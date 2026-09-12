-- Forward reissue of the later duplicate 0060 migration. Production already
-- owns 0060_booking_lifecycle_event_outbox, so this never repairs or changes
-- that historical migration; it applies this independent functionality once
-- under the next unique forward version.
--
-- A captured booking may be proven cancelled before the financial disposition
-- is known. This narrow contract records that supplier truth without releasing
-- a reservation, moving a wallet balance, creating a ledger entry, or closing
-- the case. A later, independently-approved financial proposal must use the
-- exact captured-cancellation wrappers from 0056.

create or replace function public.confirm_booking_reconciliation_cancelled_captured_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_expected_case_version integer,
  p_proposal_hash text,
  p_actor_user_id text,
  p_execution_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract jsonb;
  v_booking public.flight_bookings;
  v_case public.booking_reconciliation_cases;
  v_operation public.booking_operations;
  v_reservation public.wallet_reservations;
  v_evidence public.booking_reconciliation_observations;
  v_existing public.booking_reconciliation_observations;
  v_supplier_pnr text;
  v_airlines_pnr jsonb;
  v_supplier_status text;
  v_cancelled_at timestamptz;
  v_event_id bigint;
  v_occurrence_number integer;
  v_from_lifecycle text;
  v_confirmation_facts jsonb;
  v_confirmation_hash text;
  v_result jsonb;
