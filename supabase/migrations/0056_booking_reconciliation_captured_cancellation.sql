-- Captured cancellation financial outcomes. Four public RPCs expose four exact
-- consequences; one private engine reads the approved disposition from the
-- locked case. There is no caller-selected generic financial action.

create or replace function public.execute_booking_captured_cancellation_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_expected_case_version integer,
  p_proposal_hash text,
  p_actor_user_id text,
  p_execution_request_key text,
  p_expected_disposition text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract_kind text;
  v_contract jsonb;
  v_booking public.flight_bookings;
  v_case public.booking_reconciliation_cases;
  v_operation public.booking_operations;
  v_reservation public.wallet_reservations;
  v_account public.wallet_accounts;
  v_evidence public.booking_reconciliation_observations;
  v_supplier_pnr text;
  v_airlines_pnr jsonb;
  v_supplier_status text;
  v_cancelled_at timestamptz;
  v_outstanding bigint;
  v_refund_amount bigint := 0;
  v_refunded_after bigint;
  v_retained_amount bigint;
  v_payment_after text;
  v_available_before bigint;
  v_ledger_entry_id uuid;
  v_event_id bigint;
  v_occurrence_number integer;
  v_from_lifecycle text;
  v_resolution_outcome text;
  v_resolution_result jsonb;
