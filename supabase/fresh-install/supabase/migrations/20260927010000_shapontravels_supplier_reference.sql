-- Shapontravels' stable STR reference is carried in X-Booking-Reference.
-- The Book body bookingRefNumber and uniqueTransID are different UUIDs; keep
-- both intact for supplier reconciliation and future operations.
alter table public.flight_bookings
  add column if not exists supplier_public_ref text;
alter table public.flight_bookings
  add constraint flight_bookings_supplier_public_ref_check
  check (supplier_public_ref is null or
    (supplier = 'shapontravels' and supplier_public_ref ~ '^STR[A-Z0-9]{6,32}$'));
create unique index if not exists flight_bookings_supplier_public_ref_idx
  on public.flight_bookings (supplier_public_ref)
  where supplier_public_ref is not null;

-- The existing v2 finalizer and this update run in one database transaction.
-- A bad/missing STR header rolls the entire booking finalization back, leaving
-- the attempt for the existing uncertainty and reconciliation path.
create or replace function public.create_shapontravels_booking_from_attempt_v1(
  p_attempt_id uuid,
  p_request_key text,
  p_request_payload_hash text,
  p_outcome jsonb
)
returns public.flight_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.booking_attempts;
  v_booking public.flight_bookings;
  v_reference text;
begin
  select * into v_attempt
    from public.booking_attempts
   where id = p_attempt_id
   for update;
  if not found or v_attempt.supplier <> 'shapontravels'
     or v_attempt.supplier_account <> 'shapontravels' then
    raise exception 'Shapontravels booking attempt binding is missing'
      using errcode = '23514';
  end if;
  v_reference := p_outcome->>'supplierPublicRef';
  if v_reference is null or v_reference !~ '^STR[A-Z0-9]{6,32}$' then
    raise exception 'Shapontravels booking reference is missing or invalid'
      using errcode = '22023';
  end if;

  v_booking := public.create_booking_from_attempt_v2(
    p_attempt_id, p_request_key, p_request_payload_hash, p_outcome
  );
  update public.flight_bookings
     set supplier_public_ref = v_reference
   where id = v_booking.id
     and supplier = 'shapontravels'
  returning * into v_booking;
  if not found then
    raise exception 'Shapontravels booking finalization lost its row'
      using errcode = 'P0002';
  end if;
  return v_booking;
end;
$$;

