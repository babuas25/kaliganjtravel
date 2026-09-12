# Booking Lifecycle

The booking lifecycle defines the seven public business statuses used for display,
filtering, reporting, and customer communication. Operation progress,
reconciliation ownership, financial disposition, and notification delivery are
separate internal state machines; they must never be encoded as extra public
statuses.

## Seven Business Statuses

The booking system uses exactly seven public statuses:

```
On Hold · Pending · In Progress · Confirmed · Expired · Unconfirmed · Cancelled
```

Canonical stored values:

```typescript
const BOOKING_STATUSES = [
  'on-hold',
  'pending',
  'in-progress',
  'confirmed',
  'expired',
  'unconfirmed',
  'cancelled',
] as const;
```

## Status Meanings

### On Hold

**Authoritative meaning**: A real supplier-held booking exists, airline PNR is present, the authoritative ticketing deadline has not passed, and no supplier operation is active or unresolved. For IMP/EXP, the booking may be stored On Hold/Unpaid until the assigned owner confirms payment.

**Business implications**:
- Booking is confirmed by supplier but not yet ticketed
- Funds may be held in wallet reservation
- Customer can proceed to ticket issuance
- Booking can be cancelled before deadline
- Imported On Hold bookings have no wallet debit until Confirm & Pay succeeds

**Stored in**: `flight_bookings.status = 'on-hold'`

### Pending

**Authoritative meaning**: A reserved state for a known waiting prerequisite before any supplier write is active or ambiguous.

**Business implications**:
- Booking is waiting for a prerequisite (e.g., wallet funding)
- The prerequisite and owner must be explicit internally
- No irreversible supplier write is active or uncertain
- This is a rare compatibility/special-use state, not the normal response to a
  supplier or wallet shortage

**Stored in**: `flight_bookings.status = 'pending'`

### In Progress

**Authoritative meaning**: Ticketing, cancellation, imported manual ticketing,
supplier verification, or genuine supplier-outcome uncertainty is active. The
public label stays In Progress; staff use the linked operation and case for the
precise subtype, owner, evidence freshness, and SLA.

**Business implications**:
- A supplier operation is in progress
- Funds may be held in wallet reservation
- Booking cannot be modified during operation
- Operation reason explains which operation (ticketing, cancellation, reconciliation)

**Stored in**: `flight_bookings.status = 'in-progress'`

**Operation reasons**:
- `ticketing` - Standard ticket issuance
- `supplier_balance_insufficient` - Legacy compatibility reason only; new
  supplier-balance ambiguity uses ticketing reconciliation, not Pending
- `ticketing_reconciliation` - Reconciling ambiguous ticket issuance
- `cancellation` - Standard cancellation
- `cancellation_reconciliation` - Reconciling ambiguous cancellation
- `terminal_state_conflict` - Resolving state conflicts
- `direct_ticket_payment_reconciliation` - Reconciling direct-ticket payment
- `imported_manual_ticketing` - Imported payment captured; staff must issue/verify externally

### Confirmed

**Authoritative meaning**: Ticket issuance is authoritatively proven and required
ticket evidence is persisted. A payment disagreement does not change ticket
truth; it must appear as an owned financial case.

**Business implications**:
- Tickets have been issued
- Payment is captured or any disagreement is explicitly owned
- Booking is terminal for ordinary flows
- Any correction uses an evidence-bound reconciliation action

**Stored in**: `flight_bookings.status = 'confirmed'`

**Protected outcome**: Ordinary refresh logic must not silently change this to another status.

### Expired

**Authoritative meaning**: A held booking with an airline PNR has passed its authoritative ticketing deadline and has no unresolved supplier write that could already have issued it.

**Business implications**:
- Ticketing deadline has passed
- Booking was not ticketed in time
- Supplier may have auto-cancelled the booking
- May require manual reconciliation

