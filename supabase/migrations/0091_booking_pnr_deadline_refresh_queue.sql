-- Durable post-Book PNR deadline refreshes. The Book write remains atomic and
-- is never replayed: this queue contains only safe `/api/pnr` reads for newly
-- created held Triplover bookings. There is intentionally no backfill, so
-- applying this migration never reconciles an existing production booking.
--
-- Carrier availability policy, confirmed against supplier samples:
--   * BS: PNR TTL is normally available immediately. Try at 0, +1, +3 min.
--   * every non-BS carrier: TTL may arrive 2--5 minutes later. Try at
--     +2, +4, +6 min. An early null value is never terminal.

create table public.booking_pnr_refresh_jobs (
  id                  uuid primary key default gen_random_uuid(),
  booking_id          uuid not null unique
                      references public.flight_bookings(id) on delete restrict,
  carrier_group       text not null,
  state               text not null default 'pending',
  attempt_count       integer not null default 0,
  next_attempt_at     timestamptz not null,
  claimed_at          timestamptz,
  claimed_by          text,
  last_attempt_at     timestamptz,
  last_error_code     text,
  completed_at        timestamptz,
  completion_reason   text,
  created_at          timestamptz not null default clock_timestamp(),
  updated_at          timestamptz not null default clock_timestamp(),
  constraint booking_pnr_refresh_jobs_carrier_group_check
    check (carrier_group in ('bs_immediate', 'non_bs_delayed')),
  constraint booking_pnr_refresh_jobs_state_check
    check (state in ('pending', 'running', 'completed', 'exhausted', 'skipped')),
  constraint booking_pnr_refresh_jobs_attempt_count_check
    check (attempt_count between 0 and 3),
  constraint booking_pnr_refresh_jobs_error_code_check
    check (last_error_code is null or last_error_code ~ '^[A-Z0-9_:-]{1,80}$'),
  constraint booking_pnr_refresh_jobs_shape_check
    check (
      (state = 'pending' and claimed_at is null and claimed_by is null and completed_at is null)
      or (state = 'running' and claimed_at is not null and claimed_by is not null and completed_at is null)
      or (state in ('completed', 'exhausted', 'skipped') and completed_at is not null)
    )
);

create index booking_pnr_refresh_jobs_due_idx
  on public.booking_pnr_refresh_jobs (next_attempt_at, id)
  where state = 'pending';
create index booking_pnr_refresh_jobs_running_lease_idx
  on public.booking_pnr_refresh_jobs (claimed_at, id)
  where state = 'running';

create trigger booking_pnr_refresh_jobs_touch_updated_at
  before update on public.booking_pnr_refresh_jobs
  for each row execute function public.touch_updated_at();

-- Centralize queue timing in the database so all workers obey the exact same
-- carrier policy, regardless of deployment topology or server timezone.
create or replace function public.booking_pnr_refresh_initial_due_at_v1(
  p_carrier_group text,
  p_booked_at timestamptz
)
returns timestamptz
language sql
immutable
set search_path = public
as $$
  select case p_carrier_group
    when 'bs_immediate' then p_booked_at
    when 'non_bs_delayed' then p_booked_at + interval '2 minutes'
    else null
  end;
$$;

-- `p_attempt_count` is the completed read count. Returning NULL means the
-- bounded retry policy is exhausted. A clock-relative minimum keeps a delayed
-- scheduler from issuing two supplier calls back-to-back in the same run.
create or replace function public.booking_pnr_refresh_next_due_at_v1(
  p_carrier_group text,
  p_attempt_count integer,
  p_booked_at timestamptz
)
returns timestamptz
language plpgsql
stable
set search_path = public
as $$
begin
  if p_carrier_group = 'bs_immediate' then
    return case p_attempt_count
      when 1 then greatest(p_booked_at + interval '1 minute', clock_timestamp() + interval '1 minute')
      when 2 then greatest(p_booked_at + interval '3 minutes', clock_timestamp() + interval '2 minutes')
      else null
    end;
  end if;
  if p_carrier_group = 'non_bs_delayed' then
    return case p_attempt_count
      when 1 then greatest(p_booked_at + interval '4 minutes', clock_timestamp() + interval '2 minutes')
      when 2 then greatest(p_booked_at + interval '6 minutes', clock_timestamp() + interval '2 minutes')
      else null
    end;
  end if;
  return null;
end;
$$;

