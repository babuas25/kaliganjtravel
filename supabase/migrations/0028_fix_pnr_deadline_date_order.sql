-- PNR lastTicketTime is DD/MM/YYYY. The application previously treated it as
-- MM/DD/YYYY, so ambiguous dates could be stored with day and month swapped.
-- Repair only rows whose parsed deadline is already before the booking while
-- the swapped interpretation is on or after it. The supplier's clock portion
-- is preserved exactly; only the calendar components are corrected.
with candidates as (
  select
    id,
    regexp_match(
      ticketing_time_limit,
      '^([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$'
    ) as parts
  from public.flight_bookings
  where legacy_operational = false
    and ticketing_deadline_at < created_at
    and ticketing_time_limit ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
), corrected as (
  select
    id,
    make_timestamptz(
      parts[1]::integer,
      parts[3]::integer,
      parts[2]::integer,
      parts[4]::integer,
      parts[5]::integer,
      parts[6]::double precision,
      'Asia/Dhaka'
    ) as deadline_at,
    format(
      '%s-%s-%s %s:%s:%s',
      parts[1], parts[3], parts[2], parts[4], parts[5], parts[6]
    ) as normalized_limit
  from candidates
  where parts is not null
    and parts[2]::integer between 1 and 12
    and parts[3]::integer between 1 and 12
)
update public.flight_bookings booking
set ticketing_deadline_at = corrected.deadline_at,
    ticketing_time_limit = corrected.normalized_limit
from corrected
where booking.id = corrected.id
  and corrected.deadline_at >= booking.created_at;
