-- Ordinary supplier synchronization is evidence acquisition, not a generic
-- lifecycle setter. Matching state may be enriched; a differing supplier
-- outcome is recorded in an owned case without changing protected local truth.

create or replace function public.record_booking_sync_case_v1(
  p_booking_id uuid,
  p_case_type text,
  p_reason_code text,
  p_reason_detail text,
  p_actor_user_id text,
  p_actor_role text,
  p_normalized_facts jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_case_id uuid;
  v_observation_id uuid;
  v_facts_hash text;
  v_observation_key text;
begin
  if p_booking_id is null
     or p_case_type not in (
       'ticketing_uncertainty', 'cancellation_uncertainty',
       'legacy_review', 'terminal_conflict',
       'imported_manual_ticketing', 'imported_payment_conflict'
     )
     or nullif(btrim(p_reason_code), '') is null
     or nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_actor_role), '') is null
     or p_normalized_facts is null
     or jsonb_typeof(p_normalized_facts) <> 'object' then
    raise exception 'invalid supplier sync case request' using errcode = '22023';
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    raise exception 'booking not found' using errcode = 'P0002';
  end if;

  insert into public.booking_reconciliation_cases (
    subject_booking_id, operation_id, case_type, state,
    reason_code, reason_detail,
    opened_source, opened_by_user_id, opened_by_role, opened_at,
    assigned_team, severity, priority, due_at,
    evidence, evidence_normalizer_version, policy_version
  ) values (
    p_booking_id, v_booking.active_operation_id, p_case_type, 'open',
    p_reason_code, left(coalesce(p_reason_detail, p_reason_code), 1000),
    'supplier_sync', p_actor_user_id, p_actor_role, clock_timestamp(),
    case when p_case_type in ('terminal_conflict', 'imported_payment_conflict')
      then 'admin' else 'support' end,
    case when p_case_type in ('terminal_conflict', 'imported_payment_conflict')
      then 'critical' else 'high' end,
    case when p_case_type in ('terminal_conflict', 'imported_payment_conflict')
      then 0 else 20 end,
    clock_timestamp() + case
      when p_case_type in ('terminal_conflict', 'imported_payment_conflict')
        then interval '1 hour'
      else interval '30 minutes'
    end,
    '[]'::jsonb, 1, 1
  ) on conflict do nothing
  returning id into v_case_id;

  if v_case_id is null then
    select candidate.id into v_case_id
      from public.booking_reconciliation_cases candidate
     where candidate.subject_booking_id = p_booking_id
       and candidate.case_type = p_case_type
       and candidate.state in (
         'open', 'assigned', 'awaiting_supplier',
         'awaiting_finance', 'awaiting_approval'
       )
     order by candidate.opened_at, candidate.id
     limit 1
     for update;
  end if;
  if v_case_id is null then
    raise exception 'supplier sync case could not be owned' using errcode = 'P0001';
  end if;

  -- JSONB has a stable textual representation in PostgreSQL. Two MD5 domains
  -- provide the existing 64-hex payload binding used by migration-only rows;
  -- the supplier evidence itself retains its transport SHA-256 receipt.
  v_facts_hash := md5(p_normalized_facts::text)
    || md5('supplier-sync:v1:' || p_normalized_facts::text);
  v_observation_key := 'supplier-sync:v1:' || v_facts_hash;

  insert into public.booking_reconciliation_observations (
    reconciliation_case_id, observation_key,
    observation_kind, observation_source,
    actor_user_id, actor_role,
    normalized_facts, normalized_facts_hash,
    observed_at
  ) values (
    v_case_id, v_observation_key,
    'supplier_read', 'supplier_read',
    p_actor_user_id, p_actor_role,
    p_normalized_facts, v_facts_hash,
    clock_timestamp()
  ) on conflict (reconciliation_case_id, observation_key) do nothing
  returning id into v_observation_id;

  if v_observation_id is not null then
    update public.booking_reconciliation_cases
       set evidence_latest_at = clock_timestamp(),
           evidence_normalizer_version = 1,
           version = version + 1
     where id = v_case_id;
  end if;

  return v_case_id;
