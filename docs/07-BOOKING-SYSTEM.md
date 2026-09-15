# Booking System

## Supplier certification flow

Normal API bookings follow `Search → Reprice → Book → Ticket`, including issue
hours after a hold. References are saved with Book and reused without an
automatic PNR fetch. Known ticketing deadlines are enforced; missing deadlines
remain unknown and the supplier decides availability when Ticket is submitted.
Airline confirmation, wallet ownership, duplicate-operation guards and
uncertain-response reconciliation still apply. See the NewTicket section in
[Supplier Integration](./09-SUPPLIER-INTEGRATION.md) for rollout and validation.

The ticket page has a **Booking time limit** switch under the booking reference,
initially OFF. Turning it ON reads the supplier once and reveals the time; OFF
hides it without clearing the saved deadline or changing issuance rules. There
is no page-load fetch or periodic polling. This replaces the separate Quick
Actions **Refresh details** button. Owners, agency users and booking staff can
use it within their normal booking scope. It calls
`/api/pnr` and saves only the returned ticketing time and its normalized deadline.
It does not sync booking status, PNRs, passengers, itinerary, fares, tickets,
payments or local deadline approvals. Missing/invalid time preserves the saved
value; a concurrent booking update rejects the stale result. This switch is
independent of automatic booking and issuance. Verify with
`npm run verify:booking-ticketing-time` and `npm run verify:booking-deadline-notice`.

The booking system manages fare selection through supplier submission. It keeps
booking attempts, durable supplier/manual operations, reconciliation cases, and
customer-visible business bookings as separate records so uncertainty is owned
without inventing a public booking or status.

## Booking Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Flight Search Results                          │
│                  User Selects Fare                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Prepare Booking
                              │
┌─────────────────────────────────────────────────────────────────┐
│          API Route (/api/flights/booking/prepare)                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Create Booking Attempt                          │  │
│  │  - Generate access token                                    │  │
│  │  - Store supplier references                                │  │
│  │  - Cache pricing snapshot                                   │  │
│  │  - Set expiry (20 minutes)                                  │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Database (booking_attempts)
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Booking Attempt (draft state)                       │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  - attempt_id (UUID)                                       │  │
│  │  - access_token_hash (SHA-256)                             │  │
│  │  - state = 'draft'                                         │  │
│  │  - supplier_refs (uniqueTransID, itemCodeRef, priceCodeRef)│  │
│  │  - offer_snapshot (itinerary, fares, pricing)              │  │
│  │  - expires_at (20 minutes from now)                        │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Booking Draft URL
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Booking Checkout Page                               │
│           (Traveller Information Form)                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Submit Booking
                              │
