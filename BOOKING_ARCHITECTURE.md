# Booking architecture — migration plan

*Status: **agreed**, implementation in progress. Decisions finalised 2026-08-01.*

Splits the irreversible-call machinery (`booking_attempts`) from the business
record (`flight_bookings`), so that no `draft` or `submitting` row ever exists
in the booking table, while keeping the durability that makes an orphaned PNR
recoverable.

**Supplier scope:** Triplover only. A `supplier` column and an opaque
`supplier_refs` payload keep the door open, but no adapter abstraction is built
until a second supplier is actually contracted.

---

## 1. Where we are today

One table does both jobs. `flight_bookings` is written at fare selection with
`status = 'draft'`, flipped to `submitting` when the customer confirms, then
updated in place to `held` / `ticketed` / `failed` / `unknown`.

The full path, as built:

| Step | Route / component | Writes |
|---|---|---|
| Search | `/api/flights/search` | shared Redis quote graph (20 min absolute TTL) |
| Verify fare | `/api/flights/reprice` | atomic Redis selection capability update |
| Select fare | `/api/flights/booking/prepare` ← `ItineraryCard.tsx:693` | **inserts `flight_bookings`** `status='draft'`, returns `{ draft, accessToken }` |
| Enter travellers | `/api/flights/booking/draft` ← `BookingCheckout.tsx` | reads by `id` + `access_token_hash` |
| Confirm | `/api/flights/booking` | `claimBookingDraft` `draft→submitting`, calls Book, `updateBookingOutcome` |
| Show result | `BookingDetails.tsx` | — |
| List | `/dashboard/bookings` | reads `flight_bookings` |

Two properties of the current design are load-bearing and must survive:

- **The optimistic lock.** `claimBookingDraft` updates `WHERE status='draft' AND expires_at > now()`; `updateBookingOutcome` updates `WHERE status='submitting'`. That pair is what stops one booking being sent to the airline twice.
- **The reference chain.** Redis holds the expiring `uniqueTransID` / `itemCodeRef` / `segmentCodeRefs` and refreshed `priceCodeRef` only until Prepare. Prepare verifies the digest-bound public snapshot and writes those exact references into `booking_attempts`; Book then relies on that durable Supabase attempt only. Per supplier doc §4.5 these *cannot be re-derived*.

---

## 2. Target shape

### 2.1 `booking_attempts` — operational

Written **before** the Book call. Never shown as a booking. Prunable.

| Column | Notes |
|---|---|
| `id uuid pk` | internal only |

| `access_token_hash text unique not null` | the checkout capability; moves off `flight_bookings` |
| `user_id`, `audience`, `agency_code` | as today |
| `supplier text not null default 'triplover'` | |
| `state text not null` | `draft` \| `submitting` \| `succeeded` \| `failed` \| `unknown` |
| `search_id uuid`, `itinerary_id text` | provenance |
| `unique_trans_id`, `item_code_ref`, `price_code_ref` | recovery keys, not null |
| `booking_code_ref`, `pnr` | only after a successful Book |
| `offer_snapshot jsonb` | itinerary, fares, currency, pricing snapshot, passenger counts, travel date, `direct_ticketing`, `passport_required`, `repriced_at` |
| `passenger_snapshot jsonb` | travellers + contact as submitted |
| `error_code`, `supplier_message`, `warnings jsonb` | failure detail |
| `expires_at timestamptz` | quote expiry — bounds `draft` only |
| `submitted_at`, `resolved_at`, `created_at`, `updated_at` | |

`offer_snapshot` is a copy, not a reference: the Redis quote expires in
20 minutes and the attempt must stay self-sufficient after that.

### 2.2 `flight_bookings` — business

A row exists **only** because the supplier returned a booking.

Added: `public_ref` (copied from the attempt), `attempt_id` FK, `supplier`,
`ticketing_deadline_at timestamptz`, `deadline_source` (`supplier` \| `pnr_call`
\| `assumed`), `issued_at`, `cancelled_at`, `cancelled_by`, `cancel_reason`,
`synced_at`.