-- Enqueue only newly inserted supplier holds. Existing rows are deliberately
-- untouched; queueing starts with bookings created after this migration.
create or replace function public.enqueue_booking_pnr_refresh_job_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_carrier_group text;
begin
  if new.legacy_operational
     or lower(coalesce(new.supplier, '')) <> 'triplover'
     or new.status <> 'on-hold'
     or new.direct_ticketing
     or new.import_source is not null
     or coalesce(new.supplier_account, '') not in ('firsttrip', 'takeoff')
     or nullif(btrim(coalesce(new.pnr, '')), '') is null
     or nullif(btrim(coalesce(new.booking_code_ref, '')), '') is null
     or nullif(btrim(new.supplier_refs->>'uniqueTransId'), '') is null
     or nullif(btrim(new.supplier_refs->>'itemCodeRef'), '') is null
     or nullif(btrim(new.supplier_refs->>'priceCodeRef'), '') is null then
    return new;
  end if;

  v_carrier_group := case upper(btrim(coalesce(new.itinerary->>'carrierCode', '')))
    when 'BS' then 'bs_immediate'
    else 'non_bs_delayed'
  end;
  insert into public.booking_pnr_refresh_jobs (
    booking_id, carrier_group, next_attempt_at
  ) values (
    new.id,
    v_carrier_group,
    public.booking_pnr_refresh_initial_due_at_v1(v_carrier_group, new.created_at)
  ) on conflict (booking_id) do nothing;
  return new;
end;
$$;

create trigger flight_bookings_enqueue_pnr_refresh_job_v1
  after insert on public.flight_bookings
  for each row execute function public.enqueue_booking_pnr_refresh_job_v1();

