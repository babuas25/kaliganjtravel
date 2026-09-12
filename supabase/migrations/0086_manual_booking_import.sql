-- Manual Booking Import is a source on the canonical booking lifecycle.  It
-- never represents a supplier API booking and deliberately writes the same
-- booking, wallet, lifecycle-event, notification-outbox, and reporting rows.

alter table public.flight_bookings
  drop constraint if exists flight_bookings_import_source_check;
alter table public.flight_bookings
  add constraint flight_bookings_import_source_check
  check (import_source is null or import_source in ('IMP_EXP', 'MANUAL'));

create unique index if not exists flight_bookings_manual_reference_key
  on public.flight_bookings (booking_ref_number)
  where import_source = 'MANUAL' and booking_ref_number is not null;
create index if not exists flight_bookings_manual_created_idx
  on public.flight_bookings (created_at desc)
  where import_source = 'MANUAL';

-- A source command can suppress the generic insert event only while it builds
-- a richer, actor-attributed lifecycle event in the same transaction.
create or replace function public.record_initial_booking_status_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not new.legacy_operational
     and coalesce(current_setting('app.skip_initial_booking_status_event', true), '') <> 'true' then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, supplier_operation, supplier_evidence,
      idempotency_key, created_at
    ) values (
      new.id, null,
      public.resolve_booking_lifecycle(
        new.status, new.airlines_pnr, new.ticketing_deadline_at, new.operation_kind
      ),
      null, new.status, new.operation_kind, new.operation_reason, 'Book',
      jsonb_build_object('bookingStatus', new.booking_status,
        'airlinesPnr', new.airlines_pnr),
      'booking-created', new.created_at
    ) on conflict do nothing;
  end if;
  return new;
end;
$$;

-- Request records make a browser retry return the original result rather than
-- creating a second booking or a second wallet debit.  They are audit records,
-- not a separate booking model.
create table if not exists public.manual_booking_actions (
  id             uuid primary key default gen_random_uuid(),
  request_key    text not null unique,
  booking_id     uuid references public.flight_bookings (id) on delete restrict,
  action         text not null check (action in ('import', 'status_change')),
  actor_user_id  text not null,
  actor_role     text not null,
  payload_hash   text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  result         jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at     timestamptz not null default clock_timestamp()
);
alter table public.manual_booking_actions enable row level security;
revoke all on table public.manual_booking_actions from public, anon, authenticated;
grant select, insert on table public.manual_booking_actions to service_role;

-- Manual commercial truth follows the same protected User Payable rules as
-- IMP/EXP, while remaining independent from supplier-sync pricing.
alter table public.flight_bookings
  add constraint flight_bookings_manual_pricing_truth_check
  check (
    import_source is distinct from 'MANUAL'
    or (
      user_payable_amount is not null and user_payable_amount > 0
      and supplier_gross_amount is not null and supplier_gross_amount >= 0
      and public.impexp_pricing_minor_amount_v1(pricing_snapshot, 'sellingPrice') = user_payable_amount
      and public.impexp_pricing_minor_amount_v1(pricing_snapshot, 'supplierTotalPrice') = supplier_gross_amount
      and public.impexp_pricing_minor_amount_v1(pricing_snapshot, 'grossPrice') = supplier_gross_amount
      and (payment_amount is null or payment_amount = user_payable_amount)
      and captured_amount in (0, user_payable_amount)
      and refunded_amount between 0 and captured_amount
    )
  ) not valid;

alter table public.flight_bookings
  add constraint flight_bookings_manual_on_hold_unpaid_check
  check (
    import_source is distinct from 'MANUAL'
    or status <> 'on-hold'
    or (
      payment_state = 'unpaid' and charged_wallet_account_id is null
      and captured_amount = 0 and refunded_amount = 0
    )
  ) not valid;

create or replace function public.enforce_manual_booking_invariants_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.import_source = 'MANUAL' then
    if new.import_source is distinct from old.import_source then
      raise exception 'manual booking source is immutable'
        using errcode = '23514', constraint = 'flight_bookings_manual_source_immutable';
    end if;
    if new.user_payable_amount is distinct from old.user_payable_amount
       or new.currency is distinct from old.currency then
      raise exception 'manual User Payable and currency are immutable'
        using errcode = '23514', constraint = 'flight_bookings_manual_payable_immutable';
    end if;
  end if;
  if new.import_source is distinct from 'MANUAL' then return new; end if;
  if new.user_payable_amount is null or new.user_payable_amount <= 0
     or new.supplier_gross_amount is null or new.supplier_gross_amount < 0
     or public.impexp_pricing_minor_amount_v1(new.pricing_snapshot, 'sellingPrice') is distinct from new.user_payable_amount
     or public.impexp_pricing_minor_amount_v1(new.pricing_snapshot, 'supplierTotalPrice') is distinct from new.supplier_gross_amount
     or public.impexp_pricing_minor_amount_v1(new.pricing_snapshot, 'grossPrice') is distinct from new.supplier_gross_amount
     or (new.payment_amount is not null and new.payment_amount is distinct from new.user_payable_amount)
     or new.captured_amount not in (0, new.user_payable_amount)
     or new.refunded_amount < 0 or new.refunded_amount > new.captured_amount then
    raise exception 'manual Supplier Gross/User Payable invariant failed'
      using errcode = '23514', constraint = 'flight_bookings_manual_pricing_truth_check';
  end if;
  return new;
end;
$$;

drop trigger if exists flight_bookings_enforce_manual_invariants on public.flight_bookings;
create trigger flight_bookings_enforce_manual_invariants
before insert or update of import_source, currency, pricing_snapshot,
  supplier_gross_amount, user_payable_amount, payment_state, payment_amount,
  captured_amount, refunded_amount
on public.flight_bookings
for each row execute function public.enforce_manual_booking_invariants_v1();

create or replace function public.enforce_manual_reservation_amount_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_booking public.flight_bookings;
begin
  if new.booking_id is null then return new; end if;
  select * into v_booking from public.flight_bookings where id = new.booking_id;
  if found and v_booking.import_source = 'MANUAL'
     and (new.amount is distinct from v_booking.user_payable_amount
       or upper(new.currency) is distinct from upper(v_booking.currency)) then
    raise exception 'manual reservation must equal protected User Payable'
      using errcode = '23514', constraint = 'wallet_reservations_manual_user_payable_check';
  end if;
  return new;
