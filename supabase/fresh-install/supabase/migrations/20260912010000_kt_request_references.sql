-- Company request prefixes. Preserve IDs, dates, counter values and suffixes.
begin;
lock table public.wallet_deposit_requests, public.ticket_management_requests in access exclusive mode;

create or replace function public.allocate_deposit_ref_for(p_date date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  insert into public.deposit_ref_counters as c (ref_date, last_value)
  values (p_date, 1)
  on conflict (ref_date) do update
    set last_value = c.last_value + 1,
        updated_at = now()
  returning c.last_value into v_next;

  if v_next > 999999 then
    raise exception 'daily deposit reference capacity exhausted';
  end if;

  return 'KTD' || to_char(p_date, 'YYMMDD') || lpad(v_next::text, 6, '0');
end;
$$;


alter table public.wallet_deposit_requests
  drop constraint wallet_deposit_requests_public_ref_format_check;
alter table public.wallet_deposit_requests disable trigger wallet_deposit_public_ref_immutable;
update public.wallet_deposit_requests
  set public_ref = 'KT' || substring(public_ref from 3)
  where public_ref ~ '^STD[0-9]{12}$';
alter table public.wallet_deposit_requests enable trigger wallet_deposit_public_ref_immutable;
alter table public.wallet_deposit_requests
  add constraint wallet_deposit_requests_public_ref_format_check
  check (public_ref ~ '^KTD[0-9]{12}$');
comment on column public.wallet_deposit_requests.public_ref is
  'Immutable customer-facing reference, KTDYYMMDD######.';

alter table public.ticket_management_requests drop constraint ticket_management_requests_public_ref_check;
update public.ticket_management_requests
  set public_ref = 'KT' || substring(public_ref from 3)
  where public_ref ~ '^TMR[REV][A-F0-9]{12}$';
alter table public.ticket_management_requests add constraint ticket_management_requests_public_ref_check
  check (public_ref ~ '^KTR[REV][A-F0-9]{12}$');

create or replace function public.assign_ticket_management_public_ref_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- The old generic TMR default is treated as an automatic value and replaced.
  -- Explicit valid action-prefixed references remain available for controlled
  -- data imports.
  if new.public_ref is null or new.public_ref ~ '^TMR[A-F0-9]{12}$' then
    new.public_ref := case new.action
      when 'refund' then 'KTRR'
      when 'reissue' then 'KTRE'
      when 'void' then 'KTRV'
    end || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  end if;
  if new.public_ref ~ '^TMR[REV][A-F0-9]{12}$' then
    new.public_ref := 'KT' || substring(new.public_ref from 3);
  end if;
  return new;
end;
$$;


comment on column public.ticket_management_requests.public_ref is
  'KTRR (Refund), KTRE (Reissue), KTRV (VOID), followed by 12 uppercase hexadecimal characters.';
commit;
