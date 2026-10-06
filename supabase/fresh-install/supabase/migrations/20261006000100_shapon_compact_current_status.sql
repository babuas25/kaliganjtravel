-- Rust's public receipt deliberately publishes only status and reviewRequired.
-- The application labels that compact projection explicitly, retaining false
-- verification and null private evidence. Permit only that exact conservative
-- shape through the existing identity-bound observation RPC. A clear public
-- On Hold does not require private bookingState; all rich evidence and local
-- financial/terminal precedence rules remain authoritative.
create function public.shapon_public_current_status_is_compact_v1(p_status jsonb)
returns boolean language sql immutable set search_path = public as $$
  select case when jsonb_typeof(p_status) = 'object' then coalesce(
    p_status ?& array['status','reviewRequired','source','verified','bookingState',
      'supplierStatus','checkedAt','supplierCheckedAt','lastCheck']
    and p_status - array['status','reviewRequired','source','verified','bookingState',
      'supplierStatus','checkedAt','supplierCheckedAt','lastCheck'] = '{}'::jsonb
    and p_status->>'source' = 'public_receipt'
    and p_status->>'status' in
      ('on-hold','pending','in-progress','confirmed','expired','unconfirmed','cancelled')
    and jsonb_typeof(p_status->'reviewRequired') = 'boolean'
    and p_status->'verified' = 'false'::jsonb
    and p_status->'bookingState' = 'null'::jsonb
    and p_status->'supplierStatus' = 'null'::jsonb
    and p_status->'checkedAt' = 'null'::jsonb
    and p_status->'supplierCheckedAt' = 'null'::jsonb
    and p_status->'lastCheck' = 'null'::jsonb,
    false
  ) else false end;
$$;
revoke all on function public.shapon_public_current_status_is_compact_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.shapon_public_current_status_is_compact_v1(jsonb)
  to service_role;

-- Preserve the installed recorder and its identity, timestamp, size and grant
-- checks. Allow the new provenance only after validating its exact shape.
do $$
declare
  v_definition text;
  v_sources text := '''staff_manual'',''saved_booking'',''saved_import'')';
  v_validation text := '  if jsonb_typeof(p_current_status) is distinct from ''object''';
begin
  v_definition := pg_get_functiondef(
    'public.record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb)'::regprocedure);
  if (length(v_definition)-length(replace(v_definition,v_sources,'')))/length(v_sources) <> 1
      or (length(v_definition)-length(replace(v_definition,v_validation,'')))/length(v_validation) <> 1 then
    raise exception 'unexpected record_shapon_booking_current_status_v1 source';
  end if;
  v_definition := replace(v_definition,v_sources,
    '''staff_manual'',''saved_booking'',''saved_import'',''public_receipt'')');
  v_definition := replace(v_definition,v_validation,$guard$
  if p_current_status->>'source' = 'public_receipt'
      and not public.shapon_public_current_status_is_compact_v1(p_current_status) then
    return jsonb_build_object('recorded',false,'projectionUpdated',false,'code','INVALID_CURRENT_STATUS');
  end if;
$guard$ || v_validation);
  execute v_definition;
end;
$$;

-- Exempt only the validated public On Hold with an explicit false review flag.
-- Rich metadata without held bookingState retains its previous fail-closed rule.
do $$
declare
  v_definition text;
  v_anchor text := 'or v_remote = ''on-hold'' and p_current_status->>''bookingState'' is distinct from ''held'';';
begin
  v_definition := pg_get_functiondef(
    'public.project_shapon_booking_current_status_v1(public.flight_bookings,jsonb,text,timestamptz)'::regprocedure);
  if (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor) <> 1 then
    raise exception 'unexpected project_shapon_booking_current_status_v1 source';
  end if;
  v_definition := replace(v_definition,v_anchor,$guard$
or v_remote = 'on-hold' and p_current_status->>'bookingState' is distinct from 'held'
    and not (public.shapon_public_current_status_is_compact_v1(p_current_status)
      and p_current_status->'reviewRequired' = 'false'::jsonb);
$guard$);
  execute v_definition;
end;
$$;
