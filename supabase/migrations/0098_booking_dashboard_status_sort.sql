-- The dashboard's status column has a business order rather than an
-- alphabetical order. Keep it in a thin wrapper so the narrow list projection
-- remains reusable and PostgREST can order it before pagination.
create or replace view public.booking_dashboard_list_ordered_v
with (security_invoker = true)
as
select
  booking.*,
  case booking.lifecycle_status
    when 'on-hold' then 0
    when 'pending' then 1
    when 'in-progress' then 2
    when 'confirmed' then 3
    when 'unconfirmed' then 4
    when 'expired' then 5
    when 'cancelled' then 6
    else 99
  end as status_order
from public.booking_dashboard_list_v booking;

revoke all on table public.booking_dashboard_list_ordered_v
  from public, anon, authenticated;
grant select on table public.booking_dashboard_list_ordered_v to service_role;

comment on view public.booking_dashboard_list_ordered_v is
  'Dashboard list projection with the product-defined lifecycle sort order.';
