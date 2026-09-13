# Local UAT recovery fixes — 13 September 2026

## Implemented locally

- Checkout attempt reads previously returned null for storage errors, producing DRAFT_NOT_FOUND/BOOKING_NOT_FOUND. They now distinguish missing rows from unavailable storage. Draft, submit and status routes return HTTP 503 BOOKING_STORAGE_UNAVAILABLE for failed reads, including thrown network errors. Genuine missing or unauthorized records retain their existing responses.
- Booking details use strict storage reads, including legacy-reference resolution. Storage failure reaches a retryable page error boundary rather than a false 404. Other service callers retain their established default read contract. User/agency and hidden-booking filters remain in place.
- The checkout confirmation control now locks after unknown, already-started or terminal supplier outcomes and after a lost submission response. Recovery continues through the read-only status endpoint. There is no automatic Book/NewTicket replay and no change to the server claim guard.
- HTTP-200 supplier Search failures now surface as SUPPLIER_SEARCH_REJECTED (HTTP 502, or an SSE error), distinct from network failure and a successful empty result. Raw supplier messages are not exposed to the browser.
- Search excludes adjoining same-airport legs whose next departure is at or before the preceding arrival. Valid overnight returns remain available; different-airport local times are not compared without timezone evidence.
- Operating-carrier labels use explicit supplier fields only. Missing operating-carrier data no longer falls back to airlineCode. Supplier codeshare flags are retained.
- A supplier no-eligible-fare rejection displays a neutral "No eligible fare found" notice. Other transport and supplier errors retain their own handling.
- Booking uncertainty is displayed as "Unconfirmed". Backend unknown states, error codes and duplicate-submission safeguards are unchanged.

## Local observations

- Local JSR–CXB, 24 September, 1 adult reproduced a supplier business failure: HTTP 200, error kind supplier, active account triplover. Trace acdc5347-c57b-4000-97b7-22cf2238ce8b. The search usage record and SSE stream finalized. This is not evidence of unavailable inventory and not a local timeout.
- Repeating the same search after the fix displayed the new supplier-specific failure message in the local browser.
- Original and separately authorized different-date TC012/TC013 attempts remain unconfirmed with no returned PNR. The original attempts were not replayed. Details are retained in the local supplier workbook.

## Still externally blocked

The user has deferred test-environment inventory gaps; production availability remains unverified. The Student fareType enum is not defined by the supplied documentation. Actual operating carriers require explicit supplier data. No fare values, carrier identities or successful PNRs were fabricated to satisfy the test matrix.

## Validation

- npm run typecheck
- ESLint on changed application files and verifier scripts
- node scripts/verify-booking-read-recovery.mjs: unavailable/missing/found reads, rejected queries, legacy aliases, tenant/visibility filters, 503 versus 404 route responses, no supplier replay
- node scripts/verify-search-stream-finalization.mjs: JSON/SSE supplier rejection, private raw messages, usage finalization and disconnect behavior
- node scripts/verify-booking-post-write-finalization.mjs
- node scripts/verify-supplier-write-uncertainty.mjs
- node scripts/verify-flight-search-reference-safety.mjs
- node scripts/verify-booking-list-reliability.mjs
- npm run build

Deployment status is tracked separately from these checks. Passing local regressions does not convert supplier UAT cases to PASS. The local workbook retains 7 PASS, 11 blocked cases and 2 Unconfirmed cases.
