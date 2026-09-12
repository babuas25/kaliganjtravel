# Wallet architecture

Status: implemented in source. Environments must be migrated through
`0033_verified_booking_cancellation_reconciliation.sql`. Opening balances and
unresolved legacy Pending or In Progress bookings must be reconciled before
ticketing is activated.

## Financial ownership

| Actor | Charged wallet |
|---|---|
| B2C customer | User wallet |
| B2B owner | Agency wallet |
| B2B sub-user | Parent agency wallet |
| Super Admin, Admin, Accounts Staff | Booking owner's wallet |

Operational roles never receive personal wallets. A company-owned ticket must
use a dedicated internal B2B agency account.

`flight_bookings` keeps four separate facts: owner, booked by, issued by and
charged wallet account. Existing B2C and agency bookings are backfilled by the
migration. Legacy Super Admin bookings remain ownerless and are blocked from
ticketing until reconciled.

## Money model

All amounts are integer minor units. `wallets` owns status and identity;
`wallet_accounts` carries one balance pair per currency. Adding another currency
therefore requires a new account row, not a schema change.

- Available balance is spendable.
- Hold balance is reserved for an in-flight supplier operation.
- Neither balance can become negative.
- A frozen wallet rejects new holds and debits, while deposits and refunds may
  still credit it.

The ledger records both balance dimensions before and after every movement.
PostgreSQL rejects all ledger updates and deletes. A correction is a new
approved adjustment or reversal, never a rewrite.

The service credential has no direct permission to change balance rows or
append ledger entries. It can read reports, create deposit/adjustment workflow
requests and update wallet freeze fields; balance settlement is possible only
through the database's audited wallet functions. Currency guard triggers reject
any ledger, reservation or request whose currency differs from its account.

Financial report totals are calculated from the complete wallet-account set and
are grouped by currency. Paginated detail rows must never be used as accounting
totals, and storage failures must be returned as failures rather than empty
balances or histories.

## Ticket issue sequence

1. Authorize the actor against the stored booking owner.
2. Lock booking and wallet account.
3. Validate airline PNR, authoritative deadline, frozen server price, wallet
   status, available funds and absence of an incompatible supplier operation.
4. Move available funds to hold, append `booking_hold`, and atomically claim
   `In Progress (ticketing)` on the booking.
5. Commit, then call Triplover `NewTicket` outside the database transaction.
6. Success reduces hold and appends `booking_confirm` atomically with the
   confirmed booking update.
7. A definitive, evidenced non-issuance restores available funds, appends
   `hold_release`, and restores the held booking state.
8. A network, protocol, upstream-5xx, incomplete, or weak HTTP-200 failure keeps
   the funds protected and marks both booking and reservation for
   reconciliation. The call is never blindly replayed.

Supplier-wallet shortage does not capture the customer's funds and does not
create Pending. Until Triplover supplies a stable machine-readable shortage
code, an apparent shortage is treated as ticketing reconciliation. Pending is
retained in the vocabulary but has no new automatic producer.

Direct-ticket fares use the same reservation rule before the existing `Book`
call. If the supplier issues but local finalization fails, funds remain held for
manual reconciliation.

## Approval workflows

Deposit and manual adjustment requests are mutable workflow records. Approval
locks the request and wallet account, settles the balance, appends the immutable
ledger entry and marks the workflow approved in one transaction. The requester
cannot approve their own request.

Every deposit request receives an immutable public reference in the form
`STDYYMMDD######`. The payer's bank, mobile-banking or cash reference remains a
separate field so internal audit identity is never confused with an external
payment reference.

Cash, bank transfer/deposit, cheque and mobile-banking requests keep their
method-specific audit fields. Receipt and cheque files are verified and stored
as authenticated Cloudinary assets; the database keeps only the durable handle.
Active branches and company bank accounts come from
`wallet_payment_branches` and `wallet_company_bank_accounts`. The receiver for
a cash request is resolved from Clerk and must currently hold an Admin, Super
Admin, Accounts, Support or Media Staff role. Mobile-banking providers follow
Bangladesh Bank's published MFS list; the server recomputes the depositable
amount from gross amount and gateway-fee basis points.

Refunds are limited to captured amount minus prior refunds. The booking payment
state becomes `partially-refunded` or `refunded`; retries are protected by a
unique idempotency key.

Cancelled is supplier/lifecycle truth, not proof that a refund is complete. An
active hold is released atomically only with a proven unticketed cancellation;
captured cancellations retain an owned case until an independently approved
full/partial/no-refund, external-settlement, or manual-adjustment disposition is
executed.

## Rollout

1. Confirm migrations through `0033_verified_booking_cancellation_reconciliation.sql`
   are applied in each environment.
2. Run `npm run verify:wallet`, `npm run verify:wallet:live`, typecheck, lint
   and the production build.
3. Create/reconcile opening wallet balances through approved adjustments.
4. Verify supplier credentials and one controlled staging issuance.
5. Enable ticketing from Super Admin **Supplier Control** only after Accounts signs off.
6. Monitor `payment_state = 'reconciliation'`, active reservations and security
   audit failures. Never release an ambiguous hold without an authoritative
   supplier result.