end;
$$;
drop trigger if exists wallet_reservations_enforce_manual_amount on public.wallet_reservations;
create trigger wallet_reservations_enforce_manual_amount
before insert or update of booking_id, amount, currency on public.wallet_reservations
for each row execute function public.enforce_manual_reservation_amount_v1();

create or replace function public.enforce_manual_capture_ledger_amount_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_booking public.flight_bookings;
begin
  if new.booking_id is null or new.transaction_type <> 'booking_confirm' then return new; end if;
  select * into v_booking from public.flight_bookings where id = new.booking_id;
  if found and v_booking.import_source = 'MANUAL'
     and (new.amount is distinct from v_booking.user_payable_amount
       or upper(new.currency) is distinct from upper(v_booking.currency)
       or new.metadata->>'userPayableAmount' is distinct from v_booking.user_payable_amount::text
       or new.metadata->>'supplierGrossAmount' is distinct from v_booking.supplier_gross_amount::text) then
    raise exception 'manual capture ledger must equal protected User Payable'
      using errcode = '23514', constraint = 'wallet_ledger_entries_manual_user_payable_check';
  end if;
  return new;
end;
$$;
drop trigger if exists wallet_ledger_enforce_manual_capture_amount on public.wallet_ledger_entries;
create trigger wallet_ledger_enforce_manual_capture_amount
before insert on public.wallet_ledger_entries
for each row execute function public.enforce_manual_capture_ledger_amount_v1();

