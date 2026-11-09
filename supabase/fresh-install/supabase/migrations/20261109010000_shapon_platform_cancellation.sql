-- Shapon Cancel closes its platform booking. The public receipt carries no
-- carrier cancellation confirmation and grants no wallet authority.
begin;

-- Use the existing audit-only outbox policy. The new reason is accepted only
-- for Shapon's internal claim or failed restoration event.
do $migration$
declare
  v_definition text := pg_get_functiondef(
    'public.resolve_booking_notification_policy_v1(text,text,text,text,jsonb)'::regprocedure);
  v_anchor text := '  if v_disposition = ''audit_only'' then';
begin
  if v_definition is null
      or (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor) <> 1 then
    raise exception 'unexpected booking notification policy source';
  end if;
  v_definition := replace(v_definition,v_anchor,v_anchor||$guard$
    if v_reason = 'shapon_cancellation_internal'
        and p_operation_kind = 'cancellation' and p_supplier_operation = 'Cancel'
        and p_event_snapshot->>'operationSource' = 'shapontravels'
        and p_event_snapshot->'walletMutation' = 'false'::jsonb
        and (
          (p_event_snapshot->>'shaponCancellationPhase' = 'claim'
            and p_from_lifecycle_status in ('on-hold','unconfirmed','expired')
            and p_to_lifecycle_status = 'in-progress')
          or (p_event_snapshot->>'shaponCancellationPhase' in ('refused','not-sent')
            and p_from_lifecycle_status = 'in-progress')
        ) then
      return query select 'suppress'::text, v_reason, null::integer;
      return;
    end if;
$guard$);
  execute v_definition;
end;
$migration$;

create function public.shapon_cancellation_actor_allowed_v1(
  p_booking public.flight_bookings,
  p_actor_user_id text,
  p_actor_role text default null
)
returns boolean language sql stable set search_path = public as $$
  select coalesce(exists (
    select 1 from public.app_users actor
    where actor.clerk_id = p_actor_user_id
      and (p_actor_role is null or actor.role = p_actor_role)
      and p_booking.booking_owner_type in ('user', 'agency')
      and nullif(btrim(p_booking.booking_owner_key), '') is not null
      and (
        actor.role in ('superadmin', 'admin', 'staff_account')
        or actor.role = 'customer' and p_booking.booking_owner_type = 'user'
          and p_booking.booking_owner_key = actor.clerk_id
        or actor.role in ('b2b', 'b2b_sub') and p_booking.booking_owner_type = 'agency'
          and nullif(btrim(actor.agency_code), '') is not null
          and p_booking.booking_owner_key = actor.agency_code
      )
  ), false);
$$;
revoke all on function public.shapon_cancellation_actor_allowed_v1(public.flight_bookings,text,text)
  from public, anon, authenticated;
grant execute on function public.shapon_cancellation_actor_allowed_v1(public.flight_bookings,text,text)
  to service_role;

create function public.shapon_platform_cancel_references_ready_v1(p_booking public.flight_bookings)
returns boolean language sql immutable set search_path = public as $$
  select public.booking_uses_saved_references(p_booking) or coalesce(
    p_booking.supplier = 'shapontravels' and p_booking.supplier_account = 'shapontravels'
    and p_booking.import_source is null and not p_booking.legacy_operational
    and not p_booking.direct_ticketing and p_booking.pnr is null
    and p_booking.booking_ref_number is null
    and p_booking.supplier_public_ref ~ '^STR[A-Z0-9]{6,32}$'
    and p_booking.booking_code_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and p_booking.supplier_refs->>'uniqueTransId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and p_booking.supplier_refs->>'itemCodeRef' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and p_booking.supplier_refs->>'priceCodeRef' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    false
  );
$$;

create function public.shapon_platform_cancel_unpaid_v1(p_booking public.flight_bookings)
returns boolean language sql stable set search_path = public as $$
  select p_booking.payment_state = 'unpaid'
    and p_booking.captured_amount = 0 and p_booking.refunded_amount = 0
    and p_booking.charged_wallet_account_id is null and p_booking.payment_amount is null
    and p_booking.issued_at is null and nullif(btrim(p_booking.ticket_code_ref),'') is null
    and coalesce(p_booking.ticket_numbers,'[]'::jsonb) = '[]'::jsonb
    and not exists(select 1 from public.wallet_reservations where booking_id=p_booking.id
      or (booking_id is null and booking_attempt_id=p_booking.attempt_id))
    and not exists(select 1 from public.wallet_ledger_entries where booking_id=p_booking.id
      and transaction_type in ('booking_hold','booking_confirm','hold_release','refund'));
$$;

revoke all on function public.shapon_platform_cancel_references_ready_v1(public.flight_bookings),
  public.shapon_platform_cancel_unpaid_v1(public.flight_bookings) from public,anon,authenticated;
