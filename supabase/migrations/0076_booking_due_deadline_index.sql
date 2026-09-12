-- Keep the expiry sweep on the small, ordered set of actionable deadlines.
-- The stable booking ID is the keyset tie-breaker used by the Phase 8 worker.
create index if not exists flight_bookings_due_expiry_observation_idx
  on public.flight_bookings (ticketing_deadline_at, id)
  where not legacy_operational
    and status = 'on-hold'
    and active_operation_id is null
    and operation_kind is null
    and ticketing_deadline_at is not null
    and public.jsonb_is_nonempty_array(airlines_pnr);

comment on index public.flight_bookings_due_expiry_observation_idx is
  'Ordered expiry-observation candidates only: active On Hold supplier bookings with an airline PNR, a deadline, and no unresolved operation.';
