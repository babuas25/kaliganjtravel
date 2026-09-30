-- KTT + YYMMDD in Bangladesh + a daily serial starting at 111111 (15 characters).
-- Retain historical links and every other booking field during the backfill.
begin;

lock table public.flight_bookings in share row exclusive mode;

create or replace function public.allocate_booking_ref_for(p_date date)
returns text language plpgsql set search_path = public as $$
declare
  v_next integer;
  v_reference text;
begin
  loop
    -- Atomic counter updates serialize requests, including same-second bookings.
    insert into public.booking_ref_counters as c (ref_date, last_value)
    values (p_date, 111111)
    on conflict (ref_date) do update
      set last_value = greatest(c.last_value, 111110) + 1, updated_at = now()
    returning last_value into v_next;
    v_reference := 'KTT' || to_char(p_date, 'YYMMDD') || v_next::text;
    if not exists (select 1 from public.flight_bookings where public_ref = v_reference)
      and not exists (select 1 from public.booking_reference_aliases where alias = v_reference) then
      return v_reference;
    end if;
  end loop;
end;
$$;
revoke execute on function public.allocate_booking_ref_for(date) from public, anon, authenticated;
grant execute on function public.allocate_booking_ref_for(date) to service_role;

create or replace function public.assign_ktt_booking_reference()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_date date := (new.created_at at time zone 'Asia/Dhaka')::date;
  v_prefix text := 'KTT' || to_char(v_date, 'YYMMDD');
  v_original text;
  v_legacy text;
  v_reference text;
  v_serial integer;
begin
  if new.public_ref is null and new.legacy_operational then return new; end if;
  if tg_op = 'UPDATE' then v_original := old.public_ref;
  else v_original := new.public_ref; end if;

  -- An RPC may already have allocated the reference; do not allocate it twice.
  if v_original ~ ('^' || v_prefix || '[1-9][0-9]{5,9}$') then
    if substring(v_original from 10)::numeric between 111111 and 2147483647 then
      v_serial := substring(v_original from 10)::integer;
      v_reference := v_original;
    end if;
  end if;
  if tg_op = 'UPDATE' and v_reference is not null then
    new.public_ref := old.public_ref;
    return new;
  end if;

  -- Lock the same daily counter used by allocate_booking_ref_for before probing
  -- references. No second allocator lock is needed, avoiding reversed lock order.
  insert into public.booking_ref_counters(ref_date, last_value) values (v_date, 111110)
    on conflict (ref_date) do nothing;
  perform 1 from public.booking_ref_counters where ref_date = v_date for update;

  if v_reference is null then
    -- Reuse historical STR serials with the 111110 offset where available.
    if v_original ~ ('^STR' || to_char(v_date, 'YYMMDD') || '[0-9]{6}$') then
      v_legacy := v_original;
    else
      select alias into v_legacy from public.booking_reference_aliases
        where booking_id = new.id
          and alias ~ ('^STR' || to_char(v_date, 'YYMMDD') || '[0-9]{6}$')
        order by alias limit 1;
    end if;
    if v_legacy is not null and substring(v_legacy from 10)::integer > 0 then
      v_serial := 111110 + substring(v_legacy from 10)::integer;
      v_reference := v_prefix || v_serial::text;
    end if;
  end if;

  if v_reference is null
    or exists (select 1 from public.flight_bookings where public_ref = v_reference and id <> new.id)
    or exists (select 1 from public.booking_reference_aliases where alias = v_reference and booking_id <> new.id) then
    v_reference := public.allocate_booking_ref_for(v_date);
    v_serial := substring(v_reference from 10)::integer;
  end if;
  -- Imported historical dates and explicit references must advance their counter.
  update public.booking_ref_counters set last_value = v_serial, updated_at = now()
    where ref_date = v_date and last_value < v_serial;

  if v_original is not null and v_original <> v_reference then
    if exists (select 1 from public.flight_bookings where public_ref = v_original and id <> new.id)
      or exists (select 1 from public.booking_reference_aliases where alias = v_original and booking_id <> new.id) then
      raise exception 'booking reference already belongs to another booking' using errcode = '23505';
    end if;
    insert into public.booking_reference_aliases(alias, booking_id) values (v_original, new.id)
      on conflict (alias) do nothing;
  end if;
  new.public_ref := v_reference;
  return new;
end;
$$;
revoke all on function public.assign_ktt_booking_reference() from public, anon, authenticated;

-- Only public_ref changes. Normal timestamp maintenance resumes before commit.
alter table public.flight_bookings disable trigger flight_bookings_touch_updated_at;
do $$
declare
  v_booking record;
begin
  for v_booking in
    select id from public.flight_bookings where public_ref is not null order by created_at, id
  loop
    update public.flight_bookings set public_ref = public_ref where id = v_booking.id;
  end loop;
end;
$$;
alter table public.flight_bookings enable trigger flight_bookings_touch_updated_at;

comment on column public.flight_bookings.public_ref is
  'KTT + YYMMDD from created_at in Asia/Dhaka + daily serial starting at 111111. Fifteen characters through serial 999999, then grows without truncation. Historical STR/KTT aliases preserve old links.';
commit;
