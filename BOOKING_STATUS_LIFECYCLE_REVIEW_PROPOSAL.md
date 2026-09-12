# ShoponTravels Booking Status Lifecycle — Revised Recommendation

**Document purpose:** Approved implementation baseline and remaining decision record

**Implementation status:** Database migrations `0031`–`0033` applied; application implementation included in this revision

**Supplier scope:** Triplover

**Related documents:** `BOOKING_ARCHITECTURE.md`, `WALLET_ARCHITECTURE.md`, `Triploaver_API_Documentation.md`
**Revised:** 2026-08-06 after implementation and linked-database verification

---

## 0. Controlled migration record

- `0031_booking_lifecycle_authority.sql` was applied on 2026-08-06.
- `0032_booking_lifecycle_manual_issue_guard.sql` was applied immediately after
  verification found that the application uses the historical four-argument
  manual-issue RPC signature. The corrective migration replaces that exact
  overload with the guarded implementation and removes the accidental
  three-argument overload from `0031`.
- `0033_verified_booking_cancellation_reconciliation.sql` added a row-locking,
  service-role-only, idempotent resolver for manually verified cancellations.
  It resolved three unpaid legacy reconciliations and repaired one missing
  event on an already-Cancelled captured booking without changing wallet or
  `cancelled_at` data. The test-credential booking `STR260805000013` remains
  explicitly unresolved.
- Legacy row `8b447ef1-b91c-4444-a3ba-81e413168bb2` was not backfilled. It is an
  expired legacy draft whose copied attempt was legitimately removed by the
  existing seven-day security-retention policy; no authoritative related
  attempt exists from which to reconstruct it.
- Migration status, database lint, lifecycle projection, operation invariants,
  transactional issue/cancel guards, status events, wallet boundaries,
  TypeScript, ESLint, production build, security, and email verification all
  passed after migration.
- Application deployment is handled separately by the repository production
  workflow after this verified revision is committed.

---

## 1. Verdict

ShoponTravels should retain exactly seven public booking statuses, but those
statuses must not also carry supplier-operation and wallet meanings. The safe
model has four separate state dimensions:

1. booking-attempt state;
2. stored business-booking state;
3. active supplier operation and reason;
4. wallet payment/reservation state.

The reviewed baseline already separated attempts and wallet reservations
reasonably well, but it did not have one lifecycle authority or a durable
operation lock shared by ticket issuance and cancellation. Migrations `0031`
through `0033` now provide that database authority; the corresponding application
source changes remain local until a separate deployment is requested.

This document defines the approved target model and records the controlled
database rollout. Application deployment remains a separate action.

---

## 2. Required public status vocabulary

The user/business-facing vocabulary remains exactly:

1. **On Hold**
2. **Pending**
3. **In Progress**
4. **Confirmed**
5. **Expired**
6. **Unconfirmed**
7. **Cancelled**

Canonical stored/API values are:

```text
on-hold | pending | in-progress | confirmed | expired | unconfirmed | cancelled
```

Use one shared label source. The preferred English label is **Unconfirmed**,
without a hyphen.

---

## 3. Four independent state dimensions

### 3.1 Booking attempt state

`booking_attempts.state` describes only the initial Triplover Book execution:

```text
draft -> submitting -> succeeded
                  \-> failed
                  \-> unknown
```

- `failed` means Book definitively did not create a supplier booking.
- `unknown` means Book may have created or ticketed something and must be
  reconciled.
- Failed and unknown attempts do not become Unconfirmed business bookings.
- A `flight_bookings` row is created only when there is sufficient evidence
  that a real supplier booking exists.

The current optimistic `draft -> submitting` claim remains the initial
double-submit guard. Successful booking insert, attempt resolution, and public
reference allocation should remain atomic.

### 3.2 Stored business-booking state

`flight_bookings.status` stores only decided business states:

```text
on-hold | pending | in-progress | confirmed | cancelled
```

`expired` and `unconfirmed` remain derived lifecycle states. They should not be
written to `flight_bookings.status`.

### 3.3 Supplier operation state

Every supplier write after Book needs a durable operation claim. At minimum it
must distinguish:

```text
operation_kind:
none | ticketing | cancellation | reconciliation

operation_reason:
ticketing
supplier_balance_insufficient
ticketing_reconciliation
cancellation
cancellation_reconciliation
terminal_state_conflict
direct_ticket_payment_reconciliation
```

