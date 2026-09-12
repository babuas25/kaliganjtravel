# Instant Purchase

Instant purchase is used when Triplover returns `bookable: false`. These fares cannot be held. Calling Triplover `POST /api/Book` can issue paid tickets immediately, so booking and ticket issuance happen in one irreversible supplier operation.

## Boundary With Imported Confirmed Bookings

An IMP/EXP booking that is already Ticketed/Confirmed at the airline is not an
instant-purchase booking. The two flows must not share supplier-write behavior:

| Flow | Supplier action during charge | Debit basis | Database result |
| ---- | ----------------------------- | ----------- | --------------- |
| Triplover instant purchase | Reserve first, then call Triplover `Book` | Frozen normal selling price | Capture reservation after ticket evidence |
| Direct confirmed IMP/EXP import | No issue/book call; booking is already ticketed externally | Explicit imported User Payable | Create booking, debit, ledger, and Confirmed/Captured atomically |

Imported held bookings also do not use instant purchase: import does not charge,
owner Confirm & Pay captures User Payable and moves to In Progress, and staff
ticket manually before non-financial Sync. See
[IMP/EXP Booking Imports](17-IMP-EXP-IMPORTS.md).

For imported confirmed bookings, User Payable remains the debit/captured amount
but the generated e-ticket displays the airline Supplier Gross and supplier fare
breakdown. This presentation rule does not apply to the Triplover instant-
purchase pricing calculation.

## User Experience

- Search results show **Instant Purchase** and **Hold unavailable**.
- RePrice remains mandatory before checkout.
- If RePrice changes the selling price, the customer must explicitly accept it.
- Checkout collects and validates traveller and contact information normally.
- Review warns that confirmation reserves the full wallet amount and immediately requests ticket issuance.
- There is no hold-then-issue step or online Book Cancel path after issuance.

The final action is labelled **Book and issue ticket**. A direct-ticket fare can be prepared and reviewed while ticketing is disabled, but it cannot be submitted.

## Feature Gates

| Super Admin control | Purpose |
| --- | --- |
| `booking_enabled` | Allows supplier booking submissions generally |
| `ticketing_enabled` | Allows paid-ticket operations, including direct-ticket `Book` |

Both database controls must be enabled before instant purchase is available.
Checkout receives read-only capability booleans for rendering, but
`app/api/flights/booking/route.ts` remains authoritative.

When `ticketing_enabled=false`:

- Search and RePrice continue to work.
- A direct-ticket draft can be prepared and reviewed.
- Checkout disables final submission.
- The server returns `TICKETING_DISABLED` before claiming the attempt, reserving funds, or calling Triplover.

Client-side disabling is a user-experience measure and must never replace the server gate.

## End-to-End Flow

1. Search returns `bookable: false`.
2. The server caches the exact supplier references and marks the selection as direct ticketing.
3. RePrice verifies the live fare.
4. The customer accepts any changed fare and opens checkout.
5. The server stores a private attempt with frozen selling price, currency, passenger mix, references, and `directTicketing: true`.
6. Checkout validates travellers and displays the instant-purchase warning.
7. Final confirmation triggers server checks for authentication, ownership, expiry, feature gates, passenger mix, and ages.
8. The attempt is atomically claimed to prevent double submission.
9. The wallet moves the full frozen selling amount from available balance to hold balance.
10. Only after reservation succeeds does the server call Triplover `POST /api/Book`.
11. A valid response is persisted with PNR, ticket reference, and ticket numbers.
12. The reservation is captured, `booking_confirm` is appended, and the booking becomes Confirmed.
13. The customer is redirected to the durable booking page and receives confirmation email.

## Wallet Handling

The amount comes from the server-frozen selling price, including configured markup and applicable service margin. The browser cannot choose the charge amount.

| Stage | Available balance | Hold balance | Ledger/reservation state |
| --- | --- | --- | --- |
| Before submission | Unchanged | Unchanged | No direct-ticket reservation |
| Before supplier call | Reduced by full amount | Increased by full amount | `booking_hold` / active |
| Tickets proven issued | Unchanged | Reduced by full amount | `booking_confirm` / captured |
| Definitive rejection | Restored | Reduced by full amount | `hold_release` / released |
| Ambiguous result | Remains protected | Remains held | reconciliation |