end;
$$;

revoke all on function public.record_booking_sync_case_v1(
  uuid, text, text, text, text, text, jsonb
) from public, anon, authenticated, service_role;

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
  v_case_id uuid;
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
    'version', 1,
    'action', 'ordinary_supplier_sync',
    'source', 'air-ticketing-details',
    'syncSource', p_sync_source,
    'bookingId', p_booking_id,
    'localStoredStatus', v_before.status,
    'localLifecycleStatus', v_before_lifecycle,
    'supplierStatus', p_supplier_status,
    'candidateLifecycleStatus', v_target,
    'protectedTerminal', v_terminal,
    'statusMutation', false,
    'walletMutation', false,
    'evidence', coalesce(p_normalized_evidence, '{}'::jsonb)
  );

  if v_conflict then
    -- Conflicting supplier truth is retained only in the immutable observation.
    -- Do not copy conflicting PNR/ticket/timestamps over local truth.
    update public.flight_bookings
       set synced_at = clock_timestamp(),
           booking_status = p_supplier_status
     where id = p_booking_id
     returning * into v_after;

    v_case_type := case
      when v_terminal then 'terminal_conflict'
      when v_target = 'cancelled' then 'cancellation_uncertainty'
      else 'ticketing_uncertainty'
    end;
    v_case_id := public.record_booking_sync_case_v1(
      p_booking_id,
      v_case_type,
      'supplier_sync_conflicts_with_local_truth',
      'Ordinary AirTicketingDetails Sync differs from local lifecycle truth and requires controlled resolution.',
      p_actor_user_id,
      p_actor_role,
      v_facts || jsonb_build_object('caseType', v_case_type)
    );
  else
    -- Matching terminal truth or non-terminal enrichment may update only the
    -- corresponding supplier snapshot. It does not set lifecycle status.
    update public.flight_bookings
       set synced_at = clock_timestamp(),
           booking_status = p_supplier_status,
           airlines_pnr = case
             when public.jsonb_is_nonempty_array(p_airlines_pnr)
               then p_airlines_pnr
             else airlines_pnr
           end,
           ticket_numbers = case
             when public.jsonb_is_nonempty_array(p_ticket_numbers)
               then p_ticket_numbers
             else ticket_numbers
           end,
           issued_at = case
             when status = 'confirmed' and v_target = 'confirmed'
               then coalesce(p_issued_at, issued_at)
             else issued_at
           end,
           cancelled_at = case
             when status = 'cancelled' and v_target = 'cancelled'
               then coalesce(p_cancelled_at, cancelled_at)
             else cancelled_at
           end
     where id = p_booking_id
     returning * into v_after;
  end if;

  v_after_lifecycle := public.resolve_booking_lifecycle(
    v_after.status, v_after.airlines_pnr,
    v_after.ticketing_deadline_at, v_after.operation_kind
  );
  if v_after_lifecycle is distinct from v_before_lifecycle then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, actor_user_id, supplier_operation,
      supplier_evidence
    ) values (
      p_booking_id, v_before_lifecycle, v_after_lifecycle,
      v_before.status, v_after.status, v_after.operation_kind,
      v_after.operation_reason, p_actor_user_id, 'SupplierRefreshV2',
      jsonb_build_object(
        'supplierStatus', p_supplier_status,
        'statusMutation', false,
        'walletMutation', false
      )
    );
  end if;
  return v_after;