grant execute on function public.shapon_platform_cancel_references_ready_v1(public.flight_bookings),
  public.shapon_platform_cancel_unpaid_v1(public.flight_bookings) to service_role;

create or replace function public.begin_booking_cancellation(
  p_booking_id uuid,
  p_actor_user_id text,
  p_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_booking public.flight_bookings;
  v_actor_role text;
  v_current jsonb;
  v_request_role text;
  v_prior_lifecycle text;
begin
  select * into v_booking from public.flight_bookings
    where id = p_booking_id and not legacy_operational for update;
  if not found then
    return jsonb_build_object('ok',false,'code','BOOKING_NOT_FOUND');
  end if;
  v_prior_lifecycle := public.resolve_booking_lifecycle(v_booking.status,
    v_booking.airlines_pnr,v_booking.ticketing_deadline_at,v_booking.operation_kind);
  if v_booking.supplier = 'shapontravels' then
    if v_booking.status not in ('on-hold','pending')
        or v_prior_lifecycle not in ('on-hold','pending','unconfirmed','expired')
        or v_booking.operation_kind is not null or v_booking.active_operation_id is not null
        or v_booking.issued_at is not null or v_booking.direct_ticketing
        or public.jsonb_is_nonempty_array(v_booking.ticket_numbers)
        or nullif(btrim(v_booking.ticket_code_ref),'') is not null
        or coalesce(v_booking.captured_amount,0) > 0
        or v_booking.payment_state in ('held','captured','reconciliation') then
      return jsonb_build_object('ok',false,'code','BOOKING_NOT_CANCELLABLE');
    end if;
    -- V2 has already recorded the operation actor. A supplied role cannot
    -- elevate a customer or Support identity above the canonical app_users role.
    select actor_role into v_request_role from public.booking_operations
      where booking_id = p_booking_id and request_key = p_idempotency_key
        and actor_user_id = p_actor_user_id and kind = 'cancellation';
    if not public.shapon_cancellation_actor_allowed_v1(v_booking,p_actor_user_id,v_request_role) then
      return jsonb_build_object('ok',false,'code','CANCEL_FORBIDDEN');
    end if;
    -- Includes supplier/account binding, ordinary source, STR, public PNR
    -- mirror (or previous UUID reference) and the four private platform UUIDs.
    if not public.shapon_platform_cancel_references_ready_v1(v_booking) then
      return jsonb_build_object('ok',false,'code','SUPPLIER_REFERENCES_MISSING');
    end if;
    if not public.shapon_platform_cancel_unpaid_v1(v_booking) then
      return jsonb_build_object('ok',false,'code','BOOKING_NOT_CANCELLABLE');
    end if;
    if exists(select 1 from public.booking_reconciliation_cases
      where (subject_booking_id=p_booking_id or subject_booking_attempt_id=v_booking.attempt_id)
        and state not in ('resolved','closed_no_change','superseded')) then
      return jsonb_build_object('ok',false,'code','RECONCILIATION_REQUIRED');
    end if;
    v_current := public.shapon_booking_current_status_v1(v_booking);
    if coalesce(v_current->>'effectiveStatus',v_prior_lifecycle) not in ('on-hold','unconfirmed','expired')
      or (v_booking.pnr is null and coalesce(v_current->>'effectiveStatus',v_prior_lifecycle) <> 'unconfirmed')
      or (v_current is not null and (
        coalesce(v_current#>>'{currentStatus,status}','') not in ('on-hold','unconfirmed','expired')
        or v_current#>'{currentStatus,canCancel}' = 'false'::jsonb
        or (v_current#>'{currentStatus,canCancel}' is distinct from 'true'::jsonb and (
          coalesce((v_current#>>'{currentStatus,reviewRequired}')::boolean,true)
          or (coalesce((v_current->>'reviewRequired')::boolean,true)
            and v_current#>>'{currentStatus,status}' = 'on-hold')
        ))
      )) then
      return jsonb_build_object('ok',false,'code','SUPPLIER_CURRENT_STATUS_BLOCKS_CANCEL');
    end if;
    if v_current is not null then v_prior_lifecycle := v_current->>'effectiveStatus'; end if;
    update public.booking_operations set prior_stored_status = v_booking.status,
      prior_lifecycle_status = v_prior_lifecycle
      where booking_id = p_booking_id and request_key = p_idempotency_key
        and actor_user_id = p_actor_user_id and kind = 'cancellation' and state = 'claimed';
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
    select role into v_actor_role from public.app_users where clerk_id = p_actor_user_id;
    insert into public.booking_local_time_limit_events (
      booking_id,request_id,event_type,actor_user_id,actor_role,
      resulting_deadline_at,operation_request_key,evidence
    ) values (
      p_booking_id,v_booking.active_local_time_limit_request_id,'used_for_cancellation',
      p_actor_user_id,case when v_actor_role in
        ('superadmin','admin','staff_support','staff_account','customer','b2b','b2b_sub')
        then v_actor_role else 'system' end,
      v_booking.local_ticketing_deadline_at,p_idempotency_key,jsonb_build_object('walletMutation',false)
    ) on conflict do nothing;
  end if;
  update public.flight_bookings set status = 'in-progress',
    operation_kind = 'cancellation',operation_reason = 'cancellation',
    operation_request_id = p_idempotency_key,operation_actor_user_id = p_actor_user_id,
    operation_started_at = now(),operation_prior_status = v_booking.status
    where id = p_booking_id;
  insert into public.booking_status_events (
    booking_id,from_lifecycle_status,to_lifecycle_status,stored_status_before,stored_status_after,
    operation_kind,operation_reason,actor_user_id,supplier_operation,idempotency_key,event_snapshot
  ) values (
    p_booking_id,v_prior_lifecycle,'in-progress',v_booking.status,'in-progress',
    'cancellation','cancellation',p_actor_user_id,'Cancel',p_idempotency_key || ':cancellation-start',
    case when v_booking.supplier='shapontravels' then jsonb_build_object(
      'operationSource','shapontravels','shaponCancellationPhase','claim','walletMutation',false,
      'notificationDisposition','audit_only','suppressionReason','shapon_cancellation_internal')
      else '{}'::jsonb end
  ) on conflict do nothing;
  return jsonb_build_object('ok',true,'status','in-progress','walletMutation',false);
end;
$$;

create or replace function public.resolve_shapon_cancellation_not_sent_v1(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_key text,
  p_request_payload_hash text,
  p_operation_id uuid,
  p_evidence jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_evidence jsonb;
  v_restore_status text;
  v_restore_lifecycle text;
  v_restore_current jsonb;
  v_observation jsonb;
  v_observed_at timestamptz;
  v_refusal boolean := coalesce(p_evidence->>'phase'='pre-closure-refusal',false);
  v_error_code text := case when v_refusal then 'SHAPON_CANCEL_REFUSED' else 'SUPPLIER_CALL_NOT_SENT' end;
begin
  if jsonb_typeof(p_evidence) is distinct from 'object' or pg_column_size(p_evidence) > 5000
      or p_evidence->>'retryId' is not null
      or (v_refusal and (p_evidence->'supplierCallStarted' is distinct from 'true'::jsonb
        or coalesce(p_evidence->>'code','') not in ('TICKET_ISSUE_ALREADY_RESERVED','LOCAL_CANCELLATION_NOT_ELIGIBLE')))
      or (not v_refusal and (p_evidence->'supplierCallStarted' is distinct from 'false'::jsonb
        or p_evidence->>'phase' is distinct from 'before-request')) then
    return jsonb_build_object('ok',false,'code','INVALID_NOT_SENT_EVIDENCE');
  end if;
  -- The booking-first lock order matches a new Issue/Cancel claim, which can
  -- inspect this active operation while holding the same booking row.
  select * into v_booking from public.flight_bookings where id = p_booking_id for update;
  if not found then
    return jsonb_build_object('ok',false,'code','BOOKING_NOT_FOUND');
  end if;
  select * into v_operation from public.booking_operations where id = p_operation_id for update;
  if not found then
    return jsonb_build_object('ok',false,'code','OPERATION_NOT_FOUND');
  end if;
  if v_operation.booking_id is distinct from p_booking_id
      or v_operation.kind is distinct from 'cancellation'
      or v_operation.supplier is distinct from 'shapontravels'
      or v_operation.supplier_operation is distinct from 'Cancel'
      or v_operation.actor_user_id is distinct from p_actor_user_id
      or v_operation.actor_role is distinct from p_actor_role
      or v_operation.request_key is distinct from p_request_key
      or v_operation.request_payload_hash is distinct from p_request_payload_hash then
    return jsonb_build_object('ok',false,'code','OPERATION_IDENTITY_MISMATCH');
  end if;
  if v_booking.supplier is distinct from 'shapontravels'
      or not public.shapon_platform_cancel_references_ready_v1(v_booking)
      or not public.shapon_cancellation_actor_allowed_v1(v_booking,p_actor_user_id,p_actor_role) then
    return jsonb_build_object('ok',false,'code','CANCEL_FORBIDDEN');
  end if;
  if v_operation.state = 'failed' and v_operation.error_code = v_error_code
      and (not v_refusal or v_operation.supplier_evidence#>>'{finalOutcome,code}'=p_evidence->>'code') then
    return jsonb_build_object('ok',true,'replay',true,'operationId',p_operation_id,
      'operationState','failed','status',v_booking.status,'walletMutation',false);
  end if;
  if not v_refusal and (v_operation.state <> 'claimed' or v_operation.supplier_call_started_at is not null
      or v_operation.supplier_response_received_at is not null) then
    return jsonb_build_object('ok',false,'code','SUPPLIER_CALL_ALREADY_STARTED');
  end if;
  -- A refusal can resolve only the original dispatch. A retry response
  -- cannot prove that an earlier ambiguous request will never commit.
  if v_refusal and (v_operation.state <> 'supplier_call_started'
      or v_operation.supplier_call_started_at is null
      or v_operation.supplier_response_received_at is null
      or v_operation.supplier_evidence->>'httpStatus' is distinct from '409') then
    return jsonb_build_object('ok',false,'code','SHAPON_CANCEL_REFUSAL_UNVERIFIED');
  end if;
  if v_booking.active_operation_id is distinct from p_operation_id
      or v_booking.status <> 'in-progress'
      or v_booking.operation_kind is distinct from 'cancellation'
      or v_booking.operation_reason is distinct from 'cancellation'
      or v_booking.operation_request_id is distinct from p_request_key
      or v_booking.operation_actor_user_id is distinct from p_actor_user_id
      or coalesce(v_booking.operation_prior_status,'') not in ('on-hold','pending')
      or v_booking.issued_at is not null or v_booking.direct_ticketing
      or public.jsonb_is_nonempty_array(v_booking.ticket_numbers)
      or nullif(btrim(v_booking.ticket_code_ref),'') is not null
      or coalesce(v_booking.captured_amount,0) > 0
      or v_booking.payment_state in ('held','captured','reconciliation') then
    return jsonb_build_object('ok',false,'code','CANCELLATION_OPERATION_NOT_ACTIVE');
  end if;
  if v_refusal and not public.shapon_platform_cancel_unpaid_v1(v_booking) then
    return jsonb_build_object('ok',false,'code','CANCELLATION_OPERATION_NOT_ACTIVE');
  end if;
  if exists(select 1 from public.booking_reconciliation_cases
      where (subject_booking_id=p_booking_id or subject_booking_attempt_id=v_booking.attempt_id)
        and state not in ('resolved','closed_no_change','superseded')) then
    return jsonb_build_object('ok',false,'code','RECONCILIATION_REQUIRED');
  end if;
  v_evidence := jsonb_build_object('supplierCallStarted',v_refusal,'phase',p_evidence->>'phase',
    'code',left(coalesce(p_evidence->>'code','SUPPLIER_CALL_NOT_SENT'),100),'actorRole',p_actor_role);
  if v_refusal then v_evidence := v_evidence||jsonb_build_object('walletMutation',false); end if;
  v_restore_status := v_booking.operation_prior_status;
  v_restore_lifecycle := public.resolve_booking_lifecycle(v_restore_status,
    v_booking.airlines_pnr,v_booking.ticketing_deadline_at,null);
  update public.flight_bookings set
    status = v_restore_status, active_operation_id = null,
    operation_kind = null, operation_reason = null, operation_request_id = null,
    operation_actor_user_id = null, operation_started_at = null, operation_prior_status = null
    where id = p_booking_id returning * into v_booking;
  update public.booking_operations set state = 'failed', completed_at = now(),
    error_code = v_error_code,
    error_message = case when v_refusal then 'Shapon refused cancellation before platform closure'
      else 'Cancellation was not sent to Shapon' end,
    supplier_evidence = supplier_evidence || jsonb_build_object('finalOutcome',v_evidence)
    where id = p_operation_id;
  v_restore_current := public.shapon_booking_current_status_v1(v_booking);
  if v_refusal then
    -- A known refusal proves no closure, but previously displayed permission
    -- is stale. Keep that action fenced until another verified saved read.
    select greatest(clock_timestamp(),max(request_started_at)+interval '1 microsecond')
      into v_observed_at from public.shapon_booking_current_status_observations where booking_id=p_booking_id;
    v_observation := public.record_shapon_booking_current_status_v1(p_booking_id,v_observed_at,v_booking.supplier_public_ref,
      jsonb_build_object('uniqueTransId',v_booking.supplier_refs->'uniqueTransId',
        'itemCodeRef',v_booking.supplier_refs->'itemCodeRef','priceCodeRef',v_booking.supplier_refs->'priceCodeRef',
        'bookingCodeRef',v_booking.booking_code_ref,'bookingRefNumber',v_booking.booking_ref_number,
        'pnr',v_booking.pnr,'supplierPublicRef',v_booking.supplier_public_ref,
        'originalBookingStatus',v_booking.booking_status,'canCancel',false),
      jsonb_build_object('status',coalesce(v_restore_current#>>'{currentStatus,status}',v_restore_lifecycle),
        'reviewRequired',true,'source','public_receipt','verified',false,'bookingState',null,
        'supplierStatus',null,'checkedAt',null,'supplierCheckedAt',null,'lastCheck',null));
    if v_observation->'recorded' is distinct from 'true'::jsonb then
      raise exception 'Shapon cancellation refusal action fence was not recorded';
    end if;
  end if;
  if v_restore_current is not null then
    v_restore_lifecycle := v_restore_current->>'effectiveStatus';
  end if;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind, operation_reason,
    actor_user_id, supplier_operation, supplier_evidence,
    operation_id, idempotency_key, event_snapshot
  ) values (
    p_booking_id,'in-progress',v_restore_lifecycle,'in-progress',v_restore_status,'cancellation','cancellation',
    p_actor_user_id,'Cancel',v_evidence,p_operation_id,p_request_key ||
      case when v_refusal then ':cancel-refused' else ':cancel-not-sent' end,
    jsonb_build_object('operationSource','shapontravels',
      'shaponCancellationPhase',case when v_refusal then 'refused' else 'not-sent' end,
      'walletMutation',false,'notificationDisposition','audit_only',
      'suppressionReason','shapon_cancellation_internal')
  ) on conflict do nothing;
  return jsonb_build_object('ok',true,'replay',false,'operationId',p_operation_id,
    'operationState','failed','status',v_restore_status,'walletMutation',false);
end;
$$;

-- The original Shapon key is durable. Lease only its exact operation and
-- keep the reconciliation pointer while a user explicitly retries that key.
create function public.advance_shapon_platform_cancel_retry_v1(
  p_booking_id uuid, p_actor_user_id text, p_actor_role text, p_request_key text,
  p_request_payload_hash text, p_operation_id uuid, p_retry_id uuid, p_http_status integer,
  p_booking_identity jsonb, p_saved_started_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_retry jsonb;
  v_history jsonb;
  v_case public.booking_reconciliation_cases;
  v_found_case boolean := false;
  v_now timestamptz;
begin
  select * into v_booking from public.flight_bookings where id=p_booking_id for update;
  if not found then return jsonb_build_object('ok',false,'code','BOOKING_NOT_FOUND'); end if;
  select * into v_operation from public.booking_operations where id=p_operation_id for update;
  if not found or p_retry_id is null or v_booking.active_operation_id is distinct from p_operation_id
    or v_booking.status <> 'in-progress' or v_booking.operation_kind is distinct from 'reconciliation'
    or v_booking.operation_reason is distinct from 'cancellation_reconciliation'
    or v_booking.operation_request_id is distinct from p_request_key
    or v_booking.operation_actor_user_id is distinct from p_actor_user_id
    or not public.shapon_platform_cancel_references_ready_v1(v_booking)
    or not public.shapon_platform_cancel_unpaid_v1(v_booking)
    or not public.shapon_cancellation_actor_allowed_v1(v_booking,p_actor_user_id,p_actor_role)
    or v_operation.booking_id is distinct from p_booking_id or v_operation.kind is distinct from 'cancellation'
    or v_operation.supplier is distinct from 'shapontravels' or v_operation.supplier_operation is distinct from 'Cancel'
    or v_operation.state <> 'needs_reconciliation' or v_operation.supplier_call_started_at is null
    or v_operation.request_key is distinct from p_request_key
    or v_operation.request_payload_hash is distinct from p_request_payload_hash
    or v_operation.actor_user_id is distinct from p_actor_user_id or v_operation.actor_role is distinct from p_actor_role
    or v_operation.supplier_unique_trans_id is distinct from v_booking.supplier_refs->>'uniqueTransId'
    or v_operation.supplier_booking_code_ref is distinct from v_booking.booking_code_ref
    or v_operation.supplier_pnr is distinct from coalesce(v_booking.booking_ref_number,v_booking.pnr)
    or p_booking_identity->>'supplierPublicRef' is distinct from v_booking.supplier_public_ref
    or p_booking_identity->>'bookingCodeRef' is distinct from v_booking.booking_code_ref
    or p_booking_identity->>'uniqueTransId' is distinct from v_booking.supplier_refs->>'uniqueTransId'
    or p_booking_identity->>'itemCodeRef' is distinct from v_booking.supplier_refs->>'itemCodeRef'
    or p_booking_identity->>'priceCodeRef' is distinct from v_booking.supplier_refs->>'priceCodeRef'
    or p_booking_identity->>'pnr' is distinct from coalesce(v_booking.pnr,'')
    or p_booking_identity->>'bookingRefNumber' is distinct from coalesce(v_booking.booking_ref_number,'') then
    return jsonb_build_object('ok',false,'code','SHAPON_RETRY_NOT_ELIGIBLE');
  end if;
  v_retry := v_operation.supplier_evidence->'shaponCancelRetry';
  v_history := coalesce(v_operation.supplier_evidence->'shaponCancelRetryHistory','[]'::jsonb);
  v_now := clock_timestamp();
  if p_http_status is null then
    if p_saved_started_at is null or not isfinite(p_saved_started_at)
      or p_saved_started_at < v_now-interval '2 minutes' or p_saved_started_at > v_now+interval '5 minutes'
      or exists(select 1 from public.shapon_booking_current_status_observations observation
        where observation.booking_id=p_booking_id and observation.request_started_at>p_saved_started_at
          and (observation.current_status->>'status' not in ('on-hold','unconfirmed','expired')
            or observation.receipt_identity->'canCancel' = 'false'::jsonb)) then
      return jsonb_build_object('ok',false,'code','SHAPON_RETRY_STATUS_STALE');
    end if;
    if coalesce((v_retry->>'leaseUntil')::timestamptz > v_now,false) then
      return jsonb_build_object('ok',false,'code','SHAPON_RETRY_IN_PROGRESS');
    end if;
    for v_case in select * from public.booking_reconciliation_cases
      where (subject_booking_id=p_booking_id or subject_booking_attempt_id=v_booking.attempt_id)
        and state not in ('resolved','closed_no_change','superseded') order by id for update loop
      if v_found_case or v_case.subject_booking_id is distinct from p_booking_id
        or v_case.operation_id is distinct from p_operation_id or v_case.case_type <> 'cancellation_uncertainty'
        or v_case.state not in ('open','assigned','awaiting_supplier','awaiting_finance')
        or v_case.proposal_hash is not null or v_case.proposed_outcome is not null
        or v_case.proposal <> '{}'::jsonb or v_case.approved_at is not null then
        return jsonb_build_object('ok',false,'code','SHAPON_RETRY_NOT_ELIGIBLE');
      end if;
      v_found_case := true;
    end loop;
    if not v_found_case then return jsonb_build_object('ok',false,'code','SHAPON_RETRY_NOT_ELIGIBLE'); end if;
    if v_retry is not null then v_history := v_history||jsonb_build_array(v_retry); end if;
    v_retry := jsonb_build_object('id',p_retry_id,'startedAt',v_now,'leaseUntil',v_now+interval '3 minutes');
  else
    if p_http_status not between 100 and 599 or v_retry->>'id' is distinct from p_retry_id::text
      or v_retry ? 'httpStatus' then
      return jsonb_build_object('ok',false,'code','SHAPON_RETRY_IDENTITY_MISMATCH');
    end if;
    v_retry := v_retry||jsonb_build_object('httpStatus',p_http_status,'responseAt',v_now);
  end if;
  update public.booking_operations set supplier_evidence=supplier_evidence||
    jsonb_build_object('shaponCancelRetry',v_retry,'shaponCancelRetryHistory',v_history) where id=p_operation_id;
  return jsonb_build_object('ok',true);
end;
$$;

revoke all on function public.advance_shapon_platform_cancel_retry_v1(uuid,text,text,text,text,uuid,uuid,integer,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function public.advance_shapon_platform_cancel_retry_v1(uuid,text,text,text,text,uuid,uuid,integer,jsonb,timestamptz)
  to service_role;

create function public.finalize_shapon_platform_cancel_v1(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_key text,
  p_request_payload_hash text,
  p_operation_id uuid,
  p_outcome jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_case_id uuid;
  v_now timestamptz := clock_timestamp();
  v_evidence jsonb;
begin
  select * into v_booking from public.flight_bookings where id=p_booking_id for update;
  if not found then return jsonb_build_object('ok',false,'code','BOOKING_NOT_FOUND'); end if;
  select * into v_operation from public.booking_operations where id=p_operation_id for update;
  if not found or v_operation.booking_id is distinct from p_booking_id
    or v_operation.kind is distinct from 'cancellation'
    or v_operation.supplier is distinct from 'shapontravels'
    or v_operation.supplier_operation is distinct from 'Cancel'
    or v_operation.request_key is distinct from p_request_key
    or v_operation.request_payload_hash is distinct from p_request_payload_hash
    or v_operation.actor_user_id is distinct from p_actor_user_id
    or v_operation.actor_role is distinct from p_actor_role then
    return jsonb_build_object('ok',false,'code','OPERATION_IDENTITY_MISMATCH');
  end if;
  if v_booking.supplier is distinct from 'shapontravels'
    or not public.shapon_platform_cancel_references_ready_v1(v_booking)
    or not public.shapon_cancellation_actor_allowed_v1(v_booking,p_actor_user_id,p_actor_role)
    or v_operation.supplier_unique_trans_id is distinct from v_booking.supplier_refs->>'uniqueTransId'
    or v_operation.supplier_booking_code_ref is distinct from v_booking.booking_code_ref
    or v_operation.supplier_pnr is distinct from coalesce(v_booking.booking_ref_number,v_booking.pnr)
    or jsonb_typeof(p_outcome) is distinct from 'object'
    or p_outcome->'isCancel' is distinct from 'true'::jsonb
    or p_outcome->>'status' is distinct from 'cancelled'
    or p_outcome->'walletMutation' is distinct from 'false'::jsonb
    or p_outcome->>'uniqueTransId' is distinct from v_booking.supplier_refs->>'uniqueTransId'
    or p_outcome->>'itemCodeRef' is distinct from v_booking.supplier_refs->>'itemCodeRef'
    or p_outcome->>'priceCodeRef' is distinct from v_booking.supplier_refs->>'priceCodeRef'
    or p_outcome->>'bookingCodeRef' is distinct from v_booking.booking_code_ref
    or p_outcome->>'savedBookingId' is distinct from v_booking.booking_code_ref
    or p_outcome->>'supplierPublicRef' is distinct from v_booking.supplier_public_ref then
    return jsonb_build_object('ok',false,'code','SHAPON_CLOSURE_UNVERIFIED');
  end if;
  if v_operation.state='succeeded' and v_booking.status='cancelled'
    and v_operation.supplier_evidence#>'{finalOutcome,platformClosure}' = 'true'::jsonb then
    return jsonb_build_object('ok',true,'replay',true,'status','cancelled','walletMutation',false);
  end if;
  if v_booking.status <> 'in-progress' or v_booking.active_operation_id is distinct from p_operation_id
    or v_booking.operation_request_id is distinct from p_request_key
    or v_booking.operation_actor_user_id is distinct from p_actor_user_id
    or v_operation.supplier_call_started_at is null
    or v_operation.state not in ('supplier_call_started','needs_reconciliation')
    or not public.shapon_platform_cancel_unpaid_v1(v_booking)
    or not (
      (v_operation.state='supplier_call_started' and v_booking.operation_kind='cancellation'
        and v_booking.operation_reason='cancellation')
      or (v_operation.state='needs_reconciliation' and v_booking.operation_kind='reconciliation'
        and v_booking.operation_reason='cancellation_reconciliation')) then
    return jsonb_build_object('ok',false,'code','SHAPON_CLOSURE_REVIEW_REQUIRED');
  end if;

  for v_case in select * from public.booking_reconciliation_cases
    where (subject_booking_id=p_booking_id or subject_booking_attempt_id=v_booking.attempt_id)
      and state not in ('resolved','closed_no_change','superseded') order by id for update loop
    if v_case_id is not null
      or v_case.subject_booking_id is distinct from p_booking_id
      or v_case.operation_id is distinct from p_operation_id
      or v_case.case_type <> 'cancellation_uncertainty'
      or v_case.state not in ('open','assigned','awaiting_supplier','awaiting_finance')
      or v_case.proposal_hash is not null or v_case.proposed_outcome is not null
      or v_case.proposal <> '{}'::jsonb or v_case.approved_at is not null then
      return jsonb_build_object('ok',false,'code','SHAPON_CLOSURE_REVIEW_REQUIRED');
    end if;
    v_case_id := v_case.id;
  end loop;
  if v_operation.state='needs_reconciliation' and v_case_id is null then
    return jsonb_build_object('ok',false,'code','SHAPON_CLOSURE_REVIEW_REQUIRED');
  end if;

  v_evidence := jsonb_build_object('platformClosure',true,'walletMutation',false,
    'status','cancelled','observedBy','saved_booking');
  update public.flight_bookings set status='cancelled',booking_status='Cancelled',
    cancelled_at=v_now,cancelled_by=p_actor_user_id,cancel_reason='Booking closed on the Shapon platform',
    active_operation_id=null,operation_kind=null,operation_reason=null,operation_request_id=null,
    operation_actor_user_id=null,operation_started_at=null,operation_prior_status=null
    where id=p_booking_id;
  if v_booking.supplier_public_ref is not null then
    perform public.record_shapon_booking_current_status_v1(p_booking_id,v_now,v_booking.supplier_public_ref,
      jsonb_build_object('uniqueTransId',v_booking.supplier_refs->'uniqueTransId',
        'itemCodeRef',v_booking.supplier_refs->'itemCodeRef',
        'priceCodeRef',v_booking.supplier_refs->'priceCodeRef',
        'bookingCodeRef',v_booking.booking_code_ref,'bookingRefNumber',v_booking.booking_ref_number,
        'pnr',v_booking.pnr,'supplierPublicRef',v_booking.supplier_public_ref,
        'originalBookingStatus',v_booking.booking_status,'canCancel',false),
      jsonb_build_object('status','cancelled','reviewRequired',false,'source','public_receipt',
        'verified',false,'bookingState',null,'supplierStatus',null,'checkedAt',null,
        'supplierCheckedAt',null,'lastCheck',null));
  end if;
  update public.booking_operations set state='succeeded',completed_at=v_now,error_code=null,error_message=null,
    supplier_evidence=supplier_evidence||jsonb_build_object('finalOutcome',v_evidence)
    where id=p_operation_id;
  if v_case_id is not null then
    update public.booking_reconciliation_cases set state='resolved',resolution_outcome='cancelled_unpaid',
      resolution=jsonb_build_object('version',1,'resolutionKind','shapon_platform_closure',
        'operationId',p_operation_id,'executedByRole',p_actor_role,'walletMutation',false),
      resolution_reason='Matching closure verified from the Shapon saved booking',
      resolved_by_user_id=p_actor_user_id,resolved_at=v_now,closed_at=v_now,version=version+1 where id=v_case_id;
  end if;
  insert into public.booking_status_events(booking_id,from_lifecycle_status,to_lifecycle_status,
    stored_status_before,stored_status_after,operation_kind,operation_reason,actor_user_id,
    supplier_operation,supplier_evidence,idempotency_key,operation_id,reconciliation_case_id,event_snapshot)
  values(p_booking_id,'in-progress','cancelled','in-progress','cancelled',
    v_booking.operation_kind,v_booking.operation_reason,p_actor_user_id,'Cancel',
    v_evidence,p_request_key||':shapon-platform-closed',p_operation_id,v_case_id,
    jsonb_build_object('operationSource','shapontravels','paymentState','unpaid','walletMutation',false));
  return jsonb_build_object('ok',true,'replay',false,'status','cancelled','walletMutation',false);
end;
$$;

revoke all on function public.finalize_shapon_platform_cancel_v1(uuid,text,text,text,text,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.finalize_shapon_platform_cancel_v1(uuid,text,text,text,text,uuid,jsonb)
  to service_role;

-- Native Shapon cancellation never acquires wallet authority, including an
-- old application caller or an uncertain response after a concurrent hold.
do $migration$
declare
  v_definition text;
  v_anchor text;
begin
  v_definition := pg_get_functiondef(
    'public.wallet_finalize_booking_cancel(uuid,text,text,text,text)'::regprocedure);
  v_anchor := '  v_release := public.wallet_release_reservation(';
  if strpos(v_definition,v_anchor)=0 then raise exception 'Unexpected legacy Cancel finalizer'; end if;
  execute replace(v_definition,v_anchor,$guard$  if v_booking.supplier = 'shapontravels' then
    return jsonb_build_object('ok',false,'code','SHAPON_PLATFORM_CLOSURE_REQUIRED');
  end if;
$guard$||v_anchor);

  v_definition := pg_get_functiondef(
    'public.wallet_finalize_booking_cancel_v2(uuid,text,text,text,text,uuid,text,jsonb)'::regprocedure);
  v_anchor := '  v_result := public.wallet_finalize_booking_cancel(';
  if strpos(v_definition,v_anchor)=0 then raise exception 'Unexpected operation Cancel finalizer'; end if;
  execute replace(v_definition,v_anchor,$guard$  if exists(select 1 from public.flight_bookings
    where id=p_booking_id and supplier='shapontravels') then
    return jsonb_build_object('ok',false,'code','SHAPON_PLATFORM_CLOSURE_REQUIRED');
  end if;
$guard$||v_anchor);

  v_definition := pg_get_functiondef(
    'public.record_supplier_write_uncertainty_v2(uuid,uuid,uuid,text,text,text,text,text,integer,boolean,boolean,jsonb,text,text)'::regprocedure);
  v_anchor := '  if p_booking_id is not null then';
  if strpos(v_definition,v_anchor)=0 then raise exception 'Unexpected uncertainty lock ordering'; end if;
  v_definition := replace(v_definition,v_anchor,$guard$  if p_booking_id is not null then
    -- Match the Shapon closure and retry lock order before locking its operation.
    perform 1 from public.flight_bookings where id=p_booking_id
      and supplier='shapontravels' and operation_reason in ('cancellation','cancellation_reconciliation')
      and active_operation_id=p_operation_id for update;
$guard$);
  v_anchor := E'    v_wallet_result := public.wallet_mark_reconciliation(\n      p_booking_id, null, v_reason_detail\n    );';
  if strpos(v_definition,v_anchor)=0 then raise exception 'Unexpected uncertainty wallet handling'; end if;
  execute replace(v_definition,v_anchor,$guard$    if v_operation.supplier='shapontravels' and v_operation.kind='cancellation' then
      update public.flight_bookings set operation_kind='reconciliation',
        operation_reason='cancellation_reconciliation',
        operation_started_at=coalesce(operation_started_at,now())
        where id=p_booking_id and supplier='shapontravels' and supplier_account='shapontravels'
          and status='in-progress' and active_operation_id=p_operation_id
          and operation_request_id=p_request_key and operation_actor_user_id=p_actor_user_id
          and v_operation.actor_user_id=p_actor_user_id and v_operation.actor_role=p_actor_role
          and operation_reason in ('cancellation','cancellation_reconciliation');
      if not found then return jsonb_build_object('ok',false,'code','CANCELLATION_OPERATION_NOT_ACTIVE'); end if;
      v_wallet_result := jsonb_build_object('ok',true,'walletMutation',false);
    else
$guard$||v_anchor||E'\n    end if;');
end;
$migration$;

commit;
