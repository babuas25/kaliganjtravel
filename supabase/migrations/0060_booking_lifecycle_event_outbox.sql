-- Every new lifecycle occurrence owns one transactional notification intent.
-- The trigger runs inside the event-producing transaction, so a booking,
-- operation, case, wallet ledger, lifecycle event, and outbox either all
-- commit or all roll back. Recipient expansion and sending remain disabled
-- until the Phase 7 worker cutover.

create or replace function public.enqueue_booking_lifecycle_event_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_booking_ref text;
  v_payment_state text;
  v_policy text := 'send';
  v_available_at timestamptz;
  v_grace_expires_at timestamptz;
  v_snapshot jsonb;
begin
  if new.to_lifecycle_status not in (
    'on-hold', 'pending', 'in-progress', 'confirmed',
    'expired', 'unconfirmed', 'cancelled'
  ) then
    raise exception 'unsupported lifecycle notification status'
      using errcode = '23514';
  end if;
  select booking.public_ref, booking.payment_state
    into v_booking_ref, v_payment_state
    from public.flight_bookings booking
   where booking.id = new.booking_id;
  if not found then
    raise exception 'notification booking not found' using errcode = '23503';
  end if;

  -- Ordinary Triplover supplier writes receive the approved 120-second grace
  -- window. Imported manual ticketing and every terminal/financial occurrence
  -- are immediately eligible.
  if new.to_lifecycle_status = 'in-progress'
     and new.operation_kind in ('ticketing', 'cancellation')
     and coalesce(
       new.event_snapshot->>'operationSource',
       case when new.operation_kind = 'imported_manual_ticketing'
         then 'imported_manual_ticketing' else 'triplover' end
     ) <> 'imported_manual_ticketing' then
    v_policy := 'grace';
    v_grace_expires_at := v_now + interval '120 seconds';
    v_available_at := v_grace_expires_at;
  else
    v_available_at := v_now;
  end if;

  -- Enforced keys cannot be overridden by a caller-provided event snapshot.
  -- The snapshot remains render-safe and excludes passenger/contact addresses.
  v_snapshot := coalesce(new.event_snapshot, '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object(
      'version', greatest(coalesce(new.event_version, 1), 1),
      'bookingReference', v_booking_ref,
      'lifecycleStatus', new.to_lifecycle_status,
      'paymentState', v_payment_state,
      'occurrenceId', new.occurrence_id,
      'occurrenceNumber', new.occurrence_number,
      'effectiveAt', new.effective_at,
      'observedAt', coalesce(new.observed_at, v_now)
    ));
  insert into public.booking_notification_outbox (
    lifecycle_event_id, booking_id, notification_kind,
    lifecycle_status, event_snapshot, delivery_policy,
    state, policy_version, available_at, grace_expires_at
  ) values (
    new.id, new.booking_id, 'booking_status',
    new.to_lifecycle_status, v_snapshot, v_policy,
    'pending', 1, v_available_at, v_grace_expires_at
  )
  on conflict (lifecycle_event_id, notification_kind) do nothing;
  return new;
end;
$$;

drop trigger if exists booking_status_events_enqueue_notification
  on public.booking_status_events;
create trigger booking_status_events_enqueue_notification
  after insert on public.booking_status_events
  for each row execute function public.enqueue_booking_lifecycle_event_v1();

revoke all on function public.enqueue_booking_lifecycle_event_v1()
  from public, anon, authenticated, service_role;

comment on function public.enqueue_booking_lifecycle_event_v1() is
  'Creates one render-safe occurrence outbox row in the lifecycle-event transaction. Ordinary Triplover In Progress receives a 120-second grace; other events are immediately eligible.';
