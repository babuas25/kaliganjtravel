-- Generic refunds remain available for ordinary, non-reconciliation financial
-- work on an internally consistent captured booking. They cannot resolve a
-- Cancelled/Captured booking, an uncertain operation, or any unresolved case.
-- Those outcomes must use the exact approved case-bound reconciliation RPCs.

create or replace function public.wallet_refund_booking(
  p_booking_id uuid,
  p_amount bigint,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text,
  p_remarks text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_case_id uuid;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_existing public.wallet_ledger_entries;
  v_outstanding bigint;
  v_payment_after text;
  v_event_id bigint;
  v_occurrence_number integer;
begin
  if p_booking_id is null
     or p_amount is null or p_amount <= 0
     or nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_idempotency_key), '') is null
     or char_length(p_idempotency_key) > 220 then
    raise exception 'invalid refund request' using errcode = '22023';
  end if;
  select app_user.role into v_actor_role
    from public.app_users app_user
   where app_user.clerk_id = p_actor_user_id;
  if v_actor_role not in ('superadmin', 'admin', 'staff_account') then
    return jsonb_build_object('ok', false, 'code', 'REFUND_FORBIDDEN');
  end if;

  -- Global mutation order: booking -> operation -> case -> reservation ->
  -- wallet -> account. Ledger entries are immutable and are never locked.
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
     and not booking.legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select ledger.* into v_existing
    from public.wallet_ledger_entries ledger
   where ledger.idempotency_key = p_idempotency_key || ':refund';
  if found then
    if v_existing.booking_id is distinct from p_booking_id
       or v_existing.amount <> p_amount
       or v_existing.transaction_type <> 'refund' then
      return jsonb_build_object(
        'ok', false, 'code', 'REFUND_IDEMPOTENCY_CONFLICT'
      );
    end if;
    return jsonb_build_object(
      'ok', true,
      'replay', true,
      'availableBalance', v_existing.available_after,
      'refundedAmount', v_booking.refunded_amount,
      'lifecycleEventId', (
        select event.id from public.booking_status_events event
         where event.idempotency_key = p_idempotency_key || ':refund-status'
      )
    );
  end if;
  if v_booking.active_operation_id is not null then
    select operation.* into v_operation
      from public.booking_operations operation
     where operation.id = v_booking.active_operation_id
       and operation.booking_id = v_booking.id
     for update;
  end if;
  if v_booking.status <> 'confirmed'
     or v_booking.payment_state = 'reconciliation'
     or v_booking.operation_kind = 'reconciliation'
     or v_booking.operation_reason in (
       'ticketing_reconciliation', 'cancellation_reconciliation',
       'legacy_reconciliation', 'terminal_state_conflict',
       'supplier_outcome_unknown'
     )
     or v_operation.state = 'needs_reconciliation' then
    return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REQUIRED');
  end if;
  select reconciliation_case.id into v_case_id
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.subject_booking_id = p_booking_id
     and reconciliation_case.state not in ('resolved', 'closed_no_change')
   limit 1
   for update;
  if v_case_id is not null then
    return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REQUIRED');
  end if;

  select reservation.* into v_reservation
    from public.wallet_reservations reservation
   where reservation.booking_id = p_booking_id
   for update;
  if not found
     or v_reservation.state <> 'captured'
     or v_reservation.amount <> v_booking.captured_amount
     or v_reservation.wallet_account_id
        is distinct from v_booking.charged_wallet_account_id
     or v_reservation.currency <> v_booking.currency then
    return jsonb_build_object(
      'ok', false, 'code', 'REFUND_RESERVATION_MISMATCH'
    );
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
  if not found
     or v_account.currency <> v_reservation.currency then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;

  v_outstanding := v_booking.captured_amount - v_booking.refunded_amount;
  if v_booking.payment_state not in ('captured', 'partially-refunded')
     or p_amount > v_outstanding then
    return jsonb_build_object(
      'ok', false,
      'code', 'REFUND_EXCEEDS_CAPTURE',
      'refundable', greatest(v_outstanding, 0)
    );
  end if;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks
  ) values (
    v_account.id, 'refund', p_amount, v_account.currency,
    v_account.available_balance, v_account.available_balance + p_amount,
    v_account.hold_balance, v_account.hold_balance,
    v_booking.id, v_booking.public_ref, v_reservation.id,
    p_idempotency_key || ':refund', p_actor_user_id, v_actor_role, p_remarks
  );
  update public.wallet_accounts
     set available_balance = available_balance + p_amount
   where id = v_account.id;
  v_payment_after := case
    when v_booking.refunded_amount + p_amount = v_booking.captured_amount
      then 'refunded'
    else 'partially-refunded'
  end;
  update public.flight_bookings
     set refunded_amount = refunded_amount + p_amount,
         payment_state = v_payment_after
   where id = v_booking.id;
  select count(*)::integer + 1 into v_occurrence_number
    from public.booking_status_events event
   where event.booking_id = v_booking.id
     and event.to_lifecycle_status = 'confirmed';
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, occurrence_number,
    effective_at, observed_at, event_snapshot, event_version
  ) values (
    v_booking.id, 'confirmed', 'confirmed',
    v_booking.status, v_booking.status, null, null,
    p_actor_user_id, 'WalletRefund',
    jsonb_build_object('refundAmount', p_amount),
    p_idempotency_key || ':refund-status', v_occurrence_number,
    clock_timestamp(), clock_timestamp(),
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'lifecycleStatus', 'confirmed',
      'paymentState', v_payment_after,
      'financialEvent', 'refund',
      'refundAmount', p_amount,
      'refundedAmount', v_booking.refunded_amount + p_amount,
      'capturedAmount', v_booking.captured_amount,
      'currency', v_booking.currency
    ), 1
  ) returning id into v_event_id;
  return jsonb_build_object(
    'ok', true,
    'availableBalance', v_account.available_balance + p_amount,
    'refundedAmount', v_booking.refunded_amount + p_amount,
    'lifecycleEventId', v_event_id
  );
end;
$$;

revoke all on function public.wallet_refund_booking(
  uuid, bigint, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.wallet_refund_booking(
  uuid, bigint, text, text, text, text
) to service_role;

comment on function public.wallet_refund_booking(
  uuid, bigint, text, text, text, text
) is
  'Ordinary non-reconciliation refund only. Current Accounts/Admin/Super Admin authority, captured reservation identity, and absence of terminal/reconciliation conflict are enforced in the database.';
