-- Ticket Management passenger/ticket financial entitlement protection.
--
-- Existing booking User Payable fare snapshots are expanded by passenger
-- type/count and converted directly to minor units. They must sum exactly to
-- the authoritative captured amount; proportional Gross-based scaling is
-- forbidden.
-- Bootstrap fails closed when passenger, ticket, fare, or legacy refund facts
-- cannot be proved. This migration performs no wallet movement.

create table public.ticket_management_ticket_entitlements (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null
    references public.flight_bookings(id) on delete restrict,
  predecessor_entitlement_id uuid
    references public.ticket_management_ticket_entitlements(id) on delete restrict,
  passenger_index integer not null check (passenger_index >= 0),
  passenger_snapshot jsonb not null
    check (jsonb_typeof(passenger_snapshot) = 'object'),
  passenger_name text not null
    check (char_length(btrim(passenger_name)) between 1 and 300),
  passenger_type text not null
    check (passenger_type in ('ADT', 'CHD', 'CNN', 'INF', 'INS')),
  original_ticket_number text not null
    check (char_length(btrim(original_ticket_number)) between 1 and 80),
  active_ticket_number text not null
    check (char_length(btrim(active_ticket_number)) between 1 and 80),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  entitlement_amount bigint not null check (entitlement_amount > 0),
  consumed_amount bigint not null default 0
    check (consumed_amount >= 0 and consumed_amount <= entitlement_amount),
  user_payable_source_minor bigint not null check (user_payable_source_minor > 0),
  allocation_source text not null
    check (allocation_source in ('authoritative-user-payable', 'reissue-lineage')),
  allocation_hash text not null check (allocation_hash ~ '^[a-f0-9]{64}$'),
  state text not null default 'active'
    check (state in ('active', 'refunded', 'voided', 'reissued')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint ticket_management_entitlement_terminal_consumption_check
    check (
      state = 'active'
      or consumed_amount = entitlement_amount
    )
);

create unique index ticket_management_root_entitlement_passenger_key
  on public.ticket_management_ticket_entitlements(booking_id, passenger_index)
  where predecessor_entitlement_id is null;
create unique index ticket_management_active_ticket_key
  on public.ticket_management_ticket_entitlements(booking_id, active_ticket_number)
  where state = 'active';
create index ticket_management_entitlements_booking_idx
  on public.ticket_management_ticket_entitlements(booking_id, passenger_index, id);

create trigger ticket_management_entitlements_touch_updated_at
  before update on public.ticket_management_ticket_entitlements
  for each row execute function public.touch_updated_at();

create table public.ticket_management_request_selections (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.ticket_management_requests(id) on delete restrict,
  entitlement_id uuid not null
    references public.ticket_management_ticket_entitlements(id) on delete restrict,
  passenger_index integer not null check (passenger_index >= 0),
  passenger_snapshot jsonb not null
    check (jsonb_typeof(passenger_snapshot) = 'object'),
  passenger_name text not null,
  passenger_type text not null
    check (passenger_type in ('ADT', 'CHD', 'CNN', 'INF', 'INS')),
  ticket_number_snapshot text not null,
  entitlement_amount_snapshot bigint not null check (entitlement_amount_snapshot > 0),
  consumed_amount_snapshot bigint not null check (consumed_amount_snapshot >= 0),
  coupon_scope jsonb not null default '[]'::jsonb
    check (jsonb_typeof(coupon_scope) = 'array'),
  created_at timestamptz not null default clock_timestamp(),
  unique (request_id, entitlement_id),
  unique (request_id, passenger_index)
);

create index ticket_management_selections_entitlement_idx
  on public.ticket_management_request_selections(entitlement_id, request_id);

create table public.ticket_management_entitlement_claims (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.ticket_management_requests(id) on delete restrict,
  entitlement_id uuid not null
    references public.ticket_management_ticket_entitlements(id) on delete restrict,
  state text not null default 'active'
    check (state in ('active', 'released', 'consumed')),
  claimed_at timestamptz not null default clock_timestamp(),
  released_at timestamptz,
  consumed_at timestamptz,
  release_reason text,
  unique (request_id, entitlement_id),
  constraint ticket_management_claim_timestamp_check
    check (
      (state = 'active' and released_at is null and consumed_at is null)
      or (state = 'released' and released_at is not null and consumed_at is null)
      or (state = 'consumed' and consumed_at is not null and released_at is null)
    )
);

create unique index ticket_management_one_active_entitlement_claim
  on public.ticket_management_entitlement_claims(entitlement_id)
  where state = 'active';
create index ticket_management_claims_request_idx
  on public.ticket_management_entitlement_claims(request_id, state, id);

alter table public.ticket_management_requests
  add column selection_hash text
    check (selection_hash is null or selection_hash ~ '^[a-f0-9]{64}$');

alter table public.ticket_management_quotes
  add column selection_hash text
    check (selection_hash is null or selection_hash ~ '^[a-f0-9]{64}$');

create or replace function public.prevent_ticket_management_selection_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'ticket management request selections are immutable'
    using errcode = '55000';
end;
$$;

create trigger ticket_management_selections_deny_update_delete
  before update or delete on public.ticket_management_request_selections
  for each row execute function public.prevent_ticket_management_selection_mutation_v1();

create or replace function public.ticket_management_ensure_booking_entitlements_v1(
  p_booking_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_count integer;
  v_total bigint;
  v_allocation_hash text;
begin
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  select count(*), coalesce(sum(entitlement.entitlement_amount), 0)
    into v_count, v_total
    from public.ticket_management_ticket_entitlements entitlement
   where entitlement.booking_id = p_booking_id
     and entitlement.predecessor_entitlement_id is null;
  if v_count > 0 then
    return jsonb_build_object('ok', true, 'replay', true, 'count', v_count);
  end if;

  if v_booking.captured_amount <= 0
     or v_booking.refunded_amount <> 0
     or v_booking.import_source in ('IMP_EXP', 'MANUAL')
     or jsonb_typeof(v_booking.passengers->'travellers') <> 'array'
     or jsonb_array_length(v_booking.passengers->'travellers') = 0
     or jsonb_typeof(v_booking.ticket_numbers) <> 'array'
     or jsonb_array_length(v_booking.ticket_numbers)
          <> jsonb_array_length(v_booking.passengers->'travellers')
     or jsonb_typeof(v_booking.fares) <> 'array'
     or jsonb_array_length(v_booking.fares) = 0 then
    return jsonb_build_object('ok', false, 'code', 'AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE');
  end if;
  if exists (
    select 1
      from jsonb_array_elements(v_booking.ticket_numbers) ticket(value)
     where jsonb_typeof(ticket.value) <> 'string'
        or nullif(btrim(ticket.value #>> '{}'), '') is null
        or char_length(btrim(ticket.value #>> '{}')) > 80
  ) or (
    select count(distinct upper(btrim(ticket.value #>> '{}')))
      from jsonb_array_elements(v_booking.ticket_numbers) ticket(value)
  ) <> jsonb_array_length(v_booking.ticket_numbers) then
    return jsonb_build_object('ok', false, 'code', 'ENTITLEMENT_TICKETS_UNPROVEN');
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_booking.fares) fare(value)
     where fare.value->>'passengerType' not in ('ADT', 'CHD', 'CNN', 'INF', 'INS')
        or jsonb_typeof(fare.value->'count') <> 'number'
        or (fare.value->>'count')::numeric <> trunc((fare.value->>'count')::numeric)
        or (fare.value->>'count')::integer <= 0
        or jsonb_typeof(fare.value->'totalPrice') <> 'number'
        or (fare.value->>'totalPrice')::numeric <= 0
  ) then
    return jsonb_build_object('ok', false, 'code', 'ENTITLEMENT_FARES_UNPROVEN');
  end if;

  v_allocation_hash := encode(sha256(convert_to(
    concat_ws('|', p_booking_id::text, v_booking.currency,
      v_booking.captured_amount::text,
      (v_booking.passengers->'travellers')::text,
      v_booking.ticket_numbers::text, v_booking.fares::text),
    'UTF8'
  )), 'hex');

  with traveller_base as (
    select
      traveller.ordinality::integer - 1 as passenger_index,
      traveller.value as passenger_snapshot,
      traveller.value->>'passengerType' as passenger_type,
      upper(btrim(v_booking.ticket_numbers ->> (traveller.ordinality::integer - 1)))
        as ticket_number
    from jsonb_array_elements(v_booking.passengers->'travellers')
      with ordinality traveller(value, ordinality)
  ), travellers as (
    select base.*,
      row_number() over (
        partition by base.passenger_type order by base.passenger_index
      ) - 1 as type_occurrence
    from traveller_base base
  ), fare_rows as (
    select
      fare.ordinality,
      fare.value->>'passengerType' as passenger_type,
      (fare.value->>'count')::integer as passenger_count,
      (fare.value->>'totalPrice')::numeric as total_price
    from jsonb_array_elements(v_booking.fares)
      with ordinality fare(value, ordinality)
  ), user_payable_slots as (
    select
      fare.passenger_type,
      row_number() over (
        partition by fare.passenger_type
        order by fare.ordinality, slot.number
      ) - 1 as type_occurrence,
      (fare.total_price * 100 / fare.passenger_count) as user_payable_minor
    from fare_rows fare
    cross join lateral generate_series(1, fare.passenger_count) slot(number)
  ), authoritative as (
    select traveller.*, slot.user_payable_minor
    from travellers traveller
    join user_payable_slots slot
      on slot.passenger_type = traveller.passenger_type
     and slot.type_occurrence = traveller.type_occurrence
    where slot.user_payable_minor > 0
      and slot.user_payable_minor = trunc(slot.user_payable_minor)
  )
  insert into public.ticket_management_ticket_entitlements (
    booking_id, passenger_index, passenger_snapshot, passenger_name,
    passenger_type, original_ticket_number, active_ticket_number,
    currency, entitlement_amount, user_payable_source_minor,
    allocation_source, allocation_hash
  )
  select
    p_booking_id, authoritative.passenger_index, authoritative.passenger_snapshot,
    btrim(concat_ws(' ', authoritative.passenger_snapshot->>'title',
      authoritative.passenger_snapshot->>'firstName', authoritative.passenger_snapshot->>'lastName')),
    authoritative.passenger_type, authoritative.ticket_number, authoritative.ticket_number,
    upper(v_booking.currency),
    authoritative.user_payable_minor::bigint,
    authoritative.user_payable_minor::bigint,
    'authoritative-user-payable', v_allocation_hash
  from authoritative
  order by authoritative.passenger_index;

  get diagnostics v_count = row_count;
  if v_count <> jsonb_array_length(v_booking.passengers->'travellers') then
    raise exception 'passenger fare allocation is incomplete'
      using errcode = '23514';
  end if;
  select sum(entitlement.entitlement_amount) into v_total
    from public.ticket_management_ticket_entitlements entitlement
   where entitlement.booking_id = p_booking_id
     and entitlement.predecessor_entitlement_id is null;
  if v_total <> v_booking.captured_amount then
    raise exception 'authoritative passenger User Payable does not equal captured amount'
      using errcode = '23514';
  end if;
  return jsonb_build_object('ok', true, 'replay', false, 'count', v_count);
end;
$$;

create or replace function public.create_ticket_management_request_v2(
  p_booking_id uuid,
  p_action text,
  p_actor_user_id text,
  p_request_key text,
  p_request_payload_hash text,
  p_passenger_indexes integer[],
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_bootstrap jsonb;
  v_request public.ticket_management_requests;
  v_index_count integer;
  v_selected_count integer;
  v_selection_hash text;
begin
  if p_passenger_indexes is null or cardinality(p_passenger_indexes) = 0
     or exists (select 1 from unnest(p_passenger_indexes) value where value < 0)
     or cardinality(p_passenger_indexes) <>
        (select count(distinct value) from unnest(p_passenger_indexes) value) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PASSENGER_SELECTION');
  end if;

  v_result := public.create_ticket_management_request_v1(
    p_booking_id, p_action, p_actor_user_id, p_request_key,
    p_request_payload_hash, p_note
  );
  if not coalesce((v_result->>'ok')::boolean, false) then return v_result; end if;

  select request.* into strict v_request
    from public.ticket_management_requests request
   where request.id = (v_result->>'requestId')::uuid
   for update;
  v_bootstrap := public.ticket_management_ensure_booking_entitlements_v1(p_booking_id);
  if not coalesce((v_bootstrap->>'ok')::boolean, false) then
    raise exception '%', v_bootstrap->>'code' using errcode = 'P0001';
  end if;

  select count(*) into v_index_count
    from public.ticket_management_ticket_entitlements entitlement
   where entitlement.booking_id = p_booking_id
     and entitlement.passenger_index = any(p_passenger_indexes)
     and entitlement.state = 'active'
     and entitlement.consumed_amount < entitlement.entitlement_amount;
  if v_index_count <> cardinality(p_passenger_indexes) then
    raise exception 'selected passenger entitlement is unavailable'
      using errcode = 'P0001';
  end if;

  select encode(sha256(convert_to(
      string_agg(value::text, ',' order by value), 'UTF8'
    )), 'hex')
    into v_selection_hash
    from unnest(p_passenger_indexes) value;
  select count(*) into v_selected_count
    from public.ticket_management_request_selections selection
   where selection.request_id = v_request.id;
  if v_selected_count > 0 then
    if v_request.selection_hash is distinct from v_selection_hash
       or v_selected_count <> cardinality(p_passenger_indexes) then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_IDEMPOTENCY_CONFLICT');
    end if;
    return v_result || jsonb_build_object(
      'selectionHash', v_selection_hash, 'selectedPassengerCount', v_selected_count
    );
  end if;
  if exists (
    select 1
      from public.ticket_management_entitlement_claims claim
      join public.ticket_management_ticket_entitlements entitlement
        on entitlement.id = claim.entitlement_id
     where entitlement.booking_id = p_booking_id
       and entitlement.passenger_index = any(p_passenger_indexes)
       and claim.state = 'active'
  ) then
    raise exception 'selected passenger entitlement is already claimed'
      using errcode = 'P0001';
  end if;

  insert into public.ticket_management_request_selections (
    request_id, entitlement_id, passenger_index, passenger_snapshot,
    passenger_name, passenger_type, ticket_number_snapshot,
    entitlement_amount_snapshot, consumed_amount_snapshot
  )
  select
    v_request.id, entitlement.id, entitlement.passenger_index,
    entitlement.passenger_snapshot, entitlement.passenger_name,
    entitlement.passenger_type, entitlement.active_ticket_number,
    entitlement.entitlement_amount, entitlement.consumed_amount
  from public.ticket_management_ticket_entitlements entitlement
  where entitlement.booking_id = p_booking_id
    and entitlement.state = 'active'
    and entitlement.consumed_amount < entitlement.entitlement_amount
    and entitlement.passenger_index = any(p_passenger_indexes)
  order by entitlement.passenger_index;

  insert into public.ticket_management_entitlement_claims (request_id, entitlement_id)
  select selection.request_id, selection.entitlement_id
    from public.ticket_management_request_selections selection
   where selection.request_id = v_request.id;
  update public.ticket_management_requests
     set selection_hash = v_selection_hash
   where id = v_request.id;

  return v_result || jsonb_build_object(
    'selectionHash', v_selection_hash,
    'selectedPassengerCount', cardinality(p_passenger_indexes)
  );
end;
$$;

create or replace function public.ticket_management_release_terminal_claims_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('rejected', 'expired')
     and old.status is distinct from new.status then
    update public.ticket_management_entitlement_claims
       set state = 'released', released_at = clock_timestamp(),
           release_reason = new.terminal_outcome
     where request_id = new.id and state = 'active';
  end if;
  return new;
end;
$$;

create trigger ticket_management_requests_release_terminal_claims
  after update of status on public.ticket_management_requests
  for each row execute function public.ticket_management_release_terminal_claims_v1();

create or replace function public.ticket_management_validate_quote_selection_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.ticket_management_requests;
  v_remaining bigint;
  v_count integer;
begin
  select request.* into strict v_request
    from public.ticket_management_requests request
   where request.id = new.request_id
   for update;
  if v_request.selection_hash is null then
    raise exception 'request has no frozen passenger selection' using errcode = '23514';
  end if;
  perform entitlement.id
    from public.ticket_management_request_selections selection
    join public.ticket_management_ticket_entitlements entitlement
      on entitlement.id = selection.entitlement_id
   where selection.request_id = new.request_id
   order by entitlement.id
   for update of entitlement;
  select count(*), coalesce(sum(
      entitlement.entitlement_amount - entitlement.consumed_amount
    ), 0)
    into v_count, v_remaining
    from public.ticket_management_request_selections selection
    join public.ticket_management_ticket_entitlements entitlement
      on entitlement.id = selection.entitlement_id
    join public.ticket_management_entitlement_claims claim
      on claim.request_id = selection.request_id
     and claim.entitlement_id = selection.entitlement_id
   where selection.request_id = new.request_id
     and entitlement.state = 'active'
     and claim.state = 'active';
  if v_count = 0 or v_count <> (
    select count(*) from public.ticket_management_request_selections selection
     where selection.request_id = new.request_id
  ) then
    raise exception 'request passenger entitlement is no longer active'
      using errcode = '23514';
  end if;
  if v_request.action in ('refund', 'void')
     and (new.user_payable_entitlement_amount <= 0
       or new.user_payable_entitlement_amount <> v_remaining) then
    raise exception 'quotation User Payable must equal selected remaining entitlement'
      using errcode = '23514';
  end if;
  if v_request.action = 'reissue'
     and new.user_payable_entitlement_amount <> 0 then
    raise exception 'reissue quotation User Payable entitlement must be zero'
      using errcode = '23514';
  end if;
  new.selection_hash := v_request.selection_hash;
  return new;
end;
$$;

create trigger ticket_management_quotes_validate_selection
  before insert on public.ticket_management_quotes
  for each row execute function public.ticket_management_validate_quote_selection_v1();

alter table public.ticket_management_ticket_entitlements enable row level security;
alter table public.ticket_management_request_selections enable row level security;
alter table public.ticket_management_entitlement_claims enable row level security;

revoke all on public.ticket_management_ticket_entitlements from public, anon, authenticated;
revoke all on public.ticket_management_request_selections from public, anon, authenticated;
revoke all on public.ticket_management_entitlement_claims from public, anon, authenticated;
grant select, insert, update on public.ticket_management_ticket_entitlements to service_role;
grant select, insert on public.ticket_management_request_selections to service_role;
grant select, insert, update on public.ticket_management_entitlement_claims to service_role;

revoke execute on function public.create_ticket_management_request_v1(
  uuid, text, text, text, text, text
) from service_role;
revoke all on function public.ticket_management_ensure_booking_entitlements_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.prevent_ticket_management_selection_mutation_v1()
  from public, anon, authenticated, service_role;
revoke all on function public.ticket_management_release_terminal_claims_v1()
  from public, anon, authenticated, service_role;
revoke all on function public.ticket_management_validate_quote_selection_v1()
  from public, anon, authenticated, service_role;
revoke all on function public.create_ticket_management_request_v2(
  uuid, text, text, text, text, integer[], text
) from public, anon, authenticated;
grant execute on function public.create_ticket_management_request_v2(
  uuid, text, text, text, text, integer[], text
) to service_role;

comment on function public.create_ticket_management_request_v2(
  uuid, text, text, text, text, integer[], text
) is
  'Creates an owner-authorized Ticket Management request with immutable passenger/ticket selection and an exclusive active entitlement claim. No wallet movement.';