Changed: `status` CHECK becomes `on-hold` \| `pending` \| `in-progress` \|
`confirmed` \| `cancelled`, default `on-hold`.

Removed: `access_token_hash`, `expires_at` (both move to the attempt).

Kept: `supplier_refs`, `pricing_snapshot`, `itinerary`, `fares`, `passengers`,
`pnr`, `airlines_pnr`, `booking_ref_number`, `booking_status`, `ticket_numbers`,
`warnings`.

### 2.3 The seven business statuses

These seven are **the** business lifecycle. Every consumer — the application,
reporting, filtering, analytics, exports and admin tooling — resolves to
exactly one of them:

```
On Hold · Pending · In Progress · Confirmed · Expired · Unconfirmed · Cancelled
```

Five are *decided* and stored in `flight_bookings.status`: `on-hold`,
`pending`, `in-progress`, `confirmed`, `cancelled`.

Two are *computed*, because storing them would make them wrong:

- **Expired** — the ticketing deadline has passed. The supplier can *extend* a deadline (doc §4.9 says a later `/api/pnr` call is authoritative), so a stored `expired` would need un-setting. Computed, it self-corrects.
- **Unconfirmed** — the airline PNR was never created, or the supplier booking failed. A later sync can surface a PNR that was missing at booking time; computed, that resolves itself.

Computation happens in **one place** — the SQL view `booking_lifecycle_v`
(§8) — so there is no second definition anywhere in the codebase. Nothing
outside the writers reads `flight_bookings.status` directly.

**Point-in-time history** comes from `booking_status_events` (§7), not from the
status column. The reconciliation sweep (§6) records an `expired` event the
first time it observes a passed deadline, so "how many expired last month" is
answerable even though the column itself is computed.

### 2.4 Public booking reference

Sequential, human-readable, one series per day:

```
STR 260801 000001
 │     │      └── daily sequence, zero-padded to 6
 │     └───────── YYMMDD of allocation, Asia/Dhaka
 └─────────────── fixed prefix
```

- **Day boundary is Asia/Dhaka**, not UTC. A booking taken at 02:00 Dhaka must carry that day's date, not the previous UTC day's.
- **Allocated inside the transaction that inserts `flight_bookings`** — after the supplier has confirmed, never before. Every reference therefore belongs to a booking that exists. Attempts carry only their UUID; they are operational rows and never receive a public reference.
- **Allocation is atomic**: a `booking_ref_counters (ref_date, last_value)` row is incremented with `INSERT … ON CONFLICT DO UPDATE … RETURNING`, which serialises concurrent allocations for the same day under a row lock.
- **The transaction must not span the supplier call.** It opens only once Book has returned, so the counter row lock is held for microseconds rather than for the length of a 110-second HTTP call.
- Unique index on `flight_bookings.public_ref`. The series is dense: a supplier rejection, timeout or abandoned checkout consumes nothing, because none of them reach the insert.
- A booking that is cancelled later keeps its reference permanently. References
  identify successful booking creation and are never recycled.
- UUID stays the primary key and is never shown to a user.

**Why not allocate at the lock.** An earlier draft of this document allocated at
`draft → submitting`, so that an orphaned PNR would already have a
customer-quotable reference. That was the wrong trade. A *sequential* series is
read by people — accounts, reporting, invoices — and gaps in it invite
questions that a random series would never provoke; choosing sequential raised
the cost of burning numbers. Meanwhile the property that actually matters for
recovery is that **the attempt row exists and is durable**, which its UUID,
`uniqueTransID` and passenger snapshot already provide. A customer whose
outcome is unknown is told to contact support, and support finds the attempt by
account and timestamp — no public number needed. Recovery is a durability
concern; the reference is a presentation concern, and conflating them cost the
series its density for no safety gain.

---

## 3. Booking flow changes

