# Shapontravels read-only onboarding evidence

Date: 2026-09-26. Target project: KaligonjTours. The API contract was taken from the public [OpenAPI document](https://api.shapontravels.com/openapi.json) and tested using the issued API client in this project's private `.env.local`. No credential, bearer token, full supplier response, or passenger data is stored here.

## Observed calls

| Call | Result | Sanitized observation |
| --- | --- | --- |
| `POST /auth/token` | HTTP 200 | Machine bearer token returned. |
| `GET /auth/me` | HTTP 200 | Returned client ID matched the configured ID; `search:read` was present. |
| `POST /api/Search` | HTTP 200 | One adult, DAC → CXB, 2026-10-16; 67 offers, `X-Search-Partial: false`. Request ID `f9ba9edd-99d6-455a-93ec-af71f65e7e20`. |
| `POST /api/FareRules` | HTTP 200 | One complete Search direction and its segment reference. `item1` was an object with `fareRuleDetails`, `itemCodeRef`, and `uniqueTransID`. Request ID `911d4436-515a-401f-baa5-986e18a2d8da`. |
| `POST /api/Reprice` | HTTP 200 | The same selected direction returned a `priceCodeRef`, `currency: BDT`, `isPriceChanged: false`, and `bookable: true`. Request ID `cc28aa5b-3a83-4e86-8516-7dfb3843adc5`. |

The first selected Search offer had no top-level `currency`, although it had a `fareBreakdown`. Integration code must verify currency from the documented envelope or pricing response before accepting an offer. The public Search contract says the returned selling price already reflects Shapontravels pricing; applying KaligonjTours' Triplover markup again would misprice it.

## Client boundary

`lib/shapontravels/client.ts` is a separate server-only transport for the three tested read operations. It accepts the existing `SHAPONTRAVELS_SEARCH_BASE_URL`, `CLIENT_ID`, and `CLIENT_SECRET` variables and also supports prefixed client credential names for later deployment configuration. It caches a short-lived bearer token, shares concurrent token exchanges, renews once after a read's HTTP 401, bounds response size and time, rejects redirects, and emits only redacted errors.

The chosen presentation rule is **one Super Admin-selected supplier at a time**. Existing FirstTrip, TakeOff, and Triplover accounts use one protocol. Shapontravels now has a separate read-supplier identity in operational controls, Search usage limits, and the Redis quote. Search, FareRules, and Reprice dispatch from that source-bound quote. Reprice does not save a booking capability, and the booking Prepare route rejects Shapontravels quotes before writing an attempt. The result card offers **Check fare** and airline policies and labels booking unavailable.

The new mapper reads `fareBreakdown.payable` as the final BDT price, validates its passenger payable/tax/AIT totals in integer minor units, and applies no KaligonjTours markup. In a later live DAC → CXB Search, all 67 offers had a valid breakdown. The full Search mapper formed 22 itinerary cards and 99 private option references, with zero dropped offers and `bookingAvailable: false`. A live FareRules response carried three sections; a live Reprice returned the same selected segment identity, BDT breakdown, and unchanged payable. These checks used the API client's read permissions only.

On 2026-09-26, DAC → SIN on 20 October and SIN → DAC on 20 November reproduced the reported round-trip failure. The supplier returned 1,877 offers; the original mapper formed 461 cards and 2,890 private fare references, whose compressed Redis quote was too large for the 256 KB default. After the size-aware result reduction, a repeat live read returned 1,886 supplier offers and safely assembled 459 distinct flight cards with 459 private references. The stored quote was 96,561 bytes, and the result carries a flag for the browser's large-result notice. Supplier offer counts vary between calls. This was a local adapter check using an in-memory Redis double; no Vercel deployment, booking, or supplier write was made.

Local verification passed: TypeScript typecheck, full ESLint, the full `verify:ci` suite, production build, read-client and payable mapping checks, and a disposable PGlite execution of the forward migration. A live Reprice was also passed through the new adapter with a source-bound test quote: it returned the matching BDT payable, made zero Triplover calls, and wrote zero booking selections.

On 2026-09-26 the linked Kaliganj Supabase database applied `20260926000000_shapontravels_read_supplier.sql` as its only pending migration. Migration history and a follow-up dry run were up to date. A read-only hosted query confirmed the Shapontravels supplier limit row; the active supplier remained Triplover and booking/ticketing settings were unchanged. Application rollout is separate from the database change.

## Remaining onboarding gaps

- The public OpenAPI documents request shapes but does not establish a separate UAT host, IP allowlist policy, support contact, or a guaranteed supplier rate budget. The tested host is the configured production-style HTTPS API; no sandbox behavior is claimed.
- A successful FareRules HTTP response does not guarantee substantive cancellation terms for every fare. Map and display the actual `fareRuleDetails` defensively.
- The public Reprice response requires explicit acceptance of `priceCodeRef` before booking. Acceptance and booking were not called in this milestone.
- The hosted schema supports saving the Shapontravels selection once the application code and server credentials are available in the selected environment. The migration did not change the active supplier.
- No booking, PNR, ticketing, cancellation, payment, or explicit application deployment was performed.
