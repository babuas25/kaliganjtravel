-- Narrow forward correction for authoritative MANUAL single-passenger bookings.
--
-- The 0128 allocator remains intact behind a revoked internal helper. This
-- wrapper adds one exception only: a MANUAL booking with exactly one proved
-- passenger, exactly one unique proved ticket, positive booking-level User
-- Payable, and an exact User Payable/Captured/resolved-entitlement match.
-- IMP_EXP, MANUAL multi-passenger, ambiguous, missing, and mismatched imported
-- allocations remain fail-closed.
--
-- This migration only replaces function definitions. It does not backfill or
-- modify booking, pricing, wallet, entitlement, request, or ledger rows.

alter function public.ticket_management_ensure_booking_entitlements_v1(uuid)
  rename to ticket_management_ensure_booking_entitlements_pre_0129_v1;

revoke all on function
  public.ticket_management_ensure_booking_entitlements_pre_0129_v1(uuid)
  from public, anon, authenticated, service_role;

create function public.ticket_management_ensure_booking_entitlements_v1(
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
  v_resolved_entitlement bigint;
  v_allocation_hash text;
begin
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  -- Every non-MANUAL booking, including IMP_EXP, retains the exact 0128 path.
  -- That path continues to reject imported bookings under its original gate.
  if v_booking.import_source is distinct from 'MANUAL' then
    return public.ticket_management_ensure_booking_entitlements_pre_0129_v1(
      p_booking_id
    );
  end if;

  -- MANUAL bookings do not receive the captured-amount fallback used by 0128
  -- for ordinary single-passenger bookings. Their booking-level User Payable
  -- must itself be present, positive, and exactly reconciled to capture.
  v_resolved_entitlement := nullif(v_booking.user_payable_amount, 0);
  if v_booking.captured_amount <= 0
     or v_booking.refunded_amount <> 0
     or v_booking.payment_state <> 'captured'
     or v_booking.charged_wallet_account_id is null
     or v_resolved_entitlement is null
     or v_resolved_entitlement <= 0
     or v_resolved_entitlement <> v_booking.user_payable_amount
     or v_resolved_entitlement <> v_booking.captured_amount
     or jsonb_typeof(v_booking.passengers->'travellers') <> 'array'
     or jsonb_array_length(v_booking.passengers->'travellers') <> 1
     or jsonb_typeof(v_booking.ticket_numbers) <> 'array'
     or jsonb_array_length(v_booking.ticket_numbers) <> 1 then
    return jsonb_build_object(
      'ok', false,
      'code', 'AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE'
    );
  end if;

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
  ) <> 1 then
    return jsonb_build_object('ok', false, 'code', 'ENTITLEMENT_TICKETS_UNPROVEN');
  end if;

  select count(*) into v_count
    from public.ticket_management_ticket_entitlements entitlement
   where entitlement.booking_id = p_booking_id
     and entitlement.predecessor_entitlement_id is null;
  if v_count > 0 then
    return jsonb_build_object('ok', true, 'replay', true, 'count', v_count);
  end if;

  v_allocation_hash := encode(sha256(convert_to(
    concat_ws('|', p_booking_id::text, upper(v_booking.currency),
      'authoritative-single-passenger-user-payable', 'MANUAL',
      v_resolved_entitlement::text,
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
    v_resolved_entitlement,
    v_booking.user_payable_amount,
    'authoritative-single-passenger-user-payable',
    v_allocation_hash
  from jsonb_array_elements(v_booking.passengers->'travellers') traveller(value);

  get diagnostics v_count = row_count;
  if v_count <> 1 then
    raise exception 'MANUAL single-passenger User Payable allocation is incomplete'
      using errcode = '23514';
  end if;

  return jsonb_build_object('ok', true, 'replay', false, 'count', v_count);
end;
$$;

revoke all on function public.ticket_management_ensure_booking_entitlements_v1(uuid)
  from public, anon, authenticated, service_role;

comment on function public.ticket_management_ensure_booking_entitlements_v1(uuid) is
  'Bootstraps immutable ticket entitlements. A fully reconciled MANUAL single-passenger/single-ticket booking may use booking-level User Payable; all other imported bookings remain fail-closed.';

comment on function
  public.ticket_management_ensure_booking_entitlements_pre_0129_v1(uuid) is
  'Internal 0128 allocator retained by migration 0129. Direct execution remains revoked.';