```
prepare      → INSERT booking_attempts (draft) + token
checkout     → read attempt by id + token
confirm      → UPDATE attempt draft→submitting                    ← the lock
             → POST /api/Book
   success   → allocate public_ref
             + INSERT flight_bookings
             + UPDATE attempt succeeded                           ← one transaction
   failure   → UPDATE attempt failed | unknown, no booking row
details      → read flight_bookings by public_ref, session-scoped
```

The success branch does three things across two tables and a counter. Supabase's
JS client has no transaction, so this must be a Postgres function called via
`rpc()`. Doing it as separate statements risks an attempt marked `succeeded`
with no booking row — the exact orphan this redesign exists to prevent — or a
reference allocated against a booking that was never inserted.

Direct-ticket fares (`bookable: false`) insert straight to `confirmed` with
ticket numbers, and skip the hold entirely.

---

## 4. API changes

| Route | Change |
|---|---|
| `/api/flights/booking/prepare` | creates an attempt; response `bookingId` → `attemptId` |
| `/api/flights/booking/draft` | reads the attempt; rename to `/attempt` |
| `/api/flights/booking` (POST) | returns a **booking**, not a draft — response type changes |
| `/api/flights/booking/[publicRef]` | **new** — session-scoped read; fixes today's reload gap where passenger names vanish |
| `/api/flights/booking/sync` | **new** — calls `/api/pnr`, refreshes deadline + status |
| `/api/flights/booking/cancel` | **new**, wallet phase |
| `/api/flights/booking/issue` | **new**, wallet phase — NewTicket |

`PublicBookingDraft` splits into `PublicBookingAttempt` and `PublicBooking`.
That type is consumed by `BookingCheckout`, `BookingDetails`, `CheckoutSummary`
and `CheckoutItinerary` — all four need updating.

---

## 5. Recovery flow

An attempt in `submitting` past a threshold (suggest 5 minutes; the supplier
timeout is 110 s) is a suspected orphan.

1. **If `booking_code_ref` and `pnr` were captured** — call `/api/pnr` (doc §4.9) with the six-field reference set. Returns live `status` and the authoritative `lastTicketTime`. Reconcile: create the missing booking row, or mark the attempt failed.
2. **If the Book response was lost entirely** — we have no `bookingCodeRef` or `pnr`, so `/api/pnr` is unusable. The only key we hold is `uniqueTransID`, which fits `/AirTicketingDetails/{uniqueTransID}/{status}` (doc §4.8). **Unverified**: that endpoint is documented as a *ticketing* report (`Issued`/`Cancelled`/`Refunded`) — whether it returns a merely-held booking needs confirmation from Triplover. See §11.
3. **Otherwise** — surface to an agent for manual reconciliation against the supplier portal using `uniqueTransID` and the attempt's `public_ref`. Impossible today without an attempt row; this is the main thing the redesign buys.

Reconciliation should be a route an admin can trigger, plus a scheduled sweep.

---

## 6. Supplier synchronisation

The supplier is the source of truth for booking state, deadline, PNR and ticket
numbers. Two endpoints, two jobs:

- **`/api/pnr`** — live state of a *held* booking and the authoritative `lastTicketTime`. Format is `MM/dd/yyyy HH:mm:ss`, unlike the Booking field. Both normalise into `ticketing_deadline_at`.
- **`/AirTicketingDetails`** — issued / cancelled / refunded ticket information for reconciliation.

A sweep refreshes held bookings, updates `ticketing_deadline_at` and
`synced_at`, and writes a `booking_status_events` row the first time it sees a
deadline pass.

---

## 7. Admin workflow impact

`pending`, `in-progress`, `cancelled` become admin/user/supplier writes to
`status`, each needing who/when/why. `booking_status_events` (booking id, from,
to, actor, reason, created_at) is **required**, not optional: it is where
point-in-time reporting comes from, and refunds and disputes will need the
trail.