revoke all on function public.create_shapontravels_booking_from_attempt_v1(
  uuid, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.create_shapontravels_booking_from_attempt_v1(
  uuid, text, text, jsonb
) to service_role;

-- Keep the paginated dashboard projection narrow. Show STR for Shapontravels,
-- while existing Triplover accounts continue to show uniqueTransId.
create or replace view public.booking_dashboard_list_v
with (security_invoker = true)
as
select
  booking.id,
  booking.public_ref,
  booking.user_id,
  booking.agency_code,
  booking.status,
  booking.lifecycle_status,
  booking.operation_kind,
  booking.operation_reason,
  booking.operation_started_at,
  booking.created_at,
  booking.issued_at,
  booking.cancelled_at,
  booking.ticketing_deadline_at,
  latest_event.created_at as last_lifecycle_event_at,
  case
    when supplier_booking.supplier = 'shapontravels'
      then nullif(supplier_booking.supplier_public_ref, '')
    else nullif(booking.supplier_refs ->> 'uniqueTransId', '')
  end as supplier_reference,
  coalesce(
    (
      select string_agg(value, ', ')
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(booking.airlines_pnr) = 'array'
            then booking.airlines_pnr
          else '[]'::jsonb
        end
      ) as value
    ),
    ''
  ) as airline_pnr,
  coalesce(booking.pnr, '') as pnr,
  nullif(
    concat_ws(
      ' ',
      booking.passengers #>> '{travellers,0,firstName}',
      booking.passengers #>> '{travellers,0,lastName}'
    ),
    ''
  ) as lead_name,
  jsonb_array_length(
    case
      when jsonb_typeof(booking.passengers -> 'travellers') = 'array'
        then booking.passengers -> 'travellers'
      else '[]'::jsonb
    end
  ) as traveller_count,
  booking.passenger_counts,
  coalesce(nullif(booking.pricing_snapshot ->> 'sellingPrice', '')::numeric, 0) as fare,
  nullif(booking.pricing_snapshot ->> 'grossPrice', '')::numeric as gross,
  coalesce(
    (
      select string_agg(
        concat_ws('-', leg ->> 'from', leg ->> 'to'),
        ', '
      )
      from jsonb_array_elements(
        case
          when jsonb_typeof(booking.itinerary -> 'legs') = 'array'
            then booking.itinerary -> 'legs'
          else '[]'::jsonb
        end
      ) as leg
    ),
    ''
  ) as route,
  coalesce(nullif(booking.itinerary ->> 'carrierCode', ''), '—') as airline,
  coalesce(
    nullif(booking.itinerary #>> '{legs,0,segments,0,departure}', ''),
    booking.travel_date::text
  ) as fly_date,
  nullif(booking.pricing_snapshot ->> 'supplierTotalPrice', '')::numeric
    as supplier_payable,
  coalesce(nullif(booking.pricing_snapshot ->> 'sellingPrice', '')::numeric, 0)
    - coalesce(
      nullif(booking.pricing_snapshot ->> 'supplierTotalPrice', '')::numeric,
      0
    ) as profit,
  coalesce(user_record.email, '') as booking_user_email,
  booking.import_source,
  booking.payment_state,
  case
    when booking.lifecycle_status = 'in-progress'
      then booking.operation_started_at
    when booking.lifecycle_status = 'confirmed'
      then booking.issued_at
    when booking.lifecycle_status = 'expired'
      then coalesce(booking.ticketing_deadline_at, latest_event.created_at)
    when booking.lifecycle_status = 'cancelled'
      then coalesce(booking.cancelled_at, latest_event.created_at)
    when booking.lifecycle_status = 'unconfirmed'
      then latest_event.created_at
    else null
  end as lifecycle_at,
  coalesce(
    nullif(
      concat_ws(
        ' ',
        booking.passengers #>> '{travellers,0,firstName}',
        booking.passengers #>> '{travellers,0,lastName}'
      ),
      ''
    ),
    ''
  ) as sort_name,
  lower(
    concat_ws(
      ' ',
      booking.public_ref,
      supplier_booking.supplier_public_ref,
      booking.pnr,
      coalesce(
        (
          select string_agg(value, ' ')
          from jsonb_array_elements_text(
            case
              when jsonb_typeof(booking.airlines_pnr) = 'array'
                then booking.airlines_pnr
              else '[]'::jsonb
            end
          ) as value
        ),
        ''
      ),
      booking.passengers #>> '{travellers,0,firstName}',
      booking.passengers #>> '{travellers,0,lastName}',
      user_record.email
    )
  ) as search_text,
  case
    when coalesce((booking.passenger_counts ->> 'ADT')::integer, 0) > 0
      then 'Adult ' || (booking.passenger_counts ->> 'ADT')
    else ''
  end || case
    when coalesce((booking.passenger_counts ->> 'CHD')::integer, 0)
      + coalesce((booking.passenger_counts ->> 'CNN')::integer, 0) > 0
      then ', Child ' || (
        coalesce((booking.passenger_counts ->> 'CHD')::integer, 0)
        + coalesce((booking.passenger_counts ->> 'CNN')::integer, 0)
      )
    else ''
  end || case
    when coalesce((booking.passenger_counts ->> 'INF')::integer, 0)
      + coalesce((booking.passenger_counts ->> 'INS')::integer, 0) > 0
      then ', Infant ' || (
        coalesce((booking.passenger_counts ->> 'INF')::integer, 0)
        + coalesce((booking.passenger_counts ->> 'INS')::integer, 0)
      )
    else ''
  end as passenger_type
from public.booking_lifecycle_v booking
left join lateral (
  select event.created_at
  from public.booking_status_events event
  where event.booking_id = booking.id
  order by event.created_at desc
  limit 1
) latest_event on true
left join public.flight_bookings supplier_booking
  on supplier_booking.id = booking.id
left join public.app_users user_record
  on user_record.clerk_id = booking.user_id;


comment on column public.flight_bookings.supplier_public_ref is
  'Verified Shapontravels X-Booking-Reference (STR), separate from the Book receipt UUIDs.';
comment on function public.create_shapontravels_booking_from_attempt_v1(
  uuid, text, text, jsonb
) is
  'Atomically finalizes a verified Shapontravels hold and its stable STR reference.';