begin
  if p_expected_disposition not in (
       'full_refund', 'partial_refund',
       'no_refund_due', 'externally_settled'
     ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CAPTURED_CANCELLATION_MODE');
  end if;
  select case
    when reconciliation_case.proposed_outcome = 'cancelled'
      and coalesce(
        reconciliation_case.proposal->'riskFlags'
          @> '["terminal_correction"]'::jsonb,
        false
      )
      then 'terminal_correction'
    when reconciliation_case.proposed_outcome = 'cancelled'
      then 'cancelled'
    when reconciliation_case.proposed_outcome = 'financial_only'
      then 'financial'
    else null
  end into v_contract_kind
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.id = p_case_id
     and reconciliation_case.subject_booking_id = p_booking_id;
  if v_contract_kind is null then
    return jsonb_build_object('ok', false, 'code', 'CAPTURED_CANCELLATION_OUTCOME_REQUIRED');
  end if;
  v_contract := public.booking_reconciliation_resolution_contract_v1(
    p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
    p_actor_user_id, p_execution_request_key, v_contract_kind
  );
  if coalesce((v_contract->>'ok')::boolean, false) is not true
     or coalesce((v_contract->>'replay')::boolean, false) then
    return v_contract;
  end if;
  select * into strict v_booking
    from public.flight_bookings where id = p_booking_id;
  select * into strict v_case
    from public.booking_reconciliation_cases where id = p_case_id;
  if v_case.financial_disposition <> p_expected_disposition then
    return jsonb_build_object('ok', false, 'code', 'FINANCIAL_DISPOSITION_MISMATCH');
  end if;
  if (v_contract_kind = 'terminal_correction'
       and (v_case.proposed_outcome <> 'cancelled'
         or v_booking.status <> 'confirmed'))
     or (v_contract_kind = 'financial'
       and (v_case.proposed_outcome <> 'financial_only'
         or v_booking.status <> 'cancelled'))
     or (v_contract_kind = 'cancelled'
       and (v_case.proposed_outcome <> 'cancelled'
         or v_booking.status not in (
           'on-hold', 'pending', 'in-progress', 'cancelled'
         ))) then
    return jsonb_build_object('ok', false, 'code', 'CANCELLATION_STATUS_MISMATCH');
  end if;
  if v_booking.payment_state not in (
       'captured', 'partially-refunded', 'reconciliation'
     )
     or v_booking.captured_amount <= 0
     or v_booking.refunded_amount < 0
     or v_booking.refunded_amount >= v_booking.captured_amount then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_CAPTURED_CANCELLATION');
  end if;
  if v_case.operation_id is not null then
    select * into v_operation
      from public.booking_operations where id = v_case.operation_id;
    if v_operation.state <> 'needs_reconciliation' then
      return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_RECONCILING');
    end if;
  end if;
  select * into v_reservation
    from public.wallet_reservations
   where id = (v_contract->>'reservationId')::uuid;
  if not found
     or v_reservation.state <> 'captured'
     or v_reservation.booking_id is distinct from p_booking_id
     or v_reservation.amount <> v_booking.captured_amount then
    return jsonb_build_object('ok', false, 'code', 'CAPTURED_RESERVATION_REQUIRED');
  end if;
  select * into v_account
    from public.wallet_accounts
   where id = v_reservation.wallet_account_id;
  if not found
     or v_account.id is distinct from (v_contract->>'walletAccountId')::uuid
     or v_booking.charged_wallet_account_id is distinct from v_account.id
     or v_account.currency <> v_reservation.currency
     or v_booking.currency <> v_reservation.currency then
    return jsonb_build_object('ok', false, 'code', 'REFUND_IDENTITY_MISMATCH');
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

  v_outstanding := v_booking.captured_amount - v_booking.refunded_amount;
  if p_expected_disposition = 'full_refund' then
    v_refund_amount := v_outstanding;
    v_resolution_outcome := 'cancelled_full_refund';
  elsif p_expected_disposition = 'partial_refund' then
    if v_case.financial_amount is null
       or v_case.financial_amount <= 0
       or v_case.financial_amount >= v_outstanding
       or v_case.financial_currency <> v_booking.currency then
      return jsonb_build_object('ok', false, 'code', 'INVALID_PARTIAL_REFUND');
    end if;
    v_refund_amount := v_case.financial_amount;
    v_resolution_outcome := 'cancelled_partial_refund';
  elsif p_expected_disposition = 'no_refund_due' then
    if not (v_case.proposal->'confirmationCodes'
      @> '["confirm_fee_or_no_refund"]'::jsonb) then
      return jsonb_build_object('ok', false, 'code', 'NO_REFUND_CONFIRMATION_REQUIRED');
    end if;
    v_resolution_outcome := 'cancelled_no_refund_due';
  else
    if nullif(btrim(v_case.external_settlement_reference), '') is null
       or not (v_case.proposal->'confirmationCodes'
         @> '["confirm_external_settlement"]'::jsonb) then
      return jsonb_build_object('ok', false, 'code', 'EXTERNAL_SETTLEMENT_CONFIRMATION_REQUIRED');
    end if;
    v_resolution_outcome := 'cancelled_externally_settled';
  end if;

  v_available_before := v_account.available_balance;
  if v_refund_amount > 0 then
    if exists (
      select 1 from public.wallet_ledger_entries ledger
       where ledger.idempotency_key = p_execution_request_key || ':refund'
    ) then
      return jsonb_build_object('ok', false, 'code', 'REFUND_IDEMPOTENCY_CONFLICT');
    end if;
    update public.wallet_accounts
       set available_balance = available_balance + v_refund_amount
     where id = v_account.id;
    insert into public.wallet_ledger_entries (
      wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after,
      booking_id, booking_reference, reservation_id, idempotency_key,
      created_by_user_id, created_by_role, remarks, metadata
    ) values (
      v_account.id, 'refund', v_refund_amount, v_booking.currency,
      v_available_before, v_available_before + v_refund_amount,
      v_account.hold_balance, v_account.hold_balance,
      v_booking.id, v_booking.public_ref, v_reservation.id,
      p_execution_request_key || ':refund', p_actor_user_id,
      v_contract->>'actorRole',
      'Approved captured cancellation reconciliation',
      jsonb_build_object(
        'reconciliationCaseId', v_case.id,
        'proposalHash', v_case.proposal_hash,
        'operationId', v_case.operation_id,
        'evidenceObservationId', v_evidence.id,
        'financialDisposition', p_expected_disposition
      )
    ) returning id into v_ledger_entry_id;
  end if;
  v_refunded_after := v_booking.refunded_amount + v_refund_amount;
  v_retained_amount := v_booking.captured_amount - v_refunded_after;
  v_payment_after := case
    when v_refunded_after = v_booking.captured_amount then 'refunded'
    when v_refunded_after > 0 then 'partially-refunded'
    else 'captured'
  end;

  v_from_lifecycle := public.resolve_booking_lifecycle(
    v_booking.status, v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, v_booking.operation_kind
  );
  update public.flight_bookings
     set status = 'cancelled',
         payment_state = v_payment_after,
         refunded_amount = v_refunded_after,
         cancelled_at = coalesce(cancelled_at, v_cancelled_at),
         cancelled_by = p_actor_user_id,
         cancel_reason = coalesce(
           nullif(v_case.proposal->>'reason', ''),
           'Captured supplier cancellation resolved'
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
               'evidenceObservationId', v_evidence.id,
               'financialDisposition', p_expected_disposition
             )
           )
     where id = v_case.operation_id;
  end if;

  -- A later financial disposition is a material customer occurrence even
  -- when supplier cancellation was already recorded. Preserve it as a
  -- Cancelled -> Cancelled event so the outbox can notify the new money truth.
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
      case
        when v_contract_kind = 'terminal_correction'
          then 'TerminalCorrectionCapturedCancellation'
        when v_from_lifecycle = 'cancelled'
          then 'ReconciliationCancellationFinancialOutcome'
        else 'ReconciliationCapturedCancellation'
      end,
      jsonb_build_object('evidenceObservationId', v_evidence.id),
      p_execution_request_key || ':cancelled', v_case.operation_id,
      v_case.id, v_occurrence_number,
      case when v_from_lifecycle = 'cancelled'
        then clock_timestamp() else v_cancelled_at end,
      clock_timestamp(),
      jsonb_build_object(
        'version', 1,
        'bookingReference', v_booking.public_ref,
        'lifecycleStatus', 'cancelled',
        'paymentState', v_payment_after,
        'financialDisposition', p_expected_disposition,
        'terminalCorrection', v_contract_kind = 'terminal_correction',
        'reconciliationCaseId', v_case.id
      ), 1
    ) returning id into v_event_id;

  v_resolution_result := jsonb_build_object(
    'bookingStatus', 'cancelled',
    'paymentState', v_payment_after,
    'financialDisposition', p_expected_disposition,
    'reservationId', v_reservation.id,
    'walletAccountId', v_account.id,
    'ledgerEntryId', v_ledger_entry_id,
    'lifecycleEventId', v_event_id,
    'refundAmount', v_refund_amount,
    'refundedAmount', v_refunded_after,
    'retainedAmount', v_retained_amount,
    'capturedAmount', v_booking.captured_amount,
    'currency', v_booking.currency,
    'walletMutation', v_refund_amount > 0,
    'externalSettlementReference', case
      when p_expected_disposition = 'externally_settled'
        then v_case.external_settlement_reference else null end,
    'availableBalance', v_available_before + v_refund_amount,
    'holdBalance', v_account.hold_balance
  );
  update public.booking_reconciliation_cases
     set state = 'resolved',
         resolution_outcome = v_resolution_outcome,
         resolution = jsonb_build_object(
           'version', 1,
           'executionRequestKey', p_execution_request_key,
           'proposalHash', v_case.proposal_hash,
           'resolutionKind', v_contract_kind,
           'financialDisposition', p_expected_disposition,
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
    'resolutionKind', v_contract_kind
  );