┌─────────────────────────────────────────────────────────────────┐
│          API Route (/api/flights/booking)                          │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Claim Booking Attempt                           │  │
│  │  - Validate access token                                    │  │
│  │  - Optimistic lock (draft → submitting)                     │  │
│  │  - Validate expiry                                          │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Validation
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Traveller Validation                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  - Passenger mix matches fare                               │  │
│  │  - Ages valid for passenger types                           │  │
│  │  - Passports valid for international flights               │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Supplier Call
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Triplover Book API                                   │
│              POST /api/Book                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Success/Failure
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Booking Finalization                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Success:                                                   │  │
│  │  - Create flight_bookings row                              │  │
│  │  - Allocate public_ref (STRYYMMDD######)                   │  │
│  │  - Update booking_attempts (succeeded)                      │  │
│  │  - Create wallet reservation                                │  │
│  │  - Send confirmation email                                 │  │
│  │                                                             │  │
│  │  Failure:                                                   │  │
│  │  - Update booking_attempts (failed/unknown)                │  │
│  │  - No flight_bookings row created                          │  │
│  │  - No wallet reservation                                   │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Booking Attempt vs Booking Record

### Separation Principle

The system separates operational booking attempts from business booking records:

**booking_attempts** - Operational records:
- Temporary rows that track the booking process
- States: `draft`, `submitting`, `succeeded`, `failed`, `unknown`
- Never shown to customers as bookings
- Can be pruned only after retention and unresolved-case links allow it
- Carry supplier reference tokens
- Aged `submitting`/`unknown` rows receive attempt-level reconciliation cases

**flight_bookings** - Business records:
- Permanent records of successful bookings
- States: `on-hold`, `pending`, `in-progress`, `confirmed`, `cancelled`
- Shown to customers in booking lists
- Carry public booking references
- Linked to booking_attempts via `attempt_id`

### Why Separate?

1. **Durability**: Attempt rows survive supplier failures for recovery
2. **Clarity**: Draft states never appear in business booking lists
3. **Recoverability**: Orphaned PNRs can be recovered from attempts
4. **Cleanliness**: Business queries never see operational states

An attempt case is internal Support work. It may store normalized evidence and
resolution audit, but it does not receive an `STR...` reference and cannot be
displayed as Pending/In Progress. Only authoritative proof that the supplier
created a real booking permits atomic creation/linking of `flight_bookings`.

After a business booking exists, `booking_operations` tracks ticketing,
cancellation, or imported manual-ticket work. `booking_reconciliation_cases`
tracks ownership, SLA, evidence, proposal/approval, and outcome. Neither table
adds a customer status; `booking_lifecycle_v` remains the seven-status contract.

## Imported Booking Records

IMP/EXP creates durable `flight_bookings` rows without a search quote or normal
Triplover Book attempt. These rows still use the canonical public reference,
booking details, lifecycle view, ownership fields, wallet ledger, reports, and
email paths.

An imported booking is identified by `import_source = 'IMP_EXP'` plus the stable
airline provider/reference pair. Assignment is mandatory and stored separately
from the operator:

- `user_id`/`booked_by_user_id` identify the assigned customer or agency user.
- `imported_by_user_id` records the admin/support actor.
- `booking_owner_type` and `booking_owner_key` identify the financial owner.
- `supplier_gross_amount` stores supplier/reference pricing in minor units.
- `user_payable_amount` stores the assigned customer's commercial price in minor units.

Those values intentionally serve different read models. Imported booking
details, downloadable e-tickets, and confirmation emails present Supplier Gross
and the stored supplier fare rows. Wallet summaries, payment state, ledger, and
commercial reporting retain User Payable. Changing the ticket projection must
never mutate either stored amount.

The imported flow has two creation paths:

| Supplier state at import | Booking/payment result | Wallet behavior |
| ------------------------ | ---------------------- | --------------- |
| Held | On Hold/Unpaid | No debit during import |
| Ticketed/Confirmed + Import Only | Confirmed/Unpaid + Accounts case | No debit |
| Ticketed/Confirmed + Import & Charge | Confirmed/Captured | Prior one-use authorization; User Payable debited once |

For a held import, the exact assigned B2C owner or a B2B/B2B sub-user in the
assigned agency can use Confirm & Pay. The atomic confirmation captures User
Payable and changes the booking to In Progress for manual external ticketing.
It never calls Triplover NewTicket. Operations staff use non-financial Sync to
record fresh evidence and route the owned case. A separate Complete action may
move paid In Progress to Confirmed only from complete matching ticket evidence,
without another debit.

Re-import is an identity/status refresh, not permission to create another
financial obligation. Provider/reference uniqueness, database locks, and stable
payment idempotency prevent duplicate bookings and duplicate wallet debits.

See [IMP/EXP Booking Imports](17-IMP-EXP-IMPORTS.md) for the complete workflow.

## Booking Draft Creation

### Prepare Endpoint

```typescript
// app/api/flights/booking/prepare/route.ts
export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  const { searchId, itineraryId } = await request.json();

  // Retrieve cached search result
  const cached = await readSearchQuote(searchId, itineraryId);
  if (!cached) {
    return NextResponse.json({ error: 'Quote expired' }, { status: 410 });
  }

  // Create booking attempt
  const attempt = await createBookingAttempt({
    userId: session.clerkId,
    audience: session.agencyCode ? 'agency' : 'b2c',
    agencyCode: session.agencyCode,
    searchId,
    itineraryId,
    supplierRefs: cached.supplier_refs,
    offerSnapshot: cached.pricing_snapshot,
    expiresAt: new Date(Date.now() + 20 * 60 * 1000),
  });

  return NextResponse.json({
    draft: {
      attemptId: attempt.id,
      accessToken: attempt.access_token,
      expiresAt: attempt.expires_at,
    },
  });
}
```

### Access Token

- **Format**: 64-character hex string (SHA-256 hash)
- **Purpose**: Capability token for accessing the draft
- **Security**: Hashed before storage, compared by hash
- **Expiry**: 20 minutes from creation

### Supplier References

Critical tokens that cannot be re-derived:

```typescript
type PrivateBookingRefs = {
  uniqueTransId: string;  // Unique transaction ID
  itemCodeRef: string;    // Item code reference
  priceCodeRef: string;   // Price code reference
};
```

These must be preserved from search through booking.

## Booking Submission Flow

### Claim Booking Attempt

The booking submission starts by claiming the attempt:

```typescript
const current = await readBookingAttempt(
  parsed.data.bookingId,
  parsed.data.accessToken
);

if (!current) {
  return fail(404, 'DRAFT_NOT_FOUND', 'This booking draft is unavailable.');
}

if (current.user_id !== userId) {
  return fail(403, 'DRAFT_NOT_YOURS', 'This booking belongs to a different account.');
}

if (current.state !== 'draft') {
  return fail(409, 'BOOKING_ALREADY_STARTED', 'This booking has already been submitted.');
}

if (Date.parse(current.expires_at) <= Date.now()) {
  return fail(410, 'DRAFT_EXPIRED', 'This fare expired. Search and verify it again.');
}

// Optimistic lock: draft → submitting
await claimBookingAttempt(current.id, current.access_token_hash);
```

### Optimistic Locking

The optimistic lock prevents double-submission:

```sql
UPDATE booking_attempts
SET state = 'submitting',
    submitted_at = now()
WHERE id = $1
  AND access_token_hash = $2
  AND state = 'draft'
  AND expires_at > now();
```

If the update affects 0 rows, another request already claimed it.

## Traveller Information Collection

### Traveller Data Structure

```typescript
type BookingTraveller = {
  passengerType: 'ADT' | 'CHD' | 'CNN' | 'INF' | 'INS';
  title: 'Mr' | 'Mrs' | 'Ms' | 'Mstr' | 'Miss';
  firstName: string;
  lastName: string;
  gender: 'Male' | 'Female';
  dateOfBirth: string;      // YYYY-MM-DD
  passportNumber?: string;  // Required for international
  passportExpiry?: string;  // Required for international
  issuingCountry?: string;  // Required for international
  nationality: string;
};
```

### Contact Information

```typescript
type BookingContact = {
  phone: string;
  phoneCountryCode: string;
  customerEmail: string;    // Customer-facing
  email: string;            // Supplier-facing (fixed)
  countryCode: string;      // Fixed: BD
  cityName: string;         // Fixed: Dhaka
};
```

**Security**: Email, country, and city are fixed server-side to prevent redirecting booking correspondence.

## Booking Validation

### Passenger Mix Validation

```typescript
function exactPassengerMix(
  expected: Partial<Record<BookingPassengerType, number>>,
  travellers: BookingTraveller[]
): boolean {
  const actual = travellers.reduce<Partial<Record<BookingPassengerType, number>>>(
    (counts, passenger) => {
      counts[passenger.passengerType] = (counts[passenger.passengerType] ?? 0) + 1;
      return counts;
    },
    {}
  );
  return (['ADT', 'CHD', 'CNN', 'INF', 'INS'] as const).every(
    (type) => (actual[type] ?? 0) === (expected[type] ?? 0)
  );
}
```

Ensures the submitted travellers match the fare's passenger counts.

### Age Validation

```typescript
function ageOn(dateOfBirth: string, travelDate: string): number | null {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`);
  const travel = new Date(`${travelDate}T00:00:00Z`);
  if (!Number.isFinite(dob.getTime()) || !Number.isFinite(travel.getTime())) return null;
  let age = travel.getUTCFullYear() - dob.getUTCFullYear();
  if (
    travel.getUTCMonth() < dob.getUTCMonth() ||
    (travel.getUTCMonth() === dob.getUTCMonth() &&
      travel.getUTCDate() < dob.getUTCDate())
  ) {
    age -= 1;
  }
  return age;
}

