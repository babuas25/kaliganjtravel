-- Owner Confirm & Pay is one atomic business action: capture the protected
-- User Payable once, create the durable imported-manual-ticket operation and
-- Support-owned case, enter In Progress, and emit the occurrence/outbox.

create or replace function public.wallet_confirm_impexp_booking(
  p_booking_id uuid,
  p_actor_user_id text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_actor_role text;
  v_actor_agency text;
  v_existing_operation public.booking_operations;
  v_existing_case public.booking_reconciliation_cases;
  v_existing_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_reservation public.wallet_reservations;
  v_available_before bigint;
  v_hold_before bigint;
  v_ledger_key text;
  v_operation_request_key text;
  v_payload_hash text;
  v_now timestamptz := clock_timestamp();
  v_due_at timestamptz;
  v_event_id bigint;
  v_occurrence_number integer;
begin
  if p_booking_id is null
     or nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_idempotency_key), '') is null
     or char_length(p_idempotency_key) > 220 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CONFIRM_REQUEST');
  end if;
  select app_user.role, app_user.agency_code
    into v_actor_role, v_actor_agency
    from public.app_users app_user
   where app_user.clerk_id = p_actor_user_id;
  if not found or v_actor_role not in ('customer', 'b2b', 'b2b_sub') then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_CONFIRM_FORBIDDEN');
  end if;

  -- The booking is the serialization root for owner, payment, operation, case,
  -- and reservation identity.
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
     and booking.import_source = 'IMP_EXP'
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_NOT_FOUND');
  end if;
  if not (
    (v_actor_role = 'customer'
      and v_booking.booking_owner_type = 'user'
      and v_booking.booking_owner_key = p_actor_user_id)
    or
    (v_actor_role in ('b2b', 'b2b_sub')
      and nullif(btrim(v_actor_agency), '') is not null
      and v_booking.booking_owner_type = 'agency'
      and v_booking.booking_owner_key = v_actor_agency)
  ) then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_CONFIRM_FORBIDDEN');
  end if;

  v_ledger_key := 'impexp-payment:' || v_booking.id::text;
  v_operation_request_key :=
    'impexp-manual-ticketing:' || v_booking.id::text;
  v_payload_hash := encode(sha256(convert_to(jsonb_build_object(
    'version', 1,
    'bookingId', v_booking.id,
    'ownerType', v_booking.booking_owner_type,
    'ownerKey', v_booking.booking_owner_key,
    'amount', v_booking.user_payable_amount,
    'currency', upper(v_booking.currency)
  )::text, 'UTF8')), 'hex');

  select operation.* into v_existing_operation
    from public.booking_operations operation
   where operation.booking_id = v_booking.id
     and operation.state in (
       'claimed', 'supplier_call_started', 'awaiting_external_action',
       'needs_reconciliation'
     )
   order by operation.claimed_at desc, operation.id desc
   limit 1
   for update;
  if found then
    select reconciliation_case.* into v_existing_case
      from public.booking_reconciliation_cases reconciliation_case
     where reconciliation_case.operation_id = v_existing_operation.id
       and reconciliation_case.subject_booking_id = v_booking.id
       and reconciliation_case.state not in ('resolved', 'closed_no_change')
     limit 1
     for update;
  else
    select reconciliation_case.* into v_existing_case
      from public.booking_reconciliation_cases reconciliation_case
     where reconciliation_case.subject_booking_id = v_booking.id
       and reconciliation_case.state not in ('resolved', 'closed_no_change')
     limit 1
     for update;
  end if;
  select reservation.* into v_existing_reservation
    from public.wallet_reservations reservation
   where reservation.booking_id = v_booking.id
   for update;

  if v_booking.payment_state = 'captured' then
    if v_booking.status = 'in-progress'
       and v_booking.captured_amount = v_booking.user_payable_amount
       and v_booking.refunded_amount = 0
       and v_booking.active_operation_id = v_existing_operation.id
       and v_existing_operation.kind = 'imported_manual_ticketing'
       and v_existing_operation.request_key = v_operation_request_key
       and v_existing_operation.request_payload_hash = v_payload_hash
       and v_existing_operation.state = 'awaiting_external_action'
       and v_existing_case.case_type = 'imported_manual_ticketing'
       and v_existing_reservation.state = 'captured'
       and v_existing_reservation.amount = v_booking.user_payable_amount
       and v_existing_reservation.wallet_account_id
          = v_booking.charged_wallet_account_id
       and exists (
         select 1 from public.wallet_ledger_entries ledger
          where ledger.idempotency_key = v_ledger_key
            and ledger.booking_id = v_booking.id
            and ledger.amount = v_booking.user_payable_amount
       ) then
      return jsonb_build_object(
        'ok', true, 'replay', true,
        'status', 'in-progress',
        'operationId', v_existing_operation.id,
        'operationState', v_existing_operation.state,
        'reconciliationCaseId', v_existing_case.id,
        'reservationId', v_existing_reservation.id,
        'accountId', v_booking.charged_wallet_account_id,
        'amount', v_booking.captured_amount,
        'currency', v_booking.currency
      );
    end if;
    return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REQUIRED');
  end if;
  if v_existing_operation.id is not null
     or v_existing_case.id is not null
     or v_existing_reservation.id is not null then
    return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REQUIRED');
  end if;
  if v_booking.status <> 'on-hold'
     or v_booking.operation_kind is not null
     or v_booking.payment_state <> 'unpaid'
     or v_booking.charged_wallet_account_id is not null
     or v_booking.captured_amount <> 0
     or v_booking.refunded_amount <> 0
     or public.resolve_booking_lifecycle(
       v_booking.status, v_booking.airlines_pnr,
       v_booking.ticketing_deadline_at, v_booking.operation_kind
     ) <> 'on-hold' then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_ISSUABLE');
  end if;
  if v_booking.user_payable_amount is null
     or v_booking.user_payable_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
  end if;

  select wallet.* into v_wallet
    from public.wallets wallet
   where wallet.owner_type = v_booking.booking_owner_type
     and wallet.owner_key = v_booking.booking_owner_key
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND');
  end if;
  select account.* into v_account
    from public.wallet_accounts account
   where account.wallet_id = v_wallet.id
     and account.currency = upper(v_booking.currency)
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;
  if v_wallet.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN');
  end if;
  if v_account.available_balance < v_booking.user_payable_amount then
    return jsonb_build_object(
      'ok', false, 'code', 'INSUFFICIENT_FUNDS',
      'available', v_account.available_balance,
      'required', v_booking.user_payable_amount,
      'currency', v_account.currency
    );
  end if;

  v_due_at := case
    when v_booking.ticketing_deadline_at is null
      then v_now + interval '2 hours'
    else greatest(
      v_now,
      least(
        v_now + interval '2 hours',
        v_booking.ticketing_deadline_at - interval '1 hour'
      )
    )
  end;
  insert into public.booking_operations (
    booking_id, kind, state, reason_code, reason_detail,
    request_key, request_payload_hash, actor_user_id, actor_role,
    source, prior_stored_status, prior_lifecycle_status,
    supplier, supplier_operation, supplier_unique_trans_id,
    supplier_booking_code_ref, supplier_pnr, supplier_evidence,
    policy_version, claimed_at, external_action_due_at
  ) values (
    v_booking.id, 'imported_manual_ticketing', 'awaiting_external_action',
    'imported_manual_ticketing',
    'Owner payment captured; external manual ticketing is required.',
    v_operation_request_key, v_payload_hash,
    p_actor_user_id, v_actor_role, 'customer',
    'on-hold', 'on-hold', v_booking.supplier,
    'ManualExternalTicketing',
    v_booking.supplier_refs->>'uniqueTransId',
    v_booking.booking_code_ref, v_booking.pnr,
    jsonb_build_object(
      'paymentCaptured', true,
      'supplierApiCalled', false,
      'clientRequestId', p_idempotency_key,
      'userPayableAmount', v_booking.user_payable_amount,
      'currency', v_booking.currency,
      'externalActionDueAt', v_due_at,
      'slaPolicy', jsonb_build_object(
        'policyVersion', 1,
        'warnUnassignedAfterMinutes', 30,
        'adminEscalationAtDue', true,
        'superAdminAfterOverdueMinutes', 60
      )
    ), 1, v_now, v_due_at
  ) returning * into v_operation;
  insert into public.booking_reconciliation_cases (
    subject_booking_id, operation_id, case_type, state,
    reason_code, reason_detail, opened_source,
    opened_by_user_id, opened_by_role, opened_at,
    assigned_team, assigned_at, severity, priority, due_at,
    escalation_level,
    evidence, financial_disposition, policy_version
  ) values (
    v_booking.id, v_operation.id, 'imported_manual_ticketing', 'assigned',
    'manual_ticketing_required',
    'Payment received; verify and complete external supplier ticketing.',
    'operation', p_actor_user_id, v_actor_role, v_now,
    'support', v_now, 'high', 30, v_due_at, 0,
    jsonb_build_array(jsonb_build_object(
      'type', 'owner_payment_capture',
      'operationId', v_operation.id,
      'amount', v_booking.user_payable_amount,
      'currency', v_booking.currency,
      'supplierApiCalled', false,
      'externalActionDueAt', v_due_at,
      'slaPolicy', jsonb_build_object(
        'policyVersion', 1,
        'warnUnassignedAfterMinutes', 30,
        'adminEscalationAtDue', true,
        'superAdminAfterOverdueMinutes', 60
      ),
      'recordedAt', v_now
    )), 'none', 1
  ) returning * into v_case;

  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  update public.wallet_accounts
     set available_balance = available_balance - v_booking.user_payable_amount
   where id = v_account.id;
  insert into public.wallet_reservations (
    wallet_account_id, booking_id, amount, currency, state,
    requested_by_user_id, issued_by_user_id, captured_at
  ) values (
    v_account.id, v_booking.id, v_booking.user_payable_amount,
    v_account.currency, 'captured', p_actor_user_id, p_actor_user_id, v_now
  ) returning * into v_reservation;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks, metadata
  ) values (
    v_account.id, 'booking_confirm', v_booking.user_payable_amount,
    v_account.currency, v_available_before,
    v_available_before - v_booking.user_payable_amount,
    v_hold_before, v_hold_before, v_booking.id, v_booking.public_ref,
    v_reservation.id, v_ledger_key, p_actor_user_id, v_actor_role,
    'Owner confirmed imported booking for manual external ticketing',
    jsonb_build_object(
      'importSource', 'IMP_EXP',
      'operationId', v_operation.id,
      'reconciliationCaseId', v_case.id,
      'supplierGrossAmount', v_booking.supplier_gross_amount,
      'userPayableAmount', v_booking.user_payable_amount
    )
  );
  update public.flight_bookings
     set charged_wallet_account_id = v_account.id,
         payment_state = 'captured',
         payment_amount = user_payable_amount,
         captured_amount = user_payable_amount,
         status = 'in-progress',
         active_operation_id = v_operation.id,
         operation_kind = 'ticketing',
         operation_reason = 'imported_manual_ticketing',
         operation_request_id = v_operation_request_key,
         operation_actor_user_id = p_actor_user_id,
         operation_started_at = v_now,
         operation_prior_status = 'on-hold'
   where id = v_booking.id;
  select count(*)::integer + 1 into v_occurrence_number
    from public.booking_status_events event
   where event.booking_id = v_booking.id
     and event.to_lifecycle_status = 'in-progress';
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, operation_id,
    reconciliation_case_id, occurrence_number,
    effective_at, observed_at, event_snapshot, event_version
  ) values (
    v_booking.id, 'on-hold', 'in-progress', 'on-hold', 'in-progress',
    'ticketing', 'imported_manual_ticketing', p_actor_user_id,
    'ImportCustomerConfirm',
    jsonb_build_object(
      'walletCaptured', true,
      'supplierApiCalled', false,
      'userPayableAmount', v_booking.user_payable_amount
    ),
    v_ledger_key || ':in-progress', v_operation.id, v_case.id,
    v_occurrence_number, v_now, v_now,
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'lifecycleStatus', 'in-progress',
      'paymentState', 'captured',
      'operationKind', 'imported_manual_ticketing',
      'operationSource', 'imported_manual_ticketing',
      'operationId', v_operation.id,
      'reconciliationCaseId', v_case.id,
      'userPayableAmount', v_booking.user_payable_amount,
      'currency', v_booking.currency
    ), 1
  ) returning id into v_event_id;

  return jsonb_build_object(
    'ok', true, 'replay', false,
    'status', 'in-progress',
    'operationId', v_operation.id,
    'operationState', v_operation.state,
    'reconciliationCaseId', v_case.id,
    'reservationId', v_reservation.id,
    'accountId', v_account.id,
    'lifecycleEventId', v_event_id,
    'amount', v_booking.user_payable_amount,
    'currency', v_account.currency,
    'availableBalance', v_available_before - v_booking.user_payable_amount,
    'holdBalance', v_hold_before
  );
end;
$$;

revoke all on function public.wallet_confirm_impexp_booking(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.wallet_confirm_impexp_booking(uuid,text,text)
  to service_role;

comment on function public.wallet_confirm_impexp_booking(uuid,text,text) is
  'Atomically captures imported User Payable exactly once and creates the durable awaiting-external-action operation, Support-owned case, In Progress occurrence, and outbox intent. No supplier write occurs.';
