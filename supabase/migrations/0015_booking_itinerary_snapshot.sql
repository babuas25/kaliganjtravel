-- Checkout renders the flights, the per-passenger money and the passport rule
-- from the draft alone, so none of it may depend on the Search results page
-- still being open (or on the 20-minute quote row still existing).
--
-- All three are nullable: drafts created before this migration keep working,
-- and the checkout page degrades to the totals it already had.

alter table public.flight_bookings
  add column if not exists itinerary jsonb
    check (itinerary is null or jsonb_typeof(itinerary) = 'object');

alter table public.flight_bookings
  add column if not exists fares jsonb
    check (fares is null or jsonb_typeof(fares) = 'array');

-- Null means "unknown, ask for a passport" — the safe default for any row
-- written before the country rule existed.
alter table public.flight_bookings
  add column if not exists passport_required boolean;
