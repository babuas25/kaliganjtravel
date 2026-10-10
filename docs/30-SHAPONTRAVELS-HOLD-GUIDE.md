# Shapontravels hold booking integration

Implemented locally on 2026-09-27 against the public [Shapontravels OpenAPI](https://api.shapontravels.com/openapi.json). This extends the earlier [read-only integration](29-SHAPONTRAVELS-READ-ONLY-GUIDE.md). The configured local API client returned a `booking` permission from `GET /auth/me`; no live Book or fare acceptance call was made during implementation.

## Flow

1. Search retains the Shapontravels transaction and option references in Redis. A holdable option can open checkout; a nonholdable option can only check its fare.
2. Reprice verifies the selected flights and BDT payable, applies current local markup rules, then saves the current `priceCodeRef` and separate supplier/selling amounts in the principal-bound Redis selection. A changed supplier or selling price requires the customer's confirmation. Book receipt verification uses supplier payable; the customer's booking and wallet charge use selling price.
3. Prepare checks the signed-in owner, public itinerary digest, fresh selection, and holdability. It calls `POST /api/Reprice/accept` for the exact private price reference and creates a durable Shapontravels booking attempt only after acceptance succeeds.
4. Submit validates travellers and claims the attempt once. `POST /api/Book` carries `directIssueIntent: false` and the attempt's stable `Idempotency-Key`. The server records the supplier-call and response boundaries. A verified held receipt and its `X-Booking-Reference` STR header are finalized in one database transaction. The Rust API projects public `bookingRefNumber` to the PNR; `bookingCodeRef`, `uniqueTransID`, `itemCodeRef`, and `priceCodeRef` are platform UUIDs. Rust retains and translates the private upstream references. Existing receipts with a UUID `bookingRefNumber` remain supported, but a non-UUID reference must exactly match the saved PNR.
5. HTTP 202, timeouts, 5xx, mismatched references or payable, and incomplete receipts remain unresolved. The attempt is not automatically resubmitted. The saved request key, transaction reference, attempt record, and any validated pending booking ID/reference support operator reconciliation.

The hold path never requests direct issue. Delayed **Issue Now** is available only when a Super Admin enables ticketing and the server has Shapontravels credentials. The cancellation implementation prepared on 2026-10-08 is described below; deploy its forward migration with the application before enabling the new cancellation behavior in production.

### Cancellation — 2026-10-08

Shapontravels **Cancel Booking** applies to unissued **On Hold, Pending, Unconfirmed and Expired** local bookings. The server requires an owned API booking, the correct supplier account, complete saved PNR/platform references, no ticket evidence or active operation, and an unpaid or released payment position. Confirmed, Cancelled and In Progress bookings cannot start cancellation. Triplover retains its existing On Hold cancellation policy. Checkout hides cancellation during its redirect; the dashboard supplies the validated capability.

Before claiming an operation, a fresh `GET /api/bookings/{id}` must match the saved booking, quote, PNR and supplier STR identity, explicitly permit `publicReceipt.actions.canCancel`, and have no pending review or tickets. This permission is independent of `canIssue` and the local ticketing deadline. A local Pending, Unconfirmed or Expired label does not establish that the supplier can cancel its record: the supplier's native cancellation still requires an unticketed held booking and its own matched live PNR check.

`POST /api/Cancel` sends the six public reference fields with `BookingRefNumber` mirroring the PNR and the durable operation key in `Idempotency-Key`. Only HTTP 200 with `item2.isSuccess`, `item1.isCancel` and all four exact saved UUID identities can finalize cancellation. The existing atomic finalizer records Cancelled, completes the operation and resolves any applicable wallet hold exactly once. An HTTP 202, timeout, malformed or mismatched receipt, or other response leaves the operation for reconciliation; the write is never automatically repeated. A configuration, authentication or start-boundary failure before dispatch can restore the exact prior local state through a separate guarded RPC that proves no supplier call started.

Staff **Verify Supplier Status** also reads `GET /api/bookings/{id}/cancellation` for an unresolved cancellation and checks any saved cancellation receipt. This provides review evidence without finalizing cancellation or changing money. Missing evidence is inconclusive. Audit or notification delivery failure after successful atomic cancellation cannot reopen supplier uncertainty.

`supabase/fresh-install/supabase/migrations/20261008000000_shapontravels_booking_cancellation.sql` was applied and verified on 2026-10-11 before the matching application release. It changes cancellation claim eligibility for Shapontravels, adds guarded restoration for an unsent cancellation, and preserves the Triplover path, existing rows, balances and installed baseline. Disposable database regression and hosted schema/permission checks passed. The supplier API client also needs its `booking` and `cancellation` grants and the supplier's execution/servicing settings enabled, as documented in the [supplier OpenAPI](https://api.shapontravels.com/openapi.json).

A read-only check of the locally configured client on 2026-10-08 returned `booking`, `ticketing` and `cancellation` from `GET /auth/me`. This confirms the client's grants; no live cancellation or other supplier booking/ticket write was sent.

Run `npm run verify:shapontravels-cancel` and `npm run typecheck`. The cancellation suite covers the actual adapter and request boundaries, four permitted statuses, ownership and reference checks, supplier Cancel independent of Issue, UI capability rendering, issue/cancel conflicts, local unsent restoration and atomic finalization/replay. These tests use mocks and disposable PGlite and never send live Book, Issue or Cancel requests.

The delayed issue path sends the saved PNR, its public `BookingRefNumber` mirror, and four platform UUID references in `POST /api/ticket/NewTicket`, with the durable operation request key as `Idempotency-Key`. Rust resolves the private supplier references from its saved Book response. Owner/role checks, wallet funding, saved references, passenger count, and known deadline are checked before dispatch. The supplier response must echo the exact PNR, transaction, item, price, and booking references and contain one complete ticket entry per passenger. Only that verified response can atomically capture the wallet reservation and confirm the local booking. A 202 response, transport gap, supplier rejection, or incomplete ticket evidence locks the operation for reconciliation; it never automatically sends a second Issue request or releases the wallet hold based on uncertain supplier evidence. Staff can use the supplier check to inspect a saved ticket after an uncertain outcome; that check never confirms a local ticket or changes the wallet.

The ticketing implementation and synthetic wallet finalization were tested without sending a live Issue request. A read-only `GET /auth/me` returned the `ticketing` permission for the locally configured supplier account. Production credentials and the first real ticket outcome still need operational observation when an authorized user issues a booking.

Authorized booking staff can use **Verify Supplier Status** on a Shapontravels booking. This performs an authenticated `GET /api/bookings/{id}` and checks the returned transaction, item, price, booking, PNR, and STR references against the saved booking. It displays the additive `currentStatus.status` as the current API outcome. The original `item1.bookingStatus`, often `Created`, remains historical Book evidence. The uncertain-attempt reconciliation panel has a similar read-only lookup when a validated booking ID or STR reference was captured from the pending response. A timeout before any supplier reference was returned still requires manual portal investigation; the Book request must not be replayed automatically. A missing supplier booking is inconclusive and does not authorize a retry.

### Current status integration — 2026-10-03

A successful staff check with complete receipt identity and valid `currentStatus` records an append-only display observation. The shared lifecycle projection then supplies the booking list, status filter/count/sort, details, and normal Super Admin reader. For example, an original held booking whose API `currentStatus.status` is `cancelled` displays **Cancelled**, while the original `flight_bookings.status`, Book receipt, wallet, tickets, and notification records remain unchanged. There are no supplier requests for each booking-list row. The check records the API read time separately from the saved supplier evidence timestamp; the API read does not claim a new supplier PNR check.

Local decided Confirmed/Cancelled states, active operations, and payment reconciliation retain precedence. Supplier `confirmed` alone does not complete local ticketing or capture money. Conflicting or review-required observations block ticket issuance in both application permissions and the atomic database claim, before funds are reserved. Cancellation display does not release a hold or refund money; those actions continue through their existing controlled workflows.

The status panel shows selected-source evidence separately from the latest raw supplier observation. An Admin outcome with `verified: false` is still a valid current API outcome; receipt identity verification does not imply supplier verification. A failed `lastCheck` keeps earlier valid evidence and shows the failure separately. Missing metadata uses an explicitly historical fallback; malformed metadata cannot promote `Created` into current status. Legacy, invalid, failed, 202, 404, or mismatched reads cannot erase a previously saved observation. Out-of-order reads use their request start times so a late older response cannot replace a newer check.

Rust public machine receipts deliberately expose only `currentStatus.status` and `reviewRequired`. The adapter labels these as `public_receipt`, with `verified: false` and null private state, supplier evidence and timestamps. A compact On Hold is usable only when the matching public receipt also has `pendingReview: false` and explicitly permits `actions.canIssue`. Conflicting, manually resolved, expired or otherwise blocked receipts cannot authorize Issue. Stored legacy UUID booking references may match the public PNR mirror only when the saved PNR and all other receipt identities match. The forward `20261006000100_shapon_compact_current_status.sql` migration accepts only this exact conservative metadata shape; existing rich evidence rules remain intact.

The forward migrations `20261003000000_shapon_current_status_projection.sql`, `20261006000000_shapon_public_booking_reference.sql` and `20261006000100_shapon_compact_current_status.sql` were applied to the linked Kaliganj project `ljzoizsogbirlvlsrwzi` on 2026-10-06, after a dry run showed exactly those three pending migrations and the complete disposable database regressions passed. No seeds, roles or Vault updates were applied. During application-first rollout, an unavailable recording RPC leaves the supplier check usable and reports that the list/detail snapshot could not be updated. Live migration and application deployment remain separate release steps.

The hold receipt exposes one `pnr` and no separate airline-PNR array. KaligonjTours stores that verified locator in its airline-PNR list so the existing lifecycle projection shows the booking as **On Hold**. A missing or two-character locator is treated as an unverified response for reconciliation.

### IndiGo airline PNR receipts — local source preparation, 2026-10-09

Verified IndiGo issuance may use the airline PNR in the existing ticket-number
cell. The Shapon ticket adapter now accepts `ticketNumberSource:"airline_pnr"`
only for a server-owned saved itinerary whose carrier and every segment are
`6E`, a matching confirmed public receipt with `pendingReview:false`, the exact
saved platform references and one complete ticket entry per passenger. Each
identifier must belong to the receipt's verified `airlinesPNR` list. Shared PNRs
retain separate passenger slots; numeric tickets retain their uniqueness checks.
Booking PNR and airline locators are saved separately when they differ. Hold or
Active PNR evidence alone cannot confirm issuance or capture money.

Both Issue and saved-ticket review supply the stored itinerary. The supplier
request and durable request hash retain their existing fields. Read-only review
does not finalize a ticket or move funds. This correction needs no new database
migration and does not enable Shapon Direct Issue checkout, which remains
Hold-only. Source qualification passes 15 offline checks including typecheck,
affected-file lint, the actual Issue/review routes and full migration-chain
PGlite receipt storage and exact one-time wallet capture. No live Issue, push or
deployment was performed. Run `node scripts/verify-shapontravels-ticket-route.mjs`
alongside the existing ticket and hold-database regressions.

### Supplier portal ticket confirmation — 2026-10-10

An Admin or Super Admin can refresh a native Shapontravels held booking that
was issued through the supplier portal. The status check also reads the saved
ticket when the supplier reports Confirmed. Both reads must match the stored
booking/quote references and PNR, explicitly report Confirmed and Paid without
pending review, and include complete ticket evidence for the saved passenger
count. This refresh only verifies evidence; it does not confirm or charge.

After that check, **Confirm Issued Ticket** appears immediately below the
refresh button. The dialog asks **“Charge the booking owner’s wallet?”** and
offers **Charge & Confirm** or **Confirm Without Charge**. The displayed amount
is the booking’s saved selling price. The first choice charges the booking
owner’s user or agency wallet and confirms the booking. The second confirms
the same ticket without debiting a wallet; its immutable decision records
`external_supplier_paid_no_wallet_charge`. Local wallet payment state stays
Unpaid with zero captured amount in that branch, rather than inventing a
wallet payment. The audited external settlement is excluded from the generic
Confirmed/Unpaid staff conflict warning.

The confirmation endpoint independently re-reads both supplier records and
then calls `confirm_shapon_external_ticket_v1`. Only the canonical database
Admin/Super Admin role can execute either choice. Existing active operations,
open reconciliation cases, captured funds, live reservations, inconsistent
owners and conflicting ticket evidence block the action. The transaction
records the decision, ticket fields, lifecycle event and notification intent
together with any owner-wallet debit. No Book, NewTicket or Cancel request is
sent. A frozen or insufficient wallet fails before any confirmation or debit.

Each decision uses a stable request UUID and a unique booking record. Exact
retries return the committed decision even when supplier reads are unavailable;
changing the booking, actor, wallet choice or ticket proof rejects the replay.
If a response is lost, the dialog retains the original choice for a safe retry.
Once confirmed, the action disappears and a second request cannot charge again.

The forward migration
`20261010000000_shapon_external_ticket_confirmation.sql` was applied and
verified on 2026-10-11 from the fresh-install workdir, after the cancellation
migration and before deploying this flow. Hosted checks verified restricted
permissions, the immutable decision trigger, and preserved staff-view columns
and grants. Migration history matches and the follow-up dry run is empty;
booking and wallet row snapshots are unchanged. This rollout did not deploy
the application, confirm a live booking or charge a wallet. Run
`npm run verify:shapontravels-external-confirmation` and `npm run typecheck`.

## Migration and activation

`supabase/fresh-install/supabase/migrations/20260927000000_shapontravels_hold_booking.sql` was applied to the linked Kaliganj database on 2026-09-27 after the local hold database test passed and a dry run showed it as the sole pending migration. A follow-up migration list and dry run matched local and remote history. A read-only hosted schema query confirmed that both `booking_attempts` and `flight_bookings` now accept the `shapontravels` supplier account and require it for Shapontravels rows. The migration extends supplier-account constraints, enforces the Shapontravels binding, and parses offset-bearing ticketing deadlines. It does not change supplier selection or booking/ticketing switches. At verification time, Supplier Control selected Shapontravels with booking enabled and ticketing disabled.

`20260927010000_shapontravels_supplier_reference.sql` was applied later the same day. It saves the stable STR reference separately and makes the staff booking list show/search it for Shapontravels. The existing booking `KTT0AEKGH0AEKGH` was matched by a read-only supplier lookup against its stored booking UUID, body booking reference UUID, PNR, and transaction ID before its `supplier_public_ref` was set to `STR0AEKGH0AEKGH`. The hosted dashboard view now returns that STR reference; the body UUIDs remain unchanged. No second supplier Book call was made for this correction.

The public OpenAPI currently lists production at `api.shapontravels.com` and UAT at `sendbox.shapontravels.com`; they require separate credentials. The locally configured client points at production. The original implementation was validated with mocks and a read-only permission check; a later authorized B2B hold created `KTT0AEKGH0AEKGH` / `STR0AEKGH0AEKGH`. A supplier GET for that booking returned `Created`, matching its saved references and PNR. The staff booking detail's read-only check returned the same result. Actual B2B dashboard access was not tested in this session; the database shows the booking belongs to the B2B agency and is visible to its owner.

## Verification

The forward migration `20261006000000_shapon_public_booking_reference.sql` aligns wallet saved-reference eligibility with the Rust public PNR contract. Deploy it with the application validation fix; it does not rewrite stored booking references or wallet history. Shapontravels bookings use the normal Issue Ticket action; the separate Super Admin Issue Now resolution panel remains restricted to its existing Triplover scope. An authenticated `404 NOT_FOUND` on booking retrieval means the record is not visible to that API client in that environment. Check that the API base URL and client credentials match those used for Book before treating the stored references as invalid.

Run `npm run typecheck`, `npm run verify:shapontravels-read-client`, `npm run verify:shapontravels-status`, `npm run verify:shapontravels-ticket`, `npm run verify:shapontravels-hold-db`, `npm run verify:flight-search-reference-safety`, and `npm run verify:supplier-write-uncertainty`. The hold database test loads the complete fresh-install migration chain in disposable PGlite, finalizes a synthetic held receipt, reserves a synthetic wallet amount, and captures it once from synthetic ticket evidence. The ticket test covers exact payload, identity, passenger count, no automatic retry, and incomplete supplier responses. The status command also runs current metadata, UI message, recording fallback, issue-permission and disposable database projection regressions. All current-status checks use synthetic fixtures and do not contact a live supplier or database.