-- Extend the owner Confirm & Pay command, without changing the existing
-- supplier-import semantics.  The command still creates no supplier write.
create or replace function public.wallet_confirm_impexp_booking(
  p_booking_id uuid, p_actor_user_id text, p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings; v_actor_role text; v_actor_agency text;
  v_existing_operation public.booking_operations; v_existing_case public.booking_reconciliation_cases;
  v_existing_reservation public.wallet_reservations; v_wallet public.wallets;
  v_account public.wallet_accounts; v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases; v_reservation public.wallet_reservations;
  v_available_before bigint; v_hold_before bigint; v_ledger_key text;
  v_operation_request_key text; v_payload_hash text; v_now timestamptz := clock_timestamp();
  v_due_at timestamptz; v_event_id bigint; v_occurrence_number integer;
begin
  if p_booking_id is null or nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_idempotency_key), '') is null or char_length(p_idempotency_key) > 220 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CONFIRM_REQUEST');
  end if;
  select role, agency_code into v_actor_role, v_actor_agency from public.app_users where clerk_id = p_actor_user_id;
  if not found or v_actor_role not in ('customer', 'b2b', 'b2b_sub') then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_CONFIRM_FORBIDDEN');
  end if;
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and import_source in ('IMP_EXP', 'MANUAL') for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_NOT_FOUND'); end if;
  if not ((v_actor_role = 'customer' and v_booking.booking_owner_type = 'user' and v_booking.booking_owner_key = p_actor_user_id)
    or (v_actor_role in ('b2b', 'b2b_sub') and nullif(btrim(v_actor_agency), '') is not null
      and v_booking.booking_owner_type = 'agency' and v_booking.booking_owner_key = v_actor_agency)) then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_CONFIRM_FORBIDDEN');
  end if;
  v_ledger_key := lower(v_booking.import_source) || '-payment:' || v_booking.id::text;
  v_operation_request_key := lower(v_booking.import_source) || '-manual-ticketing:' || v_booking.id::text;
  v_payload_hash := encode(sha256(convert_to(jsonb_build_object('version', 1, 'bookingId', v_booking.id,
    'ownerType', v_booking.booking_owner_type, 'ownerKey', v_booking.booking_owner_key,
    'amount', v_booking.user_payable_amount, 'currency', upper(v_booking.currency))::text, 'UTF8')), 'hex');
  select * into v_existing_operation from public.booking_operations
   where booking_id = v_booking.id and state in ('claimed','supplier_call_started','awaiting_external_action','needs_reconciliation')
   order by claimed_at desc, id desc limit 1 for update;
  select * into v_existing_case from public.booking_reconciliation_cases
   where subject_booking_id = v_booking.id and state not in ('resolved','closed_no_change')
   order by opened_at desc limit 1 for update;
  select * into v_existing_reservation from public.wallet_reservations where booking_id = v_booking.id for update;
  if v_booking.payment_state = 'captured' then
    if v_booking.status = 'in-progress' and v_booking.captured_amount = v_booking.user_payable_amount
       and v_booking.refunded_amount = 0 and v_booking.active_operation_id = v_existing_operation.id
       and v_existing_operation.kind = 'imported_manual_ticketing'
       and v_existing_operation.request_key = v_operation_request_key
       and v_existing_operation.request_payload_hash = v_payload_hash
       and v_existing_operation.state = 'awaiting_external_action'
       and v_existing_reservation.state = 'captured'
       and v_existing_reservation.amount = v_booking.user_payable_amount
       and v_existing_reservation.wallet_account_id = v_booking.charged_wallet_account_id
       and exists (select 1 from public.wallet_ledger_entries ledger where ledger.idempotency_key = v_ledger_key and ledger.booking_id = v_booking.id and ledger.amount = v_booking.user_payable_amount) then
      return jsonb_build_object('ok', true, 'replay', true, 'status', 'in-progress',
        'operationId', v_existing_operation.id, 'operationState', v_existing_operation.state,
        'reconciliationCaseId', v_existing_case.id, 'reservationId', v_existing_reservation.id,
        'accountId', v_booking.charged_wallet_account_id, 'amount', v_booking.captured_amount, 'currency', v_booking.currency);
    end if;
    return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REQUIRED');
  end if;
  if v_existing_operation.id is not null or v_existing_case.id is not null or v_existing_reservation.id is not null then
    return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REQUIRED');
  end if;
  if v_booking.status <> 'on-hold' or v_booking.operation_kind is not null or v_booking.payment_state <> 'unpaid'
    or v_booking.charged_wallet_account_id is not null or v_booking.captured_amount <> 0 or v_booking.refunded_amount <> 0
    or public.resolve_booking_lifecycle(v_booking.status, v_booking.airlines_pnr, v_booking.ticketing_deadline_at, v_booking.operation_kind) <> 'on-hold' then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_ISSUABLE');
  end if;
  if v_booking.user_payable_amount is null or v_booking.user_payable_amount <= 0 then return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT'); end if;
  select * into v_wallet from public.wallets where owner_type = v_booking.booking_owner_type and owner_key = v_booking.booking_owner_key for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND'); end if;
  select * into v_account from public.wallet_accounts where wallet_id = v_wallet.id and currency = upper(v_booking.currency) for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND'); end if;
  if v_wallet.status <> 'active' then return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN'); end if;
  if v_account.available_balance < v_booking.user_payable_amount then return jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_FUNDS', 'available', v_account.available_balance, 'required', v_booking.user_payable_amount, 'currency', v_account.currency); end if;
  v_due_at := case when v_booking.ticketing_deadline_at is null then v_now + interval '2 hours'
    else greatest(v_now, least(v_now + interval '2 hours', v_booking.ticketing_deadline_at - interval '1 hour')) end;
  insert into public.booking_operations (booking_id, kind, state, reason_code, reason_detail, request_key, request_payload_hash, actor_user_id, actor_role, source, prior_stored_status, prior_lifecycle_status, supplier, supplier_operation, supplier_unique_trans_id, supplier_booking_code_ref, supplier_pnr, supplier_evidence, policy_version, claimed_at, external_action_due_at)
  values (v_booking.id, 'imported_manual_ticketing', 'awaiting_external_action', 'imported_manual_ticketing', 'Owner payment captured; external manual ticketing is required.', v_operation_request_key, v_payload_hash, p_actor_user_id, v_actor_role, 'customer', 'on-hold', 'on-hold', v_booking.supplier, 'ManualExternalTicketing', v_booking.supplier_refs->>'uniqueTransId', v_booking.booking_code_ref, v_booking.pnr,
    jsonb_build_object('paymentCaptured', true, 'supplierApiCalled', false, 'clientRequestId', p_idempotency_key, 'importSource', v_booking.import_source, 'userPayableAmount', v_booking.user_payable_amount, 'currency', v_booking.currency, 'externalActionDueAt', v_due_at), 1, v_now, v_due_at) returning * into v_operation;
  insert into public.booking_reconciliation_cases (subject_booking_id, operation_id, case_type, state, reason_code, reason_detail, opened_source, opened_by_user_id, opened_by_role, opened_at, assigned_team, assigned_at, severity, priority, due_at, escalation_level, evidence, financial_disposition, policy_version)
  values (v_booking.id, v_operation.id, 'imported_manual_ticketing', 'assigned', 'manual_ticketing_required', 'Payment received; verify and complete external manual ticketing.', 'operation', p_actor_user_id, v_actor_role, v_now, 'support', v_now, 'high', 30, v_due_at, 0,
    jsonb_build_array(jsonb_build_object('type','owner_payment_capture','operationId',v_operation.id,'amount',v_booking.user_payable_amount,'currency',v_booking.currency,'supplierApiCalled',false,'recordedAt',v_now)), 'none', 1) returning * into v_case;
  v_available_before := v_account.available_balance; v_hold_before := v_account.hold_balance;
  update public.wallet_accounts set available_balance = available_balance - v_booking.user_payable_amount where id = v_account.id;
  insert into public.wallet_reservations (wallet_account_id, booking_id, amount, currency, state, requested_by_user_id, issued_by_user_id, captured_at)
  values (v_account.id, v_booking.id, v_booking.user_payable_amount, v_account.currency, 'captured', p_actor_user_id, p_actor_user_id, v_now) returning * into v_reservation;
  insert into public.wallet_ledger_entries (wallet_account_id, transaction_type, amount, currency, available_before, available_after, hold_before, hold_after, booking_id, booking_reference, reservation_id, idempotency_key, created_by_user_id, created_by_role, remarks, metadata)
  values (v_account.id, 'booking_confirm', v_booking.user_payable_amount, v_account.currency, v_available_before, v_available_before - v_booking.user_payable_amount, v_hold_before, v_hold_before, v_booking.id, v_booking.public_ref, v_reservation.id, v_ledger_key, p_actor_user_id, v_actor_role, 'Owner confirmed external booking for manual ticketing',
    jsonb_build_object('importSource',v_booking.import_source,'operationId',v_operation.id,'reconciliationCaseId',v_case.id,'supplierGrossAmount',v_booking.supplier_gross_amount,'userPayableAmount',v_booking.user_payable_amount));
  update public.flight_bookings set charged_wallet_account_id = v_account.id, payment_state = 'captured', payment_amount = user_payable_amount, captured_amount = user_payable_amount, status = 'in-progress', active_operation_id = v_operation.id, operation_kind = 'ticketing', operation_reason = 'imported_manual_ticketing', operation_request_id = v_operation_request_key, operation_actor_user_id = p_actor_user_id, operation_started_at = v_now, operation_prior_status = 'on-hold' where id = v_booking.id;
  select count(*)::integer + 1 into v_occurrence_number from public.booking_status_events where booking_id = v_booking.id and to_lifecycle_status = 'in-progress';
  insert into public.booking_status_events (booking_id,from_lifecycle_status,to_lifecycle_status,stored_status_before,stored_status_after,operation_kind,operation_reason,actor_user_id,supplier_operation,supplier_evidence,idempotency_key,operation_id,reconciliation_case_id,occurrence_number,effective_at,observed_at,event_snapshot,event_version)
  values (v_booking.id,'on-hold','in-progress','on-hold','in-progress','ticketing','imported_manual_ticketing',p_actor_user_id,'ImportCustomerConfirm',jsonb_build_object('walletCaptured',true,'supplierApiCalled',false,'importSource',v_booking.import_source,'userPayableAmount',v_booking.user_payable_amount),v_ledger_key || ':in-progress',v_operation.id,v_case.id,v_occurrence_number,v_now,v_now,jsonb_build_object('version',1,'bookingReference',v_booking.public_ref,'lifecycleStatus','in-progress','paymentState','captured','operationKind','imported_manual_ticketing','operationSource','imported_manual_ticketing','operationId',v_operation.id,'reconciliationCaseId',v_case.id,'userPayableAmount',v_booking.user_payable_amount,'currency',v_booking.currency),1) returning id into v_event_id;
  return jsonb_build_object('ok',true,'replay',false,'status','in-progress','operationId',v_operation.id,'operationState',v_operation.state,'reconciliationCaseId',v_case.id,'reservationId',v_reservation.id,'accountId',v_account.id,'lifecycleEventId',v_event_id,'amount',v_booking.user_payable_amount,'currency',v_account.currency,'availableBalance',v_available_before-v_booking.user_payable_amount,'holdBalance',v_hold_before);