Admins also need a view of failed/unknown attempts. Those are the operationally
urgent rows: an `unknown` attempt may be a real airline booking nobody knows
about.

---

## 8. My Bookings impact

`booking_lifecycle_v` is a SQL view returning one row per real business booking
with a `lifecycle_status` column resolving to one of the seven:

- decided `confirmed` and `cancelled` outrank all computed conditions;
- an active or unresolved supplier operation resolves to `in-progress`;
- stored `pending` remains `pending`;
- stored `on-hold` resolves to `unconfirmed` when `airlines_pnr` is empty,
  `expired` when its authoritative deadline has passed, and otherwise
  `on-hold`.

Failed and unknown attempts remain operational records. They are not invented
as Unconfirmed business bookings and do not appear in this view.

Consequences for the existing UI:

- Ref No column shows `public_ref` — the UUID-prefix placeholder goes away.
- Sorting and pagination move into SQL. Today the table sorts and pages client-side over the whole set, which stops being viable past a few thousand rows.

### Staff-controlled B2B visibility

Migration `0117_booking_user_visibility.sql` adds a visibility-only state for
B2B agency bookings. Super Admin, Admin, and Support Staff may hide a booking
only when the canonical lifecycle is On Hold, Cancelled, or Expired and no
wallet reservation or ledger entry exists for either the booking or its
attempt. Denormalized payment fields are also required to be clean so the
check fails closed on inconsistent historical data.

The mutation locks the booking, attempt, and related reservation rows, then
re-runs the eligibility check in the same transaction. It records an immutable
`booking_user_visibility_events` entry and a `security_audit_events` entry.
Restoring visibility appends another event; it does not erase the hide event.

When a B2B booking is hidden, lifecycle events and notification outbox evidence
continue to be created. Visible recipient deliveries are terminally marked
`suppressed` with reason `booking_hidden_from_user`. Hide serializes against a
delivery entering its external send window; if a send is already in progress,
staff is asked to retry Hide after it finishes. Restore does not requeue old
suppressed occurrences, while later lifecycle occurrences expand recipients
normally again.

Only agency/user-facing readers filter `hidden_from_user`. Staff reads and all
supplier, expiry, email, wallet, lifecycle, evidence, and reconciliation
workers continue reading the intact booking. The visibility operation contains
no wallet call, supplier call, status update, or lifecycle-event mutation. Its
only notification write is the intended terminal suppression of pending
user-facing delivery rows/outboxes; it never deletes notification evidence.

---

## 9. Backward compatibility

- The legacy `/api/flights/booking/draft` path reads `booking_attempts` and stays
  for one rollout window. It is renamed to `/attempt` after deployed checkouts
  can no longer be holding the old URL.
- `sessionStorage` key `shopon-booking-${bookingId}` becomes the attempt id — old keys are orphaned, harmless.
- `PublicBookingDraft` is a breaking type change across four components.
- Rate-limit buckets (`flightBookingPrepare`, `flightBookingSubmit`) carry over unchanged.

---

## 10. Migration strategy for existing data

Current production content before Step 3: **5 bookings, all `held`**, all with
an airline PNR, plus **26 legacy draft rows**. Three bookings carry the actual
Triplover Booking deadline format `DD/MM/YYYY HH:mm:ss`.

Step 3 is deliberately additive and database-first compatible:

1. Create `booking_ref_counters`, the allocator and the Triplover deadline parser.
2. Add the lifecycle columns. `legacy_operational` defaults true so the
   pre-Step-3 application can continue writing its old row shape during the
   short migration-to-deploy window.
3. Copy legacy operational rows into `booking_attempts` and verify the copy.
   Keep the source rows in place; do not delete them.
4. For each real booking, insert a random synthetic attempt with
   `state='succeeded'`, then set `attempt_id`.
5. Allocate historical references in deterministic `created_at, id` order.
6. Map `held` → `on-hold` and `ticketed` → `confirmed`; parse supplier deadlines
   as Dhaka-local instants; tag these rows `legacy_operational=false`.