function agesAreValid(travellers: BookingTraveller[], travelDate: string): boolean {
  return travellers.every((passenger) => {
    const age = ageOn(passenger.dateOfBirth, travelDate);
    if (age === null) return false;
    if (passenger.passengerType === 'ADT') return age >= 12;
    if (passenger.passengerType === 'CHD') return age >= 5 && age < 12;
    if (passenger.passengerType === 'CNN') return age >= 2 && age < 5;
    return age >= 0 && age < 2;
  });
}
```

### Passport Validation

Only enforced for international itineraries:

```typescript
function passportsAreValid(
  travellers: BookingTraveller[],
  travelDate: string
): boolean {
  return travellers.every(
    (passenger) =>
      Boolean(passenger.passportNumber) &&
      Boolean(passenger.issuingCountry) &&
      Boolean(passenger.passportExpiry) &&
      (passenger.passportExpiry as string) >= travelDate
  );
}
```

## Booking Data Structures

### Booking Offer

```typescript
type BookingOffer = {
  currency: string;
  totalPrice: number;
  serviceMargin: number;
  passengerCounts: Partial<Record<BookingPassengerType, number>>;
  travelDate: string;
  directTicketing: boolean;
  passportRequired: boolean;
  itinerary: BookedItinerary | null;
  fares: FareBreakdown[];
  repricedAt: string;
};
```

### Public Booking Attempt

```typescript
type PublicBookingAttempt = BookingOffer & {
  attemptId: string;
  expiresAt: string;
  submissionEnabled: boolean;
  suggestedContact?: Pick<BookingContact, 'phone' | 'phoneCountryCode'>;
};
```

Deliberately has no status field - draft/submitting are internal states.

### Public Booking

```typescript
type PublicBooking = BookingOffer & {
  bookingId: string;
  publicRef: string;           // STRYYMMDD######
  status: BookingStatus;
  paymentState: PaymentState;
  headerContact: { /* ... */ };
  pnr: string | null;
  airlinesPnr: string[];
  bookingRefNumber: string | null;
  bookingStatus: string | null;
  ticketingTimeLimit: string | null;
  ticketingDeadlineAt: string | null;
  ticketNumbers: string[];
  warnings: string[];
  bookedAt: string;
  issuedAt: string | null;
  cancelledAt: string | null;
};
```

## Booking Attempt Lifecycle

### State Transitions

```
draft → submitting → succeeded
                    \→ failed
                    \→ unknown