**Computed from**: `flight_bookings.status = 'on-hold'` + `ticketing_deadline_at <= now()`

**Why computed**: Supplier can extend deadlines, so a stored `expired` would need un-setting. Computed status self-corrects.

### Unconfirmed

**Authoritative meaning**: A real supplier booking exists but airline-side PNR/confirmation is missing.

**Business implications**:
- Supplier booking exists but airline PNR is missing
- May indicate supplier-side delay or issue
- Requires PNR sync to resolve
- Not a failed or unknown booking attempt

**Computed from**: `flight_bookings.status = 'on-hold'` + `airlines_pnr` is empty

**Why computed**: A later sync can surface a missing PNR. Computed status resolves itself.

### Cancelled

**Authoritative meaning**: Supplier cancellation/voiding is authoritatively
proven. Refund, fee, retained capture, external settlement, or other payment
truth is represented separately and must be settled or explicitly owned.

**Business implications**:
- Booking has been cancelled
- Funds may be released/refunded, retained under an approved disposition, or
  visibly awaiting financial resolution
- Booking is terminal for ordinary flows
- A correction requires fresh matching supplier evidence and maker-checker
  authorization; Sync cannot restore it

**Stored in**: `flight_bookings.status = 'cancelled'`

**Protected outcome**: Ordinary refresh logic must not silently change this to another status.

## Stored vs Computed Statuses

### Stored Statuses

Five statuses are stored directly in `flight_bookings.status`:

```typescript
const STORED_BOOKING_STATUSES = [
  'on-hold',
  'pending',
  'in-progress',
  'confirmed',
  'cancelled',
] as const;
```

These are **decided states** that represent definitive business outcomes.

### Computed Statuses

Two statuses are computed from other data:

- **Expired**: Computed from `on-hold` + passed deadline
- **Unconfirmed**: Computed from `on-hold` + missing airline PNR

These are **derived states** that must not be stored because:
- Supplier can extend deadlines (expired would need un-setting)
- PNR sync can surface missing data (unconfirmed would need updating)

## Authoritative Lifecycle Resolution

### Read/Display Precedence

For an ordinary business booking, resolve lifecycle status in this order:

```text
1. stored cancelled                         -> Cancelled
2. stored confirmed                         -> Confirmed
3. active or unresolved supplier operation  -> In Progress
4. stored pending                           -> Pending
5. stored on-hold + airline PNR missing      -> Unconfirmed
6. stored on-hold + PNR + deadline <= now   -> Expired
7. stored on-hold                           -> On Hold
```

**Key rule**: An unresolved supplier write outranks the clock. If NewTicket timed out, the ticket may already exist; the booking must remain In Progress until supplier truth is established.

### One Shared Definition

The authoritative resolution is implemented in the SQL view `booking_lifecycle_v`:

```sql
create view booking_lifecycle_v as
select
  fb.*,
  case
    when fb.status = 'cancelled' then 'cancelled'::text
    when fb.status = 'confirmed' then 'confirmed'::text
    when fb.operation_kind is not null then 'in-progress'::text
    when fb.status = 'pending' then 'pending'::text
    when fb.status = 'on-hold' and
         (fb.airlines_pnr is null or jsonb_array_length(fb.airlines_pnr) = 0)
      then 'unconfirmed'::text
    when fb.status = 'on-hold' and
         fb.ticketing_deadline_at is not null and
         fb.ticketing_deadline_at <= now()
      then 'expired'::text
    when fb.status = 'on-hold' then 'on-hold'::text
    else fb.status
  end as lifecycle_status
from flight_bookings fb
where fb.legacy_operational = false;
```

**Important**: Application code must not independently recreate this precedence. Everything reads from this view.

### Application Fallback

For writer-returned rows that haven't been re-read through the view, a TypeScript fallback exists:

```typescript
// lib/flights/booking-status.ts
export function deriveBookingStatus({
  status,
  airlinesPnr,
  ticketingDeadlineAt,
  now = Date.now(),
}: BookingStatusInput): BookingStatus {
  if (status !== 'on-hold') return status;
  if (airlinesPnr.length === 0) return 'unconfirmed';
  const deadline = ticketingDeadlineAt ? Date.parse(ticketingDeadlineAt) : Number.NaN;
  if (Number.isFinite(deadline) && deadline <= now) return 'expired';
  return 'on-hold';
}
```

This mirrors the SQL view logic for TypeScript type safety.

## Status Transitions

### Allowed Transitions

```
on-hold → in-progress (ticketing)
on-hold → cancelled
on-hold → expired (computed)
on-hold → unconfirmed (computed)

pending → in-progress (ticketing)
pending → cancelled

in-progress → confirmed (ticketing success)
in-progress → on-hold (ticketing failure)
in-progress → cancelled (cancellation success)
in-progress → on-hold (cancellation failure)

expired → cancelled (manual)
unconfirmed → on-hold (PNR sync)
unconfirmed → cancelled (manual)
```

### Imported Booking Transitions

Imported bookings use the same public statuses with stricter financial gates:

| Action/evidence | From | To | Payment/wallet |
| --------------- | ---- | -- | -------------- |
| Import supplier Held | New | On Hold | Unpaid; no debit |
| Assigned owner Confirm & Pay | On Hold | In Progress | Capture User Payable once |
| Sync, supplier still Held | In Progress | In Progress | Captured; no debit |
| Sync observes authoritative Ticketed/Confirmed | In Progress | In Progress | Store fresh evidence; no debit |
| Staff Complete after matching ticket evidence | In Progress | Confirmed | Reuse original capture; no debit |
| Direct confirmed Import Only | New | Confirmed | Unpaid plus owned Accounts case; no debit |
| Direct confirmed Import & Charge | New | Confirmed | Consume a fresh one-use authorization; capture User Payable once |
| Sync finds negative/failed evidence after capture | In Progress | In Progress/Reconciliation | No direct balance edit |

An imported `In Progress` row with
`operation_reason = 'imported_manual_ticketing'` is not a transient Triplover
write. It records that customer payment is complete while manual external
ticketing/verification is outstanding. Supplier Held evidence must not return
it to On Hold, and supplier status alone must never authorize a wallet debit.

Lifecycle transitions do not merge the imported price concepts. Sync may
refresh Supplier Gross and supplier fare evidence, which changes the ticket face
presentation, but it must preserve the already-authorized User Payable and
captured payment amount.

### Protected States

**Confirmed** and **Cancelled** are protected outcomes:
- Ordinary refresh logic must not silently change them
- Only explicit reconciliation can transition them
- This prevents accidental state corruption

### Terminal Correction

Confirmed and Cancelled may be corrected only by named case-bound resolution
contracts. The database rechecks the current booking, operation, case version,
fresh evidence, proposal hash, actor role, and maker/checker separation in the
same transaction as any booking, reservation, wallet, ledger, event, and outbox
change. Ordinary status writers and supplier Sync never perform terminal
correction.

## Internal Operations and Reconciliation Cases

### Operation Kind

Every irreversible supplier write and imported manual-ticket task has a durable
`booking_operations` row. Compatibility columns on `flight_bookings` remain for
rolling deployment, but the operation row is authoritative for request identity,
claim state, supplier-call boundaries, evidence, completion, and watchdog timing.

```text
kind: ticketing | cancellation | imported_manual_ticketing

state:
claimed | supplier_call_started | awaiting_external_action |
needs_reconciliation | succeeded | failed
```

### Operation Reason

The specific reason for the operation:

```text
operation_reason:
ticketing
supplier_balance_insufficient
ticketing_reconciliation
cancellation
cancellation_reconciliation
terminal_state_conflict
direct_ticket_payment_reconciliation
imported_manual_ticketing
legacy_reconciliation
```

