-- Saved Shapon status is read evidence, separate from the original local Book,
-- local Issue/Admin decisions, financial settlement and notification events.
create table public.shapon_booking_current_status_observations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.flight_bookings(id) on delete restrict,
  request_started_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  receipt_identity jsonb not null check (jsonb_typeof(receipt_identity) = 'object'),
  original_booking_status text not null,
  current_status jsonb not null check (jsonb_typeof(current_status) = 'object')
);
create index shapon_booking_current_status_latest_idx
  on public.shapon_booking_current_status_observations
  (booking_id, request_started_at desc, received_at desc, id desc);
alter table public.shapon_booking_current_status_observations enable row level security;
revoke all on public.shapon_booking_current_status_observations
  from public, anon, authenticated, service_role;
grant select on public.shapon_booking_current_status_observations to service_role;

create function public.shapon_booking_status_identity_matches_v1(
  p_booking public.flight_bookings, p_identity jsonb
)
returns boolean language sql immutable set search_path = public as $$
  select coalesce(
    p_booking.supplier = 'shapontravels'
    and p_booking.supplier_account = 'shapontravels'
    and p_booking.import_source is null and not p_booking.legacy_operational
    and p_booking.direct_ticketing is false
    and p_booking.supplier_public_ref ~ '^STR[A-Z0-9]{6,32}$'
    and length(btrim(p_booking.pnr)) > 2
    and nullif(p_booking.booking_code_ref, '') is not null
    and nullif(p_booking.booking_ref_number, '') is not null
    and nullif(p_booking.supplier_refs->>'uniqueTransId', '') is not null
    and nullif(p_booking.supplier_refs->>'itemCodeRef', '') is not null
    and nullif(p_booking.supplier_refs->>'priceCodeRef', '') is not null
    and p_identity->'uniqueTransId' = to_jsonb(p_booking.supplier_refs->>'uniqueTransId')
    and p_identity->'itemCodeRef' = to_jsonb(p_booking.supplier_refs->>'itemCodeRef')
    and p_identity->'priceCodeRef' = to_jsonb(p_booking.supplier_refs->>'priceCodeRef')
    and p_identity->'bookingCodeRef' = to_jsonb(p_booking.booking_code_ref)
    and p_identity->'bookingRefNumber' = to_jsonb(p_booking.booking_ref_number)
    and p_identity->'pnr' = to_jsonb(p_booking.pnr)
    and p_identity->'supplierPublicRef' = to_jsonb(p_booking.supplier_public_ref),
    false
  );
$$;

create function public.project_shapon_booking_current_status_v1(
  p_booking public.flight_bookings, p_current_status jsonb,
  p_original_booking_status text, p_fetched_at timestamptz
)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  v_local text := public.resolve_booking_lifecycle(
    p_booking.status, p_booking.airlines_pnr,
    p_booking.ticketing_deadline_at, p_booking.operation_kind);
  v_remote text := p_current_status->>'status';
  v_effective text := v_local;
  v_review boolean := coalesce((p_current_status->>'reviewRequired')::boolean, true);
  v_local_ticket boolean := public.jsonb_is_nonempty_array(p_booking.ticket_numbers)
    or nullif(p_booking.ticket_code_ref, '') is not null
    or p_booking.issued_at is not null or coalesce(p_booking.captured_amount, 0) > 0;
begin
  if p_current_status is null then return null; end if;
  if p_booking.status in ('confirmed', 'cancelled') then
    v_effective := p_booking.status;
  elsif p_booking.status = 'in-progress' or p_booking.operation_kind is not null
      or p_booking.active_operation_id is not null
      or p_booking.payment_state = 'reconciliation' then
    v_effective := 'in-progress';
  elsif p_booking.status = 'on-hold' and not v_local_ticket then
    -- A remote ticket claim cannot manufacture local tickets or settlement.
    -- A saved supplier hold cannot reopen a locally expired/missing-PNR hold.
    if v_remote not in ('confirmed', 'on-hold') then v_effective := v_remote; end if;
  end if;
  v_review := v_review or v_remote = 'confirmed' and p_booking.status <> 'confirmed'
    or v_effective <> v_remote or v_effective <> p_booking.status
    or v_local_ticket and p_booking.status not in ('confirmed', 'cancelled')
    or v_remote = 'on-hold' and p_current_status->>'bookingState' is distinct from 'held';
  return jsonb_build_object(
    'currentStatus', p_current_status,
    'originalBookingStatus', p_original_booking_status,
    'fetchedAt', p_fetched_at,
    'effectiveStatus', v_effective,
    'reviewRequired', v_review
  );
