-- Payload-bound, replay-safe supplier-operation identity. This migration adds
-- no worker and changes no existing route until the versioned claim wrappers
-- below are adopted by the application.

create or replace function public.claim_booking_operation_identity(
  p_booking_id uuid,
  p_kind text,
  p_reason_code text,
  p_reason_detail text,
  p_request_key text,
  p_request_payload_hash text,
  p_actor_user_id text,
  p_actor_role text,
  p_source text,
  p_supplier_operation text,
  p_external_action_due_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_existing public.booking_operations;
  v_active public.booking_operations;
  v_created public.booking_operations;
  v_prior_lifecycle text;
begin
  if p_kind not in ('ticketing', 'cancellation', 'imported_manual_ticketing')
     or nullif(btrim(p_reason_code), '') is null
     or nullif(btrim(p_request_key), '') is null
     or p_request_payload_hash !~ '^[a-f0-9]{64}$'
     or nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_actor_role), '') is null
     or p_source not in (
       'customer', 'staff', 'system', 'import', 'backfill', 'reconciliation'
     ) then
    raise exception 'invalid booking operation identity'
      using errcode = '22023';
  end if;

  -- A request key is global. Serialize even when a malicious/buggy replay
  -- changes the booking id so the second transaction cannot race the unique
  -- index and accidentally receive an unclassified constraint error.
  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));

  select * into v_existing
  from public.booking_operations
  where request_key = p_request_key
  for update;
  if found then
    if v_existing.booking_id is distinct from p_booking_id
       or v_existing.kind is distinct from p_kind
       or v_existing.request_payload_hash is distinct from p_request_payload_hash
       or v_existing.actor_user_id is distinct from p_actor_user_id
       or v_existing.actor_role is distinct from p_actor_role then
      raise exception 'operation request key was reused with different intent'
        using errcode = '22023';
    end if;
    return jsonb_build_object(
      'ok', true,
      'replay', true,
      'operationId', v_existing.id,
      'state', v_existing.state,
      'result', v_existing.supplier_evidence,
      'errorCode', v_existing.error_code
    );
  end if;

  select * into v_booking
  from public.flight_bookings
  where id = p_booking_id and not legacy_operational
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  select * into v_active
  from public.booking_operations
  where booking_id = p_booking_id
    and state in (
      'claimed', 'supplier_call_started', 'awaiting_external_action',
      'needs_reconciliation'
    )
  order by claimed_at desc, id desc
  limit 1
  for update;
  if found then
    return jsonb_build_object(
      'ok', false,
      'code', 'OPERATION_ALREADY_ACTIVE',
      'operationId', v_active.id,
      'state', v_active.state
    );
  end if;

  v_prior_lifecycle := public.resolve_booking_lifecycle(
    v_booking.status,
    v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at,
    v_booking.operation_kind
  );

  insert into public.booking_operations (
    booking_id, kind, state, reason_code, reason_detail,
    request_key, request_payload_hash,
    actor_user_id, actor_role, source,
    prior_stored_status, prior_lifecycle_status,
    supplier, supplier_operation, supplier_unique_trans_id,
    supplier_booking_code_ref, supplier_pnr,
    external_action_due_at, policy_version, claimed_at
  ) values (
    v_booking.id, p_kind, 'claimed', p_reason_code,
    nullif(btrim(p_reason_detail), ''),
    p_request_key, p_request_payload_hash,
    p_actor_user_id, p_actor_role, p_source,
    v_booking.status, v_prior_lifecycle,
    v_booking.supplier, nullif(btrim(p_supplier_operation), ''),
    v_booking.supplier_refs->>'uniqueTransId',
    v_booking.booking_code_ref,
    coalesce(v_booking.booking_ref_number, v_booking.pnr),
    p_external_action_due_at, 1, now()
  ) returning * into v_created;

  return jsonb_build_object(
    'ok', true,
    'replay', false,
    'operationId', v_created.id,
    'state', v_created.state,
    'result', v_created.supplier_evidence,
    'errorCode', v_created.error_code
  );
end;
$$;

