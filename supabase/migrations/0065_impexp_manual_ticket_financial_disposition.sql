-- Captured imported manual-ticket failures require a case-bound financial
-- disposition. Proposal is non-mutating and always maker-checker. Execution
-- atomically records the terminal booking outcome, optional refund ledger,
-- operation failure, case resolution, lifecycle occurrence, and outbox intent.

create or replace function public.propose_impexp_manual_ticket_financial_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_expected_case_version integer,
  p_actor_user_id text,
  p_request_key text,
  p_financial_disposition text,
  p_financial_amount bigint,
  p_financial_currency text,
  p_external_settlement_reference text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_operation_id uuid;
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_evidence public.booking_reconciliation_observations;
  v_supplier_outcome text;
  v_outstanding bigint;
  v_risk_flags jsonb;
  v_confirmation_codes jsonb;
  v_proposal jsonb;
  v_proposal_hash text;
begin
  if p_booking_id is null
     or p_case_id is null
     or p_expected_case_version is null
     or p_expected_case_version < 1
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or p_request_key is null
     or p_request_key !~ '^impexp-financial-proposal:v1:[0-9a-f-]{36}$'
     or p_financial_disposition not in (
       'full_refund', 'partial_refund', 'no_refund_due',
       'externally_settled', 'manual_adjustment_required'
     )
     or nullif(btrim(coalesce(p_reason, '')), '') is null
     or char_length(p_reason) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_FINANCIAL_PROPOSAL');
  end if;
  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role is null
     or v_actor_role not in ('staff_account', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'FINANCIAL_PROPOSAL_FORBIDDEN');
  end if;

  select candidate.operation_id into v_operation_id
    from public.booking_reconciliation_cases candidate
   where candidate.id = p_case_id
     and candidate.subject_booking_id = p_booking_id;
  if not found or v_operation_id is null then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_CASE_NOT_FOUND');
  end if;

  -- Global mutation prefix: booking -> operation -> case. Proposal never locks
  -- or mutates reservation, wallet, account, ledger, event, or outbox rows.
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_NOT_FOUND');
  end if;
  select operation.* into v_operation
    from public.booking_operations operation
   where operation.id = v_operation_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_OPERATION_NOT_FOUND');
  end if;
  select candidate.* into v_case
    from public.booking_reconciliation_cases candidate
   where candidate.id = p_case_id
     and candidate.subject_booking_id = p_booking_id
     and candidate.operation_id = v_operation.id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_CASE_MISMATCH');
  end if;

  if v_case.proposal->>'requestKey' = p_request_key then
    v_proposal := jsonb_build_object(
      'version', 1,
      'proposalKind', 'imported_manual_ticket_financial',
      'requestKey', p_request_key,
      'domain', 'financial',
      'proposedOutcome', 'cancelled',
      'supplierOutcome', v_case.proposal->>'supplierOutcome',
      'riskFlags', v_case.proposal->'riskFlags',
      'makerCheckerRequired', true,
      'confirmationCodes', v_case.proposal->'confirmationCodes',
      'evidenceObservationIds', v_case.proposal->'evidenceObservationIds',
      'expectedBookingStatus', v_booking.status,
      'expectedPaymentState', v_booking.payment_state,
      'expectedCapturedAmount', v_booking.captured_amount,
      'expectedRefundedAmount', v_booking.refunded_amount,
      'financialDisposition', p_financial_disposition,
      'financialAmount', p_financial_amount,
      'financialCurrency', case when p_financial_currency is null
        then null else upper(p_financial_currency) end,
      'externalSettlementReference', p_external_settlement_reference,
      'reason', p_reason,
      'statusMutationAuthorized', true,
      'walletMutationAuthorized', p_financial_disposition in (
        'full_refund', 'partial_refund'
      )
    );
    v_proposal_hash := encode(
      sha256(convert_to(v_proposal::text, 'UTF8')), 'hex'
    );
    if v_case.proposal_hash = v_proposal_hash
       and v_case.proposed_by_user_id = p_actor_user_id then
      return jsonb_build_object(
        'ok', true, 'replay', true,
        'caseId', v_case.id,
        'caseVersion', v_case.version,
        'proposalHash', v_case.proposal_hash,
        'supplierOutcome', v_case.proposal->>'supplierOutcome',
        'financialDisposition', v_case.financial_disposition,
        'makerCheckerRequired', true,
        'statusMutation', false,
        'walletMutation', false
      );
    end if;
    raise exception 'imported financial proposal request identity mismatch'
      using errcode = '22023';
  end if;

  if v_booking.import_source is distinct from 'IMP_EXP'
     or v_booking.status <> 'in-progress'
     or v_booking.active_operation_id is distinct from v_operation.id
     or v_booking.operation_reason is distinct from 'imported_manual_ticketing'
     or v_operation.kind is distinct from 'imported_manual_ticketing'
     or v_operation.state is distinct from 'needs_reconciliation'
     or v_case.case_type is distinct from 'imported_manual_ticketing'
     or v_case.state not in ('assigned', 'awaiting_finance') then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_FINANCE_NOT_PROPOSABLE');
  end if;
  if v_case.approved_at is not null then
    return jsonb_build_object('ok', false, 'code', 'APPROVED_PROPOSAL_LOCKED');
  end if;
  if v_case.version <> p_expected_case_version then
    return jsonb_build_object(
      'ok', false, 'code', 'CASE_VERSION_CONFLICT',
      'caseVersion', v_case.version
    );
  end if;
  if v_booking.payment_state <> 'captured'
     or v_booking.user_payable_amount is null
     or v_booking.captured_amount is distinct from v_booking.user_payable_amount
     or v_booking.refunded_amount < 0
     or v_booking.refunded_amount >= v_booking.captured_amount
     or v_booking.charged_wallet_account_id is null then
    return jsonb_build_object('ok', false, 'code', 'CAPTURED_PAYMENT_MISMATCH');
  end if;
  v_outstanding := v_booking.captured_amount - v_booking.refunded_amount;

  select observation.* into v_evidence
    from public.booking_reconciliation_observations observation
   where observation.reconciliation_case_id = v_case.id
     and observation.observation_kind = 'staff_evidence'
     and observation.observation_source = 'supplier_read'
     and observation.normalized_facts->>'sourceKind'
        = 'imported_supplier_manage_booking'
     and observation.normalized_facts #>> '{outcome,classification}' in (
       'cancelled', 'expired', 'unconfirmed'
     )
     and observation.normalized_facts #>> '{outcome,authoritative}' = 'true'
     and observation.normalized_facts #>> '{validation,fresh}' = 'true'
     and observation.normalized_facts #>> '{validation,identityMatches}' = 'true'
     and observation.observed_at >= clock_timestamp() - interval '5 minutes'
   order by observation.observed_at desc, observation.id desc
   limit 1;
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'FRESH_NEGATIVE_IMPORTED_EVIDENCE_REQUIRED'
    );
  end if;
  v_supplier_outcome := v_evidence.normalized_facts
    #>> '{outcome,classification}';

  if p_financial_disposition = 'partial_refund' then
    if p_financial_amount is null
       or p_financial_amount <= 0
       or p_financial_amount >= v_outstanding
       or upper(coalesce(p_financial_currency, '')) <> v_booking.currency then
      return jsonb_build_object('ok', false, 'code', 'INVALID_PARTIAL_REFUND');
    end if;
  elsif p_financial_amount is not null or p_financial_currency is not null then
    return jsonb_build_object('ok', false, 'code', 'UNEXPECTED_FINANCIAL_AMOUNT');
  end if;
  if p_financial_disposition = 'externally_settled' then
    if nullif(btrim(coalesce(p_external_settlement_reference, '')), '') is null
       or char_length(p_external_settlement_reference) > 255 then
      return jsonb_build_object('ok', false, 'code', 'SETTLEMENT_REFERENCE_REQUIRED');
    end if;
  elsif p_external_settlement_reference is not null then
    return jsonb_build_object('ok', false, 'code', 'UNEXPECTED_SETTLEMENT_REFERENCE');
  end if;

  v_risk_flags := case p_financial_disposition
    when 'full_refund' then '["money_movement"]'::jsonb
    when 'partial_refund' then '["fee_or_no_refund","money_movement"]'::jsonb
    when 'no_refund_due' then '["fee_or_no_refund"]'::jsonb
    when 'externally_settled' then '["external_settlement"]'::jsonb
    else '["manual_adjustment"]'::jsonb
  end;
  v_confirmation_codes := case p_financial_disposition
    when 'partial_refund' then
      '["confirm_financial_disposition","confirm_fee_or_no_refund"]'::jsonb
    when 'no_refund_due' then
      '["confirm_financial_disposition","confirm_fee_or_no_refund"]'::jsonb
    when 'externally_settled' then
      '["confirm_external_settlement","confirm_financial_disposition"]'::jsonb
    else '["confirm_financial_disposition"]'::jsonb
  end;
  v_proposal := jsonb_build_object(
    'version', 1,
    'proposalKind', 'imported_manual_ticket_financial',
    'requestKey', p_request_key,
    'domain', 'financial',
    'proposedOutcome', 'cancelled',
    'supplierOutcome', v_supplier_outcome,
    'riskFlags', v_risk_flags,
    'makerCheckerRequired', true,
    'confirmationCodes', v_confirmation_codes,
    'evidenceObservationIds', jsonb_build_array(v_evidence.id),
    'expectedBookingStatus', v_booking.status,
    'expectedPaymentState', v_booking.payment_state,
    'expectedCapturedAmount', v_booking.captured_amount,
    'expectedRefundedAmount', v_booking.refunded_amount,
    'financialDisposition', p_financial_disposition,
    'financialAmount', p_financial_amount,
    'financialCurrency', case when p_financial_currency is null
      then null else upper(p_financial_currency) end,
    'externalSettlementReference', p_external_settlement_reference,
    'reason', p_reason,
    'statusMutationAuthorized', true,
    'walletMutationAuthorized', p_financial_disposition in (
      'full_refund', 'partial_refund'
    )
  );
  v_proposal_hash := encode(
    sha256(convert_to(v_proposal::text, 'UTF8')), 'hex'
  );

  update public.booking_reconciliation_cases
     set state = 'awaiting_approval',
         assigned_team = 'admin',
         assignee_user_id = null,
         assigned_at = clock_timestamp(),
         proposed_outcome = 'cancelled',
         proposal = v_proposal,
         proposal_hash = v_proposal_hash,
         proposed_by_user_id = p_actor_user_id,
         proposed_at = clock_timestamp(),
         approved_by_user_id = null,
         approved_at = null,
         rejected_by_user_id = null,
         rejected_at = null,
         rejection_reason = null,
         financial_disposition = p_financial_disposition,
         financial_amount = p_financial_amount,
         financial_currency = case when p_financial_currency is null
           then null else upper(p_financial_currency) end,
         external_settlement_reference = p_external_settlement_reference,
         version = version + 1
   where id = v_case.id;

  return jsonb_build_object(
    'ok', true, 'replay', false,
    'caseId', v_case.id,
    'caseVersion', v_case.version + 1,
    'proposalHash', v_proposal_hash,
    'supplierOutcome', v_supplier_outcome,
    'financialDisposition', p_financial_disposition,
    'riskFlags', v_risk_flags,
    'makerCheckerRequired', true,
    'statusMutation', false,
    'walletMutation', false
  );
