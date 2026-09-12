-- Stable customer references based on the locators available at creation.
-- Historical links retain a private alias; booking IDs and audit history stay intact.
begin;
create table if not exists public.booking_reference_aliases (
  alias text primary key,
  booking_id uuid not null references public.flight_bookings(id) deferrable initially deferred
);
alter table public.booking_reference_aliases enable row level security;
revoke all on public.booking_reference_aliases from anon, authenticated;
grant select, insert on public.booking_reference_aliases to service_role;

alter table public.flight_bookings drop constraint if exists flight_bookings_public_ref_format_check;
alter table public.flight_bookings add constraint flight_bookings_public_ref_format_check
  check (public_ref is null or public_ref ~ '^(STR[0-9]{12}|KTT[A-Z0-9]{1,100})$');

create or replace function public.assign_ktt_booking_reference()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_gds text;
  v_airline text;
  v_reference text;
  v_original text := new.public_ref;
begin
  if new.public_ref like 'KTT%' then return new; end if;
  if new.public_ref is null and new.legacy_operational then return new; end if;
  -- Serialize allocations, including recycled PNRs and separate supplier accounts.
  perform pg_advisory_xact_lock(74162026161::bigint);
  v_gds := upper(btrim(coalesce(new.pnr, '')));
  if v_gds !~ '^[A-Z0-9]{3,32}$' then v_gds := ''; end if;
  select upper(btrim(value)) into v_airline
    from jsonb_array_elements_text(case when jsonb_typeof(new.airlines_pnr) = 'array'
      then new.airlines_pnr else '[]'::jsonb end) with ordinality as p(value, position)
    where upper(btrim(value)) ~ '^[A-Z0-9]{3,32}$'
    order by position limit 1;
  -- Never invent an absent locator. Use the booking UUID to keep the fallback unique.
  if v_gds = '' or v_airline is null then
    v_reference := 'KTT' || v_gds || coalesce(v_airline, '') || upper(replace(new.id::text, '-', ''));
  else
    v_reference := 'KTT' || v_gds || v_airline;
  end if;
  if exists (select 1 from public.flight_bookings where public_ref = v_reference and id <> new.id) then
    v_reference := v_reference || upper(replace(new.id::text, '-', ''));
  end if;
  if v_original is not null then
    insert into public.booking_reference_aliases(alias, booking_id) values(v_original, new.id)
      on conflict (alias) do nothing;
  end if;
  new.public_ref := v_reference;
  return new;
end;
$$;
revoke all on function public.assign_ktt_booking_reference() from public, anon, authenticated;
drop trigger if exists flight_bookings_assign_ktt_reference on public.flight_bookings;
create trigger flight_bookings_assign_ktt_reference
  before insert or update of public_ref on public.flight_bookings
  for each row execute function public.assign_ktt_booking_reference();

-- Only the reference changes; no status transitions, supplier calls or notifications.
update public.flight_bookings set public_ref = public_ref where public_ref ~ '^STR[0-9]{12}$';
comment on column public.flight_bookings.public_ref is
  'KTT + GDS PNR + first airline PNR. Missing/repeated locators receive a UUID suffix. Stable after creation; STR aliases preserve old links.';
commit;
