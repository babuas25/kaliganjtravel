-- Record the saved public airline Refresh observation without inventing private
-- booking/check state. Only receipt-bound metadata and its view projection change.
-- Existing bookings, financial rows, supplier writes and historical SQL stay intact.
begin;

do $migration$
declare
  v_definition text;
  v_old text;
  v_new text;
  v_signature text;
  v_owner oid;
  v_acl aclitem[];
  v_after_owner oid;
  v_after_acl aclitem[];
  v_shape text := $shape$
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
  v_guard text;
begin
  v_signature := 'public.record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb)';
  select proowner,proacl into v_owner,v_acl from pg_proc where oid = to_regprocedure(v_signature);
  v_definition := pg_get_functiondef(to_regprocedure(v_signature));
  if v_definition is null then raise exception 'required Shapon current-status recorder missing'; end if;
  if position('-- shapon-airline-refresh-public-v1 recorder guard' in v_definition) = 0 then
    v_old := '''staff_manual'',''saved_booking'',''saved_import'',''public_receipt'')';
    v_new := '''staff_manual'',''saved_booking'',''saved_import'',''public_receipt'',''airline_refresh'')';
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
      raise exception 'unexpected Shapon current-status source allowlist';
    end if;
    v_definition := replace(v_definition,v_old,v_new);
    v_old := '  v_projection jsonb;';
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
      raise exception 'unexpected Shapon current-status recorder declaration';
    end if;
    v_definition := replace(v_definition,v_old,v_old || E'\n  v_airline_public boolean := false;');
    v_old := '  if jsonb_typeof(p_current_status) is distinct from ''object''';
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
      raise exception 'unexpected Shapon current-status recorder validation';
    end if;
    v_guard := E'  -- shapon-airline-refresh-public-v1 recorder guard\n  v_airline_public := ' || v_shape || $guard$;
  if v_airline_public then
    begin
      v_instant := (p_current_status->>'supplierCheckedAt')::timestamptz;
      v_airline_public := isfinite(v_instant) and v_instant <= v_now + interval '5 minutes';
    exception when others then v_airline_public := false;
    end;
  end if;
  if p_current_status->>'source' = 'airline_refresh' and not v_airline_public then
    return jsonb_build_object('recorded',false,'projectionUpdated',false,'code','INVALID_CURRENT_STATUS');
  end if;