end;
$$;

create function public.shapon_booking_current_status_v1(p_booking public.flight_bookings)
returns jsonb language sql stable set search_path = public as $$
  select public.project_shapon_booking_current_status_v1(
    p_booking, observation.current_status,
    observation.original_booking_status, observation.received_at)
  from public.shapon_booking_current_status_observations observation
  where observation.booking_id = p_booking.id
    and public.shapon_booking_status_identity_matches_v1(p_booking, observation.receipt_identity)
  order by observation.request_started_at desc, observation.received_at desc, observation.id desc
  limit 1
$$;

create function public.record_shapon_booking_current_status_v1(
  p_booking_id uuid, p_request_started_at timestamptz,
  p_supplier_public_ref text, p_receipt_identity jsonb, p_current_status jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_booking public.flight_bookings;
  v_now timestamptz := clock_timestamp();
  v_identity jsonb;
  v_current jsonb;
  v_last_check jsonb;
  v_key text;
  v_value jsonb;
  v_instant timestamptz;
  v_id uuid;
  v_latest uuid;
  v_projection jsonb;
begin
  -- Serializes with the existing ticket claim, which locks this same row.
  select * into v_booking from public.flight_bookings where id = p_booking_id for update;
  if not found then
    return jsonb_build_object('recorded',false,'projectionUpdated',false,'code','BOOKING_NOT_FOUND');
  end if;
  if p_request_started_at is null or not isfinite(p_request_started_at)
      or p_request_started_at > v_now + interval '5 minutes'
      or p_request_started_at < v_booking.created_at
      or jsonb_typeof(p_receipt_identity) is distinct from 'object'
      or pg_column_size(p_receipt_identity) > 5000
      or p_supplier_public_ref is distinct from v_booking.supplier_public_ref
      or not public.shapon_booking_status_identity_matches_v1(v_booking, p_receipt_identity)
      or jsonb_typeof(p_receipt_identity->'originalBookingStatus') is distinct from 'string'
      or length(btrim(p_receipt_identity->>'originalBookingStatus')) not between 1 and 100 then
    return jsonb_build_object('recorded',false,'projectionUpdated',false,'code','SUPPLIER_IDENTITY_UNVERIFIED');
  end if;
  if jsonb_typeof(p_current_status) is distinct from 'object'
      or pg_column_size(p_current_status) > 16000
      or not p_current_status ?& array['bookingState','supplierStatus','checkedAt','supplierCheckedAt']
      or coalesce(p_current_status->>'status', '') not in
        ('on-hold','pending','in-progress','confirmed','expired','unconfirmed','cancelled')
      or coalesce(p_current_status->>'source', '') not in
        ('supplier_pnr','ticket_operation','cancellation_operation','admin_decision','staff_manual','saved_booking','saved_import')
      or jsonb_typeof(p_current_status->'verified') is distinct from 'boolean'
      or coalesce(jsonb_typeof(p_current_status->'reviewRequired'),'null') not in ('boolean','null')
      or coalesce(jsonb_typeof(p_current_status->'bookingState'),'null') not in ('string','null')
      or length(coalesce(p_current_status->>'bookingState','')) > 100
      or (p_current_status->>'bookingState' is not null and
        (btrim(p_current_status->>'bookingState') = '' or p_current_status->>'bookingState' ~ '[[:cntrl:]]'))
      or coalesce(jsonb_typeof(p_current_status->'supplierStatus'),'null') not in ('string','null')
      or length(coalesce(p_current_status->>'supplierStatus','')) > 100
      or (p_current_status->>'supplierStatus' is not null and
        (btrim(p_current_status->>'supplierStatus') = '' or p_current_status->>'supplierStatus' ~ '[[:cntrl:]]'))
      or (p_current_status->>'supplierStatus' is not null and p_current_status->>'supplierCheckedAt' is null)
      or (p_current_status->>'source' = 'supplier_pnr'
          and (p_current_status->>'verified' <> 'true' or p_current_status->>'supplierCheckedAt' is null)) then
    return jsonb_build_object('recorded',false,'projectionUpdated',false,'code','INVALID_CURRENT_STATUS');
  end if;
  v_last_check := p_current_status->'lastCheck';
  if v_last_check is not null and v_last_check <> 'null'::jsonb then
    if jsonb_typeof(v_last_check) is distinct from 'object'
        or jsonb_typeof(v_last_check->'verified') is distinct from 'boolean'
        or jsonb_typeof(v_last_check->'checkedAt') is distinct from 'string'
        or coalesce(jsonb_typeof(v_last_check->'reasonCode'),'null') not in ('string','null')
        or (v_last_check->>'reasonCode' is not null
          and v_last_check->>'reasonCode' !~ '^[A-Z][A-Z0-9_]{0,79}$') then
      return jsonb_build_object('recorded',false,'projectionUpdated',false,'code','INVALID_CURRENT_STATUS');
    end if;
  end if;
  foreach v_key in array array['checkedAt','supplierCheckedAt','lastCheck.checkedAt'] loop
    v_value := case when v_key = 'lastCheck.checkedAt' then v_last_check->'checkedAt'
      else p_current_status->v_key end;
    if v_value is not null and v_value <> 'null'::jsonb then
      if jsonb_typeof(v_value) <> 'string'
          or length(v_value#>>'{}') > 64
          or (v_value#>>'{}') !~ '^\d{4}-\d{2}-\d{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.\d{1,9})?(Z|[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])$' then
        return jsonb_build_object('recorded',false,'projectionUpdated',false,'code','INVALID_CURRENT_STATUS');
      end if;
      begin v_instant := (v_value#>>'{}')::timestamptz;
      exception when others then
        return jsonb_build_object('recorded',false,'projectionUpdated',false,'code','INVALID_CURRENT_STATUS');
      end;
      if not isfinite(v_instant) or v_instant > v_now + interval '5 minutes' then
        return jsonb_build_object('recorded',false,'projectionUpdated',false,'code','INVALID_CURRENT_STATUS');
      end if;
    end if;
  end loop;
  v_identity := jsonb_build_object(
    'uniqueTransId',p_receipt_identity->'uniqueTransId','itemCodeRef',p_receipt_identity->'itemCodeRef',
    'priceCodeRef',p_receipt_identity->'priceCodeRef','bookingCodeRef',p_receipt_identity->'bookingCodeRef',
    'bookingRefNumber',p_receipt_identity->'bookingRefNumber','pnr',p_receipt_identity->'pnr',
    'supplierPublicRef',p_receipt_identity->'supplierPublicRef');
  v_current := jsonb_build_object(
    'status',p_current_status->'status','bookingState',p_current_status->'bookingState',
    'supplierStatus',p_current_status->'supplierStatus','supplierCheckedAt',p_current_status->'supplierCheckedAt',
    'verified',p_current_status->'verified','source',p_current_status->'source',
    'checkedAt',p_current_status->'checkedAt','reviewRequired',p_current_status->'reviewRequired',
    'lastCheck',case when v_last_check is not null and v_last_check <> 'null'::jsonb then
      jsonb_build_object('checkedAt',v_last_check->'checkedAt','verified',v_last_check->'verified',
        'reasonCode',v_last_check->'reasonCode') else null end);
  insert into public.shapon_booking_current_status_observations
    (booking_id,request_started_at,receipt_identity,original_booking_status,current_status)
  values (v_booking.id,p_request_started_at,v_identity,
    p_receipt_identity->>'originalBookingStatus',v_current) returning id into v_id;
  select observation.id into v_latest
  from public.shapon_booking_current_status_observations observation
  where observation.booking_id = v_booking.id
    and public.shapon_booking_status_identity_matches_v1(v_booking, observation.receipt_identity)
  order by observation.request_started_at desc, observation.received_at desc, observation.id desc limit 1;
  v_projection := public.shapon_booking_current_status_v1(v_booking);
  return jsonb_build_object('recorded',true,'projectionUpdated',v_id = v_latest,
    'effectiveStatus',v_projection->>'effectiveStatus','currentStatus',v_projection);
end;
$$;

revoke all on function public.shapon_booking_status_identity_matches_v1(public.flight_bookings,jsonb),
  public.project_shapon_booking_current_status_v1(public.flight_bookings,jsonb,text,timestamptz),
  public.shapon_booking_current_status_v1(public.flight_bookings),
  public.record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb)
  from public, anon, authenticated;
grant execute on function public.shapon_booking_status_identity_matches_v1(public.flight_bookings,jsonb),
  public.project_shapon_booking_current_status_v1(public.flight_bookings,jsonb,text,timestamptz),
  public.shapon_booking_current_status_v1(public.flight_bookings),
  public.record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb) to service_role;

-- Replace the one status expression in place; preserve every previous output
-- name, type and ordinal, including the later visibility/account columns.
do $$
declare v_columns text;
begin
  select string_agg(case when attname = 'lifecycle_status' then
      'coalesce(projected.metadata->>''effectiveStatus'',public.resolve_booking_lifecycle(fb.status,fb.airlines_pnr,fb.ticketing_deadline_at,fb.operation_kind)) as lifecycle_status'
    else format('fb.%I',attname) end, ', ' order by attnum) into v_columns
  from pg_attribute where attrelid = 'public.booking_lifecycle_v'::regclass
    and attnum > 0 and not attisdropped;
  execute format('create or replace view public.booking_lifecycle_v with (security_invoker = true) as
    select %s, projected.metadata as shapon_current_status from public.flight_bookings fb
    left join lateral (select public.shapon_booking_current_status_v1(fb) as metadata offset 0) projected on true
    where not fb.legacy_operational',v_columns);
end;
$$;

-- The three existing read views already consume lifecycle_status. Append the
-- metadata at each exact FROM anchor, retaining their expanded column order.
do $$
declare v_view text; v_source text; v_alias text; v_definition text; v_pattern text; v_matches integer;
begin
  for v_view,v_source,v_alias in values
    ('booking_dashboard_list_v','booking_lifecycle_v','booking'),
    ('booking_dashboard_list_ordered_v','booking_dashboard_list_v','booking'),
    ('booking_dashboard_creator_v','booking_dashboard_list_ordered_v','list') loop
    v_definition := pg_get_viewdef(format('public.%I',v_view)::regclass,true);
    if v_view = 'booking_dashboard_list_v' then
      -- Status-based date sorting uses the evidence instant for an effective
      -- remote outcome; local ticket/operation/deadline dates retain priority.
      v_pattern := '(CASE[[:space:]]+)(WHEN booking\.lifecycle_status = ''in-progress''::text)';
      select count(*) into v_matches from regexp_matches(v_definition,v_pattern,'g');
      if v_matches <> 1 then raise exception 'unexpected dashboard lifecycle date projection'; end if;
      v_definition := regexp_replace(v_definition,v_pattern,$date$
CASE WHEN booking.shapon_current_status is not null
  and booking.status = 'on-hold' and booking.operation_kind is null
  and booking.payment_state <> 'reconciliation'
  and booking.shapon_current_status#>>'{currentStatus,status}' not in ('confirmed','on-hold')
  and booking.lifecycle_status = booking.shapon_current_status#>>'{currentStatus,status}'
  then (booking.shapon_current_status#>>'{currentStatus,checkedAt}')::timestamptz
  \2$date$);
    end if;
    v_pattern := format('([[:space:]]FROM[[:space:]]+(public\.)?%s[[:space:]]+%s([[:space:];]))',v_source,v_alias);
    select count(*) into v_matches from regexp_matches(v_definition,v_pattern,'g');
    if v_matches <> 1 then raise exception 'unexpected % source projection',v_view; end if;
    v_definition := regexp_replace(v_definition,v_pattern,format(', %s.shapon_current_status\1',v_alias));
    execute format('create or replace view public.%I with (security_invoker = true) as %s',v_view,v_definition);
  end loop;
end;
$$;

-- Preserve the installed claim exactly, adding a veto only after its existing
-- FOR UPDATE and before any reservation. The record RPC takes the same lock.
do $$
declare v_definition text; v_anchor text := '  if v_booking.status = ''confirmed'' or v_booking.payment_state = ''captured'' then';
begin
  v_definition := pg_get_functiondef('public.wallet_begin_booking_issue(uuid,text,text,text)'::regprocedure);
  if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor) <> 1 then
    raise exception 'unexpected wallet_begin_booking_issue source';
  end if;
  v_definition := replace(v_definition,v_anchor,$guard$
  if v_booking.supplier = 'shapontravels' and v_booking.status = 'on-hold'
    and v_booking.operation_kind is null and v_booking.payment_state <> 'captured' and exists (
    select 1 from (select public.shapon_booking_current_status_v1(v_booking) as metadata offset 0) projection
    where projection.metadata is not null and
      (projection.metadata->>'effectiveStatus' <> 'on-hold'
       or coalesce((projection.metadata->>'reviewRequired')::boolean,true))
  ) then
    return jsonb_build_object('ok',false,'code','SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  end if;
$guard$ || v_anchor);
  execute v_definition;
end;
$$;

comment on table public.shapon_booking_current_status_observations is
  'RPC-only append-only saved API status reads; no Book/Issue/Cancel, local booking, wallet or notification mutation.';
