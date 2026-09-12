# KTT booking references

Existing and future bookings use `KTT` + normalized GDS PNR + the first available airline PNR. Example: `KTT0A4OQT0A4OQT`.

References are assigned by the database when a booking is inserted. When either locator is missing, a booking UUID suffix supplies uniqueness without inventing a locator. Recycled locator combinations also receive a UUID suffix. A later PNR refresh does not change a reference already sent to a customer.

Migration 0161 (fresh-install version 20260911030000) renames existing STR references. `booking_reference_aliases` retains their mapping to the booking ID. Old booking page links resolve through the same role and visibility checks, then redirect to the new reference. Audit snapshots and wallet history remain historical records.

Booking routes, ticket management, refunds, SMS, and exact-reference search accept both KTT and legacy STR syntax. Current actions use the canonical reference returned by the booking page. Refresh an already-open old checkout or booking page after rollout.

Validation: `node scripts/verify-ktt-booking-references.mjs` exercises migration/backfill, new bookings, normalization, repeated and missing PNRs, stable refresh, aliases, and migration reapplication against an isolated PostgreSQL-compatible database.
