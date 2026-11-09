begin;

-- The previous Book and Issue adapters sometimes copied pnr into airlines_pnr.
-- Keep both stored values and the local lifecycle intact; only withhold the
-- ambiguous value from documents until an explicit supplier locator is proved.
alter table public.flight_bookings add column shapon_unverified_airline_pnr text;

-- Avoid marking existing bookings as newly modified by this display backfill.
alter table public.flight_bookings disable trigger flight_bookings_touch_updated_at;
update public.flight_bookings
set shapon_unverified_airline_pnr = airlines_pnr->>0
where supplier = 'shapontravels' and supplier_account = 'shapontravels'
  and import_source is null and not legacy_operational
  and length(btrim(pnr)) > 2 and jsonb_typeof(airlines_pnr->0) = 'string' and airlines_pnr->1 is null
  and lower(btrim(airlines_pnr->>0)) = lower(btrim(pnr));
alter table public.flight_bookings enable trigger flight_bookings_touch_updated_at;

do $migration$
declare
  v_definition text;
  v_signature text;
  v_anchor text;
  v_pattern text := '([[:space:]]+FROM[[:space:]]+(public\.)?flight_bookings fb)';
begin
  v_definition := pg_get_viewdef('public.booking_lifecycle_v'::regclass, true);
  if (select count(*) from regexp_matches(v_definition, v_pattern, 'g')) <> 1 then
    raise exception 'Unexpected booking lifecycle locator projection';
  end if;
  execute 'create or replace view public.booking_lifecycle_v with (security_invoker = true) as ' ||
    regexp_replace(v_definition, v_pattern, E',\n    fb.shapon_unverified_airline_pnr\\1');

  v_definition := pg_get_viewdef('public.booking_dashboard_list_v'::regclass, true);
  v_anchor := 'THEN booking.airlines_pnr';
  if strpos(v_definition, v_anchor) = 0 then raise exception 'Unexpected dashboard locator projection'; end if;
  execute 'create or replace view public.booking_dashboard_list_v with (security_invoker = true) as ' ||
    replace(v_definition, v_anchor, $projection$THEN case
      when booking.airlines_pnr = jsonb_build_array(booking.shapon_unverified_airline_pnr) then '[]'::jsonb
      else booking.airlines_pnr end$projection$);

  -- A verified issue may supply the same value as the reservation. In that
  -- case explicit receipt evidence clears the marker before creating a ticket.
  for v_signature in values
    ('public.wallet_capture_reservation(uuid,text,text,text,jsonb)'),
    ('public.wallet_finalize_manual_issue(uuid,text,text,jsonb)') loop
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    v_anchor := 'airlines_pnr = case when public.jsonb_is_nonempty_array(p_supplier_outcome->''airlinesPnr'')';
    if strpos(v_definition, v_anchor) = 0 then raise exception 'Unexpected issue locator storage: %', v_signature; end if;
    execute replace(v_definition, v_anchor, $assignment$shapon_unverified_airline_pnr = case
      when v_booking.supplier = 'shapontravels' and
        public.jsonb_is_nonempty_array(p_supplier_outcome->'airlinesPnr') then null
      else shapon_unverified_airline_pnr end,
    $assignment$ || v_anchor);
  end loop;

  v_definition := pg_get_functiondef(
    'public.confirm_shapon_external_ticket_v1(uuid,text,text,uuid,boolean,jsonb,jsonb,timestamptz)'::regprocedure);
  v_anchor := 'shapon_passenger_ticket_refs=public.shapon_platform_passenger_ticket_refs_v1(p_ticket_proof->''passengerTickets''),';
  if strpos(v_definition, v_anchor) = 0 then raise exception 'Unexpected confirmed ticket locator storage'; end if;
  execute replace(v_definition, v_anchor, v_anchor || $assignment$
    shapon_unverified_airline_pnr=case when public.jsonb_is_nonempty_array(p_ticket_proof->'airlinesPnr')
      then null else shapon_unverified_airline_pnr end,$assignment$);

  v_definition := pg_get_functiondef('public.enrich_booking_notification_snapshot_v1()'::regprocedure);
  v_anchor := '''airlinesPnr'', coalesce(v_booking.airlines_pnr, ''[]''::jsonb),';
  if strpos(v_definition, v_anchor) = 0 then raise exception 'Unexpected ticket notification locator projection'; end if;
  execute replace(v_definition, v_anchor, $snapshot$'airlinePnrDisplayVersion', 1,
    'airlinesPnr', case
    when v_booking.airlines_pnr = jsonb_build_array(v_booking.shapon_unverified_airline_pnr) then '[]'::jsonb
    else coalesce(v_booking.airlines_pnr, '[]'::jsonb) end,$snapshot$);

  v_definition := pg_get_functiondef('public.enqueue_booking_issued_sms_v1()'::regprocedure);
  v_anchor := 'public.valid_booking_airline_pnrs_v1(v_booking.airlines_pnr)';
  if strpos(v_definition, v_anchor) = 0 then raise exception 'Unexpected issued SMS locator projection'; end if;
  execute replace(v_definition, v_anchor, $sms$public.valid_booking_airline_pnrs_v1(case
    when v_booking.airlines_pnr = jsonb_build_array(v_booking.shapon_unverified_airline_pnr) then '[]'::jsonb
    else v_booking.airlines_pnr end)$sms$);
end;
$migration$;

-- Link locator storage to the winning saved-status observation under the same
-- booking lock. An older reply can still be recorded as status history.
do $migration$
declare
  v_definition text := pg_get_functiondef(
    'public.record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb)'::regprocedure);
  v_declaration text := '  v_projection jsonb;';
  v_projection_call text := '  v_projection := public.shapon_booking_current_status_v1(v_booking);';
  v_response text := $response$    'effectiveStatus',v_projection->>'effectiveStatus','currentStatus',v_projection);$response$;
begin
  if (length(v_definition)-length(replace(v_definition,v_declaration,'')))/length(v_declaration) <> 1
      or (length(v_definition)-length(replace(v_definition,v_projection_call,'')))/length(v_projection_call) <> 1
      or (length(v_definition)-length(replace(v_definition,v_response,'')))/length(v_response) <> 1 then
    raise exception 'Unexpected Shapon status recorder locator projection';
  end if;
  v_definition := replace(v_definition, v_declaration, v_declaration || $declaration$
  v_locator_refresh jsonb := p_receipt_identity->'airlineLocatorRefresh';
  v_locator_timestamp timestamptz;
  v_locator_array jsonb := v_locator_refresh->'locators';
  v_locators_updated boolean := false;$declaration$);
  v_definition := replace(v_definition, v_projection_call, $refresh$
  if v_id = v_latest and not (p_receipt_identity ? 'issueResponse')
      and v_booking.supplier = 'shapontravels' and v_booking.supplier_account = 'shapontravels'
      and v_booking.import_source is null and not v_booking.legacy_operational
      and length(btrim(v_booking.pnr)) > 2
      and v_booking.operation_kind is null and v_booking.active_operation_id is null
      and v_current->'reviewRequired' = 'false'::jsonb
      and ((v_current->>'status' = 'confirmed' and v_booking.status = 'confirmed')
        or (v_current->>'status' = 'on-hold' and v_booking.status in ('on-hold','pending')))
      and (v_booking.airlines_pnr = '[]'::jsonb
        or (v_booking.shapon_unverified_airline_pnr is not null
          and v_booking.airlines_pnr = jsonb_build_array(v_booking.shapon_unverified_airline_pnr)))
      and jsonb_typeof(v_locator_refresh) = 'object'
      and jsonb_typeof(v_locator_refresh->'bookingUpdatedAt') = 'string'
      and v_locator_refresh->>'bookingUpdatedAt' ~
        '^\d{4}-\d{2}-\d{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.\d{1,6})?(Z|[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])$'
      and jsonb_typeof(v_locator_array) = 'array' and v_locator_array <> '[]'::jsonb then
    begin
      v_locator_timestamp := (v_locator_refresh->>'bookingUpdatedAt')::timestamptz;
    exception when datetime_field_overflow or invalid_datetime_format or invalid_time_zone_displacement_value then
      v_locator_timestamp := null;
    end;
    if v_locator_timestamp = v_booking.updated_at and not exists (
        select 1 from jsonb_array_elements(v_locator_array) as locator(value)
        where jsonb_typeof(locator.value) <> 'string' or locator.value#>>'{}' !~ '^[A-Z0-9]{3,12}$'
      ) then
      update public.flight_bookings
        set airlines_pnr = v_locator_array, shapon_unverified_airline_pnr = null
        where id = v_booking.id
        returning * into v_booking;
      v_locators_updated := found;
    end if;
  end if;
$refresh$ || v_projection_call);
  v_definition := replace(v_definition, v_response, $response$
    'effectiveStatus',v_projection->>'effectiveStatus','currentStatus',v_projection)
    || case when p_receipt_identity ? 'airlineLocatorRefresh'
      then jsonb_build_object('airlinePnrsUpdated', v_locators_updated) else '{}'::jsonb end;$response$);
  execute v_definition;
end;
$migration$;

commit;
