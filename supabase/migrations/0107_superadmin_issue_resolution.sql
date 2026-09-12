-- Super Admin resolution for stuck ordinary B2B/B2C Issue Now bookings.
--
-- This is deliberately separate from Instant Purchase, IMP/EXP, Manual Import,
-- deposits, and the generic maker-checker adjustment workflow. Proven local
-- reservation/ledger truth always uses the normal path. A manually verified
-- supplier exception never invents a reservation and records its own immutable
-- resolution plus a distinct append-only ledger entry.

-- 1. Distinct manual-resolution ledger vocabulary --------------------------

alter table public.wallet_ledger_entries
  drop constraint if exists wallet_ledger_entries_transaction_type_check;
alter table public.wallet_ledger_entries
  add constraint wallet_ledger_entries_transaction_type_check
  check (transaction_type in (
    'deposit', 'booking_hold', 'booking_confirm', 'hold_release', 'refund',
    'manual_credit', 'manual_debit', 'adjustment', 'reversal',
    'superadmin_resolution_credit',
    'superadmin_resolution_debit',
    'superadmin_resolution_hold_release',
    'superadmin_resolution_hold_capture'
  ));

-- 2. Durable Super Admin deadline authority --------------------------------

create table if not exists public.superadmin_booking_deadline_overrides (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.flight_bookings(id) on delete restrict,
  request_key text not null unique
    check (char_length(request_key) between 1 and 220),
  effective_deadline_at timestamptz not null,
  supplier_deadline_snapshot timestamptz,
  supplier_time_limit_snapshot text,
  actor_user_id text not null,
  actor_role text not null check (actor_role = 'superadmin'),
  note text,
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists superadmin_deadline_overrides_booking_created_idx
  on public.superadmin_booking_deadline_overrides (booking_id, created_at desc);

-- Forward declaration for the automatic preview functions below. The complete
-- body replaces this declaration after the manual-resolution schema exists.
create or replace function public.superadmin_issue_resolution_context_v2(
  p_booking_id uuid,
  p_actor_user_id text
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select jsonb_build_object('ok', false, 'code', 'SETUP_IN_PROGRESS')
$$;

alter table public.flight_bookings
  add column if not exists active_superadmin_deadline_override_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'flight_bookings_active_superadmin_deadline_override_fk'
  ) then
    alter table public.flight_bookings
      add constraint flight_bookings_active_superadmin_deadline_override_fk
      foreign key (active_superadmin_deadline_override_id)
      references public.superadmin_booking_deadline_overrides(id)
      on delete restrict not valid;
  end if;
end;
$$;

-- 5. Contextual automatic preview -------------------------------------------

create or replace function public.preview_superadmin_issue_resolution_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_supplier_outcome text,
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
  v_context jsonb;
  v_accounting jsonb;
  v_state text;
  v_effect text := 'none';
  v_amount bigint := 0;
  v_wallet jsonb;
  v_available_before bigint;
  v_available_after bigint;
  v_hold_before bigint;
  v_hold_after bigint;
  v_protected_hold bigint := 0;
  v_legacy_preview jsonb;
  v_to_status text;
begin
  v_context := public.superadmin_issue_resolution_context_v2(
    p_booking_id, p_actor_user_id
  );
  if coalesce((v_context->>'ok')::boolean, false) is not true then
    return v_context;
  end if;
  if p_supplier_outcome not in ('ticket_issued', 'still_valid', 'not_issued') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUPPLIER_OUTCOME');
  end if;
  v_accounting := v_context->'accounting';
  if coalesce((v_accounting->>'ok')::boolean, false) is not true then
    return jsonb_build_object(
      'ok', false, 'code', 'MANUAL_RESOLUTION_REQUIRED',
      'manualAllowed', true,
      'accounting', v_accounting,
      'context', v_context
    );
  end if;
  v_state := v_accounting->>'accountingState';
  v_wallet := v_context->'wallet';
  v_available_before := coalesce((v_wallet->>'availableBalance')::bigint, 0);
  v_hold_before := coalesce((v_wallet->>'holdBalance')::bigint, 0);
  v_available_after := v_available_before;
  v_hold_after := v_hold_before;
  if v_state = 'active_hold' then
    select coalesce(sum(reservation.amount), 0)::bigint
      into v_protected_hold
      from public.wallet_reservations reservation
     where reservation.wallet_account_id =
         (v_accounting->>'walletAccountId')::uuid
       and reservation.state in ('active', 'reconciliation')
       and reservation.id <> (v_accounting->>'reservationId')::uuid;
    if v_hold_before <
       (v_accounting->>'expectedAmount')::bigint + v_protected_hold then
      return jsonb_build_object(
        'ok', false, 'code', 'ACTIVE_HOLD_ACCOUNTING_CONFLICT',
        'hold', v_hold_before,
        'bookingHold', (v_accounting->>'expectedAmount')::bigint,
        'protectedHold', v_protected_hold
      );
    end if;
  end if;

  if p_supplier_outcome = 'ticket_issued' then
    v_to_status := 'confirmed';
    if v_state = 'paid' then
      v_effect := 'none';
    elsif v_state = 'active_hold' then
      v_effect := 'capture_hold';
      v_amount := (v_accounting->>'expectedAmount')::bigint;
      v_hold_after := v_hold_before - v_amount;
    else
      return jsonb_build_object(
        'ok', false, 'code', 'MANUAL_RESOLUTION_REQUIRED',
        'manualAllowed', true,
        'reason', 'NO_LOCAL_CAPTURE_SOURCE',
        'accounting', v_accounting,
        'context', v_context
      );
    end if;
  elsif p_supplier_outcome = 'still_valid' then
    v_to_status := 'on-hold';
    if v_state = 'paid' then
      return jsonb_build_object('ok', false, 'code', 'PAID_BOOKING_CANNOT_BE_HELD');
    elsif v_state = 'active_hold' then
      v_effect := 'release_hold';
      v_amount := (v_accounting->>'expectedAmount')::bigint;
      v_available_after := v_available_before + v_amount;
      v_hold_after := v_hold_before - v_amount;
    end if;
    if (v_context->>'lifecycleStatus') = 'expired'
       and p_new_deadline_at is null then
      return jsonb_build_object('ok', false, 'code', 'FUTURE_DEADLINE_REQUIRED');
    end if;
    if p_new_deadline_at is not null
       and p_new_deadline_at <= clock_timestamp() then
      return jsonb_build_object('ok', false, 'code', 'FUTURE_DEADLINE_REQUIRED');
    end if;
  else
    v_to_status := 'cancelled';
    if v_state = 'active_hold' then
      v_effect := 'release_hold';
      v_amount := (v_accounting->>'expectedAmount')::bigint;
      v_available_after := v_available_before + v_amount;
      v_hold_after := v_hold_before - v_amount;
    elsif v_state = 'paid' then
      v_legacy_preview := public.preview_superadmin_booking_decision_v1(
        p_booking_id, p_actor_user_id, 'cancel', p_refund_disposition,
        p_refund_amount, p_external_settlement_reference, null
      );
      if coalesce((v_legacy_preview->>'ok')::boolean, false) is not true then
        return v_legacy_preview;
      end if;
      v_effect := v_legacy_preview->>'walletEffect';
      v_amount := coalesce((v_legacy_preview->>'walletAmount')::bigint, 0);
      if v_effect = 'refund' then
        v_available_after := v_available_before + v_amount;
      end if;
    end if;
  end if;

  if v_effect in ('capture_hold', 'release_hold')
     and (v_wallet is null or nullif(v_wallet->>'accountId', '') is null) then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;

  return jsonb_build_object(
    'ok', true,
    'mode', 'automatic_local_accounting',
    'bookingId', v_context->>'bookingId',
    'bookingReference', v_context->>'bookingReference',
    'fromStatus', v_context->>'bookingStatus',
    'fromLifecycleStatus', v_context->>'lifecycleStatus',
    'toStatus', v_to_status,
    'supplierOutcome', p_supplier_outcome,
    'walletEffect', v_effect,
    'walletAmount', v_amount,
    'currency', v_accounting->>'currency',
    'availableBefore', v_available_before,
    'availableAfter', v_available_after,
    'holdBefore', v_hold_before,
    'holdAfter', v_hold_after,
    'protectedHold', v_protected_hold,
    'newDeadlineAt', p_new_deadline_at,
    'accounting', v_accounting,
    'wallet', v_wallet,
    'manualAllowed', false
  );
end;
$$;

-- Normal restore/cancel when local truth is either a real Hold or proven no
-- financial footprint. Restore intentionally releases an Issue Now Hold.
create or replace function public.execute_superadmin_hold_outcome_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_request_key text,
  p_supplier_outcome text,
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
  v_booking public.flight_bookings;
  v_existing public.superadmin_booking_decisions;
  v_preview jsonb;
  v_accounting jsonb;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_amount bigint := 0;
  v_effect text;
  v_before_available bigint;
  v_before_hold bigint;
  v_to_status text;
  v_from_lifecycle text;
  v_after_lifecycle text;
  v_event_id bigint;
  v_occurrence integer;
  v_override_id uuid;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_supplier_outcome not in ('still_valid', 'not_issued')
     or p_request_key !~ '^superadmin-booking-decision:v1:[0-9a-f-]{36}$'
     or char_length(coalesce(p_note, '')) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUPERADMIN_DECISION');
  end if;
  select * into v_booking from public.flight_bookings
   where id = p_booking_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select * into v_existing from public.superadmin_booking_decisions
   where request_key = p_request_key;
  if found then
    if v_existing.booking_id <> p_booking_id
       or v_existing.actor_user_id <> p_actor_user_id then
      return jsonb_build_object('ok', false, 'code', 'DECISION_IDEMPOTENCY_CONFLICT');
    end if;
    return v_existing.result || jsonb_build_object('ok', true, 'replay', true);
  end if;

  perform 1 from public.booking_operations operation
   where operation.booking_id = p_booking_id
     and operation.state in (
       'claimed', 'supplier_call_started',
       'awaiting_external_action', 'needs_reconciliation'
     ) order by operation.id for update;
  perform 1 from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.subject_booking_id = p_booking_id
     and reconciliation_case.state in (
       'open', 'assigned', 'awaiting_supplier',
       'awaiting_finance', 'awaiting_approval'
     ) order by reconciliation_case.id for update;
  select * into v_reservation from public.wallet_reservations reservation
   where reservation.booking_id = p_booking_id
      or (reservation.booking_id is null
        and reservation.booking_attempt_id = v_booking.attempt_id)
   order by reservation.booking_id nulls last limit 1 for update;

  v_preview := public.preview_superadmin_issue_resolution_v2(
    p_booking_id, p_actor_user_id, p_supplier_outcome,
    null, null, null, p_new_deadline_at
  );
  if coalesce((v_preview->>'ok')::boolean, false) is not true then
    return v_preview;
  end if;
  v_accounting := v_preview->'accounting';
  if v_accounting->>'accountingState' not in ('active_hold', 'unpaid') then
    return jsonb_build_object('ok', false, 'code', 'ACCOUNTING_STATE_CHANGED');
  end if;
  v_effect := v_preview->>'walletEffect';
  v_amount := coalesce((v_preview->>'walletAmount')::bigint, 0);
  if v_effect = 'release_hold' and p_money_movement_confirmed is not true then
    return jsonb_build_object(
      'ok', false, 'code', 'MONEY_MOVEMENT_CONFIRMATION_REQUIRED'
    );
  end if;

  if v_effect = 'release_hold' then
    if v_reservation.id is null
       or v_reservation.id::text is distinct from v_accounting->>'reservationId'
       or v_reservation.state not in ('active', 'reconciliation')
       or v_reservation.amount <> v_amount then
      return jsonb_build_object('ok', false, 'code', 'RESERVATION_CHANGED');
    end if;
    select wallet.* into v_wallet from public.wallets wallet
      join public.wallet_accounts account on account.wallet_id = wallet.id
     where account.id = v_reservation.wallet_account_id for update of wallet;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'WALLET_OWNER_NOT_FOUND');
    end if;
    select * into v_account from public.wallet_accounts account
     where account.id = v_reservation.wallet_account_id
       and account.wallet_id = v_wallet.id for update;
    if not found or v_account.hold_balance < v_amount then
      return jsonb_build_object('ok', false, 'code', 'ACTIVE_HOLD_CHANGED');
    end if;
    v_before_available := v_account.available_balance;
    v_before_hold := v_account.hold_balance;
    update public.wallet_accounts set
      available_balance = available_balance + v_amount,
      hold_balance = hold_balance - v_amount
    where id = v_account.id;
    update public.wallet_reservations set
      booking_id = v_booking.id, booking_attempt_id = null,
      state = 'released', released_at = v_now,
      release_reason = left(coalesce(nullif(btrim(p_note), ''),
        'Super Admin Issue Now resolution'), 1000),
      reconciliation_at = null, reconciliation_reason = null
    where id = v_reservation.id;
    insert into public.wallet_ledger_entries (
      wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after,
      booking_id, booking_reference, reservation_id, idempotency_key,
      created_by_user_id, created_by_role, remarks, metadata
    ) values (
      v_account.id, 'hold_release', v_amount, v_account.currency,
      v_before_available, v_before_available + v_amount,
      v_before_hold, v_before_hold - v_amount,
      v_booking.id, v_booking.public_ref, v_reservation.id,
      p_request_key || ':release', p_actor_user_id, 'superadmin',
      coalesce(nullif(btrim(p_note), ''), 'Super Admin Issue Now resolution'),
      jsonb_build_object(
        'resolutionMode', 'automatic_local_accounting',
        'supplierOutcome', p_supplier_outcome,
        'evidenceRequired', false
      )
    );
  end if;

  v_from_lifecycle := public.resolve_superadmin_issue_lifecycle_v2(
    v_booking.status, v_booking.legacy_operational, v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, v_booking.operation_kind
  );
  v_to_status := case when p_supplier_outcome = 'still_valid'
    then 'on-hold' else 'cancelled' end;
  if p_supplier_outcome = 'still_valid' and p_new_deadline_at is not null then
    insert into public.superadmin_booking_deadline_overrides (
      booking_id, request_key, effective_deadline_at,
      supplier_deadline_snapshot, supplier_time_limit_snapshot,
      actor_user_id, actor_role, note
    ) values (
      v_booking.id, p_request_key || ':deadline', p_new_deadline_at,
      v_booking.supplier_ticketing_deadline_at,
      v_booking.supplier_ticketing_time_limit,
      p_actor_user_id, 'superadmin', nullif(btrim(p_note), '')
    ) returning id into v_override_id;
  end if;

  update public.booking_operations set
    state = 'failed', completed_at = coalesce(completed_at, v_now),
    error_code = 'SUPERADMIN_DECISION_SUPERSEDED',
    error_message = 'Superseded by an explicit Super Admin Issue Now resolution',
    supplier_evidence = supplier_evidence || jsonb_build_object(
      'supplierOutcome', p_supplier_outcome,
      'decisionRequestKey', p_request_key,
      'evidenceRequired', false, 'walletEffect', v_effect
    )
  where booking_id = v_booking.id
    and state in (
      'claimed', 'supplier_call_started',
      'awaiting_external_action', 'needs_reconciliation'
    );

  update public.flight_bookings set
    status = v_to_status,
    active_operation_id = null, operation_kind = null,
    operation_reason = null, operation_request_id = null,
    operation_actor_user_id = null, operation_started_at = null,
    operation_prior_status = null,
    charged_wallet_account_id = case when v_effect = 'release_hold'
      then v_account.id else charged_wallet_account_id end,
    payment_state = case when v_effect = 'release_hold' then 'released'
      when v_accounting->>'reservationState' = 'released' then 'released'
      else 'unpaid' end,
    active_superadmin_deadline_override_id = case
      when p_supplier_outcome = 'still_valid' and v_override_id is not null
        then v_override_id
      when p_supplier_outcome = 'not_issued' then null
      else active_superadmin_deadline_override_id end,
    local_ticketing_deadline_at = case
      when p_supplier_outcome = 'still_valid' and p_new_deadline_at is not null
        then p_new_deadline_at else local_ticketing_deadline_at end,
    ticketing_deadline_at = case
      when p_supplier_outcome = 'still_valid' and p_new_deadline_at is not null
        then p_new_deadline_at else ticketing_deadline_at end,
    deadline_source = case
      when p_supplier_outcome = 'still_valid' and p_new_deadline_at is not null
        then 'superadmin_override' else deadline_source end,
    cancelled_at = case when p_supplier_outcome = 'not_issued'
      then coalesce(cancelled_at, v_now) else cancelled_at end,
    cancelled_by = case when p_supplier_outcome = 'not_issued'
      then p_actor_user_id else cancelled_by end,
    cancel_reason = case when p_supplier_outcome = 'not_issued'
      then left(coalesce(nullif(btrim(p_note), ''),
        'Super Admin Issue Now resolution'), 1000) else cancel_reason end
  where id = v_booking.id;

  update public.booking_reconciliation_cases set
    state = 'resolved',
    resolution_outcome = 'superadmin_issue_' || p_supplier_outcome,
    resolution = jsonb_build_object(
      'version', 2, 'resolutionKind', 'superadmin_issue_resolution',
      'supplierOutcome', p_supplier_outcome,
      'decisionRequestKey', p_request_key,
      'evidenceRequired', false,
      'accounting', v_accounting,
      'walletEffect', v_effect, 'walletAmount', v_amount
    ),
    resolution_reason = nullif(btrim(p_note), ''),
    resolved_by_user_id = p_actor_user_id,
    resolved_at = v_now, version = version + 1
  where subject_booking_id = v_booking.id
    and state in (
      'open', 'assigned', 'awaiting_supplier',
      'awaiting_finance', 'awaiting_approval'
    );

  v_after_lifecycle := case when v_to_status = 'cancelled' then 'cancelled'
    else public.resolve_superadmin_issue_lifecycle_v2(
      v_to_status, v_booking.legacy_operational, v_booking.airlines_pnr,
      coalesce(p_new_deadline_at, v_booking.ticketing_deadline_at), null
    ) end;
  select count(*)::integer + 1 into v_occurrence
    from public.booking_status_events event
   where event.booking_id = v_booking.id
     and event.to_lifecycle_status = v_after_lifecycle;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after,
    actor_user_id, supplier_operation, supplier_evidence,
    idempotency_key, occurrence_number, effective_at, observed_at,
    event_snapshot, event_version
  ) values (
    v_booking.id, v_from_lifecycle, v_after_lifecycle,
    v_booking.status, v_to_status, p_actor_user_id,
    'SuperAdminIssueResolution', jsonb_build_object(
      'supplierOutcome', p_supplier_outcome, 'evidenceRequired', false,
      'walletEffect', v_effect, 'walletAmount', v_amount
    ), p_request_key || ':status', v_occurrence, v_now, v_now,
    jsonb_strip_nulls(jsonb_build_object(
      'version', 2, 'supplierOutcome', p_supplier_outcome,
      'walletEffect', v_effect, 'walletAmount', v_amount,
      'newDeadlineAt', p_new_deadline_at,
      'notificationDisposition', case
        when v_from_lifecycle = v_after_lifecycle then 'audit_only'
        else null end,
      'suppressionReason', case
        when v_from_lifecycle = v_after_lifecycle
          then 'superadmin_same_status_resolution' else null end
    )), 2
  ) returning id into v_event_id;

  v_result := jsonb_build_object(
    'ok', true, 'replay', false,
    'bookingId', v_booking.id, 'bookingReference', v_booking.public_ref,
    'supplierOutcome', p_supplier_outcome,
    'bookingStatus', v_to_status, 'walletEffect', v_effect,
    'walletAmount', v_amount, 'currency', v_accounting->>'currency',
    'accountingStateBefore', v_accounting->>'accountingState',
    'lifecycleEventId', v_event_id
  );
  insert into public.superadmin_booking_decisions (
    booking_id, request_key, actor_user_id, actor_role, decision, note,
    request_snapshot, accounting_snapshot, result
  ) values (
    v_booking.id, p_request_key, p_actor_user_id, 'superadmin',
    case when p_supplier_outcome = 'still_valid'
      then 'keep_on_hold' else 'cancel' end,
    nullif(btrim(p_note), ''),
    jsonb_strip_nulls(jsonb_build_object(
      'version', 2, 'supplierOutcome', p_supplier_outcome,
      'newDeadlineAt', p_new_deadline_at,
      'moneyMovementConfirmed', p_money_movement_confirmed
    )), v_accounting, v_result
  );
  insert into public.security_audit_events (
    actor_user_id, actor_role, action, target_type, target_id,
    outcome, metadata
  ) values (
    p_actor_user_id, 'superadmin', 'booking.superadmin_issue_resolution',
    'flight_booking', v_booking.id::text, 'succeeded',
    jsonb_build_object(
      'requestKey', p_request_key, 'supplierOutcome', p_supplier_outcome,
      'resolutionMode', 'automatic_local_accounting',
      'walletEffect', v_effect, 'walletAmount', v_amount
    )
  );
  return v_result;
