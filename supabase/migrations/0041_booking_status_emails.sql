-- One durable, retry-safe delivery claim for every public booking status.
-- Existing lifecycle history is baselined to prevent a deployment-time email
-- flood; only status observations created after this migration are delivered.

create table if not exists public.booking_status_email_deliveries (
  booking_id uuid not null references public.flight_bookings(id) on delete cascade,
  lifecycle_status text not null check (lifecycle_status in (
    'on-hold', 'pending', 'in-progress', 'confirmed', 'expired',
    'unconfirmed', 'cancelled'
  )),
  claimed_at timestamptz,
  completed_at timestamptz,
  outcome text check (outcome in ('sent', 'baseline')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (booking_id, lifecycle_status)
);

alter table public.booking_status_email_deliveries enable row level security;

-- Mark every status already observed before rollout as historical. A repeated
-- status is intentionally sent once per booking, not once per operation.
insert into public.booking_status_email_deliveries (
  booking_id, lifecycle_status, completed_at, outcome
)
select distinct booking_id, to_lifecycle_status, now(), 'baseline'
from public.booking_status_events
where to_lifecycle_status in (
  'on-hold', 'pending', 'in-progress', 'confirmed', 'expired',
  'unconfirmed', 'cancelled'
)
on conflict (booking_id, lifecycle_status) do nothing;

-- Some retained rows predate complete lifecycle-event history.
insert into public.booking_status_email_deliveries (
  booking_id, lifecycle_status, completed_at, outcome
)
select id, lifecycle_status, now(), 'baseline'
from public.booking_lifecycle_v
on conflict (booking_id, lifecycle_status) do nothing;

-- Preserve the stronger evidence from the two legacy delivery columns.
update public.booking_status_email_deliveries d
set completed_at = fb.on_hold_email_sent_at,
    outcome = 'sent',
    updated_at = now()
from public.flight_bookings fb
where d.booking_id = fb.id
  and d.lifecycle_status = 'on-hold'
  and fb.on_hold_email_sent_at is not null;

update public.booking_status_email_deliveries d
set completed_at = fb.confirmed_email_sent_at,
    outcome = 'sent',
    updated_at = now()
from public.flight_bookings fb
where d.booking_id = fb.id
  and d.lifecycle_status = 'confirmed'
  and fb.confirmed_email_sent_at is not null;

create or replace function public.claim_booking_status_email(
  p_booking_id uuid,
  p_lifecycle_status text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings%rowtype;
  v_delivery public.booking_status_email_deliveries%rowtype;
  v_current_status text;
begin
  if p_lifecycle_status not in (
    'on-hold', 'pending', 'in-progress', 'confirmed', 'expired',
    'unconfirmed', 'cancelled'
  ) then
    return false;
  end if;

  select * into v_booking
  from public.flight_bookings
  where id = p_booking_id and not legacy_operational
  for update;
  if not found then return false; end if;

  v_current_status := public.resolve_booking_lifecycle(
    v_booking.status,
    v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at,
    v_booking.operation_kind
  );

  -- A fast operation may already have moved on from In Progress by the time
  -- the worker sends it, so retained lifecycle evidence is also authoritative.
  if v_current_status <> p_lifecycle_status and not exists (
    select 1 from public.booking_status_events e
    where e.booking_id = p_booking_id
      and e.to_lifecycle_status = p_lifecycle_status
  ) then
    return false;
  end if;

  insert into public.booking_status_email_deliveries (
    booking_id, lifecycle_status
  ) values (p_booking_id, p_lifecycle_status)
  on conflict (booking_id, lifecycle_status) do nothing;

  select * into v_delivery
  from public.booking_status_email_deliveries
  where booking_id = p_booking_id
    and lifecycle_status = p_lifecycle_status
  for update;

  if v_delivery.completed_at is not null
     or (
       v_delivery.claimed_at is not null
       and v_delivery.claimed_at > now() - interval '15 minutes'
     ) then
    return false;
  end if;

  update public.booking_status_email_deliveries
  set claimed_at = now(),
      attempt_count = attempt_count + 1,
      last_error = null,
      updated_at = now()
  where booking_id = p_booking_id
    and lifecycle_status = p_lifecycle_status;
  return true;
end;
$$;

create or replace function public.mark_booking_status_email_sent(
  p_booking_id uuid,
  p_lifecycle_status text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.booking_status_email_deliveries
  set claimed_at = null,
      completed_at = now(),
      outcome = 'sent',
      last_error = null,
      updated_at = now()
  where booking_id = p_booking_id
    and lifecycle_status = p_lifecycle_status;

  -- Keep legacy observability compatible during the transition.
  if p_lifecycle_status = 'on-hold' then
    update public.flight_bookings
    set on_hold_email_claimed_at = null,
        on_hold_email_sent_at = coalesce(on_hold_email_sent_at, now())
    where id = p_booking_id;
  elsif p_lifecycle_status = 'confirmed' then
    update public.flight_bookings
    set confirmed_email_claimed_at = null,
        confirmed_email_sent_at = coalesce(confirmed_email_sent_at, now()),
        confirmed_email_last_error = null
    where id = p_booking_id;
  end if;
end;
$$;

create or replace function public.fail_booking_status_email(
  p_booking_id uuid,
  p_lifecycle_status text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.booking_status_email_deliveries
  set claimed_at = null,
      last_error = left(coalesce(p_error, 'Booking status email failed.'), 500),
      updated_at = now()
  where booking_id = p_booking_id
    and lifecycle_status = p_lifecycle_status;

  if p_lifecycle_status = 'confirmed' then
    update public.flight_bookings
    set confirmed_email_claimed_at = null,
        confirmed_email_attempt_count = confirmed_email_attempt_count + 1,
        confirmed_email_last_error = left(coalesce(p_error, 'Booking status email failed.'), 500)
    where id = p_booking_id;
  end if;
end;
$$;

create or replace function public.pending_booking_status_email_jobs(
  p_limit integer default 100,
  p_booking_id uuid default null
)
returns table (booking_id uuid, lifecycle_status text)
language sql
security definer
set search_path = public
as $$
  with observed as (
    select e.booking_id, e.to_lifecycle_status as lifecycle_status,
      min(e.created_at) as observed_at
    from public.booking_status_events e
    where e.to_lifecycle_status in (
      'on-hold', 'pending', 'in-progress', 'confirmed', 'expired',
      'unconfirmed', 'cancelled'
    )
      and (p_booking_id is null or e.booking_id = p_booking_id)
    group by e.booking_id, e.to_lifecycle_status
    union all
    select v.id, v.lifecycle_status, v.created_at
    from public.booking_lifecycle_v v
    where (p_booking_id is null or v.id = p_booking_id)
      and not exists (
        select 1 from public.booking_status_events e
        where e.booking_id = v.id
          and e.to_lifecycle_status = v.lifecycle_status
      )
  )
  select o.booking_id, o.lifecycle_status
  from observed o
  left join public.booking_status_email_deliveries d
    on d.booking_id = o.booking_id
   and d.lifecycle_status = o.lifecycle_status
  where d.completed_at is null
    and (d.claimed_at is null or d.claimed_at <= now() - interval '15 minutes')
  order by o.observed_at, o.booking_id, o.lifecycle_status
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

revoke all on public.booking_status_email_deliveries from public, anon, authenticated;
revoke all on function public.claim_booking_status_email(uuid,text),
  public.mark_booking_status_email_sent(uuid,text),
  public.fail_booking_status_email(uuid,text,text),
  public.pending_booking_status_email_jobs(integer,uuid)
from public, anon, authenticated;

grant select, insert, update on public.booking_status_email_deliveries to service_role;
grant execute on function public.claim_booking_status_email(uuid,text),
  public.mark_booking_status_email_sent(uuid,text),
  public.fail_booking_status_email(uuid,text,text),
  public.pending_booking_status_email_jobs(integer,uuid)
to service_role;

comment on table public.booking_status_email_deliveries is
  'Retry-safe, once-per-booking lifecycle email delivery ledger.';