end;
$$;

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
  v_case_id uuid;
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
  v_terminal := v_before.status in ('confirmed', 'cancelled');
  v_conflict := case
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
    'version', 1,
    'action', 'ordinary_supplier_sync',
    'source', 'pnr',
    'syncSource', p_sync_source,
    'bookingId', p_booking_id,
    'localStoredStatus', v_before.status,
    'localLifecycleStatus', v_before_lifecycle,
    'supplierStatus', p_supplier_status,
    'candidateLifecycleStatus', v_target,
    'protectedTerminal', v_terminal,
    'statusMutation', false,
    'walletMutation', false,
    'evidence', coalesce(p_normalized_evidence, '{}'::jsonb)
  );

  if v_conflict then
    update public.flight_bookings
       set synced_at = clock_timestamp(),
           booking_status = p_supplier_status
     where id = p_booking_id
     returning * into v_after;
    v_case_type := case
      when v_terminal then 'terminal_conflict'
      when v_target = 'cancelled' then 'cancellation_uncertainty'
      else 'ticketing_uncertainty'
    end;
    v_case_id := public.record_booking_sync_case_v1(
      p_booking_id,
      v_case_type,
      'pnr_sync_conflicts_with_local_truth',
      'Ordinary PNR Sync differs from local lifecycle truth and requires controlled resolution.',
      p_actor_user_id,
      p_actor_role,
      v_facts || jsonb_build_object('caseType', v_case_type)
    );
  else
    update public.flight_bookings
       set synced_at = clock_timestamp(),
           booking_status = p_supplier_status,
           airlines_pnr = case
             when public.jsonb_is_nonempty_array(p_airlines_pnr)
               then p_airlines_pnr
             else airlines_pnr
           end,
           ticketing_time_limit = case
             when p_ticketing_deadline_at is not null
               then p_ticketing_time_limit
             else ticketing_time_limit
           end,
           ticketing_deadline_at = coalesce(
             p_ticketing_deadline_at, ticketing_deadline_at
           ),
           deadline_source = case
             when p_ticketing_deadline_at is not null
               then 'pnr_call'
             else deadline_source
           end
     where id = p_booking_id
     returning * into v_after;
  end if;

  v_after_lifecycle := public.resolve_booking_lifecycle(
    v_after.status, v_after.airlines_pnr,
    v_after.ticketing_deadline_at, v_after.operation_kind
  );
  if v_after_lifecycle is distinct from v_before_lifecycle then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, actor_user_id, supplier_operation,
      supplier_evidence
    ) values (
      p_booking_id, v_before_lifecycle, v_after_lifecycle,
      v_before.status, v_after.status, v_after.operation_kind,
      v_after.operation_reason, p_actor_user_id, 'PnrRefreshV2',
      jsonb_build_object(
        'supplierStatus', p_supplier_status,
        'airlinesPnr', p_airlines_pnr,
        'ticketingDeadlineAt', p_ticketing_deadline_at,
        'statusMutation', false,
        'walletMutation', false
      )
    );
  end if;
  return v_after;
end;
$$;

-- Keep the established RPC signatures safe during a rolling application
-- deployment. Compatibility callers receive the same protected behavior.
create or replace function public.record_booking_supplier_refresh(
  p_booking_id uuid,
  p_supplier_status text,
  p_airlines_pnr jsonb,
  p_ticket_numbers jsonb,
  p_issued_at timestamptz,
  p_cancelled_at timestamptz
)
returns public.flight_bookings
language sql
security definer
set search_path = public
as $$
  select public.record_booking_supplier_refresh_v2(
    p_booking_id, 'system:compat-sync', 'system', 'compatibility_sync',
    p_supplier_status, p_airlines_pnr, p_ticket_numbers,
    p_issued_at, p_cancelled_at, '{}'::jsonb
  );
$$;

create or replace function public.record_booking_pnr_refresh(
  p_booking_id uuid,
  p_supplier_status text,
  p_airlines_pnr jsonb,
  p_ticketing_time_limit text,
  p_ticketing_deadline_at timestamptz
)
returns public.flight_bookings
language sql
security definer
set search_path = public
as $$
  select public.record_booking_pnr_refresh_v2(
    p_booking_id, 'system:compat-sync', 'system', 'compatibility_sync',
    p_supplier_status, p_airlines_pnr,
    p_ticketing_time_limit, p_ticketing_deadline_at, '{}'::jsonb
  );
$$;

