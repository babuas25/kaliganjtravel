-- Controlled resolution for manually verified cancellation evidence.
-- This function never calls a supplier and never mutates wallet state.

create or replace function public.resolve_verified_booking_cancellation(
  p_booking_id uuid,
  p_actor_user_id text,
  p_idempotency_key text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_latest_event public.booking_status_events;
  v_existing_event_id bigint;
  v_event_id bigint;
  v_before_lifecycle text;
  v_mode text;
  v_event_evidence jsonb;
begin
  if nullif(trim(coalesce(p_actor_user_id, '')), '') is null
     or nullif(trim(coalesce(p_idempotency_key, '')), '') is null
     or jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'invalid verified reconciliation request' using errcode = '22023';
  end if;
  if lower(trim(coalesce(p_evidence->>'airlineStatus', ''))) <> 'cancelled'
     or lower(trim(coalesce(p_evidence->>'supplierStatus', ''))) <> 'cancelled'
     or p_evidence->>'verificationMethod' <> 'manual_real_world_verification' then
    return jsonb_build_object('ok', false, 'code', 'CANCELLATION_EVIDENCE_REQUIRED');
  end if;

  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id
     and not legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  select id into v_existing_event_id
    from public.booking_status_events
   where booking_id = p_booking_id
     and idempotency_key = p_idempotency_key
     and to_lifecycle_status = 'cancelled'
   order by id desc
   limit 1;
  if v_existing_event_id is not null then
    return jsonb_build_object(
      'ok', true, 'replay', true, 'status', 'cancelled',
      'eventId', v_existing_event_id
    );
  end if;

  select * into v_latest_event
    from public.booking_status_events
   where booking_id = p_booking_id
   order by created_at desc, id desc
   limit 1;

  if v_booking.status = 'cancelled' then
    if v_booking.operation_kind is not null
       or v_booking.operation_reason is not null
       or v_booking.operation_request_id is not null
       or v_booking.operation_actor_user_id is not null
       or v_booking.operation_started_at is not null
       or v_booking.operation_prior_status is not null then
      return jsonb_build_object('ok', false, 'code', 'CANCELLED_OPERATION_STILL_ACTIVE');
    end if;
    if v_latest_event.to_lifecycle_status = 'cancelled' then
      return jsonb_build_object(
        'ok', true, 'replay', true, 'status', 'cancelled',
        'eventId', v_latest_event.id
      );
    end if;
    v_mode := 'event_repair';
    v_before_lifecycle := coalesce(v_latest_event.to_lifecycle_status, 'cancelled');
  elsif v_booking.status = 'in-progress'
        and v_booking.operation_kind = 'reconciliation'
        and v_booking.operation_reason = 'legacy_reconciliation'
        and v_booking.operation_prior_status = 'on-hold'
        and v_booking.issued_at is null
        and not v_booking.direct_ticketing
        and not public.jsonb_is_nonempty_array(v_booking.ticket_numbers) then
    if v_booking.payment_state <> 'unpaid'
       or v_booking.payment_amount is not null
       or v_booking.captured_amount <> 0
       or v_booking.refunded_amount <> 0
       or v_booking.charged_wallet_account_id is not null
       or exists (
         select 1 from public.wallet_reservations wr
          where wr.booking_id = v_booking.id
             or wr.booking_attempt_id = v_booking.attempt_id
       )
       or exists (
         select 1 from public.wallet_ledger_entries le
          where le.booking_id = v_booking.id
       ) then
      return jsonb_build_object(
        'ok', false, 'code', 'WALLET_STATE_REQUIRES_SEPARATE_RECONCILIATION'
      );
    end if;

    v_mode := 'legacy_reconciliation_resolution';
    v_before_lifecycle := public.resolve_booking_lifecycle(
      v_booking.status,
      v_booking.airlines_pnr,
      v_booking.ticketing_deadline_at,
      v_booking.operation_kind
    );
    update public.flight_bookings
       set status = 'cancelled',
           booking_status = 'Cancelled',
           operation_kind = null,
           operation_reason = null,
           operation_request_id = null,
           operation_actor_user_id = null,
           operation_started_at = null,
           operation_prior_status = null
     where id = v_booking.id;
  else
    return jsonb_build_object(
      'ok', false, 'code', 'BOOKING_NOT_ELIGIBLE_FOR_VERIFIED_CANCELLATION'
    );
  end if;

  v_event_evidence := p_evidence || jsonb_build_object(
    'reconciliationMode', v_mode,
    'supplierApiCalled', false,
    'walletMutation', false,
    'cancelledAtPreserved', true,
    'previousOperationKind', v_booking.operation_kind,
    'previousOperationReason', v_booking.operation_reason
  );

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
    v_before_lifecycle,
    'cancelled',
    v_booking.status,
    'cancelled',
    v_booking.operation_kind,
    v_booking.operation_reason,
    p_actor_user_id,
    'VerifiedManualReconciliation',
    v_event_evidence,
    p_idempotency_key
  )
  on conflict (booking_id, idempotency_key, to_lifecycle_status)
    where idempotency_key is not null
  do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select id into v_event_id
      from public.booking_status_events
     where booking_id = v_booking.id
       and idempotency_key = p_idempotency_key
       and to_lifecycle_status = 'cancelled';
  else
    insert into public.security_audit_events (
      actor_user_id,
      actor_role,
      action,
      target_type,
      target_id,
      outcome,
      metadata
    ) values (
      p_actor_user_id,
      'system',
      'booking.verified_cancellation_reconciled',
      'booking',
      v_booking.id::text,
      'succeeded',
      jsonb_build_object(
        'publicRef', v_booking.public_ref,
        'mode', v_mode,
        'statusEventId', v_event_id,
        'idempotencyKey', p_idempotency_key,
        'supplierApiCalled', false,
        'walletMutation', false
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'replay', false,
    'status', 'cancelled',
    'mode', v_mode,
    'eventId', v_event_id,
    'walletMutation', false
  );
end;
$$;

revoke all on function public.resolve_verified_booking_cancellation(uuid,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.resolve_verified_booking_cancellation(uuid,text,text,jsonb)
  to service_role;

comment on function public.resolve_verified_booking_cancellation(uuid,text,text,jsonb) is
  'Resolves only verified unpaid legacy cancellations or repairs an already-cancelled event; never mutates wallet state or cancelled_at.';