begin
  -- A repeat may arrive after the status proposal has deliberately been
  -- cleared for the subsequent financial proposal. The immutable observation
  -- is the case-bound idempotency record for this first, no-money stage.
  select observation.* into v_existing
    from public.booking_reconciliation_observations observation
   where observation.reconciliation_case_id = p_case_id
     and observation.observation_key = p_execution_request_key || ':cancelled-confirmed';
  if found then
    if v_existing.normalized_facts->>'action'
         <> 'captured_cancellation_confirmed' then
      raise exception 'captured cancellation request identity mismatch'
        using errcode = '22023';
    end if;
    return coalesce(v_existing.normalized_facts->'result', '{}'::jsonb)
      || jsonb_build_object('ok', true, 'replay', true, 'caseId', p_case_id);
  end if;

  v_contract := public.booking_reconciliation_resolution_contract_v1(
    p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
    p_actor_user_id, p_execution_request_key, 'cancelled'
  );
  if coalesce((v_contract->>'ok')::boolean, false) is not true
     or coalesce((v_contract->>'replay')::boolean, false) then
    return v_contract;
  end if;

  select * into strict v_booking
    from public.flight_bookings where id = p_booking_id;
  select * into strict v_case
    from public.booking_reconciliation_cases where id = p_case_id;

  if v_case.financial_disposition <> 'none'
     or v_case.proposed_outcome <> 'cancelled'
     or v_booking.status not in ('on-hold', 'pending', 'in-progress')
     or v_booking.payment_state not in (
       'captured', 'partially-refunded', 'reconciliation'
     )
     or v_booking.captured_amount <= 0
     or v_booking.refunded_amount < 0
     or v_booking.refunded_amount >= v_booking.captured_amount then
    return jsonb_build_object(
      'ok', false, 'code', 'BOOKING_NOT_CAPTURED_CANCELLATION_CONFIRMABLE'
    );
  end if;
  if v_case.operation_id is not null then
    select * into v_operation
      from public.booking_operations where id = v_case.operation_id;
    if not found or v_operation.state <> 'needs_reconciliation' then
      return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_RECONCILING');
    end if;
  end if;
  select * into v_reservation
    from public.wallet_reservations
   where id = (v_contract->>'reservationId')::uuid;
  if not found
     or v_reservation.state <> 'captured'
     or v_reservation.booking_id is distinct from p_booking_id
     or v_reservation.amount <> v_booking.captured_amount
     or v_reservation.wallet_account_id
        is distinct from v_booking.charged_wallet_account_id then
    return jsonb_build_object('ok', false, 'code', 'CAPTURED_RESERVATION_REQUIRED');
  end if;

  select observation.* into v_evidence
    from jsonb_array_elements_text(
      v_case.proposal->'evidenceObservationIds'
    ) evidence_id(id)
    join public.booking_reconciliation_observations observation
      on observation.id = evidence_id.id::uuid
     and observation.reconciliation_case_id = v_case.id
   where observation.normalized_facts->>'requestedPurpose' = 'cancelled'
     and observation.normalized_facts #>> '{validation,authoritativeFor}' = 'cancelled'
     and observation.normalized_facts #>> '{validation,valid}' = 'true'
     and observation.normalized_facts #>> '{validation,complete}' = 'true'
     and observation.normalized_facts #>> '{validation,fresh}' = 'true'
     and observation.normalized_facts
       #>> '{validation,identityMatches}' = 'true'
     and observation.normalized_facts
       #>> '{evidence,airTicketing,source}' = 'air-ticketing-details'
   order by observation.observed_at desc, observation.id desc
   limit 1;
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'AUTHORITATIVE_CANCELLATION_EVIDENCE_REQUIRED'
    );
  end if;

  v_supplier_pnr := nullif(btrim(v_evidence.normalized_facts
    #>> '{evidence,airTicketing,facts,pnr}'), '');
  v_airlines_pnr := v_evidence.normalized_facts
    #> '{evidence,airTicketing,facts,airlinesPnr}';
  v_supplier_status := nullif(btrim(v_evidence.normalized_facts
    #>> '{evidence,airTicketing,facts,supplierStatus}'), '');
  begin
    v_cancelled_at := nullif(v_evidence.normalized_facts
      #>> '{evidence,airTicketing,facts,cancelledAt}', '')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CANCELLATION_TIMESTAMP');
  end;
  v_cancelled_at := coalesce(v_cancelled_at, v_evidence.observed_at);
  if v_cancelled_at > v_evidence.observed_at + interval '1 minute' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CANCELLATION_TIMESTAMP');
  end if;

  v_from_lifecycle := public.resolve_booking_lifecycle(
    v_booking.status, v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, v_booking.operation_kind
  );
  update public.flight_bookings
     set status = 'cancelled',
         cancelled_at = coalesce(cancelled_at, v_cancelled_at),
         cancelled_by = p_actor_user_id,
         cancel_reason = coalesce(
           nullif(v_case.proposal->>'reason', ''),
           'Supplier cancellation verified; financial review remains open'
         ),
         pnr = coalesce(v_supplier_pnr, pnr),
         airlines_pnr = case
           when jsonb_typeof(v_airlines_pnr) = 'array'
             and jsonb_array_length(v_airlines_pnr) > 0
             then v_airlines_pnr else airlines_pnr end,
         booking_status = coalesce(v_supplier_status, 'Cancelled')
   where id = v_booking.id;

  if v_case.operation_id is not null then
    update public.booking_operations
       set supplier_evidence = coalesce(supplier_evidence, '{}'::jsonb)
           || jsonb_build_object(
             'reconciliationCancellationConfirmed', jsonb_build_object(
               'caseId', v_case.id,
               'evidenceObservationId', v_evidence.id,
               'financialReviewRequired', true
             )
           )
     where id = v_case.operation_id;
  end if;

  select count(*)::integer + 1 into v_occurrence_number
    from public.booking_status_events event
   where event.booking_id = v_booking.id
     and event.to_lifecycle_status = 'cancelled';
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, operation_id,
    reconciliation_case_id, occurrence_number,
    effective_at, observed_at, event_snapshot, event_version
  ) values (
    v_booking.id, v_from_lifecycle, 'cancelled',
    v_booking.status, 'cancelled', v_booking.operation_kind,
    v_booking.operation_reason, p_actor_user_id,
    'ReconciliationCapturedCancellationConfirmed',
    jsonb_build_object('evidenceObservationId', v_evidence.id),
    p_execution_request_key || ':cancelled', v_case.operation_id,
    v_case.id, v_occurrence_number, v_cancelled_at,
    clock_timestamp(),
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'lifecycleStatus', 'cancelled',
      'paymentState', v_booking.payment_state,
      'financialReviewRequired', true,
      'financialDisposition', 'none',
      'resolutionReason', v_case.proposal->>'reason',
      'reconciliationCaseId', v_case.id
    ), 1
  ) returning id into v_event_id;

  v_result := jsonb_build_object(
    'bookingStatus', 'cancelled',
    'paymentState', v_booking.payment_state,
    'lifecycleEventId', v_event_id,
    'evidenceObservationId', v_evidence.id,
    'statusMutation', true,
    'walletMutation', false,
    'reservationMutation', false,
    'ledgerMutation', false,
    'financialReviewRequired', true
  );
  v_confirmation_facts := jsonb_build_object(
    'action', 'captured_cancellation_confirmed',
    'evidenceObservationId', v_evidence.id,
    'evidenceSource', 'air-ticketing-details',
    'proposalHash', v_case.proposal_hash,
    'previousBookingStatus', v_booking.status,
    'newBookingStatus', 'cancelled',
    'paymentStateBefore', v_booking.payment_state,
    'paymentStateAfter', v_booking.payment_state,
    'walletMutation', false,
    'resolutionReason', v_case.proposal->>'reason',
    'result', v_result
  );
  v_confirmation_hash := encode(
    sha256(convert_to(v_confirmation_facts::text, 'UTF8')), 'hex'
  );
  insert into public.booking_reconciliation_observations (
    reconciliation_case_id, observation_key, observation_kind,
    observation_source, actor_user_id, actor_role, normalized_facts,
    normalized_facts_hash, observed_at
  ) values (
    v_case.id, p_execution_request_key || ':cancelled-confirmed',
    'staff_evidence', 'staff', p_actor_user_id, v_contract->>'actorRole',
    v_confirmation_facts, v_confirmation_hash, clock_timestamp()
  );

  -- The status proposal has been executed. Clear it only after preserving its
  -- reason/evidence in immutable lifecycle and observation records, then keep
  -- the same case open for the distinct financial proposal.
  update public.booking_reconciliation_cases
     set state = 'awaiting_finance',
         proposed_outcome = null,
         proposal = '{}'::jsonb,
         proposal_hash = null,
         proposed_by_user_id = null,
         proposed_at = null,
         approved_by_user_id = null,
         approved_at = null,
         rejected_by_user_id = null,
         rejected_at = null,
         rejection_reason = null,
         financial_disposition = 'none',
         financial_amount = null,
         financial_currency = null,
         external_settlement_reference = null,
         version = version + 1
   where id = v_case.id;

  return v_result || jsonb_build_object(
    'ok', true, 'replay', false,
    'caseId', v_case.id,
    'caseVersion', v_case.version + 1,
    'resolutionKind', 'cancelled'
  );
end;
$$;

revoke all on function public.confirm_booking_reconciliation_cancelled_captured_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.confirm_booking_reconciliation_cancelled_captured_v1(
  uuid, uuid, integer, text, text, text
) to service_role;

comment on function public.confirm_booking_reconciliation_cancelled_captured_v1(
  uuid, uuid, integer, text, text, text
) is
  'Confirms a fresh, authoritative captured-booking cancellation without any wallet or ledger mutation. It keeps the same immutable case open for a separate financial review.';

-- Keeping a case open is an explicit investigative decision, not a silent
-- dismissal. Store the note as immutable case evidence; it cannot close or
-- mutate booking/payment/wallet state.
create or replace function public.record_booking_reconciliation_keep_open_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_evidence_observation_id uuid,
  p_actor_user_id text,
  p_request_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_case public.booking_reconciliation_cases;
  v_evidence public.booking_reconciliation_observations;
  v_existing public.booking_reconciliation_observations;
  v_facts jsonb;
  v_hash text;
begin
  if p_booking_id is null or p_case_id is null
     or p_evidence_observation_id is null
     or nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_request_key), '') is null
     or char_length(p_request_key) > 220
     or nullif(btrim(p_reason), '') is null
     or char_length(p_reason) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_KEEP_OPEN_NOTE');
  end if;
  select app_user.role into v_actor_role
    from public.app_users app_user
   where app_user.clerk_id = p_actor_user_id;
  if not found or v_actor_role not in ('superadmin', 'admin', 'staff_support') then
    return jsonb_build_object('ok', false, 'code', 'KEEP_OPEN_FORBIDDEN');
  end if;
  select reconciliation_case.* into v_case
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.id = p_case_id
     and reconciliation_case.subject_booking_id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND');
  end if;
  if v_case.state not in (
       'open', 'assigned', 'awaiting_supplier',
       'awaiting_finance', 'awaiting_approval'
     ) then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_OPEN');
  end if;
  select observation.* into v_evidence
    from public.booking_reconciliation_observations observation
   where observation.id = p_evidence_observation_id
     and observation.reconciliation_case_id = p_case_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_CASE_MISMATCH');
  end if;
  select observation.* into v_existing
    from public.booking_reconciliation_observations observation
   where observation.reconciliation_case_id = p_case_id
     and observation.observation_key = p_request_key || ':keep-open';
  if found then
    if v_existing.actor_user_id = p_actor_user_id
       and v_existing.normalized_facts->>'action' = 'case_kept_open'
       and v_existing.normalized_facts->>'reason' = p_reason
       and v_existing.normalized_facts->>'evidenceObservationId'
         = p_evidence_observation_id::text then
      return jsonb_build_object(
        'ok', true, 'replay', true, 'caseId', p_case_id,
        'caseVersion', v_case.version,
        'statusMutation', false, 'walletMutation', false
      );
    end if;
    raise exception 'keep-open request identity mismatch' using errcode = '22023';
  end if;
  v_facts := jsonb_build_object(
    'action', 'case_kept_open',
    'evidenceObservationId', p_evidence_observation_id,
    'evidenceSource', v_evidence.observation_source,
    'previousCaseState', v_case.state,
    'newCaseState', v_case.state,
    'previousBookingStatus', null,
    'newBookingStatus', null,
    'paymentChanges', false,
    'reason', p_reason
  );
  v_hash := encode(sha256(convert_to(v_facts::text, 'UTF8')), 'hex');
  insert into public.booking_reconciliation_observations (
    reconciliation_case_id, observation_key, observation_kind,
    observation_source, actor_user_id, actor_role,
    normalized_facts, normalized_facts_hash, observed_at
  ) values (
    p_case_id, p_request_key || ':keep-open', 'staff_evidence', 'staff',
    p_actor_user_id, v_actor_role, v_facts, v_hash, clock_timestamp()
  );
  return jsonb_build_object(
    'ok', true, 'replay', false, 'caseId', p_case_id,
    'caseVersion', v_case.version,
    'statusMutation', false, 'walletMutation', false
  );
end;
$$;

revoke all on function public.record_booking_reconciliation_keep_open_v1(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_booking_reconciliation_keep_open_v1(
  uuid, uuid, uuid, text, text, text
) to service_role;

comment on function public.record_booking_reconciliation_keep_open_v1(
  uuid, uuid, uuid, text, text, text
) is
  'Appends an immutable evidence-linked investigation note without closing a case or mutating booking/payment/wallet state.';