### Operation Locking

Only one unresolved operation may exist for a booking. Every write/resolution
uses the booking as the first serialization root, followed by operation, case,
reservation, wallet, and currency account where applicable. An ambiguous
supplier write moves to `needs_reconciliation`; it is never replayed blindly.

### Reconciliation Cases

`booking_reconciliation_cases` owns uncertainty for either one booking or one
booking attempt. It stores case type, state, team/assignee, SLA and escalation,
normalized evidence references, proposal/approval/resolution metadata, and any
financial disposition. Cases are internal and do not add customer statuses.

One unresolved case per subject and case type is enforced. High-risk terminal or
financial outcomes require a proposal by an authorized maker and approval by a
different Admin or Super Admin. Automatic no-change closure is allowed only when
fresh identity-matching evidence agrees with already-consistent terminal and
financial truth.

## Deadline Handling

### Deadline Sources

The ticketing deadline can come from three sources:

```text
deadline_source:
supplier    - From Book response
pnr_call    - From PNR lookup (authoritative)
assumed     - Fallback assumption
```

### Deadline Parsing

Triplover Book responses use DD/MM/YYYY HH24:MI:SS or an ISO-like timestamp.
Live PNR slash dates are credential-account and carrier-specific. FirstTrip
and direct Triplover use MM/DD/YYYY for US-Bangla (`BS`) and DD/MM/YYYY
otherwise; TakeOff uses MM/DD/YYYY for every carrier. All values represent an
`Asia/Dhaka` wall clock and are stored as `timestamptz` instants.

```sql
create or replace function public.parse_triplover_booking_deadline(p_value text)
returns timestamptz
language plpgsql
stable
as $$
declare
  v_value text := nullif(trim(p_value), '');
  v_match text[];
begin
  if v_value is null then
    return null;
  end if;

  v_match := regexp_match(
    v_value,
    '^([0-9]{2})/([0-9]{2})/([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$'
  );
  if v_match is not null then
    return make_timestamptz(
      v_match[3]::integer,
      v_match[2]::integer,
      v_match[1]::integer,
      v_match[4]::integer,
      v_match[5]::integer,
      v_match[6]::double precision,
      'Asia/Dhaka'
    );
  end if;

  -- ISO format for fixtures/imports
  v_match := regexp_match(
    v_value,
    '^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})$'
  );
  if v_match is not null then
    return make_timestamptz(
      v_match[1]::integer,
      v_match[2]::integer,
      v_match[3]::integer,
      v_match[4]::integer,
      v_match[5]::integer,
      v_match[6]::double precision,
      'Asia/Dhaka'
    );
  end if;

  return null;
end;
$$;
```

### Deadline Authority

Triplover `/api/pnr.lastTicketTime` supersedes Book deadline. PNR sync updates the deadline and sets `deadline_source = 'pnr_call'`.

After a new held booking, the confirmation page checks PNR at 15, 30, and 45
seconds, then at 2, 4, and 6 minutes for slower carrier propagation. Intermediate
responses without a deadline do not reload the page, because doing so would
cancel the remaining client retry sequence. The page refreshes once a deadline
is found or the complete window is exhausted.

## PNR-Based Confirmation Detection

### Airline PNR

The airline's own record locator(s):

```typescript
airlinesPnr: string[];
```

- Empty array → airline never confirmed → **Unconfirmed**
- Has values → airline confirmed → evaluate further

### PNR Sync

PNR lookup via `/api/pnr`:
- Fetches current PNR status
- Updates ticketing deadline
- Populates `airlines_pnr`
- May resolve Unconfirmed status

## Public Booking References

### Reference Format

Sequential, human-readable references:

```
STR 260801 000001
 │     │      └── daily sequence, zero-padded to 6
 │     └───────── YYMMDD of allocation, Asia/Dhaka
 └─────────────── fixed prefix
```

### Allocation Rules

