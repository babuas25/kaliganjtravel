-- Preserve optional supplier/original references and passenger supplements
-- for IMP/EXP imports after the initial import migration has already shipped.

create or replace function public.create_impexp_booking(
  p_actor_user_id text,
  p_assigned_user_id text,
  p_data jsonb
)
returns public.flight_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_target_user_id text;
  v_target_role text;
  v_agency_code text;
  v_audience text;
  v_supplier text;
  v_supplier_ref text;
  v_status text;
  v_lifecycle_status text;
  v_old_lifecycle text;
  v_new_lifecycle text;
  v_imported_at timestamptz;
  v_attempt_id uuid := gen_random_uuid();
  v_search_id uuid := gen_random_uuid();
  v_access_hash text;
  v_offer jsonb;
  v_existing public.flight_bookings;
  v_booking public.flight_bookings;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'import payload must be an object' using errcode = '22023';
  end if;

  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role not in ('superadmin', 'admin', 'staff_support') then
    raise exception 'IMP/EXP access is forbidden' using errcode = '42501';
  end if;

  v_supplier := nullif(trim(p_data->>'provider'), '');
  v_supplier_ref := nullif(trim(p_data->>'supplierReference'), '');
  if v_supplier not in ('US_BANGLA', 'AIR_ASTRA', 'NOVOAIR')
     or v_supplier_ref is null then
    raise exception 'invalid supplier import identity' using errcode = '22023';
  end if;

  v_target_user_id := nullif(trim(p_assigned_user_id), '');
  if v_target_user_id is not null then
    select role, agency_code into v_target_role, v_agency_code
      from public.app_users
     where clerk_id = v_target_user_id;
    if not found or v_target_role not in ('b2b', 'b2b_sub', 'customer') then
      raise exception 'assigned user is not eligible for IMP/EXP' using errcode = '22023';
    end if;
    if v_target_role in ('b2b', 'b2b_sub') then
      if nullif(trim(v_agency_code), '') is null then
        raise exception 'assigned agency user has no agency' using errcode = '22023';
      end if;
      v_audience := 'agency';
    else
      v_audience := 'b2c';
      v_agency_code := null;
    end if;
  else
    v_target_user_id := p_actor_user_id;
    v_target_role := v_actor_role;
    v_agency_code := null;
    v_audience := 'superadmin';
  end if;

  v_status := p_data->>'storedStatus';
  v_lifecycle_status := p_data->>'lifecycleStatus';
  if v_status is null
     or v_lifecycle_status is null
     or v_status not in ('on-hold', 'pending', 'in-progress', 'confirmed', 'cancelled')
     or v_lifecycle_status not in (
       'on-hold', 'pending', 'in-progress', 'confirmed', 'expired',
       'unconfirmed', 'cancelled'
     )
     or (v_lifecycle_status in ('expired', 'unconfirmed') and v_status <> 'on-hold')
     or (v_lifecycle_status not in ('expired', 'unconfirmed') and v_lifecycle_status <> v_status) then
    raise exception 'invalid imported booking status' using errcode = '22023';
  end if;
  if coalesce(p_data->>'travelDate', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'invalid imported travel date' using errcode = '22007';
  end if;
  if jsonb_typeof(p_data->'passengerCounts') <> 'object'
     or jsonb_typeof(p_data->'itinerary') <> 'object'
     or jsonb_typeof(p_data->'fares') <> 'array'
     or jsonb_typeof(p_data->'passengers') <> 'object'
     or jsonb_typeof(p_data->'airlinesPnr') <> 'array'
     or jsonb_typeof(p_data->'ticketNumbers') <> 'array' then
    raise exception 'invalid normalized import payload' using errcode = '22023';
  end if;

  v_imported_at := coalesce(
    nullif(p_data->>'importedAt', '')::timestamptz,
    now()
  );
  v_offer := jsonb_build_object(
    'itinerary', p_data->'itinerary',
    'fares', p_data->'fares',
    'currency', coalesce(nullif(p_data->>'currency', ''), 'BDT'),
    'pricing', jsonb_build_object(
      'audience', v_audience,
      'agencyCode', v_agency_code,
      'sellingPrice', greatest(0, coalesce((p_data->>'totalPrice')::numeric, 0)),
      'supplierTotalPrice', greatest(0, coalesce((p_data->>'totalPrice')::numeric, 0)),
      'grossPrice', greatest(0, coalesce((p_data->>'totalPrice')::numeric, 0)),
      'serviceMarginAmount', 0,
      'ruleId', null,
      'basis', 'supplier'
    ),
    'passengerCounts', p_data->'passengerCounts',
    'travelDate', p_data->>'travelDate',
    'directTicketing', v_status = 'confirmed',
    'passportRequired', coalesce((p_data->>'passportRequired')::boolean, true),
    'repricedAt', v_imported_at
  );
  v_access_hash := md5(v_attempt_id::text || clock_timestamp()::text)
    || md5(v_search_id::text || random()::text);

  -- A repeated import is a supplier status refresh, not a duplicate booking.
  -- Reuse the STR reference and append a lifecycle event only when its public
  -- status actually changes.
  select * into v_existing
    from public.flight_bookings
   where import_source = 'IMP_EXP'
     and supplier = v_supplier
     and booking_ref_number = v_supplier_ref
   limit 1
   for update;
  if found then
    v_old_lifecycle := public.resolve_booking_lifecycle(
      v_existing.status,
      v_existing.airlines_pnr,
      v_existing.ticketing_deadline_at,
      v_existing.operation_kind
    );

    update public.booking_attempts
       set user_id = v_target_user_id,
           audience = v_audience,
           agency_code = v_agency_code,
           supplier = v_supplier,
           offer_snapshot = v_offer,
           passenger_snapshot = p_data->'passengers',
           pnr = coalesce(nullif(p_data->>'pnr', ''), v_supplier_ref),
           resolved_at = v_imported_at
     where id = v_existing.attempt_id;

    update public.flight_bookings
       set user_id = v_target_user_id,
           audience = v_audience,
           agency_code = v_agency_code,
           booking_owner_type = null,
           booking_owner_key = null,
           status = v_status,
           operation_kind = case when v_status = 'in-progress'
             then 'reconciliation' else null end,
           operation_reason = case when v_status = 'in-progress'
             then 'legacy_reconciliation' else null end,
           operation_request_id = null,
           operation_actor_user_id = null,
           operation_started_at = case when v_status = 'in-progress'
             then v_imported_at else null end,
           operation_prior_status = null,
           currency = coalesce(nullif(p_data->>'currency', ''), 'BDT'),
           pricing_snapshot = v_offer->'pricing',
           passenger_counts = p_data->'passengerCounts',
           travel_date = (p_data->>'travelDate')::date,
           direct_ticketing = v_status = 'confirmed',
           itinerary = p_data->'itinerary',
           fares = p_data->'fares',
           passport_required = coalesce(
             (p_data->>'passportRequired')::boolean,
             true
           ),
           supplier_refs = jsonb_strip_nulls(
             coalesce(v_existing.supplier_refs, '{}'::jsonb)
             || jsonb_build_object(
               'originalReference', nullif(p_data->>'originalReference', '')
             )
           ),
           repriced_at = v_imported_at,
           accepted_at = v_imported_at,
           passengers = p_data->'passengers',
           pnr = coalesce(nullif(p_data->>'pnr', ''), v_supplier_ref),
           airlines_pnr = p_data->'airlinesPnr',
           booking_status = p_data->>'orderStatus',
           ticketing_time_limit = nullif(p_data->>'ticketingTimeLimit', ''),
           ticketing_deadline_at = nullif(
             p_data->>'ticketingDeadlineAt',
             ''
           )::timestamptz,
           deadline_source = case
             when nullif(p_data->>'ticketingDeadlineAt', '') is not null
               then 'supplier'
             else null
           end,
           ticket_numbers = p_data->'ticketNumbers',
           supplier_message = nullif(p_data->>'supplierMessage', ''),
           issued_at = case when v_status = 'confirmed'
             then coalesce(v_existing.issued_at, v_imported_at) else null end,
           cancelled_at = case when v_status = 'cancelled'
             then coalesce(v_existing.cancelled_at, v_imported_at) else null end,
           booked_by_user_id = p_actor_user_id,
           imported_by_user_id = p_actor_user_id,
           import_metadata = jsonb_build_object(
             'provider', v_supplier,
             'supplierReference', v_supplier_ref,
             'originalReference', nullif(p_data->>'originalReference', ''),
             'orderStatus', p_data->>'orderStatus',
             'lifecycleStatus', v_lifecycle_status,
             'lastSyncedAt', v_imported_at
           )
     where id = v_existing.id
     returning * into v_booking;

    v_new_lifecycle := public.resolve_booking_lifecycle(
      v_booking.status,
      v_booking.airlines_pnr,
      v_booking.ticketing_deadline_at,
      v_booking.operation_kind
    );
    if v_old_lifecycle is distinct from v_new_lifecycle then
      insert into public.booking_status_events (
        booking_id, from_lifecycle_status, to_lifecycle_status,
        stored_status_before, stored_status_after, operation_kind,
        operation_reason, actor_user_id, supplier_operation,
        supplier_evidence
      ) values (
        v_booking.id, v_old_lifecycle, v_new_lifecycle,
        v_existing.status, v_booking.status, v_booking.operation_kind,
        v_booking.operation_reason, p_actor_user_id, 'ImportSync',
        jsonb_build_object(
          'provider', v_supplier,
          'supplierStatus', p_data->>'orderStatus',
          'lifecycleStatus', v_lifecycle_status,
          'airlinesPnr', p_data->'airlinesPnr',
          'ticketNumbers', p_data->'ticketNumbers'
        )
      );
    end if;
    return v_booking;
  end if;

  insert into public.booking_attempts (
    id, access_token_hash, user_id, audience, agency_code, supplier, state,
    search_id, itinerary_id, unique_trans_id, item_code_ref, price_code_ref,
    booking_code_ref, pnr, offer_snapshot, passenger_snapshot,
    expires_at, submitted_at, resolved_at, created_at
  ) values (
    v_attempt_id, v_access_hash, v_target_user_id, v_audience, v_agency_code,
    v_supplier, 'succeeded', v_search_id,
    'impexp:' || lower(v_supplier) || ':' || v_supplier_ref,
    v_supplier_ref, v_supplier_ref, v_supplier_ref,
    'impexp:' || v_supplier_ref,
    coalesce(nullif(p_data->>'pnr', ''), v_supplier_ref),
    v_offer, p_data->'passengers', v_imported_at, v_imported_at,
    v_imported_at, v_imported_at
  );

  insert into public.flight_bookings (
    id, public_ref, attempt_id, supplier, user_id, audience, agency_code,
    search_id, itinerary_id, status, operation_kind, operation_reason,
    operation_started_at, currency, pricing_snapshot,
    passenger_counts, travel_date, direct_ticketing, itinerary, fares,
    passport_required, supplier_refs, repriced_at, accepted_at, passengers,
    pnr, airlines_pnr, booking_ref_number, booking_status, ticketing_time_limit,
    ticketing_deadline_at, deadline_source, booking_code_ref, ticket_numbers,
    warnings, supplier_message, issued_at, cancelled_at, submission_started_at,
    legacy_operational, booked_by_user_id, import_source, imported_by_user_id,
    import_metadata, created_at
  ) values (
    gen_random_uuid(), public.allocate_booking_ref(), v_attempt_id, v_supplier,
    v_target_user_id, v_audience, v_agency_code, v_search_id,
    'impexp:' || lower(v_supplier) || ':' || v_supplier_ref,
    v_status,
    case when v_status = 'in-progress' then 'reconciliation' else null end,
    case when v_status = 'in-progress' then 'legacy_reconciliation' else null end,
    case when v_status = 'in-progress' then v_imported_at else null end,
    coalesce(nullif(p_data->>'currency', ''), 'BDT'),
    v_offer->'pricing', p_data->'passengerCounts',
    (p_data->>'travelDate')::date, v_status = 'confirmed',
    p_data->'itinerary', p_data->'fares',
    coalesce((p_data->>'passportRequired')::boolean, true),
    jsonb_strip_nulls(jsonb_build_object(
      'uniqueTransId', v_supplier_ref,
      'itemCodeRef', v_supplier_ref,
      'priceCodeRef', v_supplier_ref,
      'externalImport', true,
      'originalReference', nullif(p_data->>'originalReference', '')
    )),
    v_imported_at, v_imported_at, p_data->'passengers',
    coalesce(nullif(p_data->>'pnr', ''), v_supplier_ref),
    p_data->'airlinesPnr', v_supplier_ref, p_data->>'orderStatus',
    nullif(p_data->>'ticketingTimeLimit', ''),
    nullif(p_data->>'ticketingDeadlineAt', '')::timestamptz,
    case when nullif(p_data->>'ticketingDeadlineAt', '') is not null
      then 'supplier' else null end,
    'impexp:' || v_supplier_ref, p_data->'ticketNumbers', '[]'::jsonb,
    nullif(p_data->>'supplierMessage', ''),
    case when v_status = 'confirmed' then v_imported_at end,
    case when v_status = 'cancelled' then v_imported_at end,
    v_imported_at, false, p_actor_user_id, 'IMP_EXP', p_actor_user_id,
    jsonb_build_object(
      'provider', v_supplier,
      'supplierReference', v_supplier_ref,
      'originalReference', nullif(p_data->>'originalReference', ''),
      'orderStatus', p_data->>'orderStatus',
      'lifecycleStatus', v_lifecycle_status,
      'lastSyncedAt', v_imported_at
    ),
    v_imported_at
  ) returning * into v_booking;

  return v_booking;
exception
  when unique_violation then
    select * into v_existing
      from public.flight_bookings
     where import_source = 'IMP_EXP'
       and supplier = v_supplier
       and booking_ref_number = v_supplier_ref
     limit 1;
    if found then return v_existing; end if;
    raise;
end;
$$;

revoke all on function public.create_impexp_booking(text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.create_impexp_booking(text,text,jsonb)
  to service_role;