7. Install transitional constraints: archived legacy rows may retain old
   operational statuses and null public references, while every non-legacy row
   must carry a decided business status, `attempt_id` and `public_ref`.
8. Keep `access_token_hash`, `expires_at` and all archived legacy rows until a
   separate cleanup migration is approved after production verification.

Take a logical backup before applying Step 3. The later cleanup migration is
the only destructive phase.

---

## 11. Open questions

1. **Expired fallback.** When `ticketingTimeLimit` is empty, call `/api/pnr` for `lastTicketTime` (authoritative per doc §4.9). If that is also empty, what policy deadline? Proposal: `min(created_at + 24h, first_departure − 3h)`, flagged `deadline_source='assumed'`. Err early — showing a hold the airline already released is the costlier error.
2. **Does `/AirTicketingDetails` return held bookings?** Determines whether a lost Book response is recoverable automatically or only manually. Needs a question to Triplover.
3. **Attempt retention.** Proposal: prune `draft` after 7 days, `failed` after 90; keep `unknown` and `succeeded` indefinitely.
4. **`/api/pnr` refresh cadence** for long-lived holds — the supplier can shorten a deadline (doc §4.9).

---

## 12. Risks this introduces

| Risk | Severity | Mitigation |
|---|---|---|
| Non-atomic write on success — booking, attempt resolution and reference allocation must land together | **High** | Postgres function via `rpc()`, not separate client calls |
| Lost Book response leaves no `bookingCodeRef`, so `/api/pnr` is unusable | **High** | §5 step 2/3; confirm §11.2 before relying on automation |
| The optimistic lock is re-implemented on a new table and gets it subtly wrong | **High** | Port the exact conditional-update pattern; test double-submit explicitly |
| Reference allocation contends under concurrency | Medium | Single upsert-returning statement; row lock per day, not per table, and never held across the supplier call |
| Direct-ticket fares spend money at Book, before any wallet gate | Medium | Keep the current refusal until the wallet gate exists |
| Two id spaces in one list; an action fired against an attempt row | Medium | View tags `source`; UI disables actions on attempt rows |
| Booking uses `DD/MM/yyyy HH:mm:ss`; `lastTicketTime` uses `MM/dd/yyyy HH:mm:ss` | Low | Separate parsers; normalise both into `ticketing_deadline_at` |
| Attempts table growth | Low | Retention policy, §11.3 |

Compared with today, the redesign removes one failure mode entirely — a booking
table that mixes real bookings with abandoned fare selections — and adds one:
the success path now spans two tables and must be atomic.

---

## 13. Implementation sequence

Each step ships independently and leaves the application working.

The reference is allocated by the transactional success path, so it cannot be
built before that path exists. The order below follows from that.

| # | Step | State |
|---|---|---|
| 1 | `booking_attempts` table + writer, dual-written alongside the current flow; nothing reads it | **done**, verified 2026-08-01 |
| 2 | Move prepare/checkout onto attempts; stop inserting `draft` rows into `flight_bookings` | **done** |
| 3 | Transactional success path (`rpc`): allocate reference + insert booking + resolve attempt. Adds counters, `public_ref`, the lifecycle constraint and a non-destructive legacy backfill | **database applied and verified 2026-08-01; authenticated E2E pending** |
| 4 | `booking_lifecycle_v`; repoint booking, dashboard and status consumers at it | **database applied and live-verified through migration 0033 on 2026-08-06** |
| 5 | `/api/pnr` airline-PNR/deadline sync + lifecycle observations + `booking_status_events` | **database applied and live-verified; scheduler wiring pending** |
| 6 | Wallet, issue, cancel with one durable supplier-operation claim | **database applied and live-verified; application implementation included in this revision** |

Until step 3 the Ref No column shows a dash. That is deliberate: the old UUID
prefix is gone, and no reference is invented before there is a booking to
attach it to.