end;
$$;

create or replace function public.execute_impexp_manual_ticket_financial_v1(
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
  v_actor_role text;
  v_operation_id uuid;
  v_wallet_id uuid;
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_evidence public.booking_reconciliation_observations;
  v_supplier_outcome text;
  v_disposition text;
  v_outstanding bigint;
  v_refund_amount bigint := 0;
  v_refunded_after bigint;
  v_retained_amount bigint;
  v_payment_after text;
  v_available_before bigint;
  v_capture_ledger_count integer;
  v_ledger_entry_id uuid;
  v_event_id bigint;
  v_occurrence_number integer;
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
begin
  if p_booking_id is null
     or p_case_id is null
     or p_expected_case_version is null
     or p_expected_case_version < 1
     or p_proposal_hash !~ '^[a-f0-9]{64}$'
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or p_execution_request_key is null
     or p_execution_request_key
        !~ '^impexp-financial-execute:v1:[0-9a-f-]{36}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_FINANCIAL_EXECUTION');
  end if;
  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role is null
     or v_actor_role not in ('admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'FINANCIAL_EXECUTION_FORBIDDEN');
  end if;

  select candidate.operation_id into v_operation_id
    from public.booking_reconciliation_cases candidate
   where candidate.id = p_case_id
     and candidate.subject_booking_id = p_booking_id;
  if not found or v_operation_id is null then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_CASE_NOT_FOUND');
  end if;

  -- Global financial mutation order:
  -- booking -> operation -> case -> reservation -> wallet -> account.
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_NOT_FOUND');
  end if;
  select operation.* into v_operation
    from public.booking_operations operation
   where operation.id = v_operation_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_OPERATION_NOT_FOUND');
  end if;
  select candidate.* into v_case
    from public.booking_reconciliation_cases candidate
   where candidate.id = p_case_id
     and candidate.subject_booking_id = p_booking_id
     and candidate.operation_id = v_operation.id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_CASE_MISMATCH');
  end if;

  if v_case.state = 'resolved' then
    if v_case.proposal_hash = p_proposal_hash
       and v_case.resolution->>'executionRequestKey' = p_execution_request_key
       and v_case.resolution->>'resolutionKind'
          = 'imported_manual_ticket_financial' then
      return coalesce(v_case.resolution->'result', '{}'::jsonb)
        || jsonb_build_object(
          'ok', true, 'replay', true,
          'caseId', v_case.id,
          'caseVersion', v_case.version,
          'proposalHash', v_case.proposal_hash,
          'resolutionKind', 'imported_manual_ticket_financial'
        );
    end if;
    return jsonb_build_object('ok', false, 'code', 'CASE_ALREADY_RESOLVED');
  end if;

  if v_booking.import_source is distinct from 'IMP_EXP'
     or v_booking.status <> 'in-progress'
     or v_booking.active_operation_id is distinct from v_operation.id
     or v_booking.payment_state <> 'captured'
     or v_booking.captured_amount is distinct from v_booking.user_payable_amount
     or v_booking.refunded_amount < 0
     or v_booking.refunded_amount >= v_booking.captured_amount
     or v_operation.kind is distinct from 'imported_manual_ticketing'
     or v_operation.state is distinct from 'needs_reconciliation'
     or v_case.case_type is distinct from 'imported_manual_ticketing' then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_FINANCE_NOT_EXECUTABLE');
  end if;
  if v_case.state <> 'awaiting_approval'
     or v_case.version <> p_expected_case_version
     or v_case.proposal_hash is distinct from p_proposal_hash
     or v_case.proposal->>'proposalKind'
        is distinct from 'imported_manual_ticket_financial'
     or coalesce((v_case.proposal->>'makerCheckerRequired')::boolean, false)
        is not true
     or v_case.approved_by_user_id is null
     or v_case.approved_at is null
     or v_case.approved_by_user_id = v_case.proposed_by_user_id
     or v_case.proposal->>'expectedBookingStatus'
        is distinct from v_booking.status
     or v_case.proposal->>'expectedPaymentState'
        is distinct from v_booking.payment_state
     or v_case.proposal->>'financialDisposition'
        is distinct from v_case.financial_disposition
     or (v_case.proposal->>'expectedCapturedAmount')::bigint
        is distinct from v_booking.captured_amount
     or (v_case.proposal->>'expectedRefundedAmount')::bigint
        is distinct from v_booking.refunded_amount then
    return jsonb_build_object('ok', false, 'code', 'APPROVED_FINANCIAL_PROPOSAL_REQUIRED');
  end if;

  v_disposition := v_case.financial_disposition;
  if v_disposition = 'manual_adjustment_required' then
    return jsonb_build_object(
      'ok', false, 'code', 'MANUAL_ADJUSTMENT_REQUIRED',
      'caseId', v_case.id,
      'caseVersion', v_case.version,
      'financialDisposition', v_disposition,
      'capturedAmount', v_booking.captured_amount,
      'currency', v_booking.currency,
      'walletMutation', false
    );
  end if;
  if v_disposition not in (
       'full_refund', 'partial_refund',
       'no_refund_due', 'externally_settled'
     ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_FINANCIAL_DISPOSITION');
  end if;

  select observation.* into v_evidence
    from jsonb_array_elements_text(
      v_case.proposal->'evidenceObservationIds'
    ) evidence_id(id)
    join public.booking_reconciliation_observations observation
      on observation.id = evidence_id.id::uuid
     and observation.reconciliation_case_id = v_case.id
   where observation.observation_kind = 'staff_evidence'
     and observation.observation_source = 'supplier_read'
     and observation.normalized_facts->>'sourceKind'
        = 'imported_supplier_manage_booking'
     and observation.normalized_facts #>> '{outcome,classification}' in (
       'cancelled', 'expired', 'unconfirmed'
     )
     and observation.normalized_facts #>> '{outcome,authoritative}' = 'true'
     and observation.normalized_facts #>> '{validation,fresh}' = 'true'
     and observation.normalized_facts #>> '{validation,identityMatches}' = 'true'
     and observation.observed_at >= v_now - interval '5 minutes'
   order by observation.observed_at desc, observation.id desc
   limit 1;
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'FRESH_NEGATIVE_IMPORTED_EVIDENCE_REQUIRED'
    );
  end if;
  v_supplier_outcome := v_evidence.normalized_facts
    #>> '{outcome,classification}';
  if v_case.proposal->>'supplierOutcome' is distinct from v_supplier_outcome then
    return jsonb_build_object('ok', false, 'code', 'SUPPLIER_OUTCOME_CHANGED');
  end if;

  select reservation.* into v_reservation
    from public.wallet_reservations reservation
   where reservation.booking_id = v_booking.id
   for update;
  if not found or v_reservation.state <> 'captured'
     or v_reservation.amount is distinct from v_booking.captured_amount
     or v_reservation.wallet_account_id
        is distinct from v_booking.charged_wallet_account_id then
    return jsonb_build_object('ok', false, 'code', 'CAPTURED_RESERVATION_REQUIRED');
  end if;
  select account.wallet_id into v_wallet_id
    from public.wallet_accounts account
   where account.id = v_reservation.wallet_account_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;
  select wallet.* into v_wallet
    from public.wallets wallet
   where wallet.id = v_wallet_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND');
  end if;
  select account.* into v_account
    from public.wallet_accounts account
   where account.id = v_reservation.wallet_account_id
     and account.wallet_id = v_wallet.id
   for update;
  if not found or v_account.currency <> v_booking.currency then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_MISMATCH');
  end if;
  select count(*)::integer into v_capture_ledger_count
    from public.wallet_ledger_entries ledger
   where ledger.booking_id = v_booking.id
     and ledger.reservation_id = v_reservation.id
     and ledger.wallet_account_id = v_account.id
     and ledger.transaction_type = 'booking_confirm'
     and ledger.amount = v_booking.captured_amount
     and ledger.currency = v_booking.currency;
  if v_capture_ledger_count <> 1 then
    return jsonb_build_object('ok', false, 'code', 'CAPTURE_LEDGER_MISMATCH');
  end if;

  v_outstanding := v_booking.captured_amount - v_booking.refunded_amount;
  if v_disposition = 'full_refund' then
    v_refund_amount := v_outstanding;
  elsif v_disposition = 'partial_refund' then
    if v_case.financial_amount is null
       or v_case.financial_amount <= 0
       or v_case.financial_amount >= v_outstanding
       or v_case.financial_currency <> v_booking.currency then
      return jsonb_build_object('ok', false, 'code', 'INVALID_PARTIAL_REFUND');
    end if;
    v_refund_amount := v_case.financial_amount;
  elsif v_disposition = 'externally_settled'
     and nullif(btrim(v_case.external_settlement_reference), '') is null then
    return jsonb_build_object('ok', false, 'code', 'SETTLEMENT_REFERENCE_REQUIRED');
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
      p_execution_request_key || ':refund', p_actor_user_id, v_actor_role,
      'Approved imported manual-ticket financial disposition',
      jsonb_build_object(
        'reconciliationCaseId', v_case.id,
        'proposalHash', v_case.proposal_hash,
        'operationId', v_operation.id,
        'evidenceObservationId', v_evidence.id,
        'supplierOutcome', v_supplier_outcome,
        'financialDisposition', v_disposition
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

  update public.flight_bookings
     set status = 'cancelled',
         payment_state = v_payment_after,
         refunded_amount = v_refunded_after,
         cancelled_at = coalesce(cancelled_at, v_now),
         cancelled_by = p_actor_user_id,
         cancel_reason = v_case.proposal->>'reason',
         booking_status = 'Manual ticketing could not complete ('
           || v_supplier_outcome || ')',
         active_operation_id = null,
         operation_kind = null,
         operation_reason = null,
         operation_request_id = null,
         operation_actor_user_id = null,
         operation_started_at = null,
         operation_prior_status = null
   where id = v_booking.id;
  update public.booking_operations
     set state = 'failed',
         completed_at = v_now,
         error_code = 'IMPEXP_MANUAL_TICKETING_' || upper(v_supplier_outcome),
         error_message = 'Manual ticketing did not complete; approved financial disposition executed.',
         supplier_evidence = supplier_evidence || jsonb_build_object(
           'financialResolution', jsonb_build_object(
             'caseId', v_case.id,
             'evidenceObservationId', v_evidence.id,
             'supplierOutcome', v_supplier_outcome,
             'financialDisposition', v_disposition,
             'refundAmount', v_refund_amount,
             'executedAt', v_now
           )
         )
   where id = v_operation.id;

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
    v_booking.id, 'in-progress', 'cancelled',
    'in-progress', 'cancelled', 'ticketing',
    'imported_manual_ticketing', p_actor_user_id,
    'ImportedManualTicketFinancialResolution',
    jsonb_build_object(
      'evidenceObservationId', v_evidence.id,
      'supplierOutcome', v_supplier_outcome,
      'financialDisposition', v_disposition,
      'refundAmount', v_refund_amount
    ),
    p_execution_request_key || ':cancelled', v_operation.id, v_case.id,
    v_occurrence_number, v_now, v_now,
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'lifecycleStatus', 'cancelled',
      'paymentState', v_payment_after,
      'operationKind', 'imported_manual_ticketing',
      'operationSource', 'financial_reconciliation',
      'operationId', v_operation.id,
      'reconciliationCaseId', v_case.id,
      'supplierOutcome', v_supplier_outcome,
      'financialDisposition', v_disposition,
      'refundAmount', v_refund_amount,
      'capturedAmount', v_booking.captured_amount,
      'retainedAmount', v_retained_amount,
      'currency', v_booking.currency
    ), 1
  ) returning id into v_event_id;

  v_result := jsonb_build_object(
    'bookingStatus', 'cancelled',
    'paymentState', v_payment_after,
    'operationId', v_operation.id,
    'caseId', v_case.id,
    'reservationId', v_reservation.id,
    'walletAccountId', v_account.id,
    'evidenceObservationId', v_evidence.id,
    'lifecycleEventId', v_event_id,
    'ledgerEntryId', v_ledger_entry_id,
    'supplierOutcome', v_supplier_outcome,
    'financialDisposition', v_disposition,
    'refundAmount', v_refund_amount,
    'refundedAmount', v_refunded_after,
    'retainedAmount', v_retained_amount,
    'capturedAmount', v_booking.captured_amount,
    'currency', v_booking.currency,
    'walletMutation', v_refund_amount > 0,
    'availableBalance', v_available_before + v_refund_amount,
    'holdBalance', v_account.hold_balance,
    'externalSettlementReference', case
      when v_disposition = 'externally_settled'
        then v_case.external_settlement_reference else null end
  );
  update public.booking_reconciliation_cases
     set state = 'resolved',
         resolution_outcome = 'imported_manual_' || v_supplier_outcome
           || '_' || v_disposition,
         resolution = jsonb_build_object(
           'version', 1,
           'executionRequestKey', p_execution_request_key,
           'proposalHash', v_case.proposal_hash,
           'resolutionKind', 'imported_manual_ticket_financial',
           'supplierOutcome', v_supplier_outcome,
           'financialDisposition', v_disposition,
           'executedByRole', v_actor_role,
           'evidenceObservationIds', v_case.proposal->'evidenceObservationIds',
           'result', v_result
         ),
         resolution_reason = v_case.proposal->>'reason',
         resolved_by_user_id = p_actor_user_id,
         resolved_at = v_now,
         closed_at = v_now,
         version = version + 1
   where id = v_case.id;

  return v_result || jsonb_build_object(
    'ok', true, 'replay', false,
    'caseVersion', v_case.version + 1,
    'proposalHash', v_case.proposal_hash,
    'resolutionKind', 'imported_manual_ticket_financial'
  );
end;
$$;

revoke all on function public.propose_impexp_manual_ticket_financial_v1(
  uuid, uuid, integer, text, text, text, bigint, text, text, text
) from public, anon, authenticated;
revoke all on function public.execute_impexp_manual_ticket_financial_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.propose_impexp_manual_ticket_financial_v1(
  uuid, uuid, integer, text, text, text, bigint, text, text, text
) to service_role;
grant execute on function public.execute_impexp_manual_ticket_financial_v1(
  uuid, uuid, integer, text, text, text
) to service_role;

comment on function public.propose_impexp_manual_ticket_financial_v1(
  uuid, uuid, integer, text, text, text, bigint, text, text, text
) is
  'Creates an immutable-evidence-bound, always-maker-checker financial proposal for a captured imported manual-ticket failure. It changes no booking or wallet truth.';
comment on function public.execute_impexp_manual_ticket_financial_v1(
  uuid, uuid, integer, text, text, text
) is
  'Executes an independently approved imported manual-ticket financial disposition atomically. Refund modes write one wallet ledger row; no-refund and external settlement remain explicit without fabricated wallet movement.';
