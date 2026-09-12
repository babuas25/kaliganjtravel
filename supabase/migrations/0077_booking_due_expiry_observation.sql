-- Replace the legacy oldest-updated-row sweep with a due-first expiry query.
-- P8.2 deliberately filters both deadline eligibility and prior observation
-- before applying the bounded limit. Later Phase 8 migrations add the worker
-- cursor/concurrency contract without reintroducing the broad scan.
create or replace function public.record_booking_lifecycle_observations(
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_observed_at timestamptz := clock_timestamp();
begin
  with due_unobserved as (
    select
      booking.id,
      booking.status,
      booking.ticketing_deadline_at,
      coalesce(latest_event.to_lifecycle_status, 'on-hold') as last_status
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
      and booking.ticketing_deadline_at <= v_observed_at
      and public.jsonb_is_nonempty_array(booking.airlines_pnr)
      and coalesce(latest_event.to_lifecycle_status, 'on-hold') <> 'expired'
    order by booking.ticketing_deadline_at, booking.id
    limit greatest(1, least(coalesce(p_limit, 500), 2000))
  ), inserted as (
    insert into public.booking_status_events (
      booking_id,
      from_lifecycle_status,
      to_lifecycle_status,
      stored_status_before,
      stored_status_after,
      supplier_operation,
      supplier_evidence,
      idempotency_key,
      effective_at,
      observed_at,
      event_snapshot
    )
    select
      candidate.id,
      candidate.last_status,
      'expired',
      candidate.status,
      candidate.status,
      'LifecycleSweep',
      jsonb_build_object(
        'deadlineAt', candidate.ticketing_deadline_at,
        'observationSource', 'due_expiry_worker'
      ),
      'derived-expired:v1:' || to_char(
        candidate.ticketing_deadline_at at time zone 'UTC',
        'YYYYMMDD"T"HH24MISS.US"Z"'
      ),
      candidate.ticketing_deadline_at,
      v_observed_at,
      jsonb_build_object(
        'deadlineAt', candidate.ticketing_deadline_at,
        'observationSource', 'due_expiry_worker'
      )
    from due_unobserved candidate
    on conflict do nothing
    returning 1
  )
  select count(*) into v_count from inserted;

  return v_count;
end;
$$;

revoke all on function public.record_booking_lifecycle_observations(integer)
  from public, anon, authenticated;
grant execute on function public.record_booking_lifecycle_observations(integer)
  to service_role;

comment on function public.record_booking_lifecycle_observations(integer) is
  'Compatibility expiry observer: filters due, actionable, not-currently-observed Expired occurrences before the bounded deadline/ID-ordered limit.';