- **Day boundary**: Asia/Dhaka, not UTC
- **Allocation timing**: After supplier confirms, never before
- **Atomic allocation**: Single transaction with row lock
- **No supplier call in transaction**: Lock held for microseconds, not HTTP call duration
- **Unique index**: Prevents duplicate references
- **Permanent**: References never recycled, even after cancellation

### Allocation Function

```sql
create or replace function public.allocate_booking_ref()
returns text
language sql
as $$
  select public.allocate_booking_ref_for(
    (now() at time zone 'Asia/Dhaka')::date
  );
$$;
```

## Status Event Tracking

### booking_status_events Table

Immutable occurrence-aware history of lifecycle and material financial events:

```sql
create table public.booking_status_events (
  id bigint generated by default as identity primary key,
  booking_id uuid not null references public.flight_bookings (id),
  from_lifecycle_status text,
  to_lifecycle_status text not null,
  stored_status_before text,
  stored_status_after text,
  operation_kind text,
  operation_reason text,
  actor_user_id text,
  supplier_operation text,
  supplier_evidence jsonb not null,
  idempotency_key text not null unique,
  operation_id uuid,
  reconciliation_case_id uuid,
  occurrence_id uuid not null unique,
  occurrence_number integer,
  effective_at timestamptz,
  observed_at timestamptz,
  event_snapshot jsonb not null,
  event_version integer not null
);
```

### Event Recording

Every material occurrence records an event in the same transaction as its
business change. A database trigger creates the corresponding outbox intent:

```sql
insert into public.booking_status_events
  (booking_id, from_lifecycle_status, to_lifecycle_status, occurrence_id, ...)
values (p_booking_id, p_from_status, p_to_status, gen_random_uuid(), ...);
```

### Purpose

- Provides audit trail of status changes
- Enables historical reporting
- Supports reconciliation analysis
- Answers "how many expired last month"
- Allows material status re-entry to notify again without duplicating the same
  occurrence
- Keeps notification suppression/supersession separate from immutable history

Outbox delivery is a separately deployed behavior. Unless the server-only
`BOOKING_NOTIFICATION_OUTBOX_ENABLED` switch is exactly `true`, both immediate
and scheduled delivery entry points leave durable intents queued and send no
email. The scalable keyset expiry/unconfirmed worker is likewise selected only
by `BOOKING_LIFECYCLE_SCALABLE_SWEEP_ENABLED=true`; otherwise the protected
scheduler uses the retained bounded compatibility observer.

## Database Schema

### flight_bookings Columns

Key lifecycle-related columns:

```sql
status                  text not null default 'on-hold'
                        check (status in ('on-hold', 'pending', 'in-progress', 'confirmed', 'cancelled'))

operation_kind          text
                        check (operation_kind in ('none', 'ticketing', 'cancellation', 'reconciliation'))

operation_reason        text
operation_request_id    text
operation_actor_user_id text
operation_started_at    timestamptz
operation_prior_status   text
active_operation_id      uuid references booking_operations(id)

ticketing_deadline_at   timestamptz
deadline_source          text
                        check (deadline_source in ('supplier', 'pnr_call', 'assumed'))

issued_at               timestamptz
cancelled_at            timestamptz
cancelled_by            text
cancel_reason           text
```

### booking_attempts Columns

Operational states (not business statuses):

```sql
state                   text not null default 'draft'
                        check (state in ('draft', 'submitting', 'succeeded', 'failed', 'unknown'))
```

## Related Documentation

### Super Admin Issue Now Resolution

The booking detail page gives Super Admin three supplier outcomes for a stuck
ordinary B2B/B2C Issue Now booking: Ticket Issued, Still Valid / Restore On
Hold, and Not Issued / Cancel. Supplier evidence upload, proposal,
maker/checker, and a separate execution step are not required.

