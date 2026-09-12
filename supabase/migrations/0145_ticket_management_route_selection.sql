-- Persist the itinerary routes selected for Refund, Reissue, and VOID.
-- Route snapshots are immutable so staff always review the exact scope the
-- customer submitted, even if the booking snapshot changes later.

create table public.ticket_management_request_routes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.ticket_management_requests(id) on delete restrict,
  route_index integer not null check (route_index >= 0),
  route_snapshot jsonb not null
    check (jsonb_typeof(route_snapshot) = 'object'),
  route_label text not null
    check (char_length(btrim(route_label)) between 1 and 80),
  origin_code text not null
    check (char_length(btrim(origin_code)) between 1 and 12),
  destination_code text not null
    check (char_length(btrim(destination_code)) between 1 and 12),
  departure_at text,
  created_at timestamptz not null default clock_timestamp(),
  unique (request_id, route_index)
);

create index ticket_management_request_routes_request_idx
  on public.ticket_management_request_routes(request_id, route_index);

alter table public.ticket_management_requests
  add column route_selection_hash text
    check (route_selection_hash is null or route_selection_hash ~ '^[a-f0-9]{64}$');

create or replace function public.prevent_ticket_management_route_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'ticket management request routes are immutable'
    using errcode = '55000';
end;
$$;

create trigger ticket_management_request_routes_deny_update_delete
  before update or delete on public.ticket_management_request_routes
  for each row execute function public.prevent_ticket_management_route_mutation_v1();

alter table public.ticket_management_request_routes enable row level security;
revoke all on public.ticket_management_request_routes from public, anon, authenticated;
grant select, insert on public.ticket_management_request_routes to service_role;

create or replace function public.create_ticket_management_request_v4(
  p_booking_id uuid,
  p_action text,
  p_actor_user_id text,
  p_request_key text,
  p_request_payload_hash text,
  p_passenger_indexes integer[],
  p_route_indexes integer[],
  p_request_type text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_booking public.flight_bookings;
  v_request public.ticket_management_requests;
  v_itinerary_routes jsonb;
  v_route_count integer;
  v_selected_count integer;
  v_existing_count integer;
  v_route_selection_hash text;
begin
  if p_route_indexes is null or cardinality(p_route_indexes) = 0 then
    return jsonb_build_object('ok', false, 'code', 'ROUTE_SELECTION_REQUIRED');
  end if;
  if exists (select 1 from unnest(p_route_indexes) route_index where route_index < 0) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ROUTE_SELECTION');
  end if;
  if (select count(*) from unnest(p_route_indexes)) <>
     (select count(distinct route_index) from unnest(p_route_indexes) route_index) then
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_ROUTE_SELECTION');
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id;

  -- Let v3 retain authority for missing/unauthorized bookings. For a real
  -- booking, fail before request creation when its selected route is invalid.
  if found then
    v_itinerary_routes := v_booking.itinerary->'legs';
    if v_itinerary_routes is null or jsonb_typeof(v_itinerary_routes) <> 'array'
       or jsonb_array_length(v_itinerary_routes) = 0 then
      return jsonb_build_object('ok', false, 'code', 'ROUTES_UNAVAILABLE');
    end if;
    v_route_count := jsonb_array_length(v_itinerary_routes);
    if exists (
      select 1 from unnest(p_route_indexes) route_index
       where route_index >= v_route_count
    ) then
      return jsonb_build_object('ok', false, 'code', 'INVALID_ROUTE_SELECTION');
    end if;
  end if;

  v_result := public.create_ticket_management_request_v3(
    p_booking_id, p_action, p_actor_user_id, p_request_key,
    p_request_payload_hash, p_passenger_indexes, p_request_type, p_note
  );
  if not coalesce((v_result->>'ok')::boolean, false) then
    return v_result;
  end if;

  select request.* into v_request
    from public.ticket_management_requests request
   where request.id = (v_result->>'requestId')::uuid
   for update;

  v_route_selection_hash := encode(sha256(convert_to(
    concat_ws('|', p_booking_id::text, p_action,
      (select string_agg(route_index::text, ',' order by route_index)
         from unnest(p_route_indexes) route_index)),
    'UTF8'
  )), 'hex');

  select count(*) into v_existing_count
    from public.ticket_management_request_routes route
   where route.request_id = v_request.id;
  if v_existing_count > 0 then
    if v_request.route_selection_hash is distinct from v_route_selection_hash
       or v_existing_count <> cardinality(p_route_indexes) then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_KEY_REUSED');
    end if;
    return v_result || jsonb_build_object(
      'selectedRouteCount', v_existing_count,
      'routeSelectionHash', v_route_selection_hash
    );
  end if;

  insert into public.ticket_management_request_routes (
    request_id, route_index, route_snapshot, route_label,
    origin_code, destination_code, departure_at
  )
  select
    v_request.id,
    leg.ordinality::integer - 1,
    leg.value,
    case when v_route_count > 1
      then 'Route ' || leg.ordinality::text
      else 'Route'
    end,
    upper(btrim(leg.value->>'from')),
    upper(btrim(leg.value->>'to')),
    nullif(btrim(leg.value->>'departure'), '')
  from jsonb_array_elements(v_itinerary_routes)
    with ordinality leg(value, ordinality)
  where (leg.ordinality::integer - 1) = any(p_route_indexes)
    and jsonb_typeof(leg.value) = 'object'
    and nullif(btrim(leg.value->>'from'), '') is not null
    and nullif(btrim(leg.value->>'to'), '') is not null
  order by leg.ordinality;

  get diagnostics v_selected_count = row_count;
  if v_selected_count <> cardinality(p_route_indexes) then
    raise exception 'selected route is unavailable' using errcode = '23514';
  end if;

  update public.ticket_management_requests
     set route_selection_hash = v_route_selection_hash
   where id = v_request.id;

  return v_result || jsonb_build_object(
    'selectedRouteCount', v_selected_count,
    'routeSelectionHash', v_route_selection_hash
  );
end;
$$;

revoke all on function public.create_ticket_management_request_v4(
  uuid, text, text, text, text, integer[], integer[], text, text
) from public, anon, authenticated;
grant execute on function public.create_ticket_management_request_v4(
  uuid, text, text, text, text, integer[], integer[], text, text
) to service_role;

revoke all on function public.prevent_ticket_management_route_mutation_v1()
  from public, anon, authenticated;
grant execute on function public.prevent_ticket_management_route_mutation_v1()
  to service_role;

comment on table public.ticket_management_request_routes is
  'Immutable booking-itinerary route snapshots selected by the customer for a Ticket Management request.';
comment on column public.ticket_management_requests.route_selection_hash is
  'SHA-256 binding the request to its selected itinerary route indexes.';
comment on function public.create_ticket_management_request_v4(
  uuid, text, text, text, text, integer[], integer[], text, text
) is
  'Creates an owner-authorized Refund, Reissue, or VOID request with immutable passenger and route selections.';