```

- **draft**: Initial state, awaiting traveller information
- **submitting**: Optimistic lock acquired, supplier call in progress
- **succeeded**: Supplier booking created successfully
- **failed**: Supplier definitively did not create a booking
- **unknown**: Ambiguous outcome, requires reconciliation

The operation/attempt watchdog creates or confirms an `attempt_uncertainty`
case for aged `submitting`/`unknown` rows. It never retries the destructive Book
call and never creates a placeholder `flight_bookings` row.

### Attempt Resolution

```typescript
if (bookingOutcome.status === 'held' || bookingOutcome.status === 'ticketed') {
  // Create business booking
  const booking = await createBookingFromAttempt(attempt, bookingOutcome);

  // Update attempt
  await resolveBookingAttempt(attempt.id, 'succeeded');

  // Atomic finalizer also links event/outbox and any reservation consequence.
} else {
  // Definitive response: failed. Ambiguous/no complete response: unknown + case.
}
```

## API Route Implementation

### Main Booking Route

```typescript
// app/api/flights/booking/route.ts
export async function POST(request: NextRequest) {
  // 1. Authenticate
  const session = await getDashboardSession();
  if (!session) {
    return fail(401, 'SIGN_IN_REQUIRED', 'Please sign in to complete this booking.');
  }

  // 2. Validate request
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return fail(400, 'INVALID_TRAVELLERS', parsed.error.issues[0]?.message);
  }

  // 3. Rate limit
  const limit = await checkActionLimit('flightBookingSubmit', requestActorKey(request, userId));
  if (!limit.ok) {
    return NextResponse.json({ error: 'Rate limited' }, { status: 429 });
  }

  // 4. Read and claim attempt
  const current = await readBookingAttempt(parsed.data.bookingId, parsed.data.accessToken);
  if (!current) {
    return fail(404, 'DRAFT_NOT_FOUND', 'This booking draft is unavailable.');
  }

  // 5. Validate ownership and state
  if (current.user_id !== userId) {
    return fail(403, 'DRAFT_NOT_YOURS', 'This booking belongs to a different account.');
  }

  if (current.state !== 'draft') {
    return fail(409, 'BOOKING_ALREADY_STARTED', 'This booking has already been submitted.');
  }

  if (Date.parse(current.expires_at) <= Date.now()) {
    return fail(410, 'DRAFT_EXPIRED', 'This fare expired. Search and verify it again.');
  }

  // 6. Claim attempt (optimistic lock)
  await claimBookingAttempt(current.id, current.access_token_hash);

  // 7. Validate travellers
  const offer = current.offer_snapshot;
  if (
    !exactPassengerMix(offer.passengerCounts, parsed.data.travellers) ||
    !agesAreValid(parsed.data.travellers, offer.travelDate)
  ) {
    await restoreClaimedBookingAttempt(current.id);
    return fail(400, 'PASSENGER_MISMATCH', 'Traveller details do not match the fare.');
  }

  if (offer.passportRequired && !passportsAreValid(parsed.data.travellers, offer.travelDate)) {
    await restoreClaimedBookingAttempt(current.id);
    return fail(400, 'PASSPORT_REQUIRED', 'Valid passports are required for this itinerary.');
  }

  // 8. Call supplier
  const contact = {
    ...parsed.data.contact,
    ...BOOKING_CONTACT_DEFAULTS, // Override with fixed values
  };

  const { outcome, submittedPassengers } = await bookFlight(
    current.supplier_refs,
    parsed.data.travellers,
    contact
  );

  // 9. Create or fail
  if (outcome.status === 'held' || outcome.status === 'ticketed') {
    const booking = await createBookingFromAttempt(current.id, outcome, {
      passengers: submittedPassengers,
      contact: parsed.data.contact,
    });

    await resolveBookingAttempt(current.id, 'succeeded');

    if (outcome.status === 'held') {
      await sendOnHoldBookingEmailOnce(booking);
    } else {
      await sendConfirmedBookingEmailOnce(booking);
    }

    return NextResponse.json({ booking: publicBookingWithHeaderContact(booking, session) });
  } else {
    await resolveBookingAttempt(current.id, 'failed');
    return fail(502, 'BOOKING_FAILED', outcome.message || 'The supplier could not create this booking.');
  }
}
```

## Error Handling

### Classification

Booking errors are classified by type:

- **Authentication errors**: User not signed in
- **Authorization errors**: Draft belongs to another user
- **Validation errors**: Invalid traveller data
- **State errors**: Draft already submitted or expired
- **Rate limiting**: Too many booking attempts
- **Supplier errors**: Triplover booking failure
- **Network errors**: Connection issues

### Recovery Strategy

- **Validation failures**: Restore attempt to draft, inform user
- **State conflicts**: Inform user to start over
- **Definitive supplier failures before creation**: Mark attempt failed; a new
  user action may start a new request identity
- **Network/protocol/timeout or lost complete response**: Mark attempt unknown,
  create/retain an owned attempt case, and never replay Book blindly

## Related Documentation

- [08-BOOKING-LIFECYCLE.md](08-BOOKING-LIFECYCLE.md) - Booking status lifecycle
- [09-SUPPLIER-INTEGRATION.md](09-SUPPLIER-INTEGRATION.md) - Triplover API integration
- [10-WALLET-SYSTEM.md](10-WALLET-SYSTEM.md) - Wallet and payment system
- [12-DATABASE.md](12-DATABASE.md) - Database schema
- [17-IMP-EXP-IMPORTS.md](17-IMP-EXP-IMPORTS.md) - Imported booking workflow

## Critical Invariants

### Supplier References
- Supplier reference tokens must be preserved from search through booking
- These tokens cannot be re-derived and are required for booking
- They must be stored in booking_attempts and copied to flight_bookings

### Optimistic Locking
- Booking attempts must use optimistic locking to prevent double-submission
- The lock must check state, access token, and expiry
- Failed claims must restore the attempt to draft state

### Attempt vs Booking Separation
- booking_attempts must never be shown as bookings
- flight_bookings must only be created for successful supplier bookings
- Attempt rows must be linked to booking rows via attempt_id
- `submitting`/`unknown` attempts must remain internal and explicitly owned until
  definitive supplier truth is established

### Validation Order
- User authentication must happen before any validation
- Draft ownership must be validated before state checks
- Traveller validation must happen before supplier call
- Supplier call must only happen after all validations pass

### Security
- Contact email/country/city must be fixed server-side
- Access tokens must be hashed before storage
- User identity must come from session, not request payload

### Imported Booking Safety

- Imported assignments are required; the operator must never become the fallback owner
- Supplier Gross and User Payable must remain separate, and only User Payable is chargeable
- Held import does not charge; owner confirmation charges once and moves to In Progress
- Direct confirmed import charges only after explicit Import & Charge prior authorization; Import Only creates an Accounts case and no debit
- Sync, Complete, re-import, retry, double-click, and concurrent requests must not create another debit
- Normal Triplover Issue, Cancel, and Refresh routes must reject imported external-supplier rows

## Before Modifying This System

1. **Understand Attempt/Booking Separation**: Review BOOKING_ARCHITECTURE.md
2. **Test Optimistic Locking**: Verify double-submission prevention
3. **Check Supplier Dependencies**: Review Triplover API contract
4. **Validate Validation Logic**: Ensure all validation rules are covered
5. **Test Error Recovery**: Verify failure handling and attempt restoration
6. **Update Related Systems**: Update wallet and email systems if booking flow changes
7. **Security Review**: Ensure contact information remains fixed server-side
8. **Database Impact**: Check for schema changes needed in booking_attempts or flight_bookings
