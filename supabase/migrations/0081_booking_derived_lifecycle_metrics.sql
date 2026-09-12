-- Address/PII-free monitoring for derived lifecycle backlog, detection latency,
-- bounded-worker health, and missed-observation starvation.
create index if not exists booking_status_events_expiry_latency_idx
  on public.booking_status_events (observed_at desc, id desc)
  where to_lifecycle_status = 'expired'
    and supplier_operation = 'LifecycleSweep';

create or replace view public.booking_derived_lifecycle_metrics_v
with (security_invoker = true)
as
with due_expiry as (
  select booking.ticketing_deadline_at
  from public.flight_bookings booking
  left join lateral (
    select event.to_lifecycle_status
    from public.booking_status_events event
    where event.booking_id = booking.id
    order by event.id desc
    limit 1
  ) latest_event on true
  where not booking.legacy_operational
    and booking.status = 'on-hold'
    and booking.active_operation_id is null
    and booking.operation_kind is null
    and booking.ticketing_deadline_at is not null
    and booking.ticketing_deadline_at <= clock_timestamp()
    and public.jsonb_is_nonempty_array(booking.airlines_pnr)
    and coalesce(latest_event.to_lifecycle_status, 'on-hold') <> 'expired'
), expiry_backlog as (
  select
    count(*)::bigint as due_expiry_count,
    min(ticketing_deadline_at) as oldest_due_deadline_at,
    coalesce(max(greatest(
      extract(epoch from (clock_timestamp() - ticketing_deadline_at)),
      0
    )), 0)::double precision as max_expiry_overdue_seconds,
    count(*) filter (
      where ticketing_deadline_at
        <= clock_timestamp() - interval '30 minutes'
    )::bigint as starved_expiry_count
  from due_expiry
), unconfirmed_backlog as (
  select count(*)::bigint as unconfirmed_repair_count
  from public.flight_bookings booking
  left join lateral (
    select event.to_lifecycle_status
    from public.booking_status_events event
    where event.booking_id = booking.id
    order by event.id desc
    limit 1
  ) latest_event on true
  where not booking.legacy_operational
    and booking.status = 'on-hold'
    and booking.active_operation_id is null
    and booking.operation_kind is null
    and not public.jsonb_is_nonempty_array(booking.airlines_pnr)
    and coalesce(latest_event.to_lifecycle_status, 'on-hold') <> 'unconfirmed'
), latency as (
  select
    count(*)::bigint as expiry_observations_24h,
    coalesce(avg(greatest(
      extract(epoch from (event.observed_at - event.effective_at)),
      0
    )), 0)::double precision as average_detection_latency_seconds,
    coalesce(percentile_cont(0.95) within group (
      order by greatest(
        extract(epoch from (event.observed_at - event.effective_at)),
        0
      )
    ), 0)::double precision as p95_detection_latency_seconds,
    coalesce(max(greatest(
      extract(epoch from (event.observed_at - event.effective_at)),
      0
    )), 0)::double precision as max_detection_latency_seconds
  from public.booking_status_events event
  where event.to_lifecycle_status = 'expired'
    and event.supplier_operation = 'LifecycleSweep'
    and event.effective_at is not null
    and event.observed_at is not null
    and event.observed_at >= clock_timestamp() - interval '24 hours'
), run_health as (
  select
    count(*) filter (
      where run.state = 'failed'
        and run.started_at >= clock_timestamp() - interval '24 hours'
    )::bigint as failed_runs_24h,
    count(*) filter (
      where run.state = 'bounded'
        and run.started_at >= clock_timestamp() - interval '24 hours'
    )::bigint as bounded_runs_24h,
    count(*) filter (
      where run.state = 'running'
        and run.started_at < clock_timestamp() - interval '15 minutes'
    )::bigint as stale_running_runs,
    max(run.completed_at) filter (
      where run.state = 'succeeded'
    ) as last_successful_run_at
  from public.booking_lifecycle_worker_runs run
  where run.worker_kind = 'due_expiry_observation'
)
select
  clock_timestamp() as observed_at,
  expiry_backlog.due_expiry_count,
  expiry_backlog.oldest_due_deadline_at,
  expiry_backlog.max_expiry_overdue_seconds,
  expiry_backlog.starved_expiry_count,
  unconfirmed_backlog.unconfirmed_repair_count,
  latency.expiry_observations_24h,
  latency.average_detection_latency_seconds,
  latency.p95_detection_latency_seconds,
  latency.max_detection_latency_seconds,
  run_health.failed_runs_24h,
  run_health.bounded_runs_24h,
  run_health.stale_running_runs,
  run_health.last_successful_run_at,
  latest_run.started_at as last_run_started_at,
  latest_run.completed_at as last_run_completed_at,
  latest_run.stop_reason as last_run_stop_reason,
  latest_run.selected_count as last_run_selected_count,
  latest_run.inserted_count as last_run_inserted_count
from expiry_backlog
cross join unconfirmed_backlog
cross join latency
cross join run_health
left join lateral (
  select run.*
  from public.booking_lifecycle_worker_runs run
  where run.worker_kind = 'due_expiry_observation'
  order by run.started_at desc, run.id desc
  limit 1
) latest_run on true;

revoke all on table public.booking_derived_lifecycle_metrics_v
  from public, anon, authenticated, service_role;
grant select on table public.booking_derived_lifecycle_metrics_v to service_role;

comment on view public.booking_derived_lifecycle_metrics_v is
  'Service-only aggregate health for due Expired backlog, >30-minute starvation, Unconfirmed repair backlog, 24-hour detection latency, and bounded worker outcomes; contains no booking or recipient identity.';
