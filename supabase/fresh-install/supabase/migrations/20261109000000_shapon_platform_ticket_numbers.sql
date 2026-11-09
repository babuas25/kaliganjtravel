begin;

alter table public.flight_bookings add column shapon_passenger_ticket_refs jsonb;

-- Validate the supplier-verified rows in original saved passenger order. Only
-- genuine numeric e-tickets participate in cross-booking uniqueness checks.
create function public.shapon_passenger_ticket_numbers_v1(
  p_rows jsonb, p_itinerary jsonb, p_airline_pnrs jsonb, p_ticket_code_ref text
)
returns table(ticket_numbers jsonb, numeric_numbers text[])
language plpgsql immutable set search_path = pg_catalog as $$
declare
  v_carrier text;
  v_ticketless boolean := false;
  v_leg jsonb;
  v_segment jsonb;
  v_row jsonb;
  v_slot bigint;
  v_source text;
  v_value jsonb;
  v_number text;
  v_locator text;
  v_row_seen text[];
begin
  if jsonb_typeof(p_itinerary->'legs') = 'array' then
    v_ticketless := jsonb_array_length(p_itinerary->'legs') > 0;
    for v_leg in select value from jsonb_array_elements(p_itinerary->'legs') loop
      if jsonb_typeof(v_leg->'segments') is distinct from 'array' then
        v_ticketless := false;
        exit;
      end if;
      if jsonb_array_length(v_leg->'segments') = 0 then
        v_ticketless := false;
        exit;
      end if;
      for v_segment in select value from jsonb_array_elements(v_leg->'segments') loop
        v_carrier := coalesce(v_carrier, v_segment->>'airlineCode');
        if v_carrier is null or v_carrier not in ('6E', 'J9')
           or v_segment->>'airlineCode' is distinct from v_carrier then
          v_ticketless := false;
          exit;
        end if;
      end loop;
      exit when not v_ticketless;
    end loop;
  end if;

  ticket_numbers := '[]'::jsonb;
  numeric_numbers := array[]::text[];
  for v_row, v_slot in select value, ordinality from jsonb_array_elements(p_rows) with ordinality loop
    v_source := coalesce(v_row->>'ticketNumberSource', '');
    if jsonb_typeof(v_row) is distinct from 'object'
       or jsonb_typeof(v_row->'ticketNumbers') is distinct from 'array'
       or coalesce(jsonb_typeof(v_row->'ticketNumberSource'), 'null') not in ('null', 'string')
       or v_source not in ('', 'airline_pnr', 'platform_pnr') then return; end if;
    if jsonb_array_length(v_row->'ticketNumbers') not between 1 and 20 then return; end if;
    if v_source <> '' and (not v_ticketless or p_ticket_code_ref is null) then return; end if;

    v_row_seen := array[]::text[];
    for v_value in select value from jsonb_array_elements(v_row->'ticketNumbers') loop
      v_number := v_value #>> '{}';
      if jsonb_typeof(v_value) <> 'string' or v_number = any(v_row_seen) then return; end if;
      if v_source = '' then
        if v_number !~ '^[0-9]{10,16}$' or v_number = any(numeric_numbers) then return; end if;
        numeric_numbers := array_append(numeric_numbers, v_number);
      else
        v_locator := v_number;
        if v_source = 'platform_pnr' then
          v_locator := split_part(v_number, '/', 1);
          if v_slot > 20 or v_number <> v_locator || '/' || v_slot::text then return; end if;
        end if;
        if v_locator !~ '^[A-Z0-9]{6}$'
           or not coalesce(p_airline_pnrs @> jsonb_build_array(v_locator), false) then return; end if;
      end if;
      v_row_seen := array_append(v_row_seen, v_number);
      ticket_numbers := ticket_numbers || jsonb_build_array(v_value);
    end loop;
  end loop;
  return next;
end;
$$;
revoke all on function public.shapon_passenger_ticket_numbers_v1(jsonb,jsonb,jsonb,text)
  from public, anon, authenticated;
grant execute on function public.shapon_passenger_ticket_numbers_v1(jsonb,jsonb,jsonb,text)
  to service_role;