-- One worker claims one safe PNR read. A stale lease can be reclaimed because
-- PNR is read-only. Jobs for bookings that are no longer ordinary held
-- bookings are closed without a supplier call.
create or replace function public.claim_due_booking_pnr_refresh_job_v1(
  p_worker_id text
)
returns table (
  job_id uuid,
  booking_id uuid,
  supplier_account text,
  supplier_refs jsonb,
  pnr text,
  booking_ref_number text,
  booking_code_ref text,
  carrier_code text,
  deadline_not_before timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(btrim(p_worker_id), '') is null or char_length(p_worker_id) > 255 then
    raise exception 'PNR refresh worker identity is required' using errcode = '22023';
  end if;

  update public.booking_pnr_refresh_jobs
     set state = 'pending', claimed_at = null, claimed_by = null,
         last_error_code = coalesce(last_error_code, 'WORKER_LEASE_EXPIRED')
   where state = 'running'
     and claimed_at < clock_timestamp() - interval '3 minutes';

  update public.booking_pnr_refresh_jobs job
     set state = 'skipped', completed_at = clock_timestamp(),
         completion_reason = 'booking_not_refreshable',
         claimed_at = null, claimed_by = null
    from public.flight_bookings booking
   where booking.id = job.booking_id
     and job.state = 'pending'
     and job.next_attempt_at <= clock_timestamp()
     and (
       booking.legacy_operational
       or lower(coalesce(booking.supplier, '')) <> 'triplover'
       or booking.status <> 'on-hold'
       or booking.operation_kind is not null
       or booking.import_source is not null
       or coalesce(booking.supplier_account, '') not in ('firsttrip', 'takeoff')
       or nullif(btrim(coalesce(booking.pnr, '')), '') is null
       or nullif(btrim(coalesce(booking.booking_code_ref, '')), '') is null
       or nullif(btrim(booking.supplier_refs->>'uniqueTransId'), '') is null
       or nullif(btrim(booking.supplier_refs->>'itemCodeRef'), '') is null
       or nullif(btrim(booking.supplier_refs->>'priceCodeRef'), '') is null
     );

  return query
  with candidate as (
    select job.id
      from public.booking_pnr_refresh_jobs job
      join public.flight_bookings booking on booking.id = job.booking_id
     where job.state = 'pending'
       and job.next_attempt_at <= clock_timestamp()
       and not booking.legacy_operational
       and lower(coalesce(booking.supplier, '')) = 'triplover'
       and booking.status = 'on-hold'
       and booking.operation_kind is null
       and booking.import_source is null
       and booking.supplier_account in ('firsttrip', 'takeoff')
     order by job.next_attempt_at, job.id
     limit 1
     for update of job skip locked
  ), claimed as (
    update public.booking_pnr_refresh_jobs job
       set state = 'running', claimed_at = clock_timestamp(), claimed_by = p_worker_id
      from candidate
     where job.id = candidate.id
    returning job.id, job.booking_id
  )
  select
    claimed.id,
    booking.id,
    booking.supplier_account,
    booking.supplier_refs,
    booking.pnr,
    booking.booking_ref_number,
    booking.booking_code_ref,
    booking.itinerary->>'carrierCode',
    coalesce(booking.submission_started_at, booking.created_at)
  from claimed
  join public.flight_bookings booking on booking.id = claimed.booking_id;
end;
$$;

-- Missing PNR deadlines and transport/protocol failures consume the same
-- bounded retry budget. A missing early non-BS value therefore remains queued
-- through +6 minutes; it is never persisted as an authoritative NULL read.
create or replace function public.finish_booking_pnr_refresh_job_v1(
  p_job_id uuid,
  p_worker_id text,
  p_outcome text,
  p_error_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.booking_pnr_refresh_jobs;
  v_attempt_count integer;
  v_next_attempt_at timestamptz;
begin
  if p_outcome not in ('deadline_found', 'deadline_missing', 'retryable_error', 'skipped') then
    raise exception 'unsupported PNR refresh outcome' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code !~ '^[A-Z0-9_:-]{1,80}$' then
    raise exception 'invalid PNR refresh error code' using errcode = '22023';
  end if;

  select * into v_job
    from public.booking_pnr_refresh_jobs
   where id = p_job_id
   for update;
  if not found or v_job.state <> 'running' or v_job.claimed_by <> p_worker_id then
    return jsonb_build_object('ok', false, 'code', 'JOB_NOT_CLAIMED');
  end if;

  if p_outcome = 'deadline_found' then
    update public.booking_pnr_refresh_jobs
       set state = 'completed', attempt_count = attempt_count + 1,
           last_attempt_at = clock_timestamp(), last_error_code = null,
           completed_at = clock_timestamp(), completion_reason = 'deadline_found',
           claimed_at = null, claimed_by = null
     where id = v_job.id;
    return jsonb_build_object('ok', true, 'state', 'completed');
  end if;

  if p_outcome = 'skipped' then
    update public.booking_pnr_refresh_jobs
       set state = 'skipped', completed_at = clock_timestamp(),
           completion_reason = coalesce(p_error_code, 'worker_skipped'),
           claimed_at = null, claimed_by = null
     where id = v_job.id;
    return jsonb_build_object('ok', true, 'state', 'skipped');
  end if;

  v_attempt_count := v_job.attempt_count + 1;
  v_next_attempt_at := public.booking_pnr_refresh_next_due_at_v1(
    v_job.carrier_group, v_attempt_count, v_job.created_at
  );
  if v_next_attempt_at is null then
    update public.booking_pnr_refresh_jobs
       set state = 'exhausted', attempt_count = v_attempt_count,
           last_attempt_at = clock_timestamp(), last_error_code = p_error_code,
           completed_at = clock_timestamp(),
           completion_reason = case
             when p_outcome = 'deadline_missing' then 'deadline_unavailable_after_retry_window'
             else 'retry_window_exhausted'
           end,
           claimed_at = null, claimed_by = null
     where id = v_job.id;
    return jsonb_build_object('ok', true, 'state', 'exhausted');
  end if;

  update public.booking_pnr_refresh_jobs
     set state = 'pending', attempt_count = v_attempt_count,
         next_attempt_at = v_next_attempt_at,
         last_attempt_at = clock_timestamp(), last_error_code = p_error_code,
         claimed_at = null, claimed_by = null
   where id = v_job.id;
  return jsonb_build_object('ok', true, 'state', 'pending');
end;
$$;

alter table public.booking_pnr_refresh_jobs enable row level security;
revoke all on table public.booking_pnr_refresh_jobs
  from public, anon, authenticated, service_role;

revoke all on function public.booking_pnr_refresh_initial_due_at_v1(text, timestamptz),
  public.booking_pnr_refresh_next_due_at_v1(text, integer, timestamptz),
  public.enqueue_booking_pnr_refresh_job_v1(),
  public.claim_due_booking_pnr_refresh_job_v1(text),
  public.finish_booking_pnr_refresh_job_v1(uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_due_booking_pnr_refresh_job_v1(text),
  public.finish_booking_pnr_refresh_job_v1(uuid, text, text, text)
  to service_role;

comment on table public.booking_pnr_refresh_jobs is
  'Durable, bounded read-only PNR deadline refreshes for newly created Triplover holds. BS is due immediately; all non-BS carriers start after two minutes and retry through six minutes. Existing bookings are never backfilled.';
