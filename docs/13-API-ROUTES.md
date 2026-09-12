# API Routes

This document describes the internal/backend API routes that power the ShoponTravels platform. These endpoints are consumed by the dashboard application and external webhooks.

## Table of Contents

1. [API Routes Overview and Organization](#api-routes-overview-and-organization)
2. [Flight Booking Endpoints](#flight-booking-endpoints)
3. [Staff Booking Lifecycle Endpoints](#staff-booking-lifecycle-endpoints)
4. [IMP/EXP Endpoints](#impexp-endpoints)
5. [Wallet Endpoints](#wallet-endpoints)
6. [Reports Endpoints](#reports-endpoints)
7. [Webhook Endpoints](#webhook-endpoints)
8. [Authentication and Authorization](#authentication-and-authorization)
9. [Rate Limiting](#rate-limiting)
10. [Error Handling Patterns](#error-handling-patterns)
11. [Request/Response Formats](#requestresponse-formats)
12. [Security Considerations](#security-considerations)

---

## API Routes Overview and Organization

### Directory Structure

API routes are organized in `app/api/` following Next.js App Router conventions:

```
app/api/
├── airports/
│   └── route.ts                    # Airport search endpoint
├── flights/
│   ├── search/
│   │   └── route.ts                # Flight search
│   ├── reprice/
│   │   └── route.ts                # Fare reprice/verification
│   ├── fare-rules/
│   │   └── route.ts                # Fare rules retrieval
│   └── booking/
│       ├── route.ts                # Booking submission
│       ├── prepare/
│       │   └── route.ts            # Booking draft preparation
│       ├── draft/
│       │   └── route.ts            # Draft retrieval
│       ├── status/
│       │   └── route.ts            # Booking status polling
│       ├── issue/
│       │   └── route.ts            # Ticket issuance
│       ├── cancel/
│       │   └── route.ts            # Booking cancellation
│       └── refresh-details/
│           └── route.ts            # Supplier ticket details refresh
├── admin/booking-lifecycle/
│   ├── route.ts                     # Staff booking operation/case list
│   ├── attempts/route.ts            # Unresolved attempt cases
│   ├── metrics/route.ts             # PII-free lifecycle health
│   └── [reference]/
│       ├── timeline/route.ts         # Masked operation/case/event history
│       ├── evidence/route.ts         # Case-bound supplier reads
│       └── reconciliation/
│           ├── proposal/route.ts     # Maker proposal
│           ├── decision/route.ts     # Independent approval/rejection
│           └── nonissuance-attestation/route.ts
├── impexp/
│   ├── authorize-charge/route.ts     # Non-financial prior authorization
│   ├── complete-booking/route.ts     # Evidence-bound completion; no debit
│   └── financial-disposition/route.ts # Propose/decide/execute failure outcome
├── wallet/
│   ├── route.ts                    # Wallet summary and ledger
│   ├── admin/
│   │   └── route.ts                # Wallet administration
│   ├── ledger/
│   │   └── route.ts                # Financial ledger view
│   ├── deposits/
│   │   ├── route.ts                # Deposit request list/create
│   │   └── [id]/
│   │       └── route.ts            # Deposit request review
│   ├── adjustments/
│   │   ├── route.ts                # Adjustment request list/create
│   │   └── [id]/
│   │       └── route.ts            # Adjustment request review
│   ├── company-bank-accounts/
│   │   ├── route.ts                # Company bank account CRUD
│   │   └── [id]/
│   │       └── logo/
│   │           └── route.ts        # Bank account logo upload
│   └── company-mfs-accounts/
│       ├── route.ts                # MFS account CRUD
│       └── [id]/
│           └── assets/
│               └── [kind]/
│                   └── route.ts    # MFS logo/QR code upload
├── reports/
│   └── issued-tickets/
│       └── route.ts                # Issued tickets report
└── webhooks/
    └── clerk-email/
        └── route.ts                # Clerk email relay webhook
```

### Route Handler Conventions

All API routes follow these conventions:

- **Runtime**: Set to `nodejs` for compatibility with external APIs
- **Dynamic**: Set to `force-dynamic` to disable caching for sensitive operations
- **Max Duration**: Configured for long-running supplier operations (up to 300s for search)
- **Validation**: Zod schemas for request validation
- **Error Handling**: Consistent error response format
- **Headers**: `Cache-Control: no-store` for all sensitive endpoints

### Common Patterns

**Response Format**: Most endpoints return JSON in this format:

```typescript
// Success
{ success: true, data: {...} }

// Error
{ success: false, error: { errorCode: string, errorMessage: string } }
```

**Helper Functions**: Shared response builders in `lib/wallet/http.ts`:

- `walletOk(data, status)` - Success response with `Cache-Control: no-store`
- `walletFail(status, errorCode, errorMessage, details)` - Error response
- `walletOperationResponse(result)` - Converts wallet operation results

---

## Flight Booking Endpoints

### `/api/flights/search` - Flight Search

**Implementation**: `app/api/flights/search/route.ts`

**Method**: `POST`

**Purpose**: Search for flights through Triplover API. This is the only public endpoint that can be called by signed-out visitors (used on marketing home page).

**Request Schema**:
```typescript
{
  tripType: 'oneway' | 'round' | 'multicity',
  routes: Array<{
    origin: string,        // IATA code (3 uppercase letters)
    destination: string,   // IATA code
    departureDate: string  // YYYY-MM-DD format
  }>,
  adults: number,         // 1-9
  children: number,       // 0-8
  infants: number,        // 0-9 (must not exceed adults)
  childrenAges: number[], // Ages 2-11, one per child
  cabinClass: 'Economy' | 'Premium Economy' | 'Business' | 'First' | 'Premium First',
  preferredCarriers: string[]  // Optional, up to 8 airline codes
}
```

**Constraints**:
- Maximum 9 seated passengers (adults + children)
- Maximum 6 routes for multi-city trips
- Each infant must travel with an adult
- Children ages required for accurate pricing
- Airport codes validated as 3-letter IATA codes

**Response**:
```typescript
{
  success: true,
  data: {
    searchId: string,      // UUID for this search
    routes: [...],        // Itinerary options
    refsByItineraryId: Map<string, SupplierReferences>,
    expiresAt: string,    // ISO timestamp
    currency: string
  }
}
```

**Special Features**:
- **Server-Timing Header**: Detailed performance metrics for each stage
- **Concurrency Control**: Maximum 8 concurrent searches server-wide
- **Long Duration**: 300s timeout for slow supplier responses
- **Rate Limiting**: 20 requests per 5 minutes per IP address

**Cross-References**:
- See [05-FLIGHT-SEARCH.md](05-FLIGHT-SEARCH.md) for search architecture
- See [09-SUPPLIER-INTEGRATION.md](09-SUPPLIER-INTEGRATION.md) for Triplover integration

---

### `/api/flights/reprice` - Fare Reprice/Verification

**Implementation**: `app/api/flights/reprice/route.ts`

**Method**: `POST`

**Purpose**: Revalidate a selected fare against the live supplier to verify price and availability before booking.

**Request Schema**:
```typescript
{
  searchId: string,        // UUID from search response
  itineraryId: string      // Format: itn-{index}-{supplierIndex}
}
```

**Response**:
```typescript
{
  success: true,
  data: {
    uniqueTransId: string,
    itemCodeRef: string,
    priceCodeRef: string,
    fares: [...],
    currency: string,
    pricing: {
      audience: string,
      agencyCode: string | null,
      sellingPrice: number,
      serviceMarginAmount: number,
      supplierTotalPrice: number,
      grossPrice: number,
      ruleId: string | null,
      basis: string
    },
    requiresConfirmation: boolean,  // True if price changed
    bookable: boolean,              // False if direct ticketing required
    repricedAt: string              // ISO timestamp
  }
}
```

**Rate Limiting**: 30 requests per 5 minutes per user

**Error Codes**:
- `REPRICE_UNCONFIGURED` (503) - Triplover not configured
- `INVALID_REPRICE` (400) - Invalid searchId or itineraryId
- `RATE_LIMITED` (429) - Too many reprice attempts
- `REPRICE_TIMEOUT` (504) - Supplier timeout
- `REPRICE_FAILED` (502) - Supplier error

---

### `/api/flights/booking/prepare` - Booking Draft Preparation

**Implementation**: `app/api/flights/booking/prepare/route.ts`

**Method**: `POST`

**Purpose**: Create a booking attempt (draft) with an access token for checkout. This is called after successful reprice.

**Request Schema**:
```typescript
{
  searchId: string,
  itineraryId: string,
  acceptedRepricedAt: string | null  // ISO timestamp if price changed
}
```

**Response**:
```typescript
{
  success: true,
  data: {
    bookingId: string,       // UUID
    accessToken: string,     // 32-128 character token
    offerSnapshot: {
      itinerary: {...},
      fares: [...],
      currency: string,
      pricing: {...},
      passengerCounts: {...},
      travelDate: string,
      directTicketing: boolean,
      passportRequired: boolean,
      repricedAt: string
    },
    expiresAt: string
  }
}
```

**Authorization**: Requires authentication. Only customers and B2B users can create bookings (operational accounts cannot).

**Validation**:
- Reprice must be fresh (within 5 minutes)
- If price changed, user must have accepted the new price
- Passport requirement determined by route airports

**Rate Limiting**: 20 requests per 5 minutes per user

**Cross-References**:
- See [07-BOOKING-SYSTEM.md](07-BOOKING-SYSTEM.md) for booking flow
- See [08-BOOKING-LIFECYCLE.md](08-BOOKING-LIFECYCLE.md) for booking states

---

### `/api/flights/booking/draft` - Draft Retrieval

**Implementation**: `app/api/flights/booking/draft/route.ts`

**Method**: `POST`

**Purpose**: Retrieve a booking draft for the checkout page. Returns draft data and suggested contact information for B2B users.

**Request Schema**:
```typescript
{
  bookingId: string,       // UUID
  accessToken: string      // From prepare response
}
```

**Response**:
```typescript
{
  success: true,
  data: {
    bookingId: string,
    offerSnapshot: {...},
    expiresAt: string,
    suggestedContact?: {   // Only for B2B/B2B_sub
      phone: string,
      phoneCountryCode: string
    }
  }
}
```

**Authorization**: User must own the draft (matches `user_id`).

**Error Codes**:
- `DRAFT_NOT_FOUND` (404) - Draft doesn't exist or user doesn't own it
- `DRAFT_CLOSED` (409) - Draft already submitted (state != 'draft')

---

### `/api/flights/booking` - Booking Submission

**Implementation**: `app/api/flights/booking/route.ts`

**Method**: `POST`

**Purpose**: Submit traveller information and create a booking with the supplier. This is the irreversible booking step.

**Request Schema**:
```typescript
{
  bookingId: string,
  accessToken: string,
  travellers: Array<{
    passengerType: 'ADT' | 'CHD' | 'CNN' | 'INF' | 'INS',
    title: 'Mr' | 'Mrs' | 'Ms' | 'Mstr' | 'Miss',
    firstName: string,      // 1-60 chars, letters/spaces/apostrophes/hyphens
    lastName: string,
    gender: 'Male' | 'Female',
    dateOfBirth: string,    // YYYY-MM-DD
    passportNumber?: string, // Required for international routes
    passportExpiry?: string,
    issuingCountry?: string, // 2-letter country code
    nationality: string
  }>,
  contact: {
    phone: string,          // 6-15 digits
    phoneCountryCode: string, // +[1-4 digits]
    customerEmail: string
  }
}
```

**Validation**:
- Passenger mix must match offer exactly
- Ages must match passenger types (ADT ≥12, CHD 5-11, CNN 2-4, INF <2)
- Passport required for international routes (expiry after travel date)
- Draft must not be expired
- Draft must be in 'draft' state

**Response**:
```typescript
// Success
{
  success: true,
  state: 'succeeded' | 'pending',
  data?: {
    booking: {...},        // Full booking details if succeeded
    wallet?: {...}        // Wallet state if payment captured
  }
}

// Failure
{
  success: false,
  error: { errorCode, errorMessage }
}
```

**Rate Limiting**: 5 requests per hour per user (strictest limit)

**Error Codes**:
- `BOOKING_DISABLED` (503) - Booking submission not enabled
- `BOOKING_ALREADY_STARTED` (409) - Draft already submitted
- `DRAFT_EXPIRED` (410) - Fare expired
- `PASSENGER_MISMATCH` (400) - Passenger details don't match offer
- `BOOKING_FAILED` (502) - Supplier declined booking
- `BOOKING_OUTCOME_UNKNOWN` (503) - Supplier outcome ambiguous

**Special Features**:
- **Optimistic Locking**: Claims booking attempt to prevent duplicate submissions
- **Direct Ticketing**: Routes that can't be held are ticketed immediately
- **Wallet Reservation**: Funds reserved before supplier call when possible
- **Email Notification**: Confirmation email sent on success

**Cross-References**:
- See [BOOKING_ARCHITECTURE.md](../BOOKING_ARCHITECTURE.md) for detailed booking flow
- See [10-WALLET-SYSTEM.md](10-WALLET-SYSTEM.md) for payment reservation

---

### `/api/flights/booking/status` - Booking Status Polling

**Implementation**: `app/api/flights/booking/status/route.ts`

**Method**: `POST`

**Purpose**: Poll for booking result after submission connection loss. Never calls the supplier, so polling is safe.

**Request Schema**:
```typescript
{
  bookingId: string,
  accessToken: string
}
```

**Response**:
```typescript
// Draft state
{ success: true, state: 'draft' }

// Submitting state
{ success: true, state: 'pending' }

// Succeeded
{
  success: true,
  state: 'succeeded',
  data: { booking: {...} }
}

// Failed
{
  success: false,
  error: {
    errorCode: 'BOOKING_FAILED',
    errorMessage: 'The airline declined the booking...'
  }
}

// Unknown
{
  success: false,
  error: {
    errorCode: 'BOOKING_OUTCOME_UNKNOWN',
    errorMessage: 'The airline outcome is unknown...'
  }
}
```

**States**:
- `draft` - Not yet submitted
- `submitting` - Optimistic claim held while the supplier Book call is active
- `succeeded` - Booking created successfully
- `failed` - Supplier declined booking
- `unknown` - Supplier outcome ambiguous (reconciliation needed)

---

### `/api/flights/booking/issue` - Ticket Issuance

**Implementation**: `app/api/flights/booking/issue/route.ts`

**Methods**: `GET`, `POST`

**Purpose**: Issue tickets for on-hold bookings using wallet funds.

**GET Request** - Prepare issuance:
```typescript
?reference=STRXXXXXXXXXXXX  // 12-digit booking reference
```

**GET Response**:
```typescript
{
  success: true,
  data: {
    wallet: {
      accountId: string,
      availableBalance: number,
      holdBalance: number,
      totalBalance: number,
      currency: string
    },
    requiredAmount: number,  // 0 if already captured
    paymentState: 'captured' | 'uncaptured'
  }
}
```

**POST Request** - Execute issuance:
```typescript
{
  bookingReference: string,  // STRXXXXXXXXXXXX
  requestId: string          // UUID for idempotency
}
```

**POST Response**:
```typescript
{
  success: true,
  data: {
    booking: {...},          // Updated booking with ticket details
    wallet: {...}            // Updated wallet state
  }
}
```

**Authorization**:
- Financial operators (superadmin, admin, staff) can issue any booking
- Customers/B2B users can only issue their own wallet-backed bookings
- Rare Pending prerequisite/compatibility bookings require an authorized
  operational user; Pending does not prove supplier-wallet failure or prior debit

**Validation**:
- Booking must be in 'on-hold' or 'pending' status
- Booking must have wallet owner assigned
- Supplier references must be present
- Wallet must have sufficient available balance
- Booking supplier must be `triplover`; imported external-supplier bookings return `EXTERNAL_SUPPLIER_BOOKING`

**Rate Limiting**: 10 requests per hour per user

**Error Codes**:
- `TICKETING_DISABLED` (503) - Ticket issuance not enabled
- `BOOKING_NOT_FOUND` (404) - Booking doesn't exist
- `ISSUE_FORBIDDEN` (403) - User cannot issue this booking
- `BOOKING_OWNER_REQUIRED` (409) - No wallet owner assigned
- `SUPPLIER_REFERENCES_MISSING` (409) - Supplier references incomplete
- `INSUFFICIENT_FUNDS` (409) - Wallet balance insufficient
- `WALLET_FROZEN` (409) - Wallet is frozen
- `PAYMENT_RECONCILIATION_REQUIRED` (503) - Tickets issued but payment needs reconciliation

**Special Features**:
- **Idempotency**: RequestId prevents duplicate issuances
- **Manual Queue**: Supports legacy queued bookings with pre-captured payments
- **Reconciliation**: Marks for reconciliation if payment capture fails after successful ticketing
- **Security Audit**: All issuances logged to security audit trail

**Cross-References**:
- See [10-WALLET-SYSTEM.md](10-WALLET-SYSTEM.md) for wallet reservation
- See [08-BOOKING-LIFECYCLE.md](08-BOOKING-LIFECYCLE.md) for booking states

---

### `/api/flights/booking/cancel` - Booking Cancellation

**Implementation**: `app/api/flights/booking/cancel/route.ts`

**Method**: `POST`

**Purpose**: Cancel an on-hold booking and release reserved funds.

**Request Schema**:
```typescript
{
  bookingReference: string,  // STRXXXXXXXXXXXX
  requestId: string          // UUID for idempotency
}
```

**Response**:
```typescript
{
  success: true,
  data: {
    cancellation: {...},     // Supplier cancellation response
    wallet: {...}            // Updated wallet state
  }
}
```

**Authorization**:
- Financial operators can cancel any booking
- Customers/B2B users can only cancel their own wallet-backed bookings
- Only bookings in 'on-hold' state can be cancelled

**Validation**:
- Booking must be in 'on-hold' state with 'on-hold' lifecycle status
- Must not be direct-ticketed or already issued
- Supplier references must be present
- Booking supplier must be `triplover`; imported external-supplier bookings return `EXTERNAL_SUPPLIER_BOOKING`

**Rate Limiting**: 10 requests per hour per user

**Error Codes**:
- `BOOKING_NOT_FOUND` (404) - Booking doesn't exist
- `BOOKING_NOT_CANCELLABLE` (409) - Booking not in cancellable state
- `SUPPLIER_REFERENCES_MISSING` (409) - Supplier references incomplete
- `CANCEL_IN_PROGRESS` (409) - Cancellation already in progress
- `BOOKING_EXPIRED` (410) - Ticketing deadline passed
- `BOOKING_UNCONFIRMED` (409) - PNR must be verified first
- `CANCEL_RECONCILIATION_REQUIRED` (503) - Supplier cancelled but wallet needs reconciliation
- `CANCEL_OUTCOME_UNKNOWN` (503) - Supplier outcome ambiguous

**Special Features**:
- **Reconciliation Logic**: If supplier reports failure, checks AirTicketingDetails to see if actually cancelled
- **PNR Verification**: On refusal, reads live PNR to verify hold state before restoring reservation
- **Idempotency**: RequestId prevents duplicate cancellations
- **Security Audit**: All cancellations logged to security audit trail

---

### `/api/flights/booking/refresh-details` - Supplier Ticket Details Refresh

**Implementation**: `app/api/flights/booking/refresh-details/route.ts`

**Method**: `POST`

**Purpose**: Refresh ticket details from supplier (superadmin only). Used for reconciliation and manual verification.

**Request Schema**:
```typescript
{
  bookingReference: string  // STRXXXXXXXXXXXX
}
```

**Response**:
```typescript
{
  success: true,
  data: {
    details: {
      supplierStatus: string,
      pnr: string,
      airlinesPnr: string[],
      ticketNumbers: string[],
      issuedAt: string | null,
      cancelledAt: string | null
    },
    source: 'ticketing' | 'pnr'  // Which API provided the data
  }
}
```

**Authorization**: Superadmin only

**Logic**:
- For confirmed/cancelled bookings: Reads AirTicketingDetails
- For on-hold bookings: Reads live PNR, then checks AirTicketingDetails if status indicates completion
- Syncs results to booking record
- Rejects imported external-supplier bookings; those use `/api/impexp/sync-booking`

**Error Codes**:
- `REFRESH_FORBIDDEN` (403) - Not superadmin
- `BOOKING_NOT_FOUND` (404) - Booking doesn't exist
- `SUPPLIER_REFERENCE_MISSING` (409) - No supplier transaction ID
- `TICKET_DETAILS_REFRESH_FAILED` (502) - Supplier call failed

---

### `/api/flights/fare-rules` - Fare Rules Retrieval

**Implementation**: `app/api/flights/fare-rules/route.ts`

**Method**: `POST`

**Purpose**: Retrieve airline fare rules and policies for a selected fare.

**Request Schema**:
```typescript
{
  searchId: string,
  itineraryId: string
}
```

**Response**:
```typescript
{
  success: true,
  data: {
    rules: string,          // HTML-formatted fare rules
    baggage: {...},         // Baggage allowance information
    penalties: {...}        // Cancellation/change penalties
  }
}
```

**Rate Limiting**: 60 requests per 5 minutes per actor (can be IP-based for anonymous users)

**Error Codes**:
- `FARE_RULES_UNCONFIGURED` (503) - Triplover not configured
- `INVALID_FARE_RULES_REQUEST` (400) - Invalid searchId or itineraryId
- `RATE_LIMITED` (429) - Too many requests
- `FARE_RULES_TIMEOUT` (504) - Supplier timeout
- `FARE_RULES_FAILED` (502) - Supplier error

---

## Staff Booking Lifecycle Endpoints

These routes are internal staff APIs. Customers, B2B owners, and B2B sub-users
cannot read or act on operations or reconciliation cases. Read responses are
role-masked and exclude raw supplier payloads, passenger/contact data, proposal
bodies, and notification recipients.

### Read-only lifecycle, attempt, timeline, and metrics routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/admin/booking-lifecycle` | `GET` | Paginated staff booking rows with current operation, primary open case, evidence freshness, SLA, and payment-conflict indicators |
| `/api/admin/booking-lifecycle/attempts` | `GET` | Aged `submitting`/`unknown` attempt cases; attempts are not public bookings |
| `/api/admin/booking-lifecycle/metrics` | `GET` | PII-free operation/case, notification, expiry, worker, and starvation health |
| `/api/admin/booking-lifecycle/[reference]/timeline` | `GET` | Merged immutable event, operation, and case history with role-based masking |

All require an authenticated `superadmin`, `admin`, `staff_support`, or
`staff_account` session. They do not call suppliers or mutate lifecycle/wallet
state. Attempt uncertainty remains an owned case; there is no generic endpoint
that invents a booking or marks an attempt successful.

The supplier-read and reconciliation-write endpoints below additionally require
the server-only `BOOKING_RECONCILIATION_ACTIONS_ENABLED=true` rollout switch.
When it is absent or false, an otherwise authorized request fails with `503`
and `RECONCILIATION_ACTIONS_DISABLED` before a supplier read or mutation.

### `POST /api/admin/booking-lifecycle/[reference]/evidence`

Support/Admin/Super Admin may request a case-bound `held`, `ticketed`, or
`cancelled` supplier read with `{ caseId, requestId, purpose }`. Cancelled reads
may also specify the normalized cancellation report status. The route rate-limits
and leases the read, validates booking/supplier identity, stores an immutable
payload-hashed observation, and returns only safe normalized facts.

Evidence is valid for decision use for five minutes. A replay with the same
identity reuses the observation; a changed payload is rejected. The read never
performs a destructive supplier write or wallet mutation. It may close a case as
no-change only when fresh evidence agrees with already-consistent terminal and
financial truth.

### `POST /api/admin/booking-lifecycle/[reference]/reconciliation/nonissuance-attestation`

Support/Admin/Super Admin records a hashed manual supplier-portal attestation
bound to an existing fresh Held observation. It stores no raw portal payload and
does not release funds. A separately approved non-issuance execution contract is
still required.

### `POST /api/admin/booking-lifecycle/[reference]/reconciliation/proposal`

Creates or exactly replays a version/hash-bound maker proposal. Inputs include
the case/version/request identity, supplier/financial/combined domain, named
outcome, exact financial disposition/amount/currency where applicable, evidence
observation IDs, explicit confirmation codes, and reason. Support can propose
supplier truth; Accounts can propose financial truth; Admin/Super Admin can
propose either. Proposal is not execution.

### `POST /api/admin/booking-lifecycle/[reference]/reconciliation/decision`

Admin/Super Admin approves or rejects the unchanged proposal using
`{ action, caseId, expectedCaseVersion, proposalHash, rejectionReason? }`. The
database re-reads the actor’s current role and rejects self-approval. Approval
does not itself select a broader outcome than the proposal.

### Resolution execution boundary

There is intentionally no generic `Set Status`, `Move Money`, or reconciliation
`execute` HTTP endpoint. An approved proposal can be consumed only by the named
case-bound database contract for ticketed capture, proven non-issuance release,
unpaid/held/captured cancellation, terminal correction, or historical repair.
Each contract rechecks actor authority, case version/hash, fresh evidence, and
the global lock order in the same transaction as its exact side effects.
Imported manual-ticket completion and imported financial disposition expose
their own narrow HTTP routes below.

### `/api/admin/bookings/[reference]/decision`

Super Admin-only resolution for stuck ordinary B2B/B2C Issue Now bookings.
`GET`/`POST` use `mode=automatic` with supplier outcome `ticket_issued`,
`still_valid`, or `not_issued`, or `mode=manual` for the explicit audited
supplier-verified exception. Both return an exact booking/wallet preview before
submission.

Neither method accepts or requires an evidence observation, case ID, proposal
hash, or checker approval. The automatic executor re-reads the current role and
classifies actual reservation/ledger truth under the established lock order. It
may only:

- reuse an existing capture without charging;
- capture a matching active hold;
- release a matching active hold;
- refund no more than remaining captured value; or
- record an explicit no-refund/external settlement without fabricated movement.

Incomplete accounting returns the manual-lane code rather than charging. The
manual request independently supplies `customerWalletAction`, customer amount
and verification basis, optional supplier reference/amount/currency, and exact
effect confirmation. Supplier amount never determines customer amount. The
booking-owner wallet is fixed by the server, other bookings' Hold is protected,
no reservation is fabricated, and a distinct append-only ledger/manual
resolution/audit record commits atomically. Instant Purchase, IMP/EXP, Manual
Import, deposits, generic adjustments, and other wallet flows are rejected.

---

## IMP/EXP Endpoints

All IMP/EXP routes are dynamic server routes. Supplier retrieval routes use the
Node.js runtime and allow up to 120 seconds for server-side browser navigation.
Sensitive responses are not cached.

Imported Sync, prior charge authorization, manual completion, and financial
disposition additionally require
`BOOKING_IMPORTED_MANUAL_ACTIONS_ENABLED=true`. Their staff UI is hidden and an
otherwise authorized direct request fails with `503` and
`IMPORTED_MANUAL_ACTIONS_DISABLED` while the rollout switch is off. Import Only
and the existing assigned-owner Confirm & Pay route are separate controls.

### `/api/impexp/preview-booking` - Retrieve and Review

**Implementation**: `app/api/impexp/preview-booking/route.ts`

**Method**: `POST`

**Authorization**: `superadmin`, `admin`, or `staff_support`

**Request**:

```typescript
{
  provider: 'US_BANGLA' | 'AIR_ASTRA' | 'NOVOAIR',
  orderReference: string,
  lastName: string,
  originalReference?: string,
  sourceUrl?: string
}
```

The server retrieves and normalizes the supplier booking. It returns lifecycle
status, currency, Supplier Gross, passenger count, and route for review. Import
is blocked if supplier pricing cannot be verified.

The UI may collect User Payable before this request, but it is not sent to or
derived by preview. Assignment must already be selected before Retrieve &
Review, and the final Import button remains disabled until a successful preview,
an assignee, and a valid positive User Payable are all present.

`sourceUrl` is an approved-host navigation override only. It does not forward
the operator's Chrome cookies, storage, device verification, or network
identity. A supplier Device Check/CAPTCHA or an otherwise unusable supplier page
is returned as a controlled `502`; no import RPC or wallet operation runs.

### `/api/impexp/import-booking` - Import or Re-import

**Implementation**: `app/api/impexp/import-booking/route.ts`

**Method**: `POST`

**Authorization**: `superadmin`, `admin`, or `staff_support`

**Request**: Extends the preview request with:

```typescript
{
  assignedToUserId: string,
  userPayableAmount: string, // positive major-unit amount, maximum 2 decimals
  requestId: string, // UUID
  importDecision: 'import_only' | 'import_and_charge',
  chargeAuthorizationId?: string | null,
  passengerInfo?: Array<{
    paxType: 'ADT' | 'CHD' | 'INF',
    gender: '' | 'Male' | 'Female',
    birthdate: string,
    nationality: string,
    identityDocID: string,
    identityDocExpiry: string
  }>
}
```

The route re-retrieves the supplier booking and passes Supplier Gross and User
Payable as minor units to `create_impexp_booking_v2`. Assignment is required.

- Supplier Held -> On Hold/Unpaid; `walletCharged: false`.
- Supplier Ticketed/Confirmed + Import Only -> Confirmed/Unpaid plus an
  Accounts-owned case; `walletCharged: false`.
- Supplier Ticketed/Confirmed + Import & Charge -> requires a matching unexpired
  one-use authorization and captures User Payable atomically once;
  `walletCharged: true`.
- Re-import preserves assignment/User Payable and cannot create another debit.

Important 409 results include `WALLET_NOT_FOUND`,
`WALLET_ACCOUNT_NOT_FOUND`, `WALLET_FROZEN`, `INSUFFICIENT_FUNDS`,
`IMPORT_ASSIGNEE_MISMATCH`, `IMPORT_PAYABLE_MISMATCH`,
`REIMPORT_CONFIRMATION_REQUIRES_RECONCILIATION`, and
`HISTORICAL_IMPORT_RECONCILIATION_REQUIRED`.

### `/api/impexp/authorize-charge` - Prior Import & Charge Authorization

**Method**: `POST`

**Authorization**: `superadmin`, `admin`, or `staff_support`

The request uses the import form plus a UUID `requestId`. The server re-retrieves
complete confirmed supplier evidence, binds provider/reference, assignee/owner,
currency, Supplier Gross, User Payable, PNR/passengers/tickets, and normalized
payload hash, then stores a five-minute one-use authorization. This endpoint is
non-financial: it returns an authorization ID/expiry and never debits a wallet.

### `/api/impexp/confirm-booking` - Confirm and Pay Held Import

**Implementation**: `app/api/impexp/confirm-booking/route.ts`

**Methods**: `GET`, `POST`

**Authorization**: Exact assigned B2C owner or B2B/B2B sub-user in the assigned
agency. Admin/support staff cannot use this endpoint as the customer.

**GET**:

```text
?reference=STRYYMMDD######
```

Returns the assigned wallet summary, stored User Payable as `requiredAmount`,
and current payment state. The booking must be imported, On Hold, and Unpaid.

**POST**:

```typescript
{
  bookingReference: string,
  requestId: string // UUID
}
```

The database atomically validates ownership/wallet/funds, deducts User Payable,
creates the captured reservation and immutable `booking_confirm` ledger entry,
marks payment Captured, and changes On Hold to In Progress. It never calls the
normal supplier Issue Ticket API.

### `/api/impexp/sync-booking` - Non-financial Supplier Sync

**Implementation**: `app/api/impexp/sync-booking/route.ts`

**Method**: `POST`

**Authorization**: `superadmin`, `admin`, or `staff_support`

```typescript
{ bookingReference: string }
```

Sync re-retrieves the stored provider/reference and records normalized supplier
truth. A matching lifecycle may enrich supplier-controlled fields; a lifecycle,
identity, or payment disagreement appends immutable evidence to the owned case.
It protects User Payable, assignment, financial ownership, payment fields,
captured amount, reservations, ledger, and wallet balances. Successful responses
always return `walletCharged: false`.

A captured In Progress import remains In Progress after Sync. Authoritative
ticketed evidence enables the separate Complete endpoint; negative evidence
routes the case to explicit financial disposition. Sync itself never completes
the booking or charges again.

### `/api/impexp/complete-booking` - Complete Manual Ticketing

**Method**: `POST`

**Authorization**: `superadmin`, `admin`, or `staff_support`

Accepts `{ bookingReference, caseId, evidenceObservationId, requestId }`. The
database requires a fresh complete identity-matching ticket observation and the
original single capture/reservation/ledger fact bundle. It confirms the booking,
completes the operation/case, and writes one event/outbox occurrence atomically.
It never changes wallet balances, reservation, ledger, or payment amount/state.

### `/api/impexp/financial-disposition` - Captured Manual-Ticket Failure

**Method**: `POST`

The discriminated `action` is `propose`, `approve`, `reject`, or `execute`.
Accounts/Admin/Super Admin may propose a full refund, partial refund,
no-refund-due, external settlement, or manual adjustment from fresh negative
evidence. A different Admin/Super Admin approves. Execute rechecks the unchanged
proposal and original capture; refund modes append at most one exact credit,
no-refund/external settlement move no local money, and manual adjustment remains
open and visible.

### `/api/impexp/history` and `/api/impexp/users`

- `GET /api/impexp/history` lists imported records with separate Supplier Gross,
  User Payable, payment state, assignment, supplier reference, and lifecycle.
- `GET /api/impexp/users?role=b2b|b2b_sub|customer` lists valid mandatory
  assignment targets.
- Both require `superadmin`, `admin`, or `staff_support`.

The normal booking detail endpoint returns imported fare rows and total from
Supplier Gross for e-ticket display. This read projection is intentionally
different from User Payable returned by wallet/payment/report endpoints.

### IMP/EXP Idempotency Boundary

HTTP request IDs support replay handling, but financial uniqueness is enforced
in PostgreSQL with provider/reference identity, advisory and row locks, a stable
`impexp-payment:<booking-id>` ledger key, and unique ledger/reservation
constraints. UI button disabling is not the financial control.

See [IMP/EXP Booking Imports](17-IMP-EXP-IMPORTS.md) for the complete state and
charging matrix.

---

## Wallet Endpoints

### `/api/wallet` - Wallet Summary and Ledger

**Implementation**: `app/api/wallet/route.ts`

**Method**: `GET`

**Purpose**: Retrieve wallet summary and transaction ledger for the current user's wallet.

**Response**:
```typescript
{
  success: true,
  data: {
    summary: {
      accountId: string,
      walletId: string,
      ownerType: 'user' | 'agency',
      ownerKey: string,
      currency: string,
      availableBalance: number,
      holdBalance: number,
      totalBalance: number,
      status: 'active' | 'frozen'
    },
    transactions: Array<{
      id: string,
      type: string,
      amount: number,
      balanceAfter: number,
      description: string,
      createdAt: string,
      relatedBookingId?: string,
      relatedDepositId?: string
    }>
  }
}
```

**Authorization**: Requires authentication. Operational accounts (admin, staff) do not have personal wallets and receive 403.

**Error Codes**:
- `NO_PERSONAL_WALLET` (403) - Operational account has no wallet
- `STORAGE_ERROR` (503) - Wallet storage unavailable

---

### `/api/wallet/admin` - Wallet Administration

**Implementation**: `app/api/wallet/admin/route.ts`

**Methods**: `GET`, `PATCH`

**Purpose**: List all wallets and change wallet status (freeze/unfreeze).

**GET Response**:
```typescript
{
  success: true,
  data: {
    wallets: Array<{
      walletId: string,
      accountId: string,
      ownerType: 'user' | 'agency',
      ownerKey: string,
      ownerName: string,
      currency: string,
      availableBalance: number,
      holdBalance: number,
      totalBalance: number,
      status: 'active' | 'frozen'
    }>
  }
}
```

**PATCH Request**:
```typescript
{
  walletId: string,
  status: 'active' | 'frozen',
  reason?: string  // Required when freezing
}
```

**Authorization**: Financial access required (superadmin, admin, staff_account, staff_support)

**Rate Limiting**: 60 requests per hour per user for PATCH

**Error Codes**:
- `FORBIDDEN` (403) - No financial access
- `INVALID_WALLET_STATUS` (400) - Invalid request
- `FREEZE_REASON_REQUIRED` (400) - Reason required for freeze
- `STORAGE_ERROR` (503) - Wallet storage unavailable

**Special Features**:
- **Security Audit**: All status changes logged
- **Agency Names**: Includes agency names for B2B wallets

---

### `/api/wallet/ledger` - Financial Ledger View

**Implementation**: `app/api/wallet/ledger/route.ts`

**Method**: `GET`

**Purpose**: Comprehensive financial ledger view for operators. Shows all deposit requests across the system with wallet totals.

**Response**:
```typescript
{
  success: true,
  data: {
    currency: 'BDT',
    totals: {
      available: number,
      hold: number,
      frozenAmount: number,
      b2b: number,
      b2c: number,
      system: number,
      frozenCount: number
    },
    requests: Array<{
      id: string,
      requestReference: string,
      paymentMethod: string,
      paymentReference: string,
      attachmentUrl: string | null,
      userLabel: string,
      userSecondary: string,
      requestedBy: string,
      issuedBy: string | null,
      amount: number,
      currency: string,
      createdAt: string,
      updatedAt: string,
      status: string
    }>
  }
}
```

**Authorization**: Financial access required

**Features**:
- Aggregates totals across all BDT wallets
- Shows frozen wallet count
- Includes user labels (agency names or customer names)
- Signed attachment URLs for document access

---

### `/api/wallet/deposits` - Deposit Requests

**Implementation**: `app/api/wallet/deposits/route.ts`

**Methods**: `GET`, `POST`

**Purpose**: List deposit requests and create new deposit requests.

**GET Response**:
```typescript
// Financial operators - all requests
{
  success: true,
  data: {
    requests: Array<{
      id: string,
      publicRef: string,
      method: string,
      amount: number,
      currency: string,
      status: 'pending' | 'approved' | 'rejected',
      attachment_url: string | null,
      requestedAt: string,
      reviewedAt: string | null,
      reviewedBy: string | null,
      remarks: string | null
    }>
  }
}

// Regular users - only their wallet's requests
{ success: true, data: { requests: [...] } }
```

**POST Request** (multipart/form-data):
```typescript
{
  method: 'cash' | 'bank' | 'bank_transfer' | 'mobile' | 'cheque',
  amount: number,           // 1-100,000,000
  remarks?: string,         // Optional, max 1000 chars
  // Method-specific fields:
  // cash:
  branchId: string,         // UUID
  receivedByUserId: string,
  // bank:
  companyBankAccountId: string,
  depositDate: string,       // YYYY-MM-DD
  referenceNumber: string,
  // bank_transfer:
  companyBankAccountId: string,
  depositDate: string,
  referenceNumber: string,
  sourceBankAccountId: 'profile-primary',
  // mobile:
  mfsAccountId: string,
  transactionId: string,
  depositDate: string,
  // cheque:
  companyBankAccountId: string,
  chequeNo: string,
  chequeIssuedDate: string,
  chequeIssuedBank: string,
  paymentDate: string,
  // All methods except cash:
  attachment: File          // Required, max 5MB
}
```

**Authorization**:
- GET: All users can see their own requests; financial operators see all
- POST: Users with personal wallets can create requests

**Rate Limiting**: 20 requests per hour per user

**Validation**:
- Attachment required for all methods except cash
- Attachment max 5MB
- Date validation (YYYY-MM-DD format, valid calendar date)
- Cheque payment date cannot be before issue date
- Bank transfer requires profile to have saved bank account

**Error Codes**:
- `NO_PERSONAL_WALLET` (403) - No wallet for deposit
- `RATE_LIMITED` (429) - Too many deposit requests
- `ATTACHMENT_TOO_LARGE` (413) - Attachment over 5MB
- `INVALID_DEPOSIT` (400) - Validation error
- `INVALID_BRANCH` (400) - Invalid branch ID
- `INVALID_RECEIVER` (400) - Invalid cash receiver
- `INVALID_COMPANY_ACCOUNT` (400) - Invalid company bank account
- `SAVED_BANK_ACCOUNT_REQUIRED` (400) - Profile missing bank account
- `INVALID_MFS_ACCOUNT` (400) - Invalid MFS account
- `ATTACHMENT_REQUIRED` (400) - Attachment missing

**Cross-References**:
- See [10-WALLET-SYSTEM.md](10-WALLET-SYSTEM.md) for deposit workflows

---

### `/api/wallet/deposits/[id]` - Deposit Request Review

**Implementation**: `app/api/wallet/deposits/[id]/route.ts`

**Method**: `PATCH`

**Purpose**: Approve or reject a deposit request (financial operators only).

**Request Schema**:
```typescript
{
  decision: 'approved' | 'rejected',
  remarks?: string  // Required for rejection (3-1000 chars)
}
```

**Response**:
```typescript
{
  success: true,
  data: {
    id: string,
    status: 'approved' | 'rejected',
    reviewedAt: string,
    reviewedBy: string,
    remarks: string | null
  }
}
```

**Authorization**: Financial access required

**Rate Limiting**: 60 requests per hour per user

**Effects**:
- **Approve**: Credits wallet account via ledger entry
- **Reject**: No ledger entry, request marked rejected
- **Self-Approval**: Forbidden (different operator must approve)

**Error Codes**:
- `FORBIDDEN` (403) - No financial access
- `INVALID_REQUEST` (400) - Invalid deposit ID
- `RATE_LIMITED` (429) - Too many actions
- `INVALID_DECISION` (400) - Invalid decision data
- `SELF_APPROVAL_FORBIDDEN` (409) - Cannot approve own request
- `ALREADY_REVIEWED` (409) - Already reviewed
- `INSUFFICIENT_FUNDS` (409) - Cannot credit (wallet frozen/insufficient for refund scenarios)

**Special Features**:
- **Security Audit**: All reviews logged
- **Signed Attachments**: Attachment URLs signed for document access

---

### `/api/wallet/adjustments` - Adjustment Requests

**Implementation**: `app/api/wallet/adjustments/route.ts`

**Methods**: `GET`, `POST`

**Purpose**: List adjustment requests and create credit/debit adjustments (financial operators only).

**GET Response**:
```typescript
{
  success: true,
  data: {
    requests: Array<{
      id: string,
      accountId: string,
      adjustmentType: 'credit' | 'debit',
      amount: number,
      currency: string,
      reason: string,
      status: 'pending' | 'approved' | 'rejected',
      requestedBy: string,
      requestedAt: string,
      reviewedBy: string | null,
      reviewedAt: string | null,
      remarks: string | null
    }>
  }
}
```

**POST Request**:
```typescript
{
  accountId: string,        // UUID of wallet account
  adjustmentType: 'credit' | 'debit',
  amount: number,           // 1-100,000,000
  reason: string            // 3-1000 chars
}
```

**Authorization**: Financial access required

**Rate Limiting**: 60 requests per hour per user

**Error Codes**:
- `FORBIDDEN` (403) - No financial access
- `RATE_LIMITED` (429) - Too many actions
- `INVALID_ADJUSTMENT` (400) - Validation error
- `STORAGE_ERROR` (503) - Storage unavailable

---

### `/api/wallet/adjustments/[id]` - Adjustment Request Review

**Implementation**: `app/api/wallet/adjustments/[id]/route.ts`

**Method**: `PATCH`

**Purpose**: Approve or reject an adjustment request (financial operators only).

**Request Schema**:
```typescript
{
  decision: 'approved' | 'rejected',
  remarks?: string  // Required for rejection (3-1000 chars)
}
```

**Response**:
```typescript
{
  success: true,
  data: {
    id: string,
    status: 'approved' | 'rejected',
    reviewedAt: string,
    reviewedBy: string,
    remarks: string | null
  }
}
```

**Authorization**: Financial access required

**Rate Limiting**: 60 requests per hour per user

**Effects**:
- **Approve**: Credits or debits wallet account via ledger entry
- **Reject**: No ledger entry, request marked rejected

**Error Codes**:
- `FORBIDDEN` (403) - No financial access
- `INVALID_REQUEST` (400) - Invalid adjustment ID
- `RATE_LIMITED` (429) - Too many actions
- `INVALID_DECISION` (400) - Invalid decision data
- `ALREADY_REVIEWED` (409) - Already reviewed

**Special Features**:
- **Security Audit**: All reviews logged

---

### `/api/wallet/company-bank-accounts` - Company Bank Accounts

**Implementation**: `app/api/wallet/company-bank-accounts/route.ts`

**Methods**: `GET`, `POST`, `PATCH`

**Purpose**: Manage company bank accounts for receiving payments (superadmin only).

**GET Response**:
```typescript
{
  success: true,
  data: {
    accounts: Array<{
      id: string,
      bankName: string,
      accountName: string,
      accountNumber: string,
      branchName: string | null,
      branchCode: string | null,
      routingNumber: string | null,
      swiftCode: string | null,
      logoUrl: string | null,
      active: boolean,
      sortOrder: number,
      createdAt: string,
      updatedAt: string
    }>
  }
}
```

**POST Request**:
```typescript
{
  bankName: string,         // 2-150 chars
  accountName: string,      // 2-150 chars
  accountNumber: string,    // 3-100 chars
  branchName?: string,      // Optional, max 150 chars
  branchCode?: string,      // Optional, max 100 chars
  routingNumber?: string,   // Optional, max 100 chars
  swiftCode?: string        // Optional, max 50 chars
}
```

**PATCH Request**:
```typescript
{
  id: string,
  bankName: string,
  accountName: string,
  accountNumber: string,
  branchName?: string,
  branchCode?: string,
  routingNumber?: string,
  swiftCode?: string,
  active: boolean
}
```

**Authorization**: Superadmin only

**Rate Limiting**: 40 requests per hour per user

**Special Features**:
- **Security Audit**: All creates/updates logged with account number hash
- **Duplicate Detection**: Prevents duplicate account numbers
- **Logo Support**: Separate endpoint for logo upload
- **Sort Order**: Controls display order

**Error Codes**:
- `SUPERADMIN_REQUIRED` (403) - Not superadmin
- `RATE_LIMITED` (429) - Too many actions
- `INVALID_BANK_ACCOUNT` (400) - Validation error
- `DUPLICATE_ACCOUNT` (409) - Account number already exists
- `SETUP_REQUIRED` (503) - Database table not ready (migration 0023)
- `STORAGE_ERROR` (503) - Storage unavailable
- `AUDIT_UNAVAILABLE` (503) - Security audit unavailable

---

### `/api/wallet/company-bank-accounts/[id]/logo` - Bank Account Logo

**Implementation**: `app/api/wallet/company-bank-accounts/[id]/logo/route.ts`

**Methods**: `POST`, `DELETE`

**Purpose**: Upload or remove bank account logo (superadmin only).

**POST Request**: multipart/form-data with `logo` file

**Authorization**: Superadmin only

**Cross-References**:
- See Cloudinary integration in `lib/cloudinary.ts`

---

### `/api/wallet/company-mfs-accounts` - MFS Accounts

**Implementation**: `app/api/wallet/company-mfs-accounts/route.ts`

**Methods**: `GET`, `POST`, `PATCH`

**Purpose**: Manage mobile financial service accounts for receiving payments (superadmin only).

**GET Response**:
```typescript
{
  success: true,
  data: {
    accounts: Array<{
      id: string,
      mfsName: string,          // e.g., "bKash", "Nagad"
      accountNumber: string,
      paymentType: 'merchant' | 'send_money' | 'cashout',
      chargePercent: number,    // Transaction charge percentage
      logoUrl: string | null,
      qrCodeUrl: string | null,
      active: boolean,
      sortOrder: number,
      createdAt: string,
      updatedAt: string
    }>
  }
}
```

**POST Request**:
```typescript
{
  mfsName: string,             // 2-100 chars
  accountNumber: string,       // 3-100 chars
  paymentType: 'merchant' | 'send_money' | 'cashout',
  chargePercent: number        // 0-100
}
```

**PATCH Request**:
```typescript
{
  id: string,
  mfsName: string,
  accountNumber: string,
  paymentType: 'merchant' | 'send_money' | 'cashout',
  chargePercent: number,
  active: boolean
}
```

**Authorization**: Superadmin only

**Rate Limiting**: 40 requests per hour per user

**Special Features**:
- **Security Audit**: All creates/updates logged
- **Duplicate Detection**: Prevents duplicate MFS provider + payment type
- **Asset Support**: Separate endpoint for logo and QR code upload
- **Charge Calculation**: Stored as basis points (100x percentage)

**Error Codes**:
- `SUPERADMIN_REQUIRED` (403) - Not superadmin
- `RATE_LIMITED` (429) - Too many actions
- `INVALID_MFS_ACCOUNT` (400) - Validation error
- `DUPLICATE_MFS_CHANNEL` (409) - MFS provider + type already exists
- `SETUP_REQUIRED` (503) - Database table not ready (migration 0023)
- `STORAGE_ERROR` (503) - Storage unavailable
- `AUDIT_UNAVAILABLE` (503) - Security audit unavailable

---

### `/api/wallet/company-mfs-accounts/[id]/assets/[kind]` - MFS Assets

**Implementation**: `app/api/wallet/company-mfs-accounts/[id]/assets/[kind]/route.ts`

**Methods**: `POST`, `DELETE`

**Purpose**: Upload or remove MFS logo or QR code (superadmin only).

**Path Parameters**:
- `id` - MFS account UUID
- `kind` - `logo` or `qr`

**Authorization**: Superadmin only

---

## Reports Endpoints

### `/api/reports/issued-tickets` - Issued Tickets Report

**Implementation**: `app/api/reports/issued-tickets/route.ts`

**Method**: `GET`

**Purpose**: Generate sales report of issued tickets for B2B agencies. Supports JSON, Excel, and PDF formats.

**Query Parameters**:
```typescript
{
  page?: number,              // Default 1, max 1,000,000
  pageSize?: number,          // Default 25, range 10-100
  from?: string,              // YYYY-MM-DD (optional)
  to?: string,                // YYYY-MM-DD (optional)
  bookedBy?: string,          // Filter by booked-by user
  airline?: string,           // Filter by airline code
  search?: string,            // Search in reference/traveller name
  format?: 'json' | 'xlsx' | 'pdf'  // Default 'json'
}
```

**JSON Response**:
```typescript
{
  success: true,
  data: {
    tickets: Array<{
      orderReference: string,
      airlineCode: string,
      totalSegments: number,
      createdAt: string,
      ticketedAt: string,
      totalPassengers: number,
      mainTravellerName: string,
      bookedByName: string,
      currency: string,
      totalFare: number,
      savings: number
    }>,
    total: number,
    airlines: string[],       // Available airline codes for filter
    page: number,
    pageSize: number,
    pageCount: number
  }
}
```

**Excel/PDF Response**: Binary file download with appropriate Content-Type and Content-Disposition headers

**Authorization**: B2B or B2B_sub with agency code required

**Validation**:
- Date range must be valid (from ≤ to)
- Page and pageSize within bounds

**Error Codes**:
- `FORBIDDEN` (403) - B2B agency account required
- `INVALID_REPORT_FILTERS` (400) - Invalid query parameters
- `INVALID_DATE_RANGE` (400) - Start date after end date
- `REPORT_UNAVAILABLE` (503) - Report generation failed

**Special Features**:
- **Excel Export**: Uses ExcelJS with formatted columns and headers
- **PDF Export**: Uses PDFKit with landscape layout and branding
- **Pagination**: For JSON format only
- **Full Export**: Excel/PDF export all matching records (no pagination)

**Cross-References**:
- See `lib/reports/issued-tickets.ts` for report logic

---

## Webhook Endpoints

### `/api/webhooks/clerk-email` - Clerk Email Relay

**Implementation**: `app/api/webhooks/clerk-email/route.ts`

**Method**: `POST`

**Purpose**: Relay Clerk-generated authentication emails through the platform's Zoho SMTP transport. Handles both email relay and welcome email sending.

**Security**: Clerk webhook signature verification required

**Handled Events**:

**1. `email.created` - Email Relay**
Relays Clerk template emails through custom SMTP. Skips if already delivered by Clerk.

**Request**: Clerk webhook payload

**Response**: `200` on success, `400` on invalid signature, `503` on delivery failure

**2. `user.created` - Welcome Email**
Sends welcome email to new users, except for admin-provisioned accounts.

**Response**: `200` on success, `422` on missing email, `503` on delivery failure

**Special Features**:
- **Duplicate Prevention**: Skips emails already delivered by Clerk
- **Admin Exclusion**: Skips welcome email for admin-created accounts
- **Custom Message-ID**: Includes Clerk email ID in message ID for tracking
- **Retry Logic**: Non-2xx responses trigger Clerk webhook retry

**Cross-References**:
- See [11-EMAIL-NOTIFICATIONS.md](11-EMAIL-NOTIFICATIONS.md) for email system
- See `lib/email/mailer.ts` for email sending logic

---

## Authentication and Authorization

### Session Management

All API routes (except `/api/flights/search` and `/api/airports`) require authentication through Clerk sessions.

**Session Retrieval**:
```typescript
import { getDashboardSession } from '@/lib/dashboard/session';

const session = await getDashboardSession();
if (!session) {
  return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
}
```

**Session Structure**:
```typescript
type DashboardSession = {
  clerkId: string;           // Clerk user ID
  role: Role;                // User role
  name: string;              // Display name
  email: string;             // Email address
  signedInAt: number | null; // Last sign-in timestamp
  agencyCode: string | null;  // Agency code for B2B users
  isAgencyOwner: boolean;    // Whether user owns their agency
};
```

**Implementation**: `lib/dashboard/session.ts`

### Role-Based Access Control

Roles are checked before allowing operations:

```typescript
import { hasFinancialAccess } from '@/lib/wallet/permissions';

if (!hasFinancialAccess(session.role)) {
  return walletFail(403, 'FORBIDDEN', 'Financial access is required.');
}
```

**Financial Roles** (can access wallet endpoints):
- `superadmin`
- `admin`
- `staff_support`
- `staff_account`

**Booking Creation Roles**:
- `customer`
- `b2b`
- `b2b_sub`

**Implementation**: `lib/wallet/permissions.ts`

### Resource Ownership

Some endpoints check ownership of specific resources:

```typescript
import { walletOwnerForSession } from '@/lib/wallet/permissions';

const owner = walletOwnerForSession(session);
if (owner?.ownerType !== booking.booking_owner_type ||
    owner.ownerKey !== booking.booking_owner_key) {
  return walletFail(403, 'FORBIDDEN', 'You cannot access this resource.');
}
```

**Implementation**: `lib/wallet/permissions.ts`

### Cross-References

- See [03-AUTHENTICATION.md](03-AUTHENTICATION.md) for authentication system
- See [04-ROLES-AND-PERMISSIONS.md](04-ROLES-AND-PERMISSIONS.md) for role system

---

## Rate Limiting

### Overview

Rate limiting is implemented using a deployment-wide fixed-window limiter in `lib/rate-limit.ts`. Production uses Postgres atomic operations; development uses in-memory fallback.

### Limit Configuration

Limits are defined per action in `LIMITS`:

```typescript
export const LIMITS = {
  inviteUser: { limit: 20, windowMs: HOUR },
  createUserAccount: { limit: 20, windowMs: HOUR },
  setUserRole: { limit: 30, windowMs: HOUR },
  deleteUserAccount: { limit: 10, windowMs: HOUR },
  setUserActive: { limit: 40, windowMs: HOUR },
  revokeInvite: { limit: 30, windowMs: HOUR },
  inviteSubUser: { limit: 20, windowMs: HOUR },
  manageSubUser: { limit: 40, windowMs: HOUR },
  saveProfile: { limit: 20, windowMs: 5 * MINUTE },
  submitUpgradeRequest: { limit: 6, windowMs: HOUR },
  reviewUpgradeRequest: { limit: 60, windowMs: HOUR },
  viewUserProfile: { limit: 60, windowMs: HOUR },
  editUserProfile: { limit: 40, windowMs: HOUR },
  siteLogo: { limit: 10, windowMs: HOUR },
  manageMarkup: { limit: 60, windowMs: HOUR },
  businessDocument: { limit: 40, windowMs: HOUR },
  flightSearch: { limit: 20, windowMs: 5 * MINUTE },
  flightFareRules: { limit: 60, windowMs: 5 * MINUTE },
  flightReprice: { limit: 30, windowMs: 5 * MINUTE },
  flightBookingPrepare: { limit: 20, windowMs: 5 * MINUTE },
  flightBookingSubmit: { limit: 5, windowMs: HOUR },
  walletDeposit: { limit: 20, windowMs: HOUR },
  walletManage: { limit: 60, windowMs: HOUR },
  managePaymentAccounts: { limit: 40, windowMs: HOUR },
  flightTicketIssue: { limit: 10, windowMs: HOUR },
  flightBookingCancel: { limit: 10, windowMs: HOUR },
} as const;
```

### Usage Pattern

```typescript
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { requestActorKey } from '@/lib/http/actor-key';

const limit = await checkActionLimit(
  'flightSearch',
  requestActorKey(request)  // Uses IP for anonymous, userId for authenticated
);
if (!limit.ok) {
  return NextResponse.json(
    {
      success: false,
      error: {
        errorCode: 'RATE_LIMITED',
        errorMessage: rateLimitMessage(limit.retryAfterSeconds),
      },
    },
    {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(limit.retryAfterSeconds),
      },
    }
  );
}
```

### Actor Key Resolution

- **Authenticated users**: `user:{clerkId}`
- **Anonymous visitors**: `ip:{ipAddress}` (for public endpoints like flight search)
- **Namespaced**: Keys are namespaced per action to prevent cross-action limit consumption

### Response Headers

Rate-limited responses include:
- `Retry-After`: Seconds until window resets
- Human-readable error message via `rateLimitMessage()`

### Implementation Details

- **Production**: Uses Postgres RPC for atomic counter updates
- **Development**: In-memory Map with 5,000 key cap
- **Window Reset**: Closed windows are automatically cleaned up
- **Key Truncation**: Keys truncated to 512 characters

**Implementation**: `lib/rate-limit.ts`

---

## Error Handling Patterns

### Standard Error Response

All endpoints use a consistent error response format:

```typescript
{
  success: false,
  error: {
    errorCode: string,      // Machine-readable error code
    errorMessage: string,  // Human-readable message
    details?: Record<string, unknown>  // Optional context
  }
}
```

### Helper Functions

**Wallet Operations** (`lib/wallet/http.ts`):
```typescript
walletFail(status, errorCode, errorMessage, details)
walletOk(data, status)
walletOperationResponse(result)  // Converts WalletOperationResult
```

**Generic Failures**:
```typescript
function fail(status: number, errorCode: string, errorMessage: string) {
  return NextResponse.json(
    { success: false, error: { errorCode, errorMessage } },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}
```

### Common Error Codes

**Authentication/Authorization**:
- `SIGN_IN_REQUIRED` (401) - Not authenticated
- `FORBIDDEN` (403) - Insufficient permissions
- `SUPERADMIN_REQUIRED` (403) - Superadmin only

**Validation**:
- `INVALID_BODY` (400) - Invalid JSON body
- `INVALID_*` (400) - Various validation errors
- `INVALID_QUERY` (400) - Invalid query parameters

**Rate Limiting**:
- `RATE_LIMITED` (429) - Too many requests

**Resource State**:
- `NOT_FOUND` (404) - Resource doesn't exist
- `DRAFT_NOT_FOUND` (404) - Booking draft doesn't exist
- `BOOKING_NOT_FOUND` (404) - Booking doesn't exist
- `DRAFT_CLOSED` (409) - Draft already submitted
- `BOOKING_ALREADY_STARTED` (409) - Booking in progress
- `DRAFT_EXPIRED` (410) - Draft/fare expired
- `BOOKING_EXPIRED` (410) - Booking deadline passed

**Wallet Operations** (`lib/wallet/http.ts`):
- `INSUFFICIENT_FUNDS` (409) - Wallet balance insufficient
- `WALLET_FROZEN` (409) - Wallet is frozen
- `ISSUE_IN_PROGRESS` (409) - Ticket issuance already started
- `RECONCILIATION_REQUIRED` (409) - Payment needs reconciliation
- `ALREADY_CAPTURED` (409) - Already charged
- `BOOKING_NOT_ISSUABLE` (409) - Booking not in issuable state
- `BOOKING_UNCONFIRMED` (409) - PNR must be verified
- `BOOKING_OWNER_REQUIRED` (409) - No wallet owner
- `SELF_APPROVAL_FORBIDDEN` (409) - Cannot approve own request
- `ALREADY_REVIEWED` (409) - Already reviewed
- `REFUND_EXCEEDS_CAPTURE` (409) - Refund exceeds captured amount

**Supplier/Integration**:
- `REPRICE_TIMEOUT` (504) - Supplier timeout
- `REPRICE_FAILED` (502) - Supplier error
- `FARE_RULES_TIMEOUT` (504) - Supplier timeout
- `FARE_RULES_FAILED` (502) - Supplier error
- `BOOKING_FAILED` (502) - Supplier declined booking
- `BOOKING_OUTCOME_UNKNOWN` (503) - Supplier outcome ambiguous

**Configuration/Storage**:
- `UNCONFIGURED` (503) - Feature not configured
- `SETUP_REQUIRED` (503) - Database migration needed
- `STORAGE_ERROR` (503) - Database/storage unavailable
- `STORAGE_UNAVAILABLE` (503) - Storage unavailable
- `AUDIT_UNAVAILABLE` (503) - Security audit unavailable

### HTTP Status Codes

- **200** - Success
- **201** - Created (POST success)
- **400** - Bad Request (validation error)
- **401** - Unauthorized (not authenticated)
- **403** - Forbidden (insufficient permissions)
- **404** - Not Found (resource doesn't exist)
- **409** - Conflict (resource state invalid)
- **410** - Gone (resource expired)
- **413** - Payload Too Large (attachment too big)
- **422** - Unprocessable Entity (invalid payload)
- **429** - Too Many Requests (rate limited)
- **502** - Bad Gateway (supplier error)
- **503** - Service Unavailable (configuration/storage error)
- **504** - Gateway Timeout (supplier timeout)

### Error Logging

Errors are logged with context:

```typescript
console.error('[context] error message:', error);
```

Supplier errors include kind and message:

```typescript
if (error instanceof TriploverError) {
  console.error(`Flight Search failed [${error.kind}]:`, error.message);
}
```

---

## Request/Response Formats

### Content Types

**JSON Requests**:
- `Content-Type: application/json` (implicit for JSON.parse)
- Most endpoints use JSON request bodies

**Multipart Form Data**:
- `Content-Type: multipart/form-data`
- Used for file uploads (deposit attachments, logos, QR codes)
- Maximum file size: 5MB for deposit attachments

**Query Parameters**:
- URL-encoded query strings for GET requests
- Date format: `YYYY-MM-DD`
- UUIDs for IDs

### Validation

All endpoints use Zod schemas for validation:

```typescript
import { z } from 'zod';

const schema = z.object({
  searchId: z.string().uuid(),
  itineraryId: z.string().regex(/^itn-\d+-\d+$/),
});

const parsed = schema.safeParse(payload);
if (!parsed.success) {
  return fail(400, 'INVALID_REQUEST', 'Validation error message');
}
```

### Response Headers

**Standard Headers**:
```typescript
{
  'Cache-Control': 'no-store',  // All sensitive endpoints
  'Content-Type': 'application/json; charset=utf-8'
}
```

**Special Headers**:
- `Server-Timing` - Performance metrics for flight search
- `X-Flight-Search-Timing` - Backup timing header for CDN
- `Retry-After` - Seconds until rate limit resets
- `Content-Disposition` - Filename for file downloads

### Response Serialization

Flight search includes detailed timing in Server-Timing header:

```typescript
Server-Timing: validation;dur=12.34;desc="Body parsing and validation",
              token;dur=45.67;desc="Triplover token acquisition",
              triplover;dur=5234.56;desc="Triplover API request",
              ...
```

### File Downloads

Excel and PDF reports use binary responses:

```typescript
new Response(new Uint8Array(buffer), {
  headers: {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${exportName('xlsx')}"`,
    'Cache-Control': 'no-store',
  },
});
```

### Cache Strategy

**Public Endpoints**:
- `/api/airports` - `public, max-age=300, s-maxage=86400, stale-while-revalidate=604800`

**Sensitive Endpoints**:
- All wallet, booking, and admin endpoints - `no-store`

**Supplier Responses**:
- Flight search and reprice - `no-store` (prices change frequently)

---

## Security Considerations

### Authentication

**Clerk Sessions**:
- All protected endpoints require valid Clerk session
- Session verification via `getDashboardSession()`
- Session failures return 401

**Webhook Verification**:
- Clerk webhooks verified via `verifyWebhook()`
- Invalid signatures rejected with 400

### Authorization

**Role Checks**:
- Financial access required for wallet endpoints
- Superadmin required for payment account management
- B2B agency required for reports

**Ownership Checks**:
- Users can only access their own resources
- Booking operations verify wallet ownership
- Draft ownership checked before submission

### Rate Limiting

**Purpose**:
- Prevent API abuse
- Protect supplier from excessive calls
- Guard expensive operations (file uploads, email sends)

**Implementation**:
- Per-action limits in `lib/rate-limit.ts`
- Actor-key based (user ID or IP)
- Retry-After header on limit

### Input Validation

**Zod Schemas**:
- All request bodies validated
- Type checking and format validation
- Custom refinements for business rules

**Common Validations**:
- UUIDs for IDs
- IATA codes for airports
- Date format (YYYY-MM-DD)
- Phone number formats
- Email addresses
- String length limits

### SQL Injection Prevention

**Parameterized Queries**:
- Supabase client uses parameterized queries
- No string concatenation in SQL

**Service Role Access**:
- Server-only database access
- No direct browser queries
- RLS disabled (server-only pattern)

### XSS Prevention

**Response Serialization**:
- JSON responses via NextResponse.json()
- Automatic escaping
- No untrusted HTML in responses

**File Uploads**:
- Content-type validation
- Size limits (5MB)
- Cloudinary storage (not served from domain)

### CSRF Protection

**SameSite Cookies**:
- Clerk handles CSRF protection
- Session cookies are HttpOnly and SameSite

**Stateless API**:
- No CSRF tokens needed for stateless API
- Authentication via session header

### Security Audit Logging

**Critical Operations**:
- Wallet status changes
- Payment account management
- Booking issuances and cancellations
- Deposit and adjustment reviews

**Implementation**:
```typescript
await recordSecurityAuditEvent({
  actorUserId: session.clerkId,
  actorRole: session.role,
  action: 'wallet.frozen',
  targetType: 'wallet',
  targetId: walletId,
  outcome: 'succeeded',
  metadata: { reason }
});
```

**Implementation**: `lib/db/security.ts`

### Data Exposure Prevention

**Ownership Verification**:
- Users cannot access others' resources
- Draft access token required
- Booking scope limits visibility

**Error Messages**:
- Generic messages for not found (don't confirm existence)
- No sensitive data in errors
- Stack traces not exposed in production

### Supplier API Security

**Authentication**:
- Triplover API tokens stored in environment variables
- Token rotation handled externally
- Tokens never exposed in responses

**Timeout Handling**:
- Supplier timeouts handled gracefully
- No partial data exposure
- Ambiguous outcomes marked for reconciliation

### File Security

**Document Storage**:
- Cloudinary for file storage
- Signed URLs for access
- URL expiration for sensitive documents

**Upload Validation**:
- File type validation
- Size limits
- Content-type verification

### Cross-References

- See [14-SECURITY.md](14-SECURITY.md) for comprehensive security documentation
- See [03-AUTHENTICATION.md](03-AUTHENTICATION.md) for authentication details
- See [04-ROLES-AND-PERMISSIONS.md](04-ROLES-AND-PERMISSIONS.md) for authorization

---

## Ticket Management API

Ticket Management is a server-only orchestration boundary for manual
post-ticket Refund, Reissue, and VOID operations. It does not call a supplier,
airline, or GDS API and it does not implement an evidence workflow.

| Method | Route | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/ticket-management` | Booking owner or operational/financial staff | Owner-scoped or role-scoped request list with optional action/status filter. |
| `POST` | `/api/ticket-management` | Customer, B2B owner, B2B sub-user | Create an idempotent request for selected passenger indexes on an owned booking. |
| `GET` | `/api/ticket-management/:requestId` | Owning customer/agency or operational/financial staff | Return a role-safe detail view. |
| `POST` | `/api/ticket-management/:requestId/actions` | Action-specific role | Review, quote, decide, requote, assign, complete, or release. |
| `GET` | `/api/ticket-management/assignees` | Support, Admin, Superadmin | List Accounts/Admin/Superadmin settlement assignees. |
| `GET` | `/api/cron/ticket-management` | `CRON_SECRET` bearer | Expire a bounded batch of overdue Awaiting Confirmation quotations. |

The action endpoint accepts exactly one strict discriminated action. Published
quotation inputs use explicitly named integer minor-unit fields. Refund/VOID
completion and Reissue/VOID capture/release accept no client-selected wallet
account or final settlement amount. They provide only request identity,
expected version, an idempotency request key, and action-specific operational
facts; the database reads the immutable approved quotation and original charged
wallet.

Customer responses exclude supplier Gross/Supplier Payable, staff actor and
assignment history, entitlement identifiers, reservation identifiers, and
ledger identifiers. Staff reads expose the audit information required for
operations and finance. Every response is `no-store`, every mutation is rate
limited, and privileged actions fail closed when the attempt audit cannot be
written.

The generic `/api/wallet/refunds` route rejects issued/ticketed bookings with
`TICKET_MANAGEMENT_REQUIRED`. This prevents an amount-bearing application API
from bypassing quotation and assignment controls. The underlying legacy RPC is
unchanged and must not be used as the Ticket Management settlement path.

## Critical Invariants

When modifying API routes, ensure these invariants are maintained:

1. **Authentication First**: Always authenticate before any other checks to prevent information leakage
2. **Authorization Second**: Check permissions before validating business logic
3. **Rate Limiting Third**: Apply rate limits after authentication to prevent DoS on legitimate users
4. **Consistent Errors**: Use standard error response format and error codes
5. **No Sensitive Data in Errors**: Never expose internal details, stack traces, or confirm resource existence to unauthorized users
6. **Audit Logging**: Log all financial operations and security-relevant actions
7. **Cache Control**: Use `no-store` for all sensitive endpoints
8. **Idempotency**: Use request IDs for operations that must not be duplicated
9. **Validation**: Validate all inputs with Zod schemas before processing
10. **Ownership**: Verify resource ownership before allowing access/modification
11. **Imported Supplier Boundary**: Imported bookings use dedicated confirm/Sync routes; normal Triplover Issue/Cancel/Refresh must reject them
12. **Non-Financial Sync**: IMP/EXP Sync must not invoke wallet mutation or overwrite protected User Payable/ownership/payment fields

---

## Before Modifying This System

When adding or modifying API routes:

1. **Check Existing Patterns**: Review similar endpoints for consistency
2. **Add Rate Limiting**: Add appropriate limit to `LIMITS` in `lib/rate-limit.ts`
3. **Add Security Audit**: Log security-relevant operations
4. **Update Documentation**: Update this document with new endpoints
5. **Test Error Paths**: Test all error conditions and validation
6. **Test Rate Limiting**: Verify rate limiting works correctly
7. **Check Authorization**: Ensure proper role and ownership checks
8. **Validate Inputs**: Add Zod schema for all request bodies
9. **Set Headers**: Include appropriate Cache-Control headers
10. **Handle Timeouts**: Configure maxDuration for long-running operations

---

## Related Documentation

- [01-PROJECT-OVERVIEW.md](01-PROJECT-OVERVIEW.md) - System overview
- [02-ARCHITECTURE.md](02-ARCHITECTURE.md) - System architecture
- [03-AUTHENTICATION.md](03-AUTHENTICATION.md) - Authentication system
- [04-ROLES-AND-PERMISSIONS.md](04-ROLES-AND-PERMISSIONS.md) - Role system
- [05-FLIGHT-SEARCH.md](05-FLIGHT-SEARCH.md) - Flight search architecture
- [07-BOOKING-SYSTEM.md](07-BOOKING-SYSTEM.md) - Booking system
- [08-BOOKING-LIFECYCLE.md](08-BOOKING-LIFECYCLE.md) - Booking lifecycle
- [09-SUPPLIER-INTEGRATION.md](09-SUPPLIER-INTEGRATION.md) - Supplier integration
- [10-WALLET-SYSTEM.md](10-WALLET-SYSTEM.md) - Wallet system
- [11-EMAIL-NOTIFICATIONS.md](11-EMAIL-NOTIFICATIONS.md) - Email system
- [12-DATABASE.md](12-DATABASE.md) - Database architecture
- [14-SECURITY.md](14-SECURITY.md) - Security practices
- [17-IMP-EXP-IMPORTS.md](17-IMP-EXP-IMPORTS.md) - Imported booking API, wallet, and Sync contract