$guard$;
    v_definition := replace(v_definition,v_old,v_guard || v_old);
    execute v_definition;
  else
    v_old := '''staff_manual'',''saved_booking'',''saved_import'',''public_receipt'',''airline_refresh'')';
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1
      or (length(v_definition)-length(replace(v_definition,'-- shapon-airline-refresh-public-v1 recorder guard','')))
        /length('-- shapon-airline-refresh-public-v1 recorder guard') <> 1
      or position('v_airline_public := isfinite(v_instant) and v_instant <= v_now' in v_definition) = 0 then
      raise exception 'unexpected previously patched Shapon current-status recorder';
    end if;
  end if;
  select proowner,proacl into v_after_owner,v_after_acl from pg_proc where oid = to_regprocedure(v_signature);
  if v_owner is distinct from v_after_owner or v_acl is distinct from v_after_acl then
    raise exception 'Shapon current-status recorder owner or grants changed';
  end if;

  v_signature := 'public.project_shapon_booking_current_status_v1(public.flight_bookings,jsonb,text,timestamptz)';
  select proowner,proacl into v_owner,v_acl from pg_proc where oid = to_regprocedure(v_signature);
  v_definition := pg_get_functiondef(to_regprocedure(v_signature));
  if v_definition is null then raise exception 'required Shapon current-status projection missing'; end if;
  if position('-- shapon-airline-refresh-public-v1 projection guard' in v_definition) = 0 then
    v_old := '  v_effective text := v_local;';
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
      raise exception 'unexpected Shapon current-status projection declaration';
    end if;
    v_definition := replace(v_definition,v_old,v_old || E'\n  v_airline_public boolean := false;\n  v_airline_checked_at timestamptz;');
    v_old := '  if p_current_status is null then return null; end if;';
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
      raise exception 'unexpected Shapon current-status projection input guard';
    end if;
    v_guard := E'\n  -- shapon-airline-refresh-public-v1 projection guard\n  v_airline_public := ' || v_shape || $guard$;
  if v_airline_public then
    begin
      v_airline_checked_at := (p_current_status->>'supplierCheckedAt')::timestamptz;
      v_airline_public := isfinite(v_airline_checked_at)
        and v_airline_checked_at <= clock_timestamp() + interval '5 minutes';
    exception when others then v_airline_public := false;
    end;
  end if;
$guard$;
    v_definition := replace(v_definition,v_old,v_old || v_guard);
    v_old := $hold$    and not (public.shapon_public_current_status_is_compact_v1(p_current_status)
      and p_current_status->'reviewRequired' = 'false'::jsonb);$hold$;
    v_new := $hold$    and not ((public.shapon_public_current_status_is_compact_v1(p_current_status)
      or v_airline_public) and p_current_status->'reviewRequired' = 'false'::jsonb);$hold$;
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
      raise exception 'unexpected Shapon current-status held-review predicate';
    end if;
    v_definition := replace(v_definition,v_old,v_new);
    execute v_definition;
  else
    if (length(v_definition)-length(replace(v_definition,'-- shapon-airline-refresh-public-v1 projection guard','')))
      /length('-- shapon-airline-refresh-public-v1 projection guard') <> 1
      or position('or v_airline_public) and p_current_status' in v_definition) = 0 then
      raise exception 'unexpected previously patched Shapon current-status projection';
    end if;
  end if;
  select proowner,proacl into v_after_owner,v_after_acl from pg_proc where oid = to_regprocedure(v_signature);
  if v_owner is distinct from v_after_owner or v_acl is distinct from v_after_acl then
    raise exception 'Shapon current-status projection owner or grants changed';
  end if;
end;
$migration$;

-- A public observation omits private checkedAt. Terminal list dates may use its
-- real saved supplierCheckedAt, never the GET/fetched time or the migration clock.
do $migration$
declare
  v_definition text;
  v_match text[];
  v_matches integer;
  v_old text;
  v_new text;
  v_options text;
  v_owner oid;
  v_acl aclitem[];
  v_after_owner oid;
  v_after_acl aclitem[];
  v_columns text[];
  v_after_columns text[];
  v_pattern text := $pattern$THEN\s+(\(*\s*booking\.shapon_current_status\s*#>>\s*'\{currentStatus,checkedAt\}'(?:\s*::\s*text\[\])?\s*\)*\s*::\s*(?:timestamp with time zone|timestamptz)\s*\)*)\s+(?:WHEN|ELSE)$pattern$;
begin
  select relowner,relacl,array_to_string(reloptions,',') into v_owner,v_acl,v_options
    from pg_class where oid = to_regclass('public.booking_dashboard_list_v');
  if not found then raise exception 'required booking dashboard list view missing'; end if;
  select array_agg(attnum::text || ':' || attname || ':' || atttypid::text || ':' || atttypmod::text order by attnum)
    into v_columns from pg_attribute where attrelid = 'public.booking_dashboard_list_v'::regclass and attnum > 0 and not attisdropped;
  v_definition := pg_get_viewdef('public.booking_dashboard_list_v'::regclass,true);
  if position('{currentStatus,supplierCheckedAt}' in v_definition) = 0 then
    select count(*) into v_matches from regexp_matches(v_definition,v_pattern,'gi');
    if v_matches <> 1 then raise exception 'unexpected booking dashboard remote status-date expression'; end if;
    select regexp_matches(v_definition,v_pattern,'i') into v_match;
    v_old := v_match[1];
    if (length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old) <> 1 then
      raise exception 'unexpected duplicate booking dashboard remote status-date expression';
    end if;
    v_new := $view$coalesce($view$ || v_old || $view$, case when
      jsonb_typeof(booking.shapon_current_status->'currentStatus') = 'object'
      and (booking.shapon_current_status->'currentStatus') ?& array['status','reviewRequired','source','verified',
        'bookingState','supplierStatus','supplierCheckedAt','checkedAt','lastCheck']
      and (booking.shapon_current_status->'currentStatus') - array['status','reviewRequired','source','verified',
        'bookingState','supplierStatus','supplierCheckedAt','checkedAt','lastCheck'] = '{}'::jsonb
      and booking.shapon_current_status#>>'{currentStatus,source}' = 'airline_refresh'
      and booking.shapon_current_status#>>'{currentStatus,status}' in
        ('on-hold','pending','in-progress','confirmed','expired','unconfirmed','cancelled')
      and booking.shapon_current_status#>'{currentStatus,verified}' = 'true'::jsonb
      and booking.shapon_current_status#>'{currentStatus,bookingState}' = 'null'::jsonb
      and booking.shapon_current_status#>'{currentStatus,checkedAt}' = 'null'::jsonb
      and booking.shapon_current_status#>'{currentStatus,lastCheck}' = 'null'::jsonb
      and jsonb_typeof(booking.shapon_current_status#>'{currentStatus,reviewRequired}') = 'boolean'
      and (booking.shapon_current_status#>'{currentStatus,supplierStatus}' = 'null'::jsonb
        or (jsonb_typeof(booking.shapon_current_status#>'{currentStatus,supplierStatus}') = 'string'
          and length(btrim(booking.shapon_current_status#>>'{currentStatus,supplierStatus}')) between 1 and 100
          and booking.shapon_current_status#>>'{currentStatus,supplierStatus}' !~ '[[:cntrl:]]'))
      and jsonb_typeof(booking.shapon_current_status#>'{currentStatus,supplierCheckedAt}') = 'string'
      and length(booking.shapon_current_status#>>'{currentStatus,supplierCheckedAt}') <= 64
      and booking.shapon_current_status#>>'{currentStatus,supplierCheckedAt}' ~
        '^\d{4}-\d{2}-\d{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.\d{1,9})?(Z|[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])$'
      then (booking.shapon_current_status#>>'{currentStatus,supplierCheckedAt}')::timestamptz end)$view$;
    -- A literal replacement preserves the following CASE branch and the
    -- backslashes in the date predicate; regexp replacement would interpret them.
    v_definition := replace(v_definition,v_old,v_new);
    execute 'create or replace view public.booking_dashboard_list_v '
      || case when v_options is not null then 'with (' || v_options || ') ' else '' end
      || 'as ' || v_definition;
  else
    if position('airline_refresh' in v_definition) = 0
      or position('{currentStatus,verified}' in v_definition) = 0
      or position('{currentStatus,checkedAt}' in v_definition) = 0 then
      raise exception 'unexpected previously patched booking dashboard status date';
    end if;
  end if;
  select relowner,relacl into v_after_owner,v_after_acl from pg_class where oid = 'public.booking_dashboard_list_v'::regclass;
  select array_agg(attnum::text || ':' || attname || ':' || atttypid::text || ':' || atttypmod::text order by attnum)
    into v_after_columns from pg_attribute where attrelid = 'public.booking_dashboard_list_v'::regclass and attnum > 0 and not attisdropped;
  if v_owner is distinct from v_after_owner or v_acl is distinct from v_after_acl or v_columns is distinct from v_after_columns then
    raise exception 'booking dashboard status-date patch changed owner, grants or columns';
  end if;
end;
$migration$;

commit;