The exact schema may be columns on `flight_bookings` or a dedicated active
operation table. A dedicated table is preferable if it must hold an idempotency
key, actor, attempt count, prior safe state, supplier evidence, timestamps, and
resolution details.

Only one incompatible supplier operation may be active for a booking. Ticketing
and cancellation must acquire the same database-controlled lock.

### 3.4 Wallet/payment state

Wallet state remains independent:

```text
payment_state:
unpaid | held | captured | released | reconciliation |
partially-refunded | refunded

reservation_state:
active | captured | released | reconciliation
```

Public booking status is never sufficient evidence that money was reserved,
captured, released, or refunded.

---

## 4. Authoritative meaning of each public status

| Status | Authoritative meaning |
| --- | --- |
| **On Hold** | A real Triplover held booking exists, airline PNR is present, the authoritative ticketing deadline has not passed, and no supplier operation is active or unresolved. |
| **Pending** | A reserved state for a known waiting prerequisite before any supplier write is active or ambiguous. No current automatic transition is recommended. |
| **In Progress** | Ticketing, cancellation, or reconciliation is actively claimed or its supplier outcome is unresolved. The internal operation reason explains which. |
| **Confirmed** | Ticket issuance is authoritatively proven and required ticket evidence is persisted. Direct-ticket Book may enter this state directly. |
| **Expired** | A held booking with an airline PNR has passed its authoritative ticketing deadline and has no unresolved supplier write that could already have issued it. |
| **Unconfirmed** | A real supplier booking exists but airline-side PNR/confirmation is missing. It is not a failed or unknown Book attempt. |
| **Cancelled** | Cancellation of an unticketed supplier booking is authoritatively proven and the local wallet consequence is settled or explicitly marked for reconciliation. |

`Confirmed` and `Cancelled` are protected outcomes. Ordinary refresh logic must
not silently change one into the other.

---

## 5. Authoritative lifecycle resolution

### 5.1 Read/display precedence

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

An unresolved supplier write outranks the clock. If NewTicket timed out, the
ticket may already exist; the booking must remain In Progress until supplier
truth is established.

### 5.2 One shared definition

Create `booking_lifecycle_v`, or an equivalent authoritative database resolver,
for lists, details, counts, filters, reports, exports, and administrative tools.
Application code must not independently recreate the precedence.

A view alone is not a safe action lock. Issue and Cancel must use transactional
database functions that lock the booking and apply the same lifecycle
predicates while claiming the operation. Read authorization performed before a
supplier call is advisory; the transactional claim is authoritative.

### 5.3 Deadline source

Triplover `/api/pnr.lastTicketTime` supersedes Book’s earlier
`ticketingTimeLimit`. Persist both the parsed instant and its source.

If no authoritative deadline exists, do not silently invent one without a
separately approved business rule. A missing deadline should be visible to
operations and should not be treated as proof that a hold lasts indefinitely.

---

## 6. Initial Book flow

### 6.1 Normal holdable fare

```text
Search -> RePrice -> attempt draft -> submitting -> Triplover Book
```

| Supplier result | Attempt | Business booking |
| --- | --- | --- |
| Definitive failure, no booking | `failed` | No row |
| Timeout, malformed response, 5xx, or ambiguous failure | `unknown` | No row until reconciliation proves one exists |
| Booking exists with airline PNR | `succeeded` | Stored `on-hold`, lifecycle On Hold or Expired according to deadline |
| Booking exists without airline PNR | `succeeded` | Stored `on-hold`, lifecycle Unconfirmed |

Opaque Triplover references must be persisted verbatim. A Book response must
provide sufficient booking identity before a business row is created.

### 6.2 Direct-ticket fare

For a fare confirmed as direct-ticketing:

```text
attempt submitting
-> reserve customer funds
-> Triplover Book
```

Outcomes:

- Complete authoritative ticket evidence: create Confirmed booking, resolve the
  attempt, attach/capture the reservation, and persist tickets.
- Definitive failure: mark attempt failed and release the reservation.
- Ambiguous outcome: mark attempt unknown and reservation reconciliation; do
  not replay Book.
- Supplier unexpectedly creates only a hold: create the appropriate held or
  Unconfirmed booking and release the direct-ticket reservation.
- Incomplete apparent ticket response: treat as ambiguous, not Confirmed.

