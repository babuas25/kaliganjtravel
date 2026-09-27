-- One booking repair for a durably recorded Shapontravels pre-dispatch wallet
-- refusal. The exact 409 INSUFFICIENT_FUNDS response is conclusive: Shapon's
-- NewTicket wallet reservation fails in the same transaction before dispatch.
-- This is a named, atomic reconciliation action, not a generic status edit.

create or replace function public.resolve_ktt0aen460aen46_wallet_refusal_v1(
  p_actor_user_id text,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_ledger_id uuid;
  v_event_id bigint;
  v_result jsonb;
  v_available_before bigint;
  v_hold_before bigint;
  v_occurrence integer;
begin
  if nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_request_key), '') is null
     or char_length(p_request_key) > 180 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST');
  end if;
  if not exists (
    select 1 from public.app_users
     where clerk_id = p_actor_user_id and role = 'superadmin'
  ) then
    return jsonb_build_object('ok', false, 'code', 'SUPERADMIN_REQUIRED');
  end if;

  -- Serialize in the established booking -> operation -> case -> reservation
  -- -> wallet -> account order. The fixed identities prevent use for another
  -- booking or a later issue attempt.
  select * into v_booking from public.flight_bookings
   where id = '402933e6-3806-4c0e-9483-a71a9302646b'::uuid
     and public_ref = 'KTT0AEN460AEN46' for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select * into v_operation from public.booking_operations
   where id = 'b91a63e1-bb75-4e7d-8871-32a4a3972caa'::uuid
     and booking_id = v_booking.id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_FOUND');
  end if;
  select * into v_case from public.booking_reconciliation_cases
   where id = '1f0edcda-d5c5-4c37-b4ee-1ebc8609e81a'::uuid
     and subject_booking_id = v_booking.id
     and operation_id = v_operation.id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND');
  end if;
  if v_case.state = 'resolved'
     and v_case.resolution->>'executionRequestKey' = p_request_key
     and v_case.resolution->>'resolutionKind' = 'shapon_pre_dispatch_wallet_refusal' then
    return coalesce(v_case.resolution->'result', '{}'::jsonb)
      || jsonb_build_object('ok', true, 'replay', true);
  end if;
  if v_booking.supplier <> 'shapontravels'
     or v_booking.supplier_account <> 'shapontravels'
     or v_booking.booking_code_ref <> '1845ce8b-0268-40ca-a825-c93364a2b63e'
     or v_booking.status <> 'in-progress'
     or v_booking.payment_state <> 'reconciliation'
     or v_booking.operation_kind <> 'reconciliation'
     or v_booking.active_operation_id is distinct from v_operation.id
     or v_booking.captured_amount <> 0
     or v_booking.refunded_amount <> 0
     or v_booking.issued_at is not null
     or v_booking.ticket_code_ref is not null
     or jsonb_array_length(coalesce(v_booking.ticket_numbers, '[]'::jsonb)) <> 0
     or v_operation.kind <> 'ticketing'
     or v_operation.state <> 'needs_reconciliation'
     or v_operation.supplier_operation <> 'NewTicket'
     or v_operation.error_code <> 'INCOMPLETE_RESPONSE'
     or v_operation.error_message <> 'Shapontravels NewTicket INSUFFICIENT_FUNDS'
     or v_operation.supplier_call_started_at is null
     or v_operation.supplier_response_received_at is null
     or v_operation.supplier_evidence->>'httpStatus' <> '409'
     or v_operation.supplier_evidence->>'responseObserved' <> 'true'
     or v_case.case_type <> 'ticketing_uncertainty'
     or v_case.state <> 'open'
     or coalesce(v_case.proposal, '{}'::jsonb) <> '{}'::jsonb
     or v_booking.ticketing_time_limit <> '27/09/2026 18:45:00'
     or v_booking.supplier_ticketing_deadline_at <> '2026-09-27 12:45:00+00'::timestamptz
     or v_booking.active_local_time_limit_request_id is not null
     or v_booking.active_superadmin_deadline_override_id is not null
     or v_booking.ticketing_deadline_at <> '2026-09-27 12:45:00+00'::timestamptz then
    return jsonb_build_object('ok', false, 'code', 'RECOVERY_FACTS_CHANGED');
  end if;
  if exists (
    select 1 from public.booking_reconciliation_cases
     where subject_booking_id = v_booking.id and id <> v_case.id
       and state in ('open','assigned','awaiting_supplier','awaiting_finance','awaiting_approval')
  ) then
    return jsonb_build_object('ok', false, 'code', 'OTHER_CASE_OPEN');
  end if;

  select * into v_reservation from public.wallet_reservations
   where id = '58e5490e-e71f-4c30-b0d0-65a29e676570'::uuid
     and booking_id = v_booking.id for update;
  if not found or v_reservation.state <> 'reconciliation'
     or v_reservation.amount <> 508315
     or v_reservation.currency <> 'BDT'
     or v_booking.payment_amount is distinct from v_reservation.amount
     or v_booking.charged_wallet_account_id is distinct from v_reservation.wallet_account_id then
    return jsonb_build_object('ok', false, 'code', 'RESERVATION_FACTS_CHANGED');
  end if;
  if exists (
    select 1 from public.wallet_ledger_entries
     where reservation_id = v_reservation.id
       and transaction_type in ('booking_confirm','hold_release','refund')
  ) then
    return jsonb_build_object('ok', false, 'code', 'RESERVATION_ALREADY_SETTLED');
  end if;
  select wallet.* into v_wallet from public.wallets wallet
    join public.wallet_accounts account on account.wallet_id = wallet.id
   where account.id = v_reservation.wallet_account_id for update of wallet;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND');
  end if;
  select * into v_account from public.wallet_accounts
   where id = v_reservation.wallet_account_id and wallet_id = v_wallet.id for update;
  if not found or v_account.currency <> 'BDT'
     or v_account.hold_balance < v_reservation.amount then
    return jsonb_build_object('ok', false, 'code', 'ACCOUNT_FACTS_CHANGED');
  end if;

  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  update public.wallet_accounts
     set available_balance = available_balance + v_reservation.amount,
         hold_balance = hold_balance - v_reservation.amount
   where id = v_account.id;
  update public.wallet_reservations
     set state = 'released', released_at = clock_timestamp(),
         release_reason = 'Shapon NewTicket pre-dispatch wallet refusal (HTTP 409)',
         reconciliation_at = null, reconciliation_reason = null
   where id = v_reservation.id;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks, metadata
  ) values (
    v_account.id, 'hold_release', v_reservation.amount, 'BDT',
    v_available_before, v_available_before + v_reservation.amount,
    v_hold_before, v_hold_before - v_reservation.amount,
    v_booking.id, v_booking.public_ref, v_reservation.id,
    p_request_key || ':release', p_actor_user_id, 'superadmin',
    'Verified pre-dispatch Shapon wallet refusal',
    jsonb_build_object('caseId',v_case.id,'operationId',v_operation.id,
      'supplierHttpStatus',409,'supplierError','INSUFFICIENT_FUNDS')
  ) returning id into v_ledger_id;

  -- The original Book string has no offset. Shapon treats it as unverified;
  -- Kaliganj must not continue enforcing its parsed 18:45 as supplier truth.
  update public.flight_bookings
     set status = 'on-hold', payment_state = 'released',
         supplier_ticketing_deadline_at = null,
         supplier_deadline_source = 'supplier',
         active_operation_id = null, operation_kind = null,
         operation_reason = null, operation_request_id = null,
         operation_actor_user_id = null, operation_started_at = null,
         operation_prior_status = null
   where id = v_booking.id;
  update public.booking_operations
     set state = 'failed', completed_at = clock_timestamp(),
         error_code = 'SUPPLIER_WALLET_REFUSED',
         error_message = 'Shapon rejected NewTicket before dispatch: INSUFFICIENT_FUNDS',
         supplier_evidence = supplier_evidence || jsonb_build_object(
           'reconciliationResolution', jsonb_build_object(
             'caseId', v_case.id, 'kind', 'pre_dispatch_wallet_refusal',
             'supplierHttpStatus', 409, 'ledgerEntryId', v_ledger_id))
   where id = v_operation.id;
  select count(*)::integer + 1 into v_occurrence from public.booking_status_events
   where booking_id = v_booking.id and to_lifecycle_status = 'on-hold';
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, operation_id,
    reconciliation_case_id, occurrence_number, effective_at,
    observed_at, event_snapshot, event_version
  ) values (
    v_booking.id, 'in-progress', 'on-hold',
    'in-progress', 'on-hold', 'reconciliation',
    v_booking.operation_reason, p_actor_user_id, 'NewTicket',
    jsonb_build_object('httpStatus',409,'error','INSUFFICIENT_FUNDS',
      'preDispatch',true), p_request_key || ':on-hold',
    v_operation.id, v_case.id, v_occurrence, clock_timestamp(),
    clock_timestamp(), jsonb_build_object(
      'version',1,'bookingReference',v_booking.public_ref,
      'lifecycleStatus','on-hold','storedStatus','on-hold',
      'paymentState','released','reconciliationCaseId',v_case.id), 1
  ) returning id into v_event_id;

  v_result := jsonb_build_object(
    'bookingReference',v_booking.public_ref,'bookingStatus','on-hold',
    'paymentState','released','reservationId',v_reservation.id,
    'releasedAmount',v_reservation.amount,'currency','BDT',
    'ledgerEntryId',v_ledger_id,'lifecycleEventId',v_event_id,
    'availableBalance',v_available_before + v_reservation.amount,
    'holdBalance',v_hold_before - v_reservation.amount
  );
  update public.booking_reconciliation_cases
     set state = 'resolved', resolution_outcome = 'held_not_ticketed',
         financial_disposition = 'release_existing_hold',
         resolution = jsonb_build_object(
           'version',1,'resolutionKind','shapon_pre_dispatch_wallet_refusal',
           'executionRequestKey',p_request_key,'evidenceKind','recorded_supplier_http_409',
           'evidenceRequired',false,'result',v_result),
         resolution_reason = 'Recorded Shapon NewTicket 409 INSUFFICIENT_FUNDS is pre-dispatch',
         resolved_by_user_id = p_actor_user_id,
         resolved_at = clock_timestamp(), closed_at = clock_timestamp(),
         version = version + 1
   where id = v_case.id;
  insert into public.security_audit_events (
    actor_user_id,actor_role,action,target_type,target_id,outcome,metadata
  ) values (
    p_actor_user_id,'superadmin','booking.reconciliation.shapon_wallet_refusal',
    'flight_booking',v_booking.id::text,'succeeded',
    jsonb_build_object('caseId',v_case.id,'operationId',v_operation.id,
      'reservationId',v_reservation.id,'ledgerEntryId',v_ledger_id,
      'releasedAmount',v_reservation.amount,'requestKey',p_request_key)
  );
  return v_result || jsonb_build_object('ok',true,'replay',false);
end;
$$;

revoke all on function public.resolve_ktt0aen460aen46_wallet_refusal_v1(text,text)
  from public, anon, authenticated;
grant execute on function public.resolve_ktt0aen460aen46_wallet_refusal_v1(text,text)
  to service_role;
