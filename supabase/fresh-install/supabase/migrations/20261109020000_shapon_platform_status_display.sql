begin;

-- Display observations also cover native saved bookings without a PNR.
-- Keep the original identity function for the payment and ticketing RPCs.
create or replace function public.shapon_status_observation_identity_matches_v1(
  p_booking public.flight_bookings, p_identity jsonb
) returns boolean language sql immutable set search_path = public as $$
  select public.shapon_booking_status_identity_matches_v1(p_booking, p_identity)
    or coalesce(
      p_booking.supplier = 'shapontravels'
      and p_booking.supplier_account = 'shapontravels'
      and p_booking.import_source is null and not p_booking.legacy_operational
      and p_booking.supplier_public_ref ~ '^STR[A-Z0-9]{6,32}$'
      and p_booking.booking_code_ref ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      and p_identity->>'bookingCodeRef' = p_booking.booking_code_ref
      and p_identity->>'supplierPublicRef' = p_booking.supplier_public_ref
      and p_identity->>'uniqueTransId' = p_booking.supplier_refs->>'uniqueTransId'
      and p_identity->>'itemCodeRef' = p_booking.supplier_refs->>'itemCodeRef'
      and p_identity->>'priceCodeRef' = p_booking.supplier_refs->>'priceCodeRef'
      and p_identity->'pnr' = coalesce(to_jsonb(p_booking.pnr), 'null'::jsonb)
      and p_identity->'bookingRefNumber' = coalesce(to_jsonb(p_booking.booking_ref_number), 'null'::jsonb),
      false
    );
$$;

revoke all on function public.shapon_status_observation_identity_matches_v1(public.flight_bookings,jsonb)
  from public, anon, authenticated;
grant execute on function public.shapon_status_observation_identity_matches_v1(public.flight_bookings,jsonb)
  to service_role;

do $migration$
declare
  v_definition text := pg_get_functiondef(
    'public.record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb)'::regprocedure);
  v_identity text := 'public.shapon_booking_status_identity_matches_v1(v_booking,';
  v_ref text := '''supplierPublicRef'',p_receipt_identity->''supplierPublicRef'');';
  v_validation text := '  if jsonb_typeof(p_current_status) is distinct from ''object''';
  v_order text := '  order by observation.request_started_at desc, observation.received_at desc, observation.id desc limit 1;';
