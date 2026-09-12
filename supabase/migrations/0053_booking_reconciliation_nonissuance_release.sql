-- Controlled non-issuance evidence and atomic protected-hold release.
-- A Held PNR alone never releases money. Staff must record a structured,
-- append-only supplier-portal attestation tied to the fresh supplier read;
-- the later proposal and independent approval bind both observations.

create or replace function public.record_booking_nonissuance_attestation_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_related_supplier_observation_id uuid,
  p_actor_user_id text,
  p_request_key text,
  p_basis text,
  p_portal_evidence_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_booking public.flight_bookings;
  v_case_operation_id uuid;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_supplier_observation public.booking_reconciliation_observations;
  v_existing public.booking_reconciliation_observations;
  v_facts jsonb;
  v_facts_hash text;
  v_observed_at timestamptz := clock_timestamp();
begin
  if p_booking_id is null or p_case_id is null
     or p_related_supplier_observation_id is null
     or nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_request_key), '') is null
     or char_length(p_request_key) > 220
     or p_basis not in (
       'held_plus_no_ticket_record',
       'supplier_confirmed_unissued'
     )
     or p_portal_evidence_hash !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_NONISSUANCE_ATTESTATION');
  end if;
  select app_user.role into v_actor_role
    from public.app_users app_user
   where app_user.clerk_id = p_actor_user_id;
  if v_actor_role not in ('superadmin', 'admin', 'staff_support') then
    return jsonb_build_object('ok', false, 'code', 'ATTESTATION_FORBIDDEN');
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select reconciliation_case.operation_id into v_case_operation_id
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.id = p_case_id
     and reconciliation_case.subject_booking_id = p_booking_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND');
  end if;
  if v_case_operation_id is not null then
    select operation.* into v_operation
      from public.booking_operations operation
     where operation.id = v_case_operation_id
       and operation.booking_id = p_booking_id
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'CASE_OPERATION_MISMATCH');
    end if;
  end if;
  select reconciliation_case.* into v_case
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.id = p_case_id
     and reconciliation_case.subject_booking_id = p_booking_id
   for update;
  if v_case.operation_id is distinct from v_case_operation_id then
    return jsonb_build_object('ok', false, 'code', 'CASE_OPERATION_CHANGED');
  end if;
  if v_case.state not in (
       'open', 'assigned', 'awaiting_supplier',
       'awaiting_finance', 'awaiting_approval'
     ) or v_case.resolved_at is not null then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_OPEN');
  end if;

  select observation.* into v_existing
    from public.booking_reconciliation_observations observation
   where observation.reconciliation_case_id = p_case_id
     and observation.observation_key = p_request_key;
  if found then
    if v_existing.actor_user_id = p_actor_user_id
       and v_existing.normalized_facts
         #>> '{relatedSupplierObservationId}'
           = p_related_supplier_observation_id::text
       and v_existing.normalized_facts->>'basis' = p_basis
       and v_existing.normalized_facts->>'portalEvidenceHash'
           = p_portal_evidence_hash then
      return jsonb_build_object(
        'ok', true, 'replay', true,
        'caseId', p_case_id,
        'observationId', v_existing.id,
        'normalizedFactsHash', v_existing.normalized_facts_hash,
        'statusMutation', false,
        'walletMutation', false
      );
    end if;
    raise exception 'non-issuance attestation request identity mismatch'
      using errcode = '22023';
  end if;

  select observation.* into v_supplier_observation
    from public.booking_reconciliation_observations observation
   where observation.id = p_related_supplier_observation_id
     and observation.reconciliation_case_id = p_case_id
     and observation.normalized_facts->>'action' = 'supplier_evidence_read'
     and observation.normalized_facts->>'requestedPurpose' = 'held'
     and observation.observed_at >= v_observed_at - interval '5 minutes'
     and observation.normalized_facts #>> '{validation,fresh}' = 'true'
     and observation.normalized_facts
       #>> '{validation,identityMatches}' = 'true';
  if not found then
    return jsonb_build_object('ok', false, 'code', 'FRESH_HELD_READ_REQUIRED');
  end if;
  if p_basis = 'held_plus_no_ticket_record' and not (
       v_supplier_observation.normalized_facts
         #>> '{validation,authoritativeFor}' = 'held'
       and v_supplier_observation.normalized_facts
         #>> '{validation,valid}' = 'true'
       and v_supplier_observation.normalized_facts
         #>> '{validation,complete}' = 'true'
     ) then
    return jsonb_build_object('ok', false, 'code', 'AUTHORITATIVE_HELD_READ_REQUIRED');
  end if;

  v_facts := jsonb_build_object(
    'version', 1,
    'action', 'supplier_portal_nonissuance_attestation',
    'bookingId', p_booking_id,
    'caseId', p_case_id,
    'relatedSupplierObservationId', p_related_supplier_observation_id,
    'basis', p_basis,
    'portalEvidenceHash', p_portal_evidence_hash,
    'candidateOutcome', 'held_not_ticketed',
    'attestedAt', v_observed_at,
    'manualConfirmationRequired', true,
    'automaticResolution', false,
    'destructiveSupplierCall', false,
    'statusMutation', false,
    'walletMutation', false
  );
  v_facts_hash := encode(
    sha256(convert_to(v_facts::text, 'UTF8')),
    'hex'
  );
  insert into public.booking_reconciliation_observations (
    reconciliation_case_id, observation_key,
    observation_kind, observation_source,
    actor_user_id, actor_role,
    normalized_facts, normalized_facts_hash, observed_at
  ) values (
    p_case_id, p_request_key, 'staff_evidence', 'staff',
    p_actor_user_id, v_actor_role,
    v_facts, v_facts_hash, v_observed_at
  ) returning * into v_existing;

  return jsonb_build_object(
    'ok', true, 'replay', false,
    'caseId', p_case_id,
    'observationId', v_existing.id,
    'normalizedFactsHash', v_facts_hash,
    'statusMutation', false,
    'walletMutation', false
  );
