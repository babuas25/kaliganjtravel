-- Read-only counts/configuration checks; no customer data is returned.
select jsonb_build_object(
  'table_count', (select count(*) from pg_tables where schemaname = 'public'),
  'tables_without_rls', (select coalesce(jsonb_agg(tablename), '[]'::jsonb)
    from pg_tables where schemaname = 'public' and not rowsecurity),
  'row_counts', (select jsonb_object_agg(tablename,
    ((xpath('/row/n/text()', query_to_xml(
      format('select count(*) as n from public.%I', tablename), false, true, '')))[1]::text)::bigint)
    from pg_tables where schemaname = 'public'),
  'company_name', (select display_name from public.company_settings where id),
  'company_contact', (select jsonb_build_object('license',license_number, 'phone',phone,
    'email',email, 'address',address) from public.company_settings where id),
  'supplier', (select jsonb_build_object('active',active_supplier,
    'booking_enabled',booking_enabled,'ticketing_enabled',ticketing_enabled)
    from public.supplier_operational_settings where id='triplover'),
  'active_or_imaged_offers', (select count(*) from public.homepage_travel_offers
    where is_active or image_url is not null),
  'migration_versions', (select jsonb_agg(version order by version)
    from supabase_migrations.schema_migrations),
  'public_function_count', (select count(*) from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public')
) as verification;