revoke all on function public.record_booking_supplier_refresh_v2(
  uuid, text, text, text, text, jsonb, jsonb, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.record_booking_pnr_refresh_v2(
  uuid, text, text, text, text, jsonb, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.record_booking_supplier_refresh_v2(
  uuid, text, text, text, text, jsonb, jsonb, timestamptz, timestamptz, jsonb
) to service_role;
grant execute on function public.record_booking_pnr_refresh_v2(
  uuid, text, text, text, text, jsonb, text, timestamptz, jsonb
) to service_role;

-- Retain the large established import normalizer behind a protected wrapper.
-- Only an exact lifecycle match may reach it; any differing outcome becomes a
-- case and leaves stored/public/financial truth untouched.
alter function public.sync_impexp_booking(text, uuid, bigint, jsonb)
  rename to sync_impexp_booking_pre_0048;

create or replace function public.sync_impexp_booking_v2(
  p_actor_user_id text,
  p_booking_id uuid,
  p_supplier_gross_amount bigint,
  p_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_booking public.flight_bookings;
  v_updated public.flight_bookings;
  v_supplier text;
  v_supplier_ref text;
  v_supplier_status text;
  v_supplier_lifecycle text;
  v_local_lifecycle text;
  v_case_type text;
  v_case_id uuid;
  v_payment_case_id uuid;
  v_financial_conflict boolean;
  v_facts jsonb;
  v_result jsonb;
begin
  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role not in ('superadmin', 'admin', 'staff_support') then
    return jsonb_build_object('ok', false, 'code', 'IMPEXP_FORBIDDEN');
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object'
     or p_supplier_gross_amount is null or p_supplier_gross_amount < 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_DATA');
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id and booking.import_source = 'IMP_EXP'
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_NOT_FOUND');
  end if;
  if v_booking.user_payable_amount is null
     or v_booking.booking_owner_type is null
     or v_booking.booking_owner_key is null then
    return jsonb_build_object(
      'ok', false, 'code', 'HISTORICAL_IMPORT_RECONCILIATION_REQUIRED'
    );
  end if;

  v_supplier := nullif(btrim(p_data->>'provider'), '');
  v_supplier_ref := nullif(btrim(p_data->>'supplierReference'), '');
  if v_supplier is distinct from v_booking.supplier
     or v_supplier_ref is distinct from v_booking.booking_ref_number then
    return jsonb_build_object('ok', false, 'code', 'IMPORT_IDENTITY_MISMATCH');
  end if;
  if jsonb_typeof(p_data->'passengerCounts') <> 'object'
     or jsonb_typeof(p_data->'itinerary') <> 'object'
     or jsonb_typeof(p_data->'fares') <> 'array'
     or jsonb_typeof(p_data->'passengers') <> 'object'
     or jsonb_typeof(p_data->'airlinesPnr') <> 'array'
     or jsonb_typeof(p_data->'ticketNumbers') <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_DATA');
  end if;

  v_supplier_status := p_data->>'storedStatus';
  v_supplier_lifecycle := p_data->>'lifecycleStatus';
  if v_supplier_status not in (
       'on-hold', 'pending', 'in-progress', 'confirmed', 'cancelled'
     ) or v_supplier_lifecycle not in (
       'on-hold', 'pending', 'in-progress', 'confirmed', 'expired',
       'unconfirmed', 'cancelled'
     ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_STATUS');
  end if;

  v_local_lifecycle := public.resolve_booking_lifecycle(
    v_booking.status,
    v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at,
    v_booking.operation_kind
  );
  v_financial_conflict := case
    when v_booking.status = 'confirmed' then not (
      v_booking.payment_state = 'captured'
      and v_booking.captured_amount > 0
      and v_booking.refunded_amount = 0
      and v_booking.payment_amount = v_booking.captured_amount
    )
    when v_booking.status = 'cancelled' then not (
      (v_booking.payment_state = 'unpaid'
        and v_booking.captured_amount = 0
        and v_booking.refunded_amount = 0)
      or (v_booking.payment_state = 'released'
        and v_booking.captured_amount = 0
        and v_booking.refunded_amount = 0)
      or (v_booking.payment_state = 'refunded'
        and v_booking.captured_amount > 0
        and v_booking.refunded_amount = v_booking.captured_amount)
    )
    else false
  end;
  v_facts := jsonb_build_object(
    'version', 1,
    'action', 'ordinary_supplier_sync',
    'source', 'imported_supplier',
    'bookingId', p_booking_id,
    'provider', v_supplier,
    'supplierReference', v_supplier_ref,
    'localStoredStatus', v_booking.status,
    'localLifecycleStatus', v_local_lifecycle,
    'supplierStoredStatus', v_supplier_status,
    'supplierLifecycleStatus', v_supplier_lifecycle,
    'supplierOrderStatus', p_data->>'orderStatus',
    'airlinesPnr', p_data->'airlinesPnr',
    'ticketNumbers', p_data->'ticketNumbers',
    'ticketingDeadlineAt', p_data->>'ticketingDeadlineAt',
    'supplierGrossAmount', p_supplier_gross_amount,
    'statusMutation', false,
    'walletMutation', false
  );

  if v_supplier_lifecycle is distinct from v_local_lifecycle then
    -- Update only an explicitly non-authoritative supplier snapshot. Passenger,
    -- route, ticket, terminal, operation, and money fields remain untouched.
    update public.flight_bookings
       set synced_at = clock_timestamp(),
           booking_status = p_data->>'orderStatus',
           import_metadata = coalesce(import_metadata, '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
               'provider', v_supplier,
               'supplierReference', v_supplier_ref,
               'orderStatus', p_data->>'orderStatus',
               'observedLifecycleStatus', v_supplier_lifecycle,
               'lastObservedAt', clock_timestamp(),
               'lastObservedBy', p_actor_user_id,
               'protectedFromSyncMutation', true
             ))
     where id = p_booking_id
     returning * into v_updated;

    v_case_type := case
      when v_booking.status in ('confirmed', 'cancelled') then 'terminal_conflict'
      when v_supplier_lifecycle = 'cancelled' then 'cancellation_uncertainty'
      when v_supplier_lifecycle = 'confirmed'
        and v_booking.payment_state <> 'captured'
        then 'imported_payment_conflict'
      when v_booking.payment_state = 'captured'
        then 'imported_manual_ticketing'
      else 'ticketing_uncertainty'
    end;
    v_case_id := public.record_booking_sync_case_v1(
      p_booking_id,
      v_case_type,
      'imported_sync_conflicts_with_local_truth',
      'Ordinary imported-booking Sync differs from local lifecycle truth and requires controlled resolution.',
      p_actor_user_id,
      v_actor_role,
      v_facts || jsonb_build_object('caseType', v_case_type)
    );
    return jsonb_build_object(
      'ok', true,
      'booking', to_jsonb(v_updated),
      'walletCharged', false,
      'status', v_local_lifecycle,
      'reconciliationRequired', true,
      'reconciliationCaseId', v_case_id,
      'statusMutation', false,
      'walletMutation', false
    );
  end if;

  if v_booking.status in ('confirmed', 'cancelled') then
    -- Matching terminal truth may fill missing supplier locators/timestamps,
    -- but it must not clear an owned operation/case or rewrite travel/money.
    update public.flight_bookings
       set synced_at = clock_timestamp(),
           booking_status = p_data->>'orderStatus',
           airlines_pnr = case
             when public.jsonb_is_nonempty_array(p_data->'airlinesPnr')
               then p_data->'airlinesPnr'
             else airlines_pnr
           end,
           ticket_numbers = case
             when public.jsonb_is_nonempty_array(p_data->'ticketNumbers')
               then p_data->'ticketNumbers'
             else ticket_numbers
           end,
           issued_at = case
             when status = 'confirmed' then coalesce(
               issued_at,
               nullif(p_data->>'importedAt', '')::timestamptz,
               clock_timestamp()
             )
             else issued_at
           end,
           cancelled_at = case
             when status = 'cancelled' then coalesce(
               cancelled_at,
               nullif(p_data->>'importedAt', '')::timestamptz,
               clock_timestamp()
             )
             else cancelled_at
           end,
           import_metadata = coalesce(import_metadata, '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
               'provider', v_supplier,
               'supplierReference', v_supplier_ref,
               'orderStatus', p_data->>'orderStatus',
               'lifecycleStatus', v_supplier_lifecycle,
               'lastSyncedAt', clock_timestamp(),
               'lastSyncedBy', p_actor_user_id,
               'terminalTruthProtected', true
             ))
     where id = p_booking_id
     returning * into v_updated;

    if v_financial_conflict then
      v_payment_case_id := public.record_booking_sync_case_v1(
        p_booking_id,
        'imported_payment_conflict',
        'imported_terminal_financial_conflict',
        'Supplier lifecycle agrees, but local booking and financial truth require controlled reconciliation.',
        p_actor_user_id,
        v_actor_role,
        v_facts || jsonb_build_object(
          'caseType', 'imported_payment_conflict',
          'financialConflict', true
        )
      );
    end if;

    return jsonb_build_object(
      'ok', true,
      'booking', to_jsonb(v_updated),
      'walletCharged', false,
      'status', v_local_lifecycle,
      'reconciliationRequired', v_payment_case_id is not null,
      'reconciliationCaseId', v_payment_case_id,
      'statusMutation', false,
      'walletMutation', false
    );
  end if;

  -- Exact lifecycle agreement may use the retained normalizer for snapshot
  -- enrichment. It cannot cross a lifecycle boundary because both projections
  -- were compared while holding the booking row lock.
  v_result := public.sync_impexp_booking_pre_0048(
    p_actor_user_id, p_booking_id, p_supplier_gross_amount, p_data
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    return v_result;
  end if;
  select booking.* into v_updated
    from public.flight_bookings booking
   where booking.id = p_booking_id;
  if public.resolve_booking_lifecycle(
       v_updated.status,
       v_updated.airlines_pnr,
       v_updated.ticketing_deadline_at,
       v_updated.operation_kind
     ) is distinct from v_local_lifecycle then
    raise exception 'protected import sync changed lifecycle despite exact-match guard'
      using errcode = 'P0001';
  end if;

  if v_financial_conflict then
    v_payment_case_id := public.record_booking_sync_case_v1(
      p_booking_id,
      'imported_payment_conflict',
      'imported_terminal_financial_conflict',
      'Supplier lifecycle agrees, but local booking and financial truth require controlled reconciliation.',
      p_actor_user_id,
      v_actor_role,
      v_facts || jsonb_build_object(
        'caseType', 'imported_payment_conflict',
        'financialConflict', true
      )
    );
  end if;

  return v_result || jsonb_build_object(
    'reconciliationRequired', v_payment_case_id is not null,
    'reconciliationCaseId', v_payment_case_id,
    'statusMutation', false,
    'walletMutation', false
  );
end;
$$;

create or replace function public.sync_impexp_booking(
  p_actor_user_id text,
  p_booking_id uuid,
  p_supplier_gross_amount bigint,
  p_data jsonb
)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.sync_impexp_booking_v2(
    p_actor_user_id, p_booking_id, p_supplier_gross_amount, p_data
  );
$$;

revoke all on function public.sync_impexp_booking_pre_0048(
  text, uuid, bigint, jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.sync_impexp_booking_v2(
  text, uuid, bigint, jsonb
) from public, anon, authenticated;
revoke all on function public.sync_impexp_booking(
  text, uuid, bigint, jsonb
) from public, anon, authenticated;
grant execute on function public.sync_impexp_booking_v2(
  text, uuid, bigint, jsonb
) to service_role;
grant execute on function public.sync_impexp_booking(
  text, uuid, bigint, jsonb
) to service_role;

comment on function public.record_booking_supplier_refresh_v2(
  uuid, text, text, text, text, jsonb, jsonb, timestamptz, timestamptz, jsonb
) is
  'Records an actor-bound AirTicketingDetails refresh. Matching truth may enrich; differing truth opens/updates an immutable reconciliation case without changing lifecycle or money.';
comment on function public.record_booking_pnr_refresh_v2(
  uuid, text, text, text, text, jsonb, text, timestamptz, jsonb
) is
  'Records an actor-bound PNR refresh. Safe held/deadline enrichment remains supported; terminal or lifecycle conflict becomes immutable case evidence.';
comment on function public.sync_impexp_booking_v2(
  text, uuid, bigint, jsonb
) is
  'Protects imported booking lifecycle and money from ordinary Sync. Only exact lifecycle agreement may enrich the supplier snapshot; disagreement opens/updates an owned case.';
