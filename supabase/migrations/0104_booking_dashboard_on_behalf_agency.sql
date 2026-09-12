-- The dashboard needs to distinguish the internal colleague who created a
-- booking from the agency whose account the booking belongs to.  Keep both
-- identities in the existing narrow, paginated list projection so rendering
-- the "Created By" cell never requires a per-row lookup.
create or replace view public.booking_dashboard_creator_v
with (security_invoker = true)
as
select
  list.*,
  coalesce(nullif(concat_ws(' ', creator.first_name, creator.last_name), ''), creator.email, '')
    as creator_name,
  coalesce(creator.role, '') as creator_role,
  coalesce(creator.email, '') as creator_email,
  creator.agency_code as creator_agency_code,
  nullif(creator_agency_profile.agency_name, '') as creator_agency_name,
  lower(concat_ws(' ',
    coalesce(creator.first_name, ''), coalesce(creator.last_name, ''),
    coalesce(creator.email, ''), coalesce(creator.role, ''),
    coalesce(creator.agency_code, ''), coalesce(creator_agency_profile.agency_name, ''),
    coalesce(booking.agency_code, ''), coalesce(booking_agency_profile.agency_name, '')
  )) as creator_search_text,
  booking.agency_code as booking_agency_code,
  nullif(booking_agency_profile.agency_name, '') as booking_agency_name
from public.booking_dashboard_list_ordered_v list
join public.flight_bookings booking on booking.id = list.id
left join public.app_users creator
  on creator.clerk_id = coalesce(booking.booked_by_user_id, booking.user_id)
left join public.agencies creator_agency
  on creator_agency.agency_code = creator.agency_code
left join public.user_profiles creator_agency_profile
  on creator_agency_profile.clerk_id = creator_agency.owner_user_id
left join public.agencies booking_agency
  on booking_agency.agency_code = booking.agency_code
left join public.user_profiles booking_agency_profile
  on booking_agency_profile.clerk_id = booking_agency.owner_user_id;

comment on view public.booking_dashboard_creator_v is
  'Paginated booking list with creator and owning-agency identities resolved in one read.';