end;
$$;


alter table public.flight_bookings
  drop constraint if exists flight_bookings_deadline_source_check;
alter table public.flight_bookings
  add constraint flight_bookings_deadline_source_check
  check (
    deadline_source is null
    or deadline_source in (
      'supplier', 'pnr_call', 'assumed', 'local_approved',
      'superadmin_override'
    )
  );

-- Retained rows keep legacy_operational=true and therefore remain excluded
-- from normal lifecycle views/workers. The explicit Super Admin resolver may,
-- however, store one of the modern decided outcomes on such a row.
alter table public.flight_bookings
  drop constraint if exists flight_bookings_status_check;
alter table public.flight_bookings
  add constraint flight_bookings_status_check
  check (
    (
      legacy_operational and status in (
        'draft', 'submitting', 'held', 'ticketed', 'failed', 'unknown',
        'on-hold', 'pending', 'in-progress', 'confirmed', 'cancelled'
      )
    )
    or (
      not legacy_operational and status in (
        'on-hold', 'pending', 'in-progress', 'confirmed', 'cancelled'
      )
    )
  );

create or replace function public.resolve_superadmin_issue_lifecycle_v2(
  p_status text,
  p_legacy_operational boolean,
  p_airlines_pnr jsonb,
  p_ticketing_deadline_at timestamptz,
  p_operation_kind text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when not p_legacy_operational then public.resolve_booking_lifecycle(
      p_status, p_airlines_pnr, p_ticketing_deadline_at, p_operation_kind
    )
    when p_status in ('ticketed', 'confirmed') then 'confirmed'
    when p_status in ('failed', 'cancelled') then 'cancelled'
    when p_status in ('submitting', 'unknown', 'in-progress')
      or p_operation_kind is not null then 'in-progress'
    when p_status in ('draft', 'pending') then 'pending'
    when p_status in ('held', 'on-hold')
      and not public.jsonb_is_nonempty_array(p_airlines_pnr) then 'unconfirmed'
    when p_status in ('held', 'on-hold')
      and p_ticketing_deadline_at is not null
      and p_ticketing_deadline_at <= now() then 'expired'
    else 'on-hold'
  end
$$;

create or replace function public.prevent_superadmin_resolution_mutation_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Super Admin resolution records are immutable'
    using errcode = '55000';
end;
$$;

drop trigger if exists superadmin_booking_deadline_overrides_immutable
  on public.superadmin_booking_deadline_overrides;
create trigger superadmin_booking_deadline_overrides_immutable
  before update or delete on public.superadmin_booking_deadline_overrides
  for each row execute function public.prevent_superadmin_resolution_mutation_v2();

-- An active Super Admin deadline is the effective deadline. Supplier writers
-- continue updating supplier_* columns and append-only observations, but cannot
-- overwrite the active local authority. Terminal booking state clears only the
-- active pointer; the immutable override remains readable.
create or replace function public.enforce_booking_deadline_authority_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_override_deadline timestamptz;
  v_local_authority_write boolean;
  v_explicit_supplier_write boolean;
  v_legacy_deadline_write boolean;
begin
  if new.status in ('confirmed', 'cancelled') then
    new.active_superadmin_deadline_override_id := null;
  end if;

  if tg_op = 'INSERT' then
    new.supplier_ticketing_time_limit := coalesce(
      new.supplier_ticketing_time_limit, new.ticketing_time_limit
    );
    new.supplier_ticketing_deadline_at := coalesce(
      new.supplier_ticketing_deadline_at, new.ticketing_deadline_at
    );
    new.supplier_deadline_source := coalesce(
      new.supplier_deadline_source, new.deadline_source, 'booking_create'
    );
  else
    v_local_authority_write :=
      new.active_local_time_limit_request_id is distinct from
        old.active_local_time_limit_request_id
      or new.local_ticketing_deadline_at is distinct from
        old.local_ticketing_deadline_at
      or new.active_superadmin_deadline_override_id is distinct from
        old.active_superadmin_deadline_override_id;
    v_explicit_supplier_write :=
      new.supplier_ticketing_time_limit is distinct from
        old.supplier_ticketing_time_limit
      or new.supplier_ticketing_deadline_at is distinct from
        old.supplier_ticketing_deadline_at
      or new.supplier_deadline_source is distinct from old.supplier_deadline_source;
    v_legacy_deadline_write :=
      new.ticketing_time_limit is distinct from old.ticketing_time_limit
      or new.ticketing_deadline_at is distinct from old.ticketing_deadline_at
      or new.deadline_source is distinct from old.deadline_source;

    if not v_local_authority_write
       and not v_explicit_supplier_write
       and v_legacy_deadline_write then
      new.supplier_ticketing_time_limit := new.ticketing_time_limit;
      new.supplier_ticketing_deadline_at := new.ticketing_deadline_at;
      new.supplier_deadline_source := coalesce(
        new.deadline_source, 'legacy_supplier_writer'
      );
    end if;
  end if;

  if new.active_superadmin_deadline_override_id is not null then
    select deadline_override.effective_deadline_at
      into v_override_deadline
      from public.superadmin_booking_deadline_overrides deadline_override
     where deadline_override.id = new.active_superadmin_deadline_override_id
       and deadline_override.booking_id = new.id;
    if not found then
      raise exception 'active Super Admin deadline override does not match booking'
        using errcode = '23514';
    end if;
    new.local_ticketing_deadline_at := v_override_deadline;
    new.ticketing_deadline_at := v_override_deadline;
    new.ticketing_time_limit := new.supplier_ticketing_time_limit;
    new.deadline_source := 'superadmin_override';
  elsif new.active_local_time_limit_request_id is not null then
    new.ticketing_deadline_at := new.local_ticketing_deadline_at;
    new.deadline_source := 'local_approved';
    new.ticketing_time_limit := new.supplier_ticketing_time_limit;
  elsif tg_op = 'UPDATE' and (
    v_local_authority_write or v_explicit_supplier_write or v_legacy_deadline_write
  ) then
    new.ticketing_time_limit := new.supplier_ticketing_time_limit;
    new.ticketing_deadline_at := new.supplier_ticketing_deadline_at;
    new.deadline_source := case
      when new.supplier_ticketing_deadline_at is null
        then coalesce(new.supplier_deadline_source, 'pnr_call')
      when new.supplier_deadline_source in ('supplier', 'pnr_call', 'assumed')
        then new.supplier_deadline_source
      else 'pnr_call'
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists flight_bookings_deadline_authority_v1
  on public.flight_bookings;
drop trigger if exists flight_bookings_deadline_authority_v2
  on public.flight_bookings;
create trigger flight_bookings_deadline_authority_v2
  before insert or update of
    status, ticketing_time_limit, ticketing_deadline_at, deadline_source,
    supplier_ticketing_time_limit, supplier_ticketing_deadline_at,
    supplier_deadline_source, local_ticketing_deadline_at,
    active_local_time_limit_request_id, active_superadmin_deadline_override_id
  on public.flight_bookings
  for each row execute function public.enforce_booking_deadline_authority_v2();

-- 3. Immutable manual financial resolution ---------------------------------

create table if not exists public.superadmin_manual_financial_resolutions (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.flight_bookings(id) on delete restrict,
  booking_reference text not null,
  request_key text not null unique
    check (char_length(request_key) between 1 and 220),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  wallet_id uuid not null references public.wallets(id) on delete restrict,
  wallet_account_id uuid not null references public.wallet_accounts(id) on delete restrict,
  wallet_owner_type text not null check (wallet_owner_type in ('user', 'agency')),
  wallet_owner_key text not null,
  customer_wallet_action text not null check (customer_wallet_action in (
    'none', 'credit_available', 'debit_available',
    'release_orphan_hold', 'capture_orphan_hold'
  )),
  customer_wallet_amount bigint not null check (customer_wallet_amount >= 0),
  customer_wallet_currency text not null check (customer_wallet_currency ~ '^[A-Z]{3}$'),
  customer_amount_basis text,
  available_before bigint not null check (available_before >= 0),
  available_after bigint not null check (available_after >= 0),
  hold_before bigint not null check (hold_before >= 0),
  hold_after bigint not null check (hold_after >= 0),
  supplier_outcome text not null check (supplier_outcome in (
    'ticket_issued', 'still_valid', 'not_issued'
  )),
  issue_now_case_confirmed boolean not null
    check (issue_now_case_confirmed),
  supplier_reference text,
  supplier_amount bigint check (supplier_amount is null or supplier_amount > 0),
  supplier_currency text check (
    supplier_currency is null or supplier_currency ~ '^[A-Z]{3}$'
  ),
  booking_result text not null check (booking_result in (
    'confirmed', 'on-hold', 'cancelled'
  )),
  accounting_conflict_code text,
  actor_user_id text not null,
  actor_role text not null check (actor_role = 'superadmin'),
  note text,
  verified_at timestamptz not null,
  ledger_entry_id uuid references public.wallet_ledger_entries(id) on delete restrict,
  lifecycle_event_id bigint references public.booking_status_events(id) on delete restrict,
  reverses_resolution_id uuid references public.superadmin_manual_financial_resolutions(id) on delete restrict,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  check (
    (customer_wallet_action = 'none' and customer_wallet_amount = 0 and ledger_entry_id is null)
    or
    (customer_wallet_action <> 'none' and customer_wallet_amount > 0 and ledger_entry_id is not null)
  ),
  check (
    (supplier_amount is null and supplier_currency is null)
    or (supplier_amount is not null and supplier_currency is not null)
  )
);

create index if not exists superadmin_manual_resolution_booking_created_idx
  on public.superadmin_manual_financial_resolutions (booking_id, created_at desc);
create index if not exists superadmin_manual_resolution_wallet_created_idx
  on public.superadmin_manual_financial_resolutions (wallet_account_id, created_at desc);
create unique index if not exists superadmin_manual_resolution_supplier_effect_key
  on public.superadmin_manual_financial_resolutions (
    booking_id, supplier_reference, customer_wallet_action
  )
  where supplier_reference is not null
    and customer_wallet_action <> 'none'
    and reverses_resolution_id is null;

drop trigger if exists superadmin_manual_financial_resolutions_immutable
  on public.superadmin_manual_financial_resolutions;
create trigger superadmin_manual_financial_resolutions_immutable
  before update or delete on public.superadmin_manual_financial_resolutions
  for each row execute function public.prevent_superadmin_resolution_mutation_v2();

alter table public.flight_bookings
  add column if not exists last_superadmin_manual_resolution_id uuid;
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'flight_bookings_last_superadmin_manual_resolution_fk'
  ) then
    alter table public.flight_bookings
      add constraint flight_bookings_last_superadmin_manual_resolution_fk
      foreign key (last_superadmin_manual_resolution_id)
      references public.superadmin_manual_financial_resolutions(id)
      on delete restrict not valid;
  end if;