-- Keep just the identifiers and their source from already validated proof.
create function public.shapon_platform_passenger_ticket_refs_v1(p_rows jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select case when jsonb_typeof(p_rows) = 'array'
    and p_rows @> '[{"ticketNumberSource":"platform_pnr"}]'::jsonb then (
      select jsonb_agg(jsonb_build_object('ticketNumbers', value->'ticketNumbers',
        'ticketNumberSource', value->'ticketNumberSource') order by ordinality)
      from jsonb_array_elements(p_rows) with ordinality
    ) end
$$;
revoke all on function public.shapon_platform_passenger_ticket_refs_v1(jsonb) from public, anon, authenticated;
grant execute on function public.shapon_platform_passenger_ticket_refs_v1(jsonb) to service_role;

-- Replace just the duplicated ticket-row checks in the installed functions.
-- The guarded replacement preserves their identity, ownership, settlement,
-- replay, permission and audit logic, as well as function ownership and ACLs.
do $migration$
declare
  v_definition text;
  v_start integer;
  v_end integer;
  v_rpc text;
  v_capture text;
  v_capture_sql text;
  v_old text;
begin
  v_definition := pg_get_functiondef(
    'public.confirm_shapon_external_ticket_v1(uuid,text,text,uuid,boolean,jsonb,jsonb,timestamptz)'::regprocedure);
  v_old := 'jsonb_array_length(p_ticket_proof->''airlinesPnr'') not between 1 and 20';
  if strpos(v_definition, v_old) = 0 then raise exception 'Unexpected Shapon external ticket locator validation'; end if;
  v_definition := replace(v_definition, v_old, replace(v_old, '1 and 20', '0 and 20'));
  v_old := 'ticket_code_ref=v_ticket_code_ref,ticket_numbers=v_numbers,airlines_pnr=p_ticket_proof->''airlinesPnr'',';
  if strpos(v_definition, v_old) = 0 then raise exception 'Unexpected Shapon external ticket storage'; end if;
  v_definition := replace(v_definition, v_old, $assignment$ticket_code_ref=v_ticket_code_ref,ticket_numbers=v_numbers,
    shapon_passenger_ticket_refs=public.shapon_platform_passenger_ticket_refs_v1(p_ticket_proof->'passengerTickets'),
    airlines_pnr=case when jsonb_array_length(p_ticket_proof->'airlinesPnr') > 0
      then p_ticket_proof->'airlinesPnr' else airlines_pnr end,$assignment$);
  v_start := strpos(v_definition, E'  v_passenger_ticket jsonb;\n');
  v_end := strpos(v_definition, E'  v_now timestamptz:=clock_timestamp();\n');
  if v_start = 0 or v_end <= v_start then
    raise exception 'Unexpected Shapon external confirmation declarations';
  end if;
  v_definition := overlay(v_definition placing $replacement$  v_numbers jsonb;
  v_numeric_seen text[];
  v_numeric_ticket text;
$replacement$ from v_start for v_end-v_start);
  v_start := strpos(v_definition, '  -- IndiGo may use its airline locator as the ticket identifier.');
  v_end := strpos(v_definition, $marker$  if p_ticket_proof->'ticketNumbers' is distinct from v_numbers then$marker$);
  if v_start = 0 or v_end <= v_start then
    raise exception 'Unexpected Shapon external confirmation ticket-row checks';
  end if;
  execute overlay(v_definition placing $replacement$  select proof.ticket_numbers, proof.numeric_numbers into v_numbers, v_numeric_seen
    from public.shapon_passenger_ticket_numbers_v1(p_ticket_proof->'passengerTickets',
      v_booking.itinerary, p_ticket_proof->'airlinesPnr', p_ticket_proof->>'ticketCodeRef') proof;
$replacement$ from v_start for v_end-v_start);

  -- Both held Issue paths already finalize the same durable operation. Keep
  -- optional Shapon proof with its outcome and route invalid evidence through
  -- the existing reconciliation branch before the underlying wallet function.
  for v_rpc, v_capture in select * from (values
    ('public.wallet_capture_reservation_v2(uuid,text,text,text,text,uuid,jsonb)', 'wallet_capture_reservation'),
    ('public.wallet_finalize_manual_issue_v2(uuid,text,text,text,text,uuid,jsonb)', 'wallet_finalize_manual_issue')
  ) r(signature, capture_function) loop
    v_definition := pg_get_functiondef(v_rpc::regprocedure);
    if strpos(v_definition, E'  v_evidence jsonb;\nbegin') = 0 then
      raise exception 'Unexpected Shapon held Issue declarations: %', v_rpc;
    end if;
    v_definition := replace(v_definition, E'  v_evidence jsonb;\nbegin', $replacement$  v_evidence jsonb;
  v_booking public.flight_bookings;
  v_passenger_tickets jsonb := p_supplier_outcome->'passengerTickets';
  v_verified_numbers jsonb;
begin$replacement$);
    v_start := strpos(v_definition, format('  v_result := public.%I(', v_capture));
    v_end := strpos(v_definition, $marker$  if coalesce((v_result->>'ok')::boolean, false) is not true then$marker$);
    if v_start = 0 or v_end <= v_start then
      raise exception 'Unexpected Shapon held Issue settlement: %', v_rpc;
    end if;
    v_capture_sql := substring(v_definition from v_start for v_end-v_start);
    execute overlay(v_definition placing $replacement$  if p_supplier_outcome ? 'passengerTickets' then
    select * into v_booking from public.flight_bookings where id = p_booking_id;
    if v_booking.supplier = 'shapontravels' then
      if v_booking.supplier_account = 'shapontravels'
         and v_booking.pnr = p_supplier_outcome->>'pnr'
         and jsonb_typeof(v_passenger_tickets) = 'array'
         and jsonb_typeof(v_booking.passengers->'travellers') = 'array' then
        if jsonb_array_length(v_passenger_tickets) between 1 and 100
           and jsonb_array_length(v_passenger_tickets) = jsonb_array_length(v_booking.passengers->'travellers') then
          select proof.ticket_numbers into v_verified_numbers
            from public.shapon_passenger_ticket_numbers_v1(v_passenger_tickets, v_booking.itinerary,
              p_supplier_outcome->'airlinesPnr', nullif(btrim(p_supplier_outcome->>'ticketCodeRef'), '')) proof;
        end if;
      end if;
      if v_verified_numbers is null or v_verified_numbers is distinct from p_supplier_outcome->'ticketNumbers' then
        v_result := jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
      else
        v_evidence := v_evidence || jsonb_build_object('passengerTickets', (
          select jsonb_agg(jsonb_build_object('ticketNumbers', value->'ticketNumbers',
            'ticketNumberSource', value->'ticketNumberSource') order by ordinality)
          from jsonb_array_elements(v_passenger_tickets) with ordinality
        ));
      end if;
    end if;
  end if;
  if v_result is null then
$replacement$ || v_capture_sql || E'  end if;\n' from v_start for v_end-v_start);
  end loop;
end;
$migration$;

-- Save the verified passenger association in the same booking write as its
-- ticket numbers, before the immutable notification snapshot is captured.
do $migration$
declare
  v_definition text;
  v_signature text;
  v_old text;
  v_pattern text := '([[:space:]]+FROM[[:space:]]+(public\.)?flight_bookings fb)';
begin
  for v_signature in values
    ('public.wallet_capture_reservation(uuid,text,text,text,jsonb)'),
    ('public.wallet_finalize_manual_issue(uuid,text,text,jsonb)') loop
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    v_old := 'ticket_numbers = p_supplier_outcome->''ticketNumbers'',';
    if strpos(v_definition, v_old) = 0 then raise exception 'Unexpected Shapon held ticket storage: %', v_signature; end if;
    execute replace(v_definition, v_old, v_old || $assignment$
    shapon_passenger_ticket_refs = case when v_booking.supplier = 'shapontravels'
      and jsonb_typeof(p_supplier_outcome->'passengerTickets') = 'array'
      and jsonb_typeof(v_booking.passengers->'travellers') = 'array' then
      case when p_supplier_outcome->'passengerTickets' @> '[{"ticketNumberSource":"platform_pnr"}]'::jsonb
        and jsonb_array_length(p_supplier_outcome->'passengerTickets') = jsonb_array_length(v_booking.passengers->'travellers')
        and p_supplier_outcome->'ticketNumbers' = (
          select proof.ticket_numbers from public.shapon_passenger_ticket_numbers_v1(
            p_supplier_outcome->'passengerTickets', v_booking.itinerary,
            p_supplier_outcome->'airlinesPnr', nullif(btrim(p_supplier_outcome->>'ticketCodeRef'), '')) proof)
        then public.shapon_platform_passenger_ticket_refs_v1(p_supplier_outcome->'passengerTickets') end
      end,$assignment$);
  end loop;

  v_definition := pg_get_functiondef('public.enrich_booking_notification_snapshot_v1()'::regprocedure);
  v_old := E'      ''travellers'', v_travellers\n    ));';
  if strpos(v_definition, v_old) = 0 then raise exception 'Unexpected booking email snapshot storage'; end if;
  execute replace(v_definition, v_old, $snapshot$      'travellers', v_travellers
    ) || case when v_booking.shapon_passenger_ticket_refs is not null then
      jsonb_build_object('shaponPassengerTicketRefs', v_booking.shapon_passenger_ticket_refs) else '{}'::jsonb end);$snapshot$);

  v_definition := pg_get_viewdef('public.booking_lifecycle_v'::regclass, true);
  if (select count(*) from regexp_matches(v_definition, v_pattern, 'g')) <> 1 then
    raise exception 'Unexpected booking lifecycle source';
  end if;
  execute 'create or replace view public.booking_lifecycle_v with (security_invoker = true) as ' ||
    regexp_replace(v_definition, v_pattern, E',\n    fb.shapon_passenger_ticket_refs\\1');
end;
$migration$;

commit;
