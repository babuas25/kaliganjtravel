-- Super Admin, Admin, and Support Staff may start imported/manual ticketing on
-- behalf of the assigned owner. The actor is retained for audit, while every
-- wallet lookup and Hold remains pinned to the booking's durable owner.
-- Accounts Staff and all other roles stay forbidden. No supplier API is called.

create or replace function public.wallet_begin_imported_booking_issue_v2(
  p_booking_id uuid,
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
  v_actor_role text;
  v_actor_agency text;
  v_existing_ledger public.wallet_ledger_entries;
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
  v_due_at timestamptz;
  v_occurrence integer;
  v_event_id bigint;
  v_on_behalf boolean;
  v_now timestamptz := clock_timestamp();
begin
  if p_booking_id is null
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or p_request_key !~ '^imported-issue:v2:[0-9a-f-]{36}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORTED_ISSUE_REQUEST');
  end if;

  select role, agency_code into v_actor_role, v_actor_agency
    from public.app_users
   where clerk_id = p_actor_user_id;
  if not found
     or v_actor_role not in (
       'customer', 'b2b', 'b2b_sub',
       'superadmin', 'admin', 'staff_support'
     ) then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_ISSUE_FORBIDDEN');
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
     and booking.import_source in ('IMP_EXP', 'MANUAL')
     and not booking.legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_NOT_FOUND');
  end if;

  v_on_behalf := v_actor_role in ('superadmin', 'admin', 'staff_support');
  if not (
    (v_on_behalf
      and v_booking.booking_owner_type in ('user', 'agency')
      and nullif(btrim(v_booking.booking_owner_key), '') is not null)
    or
    (v_actor_role = 'customer'
      and v_booking.booking_owner_type = 'user'
      and v_booking.booking_owner_key = p_actor_user_id)
    or
    (v_actor_role in ('b2b', 'b2b_sub')
      and nullif(btrim(v_actor_agency), '') is not null
      and v_booking.booking_owner_type = 'agency'
      and v_booking.booking_owner_key = v_actor_agency)
  ) then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_ISSUE_FORBIDDEN');
  end if;

  select ledger.* into v_existing_ledger
    from public.wallet_ledger_entries ledger
   where ledger.idempotency_key = p_request_key || ':hold';
  if found and v_existing_ledger.booking_id is distinct from v_booking.id then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_ISSUE_IDEMPOTENCY_CONFLICT');
  end if;

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
  select reconciliation_case.* into v_existing_case
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.subject_booking_id = v_booking.id
     and reconciliation_case.state in (
       'open', 'assigned', 'awaiting_supplier', 'awaiting_finance',
       'awaiting_approval'
     )
   order by reconciliation_case.opened_at desc, reconciliation_case.id desc
   limit 1
   for update;
  select reservation.* into v_existing_reservation
    from public.wallet_reservations reservation
   where reservation.booking_id = v_booking.id
   for update;

  if v_existing_reservation.id is not null
     and v_existing_reservation.state in ('active', 'reconciliation')
     and v_booking.status = 'in-progress'
     and v_booking.payment_state in ('held', 'reconciliation')
     and v_existing_reservation.amount = v_booking.user_payable_amount
     and v_existing_operation.id = v_booking.active_operation_id
     and v_existing_operation.kind = 'imported_manual_ticketing'
     and v_existing_case.operation_id = v_existing_operation.id
     and exists (
       select 1 from public.wallet_ledger_entries ledger
        where ledger.reservation_id = v_existing_reservation.id
          and ledger.transaction_type = 'booking_hold'
          and ledger.amount = v_existing_reservation.amount
     ) then
    select account.* into v_account
      from public.wallet_accounts account
     where account.id = v_existing_reservation.wallet_account_id;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'status', 'in-progress',
      'paymentState', v_booking.payment_state,
      'operationId', v_existing_operation.id,
      'reconciliationCaseId', v_existing_case.id,
      'reservationId', v_existing_reservation.id,
      'accountId', v_existing_reservation.wallet_account_id,
      'amount', v_existing_reservation.amount,
      'currency', v_existing_reservation.currency,
      'availableBalance', v_account.available_balance,
      'holdBalance', v_account.hold_balance
    );
  end if;

  if v_booking.status = 'confirmed'
     or v_booking.payment_state in ('captured', 'partially-refunded', 'refunded')
     or (v_existing_reservation.id is not null
       and v_existing_reservation.state = 'captured') then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CAPTURED');
  end if;
  if v_existing_operation.id is not null
     or v_existing_case.id is not null
     or v_existing_reservation.id is not null
     or v_existing_ledger.id is not null then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_ACCOUNTING_RECONCILIATION_REQUIRED');
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

  -- Never resolve a wallet from the actor. Both owner and authorized staff
  -- paths use only the durable owner already assigned to this booking.
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
    when v_booking.ticketing_deadline_at is null then v_now + interval '2 hours'
    else greatest(
      v_now,
      least(v_now + interval '2 hours',
        v_booking.ticketing_deadline_at - interval '1 hour')
    )
  end;

  insert into public.booking_operations (
    booking_id, kind, state, reason_code, reason_detail,
    request_key, request_payload_hash, actor_user_id, actor_role, source,
    prior_stored_status, prior_lifecycle_status, supplier,
    supplier_operation, supplier_unique_trans_id,
    supplier_booking_code_ref, supplier_pnr, supplier_evidence,
    policy_version, claimed_at, external_action_due_at
  ) values (
    v_booking.id, 'imported_manual_ticketing', 'awaiting_external_action',
    'imported_manual_ticketing',
    case when v_on_behalf
      then 'Authorized staff placed assigned owner User Payable on Hold; external ticketing outcome is required.'
      else 'Owner placed User Payable on Hold; external ticketing outcome is required.'
    end,
    'imported-ticketing:v2:' || v_booking.id::text,
    encode(sha256(convert_to(jsonb_build_object(
      'version', 2, 'bookingId', v_booking.id,
      'ownerType', v_booking.booking_owner_type,
      'ownerKey', v_booking.booking_owner_key,
      'amount', v_booking.user_payable_amount,
      'currency', upper(v_booking.currency)
    )::text, 'UTF8')), 'hex'),
    p_actor_user_id, v_actor_role,
    case when v_on_behalf then 'staff' else 'customer' end,
    'on-hold', 'on-hold', v_booking.supplier,
    'ManualExternalTicketing',
    v_booking.supplier_refs->>'uniqueTransId', v_booking.booking_code_ref,
    v_booking.pnr,
    jsonb_build_object(
      'paymentHeld', true, 'paymentCaptured', false,
      'supplierApiCalled', false, 'clientRequestKey', p_request_key,
      'importSource', v_booking.import_source,
      'userPayableAmount', v_booking.user_payable_amount,
      'currency', v_booking.currency, 'externalActionDueAt', v_due_at,
      'initiatedOnBehalf', v_on_behalf,
      'walletOwnerType', v_booking.booking_owner_type,
      'accountingContractVersion', 2
    ),
    2, v_now, v_due_at
  ) returning * into v_operation;

  insert into public.booking_reconciliation_cases (
    subject_booking_id, operation_id, case_type, state,
    reason_code, reason_detail, opened_source, opened_by_user_id,
    opened_by_role, opened_at, assigned_team, assigned_at,
    severity, priority, due_at, escalation_level, evidence,
    financial_disposition, policy_version
  ) values (
    v_booking.id, v_operation.id, 'imported_manual_ticketing', 'assigned',
    'manual_ticketing_required',
    'User Payable is protected in Hold; verify ticketing and Capture or Release.',
    'operation', p_actor_user_id, v_actor_role, v_now,
    'support', v_now, 'high', 30, v_due_at, 0,
    jsonb_build_array(jsonb_build_object(
      'type', 'owner_payment_hold', 'operationId', v_operation.id,
      'amount', v_booking.user_payable_amount,
      'currency', v_booking.currency, 'supplierApiCalled', false,
      'initiatedOnBehalf', v_on_behalf,
      'walletOwnerType', v_booking.booking_owner_type,
      'accountingContractVersion', 2, 'recordedAt', v_now
    )),
    'none', 2
  ) returning * into v_case;

  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  update public.wallet_accounts set
    available_balance = available_balance - v_booking.user_payable_amount,
    hold_balance = hold_balance + v_booking.user_payable_amount
  where id = v_account.id;

  insert into public.wallet_reservations (
    wallet_account_id, booking_id, amount, currency, state,
    requested_by_user_id
  ) values (
    v_account.id, v_booking.id, v_booking.user_payable_amount,
    v_account.currency, 'active', p_actor_user_id
  ) returning * into v_reservation;

  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks, metadata
  ) values (
    v_account.id, 'booking_hold', v_booking.user_payable_amount,
    v_account.currency, v_available_before,
    v_available_before - v_booking.user_payable_amount,
    v_hold_before, v_hold_before + v_booking.user_payable_amount,
    v_booking.id, v_booking.public_ref, v_reservation.id,
    p_request_key || ':hold', p_actor_user_id, v_actor_role,
    'Imported booking Issue Now Hold',
    jsonb_build_object(
      'importSource', v_booking.import_source,
      'operationId', v_operation.id,
      'reconciliationCaseId', v_case.id,
      'supplierGrossAmount', v_booking.supplier_gross_amount,
      'userPayableAmount', v_booking.user_payable_amount,
      'supplierApiCalled', false,
      'initiatedOnBehalf', v_on_behalf,
      'walletOwnerType', v_booking.booking_owner_type,
      'accountingContractVersion', 2
    )
  );

  update public.flight_bookings set
    charged_wallet_account_id = v_account.id,
    payment_state = 'held', payment_amount = user_payable_amount,
    captured_amount = 0, status = 'in-progress',
    active_operation_id = v_operation.id,
    operation_kind = 'ticketing',
    operation_reason = 'imported_manual_ticketing',
    operation_request_id = p_request_key,
    operation_actor_user_id = p_actor_user_id,
    operation_started_at = v_now,
    operation_prior_status = 'on-hold'
  where id = v_booking.id;

  select count(*)::integer + 1 into v_occurrence
    from public.booking_status_events event
   where event.booking_id = v_booking.id
     and event.to_lifecycle_status = 'in-progress';
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, operation_id,
    reconciliation_case_id, occurrence_number, effective_at,
    observed_at, event_snapshot, event_version
  ) values (
    v_booking.id, 'on-hold', 'in-progress', 'on-hold', 'in-progress',
    'ticketing', 'imported_manual_ticketing', p_actor_user_id,
    case when v_on_behalf
      then 'ImportStaffIssueNow'
      else 'ImportCustomerIssueNow'
    end,
    jsonb_build_object(
      'walletHeld', true, 'walletCaptured', false,
      'supplierApiCalled', false, 'importSource', v_booking.import_source,
      'userPayableAmount', v_booking.user_payable_amount,
      'initiatedOnBehalf', v_on_behalf,
      'walletOwnerType', v_booking.booking_owner_type,
      'accountingContractVersion', 2
    ),
    p_request_key || ':in-progress', v_operation.id, v_case.id,
    v_occurrence, v_now, v_now,
    jsonb_build_object(
      'version', 2, 'bookingReference', v_booking.public_ref,
      'lifecycleStatus', 'in-progress', 'paymentState', 'held',
      'operationKind', 'imported_manual_ticketing',
      'operationSource', 'imported_manual_ticketing',
      'operationId', v_operation.id,
      'reconciliationCaseId', v_case.id,
      'userPayableAmount', v_booking.user_payable_amount,
      'currency', v_booking.currency, 'accountingContractVersion', 2
    ), 2
  ) returning id into v_event_id;

  insert into public.security_audit_events (
    actor_user_id, actor_role, action, target_type, target_id,
    outcome, metadata
  ) values (
    p_actor_user_id, v_actor_role, 'booking.imported.issue_now',
    'flight_booking', v_booking.id::text, 'succeeded',
    jsonb_build_object(
      'requestKey', p_request_key, 'importSource', v_booking.import_source,
      'walletEffect', 'hold', 'amount', v_booking.user_payable_amount,
      'currency', v_booking.currency, 'reservationId', v_reservation.id,
      'supplierApiCalled', false, 'initiatedOnBehalf', v_on_behalf,
      'walletOwnerType', v_booking.booking_owner_type
    )
  );

  return jsonb_build_object(
    'ok', true, 'replay', false, 'status', 'in-progress',
    'paymentState', 'held', 'operationId', v_operation.id,
    'reconciliationCaseId', v_case.id,
    'reservationId', v_reservation.id, 'accountId', v_account.id,
    'lifecycleEventId', v_event_id,
    'amount', v_booking.user_payable_amount,
    'currency', v_account.currency,
    'availableBalance', v_available_before - v_booking.user_payable_amount,
    'holdBalance', v_hold_before + v_booking.user_payable_amount
  );
end;
$$;

revoke all on function public.wallet_begin_imported_booking_issue_v2(
  uuid, text, text
) from public, anon, authenticated;
grant execute on function public.wallet_begin_imported_booking_issue_v2(
  uuid, text, text
) to service_role;

comment on function public.wallet_begin_imported_booking_issue_v2(
  uuid, text, text
) is
  'Atomically moves imported User Payable from the assigned owner wallet Available balance to Hold. The owner, Super Admin, Admin, or Support Staff may initiate it. It never calls a supplier API.';