end;
$$;

-- 4. Shared read-only context ------------------------------------------------

create or replace function public.superadmin_issue_resolution_context_v2(
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
  v_accounting jsonb;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_reservation_count integer := 0;
  v_ledger_count integer := 0;
  v_has_booking_owner boolean;
begin
  select role into v_role from public.app_users where clerk_id = p_actor_user_id;
  if v_role is distinct from 'superadmin' then
    return jsonb_build_object('ok', false, 'code', 'SUPERADMIN_DECISION_FORBIDDEN');
  end if;

  select * into v_booking from public.flight_bookings
   where id = p_booking_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  if lower(coalesce(v_booking.supplier, '')) <> 'triplover'
     or v_booking.import_source is not null
     or coalesce(v_booking.direct_ticketing, false)
     or coalesce(v_booking.audience, '') not in ('b2c', 'agency') then
    return jsonb_build_object('ok', false, 'code', 'ISSUE_RESOLUTION_SCOPE_FORBIDDEN');
  end if;
  v_has_booking_owner := coalesce(
    v_booking.booking_owner_type in ('user', 'agency'), false
  ) and nullif(btrim(v_booking.booking_owner_key), '') is not null;
  if v_booking.last_superadmin_manual_resolution_id is not null
     or v_booking.status in ('ticketed', 'failed', 'confirmed', 'cancelled') then
    return jsonb_build_object(
      'ok', false, 'code', 'ALREADY_RESOLVED',
      'bookingId', v_booking.id,
      'bookingReference', v_booking.public_ref,
      'bookingStatus', v_booking.status,
      'manualResolutionId', v_booking.last_superadmin_manual_resolution_id
    );
  end if;

  v_accounting := public.classify_superadmin_booking_accounting_v1(p_booking_id);

  -- A malformed historical price must not block a booking-only decision when
  -- the complete local footprint proves that no customer money moved.
  if coalesce(v_accounting->>'code', '') = 'INVALID_USER_PAYABLE' then
    select count(*)::integer into v_reservation_count
      from public.wallet_reservations reservation
     where reservation.booking_id = v_booking.id
        or (reservation.booking_id is null
          and reservation.booking_attempt_id = v_booking.attempt_id);
    select count(*)::integer into v_ledger_count
      from public.wallet_ledger_entries ledger
     where ledger.booking_id = v_booking.id
       and ledger.transaction_type in (
         'booking_hold', 'booking_confirm', 'hold_release', 'refund',
         'superadmin_resolution_credit', 'superadmin_resolution_debit',
         'superadmin_resolution_hold_release',
         'superadmin_resolution_hold_capture'
       );
    if v_reservation_count = 0 and v_ledger_count = 0
       and coalesce(v_booking.captured_amount, 0) = 0
       and coalesce(v_booking.refunded_amount, 0) = 0
       and v_booking.payment_state not in (
         'captured', 'partially-refunded', 'refunded', 'reconciliation'
       ) then
      v_accounting := jsonb_build_object(
        'ok', true, 'accountingState', 'unpaid',
        'accountingSource', 'proven_no_financial_footprint',
        'expectedAmount', null, 'currency', upper(v_booking.currency),
        'reservationId', null, 'reservationState', null,
        'walletAccountId', null, 'capturedAmount', 0,
        'refundedAmount', 0, 'outstandingAmount', 0,
        'paymentStateObserved', v_booking.payment_state,
        'paymentStateStale', v_booking.payment_state <> 'unpaid'
      );
    end if;
  end if;

  -- Ownerless retained history can still take a proven no-money booking-only
  -- Restore/Cancel decision. Any paid, held, conflicting, or manual financial
  -- case still requires a concrete B2B/B2C wallet owner.
  if not v_has_booking_owner and not (
    coalesce((v_accounting->>'ok')::boolean, false)
    and v_accounting->>'accountingState' = 'unpaid'
  ) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_OWNER_REQUIRED');
  end if;

  if v_has_booking_owner then
    select wallet.* into v_wallet from public.wallets wallet
     where wallet.owner_type = v_booking.booking_owner_type
       and wallet.owner_key = v_booking.booking_owner_key;
    if found then
      select account.* into v_account from public.wallet_accounts account
       where account.wallet_id = v_wallet.id
         and account.currency = upper(v_booking.currency);
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'bookingId', v_booking.id,
    'bookingReference', v_booking.public_ref,
    'bookingStatus', v_booking.status,
    'legacyOperational', v_booking.legacy_operational,
    'lifecycleStatus', public.resolve_superadmin_issue_lifecycle_v2(
      v_booking.status, v_booking.legacy_operational, v_booking.airlines_pnr,
      v_booking.ticketing_deadline_at, v_booking.operation_kind
    ),
    'currentDeadlineAt', v_booking.ticketing_deadline_at,
    'supplierDeadlineAt', v_booking.supplier_ticketing_deadline_at,
    'accounting', v_accounting,
    'wallet', case when v_wallet.id is null then null else jsonb_build_object(
      'walletId', v_wallet.id,
      'walletStatus', v_wallet.status,
      'ownerType', v_wallet.owner_type,
      'ownerKey', v_wallet.owner_key,
      'accountId', v_account.id,
      'currency', coalesce(v_account.currency, upper(v_booking.currency)),
      'availableBalance', v_account.available_balance,
      'holdBalance', v_account.hold_balance
    ) end,
    'manualAllowed', true
  );
