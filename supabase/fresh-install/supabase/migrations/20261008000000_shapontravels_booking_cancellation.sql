-- Enable the existing atomic Cancel operation for verified Shapontravels API
-- holds. Restrict the newly exposed supplier path to owned, unissued On Hold,
-- Pending, Unconfirmed or Expired bookings. The supplier's fresh canCancel
-- evidence remains authoritative, even after a local issue deadline elapsed.
-- The Triplover compatibility branch and financial finalizers keep
-- their existing behavior. Claiming Cancel never requires or mutates funds.
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
  v_actor_agency text;
  v_current_status jsonb;
  v_prior_lifecycle text;
begin
  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id and not legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  v_prior_lifecycle := public.resolve_booking_lifecycle(
    v_booking.status, v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, v_booking.operation_kind
  );
  if v_booking.supplier = 'shapontravels' then
    if v_booking.status not in ('on-hold', 'pending')
       or v_prior_lifecycle not in ('on-hold', 'pending', 'unconfirmed', 'expired')
       or v_booking.operation_kind is not null
       or v_booking.active_operation_id is not null
       or v_booking.operation_request_id is not null
       or v_booking.operation_started_at is not null
       or v_booking.issued_at is not null
       or v_booking.direct_ticketing
       or v_booking.payment_state not in ('unpaid', 'released') then
      return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_CANCELLABLE');
    end if;
    if not public.booking_uses_saved_references(v_booking) then
      return jsonb_build_object('ok', false, 'code', 'SUPPLIER_REFERENCES_MISSING');
    end if;
    if nullif(btrim(v_booking.ticket_code_ref), '') is not null
       or coalesce(v_booking.ticket_numbers, '[]'::jsonb) <> '[]'::jsonb
       or coalesce(v_booking.captured_amount, 0) > 0 then
      return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_CANCELLABLE');
    end if;
    v_current_status := public.shapon_booking_current_status_v1(v_booking);
    -- Saved review flags can include an expired Issue Ticket cutoff. They are
    -- not a cancellation permission; the application checks fresh canCancel.
    if v_current_status is not null and coalesce(
      v_current_status#>>'{currentStatus,status}' not in
        ('on-hold', 'pending', 'unconfirmed', 'expired'), true
    ) then
      return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_CANCELLABLE');
    end if;

    select role, agency_code into v_actor_role, v_actor_agency
      from public.app_users where clerk_id = p_actor_user_id;
    if v_booking.booking_owner_type is null
       or nullif(v_booking.booking_owner_key, '') is null
       or not coalesce(
         v_actor_role in ('superadmin', 'admin', 'staff_account')
         or (v_actor_role = 'customer'
           and v_booking.booking_owner_type = 'user'
           and v_booking.booking_owner_key = p_actor_user_id)
         or (v_actor_role in ('b2b', 'b2b_sub')
           and v_booking.booking_owner_type = 'agency'
           and v_booking.booking_owner_key = v_actor_agency),
         false
       ) then
      return jsonb_build_object('ok', false, 'code', 'CANCEL_FORBIDDEN');
    end if;
  else
    -- Preserve the existing Triplover cancellation contract.
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
         operation_prior_status = v_booking.status
   where id = p_booking_id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation, idempotency_key
  ) values (
    p_booking_id, v_prior_lifecycle, 'in-progress', v_booking.status, 'in-progress',
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
  'Claims verified, owned, unissued Shapontravels On Hold, Pending, Unconfirmed or Expired API bookings for cancellation and preserves existing Triplover behavior. No wallet balance or local Issue Ticket grant is required.';

-- A failed authentication/configuration/start boundary is not a supplier
-- refusal. No outbound Cancel occurred, so restore only its own untouched
-- claimed operation without inventing a future deadline or requiring PNR read
-- evidence. Once the durable dispatch boundary exists this RPC cannot restore.
create or replace function public.restore_shapon_cancellation_not_sent_v1(
  p_booking_id uuid,
  p_actor_user_id text,
  p_request_key text,
  p_request_payload_hash text,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_restored_lifecycle text;
begin
  if nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_request_key), '') is null
     or p_request_payload_hash is null
     or p_request_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid cancellation restore identity' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  -- Match operation claims: lock the booking before its active operation.
  select * into v_booking from public.flight_bookings
    where id = p_booking_id and not legacy_operational for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select * into v_operation from public.booking_operations
    where id = p_operation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_FOUND');
  end if;
  if v_operation.booking_id is distinct from p_booking_id
     or v_operation.kind is distinct from 'cancellation'
     or v_operation.supplier is distinct from 'shapontravels'
     or v_operation.supplier_operation is distinct from 'Cancel'
     or v_operation.actor_user_id is distinct from p_actor_user_id
     or v_operation.request_key is distinct from p_request_key
     or v_operation.request_payload_hash is distinct from p_request_payload_hash then
    raise exception 'cancellation restore identity mismatch' using errcode = '22023';
  end if;
  if v_operation.state = 'failed'
     and v_operation.error_code = 'CANCELLATION_NOT_SENT' then
    return jsonb_build_object('ok', true, 'replay', true,
      'operationId', p_operation_id, 'operationState', 'failed');
  end if;
  if v_operation.state <> 'claimed'
     or v_operation.supplier_call_started_at is not null
     or v_operation.supplier_response_received_at is not null then
    return jsonb_build_object('ok', false, 'code', 'CANCELLATION_DISPATCH_NOT_CLEAR',
      'operationId', p_operation_id, 'operationState', v_operation.state);
  end if;
  if v_booking.active_operation_id is distinct from p_operation_id
     or v_booking.operation_request_id is distinct from p_request_key
     or v_booking.operation_actor_user_id is distinct from p_actor_user_id
     or v_booking.status <> 'in-progress'
     or v_booking.operation_kind is distinct from 'cancellation'
     or v_booking.operation_reason is distinct from 'cancellation'
     or v_booking.operation_prior_status is null
     or v_booking.operation_prior_status not in ('on-hold', 'pending')
     or v_booking.operation_prior_status is distinct from v_operation.prior_stored_status
     or v_booking.supplier is distinct from 'shapontravels'
     or v_booking.supplier_account is distinct from 'shapontravels'
     or v_booking.import_source is not null
     or v_booking.direct_ticketing
     or v_booking.issued_at is not null
     or nullif(btrim(v_booking.ticket_code_ref), '') is not null
     or coalesce(v_booking.ticket_numbers, '[]'::jsonb) <> '[]'::jsonb
     or coalesce(v_booking.captured_amount, 0) > 0
     or v_booking.payment_state not in ('unpaid', 'released') then
    return jsonb_build_object('ok', false, 'code', 'CANCELLATION_RESTORE_CONFLICT');
  end if;
  v_restored_lifecycle := public.resolve_booking_lifecycle(
    v_booking.operation_prior_status, v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, null
  );
  if v_restored_lifecycle is null
     or v_restored_lifecycle not in ('on-hold', 'pending', 'unconfirmed', 'expired') then
    return jsonb_build_object('ok', false, 'code', 'CANCELLATION_RESTORE_CONFLICT');
  end if;
  update public.booking_operations set state = 'failed', completed_at = now(),
    error_code = 'CANCELLATION_NOT_SENT',
    error_message = 'Cancellation was not dispatched to Shapontravels',
    supplier_evidence = supplier_evidence || jsonb_build_object(
      'finalOutcome', jsonb_build_object('supplierApiCalled', false,
        'reason', 'cancellation_not_sent', 'walletMutation', false)
    ) where id = p_operation_id;
  update public.flight_bookings set status = v_booking.operation_prior_status,
    operation_kind = null, operation_reason = null, operation_request_id = null,
    operation_actor_user_id = null, operation_started_at = null,
    operation_prior_status = null, active_operation_id = null
    where id = p_booking_id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, operation_id
  ) values (
    p_booking_id, 'in-progress', v_restored_lifecycle,
    'in-progress', v_booking.operation_prior_status, 'cancellation',
    'cancellation', p_actor_user_id, 'Cancel',
    jsonb_build_object('supplierApiCalled', false, 'walletMutation', false),
    p_request_key || ':cancel-not-sent', p_operation_id
  ) on conflict do nothing;
  return jsonb_build_object('ok', true, 'replay', false,
    'status', v_booking.operation_prior_status, 'lifecycleStatus', v_restored_lifecycle,
    'operationId', p_operation_id, 'operationState', 'failed', 'walletMutation', false);
end;
$$;

revoke all on function public.restore_shapon_cancellation_not_sent_v1(
  uuid, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.restore_shapon_cancellation_not_sent_v1(
  uuid, text, text, text, uuid
) to service_role;

comment on function public.restore_shapon_cancellation_not_sent_v1(uuid, text, text, text, uuid) is
  'Restores only the matching actor and untouched Shapontravels cancellation claim before any durable supplier dispatch or response, preserving prior lifecycle/deadlines/payment without wallet mutation.';
