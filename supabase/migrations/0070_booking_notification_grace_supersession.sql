-- Coalesce short ordinary In Progress occurrences without erasing history.
--
-- A Confirmed or Cancelled event inserted before an ordinary In Progress grace
-- window expires creates its own immediately eligible outbox intent, then marks
-- the still-pending intermediate intent superseded. Both lifecycle events and
-- both outbox rows remain durable and linked.

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
  v_outbox_id uuid;
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
  on conflict (lifecycle_event_id, notification_kind) do nothing
  returning id into v_outbox_id;

  if v_outbox_id is null then
    select candidate.id into v_outbox_id
      from public.booking_notification_outbox candidate
     where candidate.lifecycle_event_id = new.id
       and candidate.notification_kind = 'booking_status';
  end if;

  if new.to_lifecycle_status in ('confirmed', 'cancelled') then
    update public.booking_notification_outbox intermediate
       set state = 'superseded',
           suppression_reason = 'terminal_during_in_progress_grace',
           superseded_by_outbox_id = v_outbox_id,
           completed_at = v_now
     where intermediate.booking_id = new.booking_id
       and intermediate.id <> v_outbox_id
       and intermediate.lifecycle_status = 'in-progress'
       and intermediate.delivery_policy = 'grace'
       and intermediate.state = 'pending'
       and intermediate.grace_expires_at > v_now;
  end if;

  return new;
end;
$$;

revoke all on function public.enqueue_booking_lifecycle_event_v1()
  from public, anon, authenticated, service_role;

comment on function public.enqueue_booking_lifecycle_event_v1() is
  'Creates one render-safe occurrence outbox row atomically. A Confirmed/Cancelled occurrence supersedes any still-pending ordinary In Progress grace intent for the same booking while retaining both events and intents.';
