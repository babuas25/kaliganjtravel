-- Finalize a successful supplier cancellation and release its wallet hold in
-- one transaction. The supplier call happens first; this function only records
-- that known outcome and performs the local financial transition.

create or replace function public.wallet_finalize_booking_cancel(
  p_booking_id uuid,
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
  v_release jsonb;
begin
  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  if v_booking.status = 'cancelled' then
    return jsonb_build_object('ok', true, 'replay', true);
  end if;
  if v_booking.status <> 'in-progress' or v_booking.issued_at is not null
     or v_booking.direct_ticketing then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_CANCELLABLE');
  end if;

  v_release := public.wallet_release_reservation(
    p_booking_id, null, p_actor_user_id, p_actor_role,
    p_idempotency_key, coalesce(p_reason, 'Booking cancelled with supplier')
  );

  if coalesce((v_release->>'ok')::boolean, false) is not true then
    update public.flight_bookings
       set status = 'cancelled',
           cancelled_at = now(),
           cancelled_by = p_actor_user_id,
           cancel_reason = left(coalesce(p_reason, 'Booking cancelled with supplier'), 1000),
           payment_state = 'reconciliation'
     where id = p_booking_id;
    return v_release || jsonb_build_object('supplierCancelled', true);
  end if;

  update public.flight_bookings
     set status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = p_actor_user_id,
         cancel_reason = left(coalesce(p_reason, 'Booking cancelled with supplier'), 1000)
   where id = p_booking_id;
  return v_release || jsonb_build_object('ok', true, 'status', 'cancelled');
end;
$$;

revoke all on function public.wallet_finalize_booking_cancel(
  uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.wallet_finalize_booking_cancel(
  uuid, text, text, text, text
) to service_role;

comment on function public.wallet_finalize_booking_cancel(uuid, text, text, text, text) is
  'Atomically records a known supplier cancellation and releases its active wallet reservation.';
