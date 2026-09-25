# Shapontravels API integration plan

_Planning snapshot: 2026-09-25. This document is a handoff for future chats, not an API contract or an implementation record._

## Goal and working agreement

Add Shapontravels to KaligonjTours as another flight supplier, alongside the existing supplier flow. Implement the integration as an external developer would: use only the Shapontravels developer-facing documentation, issued API client credentials, and accessible test environment. Do not use the Shapontravels backend source, database, internal logs, or privileged shortcuts to discover the contract or make a failing call work. Record every documentation gap and integration obstacle so the final guide reflects a real third-party onboarding experience.

The user asked for this planning file **before** authorizing integration work. Creating this document does not authorize API calls, implementation, pushes, deployment, database migration, or live booking/ticketing. Continue only after the user's next instruction.

## Current checkpoint

- Project: `/Users/ashifbabu/Projects/KaligonjTours` (Next.js, Node 24, npm).
- Branch when checked: `main`, equal to `origin/main`, with no uncommitted changes **before this planning file**.
- On 2026-09-25, the local app on port 3000 returned HTTP 200 for `/`, `/sign-in`, and `/api/airports`. This was a point-in-time smoke check, not a supplier-flow test.
- This document is the only intended repository change at this checkpoint. Check `git status` again when resuming.
- No Shapontravels API contract, base URL, scope list, or credential values have been verified yet. Never put credentials or tokens in this file, logs, fixtures, or commits.

## Existing KaligonjTours architecture to account for

- [Supplier integration overview](09-SUPPLIER-INTEGRATION.md), [flight search](05-FLIGHT-SEARCH.md), [booking](07-BOOKING-SYSTEM.md), and [booking lifecycle](08-BOOKING-LIFECYCLE.md) describe the current flow.
- [`lib/triplover/config.ts`](../lib/triplover/config.ts) names `firsttrip`, `takeoff`, and `triplover`. These are credential accounts for the **same Triplover protocol**. Shapontravels must not be added to that list unless its published API actually uses that protocol.
- [`lib/db/supplier-controls.ts`](../lib/db/supplier-controls.ts) currently selects **one** active account for a new search. [`app/api/flights/search/route.ts`](../app/api/flights/search/route.ts) invokes that account. Supporting another supplier in search results may require an explicit multi-supplier execution and result-merging design, not just another environment variable.
- Search quote → booking attempt → booking keeps its selected supplier account, so later operations use the original account even if the admin selection changes. Preserve an equally strict supplier and offer binding for Shapontravels; never route an existing quote/booking to a different supplier.
- Reprice and fare rules are in [`app/api/flights/reprice/route.ts`](../app/api/flights/reprice/route.ts) and [`app/api/flights/fare-rules/route.ts`](../app/api/flights/fare-rules/route.ts). Booking, issue, cancel, and refresh routes under [`app/api/flights/booking/`](../app/api/flights/booking/) include Triplover-specific paths or guards. Audit all of these before enabling Shapontravels offers for checkout.
- KaligonjTours currently enforces BDT-only booking prices. Reject unsupported supplier currencies until there is a separately agreed conversion design; see [README](../README.md).
- The new project's migration workdir is `supabase/fresh-install`; read its [README](../supabase/fresh-install/README.md) before any schema work. A supplier identifier or operational control may need a forward migration.

These are preliminary code-reading findings, not a completed dependency audit.

## Ordered work after authorization

### 1. External onboarding and evidence log

Collect the same materials a third-party developer would receive: official API docs or OpenAPI spec, test and production base URLs, client ID/secret delivery method, allowed scopes, test account, IP allowlist requirements, rate limits, and support contact. Verify the authentication flow from those materials. Create a dated, sanitized integration log with the documented expectation, actual HTTP status/shape, and any workaround or question for the API owner. Do not infer an undocumented contract from Shapontravels backend access.

### 2. Read-only API discovery

Using test credentials, exercise authentication and read-only operations first: flight search, offer details/fare rules, repricing or price confirmation, and booking/PNR lookup if documented. Record field meanings, missing/null cases, currency and time-zone rules, token expiry, timeout behavior, rate limits, and error envelopes. Keep complete raw responses only in a safe local location; commit sanitized examples with all personal data, tokens, and secrets removed.

### 3. Supplier boundary design

Define a separate server-only Shapontravels client and operation adapters. Map its offer/segment/passenger/fare/rules data into KaligonjTours' existing domain without changing Triplover-specific semantics. Decide how both suppliers' searches run, how results identify their source, how duplicates are handled, and how a chosen offer retains its supplier identity through reprice, booking, ticketing, cancellation, status reads, and reconciliation. Document any Shapontravels operation the API does not support and keep that capability unavailable in the UI.

### 4. Incremental implementation

