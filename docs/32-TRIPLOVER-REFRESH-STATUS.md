# Triplover Refresh Status

Admin and Super Admin can use **Refresh Status** in the booking detail sidebar
for native Triplover API bookings with complete saved references. The panel
also works for On Hold and In Progress bookings. Imported, legacy and direct
ticketing bookings retain their own workflows.

Refresh makes two bounded supplier reads: PNR and the independent confirmed
ticket report. It records an immutable check and shows the saved local status,
payment state, checked supplier status, PNR, each passenger's ticket identifiers
and the verification time in Asia/Dhaka. Refresh does not issue, cancel, capture
a hold, change booking status or send confirmation messages.

An Active PNR alone does not prove ticket issuance. Issued proof requires the
saved transaction, passenger identities and counts, itinerary, fares, currency,
paid/completed report and every passenger's ticket identifiers to match. A
shared IndiGo airline PNR is accepted only for an all-6E, non-codeshare itinerary
with that saved airline locator. Other carriers require distinct numeric ticket
numbers. Conflicting, cancelled, refunded, voided, reissued or incomplete report
evidence cannot authorize a capture.

## Confirming an already issued ticket

After verified Issued evidence, **Review confirmation** requests a database
preview. Confirmation is eligible only for the original native NewTicket
operation in reconciliation after its recorded HTTP 200 response, its unproposed
ticketing uncertainty case, and its exact existing protected wallet reservation.
The check must be the latest, less than five minutes old, and match the current
booking and financial footprint.

The preview shows the exact capture amount and Available/Hold balances before
and after. The operator checks the explicit consent box, then selects
**Confirm issued ticket**. In one transaction the database captures that
reservation, records one booking-confirm ledger entry, confirms the booking,
preserves per-passenger identifiers, resolves the original operation/case and
creates the usual lifecycle/outbox event. Available balance stays unchanged;
other bookings' holds remain protected. No NewTicket request is sent.

This command cannot debit fresh Available balance, release a hold, refund,
confirm without payment, override unrelated operations/proposals or settle an
already confirmed booking. Those cases use the existing review workflows.

A changed preview or stale check requires another refresh and review. An
ambiguous confirmation response preserves the original request ID, check ID and
preview hash; the panel freezes other choices and retries the same intent. The
database returns its saved result before checking expiry, so retry cannot
capture twice even if the supplier is offline. Verified Issued evidence also
blocks new Issue/Cancel operation claims after the check expires or a later
supplier read becomes inconclusive.

## API and database

- `POST /api/flights/booking/refresh-status`: scoped staff read, database context,
  supplier proof, immutable status-check record; no financial mutation.
- `POST /api/flights/booking/confirm-supplier-ticket`: strict preview/confirm
  commands; browser-supplied status, supplier facts and amounts are rejected.
- Forward migration:
  `supabase/fresh-install/supabase/migrations/20261013000000_triplover_supplier_status_confirmation.sql`.
  Use only the fresh-install workdir; the installed baseline is frozen.
- Both records have RLS and immutable rows. Only service-role RPCs can write;
  the database independently verifies the canonical Admin/Super Admin role.

Run `npm run verify:triplover-status`, `npm run typecheck`, `npm run lint` and
`npm run build`. The feature tests use offline supplier fixtures, actual client
handlers and the complete fresh-install migration chain in disposable PGlite.
Live deployment/readback is verified separately.
