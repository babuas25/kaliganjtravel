-- An already issued and supplier-paid native Shapon booking may be confirmed
-- by Admin/Super Admin, with an explicit choice about charging its owner.
-- This records external settlement separately from local wallet capture.
create table public.shapon_external_ticket_confirmations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.flight_bookings(id) on delete restrict,
  request_id uuid not null unique,
  actor_user_id text not null,
  actor_role text not null check (actor_role in ('admin', 'superadmin')),
  charge_wallet boolean not null,
  receipt_identity jsonb not null check (jsonb_typeof(receipt_identity) = 'object'),
  ticket_proof jsonb not null check (jsonb_typeof(ticket_proof) = 'object'),
  checked_at timestamptz not null,
  settlement text not null check (settlement in (
    'owner_wallet', 'external_supplier_paid_no_wallet_charge')),
  -- Saved selling price in minor units, whether or not it was debited.
  amount bigint not null check (amount > 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  wallet_account_id uuid references public.wallet_accounts(id) on delete restrict,
  reservation_id uuid references public.wallet_reservations(id) on delete restrict,
  ledger_entry_id uuid references public.wallet_ledger_entries(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  check ((charge_wallet and settlement = 'owner_wallet'
      and wallet_account_id is not null and reservation_id is not null and ledger_entry_id is not null)
    or (not charge_wallet and settlement = 'external_supplier_paid_no_wallet_charge'
      and wallet_account_id is null and reservation_id is null and ledger_entry_id is null))
);
alter table public.shapon_external_ticket_confirmations enable row level security;
revoke all on public.shapon_external_ticket_confirmations
  from public, anon, authenticated, service_role;
grant select on public.shapon_external_ticket_confirmations to service_role;

create function public.prevent_shapon_external_confirmation_mutation_v1()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'external ticket confirmation decisions are immutable' using errcode = '55000';
end;
$$;
create trigger shapon_external_ticket_confirmations_immutable
  before update or delete on public.shapon_external_ticket_confirmations
  for each row execute function public.prevent_shapon_external_confirmation_mutation_v1();
revoke all on function public.prevent_shapon_external_confirmation_mutation_v1()
  from public, anon, authenticated, service_role;

create function public.confirm_shapon_external_ticket_v1(
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
  if v_booking.status not in ('on-hold', 'pending')
     or v_booking.operation_kind is not null or v_booking.operation_reason is not null
     or v_booking.active_operation_id is not null or v_booking.operation_request_id is not null
     or v_booking.operation_actor_user_id is not null or v_booking.operation_started_at is not null
     or v_booking.operation_prior_status is not null
     or v_booking.issued_at is not null
     or nullif(btrim(v_booking.ticket_code_ref), '') is not null
     or coalesce(v_booking.ticket_numbers, '[]'::jsonb) <> '[]'::jsonb
     or v_booking.payment_state not in ('unpaid', 'released')
     or v_booking.captured_amount <> 0 or v_booking.refunded_amount <> 0
     or exists (select 1 from public.booking_operations where booking_id = p_booking_id
       and state in ('claimed', 'supplier_call_started', 'awaiting_external_action', 'needs_reconciliation'))
     or exists (select 1 from public.booking_reconciliation_cases
       where (subject_booking_id = p_booking_id or subject_booking_attempt_id = v_booking.attempt_id)
       and state not in ('resolved', 'closed_no_change', 'superseded'))
     or exists (select 1 from public.wallet_ledger_entries where booking_id = p_booking_id
       and transaction_type = 'booking_confirm') then
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
  if found and v_reservation.state <> 'released' then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_CONFIRMATION_CONFLICT');
  end if;

  if p_checked_at is null or not isfinite(p_checked_at)
     or p_checked_at < v_now - interval '5 minutes' or p_checked_at > v_now + interval '30 seconds'
     or jsonb_typeof(p_ticket_proof) is distinct from 'object'
     or pg_column_size(p_ticket_proof) > 64000
     or p_ticket_proof->'verified' is distinct from 'true'::jsonb
     or p_ticket_proof->'issued' is distinct from 'true'::jsonb
     or p_ticket_proof->'paid' is distinct from 'true'::jsonb
     or p_ticket_proof->>'source' is distinct from 'supplier_ticket_details'
     or p_ticket_proof->>'bookingStatus' is distinct from 'Confirmed'
     or p_ticket_proof->>'paymentStatus' is distinct from 'Paid'
     or p_ticket_proof->>'pnr' is distinct from v_booking.pnr
     or jsonb_typeof(p_ticket_proof->'ticketCodeRef') is distinct from 'string'
     or coalesce(p_ticket_proof->>'ticketCodeRef', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
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
        if not v_6e or v_number #>> '{}' !~ '^[A-Z0-9]{6}$'
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
  perform pg_advisory_xact_lock(hashtextextended('shapon-ticket:' || lower(p_ticket_proof->>'ticketCodeRef'), 0));
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

  if p_charge_wallet then
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
    captured_amount = case when p_charge_wallet then v_amount else 0 end
    where id = p_booking_id;
  insert into public.shapon_external_ticket_confirmations(id, booking_id, request_id,
    actor_user_id, actor_role, charge_wallet, receipt_identity, ticket_proof, checked_at,
    settlement, amount, currency, wallet_account_id, reservation_id, ledger_entry_id)
  values (v_decision_id, p_booking_id, p_request_id, p_actor_user_id, v_actor_role,
    p_charge_wallet, p_receipt_identity, p_ticket_proof, p_checked_at, v_settlement,
    v_amount, v_currency, case when p_charge_wallet then v_account.id else null end,
    case when p_charge_wallet then v_reservation.id else null end, v_ledger_id);
  insert into public.booking_status_events(booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, effective_at, observed_at, event_snapshot)
  values (p_booking_id, v_prior_lifecycle, 'confirmed', v_booking.status, 'confirmed',
    p_actor_user_id, 'ExternalTicketConfirmation',
    jsonb_build_object('decisionId', v_decision_id, 'requestId', p_request_id,
      'actorRole', v_actor_role, 'chargeWallet', p_charge_wallet, 'settlement', v_settlement,
      'amount', v_amount, 'currency', v_currency, 'supplierApiCalled', false,
      'ticketCodeRef', p_ticket_proof->>'ticketCodeRef', 'ticketNumbers', v_numbers,
      'walletOwnerType', v_booking.booking_owner_type, 'walletOwnerKey', v_booking.booking_owner_key),
    'shapon-external-confirm:' || p_request_id::text, v_issued_at, v_now,
    jsonb_build_object('operationSource', 'shapontravels', 'externalTicketConfirmation', true,
      'settlement', v_settlement, 'chargeWallet', p_charge_wallet));
  return jsonb_build_object('ok', true, 'replay', false, 'confirmed', true,
    'bookingId', p_booking_id, 'decisionId', v_decision_id, 'status', 'confirmed',
    'paymentState', case when p_charge_wallet then 'captured' else 'unpaid' end,
    'chargeWallet', p_charge_wallet, 'charged', p_charge_wallet, 'settlement', v_settlement,
    'walletAccountId', case when p_charge_wallet then v_account.id else null end,
    'chargedAmount', case when p_charge_wallet then v_amount else 0 end,
    'amount', v_amount, 'currency', v_currency);
end;
$$;
revoke all on function public.confirm_shapon_external_ticket_v1(uuid, text, text, uuid, boolean, jsonb, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.confirm_shapon_external_ticket_v1(uuid, text, text, uuid, boolean, jsonb, jsonb, timestamptz)
  to service_role;
comment on function public.confirm_shapon_external_ticket_v1(uuid, text, text, uuid, boolean, jsonb, jsonb, timestamptz) is
  'Confirms an identity-verified, already issued and supplier-paid native Shapon ticket. Admin chooses exactly-once owner wallet capture or audited external settlement without wallet charge. Never sends a supplier write.';

-- Confirmed/Unpaid normally needs financial reconciliation. An explicit,
-- immutable supplier-paid no-charge decision is a settled exception only
-- while the actual local owner/ticket/financial identity still matches it.
create function public.shapon_booking_has_external_paid_settlement_v1(p_booking_id uuid)
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
      and booking.ticket_code_ref = decision.ticket_proof->>'ticketCodeRef'
      and booking.ticket_numbers = decision.ticket_proof->'ticketNumbers'
      and decision.ticket_proof->'verified' = 'true'::jsonb
      and decision.ticket_proof->'issued' = 'true'::jsonb
      and decision.ticket_proof->'paid' = 'true'::jsonb
  );
$$;
revoke all on function public.shapon_booking_has_external_paid_settlement_v1(uuid)
  from public, anon, authenticated;
grant execute on function public.shapon_booking_has_external_paid_settlement_v1(uuid) to service_role;

-- Replace only the existing conflict predicate in the two staff-only views.
-- CREATE OR REPLACE preserves every output column, type, ordinal and grant.
do $$
declare
  v_view text;
  v_definition text;
  v_predicate text := 'booking.status = ''confirmed''::text AND booking.payment_state = ''unpaid''::text';
begin
  foreach v_view in array array['booking_lifecycle_staff_v', 'booking_lifecycle_metrics_v'] loop
    v_definition := pg_get_viewdef(('public.' || v_view)::regclass, true);
    if strpos(v_definition, v_predicate) = 0 then
      raise exception 'expected confirmed/unpaid predicate missing from %', v_view;
    end if;
    v_definition := replace(v_definition, v_predicate,
      v_predicate || ' AND NOT public.shapon_booking_has_external_paid_settlement_v1(booking.id)');
    execute format('create or replace view public.%I with (security_invoker = true) as %s',
      v_view, v_definition);
  end loop;
end;
$$;
