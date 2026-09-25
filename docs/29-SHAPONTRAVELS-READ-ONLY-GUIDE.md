# Shapontravels read-only supplier integration

This guide describes the local KaligonjTours integration verified on 2026-09-26. It uses the [public Shapontravels OpenAPI](https://api.shapontravels.com/openapi.json) and an issued API Management client. The API docs' Try it out uses the configured environment; treat calls as live.

## Configure

Set `SHAPONTRAVELS_SEARCH_BASE_URL` to the issued HTTPS API root in the KaligonjTours server environment. Set either `SHAPONTRAVELS_CLIENT_ID` and `SHAPONTRAVELS_CLIENT_SECRET`, or the already issued `CLIENT_ID` and `CLIENT_SECRET`. Keep values in a private environment file or secret manager. These credentials belong to KaligonjTours as an API client of Shapontravels. The transport never sends them to the browser.

`supabase/fresh-install/supabase/migrations/20260926000000_shapontravels_read_supplier.sql` was applied to the linked Kaliganj database on 2026-09-26. It enables the new Search supplier in operational controls, daily usage limits, and usage events. Booking table supplier constraints remain limited to the existing protocol. Its application did not change the active supplier or booking/ticketing settings.

Then a Super Admin selects **Shapontravels** in Supplier Control. Only one supplier serves each new Search. Existing Search quotes retain their original supplier in Redis even if the selection changes. Shapontravels booking and ticketing switches are disabled.

## Read flow

1. The server exchanges the client credentials with `POST /auth/token` and caches the machine bearer token until near expiry. An HTTP 401 on a read causes one token renewal and retry.
2. `POST /api/Search` receives the existing search request fields. The mapper accepts only complete directions and private segment references. Each selectable option is bound to `shapontravels` in the short-lived Redis quote. The browser receives only its own search and itinerary IDs.
3. The public offer's `fareBreakdown.payable` is the final BDT price. The mapper validates the decimal breakdown and passenger totals. It does not add KaligonjTours markup to that amount.
4. Airline policies call `POST /api/FareRules` with the stored supplier references. **Check fare** calls `POST /api/Reprice` and verifies that the returned journey matches the selected one. Reprice displays the updated payable but does not save a bookable price reference.
5. The UI marks booking unavailable. The booking Prepare API independently rejects every Shapontravels quote before creating a booking attempt.

## Verify locally

Run `npm run typecheck`, `npm run verify:shapontravels-read-client`, `npm run verify:shapontravels-pricing`, `node scripts/verify-flight-search-reference-safety.mjs`, `node scripts/verify-supplier-controls.mjs`, and `node scripts/verify-search-stream-finalization.mjs`. The first two Shapontravels scripts use mocks and do not call the live API. A production-style live read probe requires explicit issued client access and should print only sanitized counts, status, and non-sensitive price comparisons.

The 2026-09-26 live probe returned 67 Search offers for one adult DAC → CXB on 2026-10-16. All 67 had valid BDT payable breakdowns. One selected fare returned three FareRules sections and a Reprice response with the same segment identity and unchanged payable. No acceptance, booking, ticketing, cancellation, payment, or PNR write was attempted.

## Known gaps

The public documentation did not establish a separate UAT host, IP allowlist policy, support contact, or guaranteed supplier rate budget. The tested host is the issued HTTPS API. Booking requires a later implementation of Reprice acceptance and the full booking, ticketing, cancellation, recovery, and financial lifecycle. Until then, the provider remains read-only.
