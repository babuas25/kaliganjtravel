-- Capture a customer's reserved funds when only the supplier's own API wallet
-- is short, then let an operator finalize that already-paid ticket later.
create or replace function public.wallet_queue_manual_issue(
  p_booking_id uuid, p_actor_user_id text, p_actor_role text,
  p_idempotency_key text, p_reason text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_booking public.flight_bookings;
  v_reservation public.wallet_reservations;
  v_account public.wallet_accounts;
begin
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;

  select * into v_reservation from public.wallet_reservations
   where booking_id = p_booking_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'RESERVATION_NOT_FOUND'); end if;
  if v_reservation.state = 'captured' and v_booking.status = 'pending' then
    return jsonb_build_object('ok', true, 'replay', true, 'reservationId', v_reservation.id);
  end if;
  if v_reservation.state <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'RESERVATION_NOT_HELD');
  end if;

  select * into strict v_account from public.wallet_accounts
   where id = v_reservation.wallet_account_id for update;
  if v_account.hold_balance < v_reservation.amount then
    return jsonb_build_object('ok', false, 'code', 'HOLD_BALANCE_MISMATCH');
  end if;

  update public.wallet_accounts set hold_balance = hold_balance - v_reservation.amount
   where id = v_account.id;
  update public.wallet_reservations set state = 'captured', booking_attempt_id = null,
    issued_by_user_id = p_actor_user_id, captured_at = now() where id = v_reservation.id;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks
  ) values (
    v_account.id, 'booking_confirm', v_reservation.amount, v_reservation.currency,
    v_account.available_balance, v_account.available_balance,
    v_account.hold_balance, v_account.hold_balance - v_reservation.amount,
    v_booking.id, v_booking.public_ref, v_reservation.id, p_idempotency_key || ':manual-queue',
    p_actor_user_id, p_actor_role, 'Payment captured; supplier wallet requires funding'
  );
  update public.flight_bookings set status = 'pending', payment_state = 'captured',
    charged_wallet_account_id = v_account.id, payment_amount = v_reservation.amount,
    captured_amount = v_reservation.amount, supplier_message = left(p_reason, 2000)
   where id = v_booking.id;
  return jsonb_build_object('ok', true, 'reservationId', v_reservation.id,
    'availableBalance', v_account.available_balance, 'holdBalance', v_account.hold_balance - v_reservation.amount);
end $$;

create or replace function public.wallet_finalize_manual_issue(
  p_booking_id uuid, p_actor_user_id text, p_actor_role text, p_supplier_outcome jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_booking public.flight_bookings;
begin
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;
  if v_booking.status = 'confirmed' and v_booking.issued_at is not null then
    return jsonb_build_object('ok', true, 'replay', true);
  end if;
  if v_booking.status <> 'pending' or v_booking.payment_state <> 'captured' then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_MANUALLY_ISSUABLE');
  end if;
  update public.flight_bookings set status = 'confirmed', issued_by_user_id = p_actor_user_id,
    issued_at = now(), pnr = coalesce(nullif(trim(p_supplier_outcome->>'pnr'), ''), pnr),
    booking_status = coalesce(nullif(trim(p_supplier_outcome->>'bookingStatus'), ''), 'Confirmed'),
    ticket_code_ref = nullif(trim(p_supplier_outcome->>'ticketCodeRef'), ''),
    ticket_numbers = coalesce(p_supplier_outcome->'ticketNumbers', ticket_numbers),
    warnings = coalesce(p_supplier_outcome->'warnings', warnings),
    supplier_message = nullif(trim(p_supplier_outcome->>'message'), '')
   where id = p_booking_id;
  return jsonb_build_object('ok', true);
end $$;

revoke execute on function public.wallet_queue_manual_issue(uuid,text,text,text,text),
  public.wallet_finalize_manual_issue(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.wallet_queue_manual_issue(uuid,text,text,text,text),
  public.wallet_finalize_manual_issue(uuid,text,text,jsonb) to service_role;
