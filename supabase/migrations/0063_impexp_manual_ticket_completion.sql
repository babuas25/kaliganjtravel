-- Imported manual-ticket completion is a non-financial terminal transition.
-- It consumes only fresh, complete, identity-matched airline Manage Booking
-- evidence and proves the original Confirm & Pay capture before confirming.

create or replace function public.complete_impexp_manual_ticketing_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_evidence_observation_id uuid,
  p_actor_user_id text,
  p_request_key text
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
  v_ticket_numbers jsonb;
  v_airlines_pnr jsonb;
  v_supplier_pnr text;
  v_supplier_status text;
  v_fresh_until timestamptz;
  v_traveller_count integer;
  v_capture_ledger_count integer;
  v_occurrence_number integer;
  v_event_id bigint;
  v_now timestamptz := clock_timestamp();
  v_result jsonb;
begin
  if p_booking_id is null
     or p_case_id is null
     or p_evidence_observation_id is null
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or p_request_key is null
     or p_request_key !~ '^impexp-manual-complete:v1:[0-9a-f-]{36}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_COMPLETION_REQUEST');
  end if;

  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role is null
     or v_actor_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'IMPEXP_COMPLETION_FORBIDDEN');
  end if;

  -- Read the immutable link first, then acquire the global mutation prefix:
  -- booking -> operation -> case -> reservation -> wallet -> account.
  select candidate.operation_id into v_operation_id
    from public.booking_reconciliation_cases candidate
   where candidate.id = p_case_id
     and candidate.subject_booking_id = p_booking_id;
  if not found or v_operation_id is null then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_CASE_NOT_FOUND');
  end if;

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
    if v_case.resolution->>'executionRequestKey' = p_request_key
       and v_case.resolution->>'resolutionKind'
          = 'imported_manual_ticketed' then
      return coalesce(v_case.resolution->'result', '{}'::jsonb)
        || jsonb_build_object(
          'ok', true,
          'replay', true,
          'caseId', v_case.id,
          'caseVersion', v_case.version,
          'resolutionKind', 'imported_manual_ticketed'
        );
    end if;
    return jsonb_build_object('ok', false, 'code', 'CASE_ALREADY_RESOLVED');
  end if;

  if v_booking.import_source is distinct from 'IMP_EXP'
     or v_booking.status <> 'in-progress'
     or v_booking.active_operation_id is distinct from v_operation.id
     or v_booking.operation_kind is distinct from 'ticketing'
     or v_booking.operation_reason is distinct from 'imported_manual_ticketing'
     or v_operation.booking_id is distinct from v_booking.id
     or v_operation.kind is distinct from 'imported_manual_ticketing'
     or v_operation.state is distinct from 'awaiting_external_action'
     or v_case.case_type is distinct from 'imported_manual_ticketing'
     or v_case.state not in ('open', 'assigned', 'awaiting_supplier') then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_TICKET_NOT_COMPLETABLE');
  end if;
  if v_case.financial_disposition <> 'none' then
    return jsonb_build_object(
      'ok', false, 'code', 'MANUAL_TICKET_FINANCIAL_REVIEW_REQUIRED'
    );
  end if;

  select reservation.* into v_reservation
    from public.wallet_reservations reservation
   where reservation.booking_id = v_booking.id
   for update;
  if not found then
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
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;

  if v_booking.payment_state <> 'captured'
     or v_booking.user_payable_amount is null
     or v_booking.user_payable_amount <= 0
     or v_booking.payment_amount is distinct from v_booking.user_payable_amount
     or v_booking.captured_amount is distinct from v_booking.user_payable_amount
     or v_booking.refunded_amount <> 0
     or v_booking.charged_wallet_account_id is distinct from v_account.id
     or v_booking.currency is distinct from v_account.currency
     or v_reservation.state <> 'captured'
     or v_reservation.amount is distinct from v_booking.user_payable_amount
     or v_reservation.currency is distinct from v_booking.currency
     or v_reservation.captured_at is null then
    return jsonb_build_object('ok', false, 'code', 'CAPTURED_PAYMENT_MISMATCH');
  end if;
  select count(*)::integer into v_capture_ledger_count
    from public.wallet_ledger_entries ledger
   where ledger.booking_id = v_booking.id
     and ledger.reservation_id = v_reservation.id
     and ledger.wallet_account_id = v_account.id
     and ledger.transaction_type = 'booking_confirm'
     and ledger.amount = v_booking.user_payable_amount
     and ledger.currency = v_booking.currency;
  if v_capture_ledger_count <> 1 then
    return jsonb_build_object('ok', false, 'code', 'CAPTURE_LEDGER_MISMATCH');
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
     or v_evidence.normalized_facts->>'requestedPurpose'
        is distinct from 'ticketed'
     or v_evidence.normalized_facts->>'bookingId'
        is distinct from v_booking.id::text
     or v_evidence.normalized_facts->>'caseId'
        is distinct from v_case.id::text
     or coalesce((v_evidence.normalized_facts
       #>> '{validation,valid}')::boolean, false) is not true
     or coalesce((v_evidence.normalized_facts
       #>> '{validation,complete}')::boolean, false) is not true
     or coalesce((v_evidence.normalized_facts
       #>> '{validation,fresh}')::boolean, false) is not true
     or coalesce((v_evidence.normalized_facts
       #>> '{validation,identityMatches}')::boolean, false) is not true
     or v_evidence.normalized_facts
       #>> '{validation,authoritativeFor}' is distinct from 'ticketed'
     or v_evidence.normalized_facts
       #>> '{evidence,importedSupplier,source}'
          is distinct from 'airline-manage-booking'
     or v_evidence.normalized_facts
       #>> '{evidence,importedSupplier,provider}'
          is distinct from v_booking.supplier
     or v_evidence.normalized_facts
       #>> '{evidence,importedSupplier,identity,supplierReference}'
          is distinct from v_booking.booking_ref_number
     or v_evidence.observed_at < v_now - interval '5 minutes'
     or v_evidence.observed_at > v_now + interval '1 minute' then
    return jsonb_build_object(
      'ok', false, 'code', 'AUTHORITATIVE_IMPORTED_TICKET_EVIDENCE_REQUIRED'
    );
  end if;
  begin
    v_fresh_until := (v_evidence.normalized_facts
      #>> '{evidence,importedSupplier,freshUntil}')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    return jsonb_build_object(
      'ok', false, 'code', 'AUTHORITATIVE_IMPORTED_TICKET_EVIDENCE_REQUIRED'
    );
  end;
  if v_fresh_until is null or v_fresh_until < v_now then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_TICKET_EVIDENCE_STALE');
  end if;

  v_ticket_numbers := v_evidence.normalized_facts
    #> '{evidence,importedSupplier,facts,ticketNumbers}';
  v_airlines_pnr := v_evidence.normalized_facts
    #> '{evidence,importedSupplier,facts,airlinesPnr}';
  v_supplier_pnr := nullif(btrim(v_evidence.normalized_facts
    #>> '{evidence,importedSupplier,facts,pnr}'), '');
  v_supplier_status := nullif(btrim(v_evidence.normalized_facts
    #>> '{evidence,importedSupplier,facts,supplierStatus}'), '');
  v_traveller_count := case
    when jsonb_typeof(v_booking.passengers->'travellers') = 'array'
      then jsonb_array_length(v_booking.passengers->'travellers')
    else 0
  end;
  if v_traveller_count <= 0
     or jsonb_typeof(v_ticket_numbers) <> 'array'
     or jsonb_array_length(v_ticket_numbers) <> v_traveller_count
     or exists (
       select 1 from jsonb_array_elements(v_ticket_numbers) ticket(value)
        where jsonb_typeof(ticket.value) <> 'string'
           or nullif(btrim(ticket.value #>> '{}'), '') is null
     )
     or jsonb_typeof(v_airlines_pnr) <> 'array'
     or jsonb_array_length(v_airlines_pnr) = 0
     or v_supplier_pnr is null then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_TICKET_EVIDENCE_INCOMPLETE');
  end if;
  if public.jsonb_is_nonempty_array(v_booking.ticket_numbers)
     and not (
       v_booking.ticket_numbers @> v_ticket_numbers
       and v_ticket_numbers @> v_booking.ticket_numbers
     ) then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_TICKET_IDENTITY_CONFLICT');
  end if;
  if public.jsonb_is_nonempty_array(v_booking.airlines_pnr)
     and not (
       v_booking.airlines_pnr @> v_airlines_pnr
       and v_airlines_pnr @> v_booking.airlines_pnr
     ) then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_PNR_IDENTITY_CONFLICT');
  end if;
  if exists (
    select 1 from public.booking_status_events event
     where event.booking_id = v_booking.id
       and event.idempotency_key = p_request_key || ':confirmed'
       and event.to_lifecycle_status = 'confirmed'
  ) then
    return jsonb_build_object('ok', false, 'code', 'COMPLETION_IDEMPOTENCY_CONFLICT');
  end if;

  update public.flight_bookings
     set status = 'confirmed',
         issued_by_user_id = p_actor_user_id,
         issued_at = coalesce(issued_at, v_evidence.observed_at),
         pnr = coalesce(v_supplier_pnr, pnr),
         airlines_pnr = v_airlines_pnr,
         booking_status = coalesce(v_supplier_status, 'Confirmed'),
         ticket_numbers = v_ticket_numbers,
         synced_at = greatest(coalesce(synced_at, v_evidence.observed_at),
           v_evidence.observed_at),
         import_metadata = coalesce(import_metadata, '{}'::jsonb)
           || jsonb_build_object(
             'manualTicketCompletedAt', v_now,
             'manualTicketCompletedBy', p_actor_user_id,
             'completionEvidenceObservationId', v_evidence.id
           ),
         active_operation_id = null,
         operation_kind = null,
         operation_reason = null,
         operation_request_id = null,
         operation_actor_user_id = null,
         operation_started_at = null,
         operation_prior_status = null
   where id = v_booking.id;
  update public.booking_operations
     set state = 'succeeded',
         supplier_response_received_at = greatest(
           coalesce(supplier_response_received_at, v_evidence.observed_at),
           v_evidence.observed_at
         ),
         completed_at = v_now,
         error_code = null,
         error_message = null,
         supplier_pnr = coalesce(v_supplier_pnr, supplier_pnr),
         supplier_evidence = supplier_evidence || jsonb_build_object(
           'manualTicketCompletion', jsonb_build_object(
             'caseId', v_case.id,
             'evidenceObservationId', v_evidence.id,
             'ticketCount', jsonb_array_length(v_ticket_numbers),
             'completedAt', v_now
           )
         )
   where id = v_operation.id;

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
    v_booking.id, 'in-progress', 'confirmed',
    'in-progress', 'confirmed', 'ticketing',
    'imported_manual_ticketing', p_actor_user_id,
    'ImportedManualTicketCompletion',
    jsonb_build_object(
      'evidenceObservationId', v_evidence.id,
      'ticketCount', jsonb_array_length(v_ticket_numbers),
      'walletMutation', false,
      'additionalDebit', 0
    ),
    p_request_key || ':confirmed', v_operation.id, v_case.id,
    v_occurrence_number, v_evidence.observed_at, v_now,
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'lifecycleStatus', 'confirmed',
      'paymentState', 'captured',
      'operationKind', 'imported_manual_ticketing',
      'operationSource', 'imported_manual_ticketing',
      'operationId', v_operation.id,
      'reconciliationCaseId', v_case.id,
      'ticketCount', jsonb_array_length(v_ticket_numbers),
      'userPayableAmount', v_booking.user_payable_amount,
      'currency', v_booking.currency
    ), 1
  ) returning id into v_event_id;

  v_result := jsonb_build_object(
    'bookingStatus', 'confirmed',
    'paymentState', 'captured',
    'operationId', v_operation.id,
    'caseId', v_case.id,
    'reservationId', v_reservation.id,
    'walletAccountId', v_account.id,
    'evidenceObservationId', v_evidence.id,
    'lifecycleEventId', v_event_id,
    'ticketCount', jsonb_array_length(v_ticket_numbers),
    'capturedAmount', v_booking.captured_amount,
    'currency', v_booking.currency,
    'additionalDebit', 0,
    'walletMutation', false,
    'ledgerMutation', false
  );
  update public.booking_reconciliation_cases
     set state = 'resolved',
         resolution_outcome = 'ticketed',
         resolution = jsonb_build_object(
           'version', 1,
           'executionRequestKey', p_request_key,
           'resolutionKind', 'imported_manual_ticketed',
           'executedByRole', v_actor_role,
           'evidenceObservationIds', jsonb_build_array(v_evidence.id),
           'result', v_result
         ),
         resolution_reason = 'Fresh complete matching imported ticket evidence',
         resolved_by_user_id = p_actor_user_id,
         resolved_at = v_now,
         closed_at = v_now,
         version = version + 1
   where id = v_case.id;

  return v_result || jsonb_build_object(
    'ok', true,
    'replay', false,
    'caseVersion', v_case.version + 1,
    'resolutionKind', 'imported_manual_ticketed'
  );
end;
$$;

revoke all on function public.complete_impexp_manual_ticketing_v1(
  uuid, uuid, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.complete_impexp_manual_ticketing_v1(
  uuid, uuid, uuid, text, text
) to service_role;

comment on function public.complete_impexp_manual_ticketing_v1(
  uuid, uuid, uuid, text, text
) is
  'Completes paid imported manual ticketing from fresh complete matching Manage Booking evidence. It confirms travel truth and closes the operation/case without changing wallet balances, reservations, or ledger entries.';
