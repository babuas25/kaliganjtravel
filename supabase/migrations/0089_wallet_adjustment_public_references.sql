-- Human-facing manual adjustment references: STAYYMMDD######.
-- The reference is allocated once, cannot be changed, and links the approved
-- manual credit/debit ledger entry back to its maker-checker request.

create table if not exists public.adjustment_ref_counters (
  ref_date   date primary key,
  last_value integer not null default 0
             check (last_value between 0 and 999999),
  updated_at timestamptz not null default now()
);

alter table public.adjustment_ref_counters enable row level security;
revoke all on table public.adjustment_ref_counters
  from public, anon, authenticated, service_role;

create or replace function public.allocate_adjustment_ref_for(p_date date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next integer;
begin
  insert into public.adjustment_ref_counters as c (ref_date, last_value)
  values (p_date, 1)
  on conflict (ref_date) do update
    set last_value = c.last_value + 1,
        updated_at = now()
  returning c.last_value into v_next;

  if v_next > 999999 then
    raise exception 'daily adjustment reference capacity exhausted';
  end if;

  return 'STA' || to_char(p_date, 'YYMMDD') || lpad(v_next::text, 6, '0');
end;
$$;

create or replace function public.allocate_adjustment_ref()
returns text
language sql
security definer
set search_path = public
as $$
  select public.allocate_adjustment_ref_for(
    (now() at time zone 'Asia/Dhaka')::date
  );
$$;

revoke execute on function public.allocate_adjustment_ref_for(date),
  public.allocate_adjustment_ref()
  from public, anon, authenticated;
grant execute on function public.allocate_adjustment_ref_for(date),
  public.allocate_adjustment_ref()
  to service_role;

alter table public.wallet_adjustment_requests
  add column if not exists public_ref text;

do $$
declare
  v_request record;
begin
  for v_request in
    select id, (requested_at at time zone 'Asia/Dhaka')::date as ref_date
      from public.wallet_adjustment_requests
     where public_ref is null
     order by requested_at, id
  loop
    update public.wallet_adjustment_requests
       set public_ref = public.allocate_adjustment_ref_for(v_request.ref_date)
     where id = v_request.id;
  end loop;
end;
$$;

alter table public.wallet_adjustment_requests
  alter column public_ref set default public.allocate_adjustment_ref(),
  alter column public_ref set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'wallet_adjustment_requests_public_ref_format_check'
  ) then
    alter table public.wallet_adjustment_requests
      add constraint wallet_adjustment_requests_public_ref_format_check
      check (public_ref ~ '^STA[0-9]{12}$');
  end if;
end;
$$;

create unique index if not exists wallet_adjustment_requests_public_ref_key
  on public.wallet_adjustment_requests (public_ref);

create or replace function public.prevent_adjustment_public_ref_change()
returns trigger
language plpgsql
as $$
begin
  if new.public_ref is distinct from old.public_ref then
    raise exception 'adjustment request reference is immutable' using errcode = '55000';
  end if;
  return new;
end;
$$;

drop trigger if exists wallet_adjustment_public_ref_immutable
  on public.wallet_adjustment_requests;
create trigger wallet_adjustment_public_ref_immutable
  before update on public.wallet_adjustment_requests
  for each row execute function public.prevent_adjustment_public_ref_change();

revoke execute on function public.prevent_adjustment_public_ref_change()
  from public, anon, authenticated, service_role;

comment on column public.wallet_adjustment_requests.public_ref is
  'Immutable customer-facing manual adjustment reference, STAYYMMDD######.';
