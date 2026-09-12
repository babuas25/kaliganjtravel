-- SuperAdmin/Admin may issue an On Hold booking on behalf of its assigned
-- B2B/B2C owner. The actor identity is retained for audit, while reservation
-- and capture continue to use the booking owner's wallet. Support remains
-- forbidden before any wallet or supplier operation starts.

create or replace function public.wallet_begin_booking_issue(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_amount bigint;
  v_result jsonb;
begin
  if p_actor_role = 'staff_support' then
    return jsonb_build_object('ok', false, 'code', 'ISSUE_FORBIDDEN');
  end if;
  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id and not legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  if v_booking.status = 'confirmed' or v_booking.payment_state = 'captured' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CAPTURED');
  end if;
  if v_booking.status <> 'on-hold' or v_booking.operation_kind is not null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_ISSUABLE');
  end if;
  if not public.jsonb_is_nonempty_array(v_booking.airlines_pnr) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_UNCONFIRMED');
  end if;
  if v_booking.ticketing_deadline_at is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_DEADLINE_REQUIRED');
  end if;
  if v_booking.ticketing_deadline_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_EXPIRED');
  end if;
  if v_booking.booking_owner_type is null or v_booking.booking_owner_key is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_OWNER_REQUIRED');
  end if;
  begin
    v_amount := round(
      (v_booking.pricing_snapshot->>'sellingPrice')::numeric * 100
    )::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
  end;
  v_result := public.wallet_reserve_amount(
    v_booking.id, null,
    v_booking.booking_owner_type, v_booking.booking_owner_key,
    v_amount, v_booking.currency,
    p_actor_user_id, p_actor_role,
    p_idempotency_key, v_booking.public_ref
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    return v_result;
  end if;
  update public.flight_bookings
     set status = 'in-progress',
         operation_kind = 'ticketing',
         operation_reason = 'ticketing',
         operation_request_id = p_idempotency_key,
         operation_actor_user_id = p_actor_user_id,
         operation_started_at = now(),
         operation_prior_status = 'on-hold'
   where id = v_booking.id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation, idempotency_key,
    supplier_evidence
  ) values (
    v_booking.id, 'on-hold', 'in-progress', 'on-hold', 'in-progress',
    'ticketing', 'ticketing', p_actor_user_id, 'NewTicket',
    p_idempotency_key || ':ticketing-start',
    jsonb_build_object(
      'actorRole', p_actor_role,
      'walletOwnerType', v_booking.booking_owner_type,
      'walletOwnerKey', v_booking.booking_owner_key,
      'staffIssuedForOwner', p_actor_role in ('superadmin', 'admin')
    )
  ) on conflict do nothing;
  return v_result || jsonb_build_object(
    'status', 'in-progress',
    'walletOwnerType', v_booking.booking_owner_type,
    'walletOwnerKey', v_booking.booking_owner_key,
    'staffIssuedForOwner', p_actor_role in ('superadmin', 'admin')
  );
end;
$$;

create or replace function public.wallet_begin_booking_issue_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_key text,
  p_request_payload_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_operation_id uuid;
begin
  if p_actor_role = 'staff_support' then
    return jsonb_build_object('ok', false, 'code', 'ISSUE_FORBIDDEN');
  end if;
  v_claim := public.claim_booking_operation_identity(
    p_booking_id, 'ticketing', 'ticketing', null,
    p_request_key, p_request_payload_hash,
    p_actor_user_id, p_actor_role, 'staff', 'NewTicket', null
  );
  if coalesce((v_claim->>'ok')::boolean, false) is not true then
    return v_claim;
  end if;
  v_replay := public.booking_operation_replay_response(v_claim);
  if v_replay is not null then return v_replay; end if;
  v_operation_id := (v_claim->>'operationId')::uuid;
  v_result := public.wallet_begin_booking_issue(
    p_booking_id, p_actor_user_id, p_actor_role, p_request_key
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    update public.booking_operations
       set state = 'failed',
           completed_at = now(),
           error_code = coalesce(v_result->>'code', 'CLAIM_FAILED'),
           supplier_evidence = jsonb_build_object(
             'phase', 'local_claim',
             'resultCode', v_result->>'code',
             'actorRole', p_actor_role
           )
     where id = v_operation_id and state = 'claimed';
    return v_result || jsonb_build_object(
      'operationId', v_operation_id,
      'operationState', 'failed'
    );
  end if;
  update public.flight_bookings
     set active_operation_id = v_operation_id
   where id = p_booking_id;
  update public.booking_status_events
     set operation_id = v_operation_id
   where booking_id = p_booking_id
     and idempotency_key = p_request_key || ':ticketing-start';
  return v_result || jsonb_build_object(
    'replay', false,
    'operationId', v_operation_id,
    'operationState', 'claimed'
  );
end;
$$;

revoke all on function public.wallet_begin_booking_issue(
  uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.wallet_begin_booking_issue_v2(
  uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.wallet_begin_booking_issue(
  uuid, text, text, text
) to service_role;
grant execute on function public.wallet_begin_booking_issue_v2(
  uuid, text, text, text, text
) to service_role;

comment on function public.wallet_begin_booking_issue(
  uuid, text, text, text
) is
  'Reserves the booking owner wallet for ticketing. SuperAdmin/Admin may act for the owner; Support is forbidden before any wallet mutation.';
comment on function public.wallet_begin_booking_issue_v2(
  uuid, text, text, text, text
) is
  'Idempotent ticketing claim allowing SuperAdmin/Admin to charge the assigned booking owner wallet while retaining the staff actor for audit; Support remains forbidden.';
