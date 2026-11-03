-- API status Refresh reads Shapon's saved status; it does not request a new
-- airline/supplier synchronization. Preserve the source and its original saved
-- supplierCheckedAt in receipt-bound observations. GET receipt time stays only
-- fetchedAt; no booking, payment, operation or notification row is changed.
begin;

do $migration$
declare
  v_signature text;
  v_definition text;
  v_old text;
  v_new text;
  v_marker text := '-- shapon-saved-supplier-sync-v1 compatibility';
  v_owner oid;
  v_acl aclitem[];
  v_after_owner oid;
  v_after_acl aclitem[];
  v_old_shape text := $shape$
CASE WHEN jsonb_typeof(p_current_status) = 'object' THEN coalesce(
  p_current_status ?& array['status','reviewRequired','source','verified',
    'bookingState','supplierStatus','supplierCheckedAt','checkedAt','lastCheck']
  and p_current_status - array['status','reviewRequired','source','verified',
    'bookingState','supplierStatus','supplierCheckedAt','checkedAt','lastCheck'] = '{}'::jsonb
  and p_current_status->>'source' = 'airline_refresh'
  and p_current_status->>'status' in
    ('on-hold','pending','in-progress','confirmed','expired','unconfirmed','cancelled')
  and jsonb_typeof(p_current_status->'reviewRequired') = 'boolean'
  and p_current_status->'verified' = 'true'::jsonb
  and p_current_status->'bookingState' = 'null'::jsonb
  and p_current_status->'checkedAt' = 'null'::jsonb
  and p_current_status->'lastCheck' = 'null'::jsonb
  and (p_current_status->'supplierStatus' = 'null'::jsonb
    or (jsonb_typeof(p_current_status->'supplierStatus') = 'string'
      and length(btrim(p_current_status->>'supplierStatus')) between 1 and 100
      and p_current_status->>'supplierStatus' !~ '[[:cntrl:]]'))
  and jsonb_typeof(p_current_status->'supplierCheckedAt') = 'string'
  and length(p_current_status->>'supplierCheckedAt') <= 64
  and p_current_status->>'supplierCheckedAt' ~
    '^\d{4}-\d{2}-\d{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.\d{1,9})?(Z|[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])$',
  false) ELSE false END
$shape$;
  v_new_shape text := $shape$
CASE WHEN jsonb_typeof(p_current_status) = 'object' THEN coalesce(
  p_current_status ?& array['status','reviewRequired','source','verified',
    'bookingState','supplierStatus','supplierCheckedAt','checkedAt','lastCheck']
  and p_current_status - array['status','reviewRequired','source','verified',
    'bookingState','supplierStatus','supplierCheckedAt','checkedAt','lastCheck'] = '{}'::jsonb
  and p_current_status->>'source' in ('airline_refresh','supplier_sync')
  and p_current_status->>'status' in
    ('on-hold','pending','in-progress','confirmed','expired','unconfirmed','cancelled')
  and jsonb_typeof(p_current_status->'reviewRequired') = 'boolean'
  and (p_current_status->'verified' = 'true'::jsonb
    or (p_current_status->>'source' = 'supplier_sync'
      and p_current_status->'verified' = 'false'::jsonb))
  and p_current_status->'bookingState' = 'null'::jsonb
  and p_current_status->'checkedAt' = 'null'::jsonb
  and p_current_status->'lastCheck' = 'null'::jsonb
  and (p_current_status->'supplierStatus' = 'null'::jsonb
    or (jsonb_typeof(p_current_status->'supplierStatus') = 'string'
      and length(btrim(p_current_status->>'supplierStatus')) between 1 and 100
      and p_current_status->>'supplierStatus' !~ '[[:cntrl:]]'))
  and ((p_current_status->>'source' = 'supplier_sync'
      and p_current_status->'verified' = 'false'::jsonb
      and p_current_status->'supplierStatus' = 'null'::jsonb
      and p_current_status->'supplierCheckedAt' = 'null'::jsonb)
    or (jsonb_typeof(p_current_status->'supplierCheckedAt') = 'string'
      and length(p_current_status->>'supplierCheckedAt') <= 64
      and p_current_status->>'supplierCheckedAt' ~
        '^\d{4}-\d{2}-\d{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.\d{1,9})?(Z|[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])$')),
  false) ELSE false END
