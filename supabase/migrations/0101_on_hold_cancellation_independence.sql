-- On Hold cancellation is a supplier hold-release action, not ticketing.
-- A customer must not need wallet funds or a local Issue Ticket time-limit
-- grant to cancel an unissued booking they own. Expired lifecycle rows remain
-- protected by their effective deadline, while a missing deadline does not
-- manufacture an Issue Ticket prerequisite for cancellation.

create or replace function public.begin_booking_cancellation(
  p_booking_id uuid,
  p_actor_user_id text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_actor_role text;
begin
  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id and not legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  if v_booking.status <> 'on-hold'
     or v_booking.operation_kind is not null
     or v_booking.issued_at is not null
     or v_booking.direct_ticketing
     or v_booking.payment_state in ('held', 'captured', 'reconciliation') then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_CANCELLABLE');
  end if;
  if not public.jsonb_is_nonempty_array(v_booking.airlines_pnr) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_UNCONFIRMED');
  end if;
  if v_booking.ticketing_deadline_at is not null
     and v_booking.ticketing_deadline_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_EXPIRED');
  end if;

  if v_booking.active_local_time_limit_request_id is not null then
    select role into v_actor_role
      from public.app_users
     where clerk_id = p_actor_user_id;
    insert into public.booking_local_time_limit_events (
      booking_id, request_id, event_type, actor_user_id, actor_role,
      resulting_deadline_at, operation_request_key, evidence
    ) values (
      p_booking_id, v_booking.active_local_time_limit_request_id,
      'used_for_cancellation', p_actor_user_id,
      case
        when v_actor_role in (
          'superadmin', 'admin', 'staff_support', 'staff_account',
          'customer', 'b2b', 'b2b_sub'
        ) then v_actor_role
        else 'system'
      end,
      v_booking.local_ticketing_deadline_at, p_idempotency_key,
      jsonb_build_object('walletMutation', false)
    ) on conflict do nothing;
  end if;

  update public.flight_bookings
     set status = 'in-progress',
         operation_kind = 'cancellation',
         operation_reason = 'cancellation',
         operation_request_id = p_idempotency_key,
         operation_actor_user_id = p_actor_user_id,
         operation_started_at = now(),
         operation_prior_status = 'on-hold'
   where id = p_booking_id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation, idempotency_key
  ) values (
    p_booking_id, 'on-hold', 'in-progress', 'on-hold', 'in-progress',
    'cancellation', 'cancellation', p_actor_user_id, 'Cancel',
    p_idempotency_key || ':cancellation-start'
  ) on conflict do nothing;
  return jsonb_build_object(
    'ok', true,
    'status', 'in-progress',
    'walletMutation', false
  );
end;
$$;

revoke all on function public.begin_booking_cancellation(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.begin_booking_cancellation(uuid, text, text)
  to service_role;

comment on function public.begin_booking_cancellation(uuid, text, text) is
  'Claims an owned, unissued On Hold booking for supplier cancellation without checking, reserving, charging, or deducting wallet balance and without requiring an Issue Ticket local time-limit grant.';
