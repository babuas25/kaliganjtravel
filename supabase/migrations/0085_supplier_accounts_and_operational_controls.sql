-- Supplier-account binding and Super Admin operational controls.
--
-- A supplier account is deliberately separate from `supplier = 'triplover'`:
-- the latter identifies the integration, while this column identifies the
-- credential/URL set that must remain stable for one search and booking.
-- Historical rows are intentionally left NULL rather than guessed from a
-- deployment-wide setting. They require a safe manual reconciliation path.

alter table public.flight_search_quotes
  add column if not exists supplier_account text;
alter table public.flight_search_quotes
  drop constraint if exists flight_search_quotes_supplier_account_check;
alter table public.flight_search_quotes
  add constraint flight_search_quotes_supplier_account_check
  check (supplier_account is null or supplier_account in ('firsttrip', 'takeoff'));

alter table public.booking_attempts
  add column if not exists supplier_account text;
alter table public.booking_attempts
  drop constraint if exists booking_attempts_supplier_account_check;
alter table public.booking_attempts
  add constraint booking_attempts_supplier_account_check
  check (supplier_account is null or supplier_account in ('firsttrip', 'takeoff'));

alter table public.flight_bookings
  add column if not exists supplier_account text;
alter table public.flight_bookings
  drop constraint if exists flight_bookings_supplier_account_check;
alter table public.flight_bookings
  add constraint flight_bookings_supplier_account_check
  check (supplier_account is null or supplier_account in ('firsttrip', 'takeoff'));

create index if not exists booking_attempts_supplier_account_idx
  on public.booking_attempts (supplier_account, created_at desc)
  where supplier_account is not null;
create index if not exists flight_bookings_supplier_account_idx
  on public.flight_bookings (supplier_account, created_at desc)
  where supplier_account is not null;

comment on column public.flight_search_quotes.supplier_account is
  'Credential account used to create this expiring search. Never inferred after creation.';
comment on column public.booking_attempts.supplier_account is
  'Credential account copied from the source search. NULL denotes a historical row.';
comment on column public.flight_bookings.supplier_account is
  'Credential account copied from its booking attempt. NULL denotes a historical row.';

-- The existing atomic attempt-to-booking finalizer has a deliberately narrow
-- insert list. This trigger copies the bound account inside that same database
-- transaction without changing any lifecycle or ticketing semantics.
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

  if new.supplier = 'triplover'
     and not new.legacy_operational
     and new.attempt_id is not null
     and new.supplier_account is null then
    raise exception 'booking attempt is missing supplier account'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists flight_bookings_copy_supplier_account
  on public.flight_bookings;
create trigger flight_bookings_copy_supplier_account
  before insert on public.flight_bookings
  for each row execute function public.copy_booking_supplier_account_from_attempt();

revoke all on function public.copy_booking_supplier_account_from_attempt()
  from public, anon, authenticated;

-- One optional row. Leaving this table empty preserves the legacy environment
-- switches during a rolling release; the first Super Admin save makes the
-- database the only operational authority.
create table if not exists public.supplier_operational_settings (
  id                text primary key check (id = 'triplover'),
  active_supplier   text not null
                    check (active_supplier in ('firsttrip', 'takeoff')),
  booking_enabled   boolean not null,
  ticketing_enabled boolean not null,
  version           integer not null default 1 check (version > 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (not ticketing_enabled or booking_enabled)
);

alter table public.supplier_operational_settings enable row level security;
revoke all on table public.supplier_operational_settings from anon, authenticated;

comment on table public.supplier_operational_settings is
  'Singleton Super Admin control for the active Triplover account and booking/ticketing gates. Empty means temporary legacy-environment fallback.';

-- PostgreSQL expands fb.* when a view is created. Later reporting views depend
-- on booking_lifecycle_v, so do not drop it. Instead preserve every existing
-- output column and its order, then append supplier_account. That keeps the
-- lifecycle_status position stable for dependent views while exposing the new
-- account to application reads.
do $$
declare
  v_existing_columns text;
begin
  select string_agg(format('fb.%I', attribute.attname), ', ' order by attribute.attnum)
    into v_existing_columns
    from pg_attribute attribute
   where attribute.attrelid = 'public.booking_lifecycle_v'::regclass
     and attribute.attnum > 0
     and not attribute.attisdropped
     and attribute.attname not in ('lifecycle_status', 'supplier_account');

  if v_existing_columns is null then
    raise exception 'booking_lifecycle_v has no expected source columns';
  end if;

  execute format(
    'create or replace view public.booking_lifecycle_v with (security_invoker = true) as
       select %s,
         public.resolve_booking_lifecycle(
           fb.status, fb.airlines_pnr, fb.ticketing_deadline_at, fb.operation_kind
         ) as lifecycle_status,
         fb.supplier_account
       from public.flight_bookings fb
       where not fb.legacy_operational',
    v_existing_columns
  );
end;
$$;
