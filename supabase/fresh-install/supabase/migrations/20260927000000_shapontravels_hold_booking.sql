-- Shapontravels can create held bookings; issue/cancel remain supplier-specific
-- and are not enabled by this migration.

alter table public.booking_attempts
  drop constraint if exists booking_attempts_supplier_account_check;
alter table public.booking_attempts
  add constraint booking_attempts_supplier_account_check
  check (supplier_account is null or supplier_account in
    ('firsttrip', 'takeoff', 'triplover', 'shapontravels'));

alter table public.flight_bookings
  drop constraint if exists flight_bookings_supplier_account_check;
alter table public.flight_bookings
  add constraint flight_bookings_supplier_account_check
  check (supplier_account is null or supplier_account in
    ('firsttrip', 'takeoff', 'triplover', 'shapontravels'));

alter table public.booking_attempts
  add constraint booking_attempts_shapontravels_binding_check
  check (supplier <> 'shapontravels' or coalesce(supplier_account = 'shapontravels', false));

alter table public.flight_bookings
  add constraint flight_bookings_shapontravels_binding_check
  check (supplier <> 'shapontravels' or coalesce(supplier_account = 'shapontravels', false));

-- The existing finalizer copies supplier_account from the claimed attempt
-- during the same transaction. Require that binding for Shapontravels too.
create or replace function public.copy_booking_supplier_account_from_attempt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.supplier_account is null and new.attempt_id is not null then
    select supplier_account into new.supplier_account
      from public.booking_attempts
     where id = new.attempt_id;
  end if;

  if new.supplier in ('triplover', 'shapontravels')
     and not new.legacy_operational
     and new.attempt_id is not null
     and new.supplier_account is null then
    raise exception 'booking attempt is missing supplier account'
      using errcode = '23514';
  end if;
  if new.supplier = 'shapontravels'
     and (new.supplier_account is distinct from 'shapontravels'
       or new.direct_ticketing
       or new.ticket_code_ref is not null) then
    raise exception 'Shapontravels supports held bookings only'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- Book can return an offset-bearing ISO instant. Keep the existing Bangladesh
-- local-time formats for Triplover and parse explicit offsets accurately.
create or replace function public.parse_triplover_booking_deadline(p_value text)
returns timestamptz
language plpgsql
stable
as $$
declare
  v_value text := nullif(trim(p_value), '');
  v_match text[];
begin
  if v_value is null then return null; end if;

  if v_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    return v_value::timestamptz;
  end if;

  v_match := regexp_match(v_value,
    '^([0-9]{2})/([0-9]{2})/([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$');
  if v_match is not null then
    return make_timestamptz(v_match[3]::integer, v_match[2]::integer,
      v_match[1]::integer, v_match[4]::integer, v_match[5]::integer,
      v_match[6]::double precision, 'Asia/Dhaka');
  end if;

  v_match := regexp_match(v_value,
    '^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})$');
  if v_match is not null then
    return make_timestamptz(v_match[1]::integer, v_match[2]::integer,
      v_match[3]::integer, v_match[4]::integer, v_match[5]::integer,
      v_match[6]::double precision, 'Asia/Dhaka');
  end if;

  return null;
end;
$$;
