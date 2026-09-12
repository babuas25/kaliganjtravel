-- Durable expiry-worker run evidence. The cursor is scoped to one bounded run;
-- every new scheduler invocation starts at the due-index head because prior
-- observations leave the eligible set. This avoids a global high-water mark
-- skipping a newly corrected, earlier deadline.
create table if not exists public.booking_lifecycle_worker_runs (
  id uuid primary key default gen_random_uuid(),
  worker_kind text not null,
  state text not null default 'running',
  cursor_deadline timestamptz,
  cursor_booking_id uuid,
  batch_count integer not null default 0,
  selected_count bigint not null default 0,
  inserted_count bigint not null default 0,
  last_observed_at timestamptz,
  last_batch_at timestamptz,
  stop_reason text,
  last_error text,
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint booking_lifecycle_worker_runs_kind_check
    check (worker_kind = 'due_expiry_observation'),
  constraint booking_lifecycle_worker_runs_state_check
    check (state in ('running', 'succeeded', 'bounded', 'failed')),
  constraint booking_lifecycle_worker_runs_cursor_check
    check ((cursor_deadline is null) = (cursor_booking_id is null)),
  constraint booking_lifecycle_worker_runs_counts_check
    check (
      batch_count >= 0
      and selected_count >= 0
      and inserted_count >= 0
      and inserted_count <= selected_count
    ),
  constraint booking_lifecycle_worker_runs_completion_check
    check (
      (state = 'running' and completed_at is null and stop_reason is null)
      or
      (state <> 'running' and completed_at is not null and stop_reason is not null)
    )
);

create index if not exists booking_lifecycle_worker_runs_recent_idx
  on public.booking_lifecycle_worker_runs (worker_kind, started_at desc, id desc);
create index if not exists booking_lifecycle_worker_runs_running_idx
  on public.booking_lifecycle_worker_runs (started_at, id)
  where state = 'running';

drop trigger if exists booking_lifecycle_worker_runs_touch_updated_at
  on public.booking_lifecycle_worker_runs;
create trigger booking_lifecycle_worker_runs_touch_updated_at
  before update on public.booking_lifecycle_worker_runs
  for each row execute function public.touch_updated_at();

alter table public.booking_lifecycle_worker_runs enable row level security;
revoke all on table public.booking_lifecycle_worker_runs
  from public, anon, authenticated, service_role;
grant select on table public.booking_lifecycle_worker_runs to service_role;

create or replace function public.start_due_booking_expiry_worker_run_v1()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_run_id uuid;
begin
  insert into public.booking_lifecycle_worker_runs (worker_kind)
  values ('due_expiry_observation')
  returning id into v_run_id;
  return v_run_id;
end;
$$;

-- The run row is locked before the batch call. Event/outbox insertion and the
-- durable cursor/count update therefore commit or roll back together.
create or replace function public.record_due_booking_expiry_worker_batch_v2(
  p_run_id uuid,
  p_limit integer default 250
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.booking_lifecycle_worker_runs;
  v_batch jsonb;
  v_selected integer;
  v_inserted integer;
  v_next_deadline timestamptz;
  v_next_id uuid;
  v_observed_at timestamptz;
begin
  select * into v_run
  from public.booking_lifecycle_worker_runs
  where id = p_run_id
  for update;
  if not found or v_run.worker_kind <> 'due_expiry_observation' then
    raise exception 'expiry worker run not found' using errcode = 'P0002';
  end if;
  if v_run.state <> 'running' then
    raise exception 'expiry worker run is already complete' using errcode = '55000';
  end if;

  v_batch := public.record_due_booking_expiry_observation_batch_v1(
    v_run.cursor_deadline,
    v_run.cursor_booking_id,
    p_limit
  );
  v_selected := coalesce((v_batch->>'selectedCount')::integer, 0);
  v_inserted := coalesce((v_batch->>'insertedCount')::integer, 0);
  v_next_deadline := nullif(v_batch->>'nextDeadline', '')::timestamptz;
  v_next_id := nullif(v_batch->>'nextId', '')::uuid;
  v_observed_at := nullif(v_batch->>'observedAt', '')::timestamptz;
  if v_selected > 0 and (v_next_deadline is null or v_next_id is null) then
    raise exception 'expiry batch returned an invalid cursor' using errcode = '22023';
  end if;

  update public.booking_lifecycle_worker_runs
     set cursor_deadline = coalesce(v_next_deadline, cursor_deadline),
         cursor_booking_id = coalesce(v_next_id, cursor_booking_id),
         batch_count = batch_count + 1,
         selected_count = selected_count + v_selected,
         inserted_count = inserted_count + v_inserted,
         last_observed_at = v_observed_at,
         last_batch_at = clock_timestamp()
   where id = p_run_id;

  return v_batch || jsonb_build_object('runId', p_run_id);
end;
$$;

create or replace function public.complete_due_booking_expiry_worker_run_v1(
  p_run_id uuid,
  p_stop_reason text,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_run public.booking_lifecycle_worker_runs;
begin
  if p_stop_reason not in (
    'drained', 'time_budget', 'batch_cap', 'rpc_error', 'invalid_cursor'
  ) then
    raise exception 'unsupported expiry worker stop reason' using errcode = '22023';
  end if;
  update public.booking_lifecycle_worker_runs
     set state = case
           when p_stop_reason = 'drained' then 'succeeded'
           when p_stop_reason in ('time_budget', 'batch_cap') then 'bounded'
           else 'failed'
         end,
         stop_reason = p_stop_reason,
         last_error = nullif(left(coalesce(p_error, ''), 1000), ''),
         completed_at = clock_timestamp()
   where id = p_run_id and state = 'running'
   returning * into v_run;
  if not found then
    select * into v_run from public.booking_lifecycle_worker_runs where id = p_run_id;
  end if;
  if not found then
    raise exception 'expiry worker run not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'runId', v_run.id,
    'state', v_run.state,
    'stopReason', v_run.stop_reason,
    'batchCount', v_run.batch_count,
    'selectedCount', v_run.selected_count,
    'insertedCount', v_run.inserted_count,
    'cursorDeadline', v_run.cursor_deadline,
    'cursorBookingId', v_run.cursor_booking_id,
    'startedAt', v_run.started_at,
    'completedAt', v_run.completed_at
  );
end;
$$;

revoke all on function public.start_due_booking_expiry_worker_run_v1(),
  public.record_due_booking_expiry_worker_batch_v2(uuid, integer),
  public.complete_due_booking_expiry_worker_run_v1(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.start_due_booking_expiry_worker_run_v1(),
  public.record_due_booking_expiry_worker_batch_v2(uuid, integer),
  public.complete_due_booking_expiry_worker_run_v1(uuid, text, text)
  to service_role;

comment on table public.booking_lifecycle_worker_runs is
  'Durable, address/PII-free execution evidence for bounded derived-lifecycle workers; one cursor is scoped to one scheduler run.';
