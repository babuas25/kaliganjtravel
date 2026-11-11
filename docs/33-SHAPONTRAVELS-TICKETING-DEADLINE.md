# Shapontravels ticketing deadline

The **Refresh Time Limit** action on a Shapon Hold uses the booking's saved
Shapon UUID and STR reference. Live refresh sends one server-side POST to
`/api/bookings/{bookingId}/ticketing-deadline/refresh` with the existing Shapon
machine credentials and API base URL. Vercel Production enables live refresh
by default through the built-in `VERCEL_ENV`, so it needs no separate refresh
flag. The action uses Shapon's saved booking GET when live refresh is disabled.

If Shapon returns HTTP 403 with `FORBIDDEN` (Booking permission),
`DEADLINE_REFRESH_DISABLED`, or `SUPPLIER_SERVICING_DISABLED`, the action
rechecks access and eligibility and shows the effective deadline saved in
Kaliganj, if one is available. The message
says live refresh was unavailable. This fallback makes no further Shapon
requests and does not write a deadline. Other refresh failures remain errors.

Live refresh starts are spaced at least three seconds apart for the same
booking, which allows at most 20 starts in a rolling minute. Kaliganj uses its
shared Postgres rate limiter with a separate live refresh key. The existing
process-local fallback is limited to development. Shapon also enforces its own
booking history, in-flight and machine-client limits. The switch waits for an
in-flight request and shows the remaining cooldown, including `Retry-After`
from Shapon, before allowing another manual attempt.

The independent webhook receives signed
`booking.ticketing_deadline.changed` events at
`POST /api/webhooks/shapon-ticketing-deadline`. It verifies the signature
over the raw body and matches both Shapon references to one native Kaliganj
booking. The database records the event and applies a newer revision together.
The stored supplier deadline still goes through Kaliganj's existing local
deadline authority, including any staff override.

## Configure each environment

1. Apply the [deadline revisions migration](../supabase/fresh-install/supabase/migrations/20261111000000_shapon_booking_deadline_revisions.sql)
   to the Kaliganj database for that environment before deploying the matching
   application. Both refresh and webhook updates use it.
2. Confirm the existing Shapon machine client and supplier settings for that
   environment. In Shapon's **API Management → API Permissions → Ticketing
   Deadline Refresh**, an operator can check and set the supplier-specific
   permission. With Shapon migration `0165`, an absent grant or `NULL` refresh
   setting inherits access for eligible Native agency clients with Enterprise
   API access, Booking permission, a current Native agency owner and its
   canonical wallet, and supplier servicing enabled. Unlinked clients need a
   valid explicit grant. Clearing **Enable** saves an explicit opt-out. Any
   saved `false` remains off, including on an older webhook-only grant.
3. To receive webhooks, use a stable public HTTPS callback on port 443 at the
   Kaliganj route above. Set `SHAPONTRAVELS_DEADLINE_WEBHOOK_SECRET` to the
   dedicated `whsec_` signing key shared privately with Shapon. The receiver
   requires a signing key even in Vercel Production. During rotation,
   `SHAPONTRAVELS_DEADLINE_WEBHOOK_PREVIOUS_SECRET` can temporarily hold the old
   key. Use a distinct destination and signing key for each environment.
4. Have Shapon provision the exact callback and signing revision for the client
   and supplier grants in that environment and run its deadline webhook worker.
   `TICKETING_DEADLINE_WEBHOOK_DESTINATIONS` and
   `TICKETING_DEADLINE_WEBHOOK_WORKER_ENABLED` are configured on Shapon's worker.
   Delivery starts with new verified deadline changes.

Keep Vercel system environment variables available to the deployment and leave
the flags unset to use the Production defaults. Both features default off
outside Vercel Production. Set `SHAPONTRAVELS_DEADLINE_REFRESH_ENABLED=true` or
`SHAPONTRAVELS_DEADLINE_WEBHOOK_ENABLED=true` to opt in independently. An explicit
`false` disables the corresponding feature in any environment.

Run `npm run verify:shapon-deadline` to verify signed synthetic events and
the deadline transaction against a disposable database. Run
`npm run verify:booking-ticketing-time` for the booking-scoped refresh action.