end;
$$;

-- Manual preview keeps supplier facts and the customer-wallet decision in
-- separate arguments. No default or database expression copies one amount into
-- the other.
create or replace function public.preview_superadmin_manual_financial_resolution_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_supplier_outcome text,
  p_issue_now_case_confirmed boolean,
  p_customer_wallet_action text,
  p_customer_wallet_amount bigint,
  p_customer_amount_basis text,
  p_supplier_reference text,
  p_supplier_amount bigint,
  p_supplier_currency text,
  p_new_deadline_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_context jsonb;
  v_accounting jsonb;
  v_wallet jsonb;
  v_booking public.flight_bookings;
  v_matching_reservation public.wallet_reservations;
  v_matching_count integer := 0;
  v_protected_hold bigint := 0;
  v_resolvable_hold bigint := 0;
  v_available_before bigint;
  v_hold_before bigint;
  v_available_after bigint;
  v_hold_after bigint;
  v_booking_result text;
begin
  v_context := public.superadmin_issue_resolution_context_v2(
    p_booking_id, p_actor_user_id
  );
  if coalesce((v_context->>'ok')::boolean, false) is not true then
    return v_context;
  end if;
  if p_supplier_outcome not in ('ticket_issued', 'still_valid', 'not_issued') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUPPLIER_OUTCOME');
  end if;
  if p_issue_now_case_confirmed is not true then
    return jsonb_build_object('ok', false, 'code', 'ISSUE_NOW_CASE_CONFIRMATION_REQUIRED');
  end if;
  if p_customer_wallet_action not in (
    'none', 'credit_available', 'debit_available',
    'release_orphan_hold', 'capture_orphan_hold'
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_MANUAL_WALLET_ACTION');
  end if;
  if p_supplier_outcome = 'ticket_issued'
     and p_customer_wallet_action in ('credit_available', 'release_orphan_hold') then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_ACTION_OUTCOME_CONFLICT');
  end if;
  if p_supplier_outcome in ('still_valid', 'not_issued')
     and p_customer_wallet_action in ('debit_available', 'capture_orphan_hold') then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_ACTION_OUTCOME_CONFLICT');
  end if;
  if p_customer_wallet_action = 'none' then
    if coalesce(p_customer_wallet_amount, 0) <> 0 then
      return jsonb_build_object('ok', false, 'code', 'MANUAL_AMOUNT_NOT_ALLOWED');
    end if;
  elsif p_customer_wallet_amount is null or p_customer_wallet_amount <= 0
        or nullif(btrim(coalesce(p_customer_amount_basis, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_CUSTOMER_AMOUNT_REQUIRED');
  end if;
  if (p_supplier_amount is null) <> (p_supplier_currency is null) then
    return jsonb_build_object('ok', false, 'code', 'SUPPLIER_AMOUNT_PAIR_REQUIRED');
  end if;
  if p_supplier_amount is not null and (
    p_supplier_amount <= 0 or upper(p_supplier_currency) !~ '^[A-Z]{3}$'
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUPPLIER_AMOUNT');
  end if;

  v_accounting := v_context->'accounting';
  -- A complete normal state must use the normal lane. The one exception is a
  -- proven-no-money issued ticket, for which no normal Capture exists.
  if coalesce((v_accounting->>'ok')::boolean, false)
     and not (
       v_accounting->>'accountingState' = 'unpaid'
       and p_supplier_outcome = 'ticket_issued'
     ) then
    return jsonb_build_object(
      'ok', false, 'code', 'NORMAL_ACCOUNTING_AVAILABLE',
      'accounting', v_accounting
    );
  end if;

  v_wallet := v_context->'wallet';
  if v_wallet is null or nullif(v_wallet->>'accountId', '') is null then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;
  select * into v_booking from public.flight_bookings
   where id = p_booking_id;
  select count(*)::integer into v_matching_count
    from public.wallet_reservations reservation
   where reservation.booking_id = p_booking_id
      or (reservation.booking_id is null
        and reservation.booking_attempt_id = v_booking.attempt_id);
  if v_matching_count > 1 then
    return jsonb_build_object('ok', false, 'code', 'MULTIPLE_RESERVATIONS');
  elsif v_matching_count = 1 then
    select * into v_matching_reservation
      from public.wallet_reservations reservation
     where reservation.booking_id = p_booking_id
        or (reservation.booking_id is null
          and reservation.booking_attempt_id = v_booking.attempt_id)
     order by reservation.booking_id nulls last limit 1;
  end if;
  v_available_before := (v_wallet->>'availableBalance')::bigint;
  v_hold_before := (v_wallet->>'holdBalance')::bigint;
  select coalesce(sum(reservation.amount), 0)::bigint
    into v_protected_hold
    from public.wallet_reservations reservation
   where reservation.wallet_account_id = (v_wallet->>'accountId')::uuid
     and reservation.state in ('active', 'reconciliation')
     and (v_matching_reservation.id is null
       or reservation.id <> v_matching_reservation.id);
  v_resolvable_hold := v_hold_before - v_protected_hold;
  if v_resolvable_hold < 0 then
    return jsonb_build_object('ok', false, 'code', 'ACTIVE_HOLD_ACCOUNTING_CONFLICT');
  end if;
  if v_matching_reservation.id is not null
     and v_matching_reservation.state in ('active', 'reconciliation') then
    if v_matching_reservation.wallet_account_id
         <> (v_wallet->>'accountId')::uuid
       or v_matching_reservation.currency <> v_wallet->>'currency' then
      return jsonb_build_object('ok', false, 'code', 'RESERVATION_ACCOUNT_CONFLICT');
    end if;
    if p_customer_wallet_action not in (
      'release_orphan_hold', 'capture_orphan_hold'
    ) then
      return jsonb_build_object(
        'ok', false, 'code', 'MANUAL_ACTIVE_RESERVATION_ACTION_REQUIRED'
      );
    end if;
    if p_customer_wallet_amount <> v_matching_reservation.amount then
      return jsonb_build_object(
        'ok', false, 'code', 'MANUAL_RESERVATION_AMOUNT_CONFLICT',
        'reservationAmount', v_matching_reservation.amount
      );
    end if;
  end if;
  v_available_after := v_available_before;
  v_hold_after := v_hold_before;

  if p_customer_wallet_action = 'credit_available' then
    v_available_after := v_available_before + p_customer_wallet_amount;
  elsif p_customer_wallet_action = 'debit_available' then
    if v_wallet->>'walletStatus' <> 'active' then
      return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN');
    end if;
    if v_available_before < p_customer_wallet_amount then
      return jsonb_build_object(
        'ok', false, 'code', 'INSUFFICIENT_FUNDS',
        'available', v_available_before, 'required', p_customer_wallet_amount
      );
    end if;
    v_available_after := v_available_before - p_customer_wallet_amount;
  elsif p_customer_wallet_action = 'release_orphan_hold' then
    if v_resolvable_hold < p_customer_wallet_amount then
      return jsonb_build_object(
        'ok', false, 'code', 'INSUFFICIENT_HOLD_BALANCE',
        'hold', v_hold_before, 'protectedHold', v_protected_hold,
        'resolvableHold', v_resolvable_hold,
        'required', p_customer_wallet_amount
      );
    end if;
    v_available_after := v_available_before + p_customer_wallet_amount;
    v_hold_after := v_hold_before - p_customer_wallet_amount;
  elsif p_customer_wallet_action = 'capture_orphan_hold' then
    if v_resolvable_hold < p_customer_wallet_amount then
      return jsonb_build_object(
        'ok', false, 'code', 'INSUFFICIENT_HOLD_BALANCE',
        'hold', v_hold_before, 'protectedHold', v_protected_hold,
        'resolvableHold', v_resolvable_hold,
        'required', p_customer_wallet_amount
      );
    end if;
    v_hold_after := v_hold_before - p_customer_wallet_amount;
  end if;

  v_booking_result := case p_supplier_outcome
    when 'ticket_issued' then 'confirmed'
    when 'still_valid' then 'on-hold'
    else 'cancelled'
  end;
  if p_supplier_outcome = 'still_valid'
     and (p_new_deadline_at is null or p_new_deadline_at <= clock_timestamp()) then
    return jsonb_build_object('ok', false, 'code', 'FUTURE_DEADLINE_REQUIRED');
  end if;

  return jsonb_build_object(
    'ok', true,
    'mode', 'manual_supplier_verified',
    'bookingId', v_context->>'bookingId',
    'bookingReference', v_context->>'bookingReference',
    'fromStatus', v_context->>'bookingStatus',
    'fromLifecycleStatus', v_context->>'lifecycleStatus',
    'toStatus', v_booking_result,
    'supplierOutcome', p_supplier_outcome,
    'issueNowCaseConfirmed', true,
    'supplierReference', nullif(btrim(coalesce(p_supplier_reference, '')), ''),
    'supplierAmount', p_supplier_amount,
    'supplierCurrency', case when p_supplier_currency is null then null
      else upper(p_supplier_currency) end,
    'customerWalletAction', p_customer_wallet_action,
    'customerWalletAmount', coalesce(p_customer_wallet_amount, 0),
    'customerWalletCurrency', v_wallet->>'currency',
    'customerAmountBasis', nullif(btrim(coalesce(p_customer_amount_basis, '')), ''),
    'walletId', v_wallet->>'walletId',
    'walletAccountId', v_wallet->>'accountId',
    'walletOwnerType', v_wallet->>'ownerType',
    'walletOwnerKey', v_wallet->>'ownerKey',
    'matchingReservationId', v_matching_reservation.id,
    'matchingReservationState', v_matching_reservation.state,
    'protectedHold', v_protected_hold,
    'resolvableHold', v_resolvable_hold,
    'availableBefore', v_available_before,
    'availableAfter', v_available_after,
    'holdBefore', v_hold_before,
    'holdAfter', v_hold_after,
    'newDeadlineAt', p_new_deadline_at,
    'accountingConflictCode', case
      when coalesce((v_accounting->>'ok')::boolean, false) then null
      else v_accounting->>'code' end,
    'supplierAmountDeterminesCustomerAmount', false
  );
end;
$$;

-- 6. Atomic manual supplier-verified executor -------------------------------

create or replace function public.execute_superadmin_manual_financial_resolution_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_request_key text,
  p_supplier_outcome text,
  p_issue_now_case_confirmed boolean,
  p_customer_wallet_action text,
  p_customer_wallet_amount bigint,
  p_customer_amount_basis text,
  p_supplier_reference text,
  p_supplier_amount bigint,
  p_supplier_currency text,
  p_new_deadline_at timestamptz,
  p_note text,
  p_manual_effect_confirmed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_existing public.superadmin_manual_financial_resolutions;
  v_context jsonb;
  v_preview jsonb;
  v_account public.wallet_accounts;
  v_wallet public.wallets;
  v_reservation public.wallet_reservations;
  v_resolution_id uuid := gen_random_uuid();
  v_request_hash text;
  v_ledger_id uuid;
  v_event_id bigint;
  v_override_id uuid;
  v_action text;
  v_amount bigint;
  v_currency text;
  v_available_before bigint;
  v_available_after bigint;
  v_hold_before bigint;
  v_hold_after bigint;
  v_from_lifecycle text;
  v_to_status text;
  v_to_lifecycle text;
  v_occurrence integer;
  v_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_request_key !~ '^superadmin-manual-resolution:v2:[0-9a-f-]{36}$'
     or char_length(coalesce(p_note, '')) > 1000
     or p_manual_effect_confirmed is not true then
    return jsonb_build_object('ok', false, 'code',
      case when p_manual_effect_confirmed is not true
        then 'MANUAL_EFFECT_CONFIRMATION_REQUIRED'
        else 'INVALID_MANUAL_RESOLUTION' end
    );
  end if;
  v_request_hash := encode(sha256(convert_to(
    jsonb_strip_nulls(jsonb_build_object(
      'bookingId', p_booking_id,
      'supplierOutcome', p_supplier_outcome,
      'issueNowCaseConfirmed', p_issue_now_case_confirmed,
      'customerWalletAction', p_customer_wallet_action,
      'customerWalletAmount', p_customer_wallet_amount,
      'customerAmountBasis', nullif(btrim(coalesce(p_customer_amount_basis, '')), ''),
      'supplierReference', nullif(btrim(coalesce(p_supplier_reference, '')), ''),
      'supplierAmount', p_supplier_amount,
      'supplierCurrency', case when p_supplier_currency is null then null
        else upper(p_supplier_currency) end,
      'newDeadlineAt', p_new_deadline_at,
      'note', nullif(btrim(coalesce(p_note, '')), '')
    ))::text, 'UTF8')), 'hex');

  select * into v_booking from public.flight_bookings
   where id = p_booking_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select * into v_existing
    from public.superadmin_manual_financial_resolutions
   where request_key = p_request_key;
  if found then
    if v_existing.booking_id <> p_booking_id
       or v_existing.actor_user_id <> p_actor_user_id
       or v_existing.request_hash <> v_request_hash then
      return jsonb_build_object('ok', false, 'code', 'DECISION_IDEMPOTENCY_CONFLICT');
    end if;
    return v_existing.result || jsonb_build_object('ok', true, 'replay', true);
  end if;

  perform 1 from public.booking_operations operation
   where operation.booking_id = p_booking_id
     and operation.state in (
       'claimed', 'supplier_call_started',
       'awaiting_external_action', 'needs_reconciliation'
     ) order by operation.id for update;
  perform 1 from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.subject_booking_id = p_booking_id
     and reconciliation_case.state in (
       'open', 'assigned', 'awaiting_supplier',
       'awaiting_finance', 'awaiting_approval'
     ) order by reconciliation_case.id for update;
  v_context := public.superadmin_issue_resolution_context_v2(
    p_booking_id, p_actor_user_id
  );
  if coalesce((v_context->>'ok')::boolean, false) is not true then
    return v_context;
  end if;
  if v_context->'wallet' is null
     or nullif(v_context->'wallet'->>'accountId', '') is null then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;
  -- Hold is an account aggregate. Lock the matching reservation and every live
  -- reservation on the target account together in deterministic ID order,
  -- before the wallet, so another booking's protected Hold cannot be consumed.
  perform 1 from public.wallet_reservations reservation
   where (
       reservation.wallet_account_id =
         (v_context->'wallet'->>'accountId')::uuid
       and reservation.state in ('active', 'reconciliation')
     )
     or reservation.booking_id = p_booking_id
     or (reservation.booking_id is null
       and reservation.booking_attempt_id = v_booking.attempt_id)
   order by reservation.id for update;
  select wallet.* into v_wallet from public.wallets wallet
   where wallet.id = (v_context->'wallet'->>'walletId')::uuid
     and wallet.owner_type = v_booking.booking_owner_type
     and wallet.owner_key = v_booking.booking_owner_key
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_OWNER_NOT_FOUND');
  end if;
  select account.* into v_account from public.wallet_accounts account
   where account.id = (v_context->'wallet'->>'accountId')::uuid
     and account.wallet_id = v_wallet.id
     and account.currency = upper(v_booking.currency)
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;

  -- Re-preview after every relevant lock. If local records became complete, the
  -- manual lane refuses to compete with the normal Capture/Release lane.
  v_preview := public.preview_superadmin_manual_financial_resolution_v2(
    p_booking_id, p_actor_user_id, p_supplier_outcome,
    p_issue_now_case_confirmed,
    p_customer_wallet_action, p_customer_wallet_amount,
    p_customer_amount_basis, p_supplier_reference, p_supplier_amount,
    p_supplier_currency, p_new_deadline_at
  );
  if coalesce((v_preview->>'ok')::boolean, false) is not true then
    return v_preview;
  end if;
  if (v_preview->>'availableBefore')::bigint <> v_account.available_balance
     or (v_preview->>'holdBefore')::bigint <> v_account.hold_balance then
    return jsonb_build_object('ok', false, 'code', 'ACCOUNTING_STATE_CHANGED');
  end if;
  if nullif(v_preview->>'supplierReference', '') is not null
     and exists (
       select 1 from public.superadmin_manual_financial_resolutions resolution
        where resolution.booking_id = p_booking_id
          and resolution.supplier_reference = v_preview->>'supplierReference'
          and resolution.customer_wallet_action = p_customer_wallet_action
          and resolution.reverses_resolution_id is null
     ) then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_SUPPLIER_EFFECT_DUPLICATE');
  end if;

  v_action := v_preview->>'customerWalletAction';
  v_amount := (v_preview->>'customerWalletAmount')::bigint;
  v_currency := v_preview->>'customerWalletCurrency';
  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  v_available_after := (v_preview->>'availableAfter')::bigint;
  v_hold_after := (v_preview->>'holdAfter')::bigint;

  if nullif(v_preview->>'matchingReservationId', '') is not null then
    select * into v_reservation from public.wallet_reservations reservation
     where reservation.id = (v_preview->>'matchingReservationId')::uuid;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'RESERVATION_CHANGED');
    end if;
  end if;

  if v_action <> 'none' then
    update public.wallet_accounts set
      available_balance = v_available_after,
      hold_balance = v_hold_after
    where id = v_account.id;
    if v_reservation.id is not null
       and v_action in ('release_orphan_hold', 'capture_orphan_hold') then
      update public.wallet_reservations set
        booking_id = v_booking.id,
        booking_attempt_id = null,
        state = case when v_action = 'release_orphan_hold'
          then 'released' else 'captured' end,
        released_at = case when v_action = 'release_orphan_hold'
          then v_now else released_at end,
        release_reason = case when v_action = 'release_orphan_hold'
          then left(coalesce(nullif(btrim(p_note), ''),
            'Super Admin supplier-verified manual release'), 1000)
          else release_reason end,
        issued_by_user_id = case when v_action = 'capture_orphan_hold'
          then p_actor_user_id else issued_by_user_id end,
        captured_at = case when v_action = 'capture_orphan_hold'
          then v_now else captured_at end,
        reconciliation_at = null,
        reconciliation_reason = null
      where id = v_reservation.id;
    end if;
    insert into public.wallet_ledger_entries (
      wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after,
      booking_id, booking_reference, reservation_id, idempotency_key,
      created_by_user_id, created_by_role, remarks, metadata
    ) values (
      v_account.id,
      case v_action
        when 'credit_available' then 'superadmin_resolution_credit'
        when 'debit_available' then 'superadmin_resolution_debit'
        when 'release_orphan_hold' then 'superadmin_resolution_hold_release'
        else 'superadmin_resolution_hold_capture'
      end,
      v_amount, v_currency,
      v_available_before, v_available_after,
      v_hold_before, v_hold_after,
      v_booking.id, v_booking.public_ref,
      case when v_action in ('release_orphan_hold', 'capture_orphan_hold')
        then v_reservation.id else null end,
      p_request_key || ':ledger', p_actor_user_id, 'superadmin',
      coalesce(nullif(btrim(p_note), ''),
        'Super Admin supplier-verified manual financial resolution'),
      jsonb_strip_nulls(jsonb_build_object(
        'resolutionId', v_resolution_id,
        'resolutionMode', 'manual_supplier_verified',
        'supplierOutcome', p_supplier_outcome,
        'issueNowCaseConfirmed', true,
        'supplierReference', nullif(btrim(coalesce(p_supplier_reference, '')), ''),
        'supplierAmount', p_supplier_amount,
        'supplierCurrency', case when p_supplier_currency is null then null
          else upper(p_supplier_currency) end,
        'customerWalletAmount', v_amount,
        'customerWalletCurrency', v_currency,
        'customerAmountBasis', nullif(btrim(coalesce(p_customer_amount_basis, '')), ''),
        'matchingReservationId', case
          when v_action in ('release_orphan_hold', 'capture_orphan_hold')
            then v_reservation.id else null end,
        'protectedHold', v_preview->>'protectedHold',
        'resolvableHold', v_preview->>'resolvableHold',
        'supplierAmountDeterminesCustomerAmount', false,
        'evidenceUploadRequired', false
      ))
    ) returning id into v_ledger_id;
  end if;

  v_from_lifecycle := public.resolve_superadmin_issue_lifecycle_v2(
    v_booking.status, v_booking.legacy_operational, v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, v_booking.operation_kind
  );
  v_to_status := v_preview->>'toStatus';
  if v_to_status = 'on-hold' then
    insert into public.superadmin_booking_deadline_overrides (
      booking_id, request_key, effective_deadline_at,
      supplier_deadline_snapshot, supplier_time_limit_snapshot,
      actor_user_id, actor_role, note
    ) values (
      v_booking.id, p_request_key || ':deadline', p_new_deadline_at,
      v_booking.supplier_ticketing_deadline_at,
      v_booking.supplier_ticketing_time_limit,
      p_actor_user_id, 'superadmin', nullif(btrim(p_note), '')
    ) returning id into v_override_id;
  end if;

  update public.booking_operations set
    state = 'failed', completed_at = coalesce(completed_at, v_now),
    error_code = 'SUPERADMIN_MANUAL_RESOLUTION_SUPERSEDED',
    error_message = 'Superseded by a supplier-verified Super Admin resolution',
    supplier_evidence = supplier_evidence || jsonb_strip_nulls(jsonb_build_object(
      'manualResolutionId', v_resolution_id,
      'supplierOutcome', p_supplier_outcome,
      'issueNowCaseConfirmed', true,
      'supplierReference', nullif(btrim(coalesce(p_supplier_reference, '')), ''),
      'customerWalletAction', v_action,
      'evidenceUploadRequired', false
    ))
  where booking_id = v_booking.id
    and state in (
      'claimed', 'supplier_call_started',
      'awaiting_external_action', 'needs_reconciliation'
    );

  update public.flight_bookings set
    status = v_to_status,
    active_operation_id = null, operation_kind = null,
    operation_reason = null, operation_request_id = null,
    operation_actor_user_id = null, operation_started_at = null,
    operation_prior_status = null,
    active_superadmin_deadline_override_id = case when v_to_status = 'on-hold'
      then v_override_id else null end,
    local_ticketing_deadline_at = case when v_to_status = 'on-hold'
      then p_new_deadline_at else local_ticketing_deadline_at end,
    ticketing_deadline_at = case when v_to_status = 'on-hold'
      then p_new_deadline_at else ticketing_deadline_at end,
    deadline_source = case when v_to_status = 'on-hold'
      then 'superadmin_override' else deadline_source end,
    issued_by_user_id = case when v_to_status = 'confirmed'
      then p_actor_user_id else issued_by_user_id end,
    issued_at = case when v_to_status = 'confirmed'
      then coalesce(issued_at, v_now) else issued_at end,
    booking_status = case when v_to_status = 'confirmed'
      then coalesce(nullif(booking_status, ''), 'Confirmed') else booking_status end,
    cancelled_at = case when v_to_status = 'cancelled'
      then coalesce(cancelled_at, v_now) else cancelled_at end,
    cancelled_by = case when v_to_status = 'cancelled'
      then p_actor_user_id else cancelled_by end,
    cancel_reason = case when v_to_status = 'cancelled'
      then left(coalesce(nullif(btrim(p_note), ''),
        'Super Admin supplier-verified resolution'), 1000)
      else cancel_reason end
  where id = v_booking.id;

  update public.booking_reconciliation_cases set
    state = 'resolved',
    resolution_outcome = 'superadmin_manual_' || p_supplier_outcome,
    resolution = jsonb_strip_nulls(jsonb_build_object(
      'version', 2,
      'resolutionKind', 'superadmin_manual_financial_resolution',
      'manualResolutionId', v_resolution_id,
      'requestKey', p_request_key,
      'supplierOutcome', p_supplier_outcome,
      'supplierReference', nullif(btrim(coalesce(p_supplier_reference, '')), ''),
      'supplierAmount', p_supplier_amount,
      'supplierCurrency', case when p_supplier_currency is null then null
        else upper(p_supplier_currency) end,
      'customerWalletAction', v_action,
      'customerWalletAmount', v_amount,
      'customerWalletCurrency', v_currency,
      'supplierAmountDeterminesCustomerAmount', false,
      'ledgerEntryId', v_ledger_id,
      'evidenceUploadRequired', false
    )),
    resolution_reason = nullif(btrim(p_note), ''),
    resolved_by_user_id = p_actor_user_id,
    resolved_at = v_now, version = version + 1
  where subject_booking_id = v_booking.id
    and state in (
      'open', 'assigned', 'awaiting_supplier',
      'awaiting_finance', 'awaiting_approval'
    );

  v_to_lifecycle := case v_to_status
    when 'confirmed' then 'confirmed'
    when 'cancelled' then 'cancelled'
    else public.resolve_superadmin_issue_lifecycle_v2(
      'on-hold', v_booking.legacy_operational,
      v_booking.airlines_pnr, p_new_deadline_at, null
    ) end;
  select count(*)::integer + 1 into v_occurrence
    from public.booking_status_events event
   where event.booking_id = v_booking.id
     and event.to_lifecycle_status = v_to_lifecycle;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after,
    actor_user_id, supplier_operation, supplier_evidence,
    idempotency_key, occurrence_number, effective_at, observed_at,
    event_snapshot, event_version
  ) values (
    v_booking.id, v_from_lifecycle, v_to_lifecycle,
    v_booking.status, v_to_status, p_actor_user_id,
    'SuperAdminManualFinancialResolution',
    jsonb_strip_nulls(jsonb_build_object(
      'manualResolutionId', v_resolution_id,
      'supplierOutcome', p_supplier_outcome,
      'supplierReference', nullif(btrim(coalesce(p_supplier_reference, '')), ''),
      'customerWalletAction', v_action,
      'customerWalletAmount', v_amount,
      'customerWalletCurrency', v_currency,
      'evidenceUploadRequired', false
    )),
    p_request_key || ':status', v_occurrence, v_now, v_now,
    jsonb_strip_nulls(jsonb_build_object(
      'version', 2,
      'resolutionMode', 'manual_supplier_verified',
      'manualResolutionId', v_resolution_id,
      'customerWalletAction', v_action,
      'customerWalletAmount', v_amount,
      'customerWalletCurrency', v_currency,
      'supplierAmountDeterminesCustomerAmount', false,
      'newDeadlineAt', p_new_deadline_at,
      'notificationDisposition', case
        when v_from_lifecycle = v_to_lifecycle then 'audit_only'
        else null end,
      'suppressionReason', case
        when v_from_lifecycle = v_to_lifecycle
          then 'superadmin_same_status_resolution' else null end
    )), 2
  ) returning id into v_event_id;

  v_result := jsonb_build_object(
    'ok', true, 'replay', false,
    'mode', 'manual_supplier_verified',
    'resolutionId', v_resolution_id,
    'bookingId', v_booking.id,
    'bookingReference', v_booking.public_ref,
    'bookingStatus', v_to_status,
    'supplierOutcome', p_supplier_outcome,
    'customerWalletAction', v_action,
    'customerWalletAmount', v_amount,
    'customerWalletCurrency', v_currency,
    'availableBefore', v_available_before,
    'availableAfter', v_available_after,
    'holdBefore', v_hold_before,
    'holdAfter', v_hold_after,
    'ledgerEntryId', v_ledger_id,
    'lifecycleEventId', v_event_id,
    'supplierAmountDeterminesCustomerAmount', false
  );

  insert into public.superadmin_manual_financial_resolutions (
    id, booking_id, booking_reference, request_key, request_hash,
    wallet_id, wallet_account_id, wallet_owner_type, wallet_owner_key,
    customer_wallet_action, customer_wallet_amount,
    customer_wallet_currency, customer_amount_basis,
    available_before, available_after, hold_before, hold_after,
    supplier_outcome, supplier_reference, supplier_amount, supplier_currency,
    issue_now_case_confirmed,
    booking_result, accounting_conflict_code,
    actor_user_id, actor_role, note, verified_at,
    ledger_entry_id, lifecycle_event_id, result
  ) values (
    v_resolution_id, v_booking.id, v_booking.public_ref,
    p_request_key, v_request_hash,
    v_wallet.id, v_account.id, v_wallet.owner_type, v_wallet.owner_key,
    v_action, v_amount, v_currency,
    nullif(btrim(coalesce(p_customer_amount_basis, '')), ''),
    v_available_before, v_available_after, v_hold_before, v_hold_after,
    p_supplier_outcome,
    nullif(btrim(coalesce(p_supplier_reference, '')), ''),
    p_supplier_amount,
    case when p_supplier_currency is null then null
      else upper(p_supplier_currency) end,
    true,
    v_to_status, v_preview->>'accountingConflictCode',
    p_actor_user_id, 'superadmin', nullif(btrim(p_note), ''), v_now,
    v_ledger_id, v_event_id, v_result
  );
  update public.flight_bookings
     set last_superadmin_manual_resolution_id = v_resolution_id
   where id = v_booking.id;
  insert into public.security_audit_events (
    actor_user_id, actor_role, action, target_type, target_id,
    outcome, metadata
  ) values (
    p_actor_user_id, 'superadmin',
    'booking.superadmin_manual_financial_resolution',
    'flight_booking', v_booking.id::text, 'succeeded',
    jsonb_strip_nulls(jsonb_build_object(
      'resolutionId', v_resolution_id,
      'requestKey', p_request_key,
      'supplierOutcome', p_supplier_outcome,
      'issueNowCaseConfirmed', true,
      'supplierReferenceRecorded',
        nullif(btrim(coalesce(p_supplier_reference, '')), '') is not null,
      'customerWalletAction', v_action,
      'customerWalletAmount', v_amount,
      'customerWalletCurrency', v_currency,
      'supplierAmount', p_supplier_amount,
      'supplierCurrency', case when p_supplier_currency is null then null
        else upper(p_supplier_currency) end,
      'supplierAmountDeterminesCustomerAmount', false,
      'ledgerEntryId', v_ledger_id
    ))
  );
  return v_result;
end;
$$;

-- 7. One automatic execution boundary ---------------------------------------

create or replace function public.execute_superadmin_issue_resolution_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_request_key text,
  p_supplier_outcome text,
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
  v_booking public.flight_bookings;
  v_existing public.superadmin_booking_decisions;
  v_preview jsonb;
  v_state text;
  v_expected_decision text;
begin
  if p_request_key !~ '^superadmin-booking-decision:v1:[0-9a-f-]{36}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_SUPERADMIN_DECISION');
  end if;
  select * into v_booking from public.flight_bookings
   where id = p_booking_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  v_expected_decision := case p_supplier_outcome
    when 'ticket_issued' then 'confirm_ticketed'
    when 'still_valid' then 'keep_on_hold'
    when 'not_issued' then 'cancel'
    else null end;
  select * into v_existing from public.superadmin_booking_decisions
   where request_key = p_request_key;
  if found then
    if v_expected_decision is null
       or v_existing.booking_id <> p_booking_id
       or v_existing.actor_user_id <> p_actor_user_id
       or v_existing.decision <> v_expected_decision
       or v_existing.note is distinct from nullif(btrim(coalesce(p_note, '')), '')
       or (
         v_existing.request_snapshot ? 'supplierOutcome'
         and (
           v_existing.request_snapshot->>'supplierOutcome'
             is distinct from p_supplier_outcome
           or (v_existing.request_snapshot->>'newDeadlineAt')::timestamptz
             is distinct from p_new_deadline_at
         )
       )
       or (
         not (v_existing.request_snapshot ? 'supplierOutcome')
         and (
           v_existing.request_snapshot->>'refundDisposition'
             is distinct from p_refund_disposition
           or (v_existing.request_snapshot->>'refundAmount')::bigint
             is distinct from p_refund_amount
           or v_existing.request_snapshot->>'externalSettlementReference'
             is distinct from p_external_settlement_reference
           or (v_existing.request_snapshot->>'newDeadlineAt')::timestamptz
             is distinct from p_new_deadline_at
         )
       ) then
      return jsonb_build_object(
        'ok', false, 'code', 'DECISION_IDEMPOTENCY_CONFLICT'
      );
    end if;
    return v_existing.result || jsonb_build_object('ok', true, 'replay', true);
  end if;
  perform 1 from public.booking_operations operation
   where operation.booking_id = p_booking_id
     and operation.state in (
       'claimed', 'supplier_call_started',
       'awaiting_external_action', 'needs_reconciliation'
     ) order by operation.id for update;
  perform 1 from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.subject_booking_id = p_booking_id
     and reconciliation_case.state in (
       'open', 'assigned', 'awaiting_supplier',
       'awaiting_finance', 'awaiting_approval'
     ) order by reconciliation_case.id for update;
  v_preview := public.preview_superadmin_issue_resolution_v2(
    p_booking_id, p_actor_user_id, p_supplier_outcome,
    p_refund_disposition, p_refund_amount,
    p_external_settlement_reference, p_new_deadline_at
  );
  if coalesce((v_preview->>'ok')::boolean, false) is not true then
    return v_preview;
  end if;
  v_state := v_preview->'accounting'->>'accountingState';
  if v_state = 'active_hold' then
    perform 1 from public.wallet_reservations reservation
     where reservation.wallet_account_id =
         (v_preview->'accounting'->>'walletAccountId')::uuid
       and reservation.state in ('active', 'reconciliation')
     order by reservation.id for update;
    v_preview := public.preview_superadmin_issue_resolution_v2(
      p_booking_id, p_actor_user_id, p_supplier_outcome,
      p_refund_disposition, p_refund_amount,
      p_external_settlement_reference, p_new_deadline_at
    );
    if coalesce((v_preview->>'ok')::boolean, false) is not true then
      return v_preview;
    end if;
    if v_preview->'accounting'->>'accountingState' <> 'active_hold' then
      return jsonb_build_object('ok', false, 'code', 'ACCOUNTING_STATE_CHANGED');
    end if;
  end if;
  if p_supplier_outcome = 'ticket_issued' then
    if v_booking.status = 'confirmed' and v_state = 'paid' then
      return jsonb_build_object(
        'ok', false, 'code', 'ALREADY_RESOLVED',
        'bookingStatus', 'confirmed', 'walletEffect', 'none'
      );
    end if;
    return public.execute_superadmin_booking_decision_v1(
      p_booking_id, p_actor_user_id, p_request_key,
      'confirm_ticketed', null, null, null, null,
      p_note, p_money_movement_confirmed
    );
  elsif p_supplier_outcome = 'not_issued' and v_state = 'paid' then
    return public.execute_superadmin_booking_decision_v1(
      p_booking_id, p_actor_user_id, p_request_key,
      'cancel', p_refund_disposition, p_refund_amount,
      p_external_settlement_reference, null,
      p_note, p_money_movement_confirmed
    );
  end if;
  return public.execute_superadmin_hold_outcome_v2(
    p_booking_id, p_actor_user_id, p_request_key,
    p_supplier_outcome, p_new_deadline_at,
    p_note, p_money_movement_confirmed
  );
end;
$$;

-- 8. Security boundary -------------------------------------------------------

alter table public.superadmin_booking_deadline_overrides enable row level security;
alter table public.superadmin_manual_financial_resolutions enable row level security;
revoke all on table public.superadmin_booking_deadline_overrides,
  public.superadmin_manual_financial_resolutions
  from public, anon, authenticated;
grant select, insert on table public.superadmin_booking_deadline_overrides,
  public.superadmin_manual_financial_resolutions
  to service_role;

revoke all on function public.superadmin_issue_resolution_context_v2(uuid,text),
  public.resolve_superadmin_issue_lifecycle_v2(text,boolean,jsonb,timestamptz,text),
  public.preview_superadmin_issue_resolution_v2(uuid,text,text,text,bigint,text,timestamptz),
  public.execute_superadmin_hold_outcome_v2(uuid,text,text,text,timestamptz,text,boolean),
  public.preview_superadmin_manual_financial_resolution_v2(uuid,text,text,boolean,text,bigint,text,text,bigint,text,timestamptz),
  public.execute_superadmin_manual_financial_resolution_v2(uuid,text,text,text,boolean,text,bigint,text,text,bigint,text,timestamptz,text,boolean),
  public.execute_superadmin_issue_resolution_v2(uuid,text,text,text,text,bigint,text,timestamptz,text,boolean),
  public.prevent_superadmin_resolution_mutation_v2(),
  public.enforce_booking_deadline_authority_v2()
  from public, anon, authenticated;

grant execute on function public.superadmin_issue_resolution_context_v2(uuid,text),
  public.preview_superadmin_issue_resolution_v2(uuid,text,text,text,bigint,text,timestamptz),
  public.preview_superadmin_manual_financial_resolution_v2(uuid,text,text,boolean,text,bigint,text,text,bigint,text,timestamptz),
  public.execute_superadmin_manual_financial_resolution_v2(uuid,text,text,text,boolean,text,bigint,text,text,bigint,text,timestamptz,text,boolean),
  public.execute_superadmin_issue_resolution_v2(uuid,text,text,text,text,bigint,text,timestamptz,text,boolean)
  to service_role;

-- Internal implementation: callable from the owner function only.
revoke all on function public.execute_superadmin_hold_outcome_v2(
  uuid,text,text,text,timestamptz,text,boolean
) from service_role;

comment on table public.superadmin_manual_financial_resolutions is
  'Immutable booking-bound Super Admin supplier-verified customer-wallet resolutions. Supplier and customer-wallet amounts are independent facts.';
comment on table public.superadmin_booking_deadline_overrides is
  'Immutable Super Admin effective-deadline decisions; supplier deadline history remains separate and readable.';
comment on function public.execute_superadmin_manual_financial_resolution_v2(uuid,text,text,text,boolean,text,bigint,text,text,bigint,text,timestamptz,text,boolean) is
  'Atomically applies a supplier-verified manual customer-wallet resolution for a stuck ordinary B2B/B2C Issue Now booking. Never invents a reservation or rewrites ledger history.';
