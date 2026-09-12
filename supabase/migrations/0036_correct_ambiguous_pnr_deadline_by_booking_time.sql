-- Correct the exact booking whose normalized PNR deadline predates submission
-- by one month while the alternate ambiguous interpretation is two hours after
-- submission. The application now applies this booking-time invariant before
-- persisting future ambiguous PNR dates.
--
-- This migration never calls the supplier and never changes booking status,
-- operation state, wallet balances, reservations, captures, refunds or ledger.

do $$
declare
  v_booking public.flight_bookings;
  v_event_id bigint;
  v_after_lifecycle text;
begin
  select * into v_booking
    from public.flight_bookings
   where public_ref = 'STR260807000004'
     and not legacy_operational
   for update;

  if not found then
    raise exception '0036 expected booking STR260807000004 was not found';
  end if;

  if v_booking.status = 'on-hold'
     and v_booking.operation_kind is null
     and v_booking.ticketing_time_limit = '2026-07-08 09:14:00'
     and v_booking.ticketing_deadline_at = timestamptz '2026-07-08 03:14:00+00'
     and v_booking.submission_started_at = timestamptz '2026-08-07 01:14:16.006+00'
     and v_booking.payment_state = 'unpaid'
     and v_booking.payment_amount is null
     and v_booking.captured_amount = 0
     and v_booking.refunded_amount = 0
     and v_booking.charged_wallet_account_id is null
     and not exists (
       select 1 from public.wallet_reservations reservation
        where reservation.booking_id = v_booking.id
           or reservation.booking_attempt_id = v_booking.attempt_id
     )
     and not exists (
       select 1 from public.wallet_ledger_entries entry
        where entry.booking_id = v_booking.id
     ) then
    update public.flight_bookings
       set ticketing_time_limit = '2026-08-07 09:14:00',
           ticketing_deadline_at = timestamptz '2026-08-07 03:14:00+00'
     where id = v_booking.id;

    v_after_lifecycle := public.resolve_booking_lifecycle(
      v_booking.status,
      v_booking.airlines_pnr,
      timestamptz '2026-08-07 03:14:00+00',
      v_booking.operation_kind
    );

    insert into public.booking_status_events (
      booking_id,
      from_lifecycle_status,
      to_lifecycle_status,
      stored_status_before,
      stored_status_after,
      actor_user_id,
      supplier_operation,
      supplier_evidence,
      idempotency_key
    ) values (
      v_booking.id,
      public.resolve_booking_lifecycle(
        v_booking.status,
        v_booking.airlines_pnr,
        v_booking.ticketing_deadline_at,
        v_booking.operation_kind
      ),
      v_after_lifecycle,
      v_booking.status,
      v_booking.status,
      'migration:0036',
      'VerifiedDeadlineChronologyCorrection',
      jsonb_build_object(
        'verificationMethod', 'booking_submission_time_invariant',
        'submissionStartedAt', v_booking.submission_started_at,
        'previousDeadlineAt', v_booking.ticketing_deadline_at,
        'correctedDeadlineAt', timestamptz '2026-08-07 03:14:00+00',
        'bookingStatusChanged', false,
        'supplierApiCalledByMigration', false,
        'walletMutation', false
      ),
      'migration-0036-ambiguous-pnr-STR260807000004'
    )
    on conflict (booking_id, idempotency_key, to_lifecycle_status)
      where idempotency_key is not null
    do nothing
    returning id into v_event_id;

    insert into public.security_audit_events (
      actor_user_id, actor_role, action, target_type, target_id, outcome, metadata
    ) values (
      'migration:0036',
      'system',
      'booking.verified_deadline_chronology_corrected',
      'booking',
      v_booking.id::text,
      'succeeded',
      jsonb_build_object(
        'publicRef', v_booking.public_ref,
        'statusEventId', v_event_id,
        'bookingStatusChanged', false,
        'supplierApiCalledByMigration', false,
        'walletMutation', false
      )
    );
  elsif v_booking.ticketing_time_limit = '2026-08-07 09:14:00'
        and v_booking.ticketing_deadline_at = timestamptz '2026-08-07 03:14:00+00'
        and exists (
          select 1 from public.booking_status_events event
           where event.booking_id = v_booking.id
             and event.idempotency_key =
               'migration-0036-ambiguous-pnr-STR260807000004'
        ) then
    null;
  else
    raise exception '0036 refused unexpected state for STR260807000004';
  end if;
end;
$$;