Implement credentials and token handling, safe timeouts and retries for reads, defensive response parsing, and clear redacted diagnostics. Add search and quote binding first; then fare rules and reprice. Extend checkout/booking only after the complete downstream lifecycle is mapped. Supplier writes such as Book, Issue, and Cancel need idempotency or an explicit uncertain-outcome recovery path; never automatically repeat a write merely because the HTTP response timed out. Keep operational controls able to disable Shapontravels booking and ticketing separately while search is tested.

### 5. Verification

Use sanitized supplier fixtures for mapping and error tests, then run the documented test-environment flows end to end. Cover authentication failure, expired token, empty search, changed price, malformed/partial response, non-BDT currency, timeout, and supplier outage. Check that existing Triplover searches and bookings still work and that a Shapontravels offer cannot be repriced or booked with Triplover credentials. Live financial or ticket-issuing calls require a separately agreed test case and account.

### 6. Developer-facing documentation

Write a separate integration guide based on what actually worked: prerequisites, credential setup using variable names only, authentication, copyable sanitized request/response examples, search-to-booking sequence, error handling, rate limits, troubleshooting, and known API/documentation gaps. Update this plan's progress and decision log as work proceeds so a later chat can resume without reconstructing the investigation.

## Decisions and inputs still needed

1. The public OpenAPI and configured API client now establish token, Search, FareRules, and Reprice read contracts. A separate UAT host, IP allowlist policy, support contact, and guaranteed rate budget are still unknown.
2. Confirm whether later Shapontravels booking, ticket issue, cancellation, status/PNR, and refunds are in scope before building those operations.
3. The user chose one Super Admin-selected supplier at a time. A Shapontravels offer must keep its own provider identity and must not be routed through a Triplover account.
4. Establish a test-environment booking/ticketing policy, including safe test passengers and any charge or issuance implications, before a supplier write.

## Resume checklist for a new chat

1. Read this plan and the linked KaligonjTours architecture docs; check current branch, `git status`, and local server status.
2. Reconfirm the user's authorization and the supplied external developer materials. Do not consult the Shapontravels backend to fill documentation gaps.
3. Start with the external onboarding evidence log, then update the plan as verified facts replace assumptions.
4. Keep secrets out of Git and distinguish local testing from any future push, migration, or deployment request.

## Progress / decisions

| Date | Status | Evidence or decision |
| --- | --- | --- |
| 2026-09-25 | Planning only | KaligonjTours local smoke check passed; working tree was clean before this file. No Shapontravels API call or integration code change. |
| 2026-09-26 | Authorized read-only Search probe | The three API-client values were present in KaligonjTours `.env.local` (values not recorded). The public `/openapi.json` and `/docs/` returned HTTP 200. Following the public OpenAPI contract, `POST /auth/token` returned 200, `GET /auth/me` returned 200 with the configured client ID and `search:read`, and a one-way DAC→CXB `POST /api/Search` for 2026-10-16 returned 200 with 67 offers and `X-Search-Partial: false`. Search request ID: `4d4e7b11-b7a4-4a5b-b8c7-ac19802ff9f0`. No raw response, token, secret, booking, ticketing, supplier integration code, push, or deployment was created. |
| 2026-09-26 | Next read-only milestone | A fresh Search, FareRules, and Reprice call for one complete direction all returned HTTP 200. The selected Reprice returned BDT, a price reference, unchanged price, and `bookable: true`. A separate server-only read client was added and its live Search returned 67 offers. The user chose one Super Admin-selected supplier at a time. Detailed evidence and remaining gaps: [read-only evidence](28-SHAPONTRAVELS-READ-ONLY-EVIDENCE.md). No supplier write, UI activation, database migration, push, or deployment. |
| 2026-09-26 | Local read-only integration | The user selected Search + FareRules + Reprice with booking disabled. Super Admin supplier selection, read routing, provider-bound Redis quotes, exact payable mapping, Search controls, and booking Prepare guard were implemented locally. The forward migration passed disposable PGlite testing but was not applied to the hosted database. Live read verification produced 67 offers, 22 cards, 99 private fare references, three FareRules sections, and matching Reprice segment identity. See [read-only evidence](28-SHAPONTRAVELS-READ-ONLY-EVIDENCE.md) and [integration guide](29-SHAPONTRAVELS-READ-ONLY-GUIDE.md). No supplier write, push, or deployment. |
| 2026-09-26 | Hosted schema ready | The user authorized database migration and push, and requested a new `development` branch. The sole pending forward migration was applied to the linked Kaliganj database. A second dry run is up to date; the new supplier limit row exists and the active supplier remains Triplover. Full CI, lint, typecheck, production build, and read-only supplier checks passed. Application rollout remains separate. |

The current milestone covers provider selection, customer Search routing, FareRules, Reprice, quote binding, payable pricing, and the hosted schema. Application deployment and Super Admin selection remain separate. Booking, ticketing, and the downstream lifecycle remain future work.
