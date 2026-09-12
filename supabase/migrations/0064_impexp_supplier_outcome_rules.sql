-- Classify each imported Manage Booking observation into one explicit,
-- non-financial operation/case rule. Supplier truth never directly changes
-- the public booking status here and captured funds are never moved.

create or replace function public.classify_impexp_manual_ticket_outcome_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_evidence_observation_id uuid,
  p_actor_user_id text
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
  v_classification text;
  v_lifecycle_status text;
  v_reason_code text;
  v_reason_detail text;
  v_required_action text;
  v_operation_state text;
  v_case_state text;
  v_assigned_team text;
  v_severity text;
  v_priority integer;
  v_financial_disposition_required boolean;
  v_due_at timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  if p_booking_id is null
     or p_case_id is null
     or p_evidence_observation_id is null
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_OUTCOME_REQUEST');
  end if;

  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role is null
     or v_actor_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'IMPEXP_OUTCOME_FORBIDDEN');
  end if;

  select candidate.operation_id into v_operation_id
    from public.booking_reconciliation_cases candidate
   where candidate.id = p_case_id
     and candidate.subject_booking_id = p_booking_id;
  if not found or v_operation_id is null then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_CASE_NOT_FOUND');
  end if;

  -- Global mutation order: booking -> operation -> case. This action does not
  -- lock or mutate reservations, wallets, accounts, or ledger entries.
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

  if v_booking.import_source is distinct from 'IMP_EXP'
     or v_booking.status <> 'in-progress'
     or v_booking.active_operation_id is distinct from v_operation.id
     or v_booking.operation_kind is distinct from 'ticketing'
     or v_booking.operation_reason is distinct from 'imported_manual_ticketing'
     or v_operation.booking_id is distinct from v_booking.id
     or v_operation.kind is distinct from 'imported_manual_ticketing'
     or v_operation.state not in ('awaiting_external_action', 'needs_reconciliation')
     or v_case.case_type is distinct from 'imported_manual_ticketing'
     or v_case.state not in (
       'open', 'assigned', 'awaiting_supplier',
       'awaiting_finance', 'awaiting_approval'
     ) then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_NOT_CLASSIFIABLE');
  end if;
  if v_booking.payment_state <> 'captured'
     or v_booking.user_payable_amount is null
     or v_booking.user_payable_amount <= 0
     or v_booking.payment_amount is distinct from v_booking.user_payable_amount
     or v_booking.captured_amount is distinct from v_booking.user_payable_amount
     or v_booking.refunded_amount <> 0
     or v_booking.charged_wallet_account_id is null then
    return jsonb_build_object(
      'ok', false, 'code', 'CAPTURED_PAYMENT_RECONCILIATION_REQUIRED'
    );
  end if;
  if v_case.financial_disposition <> 'none' then
    return jsonb_build_object(
      'ok', false, 'code', 'FINANCIAL_DISPOSITION_ALREADY_STARTED'
    );
  end if;

  select observation.* into v_evidence
    from public.booking_reconciliation_observations observation
   where observation.id = p_evidence_observation_id
     and observation.reconciliation_case_id = v_case.id;
  if not found
     or v_evidence.observation_kind is distinct from 'staff_evidence'
     or v_evidence.observation_source is distinct from 'supplier_read'
     or v_evidence.normalized_facts->>'action'
        is distinct from 'supplier_evidence_read'
     or v_evidence.normalized_facts->>'sourceKind'
        is distinct from 'imported_supplier_manage_booking'
     or v_evidence.normalized_facts->>'bookingId'
        is distinct from v_booking.id::text
     or v_evidence.normalized_facts->>'caseId'
        is distinct from v_case.id::text
     or v_evidence.normalized_facts
       #>> '{evidence,importedSupplier,source}'
        is distinct from 'airline-manage-booking'
     or v_evidence.observed_at < v_now - interval '5 minutes'
     or v_evidence.observed_at > v_now + interval '1 minute' then
    return jsonb_build_object(
      'ok', false, 'code', 'IMPORTED_SUPPLIER_EVIDENCE_REQUIRED'
    );
  end if;

  v_classification := v_evidence.normalized_facts
    #>> '{outcome,classification}';
  v_lifecycle_status := v_evidence.normalized_facts
    #>> '{evidence,importedSupplier,facts,lifecycleStatus}';
  if v_classification not in (
       'ticketed', 'held', 'cancelled', 'expired',
       'unconfirmed', 'conflicting'
     ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUPPLIER_OUTCOME');
  end if;

  -- Defense in depth: a non-conflicting supplier outcome must be fresh and
  -- identity-matched. Ticketed additionally requires the full P6.6 contract.
  if v_classification <> 'conflicting'
     and (
       coalesce((v_evidence.normalized_facts
         #>> '{outcome,authoritative}')::boolean, false) is not true
       or coalesce((v_evidence.normalized_facts
         #>> '{validation,fresh}')::boolean, false) is not true
       or coalesce((v_evidence.normalized_facts
         #>> '{validation,identityMatches}')::boolean, false) is not true
     ) then
    return jsonb_build_object('ok', false, 'code', 'OUTCOME_IDENTITY_NOT_AUTHORITATIVE');
  end if;
  if v_classification = 'ticketed'
     and (
       v_lifecycle_status is distinct from 'confirmed'
       or coalesce((v_evidence.normalized_facts
         #>> '{validation,valid}')::boolean, false) is not true
       or v_evidence.normalized_facts
         #>> '{validation,authoritativeFor}' is distinct from 'ticketed'
     ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_TICKETED_OUTCOME');
  end if;
  if v_classification = 'held'
     and (
       v_lifecycle_status not in ('on-hold', 'pending', 'in-progress')
       or case
         when jsonb_typeof(v_evidence.normalized_facts
           #> '{evidence,importedSupplier,facts,ticketNumbers}') = 'array'
           then jsonb_array_length(v_evidence.normalized_facts
             #> '{evidence,importedSupplier,facts,ticketNumbers}')
         else -1
       end <> 0
     ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_HELD_OUTCOME');
  end if;
  if v_classification in ('cancelled', 'expired', 'unconfirmed')
     and v_lifecycle_status is distinct from v_classification then
    return jsonb_build_object('ok', false, 'code', 'INVALID_NEGATIVE_OUTCOME');
  end if;
  if v_classification = 'conflicting'
     and coalesce((v_evidence.normalized_facts
       #>> '{outcome,authoritative}')::boolean, true) is not false then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CONFLICT_OUTCOME');
  end if;

  select rule.reason_code, rule.reason_detail, rule.required_action,
         rule.operation_state, rule.case_state, rule.assigned_team,
         rule.severity, rule.priority, rule.financial_required
    into v_reason_code, v_reason_detail, v_required_action,
         v_operation_state, v_case_state, v_assigned_team,
         v_severity, v_priority, v_financial_disposition_required
    from (values
      ('ticketed', 'supplier_ticket_evidence_ready',
       'Fresh complete ticket evidence is ready for staff completion.',
       'complete_ticketing', 'awaiting_external_action', 'assigned',
       'support', 'high', 70, false),
      ('held', 'supplier_booking_still_held',
       'Supplier booking remains held; Support follow-up is still required.',
       'continue_supplier_follow_up', 'awaiting_external_action',
       'awaiting_supplier', 'support', 'high', 40, false),
      ('cancelled', 'supplier_booking_cancelled',
       'Supplier reports cancellation after payment capture; a financial disposition is required.',
       'financial_disposition_required', 'needs_reconciliation',
       'awaiting_finance', 'accounts', 'critical', 90, true),
      ('expired', 'supplier_booking_expired',
       'Supplier reports expiry after payment capture; a financial disposition is required.',
       'financial_disposition_required', 'needs_reconciliation',
       'awaiting_finance', 'accounts', 'critical', 90, true),
      ('unconfirmed', 'supplier_booking_unconfirmed',
       'Supplier reports an unconfirmed booking after payment capture; a financial disposition is required.',
       'financial_disposition_required', 'needs_reconciliation',
       'awaiting_finance', 'accounts', 'critical', 90, true),
      ('conflicting', 'supplier_evidence_conflicting',
       'Supplier evidence conflicts with booking identity or ticket completeness; Admin review is required.',
       'admin_review_required', 'needs_reconciliation', 'assigned',
       'admin', 'critical', 100, false)
    ) as rule(
      classification, reason_code, reason_detail, required_action,
      operation_state, case_state, assigned_team, severity, priority,
      financial_required
    )
   where rule.classification = v_classification;

  if v_operation.supplier_evidence
       #>> '{importedSupplierOutcome,evidenceObservationId}'
       = v_evidence.id::text then
    return jsonb_build_object(
      'ok', true, 'replay', true,
      'classification', v_classification,
      'requiredAction', v_required_action,
      'operationId', v_operation.id,
      'operationState', v_operation.state,
      'caseId', v_case.id,
      'caseState', v_case.state,
      'caseVersion', v_case.version,
      'assignedTeam', v_case.assigned_team,
      'financialDisposition', v_case.financial_disposition,
      'financialDispositionRequired', v_financial_disposition_required,
      'bookingStatusMutation', false,
      'walletMutation', false,
      'ledgerMutation', false
    );
  end if;

  v_due_at := case
    when v_classification = 'conflicting'
      then least(coalesce(v_case.due_at, v_now), v_now)
    when v_financial_disposition_required
      then least(coalesce(v_case.due_at, v_now + interval '30 minutes'),
                  v_now + interval '30 minutes')
    else v_case.due_at
  end;

  update public.booking_operations
     set state = v_operation_state,
         reason_code = v_reason_code,
         reason_detail = v_reason_detail,
         supplier_response_received_at = greatest(
           coalesce(supplier_response_received_at, v_evidence.observed_at),
           v_evidence.observed_at
         ),
         reconciliation_required_at = case
           when v_operation_state = 'needs_reconciliation'
             then coalesce(reconciliation_required_at, v_now)
           else reconciliation_required_at
         end,
         error_code = case
           when v_operation_state = 'needs_reconciliation'
             then upper(v_reason_code)
           else null
         end,
         error_message = case
           when v_operation_state = 'needs_reconciliation'
             then v_reason_detail
           else null
         end,
         supplier_evidence = supplier_evidence || jsonb_build_object(
           'importedSupplierOutcome', jsonb_build_object(
             'classification', v_classification,
             'reasonCode', v_reason_code,
             'requiredAction', v_required_action,
             'evidenceObservationId', v_evidence.id,
             'classifiedAt', v_now,
             'classifiedByUserId', p_actor_user_id,
             'classifiedByRole', v_actor_role,
             'bookingStatusMutation', false,
             'walletMutation', false
           )
         )
   where id = v_operation.id;

  update public.booking_reconciliation_cases
     set state = v_case_state,
         reason_code = v_reason_code,
         reason_detail = v_reason_detail,
         assignee_user_id = case
           when assigned_team is distinct from v_assigned_team then null
           else assignee_user_id
         end,
         assigned_at = case
           when assigned_team is distinct from v_assigned_team
             or assigned_at is null then v_now
           else assigned_at
         end,
         assigned_team = v_assigned_team,
         severity = v_severity,
         priority = v_priority,
         due_at = v_due_at,
         evidence = evidence || jsonb_build_array(jsonb_build_object(
           'type', 'imported_supplier_outcome',
           'classification', v_classification,
           'reasonCode', v_reason_code,
           'requiredAction', v_required_action,
           'evidenceObservationId', v_evidence.id,
           'financialDispositionRequired', v_financial_disposition_required,
           'bookingStatusMutation', false,
           'walletMutation', false,
           'recordedAt', v_now
         )),
         version = version + 1
   where id = v_case.id;

  return jsonb_build_object(
    'ok', true, 'replay', false,
    'classification', v_classification,
    'requiredAction', v_required_action,
    'operationId', v_operation.id,
    'operationState', v_operation_state,
    'caseId', v_case.id,
    'caseState', v_case_state,
    'caseVersion', v_case.version + 1,
    'assignedTeam', v_assigned_team,
    'financialDisposition', 'none',
    'financialDispositionRequired', v_financial_disposition_required,
    'bookingStatusMutation', false,
    'walletMutation', false,
    'ledgerMutation', false
  );
end;
$$;

revoke all on function public.classify_impexp_manual_ticket_outcome_v1(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.classify_impexp_manual_ticket_outcome_v1(
  uuid, uuid, uuid, text
) to service_role;

comment on function public.classify_impexp_manual_ticket_outcome_v1(
  uuid, uuid, uuid, text
) is
  'Applies explicit imported ticketed, held, cancelled, expired, unconfirmed, or conflicting operation/case rules from immutable Manage Booking evidence. Never changes booking status or wallet/ledger state.';
