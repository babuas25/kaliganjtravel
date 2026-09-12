-- Triplover's /api/pnr response uses MM/DD/YYYY for US-Bangla (BS), while
-- other validating carriers currently use DD/MM/YYYY. Correct only the nine
-- verified BS rows whose raw PNR deadline was persisted in slash form and was
-- previously interpreted day-first. Book-response deadlines are out of scope.
--
-- This migration does not call the supplier and does not change stored booking
-- status, operation state, payment state, wallet balances or wallet ledgers.

do $$
declare
  v_ref text;
  v_booking public.flight_bookings;
  v_match text[];
  v_previous_lifecycle text;
  v_corrected_lifecycle text;
  v_expected_day_first timestamptz;
  v_corrected_month_first timestamptz;
  v_event_id bigint;
begin
  foreach v_ref in array array[
    'STR260808000002',
    'STR260808000003',
    'STR260809000001',
    'STR260809000003',
    'STR260809000004',
    'STR260810000004',
    'STR260810000005',
    'STR260810000006',
    'STR260810000007'
  ] loop
    select * into v_booking
      from public.flight_bookings
     where public_ref = v_ref
       and not legacy_operational
     for update;

    if not found then
      raise exception '0039 expected booking % was not found', v_ref;
    end if;
    if v_booking.itinerary->>'carrierCode' <> 'BS'
       or v_booking.deadline_source <> 'pnr_call'
       or v_booking.operation_kind is not null then
      raise exception '0039 refused unexpected booking state for %', v_ref;
    end if;

    v_match := regexp_match(
      v_booking.ticketing_time_limit,
      '^([0-9]{2})/([0-9]{2})/([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$'
    );
    if v_match is null then
      raise exception '0039 refused unexpected raw PNR deadline for %', v_ref;
    end if;

    -- Existing interpretation: DD/MM/YYYY in Asia/Dhaka.
    v_expected_day_first := make_timestamptz(
      v_match[3]::integer,
      v_match[2]::integer,
      v_match[1]::integer,
      v_match[4]::integer,
      v_match[5]::integer,
      v_match[6]::double precision,
      'Asia/Dhaka'
    );
    -- Correct BS PNR interpretation: MM/DD/YYYY in Asia/Dhaka.
    v_corrected_month_first := make_timestamptz(
      v_match[3]::integer,
      v_match[1]::integer,
      v_match[2]::integer,
      v_match[4]::integer,
      v_match[5]::integer,
      v_match[6]::double precision,
      'Asia/Dhaka'
    );

    if v_corrected_month_first <
       coalesce(v_booking.submission_started_at, v_booking.created_at) - interval '5 minutes' then
      raise exception '0039 corrected deadline predates booking for %', v_ref;
    end if;
    -- The operational correction may already have run before this migration
    -- reaches an environment. In that case there is nothing left to record.
    if v_booking.ticketing_deadline_at = v_corrected_month_first then
      continue;
    end if;
    if v_booking.ticketing_deadline_at <> v_expected_day_first then
      raise exception '0039 refused unexpected stored deadline for %', v_ref;
    end if;

    v_previous_lifecycle := public.resolve_booking_lifecycle(
      v_booking.status,
      v_booking.airlines_pnr,
      v_booking.ticketing_deadline_at,
      v_booking.operation_kind
    );
    v_corrected_lifecycle := public.resolve_booking_lifecycle(
      v_booking.status,
      v_booking.airlines_pnr,
      v_corrected_month_first,
      v_booking.operation_kind
    );
    v_event_id := null;

    update public.flight_bookings
       set ticketing_deadline_at = v_corrected_month_first
     where id = v_booking.id;

    insert into public.booking_status_events (
      booking_id,
      from_lifecycle_status,
      to_lifecycle_status,
      stored_status_before,
      stored_status_after,
      operation_kind,
      operation_reason,
      actor_user_id,
      supplier_operation,
      supplier_evidence,
      idempotency_key
    ) values (
      v_booking.id,
      v_previous_lifecycle,
      v_corrected_lifecycle,
      v_booking.status,
      v_booking.status,
      v_booking.operation_kind,
      v_booking.operation_reason,
      'migration:0039',
      'VerifiedDeadlineCorrection',
      jsonb_build_object(
        'verificationMethod', 'carrier_specific_pnr_date_order',
        'carrierCode', 'BS',
        'supplierDateOrder', 'MM/DD/YYYY',
        'rawLastTicketTime', v_booking.ticketing_time_limit,
        'previousDeadlineAt', v_booking.ticketing_deadline_at,
        'correctedDeadlineAt', v_corrected_month_first,
        'bookingStatusChanged', false,
        'supplierApiCalledByMigration', false,
        'walletMutation', false
      ),
      'migration-0039-bs-pnr-month-day-' || v_booking.public_ref
    )
    on conflict (booking_id, idempotency_key, to_lifecycle_status)
      where idempotency_key is not null
    do nothing
    returning id into v_event_id;

    insert into public.security_audit_events (
      actor_user_id,
      actor_role,
      action,
      target_type,
      target_id,
      outcome,
      metadata
    ) values (
      'migration:0039',
      'system',
      'booking.us_bangla_pnr_deadline_corrected',
      'booking',
      v_booking.id::text,
      'succeeded',
      jsonb_build_object(
        'publicRef', v_booking.public_ref,
        'statusEventId', v_event_id,
        'previousLifecycle', v_previous_lifecycle,
        'correctedLifecycle', v_corrected_lifecycle,
        'bookingStatusChanged', false,
        'supplierApiCalledByMigration', false,
        'walletMutation', false
      )
    );
  end loop;
end;
$$;
