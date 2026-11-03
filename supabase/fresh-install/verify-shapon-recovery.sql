-- Read-only current catalog/permission verification. No business RPC, allocator,
-- wallet command or supplier request; no customer/passenger row is returned.
select jsonb_build_object(
  'table_count',(select count(*) from pg_tables where schemaname='public'),
  'public_function_count',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f'),
  'tables_without_rls',(select coalesce(jsonb_agg(tablename),'[]'::jsonb)
    from pg_tables where schemaname='public' and not rowsecurity),
  'migration_versions',(select jsonb_agg(version order by version) from supabase_migrations.schema_migrations),
  'saved_sync_recorder',position('-- shapon-saved-supplier-sync-v1 compatibility' in pg_get_functiondef(
    'public.record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb)'::regprocedure))>0,
  'saved_sync_projection',position('-- shapon-saved-supplier-sync-v1 compatibility' in pg_get_functiondef(
    'public.project_shapon_booking_current_status_v1(public.flight_bookings,jsonb,text,timestamptz)'::regprocedure))>0,
  'original_status_nullable',exists(select 1 from information_schema.columns
    where table_schema='public' and table_name='shapon_booking_current_status_observations'
      and column_name='original_booking_status' and is_nullable='YES'),
  'saved_source_date',position('supplier_sync' in pg_get_viewdef('public.booking_dashboard_list_v'::regclass,true))>0
    and position('{currentStatus,supplierCheckedAt}' in pg_get_viewdef('public.booking_dashboard_list_v'::regclass,true))>0,
  'mandatory_payment',position('PAYMENT_REQUIRED' in pg_get_functiondef(
    'public.confirm_shapon_external_ticket_v1(uuid,text,text,uuid,boolean,jsonb,jsonb,timestamptz)'::regprocedure))>0
    and position('PAYMENT_PREVIEW_REQUIRED' in pg_get_functiondef(
      'public.confirm_shapon_external_ticket_v1(uuid,text,text,uuid,boolean,jsonb,jsonb,timestamptz)'::regprocedure))>0,
  'return_decisions_immutable',exists(select 1 from pg_trigger
    where tgrelid='public.booking_payment_returns'::regclass and tgname='booking_payment_returns_immutable'
      and tgenabled='O' and not tgisinternal),
  'return_table_private',has_table_privilege('service_role','public.booking_payment_returns','SELECT')
    and not has_table_privilege('service_role','public.booking_payment_returns','INSERT,UPDATE,DELETE')
    and not has_table_privilege('anon','public.booking_payment_returns','SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('authenticated','public.booking_payment_returns','SELECT,INSERT,UPDATE,DELETE'),
  'return_accounting_private',not has_function_privilege('service_role','public.booking_payment_return_accounting_v1(uuid)','EXECUTE')
    and not has_function_privilege('anon','public.booking_payment_return_accounting_v1(uuid)','EXECUTE')
    and not has_function_privilege('authenticated','public.booking_payment_return_accounting_v1(uuid)','EXECUTE'),
  'service_rpc_only',(select bool_and(has_function_privilege('service_role',signature,'EXECUTE')
      and not has_function_privilege('anon',signature,'EXECUTE')
      and not has_function_privilege('authenticated',signature,'EXECUTE')) from unnest(array[
    'public.resolve_shapon_cancelled_refresh_v1(uuid,text,text,uuid,jsonb,jsonb,timestamptz)',
    'public.preview_shapon_ticket_payment_v1(uuid,text,text)',
    'public.preview_booking_payment_return_v1(uuid,text,text)',
    'public.return_booking_payment_v1(uuid,text,text,uuid,uuid,bigint,bigint,bigint,bigint,boolean,text)']) signature),
  'triplover_preserved',to_regprocedure('public.confirm_triplover_issued_hold_v1(uuid,text,text,uuid,text,text,boolean)') is not null
    and exists(select 1 from pg_trigger where tgrelid='public.booking_operations'::regclass
      and tgname='booking_operations_triplover_issued_status_guard' and tgenabled='O' and not tgisinternal),
  'ktt_reference_preserved',position('''KTT''' in pg_get_functiondef('public.allocate_booking_ref_for(date)'::regprocedure))>0
) as verification;