begin
  if position('-- shapon-platform-actions-v1' in v_definition) > 0 then return; end if;
  if (length(v_definition)-length(replace(v_definition,v_identity,'')))/length(v_identity) <> 2
      or (length(v_definition)-length(replace(v_definition,v_ref,'')))/length(v_ref) <> 1
      or (length(v_definition)-length(replace(v_definition,v_validation,'')))/length(v_validation) <> 1
      or (length(v_definition)-length(replace(v_definition,v_order,'')))/length(v_order) <> 1 then
    raise exception 'unexpected Shapon status recorder source';
  end if;
  v_definition := replace(v_definition, v_identity, 'public.shapon_status_observation_identity_matches_v1(v_booking,');
  v_definition := replace(v_definition, v_ref, $identity$
'supplierPublicRef',p_receipt_identity->'supplierPublicRef') ||
    case when p_receipt_identity ? 'canCancel'
      then jsonb_build_object('canCancel',p_receipt_identity->'canCancel') else '{}'::jsonb end ||
    case when p_receipt_identity ? 'canIssue'
      then jsonb_build_object('canIssue',p_receipt_identity->'canIssue') else '{}'::jsonb end ||
    case when p_receipt_identity->'issueResponse' = 'true'::jsonb
      then jsonb_build_object('issueResponse',true) else '{}'::jsonb end;$identity$);
  v_definition := replace(v_definition, v_order, $order$
  order by observation.request_started_at desc,
    coalesce(observation.receipt_identity->'issueResponse' = 'true'::jsonb, false) desc,
    observation.received_at desc, observation.id desc limit 1;$order$);
  v_definition := replace(v_definition, v_validation, $guard$
  -- shapon-platform-actions-v1
  if (p_receipt_identity ? 'canCancel'
        and jsonb_typeof(p_receipt_identity->'canCancel') is distinct from 'boolean')
      or (p_receipt_identity ? 'canIssue'
        and jsonb_typeof(p_receipt_identity->'canIssue') is distinct from 'boolean') then
    return jsonb_build_object('recorded',false,'projectionUpdated',false,'code','INVALID_CURRENT_STATUS');
  end if;
  if p_receipt_identity ? 'issueResponse' then
    if p_receipt_identity->'issueResponse' is distinct from 'true'::jsonb then
      return jsonb_build_object('recorded',false,'projectionUpdated',false,'code','INVALID_CURRENT_STATUS');
    end if;
    -- A delayed pending response cannot reopen an already resolved Issue or
    -- override a durable cancellation. A confirmed write can supersede an
    -- earlier hold snapshot even if the read started during that write.
    if (p_current_status->>'status' <> 'cancelled' and (v_booking.status = 'cancelled'
          or public.shapon_booking_current_status_v1(v_booking)#>>'{currentStatus,status}' = 'cancelled'))
        or (p_current_status->>'status' = 'in-progress' and (v_booking.status = 'confirmed'
          or public.shapon_booking_current_status_v1(v_booking)#>>'{currentStatus,status}' in ('confirmed','expired'))) then
      return jsonb_build_object('recorded',false,'projectionUpdated',false,'code','STALE_ISSUE_STATUS');
    end if;
  end if;
$guard$ || v_validation);
  execute v_definition;
end;
$migration$;

create or replace function public.shapon_booking_current_status_v1(p_booking public.flight_bookings)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_set(projected.metadata, '{currentStatus}', projected.metadata->'currentStatus' ||
    jsonb_strip_nulls(jsonb_build_object(
      'canCancel', observation.receipt_identity->'canCancel',
      'canIssue', observation.receipt_identity->'canIssue')))
    || case when observation.receipt_identity->'canIssue' = 'true'::jsonb
      and observation.current_status->>'status' = 'on-hold'
      and observation.current_status->'reviewRequired' = 'false'::jsonb
      and public.shapon_public_current_status_is_compact_v1(observation.current_status)
      and projected.metadata->>'effectiveStatus' = 'unconfirmed'
      and p_booking.supplier = 'shapontravels' and public.booking_uses_saved_references(p_booking)
      and p_booking.status = 'on-hold' and p_booking.operation_kind is null
      and p_booking.active_operation_id is null and p_booking.payment_state = 'unpaid'
      and not public.jsonb_is_nonempty_array(p_booking.airlines_pnr)
      and not public.jsonb_is_nonempty_array(p_booking.ticket_numbers)
      and nullif(p_booking.ticket_code_ref, '') is null and p_booking.issued_at is null
      and coalesce(p_booking.captured_amount, 0) = 0
      and (p_booking.ticketing_deadline_at > now() or (p_booking.ticketing_deadline_at is null
        and p_booking.active_local_time_limit_request_id is null
        and p_booking.active_superadmin_deadline_override_id is null))
    then jsonb_build_object('effectiveStatus','on-hold','reviewRequired',false)
    else '{}'::jsonb end
  from public.shapon_booking_current_status_observations observation
  cross join lateral (select public.project_shapon_booking_current_status_v1(
    p_booking, observation.current_status, observation.original_booking_status, observation.received_at
  ) as metadata offset 0) projected
  where observation.booking_id = p_booking.id
    and public.shapon_status_observation_identity_matches_v1(p_booking, observation.receipt_identity)
    and (p_booking.status <> 'cancelled'
      or p_booking.cancel_reason is distinct from 'Booking closed on the Shapon platform'
      or observation.current_status->>'status' = 'cancelled')
  order by observation.request_started_at desc,
    coalesce(observation.receipt_identity->'issueResponse' = 'true'::jsonb, false) desc,
    observation.received_at desc, observation.id desc
  limit 1
$$;

-- Use the same locked projection as the existing Issue veto. Only an explicit
-- Shapon permission and an eligible saved reservation can replace the generic
-- airline-locator prerequisite. Authorization and wallet reservation stay below.
do $migration$
declare
  v_definition text := pg_get_functiondef('public.wallet_begin_booking_issue(uuid,text,text,text)'::regprocedure);
  v_declare text := '  v_saved_reference_flow boolean;';
  v_veto text := $old$  if v_booking.supplier = 'shapontravels' and v_booking.status = 'on-hold'
    and v_booking.operation_kind is null and v_booking.payment_state <> 'captured' and exists (
    select 1 from (select public.shapon_booking_current_status_v1(v_booking) as metadata offset 0) projection
    where projection.metadata is not null and
      (projection.metadata->>'effectiveStatus' <> 'on-hold'
       or coalesce((projection.metadata->>'reviewRequired')::boolean,true))
  ) then
    return jsonb_build_object('ok',false,'code','SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  end if;$old$;
  v_locator text := '  if not public.jsonb_is_nonempty_array(v_booking.airlines_pnr) then';
begin
  if position('-- shapon-explicit-held-issue-permission-v1' in v_definition) > 0 then return; end if;
  if (length(v_definition)-length(replace(v_definition,v_declare,'')))/length(v_declare) <> 1
      or (length(v_definition)-length(replace(v_definition,v_veto,'')))/length(v_veto) <> 1
      or (length(v_definition)-length(replace(v_definition,v_locator,'')))/length(v_locator) <> 1 then
    raise exception 'unexpected Shapon held Issue claim source';
  end if;
  v_definition := replace(v_definition, v_declare, v_declare || E'\n  v_shapon_status jsonb;');
  v_definition := replace(v_definition, v_veto, $guard$  -- shapon-explicit-held-issue-permission-v1
  if v_booking.supplier = 'shapontravels' and v_booking.status = 'on-hold'
      and v_booking.operation_kind is null and v_booking.payment_state <> 'captured' then
    v_shapon_status := public.shapon_booking_current_status_v1(v_booking);
    if v_shapon_status is not null and (
        v_shapon_status->>'effectiveStatus' <> 'on-hold'
        or coalesce((v_shapon_status->>'reviewRequired')::boolean,true)
        or v_shapon_status#>'{currentStatus,canIssue}' = 'false'::jsonb) then
      return jsonb_build_object('ok',false,'code','SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
    end if;
  end if;$guard$);
  v_definition := replace(v_definition, v_locator, $guard$  if not public.jsonb_is_nonempty_array(v_booking.airlines_pnr)
      and not coalesce(v_shapon_status#>'{currentStatus,canIssue}' = 'true'::jsonb
        and v_shapon_status->>'effectiveStatus' = 'on-hold'
        and v_shapon_status->'reviewRequired' = 'false'::jsonb, false) then$guard$);
  execute v_definition;
end;
$migration$;

-- The dashboard filters and sorts the same displayed status. The lifecycle
-- view used by ticket/payment commands retains its guarded local projection.
do $migration$
declare
  v_definition text := pg_get_viewdef('public.booking_dashboard_creator_v'::regclass, true);
  v_status text := 'coalesce(list.shapon_current_status #>> ''{currentStatus,status}'', list.lifecycle_status)';
begin
  if position(v_status in v_definition) > 0 or position('list.shapon_current_status #>>' in v_definition) > 0 then
    return;
  end if;
  if (length(v_definition)-length(replace(v_definition,'list.lifecycle_status','')))/length('list.lifecycle_status') <> 1
      or (length(v_definition)-length(replace(v_definition,'list.status_order','')))/length('list.status_order') <> 1 then
    raise exception 'unexpected booking dashboard status projection';
  end if;
  v_definition := replace(v_definition, 'list.lifecycle_status', v_status || ' as lifecycle_status');
  v_definition := replace(v_definition, 'list.status_order', 'case ' || v_status || $order$
    when 'on-hold' then 0 when 'pending' then 1 when 'in-progress' then 2
    when 'confirmed' then 3 when 'unconfirmed' then 4 when 'expired' then 5
    when 'cancelled' then 6 else 99 end as status_order$order$);
  execute 'create or replace view public.booking_dashboard_creator_v with (security_invoker = true) as ' || v_definition;
end;
$migration$;

commit;