end;
$$;

create or replace function public.resolve_booking_reconciliation_nonissuance_v1(
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
  v_account public.wallet_accounts;
  v_attestation public.booking_reconciliation_observations;
  v_supplier_observation public.booking_reconciliation_observations;
  v_available_before bigint;
  v_hold_before bigint;
  v_ledger_entry_id uuid;
  v_event_id bigint;
  v_occurrence_number integer;
  v_from_lifecycle text;
  v_to_lifecycle text;
  v_resolution_result jsonb;
begin
  v_contract := public.booking_reconciliation_resolution_contract_v1(
    p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
    p_actor_user_id, p_execution_request_key, 'nonissuance'
  );
  if coalesce((v_contract->>'ok')::boolean, false) is not true
     or coalesce((v_contract->>'replay')::boolean, false) then
    return v_contract;
  end if;
  select * into strict v_booking
    from public.flight_bookings where id = p_booking_id;
  select * into strict v_case
    from public.booking_reconciliation_cases where id = p_case_id;
  if v_case.financial_disposition <> 'release_existing_hold' then
    return jsonb_build_object('ok', false, 'code', 'RELEASE_DISPOSITION_REQUIRED');
  end if;
  if not (
       v_case.proposal->'confirmationCodes'
         @> '["confirm_held_nonissuance_basis"]'::jsonb
       and v_case.proposal->'confirmationCodes'
         @> '["confirm_manual_resolution_basis"]'::jsonb
     ) then
    return jsonb_build_object('ok', false, 'code', 'NONISSUANCE_CONFIRMATION_REQUIRED');
  end if;
  if v_booking.status not in ('on-hold', 'pending', 'in-progress')
     or v_booking.payment_state not in ('held', 'reconciliation')
     or v_booking.captured_amount <> 0
     or v_booking.refunded_amount <> 0 then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_HOLD_NOT_RELEASABLE');
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
     or v_reservation.state not in ('active', 'reconciliation')
     or v_reservation.booking_id is distinct from p_booking_id
     or v_reservation.amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'PROTECTED_HOLD_REQUIRED');
  end if;
  select * into v_account
    from public.wallet_accounts
   where id = v_reservation.wallet_account_id;
  if not found
     or v_account.id is distinct from (v_contract->>'walletAccountId')::uuid
     or v_account.currency <> v_reservation.currency
     or v_booking.currency <> v_reservation.currency
     or (v_booking.payment_amount is not null
       and v_booking.payment_amount <> v_reservation.amount)
     or (v_booking.charged_wallet_account_id is not null
       and v_booking.charged_wallet_account_id <> v_account.id) then
    return jsonb_build_object('ok', false, 'code', 'RELEASE_IDENTITY_MISMATCH');
  end if;
  if v_account.hold_balance < v_reservation.amount then
    return jsonb_build_object('ok', false, 'code', 'HOLD_BALANCE_MISMATCH');
  end if;

  select observation.* into v_attestation
    from jsonb_array_elements_text(
      v_case.proposal->'evidenceObservationIds'
    ) evidence_id(id)
    join public.booking_reconciliation_observations observation
      on observation.id = evidence_id.id::uuid
     and observation.reconciliation_case_id = v_case.id
   where observation.normalized_facts->>'action'
       = 'supplier_portal_nonissuance_attestation'
     and observation.normalized_facts->>'candidateOutcome'
       = 'held_not_ticketed'
     and observation.normalized_facts->>'automaticResolution' = 'false'
     and observation.normalized_facts->>'portalEvidenceHash'
       ~ '^[a-f0-9]{64}$'
   order by observation.observed_at desc, observation.id desc
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'PORTAL_NONISSUANCE_ATTESTATION_REQUIRED');
  end if;
  select observation.* into v_supplier_observation
    from jsonb_array_elements_text(
      v_case.proposal->'evidenceObservationIds'
    ) evidence_id(id)
    join public.booking_reconciliation_observations observation
      on observation.id = evidence_id.id::uuid
     and observation.reconciliation_case_id = v_case.id
   where observation.id::text = v_attestation.normalized_facts
       #>> '{relatedSupplierObservationId}'
     and observation.normalized_facts->>'action' = 'supplier_evidence_read'
     and observation.normalized_facts->>'requestedPurpose' = 'held'
     and observation.normalized_facts #>> '{validation,fresh}' = 'true'
     and observation.normalized_facts
       #>> '{validation,identityMatches}' = 'true'
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ATTESTATION_EVIDENCE_MISMATCH');
  end if;
  if v_attestation.normalized_facts->>'basis'
       = 'held_plus_no_ticket_record' and not (
       v_supplier_observation.normalized_facts
         #>> '{validation,authoritativeFor}' = 'held'
       and v_supplier_observation.normalized_facts
         #>> '{validation,valid}' = 'true'
       and v_supplier_observation.normalized_facts
         #>> '{validation,complete}' = 'true'
     ) then
    return jsonb_build_object('ok', false, 'code', 'AUTHORITATIVE_HELD_READ_REQUIRED');
  end if;

  if exists (
    select 1 from public.wallet_ledger_entries ledger
     where ledger.idempotency_key = p_execution_request_key || ':release'
  ) then
    return jsonb_build_object('ok', false, 'code', 'RELEASE_IDEMPOTENCY_CONFLICT');
  end if;
  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  update public.wallet_accounts
     set available_balance = available_balance + v_reservation.amount,
         hold_balance = hold_balance - v_reservation.amount
   where id = v_account.id;
  update public.wallet_reservations
     set state = 'released',
         released_at = clock_timestamp(),
         release_reason = 'Approved supplier-portal non-issuance reconciliation',
         reconciliation_at = null,
         reconciliation_reason = null
   where id = v_reservation.id;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks, metadata
  ) values (
    v_account.id, 'hold_release', v_reservation.amount,
    v_reservation.currency, v_available_before,
    v_available_before + v_reservation.amount,
    v_hold_before, v_hold_before - v_reservation.amount,
    v_booking.id, v_booking.public_ref, v_reservation.id,
    p_execution_request_key || ':release', p_actor_user_id,
    v_contract->>'actorRole',
    'Approved supplier-portal non-issuance reconciliation',
    jsonb_build_object(
      'reconciliationCaseId', v_case.id,
      'proposalHash', v_case.proposal_hash,
      'operationId', v_case.operation_id,
      'supplierObservationId', v_supplier_observation.id,
      'attestationObservationId', v_attestation.id,
      'portalEvidenceHash', v_attestation.normalized_facts->>'portalEvidenceHash',
      'resolutionKind', 'nonissuance'
    )
  ) returning id into v_ledger_entry_id;

  v_from_lifecycle := public.resolve_booking_lifecycle(
    v_booking.status, v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, v_booking.operation_kind
  );
  v_to_lifecycle := public.resolve_booking_lifecycle(
    'on-hold', v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, null
  );
  update public.flight_bookings
     set status = 'on-hold',
         payment_state = 'released',
         captured_amount = 0,
         refunded_amount = 0,
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
       set state = 'failed',
           completed_at = clock_timestamp(),
           error_code = 'SUPPLIER_NOT_ISSUED',
           error_message = 'Supplier portal verification found no issued ticket',
           supplier_evidence = supplier_evidence || jsonb_build_object(
             'reconciliationResolution', jsonb_build_object(
               'caseId', v_case.id,
               'outcome', 'held_not_ticketed',
               'supplierObservationId', v_supplier_observation.id,
               'attestationObservationId', v_attestation.id
             )
           )
     where id = v_case.operation_id;
  end if;

  select count(*)::integer + 1 into v_occurrence_number
    from public.booking_status_events event
   where event.booking_id = v_booking.id
     and event.to_lifecycle_status = v_to_lifecycle;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, operation_id,
    reconciliation_case_id, occurrence_number,
    effective_at, observed_at, event_snapshot, event_version
  ) values (
    v_booking.id, v_from_lifecycle, v_to_lifecycle,
    v_booking.status, 'on-hold', v_booking.operation_kind,
    v_booking.operation_reason, p_actor_user_id,
    'ReconciliationNonIssuance',
    jsonb_build_object(
      'supplierObservationId', v_supplier_observation.id,
      'attestationObservationId', v_attestation.id,
      'portalEvidenceHash', v_attestation.normalized_facts->>'portalEvidenceHash'
    ),
    p_execution_request_key || ':nonissuance', v_case.operation_id,
    v_case.id, v_occurrence_number, v_attestation.observed_at,
    clock_timestamp(),
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'lifecycleStatus', v_to_lifecycle,
      'storedStatus', 'on-hold',
      'paymentState', 'released',
      'operationKind', coalesce(v_booking.operation_kind, 'reconciliation'),
      'reconciliationCaseId', v_case.id
    ), 1
  ) returning id into v_event_id;

  v_resolution_result := jsonb_build_object(
    'bookingStatus', v_to_lifecycle,
    'storedStatus', 'on-hold',
    'paymentState', 'released',
    'reservationId', v_reservation.id,
    'walletAccountId', v_account.id,
    'ledgerEntryId', v_ledger_entry_id,
    'lifecycleEventId', v_event_id,
    'releasedAmount', v_reservation.amount,
    'currency', v_reservation.currency,
    'availableBalance', v_available_before + v_reservation.amount,
    'holdBalance', v_hold_before - v_reservation.amount
  );
  update public.booking_reconciliation_cases
     set state = 'resolved',
         resolution_outcome = 'held_not_ticketed',
         resolution = jsonb_build_object(
           'version', 1,
           'executionRequestKey', p_execution_request_key,
           'proposalHash', v_case.proposal_hash,
           'resolutionKind', 'nonissuance',
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
    'resolutionKind', 'nonissuance'
  );
end;
$$;

revoke all on function public.record_booking_nonissuance_attestation_v1(
  uuid, uuid, uuid, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.resolve_booking_reconciliation_nonissuance_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.record_booking_nonissuance_attestation_v1(
  uuid, uuid, uuid, text, text, text, text
) to service_role;
grant execute on function public.resolve_booking_reconciliation_nonissuance_v1(
  uuid, uuid, integer, text, text, text
) to service_role;

comment on function public.record_booking_nonissuance_attestation_v1(
  uuid, uuid, uuid, text, text, text, text
) is
  'Records a structured, hashed, append-only supplier-portal non-issuance attestation tied to a fresh case-bound Held supplier read. It cannot change lifecycle or wallet state.';
comment on function public.resolve_booking_reconciliation_nonissuance_v1(
  uuid, uuid, integer, text, text, text
) is
  'Atomically resolves approved, portal-attested non-issuance: releases one protected hold, restores stored On Hold, derives On Hold/Expired/Unconfirmed, completes the operation/case, and records the linked lifecycle event.';
