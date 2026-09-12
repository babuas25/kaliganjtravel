-- Cursor-based batches avoid rescanning already examined rows inside one worker
-- run. A fresh scheduler invocation starts without a cursor; rows successfully
-- observed by an earlier run are excluded by lifecycle occurrence state.
create or replace function public.record_due_booking_expiry_observation_batch_v1(
  p_after_deadline timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 250
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 250), 500));
  v_observed_at timestamptz := clock_timestamp();
  v_result jsonb;
begin
  if (p_after_deadline is null) <> (p_after_id is null) then
    raise exception 'expiry cursor requires both deadline and booking ID'
      using errcode = '22023';
  end if;

  with due_unobserved as materialized (
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
      and (
        p_after_deadline is null
        or (booking.ticketing_deadline_at, booking.id)
          > (p_after_deadline, p_after_id)
      )
    order by booking.ticketing_deadline_at, booking.id
    limit v_limit
    for update of booking skip locked
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
  select jsonb_build_object(
    'selectedCount', (select count(*) from due_unobserved),
    'insertedCount', (select count(*) from inserted),
    'nextDeadline', (
      select candidate.ticketing_deadline_at
      from due_unobserved candidate
      order by candidate.ticketing_deadline_at desc, candidate.id desc
      limit 1
    ),
    'nextId', (
      select candidate.id
      from due_unobserved candidate
      order by candidate.ticketing_deadline_at desc, candidate.id desc
      limit 1
    ),
    'hasMore', (select count(*) = v_limit from due_unobserved),
    'observedAt', v_observed_at
  ) into v_result;

  return v_result;
end;
$$;

-- Retain the original RPC as a one-batch compatibility wrapper while the
-- application worker cuts over to the cursor result.
create or replace function public.record_booking_lifecycle_observations(
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_result jsonb;
begin
  v_result := public.record_due_booking_expiry_observation_batch_v1(
    null,
    null,
    p_limit
  );
  return coalesce((v_result->>'insertedCount')::integer, 0);
end;
$$;

revoke all on function public.record_due_booking_expiry_observation_batch_v1(
  timestamptz, uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.record_due_booking_expiry_observation_batch_v1(
  timestamptz, uuid, integer
) to service_role;

revoke all on function public.record_booking_lifecycle_observations(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.record_booking_lifecycle_observations(integer)
  to service_role;

comment on function public.record_due_booking_expiry_observation_batch_v1(
  timestamptz, uuid, integer
) is
  'Records one due Expired occurrence batch after an optional (deadline, booking ID) cursor and returns the last examined key.';