Where practical, successful business-booking creation and wallet capture should
be one local transaction. If they cannot be one transaction, failure must link
the created booking to a visible payment-reconciliation state.

Direct-ticket success requires at least a ticket reference and non-empty ticket
numbers, not merely the presence of a `ticketInfoes` array or a status string.

---

## 7. Unconfirmed recovery

The PNR parser must retain Triplover `airlinePNRs[]`; the current implementation
does not.

```text
stored on-hold + no airline PNR
-> Unconfirmed

authoritative PNR sync returns airline PNR
-> persist airlines_pnr
-> On Hold if deadline is valid
-> Expired if deadline has passed
```

While Unconfirmed:

- do not call NewTicket;
- do not run normal held-booking Cancel merely because stored status is
  `on-hold`;
- allow safe read-only PNR/reconciliation operations;
- preserve the supplier’s primary/GDS PNR separately from airline PNRs.

---

## 8. Expired behavior

```text
stored on-hold
+ airline PNR present
+ authoritative deadline <= now()
+ no unresolved supplier operation
-> Expired
```

Expired is ineligible for normal NewTicket and normal held-booking Cancel.
Eligibility must be enforced in the transactional database claim, not only in
the UI.

If a later authoritative PNR read extends the deadline and still proves a valid
held booking, the computed lifecycle may recover from Expired to On Hold.

If an In Progress supplier-balance wait reaches the deadline, first verify that
no ticket was issued and that the supplier hold expired. Only then release the
reservation and resolve the stored booking back to `on-hold`, whose lifecycle
will be Expired.

An ambiguous ticketing operation never becomes Expired from the clock alone.

---

## 9. Ticket-issuance flow

### 9.1 Atomic start claim

Before NewTicket, one database transaction must:

1. lock the booking;
2. verify ownership and actor authorization;
3. verify stored status and authoritative lifecycle eligibility;
4. require a non-empty airline PNR and all opaque supplier references;
5. require a valid, unexpired authoritative deadline;
6. verify no incompatible active operation;
7. verify wallet is active and available balance is sufficient;
8. create or safely reuse an idempotent wallet reservation;
9. change booking to `in-progress` with reason `ticketing`;
10. commit before NewTicket is called.

This shared claim prevents both duplicate NewTicket calls and NewTicket/Cancel
races. Rate limits and UI buttons are not correctness controls.

### 9.2 Outcome A — authoritative success

Success evidence requires a valid ticket reference and non-empty ticket
numbers.

```text
In Progress(ticketing) -> Confirmed
wallet active hold -> captured
persist issued_at + ticket evidence
resolve operation
record status event
```

Booking confirmation and wallet capture must be atomic locally and idempotent.

### 9.3 Outcome B — positively identified supplier-wallet shortage

Triplover’s current project documentation does not expose a stable structured
supplier-balance code. The existing broad text regular expression is not safe
enough to drive money and lifecycle transitions.

Until Triplover provides a verified code/field plus test fixtures, an apparent
balance-shortage message must be treated as an unresolved ticketing result:

```text
In Progress(ticketing_reconciliation)
wallet funds remain held/reconciliation
no automatic Pending transition
no automatic capture
```

After a stable supplier contract is available, a positively identified shortage
that proves no ticket was issued may use:

```text
In Progress(supplier_balance_insufficient)
wallet reservation remains active/held
```

Never capture the customer’s money merely because the supplier wallet is low.

### 9.4 Outcome C — other definitive failure

Only use this path when supplier evidence authoritatively proves NewTicket did
not issue tickets.

```text
still valid supplier hold -> On Hold + release wallet hold
confirmed expired hold    -> Expired + release wallet hold
```

The stored state returns to `on-hold`; lifecycle resolution decides On Hold,
Unconfirmed, or Expired from current supplier facts.

### 9.5 Outcome D — ambiguous result

The following are ambiguous unless a supplier-specific contract proves
otherwise:

- timeout or network failure;
- HTTP 5xx;
- malformed/incomplete response;
- HTTP 200 with `isSuccess:false` but no reliable explanatory evidence;
- incomplete ticket evidence;
- undocumented or conflicting supplier response.

```text
In Progress(ticketing_reconciliation)
wallet funds remain reserved/reconciliation
do not replay NewTicket
```

Reconciliation outcomes:

- issued -> Confirmed and capture;
- definitely not issued, hold valid -> On Hold and release;
- definitely not issued, hold expired -> Expired and release;
- still ambiguous -> remain In Progress and escalate.

---

## 10. Customer wallet insufficient

If the customer wallet cannot fund the reservation:

```text
On Hold -> On Hold
```

- Do not call NewTicket.
- Do not create an unfunded reservation.
- Do not use Pending or In Progress.
- Return a clear recharge/insufficient-funds response.
- Continue resolving expiry normally.

The current wallet balance lock and insufficient-funds behavior already mostly
match this rule.

---

## 11. Cancellation flow

### 11.1 Atomic start claim

Normal cancellation applies only to a verified, unticketed, non-expired held
booking. One database transaction must:

1. lock the booking and active operation;
2. require lifecycle On Hold;
3. require airline PNR and supplier references;
4. require no issued ticket evidence;
5. require the authoritative deadline has not passed;
6. require no ticketing or reconciliation operation;
7. preserve prior safe state and wallet context;
8. set `in-progress` with reason `cancellation`;
9. commit before calling Triplover Cancel.

Triplover Book Cancel is never used for Confirmed tickets. Those require an
explicit void/refund workflow.

### 11.2 Authoritative success

```text
In Progress(cancellation) -> Cancelled
release any applicable uncaptured wallet reservation
persist cancelled_at, actor, reason, evidence
resolve operation
record status event
```

Cancellation and applicable wallet release should be atomic locally.

### 11.3 Definitive refusal

A refusal is definitive only when supplier evidence proves the booking was not
cancelled and states its current condition.

- Still valid hold -> restore stored `on-hold` and resolve lifecycle.
- Hold expired -> restore stored `on-hold`, lifecycle Expired, and release any
  uncaptured reservation.
- Supplier reports issued -> terminal conflict reconciliation; do not restore
  On Hold.

### 11.4 Ambiguous result

Timeouts, 5xx, protocol failures, and empty/weak HTTP 200 failures are
ambiguous:

```text
In Progress(cancellation_reconciliation)
preserve safe wallet state
do not replay Cancel
```

AirTicketingDetails may prove a decided ticket/cancellation outcome, but it must
not be assumed to recover every merely held booking. PNR is the preferred read
for a current hold when the necessary references exist.

---

## 12. Terminal-state protection and reconciliation

Ordinary refresh must not perform:

```text
Cancelled -> Confirmed
Confirmed -> Cancelled
Confirmed -> On Hold
Cancelled -> On Hold
```

When supplier evidence conflicts with Confirmed or Cancelled:

1. retain the protected local status;
2. create/mark a `terminal_state_conflict` reconciliation operation;
3. preserve the supplier response as evidence;
4. block incompatible writes;
5. require a controlled reconciliation action;
6. coordinate any wallet capture, release, or refund atomically;
7. record an immutable status event and actor.

Confirmed and Cancelled are terminal for ordinary workflows. A genuine
correction is an exceptional reconciliation transition, not a normal refresh.

---

## 13. Pending recommendation

Keep Pending in the public vocabulary and database constraint, but do not assign
it an automatic transition yet.

The current project uses Pending for apparent supplier-wallet shortage after it
has already captured customer funds. That behavior should not remain in the
target model.

A future Pending use-case must be:

- a known waiting prerequisite;
- non-ambiguous;
- before any unresolved supplier write;
- distinct from a normal actionable hold;
- distinct from ticketing/cancellation reconciliation;
- defined with explicit wallet behavior.

An approved manual pre-ticket review could qualify, but no such distinct
workflow currently exists. Existing Pending rows must be reconciled
individually before migration; they must not all be mechanically relabelled.

---

## 14. Recommended transition table

