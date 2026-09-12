-- VOID requests may only be created from the issue instant until 23:30 on
-- that same Asia/Dhaka calendar day. The trigger protects every insert path,
-- including future service-side callers that do not pass through the web API.

create or replace function public.ticket_management_void_request_window_open_v1(
  p_issued_at timestamptz,
  p_now timestamptz default clock_timestamp()
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select p_issued_at is not null
    and p_now >= p_issued_at
    and (p_now at time zone 'Asia/Dhaka')::date =
        (p_issued_at at time zone 'Asia/Dhaka')::date
    and (p_now at time zone 'Asia/Dhaka')::time < time '23:30:00';
$$;

create or replace function public.enforce_ticket_management_void_request_window_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_issued_at timestamptz;
begin
  if new.action <> 'void' then
    return new;
  end if;

  select booking.issued_at
    into v_issued_at
    from public.flight_bookings booking
   where booking.id = new.booking_id;

  if not public.ticket_management_void_request_window_open_v1(
    v_issued_at,
    clock_timestamp()
  ) then
    raise exception 'VOID_REQUEST_WINDOW_CLOSED' using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger ticket_management_requests_void_window_guard
  before insert on public.ticket_management_requests
  for each row execute function public.enforce_ticket_management_void_request_window_v1();

revoke all on function public.ticket_management_void_request_window_open_v1(
  timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.enforce_ticket_management_void_request_window_v1()
  from public, anon, authenticated;

grant execute on function public.ticket_management_void_request_window_open_v1(
  timestamptz, timestamptz
) to service_role;
grant execute on function public.enforce_ticket_management_void_request_window_v1()
  to service_role;

comment on function public.ticket_management_void_request_window_open_v1(
  timestamptz, timestamptz
) is
  'True only from ticket issuance until, but excluding, 23:30 Asia/Dhaka on the same local calendar date.';
