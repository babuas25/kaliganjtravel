# IMP/EXP Booking Imports

The IMP/EXP module retrieves an existing booking directly from an airline's
Manage Booking website and stores it as a normal ShoponTravels booking. Imported
bookings receive an `STR...` public reference and use the same booking details,
history, assignment, and lifecycle views as supplier-created bookings.

The dashboard's separate Supplier API tab is not IMP/EXP: FirstTrip, TakeOff,
and Triplover reference imports remain ordinary Triplover API-backed bookings
and continue to use normal Issue, Cancel, and PNR operations. See
[Supplier Reference Import](09-SUPPLIER-INTEGRATION.md#12-firsttrip-takeoff-and-triplover-reference-import).

## Table of Contents

1. [Access and Route](#access-and-route)
2. [Supported Airlines](#supported-airlines)
3. [Import Form](#import-form)
4. [Pricing and Wallet Ownership](#pricing-and-wallet-ownership)
5. [Charging and Lifecycle Matrix](#charging-and-lifecycle-matrix)
6. [Import Workflow](#import-workflow)
7. [Manual Ticket Ownership and SLA](#manual-ticket-ownership-and-sla)
8. [Passenger Details](#passenger-details)
9. [Status Mapping](#status-mapping)
10. [Re-import and Synchronization](#re-import-and-synchronization)
11. [Storage and APIs](#storage-and-apis)
12. [Deployment Requirements](#deployment-requirements)
13. [Troubleshooting](#troubleshooting)
14. [Critical Invariants](#critical-invariants)
15. [Related Documentation](#related-documentation)

## Access and Route

- Dashboard route: `/dashboard/impexp`
- API namespace: `/api/impexp/*`
- Authorized roles: `superadmin`, `admin`, and `staff_support`
- Assignment targets: B2B partner, B2B sub-user, or customer

All page and API access is checked server-side. A development role preview does
not grant permissions that the signed-in account does not have.

## Supported Airlines

| Provider  | Direct Manage Booking entry point                                                    |
| --------- | ------------------------------------------------------------------------------------ |
| US-Bangla | `https://fo-usba.ttinteractive.com/Zenith/FrontOffice/usbangla/Home/FindBooking`     |
| Air Astra | `https://fo-airastra.ttinteractive.com/Zenith/FrontOffice/airastra/Home/FindBooking` |
| NOVOAIR   | `https://secure.flynovoair.com/bookings/retrieve_reservation.aspx`                   |

The application launches server-side Chromium and reads the selected airline
website directly. It does not call the Tripfeels backend and does not require a
supplier-import proxy URL. BDFare is not an IMP/EXP provider.

The optional Manage Booking URL selects an alternate current entry URL. URLs are
accepted only for the selected airline's approved host. A temporary TTInteractive
`(S(...))` token is not stored as permanent configuration and does not transfer
the operator's cookies, device verification, browser fingerprint, local storage,
or network identity to the server-side browser.

## Import Form

| Field               | Requirement | Meaning                                                |
| ------------------- | ----------- | ------------------------------------------------------ |
| Provider            | Required    | Airline website to retrieve from                       |
| Airline ref / PNR   | Required    | Airline booking locator                                |
| Passenger last name | Required    | Surname used by the airline lookup form                |
| Supplier ref        | Optional    | Original Tripfeels, legacy-site, or supplier reference |
| Manage Booking URL  | Optional    | Alternate approved-host entry URL; not a transferred browser session |
| Assign role         | Required    | Type of booking owner                                  |
| Assign user         | Required    | Specific user whose personal/shared agency wallet owns it |
| Supplier Gross      | Retrieved   | Supplier/reference amount; never used as the wallet debit |
| User Payable Amount | Required    | Local commercial amount charged to the assigned wallet |
| Passenger info      | Optional    | Extra passenger data not exposed by the airline page   |

The PNR and surname must be entered in their matching fields. For example, the
NOVOAIR booking URL `view_reservation.aspx?PNR=XNCPXK` uses `XNCPXK` as the
Airline ref / PNR and `RAHMAN` as the passenger last name.

There is no unassigned import state. The import cannot be submitted until an
eligible B2B partner, B2B sub-user, or B2C customer with an existing wallet
account for the supplier currency is selected.

The pricing card is always visible. Before retrieval, Supplier Gross reads
`Not retrieved yet` while User Payable remains an explicit editable input.
Retrieve & Review requires PNR, surname, and assignment; retrieval does not
silently copy Supplier Gross into User Payable. Import remains disabled until a
successful preview, valid assignment, and positive User Payable are present.

## Pricing and Wallet Ownership

Supplier Gross and User Payable are deliberately separate financial facts:

| Value | Source | Used for wallet debit | Sync behavior |
| ----- | ------ | --------------------- | ------------- |
| Supplier Gross | Airline Manage Booking result | Never | May be refreshed from supplier evidence |
| User Payable | Explicit local operator input | Only Confirm & Pay or authorized Import & Charge | Protected; Sync and re-import cannot overwrite it |

Both values are entered/displayed in major units but stored as integer minor
units. For BDT 10,000 Supplier Gross and BDT 9,500 User Payable, the only
legitimate customer debit is BDT 9,500.

The imported e-ticket uses Supplier Gross as its face total and preserves the
supplier-authored fare rows. In the same example, the web ticket, downloaded
ticket, and confirmation email show BDT 10,000 while wallet/payment/ledger data
remain BDT 9,500. Sync may refresh Supplier Gross and ticket evidence but cannot
change the protected BDT 9,500 User Payable.

The operator and financial owner are different identities:

| Assigned account | Booking/financial owner | Wallet charged |
| ---------------- | ----------------------- | -------------- |
| B2C customer | Assigned customer's Clerk ID | Customer's personal wallet |
| B2B partner | Assigned agency code | Shared agency wallet |
| B2B sub-user | Parent agency code | Shared parent agency wallet |

`superadmin`, `admin`, and `staff_support` are operators. Their wallet is never
used as a fallback for an imported booking. An invalid assignment, missing
wallet, or missing currency account fails safely.

## Charging and Lifecycle Matrix

| Action | Stored/lifecycle result | Payment | Wallet action |
| ------ | ----------------------- | ------- | ------------- |
| Import supplier Held booking | On Hold | Unpaid | No charge |
| Authorized owner confirms held import | In Progress | Captured | Debit User Payable once |
| Sync while supplier still Held | In Progress | Captured | No charge |
| Sync after authoritative ticket confirmation | In Progress; completion ready | Captured | No charge |
| Staff Complete with matching ticket evidence | Confirmed | Captured | No charge; reuse original capture |
| Import confirmed booking with Import Only | Confirmed | Unpaid + Accounts case | No charge |
| Import confirmed booking with Import & Charge | Confirmed | Captured | Consume prior authorization; debit User Payable once |
| Re-import an already-paid booking | Existing safe state | Captured | No charge |
| Repeated Sync or browser refresh | Existing safe state | Unchanged | No charge |

For a held import, the customer-facing Confirm & Pay action performs the
financial capture and moves `On Hold -> In Progress`. In Progress means payment
is complete but authorized operations staff must issue or verify the ticket in
the external airline system. The normal Triplover Issue Ticket endpoint is not
called.

For a direct confirmed/ticketed import the operator must choose Import Only or
Import & Charge. Import Only creates Confirmed/Unpaid plus an Accounts-owned
payment-conflict case and does not validate or debit wallet funds. Import &
Charge requires a separate five-minute, one-use authorization bound to the
owner, amounts, currency, supplier identity, and complete passenger/PNR/ticket
evidence. Authorization itself never moves money; the import atomically
consumes it for one debit.

## Import Workflow

1. The API verifies the signed-in role and rate limit.
2. Input is validated, normalized, and converted to uppercase where required.
3. A server-side browser submits the PNR and surname to the airline website.
4. The scraper reads passenger, ticket, itinerary, fare, PNR, and status data.
5. The operator reviews Supplier Gross and explicitly enters User Payable.
6. Optional passenger rows supplement the scraped passenger records.
7. Supplier data is normalized to the ShoponTravels booking response shape.
8. The operator chooses Import Only or, after a fresh prior authorization,
   Import & Charge; `create_impexp_booking_v2` persists that explicit decision.
9. The imported booking appears in history and the normal booking-details view.

An On Hold import is stored as `on-hold + unpaid` and does not change the
wallet. The assigned customer/agency later uses Confirm & Pay. The controlled
`wallet_confirm_impexp_booking` transaction captures User Payable and moves the
booking to `in-progress` for manual external ticketing. It does not call the
normal supplier Issue Ticket API.

An initially confirmed/ticketed Import & Charge requires an active funded owner
wallet and consumes the exact matching authorization atomically with booking,
reservation, ledger, and payment state. Import Only intentionally permits
Confirmed/Unpaid only because it creates a visible Accounts case.

The main implementation paths are:

- `components/dashboard/impexp/ImpExpPage.tsx`
- `app/api/impexp/import-booking/route.ts`
- `lib/impexp/providers.server.ts`
- `lib/impexp/ttinteractive-manage-booking.server.ts`
- `lib/impexp/novoair-manage-booking.server.ts`
- `lib/impexp/normalize.ts`
- `lib/db/impexp.ts`

## Manual Ticket Ownership and SLA

Confirm & Pay creates the captured reservation/ledger entry, an
`imported_manual_ticketing` operation in `awaiting_external_action`, and an
owned Support case in one transaction. The customer sees In Progress with
“Payment received; ticketing is being completed.” Internal task state is never
shown as another customer status.

The task is due at the earlier of capture plus two hours or the ticketing
deadline minus 60 minutes. An already-passed due time is immediately overdue.
An unassigned case receives a durable warning after 30 minutes; Admin ownership
is required at due time; Super Admin escalation follows after 60 overdue
minutes. The bounded scheduler records escalation only—it never invents a
supplier outcome or changes wallet/public truth.

Staff Sync retrieves and stores normalized, payload-hashed evidence without a
debit. Outcome routing is explicit:

| Fresh Sync outcome | Internal routing | Public/financial effect |
| --- | --- | --- |
| Complete matching ticket evidence | Support completion ready | Remain In Progress/Captured until Complete |
| Held | Support supplier follow-up | Remain In Progress/Captured |
| Cancelled, Expired, or Unconfirmed | Accounts financial disposition | Remain In Progress/Captured |
| Identity/lifecycle/payment conflict | Critical Admin reconciliation | No automatic truth change |

Complete requires a fresh five-minute matching observation with provider,
supplier reference, passenger identity hashes, route, airline PNR, and exactly
one non-empty ticket number per stored passenger. It changes the booking to
Confirmed and completes operation/case/event/outbox atomically, but performs no
additional wallet, reservation, ledger, or payment mutation.

If ticketing cannot complete, Accounts/Admin/Super Admin may propose full or
partial refund, no refund due, external settlement, or manual adjustment from
fresh negative evidence. A different Admin/Super Admin must approve. Refund
execution appends one idempotent credit; no-refund/external-settlement moves no
local money; manual adjustment stays open. No staff member should repair these
states with direct SQL or a generic wallet action.

## Passenger Details

Passenger names always come from the airline Manage Booking result. Optional
rows add or correct details that the airline page does not expose:

- PAX type: adult, child, or infant
- Gender
- Date of birth
- Nationality
- Passport number
- Passport expiry

Rows are positional: passenger row 1 supplements airline passenger 1, row 2
supplements airline passenger 2, and so on. The import is rejected when more
supplement rows are submitted than passengers returned by the airline.

## Status Mapping

Airline status evidence is converted to the canonical ShoponTravels lifecycle:

| Airline evidence                                            | ShoponTravels status |
| ----------------------------------------------------------- | -------------------- |
| Cancelled, Canceled, Refunded, Refund, Void, Voided         | `cancelled`          |
| Expired                                                     | `expired`            |
| Unconfirmed, Rejected, Failed                               | `unconfirmed`        |
| Processing, Ticketing, In progress                          | `in-progress`        |
| Issued, Ticketed, Confirmed, Used, or a valid active ticket | `confirmed`          |
| Held, Booked, Created                                       | `on-hold`            |
| No conclusive evidence                                      | `pending`            |

Terminal negative states take precedence over ticket evidence. Refunded or
cancelled bookings can retain their historical ticket number, but that ticket
must never cause the booking to become `confirmed` again.

ShoponTravels has no separate `refunded` booking lifecycle, so airline Refunded
is represented as `cancelled` while the supplier status remains in import
metadata.

## Re-import and Synchronization

The unique external identity is the airline provider plus airline booking
reference. Re-importing the same provider/reference updates the existing
booking instead of allocating another `STR...` reference.

The operations-only Sync action observes:

- Booking lifecycle and supplier status
- Passenger and ticket data
- Itinerary and fares
- Airline PNRs and ticketing deadline
- Import audit metadata

When lifecycle and identities agree, supplier-controlled fields may be enriched
from the fresh observation. Disagreement is appended to the owned case instead
of overwriting protected booking, ticket, payment, or ownership truth.

Sync protects all local financial and ownership facts, including User Payable,
booking owner, financial owner, charged wallet account, payment state, captured
amount, and immutable ledger/reservation rows.

A lifecycle event is appended only by a separate accepted material outcome.
Sync never writes wallet tables, never creates a payment ledger entry, never
changes User Payable, and never completes a captured manual-ticket booking.
Ticket evidence enables the explicit Complete action. The optional
supplier/original reference is stored separately and does not replace the
airline PNR used for lookup and de-duplication. Import history displays the
original reference when one was supplied.

Re-import uses provider plus airline reference and is serialized with a
transaction-level advisory lock. It cannot create a second booking/payment.
Assignment and User Payable are immutable through re-import. An existing unpaid
hold that newly appears confirmed is rejected for explicit reconciliation; a
re-import is not treated as customer authorization to charge.

Database-level duplicate protection combines the provider/reference identity,
a transaction advisory lock, a booking row lock, a stable
`impexp-payment:<booking-id>` ledger idempotency key, and unique
ledger/reservation constraints. Frontend button disabling is only a usability
measure; it is not the financial safety boundary.

## Storage and APIs

### API routes

| Method | Route                        | Purpose                                 |
| ------ | ---------------------------- | --------------------------------------- |
| `POST` | `/api/impexp/preview-booking` | Retrieve supplier status and gross for review |
| `POST` | `/api/impexp/authorize-charge` | Record a non-financial five-minute prior Import & Charge authorization |
| `POST` | `/api/impexp/import-booking` | Import Only or consume prior authorization for Import & Charge |
| `GET/POST` | `/api/impexp/confirm-booking` | Preview/capture an assigned imported hold |
| `POST` | `/api/impexp/sync-booking` | Non-financial supplier observation and case routing |
| `POST` | `/api/impexp/complete-booking` | Complete from fresh matching ticket evidence without another debit |
| `POST` | `/api/impexp/financial-disposition` | Propose/approve/reject/execute captured failure disposition |
| `GET`  | `/api/impexp/history`        | List imported bookings                  |
| `GET`  | `/api/impexp/users?role=...` | List valid assignment targets           |

Import, history, assignment lookup, and Sync require `superadmin`, `admin`, or
`staff_support`. Confirm & Pay requires the exact assigned B2C owner or a B2B/
B2B sub-user in the assigned agency. Staff operators cannot perform the
customer payment confirmation.

### Database

The original import foundation is in:

- `0037_impexp_booking_imports.sql`
- `0038_impexp_passenger_details.sql`
- `0039_fix_us_bangla_pnr_month_day_deadlines.sql`
- `0040_impexp_wallet_and_sync.sql`

The current protected manual-ticket/import model additionally requires
migrations `0043`–`0082`, especially `0061`–`0068` for imported invariants,
operation/case ownership, completion, outcome routing, disposition, escalation,
direct charge authorization, and price separation.

Imported records use `flight_bookings.import_source = 'IMP_EXP'`. Audit data is
stored in `imported_by_user_id` and `import_metadata`. The atomic
`create_impexp_booking_v2`, `wallet_confirm_impexp_booking`,
`sync_impexp_booking_v2`, `complete_impexp_manual_ticketing_v1`, and the
imported financial-disposition RPCs own their narrow boundaries.
`supplier_gross_amount` and `user_payable_amount` are stored separately as
integer minor units. The normal pricing snapshot also retains Supplier Gross in
`supplierTotalPrice/grossPrice` and User Payable in `sellingPrice`.

The customer-facing e-ticket, downloadable ticket, and confirmation email use
the supplier-authored fare breakdown and Supplier Gross as the ticket face
value. User Payable remains the wallet, ledger, and payment amount and is never
substituted into the e-ticket fare breakdown or total.

Migration `0040_impexp_wallet_and_sync.sql` also rebuilds
`booking_lifecycle_v` so the imported pricing columns remain available through
canonical booking reads, then recreates the dependent
`booking_payment_report_v` with its established payment projection.

The migration intentionally does not backfill historical imports. A historical
row without protected owner/User Payable data is blocked from financial Sync or
re-import and must follow a controlled reconciliation process.

## Deployment Requirements

Chrome, Chromium, or Microsoft Edge must be installed on a normal server. Set
`CHROME_EXECUTABLE_PATH` when automatic executable discovery is insufficient.
Vercel deployments use `@sparticuz/chromium-min`; the matching compressed
Chromium release pack is downloaded to `/tmp` instead of being bundled with the
function. The official Sparticuz v143.0.4 x64/arm64 release URL is selected from
the runtime architecture by default. `CHROMIUM_PACK_URL` may override it with a
trusted HTTPS mirror. The first cold invocation can take longer while the pack
is downloaded and extracted; warm invocations reuse the prepared `/tmp`
executable.

Packaging/runtime success does not mean the airline will accept the deployed
browser. Vercel executes in a separate cloud environment and cannot reuse the
operator's trusted Chrome profile, completed Device Check, cookies, or network
identity. A session-shaped URL cannot bridge that boundary. Direct website
retrieval is therefore environment- and supplier-policy-dependent even when the
Chromium executable and Playwright assets are correct.

Optional stable-entry overrides:

- `US_BANGLA_FIND_BOOKING_URL`
- `AIR_ASTRA_FIND_BOOKING_URL`
- `NOVOAIR_RETRIEVE_BOOKING_URL`

No `SUPPLIER_IMPORT_API_BASE_URL` or Tripfeels backend URL is used.

If retrieval reports that serverless Chromium could not be prepared, check the
Vercel function log for the preserved download/extraction error and confirm that
the deployment can reach `CHROMIUM_PACK_URL` (or the default GitHub release).
The three browser-backed IMP/EXP functions also explicitly trace Playwright's
root `browsers.json` runtime asset; a production error referencing that file
means the deployment predates this tracing configuration or was built from a
different commit.

Before enabling this feature in an environment, apply migrations in order
through `0082_booking_notification_address_hash_resolution.sql`, run
`npm run verify:impexp-phase6-gate` and `npm run verify:impexp-wallet` with the
normal typecheck, lint, and build, and verify staff evidence/maker-checker roles.
Do not backfill User Payable from Supplier Gross and do not repair historical
wallet balances as part of deployment.

## Troubleshooting

### Booking not found

Confirm that:

1. The correct provider is selected.
2. Airline ref / PNR contains the airline locator, not the surname.
3. Passenger last name contains the surname, not the PNR.
4. The booking opens on the airline website with the same values.
5. A pasted Manage Booking URL belongs to the selected airline.

### Incorrect status

Compare the status shown on the live airline page with import history. Re-import
the same provider/PNR to synchronize the existing booking. Do not manually edit
the database status to work around scraper evidence.

### Browser runtime failure

Errors about a missing executable, Chromium pack, Playwright module, or
`browsers.json` mean the server browser did not start correctly. Verify the
deployment includes the current runtime tracing configuration, can download the
configured pack, and has enough execution time.

### Airline Device Check or CAPTCHA

A Device Check message means Chromium started and reached the airline, but the
upstream security system rejected or challenged that server-side environment.
The same booking may still work in a normal operator Chrome session because the
two browsers do not share cookies, fingerprint, verification state, or IP.

Retrying a temporary session URL does not transfer that trust and must not be
treated as a reliable production solution. Do not suppress the detector, solve
the challenge automatically, or add an anti-bot bypass. Use an official airline/
TTInteractive API or a supplier-approved persistent integration host/network.
Preview failure occurs before import, ledger creation, or wallet debit.

## Critical Invariants

1. Airline websites are queried directly; never add a Tripfeels backend proxy.
2. BDFare must not appear as an import provider.
3. Only `superadmin`, `admin`, and `staff_support` may access IMP/EXP.
4. Names originate from airline data; manual passenger rows only supplement it.
5. Refunded/cancelled/voided evidence always overrides ticket presence.
6. Re-import must update the existing provider/PNR record, not create a duplicate.
7. Original supplier references must remain separate from the airline PNR.
8. Imported bookings must use the canonical ShoponTravels lifecycle and shape.
9. Triplover issue, cancel, and refresh operations must not run on IMP/EXP records.
10. Operational changes remain managed in the source airline/supplier system.
11. Assignment is mandatory; operators never become fallback wallet owners.
12. B2B and B2B sub-users use the shared agency wallet; B2C uses a personal wallet.
13. On Hold import never charges. Confirm & Pay captures only User Payable and moves to In Progress.
14. Direct confirmed import never implies a debit; Import & Charge requires a fresh matching one-use authorization, while Import Only opens an Accounts case.
15. Sync, Complete, and re-import never create an additional wallet debit.
16. Supplier Gross and User Payable remain distinct; Sync cannot overwrite User Payable.
17. A missing assigned wallet/account always fails; when capture is required, frozen/inactive or insufficient wallets fail without partial financial state.
18. Confirm & Pay is owner-only; operations staff import and Sync but cannot substitute their wallet.
19. Duplicate import, retry, concurrent confirmation, and double-click are database-idempotent.
20. Paid imported booking failure/cancellation requires an explicit case-bound maker-checker disposition, never a direct balance edit or generic refund shortcut.
21. Imported e-ticket fare rows and total use supplier evidence/Supplier Gross; User Payable remains the wallet and payment amount.
22. A Manage Booking session URL never represents transferred cookies or device trust, and supplier Device Check/CAPTCHA must fail closed without bypass.
23. Every captured manual-ticket booking has a Support-owned operation/case with a persisted due time and bounded escalation.
24. Sync records evidence/routing only; Confirmed requires the separate Complete action with fresh complete identity-matching ticket evidence.

## Related Documentation

- [Roles and Permissions](04-ROLES-AND-PERMISSIONS.md)
- [Pricing and Markup](06-PRICING-AND-MARKUP.md)
- [Booking System](07-BOOKING-SYSTEM.md)
- [Booking Lifecycle](08-BOOKING-LIFECYCLE.md)
- [Supplier Integration](09-SUPPLIER-INTEGRATION.md)
- [Wallet System](10-WALLET-SYSTEM.md)
- [Database](12-DATABASE.md)
- [API Routes](13-API-ROUTES.md)
- [Security](14-SECURITY.md)
- [Deployment](15-DEPLOYMENT.md)
