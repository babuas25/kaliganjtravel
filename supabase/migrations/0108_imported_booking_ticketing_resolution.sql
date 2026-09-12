-- Dedicated MANUAL / IMP_EXP owner Issue Now and staff resolution.
--
-- Imported On Hold creation remains non-financial. The owner later moves the
-- protected User Payable from Available to Hold without calling a supplier
-- API. Authorized operations staff then either capture that exact Hold with
-- complete ticket evidence or release it with a cancellation timestamp and
-- reason. Rows captured by the former Confirm & Pay behavior remain supported
-- without a second charge; their cancellation uses an explicit refund choice.
-- Ordinary Triplover Issue Now and the 0107 Super Admin resolver are untouched.

create table if not exists public.imported_ticketing_resolutions (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique
    references public.flight_bookings(id) on delete restrict,
  booking_reference text not null,
  request_key text not null unique
    check (char_length(request_key) between 1 and 220),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  import_source text not null check (import_source in ('IMP_EXP', 'MANUAL')),
  decision text not null check (decision in ('confirm_ticketed', 'cancel')),
  accounting_mode text not null check (
    accounting_mode in ('active_hold', 'legacy_captured')
  ),
  wallet_account_id uuid not null
    references public.wallet_accounts(id) on delete restrict,
  reservation_id uuid not null
    references public.wallet_reservations(id) on delete restrict,
  wallet_effect text not null check (
    wallet_effect in ('capture_hold', 'release_hold', 'refund', 'none')
  ),
  wallet_amount bigint not null check (wallet_amount >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  available_before bigint not null check (available_before >= 0),
  available_after bigint not null check (available_after >= 0),
  hold_before bigint not null check (hold_before >= 0),
  hold_after bigint not null check (hold_after >= 0),
  ticket_numbers jsonb not null default '[]'::jsonb
    check (jsonb_typeof(ticket_numbers) = 'array'),
  issued_at timestamptz,
  cancellation_at timestamptz,
  cancellation_reason text,
  refund_disposition text check (
    refund_disposition is null or refund_disposition in (
      'full_refund', 'partial_refund', 'no_refund_due', 'externally_settled'
    )
  ),
  refund_amount bigint not null default 0 check (refund_amount >= 0),
  external_settlement_reference text,
  actor_user_id text not null,
  actor_role text not null check (
    actor_role in ('staff_support', 'admin', 'superadmin')
  ),
  operation_id uuid references public.booking_operations(id) on delete restrict,
  reconciliation_case_id uuid
    references public.booking_reconciliation_cases(id) on delete restrict,
  ledger_entry_id uuid
    references public.wallet_ledger_entries(id) on delete restrict,
  lifecycle_event_id bigint
    references public.booking_status_events(id) on delete restrict,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  check (
    (decision = 'confirm_ticketed' and issued_at is not null
      and cancellation_at is null and cancellation_reason is null)
    or
    (decision = 'cancel' and issued_at is null
      and cancellation_at is not null
      and nullif(btrim(cancellation_reason), '') is not null)
  ),
  check (
    (wallet_effect = 'none' and wallet_amount = 0 and ledger_entry_id is null)
    or
    (wallet_effect <> 'none' and wallet_amount > 0 and ledger_entry_id is not null)
  ),
  check (
    refund_disposition <> 'externally_settled'
    or nullif(btrim(external_settlement_reference), '') is not null
  )
);

create index if not exists imported_ticketing_resolutions_created_idx
  on public.imported_ticketing_resolutions(created_at desc);

create or replace function public.prevent_imported_ticketing_resolution_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Imported ticketing resolution records are immutable'
    using errcode = '55000';
end;
$$;

drop trigger if exists imported_ticketing_resolutions_immutable
  on public.imported_ticketing_resolutions;
create trigger imported_ticketing_resolutions_immutable
  before update or delete on public.imported_ticketing_resolutions
  for each row execute function
    public.prevent_imported_ticketing_resolution_mutation_v1();

alter table public.imported_ticketing_resolutions enable row level security;
revoke all on table public.imported_ticketing_resolutions
  from public, anon, authenticated;
grant select on table public.imported_ticketing_resolutions
  to service_role;
revoke all on function public.prevent_imported_ticketing_resolution_mutation_v1()
  from public, anon, authenticated;

-- Owner command. This is intentionally not wallet_begin_booking_issue: no
-- supplier NewTicket request is made and supplier_call_started_at stays null.
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
  if not found or v_actor_role not in ('customer', 'b2b', 'b2b_sub') then
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
    'Owner placed User Payable on Hold; external ticketing outcome is required.',
    'imported-ticketing:v2:' || v_booking.id::text,
    encode(sha256(convert_to(jsonb_build_object(
      'version', 2, 'bookingId', v_booking.id,
      'ownerType', v_booking.booking_owner_type,
      'ownerKey', v_booking.booking_owner_key,
      'amount', v_booking.user_payable_amount,
      'currency', upper(v_booking.currency)
    )::text, 'UTF8')), 'hex'),
    p_actor_user_id, v_actor_role, 'customer', 'on-hold', 'on-hold',
    v_booking.supplier, 'ManualExternalTicketing',
    v_booking.supplier_refs->>'uniqueTransId', v_booking.booking_code_ref,
    v_booking.pnr,
    jsonb_build_object(
      'paymentHeld', true, 'paymentCaptured', false,
      'supplierApiCalled', false, 'clientRequestKey', p_request_key,
      'importSource', v_booking.import_source,
      'userPayableAmount', v_booking.user_payable_amount,
      'currency', v_booking.currency, 'externalActionDueAt', v_due_at,
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
      'supplierApiCalled', false, 'accountingContractVersion', 2
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
    'ImportCustomerIssueNow',
    jsonb_build_object(
      'walletHeld', true, 'walletCaptured', false,
      'supplierApiCalled', false, 'importSource', v_booking.import_source,
      'userPayableAmount', v_booking.user_payable_amount,
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
      'supplierApiCalled', false
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

-- Read-only staff context. The reservation and immutable ledger decide whether
-- this is a new active-Hold row or a legacy captured-before-ticketing row.
create or replace function public.imported_ticketing_resolution_context_v1(
  p_booking_id uuid,
  p_actor_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_reservation_count integer;
  v_hold_count integer;
  v_capture_count integer;
  v_refund_amount bigint;
  v_hold_net bigint;
  v_accounting_mode text;
begin
  select role into v_role from public.app_users where clerk_id = p_actor_user_id;
  if v_role is null or v_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_RESOLUTION_FORBIDDEN');
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
     and booking.import_source in ('IMP_EXP', 'MANUAL');
  if not found then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_NOT_FOUND');
  end if;
  if exists (
    select 1 from public.imported_ticketing_resolutions resolution
     where resolution.booking_id = v_booking.id
  ) or v_booking.status in ('confirmed', 'cancelled') then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_ALREADY_RESOLVED');
  end if;
  if v_booking.status <> 'in-progress'
     or v_booking.operation_reason not in (
       'imported_manual_ticketing', 'ticketing_reconciliation'
     ) then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_NOT_RESOLVABLE');
  end if;

  if v_booking.active_operation_id is not null then
    select operation.* into v_operation
      from public.booking_operations operation
     where operation.id = v_booking.active_operation_id
       and operation.booking_id = v_booking.id
       and operation.kind = 'imported_manual_ticketing'
       and operation.state in ('awaiting_external_action', 'needs_reconciliation');
  end if;
  if v_operation.id is null then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_OPERATION_NOT_FOUND');
  end if;
  select reconciliation_case.* into v_case
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.subject_booking_id = v_booking.id
     and reconciliation_case.operation_id = v_operation.id
     and reconciliation_case.case_type = 'imported_manual_ticketing'
     and reconciliation_case.state in (
       'open', 'assigned', 'awaiting_supplier', 'awaiting_finance',
       'awaiting_approval'
     )
   order by reconciliation_case.opened_at desc
   limit 1;
  if v_case.id is null then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_CASE_NOT_FOUND');
  end if;

  select count(*)::integer into v_reservation_count
    from public.wallet_reservations reservation
   where reservation.booking_id = v_booking.id;
  if v_reservation_count <> 1 then
    return jsonb_build_object('ok', false, 'code',
      case when v_reservation_count = 0 then 'IMPORTED_RESERVATION_NOT_FOUND'
        else 'IMPORTED_MULTIPLE_RESERVATIONS' end);
  end if;
  select reservation.* into v_reservation
    from public.wallet_reservations reservation
   where reservation.booking_id = v_booking.id;

  select count(*)::integer into v_hold_count
    from public.wallet_ledger_entries ledger
   where ledger.booking_id = v_booking.id
     and ledger.reservation_id = v_reservation.id
     and ledger.transaction_type = 'booking_hold';
  select count(*)::integer into v_capture_count
    from public.wallet_ledger_entries ledger
   where ledger.booking_id = v_booking.id
     and ledger.reservation_id = v_reservation.id
     and ledger.transaction_type = 'booking_confirm';
  select coalesce(sum(ledger.amount), 0)::bigint into v_refund_amount
    from public.wallet_ledger_entries ledger
   where ledger.booking_id = v_booking.id
     and ledger.transaction_type = 'refund';

  select wallet.* into v_wallet
    from public.wallet_accounts account
    join public.wallets wallet on wallet.id = account.wallet_id
   where account.id = v_reservation.wallet_account_id
     and wallet.owner_type = v_booking.booking_owner_type
     and wallet.owner_key = v_booking.booking_owner_key;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_OWNER_NOT_FOUND');
  end if;
  select account.* into v_account
    from public.wallet_accounts account
   where account.id = v_reservation.wallet_account_id
     and account.wallet_id = v_wallet.id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;

  if v_reservation.amount <> v_booking.user_payable_amount
     or v_reservation.currency <> upper(v_booking.currency)
     or v_account.currency <> v_reservation.currency
     or v_booking.charged_wallet_account_id is distinct from v_account.id then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_RESERVATION_ACCOUNT_CONFLICT');
  end if;

  if v_reservation.state in ('active', 'reconciliation') then
    select coalesce(sum(case
      when ledger.transaction_type = 'booking_hold' then ledger.amount
      when ledger.transaction_type = 'hold_release' then -ledger.amount
      when ledger.transaction_type = 'booking_confirm'
       and ledger.hold_before - ledger.hold_after = ledger.amount
        then -ledger.amount
      else 0 end), 0)::bigint into v_hold_net
      from public.wallet_ledger_entries ledger
     where ledger.reservation_id = v_reservation.id;
    if v_hold_count <> 1 or v_capture_count <> 0
       or v_hold_net <> v_reservation.amount
       or v_account.hold_balance < v_reservation.amount
       or v_booking.payment_state not in ('held', 'reconciliation')
       or v_booking.captured_amount <> 0
       or v_booking.refunded_amount <> 0 then
      return jsonb_build_object('ok', false, 'code', 'IMPORTED_ACTIVE_HOLD_CONFLICT');
    end if;
    v_accounting_mode := 'active_hold';
  elsif v_reservation.state = 'captured' then
    if v_capture_count <> 1
       or v_booking.payment_state not in (
         'captured', 'partially-refunded', 'refunded'
       )
       or v_booking.captured_amount <> v_reservation.amount
       or v_booking.refunded_amount <> v_refund_amount
       or v_refund_amount > v_booking.captured_amount then
      return jsonb_build_object('ok', false, 'code', 'IMPORTED_LEGACY_CAPTURE_CONFLICT');
    end if;
    v_accounting_mode := 'legacy_captured';
  else
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_RESERVATION_STATE_CONFLICT');
  end if;

  return jsonb_build_object(
    'ok', true, 'bookingId', v_booking.id,
    'bookingReference', v_booking.public_ref,
    'importSource', v_booking.import_source,
    'status', v_booking.status, 'paymentState', v_booking.payment_state,
    'accountingMode', v_accounting_mode,
    'operationId', v_operation.id, 'operationState', v_operation.state,
    'reconciliationCaseId', v_case.id, 'caseState', v_case.state,
    'reservationId', v_reservation.id,
    'reservationState', v_reservation.state,
    'walletId', v_wallet.id, 'walletAccountId', v_account.id,
    'walletStatus', v_wallet.status,
    'walletOwnerType', v_wallet.owner_type,
    'walletOwnerKey', v_wallet.owner_key,
    'currency', v_account.currency,
    'userPayableAmount', v_booking.user_payable_amount,
    'capturedAmount', v_booking.captured_amount,
    'refundedAmount', v_booking.refunded_amount,
    'outstandingAmount', v_booking.captured_amount - v_booking.refunded_amount,
    'availableBefore', v_account.available_balance,
    'holdBefore', v_account.hold_balance,
    'confirmEffect', case when v_accounting_mode = 'active_hold'
      then 'capture_hold' else 'none' end,
    'confirmAmount', case when v_accounting_mode = 'active_hold'
      then v_reservation.amount else 0 end,
    'confirmAvailableAfter', v_account.available_balance,
    'confirmHoldAfter', case when v_accounting_mode = 'active_hold'
      then v_account.hold_balance - v_reservation.amount
      else v_account.hold_balance end,
    'cancelEffect', case when v_accounting_mode = 'active_hold'
      then 'release_hold' else 'refund_decision_required' end,
    'cancelAmount', case when v_accounting_mode = 'active_hold'
      then v_reservation.amount else v_booking.captured_amount - v_booking.refunded_amount end,
    'cancelAvailableAfter', case when v_accounting_mode = 'active_hold'
      then v_account.available_balance + v_reservation.amount
      else null end,
    'cancelHoldAfter', case when v_accounting_mode = 'active_hold'
      then v_account.hold_balance - v_reservation.amount
      else v_account.hold_balance end
  );
end;
$$;

create or replace function public.resolve_imported_booking_ticketing_v1(
  p_booking_id uuid,
  p_actor_user_id text,
  p_decision text,
  p_data jsonb,
  p_request_key text,
  p_money_effect_confirmed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_booking public.flight_bookings;
  v_existing public.imported_ticketing_resolutions;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_reservation public.wallet_reservations;
  v_wallet_id uuid;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_context jsonb;
  v_request_hash text;
  v_accounting_mode text;
  v_ticket_numbers jsonb := '[]'::jsonb;
  v_traveller_count integer;
  v_issued_at timestamptz;
  v_cancellation_at timestamptz;
  v_cancellation_reason text;
  v_refund_disposition text;
  v_requested_refund bigint;
  v_external_reference text;
  v_refund_amount bigint := 0;
  v_wallet_effect text := 'none';
  v_wallet_amount bigint := 0;
  v_available_before bigint;
  v_available_after bigint;
  v_hold_before bigint;
  v_hold_after bigint;
  v_ledger_id uuid;
  v_event_id bigint;
  v_resolution_id uuid := gen_random_uuid();
  v_occurrence integer;
  v_to_status text;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_booking_id is null
     or p_decision not in ('confirm_ticketed', 'cancel')
     or p_data is null or jsonb_typeof(p_data) <> 'object'
     or p_request_key !~ '^imported-resolution:v1:[0-9a-f-]{36}$'
     or p_money_effect_confirmed is not true then
    return jsonb_build_object('ok', false, 'code',
      case when p_money_effect_confirmed is not true
        then 'IMPORTED_EFFECT_CONFIRMATION_REQUIRED'
        else 'INVALID_IMPORTED_RESOLUTION_REQUEST' end);
  end if;
  select role into v_role from public.app_users where clerk_id = p_actor_user_id;
  if v_role is null or v_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_RESOLUTION_FORBIDDEN');
  end if;

  v_request_hash := encode(sha256(convert_to(jsonb_build_object(
    'bookingId', p_booking_id, 'decision', p_decision, 'data', p_data
  )::text, 'UTF8')), 'hex');

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
     and booking.import_source in ('IMP_EXP', 'MANUAL')
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_NOT_FOUND');
  end if;
  select resolution.* into v_existing
    from public.imported_ticketing_resolutions resolution
   where resolution.request_key = p_request_key;
  if found then
    if v_existing.booking_id <> v_booking.id
       or v_existing.actor_user_id <> p_actor_user_id
       or v_existing.request_hash <> v_request_hash then
      return jsonb_build_object('ok', false, 'code', 'IMPORTED_RESOLUTION_IDEMPOTENCY_CONFLICT');
    end if;
    return v_existing.result || jsonb_build_object('ok', true, 'replay', true);
  end if;
  if v_booking.status in ('confirmed', 'cancelled')
     or exists (select 1 from public.imported_ticketing_resolutions resolution
       where resolution.booking_id = v_booking.id) then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_ALREADY_RESOLVED');
  end if;

  if v_booking.active_operation_id is not null then
    select operation.* into v_operation
      from public.booking_operations operation
     where operation.id = v_booking.active_operation_id
     for update;
  end if;
  if v_operation.id is not null then
    select reconciliation_case.* into v_case
      from public.booking_reconciliation_cases reconciliation_case
     where reconciliation_case.subject_booking_id = v_booking.id
       and reconciliation_case.operation_id = v_operation.id
       and reconciliation_case.case_type = 'imported_manual_ticketing'
       and reconciliation_case.state in (
         'open', 'assigned', 'awaiting_supplier', 'awaiting_finance',
         'awaiting_approval'
       )
     order by reconciliation_case.opened_at desc
     limit 1
     for update;
  end if;
  select reservation.* into v_reservation
    from public.wallet_reservations reservation
   where reservation.booking_id = v_booking.id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_RESERVATION_NOT_FOUND');
  end if;
  select account.wallet_id into v_wallet_id
    from public.wallet_accounts account
   where account.id = v_reservation.wallet_account_id;
  select wallet.* into v_wallet
    from public.wallets wallet
   where wallet.id = v_wallet_id
   for update;
  select account.* into v_account
    from public.wallet_accounts account
   where account.id = v_reservation.wallet_account_id
     and account.wallet_id = v_wallet.id
   for update;

  v_context := public.imported_ticketing_resolution_context_v1(
    v_booking.id, p_actor_user_id
  );
  if coalesce((v_context->>'ok')::boolean, false) is not true then
    return v_context;
  end if;
  if (v_context->>'availableBefore')::bigint <> v_account.available_balance
     or (v_context->>'holdBefore')::bigint <> v_account.hold_balance
     or (v_context->>'reservationId')::uuid <> v_reservation.id then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_ACCOUNTING_STATE_CHANGED');
  end if;
  v_accounting_mode := v_context->>'accountingMode';

  if p_decision = 'confirm_ticketed' then
    begin
      v_issued_at := nullif(p_data->>'issuedAt', '')::timestamptz;
    exception when others then
      v_issued_at := null;
    end;
    v_ticket_numbers := coalesce(p_data->'ticketNumbers', '[]'::jsonb);
    v_traveller_count := case
      when jsonb_typeof(v_booking.passengers->'travellers') = 'array'
        then jsonb_array_length(v_booking.passengers->'travellers')
      else 0 end;
    if v_issued_at is null or v_issued_at > v_now
       or v_traveller_count <= 0
       or jsonb_typeof(v_ticket_numbers) <> 'array'
       or jsonb_array_length(v_ticket_numbers) <> v_traveller_count
       or exists (
         select 1 from jsonb_array_elements(v_ticket_numbers) ticket(value)
          where jsonb_typeof(ticket.value) <> 'string'
             or nullif(btrim(ticket.value #>> '{}'), '') is null
       )
       or (select count(distinct upper(ticket.value #>> '{}'))
             from jsonb_array_elements(v_ticket_numbers) ticket(value))
          <> v_traveller_count then
      return jsonb_build_object('ok', false, 'code', 'IMPORTED_TICKET_EVIDENCE_REQUIRED');
    end if;
    v_to_status := 'confirmed';
  else
    begin
      v_cancellation_at := nullif(p_data->>'cancellationAt', '')::timestamptz;
    exception when others then
      v_cancellation_at := null;
    end;
    v_cancellation_reason := nullif(btrim(p_data->>'cancellationReason'), '');
    v_refund_disposition := nullif(btrim(p_data->>'refundDisposition'), '');
    v_external_reference := nullif(btrim(p_data->>'externalSettlementReference'), '');
    begin
      v_requested_refund := nullif(p_data->>'refundAmount', '')::bigint;
    exception when others then
      v_requested_refund := null;
    end;
    if v_cancellation_at is null
       or v_cancellation_at > v_now
       or v_cancellation_reason is null then
      return jsonb_build_object('ok', false, 'code', 'IMPORTED_CANCELLATION_DETAILS_REQUIRED');
    end if;
    if v_accounting_mode = 'active_hold' then
      if v_refund_disposition is not null
         and v_refund_disposition <> 'release_existing_hold' then
        return jsonb_build_object('ok', false, 'code', 'IMPORTED_REFUND_NOT_ALLOWED_FOR_HOLD');
      end if;
      v_refund_disposition := null;
    else
      if v_refund_disposition not in (
        'full_refund', 'partial_refund', 'no_refund_due', 'externally_settled'
      ) then
        return jsonb_build_object('ok', false, 'code', 'IMPORTED_REFUND_DECISION_REQUIRED');
      end if;
      if v_refund_disposition = 'full_refund' then
        v_refund_amount := (v_context->>'outstandingAmount')::bigint;
        if v_refund_amount <= 0 then
          return jsonb_build_object('ok', false, 'code', 'IMPORTED_NOTHING_TO_REFUND');
        end if;
      elsif v_refund_disposition = 'partial_refund' then
        v_refund_amount := coalesce(v_requested_refund, 0);
        if v_refund_amount <= 0
           or v_refund_amount >= (v_context->>'outstandingAmount')::bigint then
          return jsonb_build_object('ok', false, 'code', 'IMPORTED_PARTIAL_REFUND_INVALID');
        end if;
      elsif v_refund_disposition = 'externally_settled'
         and v_external_reference is null then
        return jsonb_build_object('ok', false, 'code', 'IMPORTED_EXTERNAL_REFERENCE_REQUIRED');
      end if;
    end if;
    v_to_status := 'cancelled';
  end if;

  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  v_available_after := v_available_before;
  v_hold_after := v_hold_before;

  if v_accounting_mode = 'active_hold' then
    if v_account.hold_balance < v_reservation.amount then
      return jsonb_build_object('ok', false, 'code', 'IMPORTED_HOLD_BALANCE_MISMATCH');
    end if;
    v_wallet_amount := v_reservation.amount;
    v_hold_after := v_hold_before - v_wallet_amount;
    if p_decision = 'confirm_ticketed' then
      v_wallet_effect := 'capture_hold';
      update public.wallet_accounts set hold_balance = v_hold_after
       where id = v_account.id;
      update public.wallet_reservations set
        state = 'captured', issued_by_user_id = p_actor_user_id,
        captured_at = v_now, reconciliation_at = null,
        reconciliation_reason = null
      where id = v_reservation.id
        and state in ('active', 'reconciliation');
      insert into public.wallet_ledger_entries (
        wallet_account_id, transaction_type, amount, currency,
        available_before, available_after, hold_before, hold_after,
        booking_id, booking_reference, reservation_id, idempotency_key,
        created_by_user_id, created_by_role, remarks, metadata
      ) values (
        v_account.id, 'booking_confirm', v_wallet_amount, v_account.currency,
        v_available_before, v_available_after, v_hold_before, v_hold_after,
        v_booking.id, v_booking.public_ref, v_reservation.id,
        p_request_key || ':ledger', p_actor_user_id, v_role,
        'Imported ticketing Hold captured after verified issuance',
        jsonb_build_object(
          'importSource', v_booking.import_source,
          'supplierGrossAmount', v_booking.supplier_gross_amount,
          'userPayableAmount', v_booking.user_payable_amount,
          'resolutionId', v_resolution_id,
          'accountingContractVersion', 2
        )
      ) returning id into v_ledger_id;
    else
      v_wallet_effect := 'release_hold';
      v_available_after := v_available_before + v_wallet_amount;
      update public.wallet_accounts set
        available_balance = v_available_after, hold_balance = v_hold_after
      where id = v_account.id;
      update public.wallet_reservations set
        state = 'released', released_at = v_now,
        release_reason = left(v_cancellation_reason, 1000),
        reconciliation_at = null, reconciliation_reason = null
      where id = v_reservation.id
        and state in ('active', 'reconciliation');
      insert into public.wallet_ledger_entries (
        wallet_account_id, transaction_type, amount, currency,
        available_before, available_after, hold_before, hold_after,
        booking_id, booking_reference, reservation_id, idempotency_key,
        created_by_user_id, created_by_role, remarks, metadata
      ) values (
        v_account.id, 'hold_release', v_wallet_amount, v_account.currency,
        v_available_before, v_available_after, v_hold_before, v_hold_after,
        v_booking.id, v_booking.public_ref, v_reservation.id,
        p_request_key || ':ledger', p_actor_user_id, v_role,
        left(v_cancellation_reason, 1000),
        jsonb_build_object(
          'importSource', v_booking.import_source,
          'userPayableAmount', v_booking.user_payable_amount,
          'resolutionId', v_resolution_id,
          'accountingContractVersion', 2
        )
      ) returning id into v_ledger_id;
    end if;
  elsif p_decision = 'cancel' and v_refund_amount > 0 then
    v_wallet_effect := 'refund';
    v_wallet_amount := v_refund_amount;
    v_available_after := v_available_before + v_refund_amount;
    update public.wallet_accounts set available_balance = v_available_after
     where id = v_account.id;
    insert into public.wallet_ledger_entries (
      wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after,
      booking_id, booking_reference, reservation_id, idempotency_key,
      created_by_user_id, created_by_role, remarks, metadata
    ) values (
      v_account.id, 'refund', v_refund_amount, v_account.currency,
      v_available_before, v_available_after, v_hold_before, v_hold_after,
      v_booking.id, v_booking.public_ref, v_reservation.id,
      p_request_key || ':ledger', p_actor_user_id, v_role,
      left(v_cancellation_reason, 1000),
      jsonb_build_object(
        'importSource', v_booking.import_source,
        'resolutionId', v_resolution_id,
        'refundDisposition', v_refund_disposition,
        'legacyCapturedBeforeTicketing', true
      )
    ) returning id into v_ledger_id;
  end if;

  update public.booking_operations set
    state = 'succeeded', completed_at = v_now,
    reason_detail = case when p_decision = 'confirm_ticketed'
      then 'Imported ticket issuance verified and wallet settlement completed.'
      else 'Imported non-issuance verified and wallet disposition completed.' end,
    supplier_evidence = coalesce(supplier_evidence, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'importedResolutionId', v_resolution_id,
        'decision', p_decision, 'ticketNumbers', v_ticket_numbers,
        'issuedAt', v_issued_at, 'cancellationAt', v_cancellation_at,
        'cancellationReason', v_cancellation_reason,
        'refundDisposition', v_refund_disposition,
        'externalSettlementReference', v_external_reference,
        'walletEffect', v_wallet_effect, 'walletAmount', v_wallet_amount,
        'resolvedAt', v_now
      ))
  where id = v_operation.id;

  update public.booking_reconciliation_cases set
    state = 'resolved',
    financial_disposition = case
      when v_accounting_mode = 'active_hold' and p_decision = 'confirm_ticketed'
        then 'capture_existing_hold'
      when v_accounting_mode = 'active_hold' and p_decision = 'cancel'
        then 'release_existing_hold'
      when p_decision = 'cancel' then v_refund_disposition
      else 'none' end,
    financial_amount = case
      when v_wallet_effect in ('capture_hold', 'release_hold', 'refund')
        then v_wallet_amount else null end,
    financial_currency = case
      when v_wallet_effect in ('capture_hold', 'release_hold', 'refund')
        then v_account.currency else null end,
    external_settlement_reference = v_external_reference,
    resolution_outcome = case when p_decision = 'confirm_ticketed'
      then 'imported_ticketed' else 'imported_cancelled' end,
    resolution = jsonb_strip_nulls(jsonb_build_object(
      'version', 2, 'resolutionKind', 'imported_ticketing_resolution',
      'resolutionId', v_resolution_id, 'requestKey', p_request_key,
      'decision', p_decision, 'accountingMode', v_accounting_mode,
      'walletEffect', v_wallet_effect, 'walletAmount', v_wallet_amount,
      'ledgerEntryId', v_ledger_id, 'ticketNumbers', v_ticket_numbers,
      'issuedAt', v_issued_at, 'cancellationAt', v_cancellation_at,
      'cancellationReason', v_cancellation_reason,
      'refundDisposition', v_refund_disposition,
      'externalSettlementReference', v_external_reference
    )),
    resolution_reason = coalesce(v_cancellation_reason,
      'Imported ticket issuance verified'),
    resolved_by_user_id = p_actor_user_id,
    resolved_at = v_now, closed_at = v_now, version = version + 1
  where id = v_case.id;

  update public.flight_bookings set
    status = v_to_status,
    payment_state = case
      when v_accounting_mode = 'active_hold' and p_decision = 'confirm_ticketed'
        then 'captured'
      when v_accounting_mode = 'active_hold' and p_decision = 'cancel'
        then 'released'
      when p_decision = 'cancel'
       and refunded_amount + v_refund_amount = captured_amount
       and captured_amount > 0 then 'refunded'
      when p_decision = 'cancel' and v_refund_amount > 0
        then 'partially-refunded'
      else payment_state end,
    captured_amount = case
      when v_accounting_mode = 'active_hold' and p_decision = 'confirm_ticketed'
        then v_reservation.amount
      else captured_amount end,
    refunded_amount = refunded_amount + v_refund_amount,
    direct_ticketing = case when p_decision = 'confirm_ticketed'
      then true else direct_ticketing end,
    ticket_numbers = case when p_decision = 'confirm_ticketed'
      then v_ticket_numbers else ticket_numbers end,
    issued_at = case when p_decision = 'confirm_ticketed'
      then v_issued_at else issued_at end,
    issued_by_user_id = case when p_decision = 'confirm_ticketed'
      then p_actor_user_id else issued_by_user_id end,
    booking_status = case when p_decision = 'confirm_ticketed'
      then 'Confirmed' else booking_status end,
    cancelled_at = case when p_decision = 'cancel'
      then v_cancellation_at else cancelled_at end,
    cancelled_by = case when p_decision = 'cancel'
      then p_actor_user_id else cancelled_by end,
    cancel_reason = case when p_decision = 'cancel'
      then left(v_cancellation_reason, 1000) else cancel_reason end,
    active_operation_id = null, operation_kind = null,
    operation_reason = null, operation_request_id = null,
    operation_actor_user_id = null, operation_started_at = null,
    operation_prior_status = null
  where id = v_booking.id;

  select count(*)::integer + 1 into v_occurrence
    from public.booking_status_events event
   where event.booking_id = v_booking.id
     and event.to_lifecycle_status = v_to_status;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, operation_id,
    reconciliation_case_id, occurrence_number, effective_at,
    observed_at, event_snapshot, event_version
  ) values (
    v_booking.id, 'in-progress', v_to_status,
    'in-progress', v_to_status, 'ticketing',
    'imported_manual_ticketing', p_actor_user_id,
    'ImportedTicketingResolution',
    jsonb_strip_nulls(jsonb_build_object(
      'resolutionId', v_resolution_id, 'decision', p_decision,
      'accountingMode', v_accounting_mode,
      'walletEffect', v_wallet_effect, 'walletAmount', v_wallet_amount,
      'ticketNumbers', v_ticket_numbers, 'issuedAt', v_issued_at,
      'cancellationAt', v_cancellation_at,
      'refundDisposition', v_refund_disposition
    )),
    p_request_key || ':status', v_operation.id, v_case.id,
    v_occurrence, coalesce(v_issued_at, v_cancellation_at, v_now), v_now,
    jsonb_strip_nulls(jsonb_build_object(
      'version', 2, 'bookingReference', v_booking.public_ref,
      'lifecycleStatus', v_to_status,
      'paymentState', case
        when v_accounting_mode = 'active_hold' and p_decision = 'confirm_ticketed'
          then 'captured'
        when v_accounting_mode = 'active_hold' and p_decision = 'cancel'
          then 'released'
        when v_refund_amount > 0 then 'refunded_or_partial'
        else v_booking.payment_state end,
      'operationSource', 'imported_ticketing_resolution',
      'accountingMode', v_accounting_mode,
      'walletEffect', v_wallet_effect, 'walletAmount', v_wallet_amount,
      'currency', v_account.currency, 'resolutionId', v_resolution_id
    )), 2
  ) returning id into v_event_id;

  v_result := jsonb_build_object(
    'ok', true, 'replay', false, 'resolutionId', v_resolution_id,
    'bookingId', v_booking.id, 'bookingReference', v_booking.public_ref,
    'status', v_to_status, 'decision', p_decision,
    'accountingMode', v_accounting_mode,
    'walletEffect', v_wallet_effect, 'walletAmount', v_wallet_amount,
    'currency', v_account.currency,
    'availableBefore', v_available_before,
    'availableAfter', v_available_after,
    'holdBefore', v_hold_before, 'holdAfter', v_hold_after,
    'ledgerEntryId', v_ledger_id, 'lifecycleEventId', v_event_id,
    'reservationId', v_reservation.id,
    'reconciliationCaseId', v_case.id
  );

  insert into public.imported_ticketing_resolutions (
    id, booking_id, booking_reference, request_key, request_hash,
    import_source, decision, accounting_mode, wallet_account_id,
    reservation_id, wallet_effect, wallet_amount, currency,
    available_before, available_after, hold_before, hold_after,
    ticket_numbers, issued_at, cancellation_at, cancellation_reason,
    refund_disposition, refund_amount, external_settlement_reference,
    actor_user_id, actor_role, operation_id, reconciliation_case_id,
    ledger_entry_id, lifecycle_event_id, result
  ) values (
    v_resolution_id, v_booking.id, v_booking.public_ref,
    p_request_key, v_request_hash, v_booking.import_source,
    p_decision, v_accounting_mode, v_account.id, v_reservation.id,
    v_wallet_effect, v_wallet_amount, v_account.currency,
    v_available_before, v_available_after, v_hold_before, v_hold_after,
    v_ticket_numbers, v_issued_at, v_cancellation_at,
    v_cancellation_reason, v_refund_disposition, v_refund_amount,
    v_external_reference, p_actor_user_id, v_role, v_operation.id,
    v_case.id, v_ledger_id, v_event_id, v_result
  );

  insert into public.security_audit_events (
    actor_user_id, actor_role, action, target_type, target_id,
    outcome, metadata
  ) values (
    p_actor_user_id, v_role, 'booking.imported.ticketing_resolution',
    'flight_booking', v_booking.id::text, 'succeeded',
    jsonb_build_object(
      'requestKey', p_request_key, 'resolutionId', v_resolution_id,
      'importSource', v_booking.import_source, 'decision', p_decision,
      'accountingMode', v_accounting_mode,
      'walletEffect', v_wallet_effect, 'walletAmount', v_wallet_amount,
      'currency', v_account.currency
    )
  );
  return v_result;
end;
$$;

-- Compatibility signature used by the existing application boundary. Its
-- meaning is now imported Issue Now (Hold), not pre-ticketing capture.
create or replace function public.wallet_confirm_impexp_booking(
  p_booking_id uuid,
  p_actor_user_id text,
  p_idempotency_key text
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.wallet_begin_imported_booking_issue_v2(
    p_booking_id,
    p_actor_user_id,
    'imported-issue:v2:' || p_idempotency_key
  )
$$;

-- The pre-0108 manual status command could confirm directly from On Hold and
-- debit Available without the owner Issue Now Hold. Preserve its non-financial
-- status commands behind a wrapper, but make imported confirmation exclusive
-- to the dedicated resolver above.
alter function public.update_manual_booking_status_v1(
  uuid, text, text, jsonb, text
) rename to update_manual_booking_status_legacy_0108;

revoke all on function public.update_manual_booking_status_legacy_0108(
  uuid, text, text, jsonb, text
) from public, anon, authenticated, service_role;

create function public.update_manual_booking_status_v1(
  p_booking_id uuid,
  p_actor_user_id text,
  p_target_status text,
  p_data jsonb,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_target_status = 'confirmed' then
    return jsonb_build_object(
      'ok', false,
      'code', 'IMPORTED_TICKETING_RESOLUTION_REQUIRED'
    );
  end if;
  return public.update_manual_booking_status_legacy_0108(
    p_booking_id,
    p_actor_user_id,
    p_target_status,
    p_data,
    p_request_key
  );
end;
$$;

revoke all on function public.wallet_begin_imported_booking_issue_v2(
  uuid, text, text
) from public, anon, authenticated;
revoke all on function public.imported_ticketing_resolution_context_v1(
  uuid, text
) from public, anon, authenticated;
revoke all on function public.resolve_imported_booking_ticketing_v1(
  uuid, text, text, jsonb, text, boolean
) from public, anon, authenticated;
revoke all on function public.wallet_confirm_impexp_booking(
  uuid, text, text
) from public, anon, authenticated;
revoke all on function public.update_manual_booking_status_v1(
  uuid, text, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.wallet_begin_imported_booking_issue_v2(
  uuid, text, text
) to service_role;
grant execute on function public.imported_ticketing_resolution_context_v1(
  uuid, text
) to service_role;
grant execute on function public.resolve_imported_booking_ticketing_v1(
  uuid, text, text, jsonb, text, boolean
) to service_role;
grant execute on function public.wallet_confirm_impexp_booking(
  uuid, text, text
) to service_role;
grant execute on function public.update_manual_booking_status_v1(
  uuid, text, text, jsonb, text
) to service_role;

comment on function public.wallet_begin_imported_booking_issue_v2(
  uuid, text, text
) is
  'Atomically moves imported User Payable from Available to an active Hold and opens imported external ticketing; it never calls a supplier API.';
comment on function public.resolve_imported_booking_ticketing_v1(
  uuid, text, text, jsonb, text, boolean
) is
  'Atomically captures/releases a new imported Hold or safely handles a legacy pre-ticketing capture with required ticket/cancellation evidence and idempotent audit history.';
