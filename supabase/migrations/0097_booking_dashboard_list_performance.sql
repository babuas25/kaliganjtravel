-- A deliberately narrow, list-only projection for the bookings dashboard.
-- It avoids transferring booking snapshots, passenger documents, raw supplier
-- references, and every historic lifecycle event just to render one table page.
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
  nullif(booking.supplier_refs ->> 'uniqueTransId', '') as supplier_reference,
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
left join public.app_users user_record
  on user_record.clerk_id = booking.user_id;

revoke all on table public.booking_dashboard_list_v
  from public, anon, authenticated;
grant select on table public.booking_dashboard_list_v to service_role;

-- The user and global paths are both ordered by newest booking. The existing
-- user index handles the former; this covers agencies without widening the
-- index to legacy operational records.
create index if not exists flight_bookings_agency_dashboard_created_idx
  on public.flight_bookings (agency_code, created_at desc)
  where not legacy_operational;

-- The lateral latest-event lookup above is intentionally one indexed row per
-- visible booking. Keep this explicit in case old environments predate 0031.
create index if not exists booking_status_events_booking_created_idx
  on public.booking_status_events (booking_id, created_at desc);

comment on view public.booking_dashboard_list_v is
  'Narrow, paginated dashboard projection with the latest lifecycle timestamp and creator email in one read.';