revoke all on function public.claim_booking_operation_identity(
  uuid, text, text, text, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_booking_operation_identity(
  uuid, text, text, text, text, text, text, text, text, text, timestamptz
) to service_role;

comment on function public.claim_booking_operation_identity(
  uuid, text, text, text, text, text, text, text, text, text, timestamptz
) is
  'Internal replay boundary. An exact request-key replay returns its existing operation/result; any booking/kind/payload/actor mismatch raises 22023. Does not call the supplier.';

create or replace function public.booking_operation_replay_response(
  p_claim jsonb
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce((p_claim->>'replay')::boolean, false) is not true then null
    when p_claim->>'state' = 'succeeded' then
      jsonb_build_object(
        'ok', true, 'replay', true,
        'operationId', p_claim->>'operationId',
        'operationState', p_claim->>'state',
        'operationResult', p_claim->'result'
      )
    when p_claim->>'state' = 'failed' then
      jsonb_build_object(
        'ok', false, 'replay', true,
        'code', coalesce(p_claim->>'errorCode', 'OPERATION_FAILED'),
        'operationId', p_claim->>'operationId',
        'operationState', p_claim->>'state'
      )
    when p_claim->>'state' in (
      'needs_reconciliation', 'awaiting_external_action'
    ) then
      jsonb_build_object(
        'ok', false, 'replay', true,
        'code', 'RECONCILIATION_REQUIRED',
        'operationId', p_claim->>'operationId',
        'operationState', p_claim->>'state'
      )
    else
      jsonb_build_object(
        'ok', false, 'replay', true,
        'code', 'OPERATION_IN_PROGRESS',
        'operationId', p_claim->>'operationId',
        'operationState', p_claim->>'state'
      )
  end
$$;

revoke all on function public.booking_operation_replay_response(jsonb)
  from public, anon, authenticated;
grant execute on function public.booking_operation_replay_response(jsonb)
  to service_role;

-- NewTicket claim: operation identity, wallet hold, compatibility state, event,
-- and active pointer commit or roll back as one transaction.
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
       set state = 'failed', completed_at = now(),
           error_code = coalesce(v_result->>'code', 'CLAIM_FAILED'),
           supplier_evidence = jsonb_build_object(
             'phase', 'local_claim',
             'resultCode', v_result->>'code'
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

-- Compatibility Pending claim. No new workflow may create Pending; this exists
-- only to make a retained legacy retry owned and replay-safe.
create or replace function public.wallet_begin_legacy_manual_issue_v2(
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
  v_claim := public.claim_booking_operation_identity(
    p_booking_id, 'ticketing', 'legacy_reconciliation',
    'Compatibility Pending manual ticketing claim',
    p_request_key, p_request_payload_hash,
    p_actor_user_id, p_actor_role, 'reconciliation', 'NewTicket', null
  );
  if coalesce((v_claim->>'ok')::boolean, false) is not true then
    return v_claim;
  end if;
  v_replay := public.booking_operation_replay_response(v_claim);
  if v_replay is not null then return v_replay; end if;
  v_operation_id := (v_claim->>'operationId')::uuid;

  v_result := public.wallet_begin_legacy_manual_issue(
    p_booking_id, p_actor_user_id, p_request_key
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    update public.booking_operations
       set state = 'failed', completed_at = now(),
           error_code = coalesce(v_result->>'code', 'CLAIM_FAILED'),
           supplier_evidence = jsonb_build_object(
             'phase', 'local_claim',
             'resultCode', v_result->>'code'
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
     and idempotency_key = p_request_key || ':legacy-ticketing-start';
  return v_result || jsonb_build_object(
    'replay', false,
    'operationId', v_operation_id,
    'operationState', 'claimed'
  );
end;
$$;

-- Cancel claim: booking row, compatibility status, immutable event, and durable
-- cancellation operation are protected by the same transaction and row lock.
create or replace function public.begin_booking_cancellation_v2(
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
  v_claim := public.claim_booking_operation_identity(
    p_booking_id, 'cancellation', 'cancellation', null,
    p_request_key, p_request_payload_hash,
    p_actor_user_id, p_actor_role, 'staff', 'Cancel', null
  );
  if coalesce((v_claim->>'ok')::boolean, false) is not true then
    return v_claim;
  end if;
  v_replay := public.booking_operation_replay_response(v_claim);
  if v_replay is not null then return v_replay; end if;
  v_operation_id := (v_claim->>'operationId')::uuid;

  v_result := public.begin_booking_cancellation(
    p_booking_id, p_actor_user_id, p_request_key
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    update public.booking_operations
       set state = 'failed', completed_at = now(),
           error_code = coalesce(v_result->>'code', 'CLAIM_FAILED'),
           supplier_evidence = jsonb_build_object(
             'phase', 'local_claim',
             'resultCode', v_result->>'code'
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
     and idempotency_key = p_request_key || ':cancellation-start';
  return v_result || jsonb_build_object(
    'replay', false,
    'operationId', v_operation_id,
    'operationState', 'claimed'
  );
end;
$$;

revoke all on function public.wallet_begin_booking_issue_v2(
  uuid, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.wallet_begin_legacy_manual_issue_v2(
  uuid, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.begin_booking_cancellation_v2(
  uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.wallet_begin_booking_issue_v2(
  uuid, text, text, text, text
) to service_role;
grant execute on function public.wallet_begin_legacy_manual_issue_v2(
  uuid, text, text, text, text
) to service_role;
grant execute on function public.begin_booking_cancellation_v2(
  uuid, text, text, text, text
) to service_role;

comment on function public.wallet_begin_booking_issue_v2(
  uuid, text, text, text, text
) is
  'Atomically claims NewTicket operation identity, wallet hold, booking In Progress compatibility state, active pointer, and lifecycle event.';
comment on function public.begin_booking_cancellation_v2(
  uuid, text, text, text, text
) is
  'Atomically claims Cancel operation identity, booking In Progress compatibility state, active pointer, and lifecycle event.';

-- Attempt-scoped Book calls exist before a flight_bookings row does. Keep
-- their operational boundary on booking_attempts without turning attempt state
-- into an eighth public booking status.
alter table public.booking_attempts
  add column if not exists operation_request_key text,
  add column if not exists operation_request_payload_hash text,
  add column if not exists supplier_operation text,
  add column if not exists supplier_call_started_at timestamptz,
  add column if not exists supplier_response_received_at timestamptz;

alter table public.booking_attempts
  add constraint booking_attempts_operation_request_key_check
    check (
      operation_request_key is null
      or char_length(operation_request_key) between 1 and 255
    ),
  add constraint booking_attempts_operation_payload_hash_check
    check (
      operation_request_payload_hash is null
      or operation_request_payload_hash ~ '^[a-f0-9]{64}$'
    ),
  add constraint booking_attempts_operation_identity_pair_check
    check (
      (operation_request_key is null) =
      (operation_request_payload_hash is null)
    ),
  add constraint booking_attempts_supplier_operation_check
    check (supplier_operation is null or supplier_operation = 'Book'),
  add constraint booking_attempts_supplier_timestamps_check
    check (
      supplier_response_received_at is null
      or (
        supplier_call_started_at is not null
        and supplier_response_received_at >= supplier_call_started_at
      )
    );

create unique index if not exists booking_attempts_operation_request_key_idx
  on public.booking_attempts (operation_request_key)
  where operation_request_key is not null;
create index if not exists booking_attempts_supplier_call_watchdog_idx
  on public.booking_attempts (supplier_call_started_at, id)
  where state in ('submitting', 'unknown')
    and supplier_call_started_at is not null;

create or replace function public.mark_booking_operation_supplier_call_started(
  p_operation_id uuid,
  p_request_key text,
  p_request_payload_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_operation public.booking_operations;
begin
  select * into v_operation
  from public.booking_operations
  where id = p_operation_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_FOUND');
  end if;
  if v_operation.request_key is distinct from p_request_key
     or v_operation.request_payload_hash is distinct from p_request_payload_hash then
    raise exception 'operation supplier-call boundary identity mismatch'
      using errcode = '22023';
  end if;
  if v_operation.state <> 'claimed' then
    return jsonb_build_object(
      'ok', false,
      'replay', true,
      'code', case
        when v_operation.state in (
          'needs_reconciliation', 'awaiting_external_action'
        ) then 'RECONCILIATION_REQUIRED'
        else 'SUPPLIER_CALL_ALREADY_STARTED'
      end,
      'operationId', v_operation.id,
      'operationState', v_operation.state,
      'supplierCallStartedAt', v_operation.supplier_call_started_at
    );
  end if;
  update public.booking_operations
     set state = 'supplier_call_started',
         supplier_call_started_at = now()
   where id = v_operation.id
   returning * into v_operation;
  return jsonb_build_object(
    'ok', true,
    'started', true,
    'operationId', v_operation.id,
    'operationState', v_operation.state,
    'supplierCallStartedAt', v_operation.supplier_call_started_at
  );
end;
$$;

create or replace function public.mark_booking_attempt_supplier_call_started(
  p_attempt_id uuid,
  p_request_key text,
  p_request_payload_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_attempt public.booking_attempts;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  select * into v_attempt
  from public.booking_attempts
  where id = p_attempt_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_FOUND');
  end if;
  if v_attempt.operation_request_key is not null then
    if v_attempt.operation_request_key is distinct from p_request_key
       or v_attempt.operation_request_payload_hash
         is distinct from p_request_payload_hash then
      raise exception 'attempt request key was reused with different intent'
        using errcode = '22023';
    end if;
  end if;
  if v_attempt.supplier_call_started_at is not null then
    return jsonb_build_object(
      'ok', false,
      'replay', true,
      'code', 'SUPPLIER_CALL_ALREADY_STARTED',
      'attemptId', v_attempt.id,
      'supplierCallStartedAt', v_attempt.supplier_call_started_at
    );
  end if;
  if v_attempt.state <> 'submitting' then
    return jsonb_build_object(
      'ok', false, 'code', 'ATTEMPT_NOT_SUBMITTING'
    );
  end if;
  update public.booking_attempts
     set operation_request_key = coalesce(
           operation_request_key, p_request_key
         ),
         operation_request_payload_hash = coalesce(
           operation_request_payload_hash, p_request_payload_hash
         ),
         supplier_operation = coalesce(supplier_operation, 'Book'),
         supplier_call_started_at = now()
   where id = v_attempt.id
   returning * into v_attempt;
  return jsonb_build_object(
    'ok', true,
    'started', true,
    'attemptId', v_attempt.id,
    'supplierCallStartedAt', v_attempt.supplier_call_started_at
  );
end;
$$;

revoke all on function public.mark_booking_operation_supplier_call_started(
  uuid, text, text
) from public, anon, authenticated;
revoke all on function public.mark_booking_attempt_supplier_call_started(
  uuid, text, text
) from public, anon, authenticated;
grant execute on function public.mark_booking_operation_supplier_call_started(
  uuid, text, text
) to service_role;
grant execute on function public.mark_booking_attempt_supplier_call_started(
  uuid, text, text
) to service_role;

comment on function public.mark_booking_operation_supplier_call_started(
  uuid, text, text
) is
  'One-way boundary immediately before NewTicket/Cancel HTTP. Exact replay never authorizes another supplier call.';
comment on function public.mark_booking_attempt_supplier_call_started(
  uuid, text, text
) is
  'One-way boundary immediately before Book HTTP. Attempt state remains internal and exact replay never authorizes another supplier call.';

alter table public.booking_attempts
  add column if not exists supplier_response_http_status smallint;
alter table public.booking_attempts
  add constraint booking_attempts_supplier_response_http_status_check
    check (
      supplier_response_http_status is null
      or supplier_response_http_status between 100 and 599
    );

create or replace function public.mark_booking_operation_supplier_response_received(
  p_operation_id uuid,
  p_request_key text,
  p_request_payload_hash text,
  p_http_status integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_operation public.booking_operations;
begin
  if p_http_status not between 100 and 599 then
    raise exception 'invalid supplier HTTP status' using errcode = '22023';
  end if;
  select * into v_operation
  from public.booking_operations
  where id = p_operation_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_FOUND');
  end if;
  if v_operation.request_key is distinct from p_request_key
     or v_operation.request_payload_hash is distinct from p_request_payload_hash then
    raise exception 'operation supplier-response boundary identity mismatch'
      using errcode = '22023';
  end if;
  if v_operation.supplier_response_received_at is not null then
    return jsonb_build_object(
      'ok', true, 'replay', true,
      'operationId', v_operation.id,
      'supplierResponseReceivedAt', v_operation.supplier_response_received_at
    );
  end if;
  if v_operation.state <> 'supplier_call_started'
     or v_operation.supplier_call_started_at is null then
    return jsonb_build_object(
      'ok', false, 'code', 'SUPPLIER_CALL_NOT_STARTED'
    );
  end if;
  update public.booking_operations
     set supplier_response_received_at = now(),
         supplier_evidence = supplier_evidence || jsonb_build_object(
           'httpStatus', p_http_status,
           'responseObserved', true
         )
   where id = v_operation.id
   returning * into v_operation;
  return jsonb_build_object(
    'ok', true,
    'operationId', v_operation.id,
    'supplierResponseReceivedAt', v_operation.supplier_response_received_at
  );
end;
$$;

create or replace function public.mark_booking_attempt_supplier_response_received(
  p_attempt_id uuid,
  p_request_key text,
  p_request_payload_hash text,
  p_http_status integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_attempt public.booking_attempts;
begin
  if p_http_status not between 100 and 599 then
    raise exception 'invalid supplier HTTP status' using errcode = '22023';
  end if;
  select * into v_attempt
  from public.booking_attempts
  where id = p_attempt_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_FOUND');
  end if;
  if v_attempt.operation_request_key is distinct from p_request_key
     or v_attempt.operation_request_payload_hash
       is distinct from p_request_payload_hash then
    raise exception 'attempt supplier-response boundary identity mismatch'
      using errcode = '22023';
  end if;
  if v_attempt.supplier_response_received_at is not null then
    return jsonb_build_object(
      'ok', true, 'replay', true,
      'attemptId', v_attempt.id,
      'supplierResponseReceivedAt', v_attempt.supplier_response_received_at
    );
  end if;
  if v_attempt.supplier_call_started_at is null then
    return jsonb_build_object(
      'ok', false, 'code', 'SUPPLIER_CALL_NOT_STARTED'
    );
  end if;
  update public.booking_attempts
     set supplier_response_received_at = now(),
         supplier_response_http_status = p_http_status
   where id = v_attempt.id
   returning * into v_attempt;
  return jsonb_build_object(
    'ok', true,
    'attemptId', v_attempt.id,
    'supplierResponseReceivedAt', v_attempt.supplier_response_received_at
  );
end;
$$;

revoke all on function public.mark_booking_operation_supplier_response_received(
  uuid, text, text, integer
) from public, anon, authenticated;
revoke all on function public.mark_booking_attempt_supplier_response_received(
  uuid, text, text, integer
) from public, anon, authenticated;
grant execute on function public.mark_booking_operation_supplier_response_received(
  uuid, text, text, integer
) to service_role;
grant execute on function public.mark_booking_attempt_supplier_response_received(
  uuid, text, text, integer
) to service_role;

comment on function public.mark_booking_operation_supplier_response_received(
  uuid, text, text, integer
) is
  'Records complete HTTP response receipt before NewTicket/Cancel response interpretation or local finalization. Stores status metadata only, never the raw response.';
comment on function public.mark_booking_attempt_supplier_response_received(
  uuid, text, text, integer
) is
  'Records complete Book HTTP response receipt before response interpretation or booking finalization. Stores status metadata only, never the raw response.';

-- Every operation finalizer uses the same locked identity and response guard.
-- A response must have been durably observed before local booking/wallet truth
-- is allowed to consume the supplier outcome.
create or replace function public.booking_operation_finalization_guard(
  p_operation_id uuid,
  p_booking_id uuid,
  p_expected_kind text,
  p_request_key text,
  p_request_payload_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation public.booking_operations;
  v_active_operation_id uuid;
  v_replay jsonb;
begin
  select * into v_operation
    from public.booking_operations
   where id = p_operation_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_FOUND');
  end if;
  if v_operation.booking_id is distinct from p_booking_id
     or v_operation.kind is distinct from p_expected_kind
     or v_operation.request_key is distinct from p_request_key
     or v_operation.request_payload_hash
       is distinct from p_request_payload_hash then
    raise exception 'operation finalization identity mismatch'
      using errcode = '22023';
  end if;

  if v_operation.state in (
    'succeeded', 'failed', 'needs_reconciliation', 'awaiting_external_action'
  ) then
    v_replay := public.booking_operation_replay_response(jsonb_build_object(
      'replay', true,
      'operationId', v_operation.id,
      'state', v_operation.state,
      'result', v_operation.supplier_evidence,
      'errorCode', v_operation.error_code
    ));
    return v_replay;
  end if;
  if v_operation.state = 'claimed'
     or v_operation.supplier_call_started_at is null then
    return jsonb_build_object(
      'ok', false, 'code', 'SUPPLIER_CALL_NOT_STARTED',
      'operationId', v_operation.id,
      'operationState', v_operation.state
    );
  end if;
  if v_operation.supplier_response_received_at is null then
    return jsonb_build_object(
      'ok', false, 'code', 'SUPPLIER_RESPONSE_NOT_RECORDED',
      'operationId', v_operation.id,
      'operationState', v_operation.state
    );
  end if;

  select active_operation_id into v_active_operation_id
    from public.flight_bookings
   where id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  if v_active_operation_id is distinct from v_operation.id then
    return jsonb_build_object(
      'ok', false, 'code', 'OPERATION_POINTER_MISMATCH',
      'operationId', v_operation.id,
      'operationState', v_operation.state
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'replay', false,
    'operationId', v_operation.id,
    'operationState', v_operation.state
  );
end;
$$;

-- A known supplier outcome whose local finalization fails is owned
-- immediately. The held/captured financial position is preserved and the
-- active operation remains attached to the booking until controlled review.
create or replace function public.mark_booking_operation_finalization_reconciliation(
  p_operation_id uuid,
  p_booking_id uuid,
  p_case_type text,
  p_assigned_team text,
  p_error_code text,
  p_error_message text,
  p_normalized_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation public.booking_operations;
  v_case_id uuid;
  v_wallet_result jsonb;
begin
  if p_case_type not in (
       'ticketing_uncertainty', 'cancellation_uncertainty',
       'legacy_review', 'terminal_conflict',
       'direct_ticket_payment_failure'
     )
     or p_assigned_team not in ('support', 'accounts', 'admin')
     or jsonb_typeof(coalesce(p_normalized_evidence, '{}'::jsonb)) <> 'object'
     or nullif(btrim(p_error_code), '') is null then
    raise exception 'invalid finalization reconciliation input'
      using errcode = '22023';
  end if;

  select * into v_operation
    from public.booking_operations
   where id = p_operation_id and booking_id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_FOUND');
  end if;
  if v_operation.state = 'needs_reconciliation' then
    select id into v_case_id
      from public.booking_reconciliation_cases
     where subject_booking_id = p_booking_id
       and case_type = p_case_type
       and state in (
         'open', 'assigned', 'awaiting_supplier',
         'awaiting_finance', 'awaiting_approval'
       )
     order by opened_at, id
     limit 1;
    return jsonb_build_object(
      'ok', false, 'replay', true,
      'code', 'RECONCILIATION_REQUIRED',
      'operationId', v_operation.id,
      'operationState', v_operation.state,
      'reconciliationCaseId', v_case_id
    );
  end if;
  if v_operation.state <> 'supplier_call_started'
     or v_operation.supplier_call_started_at is null then
    return jsonb_build_object(
      'ok', false, 'code', 'OPERATION_NOT_RECONCILABLE'
    );
  end if;

  v_wallet_result := public.wallet_mark_reconciliation(
    p_booking_id,
    null,
    left(coalesce(p_error_message, p_error_code), 1000)
  );

  update public.booking_operations
     set state = 'needs_reconciliation',
         reconciliation_required_at = coalesce(
           reconciliation_required_at, now()
         ),
         error_code = left(p_error_code, 100),
         error_message = left(coalesce(p_error_message, p_error_code), 1000),
         supplier_evidence = supplier_evidence || jsonb_build_object(
           'localFinalization',
           jsonb_build_object(
             'ok', false,
             'code', p_error_code,
             'walletProtected', coalesce(
               (v_wallet_result->>'ok')::boolean, false
             ),
             'evidence', coalesce(p_normalized_evidence, '{}'::jsonb)
           )
         )
   where id = v_operation.id;

  update public.flight_bookings
     set active_operation_id = v_operation.id
   where id = p_booking_id;

  insert into public.booking_reconciliation_cases (
    subject_booking_id, operation_id, case_type, state,
    reason_code, reason_detail, opened_source,
    opened_by_user_id, opened_by_role, opened_at,
    assigned_team, severity, priority, due_at,
    evidence, evidence_latest_at, evidence_normalizer_version,
    policy_version
  ) values (
    p_booking_id, v_operation.id, p_case_type, 'open',
    'local_finalization_failed',
    left(coalesce(p_error_message, p_error_code), 1000),
    'operation', 'system:lifecycle', 'system', now(),
    p_assigned_team, 'high', 80, now() + interval '30 minutes',
    jsonb_build_array(jsonb_build_object(
      'kind', 'normalized_local_finalization_failure',
      'observedAt', now(),
      'code', p_error_code,
      'details', coalesce(p_normalized_evidence, '{}'::jsonb)
    )),
    now(), 1, 1
  ) on conflict do nothing
  returning id into v_case_id;

  if v_case_id is null then
    select id into v_case_id
      from public.booking_reconciliation_cases
     where subject_booking_id = p_booking_id
       and case_type = p_case_type
       and state in (
         'open', 'assigned', 'awaiting_supplier',
         'awaiting_finance', 'awaiting_approval'
       )
     order by opened_at, id
     limit 1;
  end if;

  return jsonb_build_object(
    'ok', false,
    'code', 'RECONCILIATION_REQUIRED',
    'finalizationCode', p_error_code,
    'operationId', v_operation.id,
    'operationState', 'needs_reconciliation',
    'reconciliationCaseId', v_case_id
  );
end;
$$;

-- Ticketing success: wallet capture, booking confirmation, operation terminal
-- state, pointer cleanup, and event linkage commit as one transaction.
create or replace function public.wallet_capture_reservation_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_key text,
  p_request_payload_hash text,
  p_operation_id uuid,
  p_supplier_outcome jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guard jsonb;
  v_result jsonb;
  v_direct_ticketing boolean;
  v_case_type text;
  v_evidence jsonb;
begin
  v_guard := public.booking_operation_finalization_guard(
    p_operation_id, p_booking_id, 'ticketing',
    p_request_key, p_request_payload_hash
  );
  if coalesce((v_guard->>'ok')::boolean, false) is not true
     or coalesce((v_guard->>'replay')::boolean, false) then
    return v_guard;
  end if;

  select direct_ticketing into v_direct_ticketing
    from public.flight_bookings where id = p_booking_id;
  v_evidence := jsonb_build_object(
    'pnr', nullif(btrim(p_supplier_outcome->>'pnr'), ''),
    'bookingStatus', nullif(btrim(p_supplier_outcome->>'bookingStatus'), ''),
    'ticketCodeRef', nullif(btrim(p_supplier_outcome->>'ticketCodeRef'), ''),
    'ticketNumbers', coalesce(p_supplier_outcome->'ticketNumbers', '[]'::jsonb)
  );
  v_result := public.wallet_capture_reservation(
    p_booking_id, p_actor_user_id, p_actor_role,
    p_request_key, p_supplier_outcome
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    v_case_type := case when coalesce(v_direct_ticketing, false)
      then 'direct_ticket_payment_failure'
      else 'ticketing_uncertainty' end;
    return public.mark_booking_operation_finalization_reconciliation(
      p_operation_id, p_booking_id, v_case_type, 'accounts',
      coalesce(v_result->>'code', 'TICKET_CAPTURE_FAILED'),
      'Supplier issued tickets but local wallet capture/finalization failed',
      v_evidence
    );
  end if;

  update public.booking_operations
     set state = 'succeeded',
         completed_at = now(),
         error_code = null,
         error_message = null,
         supplier_evidence = supplier_evidence ||
           jsonb_build_object('finalOutcome', v_evidence)
   where id = p_operation_id;
  update public.flight_bookings
     set active_operation_id = null
   where id = p_booking_id and active_operation_id = p_operation_id;
  update public.booking_status_events
     set operation_id = p_operation_id
   where booking_id = p_booking_id
     and idempotency_key = p_request_key || ':confirmed';

  return v_result || jsonb_build_object(
    'operationId', p_operation_id,
    'operationState', 'succeeded'
  );
end;
$$;

-- Compatibility Pending success uses no wallet movement, but the existing
-- captured state, booking confirmation, operation, pointer, and event still
-- finalize atomically.
create or replace function public.wallet_finalize_manual_issue_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_key text,
  p_request_payload_hash text,
  p_operation_id uuid,
  p_supplier_outcome jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guard jsonb;
  v_result jsonb;
  v_evidence jsonb;
begin
  v_guard := public.booking_operation_finalization_guard(
    p_operation_id, p_booking_id, 'ticketing',
    p_request_key, p_request_payload_hash
  );
  if coalesce((v_guard->>'ok')::boolean, false) is not true
     or coalesce((v_guard->>'replay')::boolean, false) then
    return v_guard;
  end if;
  v_evidence := jsonb_build_object(
    'pnr', nullif(btrim(p_supplier_outcome->>'pnr'), ''),
    'bookingStatus', nullif(btrim(p_supplier_outcome->>'bookingStatus'), ''),
    'ticketCodeRef', nullif(btrim(p_supplier_outcome->>'ticketCodeRef'), ''),
    'ticketNumbers', coalesce(p_supplier_outcome->'ticketNumbers', '[]'::jsonb)
  );
  v_result := public.wallet_finalize_manual_issue(
    p_booking_id, p_actor_user_id, p_actor_role, p_supplier_outcome
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    return public.mark_booking_operation_finalization_reconciliation(
      p_operation_id, p_booking_id, 'legacy_review', 'support',
      coalesce(v_result->>'code', 'MANUAL_ISSUE_FINALIZATION_FAILED'),
      'Supplier issued tickets but legacy manual finalization failed',
      v_evidence
    );
  end if;

  update public.booking_operations
     set state = 'succeeded', completed_at = now(),
         error_code = null, error_message = null,
         supplier_evidence = supplier_evidence ||
           jsonb_build_object('finalOutcome', v_evidence)
   where id = p_operation_id;
  update public.flight_bookings
     set active_operation_id = null
   where id = p_booking_id and active_operation_id = p_operation_id;
  update public.booking_status_events
     set operation_id = p_operation_id
   where id = (
     select id from public.booking_status_events
      where booking_id = p_booking_id
        and to_lifecycle_status = 'confirmed'
        and supplier_operation = 'NewTicket'
        and operation_id is null
      order by created_at desc, id desc
      limit 1
   );
  return v_result || jsonb_build_object(
    'operationId', p_operation_id,
    'operationState', 'succeeded'
  );
end;
$$;

-- A definitive NewTicket refusal may release the hold and restore the prior
-- public state only while completing the durable operation as failed.
create or replace function public.wallet_fail_booking_issue_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_key text,
  p_request_payload_hash text,
  p_operation_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guard jsonb;
  v_result jsonb;
  v_evidence jsonb;
begin
  v_guard := public.booking_operation_finalization_guard(
    p_operation_id, p_booking_id, 'ticketing',
    p_request_key, p_request_payload_hash
  );
  if coalesce((v_guard->>'replay')::boolean, false)
     and v_guard->>'operationState' = 'failed' then
    return jsonb_build_object(
      'ok', true, 'replay', true,
      'operationId', p_operation_id,
      'operationState', 'failed'
    );
  end if;
  if coalesce((v_guard->>'ok')::boolean, false) is not true
     or coalesce((v_guard->>'replay')::boolean, false) then
    return v_guard;
  end if;
  v_evidence := jsonb_build_object(
    'supplierDecision', 'declined',
    'reason', left(coalesce(p_reason, 'Supplier declined ticketing'), 1000)
  );
  v_result := public.wallet_fail_booking_issue(
    p_booking_id, p_actor_user_id, p_actor_role,
    p_request_key, p_reason
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    return public.mark_booking_operation_finalization_reconciliation(
      p_operation_id, p_booking_id, 'ticketing_uncertainty', 'accounts',
      coalesce(v_result->>'code', 'TICKET_FAILURE_FINALIZATION_FAILED'),
      'Supplier declined ticketing but hold release/finalization failed',
      v_evidence
    );
  end if;

  update public.booking_operations
     set state = 'failed', completed_at = now(),
         error_code = 'SUPPLIER_DECLINED',
         error_message = left(coalesce(p_reason, 'Supplier declined ticketing'), 1000),
         supplier_evidence = supplier_evidence ||
           jsonb_build_object('finalOutcome', v_evidence)
   where id = p_operation_id;
  update public.flight_bookings
     set active_operation_id = null
   where id = p_booking_id and active_operation_id = p_operation_id;
  update public.booking_status_events
     set operation_id = p_operation_id
   where booking_id = p_booking_id
     and idempotency_key = p_request_key || ':ticketing-failed';
  return v_result || jsonb_build_object(
    'operationId', p_operation_id,
    'operationState', 'failed'
  );
end;
$$;

-- Supplier cancellation success and local wallet/release consequences are one
-- transaction with operation completion and pointer/event cleanup.
create or replace function public.wallet_finalize_booking_cancel_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_key text,
  p_request_payload_hash text,
  p_operation_id uuid,
  p_reason text,
  p_supplier_outcome jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guard jsonb;
  v_result jsonb;
  v_case_type text;
  v_team text;
  v_evidence jsonb;
begin
  v_guard := public.booking_operation_finalization_guard(
    p_operation_id, p_booking_id, 'cancellation',
    p_request_key, p_request_payload_hash
  );
  if coalesce((v_guard->>'ok')::boolean, false) is not true
     or coalesce((v_guard->>'replay')::boolean, false) then
    return v_guard;
  end if;
  v_evidence := jsonb_build_object(
    'supplierDecision', 'cancelled',
    'reason', left(coalesce(p_reason, 'Booking cancelled with supplier'), 1000),
    'supplierStatus', nullif(btrim(p_supplier_outcome->>'supplierStatus'), ''),
    'pnr', nullif(btrim(p_supplier_outcome->>'pnr'), '')
  );
  v_result := public.wallet_finalize_booking_cancel(
    p_booking_id, p_actor_user_id, p_actor_role,
    p_request_key, p_reason
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    v_case_type := case
      when v_result->>'code' = 'CAPTURED_BOOKING_CANCEL_CONFLICT'
        then 'terminal_conflict'
      else 'cancellation_uncertainty'
    end;
    v_team := case when v_case_type = 'terminal_conflict'
      then 'admin' else 'support' end;
    return public.mark_booking_operation_finalization_reconciliation(
      p_operation_id, p_booking_id, v_case_type, v_team,
      coalesce(v_result->>'code', 'CANCEL_FINALIZATION_FAILED'),
      'Supplier cancelled booking but local wallet/finalization failed',
      v_evidence
    );
  end if;

  update public.booking_operations
     set state = 'succeeded', completed_at = now(),
         error_code = null, error_message = null,
         supplier_evidence = supplier_evidence ||
           jsonb_build_object('finalOutcome', v_evidence)
   where id = p_operation_id;
  update public.flight_bookings
     set active_operation_id = null
   where id = p_booking_id and active_operation_id = p_operation_id;
  update public.booking_status_events
     set operation_id = p_operation_id
   where booking_id = p_booking_id
     and idempotency_key = p_request_key || ':cancelled';
  return v_result || jsonb_build_object(
    'operationId', p_operation_id,
    'operationState', 'succeeded'
  );
end;
$$;

-- A cancellation refusal is only final after the caller's fresh PNR read has
-- persisted a valid live hold. The restore and operation failure are atomic.
create or replace function public.resolve_booking_cancellation_refusal_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_request_key text,
  p_request_payload_hash text,
  p_operation_id uuid,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guard jsonb;
  v_result jsonb;
begin
  v_guard := public.booking_operation_finalization_guard(
    p_operation_id, p_booking_id, 'cancellation',
    p_request_key, p_request_payload_hash
  );
  if coalesce((v_guard->>'replay')::boolean, false)
     and v_guard->>'operationState' = 'failed' then
    return jsonb_build_object(
      'ok', true, 'replay', true,
      'operationId', p_operation_id,
      'operationState', 'failed'
    );
  end if;
  if coalesce((v_guard->>'ok')::boolean, false) is not true
     or coalesce((v_guard->>'replay')::boolean, false) then
    return v_guard;
  end if;
  v_result := public.resolve_booking_cancellation_refusal(
    p_booking_id, p_actor_user_id, p_request_key,
    coalesce(p_evidence, '{}'::jsonb)
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    return public.mark_booking_operation_finalization_reconciliation(
      p_operation_id, p_booking_id, 'cancellation_uncertainty', 'support',
      coalesce(v_result->>'code', 'CANCEL_REFUSAL_FINALIZATION_FAILED'),
      'Supplier refused cancellation but a live held booking was not safely restorable',
      coalesce(p_evidence, '{}'::jsonb)
    );
  end if;

  update public.booking_operations
     set state = 'failed', completed_at = now(),
         error_code = 'SUPPLIER_DECLINED',
         error_message = 'Supplier declined cancellation; live hold verified',
         supplier_evidence = supplier_evidence || jsonb_build_object(
           'finalOutcome', jsonb_build_object(
             'supplierDecision', 'declined',
             'heldBookingVerified', true,
             'evidence', coalesce(p_evidence, '{}'::jsonb)
           )
         )
   where id = p_operation_id;
  update public.flight_bookings
     set active_operation_id = null
   where id = p_booking_id and active_operation_id = p_operation_id;
  update public.booking_status_events
     set operation_id = p_operation_id
   where booking_id = p_booking_id
     and idempotency_key = p_request_key || ':cancel-refused';
  return v_result || jsonb_build_object(
    'operationId', p_operation_id,
    'operationState', 'failed'
  );
end;
$$;

-- Book happens before a business booking exists. Its attempt identity and
-- response boundary must therefore be checked on booking_attempts immediately
-- before the existing atomic attempt-to-booking finalizer runs.
create or replace function public.create_booking_from_attempt_v2(
  p_attempt_id uuid,
  p_request_key text,
  p_request_payload_hash text,
  p_outcome jsonb
)
returns public.flight_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.booking_attempts;
  v_booking public.flight_bookings;
begin
  select * into v_attempt
    from public.booking_attempts
   where id = p_attempt_id
   for update;
  if not found then
    raise exception 'booking attempt does not exist' using errcode = 'P0002';
  end if;
  if v_attempt.operation_request_key is distinct from p_request_key
     or v_attempt.operation_request_payload_hash
       is distinct from p_request_payload_hash then
    raise exception 'booking attempt finalization identity mismatch'
      using errcode = '22023';
  end if;
  if v_attempt.supplier_call_started_at is null then
    raise exception 'supplier call was not recorded for booking attempt'
      using errcode = '23514';
  end if;
  if v_attempt.supplier_response_received_at is null then
    raise exception 'supplier response was not recorded for booking attempt'
      using errcode = '23514';
  end if;
  v_booking := public.create_booking_from_attempt(p_attempt_id, p_outcome);
  return v_booking;
end;
$$;

revoke all on function public.booking_operation_finalization_guard(
  uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.mark_booking_operation_finalization_reconciliation(
  uuid, uuid, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.wallet_capture_reservation_v2(
  uuid, text, text, text, text, uuid, jsonb
) from public, anon, authenticated;
revoke all on function public.wallet_finalize_manual_issue_v2(
  uuid, text, text, text, text, uuid, jsonb
) from public, anon, authenticated;
revoke all on function public.wallet_fail_booking_issue_v2(
  uuid, text, text, text, text, uuid, text
) from public, anon, authenticated;
revoke all on function public.wallet_finalize_booking_cancel_v2(
  uuid, text, text, text, text, uuid, text, jsonb
) from public, anon, authenticated;
revoke all on function public.resolve_booking_cancellation_refusal_v2(
  uuid, text, text, text, uuid, jsonb
) from public, anon, authenticated;
revoke all on function public.create_booking_from_attempt_v2(
  uuid, text, text, jsonb
) from public, anon, authenticated;

grant execute on function public.booking_operation_finalization_guard(
  uuid, uuid, text, text, text
) to service_role;
grant execute on function public.mark_booking_operation_finalization_reconciliation(
  uuid, uuid, text, text, text, text, jsonb
) to service_role;
grant execute on function public.wallet_capture_reservation_v2(
  uuid, text, text, text, text, uuid, jsonb
) to service_role;
grant execute on function public.wallet_finalize_manual_issue_v2(
  uuid, text, text, text, text, uuid, jsonb
) to service_role;
grant execute on function public.wallet_fail_booking_issue_v2(
  uuid, text, text, text, text, uuid, text
) to service_role;
grant execute on function public.wallet_finalize_booking_cancel_v2(
  uuid, text, text, text, text, uuid, text, jsonb
) to service_role;
grant execute on function public.resolve_booking_cancellation_refusal_v2(
  uuid, text, text, text, uuid, jsonb
) to service_role;
grant execute on function public.create_booking_from_attempt_v2(
  uuid, text, text, jsonb
) to service_role;

comment on function public.wallet_capture_reservation_v2(
  uuid, text, text, text, text, uuid, jsonb
) is
  'Atomically finalizes NewTicket evidence, wallet capture, booking confirmation, operation completion, active pointer, and lifecycle event; local failure opens an owned case.';
comment on function public.wallet_finalize_booking_cancel_v2(
  uuid, text, text, text, text, uuid, text, jsonb
) is
  'Atomically finalizes supplier cancellation, wallet release/conflict, booking truth, operation completion, active pointer, and lifecycle event.';
comment on function public.create_booking_from_attempt_v2(
  uuid, text, text, jsonb
) is
  'Requires the one-way Book start and complete-response boundaries before atomically converting the attempt into a business booking.';

-- A claim can be abandoned before authentication completes, so it also needs
-- an indexed ownerless-work scan even though no supplier call was started.
create index if not exists booking_operations_claim_watchdog_idx
  on public.booking_operations (claimed_at, id)
  where state = 'claimed';

-- Bounded, concurrency-safe watchdog. It never calls a supplier endpoint and
-- never releases/captures funds. Instead it preserves the financial position,
-- moves the operation to reconciliation, and creates one SLA-owned case.
create or replace function public.process_booking_operation_watchdog(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation public.booking_operations;
  v_case_id uuid;
  v_case_type text;
  v_reason_code text;
  v_reason_detail text;
  v_wallet_result jsonb;
  v_processed integer := 0;
  v_cases_created integer := 0;
  v_cutoff timestamptz := now() - interval '3 minutes';
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'watchdog limit must be between 1 and 500'
      using errcode = '22023';
  end if;

  for v_operation in
    select operation.*
      from public.booking_operations operation
     where (
       operation.state = 'supplier_call_started'
       and operation.supplier_call_started_at <= v_cutoff
     ) or (
       operation.state = 'claimed'
       and operation.claimed_at <= v_cutoff
     )
     order by coalesce(
       operation.supplier_call_started_at,
       operation.claimed_at
     ), operation.id
     limit p_limit
     for update skip locked
  loop
    v_case_type := case
      when v_operation.reason_code = 'legacy_reconciliation'
        then 'legacy_review'
      when v_operation.kind = 'cancellation'
        then 'cancellation_uncertainty'
      else 'ticketing_uncertainty'
    end;
    v_reason_code := case
      when v_operation.state = 'supplier_call_started'
        then 'supplier_call_watchdog_timeout'
      else 'local_claim_watchdog_timeout'
    end;
    v_reason_detail := case
      when v_operation.state = 'supplier_call_started' then
        'Supplier write exceeded the three-minute operation watchdog; outcome must be read and reconciled without replay.'
      else
        'Operation claim exceeded the three-minute watchdog before the supplier-call boundary was recorded.'
    end;

    v_wallet_result := public.wallet_mark_reconciliation(
      v_operation.booking_id,
      null,
      v_reason_detail
    );

    update public.booking_operations
       set state = 'needs_reconciliation',
           reconciliation_required_at = coalesce(
             reconciliation_required_at, now()
           ),
           error_code = upper(v_reason_code),
           error_message = v_reason_detail,
           supplier_evidence = supplier_evidence || jsonb_build_object(
             'watchdog', jsonb_build_object(
               'policyVersion', 1,
               'thresholdSeconds', 180,
               'detectedAt', now(),
               'supplierCallStarted',
                 v_operation.supplier_call_started_at is not null,
               'supplierResponseRecorded',
                 v_operation.supplier_response_received_at is not null,
               'walletPositionProtected', coalesce(
                 (v_wallet_result->>'ok')::boolean, false
               ),
               'automaticSupplierReplay', false
             )
           )
     where id = v_operation.id;

    update public.flight_bookings
       set active_operation_id = v_operation.id
     where id = v_operation.booking_id;

    v_case_id := null;
    insert into public.booking_reconciliation_cases (
      subject_booking_id, operation_id, case_type, state,
      reason_code, reason_detail, opened_source,
      opened_by_user_id, opened_by_role, opened_at,
      assigned_team, severity, priority, due_at,
      escalated_at, escalation_level, escalation_reason,
      evidence, evidence_latest_at, evidence_normalizer_version,
      policy_version
    ) values (
      v_operation.booking_id, v_operation.id, v_case_type, 'open',
      v_reason_code, v_reason_detail, 'operation',
      'system:lifecycle-watchdog', 'system', now(),
      'support', 'high', 90, now() + interval '30 minutes',
      now(), 1, 'Active supplier operation watchdog threshold exceeded',
      jsonb_build_array(jsonb_build_object(
        'kind', 'operation_watchdog_observation',
        'observedAt', now(),
        'operationStateBefore', v_operation.state,
        'supplierCallStartedAt', v_operation.supplier_call_started_at,
        'supplierResponseRecorded',
          v_operation.supplier_response_received_at is not null,
        'automaticSupplierReplay', false
      )),
      now(), 1, 1
    ) on conflict do nothing
    returning id into v_case_id;

    v_processed := v_processed + 1;
    if v_case_id is not null then
      v_cases_created := v_cases_created + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'processed', v_processed,
    'casesCreated', v_cases_created,
    'thresholdSeconds', 180,
    'limit', p_limit,
    'automaticSupplierReplay', false
  );
end;
$$;

revoke all on function public.process_booking_operation_watchdog(integer)
  from public, anon, authenticated;
grant execute on function public.process_booking_operation_watchdog(integer)
  to service_role;

comment on function public.process_booking_operation_watchdog(integer) is
  'Moves stale claimed/supplier-call-started booking operations to owned reconciliation after three minutes. Uses SKIP LOCKED, preserves funds, and never calls or replays a supplier write.';

create index if not exists booking_attempts_reconciliation_watchdog_idx
  on public.booking_attempts (
    state, supplier_call_started_at, submitted_at, resolved_at, updated_at, id
  )
  where state in ('submitting', 'unknown')
    and operation_request_key is not null;

-- Only operation-identified attempts are eligible. This deliberately leaves
-- pre-0045 historical null-identity attempts unchanged for the separately
-- approved historical-remediation phase.
create or replace function public.process_booking_attempt_watchdog(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.booking_attempts;
  v_state_before text;
  v_reason_code text;
  v_reason_detail text;
  v_wallet_result jsonb;
  v_case_id uuid;
  v_processed integer := 0;
  v_cases_created integer := 0;
  v_cutoff timestamptz := now() - interval '3 minutes';
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'attempt watchdog limit must be between 1 and 500'
      using errcode = '22023';
  end if;

  for v_attempt in
    select attempt.*
      from public.booking_attempts attempt
     where attempt.state in ('submitting', 'unknown')
       and attempt.operation_request_key is not null
       and coalesce(
         attempt.supplier_call_started_at,
         attempt.submitted_at,
         attempt.resolved_at,
         attempt.updated_at
       ) <= v_cutoff
       and not exists (
         select 1
           from public.booking_reconciliation_cases open_case
          where open_case.subject_booking_attempt_id = attempt.id
            and open_case.case_type = 'attempt_uncertainty'
            and open_case.state in (
              'open', 'assigned', 'awaiting_supplier',
              'awaiting_finance', 'awaiting_approval'
            )
       )
     order by coalesce(
       attempt.supplier_call_started_at,
       attempt.submitted_at,
       attempt.resolved_at,
       attempt.updated_at
     ), attempt.id
     limit p_limit
     for update skip locked
  loop
    v_state_before := v_attempt.state;
    v_reason_code := case
      when v_attempt.supplier_call_started_at is not null
        then 'book_supplier_call_watchdog_timeout'
      else 'book_local_claim_watchdog_timeout'
    end;
    v_reason_detail := case
      when v_attempt.supplier_call_started_at is not null then
        'Book supplier write exceeded the three-minute watchdog; reconcile by authoritative read and never replay the write.'
      else
        'Book attempt claim exceeded the three-minute watchdog before the supplier-call boundary was recorded.'
    end;

    v_wallet_result := public.wallet_mark_reconciliation(
      null,
      v_attempt.id,
      v_reason_detail
    );

    update public.booking_attempts
       set state = 'unknown',
           error_code = upper(v_reason_code),
           supplier_message = coalesce(supplier_message, v_reason_detail),
           resolved_at = coalesce(resolved_at, now())
     where id = v_attempt.id;

    v_case_id := null;
    insert into public.booking_reconciliation_cases (
      subject_booking_attempt_id, case_type, state,
      reason_code, reason_detail, opened_source,
      opened_by_user_id, opened_by_role, opened_at,
      assigned_team, severity, priority, due_at,
      evidence, evidence_latest_at, evidence_normalizer_version,
      policy_version
    ) values (
      v_attempt.id, 'attempt_uncertainty', 'open',
      v_reason_code, v_reason_detail, 'operation',
      'system:attempt-watchdog', 'system', now(),
      'support', 'high', 85, now() + interval '15 minutes',
      jsonb_build_array(jsonb_build_object(
        'kind', 'attempt_watchdog_observation',
        'observedAt', now(),
        'attemptStateBefore', v_state_before,
        'supplierCallStartedAt', v_attempt.supplier_call_started_at,
        'supplierResponseRecorded',
          v_attempt.supplier_response_received_at is not null,
        'walletPositionProtected', coalesce(
          (v_wallet_result->>'ok')::boolean, false
        ),
        'automaticSupplierReplay', false
      )),
      now(), 1, 1
    ) on conflict do nothing
    returning id into v_case_id;

    v_processed := v_processed + 1;
    if v_case_id is not null then
      v_cases_created := v_cases_created + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'processed', v_processed,
    'casesCreated', v_cases_created,
    'thresholdSeconds', 180,
    'caseDueSeconds', 900,
    'limit', p_limit,
    'historicalNullIdentityExcluded', true,
    'automaticSupplierReplay', false
  );
end;
$$;

revoke all on function public.process_booking_attempt_watchdog(integer)
  from public, anon, authenticated;
grant execute on function public.process_booking_attempt_watchdog(integer)
  to service_role;

comment on function public.process_booking_attempt_watchdog(integer) is
  'Owns stale operation-identified Book attempts as attempt_uncertainty cases. Preserves direct-ticket holds, excludes historical null-identity attempts, and never replays Book.';

-- 10. Controlled attempt-reconciliation queue -----------------------------
-- This queue exposes only the durable identifiers and operational/financial
-- posture needed to choose a safe read. It deliberately does not select the
-- passenger snapshot or raw case evidence. AirTicketingDetails can prove an
-- issued/cancelled/refunded report but cannot, by absence, prove that a held
-- booking does not exist; an inconclusive read therefore requires the supplier
-- portal instead of another Book call.
create index if not exists
  booking_reconciliation_cases_attempt_queue_idx
  on public.booking_reconciliation_cases (
    priority, due_at, opened_at, id, subject_booking_attempt_id
  )
  where case_type = 'attempt_uncertainty'
    and subject_booking_attempt_id is not null
    and state in (
      'open', 'assigned', 'awaiting_supplier',
      'awaiting_finance', 'awaiting_approval'
    );

create or replace view public.booking_attempt_reconciliation_queue_v
with (security_invoker = true)
as
select
  reconciliation.id as reconciliation_case_id,
  reconciliation.state as reconciliation_state,
  reconciliation.reason_code,
  reconciliation.reason_detail,
  reconciliation.assigned_team,
  reconciliation.assignee_user_id,
  reconciliation.severity,
  reconciliation.priority,
  reconciliation.opened_at,
  reconciliation.due_at,
  reconciliation.escalation_level,
  reconciliation.evidence_latest_at,
  reconciliation.version as reconciliation_version,
  attempt.id as booking_attempt_id,
  attempt.supplier,
  attempt.state as attempt_state,
  attempt.created_at as attempt_created_at,
  attempt.submitted_at,
  attempt.resolved_at,
  attempt.supplier_call_started_at,
  attempt.supplier_response_received_at,
  attempt.supplier_response_http_status,
  attempt.operation_request_key is not null as operation_identity_present,
  attempt.unique_trans_id,
  attempt.pnr,
  attempt.booking_code_ref,
  coalesce(
    nullif(trim(attempt.unique_trans_id), '') is not null,
    false
  ) as air_ticketing_details_eligible,
  (
    nullif(trim(attempt.unique_trans_id), '') is not null
    and nullif(trim(attempt.item_code_ref), '') is not null
    and nullif(trim(attempt.price_code_ref), '') is not null
    and nullif(trim(attempt.booking_code_ref), '') is not null
    and nullif(trim(attempt.pnr), '') is not null
  ) as pnr_lookup_eligible,
  case
    when nullif(trim(attempt.unique_trans_id), '') is null then
      'manual_supplier_portal_only'
    when nullif(trim(attempt.item_code_ref), '') is not null
      and nullif(trim(attempt.price_code_ref), '') is not null
      and nullif(trim(attempt.booking_code_ref), '') is not null
      and nullif(trim(attempt.pnr), '') is not null then
      'pnr_then_air_ticketing_details'
    else 'air_ticketing_details_then_manual_portal'
  end as supplier_read_strategy,
  'unique_transaction_id'::text as supplier_identity_kind,
  false as destructive_replay_allowed,
  false as automatic_resolution_allowed,
  true as manual_portal_required_if_inconclusive,
  case
    when lower(coalesce(attempt.offer_snapshot->>'directTicketing', 'false'))
      = 'true' then true
    else false
  end as direct_ticketing,
  reservation.id as reservation_id,
  reservation.state as reservation_state,
  reservation.amount as reservation_amount,
  reservation.currency as reservation_currency,
  recovered.id as recovered_booking_id,
  recovered.public_ref as recovered_booking_public_ref
from public.booking_reconciliation_cases reconciliation
join public.booking_attempts attempt
  on attempt.id = reconciliation.subject_booking_attempt_id
left join public.wallet_reservations reservation
  on reservation.booking_attempt_id = attempt.id
left join public.flight_bookings recovered
  on recovered.attempt_id = attempt.id
where reconciliation.case_type = 'attempt_uncertainty'
  and reconciliation.state in (
    'open', 'assigned', 'awaiting_supplier',
    'awaiting_finance', 'awaiting_approval'
  );

revoke all on table public.booking_attempt_reconciliation_queue_v
  from public, anon, authenticated;
grant select on table public.booking_attempt_reconciliation_queue_v
  to service_role;

comment on view public.booking_attempt_reconciliation_queue_v is
  'Staff-only unresolved Book-attempt queue. Plans safe PNR/AirTicketingDetails reads by durable supplier identity, exposes no passenger/contact/raw evidence, and never authorizes Book replay or automatic resolution.';

-- 11. Deduplicated cases with append-only observation history --------------
create table if not exists public.booking_reconciliation_observations (
  id                     uuid primary key default gen_random_uuid(),
  reconciliation_case_id uuid not null
                         references public.booking_reconciliation_cases (id)
                         on delete restrict,
  observation_key        text not null,
  observation_kind       text not null,
  observation_source     text not null,
  actor_user_id          text not null,
  actor_role             text not null,
  normalized_facts       jsonb not null,
  normalized_facts_hash  text not null,
  observed_at            timestamptz not null,
  created_at             timestamptz not null default now(),
  constraint booking_reconciliation_observations_key_check
    check (char_length(observation_key) between 1 and 255),
  constraint booking_reconciliation_observations_kind_check
    check (observation_kind in (
      'supplier_write_uncertainty', 'supplier_read',
      'watchdog', 'staff_evidence', 'historical_snapshot'
    )),
  constraint booking_reconciliation_observations_source_check
    check (observation_source in (
      'operation', 'watchdog', 'supplier_read',
      'staff', 'historical_remediation'
    )),
  constraint booking_reconciliation_observations_actor_check
    check (
      nullif(btrim(actor_user_id), '') is not null
      and nullif(btrim(actor_role), '') is not null
    ),
  constraint booking_reconciliation_observations_facts_check
    check (jsonb_typeof(normalized_facts) = 'object'),
  constraint booking_reconciliation_observations_hash_check
    check (normalized_facts_hash ~ '^[a-f0-9]{64}$'),
  constraint booking_reconciliation_observations_time_check
    check (observed_at <= created_at + interval '5 minutes'),
  unique (reconciliation_case_id, observation_key)
);

create index if not exists
  booking_reconciliation_observations_case_timeline_idx
  on public.booking_reconciliation_observations (
    reconciliation_case_id, observed_at desc, id desc
  );

create or replace function public.prevent_reconciliation_observation_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'booking reconciliation observations are immutable'
    using errcode = '55000';
end;
$$;

drop trigger if exists booking_reconciliation_observations_immutable
  on public.booking_reconciliation_observations;
create trigger booking_reconciliation_observations_immutable
  before update or delete on public.booking_reconciliation_observations
  for each row execute function public.prevent_reconciliation_observation_mutation();

alter table public.booking_reconciliation_observations enable row level security;
revoke all on table public.booking_reconciliation_observations
  from public, anon, authenticated, service_role;
grant select, insert on table public.booking_reconciliation_observations
  to service_role;

comment on table public.booking_reconciliation_observations is
  'Append-only normalized evidence occurrences for a reconciliation case. The case is deduplicated, while distinct reads/conflicts retain immutable history.';
comment on column public.booking_reconciliation_observations.observation_key is
  'Occurrence idempotency key. Replaying one application/database request returns the same observation; a later supplier read uses a new key.';
comment on column public.booking_reconciliation_observations.normalized_facts is
  'Protected normalized facts only. Raw supplier payload retention and hashing are introduced by the evidence phase.';

create or replace function public.record_supplier_write_uncertainty_v2(
  p_booking_id uuid,
  p_booking_attempt_id uuid,
  p_operation_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_key text,
  p_request_payload_hash text,
  p_failure_reason_code text,
  p_http_status integer,
  p_response_observed boolean,
  p_response_recorded boolean,
  p_normalized_facts jsonb,
  p_normalized_facts_hash text,
  p_error_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operation public.booking_operations;
  v_attempt public.booking_attempts;
  v_case_type text;
  v_reason_detail text;
  v_case_id uuid;
  v_observation_id uuid;
  v_observation_created boolean := false;
  v_wallet_result jsonb;
  v_observation_key text;
begin
  if (p_booking_id is null) = (p_booking_attempt_id is null)
     or (p_booking_id is null) <> (p_operation_id is null)
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or nullif(btrim(coalesce(p_actor_role, '')), '') is null
     or nullif(btrim(coalesce(p_request_key, '')), '') is null
     or p_request_payload_hash !~ '^[a-f0-9]{64}$'
     or p_normalized_facts_hash !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(coalesce(p_normalized_facts, '{}'::jsonb)) <> 'object'
     or p_failure_reason_code not in (
       'local_response_boundary_failed', 'network_after_write',
       'incomplete_response', 'protocol_response',
       'supplier_upstream_failure', 'supplier_http_200_failure',
       'unexpected_after_write'
     )
     or coalesce(p_normalized_facts->>'failureClass', '') <> 'uncertain'
     or coalesce((p_normalized_facts->>'automaticReplayAllowed')::boolean, true)
        is not false
     or p_http_status is not null and (p_http_status < 100 or p_http_status > 599)
     or p_response_recorded and not p_response_observed then
    raise exception 'invalid supplier uncertainty observation'
      using errcode = '22023';
  end if;

  v_reason_detail := left(coalesce(
    nullif(btrim(p_error_message), ''),
    'Supplier write outcome requires authoritative read reconciliation'
  ), 1000);
  v_observation_key := p_request_key || ':supplier-uncertainty';

  if p_booking_id is not null then
    select * into v_operation
      from public.booking_operations
     where id = p_operation_id
       and booking_id = p_booking_id
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_FOUND');
    end if;
    if v_operation.request_key is distinct from p_request_key
       or v_operation.request_payload_hash
         is distinct from p_request_payload_hash then
      raise exception 'supplier uncertainty operation identity mismatch'
        using errcode = '22023';
    end if;
    if v_operation.supplier_call_started_at is null then
      return jsonb_build_object(
        'ok', false, 'code', 'SUPPLIER_CALL_NOT_STARTED'
      );
    end if;
    if v_operation.state in ('succeeded', 'failed') then
      return jsonb_build_object(
        'ok', false, 'code', 'OPERATION_ALREADY_TERMINAL'
      );
    end if;

    v_case_type := case
      when v_operation.kind = 'cancellation' then 'cancellation_uncertainty'
      when v_operation.reason_code = 'legacy_reconciliation' then 'legacy_review'
      else 'ticketing_uncertainty'
    end;
    v_wallet_result := public.wallet_mark_reconciliation(
      p_booking_id, null, v_reason_detail
    );
    update public.booking_operations
       set state = 'needs_reconciliation',
           reconciliation_required_at = coalesce(
             reconciliation_required_at, now()
           ),
           error_code = upper(p_failure_reason_code),
           error_message = v_reason_detail
     where id = v_operation.id;
  else
    select * into v_attempt
      from public.booking_attempts
     where id = p_booking_attempt_id
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_FOUND');
    end if;
    if v_attempt.operation_request_key is distinct from p_request_key
       or v_attempt.operation_request_payload_hash
         is distinct from p_request_payload_hash then
      raise exception 'supplier uncertainty attempt identity mismatch'
        using errcode = '22023';
    end if;
    if v_attempt.supplier_call_started_at is null then
      return jsonb_build_object(
        'ok', false, 'code', 'SUPPLIER_CALL_NOT_STARTED'
      );
    end if;
    if v_attempt.state not in ('submitting', 'unknown') then
      return jsonb_build_object(
        'ok', false, 'code', 'ATTEMPT_ALREADY_TERMINAL'
      );
    end if;

    v_case_type := 'attempt_uncertainty';
    v_wallet_result := public.wallet_mark_reconciliation(
      null, p_booking_attempt_id, v_reason_detail
    );
    update public.booking_attempts
       set state = 'unknown',
           error_code = upper(p_failure_reason_code),
           supplier_message = v_reason_detail,
           resolved_at = coalesce(resolved_at, now())
     where id = v_attempt.id;
  end if;

  insert into public.booking_reconciliation_cases (
    subject_booking_id, subject_booking_attempt_id, operation_id,
    case_type, state, reason_code, reason_detail,
    opened_source, opened_by_user_id, opened_by_role, opened_at,
    assigned_team, severity, priority, due_at,
    evidence, evidence_latest_at, evidence_normalizer_version,
    policy_version
  ) values (
    p_booking_id, p_booking_attempt_id, p_operation_id,
    v_case_type, 'open', p_failure_reason_code, v_reason_detail,
    'operation', p_actor_user_id, p_actor_role, now(),
    'support', 'high', 10,
    now() + case
      when v_case_type = 'attempt_uncertainty' then interval '15 minutes'
      else interval '30 minutes'
    end,
    '[]'::jsonb, null, 1, 1
  ) on conflict do nothing
  returning id into v_case_id;

  if v_case_id is null then
    select id into v_case_id
      from public.booking_reconciliation_cases
     where case_type = v_case_type
       and (
         (p_booking_id is not null and subject_booking_id = p_booking_id)
         or (
           p_booking_attempt_id is not null
           and subject_booking_attempt_id = p_booking_attempt_id
         )
       )
       and state in (
         'open', 'assigned', 'awaiting_supplier',
         'awaiting_finance', 'awaiting_approval'
       )
     order by opened_at, id
     limit 1
     for update;
  end if;
  if v_case_id is null then
    raise exception 'supplier uncertainty case could not be owned'
      using errcode = 'P0001';
  end if;

  insert into public.booking_reconciliation_observations (
    reconciliation_case_id, observation_key,
    observation_kind, observation_source,
    actor_user_id, actor_role,
    normalized_facts, normalized_facts_hash,
    observed_at
  ) values (
    v_case_id, v_observation_key,
    'supplier_write_uncertainty', 'operation',
    p_actor_user_id, p_actor_role,
    p_normalized_facts, p_normalized_facts_hash,
    now()
  ) on conflict (reconciliation_case_id, observation_key) do nothing
  returning id into v_observation_id;

  if v_observation_id is not null then
    v_observation_created := true;
    update public.booking_reconciliation_cases
       set evidence_latest_at = now(),
           evidence_normalizer_version = 1,
           version = version + 1
     where id = v_case_id;
  else
    select id into v_observation_id
      from public.booking_reconciliation_observations
     where reconciliation_case_id = v_case_id
       and observation_key = v_observation_key;
  end if;

  return jsonb_build_object(
    'ok', true,
    'replay', not v_observation_created,
    'caseId', v_case_id,
    'caseType', v_case_type,
    'observationId', v_observation_id,
    'operationState', case
      when p_booking_id is not null then 'needs_reconciliation'
      else null
    end,
    'attemptState', case
      when p_booking_attempt_id is not null then 'unknown'
      else null
    end,
    'walletPositionProtected', coalesce(
      (v_wallet_result->>'ok')::boolean, false
    ),
    'automaticSupplierReplay', false
  );
end;
$$;

revoke all on function public.record_supplier_write_uncertainty_v2(
  uuid, uuid, uuid, text, text, text, text, text,
  integer, boolean, boolean, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.record_supplier_write_uncertainty_v2(
  uuid, uuid, uuid, text, text, text, text, text,
  integer, boolean, boolean, jsonb, text, text
) to service_role;

comment on function public.record_supplier_write_uncertainty_v2(
  uuid, uuid, uuid, text, text, text, text, text,
  integer, boolean, boolean, jsonb, text, text
) is
  'Atomically preserves wallet position, owns one open case, and appends one idempotent immutable observation for an ambiguous Book/NewTicket/Cancel outcome. Never replays a supplier write.';
