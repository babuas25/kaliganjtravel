# Wallet System

**Status:** Implemented and production-ready. Requires migration through `0033_verified_booking_cancellation_reconciliation.sql`.

The wallet system provides a secure, audited financial ledger for managing customer and agency funds. It handles payment reservations, deposits, refunds, and manual adjustments with immutable transaction logging and multi-currency support.

## Table of Contents

1. [Wallet System Architecture](#1-wallet-system-architecture)
2. [Wallet Ownership](#2-wallet-ownership)
3. [Currency Accounts and Balances](#3-currency-accounts-and-balances)
4. [Available vs Hold Balance](#4-available-vs-hold-balance)
5. [Immutable Ledger System](#5-immutable-ledger-system)
6. [Payment Reservations](#6-payment-reservations)
7. [Deposit Request Workflows](#7-deposit-request-workflows)
8. [Wallet Permissions and Access Control](#8-wallet-permissions-and-access-control)
9. [Financial Operations](#9-financial-operations)
10. [Database Schema](#10-database-schema)

---

## 1. Wallet System Architecture

The wallet system is built on a multi-table PostgreSQL schema with strict database-level constraints, triggers, and SECURITY DEFINER functions to ensure financial integrity.

### Core Design Principles

- **Atomic Operations**: All balance changes occur within locked transactions that update balances and append ledger entries atomically
- **Immutable Ledger**: Transaction history cannot be modified or deleted; corrections are new approved adjustments or reversals
- **Currency Isolation**: Each currency is a separate account row; adding a currency requires a new account, not schema changes
- **Service Role Boundary**: The application service role has no direct permission to modify balances or ledger entries; all changes must pass through audited database functions
- **Audit Trail**: Every financial operation records actor identity, role, timestamps, and optional remarks
- **Case-Bound Reconciliation**: Uncertain or terminal financial truth is resolved
  only by an owned case, fresh normalized evidence, an unchanged proposal, and
  an independent authorized checker

### Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│ Application Layer (lib/db/wallet.ts)                     │
│ - Wallet storage operations                              │
│ - Deposit/adjustment request management                  │
│ - Reservation and transaction orchestration              │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Permission Layer (lib/wallet/permissions.ts)            │
│ - Wallet ownership resolution                            │
│ - Financial access control                               │
│ - Booking operation authorization                        │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Database Functions (SECURITY DEFINER)                   │
│ - wallet_ensure_account()                                │
│ - wallet_reserve_amount()                                │
│ - wallet_capture_reservation()                           │
│ - wallet_release_reservation()                           │
│ - wallet_review_deposit()                                 │
│ - wallet_review_adjustment()                              │
│ - wallet_refund_booking()                                │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Database Tables                                          │
│ - wallets                                                │
│ - wallet_accounts                                        │
│ - wallet_reservations                                    │
│ - wallet_ledger_entries                                  │
│ - wallet_deposit_requests                                │
│ - wallet_adjustment_requests                             │
└─────────────────────────────────────────────────────────┘
```

### Implementation References

- **Core operations**: `lib/db/wallet.ts` - Wallet storage, reservations, and workflow management
- **Permissions**: `lib/wallet/permissions.ts` - Ownership resolution and access control
- **Original architecture**: `WALLET_ARCHITECTURE.md` - Detailed technical specification
- **Database schema**: `supabase/migrations/0019_wallet_core.sql` - Core tables and functions

---

## 2. Wallet Ownership

Wallet ownership determines which entity financially owns the funds and which wallet is charged for bookings.

### Ownership Types

| Owner Type | Owner Key | Description |
|------------|-----------|-------------|
| `user` | Clerk user ID | B2C customer wallet |
| `agency` | Agency code | B2B agency wallet |

### Wallet Assignment Rules

| Actor | Charged Wallet | Implementation |
|-------|----------------|----------------|
| B2C customer | User wallet | `owner_type: 'user'`, `owner_key: clerkId` |
| B2B owner | Agency wallet | `owner_type: 'agency'`, `owner_key: agencyCode` |
| B2B sub-user | Parent agency wallet | Inherits parent agency's wallet |
| Super Admin, Admin, Accounts Staff | Booking owner's wallet | Financial operators may operate eligible bookings but never own the funds |

**Critical:** Operational roles (Admin, Super Admin, Staff) never receive personal wallets. A company-owned ticket must use a dedicated internal B2B agency account.

### Ownership Resolution

The system resolves wallet ownership from session context in `lib/wallet/permissions.ts`:

```typescript
export function walletOwnerForSession(
  session: DashboardSession
): WalletOwner | null {
  if (session.role === 'customer') {
    return { ownerType: 'user', ownerKey: session.clerkId };
  }
  if (
    (session.role === 'b2b' || session.role === 'b2b_sub') &&
    session.agencyCode
  ) {
    return { ownerType: 'agency', ownerKey: session.agencyCode };
  }
  return null; // Admin/staff roles do not resolve to personal wallets
}
```

### Booking Ownership Fields

The `flight_bookings` table maintains separate ownership and actor facts:

- `booking_owner_type` - Financial owner type (`user` or `agency`)
- `booking_owner_key` - Financial owner key (Clerk ID or agency code)
- `booked_by_user_id` - User who created the booking
- `issued_by_user_id` - User who issued the ticket
- `charged_wallet_account_id` - Wallet account that was charged

A database trigger (`set_booking_wallet_ownership`) automatically sets these fields on insert/update based on audience and agency code.

### Cross-References

- **Booking lifecycle**: See `docs/08-BOOKING-LIFECYCLE.md` for how ownership integrates with booking states
- **Security**: See `docs/14-SECURITY.md` for authorization controls

---

## 3. Currency Accounts and Balances

Each wallet can hold multiple currency accounts. Currency is modeled as a separate account row rather than a column, enabling unlimited currency support without schema changes.

### Account Structure

```typescript
type WalletAccountSummary = {
  walletId: string;
  accountId: string;
  ownerType: 'user' | 'agency';
  ownerKey: string;
  status: 'active' | 'frozen';
  currency: string;           // ISO 4217 code (e.g., 'BDT', 'USD')
  availableBalance: number;   // Spendable funds (minor units)
  holdBalance: number;        // Reserved funds (minor units)
  totalBalance: number;        // available + hold
  updatedAt: string;
};
```

### Currency Enforcement

- Currency codes must match regex `^[A-Z]{3}$` (ISO 4217 format)
- Database triggers enforce that ledger entries, reservations, and requests must match their account's currency
- Currency mismatch at the database boundary raises an exception
- Existing mismatches must be reconciled before enabling guards (see migration 0021)

### Account Creation

Accounts are created on-demand via the `wallet_ensure_account()` function:

```sql
create or replace function public.wallet_ensure_account(
  p_owner_type text,
  p_owner_key text,
  p_currency text default 'BDT'
)
returns public.wallet_accounts
```

This function:
1. Validates owner type and currency format
2. Creates the wallet row if it doesn't exist (upsert on unique constraint)
3. Creates the currency account if it doesn't exist (upsert on wallet_id + currency)
4. Returns the account row

### Implementation Reference

- **Account creation**: `lib/db/wallet.ts` - `ensureAccount()` and `ensureWalletForOwner()`
- **Database function**: `supabase/migrations/0019_wallet_core.sql` - `wallet_ensure_account()`

---

## 4. Available vs Hold Balance

Each currency account maintains two balance dimensions that serve different purposes in the booking lifecycle.

### Balance Dimensions

| Balance | Purpose | Constraints |
|---------|---------|-------------|
| `available_balance` | Immediately spendable funds | Cannot be negative |
| `hold_balance` | Funds reserved for in-flight supplier operations | Cannot be negative |

### Balance State Machine

```
┌─────────────────────────────────────────────────────────────┐
│ Initial State: available = X, hold = 0                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │ Hold (booking)  │
                    │ available -= A  │
                    │ hold += A       │
                    └─────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    ┌───────────────────┐           ┌───────────────────┐
    │ Capture (success) │           │ Release (failure) │
    │ hold -= A         │           │ hold -= A         │
    │ (funds consumed)  │           │ available += A    │
    └───────────────────┘           └───────────────────┘
```

### Frozen Wallet Behavior

A wallet with `status = 'frozen'`:
- **Rejects** new holds and debits
- **Accepts** deposits and refunds (can still credit)
- **Retains** existing holds until resolved
- Records freeze timestamp, actor, and reason

### Balance Calculation

```typescript
totalBalance = availableBalance + holdBalance
```

Financial reports are calculated from the complete wallet-account set and grouped by currency. Paginated detail rows must never be used as accounting totals.

### Implementation Reference

- **Balance operations**: `supabase/migrations/0019_wallet_core.sql` - Reservation and ledger functions
- **Freeze logic**: `lib/db/wallet.ts` - `setWalletStatus()`

---

## 5. Immutable Ledger System

The ledger provides a complete, tamper-proof history of all financial movements. Every balance change is recorded with before/after snapshots for both balance dimensions.

### Ledger Entry Structure

```typescript
type WalletLedgerEntry = {
  id: string;
  walletAccountId: string;
  transactionType: WalletTransactionType;
  amount: number;                  // Transaction amount (minor units)
  currency: string;
  availableBefore: number;         // Balance before transaction
  availableAfter: number;          // Balance after transaction
  holdBefore: number;
  holdAfter: number;
  bookingId: string | null;
  bookingReference: string | null;
  createdByUserId: string;
  createdByRole: string;
  remarks: string | null;
  createdAt: string;
  ownerType?: 'user' | 'agency';
  ownerKey?: string;
};
```

### Transaction Types

| Type | Description | Balance Impact |
|------|-------------|----------------|
| `deposit` | Approved deposit request | available += amount |
| `booking_hold` | Funds reserved for booking | available -= amount, hold += amount |
| `booking_confirm` | Booking successfully issued | hold -= amount (funds consumed) |
| `hold_release` | Booking failed/cancelled | hold -= amount, available += amount |
| `refund` | Refund to customer | available += amount |
| `manual_credit` | Manual adjustment (credit) | available += amount |
| `manual_debit` | Manual adjustment (debit) | available -= amount |
| `adjustment` | Generic adjustment | Varies by context |
| `reversal` | Reversal of previous transaction | Reverses original impact |

### Immutability Enforcement

```sql
create trigger wallet_ledger_immutable
  before update or delete on public.wallet_ledger_entries
  for each row execute function public.prevent_wallet_ledger_mutation();
```

The trigger raises exception `55000` on any UPDATE or DELETE attempt. Corrections must be new approved transactions, never modifications to history.

### Idempotency

Each ledger entry has a unique `idempotency_key` to prevent duplicate transactions from replayed requests. The unique constraint ensures the same key cannot be used twice.

### Audit Trail

Every ledger entry records:
- `created_by_user_id` - Clerk ID of the actor
- `created_by_role` - Role of the actor (e.g., 'admin', 'customer')
- `remarks` - Optional human-readable explanation
- `metadata` - JSONB field for structured supplementary data

### Correction Policy

**Never modify ledger entries.** To correct an error:
1. Create an adjustment request with a clear reason
2. Approve the adjustment (creates a new ledger entry)
3. For reversals, create a reversal entry that references the original via `related_entry_id`

### Implementation Reference

- **Ledger table**: `supabase/migrations/0019_wallet_core.sql` - `wallet_ledger_entries`
- **Query functions**: `lib/db/wallet.ts` - `listAccountLedger()`, `listAllLedger()`

---

## 6. Payment Reservations

Reservations protect funds during supplier operations. When a booking is issued, funds are moved from available to hold, and a reservation record tracks the operation lifecycle.

### Reservation States

| State | Description | Next States |
|-------|-------------|-------------|
| `active` | Funds held, supplier call in progress | `captured`, `released`, `reconciliation` |
| `captured` | Supplier confirmed, funds consumed | - (terminal) |
| `released` | Supplier failed, funds returned | - (terminal) |
| `reconciliation` | Ambiguous outcome requiring manual review | - (terminal) |

### Reservation Structure

```sql
create table public.wallet_reservations (
  id                       uuid primary key,
  wallet_account_id        uuid references wallet_accounts,
  booking_id               uuid references flight_bookings,        -- one required
  booking_attempt_id       uuid references booking_attempts,       -- one required
  amount                   bigint not null check (amount > 0),
  currency                 text not null check (currency ~ '^[A-Z]{3}$'),
  state                    text not null default 'active',
  cycle                    integer not null default 1,              -- retry counter
  requested_by_user_id     text not null,
  issued_by_user_id        text,
  supplier_call_started_at timestamptz,
  captured_at              timestamptz,
  released_at              timestamptz,
  reconciliation_at        timestamptz,
  reconciliation_reason    text,
  release_reason           text,
  check ((booking_id is not null)::integer +
         (booking_attempt_id is not null)::integer = 1)  -- XOR constraint
);
```

### Reservation Lifecycle

#### Booking Issue Sequence

1. **Authorize** - Verify actor against stored booking owner
2. **Lock** - Lock booking and wallet account (SELECT FOR UPDATE)
3. **Validate** - Check airline PNR, deadline, server price, wallet status, available funds, and absence of incompatible operations
4. **Hold** - Move available funds to hold, append `booking_hold` ledger entry, claim `In Progress (ticketing)` on booking
5. **Commit** - Commit transaction, then call Triplover `NewTicket` outside database
6. **Capture** - On success, reduce hold and append `booking_confirm` atomically with booking update
7. **Release** - On definitive non-issuance, restore available funds, append `hold_release`, restore held booking state
8. **Reconcile** - On network/protocol/upstream failure, keep funds held, mark for manual reconciliation

#### Direct Ticketing

Direct-ticket fares use the same reservation rule before the existing `Book` call. If the supplier issues but local finalization fails, funds remain held for manual reconciliation.

### Reconciliation Policy

**Never blindly replay a failed supplier call.** A reservation in
`reconciliation` remains protected until an owned case has fresh authoritative
evidence and an approved outcome. Support may investigate supplier truth;
Accounts/Admin/Super Admin may propose financial outcomes; Admin/Super Admin may
approve, and the checker must differ from the maker. Release, capture, refund,
or retained-money disposition then occurs only through the exact case-bound RPC.

#### Case-Bound Financial Dispositions

The allowed disposition is explicit and persisted on
`booking_reconciliation_cases`:

| Disposition | Financial effect |
| --- | --- |
| `capture_existing_hold` | Consume the exact locked reservation after complete ticket evidence |
| `release_existing_hold` | Return the exact hold after authoritative non-issuance or cancellation evidence |
| `full_refund` | Credit the full remaining captured amount |
| `partial_refund` | Credit the independently approved positive amount, not more than the remaining capture |
| `no_refund_due` | Move no money; retain captured truth with approved evidence/reason |
| `externally_settled` | Move no local money; retain a non-secret external settlement reference |
| `manual_adjustment_required` | Keep the case open and the financial inconsistency visible |

Supplier refund/penalty figures are evidence, not permission to mutate the local
wallet. Booking, operation, case, reservation, wallet/account, ledger, lifecycle
event, and outbox changes commit atomically for an executed disposition.

### Implementation Reference

- **Reservation table**: `supabase/migrations/0019_wallet_core.sql` - `wallet_reservations`
- **Hold function**: `supabase/migrations/0019_wallet_core.sql` - `wallet_reserve_amount()`
- **Capture function**: `supabase/migrations/0019_wallet_core.sql` - `wallet_capture_reservation()`
- **Release function**: `supabase/migrations/0019_wallet_core.sql` - `wallet_release_reservation()`
- **TypeScript wrappers**: `lib/db/wallet.ts` - `beginBookingIssue()`, `captureBookingReservation()`, `releaseReservation()`

---

## 7. Deposit Request Workflows

Deposits use a maker-checker workflow where requests are created by any user with wallet access but must be approved by financial staff before funds are credited.

### Request Lifecycle

```
┌──────────────┐
│   Pending    │ ← Created by requester
└──────────────┘
       │
       ├──────────────┐
       ▼              ▼
┌──────────────┐  ┌──────────────┐
│  Approved    │  │  Rejected    │
│ (funds added)│  │ (no action)  │
└──────────────┘  └──────────────┘
```

### Deposit Methods

| Method | Required Fields | Notes |
|--------|-----------------|-------|
| `cash` | `branch_id`, `received_by_user_id` | Physical cash received at branch |
| `bank` | `company_bank_account_id`, `deposit_date`, `reference_number`, `attachment` | Bank transfer/deposit |
| `mobile` | `mfs_provider`, `mfs_account_id`, `mfs_payment_type`, `deposit_date`, `reference_number`, `gateway_fee_bps`, `gross_amount`, `attachment` | Mobile financial service (MFS) |
| `cheque` | `cheque_issued_date`, `cheque_issued_bank`, `payment_date`, `company_bank_account_id`, `reference_number`, `attachment` | Cheque payment |

### Public Reference Format

Every deposit request receives an immutable public reference in the format `STDYYMMDD######`:

```
STD260802000001
 │     │      └── Daily sequence, zero-padded to 6 digits
 │     └───────── YYMMDD of allocation (Asia/Dhaka timezone)
 └─────────────── Fixed prefix
```

- Allocated atomically via `deposit_ref_counters` table with row-level locking
- Daily capacity: 999,999 requests
- Immutable once assigned (trigger prevents changes)
- Reference uses Asia/Dhaka date, not UTC

### Request Structure

```typescript
type DepositRequestRow = {
  id: string;
  public_ref: string;                    // STDYYMMDD######
  wallet_account_id: string;
  amount: number;
  currency: string;
  method: 'cash' | 'bank' | 'mobile' | 'cheque';
  reference_number: string | null;
  branch_id: string | null;
  received_by_user_id: string | null;
  company_bank_account_id: string | null;
  deposit_date: string | null;
  cheque_issued_date: string | null;
  cheque_issued_bank: string | null;
  payment_date: string | null;
  mfs_provider: string | null;
  mfs_account_id: string | null;
  mfs_payment_type: 'merchant' | 'send_money' | 'cashout' | null;
  user_bank_account: UserBankAccountSnapshot | null;
  gateway_fee_bps: number | null;
  gross_amount: number | null;
  attachment: StoredDoc | null;
  remarks: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requested_by_user_id: string;
  reviewed_by_user_id: string | null;
  review_remarks: string | null;
  requested_at: string;
  reviewed_at: string | null;
  updated_at: string;
};
```

### Approval Process

Approval locks the request and wallet account, settles the balance, appends the immutable ledger entry, and marks the workflow approved in one transaction. The requester cannot approve their own request.

### MFS Fee Calculation

For mobile deposits, the server recomputes the depositable amount from:
- `gross_amount` - Total amount sent by payer
- `gateway_fee_bps` - Gateway fee in basis points (e.g., 15 = 1.5%)

```
depositable_amount = gross_amount - (gross_amount * gateway_fee_bps / 10000)
```

### Payment Catalogs

- **Branches**: `wallet_payment_branches` - Physical office locations for cash collection
- **Bank accounts**: `wallet_company_bank_accounts` - Company bank accounts for deposits
- **MFS accounts**: `wallet_company_mfs_accounts` - Company mobile financial service accounts

MFS providers follow Bangladesh Bank's published MFS list.

### Implementation Reference

- **Deposit table**: `supabase/migrations/0019_wallet_core.sql` - `wallet_deposit_requests`
- **Public references**: `supabase/migrations/0022_deposit_public_references.sql`
- **Payment channels**: `supabase/migrations/0023_deposit_channels.sql`
- **TypeScript functions**: `lib/db/wallet.ts` - `createDepositRequest()`, `listDepositRequests()`, `reviewDeposit()`

---

## 8. Wallet Permissions and Access Control

Wallet operations are gated by role-based permissions that determine who can view, create, and manage financial transactions.

### Financial Roles

The following roles have financial access:

```typescript
const FINANCIAL_ROLES = new Set<Role>([
  'superadmin',
  'admin',
  'staff_support',
  'staff_account',
]);
```

### Access Control Functions

#### `hasFinancialAccess(role: Role): boolean`

Returns `true` if the role can perform financial operations on behalf of other wallets.

#### `walletOwnerForSession(session: DashboardSession): WalletOwner | null`

Resolves the wallet owner for a session:
- `customer` → `{ ownerType: 'user', ownerKey: clerkId }`
- `b2b` → `{ ownerType: 'agency', ownerKey: agencyCode }`
- `b2b_sub` → `{ ownerType: 'agency', ownerKey: agencyCode }` (parent agency)
- `admin`, `superadmin`, `staff_*` → `null` (no personal wallet)

#### `canIssueBooking(session, booking): boolean`

Determines if a session can issue a booking:
- Financial roles can issue any owner-backed booking
- Customers and B2B users can only issue bookings they own
- Rare Pending bookings can proceed only through the writer for their explicitly
  recorded prerequisite; Pending is not the normal supplier-wallet-shortage path

#### `canCancelBooking(session, booking): boolean`

Determines if a session can cancel a booking:
- Only live holds (`status = 'on-hold'`, `lifecycle_status = 'on-hold'`) can be cancelled
- Financial roles can cancel any owner's booking
- Wallet owners can cancel their own bookings
- Direct-ticketed or already-issued bookings cannot be cancelled via wallet release

#### `canCreateOwnBooking(role: Role): boolean`

Returns `true` if the role can create bookings (customer, b2b, b2b_sub).

### Database-Level Security

The service role has restricted database permissions:

```sql
-- Service role can:
-- SELECT on all wallet tables
-- UPDATE only wallet status fields (status, frozen_at, frozen_by, freeze_reason)
-- INSERT deposit and adjustment requests

-- Service role CANNOT:
-- Directly UPDATE wallet_accounts balances
-- Directly INSERT wallet_ledger_entries
-- Directly UPDATE or DELETE wallet_ledger_entries
-- Directly UPDATE wallet_reservations state
```

All balance mutations must pass through SECURITY DEFINER functions (`wallet_reserve_amount`, `wallet_capture_reservation`, etc.) which enforce business logic and audit requirements.

Financial access is capability-specific. `staff_support` can inspect operational
context and acquire supplier evidence but cannot propose a refund/fee/settlement
outcome or use the generic refund action. `staff_account`, `admin`, and
`superadmin` may propose financial outcomes. Only `admin` and `superadmin` may
approve/execute high-risk case outcomes, and never their own proposal.

### Report View Security

Reporting views use `security_invoker = true` to respect the caller's RLS context as defense in depth:

```sql
alter view public.wallet_report_v set (security_invoker = true);
alter view public.wallet_transaction_report_v set (security_invoker = true);
alter view public.booking_payment_report_v set (security_invoker = true);
```

### Implementation Reference

- **Permission logic**: `lib/wallet/permissions.ts`
- **Database guards**: `supabase/migrations/0021_wallet_currency_and_privilege_guards.sql`
- **View security**: `supabase/migrations/0020_wallet_report_view_security.sql`
- **Super Admin Issue Now resolution**: `supabase/migrations/0106_superadmin_booking_decisions.sql` and `0107_superadmin_issue_resolution.sql`

### Super Admin Decision Accounting Precedence

`flight_bookings.payment_state` is a display/summary field and can be stale. A
Super Admin booking decision classifies accounting from the matching
reservation and immutable `booking_hold`, `booking_confirm`, `hold_release`,
and `refund` ledger entries first:

- Ticket Issued: an existing capture means no charge and an active actual Hold
  is captured once. Missing/incomplete local capture data never triggers an
  automatic direct charge in this resolver; it requires the separate audited
  supplier-verified lane.
- Cancel: an active actual hold is released even if `payment_state` says
  `unpaid`; no hold and no capture means no movement; a captured payment uses
  the explicit full/partial/no-refund/external-settlement choice.
- Restore On Hold: an active Issue Now Hold is released to Available; proven
  no-money state has no movement.
- A reservation/ledger/currency/amount identity conflict fails the whole
  automatic transaction before the booking or wallet changes.

When local accounting is incomplete, the manual lane fixes the target wallet
from booking ownership, shows exact current/resulting Available and Hold,
protects Hold allocated to other live reservations, and writes a distinct
`superadmin_resolution_*` immutable ledger entry. Supplier and customer-wallet
amounts are separate fields. It never creates a reservation or edits history.

---

## 9. Financial Operations

Financial operations are the atomic actions that move funds between balance dimensions and create ledger entries.

### Core Operations

#### Credit (Add Funds)

Increases available balance. Used for:
- Approved deposits
- Refunds
- Manual credits

```typescript
// Implemented via wallet_review_deposit() or wallet_refund_booking()
// Ledger entry: transaction_type = 'deposit' | 'refund' | 'manual_credit'
// Balance change: available += amount
```

#### Debit (Remove Funds)

Decreases available balance. Used for:
- Manual debits
- Adjustments

```typescript
// Implemented via wallet_review_adjustment()
// Ledger entry: transaction_type = 'manual_debit'
// Balance change: available -= amount
```

#### Hold (Reserve Funds)

Moves funds from available to hold. Used for:
- Booking issue initiation
- Direct ticketing

```typescript
// Implemented via wallet_begin_booking_issue() or wallet_begin_direct_ticket()
// Ledger entry: transaction_type = 'booking_hold'
// Balance change: available -= amount, hold += amount
```

#### Capture (Consume Held Funds)

Reduces hold balance (funds consumed by supplier). Used for:
- Successful booking confirmation

```typescript
// Implemented via wallet_capture_reservation()
// Ledger entry: transaction_type = 'booking_confirm'
// Balance change: hold -= amount
```

#### Release (Return Held Funds)

Moves funds from hold back to available. Used for:
- Failed booking attempts
- Booking cancellations
- Direct ticketing failures

```typescript
// Implemented via wallet_release_reservation() or wallet_finalize_booking_cancel()
// Ledger entry: transaction_type = 'hold_release'
// Balance change: hold -= amount, available += amount
```

### Operation Workflows

#### Booking Issue Workflow

```typescript
// 1. Begin issue (hold funds)
const result = await beginBookingIssue(bookingId, session, requestId);
if (!result.ok) return error;

// 2. Call supplier API (outside transaction)
const supplierOutcome = await callTriploverNewTicket(...);

// 3. Capture or release based on outcome
if (supplierOutcome.success) {
  await captureBookingReservation(bookingId, session, requestId, supplierOutcome);
} else if (isDefinitiveFailure(supplierOutcome)) {
  await releaseReservation({ bookingId }, session, requestId, reason);
} else {
  await markReservationForReconciliation({ bookingId }, reason);
}
```

#### Imported Booking Capture

Imported bookings do not use the normal Triplover issue workflow:

- A Held import only validates that the assigned owner has the required currency
  account. Import stores On Hold/Unpaid and moves no money.
- Confirm & Pay is restricted to the exact assigned B2C owner or an authorized
  user of the assigned agency. `wallet_confirm_impexp_booking` locks the booking
  and account, validates active status and funds, deducts User Payable directly
  from available balance, creates a captured reservation and immutable
  `booking_confirm` entry, marks payment Captured, and moves the booking to In
  Progress in one transaction.
- An already confirmed/ticketed supplier booking requires an explicit choice.
  Import Only creates Confirmed/Unpaid plus an Accounts-owned case and does not
  move money. Import & Charge first records a five-minute, payload-bound,
  one-use authorization, then atomically consumes it for the single User Payable
  debit. The legacy direct-confirmed auto-charge signature is not callable by
  the application service role.
- B2B sub-users use the parent/shared agency wallet. Admin/support is the
  operator, never the wallet owner or fallback account.
- Sync and re-import never call wallet functions or write ledger/reservation
  rows. Supplier Gross is never used as the debit amount.

The amount printed on an imported e-ticket is not a wallet amount. The ticket
uses Supplier Gross and supplier fare rows, while the captured reservation,
payment report, and immutable ledger continue to show User Payable. No ticket
rendering change may update wallet balances or payment attribution.

The imported capture intentionally creates one `booking_confirm` ledger entry
without a preceding active hold because no supplier API write occurs inside the
payment action. Its captured reservation and the stable ledger key
`impexp-payment:<booking-id>` preserve the existing reporting and refund/
reconciliation model.

#### Cancellation Workflow

An ordinary proven cancellation with an active hold atomically releases that
exact hold; it is not a refund. If the supplier outcome is ambiguous, the hold
remains protected in reconciliation. A Cancelled/Captured booking never implies
that a refund already happened: it requires an approved full/partial/no-refund,
external-settlement, or manual-adjustment disposition.

#### Refund Workflow

The generic refund RPC is limited to eligible ordinary captured bookings with no
Cancelled/reconciliation/open-case state and re-reads the actor role from
`app_users`. Case-bound captured cancellations and imported manual-ticket
failures use their exact approved resolution RPC instead. All refunds are capped
at captured amount minus prior refunds and are idempotent ledger credits.

### Idempotency Keys

All operations require an idempotency key to prevent duplicate processing:

```typescript
// Generate unique key per operation attempt
const requestId = crypto.randomUUID();
await beginBookingIssue(bookingId, session, requestId);
```

The database enforces uniqueness on `wallet_ledger_entries.idempotency_key`.
Imported payments additionally serialize provider/reference import, lock the
booking/account rows, and reuse the stable per-booking payment key. A different
HTTP request UUID, retry, concurrent request, double-click, re-import, or Sync
therefore cannot create a second debit for the same obligation.

### Error Handling

Operations return a structured result:

```typescript
type WalletOperationResult = {
  ok: boolean;
  code?: string;              // Error code (e.g., 'INSUFFICIENT_FUNDS')
  reservationId?: string;
  accountId?: string;
  available?: number;         // Current available balance
  required?: number;          // Amount required
  amount?: number;
  currency?: string;
  availableBalance?: number;
  holdBalance?: number;
  replay?: boolean;           // True if operation was replayed
  status?: string;
  refundable?: number;
  refundedAmount?: number;
};
```

### Implementation Reference

- **Operation functions**: `lib/db/wallet.ts` - All `begin*`, `capture*`, `release*`, `finalize*` functions
- **Database RPCs**: `supabase/migrations/0019_wallet_core.sql` - Core `wallet_*` SECURITY DEFINER functions
- **Imported capture RPCs**: `supabase/migrations/0062_impexp_confirm_manual_ticket_operation.sql` and `0067_impexp_direct_import_charge_authorization.sql`
- **Case-bound capture/release/refund guards**: migrations `0052`–`0059`
- **Imported financial disposition**: `supabase/migrations/0065_impexp_manual_ticket_financial_disposition.sql`

---

## 10. Database Schema

The wallet system uses six core tables with strict constraints, triggers, and security definitions.

### Table: `wallets`

Stores wallet identity and status.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PRIMARY KEY | Wallet identifier |
| `owner_type` | text | CHECK in ('user', 'agency') | Owner type |
| `owner_key` | text | CHECK length 1-255 | Clerk user ID or agency code |
| `status` | text | CHECK in ('active', 'frozen') | Wallet status |
| `frozen_at` | timestamptz | | Freeze timestamp |
| `frozen_by` | text | | User who froze the wallet |
| `freeze_reason` | text | | Reason for freeze |
| `created_at` | timestamptz | NOT NULL | Creation timestamp |
| `updated_at` | timestamptz | NOT NULL | Last update |

**Indexes:**
- `wallets_status_idx` on (status, updated_at DESC)

**Unique constraint:**
- (owner_type, owner_key)

### Table: `wallet_accounts`

Stores currency-specific balances.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PRIMARY KEY | Account identifier |
| `wallet_id` | uuid | FK → wallets.id | Parent wallet |
| `currency` | text | CHECK `^[A-Z]{3}$` | ISO 4217 currency code |
| `available_balance` | bigint | CHECK >= 0 | Spendable funds (minor units) |
| `hold_balance` | bigint | CHECK >= 0 | Reserved funds (minor units) |
| `created_at` | timestamptz | NOT NULL | Creation timestamp |
| `updated_at` | timestamptz | NOT NULL | Last update |

**Indexes:**
- `wallet_accounts_wallet_idx` on (wallet_id, currency)

**Unique constraint:**
- (wallet_id, currency)

### Table: `wallet_reservations`

Tracks payment reservations for booking operations.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PRIMARY KEY | Reservation identifier |
| `wallet_account_id` | uuid | FK → wallet_accounts.id | Account holding funds |
| `booking_id` | uuid | FK → flight_bookings.id | Booking (optional) |
| `booking_attempt_id` | uuid | FK → booking_attempts.id | Booking attempt (optional) |
| `amount` | bigint | CHECK > 0 | Reserved amount |
| `currency` | text | CHECK `^[A-Z]{3}$` | Currency code |
| `state` | text | CHECK in ('active', 'captured', 'released', 'reconciliation') | Reservation state |
| `cycle` | integer | CHECK > 0 | Retry cycle |
| `requested_by_user_id` | text | NOT NULL | User who requested hold |
| `issued_by_user_id` | text | | User who issued ticket |
| `supplier_call_started_at` | timestamptz | | Supplier call start |
| `captured_at` | timestamptz | | Capture timestamp |
| `released_at` | timestamptz | | Release timestamp |
| `reconciliation_at` | timestamptz | | Reconciliation timestamp |
| `reconciliation_reason` | text | | Reconciliation reason |
| `release_reason` | text | | Release reason |
| `created_at` | timestamptz | NOT NULL | Creation timestamp |
| `updated_at` | timestamptz | NOT NULL | Last update |

**Check constraint:**
- Exactly one of booking_id or booking_attempt_id must be non-null (XOR)

**Indexes:**
- `wallet_reservations_booking_key` on (booking_id) WHERE booking_id IS NOT NULL
- `wallet_reservations_attempt_key` on (booking_attempt_id) WHERE booking_attempt_id IS NOT NULL
- `wallet_reservations_state_idx` on (state, updated_at DESC)

### Table: `wallet_ledger_entries`

Immutable transaction history.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PRIMARY KEY | Entry identifier |
| `wallet_account_id` | uuid | FK → wallet_accounts.id | Affected account |
| `transaction_type` | text | CHECK in (transaction types) | Transaction type |
| `amount` | bigint | CHECK > 0 | Transaction amount |
| `currency` | text | CHECK `^[A-Z]{3}$` | Currency code |
| `available_before` | bigint | CHECK >= 0 | Available balance before |
| `available_after` | bigint | CHECK >= 0 | Available balance after |
| `hold_before` | bigint | CHECK >= 0 | Hold balance before |
| `hold_after` | bigint | CHECK >= 0 | Hold balance after |
| `booking_id` | uuid | FK → flight_bookings.id | Related booking |
| `booking_reference` | text | | Public booking reference |
| `reservation_id` | uuid | FK → wallet_reservations.id | Related reservation |
| `related_entry_id` | uuid | FK → wallet_ledger_entries.id | Related entry (for reversals) |
| `idempotency_key` | text | UNIQUE, length 1-255 | Idempotency key |
| `created_by_user_id` | text | NOT NULL | Actor user ID |
| `created_by_role` | text | NOT NULL | Actor role |
| `remarks` | text | | Optional remarks |
| `metadata` | jsonb | CHECK is object | Structured metadata |
| `created_at` | timestamptz | NOT NULL | Creation timestamp |

**Transaction types:**
- 'deposit', 'booking_hold', 'booking_confirm', 'hold_release', 'refund', 'manual_credit', 'manual_debit', 'adjustment', 'reversal'

**Indexes:**
- `wallet_ledger_account_created_idx` on (wallet_account_id, created_at DESC)
- `wallet_ledger_booking_created_idx` on (booking_id, created_at DESC)
- `wallet_ledger_type_created_idx` on (transaction_type, created_at DESC)

**Triggers:**
- `wallet_ledger_immutable` - Prevents UPDATE and DELETE operations

### Table: `wallet_deposit_requests`

Deposit request workflow records.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PRIMARY KEY | Request identifier |
| `public_ref` | text | UNIQUE, CHECK `^STD[0-9]{12}$` | Public reference |
| `wallet_account_id` | uuid | FK → wallet_accounts.id | Target account |
| `amount` | bigint | CHECK > 0 | Deposit amount |
| `currency` | text | CHECK `^[A-Z]{3}$` | Currency code |
| `method` | text | CHECK in ('cash', 'bank', 'mobile', 'cheque') | Deposit method |
| `reference_number` | text | | Payer reference |
| `branch_id` | uuid | FK → wallet_payment_branches.id | Branch (for cash) |
| `received_by_user_id` | text | | Receiver (for cash) |
| `company_bank_account_id` | uuid | FK → wallet_company_bank_accounts.id | Company bank account |
| `deposit_date` | date | | Deposit date |
| `cheque_issued_date` | date | | Cheque issue date |
| `cheque_issued_bank` | text | | Cheque issuing bank |
| `payment_date` | date | | Payment date |
| `mfs_provider` | text | | MFS provider name |
| `mfs_account_id` | uuid | FK → wallet_company_mfs_accounts.id | MFS account |
| `mfs_payment_type` | text | CHECK in ('merchant', 'send_money', 'cashout') | MFS payment type |
| `user_bank_account` | jsonb | | User bank snapshot |
| `gateway_fee_bps` | integer | CHECK 0-10000 | Gateway fee basis points |
| `gross_amount` | bigint | CHECK > 0 | Gross amount (before fees) |
| `attachment` | jsonb | CHECK is object | Cloudinary document handle |
| `remarks` | text | | Requester remarks |
| `status` | text | CHECK in ('pending', 'approved', 'rejected') | Request status |
| `requested_by_user_id` | text | NOT NULL | Requester user ID |
| `reviewed_by_user_id` | text | | Reviewer user ID |
| `review_remarks` | text | | Reviewer remarks |
| `ledger_entry_id` | uuid | FK → wallet_ledger_entries.id | Created ledger entry |
| `requested_at` | timestamptz | NOT NULL | Request timestamp |
| `reviewed_at` | timestamptz | | Review timestamp |
| `updated_at` | timestamptz | NOT NULL | Last update |

**Indexes:**
- `wallet_deposit_queue_idx` on (status, requested_at DESC)
- `wallet_deposit_requests_public_ref_key` on (public_ref)

**Triggers:**
- `wallet_deposit_public_ref_immutable` - Prevents public_ref changes
- `wallet_deposits_currency_guard` - Enforces currency match with account

### Table: `wallet_adjustment_requests`

Manual adjustment workflow records.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PRIMARY KEY | Request identifier |
| `wallet_account_id` | uuid | FK → wallet_accounts.id | Target account |
| `adjustment_type` | text | CHECK in ('credit', 'debit') | Adjustment direction |
| `amount` | bigint | CHECK > 0 | Adjustment amount |
| `currency` | text | CHECK `^[A-Z]{3}$` | Currency code |
| `reason` | text | CHECK length 1-1000 | Adjustment reason |
| `status` | text | CHECK in ('pending', 'approved', 'rejected') | Request status |
| `requested_by_user_id` | text | NOT NULL | Requester user ID |
| `requested_by_role` | text | NOT NULL | Requester role |
| `reviewed_by_user_id` | text | | Reviewer user ID |
| `review_remarks` | text | | Reviewer remarks |
| `ledger_entry_id` | uuid | FK → wallet_ledger_entries.id | Created ledger entry |
| `requested_at` | timestamptz | NOT NULL | Request timestamp |
| `reviewed_at` | timestamptz | | Review timestamp |
| `updated_at` | timestamptz | NOT NULL | Last update |

**Indexes:**
- `wallet_adjustment_queue_idx` on (status, requested_at DESC)

**Triggers:**
- `wallet_adjustments_currency_guard` - Enforces currency match with account

### Supporting Tables

#### `wallet_payment_branches`

Physical office locations for cash collection.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `name` | text | CHECK length 1-150 |
| `address` | text | |
| `active` | boolean | NOT NULL |
| `sort_order` | integer | NOT NULL |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

#### `wallet_company_bank_accounts`

Company bank accounts for deposits.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `bank_name` | text | CHECK length 1-150 |
| `account_name` | text | CHECK length 1-150 |
| `account_number` | text | CHECK length 1-100, UNIQUE |
| `branch_name` | text | |
| `branch_code` | text | |
| `routing_number` | text | |
| `swift_code` | text | |
| `logo` | jsonb | CHECK is object |
| `active` | boolean | NOT NULL |
| `sort_order` | integer | NOT NULL |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

#### `wallet_company_mfs_accounts`

Company mobile financial service accounts.

| Column | Type | Constraints |
|--------|------|-------------|
| `id` | uuid | PRIMARY KEY |
| `mfs_name` | text | CHECK length 1-100 |
| `account_number` | text | CHECK length 3-100 |
| `payment_type` | text | CHECK in ('merchant', 'send_money', 'cashout') |
| `charge_bps` | integer | CHECK 0-10000 |
| `logo` | jsonb | CHECK is object |
| `qr_code` | jsonb | CHECK is object |
| `active` | boolean | NOT NULL |
| `sort_order` | integer | NOT NULL |
| `created_at` | timestamptz | NOT NULL |
| `updated_at` | timestamptz | NOT NULL |

#### `deposit_ref_counters`

Daily deposit reference allocation counters.

| Column | Type | Constraints |
|--------|------|-------------|
| `ref_date` | date | PRIMARY KEY |
| `last_value` | integer | CHECK 0-999999 |
| `updated_at` | timestamptz | NOT NULL |

### Views

#### `wallet_report_v`

Aggregated wallet and account summaries for reporting.

#### `wallet_transaction_report_v`

Cross-reference view joining ledger entries with wallet and account metadata.

#### `booking_payment_report_v`

Booking payment state reconciliation report.

All views use `security_invoker = true` and are accessible only to service_role.

### Implementation Reference

- **Core schema**: `supabase/migrations/0019_wallet_core.sql`
- **Currency guards**: `supabase/migrations/0021_wallet_currency_and_privilege_guards.sql`
- **Deposit references**: `supabase/migrations/0022_deposit_public_references.sql`
- **Payment channels**: `supabase/migrations/0023_deposit_channels.sql`
- **View security**: `supabase/migrations/0020_wallet_report_view_security.sql`

---

## Cross-References

### Related Documentation

- **Booking Lifecycle**: `docs/08-BOOKING-LIFECYCLE.md` - How wallet operations integrate with booking states
- **Security**: `docs/14-SECURITY.md` - Security practices and audit logging
- **Database**: `docs/12-DATABASE.md` - Complete database architecture
- **API Routes**: `docs/13-API-ROUTES.md` - Wallet-related API endpoints
- **IMP/EXP Imports**: `docs/17-IMP-EXP-IMPORTS.md` - Imported booking charging and Sync rules

### Related Source Files

- **Wallet operations**: `lib/db/wallet.ts`
- **Permissions**: `lib/wallet/permissions.ts`
- **Payment options**: `lib/wallet/payment-options.ts`
- **Deposit review**: Likely in dashboard components (search for `reviewDeposit` usage)

### Original Architecture Document

- **WALLET_ARCHITECTURE.md** - Original technical specification with detailed rollout procedures

---

## Critical Invariants

1. **Never modify ledger entries** - Corrections must be new approved transactions
2. **Never replay failed supplier calls** - Mark for reconciliation instead
3. **Never bypass currency guards** - All operations must match account currency
4. **Never allow negative balances** - Both available and hold must remain >= 0
5. **Never approve own requests** - Requester and reviewer must be different users
6. **Never change public references** - Deposit references are immutable
7. **Never skip authorization** - All operations must verify session permissions
8. **Never use paginated totals for accounting** - Sum from complete dataset only
9. **Never charge Supplier Gross for an import** - The debit basis is stored User Payable
10. **Never substitute the operator wallet** - Resolve the assigned B2C or shared agency financial owner
11. **Never charge on held import or Sync** - Held imports charge only at owner Confirm & Pay; direct confirmed import charges only after explicit Import & Charge authorization
12. **Never infer refund completion from Cancelled** - Captured cancellations keep an explicit case/disposition until resolved
13. **Never self-approve reconciliation money movement** - The maker and Admin/Super Admin checker are different current users
14. **Never bypass an owned uncertainty case** - Generic release/refund guards reject reconciliation and open-case subjects
15. **Never rely on UI idempotency** - Imported and reconciliation duplicate protection is enforced by database identity, locks, hashes, and unique ledger keys
16. **Never choose a Super Admin wallet action from `payment_state` alone** - Matching reservation and ledger truth take priority; ambiguity fails closed

---

## Before Modifying This System

- [ ] Read `WALLET_ARCHITECTURE.md` for detailed technical rationale
- [ ] Review the specific migration that introduced the feature you're changing
- [ ] Test balance changes with the database functions, not direct table updates
- [ ] Verify currency guard triggers still pass after schema changes
- [ ] Ensure idempotency keys are generated and passed correctly
- [ ] Check that view queries still return correct results after schema changes
- [ ] Run `npm run verify:wallet` and related verification scripts
- [ ] Coordinate with Accounts team before changing approval workflows
- [ ] Document any new transaction types or balance dimensions
- [ ] Update this documentation to reflect any architectural changes
