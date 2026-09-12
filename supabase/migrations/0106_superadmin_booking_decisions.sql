-- One-step Super Admin booking decisions.
--
-- Actual reservation and immutable ledger history are authoritative. The
-- denormalized flight_bookings.payment_state is repaired from proven
-- accounting truth and is never used by itself to choose a money movement.

create table if not exists public.superadmin_booking_decisions (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.flight_bookings (id) on delete restrict,
  request_key text not null unique
    check (char_length(request_key) between 1 and 220),
  actor_user_id text not null check (nullif(btrim(actor_user_id), '') is not null),
  actor_role text not null check (actor_role = 'superadmin'),
  decision text not null check (decision in (
    'confirm_ticketed', 'cancel', 'keep_on_hold',
    'extend_deadline', 'close_without_change'
  )),
  note text,
  request_snapshot jsonb not null check (jsonb_typeof(request_snapshot) = 'object'),
  accounting_snapshot jsonb not null check (jsonb_typeof(accounting_snapshot) = 'object'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists superadmin_booking_decisions_booking_created_idx
  on public.superadmin_booking_decisions (booking_id, created_at desc);

create or replace function public.deny_superadmin_booking_decision_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'superadmin booking decisions are immutable' using errcode = '55000';
end;
$$;

drop trigger if exists superadmin_booking_decisions_immutable_v1
  on public.superadmin_booking_decisions;
create trigger superadmin_booking_decisions_immutable_v1
  before update or delete on public.superadmin_booking_decisions
  for each row execute function public.deny_superadmin_booking_decision_mutation_v1();

alter table public.superadmin_booking_decisions enable row level security;
revoke all on table public.superadmin_booking_decisions
  from public, anon, authenticated;
grant select, insert on table public.superadmin_booking_decisions to service_role;

-- Read-only accounting classification shared by preview and the locked
-- executor. A caller must still re-run it after acquiring mutation locks.
create or replace function public.classify_superadmin_booking_accounting_v1(
  p_booking_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_reservation public.wallet_reservations;
  v_capture public.wallet_ledger_entries;
  v_reservation_count integer := 0;
  v_capture_count integer := 0;
  v_booking_ledger_count integer := 0;
  v_refund_count integer := 0;
  v_refund_amount bigint := 0;
  v_refund_account_count integer := 0;
  v_hold_net bigint := 0;
  v_expected_amount bigint;
  v_account_hold bigint;
  v_account_currency text;
  v_state text;
begin
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  if v_booking.user_payable_amount is not null
     and v_booking.user_payable_amount > 0 then
    v_expected_amount := v_booking.user_payable_amount;
  else
    begin
      v_expected_amount := round(
        (v_booking.pricing_snapshot->>'sellingPrice')::numeric * 100
      )::bigint;
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'INVALID_USER_PAYABLE');
    end;
  end if;
  if v_expected_amount is null or v_expected_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_USER_PAYABLE');
  end if;

  select count(*)::integer into v_reservation_count
    from public.wallet_reservations reservation
   where reservation.booking_id = v_booking.id
      or (reservation.booking_id is null
        and reservation.booking_attempt_id = v_booking.attempt_id);
  if v_reservation_count > 1 then
    return jsonb_build_object('ok', false, 'code', 'MULTIPLE_RESERVATIONS');
  end if;
  if v_reservation_count = 1 then
    select reservation.* into v_reservation
      from public.wallet_reservations reservation
     where reservation.booking_id = v_booking.id
        or (reservation.booking_id is null
          and reservation.booking_attempt_id = v_booking.attempt_id)
     order by reservation.booking_id nulls last
     limit 1;
  end if;

  select count(*)::integer into v_booking_ledger_count
    from public.wallet_ledger_entries ledger
   where ledger.booking_id = v_booking.id
     and ledger.transaction_type in (
       'booking_hold', 'booking_confirm', 'hold_release', 'refund'
     );

  select count(*)::integer into v_capture_count
    from public.wallet_ledger_entries ledger
   where ledger.booking_id = v_booking.id
     and ledger.transaction_type = 'booking_confirm';
  if v_capture_count > 1 then
    return jsonb_build_object('ok', false, 'code', 'MULTIPLE_CAPTURE_LEDGER_ENTRIES');
  end if;
  if v_capture_count = 1 then
    select ledger.* into v_capture
      from public.wallet_ledger_entries ledger
     where ledger.booking_id = v_booking.id
       and ledger.transaction_type = 'booking_confirm';
  end if;

  select count(*)::integer,
         coalesce(sum(ledger.amount), 0)::bigint,
         count(distinct ledger.wallet_account_id)::integer
    into v_refund_count, v_refund_amount, v_refund_account_count
    from public.wallet_ledger_entries ledger
   where ledger.booking_id = v_booking.id
     and ledger.transaction_type = 'refund';

  if v_capture_count = 1 then
    if v_capture.amount <> v_expected_amount
       or v_capture.currency is distinct from upper(v_booking.currency)
       or not (
         (v_capture.available_before - v_capture.available_after = v_capture.amount
           and v_capture.hold_before = v_capture.hold_after)
         or
         (v_capture.available_before = v_capture.available_after
           and v_capture.hold_before - v_capture.hold_after = v_capture.amount)
       )
       or v_refund_amount > v_capture.amount
       or (v_refund_count > 0 and (
         v_refund_account_count <> 1
         or exists (
           select 1 from public.wallet_ledger_entries refund
            where refund.booking_id = v_booking.id
              and refund.transaction_type = 'refund'
              and (refund.wallet_account_id <> v_capture.wallet_account_id
                or refund.currency <> v_capture.currency)
         )
       ))
       or (v_booking.charged_wallet_account_id is not null
         and v_booking.charged_wallet_account_id <> v_capture.wallet_account_id)
       or (v_reservation.id is not null and (
         v_reservation.id is distinct from v_capture.reservation_id
         or v_reservation.wallet_account_id <> v_capture.wallet_account_id
         or v_reservation.amount <> v_capture.amount
         or v_reservation.currency <> v_capture.currency
         or v_reservation.state <> 'captured'
       )) then
      return jsonb_build_object('ok', false, 'code', 'CAPTURE_ACCOUNTING_CONFLICT');
    end if;
    v_state := 'paid';
    return jsonb_build_object(
      'ok', true,
      'accountingState', v_state,
      'expectedAmount', v_expected_amount,
      'currency', upper(v_booking.currency),
      'reservationId', v_reservation.id,
      'reservationState', v_reservation.state,
      'walletAccountId', v_capture.wallet_account_id,
      'capturedAmount', v_capture.amount,
      'refundedAmount', v_refund_amount,
      'outstandingAmount', v_capture.amount - v_refund_amount,
      'paymentStateObserved', v_booking.payment_state,
      'paymentStateStale', v_booking.payment_state is distinct from case
        when v_refund_amount = v_capture.amount then 'refunded'
        when v_refund_amount > 0 then 'partially-refunded'
        else 'captured'
      end
    );
  end if;

  if v_refund_count > 0
     or v_booking.captured_amount > 0
     or v_booking.refunded_amount > 0
     or v_booking.payment_state in ('captured', 'partially-refunded', 'refunded') then
    return jsonb_build_object('ok', false, 'code', 'CAPTURE_LEDGER_MISSING');
  end if;

  if v_reservation.id is not null then
    select coalesce(sum(case
      when ledger.transaction_type = 'booking_hold' then ledger.amount
      when ledger.transaction_type = 'hold_release' then -ledger.amount
      when ledger.transaction_type = 'booking_confirm'
       and ledger.hold_before - ledger.hold_after = ledger.amount
        then -ledger.amount
      else 0
    end), 0)::bigint into v_hold_net
      from public.wallet_ledger_entries ledger
     where ledger.reservation_id = v_reservation.id;

    select account.hold_balance, account.currency
      into v_account_hold, v_account_currency
      from public.wallet_accounts account
     where account.id = v_reservation.wallet_account_id;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
    end if;

    if v_reservation.state in ('active', 'reconciliation') then
      if v_reservation.amount <> v_expected_amount
         or v_reservation.currency <> upper(v_booking.currency)
         or v_account_currency <> v_reservation.currency
         or v_hold_net <> v_reservation.amount
         or v_account_hold < v_reservation.amount
         or (v_booking.charged_wallet_account_id is not null
           and v_booking.charged_wallet_account_id
             <> v_reservation.wallet_account_id) then
        return jsonb_build_object('ok', false, 'code', 'ACTIVE_HOLD_ACCOUNTING_CONFLICT');
      end if;
      v_state := 'active_hold';
      return jsonb_build_object(
        'ok', true,
        'accountingState', v_state,
        'expectedAmount', v_expected_amount,
        'currency', upper(v_booking.currency),
        'reservationId', v_reservation.id,
        'reservationState', v_reservation.state,
        'walletAccountId', v_reservation.wallet_account_id,
        'capturedAmount', 0,
        'refundedAmount', 0,
        'outstandingAmount', 0,
        'paymentStateObserved', v_booking.payment_state,
        'paymentStateStale', v_booking.payment_state not in ('held', 'reconciliation')
      );
    elsif v_reservation.state = 'released' then
      if v_hold_net <> 0 then
        return jsonb_build_object('ok', false, 'code', 'RELEASE_ACCOUNTING_CONFLICT');
      end if;
    elsif v_reservation.state = 'captured' then
      return jsonb_build_object('ok', false, 'code', 'CAPTURE_LEDGER_MISSING');
    else
      return jsonb_build_object('ok', false, 'code', 'UNKNOWN_RESERVATION_STATE');
    end if;
  elsif v_booking_ledger_count > 0 then
    return jsonb_build_object('ok', false, 'code', 'RESERVATION_LEDGER_MISMATCH');
  end if;

  return jsonb_build_object(
    'ok', true,
    'accountingState', 'unpaid',
    'expectedAmount', v_expected_amount,
    'currency', upper(v_booking.currency),
    'reservationId', v_reservation.id,
    'reservationState', v_reservation.state,
    'walletAccountId', v_reservation.wallet_account_id,
    'capturedAmount', 0,
    'refundedAmount', 0,
    'outstandingAmount', 0,
    'paymentStateObserved', v_booking.payment_state,
    'paymentStateStale', v_booking.payment_state <> case
      when v_reservation.state = 'released' then 'released' else 'unpaid' end
  );
end;
$$;

create or replace function public.preview_superadmin_booking_decision_v1(
  p_booking_id uuid,
  p_actor_user_id text,
  p_decision text,
  p_refund_disposition text,
  p_refund_amount bigint,
  p_external_settlement_reference text,
  p_new_deadline_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_booking public.flight_bookings;
  v_accounting jsonb;
  v_state text;
  v_wallet_effect text := 'none';
  v_wallet_amount bigint := 0;
  v_outstanding bigint := 0;
  v_to_status text;
begin
  select app_user.role into v_actor_role
    from public.app_users app_user
   where app_user.clerk_id = p_actor_user_id;
  if v_actor_role is distinct from 'superadmin' then
    return jsonb_build_object('ok', false, 'code', 'SUPERADMIN_DECISION_FORBIDDEN');
  end if;
  if p_decision is null or p_decision not in (
    'confirm_ticketed', 'cancel', 'keep_on_hold',
    'extend_deadline', 'close_without_change'
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUPERADMIN_DECISION');
  end if;
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  v_accounting := public.classify_superadmin_booking_accounting_v1(p_booking_id);
  if coalesce((v_accounting->>'ok')::boolean, false) is not true then
    return v_accounting;
  end if;
  v_state := v_accounting->>'accountingState';
  v_outstanding := coalesce((v_accounting->>'outstandingAmount')::bigint, 0);

  if p_decision = 'confirm_ticketed' then
    v_to_status := 'confirmed';
    v_wallet_effect := case v_state
      when 'paid' then 'none'
      when 'active_hold' then 'capture_hold'
      when 'unpaid' then 'direct_charge'
      else 'accounting_conflict'
    end;
    v_wallet_amount := case when v_state = 'paid' then 0
      else (v_accounting->>'expectedAmount')::bigint end;
  elsif p_decision = 'cancel' then
    v_to_status := 'cancelled';
    if v_state = 'active_hold' then
      v_wallet_effect := 'release_hold';
      v_wallet_amount := (v_accounting->>'expectedAmount')::bigint;
    elsif v_state = 'unpaid' then
      v_wallet_effect := 'none';
    elsif v_state = 'paid' and v_outstanding = 0 then
      v_wallet_effect := 'none';
    elsif v_state = 'paid' then
      if p_refund_disposition is null or p_refund_disposition not in (
        'full_refund', 'partial_refund', 'no_refund_due', 'externally_settled'
      ) then
        return jsonb_build_object('ok', false, 'code', 'REFUND_DECISION_REQUIRED');
      end if;
      if p_refund_disposition = 'full_refund' then
        v_wallet_effect := 'refund';
        v_wallet_amount := v_outstanding;
      elsif p_refund_disposition = 'partial_refund' then
        if p_refund_amount is null or p_refund_amount <= 0
           or p_refund_amount >= v_outstanding then
          return jsonb_build_object('ok', false, 'code', 'INVALID_PARTIAL_REFUND');
        end if;
        v_wallet_effect := 'refund';
        v_wallet_amount := p_refund_amount;
      elsif p_refund_disposition = 'no_refund_due' then
        v_wallet_effect := 'no_refund';
      else
        if nullif(btrim(coalesce(p_external_settlement_reference, '')), '') is null then
          return jsonb_build_object('ok', false, 'code', 'SETTLEMENT_REFERENCE_REQUIRED');
        end if;
        v_wallet_effect := 'externally_settled';
      end if;
    end if;
  elsif p_decision in ('keep_on_hold', 'extend_deadline') then
    if v_state = 'paid' then
      return jsonb_build_object('ok', false, 'code', 'PAID_BOOKING_CANNOT_BE_HELD');
    end if;
    if p_decision = 'keep_on_hold'
       and v_booking.ticketing_deadline_at is not null
       and v_booking.ticketing_deadline_at <= clock_timestamp() then
      return jsonb_build_object(
        'ok', false, 'code', 'EXPIRED_REQUIRES_DEADLINE_EXTENSION'
      );
    end if;
    if p_decision = 'extend_deadline'
       and (p_new_deadline_at is null or p_new_deadline_at <= clock_timestamp()) then
      return jsonb_build_object('ok', false, 'code', 'FUTURE_DEADLINE_REQUIRED');
    end if;
    v_to_status := 'on-hold';
    v_wallet_effect := 'preserve';
  else
    v_to_status := v_booking.status;
    v_wallet_effect := 'none';
  end if;

  return jsonb_build_object(
    'ok', true,
    'bookingId', v_booking.id,
    'bookingReference', v_booking.public_ref,
    'decision', p_decision,
    'fromStoredStatus', v_booking.status,
    'fromLifecycleStatus', public.resolve_booking_lifecycle(
      v_booking.status, v_booking.airlines_pnr,
      v_booking.ticketing_deadline_at, v_booking.operation_kind
    ),
    'toStoredStatus', v_to_status,
    'walletEffect', v_wallet_effect,
    'walletAmount', v_wallet_amount,
    'currency', v_accounting->>'currency',
    'accounting', v_accounting,
    'refundDisposition', p_refund_disposition,
    'newDeadlineAt', p_new_deadline_at
  );
end;
$$;

create or replace function public.execute_superadmin_booking_decision_v1(
  p_booking_id uuid,
  p_actor_user_id text,
  p_request_key text,
  p_decision text,
  p_refund_disposition text,
  p_refund_amount bigint,
  p_external_settlement_reference text,
  p_new_deadline_at timestamptz,
  p_note text,
  p_money_movement_confirmed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_booking public.flight_bookings;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_existing public.superadmin_booking_decisions;
  v_preview jsonb;
  v_accounting jsonb;
  v_accounting_state text;
  v_wallet_effect text;
  v_amount bigint;
  v_available_before bigint;
  v_hold_before bigint;
  v_from_lifecycle text;
  v_to_status text;
  v_payment_after text;
  v_event_id bigint;
  v_occurrence_number integer;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_booking_id is null
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or nullif(btrim(coalesce(p_request_key, '')), '') is null
     or p_request_key !~ '^superadmin-booking-decision:v1:[0-9a-f-]{36}$'
     or char_length(p_request_key) > 220
     or p_decision is null
     or p_decision not in (
       'confirm_ticketed', 'cancel', 'keep_on_hold',
       'extend_deadline', 'close_without_change'
     )
     or char_length(coalesce(p_note, '')) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUPERADMIN_DECISION');
  end if;
  select app_user.role into v_actor_role
    from public.app_users app_user
   where app_user.clerk_id = p_actor_user_id;
  if v_actor_role is distinct from 'superadmin' then
    return jsonb_build_object('ok', false, 'code', 'SUPERADMIN_DECISION_FORBIDDEN');
  end if;

  -- The booking lock serializes decisions for one booking. The globally unique
  -- request key then makes exact retries safe across bookings as well.
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select decision.* into v_existing
    from public.superadmin_booking_decisions decision
   where decision.request_key = p_request_key;
  if found then
    if v_existing.booking_id <> p_booking_id
       or v_existing.actor_user_id <> p_actor_user_id
       or v_existing.decision <> p_decision then
      return jsonb_build_object('ok', false, 'code', 'DECISION_IDEMPOTENCY_CONFLICT');
    end if;
    return v_existing.result || jsonb_build_object('ok', true, 'replay', true);
  end if;

  -- Preserve the established mutation lock order: booking -> operation ->
  -- case -> reservation -> wallet -> account.
  perform 1 from public.booking_operations operation
   where operation.booking_id = v_booking.id
     and operation.state in (
       'claimed', 'supplier_call_started',
       'awaiting_external_action', 'needs_reconciliation'
     )
   order by operation.id
   for update;
  perform 1 from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.subject_booking_id = v_booking.id
     and reconciliation_case.state in (
       'open', 'assigned', 'awaiting_supplier',
       'awaiting_finance', 'awaiting_approval'
     )
   order by reconciliation_case.id
   for update;
  select reservation.* into v_reservation
    from public.wallet_reservations reservation
   where reservation.booking_id = v_booking.id
      or (reservation.booking_id is null
        and reservation.booking_attempt_id = v_booking.attempt_id)
   order by reservation.booking_id nulls last
   limit 1
   for update;

  v_preview := public.preview_superadmin_booking_decision_v1(
    p_booking_id, p_actor_user_id, p_decision, p_refund_disposition,
    p_refund_amount, p_external_settlement_reference, p_new_deadline_at
  );
  if coalesce((v_preview->>'ok')::boolean, false) is not true then
    return v_preview;
  end if;
  v_accounting := v_preview->'accounting';
  v_accounting_state := v_accounting->>'accountingState';
  v_wallet_effect := v_preview->>'walletEffect';
  v_amount := coalesce((v_preview->>'walletAmount')::bigint, 0);
  v_to_status := v_preview->>'toStoredStatus';
  v_from_lifecycle := v_preview->>'fromLifecycleStatus';

  if v_wallet_effect in ('capture_hold', 'direct_charge', 'release_hold', 'refund')
     and p_money_movement_confirmed is not true then
    return jsonb_build_object(
      'ok', false, 'code', 'MONEY_MOVEMENT_CONFIRMATION_REQUIRED',
      'walletEffect', v_wallet_effect,
      'walletAmount', v_amount,
      'currency', v_accounting->>'currency'
    );
  end if;

  if v_wallet_effect in ('capture_hold', 'release_hold', 'refund') then
    if v_reservation.id is null
       or v_reservation.id::text is distinct from v_accounting->>'reservationId' then
      return jsonb_build_object('ok', false, 'code', 'RESERVATION_CHANGED');
    end if;
    select wallet.* into v_wallet
      from public.wallets wallet
      join public.wallet_accounts account on account.wallet_id = wallet.id
     where account.id = v_reservation.wallet_account_id
     for update of wallet;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'WALLET_OWNER_NOT_FOUND');
    end if;
    select account.* into v_account
      from public.wallet_accounts account
     where account.id = v_reservation.wallet_account_id
       and account.wallet_id = v_wallet.id
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
    end if;
  elsif v_wallet_effect = 'direct_charge' then
    if v_booking.booking_owner_type is null
       or v_booking.booking_owner_key is null then
      return jsonb_build_object('ok', false, 'code', 'BOOKING_OWNER_REQUIRED');
    end if;
    select wallet.* into v_wallet
      from public.wallets wallet
     where wallet.owner_type = v_booking.booking_owner_type
       and wallet.owner_key = v_booking.booking_owner_key
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'WALLET_OWNER_NOT_FOUND');
    end if;
    select account.* into v_account
      from public.wallet_accounts account
     where account.wallet_id = v_wallet.id
       and account.currency = upper(v_booking.currency)
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
    end if;
  end if;

  if v_wallet_effect in ('capture_hold', 'release_hold') then
    if v_reservation.state not in ('active', 'reconciliation')
       or v_account.currency <> v_reservation.currency
       or v_account.hold_balance < v_reservation.amount
       or v_reservation.amount <> v_amount then
      return jsonb_build_object('ok', false, 'code', 'ACTIVE_HOLD_CHANGED');
    end if;
    v_available_before := v_account.available_balance;
    v_hold_before := v_account.hold_balance;
    if v_wallet_effect = 'capture_hold' then
      update public.wallet_accounts
         set hold_balance = hold_balance - v_amount
       where id = v_account.id;
      update public.wallet_reservations
         set booking_id = v_booking.id,
             booking_attempt_id = null,
             state = 'captured',
             issued_by_user_id = p_actor_user_id,
             captured_at = v_now,
             reconciliation_at = null,
             reconciliation_reason = null
       where id = v_reservation.id;
      insert into public.wallet_ledger_entries (
        wallet_account_id, transaction_type, amount, currency,
        available_before, available_after, hold_before, hold_after,
        booking_id, booking_reference, reservation_id, idempotency_key,
        created_by_user_id, created_by_role, remarks, metadata
      ) values (
        v_account.id, 'booking_confirm', v_amount, v_account.currency,
        v_available_before, v_available_before,
        v_hold_before, v_hold_before - v_amount,
        v_booking.id, v_booking.public_ref, v_reservation.id,
        p_request_key || ':capture', p_actor_user_id, 'superadmin',
        coalesce(nullif(btrim(p_note), ''), 'Super Admin confirmed ticketed'),
        jsonb_build_object(
          'decision', p_decision, 'accountingSource', 'active_hold',
          'userPayableAmount', v_amount,
          'supplierGrossAmount', v_booking.supplier_gross_amount,
          'evidenceRequired', false
        )
      );
    else
      update public.wallet_accounts
         set available_balance = available_balance + v_amount,
             hold_balance = hold_balance - v_amount
       where id = v_account.id;
      update public.wallet_reservations
         set booking_id = v_booking.id,
             booking_attempt_id = null,
             state = 'released',
             released_at = v_now,
             release_reason = left(coalesce(nullif(btrim(p_note), ''),
               'Super Admin cancelled booking'), 1000),
             reconciliation_at = null,
             reconciliation_reason = null
       where id = v_reservation.id;
      insert into public.wallet_ledger_entries (
        wallet_account_id, transaction_type, amount, currency,
        available_before, available_after, hold_before, hold_after,
        booking_id, booking_reference, reservation_id, idempotency_key,
        created_by_user_id, created_by_role, remarks, metadata
      ) values (
        v_account.id, 'hold_release', v_amount, v_account.currency,
        v_available_before, v_available_before + v_amount,
        v_hold_before, v_hold_before - v_amount,
        v_booking.id, v_booking.public_ref, v_reservation.id,
        p_request_key || ':release', p_actor_user_id, 'superadmin',
        coalesce(nullif(btrim(p_note), ''), 'Super Admin cancelled booking'),
        jsonb_build_object(
          'decision', p_decision, 'accountingSource', 'active_hold',
          'userPayableAmount', v_amount, 'evidenceRequired', false
        )
      );
    end if;
  elsif v_wallet_effect = 'direct_charge' then
    if v_wallet.status <> 'active' then
      return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN');
    end if;
    if v_account.available_balance < v_amount then
      return jsonb_build_object(
        'ok', false, 'code', 'INSUFFICIENT_FUNDS',
        'available', v_account.available_balance,
        'required', v_amount, 'currency', v_account.currency
      );
    end if;
    v_available_before := v_account.available_balance;
    v_hold_before := v_account.hold_balance;
    update public.wallet_accounts
       set available_balance = available_balance - v_amount
     where id = v_account.id;
    if v_reservation.id is null then
      insert into public.wallet_reservations (
        wallet_account_id, booking_id, amount, currency, state, cycle,
        requested_by_user_id, issued_by_user_id, captured_at
      ) values (
        v_account.id, v_booking.id, v_amount, v_account.currency,
        'captured', 1, p_actor_user_id, p_actor_user_id, v_now
      ) returning * into v_reservation;
    else
      update public.wallet_reservations
         set booking_id = v_booking.id,
             booking_attempt_id = null,
             wallet_account_id = v_account.id,
             amount = v_amount,
             currency = v_account.currency,
             state = 'captured',
             cycle = cycle + 1,
             requested_by_user_id = p_actor_user_id,
             issued_by_user_id = p_actor_user_id,
             captured_at = v_now,
             released_at = null,
             release_reason = null,
             reconciliation_at = null,
             reconciliation_reason = null
       where id = v_reservation.id
       returning * into v_reservation;
    end if;
    insert into public.wallet_ledger_entries (
      wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after,
      booking_id, booking_reference, reservation_id, idempotency_key,
      created_by_user_id, created_by_role, remarks, metadata
    ) values (
      v_account.id, 'booking_confirm', v_amount, v_account.currency,
      v_available_before, v_available_before - v_amount,
      v_hold_before, v_hold_before,
      v_booking.id, v_booking.public_ref, v_reservation.id,
      p_request_key || ':charge', p_actor_user_id, 'superadmin',
      coalesce(nullif(btrim(p_note), ''), 'Super Admin confirmed ticketed'),
      jsonb_build_object(
        'decision', p_decision, 'accountingSource', 'direct_charge',
        'userPayableAmount', v_amount,
        'supplierGrossAmount', v_booking.supplier_gross_amount,
        'evidenceRequired', false
      )
    );
  elsif v_wallet_effect = 'refund' then
    if v_account.currency <> (v_accounting->>'currency')
       or v_account.id::text is distinct from v_accounting->>'walletAccountId'
       or v_amount <= 0
       or v_amount > (v_accounting->>'outstandingAmount')::bigint then
      return jsonb_build_object('ok', false, 'code', 'REFUND_ACCOUNTING_CHANGED');
    end if;
    v_available_before := v_account.available_balance;
    v_hold_before := v_account.hold_balance;
    update public.wallet_accounts
       set available_balance = available_balance + v_amount
     where id = v_account.id;
    insert into public.wallet_ledger_entries (
      wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after,
      booking_id, booking_reference, reservation_id, idempotency_key,
      created_by_user_id, created_by_role, remarks, metadata
    ) values (
      v_account.id, 'refund', v_amount, v_account.currency,
      v_available_before, v_available_before + v_amount,
      v_hold_before, v_hold_before,
      v_booking.id, v_booking.public_ref, v_reservation.id,
      p_request_key || ':refund', p_actor_user_id, 'superadmin',
      coalesce(nullif(btrim(p_note), ''), 'Super Admin cancellation refund'),
      jsonb_build_object(
        'decision', p_decision,
        'financialDisposition', p_refund_disposition,
        'accountingSource', 'captured_ledger',
        'evidenceRequired', false
      )
    );
  end if;

  -- Finish any superseded active operation without deleting it.
  if p_decision <> 'close_without_change' then
    update public.booking_operations
       set state = 'failed',
           completed_at = coalesce(completed_at, v_now),
           error_code = 'SUPERADMIN_DECISION_SUPERSEDED',
           error_message = 'Superseded by an explicit Super Admin booking decision',
           supplier_evidence = supplier_evidence || jsonb_build_object(
             'superAdminDecision', p_decision,
             'decisionRequestKey', p_request_key,
             'evidenceRequired', false,
             'walletEffect', v_wallet_effect
           )
     where booking_id = v_booking.id
       and state in (
         'claimed', 'supplier_call_started',
         'awaiting_external_action', 'needs_reconciliation'
       );
  end if;

  if p_decision = 'confirm_ticketed' then
    v_payment_after := case
      when v_accounting_state = 'paid' then case
        when (v_accounting->>'refundedAmount')::bigint
          = (v_accounting->>'capturedAmount')::bigint then 'refunded'
        when (v_accounting->>'refundedAmount')::bigint > 0 then 'partially-refunded'
        else 'captured' end
      else 'captured'
    end;
    update public.flight_bookings
       set status = 'confirmed',
           active_operation_id = null,
           operation_kind = null,
           operation_reason = null,
           operation_request_id = null,
           operation_actor_user_id = null,
           operation_started_at = null,
           operation_prior_status = null,
           charged_wallet_account_id = coalesce(
             case when v_account.id is not null then v_account.id end,
             nullif(v_accounting->>'walletAccountId', '')::uuid,
             charged_wallet_account_id
           ),
           payment_state = v_payment_after,
           payment_amount = (v_accounting->>'expectedAmount')::bigint,
           captured_amount = case when v_accounting_state = 'paid'
             then (v_accounting->>'capturedAmount')::bigint
             else (v_accounting->>'expectedAmount')::bigint end,
           refunded_amount = case when v_accounting_state = 'paid'
             then (v_accounting->>'refundedAmount')::bigint else 0 end,
           issued_by_user_id = p_actor_user_id,
           issued_at = coalesce(issued_at, v_now),
           booking_status = coalesce(nullif(booking_status, ''), 'Confirmed')
     where id = v_booking.id;
  elsif p_decision = 'cancel' then
    v_payment_after := case
      when v_wallet_effect = 'release_hold' then 'released'
      when v_accounting_state = 'unpaid' then 'unpaid'
      when v_accounting_state = 'paid' then case
        when (v_accounting->>'refundedAmount')::bigint +
          case when v_wallet_effect = 'refund' then v_amount else 0 end
          = (v_accounting->>'capturedAmount')::bigint then 'refunded'
        when (v_accounting->>'refundedAmount')::bigint +
          case when v_wallet_effect = 'refund' then v_amount else 0 end > 0
          then 'partially-refunded'
        else 'captured' end
      else v_booking.payment_state
    end;
    update public.flight_bookings
       set status = 'cancelled',
           active_operation_id = null,
           operation_kind = null,
           operation_reason = null,
           operation_request_id = null,
           operation_actor_user_id = null,
           operation_started_at = null,
           operation_prior_status = null,
           charged_wallet_account_id = coalesce(
             nullif(v_accounting->>'walletAccountId', '')::uuid,
             charged_wallet_account_id
           ),
           payment_state = v_payment_after,
           payment_amount = case when v_accounting_state = 'paid'
             then (v_accounting->>'capturedAmount')::bigint
             else payment_amount end,
           captured_amount = case when v_accounting_state = 'paid'
             then (v_accounting->>'capturedAmount')::bigint else 0 end,
           refunded_amount = case when v_accounting_state = 'paid'
             then (v_accounting->>'refundedAmount')::bigint +
               case when v_wallet_effect = 'refund' then v_amount else 0 end
             else 0 end,
           cancelled_at = coalesce(cancelled_at, v_now),
           cancelled_by = p_actor_user_id,
           cancel_reason = left(coalesce(nullif(btrim(p_note), ''),
             'Super Admin decision'), 1000)
     where id = v_booking.id;
  elsif p_decision in ('keep_on_hold', 'extend_deadline') then
    update public.flight_bookings
       set status = 'on-hold',
           active_operation_id = null,
           operation_kind = null,
           operation_reason = null,
           operation_request_id = null,
           operation_actor_user_id = null,
           operation_started_at = null,
           operation_prior_status = null,
           payment_state = case when v_accounting_state = 'active_hold'
             then 'held'
             when v_reservation.state = 'released' then 'released'
             else 'unpaid' end,
           charged_wallet_account_id = case
             when v_accounting_state = 'active_hold'
               then nullif(v_accounting->>'walletAccountId', '')::uuid
             else charged_wallet_account_id end,
           ticketing_deadline_at = case when p_decision = 'extend_deadline'
             then p_new_deadline_at else ticketing_deadline_at end,
           local_ticketing_deadline_at = case when p_decision = 'extend_deadline'
             then p_new_deadline_at else local_ticketing_deadline_at end,
           deadline_source = case when p_decision = 'extend_deadline'
             then 'local_approved' else deadline_source end
     where id = v_booking.id;
  end if;

  update public.booking_reconciliation_cases
     set state = case when p_decision = 'close_without_change'
       then 'closed_no_change' else 'resolved' end,
         resolution_outcome = 'superadmin_' || p_decision,
         resolution = jsonb_build_object(
           'version', 1,
           'resolutionKind', 'superadmin_booking_decision',
           'decision', p_decision,
           'decisionRequestKey', p_request_key,
           'actorRole', 'superadmin',
           'evidenceRequired', false,
           'accounting', v_accounting,
           'walletEffect', v_wallet_effect,
           'walletAmount', v_amount,
           'refundDisposition', p_refund_disposition,
           'externalSettlementReference', p_external_settlement_reference
         ),
         resolution_reason = nullif(btrim(p_note), ''),
         resolved_by_user_id = p_actor_user_id,
         resolved_at = v_now,
         closed_at = case when p_decision = 'close_without_change'
           then v_now else closed_at end,
         version = version + 1
   where subject_booking_id = v_booking.id
     and state in (
       'open', 'assigned', 'awaiting_supplier',
       'awaiting_finance', 'awaiting_approval'
     );

  if p_decision = 'close_without_change' then
    v_to_status := v_booking.status;
  end if;
  select count(*)::integer + 1 into v_occurrence_number
    from public.booking_status_events event
   where event.booking_id = v_booking.id
     and event.to_lifecycle_status = case v_to_status
       when 'confirmed' then 'confirmed'
       when 'cancelled' then 'cancelled'
       else public.resolve_booking_lifecycle(
         v_to_status, v_booking.airlines_pnr,
         case when p_decision = 'extend_deadline' then p_new_deadline_at
           else v_booking.ticketing_deadline_at end,
         case when p_decision = 'close_without_change'
           then v_booking.operation_kind else null end
       ) end;

  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, occurrence_number,
    effective_at, observed_at, event_snapshot, event_version
  ) values (
    v_booking.id, v_from_lifecycle,
    case v_to_status
      when 'confirmed' then 'confirmed'
      when 'cancelled' then 'cancelled'
      else public.resolve_booking_lifecycle(
        v_to_status, v_booking.airlines_pnr,
        case when p_decision = 'extend_deadline' then p_new_deadline_at
          else v_booking.ticketing_deadline_at end,
        case when p_decision = 'close_without_change'
          then v_booking.operation_kind else null end
      ) end,
    v_booking.status, v_to_status, null, null,
    p_actor_user_id, 'SuperAdminDecision',
    jsonb_build_object(
      'decision', p_decision,
      'actorRole', 'superadmin',
      'evidenceRequired', false,
      'accountingState', v_accounting_state,
      'walletEffect', v_wallet_effect,
      'walletAmount', v_amount
    ),
    p_request_key || ':status', v_occurrence_number,
    v_now, v_now,
    jsonb_strip_nulls(jsonb_build_object(
      'version', 1,
      'decision', p_decision,
      'walletEffect', v_wallet_effect,
      'walletAmount', v_amount,
      'currency', v_accounting->>'currency',
      'financialDisposition', p_refund_disposition,
      'newDeadlineAt', p_new_deadline_at,
      'notificationDisposition', case when p_decision = 'close_without_change'
        then 'audit_only' else null end,
      'suppressionReason', case when p_decision = 'close_without_change'
        then 'case_only_repair' else null end
    )), 1
  ) returning id into v_event_id;

  v_result := jsonb_build_object(
    'ok', true,
    'replay', false,
    'bookingId', v_booking.id,
    'bookingReference', v_booking.public_ref,
    'decision', p_decision,
    'bookingStatus', v_to_status,
    'walletEffect', v_wallet_effect,
    'walletAmount', v_amount,
    'currency', v_accounting->>'currency',
    'accountingStateBefore', v_accounting_state,
    'lifecycleEventId', v_event_id,
    'paymentState', v_payment_after
  );

  insert into public.superadmin_booking_decisions (
    booking_id, request_key, actor_user_id, actor_role, decision, note,
    request_snapshot, accounting_snapshot, result
  ) values (
    v_booking.id, p_request_key, p_actor_user_id, 'superadmin', p_decision,
    nullif(btrim(p_note), ''),
    jsonb_strip_nulls(jsonb_build_object(
      'decision', p_decision,
      'refundDisposition', p_refund_disposition,
      'refundAmount', p_refund_amount,
      'externalSettlementReference', p_external_settlement_reference,
      'newDeadlineAt', p_new_deadline_at,
      'moneyMovementConfirmed', p_money_movement_confirmed
    )),
    v_accounting, v_result
  );
  return v_result;
end;
$$;

revoke all on function public.classify_superadmin_booking_accounting_v1(uuid),
  public.preview_superadmin_booking_decision_v1(uuid,text,text,text,bigint,text,timestamptz),
  public.execute_superadmin_booking_decision_v1(uuid,text,text,text,text,bigint,text,timestamptz,text,boolean),
  public.deny_superadmin_booking_decision_mutation_v1()
  from public, anon, authenticated;
grant execute on function public.classify_superadmin_booking_accounting_v1(uuid),
  public.preview_superadmin_booking_decision_v1(uuid,text,text,text,bigint,text,timestamptz),
  public.execute_superadmin_booking_decision_v1(uuid,text,text,text,text,bigint,text,timestamptz,text,boolean)
  to service_role;

comment on table public.superadmin_booking_decisions is
  'Immutable one-step Super Admin booking decisions, including the reservation/ledger accounting snapshot and atomic result.';
comment on function public.classify_superadmin_booking_accounting_v1(uuid) is
  'Classifies paid, active-hold, or unpaid truth from a matching reservation and immutable ledger. payment_state is only a stale-state signal.';
comment on function public.preview_superadmin_booking_decision_v1(uuid,text,text,text,bigint,text,timestamptz) is
  'Read-only Super Admin decision preview showing the exact wallet effect without requiring supplier evidence.';
comment on function public.execute_superadmin_booking_decision_v1(uuid,text,text,text,text,bigint,text,timestamptz,text,boolean) is
  'Atomically applies one evidence-optional Super Admin booking decision. Actual reservation/ledger truth controls charge, capture, release, refund, or no movement; inconsistent accounting fails closed.';
