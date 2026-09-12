-- Proven supplier cancellation for an unpaid booking. This exact branch has
-- no wallet, reservation, or ledger effect. Other payment states remain
-- fail-closed for their later outcome-specific implementations.

create or replace function public.resolve_booking_reconciliation_cancelled_v1(
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
  v_evidence public.booking_reconciliation_observations;
  v_supplier_pnr text;
  v_airlines_pnr jsonb;
  v_supplier_status text;
  v_cancelled_at timestamptz;
  v_event_id bigint;
  v_occurrence_number integer;
  v_from_lifecycle text;
  v_resolution_result jsonb;
begin
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
  if v_case.financial_disposition <> 'none' then
    return jsonb_build_object('ok', false, 'code', 'UNPAID_DISPOSITION_MUST_BE_NONE');
  end if;
  if v_booking.status not in ('on-hold', 'pending', 'in-progress')
     or v_booking.payment_state <> 'unpaid'
     or v_booking.captured_amount <> 0
     or v_booking.refunded_amount <> 0
     or v_booking.charged_wallet_account_id is not null
     or v_contract->>'reservationId' is not null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_UNPAID_CANCELLABLE');
  end if;
  if v_case.operation_id is not null then
    select * into v_operation
      from public.booking_operations where id = v_case.operation_id;
    if v_operation.state <> 'needs_reconciliation' then
      return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_RECONCILING');
    end if;
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
    return jsonb_build_object('ok', false, 'code', 'AUTHORITATIVE_CANCELLATION_EVIDENCE_REQUIRED');
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
           'Supplier cancellation verified during reconciliation'
         ),
         pnr = coalesce(v_supplier_pnr, pnr),
         airlines_pnr = case
           when jsonb_typeof(v_airlines_pnr) = 'array'
             and jsonb_array_length(v_airlines_pnr) > 0
             then v_airlines_pnr else airlines_pnr end,
         booking_status = coalesce(v_supplier_status, 'Cancelled'),
         active_operation_id = null,
         operation_kind = null,
         operation_reason = null,
         operation_request_id = null,
         operation_actor_user_id = null,
         operation_started_at = null,
         operation_prior_status = null
   where id = v_booking.id;
  if v_case.operation_id is not null then
    update public.booking_operations
       set state = 'succeeded',
           completed_at = clock_timestamp(),
           error_code = null,
           error_message = null,
           supplier_evidence = supplier_evidence || jsonb_build_object(
             'reconciliationResolution', jsonb_build_object(
               'caseId', v_case.id,
               'outcome', 'cancelled',
               'evidenceObservationId', v_evidence.id
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
    'ReconciliationCancelledUnpaid',
    jsonb_build_object('evidenceObservationId', v_evidence.id),
    p_execution_request_key || ':cancelled', v_case.operation_id,
    v_case.id, v_occurrence_number, v_cancelled_at,
    clock_timestamp(),
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'lifecycleStatus', 'cancelled',
      'paymentState', 'unpaid',
      'operationKind', coalesce(v_booking.operation_kind, 'reconciliation'),
      'reconciliationCaseId', v_case.id
    ), 1
  ) returning id into v_event_id;

  v_resolution_result := jsonb_build_object(
    'bookingStatus', 'cancelled',
    'paymentState', 'unpaid',
    'lifecycleEventId', v_event_id,
    'walletMutation', false,
    'reservationMutation', false,
    'ledgerMutation', false
  );
  update public.booking_reconciliation_cases
     set state = 'resolved',
         resolution_outcome = 'cancelled_unpaid',
         resolution = jsonb_build_object(
           'version', 1,
           'executionRequestKey', p_execution_request_key,
           'proposalHash', v_case.proposal_hash,
           'resolutionKind', 'cancelled',
           'executedByRole', v_contract->>'actorRole',
           'evidenceObservationIds', v_case.proposal->'evidenceObservationIds',
           'result', v_resolution_result
         ),
         resolution_reason = v_case.proposal->>'reason',
         resolved_by_user_id = p_actor_user_id,
         resolved_at = clock_timestamp(),
         closed_at = clock_timestamp(),
         version = version + 1
   where id = v_case.id;

  return v_resolution_result || jsonb_build_object(
    'ok', true, 'replay', false,
    'caseId', v_case.id,
    'caseVersion', v_case.version + 1,
    'resolutionKind', 'cancelled'
  );
end;
$$;

revoke all on function public.resolve_booking_reconciliation_cancelled_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.resolve_booking_reconciliation_cancelled_v1(
  uuid, uuid, integer, text, text, text
) to service_role;

comment on function public.resolve_booking_reconciliation_cancelled_v1(
  uuid, uuid, integer, text, text, text
) is
  'Resolves fresh authoritative supplier cancellation for an exactly Unpaid booking. It cancels/completes lifecycle state atomically and cannot mutate reservation, wallet, or ledger rows.';