Wallet reservation and capture use audited PostgreSQL functions. Application code must not directly update balances or ledger rows.

## Supplier Outcomes

### Tickets issued

A successful response must contain authoritative ticket evidence, including ticket numbers and the ticket reference required by wallet capture. The booking is persisted and funds are captured.

### Definite rejection

If Triplover authoritatively rejects the request and no ticket could have been issued, the reservation is released and available funds are restored.

### Unexpected held booking

If a direct-ticket selection unexpectedly returns a normal held booking, the wallet reservation is released. The booking is retained for operational visibility but is not treated as instant-ticket success.

### Ambiguous or incomplete result

Network failures, timeouts, upstream 5xx responses, malformed payloads, incomplete ticket evidence, and local persistence or capture failures after a supplier response require reconciliation. Funds remain held because a ticket may exist.

The supplier call must never be blindly replayed. Accounts must establish supplier truth from stored references before capturing or releasing funds.

## Idempotency and Recovery

- Each wallet operation uses a stable request ID derived from the attempt.
- An attempt can be claimed only once.
- Checkout recovery reads durable state instead of resubmitting `/api/Book`.
- A browser or gateway timeout does not prove supplier failure.
- An `unknown` or reconciliation result must tell the customer not to submit again.

## Cancellation and Refunds

Triplover Book Cancel applies only to held, unticketed PNRs. An issued instant-purchase booking cannot use it. Voids and refunds must follow the supplier's post-ticket process and the platform's guarded refund workflow.

## Key Implementation Files

| Area | File |
| --- | --- |
| Result labels and selection | `components/flights/ItineraryCard.tsx` |
| Checkout gate and warning | `components/flights/BookingCheckout.tsx` |
| Public attempt capabilities | `lib/flights/booking.ts` |
| Draft capability projection | `lib/db/booking-attempts.ts` |
| Submission and outcomes | `app/api/flights/booking/route.ts` |
| Triplover Book parsing | `lib/triplover/book.ts` |
| Feature gates | `lib/db/supplier-controls.ts` |
| Wallet wrappers | `lib/db/wallet.ts` |
| Wallet database functions | `supabase/migrations/0019_wallet_core.sql`, `supabase/migrations/0031_booking_lifecycle_authority.sql` |
| Safety verification | `scripts/verify-wallet.mjs` |

## Safe Verification

Keep Super Admin **ticketing enabled** off during implementation and routine verification:

```bash
npm run typecheck
npm run lint
npm run verify:wallet
npm run verify:booking-lifecycle
npm run build
```

Do not call production `/api/Book` with a `bookable: false` fare as a test; it can issue and charge a real ticket. Supplier end-to-end verification requires Triplover UAT or an explicitly authorized production purchase.

## Critical Invariants

- Ticketing must be enabled server-side before any direct-ticket wallet or supplier operation.
- Wallet funds must be reserved before calling Triplover.
- The charge must use the frozen server-side pricing snapshot.
- Authoritative ticket evidence is required before wallet capture.
- Ambiguous outcomes keep funds protected and enter reconciliation.
- `Book` is never automatically retried after an ambiguous result.
- Issued instant-purchase bookings cannot use held-booking cancellation.
- The browser never controls feature gates, supplier references, wallet ownership, or payment amount.

## Related Documentation

- [07-BOOKING-SYSTEM.md](07-BOOKING-SYSTEM.md)
- [08-BOOKING-LIFECYCLE.md](08-BOOKING-LIFECYCLE.md)
- [09-SUPPLIER-INTEGRATION.md](09-SUPPLIER-INTEGRATION.md)
- [10-WALLET-SYSTEM.md](10-WALLET-SYSTEM.md)
- [13-API-ROUTES.md](13-API-ROUTES.md)
- [14-SECURITY.md](14-SECURITY.md)
- [15-DEPLOYMENT.md](15-DEPLOYMENT.md)
- [17-IMP-EXP-IMPORTS.md](17-IMP-EXP-IMPORTS.md)
