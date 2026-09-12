-- Keep the server-side request boundary aligned with the booking action UI.
-- Only confirmed tickets can create requests. Instant-issued and imported
-- tickets expose Reissue only; Refund and VOID remain unavailable.

create or replace function public.ticket_management_action_available_for_booking_v1(
  p_action text,
  p_status text,
  p_direct_ticketing boolean,
  p_import_source text,
  p_booking_origin text
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_action in ('refund', 'reissue', 'void')
    and p_status = 'confirmed'
    and (
      p_action = 'reissue'
      or not (
        coalesce(p_direct_ticketing, false)
        or coalesce(p_import_source, '') in ('IMP_EXP', 'MANUAL')
        or coalesce(p_booking_origin, '') = 'supplier_reference_import'
      )
    );
$$;

create or replace function public.enforce_ticket_management_action_availability_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
begin
  select booking.*
    into v_booking
    from public.flight_bookings booking
   where booking.id = new.booking_id;

  if found and not public.ticket_management_action_available_for_booking_v1(
    new.action,
    v_booking.status,
    v_booking.direct_ticketing,
    v_booking.import_source,
    v_booking.booking_origin
  ) then
    raise exception 'TICKET_MANAGEMENT_ACTION_UNAVAILABLE'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger ticket_management_requests_action_availability_guard
  before insert on public.ticket_management_requests
  for each row execute function public.enforce_ticket_management_action_availability_v1();

revoke all on function public.ticket_management_action_available_for_booking_v1(
  text, text, boolean, text, text
) from public, anon, authenticated;
revoke all on function public.enforce_ticket_management_action_availability_v1()
  from public, anon, authenticated;

grant execute on function public.ticket_management_action_available_for_booking_v1(
  text, text, boolean, text, text
) to service_role;
grant execute on function public.enforce_ticket_management_action_availability_v1()
  to service_role;

comment on function public.ticket_management_action_available_for_booking_v1(
  text, text, boolean, text, text
) is
  'Allows all request actions for standard confirmed tickets, Reissue only for instant/imported confirmed tickets, and no actions for other statuses.';