end;
$$;

create or replace function public.create_manual_booking_v1(
  p_actor_user_id text, p_assigned_user_id text, p_user_payable_amount bigint,
  p_supplier_gross_amount bigint, p_data jsonb, p_request_key text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_actor_role text; v_target_role text; v_agency_code text; v_owner_type text; v_owner_key text;
  v_currency text; v_initial_status text; v_reference text; v_payload_hash text; v_existing_action public.manual_booking_actions;
  v_existing public.flight_bookings; v_attempt_id uuid := gen_random_uuid(); v_search_id uuid := gen_random_uuid();
  v_booking_id uuid := gen_random_uuid(); v_booking public.flight_bookings; v_wallet public.wallets; v_account public.wallet_accounts;
  v_reservation public.wallet_reservations; v_now timestamptz := clock_timestamp(); v_available_before bigint; v_hold_before bigint;
  v_ledger_key text; v_ticket_count integer; v_result jsonb; v_pnr text; v_ticket_numbers jsonb; v_issued_at timestamptz;
  v_event_id bigint; v_occurrence_number integer;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' or nullif(btrim(coalesce(p_actor_user_id,'')),'') is null
    or nullif(btrim(coalesce(p_assigned_user_id,'')),'') is null or p_user_payable_amount is null or p_user_payable_amount <= 0
    or p_supplier_gross_amount is null or p_supplier_gross_amount < 0
    or p_request_key !~ '^manual-import:v1:[0-9a-f-]{36}$' then return jsonb_build_object('ok',false,'code','INVALID_MANUAL_IMPORT_DATA'); end if;
  select role into v_actor_role from public.app_users where clerk_id = p_actor_user_id;
  if v_actor_role is null or v_actor_role not in ('staff_support','admin','superadmin') then return jsonb_build_object('ok',false,'code','MANUAL_IMPORT_FORBIDDEN'); end if;
  select role, agency_code into v_target_role, v_agency_code from public.app_users where clerk_id = p_assigned_user_id;
  if not found or v_target_role not in ('b2b','b2b_sub','customer') then return jsonb_build_object('ok',false,'code','INVALID_IMPORT_ASSIGNEE'); end if;
  if v_target_role in ('b2b','b2b_sub') then
    if nullif(btrim(v_agency_code),'') is null then return jsonb_build_object('ok',false,'code','ASSIGNEE_AGENCY_REQUIRED'); end if;
    v_owner_type := 'agency'; v_owner_key := v_agency_code;
  else v_owner_type := 'user'; v_owner_key := p_assigned_user_id; end if;
  v_currency := upper(coalesce(nullif(btrim(p_data->>'currency'),''),'BDT')); v_initial_status := p_data->>'initialStatus';
  v_reference := nullif(btrim(p_data->>'supplierReference'),''); v_pnr := nullif(btrim(p_data->>'pnr'),''); v_ticket_numbers := coalesce(p_data->'ticketNumbers','[]'::jsonb);
  v_ticket_count := case when jsonb_typeof(p_data #> '{passengers,travellers}')='array' then jsonb_array_length(p_data #> '{passengers,travellers}') else 0 end;
  if p_data->>'provider' is distinct from 'MANUAL' or v_reference is null or v_pnr is null or v_currency !~ '^[A-Z]{3}$'
    or v_initial_status not in ('on-hold','confirmed') or coalesce(p_data->>'travelDate','') !~ '^\d{4}-\d{2}-\d{2}$'
    or jsonb_typeof(p_data->'passengerCounts') <> 'object' or jsonb_typeof(p_data->'itinerary') <> 'object'
    or jsonb_typeof(p_data->'fares') <> 'array' or jsonb_typeof(p_data->'passengers') <> 'object'
    or jsonb_typeof(p_data->'airlinesPnr') <> 'array' or v_ticket_count <= 0
    or jsonb_array_length(case when jsonb_typeof(p_data->'airlinesPnr')='array' then p_data->'airlinesPnr' else '[]'::jsonb end) = 0 then
    return jsonb_build_object('ok',false,'code','INVALID_MANUAL_IMPORT_DATA');
  end if;
  if v_initial_status = 'confirmed' then
    begin v_issued_at := nullif(p_data->>'issuedAt','')::timestamptz; exception when others then v_issued_at := null; end;
    if v_issued_at is null or jsonb_typeof(v_ticket_numbers) <> 'array' or jsonb_array_length(v_ticket_numbers) <> v_ticket_count
      or exists (select 1 from jsonb_array_elements(v_ticket_numbers) ticket(value) where jsonb_typeof(ticket.value) <> 'string' or nullif(btrim(ticket.value #>> '{}'),'') is null)
      or (select count(distinct upper(ticket.value #>> '{}')) from jsonb_array_elements(v_ticket_numbers) ticket(value)) <> v_ticket_count then
      return jsonb_build_object('ok',false,'code','COMPLETE_CONFIRMED_MANUAL_EVIDENCE_REQUIRED');
    end if;
  elsif jsonb_array_length(v_ticket_numbers) <> 0 or nullif(p_data->>'issuedAt','') is not null then
    return jsonb_build_object('ok',false,'code','ON_HOLD_MANUAL_IMPORT_CANNOT_INCLUDE_TICKETS');
  end if;
  v_payload_hash := encode(sha256(convert_to(jsonb_build_object('assignedUserId',p_assigned_user_id,'userPayableAmount',p_user_payable_amount,'supplierGrossAmount',p_supplier_gross_amount,'data',p_data)::text,'UTF8')),'hex');
  select * into v_existing_action from public.manual_booking_actions where request_key = p_request_key for update;
  if found then
    if v_existing_action.actor_user_id = p_actor_user_id and v_existing_action.payload_hash = v_payload_hash then return v_existing_action.result || jsonb_build_object('replay',true); end if;
    return jsonb_build_object('ok',false,'code','MANUAL_REQUEST_IDENTITY_MISMATCH');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('MANUAL:' || v_reference,0));
  select * into v_existing from public.flight_bookings where import_source='MANUAL' and booking_ref_number=v_reference limit 1 for update;
  if found then return jsonb_build_object('ok',false,'code','MANUAL_BOOKING_ALREADY_IMPORTED','booking',jsonb_build_object('id',v_existing.id,'public_ref',v_existing.public_ref,'payment_state',v_existing.payment_state)); end if;
  if v_initial_status='confirmed' then
    select * into v_wallet from public.wallets where owner_type=v_owner_type and owner_key=v_owner_key for update;
    if not found then return jsonb_build_object('ok',false,'code','WALLET_NOT_FOUND'); end if;
    select * into v_account from public.wallet_accounts where wallet_id=v_wallet.id and currency=v_currency for update;
    if not found then return jsonb_build_object('ok',false,'code','WALLET_ACCOUNT_NOT_FOUND'); end if;
    if v_wallet.status <> 'active' then return jsonb_build_object('ok',false,'code','WALLET_FROZEN'); end if;
    if v_account.available_balance < p_user_payable_amount then return jsonb_build_object('ok',false,'code','INSUFFICIENT_FUNDS','available',v_account.available_balance,'required',p_user_payable_amount,'currency',v_currency); end if;
    v_available_before:=v_account.available_balance; v_hold_before:=v_account.hold_balance;
    update public.wallet_accounts set available_balance=available_balance-p_user_payable_amount where id=v_account.id;
  end if;
  insert into public.booking_attempts (id,access_token_hash,user_id,audience,agency_code,supplier,state,search_id,itinerary_id,unique_trans_id,item_code_ref,price_code_ref,booking_code_ref,pnr,offer_snapshot,passenger_snapshot,expires_at,submitted_at,resolved_at,created_at)
  values (v_attempt_id,encode(sha256(convert_to(v_attempt_id::text,'UTF8')),'hex'),p_assigned_user_id,case when v_owner_type='agency' then 'agency' else 'b2c' end,case when v_owner_type='agency' then v_agency_code else null end,'manual','succeeded',v_search_id,'manual:'||v_reference,v_reference,v_reference,v_reference,'manual:'||v_reference,v_pnr,
    jsonb_build_object('itinerary',p_data->'itinerary','fares',p_data->'fares','currency',v_currency,'pricing',jsonb_build_object('audience',case when v_owner_type='agency' then 'agency' else 'b2c' end,'agencyCode',case when v_owner_type='agency' then v_agency_code else null end,'sellingPrice',p_user_payable_amount::numeric/100,'supplierTotalPrice',p_supplier_gross_amount::numeric/100,'grossPrice',p_supplier_gross_amount::numeric/100,'serviceMarginAmount',0,'basis','manual'),'passengerCounts',p_data->'passengerCounts','travelDate',p_data->>'travelDate','directTicketing',v_initial_status='confirmed','passportRequired',coalesce((p_data->>'passportRequired')::boolean,true),'repricedAt',v_now),p_data->'passengers',v_now,v_now,v_now,v_now);
  perform set_config('app.skip_initial_booking_status_event', 'true', true);
  insert into public.flight_bookings (id,public_ref,attempt_id,access_token_hash,supplier,user_id,audience,agency_code,search_id,itinerary_id,status,currency,pricing_snapshot,passenger_counts,travel_date,direct_ticketing,itinerary,fares,passport_required,supplier_refs,repriced_at,accepted_at,expires_at,passengers,pnr,airlines_pnr,booking_ref_number,booking_status,ticketing_deadline_at,deadline_source,booking_code_ref,ticket_numbers,warnings,supplier_message,issued_at,submission_started_at,legacy_operational,booked_by_user_id,issued_by_user_id,booking_owner_type,booking_owner_key,charged_wallet_account_id,payment_state,payment_amount,captured_amount,refunded_amount,supplier_gross_amount,user_payable_amount,import_source,imported_by_user_id,import_metadata,created_at)
  values (v_booking_id,public.allocate_booking_ref(),v_attempt_id,encode(sha256(convert_to(v_booking_id::text,'UTF8')),'hex'),'manual',p_assigned_user_id,case when v_owner_type='agency' then 'agency' else 'b2c' end,case when v_owner_type='agency' then v_agency_code else null end,v_search_id,'manual:'||v_reference,case when v_initial_status='confirmed' then 'confirmed' else 'on-hold' end,v_currency,
    jsonb_build_object('audience',case when v_owner_type='agency' then 'agency' else 'b2c' end,'agencyCode',case when v_owner_type='agency' then v_agency_code else null end,'sellingPrice',p_user_payable_amount::numeric/100,'supplierTotalPrice',p_supplier_gross_amount::numeric/100,'grossPrice',p_supplier_gross_amount::numeric/100,'serviceMarginAmount',0,'basis','manual'),p_data->'passengerCounts',(p_data->>'travelDate')::date,v_initial_status='confirmed',p_data->'itinerary',p_data->'fares',coalesce((p_data->>'passportRequired')::boolean,true),jsonb_build_object('externalImport',true,'manualImport',true,'uniqueTransId',v_reference,'itemCodeRef',v_reference,'priceCodeRef',v_reference),v_now,v_now,v_now,p_data->'passengers',v_pnr,p_data->'airlinesPnr',v_reference,case when v_initial_status='confirmed' then 'Manual Confirmed' else 'Manual On Hold' end,nullif(p_data->>'ticketingDeadlineAt','')::timestamptz,case when nullif(p_data->>'ticketingDeadlineAt','') is not null then 'assumed' else null end,'manual:'||v_reference,case when v_initial_status='confirmed' then v_ticket_numbers else '[]'::jsonb end,'[]'::jsonb,nullif(p_data->>'supplierMessage',''),case when v_initial_status='confirmed' then v_issued_at else null end,v_now,false,p_actor_user_id,case when v_initial_status='confirmed' then p_actor_user_id else null end,v_owner_type,v_owner_key,case when v_initial_status='confirmed' then v_account.id else null end,case when v_initial_status='confirmed' then 'captured' else 'unpaid' end,case when v_initial_status='confirmed' then p_user_payable_amount else null end,case when v_initial_status='confirmed' then p_user_payable_amount else 0 end,0,p_supplier_gross_amount,p_user_payable_amount,'MANUAL',p_actor_user_id,jsonb_build_object('source','manual','externalReference',v_reference,'importRequestKey',p_request_key,'initialStatus',v_initial_status,'walletCharged',v_initial_status='confirmed'),v_now) returning * into v_booking;
  if v_initial_status='confirmed' then
    insert into public.wallet_reservations (wallet_account_id,booking_id,amount,currency,state,requested_by_user_id,issued_by_user_id,captured_at) values (v_account.id,v_booking.id,p_user_payable_amount,v_currency,'captured',p_actor_user_id,p_actor_user_id,v_now) returning * into v_reservation;
    v_ledger_key := 'manual-payment:'||v_booking.id::text;
    insert into public.wallet_ledger_entries (wallet_account_id,transaction_type,amount,currency,available_before,available_after,hold_before,hold_after,booking_id,booking_reference,reservation_id,idempotency_key,created_by_user_id,created_by_role,remarks,metadata)
    values (v_account.id,'booking_confirm',p_user_payable_amount,v_currency,v_available_before,v_available_before-p_user_payable_amount,v_hold_before,v_hold_before,v_booking.id,v_booking.public_ref,v_reservation.id,v_ledger_key,p_actor_user_id,v_actor_role,'Manual confirmed booking import and charge',jsonb_build_object('importSource','MANUAL','supplierGrossAmount',p_supplier_gross_amount,'userPayableAmount',p_user_payable_amount,'directConfirmedImport',true));
  end if;
  select count(*)::integer + 1 into v_occurrence_number from public.booking_status_events
   where booking_id=v_booking.id and to_lifecycle_status=v_initial_status;
  insert into public.booking_status_events (booking_id,from_lifecycle_status,to_lifecycle_status,stored_status_before,stored_status_after,actor_user_id,supplier_operation,supplier_evidence,idempotency_key,occurrence_number,effective_at,observed_at,event_snapshot,event_version)
  values (v_booking.id,null,v_initial_status,null,v_booking.status,p_actor_user_id,'ManualBookingImport',
    jsonb_build_object('requestKey',p_request_key,'walletCharged',v_initial_status='confirmed','supplierApiCalled',false,'ticketCount',case when v_initial_status='confirmed' then jsonb_array_length(v_booking.ticket_numbers) else 0 end),
    p_request_key || ':' || v_initial_status,v_occurrence_number,v_now,v_now,
    jsonb_build_object('version',1,'bookingReference',v_booking.public_ref,'lifecycleStatus',v_initial_status,'paymentState',v_booking.payment_state,'operationSource','manual','userPayableAmount',v_booking.user_payable_amount,'currency',v_booking.currency),1) returning id into v_event_id;
  v_result := jsonb_build_object('ok',true,'booking',jsonb_build_object('id',v_booking.id,'public_ref',v_booking.public_ref,'payment_state',v_booking.payment_state),'status',v_initial_status,'walletCharged',v_initial_status='confirmed','lifecycleEventId',v_event_id,'amount',case when v_initial_status='confirmed' then p_user_payable_amount else 0 end,'accountId',case when v_initial_status='confirmed' then v_account.id else null end,'currency',v_currency);
  insert into public.manual_booking_actions (request_key,booking_id,action,actor_user_id,actor_role,payload_hash,result) values (p_request_key,v_booking.id,'import',p_actor_user_id,v_actor_role,v_payload_hash,v_result);
  insert into public.security_audit_events (actor_user_id,actor_role,action,target_type,target_id,outcome,metadata) values (p_actor_user_id,v_actor_role,'booking.manual.import','booking',v_booking.id::text,'succeeded',jsonb_build_object('requestKey',p_request_key,'initialStatus',v_initial_status,'walletCharged',v_initial_status='confirmed','amount',case when v_initial_status='confirmed' then p_user_payable_amount else 0 end,'currency',v_currency));
  return v_result;
end;
$$;

create or replace function public.update_manual_booking_status_v1(
  p_booking_id uuid, p_actor_user_id text, p_target_status text,
  p_data jsonb, p_request_key text
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_actor_role text; v_booking public.flight_bookings; v_existing_action public.manual_booking_actions;
  v_payload_hash text; v_now timestamptz := clock_timestamp(); v_before text; v_pnr text; v_airlines_pnr jsonb;
  v_deadline timestamptz; v_ticket_numbers jsonb; v_issued_at timestamptz; v_ticket_count integer;
  v_wallet public.wallets; v_account public.wallet_accounts; v_reservation public.wallet_reservations;
  v_operation public.booking_operations; v_case public.booking_reconciliation_cases; v_available_before bigint; v_hold_before bigint;
  v_ledger_key text; v_event_id bigint; v_occurrence_number integer; v_result jsonb;
begin
  if p_booking_id is null or p_data is null or jsonb_typeof(p_data) <> 'object' or nullif(btrim(coalesce(p_actor_user_id,'')),'') is null
     or p_target_status not in ('on-hold','pending','confirmed','expired','unconfirmed','cancelled')
     or p_request_key !~ '^manual-status:v1:[0-9a-f-]{36}$' then return jsonb_build_object('ok',false,'code','INVALID_MANUAL_STATUS_REQUEST'); end if;
  select role into v_actor_role from public.app_users where clerk_id=p_actor_user_id;
  if v_actor_role is null or v_actor_role not in ('staff_support','admin','superadmin') then return jsonb_build_object('ok',false,'code','MANUAL_STATUS_FORBIDDEN'); end if;
  select * into v_booking from public.flight_bookings where id=p_booking_id and import_source='MANUAL' for update;
  if not found then return jsonb_build_object('ok',false,'code','MANUAL_BOOKING_NOT_FOUND'); end if;
  v_payload_hash:=encode(sha256(convert_to(jsonb_build_object('bookingId',p_booking_id,'targetStatus',p_target_status,'data',p_data)::text,'UTF8')),'hex');
  select * into v_existing_action from public.manual_booking_actions where request_key=p_request_key for update;
  if found then
    if v_existing_action.booking_id=v_booking.id and v_existing_action.actor_user_id=p_actor_user_id and v_existing_action.payload_hash=v_payload_hash then return v_existing_action.result || jsonb_build_object('replay',true); end if;
    return jsonb_build_object('ok',false,'code','MANUAL_REQUEST_IDENTITY_MISMATCH');
  end if;
  v_before:=public.resolve_booking_lifecycle(v_booking.status,v_booking.airlines_pnr,v_booking.ticketing_deadline_at,v_booking.operation_kind);
  if v_before in ('confirmed','cancelled') then return jsonb_build_object('ok',false,'code','MANUAL_TERMINAL_BOOKING'); end if;
  v_pnr:=coalesce(nullif(btrim(p_data->>'pnr'),''),v_booking.pnr); v_airlines_pnr:=coalesce(p_data->'airlinesPnr',v_booking.airlines_pnr,'[]'::jsonb);
  begin v_deadline:=coalesce(nullif(p_data->>'ticketingDeadlineAt','')::timestamptz,v_booking.ticketing_deadline_at); exception when others then return jsonb_build_object('ok',false,'code','INVALID_MANUAL_STATUS_DATA'); end;
  if p_target_status='confirmed' then
    begin v_issued_at:=nullif(p_data->>'issuedAt','')::timestamptz; exception when others then v_issued_at:=null; end;
    v_ticket_numbers:=coalesce(p_data->'ticketNumbers','[]'::jsonb); v_ticket_count:=case when jsonb_typeof(v_booking.passengers->'travellers')='array' then jsonb_array_length(v_booking.passengers->'travellers') else 0 end;
    if v_issued_at is null or v_ticket_count<=0 or jsonb_typeof(v_ticket_numbers)<>'array' or jsonb_array_length(v_ticket_numbers)<>v_ticket_count
       or exists (select 1 from jsonb_array_elements(v_ticket_numbers) ticket(value) where jsonb_typeof(ticket.value)<>'string' or nullif(btrim(ticket.value #>> '{}'),'') is null)
       or (select count(distinct upper(ticket.value #>> '{}')) from jsonb_array_elements(v_ticket_numbers) ticket(value))<>v_ticket_count then return jsonb_build_object('ok',false,'code','COMPLETE_CONFIRMED_MANUAL_EVIDENCE_REQUIRED'); end if;
    if v_before='in-progress' then
      select * into v_operation from public.booking_operations where id=v_booking.active_operation_id for update;
      select * into v_case from public.booking_reconciliation_cases where operation_id=v_operation.id and subject_booking_id=v_booking.id and state not in ('resolved','closed_no_change') order by opened_at desc limit 1 for update;
      select * into v_reservation from public.wallet_reservations where booking_id=v_booking.id for update;
      if v_booking.payment_state<>'captured' or v_booking.captured_amount<>v_booking.user_payable_amount or v_operation.kind<>'imported_manual_ticketing' or v_operation.state<>'awaiting_external_action' or v_reservation.state<>'captured' then return jsonb_build_object('ok',false,'code','MANUAL_TICKETING_RECONCILIATION_REQUIRED'); end if;
      update public.booking_operations set state='succeeded',completed_at=v_now,supplier_evidence=coalesce(supplier_evidence,'{}'::jsonb)||jsonb_build_object('manualTicketDetailsRecordedAt',v_now,'supplierApiCalled',false) where id=v_operation.id;
      update public.booking_reconciliation_cases set state='resolved',resolution_outcome='ticketed',resolution=jsonb_build_object('version',1,'executionRequestKey',p_request_key,'resolutionKind','manual_ticketed','walletMutation',false),resolution_reason='Manual external ticket details recorded',resolved_by_user_id=p_actor_user_id,resolved_at=v_now,closed_at=v_now,version=version+1 where id=v_case.id;
      update public.flight_bookings set status='confirmed',direct_ticketing=true,issued_at=v_issued_at,issued_by_user_id=p_actor_user_id,ticket_numbers=v_ticket_numbers,active_operation_id=null,operation_kind=null,operation_reason=null,operation_request_id=null,operation_actor_user_id=null,operation_started_at=null,operation_prior_status=null where id=v_booking.id returning * into v_booking;
    elsif v_before='on-hold' then
      if v_booking.payment_state<>'unpaid' or v_booking.captured_amount<>0 or v_booking.charged_wallet_account_id is not null then return jsonb_build_object('ok',false,'code','MANUAL_PAYMENT_RECONCILIATION_REQUIRED'); end if;
      select * into v_wallet from public.wallets where owner_type=v_booking.booking_owner_type and owner_key=v_booking.booking_owner_key for update;
      if not found then return jsonb_build_object('ok',false,'code','WALLET_NOT_FOUND'); end if;
      select * into v_account from public.wallet_accounts where wallet_id=v_wallet.id and currency=upper(v_booking.currency) for update;
      if not found then return jsonb_build_object('ok',false,'code','WALLET_ACCOUNT_NOT_FOUND'); end if;
      if v_wallet.status<>'active' then return jsonb_build_object('ok',false,'code','WALLET_FROZEN'); end if;
      if v_account.available_balance<v_booking.user_payable_amount then return jsonb_build_object('ok',false,'code','INSUFFICIENT_FUNDS','available',v_account.available_balance,'required',v_booking.user_payable_amount,'currency',v_account.currency); end if;
      v_available_before:=v_account.available_balance; v_hold_before:=v_account.hold_balance;
      update public.wallet_accounts set available_balance=available_balance-v_booking.user_payable_amount where id=v_account.id;
      insert into public.wallet_reservations (wallet_account_id,booking_id,amount,currency,state,requested_by_user_id,issued_by_user_id,captured_at) values (v_account.id,v_booking.id,v_booking.user_payable_amount,v_account.currency,'captured',p_actor_user_id,p_actor_user_id,v_now) returning * into v_reservation;
      v_ledger_key:='manual-payment:'||v_booking.id::text;
      insert into public.wallet_ledger_entries (wallet_account_id,transaction_type,amount,currency,available_before,available_after,hold_before,hold_after,booking_id,booking_reference,reservation_id,idempotency_key,created_by_user_id,created_by_role,remarks,metadata) values (v_account.id,'booking_confirm',v_booking.user_payable_amount,v_account.currency,v_available_before,v_available_before-v_booking.user_payable_amount,v_hold_before,v_hold_before,v_booking.id,v_booking.public_ref,v_reservation.id,v_ledger_key,p_actor_user_id,v_actor_role,'Manual On Hold to Confirmed status change and charge',jsonb_build_object('importSource','MANUAL','supplierGrossAmount',v_booking.supplier_gross_amount,'userPayableAmount',v_booking.user_payable_amount,'manualStatusTransition','on-hold->confirmed'));
      update public.flight_bookings set status='confirmed',direct_ticketing=true,issued_at=v_issued_at,issued_by_user_id=p_actor_user_id,ticket_numbers=v_ticket_numbers,payment_state='captured',payment_amount=user_payable_amount,captured_amount=user_payable_amount,charged_wallet_account_id=v_account.id where id=v_booking.id returning * into v_booking;
    else return jsonb_build_object('ok',false,'code','MANUAL_CONFIRM_TRANSITION_NOT_ALLOWED'); end if;
  elsif v_before='in-progress' then return jsonb_build_object('ok',false,'code','MANUAL_IN_PROGRESS_REQUIRES_TICKET_DETAILS');
  elsif v_booking.payment_state<>'unpaid' or v_booking.captured_amount<>0 or v_booking.charged_wallet_account_id is not null then return jsonb_build_object('ok',false,'code','MANUAL_PAYMENT_RECONCILIATION_REQUIRED');
  elsif p_target_status='cancelled' then
    if nullif(btrim(p_data->>'cancellationReason'),'') is null then return jsonb_build_object('ok',false,'code','MANUAL_CANCELLATION_REASON_REQUIRED'); end if;
    update public.flight_bookings set status='cancelled',cancelled_at=v_now,cancelled_by=p_actor_user_id,cancel_reason=btrim(p_data->>'cancellationReason') where id=v_booking.id returning * into v_booking;
  elsif p_target_status='pending' then
    update public.flight_bookings set status='pending' where id=v_booking.id returning * into v_booking;
  elsif p_target_status='unconfirmed' then
    update public.flight_bookings set status='on-hold',airlines_pnr='[]'::jsonb,ticketing_deadline_at=null,deadline_source=null where id=v_booking.id returning * into v_booking;
  elsif p_target_status='expired' then
    if v_pnr is null or not public.jsonb_is_nonempty_array(v_airlines_pnr) then return jsonb_build_object('ok',false,'code','MANUAL_PNR_REQUIRED'); end if;
    update public.flight_bookings set status='on-hold',pnr=v_pnr,airlines_pnr=v_airlines_pnr,ticketing_deadline_at=least(coalesce(v_deadline,v_now),v_now),deadline_source='assumed' where id=v_booking.id returning * into v_booking;
  else
    if v_pnr is null or not public.jsonb_is_nonempty_array(v_airlines_pnr) then return jsonb_build_object('ok',false,'code','MANUAL_PNR_REQUIRED'); end if;
    if v_deadline is not null and v_deadline<=v_now then return jsonb_build_object('ok',false,'code','MANUAL_ON_HOLD_DEADLINE_MUST_BE_FUTURE'); end if;
    update public.flight_bookings set status='on-hold',pnr=v_pnr,airlines_pnr=v_airlines_pnr,ticketing_deadline_at=v_deadline,deadline_source=case when v_deadline is null then null else 'assumed' end where id=v_booking.id returning * into v_booking;
  end if;
  if public.resolve_booking_lifecycle(v_booking.status,v_booking.airlines_pnr,v_booking.ticketing_deadline_at,v_booking.operation_kind)<>p_target_status then raise exception 'manual status backing facts did not resolve to target' using errcode='23514'; end if;
  select count(*)::integer+1 into v_occurrence_number from public.booking_status_events where booking_id=v_booking.id and to_lifecycle_status=p_target_status;
  insert into public.booking_status_events (booking_id,from_lifecycle_status,to_lifecycle_status,stored_status_before,stored_status_after,operation_kind,operation_reason,actor_user_id,supplier_operation,supplier_evidence,idempotency_key,operation_id,reconciliation_case_id,occurrence_number,effective_at,observed_at,event_snapshot,event_version)
  values (v_booking.id,v_before,p_target_status,case when v_before in ('expired','unconfirmed') then 'on-hold' else v_before end,v_booking.status,case when p_target_status='confirmed' and v_before='in-progress' then 'ticketing' else null end,case when p_target_status='confirmed' and v_before='in-progress' then 'imported_manual_ticketing' when p_target_status='confirmed' then 'manual_direct_confirm' else 'manual_status_change' end,p_actor_user_id,'ManualStatusChange',jsonb_build_object('requestKey',p_request_key,'walletCharged',p_target_status='confirmed' and v_before='on-hold','walletMutation',p_target_status='confirmed' and v_before='on-hold','supplierApiCalled',false,'ticketCount',case when p_target_status='confirmed' then jsonb_array_length(v_booking.ticket_numbers) else 0 end),p_request_key || ':' || p_target_status,case when v_before='in-progress' then v_operation.id else null end,case when v_before='in-progress' then v_case.id else null end,v_occurrence_number,v_now,v_now,jsonb_build_object('version',1,'bookingReference',v_booking.public_ref,'lifecycleStatus',p_target_status,'paymentState',v_booking.payment_state,'operationSource','manual','userPayableAmount',v_booking.user_payable_amount,'currency',v_booking.currency),1) returning id into v_event_id;
  v_result:=jsonb_build_object('ok',true,'booking',jsonb_build_object('id',v_booking.id,'public_ref',v_booking.public_ref,'payment_state',v_booking.payment_state),'status',p_target_status,'walletCharged',p_target_status='confirmed' and v_before='on-hold','walletMutation',p_target_status='confirmed' and v_before='on-hold','lifecycleEventId',v_event_id,'amount',case when p_target_status='confirmed' and v_before='on-hold' then v_booking.user_payable_amount else 0 end,'currency',v_booking.currency);
  insert into public.manual_booking_actions (request_key,booking_id,action,actor_user_id,actor_role,payload_hash,result) values (p_request_key,v_booking.id,'status_change',p_actor_user_id,v_actor_role,v_payload_hash,v_result);
  insert into public.security_audit_events (actor_user_id,actor_role,action,target_type,target_id,outcome,metadata) values (p_actor_user_id,v_actor_role,'booking.manual.status_change','booking',v_booking.id::text,'succeeded',jsonb_build_object('requestKey',p_request_key,'fromStatus',v_before,'targetStatus',p_target_status,'walletCharged',p_target_status='confirmed' and v_before='on-hold'));
  return v_result;
end;
$$;

revoke all on function public.create_manual_booking_v1(text,text,bigint,bigint,jsonb,text) from public,anon,authenticated;
grant execute on function public.create_manual_booking_v1(text,text,bigint,bigint,jsonb,text) to service_role;
revoke all on function public.update_manual_booking_status_v1(uuid,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.update_manual_booking_status_v1(uuid,text,text,jsonb,text) to service_role;
revoke all on function public.wallet_confirm_impexp_booking(uuid,text,text) from public,anon,authenticated;
grant execute on function public.wallet_confirm_impexp_booking(uuid,text,text) to service_role;

comment on column public.flight_bookings.import_source is
  'IMP_EXP for supplier imports and MANUAL for staff-entered external bookings. MANUAL rows must never invoke supplier APIs.';