| From | Event/evidence | To lifecycle | Stored state | Operation reason | Wallet direction |
| --- | --- | --- | --- | --- | --- |
| No booking | Book definitive failure | No booking | — | — | None for normal holdable fare |
| No booking | Book ambiguous | No booking yet | — | attempt reconciliation | Preserve direct-ticket reservation if applicable |
| No booking | Hold + airline PNR | On Hold/Expired | `on-hold` | none | None |
| No booking | Booking + no airline PNR | Unconfirmed | `on-hold` | none | None |
| No booking | Direct-ticket evidence complete | Confirmed | `confirmed` | none | Hold -> captured |
| Unconfirmed | Airline PNR recovered, deadline valid | On Hold | `on-hold` | none | None |
| Unconfirmed | Airline PNR recovered, deadline passed | Expired | `on-hold` | none | None |
| On Hold | Customer funds insufficient | On Hold | `on-hold` | none | None |
| On Hold | Ticketing claim succeeds | In Progress | `in-progress` | ticketing | Available -> held |
| In Progress | Ticket evidence complete | Confirmed | `confirmed` | resolved | Hold -> captured |
| In Progress | Verified supplier balance shortage | In Progress | `in-progress` | supplier balance | Keep held |
| In Progress | Definitive not-issued, hold valid | On Hold | `on-hold` | resolved | Release |
| In Progress | Definitive not-issued, hold expired | Expired | `on-hold` | resolved | Release |
| In Progress | Ticket result ambiguous | In Progress | `in-progress` | ticketing reconciliation | Keep held/reconciliation |
| On Hold | Deadline passes | Expired | `on-hold` | none | None |
| Expired | Authoritative deadline extended, valid hold | On Hold | `on-hold` | none | None |
| On Hold | Cancellation claim succeeds | In Progress | `in-progress` | cancellation | Preserve |
| In Progress | Cancel proven successful | Cancelled | `cancelled` | resolved | Release uncaptured hold |
| In Progress | Cancel refusal, valid hold proven | On Hold | `on-hold` | resolved | Restore/preserve as appropriate |
| In Progress | Cancel refusal, expiry proven | Expired | `on-hold` | resolved | Release uncaptured hold |
| In Progress | Cancel ambiguous | In Progress | `in-progress` | cancellation reconciliation | Preserve |
| Confirmed/Cancelled | Conflicting supplier evidence | Protected existing status | unchanged | terminal conflict | Preserve pending controlled reconciliation |

Pending intentionally has no automatic transition in this table.

---

## 15. Status events and evidence

Add an immutable `booking_status_events` history, or an equivalent event model.
At minimum record:

```text
booking_id
from_lifecycle_status
to_lifecycle_status
stored_status_before
stored_status_after
operation_kind
operation_reason
actor_type / actor_id
supplier_operation
supplier_reference / evidence metadata
idempotency_key
created_at
```

Do not store secrets or full passenger data in events.

Computed statuses need idempotent observation events if historical reporting
must answer when they first appeared or recovered. Use a unique event identity
or last-observed lifecycle record so every read/sweep does not create another
Expired or Unconfirmed event.

---

## 16. Reconciliation and expiry worker

Ambiguous results are safe only if they are eventually resolved. Add a bounded,
idempotent worker or operational queue that:

- finds aged In Progress/reconciliation operations;
- queries the safest authoritative supplier read;
- never blindly replays Book, NewTicket, or Cancel;
- settles booking and wallet atomically when evidence becomes decisive;
- releases a known-unissued expired reservation;
- preserves ambiguity when evidence is still insufficient;
- records status events without duplication;
- escalates items beyond an operational SLA;
- monitors stranded wallet holds and terminal-state conflicts.

The worker must lock each booking/operation before resolution so it cannot race
with an operator action.

---

## 17. Required invariants

The implementation is acceptable only if tests demonstrate:

1. A booking cannot be ticketed twice.
2. Ticketing and cancellation cannot run concurrently.
3. A direct API request cannot issue Expired or Unconfirmed.
4. A direct API request cannot cancel Expired, Unconfirmed, Confirmed, or an
   active ticketing/reconciliation booking.
5. Customer wallet available or held balance cannot become negative.
6. Ambiguous supplier results do not cause automatic release, capture, or blind
   replay.
7. Supplier-wallet shortage never maps to Pending.
8. Customer-wallet shortage leaves the booking On Hold and does not call
   NewTicket.
9. Confirmed requires complete authoritative ticket evidence.
10. Cancelled requires authoritative cancellation evidence.
11. Ordinary refresh cannot overwrite a protected terminal status.
12. PNR refresh persists airline PNRs and the latest deadline.
13. Every UI, report, filter, count, email decision, and authorization preview
    uses the same lifecycle definition.
14. Failed/unknown Book attempts remain operational attempts unless supplier
    evidence proves a real booking exists.
15. Wallet settlement and decisive booking transitions are locally atomic.
16. Every supplier write owns a durable operation claim before leaving the
    database transaction.