This does not weaken accounting invariants. Actual reservation and immutable
ledger state determine automatic Capture, Release, Refund, or No Movement. A
missing local Capture source never causes an automatic direct charge. Instead,
Super Admin can enter an independently verified customer-wallet action in the
audited manual lane, after seeing exact Available/Hold before and after values.
Supplier amount remains separate and never determines that customer amount.
Restore releases a real Issue Now Hold. Its Super Admin deadline stays
effective while supplier deadline history remains preserved. Retained
`legacy_operational=true` rows are reachable only through the explicit Super
Admin reference path and remain excluded from normal lifecycle workers.

- [07-BOOKING-SYSTEM.md](07-BOOKING-SYSTEM.md) - Booking creation and processing
- [10-WALLET-SYSTEM.md](10-WALLET-SYSTEM.md) - Wallet and payment integration
- [09-SUPPLIER-INTEGRATION.md](09-SUPPLIER-INTEGRATION.md) - Supplier operations
- [12-DATABASE.md](12-DATABASE.md) - Database schema
- [17-IMP-EXP-IMPORTS.md](17-IMP-EXP-IMPORTS.md) - Imported booking lifecycle and Sync

## Critical Invariants

### Status Authority
- Booking lifecycle must be resolved through a single authoritative source (booking_lifecycle_v)
- Application code must not independently recreate status resolution logic
- Stored statuses must be limited to decided states only

### Computed Statuses
- Expired and Unconfirmed must never be stored in flight_bookings.status
- These statuses must be computed from other data
- This allows them to self-correct when underlying data changes

### Protected States
- Confirmed and Cancelled are protected outcomes
- Ordinary refresh logic must not silently change them
- Only explicit reconciliation can transition these states
- A paid imported In Progress booking remains protected from a Sync downgrade to On Hold

### Imported Booking Payments

- Held import is On Hold/Unpaid and never charges during import
- Owner confirmation atomically captures User Payable and moves On Hold to In Progress
- Direct confirmed Import Only creates Confirmed/Unpaid plus an owned Accounts case
- Direct confirmed Import & Charge requires and consumes a fresh one-use authorization
- Sync records authoritative ticket evidence; the separate Complete action promotes
  paid In Progress to Confirmed without another debit
- Sync and re-import never act as payment authorization and never create another debit

### Operation Locking
- Only one incompatible supplier operation may be active for a booking
- Ticketing and cancellation must acquire the same database lock
- Operation state must be tracked independently of booking status

### Deadline Authority
- PNR deadline (deadline_source = 'pnr_call') supersedes Book deadline
- FirstTrip and direct Triplover PNR parsing must use MM/DD/YYYY for BS and DD/MM/YYYY otherwise
- TakeOff PNR parsing must use MM/DD/YYYY for every carrier
- Book parsing must continue to handle DD/MM/YYYY and ISO formats
- Time zone must be Asia/Dhaka, not UTC

### Public References
- Public references must be allocated only after supplier confirmation
- Allocation must be atomic with row locking
- References must never be recycled
- Day boundary must be Asia/Dhaka

## Before Modifying This System

1. **Understand Status Separation**: Review BOOKING_ARCHITECTURE.md and BOOKING_STATUS_LIFECYCLE_REVIEW_PROPOSAL.md
2. **Test Lifecycle Resolution**: Verify booking_lifecycle_v produces correct results
3. **Check Operation Dependencies**: Identify all operations that depend on status
4. **Validate Transition Rules**: Ensure all transitions are supported
5. **Test Protected States**: Verify Confirmed/Cancelled cannot be silently changed
6. **Update View SQL**: If status logic changes, update booking_lifecycle_v
7. **Update TypeScript Fallback**: Keep deriveBookingStatus() in sync with SQL view
8. **Test Event Recording**: Verify status events are recorded correctly
9. **Check Email Triggers**: Ensure emails trigger on correct status changes
10. **Security Review**: Ensure status transitions respect authorization
