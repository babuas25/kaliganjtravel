-- Prevent a read-only PNR observation from racing a NewTicket write. A
-- Booked/Held/Created observation is transitional only when its immutable
-- receipt overlaps a healthy ticketing operation and its supplier identity
-- matches the booking. The rule is supplier-neutral and applies to every
-- Triplover credential account.

create or replace function public.booking_ticketing_observation_overlap_v1(
  p_booking_id uuid,
  p_normalized_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_request_at timestamptz;
  v_response_at timestamptz;
  v_expected_trans_id text;
  v_expected_booking_code text;
  v_expected_pnr text;
  v_echo jsonb;
  v_operation_id uuid;
begin
  if p_booking_id is null
     or jsonb_typeof(coalesce(p_normalized_evidence, '{}'::jsonb)) <> 'object'
     or p_normalized_evidence->>'source' is distinct from 'pnr' then
    return null;
  end if;

  begin
    v_request_at := (p_normalized_evidence #>> '{receipt,requestStartedAt}')::timestamptz;
    v_response_at := (p_normalized_evidence #>> '{receipt,responseReceivedAt}')::timestamptz;
  exception when others then
    return null;
  end;
  if v_request_at is null or v_response_at is null
     or v_response_at < v_request_at
     or v_response_at > clock_timestamp() + interval '1 minute' then
    return null;
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id and not booking.legacy_operational;
  if not found then return null; end if;

  v_expected_trans_id := nullif(btrim(v_booking.supplier_refs->>'uniqueTransId'), '');
  v_expected_booking_code := nullif(btrim(v_booking.booking_code_ref), '');
  v_expected_pnr := coalesce(
    nullif(btrim(v_booking.pnr), ''),
    nullif(btrim(v_booking.booking_ref_number), '')
  );
  if v_expected_trans_id is null or v_expected_booking_code is null or v_expected_pnr is null
     or upper(btrim(coalesce(p_normalized_evidence #>> '{identity,uniqueTransId}', '')))
          is distinct from upper(v_expected_trans_id)
     or upper(btrim(coalesce(p_normalized_evidence #>> '{identity,bookingCodeRef}', '')))
          is distinct from upper(v_expected_booking_code)
     or upper(btrim(coalesce(p_normalized_evidence #>> '{identity,requestedPnr}', '')))
          is distinct from upper(v_expected_pnr)
     or upper(btrim(coalesce(p_normalized_evidence #>> '{facts,responsePnr}', '')))
          is distinct from upper(v_expected_pnr) then
    return null;
  end if;

  v_echo := coalesce(
    p_normalized_evidence #> '{facts,supplierEchoedUniqueTransIds}',
    '[]'::jsonb
  );
  if jsonb_typeof(v_echo) <> 'array'
     or exists (
       select 1 from jsonb_array_elements_text(v_echo) echoed(value)
        where upper(btrim(echoed.value)) is distinct from upper(v_expected_trans_id)
     ) then
    return null;
  end if;

  select operation.id into v_operation_id
    from public.booking_operations operation
   where operation.booking_id = p_booking_id
     and operation.kind = 'ticketing'
     and (
       (
         operation.state in ('claimed', 'supplier_call_started')
         and v_response_at >= operation.claimed_at
         and v_request_at <= clock_timestamp()
         and v_response_at <= operation.claimed_at + interval '3 minutes'
       )
       or (
         operation.state = 'succeeded'
         and operation.completed_at is not null
         and v_response_at >= operation.claimed_at
         and v_request_at <= operation.completed_at
         and v_response_at <= operation.completed_at
       )
     )
   order by operation.claimed_at desc, operation.id desc
   limit 1;
  return v_operation_id;
end;
$$;

revoke all on function public.booking_ticketing_observation_overlap_v1(uuid, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.record_booking_pnr_refresh_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_sync_source text,
  p_supplier_status text,
  p_airlines_pnr jsonb,
  p_ticketing_time_limit text,
  p_ticketing_deadline_at timestamptz,
  p_normalized_evidence jsonb
)
returns public.flight_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.flight_bookings;
  v_after public.flight_bookings;
  v_target text;
  v_case_type text;
  v_conflict boolean;
  v_terminal boolean;
  v_transitional boolean;
  v_overlap_operation_id uuid;
  v_before_lifecycle text;
  v_after_lifecycle text;
  v_facts jsonb;
begin
  if nullif(btrim(p_actor_user_id), '') is null
     or p_actor_role not in (
       'superadmin', 'admin', 'staff_support', 'staff_account',
       'customer', 'b2b', 'b2b_sub', 'system'
     )
     or p_sync_source not in (
       'ordinary_sync', 'cancellation_verification', 'compatibility_sync'
     ) then
    raise exception 'invalid PNR refresh actor' using errcode = '22023';
  end if;

  select booking.* into v_before
    from public.flight_bookings booking
   where booking.id = p_booking_id and not booking.legacy_operational
   for update;
  if not found then raise exception 'booking not found' using errcode = 'P0002'; end if;

  v_target := case lower(btrim(coalesce(p_supplier_status, '')))
    when 'issued' then 'confirmed'
    when 'confirmed' then 'confirmed'
    when 'cancelled' then 'cancelled'
    when 'canceled' then 'cancelled'
    when 'booked' then 'on-hold'
    when 'created' then 'on-hold'
    when 'held' then 'on-hold'
    else null
  end;
  v_overlap_operation_id := case when v_target = 'on-hold'
    then public.booking_ticketing_observation_overlap_v1(
      p_booking_id, coalesce(p_normalized_evidence, '{}'::jsonb)
    ) else null end;
  v_transitional := v_overlap_operation_id is not null;
  v_terminal := v_before.status in ('confirmed', 'cancelled');
  v_conflict := case
    when v_transitional then false
    when v_terminal then v_target is distinct from v_before.status
    when p_sync_source = 'cancellation_verification'
      and v_before.status = 'in-progress' and v_target = 'on-hold' then false
    else v_target in ('confirmed', 'cancelled')
      or (v_target is not null and v_target <> v_before.status)
  end;
  v_before_lifecycle := public.resolve_booking_lifecycle(
    v_before.status, v_before.airlines_pnr,
    v_before.ticketing_deadline_at, v_before.operation_kind
  );
  v_facts := jsonb_build_object(
    'version', 2,
    'action', 'ordinary_supplier_sync',
    'source', 'pnr',
    'syncSource', p_sync_source,
    'bookingId', p_booking_id,
    'localStoredStatus', v_before.status,
    'localLifecycleStatus', v_before_lifecycle,
    'supplierStatus', p_supplier_status,
    'candidateLifecycleStatus', v_target,
    'protectedTerminal', v_terminal,
    'ticketingOperationOverlap', v_transitional,
    'overlapOperationId', v_overlap_operation_id,
    'statusMutation', false,
    'walletMutation', false,
    'evidence', coalesce(p_normalized_evidence, '{}'::jsonb)
  );

  if v_conflict then
    update public.flight_bookings
       set synced_at = clock_timestamp(), booking_status = p_supplier_status
     where id = p_booking_id returning * into v_after;
    v_case_type := case
      when v_terminal then 'terminal_conflict'
      when v_target = 'cancelled' then 'cancellation_uncertainty'
      else 'ticketing_uncertainty'
    end;
    perform public.record_booking_sync_case_v1(
      p_booking_id, v_case_type, 'pnr_sync_conflicts_with_local_truth',
      'Ordinary PNR Sync differs from local lifecycle truth and requires controlled resolution.',
      p_actor_user_id, p_actor_role,
      v_facts || jsonb_build_object('caseType', v_case_type)
    );
  else
    update public.flight_bookings
       set synced_at = clock_timestamp(),
           booking_status = case
             when v_transitional and v_terminal then booking_status
             else p_supplier_status
           end,
           airlines_pnr = case
             when public.jsonb_is_nonempty_array(p_airlines_pnr)
               then p_airlines_pnr else airlines_pnr
           end,
           ticketing_time_limit = case
             when p_ticketing_deadline_at is not null and not (v_transitional and v_terminal)
               then p_ticketing_time_limit else ticketing_time_limit
           end,
           ticketing_deadline_at = case
             when v_transitional and v_terminal then ticketing_deadline_at
             else coalesce(p_ticketing_deadline_at, ticketing_deadline_at)
           end,
           deadline_source = case
             when p_ticketing_deadline_at is not null and not (v_transitional and v_terminal)
               then 'pnr_call' else deadline_source
           end
     where id = p_booking_id returning * into v_after;
  end if;

  v_after_lifecycle := public.resolve_booking_lifecycle(
    v_after.status, v_after.airlines_pnr,
    v_after.ticketing_deadline_at, v_after.operation_kind
  );
  if v_after_lifecycle is distinct from v_before_lifecycle then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, actor_user_id, supplier_operation, supplier_evidence
    ) values (
      p_booking_id, v_before_lifecycle, v_after_lifecycle,
      v_before.status, v_after.status, v_after.operation_kind,
      v_after.operation_reason, p_actor_user_id, 'PnrRefreshV2',
      jsonb_build_object(
        'supplierStatus', p_supplier_status,
        'airlinesPnr', p_airlines_pnr,
        'ticketingDeadlineAt', p_ticketing_deadline_at,
        'ticketingOperationOverlap', v_transitional,
        'statusMutation', false, 'walletMutation', false
      )
    );
  end if;
  return v_after;
end;
$$;

create or replace function public.record_booking_pnr_refresh_v3(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_sync_source text,
  p_supplier_status text,
  p_airlines_pnr jsonb,
  p_ticketing_time_limit text,
  p_ticketing_deadline_at timestamptz,
  p_normalized_evidence jsonb
)
returns public.flight_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.flight_bookings;
  v_after_sync public.flight_bookings;
  v_after public.flight_bookings;
  v_request_id uuid;
  v_target text;
  v_overlap_operation_id uuid;
  v_transitional_terminal boolean;
  v_hash text;
  v_before_lifecycle text;
  v_after_sync_lifecycle text;
  v_after_lifecycle text;
  v_supersede_reason text;
begin
  select * into v_before from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then raise exception 'booking not found' using errcode = 'P0002'; end if;

  v_before_lifecycle := public.resolve_booking_lifecycle(
    v_before.status, v_before.airlines_pnr,
    v_before.ticketing_deadline_at, v_before.operation_kind
  );
  v_overlap_operation_id := case
    when lower(btrim(coalesce(p_supplier_status, ''))) in ('booked', 'created', 'held')
    then public.booking_ticketing_observation_overlap_v1(
      p_booking_id, coalesce(p_normalized_evidence, '{}'::jsonb)
    ) else null end;
  v_after_sync := public.record_booking_pnr_refresh_v2(
    p_booking_id, p_actor_user_id, p_actor_role, p_sync_source,
    p_supplier_status, p_airlines_pnr, null, null,
    coalesce(p_normalized_evidence, '{}'::jsonb)
  );
  v_after_sync_lifecycle := public.resolve_booking_lifecycle(
    v_after_sync.status, v_after_sync.airlines_pnr,
    v_after_sync.ticketing_deadline_at, v_after_sync.operation_kind
  );
  v_transitional_terminal := v_overlap_operation_id is not null
    and v_after_sync.status in ('confirmed', 'cancelled');
  v_target := case lower(btrim(coalesce(p_supplier_status, '')))
    when 'issued' then 'confirmed'
    when 'confirmed' then 'confirmed'
    when 'cancelled' then 'cancelled'
    when 'canceled' then 'cancelled'
    else null
  end;
  v_hash := encode(sha256(convert_to(concat_ws('|',
    p_booking_id::text, 'pnr_sync', coalesce(p_sync_source, ''),
    coalesce(p_supplier_status, ''), coalesce(p_ticketing_time_limit, ''),
    coalesce(p_ticketing_deadline_at::text, ''),
    coalesce(p_normalized_evidence, '{}'::jsonb)::text
  ), 'UTF8')), 'hex');
  insert into public.booking_deadline_observations (
    booking_id, observation_source, supplier_status,
    supplier_time_limit_raw, supplier_deadline_at, supplier_deadline_source,
    actor_user_id, actor_role, normalized_evidence, evidence_hash
  ) values (
    p_booking_id, 'pnr_sync', p_supplier_status,
    p_ticketing_time_limit, p_ticketing_deadline_at, 'pnr_call',
    p_actor_user_id, p_actor_role,
    coalesce(p_normalized_evidence, '{}'::jsonb), v_hash
  ) on conflict do nothing;

  -- Preserve the stale response as evidence, but never let it overwrite the
  -- terminal booking/deadline snapshot completed by the ticketing operation.
  if v_transitional_terminal then return v_after_sync; end if;

  v_request_id := v_after_sync.active_local_time_limit_request_id;
  v_supersede_reason := case
    when v_target is not null then 'supplier_terminal_evidence'
    when p_ticketing_deadline_at >= clock_timestamp() + interval '15 minutes'
      then 'supplier_deadline_now_sufficient'
    else null
  end;
  if v_request_id is not null and v_supersede_reason is not null then
    update public.booking_local_time_limit_requests set
      state = 'superseded', superseded_at = clock_timestamp(),
      superseded_reason = v_supersede_reason, version = version + 1
    where id = v_request_id and state = 'approved';
    insert into public.booking_local_time_limit_events (
      booking_id, request_id, event_type, actor_user_id, actor_role,
      prior_deadline_at, resulting_deadline_at, reason, evidence
    ) values (
      p_booking_id, v_request_id,
      case when v_target is null then 'superseded' else 'supplier_conflict' end,
      p_actor_user_id, p_actor_role,
      v_after_sync.local_ticketing_deadline_at, p_ticketing_deadline_at,
      v_supersede_reason,
      jsonb_build_object(
        'supplierStatus', p_supplier_status,
        'supplierDeadlineAt', p_ticketing_deadline_at,
        'walletMutation', false
      )
    );
  end if;

  update public.flight_bookings set
    supplier_ticketing_time_limit = p_ticketing_time_limit,
    supplier_ticketing_deadline_at = p_ticketing_deadline_at,
    supplier_deadline_source = 'pnr_call',
    active_local_time_limit_request_id = case
      when v_supersede_reason is not null then null
      else active_local_time_limit_request_id
    end,
    ticketing_time_limit = p_ticketing_time_limit,
    ticketing_deadline_at = case
      when v_supersede_reason is not null then p_ticketing_deadline_at
      when active_local_time_limit_request_id is not null
        then local_ticketing_deadline_at
      else p_ticketing_deadline_at
    end,
    deadline_source = case
      when v_supersede_reason is null
           and active_local_time_limit_request_id is not null
        then 'local_approved'
      else 'pnr_call'
    end
  where id = p_booking_id returning * into v_after;

  v_after_lifecycle := public.resolve_booking_lifecycle(
    v_after.status, v_after.airlines_pnr,
    v_after.ticketing_deadline_at, v_after.operation_kind
  );
  if v_after_lifecycle is distinct from v_after_sync_lifecycle then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, actor_user_id, supplier_operation,
      supplier_evidence, idempotency_key
    ) values (
      p_booking_id, v_after_sync_lifecycle, v_after_lifecycle,
      v_after_sync.status, v_after.status, v_after.operation_kind,
      v_after.operation_reason, p_actor_user_id, 'PnrRefreshV3',
      jsonb_build_object(
        'supplierStatus', p_supplier_status,
        'supplierDeadlineAt', p_ticketing_deadline_at,
        'localGrantSuperseded', v_supersede_reason is not null,
        'walletMutation', false
      ), 'pnr-refresh-v3:' || v_hash
    ) on conflict do nothing;
  end if;
  return v_after;
end;
$$;

revoke all on function public.record_booking_pnr_refresh_v2(
  uuid, text, text, text, text, jsonb, text, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.record_booking_pnr_refresh_v3(
  uuid, text, text, text, text, jsonb, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_booking_pnr_refresh_v2(
  uuid, text, text, text, text, jsonb, text, timestamptz, jsonb
) to service_role;
grant execute on function public.record_booking_pnr_refresh_v3(
  uuid, text, text, text, text, jsonb, text, timestamptz, jsonb
) to service_role;

comment on function public.booking_ticketing_observation_overlap_v1(uuid, jsonb)
is 'Returns the matching healthy ticketing operation only when a case-bound PNR receipt and supplier identity overlap its NewTicket window. It is supplier-account neutral and moves no lifecycle or financial state.';

-- Supplier lifecycle timestamps are enrichment only. Once the booking writer
-- has established its authoritative terminal instant, a later report cannot
-- replace it with a lower-quality observation.
create or replace function public.record_booking_supplier_refresh_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_sync_source text,
  p_supplier_status text,
  p_airlines_pnr jsonb,
  p_ticket_numbers jsonb,
  p_issued_at timestamptz,
  p_cancelled_at timestamptz,
  p_normalized_evidence jsonb
)
returns public.flight_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.flight_bookings;
  v_after public.flight_bookings;
  v_target text;
  v_case_type text;
  v_conflict boolean;
  v_terminal boolean;
  v_before_lifecycle text;
  v_after_lifecycle text;
  v_facts jsonb;
begin
  if nullif(btrim(p_actor_user_id), '') is null
     or p_actor_role not in (
       'superadmin', 'admin', 'staff_support', 'staff_account',
       'customer', 'b2b', 'b2b_sub', 'system'
     )
     or p_sync_source not in (
       'ordinary_sync', 'cancellation_verification', 'compatibility_sync'
     ) then
    raise exception 'invalid supplier refresh actor' using errcode = '22023';
  end if;

  select booking.* into v_before
    from public.flight_bookings booking
   where booking.id = p_booking_id and not booking.legacy_operational
   for update;
  if not found then raise exception 'booking not found' using errcode = 'P0002'; end if;

  v_target := case lower(btrim(coalesce(p_supplier_status, '')))
    when 'issued' then 'confirmed'
    when 'confirmed' then 'confirmed'
    when 'cancelled' then 'cancelled'
    when 'canceled' then 'cancelled'
    else null
  end;
  v_terminal := v_before.status in ('confirmed', 'cancelled');
  v_conflict := case
    when v_terminal then v_target is distinct from v_before.status
    else v_target is not null and v_target <> v_before.status
  end;
  v_before_lifecycle := public.resolve_booking_lifecycle(
    v_before.status, v_before.airlines_pnr,
    v_before.ticketing_deadline_at, v_before.operation_kind
  );
  v_facts := jsonb_build_object(
    'version', 2, 'action', 'ordinary_supplier_sync',
    'source', 'air-ticketing-details', 'syncSource', p_sync_source,
    'bookingId', p_booking_id, 'localStoredStatus', v_before.status,
    'localLifecycleStatus', v_before_lifecycle,
    'supplierStatus', p_supplier_status,
    'candidateLifecycleStatus', v_target,
    'protectedTerminal', v_terminal,
    'statusMutation', false, 'walletMutation', false,
    'evidence', coalesce(p_normalized_evidence, '{}'::jsonb)
  );

  if v_conflict then
    update public.flight_bookings
       set synced_at = clock_timestamp(), booking_status = p_supplier_status
     where id = p_booking_id returning * into v_after;
    v_case_type := case
      when v_terminal then 'terminal_conflict'
      when v_target = 'cancelled' then 'cancellation_uncertainty'
      else 'ticketing_uncertainty'
    end;
    perform public.record_booking_sync_case_v1(
      p_booking_id, v_case_type,
      'supplier_sync_conflicts_with_local_truth',
      'Ordinary AirTicketingDetails Sync differs from local lifecycle truth and requires controlled resolution.',
      p_actor_user_id, p_actor_role,
      v_facts || jsonb_build_object('caseType', v_case_type)
    );
  else
    update public.flight_bookings
       set synced_at = clock_timestamp(),
           booking_status = p_supplier_status,
           airlines_pnr = case
             when public.jsonb_is_nonempty_array(p_airlines_pnr)
               then p_airlines_pnr else airlines_pnr
           end,
           ticket_numbers = case
             when public.jsonb_is_nonempty_array(p_ticket_numbers)
               then p_ticket_numbers else ticket_numbers
           end,
           issued_at = case
             when status = 'confirmed' and v_target = 'confirmed'
               then coalesce(issued_at, p_issued_at)
             else issued_at
           end,
           cancelled_at = case
             when status = 'cancelled' and v_target = 'cancelled'
               then coalesce(cancelled_at, p_cancelled_at)
             else cancelled_at
           end
     where id = p_booking_id returning * into v_after;
  end if;

  v_after_lifecycle := public.resolve_booking_lifecycle(
    v_after.status, v_after.airlines_pnr,
    v_after.ticketing_deadline_at, v_after.operation_kind
  );
  if v_after_lifecycle is distinct from v_before_lifecycle then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, actor_user_id, supplier_operation, supplier_evidence
    ) values (
      p_booking_id, v_before_lifecycle, v_after_lifecycle,
      v_before.status, v_after.status, v_after.operation_kind,
      v_after.operation_reason, p_actor_user_id, 'SupplierRefreshV2',
      jsonb_build_object(
        'supplierStatus', p_supplier_status,
        'statusMutation', false, 'walletMutation', false
      )
    );
  end if;
  return v_after;
end;
$$;

revoke all on function public.record_booking_supplier_refresh_v2(
  uuid, text, text, text, text, jsonb, jsonb, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_booking_supplier_refresh_v2(
  uuid, text, text, text, text, jsonb, jsonb, timestamptz, timestamptz, jsonb
) to service_role;

-- Permit the service-owned post-ticketing verifier to append the same
-- immutable case-bound evidence as the staff endpoint. All existing payload,
-- freshness and no-mutation constraints remain unchanged.
create or replace function public.record_booking_reconciliation_evidence_read_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_observation_key text,
  p_normalized_facts jsonb,
  p_normalized_facts_hash text,
  p_observed_at timestamptz,
  p_evidence_observed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case public.booking_reconciliation_cases;
  v_observation public.booking_reconciliation_observations;
  v_existing_hash text;
  v_created boolean := false;
  v_case_version integer;
begin
  if p_booking_id is null or p_case_id is null
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or p_actor_role not in ('staff_support', 'admin', 'superadmin', 'system')
     or p_observation_key !~ '^evidence-read:v1:[a-f0-9]{64}$'
     or p_normalized_facts_hash !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(coalesce(p_normalized_facts, '{}'::jsonb)) <> 'object'
     or coalesce(p_normalized_facts->>'version', '') <> '1'
     or coalesce(p_normalized_facts->>'action', '') <> 'supplier_evidence_read'
     or coalesce((p_normalized_facts->>'statusMutation')::boolean, true) is not false
     or coalesce((p_normalized_facts->>'walletMutation')::boolean, true) is not false
     or coalesce((p_normalized_facts->>'destructiveSupplierCall')::boolean, true) is not false
     or p_normalized_facts->>'bookingId' is distinct from p_booking_id::text
     or p_normalized_facts->>'caseId' is distinct from p_case_id::text
     or p_observed_at is null
     or p_observed_at > clock_timestamp() + interval '1 minute'
     or p_observed_at < clock_timestamp() - interval '5 minutes'
     or (p_evidence_observed_at is not null and (
       p_evidence_observed_at > p_observed_at + interval '1 minute'
       or p_evidence_observed_at < p_observed_at - interval '5 minutes'
     )) then
    raise exception 'invalid reconciliation evidence-read observation'
      using errcode = '22023';
  end if;

  select candidate.* into v_case
    from public.booking_reconciliation_cases candidate
   where candidate.id = p_case_id
     and candidate.subject_booking_id = p_booking_id
   for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND'); end if;
  if v_case.state not in (
    'open', 'assigned', 'awaiting_supplier',
    'awaiting_finance', 'awaiting_approval'
  ) then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_OPEN');
  end if;
  if not exists (
    select 1 from public.flight_bookings booking where booking.id = p_booking_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  insert into public.booking_reconciliation_observations (
    reconciliation_case_id, observation_key, observation_kind,
    observation_source, actor_user_id, actor_role, normalized_facts,
    normalized_facts_hash, observed_at
  ) values (
    p_case_id, p_observation_key, 'staff_evidence', 'supplier_read',
    p_actor_user_id, p_actor_role, p_normalized_facts,
    p_normalized_facts_hash, p_observed_at
  ) on conflict (reconciliation_case_id, observation_key) do nothing
  returning * into v_observation;

  if v_observation.id is null then
    select observation.normalized_facts_hash into v_existing_hash
      from public.booking_reconciliation_observations observation
     where observation.reconciliation_case_id = p_case_id
       and observation.observation_key = p_observation_key;
    if v_existing_hash is distinct from p_normalized_facts_hash then
      raise exception 'evidence-read request payload mismatch' using errcode = '22023';
    end if;
    select observation.* into v_observation
      from public.booking_reconciliation_observations observation
     where observation.reconciliation_case_id = p_case_id
       and observation.observation_key = p_observation_key;
  else
    v_created := true;
    update public.booking_reconciliation_cases
       set evidence_latest_at = case
             when p_evidence_observed_at is null then evidence_latest_at
             when evidence_latest_at is null then p_evidence_observed_at
             else greatest(evidence_latest_at, p_evidence_observed_at)
           end,
           evidence_normalizer_version = case
             when p_evidence_observed_at is null then evidence_normalizer_version
             else 1
           end,
           version = version + 1
     where id = p_case_id;
  end if;

  select version into v_case_version
    from public.booking_reconciliation_cases where id = p_case_id;
  return jsonb_build_object(
    'ok', true, 'replay', not v_created, 'caseId', p_case_id,
    'caseVersion', v_case_version, 'observationId', v_observation.id,
    'evidenceLatestAt', case when p_evidence_observed_at is null
      then null else p_evidence_observed_at end,
    'statusMutation', false, 'walletMutation', false,
    'destructiveSupplierCall', false
  );
end;
$$;

revoke all on function public.record_booking_reconciliation_evidence_read_v1(
  uuid, uuid, text, text, text, jsonb, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_booking_reconciliation_evidence_read_v1(
  uuid, uuid, text, text, text, jsonb, text, timestamptz, timestamptz
) to service_role;

-- Close only the historical false-positive shape created by an overlapping
-- PNR read. Unlike the general no-change closer, this function accepts an
-- already-succeeded ticketing operation and deliberately mutates only the
-- reconciliation case plus its security audit record.
create or replace function public.close_booking_ticketing_race_no_change_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_observation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_reservation public.wallet_reservations;
  v_observation public.booking_reconciliation_observations;
  v_operation_id uuid;
  v_evidence_at timestamptz;
begin
  if p_booking_id is null or p_case_id is null or p_observation_id is null then
    raise exception 'invalid ticketing-race closure request' using errcode = '22023';
  end if;

  select candidate.operation_id into v_operation_id
    from public.booking_reconciliation_cases candidate
   where candidate.id = p_case_id
     and candidate.subject_booking_id = p_booking_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND'); end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;

  if v_operation_id is not null then
    select operation.* into v_operation
      from public.booking_operations operation
     where operation.id = v_operation_id
       and operation.booking_id = p_booking_id
     for update;
  end if;
  select candidate.* into v_case
    from public.booking_reconciliation_cases candidate
   where candidate.id = p_case_id
     and candidate.subject_booking_id = p_booking_id
   for update;

  if v_case.state = 'closed_no_change'
     and v_case.resolution_outcome = 'supplier_truth_unchanged'
     and v_case.resolution->>'observationId' = p_observation_id::text then
    return jsonb_build_object(
      'ok', true, 'replay', true, 'caseId', p_case_id,
      'observationId', p_observation_id,
      'statusMutation', false, 'walletMutation', false
    );
  end if;
  if v_case.state not in (
    'open', 'assigned', 'awaiting_supplier',
    'awaiting_finance', 'awaiting_approval'
  ) then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_OPEN');
  end if;

  select reservation.* into v_reservation
    from public.wallet_reservations reservation
   where reservation.booking_id = p_booking_id for update;
  select observation.* into v_observation
    from public.booking_reconciliation_observations observation
   where observation.id = p_observation_id
     and observation.reconciliation_case_id = p_case_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'EVIDENCE_NOT_FOUND'); end if;

  if v_case.case_type <> 'ticketing_uncertainty'
     or v_case.reason_code <> 'pnr_sync_conflicts_with_local_truth'
     or v_case.opened_source <> 'supplier_sync'
     or v_case.proposed_outcome is not null
     or v_case.financial_disposition <> 'none'
     or v_case.operation_id is null
     or v_operation.id is null
     or v_operation.kind <> 'ticketing'
     or v_operation.state <> 'succeeded'
     or v_operation.completed_at is null
     or v_case.opened_at < v_operation.claimed_at - interval '1 minute'
     or v_case.opened_at > v_operation.completed_at + interval '1 minute'
     or v_booking.active_operation_id is not null
     or v_booking.status <> 'confirmed'
     or exists (
       select 1 from public.booking_reconciliation_cases other_case
        where other_case.subject_booking_id = p_booking_id
          and other_case.id <> p_case_id
          and other_case.state in (
            'open', 'assigned', 'awaiting_supplier',
            'awaiting_finance', 'awaiting_approval'
          )
     ) then
    return jsonb_build_object('ok', false, 'code', 'TICKETING_RACE_CLOSURE_NOT_ELIGIBLE');
  end if;

  begin
    v_evidence_at := (v_observation.normalized_facts->>'evidenceObservedAt')::timestamptz;
  exception when others then
    v_evidence_at := null;
  end;
  if v_observation.observation_kind <> 'staff_evidence'
     or v_observation.observation_source <> 'supplier_read'
     or v_observation.normalized_facts->>'action' is distinct from 'supplier_evidence_read'
     or v_observation.normalized_facts->>'bookingId' is distinct from p_booking_id::text
     or v_observation.normalized_facts->>'caseId' is distinct from p_case_id::text
     or v_observation.normalized_facts #>> '{validation,authoritativeFor}'
          is distinct from 'ticketed'
     or coalesce((v_observation.normalized_facts #>> '{validation,valid}')::boolean, false) is not true
     or coalesce((v_observation.normalized_facts #>> '{validation,complete}')::boolean, false) is not true
     or coalesce((v_observation.normalized_facts #>> '{validation,fresh}')::boolean, false) is not true
     or coalesce((v_observation.normalized_facts #>> '{validation,identityMatches}')::boolean, false) is not true
     or v_evidence_at is null
     or v_evidence_at < clock_timestamp() - interval '5 minutes'
     or v_evidence_at > clock_timestamp() + interval '1 minute'
     or not (
       coalesce(v_observation.normalized_facts->'recordedSources', '[]'::jsonb)
         @> '["pnr", "air-ticketing-details"]'::jsonb
     )
     or v_observation.normalized_facts #>> '{evidence,pnr,source}' is distinct from 'pnr'
     or v_observation.normalized_facts #>> '{evidence,airTicketing,source}'
          is distinct from 'air-ticketing-details'
     or upper(btrim(coalesce(
          v_observation.normalized_facts #>> '{expectedIdentity,uniqueTransId}', ''
        ))) is distinct from upper(btrim(coalesce(
          v_booking.supplier_refs->>'uniqueTransId', ''
        )))
     or upper(btrim(coalesce(
          v_observation.normalized_facts #>> '{expectedIdentity,bookingCodeRef}', ''
        ))) is distinct from upper(btrim(coalesce(v_booking.booking_code_ref, '')))
     or v_observation.normalized_facts #>> '{localContext,storedStatus}'
          is distinct from v_booking.status
     or v_observation.normalized_facts #>> '{localContext,paymentState}'
          is distinct from v_booking.payment_state then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_NOT_AUTHORITATIVE');
  end if;

  if not (
    v_booking.payment_state = 'captured'
    and v_booking.captured_amount > 0
    and v_booking.refunded_amount = 0
    and v_booking.payment_amount = v_booking.captured_amount
    and v_reservation.id is not null
    and v_reservation.state = 'captured'
    and v_reservation.amount = v_booking.captured_amount
    and v_reservation.currency = v_booking.currency
  ) then
    return jsonb_build_object('ok', false, 'code', 'FINANCIAL_CONFLICT');
  end if;

  update public.booking_reconciliation_cases
     set state = 'closed_no_change',
         resolution_outcome = 'supplier_truth_unchanged',
         resolution = jsonb_build_object(
           'observationId', p_observation_id,
           'authoritativeFor', 'ticketed',
           'closureKind', 'ticketing_operation_window_race',
           'statusMutation', false, 'walletMutation', false
         ),
         resolution_reason =
           'Fresh complete supplier evidence confirms the issued ticket, booking identity, itinerary, passengers, and already-captured financial state',
         resolved_by_user_id = 'system:post-ticketing-evidence',
         resolved_at = clock_timestamp(), closed_at = clock_timestamp(),
         version = version + 1
   where id = p_case_id;

  insert into public.security_audit_events (
    actor_user_id, actor_role, action, target_type, target_id, outcome, metadata
  ) values (
    'system:post-ticketing-evidence', 'system',
    'booking.reconciliation.ticketing_race_closed_no_change',
    'flight_booking', p_booking_id::text, 'succeeded',
    jsonb_build_object(
      'caseId', p_case_id, 'operationId', v_operation.id,
      'observationId', p_observation_id, 'authoritativeFor', 'ticketed',
      'statusMutation', false, 'walletMutation', false
    )
  );

  return jsonb_build_object(
    'ok', true, 'replay', false, 'caseId', p_case_id,
    'operationId', v_operation.id, 'observationId', p_observation_id,
    'closedNoChange', true, 'statusMutation', false, 'walletMutation', false
  );
end;
$$;

revoke all on function public.close_booking_ticketing_race_no_change_v1(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.close_booking_ticketing_race_no_change_v1(uuid, uuid, uuid)
  to service_role;

comment on function public.close_booking_ticketing_race_no_change_v1(uuid, uuid, uuid)
is 'Idempotently closes only a PNR-sync ticketing race case after fresh complete PNR plus AirTicketingDetails evidence matches the confirmed booking and captured reservation. It changes no booking, operation, wallet, reservation, ledger, event, or notification state.';
