-- Human-facing deposit request references: STDYYMMDD######.
-- The daily counter is concurrency-safe and the assigned reference is
-- immutable for the lifetime of the financial record.

create table if not exists public.deposit_ref_counters (
  ref_date   date primary key,
  last_value integer not null default 0
             check (last_value between 0 and 999999),
  updated_at timestamptz not null default now()
);

alter table public.deposit_ref_counters enable row level security;
revoke all on table public.deposit_ref_counters
  from public, anon, authenticated, service_role;

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

  return 'STD' || to_char(p_date, 'YYMMDD') || lpad(v_next::text, 6, '0');
end;
$$;

create or replace function public.allocate_deposit_ref()
returns text
language sql
security definer
set search_path = public
as $$
  select public.allocate_deposit_ref_for(
    (now() at time zone 'Asia/Dhaka')::date
  );
$$;

revoke execute on function public.allocate_deposit_ref_for(date),
  public.allocate_deposit_ref()
  from public, anon, authenticated;
grant execute on function public.allocate_deposit_ref_for(date),
  public.allocate_deposit_ref()
  to service_role;

alter table public.wallet_deposit_requests
  add column if not exists public_ref text;

do $$
declare
  v_request record;
begin
  for v_request in
    select id, (requested_at at time zone 'Asia/Dhaka')::date as ref_date
      from public.wallet_deposit_requests
     where public_ref is null
     order by requested_at, id
  loop
    update public.wallet_deposit_requests
       set public_ref = public.allocate_deposit_ref_for(v_request.ref_date)
     where id = v_request.id;
  end loop;
end;
$$;

alter table public.wallet_deposit_requests
  alter column public_ref set default public.allocate_deposit_ref(),
  alter column public_ref set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'wallet_deposit_requests_public_ref_format_check'
  ) then
    alter table public.wallet_deposit_requests
      add constraint wallet_deposit_requests_public_ref_format_check
      check (public_ref ~ '^STD[0-9]{12}$');
  end if;
end;
$$;

create unique index if not exists wallet_deposit_requests_public_ref_key
  on public.wallet_deposit_requests (public_ref);

create or replace function public.prevent_deposit_public_ref_change()
returns trigger
language plpgsql
as $$
begin
  if new.public_ref is distinct from old.public_ref then
    raise exception 'deposit request reference is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists wallet_deposit_public_ref_immutable
  on public.wallet_deposit_requests;
create trigger wallet_deposit_public_ref_immutable
  before update on public.wallet_deposit_requests
  for each row execute function public.prevent_deposit_public_ref_change();

revoke execute on function public.prevent_deposit_public_ref_change()
  from public, anon, authenticated, service_role;

comment on column public.wallet_deposit_requests.public_ref is
  'Immutable customer-facing reference, STDYYMMDD###### (for example STD260802000001).';

