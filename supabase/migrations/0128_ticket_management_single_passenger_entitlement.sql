-- Forward correction for booking-level User Payable allocation.
--
-- A booking with exactly one eligible passenger and one proved ticket has no
-- partial-allocation ambiguity. Its positive booking-level User Payable amount
-- may therefore fund that passenger's entitlement when it reconciles exactly
-- to the captured wallet amount. Historical Gross/supplier fare rows are not
-- used in this branch. Multi-passenger bookings retain the strict 0121 rule:
-- exact per-passenger User Payable fare rows must sum to captured amount.
--
-- This migration does not backfill entitlements or modify historical booking,
-- fare, pricing, wallet, request, or ledger data.

alter table public.ticket_management_ticket_entitlements
  drop constraint if exists
    ticket_management_ticket_entitlements_allocation_source_check;

alter table public.ticket_management_ticket_entitlements
  add constraint ticket_management_ticket_entitlements_allocation_source_check
  check (allocation_source in (
    'authoritative-user-payable',
    'authoritative-single-passenger-user-payable',
    'reissue-lineage'
  ));

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
  v_passenger_count integer;
  v_total bigint;
  v_single_user_payable bigint;
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
          <> jsonb_array_length(v_booking.passengers->'travellers') then
    return jsonb_build_object(
      'ok', false,
      'code', 'AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE'
    );
  end if;

  v_passenger_count := jsonb_array_length(v_booking.passengers->'travellers');

  if exists (
    select 1
      from jsonb_array_elements(v_booking.passengers->'travellers') traveller(value)
     where traveller.value->>'passengerType'
             not in ('ADT', 'CHD', 'CNN', 'INF', 'INS')
        or nullif(btrim(concat_ws(' ', traveller.value->>'title',
             traveller.value->>'firstName', traveller.value->>'lastName')), '') is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'ENTITLEMENT_PASSENGERS_UNPROVEN');
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

  if v_passenger_count = 1 then
    v_single_user_payable := coalesce(
      nullif(v_booking.user_payable_amount, 0),
      v_booking.captured_amount
    );
    if v_single_user_payable <= 0
       or v_single_user_payable <> v_booking.captured_amount then
      return jsonb_build_object(
        'ok', false,
        'code', 'AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE'
      );
    end if;

    v_allocation_hash := encode(sha256(convert_to(
      concat_ws('|', p_booking_id::text, v_booking.currency,
        'authoritative-single-passenger-user-payable',
        v_single_user_payable::text,
        (v_booking.passengers->'travellers')::text,
        v_booking.ticket_numbers::text),
      'UTF8'
    )), 'hex');

    insert into public.ticket_management_ticket_entitlements (
      booking_id, passenger_index, passenger_snapshot, passenger_name,
      passenger_type, original_ticket_number, active_ticket_number,
      currency, entitlement_amount, user_payable_source_minor,
      allocation_source, allocation_hash
    )
    select
      p_booking_id,
      0,
      traveller.value,
      btrim(concat_ws(' ', traveller.value->>'title',
        traveller.value->>'firstName', traveller.value->>'lastName')),
      traveller.value->>'passengerType',
      upper(btrim(v_booking.ticket_numbers->>0)),
      upper(btrim(v_booking.ticket_numbers->>0)),
      upper(v_booking.currency),
      v_single_user_payable,
      v_single_user_payable,
      'authoritative-single-passenger-user-payable',
      v_allocation_hash
    from jsonb_array_elements(v_booking.passengers->'travellers')
      traveller(value);

    get diagnostics v_count = row_count;
    if v_count <> 1 then
      raise exception 'single-passenger User Payable allocation is incomplete'
        using errcode = '23514';
    end if;
    return jsonb_build_object('ok', true, 'replay', false, 'count', v_count);
  end if;

  if jsonb_typeof(v_booking.fares) <> 'array'
     or jsonb_array_length(v_booking.fares) = 0 then
    return jsonb_build_object(
      'ok', false,
      'code', 'AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE'
    );
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
      'authoritative-user-payable', v_booking.captured_amount::text,
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
      authoritative.passenger_snapshot->>'firstName',
      authoritative.passenger_snapshot->>'lastName')),
    authoritative.passenger_type, authoritative.ticket_number,
    authoritative.ticket_number, upper(v_booking.currency),
    authoritative.user_payable_minor::bigint,
    authoritative.user_payable_minor::bigint,
    'authoritative-user-payable', v_allocation_hash
  from authoritative
  order by authoritative.passenger_index;

  get diagnostics v_count = row_count;
  if v_count <> v_passenger_count then
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

revoke all on function public.ticket_management_ensure_booking_entitlements_v1(uuid)
  from public, anon, authenticated, service_role;

comment on function public.ticket_management_ensure_booking_entitlements_v1(uuid) is
  'Bootstraps immutable ticket entitlements. A single proved passenger/ticket uses reconciled booking-level User Payable; multi-passenger bookings require exact per-passenger User Payable allocation.';