end;
$$;

create or replace function public.resolve_booking_reconciliation_cancelled_full_refund_v1(
  p_booking_id uuid, p_case_id uuid, p_expected_case_version integer,
  p_proposal_hash text, p_actor_user_id text, p_execution_request_key text
)
returns jsonb language sql security definer set search_path = public
as $$ select public.execute_booking_captured_cancellation_v1(
  p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
  p_actor_user_id, p_execution_request_key, 'full_refund'
); $$;

create or replace function public.resolve_booking_reconciliation_cancelled_partial_refund_v1(
  p_booking_id uuid, p_case_id uuid, p_expected_case_version integer,
  p_proposal_hash text, p_actor_user_id text, p_execution_request_key text
)
returns jsonb language sql security definer set search_path = public
as $$ select public.execute_booking_captured_cancellation_v1(
  p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
  p_actor_user_id, p_execution_request_key, 'partial_refund'
); $$;

create or replace function public.resolve_booking_reconciliation_cancelled_no_refund_v1(
  p_booking_id uuid, p_case_id uuid, p_expected_case_version integer,
  p_proposal_hash text, p_actor_user_id text, p_execution_request_key text
)
returns jsonb language sql security definer set search_path = public
as $$ select public.execute_booking_captured_cancellation_v1(
  p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
  p_actor_user_id, p_execution_request_key, 'no_refund_due'
); $$;

create or replace function public.resolve_booking_reconciliation_cancelled_external_settlement_v1(
  p_booking_id uuid, p_case_id uuid, p_expected_case_version integer,
  p_proposal_hash text, p_actor_user_id text, p_execution_request_key text
)
returns jsonb language sql security definer set search_path = public
as $$ select public.execute_booking_captured_cancellation_v1(
  p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
  p_actor_user_id, p_execution_request_key, 'externally_settled'
); $$;

revoke all on function public.execute_booking_captured_cancellation_v1(
  uuid, uuid, integer, text, text, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.resolve_booking_reconciliation_cancelled_full_refund_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
revoke all on function public.resolve_booking_reconciliation_cancelled_partial_refund_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
revoke all on function public.resolve_booking_reconciliation_cancelled_no_refund_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
revoke all on function public.resolve_booking_reconciliation_cancelled_external_settlement_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;

grant execute on function public.resolve_booking_reconciliation_cancelled_full_refund_v1(
  uuid, uuid, integer, text, text, text
) to service_role;
grant execute on function public.resolve_booking_reconciliation_cancelled_partial_refund_v1(
  uuid, uuid, integer, text, text, text
) to service_role;
grant execute on function public.resolve_booking_reconciliation_cancelled_no_refund_v1(
  uuid, uuid, integer, text, text, text
) to service_role;
grant execute on function public.resolve_booking_reconciliation_cancelled_external_settlement_v1(
  uuid, uuid, integer, text, text, text
) to service_role;

comment on function public.execute_booking_captured_cancellation_v1(
  uuid, uuid, integer, text, text, text, text
) is
  'Private case-bound captured-cancellation engine. Only exact disposition wrappers can call it; service clients cannot select a generic mode.';
comment on function public.resolve_booking_reconciliation_cancelled_full_refund_v1(
  uuid, uuid, integer, text, text, text
) is 'Refunds the entire remaining captured cancellation balance through one approved, idempotent case resolution.';
comment on function public.resolve_booking_reconciliation_cancelled_partial_refund_v1(
  uuid, uuid, integer, text, text, text
) is 'Refunds the approved partial amount and records the retained fee through one approved, idempotent case resolution.';
comment on function public.resolve_booking_reconciliation_cancelled_no_refund_v1(
  uuid, uuid, integer, text, text, text
) is 'Closes an approved no-refund-due cancellation disposition without wallet mutation while preserving explicit captured financial truth.';
comment on function public.resolve_booking_reconciliation_cancelled_external_settlement_v1(
  uuid, uuid, integer, text, text, text
) is 'Closes an approved externally settled cancellation disposition without fabricating a wallet refund; the external reference remains case-bound.';
