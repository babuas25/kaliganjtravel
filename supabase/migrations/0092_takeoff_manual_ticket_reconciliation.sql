-- Forward-only extension of the exact ticketed reconciliation resolver.
--
-- Generic ticketed evidence keeps its existing ticketCodeRef requirement.
-- TakeOff's manual-portal profile is the narrow exception: Triplover can
-- report an issued ticket number and issue time but no ticketCodeRef. That
-- profile is accepted only when immutable AirTicketingDetails evidence echoes
-- the exact booking uniqueTransId and includes a positive numeric supplier
-- bookingId. The resolver independently checks those facts before any wallet
-- movement, then carries both identifiers into every material audit record.

create or replace function public.resolve_booking_reconciliation_ticketed_v1(
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
  v_evidence public.booking_reconciliation_observations;
  v_ticketed_profile text;
  v_is_takeoff_manual_ticket boolean := false;
  v_ticket_code_ref text;
  v_ticket_numbers jsonb;
  v_supplier_pnr text;
  v_airlines_pnr jsonb;
  v_supplier_status text;
  v_issued_at timestamptz;
  v_expected_supplier_unique_trans_id text;
  v_supplier_unique_trans_id text;
  v_supplier_internal_booking_id_text text;
  v_supplier_internal_booking_id bigint;
  v_supplier_identifiers jsonb;
  v_available_before bigint;
  v_hold_before bigint;
  v_ledger_entry_id uuid;
  v_event_id bigint;
  v_occurrence_number integer;
  v_from_lifecycle text;
  v_resolution_result jsonb;
begin
  v_contract := public.booking_reconciliation_resolution_contract_v1(
    p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
    p_actor_user_id, p_execution_request_key, 'ticketed'
  );
  if coalesce((v_contract->>'ok')::boolean, false) is not true
     or coalesce((v_contract->>'replay')::boolean, false) then
    return v_contract;
  end if;

  select * into strict v_booking
    from public.flight_bookings where id = p_booking_id;
  select * into strict v_case
    from public.booking_reconciliation_cases where id = p_case_id;
  if v_case.financial_disposition <> 'capture_existing_hold' then
    return jsonb_build_object('ok', false, 'code', 'CAPTURE_DISPOSITION_REQUIRED');
  end if;
  if v_booking.status not in ('on-hold', 'pending', 'in-progress') then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_STATUS_NOT_TICKETABLE');
  end if;
  if v_booking.payment_state not in ('held', 'reconciliation')
     or v_booking.captured_amount <> 0
     or v_booking.refunded_amount <> 0 then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_PAYMENT_NOT_CAPTURABLE');
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
    return jsonb_build_object('ok', false, 'code', 'CAPTURE_IDENTITY_MISMATCH');
  end if;
  if v_account.hold_balance < v_reservation.amount then
    return jsonb_build_object('ok', false, 'code', 'HOLD_BALANCE_MISMATCH');
  end if;

  select observation.* into v_evidence
    from jsonb_array_elements_text(
      v_case.proposal->'evidenceObservationIds'
    ) evidence_id(id)
    join public.booking_reconciliation_observations observation
      on observation.id = evidence_id.id::uuid
     and observation.reconciliation_case_id = v_case.id
   where observation.normalized_facts->>'requestedPurpose' = 'ticketed'
     and observation.normalized_facts #>> '{validation,authoritativeFor}' = 'ticketed'
     and coalesce((observation.normalized_facts
       #>> '{validation,valid}')::boolean, false)
     and coalesce((observation.normalized_facts
       #>> '{validation,complete}')::boolean, false)
     and coalesce((observation.normalized_facts
       #>> '{validation,fresh}')::boolean, false)
     and coalesce((observation.normalized_facts
       #>> '{validation,identityMatches}')::boolean, false)
     and observation.normalized_facts
       #>> '{evidence,airTicketing,source}' = 'air-ticketing-details'
   order by observation.observed_at desc, observation.id desc
   limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'AUTHORITATIVE_TICKET_EVIDENCE_REQUIRED');
  end if;

  -- Do not trust the validation summary alone for a financial resolution.
  -- The locked booking's supplier reference is the authority for the exact
  -- Triplover transaction identity, and manual TakeOff evidence must echo it.
  v_expected_supplier_unique_trans_id := v_booking.supplier_refs->>'uniqueTransId';
  if v_expected_supplier_unique_trans_id is null
     or v_expected_supplier_unique_trans_id = ''
     or v_expected_supplier_unique_trans_id <> btrim(v_expected_supplier_unique_trans_id) then
    return jsonb_build_object('ok', false, 'code', 'SUPPLIER_UNIQUE_TRANS_ID_REQUIRED');
  end if;
  v_ticketed_profile := coalesce(
    nullif(btrim(v_evidence.normalized_facts
      #>> '{validation,ticketedProfile}'), ''),
    'generic'
  );
  if v_ticketed_profile not in ('generic', 'takeoff_manual_ticket') then
    return jsonb_build_object('ok', false, 'code', 'UNSUPPORTED_TICKET_EVIDENCE_PROFILE');
  end if;
  v_is_takeoff_manual_ticket := v_ticketed_profile = 'takeoff_manual_ticket';
  v_supplier_unique_trans_id := v_evidence.normalized_facts
    #>> '{evidence,airTicketing,facts,ticketInfoUniqueTransId}';
  if v_supplier_unique_trans_id = ''
     or v_supplier_unique_trans_id <> btrim(v_supplier_unique_trans_id) then
    return jsonb_build_object('ok', false, 'code', 'SUPPLIER_UNIQUE_TRANS_ID_MISMATCH');
  end if;
  if v_supplier_unique_trans_id is not null
     and v_supplier_unique_trans_id <> v_expected_supplier_unique_trans_id then
    return jsonb_build_object('ok', false, 'code', 'SUPPLIER_UNIQUE_TRANS_ID_MISMATCH');
  end if;
  v_supplier_internal_booking_id_text := nullif(btrim(v_evidence.normalized_facts
    #>> '{evidence,airTicketing,facts,supplierBookingId}'), '');

  v_ticket_code_ref := nullif(btrim(v_evidence.normalized_facts
    #>> '{evidence,airTicketing,facts,ticketCodeRef}'), '');
  v_ticket_numbers := v_evidence.normalized_facts
    #> '{evidence,airTicketing,facts,ticketNumbers}';
  if jsonb_typeof(v_ticket_numbers) <> 'array'
     or jsonb_array_length(v_ticket_numbers) = 0
     or exists (
       select 1 from jsonb_array_elements(v_ticket_numbers) ticket(value)
        where jsonb_typeof(ticket.value) <> 'string'
           or nullif(btrim(ticket.value #>> '{}'), '') is null
     ) then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_INCOMPLETE');
  end if;
  v_supplier_pnr := nullif(btrim(v_evidence.normalized_facts
    #>> '{evidence,airTicketing,facts,pnr}'), '');
  v_airlines_pnr := v_evidence.normalized_facts
    #> '{evidence,airTicketing,facts,airlinesPnr}';
  v_supplier_status := nullif(btrim(v_evidence.normalized_facts
    #>> '{evidence,airTicketing,facts,supplierStatus}'), '');
  begin
    v_issued_at := nullif(v_evidence.normalized_facts
      #>> '{evidence,airTicketing,facts,issuedAt}', '')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ISSUED_TIMESTAMP');
  end;

  if v_is_takeoff_manual_ticket then
    if v_booking.supplier_account is distinct from 'takeoff' then
      return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_PROFILE_SUPPLIER_MISMATCH');
    end if;
    if v_supplier_unique_trans_id is null then
      return jsonb_build_object('ok', false, 'code', 'SUPPLIER_UNIQUE_TRANS_ID_REQUIRED');
    end if;
    if jsonb_typeof(v_evidence.normalized_facts
         #> '{evidence,airTicketing,facts,supplierBookingId}') <> 'number'
       or v_supplier_internal_booking_id_text is null
       or v_supplier_internal_booking_id_text !~ '^[1-9][0-9]{0,18}$' then
      return jsonb_build_object('ok', false, 'code', 'SUPPLIER_INTERNAL_BOOKING_ID_REQUIRED');
    end if;
    begin
      v_supplier_internal_booking_id := v_supplier_internal_booking_id_text::bigint;
    exception when numeric_value_out_of_range then
      return jsonb_build_object('ok', false, 'code', 'SUPPLIER_INTERNAL_BOOKING_ID_REQUIRED');
    end;
    if v_issued_at is null then
      return jsonb_build_object('ok', false, 'code', 'ISSUED_TIMESTAMP_REQUIRED');
    end if;
  elsif v_ticket_code_ref is null then
    -- Preserve the generic ticketed path unchanged: a ticket code remains
    -- mandatory unless the explicit TakeOff manual evidence profile applies.
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_INCOMPLETE');
  end if;

  v_issued_at := coalesce(v_issued_at, v_evidence.observed_at);
  if v_issued_at > v_evidence.observed_at + interval '1 minute' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ISSUED_TIMESTAMP');
  end if;
  v_supplier_identifiers := jsonb_build_object(
    'ticketedProfile', v_ticketed_profile,
    'supplierAccount', v_booking.supplier_account,
    'supplierUniqueTransId', v_supplier_unique_trans_id,
    'expectedSupplierUniqueTransId', v_expected_supplier_unique_trans_id,
    'supplierInternalBookingId', v_supplier_internal_booking_id
  );

  if exists (
    select 1 from public.wallet_ledger_entries ledger
     where ledger.idempotency_key = p_execution_request_key || ':capture'
  ) then
    return jsonb_build_object('ok', false, 'code', 'CAPTURE_IDEMPOTENCY_CONFLICT');
  end if;
  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  update public.wallet_accounts
     set hold_balance = hold_balance - v_reservation.amount
   where id = v_account.id;
  update public.wallet_reservations
     set booking_id = p_booking_id,
         booking_attempt_id = null,
         state = 'captured',
         issued_by_user_id = p_actor_user_id,
         captured_at = clock_timestamp(),
         reconciliation_at = null,
         reconciliation_reason = null
   where id = v_reservation.id;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks, metadata
  ) values (
    v_account.id, 'booking_confirm', v_reservation.amount,
    v_reservation.currency, v_available_before, v_available_before,
    v_hold_before, v_hold_before - v_reservation.amount,
    v_booking.id, v_booking.public_ref, v_reservation.id,
    p_execution_request_key || ':capture', p_actor_user_id,
    v_contract->>'actorRole',
    'Approved ticketing reconciliation capture',
    jsonb_build_object(
      'reconciliationCaseId', v_case.id,
      'proposalHash', v_case.proposal_hash,
      'operationId', v_case.operation_id,
      'evidenceObservationId', v_evidence.id,
      'resolutionKind', 'ticketed',
      'supplierIdentifiers', v_supplier_identifiers
    )
  ) returning id into v_ledger_entry_id;

  v_from_lifecycle := public.resolve_booking_lifecycle(
    v_booking.status, v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, v_booking.operation_kind
  );
  update public.flight_bookings
     set status = 'confirmed',
         charged_wallet_account_id = v_account.id,
         payment_state = 'captured',
         payment_amount = v_reservation.amount,
         captured_amount = v_reservation.amount,
         refunded_amount = 0,
         issued_by_user_id = p_actor_user_id,
         issued_at = coalesce(issued_at, v_issued_at),
         pnr = case when v_is_takeoff_manual_ticket then v_booking.pnr
           else coalesce(v_supplier_pnr, pnr) end,
         airlines_pnr = case
           when v_is_takeoff_manual_ticket then v_booking.airlines_pnr
           when jsonb_typeof(v_airlines_pnr) = 'array'
             and jsonb_array_length(v_airlines_pnr) > 0
             then v_airlines_pnr else airlines_pnr end,
         -- These are intentionally exact locked values, not a supplier-write
         -- path. The reconciliation keeps the original reference chain and
         -- deadline while storing the supplier's additional IDs in audit data.
         supplier_refs = v_booking.supplier_refs,
         ticketing_deadline_at = v_booking.ticketing_deadline_at,
         booking_status = coalesce(v_supplier_status, 'Confirmed'),
         ticket_code_ref = case when v_is_takeoff_manual_ticket
           then ticket_code_ref else v_ticket_code_ref end,
         ticket_numbers = v_ticket_numbers,
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
           supplier_evidence = coalesce(supplier_evidence, '{}'::jsonb)
             || jsonb_build_object(
               'reconciliationResolution', jsonb_build_object(
                 'caseId', v_case.id,
                 'outcome', 'ticketed',
                 'evidenceObservationId', v_evidence.id,
                 'supplierIdentifiers', v_supplier_identifiers
               )
             )
     where id = v_case.operation_id;
  end if;

  select count(*)::integer + 1 into v_occurrence_number
    from public.booking_status_events event
   where event.booking_id = v_booking.id
     and event.to_lifecycle_status = 'confirmed';
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, operation_id,
    reconciliation_case_id, occurrence_number,
    effective_at, observed_at, event_snapshot, event_version
  ) values (
    v_booking.id, v_from_lifecycle, 'confirmed',
    v_booking.status, 'confirmed', v_booking.operation_kind,
    v_booking.operation_reason, p_actor_user_id, 'ReconciliationTicketed',
    jsonb_build_object(
      'evidenceObservationId', v_evidence.id,
      'ticketCodeRefPresent', v_ticket_code_ref is not null,
      'ticketCount', jsonb_array_length(v_ticket_numbers),
      'supplierIdentifiers', v_supplier_identifiers
    ),
    p_execution_request_key || ':confirmed', v_case.operation_id,
    v_case.id, v_occurrence_number, v_issued_at, clock_timestamp(),
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'lifecycleStatus', 'confirmed',
      'paymentState', 'captured',
      'ticketCount', jsonb_array_length(v_ticket_numbers),
      'operationKind', coalesce(v_booking.operation_kind, 'reconciliation'),
      'reconciliationCaseId', v_case.id,
      'supplierIdentifiers', v_supplier_identifiers
    ), 1
  ) returning id into v_event_id;

  v_resolution_result := jsonb_build_object(
    'bookingStatus', 'confirmed',
    'paymentState', 'captured',
    'reservationId', v_reservation.id,
    'walletAccountId', v_account.id,
    'ledgerEntryId', v_ledger_entry_id,
    'lifecycleEventId', v_event_id,
    'capturedAmount', v_reservation.amount,
    'currency', v_reservation.currency,
    'availableBalance', v_available_before,
    'holdBalance', v_hold_before - v_reservation.amount,
    'supplierUniqueTransId', v_supplier_unique_trans_id,
    'supplierInternalBookingId', v_supplier_internal_booking_id,
    'supplierIdentifiers', v_supplier_identifiers
  );
  update public.booking_reconciliation_cases
     set state = 'resolved',
         resolution_outcome = 'ticketed',
         resolution = jsonb_build_object(
           'version', 1,
           'executionRequestKey', p_execution_request_key,
           'proposalHash', v_case.proposal_hash,
           'resolutionKind', 'ticketed',
           'executedByRole', v_contract->>'actorRole',
           'evidenceObservationIds', v_case.proposal->'evidenceObservationIds',
           'supplierIdentifiers', v_supplier_identifiers,
           'result', v_resolution_result
         ),
         resolution_reason = v_case.proposal->>'reason',
         resolved_by_user_id = p_actor_user_id,
         resolved_at = clock_timestamp(),
         closed_at = clock_timestamp(),
         version = version + 1
   where id = v_case.id;

  return v_resolution_result || jsonb_build_object(
    'ok', true,
    'replay', false,
    'caseId', v_case.id,
    'caseVersion', v_case.version + 1,
    'resolutionKind', 'ticketed'
  );
end;
$$;

revoke all on function public.resolve_booking_reconciliation_ticketed_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.resolve_booking_reconciliation_ticketed_v1(
  uuid, uuid, integer, text, text, text
) to service_role;

comment on function public.resolve_booking_reconciliation_ticketed_v1(
  uuid, uuid, integer, text, text, text
) is
  'Atomically captures the already protected hold and confirms a booking only from approved fresh immutable ticket evidence. Generic evidence requires ticketCodeRef; the narrow TakeOff manual-ticket profile additionally requires exact echoed uniqueTransId and a positive numeric supplier bookingId, which are preserved in resolution, operation, ledger, and lifecycle-event metadata.';