$shape$;
begin
  foreach v_signature in array array[
    'public.record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb)',
    'public.project_shapon_booking_current_status_v1(public.flight_bookings,jsonb,text,timestamptz)'
  ] loop
    select proowner,proacl into v_owner,v_acl from pg_proc where oid = to_regprocedure(v_signature);
    v_definition := pg_get_functiondef(to_regprocedure(v_signature));
    if v_definition is null then raise exception 'required Shapon current-status function missing: %',v_signature; end if;
    if position(v_marker in v_definition) = 0 then
      -- Keep the exact normalized public shape and private evidence all null.
      -- Unlike verified airline_refresh, a saved unverified supplier_sync may
      -- truthfully have no supplier observation at all; do not invent one.
      if (length(v_definition)-length(replace(v_definition,v_old_shape,'')))/length(v_old_shape) <> 1 then
        raise exception 'unexpected Shapon public saved-status shape: %',v_signature;
      end if;
      v_definition := replace(v_definition,v_old_shape,v_new_shape);
      v_old := '  if v_airline_public then';
      v_new := v_marker || E'\n  if v_airline_public and p_current_status->''supplierCheckedAt'' <> ''null''::jsonb then';
      if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
        raise exception 'unexpected Shapon public saved-status instant guard: %',v_signature;
      end if;
      v_definition := replace(v_definition,v_old,v_new);
      if v_signature like 'public.record_%' then
        v_old := '''staff_manual'',''saved_booking'',''saved_import'',''public_receipt'',''airline_refresh'')';
        v_new := '''staff_manual'',''saved_booking'',''saved_import'',''public_receipt'',''airline_refresh'',''supplier_sync'')';
        if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
          raise exception 'unexpected Shapon current-status source allowlist';
        end if;
        v_definition := replace(v_definition,v_old,v_new);
        v_old := '  if p_current_status->>''source'' = ''airline_refresh'' and not v_airline_public then';
        v_new := '  if p_current_status->>''source'' in (''airline_refresh'',''supplier_sync'') and not v_airline_public then';
        if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
          raise exception 'unexpected Shapon public saved-status recorder guard';
        end if;
        v_definition := replace(v_definition,v_old,v_new);
      end if;
      execute v_definition;
    else
      if (length(v_definition)-length(replace(v_definition,v_marker,'')))/length(v_marker) <> 1
          or (length(v_definition)-length(replace(v_definition,v_new_shape,'')))/length(v_new_shape) <> 1
          or position('if v_airline_public and p_current_status->''supplierCheckedAt'' <> ''null''::jsonb then' in v_definition) = 0
          or (v_signature like 'public.record_%' and position(
            'if p_current_status->>''source'' in (''airline_refresh'',''supplier_sync'') and not v_airline_public then'
            in v_definition) = 0) then
        raise exception 'unexpected previously patched Shapon saved-status function: %',v_signature;
      end if;
    end if;
    select proowner,proacl into v_after_owner,v_after_acl from pg_proc where oid = to_regprocedure(v_signature);
    if v_owner is distinct from v_after_owner or v_acl is distinct from v_after_acl then
      raise exception 'Shapon saved-status function owner or grants changed: %',v_signature;
    end if;
  end loop;
end;
$migration$;

-- Preserve the shared dashboard view and all output columns/privileges. A saved
-- terminal observation may sort by its original supplierCheckedAt, never by
-- GET time or this migration's clock, under the same exact public-shape guard.
do $migration$
declare
  v_definition text;
  v_old text := '= ''airline_refresh''::text';
  v_new text := '= ANY (ARRAY[''airline_refresh''::text, ''supplier_sync''::text])';
  v_options text;
  v_owner oid;
  v_acl aclitem[];
  v_after_owner oid;
  v_after_acl aclitem[];
  v_columns text[];
  v_after_columns text[];
begin
  select relowner,relacl,array_to_string(reloptions,',') into v_owner,v_acl,v_options
    from pg_class where oid = to_regclass('public.booking_dashboard_list_v');
  if not found then raise exception 'required booking dashboard list view missing'; end if;
  select array_agg(attnum::text || ':' || attname || ':' || atttypid::text || ':' || atttypmod::text order by attnum)
    into v_columns from pg_attribute where attrelid = 'public.booking_dashboard_list_v'::regclass and attnum > 0 and not attisdropped;
  v_definition := pg_get_viewdef('public.booking_dashboard_list_v'::regclass,true);
  if position('''supplier_sync''::text' in v_definition) = 0 then
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1
        or position('{currentStatus,source}' in v_definition) = 0
        or position('{currentStatus,supplierCheckedAt}' in v_definition) = 0
        or position('{currentStatus,verified}' in v_definition) = 0 then
      raise exception 'unexpected booking dashboard saved source-date expression';
    end if;
    v_definition := replace(v_definition,v_old,v_new);
    execute 'create or replace view public.booking_dashboard_list_v '
      || case when v_options is not null then 'with (' || v_options || ') ' else '' end
      || 'as ' || v_definition;
  elsif (length(v_definition)-length(replace(v_definition,v_new,'')))/length(v_new) <> 1
      or position('{currentStatus,checkedAt}' in v_definition) = 0
      or position('{currentStatus,supplierCheckedAt}' in v_definition) = 0
      or position('{currentStatus,verified}' in v_definition) = 0 then
    raise exception 'unexpected previously patched booking dashboard saved source date';
  end if;
  select relowner,relacl into v_after_owner,v_after_acl from pg_class where oid = 'public.booking_dashboard_list_v'::regclass;
  select array_agg(attnum::text || ':' || attname || ':' || atttypid::text || ':' || atttypmod::text order by attnum)
    into v_after_columns from pg_attribute where attrelid = 'public.booking_dashboard_list_v'::regclass and attnum > 0 and not attisdropped;
  if v_owner is distinct from v_after_owner or v_acl is distinct from v_after_acl or v_columns is distinct from v_after_columns then
    raise exception 'booking dashboard saved source-date patch changed owner, grants or columns';
  end if;
end;
$migration$;

commit;
