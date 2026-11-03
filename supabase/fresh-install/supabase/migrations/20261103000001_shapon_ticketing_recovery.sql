-- Complete uncertain native Shapon ticketing from the existing Admin ticket dialog.
-- Installed migrations remain immutable; recovery stays on the existing Admin booking page.
begin;

create or replace function public.confirm_shapon_external_ticket_v1(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_id uuid,
  p_charge_wallet boolean,
  p_receipt_identity jsonb,
  p_ticket_proof jsonb,
  p_checked_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_booking public.flight_bookings;
  v_decision public.shapon_external_ticket_confirmations;
  v_actor_role text;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_ledger_id uuid;
  v_decision_id uuid := gen_random_uuid();
  v_amount bigint;
  v_currency text;
  v_count integer := 0;
  v_count_value jsonb;
  v_passenger_ticket jsonb;
  v_number jsonb;
  v_numbers jsonb := '[]'::jsonb;
  v_numeric_seen text[] := array[]::text[];
  v_row_seen text[];
  v_numeric_ticket text;
  v_locator boolean;
  v_6e boolean := false;
  v_leg jsonb;
  v_segment jsonb;
  v_now timestamptz := clock_timestamp();
  v_issued_at timestamptz;
  v_prior_lifecycle text;
  v_settlement text;
  v_recovery boolean := false;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_open_case public.booking_reconciliation_cases;
  v_open_count integer := 0;
  v_accounting jsonb;
  v_release_ledger_id uuid;
begin
  if p_booking_id is null or p_request_id is null or p_charge_wallet is null
     or nullif(btrim(p_actor_user_id), '') is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CONFIRMATION_REQUEST');
  end if;
  -- The authenticated server actor must also have the canonical DB role.
  select role into v_actor_role from public.app_users where clerk_id = p_actor_user_id;
  if v_actor_role is null or v_actor_role not in ('admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'CONFIRMATION_FORBIDDEN');
  end if;
  if p_actor_role is distinct from v_actor_role then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_ROLE_MISMATCH');
  end if;

  -- Request before booking matches the existing durable operation lock order.
  perform pg_advisory_xact_lock(hashtextextended('shapon-external:' || p_request_id::text, 0));
  select * into v_booking from public.flight_bookings where id = p_booking_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select * into v_decision from public.shapon_external_ticket_confirmations
    where request_id = p_request_id;
  if found then
    if (p_receipt_identity is not null and jsonb_typeof(p_receipt_identity) is distinct from 'object')
       or (p_ticket_proof is not null and jsonb_typeof(p_ticket_proof) is distinct from 'object') then
      return jsonb_build_object('ok', false, 'code', 'CONFIRMATION_REQUEST_CONFLICT');
    end if;
    if v_decision.booking_id is distinct from p_booking_id
       or v_decision.actor_user_id is distinct from p_actor_user_id
       or v_decision.actor_role is distinct from v_actor_role
       or v_decision.charge_wallet is distinct from p_charge_wallet
       or ((p_receipt_identity is not null or p_ticket_proof is not null)
         and (p_receipt_identity is distinct from v_decision.receipt_identity
           or (p_ticket_proof - 'issuedAt') is distinct from (v_decision.ticket_proof - 'issuedAt'))) then
      return jsonb_build_object('ok', false, 'code', 'CONFIRMATION_REQUEST_CONFLICT');
    end if;
    -- Read timestamps/optional supplier issue time are observations, not intent.
    -- A committed exact request may replay without contacting the supplier.
    return jsonb_build_object('ok', true, 'replay', true, 'confirmed', true,
      'bookingId', v_decision.booking_id, 'decisionId', v_decision.id,
      'status', 'confirmed', 'paymentState', case when v_decision.charge_wallet then 'captured' else 'unpaid' end,
      'chargeWallet', v_decision.charge_wallet, 'charged', v_decision.charge_wallet,
      'settlement', v_decision.settlement, 'walletAccountId', v_decision.wallet_account_id,
      'chargedAmount', case when v_decision.charge_wallet then v_decision.amount else 0 end,
      'amount', v_decision.amount, 'currency', v_decision.currency);
  end if;
  if exists (select 1 from public.shapon_external_ticket_confirmations where booking_id = p_booking_id) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_ALREADY_CONFIRMED');
  end if;

  if v_booking.supplier is distinct from 'shapontravels'
     or v_booking.supplier_account is distinct from 'shapontravels'
     or v_booking.import_source is not null or v_booking.legacy_operational
     or v_booking.direct_ticketing
     or not public.booking_uses_saved_references(v_booking) then
    return jsonb_build_object('ok', false, 'code', 'SUPPLIER_BOOKING_UNSUPPORTED');
  end if;
  if jsonb_typeof(p_receipt_identity) is distinct from 'object'
     or pg_column_size(p_receipt_identity) > 5000
     or not public.shapon_booking_status_identity_matches_v1(v_booking, p_receipt_identity) then
    return jsonb_build_object('ok', false, 'code', 'SUPPLIER_IDENTITY_UNVERIFIED');
  end if;
  -- Recovery is part of this explicit Admin confirmation, never an Issue retry.
  -- Retain the normal external-ticket lane unchanged for idle held bookings.
  v_recovery := v_booking.status = 'in-progress'
    and v_booking.operation_kind = 'reconciliation'
    and v_booking.operation_reason = 'ticketing_reconciliation'
    and v_booking.active_operation_id is not null
    and v_booking.payment_state in ('held', 'reconciliation');
  if v_recovery then
    select * into v_operation from public.booking_operations
      where id = v_booking.active_operation_id and booking_id = p_booking_id for update;
    if not found or v_operation.kind <> 'ticketing'
       or v_operation.state <> 'needs_reconciliation'
       or v_operation.supplier is distinct from 'shapontravels'
       or v_operation.supplier_operation is distinct from 'NewTicket'
       or v_operation.supplier_unique_trans_id is distinct from v_booking.supplier_refs->>'uniqueTransId'
       or v_operation.supplier_booking_code_ref is distinct from v_booking.booking_code_ref
       or v_operation.supplier_pnr is distinct from v_booking.pnr
       or v_operation.request_key is distinct from v_booking.operation_request_id
       or v_operation.supplier_call_started_at is null
       or v_operation.reconciliation_required_at is null
       or exists (select 1 from public.booking_operations other
         where other.booking_id = p_booking_id and other.id <> v_operation.id
           and other.state in ('claimed', 'supplier_call_started', 'awaiting_external_action', 'needs_reconciliation')) then
      return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REQUIRED');
    end if;
    -- Lock cases after the operation and before its wallet reservation. A
    -- different case or a pending proposal keeps its existing review contract.
    for v_open_case in select * from public.booking_reconciliation_cases
      where (subject_booking_id = p_booking_id or subject_booking_attempt_id = v_booking.attempt_id)
        and state not in ('resolved', 'closed_no_change', 'superseded') order by id for update loop
      v_open_count := v_open_count + 1;
      if v_open_case.subject_booking_id is distinct from p_booking_id
         or v_open_case.operation_id is distinct from v_operation.id
         or v_open_case.case_type <> 'ticketing_uncertainty'
         or v_open_case.state not in ('open', 'assigned', 'awaiting_supplier', 'awaiting_finance')
         or v_open_case.proposal_hash is not null or v_open_case.proposed_outcome is not null
         or v_open_case.proposal <> '{}'::jsonb
         or v_open_case.approved_at is not null then
        return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REQUIRED');
      end if;
      v_case := v_open_case;
    end loop;
    if v_open_count <> 1 then
      return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REQUIRED');
    end if;
  end if;
  if (not v_recovery and (v_booking.status not in ('on-hold', 'pending')
       or v_booking.operation_kind is not null or v_booking.operation_reason is not null
       or v_booking.active_operation_id is not null or v_booking.operation_request_id is not null
       or v_booking.operation_actor_user_id is not null or v_booking.operation_started_at is not null
       or v_booking.operation_prior_status is not null
       or v_booking.payment_state not in ('unpaid', 'released')
       or exists (select 1 from public.booking_operations where booking_id = p_booking_id
         and state in ('claimed', 'supplier_call_started', 'awaiting_external_action', 'needs_reconciliation'))
       or exists (select 1 from public.booking_reconciliation_cases
         where (subject_booking_id = p_booking_id or subject_booking_attempt_id = v_booking.attempt_id)
           and state not in ('resolved', 'closed_no_change', 'superseded'))))
     or v_booking.issued_at is not null
     or nullif(btrim(v_booking.ticket_code_ref), '') is not null
     or coalesce(v_booking.ticket_numbers, '[]'::jsonb) <> '[]'::jsonb
     or v_booking.captured_amount <> 0 or v_booking.refunded_amount <> 0
     or exists (select 1 from public.wallet_ledger_entries where booking_id = p_booking_id
       and transaction_type in ('booking_confirm', 'refund')) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_CONFIRMATION_CONFLICT');
  end if;
  if v_booking.booking_owner_type is null or nullif(btrim(v_booking.booking_owner_key), '') is null
     or (v_booking.booking_owner_type = 'user' and
       (v_booking.audience <> 'b2c' or v_booking.booking_owner_key is distinct from v_booking.user_id))
     or (v_booking.booking_owner_type = 'agency' and
       (v_booking.audience <> 'agency' or v_booking.booking_owner_key is distinct from v_booking.agency_code)) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_OWNER_REQUIRED');
  end if;
  -- A released earlier hold may be reused. A live, captured or unsettled hold
  -- must be handled by its original finalization/reconciliation operation.
  if (select count(*) from public.wallet_reservations where booking_id = p_booking_id
       or (booking_id is null and booking_attempt_id = v_booking.attempt_id)) > 1 then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_CONFIRMATION_CONFLICT');
  end if;
  select * into v_reservation from public.wallet_reservations
    where booking_id = p_booking_id or (booking_id is null and booking_attempt_id = v_booking.attempt_id)
    order by booking_id nulls last limit 1 for update;
  if (v_recovery and (v_reservation.id is null or v_reservation.state not in ('active', 'reconciliation')))
     or (not v_recovery and v_reservation.id is not null and v_reservation.state <> 'released') then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_CONFIRMATION_CONFLICT');
  end if;

  if p_checked_at is null or not isfinite(p_checked_at)
     or p_checked_at < v_now - interval '5 minutes' or p_checked_at > v_now + interval '30 seconds'
     or jsonb_typeof(p_ticket_proof) is distinct from 'object'
     or pg_column_size(p_ticket_proof) > 64000
     or p_ticket_proof->'verified' is distinct from 'true'::jsonb
     or p_ticket_proof->'issued' is distinct from 'true'::jsonb
     or p_ticket_proof->'paid' is distinct from 'true'::jsonb
     or coalesce(p_ticket_proof->>'source', '') not in ('supplier_ticket_details', 'supplier_saved_ticket_details')
     or p_ticket_proof->>'bookingStatus' is distinct from 'Confirmed'
     or p_ticket_proof->>'paymentStatus' is distinct from 'Paid'
     or p_ticket_proof->>'pnr' is distinct from v_booking.pnr
     or not coalesce((
       (p_ticket_proof->>'source' = 'supplier_ticket_details'
         and jsonb_typeof(p_ticket_proof->'ticketCodeRef') = 'string'
         and coalesce(p_ticket_proof->>'ticketCodeRef', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
       or (p_ticket_proof->>'source' = 'supplier_saved_ticket_details'
         and p_ticket_proof->'schemaVersion' = '1'::jsonb
         and (p_ticket_proof->'ticketCodeRef' = 'null'::jsonb
           or (jsonb_typeof(p_ticket_proof->'ticketCodeRef') = 'string'
             and coalesce(p_ticket_proof->>'ticketCodeRef', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')))), false)
     or jsonb_typeof(p_ticket_proof->'passengerCount') is distinct from 'number'
     or jsonb_typeof(p_ticket_proof->'passengerTickets') is distinct from 'array'
     or jsonb_typeof(p_ticket_proof->'ticketNumbers') is distinct from 'array'
     or jsonb_typeof(p_ticket_proof->'airlinesPnr') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
  end if;
  if jsonb_array_length(p_ticket_proof->'airlinesPnr') not between 1 and 20
     or exists (select 1 from jsonb_array_elements(p_ticket_proof->'airlinesPnr') n(value)
       where jsonb_typeof(n.value) <> 'string' or n.value #>> '{}' !~ '^[A-Z0-9]{3,12}$')
     or (select count(distinct value) from jsonb_array_elements(p_ticket_proof->'airlinesPnr'))
       <> jsonb_array_length(p_ticket_proof->'airlinesPnr') then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
  end if;
  -- Both saved passenger counts and saved traveller rows must be complete.
  for v_count_value in select value from jsonb_each(v_booking.passenger_counts) loop
    if jsonb_typeof(v_count_value) <> 'number' or v_count_value::text !~ '^[0-9]{1,3}$' then
      return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
    end if;
    v_count := v_count + v_count_value::text::integer;
  end loop;
  if v_count not between 1 and 100
     or p_ticket_proof->'passengerCount' is distinct from to_jsonb(v_count)
     or jsonb_array_length(p_ticket_proof->'passengerTickets') <> v_count
     or jsonb_typeof(v_booking.passengers->'travellers') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
  end if;
  if jsonb_array_length(v_booking.passengers->'travellers') <> v_count then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
  end if;
  -- IndiGo may use its airline locator as the ticket identifier. Establish
  -- the special carrier contract from the server-saved complete itinerary.
  if v_booking.itinerary->>'carrierCode' = '6E'
     and jsonb_typeof(v_booking.itinerary->'legs') = 'array'
     and jsonb_array_length(v_booking.itinerary->'legs') > 0 then
    v_6e := true;
    for v_leg in select value from jsonb_array_elements(v_booking.itinerary->'legs') loop
      if jsonb_typeof(v_leg->'segments') is distinct from 'array' then v_6e := false; exit; end if;
      if jsonb_array_length(v_leg->'segments') = 0 then v_6e := false; exit; end if;
      for v_segment in select value from jsonb_array_elements(v_leg->'segments') loop
        if v_segment->>'airlineCode' is distinct from '6E' then v_6e := false; exit; end if;
      end loop;
      exit when not v_6e;
    end loop;
  end if;
  for v_passenger_ticket in select value from jsonb_array_elements(p_ticket_proof->'passengerTickets') loop
    if jsonb_typeof(v_passenger_ticket) is distinct from 'object'
       or jsonb_typeof(v_passenger_ticket->'ticketNumbers') is distinct from 'array'
       or coalesce(jsonb_typeof(v_passenger_ticket->'ticketNumberSource'), 'null') not in ('null', 'string')
       or coalesce(v_passenger_ticket->>'ticketNumberSource', '') not in ('', 'airline_pnr') then
      return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
    end if;
    if jsonb_array_length(v_passenger_ticket->'ticketNumbers') not between 1 and 20 then
      return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
    end if;
    v_locator := v_passenger_ticket->>'ticketNumberSource' = 'airline_pnr';
    v_row_seen := array[]::text[];
    for v_number in select value from jsonb_array_elements(v_passenger_ticket->'ticketNumbers') loop
      if jsonb_typeof(v_number) <> 'string' or v_number #>> '{}' = any(v_row_seen) then
        return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
      end if;
      if coalesce(v_locator, false) then
        if p_ticket_proof->>'ticketCodeRef' is null
           or not v_6e or v_number #>> '{}' !~ '^[A-Z0-9]{6}$'
           or not (p_ticket_proof->'airlinesPnr' @> jsonb_build_array(v_number)) then
          return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
        end if;
      else
        if v_number #>> '{}' !~ '^[0-9]{10,16}$' or v_number #>> '{}' = any(v_numeric_seen) then
          return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
        end if;
        v_numeric_seen := array_append(v_numeric_seen, v_number #>> '{}');
      end if;
      v_row_seen := array_append(v_row_seen, v_number #>> '{}');
      v_numbers := v_numbers || jsonb_build_array(v_number);
    end loop;
  end loop;
  if p_ticket_proof->'ticketNumbers' is distinct from v_numbers then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
  end if;
  if p_ticket_proof ? 'issuedAt' and p_ticket_proof->'issuedAt' <> 'null'::jsonb then
    if jsonb_typeof(p_ticket_proof->'issuedAt') <> 'string'
       or length(p_ticket_proof->>'issuedAt') > 64
       or p_ticket_proof->>'issuedAt' !~ '^\d{4}-\d{2}-\d{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.\d{1,9})?(Z|[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])$' then
      return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
    end if;
    begin v_issued_at := (p_ticket_proof->>'issuedAt')::timestamptz;
    exception when others then return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED'); end;
    if not isfinite(v_issued_at) or v_issued_at > p_checked_at + interval '30 seconds'
       or v_issued_at < v_booking.created_at then
      return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
    end if;
  end if;

  -- Reject reusing another local booking's ticket receipt. The extra ticket
  -- lock serializes competing confirmations on different booking rows.
  if p_ticket_proof->>'ticketCodeRef' is not null then
    perform pg_advisory_xact_lock(hashtextextended('shapon-ticket:' || lower(p_ticket_proof->>'ticketCodeRef'), 0));
  end if;
  for v_numeric_ticket in select unnest(v_numeric_seen) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('shapon-ticket-number:' || v_numeric_ticket, 0));
  end loop;
  if exists (select 1 from public.flight_bookings other where other.id <> p_booking_id
    and (lower(other.ticket_code_ref) = lower(p_ticket_proof->>'ticketCodeRef')
      or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(other.ticket_numbers) = 'array'
        then other.ticket_numbers else '[]'::jsonb end) n(value)
        where n.value #>> '{}' = any(v_numeric_seen)))) then
    return jsonb_build_object('ok', false, 'code', 'TICKET_ALREADY_ASSIGNED');
  end if;
  begin
    if jsonb_typeof(v_booking.pricing_snapshot->'sellingPrice') <> 'number'
       or v_booking.pricing_snapshot->>'sellingPrice' in ('NaN', 'Infinity', '-Infinity') then
      return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
    end if;
    v_amount := round((v_booking.pricing_snapshot->>'sellingPrice')::numeric * 100)::bigint;
  exception when others then return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT'); end;
  v_currency := v_booking.currency;
  if v_amount is null or v_amount <= 0 or v_currency is null or v_currency !~ '^[A-Z]{3}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
  end if;
  v_prior_lifecycle := public.resolve_booking_lifecycle(v_booking.status, v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, v_booking.operation_kind);
  v_settlement := case when p_charge_wallet then 'owner_wallet' else 'external_supplier_paid_no_wallet_charge' end;

  if v_recovery then
    select wallet.* into v_wallet from public.wallets wallet
      join public.wallet_accounts account on account.wallet_id = wallet.id
      where account.id = v_reservation.wallet_account_id for update of wallet;
    if not found or v_wallet.owner_type is distinct from v_booking.booking_owner_type
       or v_wallet.owner_key is distinct from v_booking.booking_owner_key then
      return jsonb_build_object('ok', false, 'code', 'RESERVATION_ACCOUNT_CONFLICT');
    end if;
    select * into v_account from public.wallet_accounts
      where id = v_reservation.wallet_account_id and wallet_id = v_wallet.id for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND'); end if;
    v_accounting := public.classify_superadmin_booking_accounting_v1(p_booking_id);
    if v_accounting->>'ok' is distinct from 'true'
       or v_accounting->>'accountingState' is distinct from 'active_hold'
       or v_accounting->>'reservationId' is distinct from v_reservation.id::text
       or v_reservation.booking_id is distinct from p_booking_id
       or v_reservation.amount <> v_amount or v_reservation.currency <> v_currency
       or v_account.currency <> v_currency
       or v_booking.payment_amount is distinct from v_amount
       or v_booking.charged_wallet_account_id is distinct from v_account.id
       or v_account.hold_balance < (select coalesce(sum(amount), 0) from public.wallet_reservations
         where wallet_account_id = v_account.id and state in ('active', 'reconciliation')) then
      return jsonb_build_object('ok', false, 'code', 'ACTIVE_HOLD_ACCOUNTING_CONFLICT');
    end if;
    -- Every entry assigned to this hold must match its owner, currency and
    -- booking; account-level Hold alone is not proof of this booking's funds.
    if exists (select 1 from public.wallet_ledger_entries ledger
      where ledger.reservation_id = v_reservation.id and (
        ledger.wallet_account_id <> v_account.id or ledger.currency <> v_currency
        or ledger.booking_id is distinct from p_booking_id
        or ledger.transaction_type not in ('booking_hold', 'hold_release')
        or (ledger.transaction_type = 'booking_hold' and (
          ledger.available_before - ledger.available_after <> ledger.amount
          or ledger.hold_after - ledger.hold_before <> ledger.amount))
        or (ledger.transaction_type = 'hold_release' and (
          ledger.available_after - ledger.available_before <> ledger.amount
          or ledger.hold_before - ledger.hold_after <> ledger.amount)))) then
      return jsonb_build_object('ok', false, 'code', 'ACTIVE_HOLD_ACCOUNTING_CONFLICT');
    end if;
    if p_charge_wallet and v_wallet.status <> 'active' then
      return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN');
    end if;
    update public.wallet_accounts set
      available_balance = available_balance + case when p_charge_wallet then 0 else v_amount end,
      hold_balance = hold_balance - v_amount where id = v_account.id;
    if p_charge_wallet then
      update public.wallet_reservations set state = 'captured', issued_by_user_id = p_actor_user_id,
        captured_at = v_now, reconciliation_at = null, reconciliation_reason = null
        where id = v_reservation.id;
    else
      update public.wallet_reservations set state = 'released', released_at = v_now,
        release_reason = 'Admin confirmed supplier-paid ticket without wallet charge',
        reconciliation_at = null, reconciliation_reason = null where id = v_reservation.id;
    end if;
    insert into public.wallet_ledger_entries(wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after, booking_id, booking_reference,
      reservation_id, idempotency_key, created_by_user_id, created_by_role, remarks, metadata)
    values (v_account.id, case when p_charge_wallet then 'booking_confirm' else 'hold_release' end,
      v_amount, v_currency, v_account.available_balance,
      v_account.available_balance + case when p_charge_wallet then 0 else v_amount end,
      v_account.hold_balance, v_account.hold_balance - v_amount, p_booking_id, v_booking.public_ref,
      v_reservation.id, 'shapon-external-recovery:' || p_booking_id::text,
      p_actor_user_id, v_actor_role,
      case when p_charge_wallet then 'Admin captured existing hold for verified supplier-issued ticket'
        else 'Admin released existing hold and confirmed supplier-paid ticket without wallet charge' end,
      jsonb_build_object('decisionId', v_decision_id, 'requestId', p_request_id,
        'settlement', v_settlement, 'supplierApiCalled', false,
        'operationId', v_operation.id, 'reconciliationCaseId', v_case.id,
        'walletOwnerType', v_booking.booking_owner_type, 'walletOwnerKey', v_booking.booking_owner_key))
      returning id into v_ledger_id;
    if not p_charge_wallet then v_release_ledger_id := v_ledger_id; v_ledger_id := null; end if;
  elsif p_charge_wallet then
    -- Existing owner accounts are provisioned by account creation. A failed
    -- debit never creates accounts or leaves partial booking/audit mutations.
    select * into v_wallet from public.wallets where owner_type = v_booking.booking_owner_type
      and owner_key = v_booking.booking_owner_key for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND'); end if;
    select * into v_account from public.wallet_accounts where wallet_id = v_wallet.id
      and currency = v_currency for update;
    if not found then return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND'); end if;
    if v_wallet.status <> 'active' then return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN'); end if;
    if v_account.available_balance < v_amount then
      return jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_FUNDS',
        'available', v_account.available_balance, 'required', v_amount, 'currency', v_currency);
    end if;
    update public.wallet_accounts set available_balance = available_balance - v_amount where id = v_account.id;
    if v_reservation.id is null then
      insert into public.wallet_reservations(wallet_account_id, booking_id, amount, currency,
        state, requested_by_user_id, issued_by_user_id, captured_at)
      values (v_account.id, p_booking_id, v_amount, v_currency,
        'captured', p_actor_user_id, p_actor_user_id, v_now) returning * into v_reservation;
    else
      update public.wallet_reservations set wallet_account_id = v_account.id,
        booking_id = p_booking_id, booking_attempt_id = null, amount = v_amount,
        currency = v_currency, state = 'captured', cycle = cycle + 1,
        requested_by_user_id = p_actor_user_id, issued_by_user_id = p_actor_user_id,
        captured_at = v_now, supplier_call_started_at = null, released_at = null,
        release_reason = null, reconciliation_at = null, reconciliation_reason = null
        where id = v_reservation.id returning * into v_reservation;
    end if;
    insert into public.wallet_ledger_entries(wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after, booking_id, booking_reference,
      reservation_id, idempotency_key, created_by_user_id, created_by_role, remarks, metadata)
    values (v_account.id, 'booking_confirm', v_amount, v_currency,
      v_account.available_balance, v_account.available_balance - v_amount,
      v_account.hold_balance, v_account.hold_balance, p_booking_id, v_booking.public_ref,
      v_reservation.id, 'shapon-external-confirm:' || p_booking_id::text,
      p_actor_user_id, v_actor_role, 'Admin confirmed a supplier-issued ticket and charged the booking owner',
      jsonb_build_object('decisionId', v_decision_id, 'requestId', p_request_id,
        'settlement', v_settlement, 'supplierApiCalled', false,
        'walletOwnerType', v_booking.booking_owner_type, 'walletOwnerKey', v_booking.booking_owner_key))
      returning id into v_ledger_id;
  end if;

  update public.flight_bookings set status = 'confirmed', booking_status = 'Confirmed',
    ticket_code_ref = p_ticket_proof->>'ticketCodeRef', ticket_numbers = v_numbers,
    airlines_pnr = p_ticket_proof->'airlinesPnr', issued_at = v_issued_at,
    issued_by_user_id = p_actor_user_id,
    payment_state = case when p_charge_wallet then 'captured' else 'unpaid' end,
    charged_wallet_account_id = case when p_charge_wallet then v_account.id else null end,
    payment_amount = case when p_charge_wallet then v_amount else null end,
    captured_amount = case when p_charge_wallet then v_amount else 0 end,
    active_operation_id = null, operation_kind = null, operation_reason = null,
    operation_request_id = null, operation_actor_user_id = null,
    operation_started_at = null, operation_prior_status = null
    where id = p_booking_id;
  insert into public.shapon_external_ticket_confirmations(id, booking_id, request_id,
    actor_user_id, actor_role, charge_wallet, receipt_identity, ticket_proof, checked_at,
    settlement, amount, currency, wallet_account_id, reservation_id, ledger_entry_id)
  values (v_decision_id, p_booking_id, p_request_id, p_actor_user_id, v_actor_role,
    p_charge_wallet, p_receipt_identity, p_ticket_proof, p_checked_at, v_settlement,
    v_amount, v_currency, case when p_charge_wallet then v_account.id else null end,
    case when p_charge_wallet then v_reservation.id else null end, v_ledger_id);
  if v_recovery then
    update public.booking_operations set state = 'succeeded', completed_at = v_now,
      error_code = null, error_message = null,
      supplier_evidence = supplier_evidence || jsonb_build_object('externalTicketRecovery',
        jsonb_build_object('decisionId', v_decision_id, 'requestId', p_request_id,
          'caseId', v_case.id, 'chargeWallet', p_charge_wallet, 'checkedAt', p_checked_at))
      where id = v_operation.id;
    update public.booking_reconciliation_cases set state = 'resolved',
      resolution_outcome = 'ticketed',
      financial_disposition = case when p_charge_wallet then 'capture_existing_hold' else 'release_existing_hold' end,
      financial_amount = v_amount, financial_currency = v_currency,
      resolution = jsonb_build_object('version', 1, 'resolutionKind', 'shapon_external_ticket',
        'decisionId', v_decision_id, 'requestId', p_request_id, 'operationId', v_operation.id,
        'chargeWallet', p_charge_wallet, 'settlement', v_settlement,
        'captureLedgerEntryId', v_ledger_id, 'releaseLedgerEntryId', v_release_ledger_id,
        'checkedAt', p_checked_at, 'executedByRole', v_actor_role),
      resolution_reason = 'Admin confirmed matching issued and supplier-paid ticket from booking page',
      resolved_by_user_id = p_actor_user_id, resolved_at = v_now, closed_at = v_now,
      version = version + 1 where id = v_case.id;
  end if;
  insert into public.booking_status_events(booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, effective_at, observed_at, event_snapshot,
    operation_id, reconciliation_case_id, operation_kind, operation_reason)
  values (p_booking_id, v_prior_lifecycle, 'confirmed', v_booking.status, 'confirmed',
    p_actor_user_id, 'ExternalTicketConfirmation',
    jsonb_build_object('decisionId', v_decision_id, 'requestId', p_request_id,
      'actorRole', v_actor_role, 'chargeWallet', p_charge_wallet, 'settlement', v_settlement,
      'amount', v_amount, 'currency', v_currency, 'supplierApiCalled', false,
      'ticketCodeRef', p_ticket_proof->>'ticketCodeRef', 'ticketNumbers', v_numbers,
      'walletOwnerType', v_booking.booking_owner_type, 'walletOwnerKey', v_booking.booking_owner_key),
    'shapon-external-confirm:' || p_request_id::text, v_issued_at, v_now,
    jsonb_build_object('operationSource', 'shapontravels', 'externalTicketConfirmation', true,
      'settlement', v_settlement, 'chargeWallet', p_charge_wallet,
      'operationId', v_operation.id, 'reconciliationCaseId', v_case.id, 'recovery', v_recovery),
    v_operation.id, v_case.id, v_booking.operation_kind, v_booking.operation_reason);
  return jsonb_build_object('ok', true, 'replay', false, 'confirmed', true,
    'bookingId', p_booking_id, 'decisionId', v_decision_id, 'status', 'confirmed',
    'paymentState', case when p_charge_wallet then 'captured' else 'unpaid' end,
    'chargeWallet', p_charge_wallet, 'charged', p_charge_wallet, 'settlement', v_settlement,
    'walletAccountId', case when p_charge_wallet then v_account.id else null end,
    'chargedAmount', case when p_charge_wallet then v_amount else 0 end,
    'amount', v_amount, 'currency', v_currency, 'recovery', v_recovery);
end;
$$;
revoke all on function public.confirm_shapon_external_ticket_v1(uuid, text, text, uuid, boolean, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.confirm_shapon_external_ticket_v1(uuid, text, text, uuid, boolean, jsonb, jsonb, timestamptz)
  to service_role;
comment on function public.confirm_shapon_external_ticket_v1(uuid, text, text, uuid, boolean, jsonb, jsonb, timestamptz) is
  'Confirms an identity-verified, already issued and supplier-paid native Shapon ticket. Admin chooses exactly-once owner wallet capture or audited external settlement without wallet charge. Never sends a supplier write.';


create or replace function public.shapon_booking_has_external_paid_settlement_v1(p_booking_id uuid)
returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1 from public.shapon_external_ticket_confirmations decision
    join public.flight_bookings booking on booking.id = decision.booking_id
    where decision.booking_id = p_booking_id and not decision.charge_wallet
      and decision.settlement = 'external_supplier_paid_no_wallet_charge'
      and booking.status = 'confirmed' and booking.payment_state = 'unpaid'
      and booking.charged_wallet_account_id is null and booking.payment_amount is null
      and booking.captured_amount = 0 and booking.refunded_amount = 0
      and booking.operation_kind is null and booking.active_operation_id is null
      and public.shapon_booking_status_identity_matches_v1(booking, decision.receipt_identity)
      and booking.ticket_code_ref is not distinct from decision.ticket_proof->>'ticketCodeRef'
      and public.jsonb_is_nonempty_array(booking.ticket_numbers)
      and booking.ticket_numbers = decision.ticket_proof->'ticketNumbers'
      and decision.ticket_proof->'verified' = 'true'::jsonb
      and decision.ticket_proof->'issued' = 'true'::jsonb
      and decision.ticket_proof->'paid' = 'true'::jsonb
  );
$$;
revoke all on function public.shapon_booking_has_external_paid_settlement_v1(uuid)
  from public, anon, authenticated;
grant execute on function public.shapon_booking_has_external_paid_settlement_v1(uuid) to service_role;


-- saved-v1 can explicitly report no original bookingStatus. Preserve that
-- absence as evidence rather than inventing a historical status string.
alter table public.shapon_booking_current_status_observations
  alter column original_booking_status drop not null;
do $migration$
declare
  v_signature text := 'public.record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb)';
  v_definition text;
  v_old text := $old$      or jsonb_typeof(p_receipt_identity->'originalBookingStatus') is distinct from 'string'
      or length(btrim(p_receipt_identity->>'originalBookingStatus')) not between 1 and 100$old$;
  v_new text := $new$      -- shapon-explicit-null-original-status-v1
      or not (p_receipt_identity ? 'originalBookingStatus')
      or coalesce(jsonb_typeof(p_receipt_identity->'originalBookingStatus'), 'missing') not in ('string','null')
      or (jsonb_typeof(p_receipt_identity->'originalBookingStatus') = 'string' and
        (length(btrim(p_receipt_identity->>'originalBookingStatus')) not between 1 and 100
          or p_receipt_identity->>'originalBookingStatus' ~ '[[:cntrl:]]'))$new$;
  v_owner oid;
  v_acl aclitem[];
  v_after_owner oid;
  v_after_acl aclitem[];
begin
  select proowner,proacl into v_owner,v_acl from pg_proc where oid=to_regprocedure(v_signature);
  v_definition := pg_get_functiondef(to_regprocedure(v_signature));
  if v_definition is null then raise exception 'required Shapon current-status recorder missing'; end if;
  if position('-- shapon-explicit-null-original-status-v1' in v_definition) = 0 then
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
      raise exception 'unexpected Shapon original status evidence guard';
    end if;
    execute replace(v_definition,v_old,v_new);
  elsif position(v_new in v_definition) = 0 then
    raise exception 'unexpected previously patched Shapon original status evidence guard';
  end if;
  select proowner,proacl into v_after_owner,v_after_acl from pg_proc where oid=to_regprocedure(v_signature);
  if v_owner is distinct from v_after_owner or v_acl is distinct from v_after_acl then
    raise exception 'Shapon current-status recorder owner or grants changed';
  end if;
end;
$migration$;

-- The same staff Refresh may finish an exactly unpaid uncertain cancellation.
-- This cannot acquire, capture, release, refund or otherwise alter wallet funds.
create function public.resolve_shapon_cancelled_refresh_v1(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_id uuid,
  p_receipt_identity jsonb,
  p_cancellation_proof jsonb,
  p_checked_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_open_case public.booking_reconciliation_cases;
  v_open_count integer := 0;
  v_actor_role text;
  v_now timestamptz := clock_timestamp();
  v_cancelled_at timestamptz;
  v_event public.booking_status_events;
  v_event_id bigint;
  v_key text := 'shapon-cancelled-refresh:' || p_request_id::text;
begin
  if p_booking_id is null or p_request_id is null or nullif(btrim(p_actor_user_id),'') is null then
    return jsonb_build_object('ok',false,'code','INVALID_CANCELLATION_REQUEST');
  end if;
  select role into v_actor_role from public.app_users where clerk_id=p_actor_user_id;
  if v_actor_role is null or v_actor_role not in ('admin','superadmin') then
    return jsonb_build_object('ok',false,'code','CONFIRMATION_FORBIDDEN');
  end if;
  if p_actor_role is distinct from v_actor_role then
    return jsonb_build_object('ok',false,'code','ACTOR_ROLE_MISMATCH');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_key,0));
  select * into v_booking from public.flight_bookings where id=p_booking_id for update;
  if not found then return jsonb_build_object('ok',false,'code','BOOKING_NOT_FOUND'); end if;
  select * into v_event from public.booking_status_events
    where idempotency_key=v_key order by id limit 1;
  if found then
    if (p_receipt_identity is not null and jsonb_typeof(p_receipt_identity) is distinct from 'object')
       or (p_cancellation_proof is not null and jsonb_typeof(p_cancellation_proof) is distinct from 'object') then
      return jsonb_build_object('ok',false,'code','CONFIRMATION_REQUEST_CONFLICT');
    end if;
    if v_event.booking_id is distinct from p_booking_id
       or v_event.actor_user_id is distinct from p_actor_user_id
       or v_event.supplier_operation is distinct from 'ShaponCancelledRefresh'
       or v_event.supplier_evidence->>'actorRole' is distinct from v_actor_role
       or (p_receipt_identity is not null and p_receipt_identity is distinct from v_event.supplier_evidence->'receiptIdentity')
       or (p_cancellation_proof is not null and
         (p_cancellation_proof-'cancelledAt') is distinct from ((v_event.supplier_evidence->'cancellationProof')-'cancelledAt')) then
      return jsonb_build_object('ok',false,'code','CONFIRMATION_REQUEST_CONFLICT');
    end if;
    return jsonb_build_object('ok',true,'replay',true,'bookingStatus','cancelled',
      'paymentState','unpaid','walletMutation',false,'lifecycleEventId',v_event.id);
  end if;
  if v_booking.supplier is distinct from 'shapontravels'
     or v_booking.supplier_account is distinct from 'shapontravels'
     or v_booking.import_source is not null or v_booking.legacy_operational or v_booking.direct_ticketing
     or not public.booking_uses_saved_references(v_booking) then
    return jsonb_build_object('ok',false,'code','SUPPLIER_BOOKING_UNSUPPORTED');
  end if;
  if jsonb_typeof(p_receipt_identity) is distinct from 'object'
     or pg_column_size(p_receipt_identity)>5000
     or not public.shapon_booking_status_identity_matches_v1(v_booking,p_receipt_identity) then
    return jsonb_build_object('ok',false,'code','SUPPLIER_IDENTITY_UNVERIFIED');
  end if;
  if v_booking.status <> 'in-progress' or v_booking.operation_kind is distinct from 'reconciliation'
     or v_booking.operation_reason is distinct from 'cancellation_reconciliation'
     or v_booking.active_operation_id is null
     or v_booking.payment_state <> 'unpaid' or v_booking.captured_amount <> 0 or v_booking.refunded_amount <> 0
     or v_booking.charged_wallet_account_id is not null or v_booking.payment_amount is not null
     or v_booking.issued_at is not null or nullif(btrim(v_booking.ticket_code_ref),'') is not null
     or coalesce(v_booking.ticket_numbers,'[]'::jsonb)<>'[]'::jsonb then
    return jsonb_build_object('ok',false,'code','CANCELLATION_RECONCILIATION_REQUIRED');
  end if;
  select * into v_operation from public.booking_operations
    where id=v_booking.active_operation_id and booking_id=p_booking_id for update;
  if not found or v_operation.kind <> 'cancellation' or v_operation.state <> 'needs_reconciliation'
     or v_operation.supplier is distinct from 'shapontravels'
     or v_operation.supplier_operation is distinct from 'Cancel'
     or v_operation.supplier_unique_trans_id is distinct from v_booking.supplier_refs->>'uniqueTransId'
     or v_operation.supplier_booking_code_ref is distinct from v_booking.booking_code_ref
     or v_operation.supplier_pnr is distinct from v_booking.pnr
     or v_operation.request_key is distinct from v_booking.operation_request_id
     or v_operation.supplier_call_started_at is null or v_operation.reconciliation_required_at is null
     or exists(select 1 from public.booking_operations other where other.booking_id=p_booking_id
       and other.id<>v_operation.id and other.state in ('claimed','supplier_call_started','awaiting_external_action','needs_reconciliation')) then
    return jsonb_build_object('ok',false,'code','CANCELLATION_RECONCILIATION_REQUIRED');
  end if;
  for v_open_case in select * from public.booking_reconciliation_cases
    where (subject_booking_id=p_booking_id or subject_booking_attempt_id=v_booking.attempt_id)
      and state not in ('resolved','closed_no_change','superseded') order by id for update loop
    v_open_count:=v_open_count+1;
    if v_open_case.subject_booking_id is distinct from p_booking_id
       or v_open_case.operation_id is distinct from v_operation.id
       or v_open_case.case_type<>'cancellation_uncertainty'
       or v_open_case.state not in ('open','assigned','awaiting_supplier','awaiting_finance')
       or v_open_case.proposal_hash is not null or v_open_case.proposed_outcome is not null
       or v_open_case.proposal<>'{}'::jsonb or v_open_case.approved_at is not null then
      return jsonb_build_object('ok',false,'code','CANCELLATION_RECONCILIATION_REQUIRED');
    end if;
    v_case:=v_open_case;
  end loop;
  if v_open_count<>1 then
    return jsonb_build_object('ok',false,'code','CANCELLATION_RECONCILIATION_REQUIRED');
  end if;
  -- This exact no-money lane has no prior wallet involvement. A released or
  -- captured historical reservation belongs to its existing reviewed workflow.
  if exists(select 1 from public.wallet_reservations where booking_id=p_booking_id
       or (booking_id is null and booking_attempt_id=v_booking.attempt_id))
     or exists(select 1 from public.wallet_ledger_entries where booking_id=p_booking_id
       and transaction_type in ('booking_hold','booking_confirm','hold_release','refund')) then
    return jsonb_build_object('ok',false,'code','CANCELLATION_PAYMENT_REVIEW_REQUIRED');
  end if;
  if p_checked_at is null or not isfinite(p_checked_at)
     or p_checked_at<v_now-interval '5 minutes' or p_checked_at>v_now+interval '30 seconds'
     or jsonb_typeof(p_cancellation_proof) is distinct from 'object'
     or pg_column_size(p_cancellation_proof)>16000
     or p_cancellation_proof->'verified' is distinct from 'true'::jsonb
     or p_cancellation_proof->'cancelled' is distinct from 'true'::jsonb
     or p_cancellation_proof->>'source' is distinct from 'supplier_booking_details'
     or p_cancellation_proof->>'status' is distinct from 'cancelled'
     or p_cancellation_proof->'pendingReview' is distinct from 'false'::jsonb
     or p_cancellation_proof->'requiresReconciliation' is distinct from 'false'::jsonb
     or p_cancellation_proof->>'pnr' is distinct from v_booking.pnr
     or p_cancellation_proof->'ticketCount' is distinct from '0'::jsonb then
    return jsonb_build_object('ok',false,'code','CANCELLATION_EVIDENCE_UNVERIFIED');
  end if;
  if p_cancellation_proof ? 'cancelledAt' and p_cancellation_proof->'cancelledAt'<>'null'::jsonb then
    if jsonb_typeof(p_cancellation_proof->'cancelledAt')<>'string'
       or length(p_cancellation_proof->>'cancelledAt')>64
       or p_cancellation_proof->>'cancelledAt' !~ '^\d{4}-\d{2}-\d{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.\d{1,9})?(Z|[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])$' then
      return jsonb_build_object('ok',false,'code','CANCELLATION_EVIDENCE_UNVERIFIED');
    end if;
    begin v_cancelled_at:=(p_cancellation_proof->>'cancelledAt')::timestamptz;
    exception when others then return jsonb_build_object('ok',false,'code','CANCELLATION_EVIDENCE_UNVERIFIED'); end;
    if not isfinite(v_cancelled_at) or v_cancelled_at>p_checked_at+interval '30 seconds'
       or v_cancelled_at<v_booking.created_at then
      return jsonb_build_object('ok',false,'code','CANCELLATION_EVIDENCE_UNVERIFIED');
    end if;
  end if;
  update public.flight_bookings set status='cancelled',booking_status='Cancelled',
    cancelled_at=coalesce(v_cancelled_at,v_now),cancelled_by=p_actor_user_id,
    cancel_reason='Supplier cancellation verified by Admin booking status refresh',
    active_operation_id=null,operation_kind=null,operation_reason=null,
    operation_request_id=null,operation_actor_user_id=null,operation_started_at=null,operation_prior_status=null
    where id=p_booking_id;
  update public.booking_operations set state='succeeded',completed_at=v_now,error_code=null,error_message=null,
    supplier_evidence=supplier_evidence||jsonb_build_object('cancelledRefreshResolution',
      jsonb_build_object('caseId',v_case.id,'requestId',p_request_id,'checkedAt',p_checked_at))
    where id=v_operation.id;
  update public.booking_reconciliation_cases set state='resolved',resolution_outcome='cancelled_unpaid',
    resolution=jsonb_build_object('version',1,'resolutionKind','shapon_cancelled_refresh',
      'requestId',p_request_id,'operationId',v_operation.id,'checkedAt',p_checked_at,
      'executedByRole',v_actor_role,'walletMutation',false),
    resolution_reason='Matching supplier cancellation verified from Admin booking page',
    resolved_by_user_id=p_actor_user_id,resolved_at=v_now,closed_at=v_now,version=version+1 where id=v_case.id;
  insert into public.booking_status_events(booking_id,from_lifecycle_status,to_lifecycle_status,
    stored_status_before,stored_status_after,operation_kind,operation_reason,actor_user_id,
    supplier_operation,supplier_evidence,idempotency_key,operation_id,reconciliation_case_id,
    effective_at,observed_at,event_snapshot)
  values(p_booking_id,'in-progress','cancelled','in-progress','cancelled',
    v_booking.operation_kind,v_booking.operation_reason,p_actor_user_id,'ShaponCancelledRefresh',
    jsonb_build_object('actorRole',v_actor_role,'receiptIdentity',p_receipt_identity,
      'cancellationProof',p_cancellation_proof,'checkedAt',p_checked_at,
      'cancelledAtSource',case when v_cancelled_at is null then 'admin_refresh' else 'supplier' end,
      'supplierApiCalled',false,'walletMutation',false),v_key,v_operation.id,v_case.id,
    v_cancelled_at,v_now,jsonb_build_object('operationSource','shapontravels',
      'cancelledRefreshRecovery',true,'paymentState','unpaid','walletMutation',false)) returning id into v_event_id;
  return jsonb_build_object('ok',true,'replay',false,'bookingStatus','cancelled','paymentState','unpaid',
    'walletMutation',false,'lifecycleEventId',v_event_id,'caseId',v_case.id);
end;
$$;
revoke all on function public.resolve_shapon_cancelled_refresh_v1(uuid,text,text,uuid,jsonb,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function public.resolve_shapon_cancelled_refresh_v1(uuid,text,text,uuid,jsonb,jsonb,timestamptz)
  to service_role;
comment on function public.resolve_shapon_cancelled_refresh_v1(uuid,text,text,uuid,jsonb,jsonb,timestamptz) is
  'Completes an identity-verified exactly unpaid native Shapon cancellation from Admin status Refresh. Closes only its matching uncertain cancellation operation/case, appends linked outcome evidence and notification event, and never moves wallet funds or sends a supplier write.';

commit;
