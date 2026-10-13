# Triplover IndiGo ticket identifiers

Implemented 2026-10-13, following the ticketless identifier policy in the
`shopontravels` frontend and its `shapontravels` Rust backend.

For a saved itinerary whose every segment is IndiGo (`6E`), an issued ticket may
use the verified six-character airline PNR for several passengers. The adapter
retains each passenger's slot and original order; it never deduplicates the party.
Ordinary numeric e-tickets retain their uniqueness checks.

The exception requires server-owned saved airline locators, passengers, itinerary
and accepted supplier amounts. Receipt verification binds PNR/reference echoes,
issued status, flights/dates/booking classes, passenger identities and fare
coverage. Conflicting carriers, locators, passengers or identifiers fail closed.

When the one NewTicket response is insufficient, the adapter may read the
Confirmed ticket report once. That report must establish paid, completed issuance
with a valid issue date and matching transaction, PNR, passengers, flights and
supplier fare. A report never replaces conflicting original identifiers or causes
a second NewTicket call. Missing or incomplete proof keeps reconciliation active.

Triplover reports can repeat the passenger-type party count on every individually
named row. Each row contributes its passenger's fare once. Supplier amounts are
checked separately from the customer's markup and service margin.

A read-only live check of `KTT261013111114` passed the new report verifier for
three ADT passengers using `ODSE8Q`. Supplier payable was BDT 72,845.64 and User
Payable BDT 73,445.64. This check did not change the booking or capture its hold.
Deploying the parser does not automatically resolve existing reconciliation cases.

No booking/capture migration is required. Refund/Reissue/VOID entitlement rules
remain separately gated by their existing ticket uniqueness constraints; this
change does not relax those servicing constraints.

Local verification: `npm run verify:triplover-indigo-ticket`,
`npm run verify:booking-without-pnr`, and `npm run verify:booking-airline-pnr`.
The first suite is included in `verify:ci`; all its supplier transport is mocked.
