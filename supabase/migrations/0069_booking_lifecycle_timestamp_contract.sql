-- Explicit lifecycle timestamp semantics.
--
-- Every timestamp in this migration is an independently stored fact. Missing
-- business time remains NULL: booking creation/update time is never substituted
-- for submission, operation, supplier, case, status, terminal, deadline, or
-- completion time.

-- Future lifecycle events always record when this system observed the status
-- fact. Callers may provide an earlier, authoritative observed_at (for example,
-- from a normalized supplier evidence receipt); otherwise the insert boundary
-- is the observation boundary. effective_at remains nullable unless the
-- business-effective instant is authoritatively known.
create or replace function public.normalize_booking_status_event_time_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.observed_at is null then
    new.observed_at := clock_timestamp();
  end if;
  return new;
end;
$$;

drop trigger if exists booking_status_events_normalize_time
  on public.booking_status_events;
create trigger booking_status_events_normalize_time
  before insert on public.booking_status_events
  for each row execute function public.normalize_booking_status_event_time_v1();

revoke all on function public.normalize_booking_status_event_time_v1()
  from public, anon, authenticated, service_role;

comment on function public.normalize_booking_status_event_time_v1() is
  'Records the exact local observation boundary for new lifecycle events when a caller has no authoritative observed_at; never invents effective_at.';

-- One staff-only, one-row-per-booking contract for the currently relevant
-- operation, case, and latest lifecycle occurrence. IDs expose the provenance
-- of each joined timestamp. Ordering is deterministic and does not rank a row
-- by a fallback timestamp masquerading as another business fact.
create or replace view public.booking_lifecycle_timestamps_v
with (security_invoker = true)
as
select
  booking.id as booking_id,
  operation.id as operation_id,
  reconciliation_case.id as reconciliation_case_id,
  status_event.id as status_event_id,
  status_event.occurrence_id as status_occurrence_id,
  booking.submission_started_at,
  operation.claimed_at as operation_claimed_at,
  operation.supplier_call_started_at,
  operation.supplier_response_received_at,
  reconciliation_case.opened_at as case_opened_at,
  status_event.effective_at as status_effective_at,
  status_event.observed_at as status_observed_at,
  booking.issued_at,
  booking.cancelled_at,
  booking.ticketing_deadline_at,
  operation.completed_at as operation_completed_at
from public.flight_bookings booking
left join lateral (
  select candidate.*
  from public.booking_operations candidate
  where candidate.booking_id = booking.id
  order by
    (candidate.id = booking.active_operation_id) desc nulls last,
    candidate.claimed_at desc,
    candidate.id desc
  limit 1
) operation on true
left join lateral (
  select candidate.*
  from public.booking_reconciliation_cases candidate
  where candidate.subject_booking_id = booking.id
  order by
    (candidate.operation_id = operation.id) desc nulls last,
    (candidate.state in (
      'open', 'assigned', 'awaiting_supplier',
      'awaiting_finance', 'awaiting_approval'
    )) desc,
    candidate.opened_at desc,
    candidate.id desc
  limit 1
) reconciliation_case on true
left join lateral (
  select candidate.*
  from public.booking_status_events candidate
  where candidate.booking_id = booking.id
  order by candidate.id desc
  limit 1
) status_event on true
where not booking.legacy_operational;

revoke all on table public.booking_lifecycle_timestamps_v
  from public, anon, authenticated;
grant select on table public.booking_lifecycle_timestamps_v to service_role;

comment on view public.booking_lifecycle_timestamps_v is
  'Staff-only exact lifecycle timestamp contract. NULL means the fact is unknown; no created_at or updated_at fallback is used.';

comment on column public.flight_bookings.submission_started_at is
  'Instant the booking submission began; NULL when no authoritative submission start was recorded.';
comment on column public.booking_operations.claimed_at is
  'Instant an actor durably claimed the operation identity; not booking creation or submission time.';
comment on column public.booking_operations.supplier_call_started_at is
  'Instant immediately before the irreversible supplier write call began.';
comment on column public.booking_operations.supplier_response_received_at is
  'Instant the complete supplier write response was received; NULL for no complete response.';
comment on column public.booking_reconciliation_cases.opened_at is
  'Instant the owned reconciliation case was opened.';
comment on column public.booking_status_events.effective_at is
  'Business-effective status instant when authoritatively known; NULL must remain unknown.';
comment on column public.booking_status_events.observed_at is
  'Instant this system observed the status fact; all events inserted after migration 0069 record it.';
comment on column public.flight_bookings.issued_at is
  'Authoritative ticket-issuance instant; NULL does not mean the booking was not issued.';
comment on column public.flight_bookings.cancelled_at is
  'Authoritative cancellation instant; NULL does not mean the booking was not cancelled.';
comment on column public.flight_bookings.ticketing_deadline_at is
  'Normalized supplier ticketing deadline when known; never inferred from booking update time.';
comment on column public.booking_operations.completed_at is
  'Instant the durable operation reached succeeded or failed; separate from supplier response time.';