17. Every unresolved operation has an idempotent reconciliation path and an
    escalation deadline.

---

## 18. Baseline project gaps this recommendation must address

The following were findings before lifecycle migration `0031` and its related
source changes. They remain the implementation acceptance checklist:

- `booking_lifecycle_v` does not exist.
- `booking_status_events` does not exist.
- Expired and Unconfirmed are calculated in TypeScript while database actions
  use raw stored status.
- PNR parsing does not retain `airlinePNRs[]`.
- Issuance reserves money but does not move the booking to In Progress before
  NewTicket.
- Cancellation can claim the same raw On Hold booking while NewTicket is in
  flight.
- Cancellation does not transactionally check deadline or airline PNR.
- Manual Pending retry bypasses the ordinary reservation/issue claim and can be
  invoked concurrently.
- Supplier-balance shortage is detected by broad message matching.
- That shortage currently captures funds and writes Pending.
- Empty/weak HTTP 200 supplier failures are treated as definitive supplier
  failures rather than ambiguity.
- Supplier refresh can overwrite Confirmed and Cancelled from status text
  without wallet settlement.
- Supplier refresh can mark Confirmed without requiring ticket numbers.
- Direct-ticket detection does not require non-empty ticket numbers.
- Dashboard recent activity collapses Expired, Unconfirmed, and In Progress to
  Pending.
- There is no automated booking/wallet reconciliation worker.

These gaps must be covered by characterization and concurrency tests before
production migration.

---

## 19. Safe implementation order if approved later

1. Approve the state definitions, operation reasons, evidence requirements,
   Pending policy, and supplier-balance contract.
2. Add characterization tests for current attempt locking, wallet idempotency,
   direct-ticket flow, derived status, response classification, and refresh.
3. Add concurrency tests that reproduce duplicate issue, issue-versus-cancel,
   terminal overwrite, and manual Pending retry risks.
4. Add the operation model and immutable status-event schema without changing
   public behavior.
5. Add the authoritative lifecycle SQL resolver/view and shared lifecycle
   predicates.
6. Implement a single atomic ticketing claim that validates lifecycle, wallet,
   deadline, PNR, and operation availability, then writes In Progress.
7. Implement a single atomic cancellation claim using the same operation lock.
8. Harden supplier response classification; treat weak/empty write failures as
   ambiguous and remove message-only automatic balance classification.
9. Add atomic reconciliation outcomes for ticket success, known failure,
   expiry, cancellation, and terminal conflict.
10. Fix PNR parsing/persistence for `airlinePNRs[]` and authoritative deadline.
11. Protect Confirmed/Cancelled refresh and require complete evidence.
12. Correct direct-ticket ticket evidence and payment-reconciliation linking.
13. Replace the existing Pending/manual-capture workflow with the approved In
    Progress/held-funds model.
14. Repoint lists, details, dashboard activity, filters, reports, exports,
    emails, and authorization previews to the authoritative lifecycle.
15. Add the reconciliation/expiry worker, monitoring, and operational runbook.
16. Audit and classify existing Pending, In Progress, missing-PNR, expired,
    captured, and reconciliation rows before data migration.
17. Update `BOOKING_ARCHITECTURE.md` and `WALLET_ARCHITECTURE.md` to describe
    implemented reality rather than planned components.
18. Run migration verification, static checks, race tests, rollback rehearsal,
    and controlled supplier-fixture validation before rollout.

---

## 20. Approval questions before implementation

The following decisions still require explicit approval or supplier evidence:

1. Will Triplover provide a stable code/field for supplier-wallet shortage?
2. Should a verified supplier-balance wait retain funds as an active hold or use
   a separately named reconciliation reservation state?
3. What operational SLA and escalation owner apply to stranded In Progress
   bookings?
4. What exact ticket fields are mandatory evidence across all Triplover/GDS
   variants?
5. What authoritative read proves a held booking remains cancellable after a
   Cancel refusal?
6. Which controlled roles may resolve terminal-state conflicts and what wallet
   approvals are required?
7. Does a real, distinct Pending workflow exist? Until approved, Pending remains
   reserved and unassigned.

Until these remaining decisions are answered, implementation uses the
conservative behavior defined above: preserve funds, classify uncertain writes
as reconciliation, leave Pending unassigned, and require controlled resolution
instead of guessing supplier truth.
