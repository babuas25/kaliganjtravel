-- The compatibility release RPC remains available for ordinary definitive
-- supplier failures, but it must never resolve an owned uncertainty. Exact
-- non-issuance/cancellation reconciliation RPCs perform their own approved,
-- case-bound releases and do not call this function.

create or replace function public.wallet_release_reservation(
  p_booking_id uuid,
  p_booking_attempt_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_attempt public.booking_attempts;
  v_operation public.booking_operations;
  v_case_id uuid;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_booking_ref text;
  v_available_before bigint;
  v_hold_before bigint;
begin
  if (p_booking_id is null) = (p_booking_attempt_id is null) then
    raise exception 'exactly one reservation subject is required'
      using errcode = '22023';
  end if;
  if nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_actor_role), '') is null
     or nullif(btrim(p_idempotency_key), '') is null
     or char_length(p_idempotency_key) > 220 then
    raise exception 'invalid wallet release request' using errcode = '22023';
  end if;

  -- Booking/attempt ownership is locked before case/reservation/wallet rows.
  -- This shares the reconciliation serialization prefix and closes the race
  -- between opening a case and a generic release.
  if p_booking_id is not null then
    select booking.* into v_booking
      from public.flight_bookings booking
     where booking.id = p_booking_id
     for update;
    if found then
      v_booking_ref := v_booking.public_ref;
      if v_booking.active_operation_id is not null then
        select operation.* into v_operation
          from public.booking_operations operation
         where operation.id = v_booking.active_operation_id
           and operation.booking_id = v_booking.id
         for update;
      end if;
      if v_booking.payment_state = 'reconciliation'
         or v_booking.operation_kind = 'reconciliation'
         or v_booking.operation_reason in (
           'ticketing_reconciliation', 'cancellation_reconciliation',
           'legacy_reconciliation', 'terminal_state_conflict',
           'supplier_outcome_unknown'
         )
         or v_operation.state = 'needs_reconciliation' then
        return jsonb_build_object(
          'ok', false, 'code', 'RECONCILIATION_REQUIRED'
        );
      end if;
    end if;
    select reconciliation_case.id into v_case_id
      from public.booking_reconciliation_cases reconciliation_case
     where reconciliation_case.subject_booking_id = p_booking_id
       and reconciliation_case.state not in ('resolved', 'closed_no_change')
     limit 1
     for update;
  else
    select attempt.* into v_attempt
      from public.booking_attempts attempt
     where attempt.id = p_booking_attempt_id
     for update;
    if found and v_attempt.state = 'unknown' then
      return jsonb_build_object(
        'ok', false, 'code', 'RECONCILIATION_REQUIRED'
      );
    end if;
    select reconciliation_case.id into v_case_id
      from public.booking_reconciliation_cases reconciliation_case
     where reconciliation_case.subject_booking_attempt_id = p_booking_attempt_id
       and reconciliation_case.state not in ('resolved', 'closed_no_change')
     limit 1
     for update;
  end if;
  if v_case_id is not null then
    return jsonb_build_object(
      'ok', false, 'code', 'RECONCILIATION_REQUIRED'
    );
  end if;

  select reservation.* into v_reservation
    from public.wallet_reservations reservation
   where (p_booking_id is not null and reservation.booking_id = p_booking_id)
      or (p_booking_attempt_id is not null
        and reservation.booking_attempt_id = p_booking_attempt_id)
   for update;
  if not found then
    return jsonb_build_object('ok', true, 'replay', true);
  end if;
  if v_reservation.state = 'released' then
    return jsonb_build_object(
      'ok', true, 'replay', true, 'reservationId', v_reservation.id
    );
  end if;
  if v_reservation.state = 'captured' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CAPTURED');
  end if;
  if v_reservation.state = 'reconciliation' then
    return jsonb_build_object(
      'ok', false, 'code', 'RECONCILIATION_REQUIRED'
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
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;
  if v_account.currency <> v_reservation.currency then
    return jsonb_build_object('ok', false, 'code', 'WALLET_CURRENCY_MISMATCH');
  end if;
  if v_account.hold_balance < v_reservation.amount then
    return jsonb_build_object('ok', false, 'code', 'HOLD_BALANCE_MISMATCH');
  end if;

  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  update public.wallet_accounts
     set available_balance = available_balance + v_reservation.amount,
         hold_balance = hold_balance - v_reservation.amount
   where id = v_account.id;
  update public.wallet_reservations
     set state = 'released',
         released_at = clock_timestamp(),
         release_reason = left(
           coalesce(p_reason, 'Supplier declined issuance'), 1000
         )
   where id = v_reservation.id;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks
  ) values (
    v_account.id, 'hold_release', v_reservation.amount,
    v_reservation.currency, v_available_before,
    v_available_before + v_reservation.amount,
    v_hold_before, v_hold_before - v_reservation.amount,
    p_booking_id, v_booking_ref, v_reservation.id,
    p_idempotency_key || ':release', p_actor_user_id, p_actor_role,
    left(coalesce(p_reason, 'Supplier declined issuance'), 1000)
  );
  if p_booking_id is not null then
    update public.flight_bookings
       set payment_state = 'released'
     where id = p_booking_id and payment_state <> 'captured';
  end if;
  return jsonb_build_object(
    'ok', true,
    'reservationId', v_reservation.id,
    'availableBalance', v_available_before + v_reservation.amount,
    'holdBalance', v_hold_before - v_reservation.amount
  );
end;
$$;

revoke all on function public.wallet_release_reservation(
  uuid, uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.wallet_release_reservation(
  uuid, uuid, text, text, text, text
) to service_role;

comment on function public.wallet_release_reservation(
  uuid, uuid, text, text, text, text
) is
  'Compatibility release for ordinary definitive failures only. Reconciliation state, an unresolved case, an unknown attempt, or a needs-reconciliation operation must use an approved exact case outcome.';
