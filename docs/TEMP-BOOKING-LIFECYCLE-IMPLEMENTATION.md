# Temporary Booking Lifecycle Implementation Working Memory

> Temporary implementation control document. Keep this file until the complete
> lifecycle implementation, production verification, historical remediation,
> and documentation handoff are finished. Delete it only after explicit user
> approval at the end of the project.

## Status legend

- ⬜ Not started
- 🟨 In progress
- 🟩 Completed and verified
- 🟥 Blocked / needs decision

## Mandatory execution protocol

1. Read this entire file before starting or resuming lifecycle work.
2. Before beginning any checklist item, change only that item to 🟨.
3. Keep at most one implementation item 🟨 at a time unless the plan explicitly
   records safe parallel work.
4. After implementation and proportionate verification, change the item to 🟩
   and record the verification evidence in this file.
5. If blocked or a business decision is required, change the item to 🟥 and add
   it to the Decision Register.
6. Add newly discovered issues, risks, invariants, and decisions to this file
   immediately; do not rely on conversation memory alone.
7. Re-read the requirements, invariants, open decisions, and next phase gate
   before moving to the next checklist item.
8. Do not modify production data through ad hoc SQL. All lifecycle or financial
   repairs must use approved, audited, idempotent workflows.
9. Do not commit, push, merge, deploy, apply migrations, send test emails, or
   mutate production data unless that action belongs to the approved current
   phase and the user has authorized it.
10. Preserve unrelated user changes and stop if an overlapping dirty-worktree
    change cannot be handled safely.

## Current execution state

- 🟩 P0.0 — Created and organized this working-memory document.
- 🟩 P0.1 — User approved implementation to begin on 2026-08-11.
- 🟩 Current implementation step — Phase 0 approval, baseline, safety,
  rollback, and policy decisions completed.
- 🟩 Phase 1 additive internal model, provenance correction, and all
  verification gates completed.
- 🟩 Phase 3 operation identity, watchdog, attempt reconciliation, uncertainty,
  and verification gates completed.
- 🟩 Last completed rollout item — P12.5 read-only Preview observability stage.
- 🟩 Last completed rollout item — P12.6 incremental operation/watchdog
  activation. The configured production scheduler returned `200` at 02:45
  Asia/Dhaka with no error log or protected-state drift. P9.4 live In Progress
  reconciliation remains downstream and still requires fresh evidence plus
  independent authorized maker-checker actors.
- 🟩 Last completed action rollout — P12.7 reconciliation/imported-manual
  actions and imported SLA worker. Protected entry points rejected anonymous
  writes; the 03:00 scheduler returned `200` with no runtime error or invariant
  drift.
- 🟩 Last completed notification rollout — P12.8 outbox/coalescing on
  `dpl_8yvQ45YMzH5yiexdxcCJ91h1GMPQ`. The 03:15 scheduler returned `200`; the
  zero backlog remained zero with no runtime error or protected-state drift.
- 🟩 Last completed automation rollout — P12.9 scalable derived-lifecycle sweep
  on `dpl_2eTXQxzp4msNuX7fB5H6XoJXiJzr`. The 03:30 durable run succeeded and
  drained; expiry/starvation/Unconfirmed backlogs and failed/bounded/stale run
  counts are all zero, with no protected-state drift.
- 🟨 Current design checkpoint — The production-grade Direct Ticket evidence,
  atomic-finalization, attempt-recovery, migration, rollout, and test design is
  recorded below for D11 review. No implementation or external mutation has
  begun; P3.12/P4.11/P5.16/P5.17 remain red until the design is approved.
- 🟥 Human-controlled remediation gate — P12.10/P9.4–P9.8/P9.12. The original
  11 cases remain open and a new production Direct Ticket attempt-uncertainty
  case brings the current total to 12. The new case is safely contained but has
  no executable attempt-to-booking recovery path. Two distinct authorized staff
  identities, complete case-bound evidence, and the
  P3.12/P4.11/P5.16/P5.17 implementation are required before its booking truth
  or protected funds may change.
- 🟥 Compatibility/retirement gate — Phase 10 must wait until remediation and
  at least two stable production releases complete; no destructive constraint
  validation, wrapper removal, or legacy-field retirement has begun.
- 🟥 Final deletion gate — P12.13 requires explicit user approval at handoff;
  the temporary control document remains tracked and intact.
- New-chat resume note — Linked migrations `0043`–`0082` and production source
  commit `95c12aa1d53d29073cd871d7ffff4de9b1159541` are live and verified. Final
  deployment `dpl_2eTXQxzp4msNuX7fB5H6XoJXiJzr` is Ready at the canonical
  production alias with all six rollout controls enabled after independent
  deployment/audit gates. The final 72-verifier, typecheck, lint, schema, log,
  protected-snapshot, scheduler, and aggregate-metrics gates pass. The new
  Direct Ticket incident `06fac0c2`/`fe6f9703-baf6-408c-b80a-b096f29c64e7`
  is an additional post-rollout case: detection/containment worked, but P4.11,
  P5.16, and P9.12 are now red. P9.4–P9.8 and P12.10 still require fresh
  evidence and two different authorized staff identities for maker-checker
  resolutions.
- Current permitted scope: keep the verified release and immutable case history
  intact. This checkpoint is design/documentation only. For the new attempt-only
  Direct Ticket case, preserve the wallet hold and do not retry `Book`/
  `NewTicket`, manufacture an STR, use the booking-subject resolver, apply a
  migration, deploy, or mutate production. Do not use an agent, ad hoc SQL, or
  stale snapshot facts to select or approve business/financial outcomes. Do not
  begin legacy retirement until remediation and the two-stable-release
  compatibility window are complete.
- Current implementation branch: `development`, published to
  `origin/development`; production source is `95c12aa` and rollout evidence is
  published through `77ba532`. `main` remains at the pre-lifecycle production
  baseline pending final human remediation/handoff approval.
- Plan creation itself performed no code, migration, database, email,
  Git-history, or deployment action; all later actions are recorded below.

## Approved target architecture

The existing seven public statuses remain stable:

1. `on-hold`
2. `pending`
3. `in-progress`
4. `confirmed`
5. `expired`
6. `unconfirmed`
7. `cancelled`

The final architecture separates five concerns:

1. **Public lifecycle** — one of the seven customer-visible statuses.
2. **Operation state** — ticketing, cancellation, or imported manual ticketing.
3. **Reconciliation state** — evidence, ownership, SLA, decisions, and outcome.
4. **Financial state** — reservation, capture, release, refund, external
   settlement, and immutable wallet ledger.
5. **Notification state** — occurrence-based outbox and per-recipient delivery.

No additional customer-facing status should be introduced unless a later
explicit business decision changes this approved rule.

## Final public status meanings

| Status | Required final meaning |
| --- | --- |
| On Hold | A real unticketed supplier booking exists, an airline PNR is present, the deadline is valid, and no supplier operation or unresolved outcome is active. |
| Pending | A rare controlled state waiting for a known prerequisite before any irreversible supplier action. It is not a normal Triplover step and must have an internal reason. |
| In Progress | Ticketing, cancellation, imported manual ticketing, or genuine supplier-outcome uncertainty is active. The internal subtype must be available to staff. |
| Confirmed | Ticket issuance is authoritatively proven and required ticket evidence is stored. A financial conflict may exist, but it must be explicitly visible internally. |
| Expired | A derived On Hold booking with an airline PNR has passed its authoritative ticketing deadline. It is not automatically Cancelled. |
| Unconfirmed | A supplier booking exists, but airline PNR/confirmation is missing. It is not an unknown booking attempt. |
| Cancelled | Supplier cancellation/voiding is authoritatively proven. Any outstanding refund or payment matter must be explicitly represented internally. |

## Non-negotiable lifecycle and financial invariants

- 🟩 I1 — `confirmed` and `cancelled` remain protected from ordinary supplier
  Sync; only an explicit reconciliation workflow may correct terminal truth.
- 🟩 I2 — `expired` and `unconfirmed` remain derived public states and are never
  stored directly in `flight_bookings.status`.
- 🟩 I3 — A destructive supplier write (`Book`, `NewTicket`, `Cancel`) is never
  blindly replayed after an ambiguous outcome.
- 🟩 I4 — One active operation is allowed per booking.
- 🟩 I5 — Every operation and resolution has a stable server-side idempotency
  identity, expected prior state, and payload consistency check.
- 🟩 I6 — No wallet charge can occur twice for the same authorized obligation.
- 🟩 I7 — No capture occurs without complete ticket evidence or explicit
  imported-payment authorization.
- 🟩 I8 — No held funds are released after an ambiguous supplier write without
  authoritative non-issuance evidence or approved staff resolution.
- 🟩 I9 — Every wallet mutation creates exactly one immutable, idempotent ledger
  entry in the same transaction.
- 🟩 I10 — Booking, operation, reconciliation case, reservation, wallet, ledger,
  lifecycle event, and notification outbox updates are atomic where one
  business resolution affects them together.
- 🟩 I11 — `Confirmed + Unpaid` and `Cancelled + Captured` can exist only with an
  explicit financial disposition or open reconciliation case visible to staff.
- 🟩 I12 — Customer status reflects authoritative booking/ticket truth; internal
  financial disagreement must never silently change or conceal that truth.
- 🟩 I13 — High-risk terminal corrections, debits, refunds, fees, and historical
  repairs require explicit authorization and immutable evidence.
- 🟩 I14 — Lifecycle events remain immutable and preserve every occurrence, even
  when a customer notification is suppressed or coalesced.
- 🟩 I15 — Customer notifications are idempotent per event occurrence and per
  recipient, not merely per booking/status pair.
- 🟥 I16 — When a Direct Ticket is authoritatively issued before a business
  booking exists, one attempt-bound, maker-checker resolution must atomically
  create exactly one STR booking and capture exactly the existing reservation
  once, without another supplier write or available-balance debit.

## Known production findings to preserve as remediation inputs

These are observations, not authorization to mutate the records:

- 🟩 F1 — Three current In Progress bookings are reconciliation cases rather
  than ordinary active supplier operations.
- 🟩 F2 — `STR260805000006` is Cancelled with captured funds, zero refund, and
  no cancellation timestamp/reason.
- 🟩 F3 — Four Cancelled records currently lack `cancelled_at`.
- 🟩 F4 — Two imported Confirmed records are currently marked Unpaid.
- 🟩 F5 — One `booking_attempts.state = 'submitting'` record has remained
  unresolved for approximately nine days and has no business booking.
- 🟩 F6 — Pending has historical evidence but is not created by the current
  normal Triplover workflow.
- 🟩 F7 — Unconfirmed is supported by code but has no recent live delivery
  evidence.
- 🟩 F8 — The current email queue was caught up with no recorded delivery errors
  at design-review time; this must not be assumed later without rechecking.
- 🟩 F9 — Resolved as a verifier defect, not a data defect. The flagged booking
  is carrier `BS`, whose PNR deadline uses `MM/DD/YYYY`; its stored instant is
  correct, while `verify:booking-step3` incorrectly assumes `DD/MM/YYYY` for
  every carrier. Do not create a remediation case for this record.
- 🟥 F10 — Production Direct Ticket attempt `06fac0c2` received HTTP 200 from
  `Book` and is now reported Issued by AirTicketingDetails, but the Book adapter
  rejected the response because `bookingCodeRef` was absent. No business
  booking/STR was created; the BDT 40,600.98 reservation remains protected in
  reconciliation. Detection worked, but the deployed reconciliation actions
  cannot resolve an attempt-only subject.

### Production incident — issued Direct Ticket without local STR

Read-only investigation completed on 2026-08-12. No `Book`, `NewTicket`, wallet,
booking, case, proposal, decision, or production-data mutation was performed.
Two `AirTicketingDetails/Confirmed` GETs were used only to confirm repeatable
supplier read evidence; neither response was stored in production.

| Evidence area | Production finding |
| --- | --- |
| Identity | Attempt `06fac0c2-8b86-4ea6-9710-7d378a63c8ae`; case `fe6f9703-baf6-408c-b80a-b096f29c64e7`; reservation `6d8191d3-3c69-43dd-9034-5c07fde7a3df`. The supplied UniqueTransID matches the attempt and SHA-256 `11a1bdd322c541fdaf73c1a80af4377fb830a718436f1eda532f2d6ea6c22e94`; the raw supplier identity is not repeated here. |
| Attempt snapshot | Agency Triplover attempt, `directTicketing = true`, one ADT, carrier `6E`, route `DAC-MAA|MAA-SIN`, travel date 2026-08-19, and User Payable/supplier total BDT 40,600.98. Durable request identity and payload hash are present. |
| Request/response boundary | Wallet hold committed at `2026-08-12T04:00:19.725345Z`; supplier call began at `04:00:20.025489Z`; a complete HTTP 200 response was recorded at `04:00:34.584547Z`. The live route log on deployment `dpl_2eTXQxzp4msNuX7fB5H6XoJXiJzr` ended POST `/api/flights/booking` with 503 and `Triplover Book returned no bookingCodeRef.` The raw Book body was not retained, so later recovery cannot reconstruct its full normalized outcome from local history. |
| Local state | Attempt is `unknown` with `INCOMPLETE_RESPONSE`; PNR and `booking_code_ref` are null; no `flight_bookings` row exists for the attempt; therefore no STR exists. The case is open, version 2, attempt-subject only, with one immutable `supplier_write_uncertainty` observation and no proposal, approval, or resolution. |
| Wallet/ledger | One cycle-1 reservation for 4,060,098 minor units is `reconciliation`, attempt-bound, uncaptured, and unreleased. Exactly one `booking_hold` ledger entry moved available balance down by and hold balance up by 4,060,098; no `booking_confirm`, release, refund, or second debit exists. Current hold balance equals this reservation exactly. |
| Supplier read evidence | Both safe report reads returned HTTP 200 with matching UniqueTransID, status `Issued`, `isCompleted = true`, `isPaid = true`, a PNR, one airline PNR, one passenger, two matching route segments, an issue timestamp, and no cancellation timestamp. The passenger identity matches the attempt when the supplier's actual `first`/`last` fields are normalized. |
| Evidence limitation | The current report has no `bookingCodeRef` or `ticketCodeRef`; its sole `ticketNumbers` value equals the six-character PNR. For this `6E`/LCC response, that may be a supplier-specific identifier convention, but it does not satisfy the current complete-ticket contract and must not be re-labelled or invented. The current adapter also misses the real `first`/`last` passenger fields and root `segments`, so it would produce empty passenger hashes and no route signature. |

Exact failure chain:

1. `wallet_begin_direct_ticket` correctly reserved BDT 40,600.98 once.
2. Triplover `Book` completed and returned HTTP 200.
3. `bookFlight` extracted a response object but unconditionally required
   `bookingCodeRef`; the missing field raised a protocol error before a
   `SupplierBookingOutcome` could be returned.
4. `create_booking_from_attempt_v2` was never called. This is a pre-finalizer
   response-contract failure, not a failed STR allocation/database transaction.
5. `captureBookingReservation` was never called because it is downstream of
   business-booking creation.
6. The uncertainty handler then correctly marked the attempt `unknown`, moved
   the reservation to `reconciliation`, appended immutable uncertainty evidence,
   opened the case, prohibited automatic supplier replay, and returned 503.

Root cause: the integration treats `bookingCodeRef`/`ticketCodeRef` as universal
success fields, while this real Direct Ticket report exposes a different set of
issued-ticket identifiers. The safety boundary correctly contained the
ambiguity, but local response history is insufficient for reconstruction and
the evidence normalizer does not match the observed report schema.

Current reconciliation support is partial:

- Detection, ownership, queue visibility, destructive-replay prevention, and
  wallet protection work correctly for an attempt-only case.
- Evidence, proposal, decision, and ticketed-resolution routes require an
  existing `STR` followed by 12 digits and load a `flight_bookings` row.
- The ticketed database resolver requires a booking-subject case and rejects a
  reservation whose `booking_id` is null, even when its `booking_attempt_id`
  matches. Therefore the deployed workflow cannot create the missing business
  booking or capture this existing hold.

Safest intended recovery, after implementation and separate human approval:

1. Keep the case open and the existing hold in reconciliation. Do not retry a
   destructive supplier write and do not release/capture funds yet.
2. Add an attempt-subject evidence action. Normalize the observed supplier
   `first`/`last` and root `segments` shape, retain alternative issued-ticket
   identities such as supplier booking/report transaction references, and
   reject a PNR masquerading as a distinct e-ticket number. Establish explicit
   Triplover/airline policy for complete `6E` Direct Ticket evidence; until then,
   obtain matching portal/API evidence rather than inventing missing fields.
3. Add one high-risk, case-bound, maker-checker RPC for an issued Direct Ticket
   without a booking. In a single transaction it must lock attempt → case →
   reservation → wallet/account; recheck the immutable request/offer/passenger/
   route/price identity and fresh complete supplier evidence; prove no booking
   or capture already exists; allocate exactly one STR; create Confirmed booking
   truth from the attempt/evidence; rebind and capture the existing reservation;
   add exactly one `booking_confirm` ledger row and Confirmed lifecycle/outbox
   occurrence; complete the attempt/case; and return the committed result.
4. Stable case/proposal/execution keys plus unique `flight_bookings.attempt_id`,
   reservation, and ledger constraints must make every exact retry return the
   same STR/result. Capture removes 4,060,098 only from `hold_balance`; it must
   leave `available_balance` unchanged because the available debit already
   occurred at reservation time.
5. If complete ticket identity cannot be established, leave the case open and
   funds protected for explicit supplier/financial disposition. Manual row
   insertion, guessed identifiers, generic status changes, and ad hoc wallet
   SQL are forbidden.

### Proposed production-grade Direct Ticket design (design only)

Status: proposed for D11 review on 2026-08-12. Nothing in this section authorizes
code, migration, supplier-write, wallet, booking, case-decision, deployment, or
production-data changes.

#### 1. Repair the Triplover response and evidence contract

The adapter must stop using one supplier field as the definition of success.
Transport receipt, response normalization, evidence sufficiency, and local
finalization are separate stages:

1. The Triplover client records the completed HTTP receipt before the business
   mapper runs: operation/request identity, request-payload hash, status code,
   request/response times, raw-payload hash, and a redacted canonical response
   envelope. General logs and application tables must not retain raw passenger
   PII or credentials.
2. A pure, versioned `normalizeTriploverBookResponseV2` maps all observed Book
   shapes into optional facts with source-field provenance. Missing
   `bookingCodeRef` or `ticketCodeRef` is a fact, not a parser exception.
3. A separate validator classifies the normalized response as
   `ticketed_complete`, `supplier_positive_incomplete`, `held_complete`,
   `definitive_failure`, or `uncertain_or_conflicting`. Only the validator may
   authorize a local outcome; the parser may not silently upgrade evidence.
4. `AirTicketingDetails` normalization becomes version 2 and reads the real
   Triplover `first`/`last` passenger fields and root `segments`. It also retains
   supplier booking ID, transaction number, reference log, booking/ticket type,
   completion/payment flags, issue/cancellation times, and amount/currency when
   supplied.
5. A value equal to the normalized PNR, airline PNR, or booking reference is not
   accepted as an independent e-ticket number. The current case's six-character
   `ticketNumbers` value therefore remains a PNR, not a fabricated ticket.

Evidence sufficiency is profile-based and versioned rather than globally
weakened:

- `triplover_standard_eticket_v1` requires matching transaction, PNR,
  passenger/route identity, issued status, booking/ticket references, and valid
  distinct passenger ticket numbers.
- `triplover_ticketless_carrier_v1` is allowed only for an explicit
  supplier/carrier/booking-type allowlist approved under D11. It requires a
  matching UniqueTransID, supplier booking/report identifiers, PNR/airline PNR,
  `Issued`, `isCompleted`, `isPaid`, passenger and route identity, issue-time
  correlation, and no cancellation conflict. It stores a
  `ticketless_confirmation`; it never relabels a PNR as an e-ticket number.
- The observed `6E` response is a candidate for the ticketless profile, not
  proof that the profile is approved. Triplover/airline contract or portal
  confirmation is required before that profile can authorize this recovery.

Normalized evidence is append-only. A new attempt evidence ledger stores the
source (`Book` or safe report), observation key, operation/request hashes,
receipt metadata, normalizer/profile versions, canonical facts and fact hash,
classification, and source-field provenance. Exact occurrence keys replay the
same row; later reads append history. Existing version-1 case evidence remains
immutable and is not reinterpreted as version 2.

#### 2. Make future Instant Purchase outcomes explicit

After the one authorized `Book` call, the route persists and normalizes its
response before choosing one of these fail-closed outcomes:

| Supplier/local evidence | Local result | Wallet result | Further supplier write |
| --- | --- | --- | --- |
| Complete ticket evidence under an approved profile | Atomic Confirmed STR finalization | Capture the existing hold once | None |
| Positive supplier booking/ticket evidence but incomplete final identity | Create one In Progress STR plus ticketing case | Keep the same hold in reconciliation | No `Book`/`NewTicket`; safe reads only |
| No positive identity or ambiguous/no response | Keep attempt-only uncertainty case | Keep the same hold in reconciliation | No automatic replay; safe reads only |
| Definitive rejection proving no supplier booking | Existing failed-attempt path | Atomically release the hold once | None |

When Book is supplier-positive but not yet complete, the route may make one
bounded `AirTicketingDetails` safe read using the same UniqueTransID and persist
that independent receipt. Complete combined evidence may then use the normal
atomic finalizer. An empty, delayed, or incomplete report never erases the
positive Book evidence and never permits another write; the route instead uses
the protected In Progress materialization below.

The positive-incomplete materialization path is important: an HTTP-200 response
that proves a supplier booking exists must no longer disappear merely because a
legacy field is absent. One database transaction creates an `In Progress` STR,
rebinds the reservation without capturing it, creates the ticketing operation
and booking-subject case, and emits the correct customer lifecycle occurrence.
It is not used for timeouts, response loss, or a response with no trustworthy
supplier identity; those remain attempt-only cases.

#### 3. Replace Direct Ticket create-then-capture with one atomic finalizer

The normal Direct Ticket route must stop calling a booking creator followed by a
separate wallet capture. A new service-only
`finalize_direct_ticket_attempt_v1` database function performs both or neither:

1. Lock attempt, reservation, wallet owner, and wallet account in the canonical
   order and acquire an attempt/request-scoped advisory lock.
2. Recheck `directTicketing`, the immutable request/payload identity, approved
   complete evidence profile, reservation amount/currency, one original hold,
   and the absence of a booking, capture, release, or refund.
3. Allocate one STR, insert one Confirmed booking from the attempt snapshots and
   evidence, and store legacy supplier references only when genuinely supplied.
   Ticketless bookings retain an empty ticket-number set and an explicit
   evidence kind/profile plus alternative confirmation references.
4. Rebind and capture the existing reservation, subtract the exact amount from
   `hold_balance`, leave `available_balance` unchanged, and insert one
   `booking_confirm` ledger row.
5. Complete the attempt and insert the Confirmed lifecycle event and notification
   outbox occurrence in the same transaction.

`flight_bookings.attempt_id` remains unique. Stable finalization/evidence keys,
reservation state, ledger idempotency keys, and event occurrence keys make an
exact retry return the same committed STR. A changed payload or evidence hash
fails. If the application loses the database response, it reads the booking by
attempt and returns that result; it never repeats `Book`.

Normal immediate finalization uses the customer's original Instant Purchase
authorization. Any attempt that has entered reconciliation requires the
case-bound maker-checker recovery below. The existing held/non-Direct booking
creator remains separate; only the Direct Ticket branch changes to this atomic
contract.

#### 4. Add an attempt-subject maker-checker recovery contract

This is a distinct contract, not a relaxation of the booking-subject resolver:

- A case-ID route acquires safe `AirTicketingDetails` evidence against the
  attempt snapshot and reservation. Support/Admin may investigate; no evidence
  read changes booking state or money.
- A database-derived proposal uses the exact outcome
  `ticketed_create_booking` and disposition `capture_existing_hold`. The client
  cannot choose the amount, currency, passenger identity, ticket facts, or STR.
- The proposal fingerprint binds case/version, attempt/request hashes,
  reservation ID/state/amount/currency, evidence row IDs/hashes/profile,
  confirmation codes, absence of a booking, and the proposed result.
- Proposing this combined booking-and-money action requires the dedicated
  high-risk Admin capability. Approval requires a different Admin/Super Admin
  identity. Self-approval, stale evidence, changed case state, or an incomplete/
  unapproved evidence profile fails closed.
- Execution is a separate action after approval and requires evidence fresh
  within the five-minute policy at execution time. Expired evidence is reacquired
  using a safe read; no destructive supplier call is allowed.

The exact resolver, `resolve_direct_ticket_attempt_ticketed_v1`, locks attempt →
case → reservation → wallet owner → wallet account and rechecks all proposal
facts. In one transaction it creates the Confirmed STR, captures the existing
hold, completes the attempt, writes ledger/event/outbox/audit rows, and resolves
the original attempt-subject case with its booking ID/STR result. The case is not
rewritten into a booking-subject case, preserving incident provenance.

Execution uses a stable case/proposal/execution key. If the exact execution has
already committed, it returns the recorded result. Concurrent execution, a
lost response, or a repeated staff click cannot create another booking or
ledger entry. A different key or changed fingerprint cannot reuse the approval.

#### 5. Data model and migration plan

Use additive, forward-fix migrations; sequence names below are the proposed next
files and may be adjusted only if the linked migration head changes before work:

1. `0083_direct_ticket_evidence_contract_v2.sql` — append-only attempt supplier
   evidence table, immutable triggers/indexes, service-only grants, optional
   case-observation link, and nullable booking evidence-kind/profile/version/
   confirmation-reference columns. Add a `NOT VALID` new-write invariant for
   confirmed Direct Ticket evidence; do not rewrite historical rows.
2. `0084_direct_ticket_atomic_finalization.sql` — normal atomic create/capture
   function and positive-incomplete In Progress materializer, with exact locks,
   authorization, equations, idempotency, event, and outbox behavior.
3. `0085_attempt_ticket_evidence_actions.sql` — attempt-subject evidence-read
   recorder and queue facts. This is a new exact function; do not weaken the
   current booking-only evidence function.
4. `0086_attempt_ticket_maker_checker.sql` — exact proposal, approval, rejection,
   audit, capability, confirmation-code, freshness, and fingerprint functions.
5. `0087_attempt_ticket_atomic_resolution.sql` — approved attempt resolver and
   replay result contract.

All new functions revoke `PUBLIC`, `anon`, and ordinary authenticated execution;
the function body rechecks actor/capability. Existing booking and wallet columns
stay compatible during rolling deployment. The booking schema must not require
fake `bookingCodeRef`, `ticketCodeRef`, or ticket numbers; downstream code uses
the evidence kind and a capability resolver. If an endpoint such as PNR refresh
or Cancel requires a missing supplier reference and Triplover offers no safe
alternative, the UI exposes an owned manual/supplier-portal case instead of
constructing an invalid API request.

#### 6. Application change set

- Update `lib/triplover/book.ts` to normalize first and validate by evidence
  profile; update the Triplover response hook to persist the redacted response
  receipt before mapping/finalization.
- Update `lib/triplover/air-ticketing-details.ts` and the supplier evidence
  normalizer/validator/read modules with version-2 facts and attempt identity.
- Add direct-ticket evidence-profile and capability modules; keep profile policy
  explicit, versioned, deny-by-default, and server-side.
- Switch `app/api/flights/booking/route.ts` Direct Ticket success to the atomic
  finalizer/materializer. Exact replays read the booking by attempt; no
  non-draft branch may invoke the supplier again.
- Add attempt-case evidence/proposal/decision/execution APIs and staff UI using
  the current case/version concurrency controls and audit presentation.
- Update booking DTOs, ticket/confirmation presentation, PNR refresh, Sync, and
  Cancel to distinguish standard e-ticket from ticketless confirmation and to
  avoid fabricating unsupported supplier parameters.

#### 7. Required verification and rollout

Before any production recovery, tests must cover:

- A redacted fixture matching this real response shape: `first`/`last`, root
  `segments`, missing legacy refs, and PNR duplicated in `ticketNumbers`.
- Standard-ticket, approved-ticketless, unapproved-ticketless, incomplete,
  rejected, contradictory, and wrong-identity profile matrices.
- Normal success producing one STR and one hold capture atomically; database
  response loss and concurrent calls returning the same STR without a supplier
  replay or second available-balance debit.
- Positive-incomplete evidence producing one In Progress STR/case with no
  capture, while network ambiguity remains attempt-only with the hold protected.
- Maker/checker capability, self-approval, stale evidence, case-version,
  evidence-hash, amount/currency, and changed-reservation rejection tests.
- Two concurrent recovery executions, exact replay, mismatched replay, and
  injected failure at every transaction stage, proving zero partial booking,
  ledger, event, outbox, attempt, or case outcomes.
- Wallet equations and exact counts for hold/capture/release/refund entries;
  ticketless display, Sync/PNR/Cancel capability behavior; migration replay on
  production-equivalent fixtures; old-app rolling compatibility; and protected
  12-case snapshot invariance before activation.

Roll out with separate server-side switches for response/evidence persistence,
attempt evidence reads, normal Direct Ticket atomic finalization, and recovery
actions. Apply additive schema with all behaviors off, run linked-migration and
production-equivalent gates, enable read-only evidence first, then normal-path
prevention, and enable maker-checker recovery last. Any pre-execution anomaly
turns the relevant switch off; schema remains additive. A committed financial
resolution is never rolled back by editing balances—any later correction uses a
new explicit compensating case.

#### 8. Recovery runbook for attempt `06fac0c2`

After the mechanism is reviewed, implemented, verified, migrated, and deployed:

1. Keep the current case and BDT 40,600.98 reconciliation hold unchanged while
   the new behavior switches are off.
2. Enable only the attempt evidence read and acquire a new case-bound
   `AirTicketingDetails/Confirmed` observation. The two investigation reads are
   not reused because they were not stored and will be stale.
3. Validate the new observation against the immutable attempt, reservation,
   passenger, route, carrier, date, request hash, amount/currency, and issue-time
   window. Confirm the `6E` ticketless evidence policy with Triplover/airline
   contract or portal evidence. If it remains incomplete, stop: the case stays
   open and the hold stays protected.
4. One authorized Admin proposes `ticketed_create_booking` plus
   `capture_existing_hold`; a different Admin/Super Admin reviews the exact
   evidence and approves it. Neither actor supplies a wallet amount or STR.
5. Execute the approved resolver once. It must not call `Book` or `NewTicket`.
6. Verify exactly one booking/STR for the attempt, Confirmed/Captured truth, the
   reservation captured once, one `booking_confirm` ledger row, case resolution,
   one lifecycle/outbox occurrence, and an unchanged available balance. The
   4,060,098-minor-unit hold balance decreases once; the supplier ticket remains
   untouched.
7. Dispatch customer notification only from the committed outbox, then rerun the
   protected booking/attempt/wallet/ledger/case/event invariant snapshot and
   retain the maker/checker audit evidence.

### Read-only production aggregate baseline

Captured at `2026-08-11T10:38:22.881Z`; no passenger data or secrets were read
into this document and no record was mutated.

| Area | Aggregate baseline |
| --- | --- |
| Business bookings | 72 total: On Hold 4, Pending 0, In Progress 3, Confirmed 22, Expired 21, Unconfirmed 0, Cancelled 22. |
| Stored booking status | On Hold 25, Pending 0, In Progress 3, Confirmed 22, Cancelled 22. |
| Active operation metadata | 69 idle; 3 reconciliation (2 cancellation reconciliation, 1 legacy reconciliation). |
| Booking payment state | 50 unpaid, 21 captured, 1 released. |
| Booking attempts | 112 total: 39 draft, 1 submitting, 72 succeeded, 0 failed, 0 unknown; the submitting attempt is older than 15 minutes. |
| Wallet reservations/ledger | 22 reservations (21 captured, 1 released, 0 reconciliation); 65 immutable ledger entries. |
| Lifecycle events | 130 total: 34 On Hold, 1 Pending, 26 In Progress, 23 Confirmed, 24 Expired, 0 Unconfirmed, 22 Cancelled occurrences. |
| Status-email delivery | 127 rows: 74 baseline, 53 sent, 0 incomplete, 0 with error, 0 stale claims, and 0 pending jobs. |
| Visible anomalies | 3 In Progress reconciliation bookings; 4 Cancelled without `cancelled_at`; 1 Cancelled with captured funds outstanding; 2 Confirmed/Unpaid, both imported; 0 terminal bookings with hidden reconciliation metadata at snapshot time. |

---

# Implementation phases

## Phase 0 — Approval, baseline, and safety controls

Goal: approve scope and establish evidence before behavior changes.

- 🟩 P0.1 — User reviews and approves this implementation plan.
- 🟩 P0.2 — Confirm the exact implementation branch and branch/merge strategy.
- 🟩 P0.3 — Re-read repository instructions and inspect the working tree for
  unrelated changes.
- 🟩 P0.4 — Capture current migration list, schema lint result, build/type/lint
  baseline, and lifecycle verification results.
- 🟩 P0.5 — Capture read-only production counts for lifecycle states, operations,
  attempts, wallet states, lifecycle events, email deliveries, and anomalies.
- 🟩 P0.6 — Record a rollback strategy for each migration and application phase.
- 🟩 P0.7 — Resolve every blocking item in the Decision Register that affects
  Phase 1 schema design.

### Phase 0 verification gate

- 🟩 Baseline evidence is recorded under Verification Evidence.
- 🟩 No unexplained dirty-worktree changes overlap lifecycle work.
- 🟩 User has approved implementation to begin.

### Rollback and recovery strategy

All schema work follows expand → dual-write/backfill → cutover → validate →
contract. Additive objects and old compatibility fields/RPCs remain available
for at least two stable production releases after cutover. A deployed migration
is normally recovered with a forward-fix migration; irreversible down-migrations
must not be run against production data.

| Phase | Rollback/recovery checkpoint |
| --- | --- |
| P1 — Additive schema | Disable all new behavior flags and redeploy the previous application. Leave unused nullable tables/columns/indexes in place. Drop them only in a later reviewed cleanup migration if no writer has used them. |
| P2 — Backfill/read-only observability | Disable staff APIs/UI and metrics views. Preserve operation/case rows as audit evidence. If a backfill classifier is wrong, correct it with an idempotent forward migration; never delete ambiguous evidence ad hoc. |
| P3 — Operation identity/watchdogs | Disable new claim/watchdog/attempt workers and route calls through retained compatibility RPC wrappers. Preserve created operations/cases. Never recover by replaying a destructive supplier write. |
| P4 — Evidence/non-financial decisions | Disable evidence actions and reconciliation UI independently. Retain immutable evidence/security events; correct normalization with versioned evidence or a forward application release. |
| P5 — Financial resolutions | Disable proposal/approval/execution endpoints immediately and redeploy the prior application while retaining database authorization guards. Never reverse ledger entries or balances directly; use a new approved, case-bound compensating resolution. |
| P6 — Imported/manual ticketing | Disable new Confirm & Pay/import-charge actions and staff completion controls. Existing captures remain owned cases and must be completed/refunded through the protected workflow, not rolled back by SQL. |
| P7 — Notification outbox | Stop the outbox worker and revert to the retained status-delivery worker only while dual-write compatibility is valid. Preserve outbox/delivery rows, never reset successful recipients, and resume from idempotent claims after correction. |
| P8 — Scalable sweep | Stop the new worker and temporarily re-enable the bounded legacy sweep if compatibility remains. Preserve emitted events/outbox rows and resume with the last durable keyset/watermark. |
| P9 — Historical remediation | Snapshot and approve each batch before execution. There is no direct data rollback: incorrect outcomes require a new evidence-backed compensating case resolution with immutable before/after history. |
| P10 — Constraint/legacy retirement | Put every destructive cleanup in a separate migration after compatibility and rollback rehearsal. Restore retained wrappers/read paths before dropping old fields; otherwise forward-fix from the pre-cleanup schema/data snapshot. |
| P11 — Documentation/runbooks | Revert documentation through Git while retaining superseded runbooks in history. Operational instructions must always match the currently enabled production flags. |
| P12 — Staged rollout | Roll back one feature flag/deployment stage at a time, validate invariants, and stop progression. Application rollback must not assume schema rollback. Database backup/snapshot identifiers, release IDs, and flag states are recorded at every gate. |

Global recovery rules:

1. Take a production snapshot before migration rehearsal, backfill, financial
   activation, historical remediation, and destructive cleanup.
2. Migrations that create/alter authoritative functions run transactionally
   where PostgreSQL permits; indexes that require concurrent creation are
   isolated and monitored.
3. Feature flags separate operation writes, case UI/actions, financial
   resolution, imported ticketing, email outbox, and scalable sweep activation.
4. During a rollback, preserve immutable operations, cases, evidence, events,
   outbox deliveries, and ledger entries. Recovery creates new compensating
   records rather than rewriting history.
5. Before each rollout gate, record the exact migration set, application commit,
   feature-flag state, invariant report, queue depth, and database snapshot ID.

## Phase 1 — Additive operation, reconciliation, event, and outbox model

Goal: introduce the final internal model without changing public behavior.

### Booking operations

- 🟩 P1.1 — Design an additive `booking_operations` table with booking FK,
  operation kind, operation state, request identity, actor, source, prior state,
  supplier identity, evidence, and authoritative timestamps.
- 🟩 P1.2 — Define operation kinds: ticketing, cancellation, and imported manual
  ticketing.
- 🟩 P1.3 — Define operation states: claimed, supplier call started, awaiting
  external action, needs reconciliation, succeeded, and failed.
- 🟩 P1.4 — Enforce at most one active operation per booking with a partial
  unique index or equivalent invariant.
- 🟩 P1.5 — Add `flight_bookings.active_operation_id` as an initially nullable,
  backward-compatible FK.
- 🟩 P1.6 — Preserve existing `operation_*` fields temporarily as compatibility
  fields and plan dual-write/backfill behavior.

#### Operation compatibility contract

1. Through Phase 2, existing `flight_bookings.operation_*` fields remain the
   runtime authority and the new operation table is additive/read-only.
2. Phase 2 backfill creates one operation only when the existing metadata is
   unambiguous. It may set `active_operation_id`, but cannot change booking
   status, wallet state, supplier evidence, or legacy operation fields.
3. Phase 3 claim/finalization RPCs write `booking_operations`,
   `active_operation_id`, and compatibility `operation_*` fields atomically.
4. Rolling-deployment readers prefer the referenced operation when present and
   fall back to compatibility fields when absent. A disagreement opens a case;
   it is never silently overwritten by a reader.
5. Compatibility RPC signatures and columns remain for at least two stable
   production releases after every writer and reader has cut over. Removal is a
   separate Phase 10 migration with rollback rehearsal.

### Reconciliation cases

- 🟩 P1.7 — Design an additive `booking_reconciliation_cases` table with exactly
  one subject: a booking or booking attempt.
- 🟩 P1.8 — Define case types for ticketing uncertainty, cancellation
  uncertainty, legacy review, terminal conflict, direct-ticket payment failure,
  imported manual ticketing/payment conflict, attempt uncertainty, and
  historical inconsistency.
- 🟩 P1.9 — Define case states: open, assigned, awaiting supplier, awaiting
  finance, awaiting approval, resolved, and closed with no change.
- 🟩 P1.10 — Add assignee, severity, SLA/due time, escalation, evidence,
  resolution, proposer, approver, and optimistic version fields.
- 🟩 P1.11 — Add explicit financial-disposition values: none, capture existing
  hold, release existing hold, full refund, partial refund, no refund due,
  externally settled, and manual adjustment required.
- 🟩 P1.12 — Deduplicate open cases by subject, case type, and unresolved state.

### Lifecycle events and notification outbox

- 🟩 P1.13 — Extend lifecycle events additively with operation ID, case ID,
  occurrence identity/number, effective time, observed time, and render-safe
  event snapshot.
- 🟩 P1.14 — Design a transactional notification outbox tied to lifecycle event
  occurrences.
- 🟩 P1.15 — Design per-recipient delivery records with retry, suppression,
  failure, sent, and superseded outcomes.
- 🟩 P1.16 — Preserve existing status-delivery rows as historical/baseline
  evidence during migration.

#### Notification compatibility contract

1. Migration `0043` does not update, delete, re-key, or replace
   `booking_status_email_deliveries`; its 127 baseline/sent rows remain the
   authoritative legacy delivery evidence.
2. Phase 1 creates no outbox rows and sends no messages. Existing email worker
   and once-per-status claims remain unchanged.
3. Phase 7 cutover will dual-write new occurrences first. Historical legacy
   rows are mapped to non-send baseline evidence, never converted into pending
   customer deliveries.
4. During dual run, only one worker owns a given event occurrence. Successful
   legacy deliveries are never reset to make a new worker retry them.
5. The legacy table and RPCs remain available for rollback until the outbox has
   completed its compatibility window and replay/recipient tests pass.

### Schema safety

- 🟩 P1.17 — Add new constraints as nullable and/or `NOT VALID` where historical
  data would otherwise block deployment.
- 🟩 P1.18 — Add indexes for active operations, open cases, due cases, event
  occurrence queries, and outbox claims.
- 🟩 P1.19 — Keep the seven-value public status contract and lifecycle view
  backward compatible.

#### Phase 1 public compatibility contract

Migration `0043` does not replace `resolve_booking_lifecycle`, recreate
`booking_lifecycle_v`, change `flight_bookings.status`, add a public status, or
change status precedence. Existing application readers therefore receive the
same view columns and the same seven lifecycle values. New operation, case,
outbox, and recipient data is internal-only and has no authenticated/anonymous
grant. `active_operation_id` is nullable and is intentionally not a Phase 1
public DTO field.

- 🟩 P1.20 — Add database comments and least-privilege grants/revokes.
- 🟩 P1.21 — Add explicit operation reason/detail and reconciliation-case
  opening reason/source/actor fields so backfill never invents or loses why an
  internal workflow exists.

### Phase 1 verification gate

- 🟩 Migration dry run succeeds.
- 🟩 Schema lint succeeds.
- 🟩 Existing application build/type/lint/tests remain green.
- 🟩 Existing lifecycle view returns the same public status for every row.
- 🟩 No production behavior changes before later feature activation.

## Phase 2 — Backfill internal observability and expose a read-only staff view

Goal: make current operations and inconsistencies visible before permitting
staff resolution.

- 🟩 P2.1 — Backfill operation rows from trustworthy current operation metadata
  without changing booking status or wallet state.
- 🟩 P2.2 — Create open reconciliation cases for existing unresolved operations,
  aged attempts, and known anomalies without resolving them.
- 🟩 P2.3 — Record uncertain backfills as cases rather than inventing evidence.
- 🟩 P2.4 — Create a privileged staff lifecycle/reconciliation query/view that
  joins public status, stored status, operation, case, payment, reservation,
  evidence freshness, and SLA.
- 🟩 P2.5 — Keep the customer/public booking DTO unchanged and restricted.
- 🟩 P2.6 — Add a staff-only read DTO/API with role-based field masking.
- 🟩 P2.7 — Add read-only dashboard indicators for operation subtype,
  reconciliation warning, assignee, due time, payment conflict, and elapsed
  duration.
- 🟩 P2.8 — Add a read-only operation/case/event timeline.
- 🟩 P2.9 — Add metrics for open cases, aged operations, aged attempts, SLA
  breaches, terminal conflicts, and wallet inconsistencies.
- 🟩 P2.10 — Make `verify:booking-step3` carrier-aware for `BS` PNR deadlines
  and add a regression fixture so the live verifier agrees with the shared
  deadline policy.

### Phase 2 verification gate

- 🟩 Backfill is idempotent and changes no lifecycle/wallet truth.
- 🟩 Staff roles see only permitted details.
- 🟩 Customers cannot access internal operation/reconciliation metadata.
- 🟩 Known production anomalies appear in the read-only queue.

## Phase 3 — Operation identity, watchdogs, and attempt-level reconciliation

Goal: ensure no supplier write or booking attempt can remain ownerless forever.

- 🟩 P3.1 — Introduce server-generated, payload-bound operation request keys.
- 🟩 P3.2 — Make replay of the same key return the existing operation/result;
  reject the same key with a different booking/action/payload.
- 🟩 P3.3 — Refactor supplier-write claims to create/activate operations in the
  same transaction as status and wallet reservation changes.
- 🟩 P3.4 — Record the true supplier-call start time immediately before HTTP.
- 🟩 P3.5 — Record supplier-response receipt before/with finalization wherever
  safely possible.
- 🟩 P3.6 — Add a watchdog that converts aged active operations into owned
  reconciliation cases without replaying supplier writes.
- 🟩 P3.7 — Add an attempt-level watchdog for aged `submitting` and `unknown`
  booking attempts.
- 🟩 P3.8 — Keep attempt operational states separate from the seven public
  booking statuses.
- 🟩 P3.9 — Build a controlled attempt-reconciliation queue using supplier read
  endpoints and unique transaction identity.
- 🟩 P3.10 — Unify supplier uncertainty classification across Book, NewTicket,
  and Cancel, including HTTP-200 supplier errors, network failures, protocol
  errors, upstream errors, and incomplete responses.
- 🟩 P3.11 — Deduplicate repeated supplier conflict observations into one open
  case while retaining immutable evidence history.
- 🟥 P3.12 — Persist a redacted, normalized, versioned Direct Ticket supplier
  response receipt before mapping/finalization so a successful write cannot lose
  its reconstructable local evidence when a legacy response field is absent.

### Phase 3 verification gate

- 🟩 Concurrent Issue/Cancel claims cannot both win.
- 🟩 Crash/failure injection creates an owned case rather than a silent stuck
  operation.
- 🟩 Destructive supplier calls are never replayed automatically.
- 🟩 The known aged submitting attempt is visible but not yet mutated unless a
  later approved remediation phase resolves it.

## Phase 4 — Evidence acquisition and non-financial reconciliation decisions

Goal: define supplier truth safely before allowing money-changing resolutions.

- 🟩 P4.1 — Define normalized evidence contracts for PNR and AirTicketingDetails.
- 🟩 P4.2 — Validate unique transaction ID, PNR, booking code reference,
  passenger/route identity, ticket code, ticket numbers, status, freshness, and
  evidence source.
- 🟩 P4.3 — Add staff actions to request fresh evidence without changing status
  or money.
- 🟩 P4.4 — Define ticketing reconciliation outcomes: ticketed, definitively not
  ticketed/held, cancelled, and unresolved/conflicting.
- 🟩 P4.5 — Define cancellation reconciliation outcomes: cancelled, still held,
  ticketed, and unresolved/conflicting.
- 🟩 P4.6 — Define legacy evidence classification without a generic Resolve
  button.
- 🟩 P4.7 — Permit automatic case closure only when fresh supplier evidence
  agrees with existing local terminal truth and no financial conflict exists.
- 🟩 P4.8 — Require explicit staff confirmation for terminal correction,
  incomplete evidence, identity mismatch, legacy uncertainty, and any money
  consequence.
- 🟩 P4.9 — Ensure ordinary Sync opens/updates cases but cannot silently mutate
  protected terminal truth.
- 🟩 P4.10 — Add immutable security-audit events for every evidence read,
  proposal, rejection, approval, and resolution.
- 🟥 P4.11 — Extend case-bound evidence acquisition/validation to attempt-only
  Direct Ticket cases and the observed Triplover report schema; define complete
  LCC ticket identity without inventing `bookingCodeRef`, `ticketCodeRef`, or an
  e-ticket number.

### Phase 4 verification gate

- 🟩 Supplier evidence belonging to another booking is rejected.
- 🟩 Repeated evidence reads are idempotent and case-deduplicated.
- 🟩 No Phase 4 action can change wallet balances.
- 🟩 Terminal state remains protected without approved resolution.

## Phase 5 — Financially atomic reconciliation and maker-checker authorization

Goal: make booking truth and financial truth impossible to change silently or
independently during reconciliation.

- 🟩 P5.1 — Define granular permissions: view, investigate, propose, approve,
  and execute.
- 🟩 P5.2 — Narrow high-risk reconciliation powers instead of treating all
  financial/support roles equivalently.
- 🟩 P5.3 — Require maker-checker approval for terminal corrections, debits,
  refunds, fees/no-refund decisions, external settlement, and historical repair.
- 🟩 P5.4 — Create case-bound, outcome-specific SECURITY DEFINER resolution RPCs;
  do not expose a generic Set Status action.
- 🟩 P5.5 — Verify actor role/authorization inside high-risk database RPCs as
  defense in depth.
- 🟩 P5.6 — Enforce a consistent lock order across booking, operation, case,
  reservation, wallet, and account rows.
- 🟩 P5.7 — Implement ticketed + authorized active/reconciliation hold → atomic
  capture + Confirmed.
- 🟩 P5.8 — Implement definitive non-issuance → atomic release + correct
  On Hold/Expired/Unconfirmed projection.
- 🟩 P5.9 — Implement proven unpaid cancellation → Cancelled with no wallet
  mutation.
- 🟩 P5.10 — Implement proven cancellation with active hold → atomic release +
  Cancelled.
- 🟩 P5.11 — Implement captured cancellation outcomes through explicit full
  refund, partial refund/fee, no-refund, or external-settlement disposition.
- 🟩 P5.12 — Allow terminal-to-terminal correction only through approved,
  evidence-backed, financially atomic resolution.
- 🟩 P5.13 — Prevent generic reservation release from resolving reconciliation
  without an approved case outcome.
- 🟩 P5.14 — Bind reconciliation refunds to cases instead of relying on the
  generic refund endpoint alone.
- 🟩 P5.15 — Insert operation completion, case resolution, lifecycle event,
  wallet ledger, and notification outbox atomically.
- 🟥 P5.16 — Add an attempt-subject issued-ticket resolution that atomically
  creates one STR booking and captures the existing attempt-bound hold once,
  with fresh evidence, maker-checker, lock-order, and replay guards.
- 🟥 P5.17 — Replace the normal Direct Ticket create-then-capture sequence with
  one atomic attempt finalizer, plus an atomic In Progress materializer for
  supplier-positive but incomplete responses that keeps the hold protected.

### Phase 5 verification gate

- 🟩 Wallet balance equations and immutable ledger reconcile before/after every
  supported resolution.
- 🟩 No replay can double-capture, double-release, or double-refund.
- 🟩 Unauthorized or self-approved maker-checker actions fail.
- 🟩 Booking/payment disagreement always has an explicit case/disposition.
- 🟥 Issued Direct Ticket + no business booking + attempt-bound hold can be
  resolved without another supplier write, manual booking, or duplicate debit.

## Phase 6 — Imported booking and manual-ticketing workflow

Goal: give every paid imported booking an owner, SLA, supplier-verification
path, and financially safe outcome.

- 🟩 P6.1 — Keep imported held booking On Hold/Unpaid until owner Confirm & Pay.
- 🟩 P6.2 — Make Confirm & Pay capture User Payable exactly once and create an
  imported manual-ticketing operation/case atomically.
- 🟩 P6.3 — Assign the manual-ticket task with due time and escalation.
- 🟩 P6.4 — Show customers In Progress with “Payment received; ticketing is
  being completed.”
- 🟩 P6.5 — Allow staff Sync/verification without a second wallet debit.
- 🟩 P6.6 — Complete Confirmed only with complete, matching ticket evidence.
- 🟩 P6.7 — Handle supplier-held, cancelled, expired, unconfirmed, and
  conflicting outcomes through explicit operation/case rules.
- 🟩 P6.8 — Require refund/settlement disposition when captured manual ticketing
  cannot complete.
- 🟩 P6.9 — Escalate overdue manual-ticket operations; never leave them as
  indefinite generic In Progress.
- 🟩 P6.10 — Separate direct confirmed import from wallet charging unless prior
  authorization is established; require an explicit Import & Charge decision.
- 🟩 P6.11 — Preserve supplier gross versus protected User Payable invariants.

### Phase 6 verification gate

- 🟩 Imported On Hold never charges automatically.
- 🟩 Confirm & Pay charges once.
- 🟩 Supplier Sync never charges.
- 🟩 Manual ticket completion never charges twice.
- 🟩 Failed/cancelled/expired manual ticketing cannot hide captured funds.

## Phase 7 — Customer behavior, timestamps, and notification outbox

Goal: make status communication accurate, useful, occurrence-aware, and
non-spammy.

- 🟩 P7.1 — Keep only the seven public labels for customers.
- 🟩 P7.2 — Add customer-safe In Progress explanations for ticketing,
  cancellation, imported manual ticketing, and supplier verification.
- 🟩 P7.3 — Use actual operation start time for Processing Since.
- 🟩 P7.4 — Define status timestamps: submission, operation claim, supplier call,
  response, case opened, status effective/observed, issued, cancelled, deadline,
  and completion.
- 🟩 P7.5 — Add an ordinary ticketing/cancellation In Progress notification grace
  window; retain the event even when customer email is suppressed.
- 🟩 P7.6 — If Confirmed/Cancelled occurs during the grace window, mark the
  intermediate notification superseded and send only the final notification.
- 🟩 P7.7 — Send imported manual-ticketing In Progress promptly because payment
  capture creates a meaningful lasting state.
- 🟩 P7.8 — Replace once-per-booking/status delivery with event-occurrence and
  per-recipient idempotency.
- 🟩 P7.9 — Define material re-entry notifications for On Hold, Pending, In
  Progress, Expired, and Unconfirmed.
- 🟩 P7.10 — Render emails from event snapshots rather than the booking’s newer
  current row.
- 🟩 P7.11 — Track each visible recipient independently so partial failures do
  not resend to successful recipients.
- 🟩 P7.12 — Preserve the hidden system BCC behavior without exposing it in
  content.
- 🟩 P7.13 — Add retry, dead-letter/escalation, suppression, superseded, and
  delivery metrics.

### Phase 7 verification gate

- 🟩 Fast In Progress → Confirmed/Cancelled sends one final customer email.
- 🟩 Persistent In Progress sends the correct subtype and true start time.
- 🟩 Re-entry produces a new notification occurrence when policy requires it.
- 🟩 Partial recipient failure retries only failed recipients.
- 🟩 Event and outbox replay cannot duplicate successful delivery.

## Phase 8 — Scalable derived lifecycle observation

Goal: eliminate oldest-500 starvation and support millions of bookings.

- 🟩 P8.1 — Add a due-deadline partial index using deadline plus stable ID for
  active On Hold rows with no unresolved operation.
- 🟩 P8.2 — Query only due and not-yet-observed expiry occurrences before
  applying a batch limit.
- 🟩 P8.3 — Replace offset/oldest-row rescanning with keyset pagination.
- 🟩 P8.4 — Use `FOR UPDATE SKIP LOCKED` or equivalent safe concurrent claims.
- 🟩 P8.5 — Process bounded batches until the worker time budget is nearly
  exhausted.
- 🟩 P8.6 — Persist cursor/watermark and worker metrics where needed.
- 🟩 P8.7 — Record Unconfirmed primarily at booking creation and PNR/import Sync;
  use sweep only as a repair/backstop.
- 🟩 P8.8 — Insert expiry event and outbox atomically.
- 🟩 P8.9 — Add backlog, latency, failure, and starvation monitoring.
- 🟩 P8.10 — Keep the protected scheduler endpoint bounded and idempotent.

### Phase 8 verification gate

- 🟩 Synthetic tests with thousands and millions of rows show no starvation.
- 🟩 Concurrent workers do not duplicate an expiry occurrence.
- 🟩 Query plans use the intended partial indexes.
- 🟩 Worker completion remains within hosting/runtime limits.

## Phase 9 — Controlled historical-data remediation

Goal: repair historical truth only after protected resolution workflows exist.

- 🟩 P9.1 — Snapshot affected booking, attempt, reservation, ledger, event, and
  supplier evidence before remediation.
- 🟩 P9.2 — Create/confirm one reconciliation case per anomaly.
- 🟩 P9.3 — Classify each record as held/unpaid, ticketed/paid,
  ticketed/unpaid, cancelled/unpaid, cancelled/captured, unknown, or
  wallet/ledger mismatch.
- 🟥 P9.4 — Resolve the three existing In Progress reconciliation bookings
  through approved evidence workflows.
- 🟥 P9.5 — Resolve the aged submitting booking attempt through attempt-level
  reconciliation.
- 🟥 P9.6 — Resolve `STR260805000006` only after supplier truth and refund/fee
  disposition are explicitly approved.
- 🟥 P9.7 — Repair missing `cancelled_at` only from exact authoritative evidence;
  never infer it from a generic update time.
- 🟥 P9.8 — Resolve Confirmed/Unpaid imported bookings through external
  settlement, approved charge, or explicit financial-case outcome.
- 🟩 P9.9 — Classify or resolve historical Pending rows.
- 🟥 P9.10 — Re-run complete lifecycle/wallet/event/email invariant reports after
  each remediation batch.
- 🟥 P9.11 — Preserve before/after evidence and approver audit history.
- 🟥 P9.12 — Recover production Direct Ticket attempt `06fac0c2` only after
  P3.12/P4.11/P5.16/P5.17 are implemented, verified, deployed, and complete
  case-bound supplier evidence is independently proposed/approved. Until then
  preserve the open case and BDT 40,600.98 hold unchanged.

### Phase 9 verification gate

- 🟩 No direct ad hoc status or wallet mutation was used.
- 🟩 Ledger and balances reconcile.
- 🟩 Every former anomaly is resolved or remains as an explicitly owned case.
- 🟩 Historical customer notifications follow an explicitly approved policy.

## Phase 10 — Constraint validation and legacy-path retirement

Goal: enforce the final model only after data and writers are compatible.

- 🟥 P10.1 — Validate operation, case, terminal timestamp, financial-disposition,
  and active-operation constraints.
- 🟥 P10.2 — Ensure `Confirmed + Unpaid` and `Cancelled + Captured` cannot become
  silent inconsistencies.
- 🟥 P10.3 — Confirm all writers use new atomic operation/resolution paths.
- 🟥 P10.4 — Keep old RPC signatures as wrappers during a defined compatibility
  window.
- 🟥 P10.5 — Remove or permanently revoke obsolete Pending/manual-queue writers.
- 🟥 P10.6 — Retire compatibility operation fields only after all readers and
  rollback requirements allow it.
- 🟥 P10.7 — Remove old status-only email claiming after outbox cutover and
  historical delivery migration.
- 🟥 P10.8 — Confirm rollback strategy before every destructive cleanup.

### Phase 10 verification gate

- 🟥 All constraints validate against production-equivalent data.
- 🟥 No application reader/writer depends on retired fields/functions.
- 🟥 Rollback rehearsal succeeds before destructive cleanup.

## Phase 11 — Documentation and operational runbooks

Goal: make the final architecture maintainable by future developers and staff.

- 🟩 P11.1 — Update `docs/08-BOOKING-LIFECYCLE.md` with exact public meanings,
  operation/case separation, Pending restrictions, and terminal correction.
- 🟩 P11.2 — Update `docs/10-WALLET-SYSTEM.md` with case-bound financial
  disposition, maker-checker, and reconciliation invariants.
- 🟩 P11.3 — Update `docs/13-API-ROUTES.md` with operation, case, evidence,
  proposal, approval, execution, and attempt-reconciliation APIs.
- 🟩 P11.4 — Update `docs/17-IMP-EXP-IMPORTS.md` with manual-ticket ownership,
  SLA, verification, failure, and refund behavior.
- 🟩 P11.5 — Update `docs/12-DATABASE.md` with operations, cases, outbox, indexes,
  constraints, and delivery model.
- 🟩 P11.6 — Update `docs/02-ARCHITECTURE.md` and
  `docs/07-BOOKING-SYSTEM.md` with public lifecycle versus internal operation
  and attempt uncertainty.
- 🟩 P11.7 — Update API/business wording that currently describes Pending as the
  normal supplier-wallet-shortage path.
- 🟩 P11.8 — Update wording that implies Cancelled always means refund is already
  complete.
- 🟩 P11.9 — Document reconciliation SLA, escalation, evidence requirements,
  role permissions, maker-checker, and emergency procedures.
- 🟩 P11.10 — Create staff runbooks for each reconciliation case type.

### Phase 11 verification gate

- 🟩 Documentation matches implementation and production behavior.
- 🟩 Staff runbooks contain no direct database-mutation instructions.
- 🟩 All outdated lifecycle claims identified in the design review are removed.

## Phase 12 — Full verification, staged rollout, and handoff

Goal: deploy safely only after all invariants and rollback paths are proven.

- 🟩 P12.1 — Run complete lint, typecheck, build, unit, integration, database
  lint, migration dry-run, and lifecycle verification suites.
- 🟩 P12.2 — Run the transition, concurrency, authorization, wallet, email,
  supplier-uncertainty, sweep-scale, and migration tests listed below.
- 🟩 P12.3 — Rehearse migrations and backfill on a production snapshot.
- 🟩 P12.4 — Deploy additive schema with behavior flags disabled.
- 🟩 P12.5 — Enable read-only staff observability and monitor.
- 🟩 P12.6 — Enable operation/watchdog paths incrementally.
- 🟩 P12.7 — Enable reconciliation actions by case type and role.
- 🟩 P12.8 — Enable email outbox/coalescing separately.
- 🟩 P12.9 — Enable scalable sweep and monitor backlog/latency.
- 🟥 P12.10 — Perform historical remediation only after workflow stabilization.
- 🟩 P12.11 — Validate production invariants after every rollout stage.
- 🟩 P12.12 — Record commits, migrations, deployment IDs, verification evidence,
  and rollback checkpoints in this file.
- 🟥 P12.13 — Obtain user approval before deleting this temporary file.

---

# Required test and verification matrix

## Lifecycle and derivation

- 🟩 T1 — Every permitted transition and every forbidden transition.
- 🟩 T2 — Stored versus derived status precedence.
- 🟩 T3 — Missing PNR versus passed deadline precedence.
- 🟩 T4 — Deadline extension and repeated expiry occurrence.
- 🟩 T5 — Terminal protection and approved terminal correction.

## Concurrency and idempotency

- 🟩 T6 — Simultaneous Issue versus Issue.
- 🟩 T7 — Simultaneous Issue versus Cancel.
- 🟩 T8 — Simultaneous Sync versus resolution.
- 🟩 T9 — Simultaneous refund/capture/release attempts.
- 🟩 T10 — Same request key/same payload replay.
- 🟩 T11 — Same request key/different payload rejection.
- 🟩 T12 — Process crash before supplier call, during call, after response, and
  before local finalization.

## Supplier uncertainty

- 🟩 T13 — Network, timeout, protocol, 5xx, HTTP-200 supplier error, incomplete
  ticket response, and conflicting read endpoints.
- 🟩 T14 — Evidence identity mismatch.
- 🟩 T15 — Duplicate/repeated evidence reads.
- 🟩 T16 — No destructive supplier replay after ambiguity.

## Wallet and reconciliation

- 🟩 T17 — Hold, capture, release, full refund, partial refund, fee/no-refund,
  external settlement, and manual-adjustment-required outcomes.
- 🟩 T18 — Ledger immutability and balance equations.
- 🟩 T19 — No double charge/release/refund under retries or concurrency.
- 🟩 T20 — Confirmed/Unpaid and Cancelled/Captured visibility/invariants.
- 🟩 T21 — Maker-checker separation and role matrix.

## Email and outbox

- 🟩 T22 — Fast In Progress → Confirmed.
- 🟩 T23 — Fast In Progress → Cancelled.
- 🟩 T24 — Persistent In Progress subtype and timestamp.
- 🟩 T25 — Status re-entry occurrence notification.
- 🟩 T26 — Partial recipient success/failure.
- 🟩 T27 — Outbox retry, suppression, supersession, and dead-letter behavior.
- 🟩 T28 — Hidden BCC remains envelope-only.

## Imported/manual ticketing

- 🟩 T29 — On Hold import never charges.
- 🟩 T30 — Confirm & Pay charges exactly once.
- 🟩 T31 — Sync never charges.
- 🟩 T32 — Manual completion never charges twice.
- 🟩 T33 — Held, ticketed, cancelled, expired, unconfirmed, and conflicting
  supplier outcomes after payment.
- 🟩 T34 — SLA escalation.

## Scale and migration

- 🟩 T35 — Thousands/millions of due and non-due bookings without starvation.
- 🟩 T36 — Concurrent sweep workers without duplicate events.
- 🟩 T37 — Query plans use intended indexes.
- 🟥 T38 — Additive migration, backfill replay, rollback, and constraint
  validation on production-equivalent data.
- 🟩 T39 — Old application compatibility during rolling deployment.
- 🟥 T40 — Real-shape Direct Ticket HTTP-200 success with missing legacy refs:
  attempt evidence acquisition, issued/not-issued branches, exactly-one STR,
  exactly-one existing-hold capture, response-loss replay, concurrent execution,
  and no supplier write or second available-balance debit.
- 🟥 T41 — Future Direct Ticket prevention matrix: atomic normal success,
  supplier-positive/incomplete In Progress materialization, ambiguous response
  attempt containment, definitive rejection release, and crash injection at each
  receipt/normalization/finalization boundary.
- 🟥 T42 — Standard e-ticket versus approved ticketless evidence profiles,
  including real Triplover field shapes, PNR-not-ticket-number rejection,
  downstream display/Sync/PNR/Cancel capabilities, and deny-by-default carriers.

---

# Decision Register

Resolve each item before its dependent implementation step begins.

- 🟩 D1 — Ordinary Triplover ticketing/cancellation In Progress notifications
  have a 120-second grace window. Imported manual ticketing is immediate.
- 🟩 D2 — Adopt the SLA/watchdog policy recorded below, including a three-minute
  active supplier-call watchdog and case-type-specific resolution targets.
- 🟩 D3 — Adopt Support/Accounts maker roles, Admin/Super Admin checker roles,
  database-enforced separation of maker and checker, and no self-approval.
- 🟩 D4 — Captured cancellations require an explicit full, partial, no-refund,
  external-settlement, or manual-adjustment disposition. Supplier figures are
  evidence, never an automatic wallet mutation.
- 🟩 D5 — A directly imported Confirmed booking never charges a wallet merely
  because it was imported. Charging requires a separate, explicit, quoted,
  idempotent Import & Charge confirmation by the wallet owner.
- 🟩 D6 — Evidence must be acquired within five minutes of a decision. Terminal
  correction or money movement requires matching identity and all applicable
  authoritative read endpoints; negative/incomplete evidence is not automated.
- 🟩 D7 — Backfill, case creation, and timestamp-only historical repair do not
  email customers. New material travel or money outcomes do email; exceptional
  suppression requires an approved reason and remains visible in the outbox.
- 🟩 D8 — Pending remains a public contract value but is legacy/special-use.
  Customers see a Pending filter only when their scope contains a Pending
  booking; staff filters always include it.
- 🟩 D9 — Use team queues: Support for supplier/attempt/manual-ticketing work,
  Accounts for financial work, and Admin for terminal/historical conflicts;
  escalate to Admin and then Super Admin according to SLA.
- 🟩 D10 — Retain lifecycle/financial decision metadata for seven years,
  sensitive raw supplier evidence for two years before redaction, rendered
  notification content for 90 days, and delivery metadata for two years.
- 🟥 D11 — Review/approve the proposed Direct Ticket response, evidence-profile,
  atomic-normal-finalization, and attempt-only recovery contract recorded under
  F10. Missing legacy references must be handled by an explicit supplier/airline
  evidence policy, never by weakening ticket evidence globally or fabricating
  values. Approval is still required before P3.12/P4.11/P5.16/P5.17 begins.

## Resolved implementation policy values

These are version-1 application policies. Store due times and policy versions on
each operation/case/outbox row instead of recomputing old records after a future
policy change.

### Operation watchdog and reconciliation SLAs

| Work type | Initial owner | Target/due rule | Escalation |
| --- | --- | --- | --- |
| Active Triplover Book/NewTicket/Cancel call | Support queue | Mark `needs_reconciliation` if still active 3 minutes after `supplier_call_started_at`; never replay the write. | Admin at watchdog detection; Super Admin if unresolved 2 hours later. |
| Ticketing or cancellation uncertainty | Support queue | Resolve within 30 minutes of case opening. | Admin at due time; Super Admin at 2 hours open. |
| Imported manual ticketing | Support queue | Due at the earlier of capture + 2 hours or ticketing deadline − 60 minutes; an already-passed due time is immediately overdue. | Warn unassigned queue after 30 minutes; Admin at due time; Super Admin 1 hour overdue. |
| Terminal-state or direct-ticket payment conflict | Admin queue with Accounts collaboration | Resolve/propose within 60 minutes. | Admin notified immediately; Super Admin at 2 hours open. |
| Unknown/submitting booking attempt | Support queue | Investigate within 15 minutes of watchdog detection. | Admin at 60 minutes open; Super Admin at 2 hours open. |
| Legacy/historical inconsistency | Admin queue | Triage within one business day; resolution remains evidence-dependent. | Super Admin after three business days without an approved plan. |

### Maker-checker and execution policy

| Capability | Allowed roles/rules |
| --- | --- |
| View operational cases | `superadmin`, `admin`, `staff_support`, and `staff_account`, with existing passenger-field masking and need-to-know evidence masking. |
| Acquire/investigate supplier evidence | `staff_support`, `admin`, or `superadmin`; Accounts may view only normalized financial evidence unless separately granted. |
| Propose lifecycle/supplier-truth outcome | `staff_support`, `admin`, or `superadmin`. |
| Propose wallet/refund/settlement outcome | `staff_account`, `admin`, or `superadmin`. |
| Approve terminal or financial outcome | `admin` or `superadmin`, and `approved_by` must differ from `proposed_by`. An Admin proposal therefore requires a different Admin or Super Admin; a Super Admin proposal also requires another authorized person. |
| Execute an approved outcome | A case-bound database RPC may execute for the approving actor or trusted worker only after rechecking case version, proposal hash, authorization, evidence freshness, and maker/checker separation in the database transaction. |
| Automatic no-change closure | Allowed only when fresh evidence confirms current terminal truth, identities agree, and no payment/reservation conflict exists. It cannot move money or correct a terminal status. |

Customers, B2B owners, and B2B sub-users never see or act on internal cases;
their existing issue, cancel, and imported Confirm & Pay permissions remain
separate customer workflows.

### Refund and settlement policy

1. An unpaid proven cancellation changes booking truth with no wallet mutation.
2. A proven cancellation with an active hold releases that exact hold
   atomically; it is not a refund.
3. A captured cancellation never triggers an automatic refund from supplier
   response data. The supplier's net refund and penalty are stored as evidence.
4. `full_refund` refunds the entire remaining captured amount;
   `partial_refund` requires an explicit positive amount, currency, penalty/fee
   rationale, and cannot exceed the remaining captured amount.
5. `no_refund_due` and `externally_settled` require evidence plus maker-checker
   approval. External settlement requires a non-secret settlement reference.
6. `manual_adjustment_required` leaves the case open/owned and cannot silently
   make booking and wallet state appear reconciled.

### Supplier evidence policy

Evidence is fresh for five minutes from successful response receipt. Store the
source, request/response times, supplier identities, normalized facts, a hash of
the protected raw payload, and the normalizer version. Ticket issuance requires
matching PNR plus complete AirTicketingDetails/ticket evidence. Cancellation of
a booking with ticket or captured-money history requires cancellation evidence
plus ticket/financial evidence. Missing tickets or a single negative response
cannot automatically prove non-issuance; it requires explicit staff resolution.

### Historical notification and retention policy

Every remediation creates an immutable event and notification decision. Do not
notify for backfill, case creation, internal assignment, or timestamp-only
repair. Notify for a newly material current/future travel-state change, new
wallet debit, or refund; any suppression of such a material event needs an
approved reason. Keep cases, normalized evidence, decisions, security audit,
events, and financial references for seven years after completion. Raw supplier
payloads containing passenger data are restricted and redacted after two years;
rendered notification bodies are redacted after 90 days; recipient/provider
delivery metadata is retained for two years and then minimized. Open cases and
statutory wallet ledger records are never removed by these retention jobs.

---

# Discovery and decision log

Add entries chronologically. Never remove a discovery; mark it resolved and link
the implementing step/verification evidence.

| Date/time | Status | Area | Discovery or decision | Related step | Resolution/evidence |
| --- | --- | --- | --- | --- | --- |
| Plan creation | 🟩 | Architecture | Keep seven public statuses; represent complexity as operation, reconciliation, financial, event, and notification metadata. | P1–P12 | Approved design basis; implementation awaiting plan approval. |
| Plan creation | 🟩 | Governance | Exact policy values in Decision Register require confirmation before dependent phases. | D1–D10 | Resolved as version-1 implementation policies in P0.7 after user approved the recommended design and implementation. |
| 2026-08-11 | 🟩 | Plan governance | The bootstrap summary duplicated checklist ID `P0.2`; the bootstrap line was changed to an unnumbered current-step marker so checklist IDs remain unique. | P0.2 | Working-memory document corrected before implementation actions. |
| 2026-08-11 | 🟩 | Git strategy | Implement on `development`; keep `main` as the production branch and merge only after the staged rollout gate and user approval. `development` was fast-forwarded to the current `main` baseline before lifecycle edits. | P0.2 | `development` now points to `c2f5a62`; no commit, push, merge to `main`, or deployment was performed. |
| 2026-08-11 | 🟩 | Repository safety | No repository `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, or Copilot instruction file exists. The only working-tree change is this new temporary lifecycle document. | P0.3 | No unrelated or overlapping user edits were found. Generated/cache directories remain untouched. |
| 2026-08-11 | 🟩 | Baseline data quality | The one `verify:booking-step3` mismatch was confirmed to be a verifier defect, not a booking-data defect: US-Bangla (`BS`) correctly uses `MM/DD/YYYY`, while the verifier applied the other-airline `DD/MM/YYYY` rule universally. | P0.4, F9, P2.10 | Preserve existing correct BS deadline data and production parsing; make only the verifier carrier-aware and retain the existing non-BS parsing behavior. |
| 2026-08-11 | 🟩 | Production baseline | Read-only aggregate snapshot confirms the known three reconciliation bookings, four missing cancellation timestamps, one Cancelled/Captured conflict, two imported Confirmed/Unpaid records, and one aged submitting attempt. | P0.5, F1–F5, F8 | Aggregate table recorded above; email queue remains caught up with no recorded errors. |
| 2026-08-11 | 🟩 | Rollback design | Adopt expand/dual-write/cutover/validate/contract, feature-gated activation, forward-fix migrations, and case-bound compensating financial corrections. | P0.6, P1–P12 | Phase-by-phase checkpoints and global recovery rules recorded before schema implementation. |
| 2026-08-11 | 🟩 | Lifecycle policy | Fixed grace, SLA, role/maker-checker, refund, import charging, evidence, historical notification, Pending visibility, assignment, and retention defaults as version-1 policies. | P0.7, D1–D10 | Values recorded in the resolved policy section and must be persisted on affected rows for historical stability. |
| 2026-08-11 | 🟩 | Verification method | PostgREST `HEAD` returned `204` for both real and nonexistent resource names, so it cannot prove table existence in this environment. Normal `GET ... limit 1` probes return `PGRST205` for all four Phase 1 tables. | P1 gate | Corrected the initial false-positive immediately; migration history and GET probes confirm `0043` is not applied to production. |
| 2026-08-11 | 🟩 | Schema completeness | Phase 2 backfill design exposed that operation subtype/reason and immutable case-opening provenance were not explicit in `0043`. Relying only on kind/type or mutable evidence would lose operational meaning. | P1.21 | Added constrained reason/detail plus case source/opener/time; isolated migration replay and lifecycle-view equivalence pass. |
| 2026-08-11 | 🟩 | Backfill safety | Do not set `flight_bookings.active_operation_id` during Phase 2 backfill because the existing booking update trigger would change `updated_at`. Join a backfilled active operation by booking ID until Phase 3 writers set the pointer atomically. | P2.1, P2.4, P3.3 | Keeps all existing booking/status/wallet/timestamp rows byte-unchanged during observability backfill. |
| 2026-08-11 | 🟩 | Baseline verifier | F9 is a `BS` carrier row with raw `08/09/2026 03:00:45` and stored `2026-08-08T21:00:45Z`, which is correct under the carrier-specific `MM/DD/YYYY` rule. The generic Step 3 verifier applies `DD/MM/YYYY`. | F9, P2.10 | Exclude the correct booking from remediation; fix and regression-test the verifier in P2.10. |
| 2026-08-11 | 🟩 | View compatibility | PostgreSQL does not add later base-table columns to an existing `SELECT fb.*` view. `booking_lifecycle_v` therefore intentionally has no `active_operation_id`. | P2.4 | The staff view joins `flight_bookings` only for the internal pointer and leaves the established public lifecycle view definition and column contract unchanged. |
| 2026-08-11 | 🟩 | Finalizer result loss | A versioned database finalizer can commit while its PostgREST response is lost. Calling the legacy reconciliation mutator afterward could incorrectly rewrite compatibility metadata on an already completed terminal booking. | P3.5 | Finalizers retry the same payload-bound operation once, Book recovers by unique attempt ID, intentional failed-operation finalizers have semantic replay success, and routes no longer apply a separate legacy mutation after a versioned finalizer failure. |
| 2026-08-11 | 🟩 | Wallet verifier | The wallet ordering verifier still searched for the retired direct Issue-route capture call and an obsolete `issueTicket({` shape. | P3.5 | Updated it to assert reserve → supplier → versioned atomic finalizer ordering and the response/finalization/reconciliation guards in migration `0045`; independent wallet verification passes. |
| 2026-08-11 | 🟩 | Watchdog cadence | The approved operation threshold is three minutes, while the user-selected Supabase scheduler invokes the protected endpoint every 15 minutes. Eligibility is correct at three minutes, but actual detection occurs on the next scheduler run and can therefore be roughly 3–18 minutes after supplier-call start. | P3.6, P8.10, rollout | Retained the explicit threshold and approved 15-minute cron unchanged. The scheduler reports bounded outcomes and staff metrics expose aged operations/run health; rollout must validate the expected detection lag rather than silently changing cadence. |
| 2026-08-11 | 🟩 | Attempt reconciliation evidence boundary | An unresolved Book attempt normally retains `uniqueTransID`, but PNR lookup additionally requires PNR and booking-code references that may be missing when the response is lost. AirTicketingDetails is a safe read for issued/cancelled/refunded records, but an empty result cannot prove that no held booking exists. | P3.9, P4.1–P4.3 | The staff queue selects one of three explicit read plans, requires the supplier portal after an inconclusive report, and hard-codes destructive replay and automatic resolution as false. Phase 4 will implement evidence acquisition and decisions; P3.9 performs no supplier call or resolution. |
| 2026-08-11 | 🟩 | Supplier uncertainty consistency | Book used a narrower ad hoc unknown-outcome test than NewTicket/Cancel and could treat an HTTP-200 supplier failure as definitive even though the other destructive routes preserved it as ambiguous. Error type alone also could not distinguish a login/configuration failure before the destructive request from a network failure after it began. | P3.10 | All three routes now use one boundary-aware classifier. HTTP-200 business failures, 5xx, post-write network/protocol/incomplete responses, and unexpected post-write failures preserve uncertainty; pre-write failures are classified `not-sent`; complete 4xx/explicit rejections are definitive. No class permits automatic replay. |
| 2026-08-11 | 🟩 | Reconciliation observation history | A single mutable case-level evidence array cannot both deduplicate one open case and preserve independently idempotent observation occurrences over time. | P3.11, P4 | Added an append-only observation ledger keyed by case plus occurrence key. Exact database-response replays return the same row; later reads use new keys and append history. Update/delete are denied and trigger-blocked; normalized facts contain no raw supplier payload. |
| 2026-08-11 | 🟩 | Supplier evidence transport receipt | Existing read adapters returned normalized business fields but discarded exact wall-clock request/response timing and had no protected proof of which raw payload was normalized. Retaining raw payload in the normal DTO would create unnecessary passenger-data exposure. | P4.1 | Every Triplover call now produces an additive receipt with request start, complete-response receipt, HTTP status, and SHA-256 of the raw body; raw body is not retained in evidence. PNR and AirTicketingDetails wrap that receipt in separate versioned five-minute evidence contracts. |
| 2026-08-11 | 🟩 | Supplier evidence completeness | AirTicketingDetails passenger records may be flat or nested and ticket-number fields may be scalar or arrays. The report may also omit passenger names or route identity, so a successful HTTP response is not necessarily complete evidence. | P4.2 | The adapter normalizes both known passenger/ticket shapes. The validator fails closed on missing/mismatched passenger or route identity, malformed/wrong-source/stale evidence, or any supplier-reference/status/ticket conflict. Incomplete reports remain non-authoritative for staff review; no field is invented and no status or money changes. |
| 2026-08-11 | 🟩 | Investigation versus synchronization | The Super Admin booking page automatically invoked the legacy supplier-refresh route on first render. That behavior made merely viewing a record perform synchronization and could not serve as a controlled evidence-only investigation. | P4.3, P4.9 | Removed automatic page-load refresh. Support/Admin/Super Admin now have an explicit, rate-limited, case-bound evidence action using safe PNR/report reads. It stores normalized evidence and audit records only; Accounts is view-only and no customer/B2B role receives the action. Legacy Sync remains a separate compatibility path for P4.9 review. |
| 2026-08-11 | 🟩 | Held versus proven non-issuance | A fresh matching Held PNR positively proves the supplier currently reports a held booking, but one PNR read cannot prove that no separate ticket record exists. Treating Held as definitive non-issuance could release protected funds after an unknown NewTicket outcome. | P4.4, D6, I8 | The ticketing classifier exposes `held_not_ticketed` only as an explicit staff-confirmation candidate. It is never authoritative for automatic release. Complete matching ticket/cancellation evidence produces a positive candidate; incomplete, stale, identity/status conflict, or conflict with local terminal/ticket truth remains `unresolved_conflicting`. Phase 4 cannot mutate status or money. |
| 2026-08-11 | 🟩 | No-change closure ownership | Closing only a reconciliation case would leave its linked operation in `needs_reconciliation` and the booking's active/compatibility operation metadata unresolved even though supplier truth already matches the terminal booking. | P4.7 | The narrow automatic path atomically completes the linked operation, clears only active/compatibility operation metadata, and closes the case. It does not change public status, payment state, wallet/reservation/ledger rows, lifecycle events, or email outbox rows. |
| 2026-08-11 | 🟩 | Confirmation is not execution | A generic confirmation checkbox would be unsafe because identity exceptions, incomplete evidence, held non-issuance, terminal correction, legacy uncertainty, and financial consequences require different recovery/proposal controls. | P4.8, P5 | Added a server-derived risk/confirmation boundary that keeps evidence reads non-executable, blocks unresolved evidence exceptions, identifies the required outcome-specific next step, and requires maker-checker for every high-risk path. Persistence, approval, and execution remain Phase 5 responsibilities. |
| 2026-08-11 | 🟩 | Ordinary Sync was still a lifecycle writer | Legacy Triplover refresh copied conflicting ticket/PNR fields before flagging reconciliation, and imported Sync could move an existing Confirmed/Cancelled booking into In Progress or another supplier-reported status. Compatibility RPCs also remained callable. | P4.9 | Added actor-bound v2 Sync RPCs plus protected compatibility wrappers. Exact lifecycle agreement may enrich matching supplier fields; disagreement appends deduplicated immutable evidence to an owned case while status, operation, terminal ticket fields, payment, and wallet remain unchanged. Imported staff UI receives the case identity. |
| 2026-08-11 | 🟩 | Application-only audit was incomplete | The second evidence-replay path returned without an audit event, and future direct database case transitions could bypass application audit calls. The audit table also relied on grants rather than a mutation-denial trigger. | P4.10 | Replay now fails closed if its audit cannot be stored. Database triggers atomically audit evidence insertion and proposal/rejection/approval/resolution transitions with hashes and identifiers only; audit-row update/delete is trigger-blocked. The existing no-change RPC retains its dedicated audit action. |
| 2026-08-11 | 🟩 | Reconciliation permissions were implicit | Staff lifecycle access previously collapsed authorization into Admin/Support/Accounts views plus one evidence-read boolean, leaving no reusable boundary for proposal, approval, or execution. | P5.1 | Added one explicit six-capability role matrix. Support is operational, Accounts is financial, Admin/Super Admin may propose either domain and are the only user roles that may approve/execute, and every customer/B2B/media role fails closed. Existing evidence authorization delegates to the same matrix. |
| 2026-08-11 | 🟩 | Proposal authority needs a domain boundary | A lifecycle outcome may also imply capture/release/refund, so treating “can propose” as one permission would allow Support to prescribe money or Accounts to prescribe supplier truth. | P5.2 | Added supplier-only, financial-only, and combined proposal domains with explicit risk flags. Support/Accounts stay within their domains; combined outcomes require Admin/Super Admin. Money risk cannot be disguised as supplier-only, and terminal/money/fee/settlement/historical flags always retain maker-checker without granting execution. |
| 2026-08-11 | 🟩 | Maker-checker is a case state machine | Existing nullable proposal/approval columns did not themselves enforce who may propose, whether evidence is fresh and case-bound, whether a changed request is a replay, or whether the checker differs from the maker. | P5.3 | Added proposal/approve/reject RPCs that lock booking then case, derive risk and confirmation requirements in the database, bind the request/evidence/current case version to a stable 64-hex fingerprint, require an independent Admin/Super Admin checker for high-risk proposals, and never grant status or wallet execution. |
| 2026-08-11 | 🟩 | Carrier deadline contract reaffirmed | The user confirmed that supplier times are correct for all airlines, while the slash-date order differs: US-Bangla (`BS`) is `MM/DD/YYYY`; other currently supported carriers are `DD/MM/YYYY`. | F9, P4.1, all later deadline work | Preserve the time fields and the existing carrier-aware parser. Dedicated regression verification passes; no deadline data was changed. |
| 2026-08-11 | 🟩 | Outcome contracts must exist before execution | One generic resolver would allow a caller to smuggle an arbitrary lifecycle or financial result through a broad request body. | P5.4 | Added six named SECURITY DEFINER contracts for ticketed, non-issuance, cancelled, financial-only, terminal-correction, and historical-repair paths. The shared validator is private even to `service_role`; public contracts bind current booking/payment state, case version/hash, actor, fresh case evidence, and exact outcome. All six intentionally fail closed with execution disabled until their atomic implementations replace them. |
| 2026-08-11 | 🟩 | Service role is not a staff business role | SECURITY DEFINER functions called with the server service key cannot safely treat the PostgreSQL caller/JWT role or an application-supplied role string as Admin authority. | P5.5 | Proposal, approval, rejection, and execution RPCs accept only the session-derived actor ID, re-read its current role from `app_users`, enforce the domain/decision/execution matrix in the database, and reject self-approval. A role demotion takes effect on the next call. The private generic contract remains non-callable by `service_role`. |
| 2026-08-11 | 🟩 | Reconciliation must share one lock prefix | Existing wallet routines are safe only if competing booking operations serialize before narrower wallet locks; resolution functions also need stable linked operation/case identities. | P5.6 | The shared guard now locks booking → linked operation → case → reservation → wallet owner → currency account. It rechecks the case/operation link after locking, supports an attempt-originated reservation, verifies wallet ownership, and returns the exact locked IDs. Ledger entries remain append-only and are never locked for mutation. The private reservation helper remains non-callable by `service_role`. |
| 2026-08-11 | 🟩 | Ticketed resolution cannot trust proposal payload for tickets or amount | A correct approval proves authority, but client-supplied ticket fields or money could still diverge from the supplier observation/reservation that was approved. | P5.7 | The ticketed RPC accepts only IDs/hash/request identity. It re-validates a fresh complete identity-matching observation authoritative for ticketing, extracts ticket code/numbers/PNR from that immutable evidence, and captures the exact locked reservation amount. Capture, Confirmed booking, operation completion, case resolution, ledger entry, and linked lifecycle event commit in one transaction with exact replay recovery. |
| 2026-08-11 | 🟩 | Held evidence needs a definitive manual basis before release | A fresh matching Held PNR still cannot prove that a separate issued ticket record does not exist after an uncertain NewTicket call. | P5.8 | Added a Support/Admin/Super Admin, audit-gated API/RPC that records a SHA-256-hashed, append-only supplier-portal attestation tied to a fresh case-bound Held read. The proposal must bind both observations and both held/manual confirmation codes; incomplete supplier reads additionally retain their exception confirmation. Only the independently approved non-issuance RPC can release the exact hold, restore stored On Hold, derive On Hold/Expired/Unconfirmed, fail the operation, resolve the case, and append ledger/event rows atomically. Raw portal evidence is not stored. |
| 2026-08-11 | 🟩 | Reconciliation fingerprints should be cryptographic | PostgreSQL/PGlite provide built-in `sha256(bytea)`, so doubled MD5 does not need to be retained merely to produce 64 hex characters. | P5.3, P5.8 | Proposal and new attestation fingerprints now use `encode(sha256(convert_to(..., 'UTF8')), 'hex')`; replay and mismatch semantics remain unchanged. |
| 2026-08-11 | 🟩 | Unpaid cancellation must prove absence of financial state | Treating a zero captured amount as equivalent to Unpaid could hide an active/reconciliation reservation or a charged wallet association. | P5.9 | The unpaid cancellation branch requires exact `payment_state = unpaid`, zero captured/refunded amounts, no charged account, no reservation, and financial disposition `none`. It accepts only fresh complete identity-matching cancellation evidence and updates booking/operation/case/event state in one transaction without referencing wallet, reservation, or ledger mutation SQL. |
| 2026-08-11 | 🟩 | Held cancellation needs its own financial-consequence RPC | Broadening the unpaid cancellation function to optionally release funds would make the same action name carry materially different authority. | P5.10 | Added an explicit `cancelled_release` RPC. It requires authoritative cancellation, `release_existing_hold`, a Held/Reconciliation booking and Active/Reconciliation reservation with matching locked account/currency/amount, and independent approval. It performs one hold-release ledger movement, marks reservation/payment Released, sets Cancelled, and completes operation/case/event atomically; it never calls the generic release RPC. |
| 2026-08-11 | 🟩 | Captured cancellation has four distinct financial truths | A generic captured-cancellation action could silently imply a refund, invent a local wallet refund for an external settlement, or accept a caller-selected amount. | P5.11 | Added four exact public RPCs backed by a private non-service-callable engine. Full refund derives the remaining captured balance; partial refund reads the independently approved case amount/currency; no-refund and externally settled move no local wallet money and preserve explicit retained captured truth. All variants are evidence-bound, maker-checker protected, atomic, audited, and replay-safe. |
| 2026-08-11 | 🟩 | Terminal correction must be consequence-specific and financially closed | A broad terminal-status switch could turn Cancelled into Confirmed without payment, or Confirmed into Cancelled without deciding what happens to captured money. | P5.12 | Confirmed → Cancelled is admitted only through the four exact captured-cancellation dispositions after the server-derived terminal risk selects the terminal contract. Cancelled → Confirmed is admitted only for a captured, unrefunded, identity-matching reservation with authoritative ticket evidence and no wallet movement. Unpaid, held, released, refunded, or mismatched reverse corrections fail closed for a different controlled workflow. The cleared cancellation fields are retained in the immutable case resolution result. |
| 2026-08-11 | 🟩 | Generic release could bypass owned uncertainty | The compatibility `wallet_release_reservation` released every non-captured reservation, including reconciliation state, without checking an open case, uncertain operation, or unknown attempt. | P5.13 | Replaced the compatibility body with booking/attempt-first serialization and guards for reconciliation payment/operation/reservation state, unresolved cases, needs-reconciliation operations, and unknown attempts. It retains ordinary definitive-failure release and exact replay. Approved non-issuance/cancellation releases continue to mutate their locked rows directly and never delegate to the generic RPC. The guard returns the existing mapped `RECONCILIATION_REQUIRED` contract. |
| 2026-08-11 | 🟩 | Generic refund could bypass case authority and financial role separation | `wallet_refund_booking` accepted a caller-supplied role and could refund Cancelled/Captured or open-case bookings outside maker-checker reconciliation; Support also saw the generic refund form. | P5.14 | The database now re-reads `app_users`, permits only Accounts/Admin/Super Admin, locks booking → operation → case → captured reservation → wallet → account, blocks Cancelled/reconciliation/open-case states, verifies reservation/payment identity, and binds exact replay to booking plus amount. Exact case-bound cancellation refunds remain independent of the generic RPC. Support no longer sees or reaches the generic refund action. |
| 2026-08-11 | 🟩 | Financial truth changes need their own customer occurrence | The original captured-cancellation implementation intentionally skipped an event when the booking was already Cancelled, but that would prevent a later refund/no-refund/settlement decision from producing the material notification required by D7. Ordinary Confirmed refunds had the same gap. | P5.15, supersedes the earlier P5.11 event note | Every captured-cancellation financial disposition now records a new occurrence, including Cancelled → Cancelled, and ordinary refunds record Confirmed → Confirmed. An AFTER INSERT trigger creates exactly one render-safe outbox intent in the same transaction. Triplover In Progress receives 120-second grace; imported manual, terminal, and financial events are immediate. Recipient expansion and email sending remain disabled until Phase 7. |
| 2026-08-11 | 🟩 | Imported hold safety existed only in writer behavior | The import function created held IMP_EXP rows as On Hold/Unpaid, but no table invariant prevented another writer from persisting an imported On Hold row with captured/refunded money or a charged account. | P6.1 | Added an additive `NOT VALID` row constraint: every new/updated IMP_EXP On Hold row must be Unpaid with no charged account and zero captured/refunded amounts. The owner-confirm transaction may atomically move it to In Progress/Captured. Existing historical rows are neither scanned nor rewritten and will be handled by remediation/constraint validation later. |
| 2026-08-11 | 🟩 | Imported Confirm & Pay lacked durable operational ownership | The existing atomic wallet capture changed only booking compatibility fields, so paid manual ticketing had no durable operation, owned case, SLA, or exact fact-bundle replay guard. | P6.2, P6.3 | The replacement RPC derives stable booking-level operation/ledger identities, captures only User Payable, creates an `awaiting_external_action` operation and assigned Support case, links the booking/event/outbox, and fails closed to reconciliation if a captured replay does not match every committed fact. The due time is the earlier of capture +2 hours or deadline −1 hour, clamped to the capture time when the deadline is close. No supplier API is called. |
| 2026-08-11 | 🟩 | Imported staff Sync must remain non-financial after owner capture | Reusing an import update path after Confirm & Pay could otherwise rewrite captured payment truth or invoke the wallet capture action a second time while staff verifies supplier state. | P6.5, reuses P4.9 | The staff route calls only `sync_impexp_booking_v2`. Support/Admin/Super Admin may read and normalize supplier truth; an exact lifecycle match may enrich the supplier snapshot, while a lifecycle or payment disagreement records deduplicated immutable evidence on the active owned case. Neither path updates wallet accounts, reservations, ledger entries, payment state/amounts, or protected lifecycle truth. The response explicitly reports `walletCharged: false` and exposes any reconciliation case identity. |
| 2026-08-11 | 🟩 | Imported completion needs its own evidence and financial boundary | Airline Manage Booking Sync had normalized ticket data but no completion-grade receipt/identity contract, while the existing ticketed reconciliation RPC is designed to capture an active hold rather than reuse an already captured imported payment. | P6.6 | Sync now stores a payload-hashed five-minute evidence observation that matches provider, supplier reference, passenger identity hashes, route, airline PNR, and exactly one non-empty ticket per stored passenger. A separate Support/Admin/Super Admin action consumes only that observation. The database locks booking → operation → case → captured reservation → wallet → account, proves exactly one matching original capture ledger row, confirms the booking, completes the operation/case, and emits one event/outbox. It updates no wallet balance, reservation, ledger, or payment field; exact request replay returns the committed result. |
| 2026-08-11 | 🟩 | Imported non-ticketed supplier truth needs a durable routing rule | A safe Sync could record evidence but left held, cancelled, expired, unconfirmed, and conflicting results under the same generic manual-ticket state. Staff could not tell whether to continue supplier follow-up, begin financial disposition, or escalate an identity conflict. | P6.7 | The normalized evidence contract now classifies all six outcomes. A service-only idempotent RPC consumes the immutable observation, verifies the captured imported-payment boundary, and updates only the linked operation/case: ticketed → Support completion, held → Support supplier follow-up, cancelled/expired/unconfirmed → Accounts awaiting an explicit financial disposition, and conflicting → critical Admin reconciliation. The customer booking remains In Progress and no booking status, wallet, reservation, ledger, event, or outbox row is mutated. A later fresh observation may safely replace the prior routing while financial disposition is still `none`. |
| 2026-08-11 | 🟩 | Captured imported failures need an imported-specific executable disposition | The generic captured-cancellation engine requires Triplover cancellation evidence and had no reload-safe imported staff workflow. A negative imported Sync could route the case to Accounts but could not yet bind an independently approved refund/settlement decision to the original captured User Payable. | P6.8 | Added an imported-specific proposal and execution contract plus a durable booking-page panel. Fresh authoritative cancelled/expired/unconfirmed evidence can support full refund, partial refund, no refund due, external settlement, or manual adjustment. Every mode is maker-checker; the maker cannot approve. Execution re-proves booking, operation, case, reservation, wallet/account, and exactly one original capture ledger row in the global lock order. Refunds add exactly one idempotent ledger credit; no-refund/external settlement keep retained money explicit without wallet mutation; manual adjustment remains open and cannot auto-close. Successful execution atomically cancels the unfulfilled booking, fails the manual-ticket operation, resolves the case, and emits one occurrence/outbox. |
| 2026-08-11 | 🟩 | Manual-ticket SLA policy needed an executable worker | Confirm & Pay stored the due time and policy, and metrics exposed breaches, but no scheduled action advanced an unassigned or overdue imported manual-ticket case. A paid booking could therefore remain internally generic despite a breached external-action SLA. | P6.9 | Added a bounded service-only escalation worker to the existing protected scheduler. It claims booking serialization roots with `FOR UPDATE SKIP LOCKED`, then locks operation and case. Unassigned cases receive a durable 30-minute warning; at due time the operation becomes `needs_reconciliation` and the case becomes critical Admin work; after 60 overdue minutes it becomes level-2 Super Admin attention. Existing Accounts/approval states are preserved. The worker records no supplier outcome and mutates no booking status, wallet, reservation, ledger, event, or outbox row. |
| 2026-08-11 | 🟩 | Direct confirmed import and wallet capture were one legacy action | The legacy import writer automatically captured User Payable whenever the normalized supplier status was Confirmed, so staff could not explicitly import supplier truth without a debit or prove prior intent for a debit. | P6.10 | Added explicit Import Only and Import & Charge decisions. Import Only creates a Confirmed/Unpaid booking plus an Accounts-owned payment-conflict case and performs no financial mutation. Import & Charge requires and atomically consumes a five-minute, one-use authorization hashed over actor/owner, supplier identity, complete passenger/PNR/ticket evidence, currency, Supplier Gross, and User Payable. The app no longer has execute access to the legacy auto-charge signature; exact request replay reports the committed capture without a second debit. Both authorization and execution are fail-closed audited. |
| 2026-08-12 | 🟩 | Imported commercial amounts needed database-level separation | Supplier Gross and User Payable were separate columns and writer conventions, but no cross-field invariant prevented a later writer from changing User Payable, putting Supplier Gross into the selling snapshot, or creating a mismatched imported reservation/capture ledger row. | P6.11 | Added a `NOT VALID` new-write constraint and enforcement triggers. Imported User Payable and currency are immutable. Selling/payment/capture fields, reservations, and booking-confirm ledger rows must equal User Payable; ledger metadata retains both amounts. Supplier-total/gross snapshot fields must equal Supplier Gross, which remains independently refreshable. Existing historical rows are neither scanned nor rewritten and require later remediation before constraint validation. |
| 2026-08-12 | 🟩 | Runtime customer status values needed an explicit trust boundary | TypeScript declared the seven statuses, but raw database projections and legacy email job rows were trusted by cast/coalescing, so a malformed internal value could bypass the customer vocabulary at runtime. | P7.1 | Added a shared runtime status guard/resolver and routed customer booking detail, list, dashboard summary/activity, and email reads through it. Raw email jobs are filtered to the seven values. Public booking attempts have no status field; public bookings carry only `BookingStatus`; internal operation/case indicators remain optional and staff-role gated. |
| 2026-08-12 | 🟩 | Generic In Progress copy hid the customer-relevant action | Customers saw one broad “supplier operation/reconciliation” sentence even though ticketing, cancellation, imported paid manual ticketing, and read-only supplier verification have different practical meanings; the generic wording also exposed internal workflow language. | P7.2 | Added a pure bounded mapper from private booking facts to four customer-safe semantics and sentences. The public status remains In Progress. Public DTOs carry only the safe sentence, and detail/list/action/email rendering reuse it. Reconciliation/operation/case state names are never returned in the customer explanation. |
| 2026-08-12 | 🟩 | In Progress activity time was actually booking time | The email renderer labeled `bookedAt` as Processing Since, and booking lists had no In Progress lifecycle instant, even though every supported operation persists its actual start/claim time. | P7.3 | Added a public `processingSince` value mapped only from `operation_started_at` while status is In Progress. Detail pages, list lifecycle time, and current email activity use it. There is deliberately no creation/submission fallback; missing historical evidence displays unavailable pending remediation. |
| 2026-08-12 | 🟩 | Lifecycle timestamps needed one exact-fact contract | Timestamp columns existed across booking, operation, case, and event records, but later readers could confuse event persistence with business-effective/observed time, and older runtime writers could omit observation time. | P7.4 | Added a staff-only provenance view for submission, operation claim/call/response/completion, case opening, status effective/observed, issued, cancelled, and deadline facts. New events record their insert-boundary observation time when no authoritative value is supplied. Unknown effective time remains null and is shown as unavailable; no creation/update fallback is used. |
| 2026-08-12 | 🟩 | Short ordinary supplier operations should not spam customers | Ticketing and cancellation can enter and leave In Progress within seconds, while the lifecycle occurrence must remain available for audit and operational history. | P7.5 | Ordinary Triplover ticketing/cancellation In Progress outbox intents use policy version 1 with `available_at` and `grace_expires_at` exactly 120 seconds after enqueue. The event and pending intent remain durable; only delivery eligibility is delayed. Imported manual ticketing and terminal/financial events are unaffected. |
| 2026-08-12 | 🟩 | A terminal result inside grace must replace the intermediate message | Without an atomic supersession link, a fast final result could still leave the delayed In Progress intent eligible and send two customer emails. | P7.6 | The final Confirmed/Cancelled event first creates its immediate outbox intent, then atomically marks only a pending, unexpired In Progress grace intent for the same booking as superseded. The intermediate intent links to the final intent and records its reason/completion; neither event nor intent is deleted. |
| 2026-08-12 | 🟩 | Paid imported manual ticketing is not a transient supplier call | Confirm & Pay captures customer funds and leaves lasting manual work, so delaying its In Progress notice under the ordinary supplier-call grace would hide a meaningful paid state. | P7.7 | The capture transaction snapshots `paymentState: captured` and `operationSource: imported_manual_ticketing` on the occurrence. The outbox policy explicitly bypasses grace for that source, makes the intent immediately eligible, and uses “Payment received; ticketing is being completed.” |
| 2026-08-12 | 🟩 | Booking/status idempotency prevents legitimate re-entry delivery | The legacy ledger’s `(booking_id, lifecycle_status)` key could send a label only once forever and could not isolate a partial failure to one address. | P7.8 | New claims are rooted in the event-backed outbox and return `occurrence_id`. Recipient registration lowercases/trims the address, hashes it in the database, and relies on `(outbox_id, channel, recipient_address_hash)` uniqueness. Exact registration replay returns the same row; concurrent outbox workers use `FOR UPDATE SKIP LOCKED`. |
| 2026-08-12 | 🟩 | Re-entry needs a materiality rule, not blanket repeat or blanket dedupe | A customer should hear when a booking genuinely returns to an actionable/attention state, but same-state bookkeeping and historical repair should not send repeated messages. | P7.9 | Cross-status entry into On Hold, Pending, In Progress, Expired, or Unconfirmed creates a new send/grace occurrence. Same-status non-terminal events become completed suppressed outbox evidence. Audit-only suppression is fail-closed to four approved reasons; terminal same-status financial outcomes remain material under D7. |
| 2026-08-12 | 🟩 | Delayed/retried rendering could drift to newer booking truth | The old worker loaded the current booking row for an older status job, so later ticket, payment, deadline, profile, or passenger edits could change what that historical occurrence said. | P7.10 | A BEFORE-outbox trigger snapshots versioned public status/payment/operation time, itinerary/fares, tickets, safe business header, and only the seven passenger fields rendered in email. Recipient/contact and passport fields are excluded. The renderer validates status/version and uses no database read. Unrenderable schema-first window intents are retained as suppressed evidence rather than guessed. |
| 2026-08-12 | 🟩 | A recipient retry must not resend to a successful address | The legacy worker sent all addresses as one booking/status job, so one failure could replay the whole set and it could also pick up a newly changed profile address on retry. | P7.11 | First expansion registers and freezes the visible recipient set. Each address has its own claim token, attempt count, stored render, sent/retry/dead-letter state, and stable occurrence message identity. Finalization requeues the outbox only while a recipient remains pending/retry; the claim query never selects `sent`. The application no longer calls the legacy queue/claim/mark functions. |
| 2026-08-12 | 🟩 | The required archive copy must remain hidden after per-recipient cutover | Moving from a multi-recipient legacy call to independent visible deliveries could accidentally expose the system archive address in recipient data or email content, or omit it entirely. | P7.12 | The occurrence sender still calls the central mailer. Its public message type has no BCC input; the mailer injects the fixed system address only into the SMTP envelope. Snapshot/render/worker code contains no archive identity, and visible claims explicitly exclude hidden-copy rows. |
| 2026-08-12 | 🟩 | Occurrence delivery needs bounded recovery and actionable health signals | A worker can lose its response after claiming an outbox or recipient, and repeated transport failures must not create an unbounded hot loop or disappear silently. Metrics must not expose recipient addresses. | P7.13 | Retry delays are bounded from one minute through 24 hours, stale claims recover after 15 minutes, exhausted outboxes and recipients receive durable dead-letter timestamps, and un-escalated dead letters are explicitly stamped for staff attention. The service-only metrics view reports address-free queue, retry, suppression, supersession, dead-letter, and oldest-age signals. |
| 2026-08-12 | 🟩 | Expiry scans need an index whose predicate matches actionable booking truth | Ordering every historical On Hold row by mutable `updated_at` causes oldest-row starvation and cannot efficiently isolate deadlines that may produce Expired. | P8.1 | Added a partial index ordered by authoritative deadline then stable booking ID. It contains only non-legacy stored On Hold rows with nonempty airline PNR/deadline facts and no active operation pointer or compatibility operation kind. Booking creation/update timestamps are not part of the scan key. |
| 2026-08-12 | 🟩 | Eligibility must be resolved before limiting the expiry batch | The legacy sweep limited the oldest 500 stored On Hold rows and only then resolved lifecycle state, allowing ineligible/already-observed rows to starve every later due deadline. | P8.2 | The candidate CTE now requires a due deadline, active/no-operation state, and a latest lifecycle occurrence other than Expired before ordering and limiting. It inserts only a deadline-effective Expired occurrence with a deterministic deadline-derived key; broad lifecycle resolution and `updated_at` ordering are absent. |
| 2026-08-12 | 🟩 | A bounded worker needs a stable continuation key | Offset pagination and restarting the same oldest-row scan waste work and can starve later deadlines as the eligible set changes. | P8.3 | The versioned batch RPC accepts deadline and booking ID together, applies lexicographic tuple comparison in index order, and returns the last examined composite key plus selected/inserted counts. It contains no offset or mutable audit-time ordering; a new scheduler run may safely restart from the head because observed occurrences leave the eligible set. |
| 2026-08-12 | 🟩 | Concurrent expiry workers must divide work without claiming a lifecycle by update | Two schedulers can overlap, but updating a booking merely to claim a derived observation would alter authoritative/audit state and add write pressure. | P8.4 | The ordered candidate query locks only selected `flight_bookings` roots and uses `SKIP LOCKED`, so another worker moves to later eligible keys. Event uniqueness remains a final replay guard. The function contains no booking update. |
| 2026-08-12 | 🟩 | The scheduler must drain backlog without consuming the whole request lifetime | One fixed batch leaves avoidable backlog, while an unbounded loop can overrun the shared protected endpoint and prevent notification/watchdog work from completing. | P8.5 | The application loops 250-row batches with a 20-batch cap, a 10-second expiry budget, and a 500 ms pre-deadline margin. It stops explicitly on drain, budget, cap, RPC error, or a non-advancing cursor and returns batch/row/duration evidence. |
| 2026-08-12 | 🟩 | Cursor progress and worker outcomes need durable evidence without becoming a permanent skip watermark | An application-only cursor disappears on timeout/response loss, but a global deadline high-water mark can permanently skip a newly corrected earlier deadline. | P8.6 | Each bounded scheduler invocation starts a durable run at the index head. The run row is locked around each batch; lifecycle event/outbox insertion and run cursor/count advancement commit together. Final state records drain/budget/cap/error. The cursor is deliberately scoped to that run, and the next invocation restarts at the head after observed rows have left eligibility. |
| 2026-08-12 | 🟩 | Unconfirmed should be observed at authoritative write boundaries, not discovered primarily by a broad poll | Airline-PNR absence is known when a booking is created or supplier/import data is synchronized. A sweep should recover missed history, not be the ordinary source of customer state. | P8.7 | The existing creation and PNR Sync transactions remain primary event writers, and imported Sync now ensures the same transition event. A partial-ID-indexed, `SKIP LOCKED`, 50-row backstop records only a missing current occurrence, marks it audit-only with an approved repair reason, and never changes `flight_bookings.status`. |
| 2026-08-12 | 🟩 | Derived expiry history and customer intent must commit as one occurrence | A separately enqueued notification can be lost after the event commits or duplicated when a scheduler response is lost. | P8.8 | The expiry batch inserts one deterministic deadline-effective lifecycle event. The established AFTER INSERT event trigger creates its occurrence outbox in that same database transaction and keys it by lifecycle event plus notification kind. The application scheduler performs no enqueue write. |
| 2026-08-12 | 🟩 | Derived observation health needs identity-free backlog and latency signals | Counts of inserted events alone cannot show a starved due row, slow detection, a failed/bounded worker, or missed Unconfirmed primary-path history. | P8.9 | A service-only aggregate view reports due/oldest/max-overdue expiry backlog, a >30-minute starvation count, Unconfirmed repair backlog, 24-hour average/p95/max detection latency, failed/bounded/stale runs, and last-run success/outcome. The staff health panel exposes the actionable counts; the view contains no booking/customer/recipient identity. |
| 2026-08-12 | 🟩 | The shared protected scheduler needs a global budget in addition to bounded SQL batches | Sequential watchdog, escalation, observation, recovery, and SMTP work can each be locally bounded yet collectively exceed the hosting limit; preclaiming many email jobs near timeout would strand them. | P8.10 | The route keeps the approved bearer-protected 15-minute schedule, budgets 105 of 120 seconds, time-gates every step, and reports skips/failures. Scheduled delivery claims one outbox and one visible recipient at a time with a transport-aware safety margin. Stable event/message identities and database claims make replay safe. |
| 2026-08-12 | 🟩 | Historical remediation needs a protected evidence boundary before any write | The affected rows contain passenger, supplier, identity, and wallet details that cannot be copied into logs or the working-memory document, but before/after integrity still needs a stable reference. | P9.1 | A read-only script selected the known anomaly classes and wrote full affected booking/attempt/financial/event/delivery rows to a mode-0600-where-supported artifact under git-ignored `backups/`. The snapshot and each table are SHA-256 identified; console evidence contains counts/hashes only. Production mutations were zero. |
| 2026-08-12 | 🟩 | One booking may legitimately own more than one distinct historical anomaly case | The nine affected bookings include one Cancelled/Captured row that also lacks an authoritative cancellation timestamp; collapsing these into one generic case would lose separate evidence and resolution requirements. | P9.2 | Snapshot projection through migration `0044` yields ten unique booking subject/type keys plus one attempt key: two cancellation-uncertainty, one legacy-review, four historical-timestamp, two imported-payment, one terminal-conflict, and one attempt-uncertainty case. Partial unique indexes enforce one unresolved case per subject/type; replay is `ON CONFLICT DO NOTHING`. |
| 2026-08-12 | 🟩 | Snapshot classification must fail closed when current evidence is incomplete | Stored terminal/payment facts can classify some subjects, but active reconciliation and an unresolved attempt cannot be upgraded to held/ticketed/cancelled truth without fresh supplier evidence. | P9.3 | The protected local classifier validates reservation/capture-ledger equations first, then requires ticket evidence for ticketed classes. It classifies 2 ticketed/unpaid, 3 cancelled/unpaid, 1 cancelled/captured, and 4 unknown; no held/paid or wallet-ledger mismatch is invented. Subject identifiers remain only in the git-ignored manifest. |
| 2026-08-12 | 🟥 | Live remediation cannot precede the complete protected workflow rollout | The three active In Progress subjects need deployed staff evidence actions, five-minute supplier receipts, role checks, and maker-checker execution. At discovery time the additive database model and owned cases were live, but the application release and independent human decisions were not. | P9.4–P9.11, P12 | The application and all independent rollout families are now live and verified through P12.9. The gate remains red only for fresh case-specific evidence and execution by two different authorized human staff identities. Do not use ad hoc SQL or reuse the stale snapshot as decision evidence. |
| 2026-08-12 01:21 +06:00 | 🟩 | Linked migration boundary was recoverable | The first authorized push committed `0043`–`0066`, then PostgreSQL rejected the still-unapplied `0067` function because `authorization` was parsed as syntax in a row alias. | P12.4 | Confirmed linked history before retry, renamed only the two aliases to `auth_row`, reran the Phase 6 gate and a suffix-only dry run, then applied `0067`–`0081`. No partial `0067` objects or ad hoc repair were used. |
| 2026-08-12 01:24 +06:00 | 🟩 | Restricted function search path exposed one notification hash error | Post-deployment lint found that `register_booking_notification_delivery_v1` could not resolve unqualified `digest` with `search_path = public`. | P7.11, P12.4 | Added forward migration `0082` using built-in `sha256(convert_to(..., 'UTF8'))`, passed the recipient/Phase 7 gates, applied it alone, and confirmed live lint has zero errors. Seven unused-variable/parameter warnings remain non-functional cleanup. |
| 2026-08-12 01:28 +06:00 | 🟩 | Additive rollout preserved protected production truth | A service-role read-only comparison against the protected snapshot found every snapshotted old-schema field unchanged across 9 bookings, 10 attempts, 1 reservation/account/wallet, 4 ledger rows, 15 lifecycle events, and 15 legacy delivery rows. | P9.1–P9.3, P12.4, P12.11 | All 11 projected cases exist exactly once and remain unresolved/owned. New outbox and recipient-delivery counts are both zero, all three aggregate metrics views are readable, and anonymous case-table access is denied. |
| 2026-08-12 02:04 +06:00 | 🟩 | Production behavior cannot be called incremental while the scheduler is bundled | Production has `CRON_SECRET`, but Preview intentionally does not. The first candidate scheduler invoked operation and attempt watchdogs, imported-task escalation, scalable observation, repair, notification recovery/delivery, and dead-letter escalation from one authorized request with no independent rollout switches. | P12.6–P12.9 | Added six exact-`true`, server-only switches. Operation/attempt workers, imported escalation, staff reconciliation actions, imported manual actions, outbox delivery, and scalable sweep can now be enabled independently; the false scalable flag retains the bounded compatibility observer. Replacement Preview and 72-verifier release gate pass with all switches absent/false. |
| 2026-08-12 02:12 +06:00 | 🟩 | Production application promotion remains an external behavior boundary | The candidate was technically staged and fail-closed, but promoting it changed live customer/staff request handling and production has an active scheduler secret. Fresh evidence and maker-checker work additionally require real authorized staff identities and judgment. | P9.4–P9.11, P12.6–P12.13 | The user explicitly authorized rollout continuation. Commit `95c12aa` was promoted first with all six controls false, then each family was enabled on a separate deployment/invariant gate through final deployment `dpl_2eTXQxzp4msNuX7fB5H6XoJXiJzr`. No supplier read, case decision, wallet mutation, or test email substituted for staff verification. |
| 2026-08-12 03:31 +06:00 | 🟥 | Historical remediation is a human authority and evidence gate, not an automation task | All 11 owned cases are open; none has evidence fresh within five minutes, a proposal, an independent approval, or a resolution. Outcomes include supplier truth, terminal correction, refund/fee/settlement, and attempt uncertainty that require case-specific judgment. | P9.4–P9.8, P9.10–P9.11, P12.10 | Two different authorized staff members must acquire/review fresh supplier or portal evidence, propose an allowed outcome, and independently approve it through the deployed UI/API. The agent must not impersonate actors, choose financial outcomes, or bypass maker-checker. After staff batches, rerun the protected audit and preserve before/after evidence. |
| 2026-08-12 03:38 +06:00 | 🟥 | Legacy retirement cannot collapse the compatibility or human-remediation windows | The approved recovery plan retains old wrappers/fields for at least two stable production releases after cutover, and unresolved historical cases still depend on the protected model and rollback evidence. | P10.1–P10.8 | Do not validate/drop destructive final constraints, revoke compatibility writers, remove wrappers/fields, or retire legacy delivery claiming until remediation is complete, two stable application releases have elapsed, and a separate rollback rehearsal passes. Current additive objects remain safe and live. |
| 2026-08-12 03:38 +06:00 | 🟥 | Temporary control-file deletion requires explicit final approval | “Continue remaining steps” authorized implementation and production rollout, but did not explicitly authorize deletion of the end-of-project control record. The file also still contains open human and compatibility gates. | P12.13, definition of done | Preserve the tracked file. Ask for deletion approval only at final handoff after staff remediation/compatibility completion; do not interpret general continuation authority as permission to delete project evidence. |
| 2026-08-12 09:29 +06:00 | 🟥 | Post-remediation verification cannot be manufactured before an authorized batch | The current protected snapshot, release suite, wallet boundary, case aggregate, worker health, and notification metrics provide a valid read-only before baseline, but all 11 cases still lack a proposal, approval, and resolution. There is therefore no truthful after state or approver history to compare. | P9.10–P9.11, P12.10 | Preserve the current snapshot and audit rows. After each real human maker-checker batch, rerun the same non-mutating release/protected/wallet/notification gates and record the case-bound approver audit. Do not mark these steps complete from a pre-batch check. |
| 2026-08-12 10:26 +06:00 | 🟥 | Real Direct Ticket success can fail before the local finalizer | Attempt `06fac0c2` has a durable Book boundary and HTTP 200 response, but the adapter raised `Triplover Book returned no bookingCodeRef.` before returning a supplier outcome. Consequently `create_booking_from_attempt_v2` and wallet capture were never invoked; there was no failed STR transaction to replay. | F10, P9.12 | Treat this as an integration-contract variant plus missing response-recovery data, not a database allocation failure. Preserve the attempt/case/hold, prohibit Book/NewTicket replay, and do not invent missing supplier identifiers. |
| 2026-08-12 10:26 +06:00 | 🟥 | Attempt uncertainty is contained but not executable through booking reconciliation | The attempt queue correctly exposes a safe AirTicketingDetails-first plan and protects the reservation. However, all deployed evidence/proposal/decision routes require an STR/booking, the shared resolution contract locks `flight_bookings`, and the ticketed resolver requires `reservation.booking_id = p_booking_id`. | I16, P4.11, P5.16, T40 | Add a distinct attempt-subject maker-checker contract. Only a fresh complete identity-matching result may atomically create one booking/STR and capture the already-debited hold once; incomplete `6E` identifier evidence remains held/open. |
| 2026-08-12 | 🟨 | Direct Ticket recovery must not be implemented as a special-case row repair | The incident crosses supplier response interpretation, missing local booking identity, held wallet funds, case authority, downstream supplier-reference requirements, and replay behavior. Fixing only the adapter or adding a one-off SQL function would retain partial-finalization and future no-STR failure modes. | D11, P3.12, P4.11, P5.16, P5.17, T40–T42 | Proposed a versioned evidence-profile contract, durable normalized response ledger, atomic normal finalizer, positive-incomplete In Progress materializer, separate attempt-subject maker-checker resolver, additive migrations, capability-aware downstream handling, staged flags, and exact current-case runbook. This is design only and remains pending approval. |

---

# Verification evidence

Record commands, test names, migration dry runs, deployment identifiers, metric
snapshots, and concise results here as phases are completed. Never store secrets,
passenger PII, authentication tokens, or raw sensitive supplier payloads.

| Phase/step | Date/time | Verification | Result | Notes |
| --- | --- | --- | --- | --- |
| P0.0 | Plan creation | File created and requirements organized | 🟩 | No implementation or external mutation performed. |
| P0.1 | 2026-08-11 | User approval received | 🟩 | User said “proceed please”; implementation authorization recorded. |
| P0.2 | 2026-08-11 | `git branch -vv`; graph/divergence check; `git switch development`; `git merge --ff-only main` | 🟩 | Development baseline includes all three newer main commits and is three commits ahead of `origin/development`; lifecycle work remains uncommitted. |
| P0.3 | 2026-08-11 | Instruction-file search, root inventory, `git status --short --branch`, and diff inspection | 🟩 | No repository-specific agent instructions and no unrelated dirty changes; only `docs/TEMP-BOOKING-LIFECYCLE-IMPLEMENTATION.md` is untracked. |
| P0.4 | 2026-08-11 | `supabase migration list --linked`; `supabase db lint --linked`; `supabase db push --linked --dry-run` | 🟩 | Local/remote migrations match through `0042`; no schema lint findings; remote is up to date and dry run would push nothing. |
| P0.4 | 2026-08-11 | `npm run typecheck`; lint; production build | 🟩 | TypeScript, ESLint, and Next.js 16.2.11 production build pass. |
| P0.4 | 2026-08-11 | Booking lifecycle/email/PNR/security/wallet/import verification scripts | 🟨 | All selected checks pass except pre-existing `verify:booking-step3` deadline mismatch recorded as F9. This is baseline evidence, not a Phase 0 repair. |
| P0.5 | 2026-08-11 | Service-role read-only PostgREST/RPC aggregate queries | 🟩 | Counts recorded for lifecycle/stored status, operation metadata, attempts, wallet reservations/ledger, events, deliveries, queue health, and anomalies; no row-level sensitive data retained and no mutations performed. |
| P0.6 | 2026-08-11 | Rollback/recovery strategy review against all implementation phases | 🟩 | Every phase has an application/database recovery checkpoint; financial/history rollback requires immutable compensating outcomes rather than direct mutation. |
| P0.7 | 2026-08-11 | Current role model, Triplover 110-second timeout, 120-second route limits, and approved design reviewed against D1–D10 | 🟩 | All blocking policy inputs for additive Phase 1 schema are resolved; no database or application behavior changed. |
| P1.1 | 2026-08-11 | Static required-field/FK check and linked migration inventory | 🟩 | `booking_operations` is additive with request, actor/source, prior-state, supplier identity/evidence, policy, and authoritative timestamp fields; migration `0043` is local-only. |
| P1.2 | 2026-08-11 | Exact operation-kind constraint check | 🟩 | Only `ticketing`, `cancellation`, and `imported_manual_ticketing` are accepted by the new internal operation model. |
| P1.3 | 2026-08-11 | Exact operation-state constraint check | 🟩 | Operation states cover claimed, supplier-call-started, awaiting-external-action, needs-reconciliation, succeeded, and failed. |
| P1.4 | 2026-08-11 | Partial unique-index structural check | 🟩 | At most one claimed/supplier-call/awaiting-external/reconciliation operation can exist per booking. |
| P1.5 | 2026-08-11 | Nullable column and `NOT VALID` FK structural check | 🟩 | `flight_bookings.active_operation_id` is backward-compatible and references the additive operation table without changing existing rows. |
| P1.6 | 2026-08-11 | Destructive-SQL guard plus compatibility-contract check | 🟩 | Existing operation fields remain untouched; backfill, dual-write, read fallback, disagreement, and two-release retirement rules are recorded. |
| P1.7 | 2026-08-11 | Reconciliation subject-table structural check | 🟩 | Each case references exactly one booking or booking attempt and may reference its operation; all deletes are restricted. |
| P1.8 | 2026-08-11 | Exact reconciliation case-type constraint check | 🟩 | Ticketing, cancellation, legacy, terminal, direct-payment, imported manual/payment, attempt, and historical cases are represented explicitly. |
| P1.9 | 2026-08-11 | Exact reconciliation case-state constraint check | 🟩 | Open, assigned, supplier/finance/approval waits, resolved, and closed-no-change states are explicit. |
| P1.10 | 2026-08-11 | Required reconciliation control-field check | 🟩 | Team/assignee, severity/priority, due/escalation, evidence version, proposal/approval/rejection, resolution, and optimistic version fields are present. |
| P1.11 | 2026-08-11 | Exact financial-disposition and supporting-field check | 🟩 | None, hold capture/release, full/partial/no refund, external settlement, and manual-adjustment-required are explicit with amount/currency/reference fields. |
| P1.12 | 2026-08-11 | Booking- and attempt-subject partial unique-index checks | 🟩 | One unresolved case per subject/case type is enforced while permitting a later new occurrence after resolution. |
| P1.13 | 2026-08-11 | Event extension/FK/occurrence-identity structural check | 🟩 | Events can link operation/case, identify each occurrence, distinguish effective/observed time, and retain a versioned render-safe snapshot. |
| P1.14 | 2026-08-11 | Outbox event/FK/idempotency/state/policy structural check | 🟩 | One booking-status outbox record per lifecycle event carries the event snapshot, grace/suppression policy, claim/retry/dead-letter state, and supersession link. |
| P1.15 | 2026-08-11 | Recipient identity/idempotency/hidden-copy/retry-state structural check | 🟩 | Each email address has an independent durable outcome per outbox event; hidden system copy is explicit internally and duplicate addresses are suppressed by hash. |
| P1.16 | 2026-08-11 | Legacy-delivery destructive-SQL guard and compatibility-contract check | 🟩 | Existing delivery rows/RPCs remain untouched; Phase 1 creates no outbox jobs or emails and future baseline conversion is non-send only. |
| P1.17 | 2026-08-11 | Safety-constraint inventory and historical `NOT VALID` staging check | 🟩 | Payload hashes, state/timestamp shapes, team/severity, maker-checker, financial detail, snapshots, claims, attempts, hidden-copy, and completion invariants are constrained; historical FKs/checks are staged safely. |
| P1.18 | 2026-08-11 | Required operational-index inventory check | 🟩 | Request replay, active/watchdog/external operations, open/due cases, event occurrence/timeline, outbox claims, and per-recipient claims have targeted indexes. |
| P1.19 | 2026-08-11 | Forbidden public-resolver/view/status SQL guard | 🟩 | Migration `0043` does not change the resolver, lifecycle view, status column, precedence, or public DTO contract. |
| P1.20 | 2026-08-11 | RLS/revoke/grant/delete-denial/comment inventory check | 🟩 | All new tables enable RLS, deny public/anonymous/authenticated access, grant service role only select/insert/update, and document security/compatibility semantics. |
| P1 gate | 2026-08-11 | `supabase db push --linked --dry-run` | 🟩 | Remote dry run lists only migration `0043`; nothing was pushed or applied. |
| P1 gate | 2026-08-11 | Isolated PGlite migration replay through `0041`, then `0043`; current linked `supabase db lint` | 🟩 | `0043` executes successfully on an isolated PostgreSQL-compatible engine and creates all four new tables/constraints. Data-only assertion migrations `0036`/`0039` and the production scheduler `0042` were intentionally excluded; linked current schema has no lint findings. |
| P1 gate | 2026-08-11 | Typecheck, ESLint, production build, lifecycle/email/PNR/security/wallet/import verifiers | 🟩 | All checks that were green at baseline remain green. The pre-existing `verify:booking-step3` F9 deadline mismatch reproduces unchanged and is not caused by `0043`. |
| P1 gate | 2026-08-11 | Isolated pre/post-`0043` `pg_get_viewdef`, resolver definition, and view-column comparison | 🟩 | Lifecycle view definition, resolver function definition, and all 73 lifecycle-view columns are byte-equivalent before/after the additive migration. |
| P1 gate | 2026-08-11 | Linked migration inventory, normal PostgREST table probes, lifecycle aggregate, email pending-job query, and worktree check | 🟩 | `0043` has no remote migration version; all four new tables are absent from production; 72 booking lifecycle counts remain 4/0/3/22/21/0/22 and pending email jobs remain 0. Only the temporary plan and local migration are untracked. |
| P1.21 | 2026-08-11 | Provenance-field/constraint static check and isolated full `0043` replay | 🟩 | Operation reason and case reason/source/opener/time exist with constraints/comments; all six expected columns are queryable and the lifecycle view remains unchanged. |
| P2.1 | 2026-08-11 | Isolated synthetic cancellation-reconciliation backfill replayed twice with pre/post booking-row comparison | 🟩 | Exactly one cancellation operation is created in `needs_reconciliation`; true supplier-call start remains null; every existing booking/status/payment/operation/timestamp field is byte-unchanged. |
| P2.2 | 2026-08-11 | Isolated `0044` replay twice with unresolved-operation fixture and case classifier assertions | 🟩 | One Support-owned high-severity cancellation-uncertainty case is created and deduplicated; booking lifecycle/payment/operation timestamps remain unchanged. Migration also contains bounded classifiers for aged attempts and objective timestamp/payment contradictions. |
| P2.3 | 2026-08-11 | Isolated legacy-reconciliation fixture | 🟩 | Backfill creates zero operations and one `legacy_review` case with null operation ID and explicit `supplierEvidenceInvented: false`. |
| P2.4 | 2026-08-11 | Isolated full migration replay, synthetic cancellation-reconciliation fixture, permission/column review, and linked migration dry run | 🟩 | The 63-column staff-only view reports public/stored status, cancellation operation in `needs_reconciliation`, one cancellation-uncertainty case, stale evidence, and staff attention correctly. Passenger/contact/raw evidence/proposal/recipient fields are absent; anonymous/authenticated grants are revoked. Dry run lists only local `0043` and `0044`; neither was applied. |
| P2.5 | 2026-08-11 | Customer type/serializer, booking-status API, booking page, checkout response, and dashboard list serializer trace | 🟩 | `PublicBooking` remains the existing explicit seven-status allowlist; `publicBooking()` and list-row conversion construct explicit objects without spreading database rows. New operation/case/pointer/evidence/SLA fields are absent, and customer APIs/pages continue to use the restricted serializers. Internal `BookingRow` remains server-only. |
| P2.6 | 2026-08-11 | TypeScript/ESLint plus pure role/masking assertions across Admin, Support, Accounts, Customer, B2B, and Media roles | 🟩 | The staff-only GET route and explicit normalized DTO compile cleanly. Customer/B2B/Media roles fail closed; Support receives operational detail without monetary amounts; Accounts receives monetary/financial disposition without operational narrative/actor detail; Admin receives both. Raw evidence, passenger/contact, proposal, and recipient fields are structurally absent. |
| P2.7 | 2026-08-11 | TypeScript/ESLint and staff/customer data-flow review | 🟩 | Staff booking rows now render operation kind/state/elapsed time, reconciliation type, team/assignee, due/overdue, evidence freshness, terminal attention, and payment-conflict indicators on desktop and mobile. The normalized indicator is attached only for authorized staff roles; customer/B2B DTOs remain unchanged, and schema-unavailable rollout failures degrade to the original booking list. |
| P2.8 | 2026-08-11 | TypeScript/ESLint plus mocked event/operation/case query and role-masking assertions | 🟩 | The staff booking detail renders a read-only merged timeline and a separately authorized API. Support receives operational narrative/actor facts without financial disposition/amount; Accounts receives financial facts without narrative/actor facts. Raw supplier evidence, event snapshots, case evidence, proposals, resolution payloads, and error messages are not selected or serialized. Customer booking details remain unchanged and staged-rollout failures degrade safely. |
| P2.9 | 2026-08-11 | Isolated migration replay, exact six-anomaly fixture, TypeScript/ESLint, and aggregate DTO/UI/API review | 🟩 | The staff-only metrics view and dashboard report open cases, aged operations, aged attempts, SLA breaches, terminal conflicts, and wallet inconsistencies. A fixture containing exactly one of each produced six counts of one. The view returns only aggregate counts/oldest timestamps; authorized staff routes fail closed and rollout failures do not break the booking list. |
| P2.10 | 2026-08-11 | Live `verify:booking-step3`, `verify:pnr-deadline`, and booking-lifecycle verifier | 🟩 | All 72 business bookings and 63 stored deadline rows pass. Regression fixtures prove BS PNR slash dates use `MM/DD/YYYY`, non-BS PNR slash dates remain `DD/MM/YYYY`, and the separate Booking-response rule remains unchanged. No production parser or booking record was changed. |
| P2 gate | 2026-08-11 | Isolated production-shaped anomaly fixture with `0044` replayed twice | 🟩 | Two cancellation uncertainties, one legacy review, four missing-cancellation-timestamp cases, one terminal financial conflict, two imported payment conflicts, and one aged attempt produced exactly the expected 11 owned cases and nine booking queue rows. Only two trustworthy cancellation operations were created; no legacy operation/evidence was invented and replay created no duplicates. |
| P2 gate | 2026-08-11 | Production build, full ESLint/typecheck, booking lifecycle/observability/email/PNR/wallet/IMP-EXP verifiers | 🟩 | All checks pass; new staff APIs are present in the production route manifest. The durable observability verifier enforces replay safety, role masks, customer isolation, required indicators, and all six health metrics. |
| P2 gate | 2026-08-11 | Linked schema lint, migration inventory, and `db push --dry-run` | 🟩 | Current production schema has no lint findings and remains at `0042`. Dry run lists local `0043` and `0044` only; neither migration, backfill, staff view, API behavior, email, or database record was applied to production. |
| P3.1 | 2026-08-11 | TypeScript/ESLint and canonical operation-request verifier | 🟩 | Book, NewTicket, and Cancel derive opaque server-side request keys from stable retry nonces. Canonical payload order is stable; a changed payload retains the same request key but changes its SHA-256 binding. Raw client request UUIDs are no longer passed to destructive workflow RPCs. |
| P3.2 | 2026-08-11 | Isolated `0045` replay/result/mismatch fixture | 🟩 | The first request key creates one operation; an exact replay returns the existing terminal state and stored result. The same key with a changed payload raises `22023`; no duplicate operation is created. Active same-key replays are returned as non-retriable/in-progress rather than calling the supplier again. |
| P3.3 | 2026-08-11 | Isolated cancellation and wallet-backed ticketing claim fixtures plus TypeScript/ESLint | 🟩 | Cancellation operation/status/pointer/event commit atomically and block a competing Issue claim. Ticketing operation/status/pointer/event and the wallet hold/reservation/ledger commit atomically; exact replay leaves balances and row counts unchanged. Versioned app wrappers pass the server key plus payload hash and never call the supplier on an active replay. |
| P3.4 | 2026-08-11 | Transport-order verifier, TypeScript/ESLint, and isolated operation/attempt boundary fixture | 🟩 | Authentication completes before the start hook; the hook persists the one-way start immediately before destructive HTTP; complete response receipt is persisted before interpretation. NewTicket/Cancel operations and Book attempts preserve start/response ordering, store normalized HTTP metadata only, and reject a replayed start so it cannot authorize another supplier call. Attempt state remains internal and creates no public status. |
| P3.5 | 2026-08-11 | Isolated full-migration fixtures for ticketing capture, definitive ticket failure, cancellation success/refusal, compatibility manual issue, Book conversion, local-finalization failure, and terminal replay | 🟩 | Response receipt is required before finalization. Booking, wallet/reservation/ledger, operation terminal state, active pointer, and final lifecycle event commit together. Exact replay does not move money or duplicate a booking. Local finalization failure preserves funds and immediately creates one owned 30-minute-SLA case. Committed success/failure can be recovered after a lost database response. |
| P3.5 | 2026-08-11 | Production build, full ESLint/typecheck, operation/wallet/lifecycle/observability/email/PNR/Step-3 verifiers, and `git diff --check` | 🟩 | All checks pass after making the legacy wallet verifier version-aware. US-Bangla remains carrier-aware (`MM/DD/YYYY`) while other PNR deadlines remain `DD/MM/YYYY`; no production migration, record, wallet, email, commit, push, or deployment was performed. |
| P3.6 | 2026-08-11 | Isolated stale supplier-call, stale pre-call claim, and fresh-operation fixture replayed twice | 🟩 | The two stale operations moved once to `needs_reconciliation`, retained their active pointers, created one Support-owned high-severity 30-minute-SLA case each, and recorded Admin-level escalation. The fresh operation was untouched; wallet balances and immutable ledger count did not change; no supplier call or replay exists in the watchdog. |
| P3.6 | 2026-08-11 | Operation/wallet verifiers, TypeScript/focused ESLint, and production build | 🟩 | The bounded `FOR UPDATE SKIP LOCKED` RPC, claim/call indexes, migration-only normalized evidence, and protected scheduler integration pass. The scheduler response exposes watchdog health without preventing the legacy email/derived-status work during rolling schema availability. |
| P3.7 | 2026-08-11 | Isolated identified submitting/unknown, pre-call, direct-ticket-hold, fresh-attempt, and historical-null-identity fixture replayed twice | 🟩 | Three stale operation-identified attempts moved once to internal `unknown` and one `attempt_uncertainty` case each, with a 15-minute Support due time. The direct-ticket hold moved to reconciliation without changing balances or ledger; fresh attempts were untouched. The known historical null-identity attempt class remains `submitting` and unmodified for approved remediation later. |
| P3.7 | 2026-08-11 | Atomic claim/start static verifier, operation/wallet/lifecycle verifiers, TypeScript/focused ESLint, and production build | 🟩 | New Book attempts persist payload-bound identity in the same conditional update that claims `draft → submitting`. The before-HTTP boundary advances that preclaimed identity exactly once. Both watchdogs are bounded, `SKIP LOCKED`, scheduler-visible, and contain no supplier write/replay path. |
| P3.8 | 2026-08-11 | Public DTO/serializer/polling-route static assertions, booking-operation/lifecycle verifiers, TypeScript/focused ESLint, and production build | 🟩 | The customer attempt DTO and explicit serializer expose neither `state` nor `status`; the polling contract uses neutral `ready`, `processing`, and `booking-created` phases instead of internal attempt states or the public `Pending` label. The attempt watchdog creates no booking or lifecycle-status event, while the public allowlist remains exactly seven statuses. |
| P3.9 | 2026-08-11 | Isolated three-strategy PostgreSQL-compatible queue fixture plus durable role/security/read-plan verifier | 🟩 | PNR-complete attempts select PNR then AirTicketingDetails; unique-transaction-only attempts select AirTicketingDetails then the supplier portal; missing-identity historical attempts require the portal. All rows forbid destructive replay and automatic resolution, create no public booking/status, and preserve reconciliation wallet state. |
| P3.9 | 2026-08-11 | TypeScript/focused ESLint, operation/observability/lifecycle/wallet verifiers, production build, and diff whitespace check | 🟩 | Staff-only read API and dashboard queue pass. Support/Admin can see supplier identity but Support cannot see amounts; Accounts can see financial details but not supplier identity/narrative. Passenger/contact/raw evidence/request keys are absent; rolling schema absence degrades without breaking the booking list. |
| P3.10 | 2026-08-11 | Fourteen-case centralized supplier-write classifier verifier across Book/NewTicket/Cancel | 🟩 | Boundary persistence failure before HTTP, pre-write config/auth/network, post-write network, protocol, incomplete response, HTTP-200 supplier error, 5xx, explicit rejection, auth rejection, and unexpected mapper failure all produce the approved `not-sent`, `definitive-failure`, or `uncertain` result. Only uncertain outcomes require protected funds; automatic replay is false for every class. |
| P3.10 | 2026-08-11 | TypeScript/focused ESLint, booking-operation/lifecycle/wallet verifiers, production build, and diff whitespace check | 🟩 | All destructive routes consume the same boundary tracker/classifier and no longer contain local unknown-outcome predicates. The tracker distinguishes call-start, complete-response observation, and durable response recording without exposing raw supplier payloads. |
| P3.11 | 2026-08-11 | Isolated booking-operation/attempt uncertainty fixture with exact replay, later distinct observation, and mutation attempts | 🟩 | Exact replay produced one open case and one observation; a later read occurrence appended to the same case; booking operation moved to `needs_reconciliation`, attempt moved to internal `unknown`, wallet protection was retained, and observation update/delete raised immutable-ledger errors. |
| P3.11 | 2026-08-11 | Durable observation verifier, full ESLint/typecheck, all Phase 3/lifecycle/observability/wallet/email/PNR/Step-3 verifiers, production build, and diff check | 🟩 | Book/NewTicket/Cancel atomically own ambiguous outcomes and retry the database write idempotently. All regression checks pass, including BS `MM/DD/YYYY` and other-carrier `DD/MM/YYYY` deadline rules. |
| P3 gate | 2026-08-11 | Claim/watchdog/failure-injection/attempt-isolation fixtures and Phase 3 durable verifiers | 🟩 | Shared booking-row locking prevents competing Issue/Cancel claims; crash and uncertain-outcome paths become owned cases; no automatic destructive replay exists; the historical null-identity submitting attempt is queue-visible but remains unchanged pending approved remediation. |
| P3 gate | 2026-08-11 | Linked schema lint, migration list, and `supabase db push --linked --dry-run` | 🟩 | Current production schema has no lint findings and remains through `0042`. Dry run lists local `0043`–`0045` only; no migration, record, wallet state, email, or production behavior was applied. |
| P4.1 | 2026-08-11 | Versioned PNR/AirTicketingDetails contract verifier, PNR carrier-date regression, TypeScript/focused ESLint, production build, and diff check | 🟩 | Both evidence sources use schema/normalizer version 1, exact supplier identity, transport receipt, normalized source facts, and a response-based five-minute freshness window. Only a SHA-256 raw-body hash is retained. US-Bangla remains `MM/DD/YYYY`; other carrier PNR dates remain `DD/MM/YYYY`. |
| P4.2 | 2026-08-11 | Held/ticketed/cancelled evidence decision matrix plus identity/completeness regression suite, TypeScript/focused ESLint, PNR carrier-date regression, production build, and diff check | 🟩 | Complete matching PNR and applicable AirTicketingDetails evidence becomes authoritative only within the five-minute window. Unique transaction, accepted PNR, booking code, passenger set/count, route, ticket code/numbers, query/supplier status, source, timestamps, HTTP receipt, and payload hash are checked. Cross-booking, stale, malformed, incomplete, wrong-source, and conflicting evidence has no authoritative outcome. No database, booking status, wallet, email, Git history, or production behavior changed. |
| P4.3 | 2026-08-11 | Payload-bound evidence-read verifier, isolated PostgreSQL-compatible exact-replay/mismatch/no-mutation fixture, TypeScript/focused ESLint, evidence/PNR regressions, production build, migration dry run, and diff check | 🟩 | Staff evidence reads require an existing open case and Support/Admin/Super Admin authorization, use a shared rate limit and cross-instance lease, read PNR plus the purpose-specific report in parallel, append one immutable observation per request identity, and expose only a safe validation summary. Exact replay reused one observation; a changed payload was rejected. A later failed read appended separately without falsely refreshing evidence time. Booking, wallet, ledger, lifecycle events, and outbox were byte/count unchanged. Migration `0046` remains local-only with `0043`–`0045`; nothing was pushed or applied. |
| P4.4 | 2026-08-11 | Ticketing decision matrix for complete ticketed/cancelled/held evidence, incomplete/stale evidence, identity/supplier conflicts, and local terminal/ticket conflicts; TypeScript/focused ESLint; production build | 🟩 | Outcomes are `ticketed`, `held_not_ticketed`, `cancelled`, or `unresolved_conflicting`. Positive terminal evidence is identified but requires explicit staff confirmation and financial review. Held requires separate non-issuance confirmation. Local terminal contradictions fail closed with a candidate outcome for investigation. Every decision hard-codes automatic resolution, status mutation, and wallet mutation to false; the evidence route contains no resolution/finalization path. |
| P4.5 | 2026-08-11 | Cancellation decision matrix for complete cancelled/ticketed/held evidence, incomplete/stale and identity/status conflict, existing terminal conflict, and Confirmed-to-Cancelled correction; TypeScript/focused ESLint; evidence-read regression; production build | 🟩 | Outcomes are `cancelled`, `still_held`, `ticketed`, or `unresolved_conflicting`. Cancelled/ticketed evidence may identify supplier truth, while Held remains an explicit-confirmation candidate. A ticketed result against local Cancelled and held result against local ticket/terminal truth fail closed. A proven cancellation against local Confirmed is flagged as a terminal correction. All outcomes remain non-executable: no automatic resolution, status mutation, or wallet mutation is authorized. |
| P4.6 | 2026-08-11 | Legacy classification matrix for ticketed/cancelled/held, missing local identity, incomplete/stale evidence, and local/supplier conflicts; generic-action UI/API guard; TypeScript/focused ESLint; evidence-read regression; production build | 🟩 | Legacy evidence can only route to ticketing resolution, cancellation resolution, held non-issuance review, supplier-identity recovery, fresh-evidence acquisition, or manual conflict review. Every classification requires an outcome-specific maker-checker path; `genericResolveAllowed`, automatic resolution, status mutation, and wallet mutation are false. No generic Resolve button or route exists. |
| P4.7 | 2026-08-11 | Isolated PostgreSQL-compatible confirmed/captured, confirmed/financial-conflict, cancelled/unpaid, and exact-replay fixture; structural no-change verifier; evidence/decision regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Fresh complete PNR plus AirTicketingDetails evidence may close only ticketing/cancellation uncertainty when it matches existing Confirmed/Cancelled truth and the exact reservation/payment state is already consistent. The linked operation completes and the case closes atomically; exact replay is idempotent. Financial conflict remains open. Booking status/payment, wallet, ledger, lifecycle events, and outbox are unchanged. The dry run lists local migrations `0043`–`0047`; none was applied. |
| P4.8 | 2026-08-11 | Six-risk confirmation matrix; decision/evidence/no-change regressions; TypeScript/focused ESLint; production build; diff check | 🟩 | Terminal correction, identity exception, incomplete evidence, legacy uncertainty, held non-issuance, and possible financial consequence each produce explicit server-derived confirmation requirements and a controlled next step. Identity/incomplete/no-candidate cases remain blocked. High-risk paths require maker-checker; no generic Resolve action, evidence-read execution authority, status mutation, or wallet mutation was introduced. |
| P4.9 | 2026-08-11 | Isolated PostgreSQL-compatible AirTicketingDetails conflict/match, PNR terminal conflict, imported terminal conflict, and exact-replay fixture; static compatibility/side-effect verifier; lifecycle/operation/observation/evidence/decision/wallet/import/PNR regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Conflicting ordinary Sync cannot overwrite existing status, operation, ticket numbers, airline PNR/deadline, payment, or wallet truth. It opens/updates one case and appends one immutable observation per evidence identity; exact replay deduplicates. Matching terminal truth may enrich only matching supplier fields. Compatibility RPC names route through the same guards, and the retained imported normalizer is not executable by service role. Dry run lists local `0043`–`0048`; none was applied. |
| P4.10 | 2026-08-11 | Isolated PostgreSQL-compatible evidence/proposal/approval/rejection/resolution/no-change audit fixture plus update/delete denial; replay-route and PII-minimization verifier; evidence/security regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Every stored evidence observation and case proposal/rejection/approval/normal resolution transition creates an atomic immutable security event; no-change retains its explicit event. Both replay paths audit before any no-change closure and fail closed when audit is unavailable. Raw evidence and proposal/resolution bodies are excluded. Audit update/delete fails. Dry run lists local `0043`–`0049`; none was applied. |
| P4 gate | 2026-08-11 | Evidence identity/mismatch matrix, observation idempotency fixtures, Phase 4 migration fixtures, wallet/status side-effect guards, terminal Sync protection, audit immutability, production build, and linked migration dry run | 🟩 | Cross-booking/mismatched evidence is non-authoritative; retries deduplicate; Phase 4 can only record evidence, classify, open/update cases, or perform the tightly bounded no-change closure. No Phase 4 path moves wallet money or corrects protected terminal truth without a later approved resolution. |
| P5.1 | 2026-08-11 | Eight-role/six-capability permission matrix; evidence/observability regressions; TypeScript/focused ESLint; production build; diff check | 🟩 | View, supplier investigation, supplier-truth proposal, financial proposal, high-risk approval, and approved execution are distinct. Support cannot propose money; Accounts cannot inspect/propose supplier truth; neither can approve/execute. Admin/Super Admin receive all six. Media/customer/B2B roles receive none. |
| P5.2 | 2026-08-11 | Proposal-domain/risk matrix for Support, Accounts, Admin, combined terminal+money, and under-scoped money; confirmation regression; TypeScript/focused ESLint; production build; diff check | 🟩 | Supplier-only and financial-only proposal powers remain distinct; a combined proposal requires both. Financial risk in a supplier-only proposal fails closed. High-risk flags require maker-checker and no proposal assessment ever authorizes execution. |
| P5.3 | 2026-08-11 | Isolated PostgreSQL-compatible proposal/replay/mismatch/role/self-approval/independent-approval/rejection fixture; maker-checker/permission/audit/deadline regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Exact proposal replay is idempotent; changed payload under the same request identity fails; Support cannot propose financial outcomes; a maker cannot self-approve; an independent Admin/Super Admin can approve or reject the unchanged proposal hash/version. Booking status/payment and wallet remain unchanged. `BS` remains `MM/DD/YYYY` and other carriers remain `DD/MM/YYYY`. Dry run lists local `0043`–`0050`; none was applied. |
| P5.4 | 2026-08-11 | Isolated PostgreSQL-compatible valid/wrong-outcome/unauthorized/changed-state/stale-evidence contract fixture; structural outcome-contract verifier; maker-checker regression; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Six exact service-only contracts exist and the generic validator is not service-callable. A valid ticketed proposal reaches the explicit execution-disabled boundary; wrong outcome, Support actor, changed booking/payment state, and stale evidence fail closed. Booking/case counts and lifecycle/payment state remain unchanged. Dry run lists local `0043`–`0051`; none was applied. |
| P5.5 | 2026-08-11 | Database authorization structural verifier plus isolated executor-role-change fixture; maker-checker and outcome-contract regressions; focused ESLint | 🟩 | Supplier/financial/combined proposal domains, Admin/Super Admin decision/execution authority, and self-approval denial are enforced from current `app_users` rows inside SECURITY DEFINER functions. No RPC accepts a client-supplied actor role. A demoted checker immediately receives `EXECUTION_FORBIDDEN`; another current Super Admin reaches the unchanged execution-disabled contract. |
| P5.6 | 2026-08-11 | Structural global lock-order verifier plus isolated linked operation/reservation/wallet/account fixture; outcome/authorization regressions; TypeScript; production build; diff check; linked migration dry run | 🟩 | The exact booking → operation → case → reservation → wallet → account lock chain is enforced before outcome execution. The fixture returned all four linked internal IDs while booking/payment, reservation, balances/holds, and case state remained unchanged. Dry run lists local `0043`–`0051`; none was applied. |
| P5.7 | 2026-08-11 | Isolated PostgreSQL-compatible ticketed capture fixture with exact replay and changed-request conflict; ticketed/contract/lock/authorization/maker-checker/wallet regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Authoritative ticket evidence captured one 1,000 BDT reconciliation hold, left available balance unchanged, reduced hold once, stored ticket evidence, changed In Progress/Reconciliation to Confirmed/Captured, completed the linked operation/case, and emitted one lifecycle event/ledger row. Exact replay returned the committed result with counts still one; another request key failed. Dry run lists local `0043`–`0052`; none was applied. |
| P5.8 | 2026-08-11 | Isolated PostgreSQL-compatible Held-read/portal-attestation/replay/release fixture; non-issuance/proposal/contract/lock/audit/wallet/deadline regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Attestation appended once and exact replay reused it. The approved release moved one 1,000 BDT hold back to available once, stored On Hold, projected Expired from the preserved deadline, marked payment/reservation Released, failed the uncertain operation, resolved the case, and emitted one ledger/event row. Resolution replay duplicated nothing. BS remains `MM/DD/YYYY`; other carriers remain `DD/MM/YYYY`. Dry run lists local `0043`–`0053`; none was applied. |
| P5.9 | 2026-08-11 | Isolated PostgreSQL-compatible authoritative unpaid-cancellation fixture with exact replay; unpaid-cancellation/contract/decision/lock/audit/maker-checker/wallet regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | The booking changed from In Progress/Unpaid to Cancelled/Unpaid, operation and case completed, and one lifecycle event was recorded. Wallet/account/reservation/ledger tables all remained empty, and exact replay duplicated nothing. Dry run lists local `0043`–`0054`; none was applied. |
| P5.10 | 2026-08-11 | Isolated PostgreSQL-compatible authoritative held-cancellation fixture with exact replay; held/unpaid cancellation, contract, lock, authorization, and wallet regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | One 1,200 BDT protected hold returned to available exactly once, reservation/payment became Released, booking became Cancelled, operation/case completed, and one ledger/event row was recorded. Exact replay duplicated nothing. Dry run lists local `0043`–`0055`; none was applied. |
| P5.11 | 2026-08-11 | Four-case PostgreSQL-compatible full/partial/no-refund/external-settlement matrix with exact replay; captured-cancellation/contract/maker-checker/audit/wallet/deadline regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run; event behavior superseded/verified by P5.15 | 🟩 | Full refund credited 1,000 BDT once and became Refunded; partial refund credited the approved 300 BDT once and became Partially Refunded; no-refund and external settlement credited nothing and retained explicit Captured local-wallet truth. All four exact replays duplicated no money. P5.15 intentionally supersedes the earlier no-event behavior: each material financial disposition now creates one same-status occurrence/outbox intent. `BS` remains `MM/DD/YYYY`; other supported carriers remain `DD/MM/YYYY`, with supplier time preserved. Dry run originally listed local `0043`–`0056`; current final verification is recorded at P5.15. |
| P5.12 | 2026-08-11 | Isolated PostgreSQL-compatible two-direction terminal correction and unsupported-state fixture with exact replay; terminal/captured-cancellation/contract/maker-checker/authorization/lock/audit/wallet/deadline regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Confirmed/Captured → Cancelled/Refunded credited the exact 1,000 BDT once, emitted one correction event, stored terminal resolution kind, and replayed without duplication. Cancelled/Captured/Unrefunded → Confirmed retained the 100 BDT wallet balance, created no ledger row, emitted one correction event, cleared current cancellation fields while preserving their prior values in case history, and replayed exactly. Cancelled/Unpaid was rejected. `BS` remains `MM/DD/YYYY`; other supported carriers remain `DD/MM/YYYY`. Dry run lists local `0043`–`0057`; none was applied. |
| P5.13 | 2026-08-11 | Isolated PostgreSQL-compatible ordinary/reconciliation/open-case/unknown-attempt/definitive-attempt release matrix plus canonical-error rerun; release/nonissuance/held-cancellation/lock/wallet/deadline regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Ordinary booking and definitive attempt holds released once and replayed safely. Reconciliation reservation/payment, an active reservation with an open case, and an unknown attempt returned `RECONCILIATION_REQUIRED`; balances, holds, reservation state, and ledger counts were unchanged. Exact approved reconciliation functions do not call the generic release RPC. Dry run lists local `0043`–`0058`; none was applied. |
| P5.14 | 2026-08-11 | Isolated PostgreSQL-compatible ordinary/replay/idempotency-conflict/Cancelled/open-case/forged-role refund matrix; refund/captured-cancellation/maker-checker/wallet/deadline regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | A normal Accounts refund credited 300 BDT once, became Partially Refunded, and exact replay duplicated nothing. A changed amount under the same request key conflicted. Cancelled and open-case bookings returned `RECONCILIATION_REQUIRED` with no ledger row. A current Support user remained `REFUND_FORBIDDEN` even when the supplied role claimed Accounts; the ledger stores the database-derived Accounts role. Support refund UI/API access is removed. Dry run lists local `0043`–`0059`; none was applied. |
| P5.15 | 2026-08-11 | Isolated PostgreSQL-compatible case-bound refund/ordinary refund/Triplover grace/imported-manual immediate outbox fixture with exact replay; all Phase 5 contract/authorization/lock/audit/release/refund/wallet/email/deadline regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Case-bound Cancelled → Cancelled refund and ordinary Confirmed → Confirmed refund each committed exactly one ledger row, one lifecycle occurrence, and one outbox intent; replay duplicated none. Triplover In Progress was available after exactly 120 seconds; imported manual ticketing was immediately eligible. The trigger stores a render-safe occurrence snapshot, creates no delivery recipient, and sends no email. Dry run lists local `0043`–`0060`; none was applied. |
| P5 gate | 2026-08-11 | Phase 5 resolution matrices, exact replay, current-role/self-approval failures, balance/ledger equations, explicit disposition checks, atomic event/outbox fixture, production build, and linked migration dry run | 🟩 | Every supported capture/release/refund/terminal outcome is exact, case-bound where reconciliation is involved, atomic, audited, and replay-safe. Unsupported or inconsistent states remain owned/fail-closed. No production migration, record, wallet, email, commit, push, or deployment occurred. |
| P6.1 | 2026-08-11 | Static IMP/EXP writer/owner-confirm verification plus isolated PostgreSQL-compatible valid/invalid/historical/non-import constraint fixture; existing 44-check IMP/EXP wallet regression; TypeScript/focused ESLint; deadline regression; production build; diff check; linked migration dry run | 🟩 | Valid On Hold/Unpaid import persisted; new Captured or charged-account On Hold imports failed; the atomic In Progress/Captured owner transition and non-import booking remained allowed. A seeded historical invalid row remained untouched because the constraint is `NOT VALID`. No wallet row, booking data, or production schema was mutated. Dry run lists local `0043`–`0061`; none was applied. |
| P6.2 | 2026-08-11 | Static atomic/import authorization verifier plus isolated PostgreSQL-compatible first capture, exact replay, malformed captured state, unauthorized owner, insufficient-funds rollback, and immediate-outbox fixture; IMP/EXP, lifecycle, operation, lock-order, wallet, email, and carrier-deadline regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | First Confirm & Pay debited the exact 1,000 BDT User Payable and created exactly one captured reservation, ledger row, awaiting-external-action operation, assigned Support case, linked In Progress occurrence, and immediate outbox intent. A retry with a different transport request ID returned the same business result and duplicated nothing. Malformed captured state required reconciliation; unauthorized and insufficient-funds calls created no artifacts. No supplier API call exists. `BS` remains `MM/DD/YYYY`; other supported carriers remain `DD/MM/YYYY`. Dry run lists local `0043`–`0062`; none was applied. |
| P6.3 | 2026-08-11 | Manual-task assignment/SLA structural verifier; IMP/EXP, atomic-confirm, and staff-observability regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Each paid manual-ticket operation starts `awaiting_external_action` with a linked `assigned` high-severity Support case. Operation and case share the deadline-aware due instant: earlier of capture +2 hours or airline deadline −1 hour, clamped to capture for a close deadline. Policy version 1 records the 30-minute unassigned warning, Admin-at-due, and Super-Admin-after-60-minutes-overdue rules; indexed queues, staff mapping, due/overdue UI, and SLA metrics expose it. P6.9 remains responsible for executing timed escalation updates. Dry run lists local `0043`–`0062`; none was applied. |
| P6.4 | 2026-08-11 | Imported customer-status copy/data-flow verifier; atomic-confirm and IMP/EXP regressions; TypeScript/focused ESLint; production build; diff check | 🟩 | Immediately after Confirm & Pay and after a later page reload, an imported In Progress booking displays exactly “Payment received; ticketing is being completed.” Internal operation/case ownership is not added to the public booking DTO. Email rendering remains in the approved Phase 7 scope. No database, email, or production behavior was changed. |
| P6.5 | 2026-08-11 | Non-financial imported-Sync structural verifier; 44-check IMP/EXP wallet/lifecycle/authorization/Sync/idempotency regression; import confirmation, manual-task, customer-status, On Hold, Sync-protection, and observation regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Support/Admin/Super Admin Sync calls the protected v2 RPC. Exact matches enrich supplier data only; disagreement retains local lifecycle/payment truth and appends deduplicated evidence to the active case. Static assignment-list checks prove zero wallet account, reservation, ledger, or payment-field writes and no call to Confirm & Pay. All gates pass. Dry run lists local `0043`–`0062`; none was applied, and no production record, wallet, email, migration, commit, push, or deployment was changed. |
| P6.6 | 2026-08-11 | Imported evidence/completion contract verifier; incomplete/mismatch/freshness/captured-ledger/lock-order/replay guards; Sync, Confirm & Pay, 44-check IMP/EXP, evidence, lifecycle, wallet, outbox, customer-status, manual-task, and carrier-deadline regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Only fresh complete provider/reference/passenger/route/PNR/ticket evidence can enable and execute staff completion. The RPC proves the captured User Payable and its single immutable capture ledger row, confirms the booking, succeeds the operation, resolves the case, and emits one atomic Confirmed occurrence/outbox. It contains no wallet-account/reservation update or ledger insert and reports zero additional debit. Exact replay is recoverable. Dry run lists local `0043`–`0063`; none was applied, and no production record, wallet, email, migration, commit, push, or deployment was changed. |
| P6.7 | 2026-08-11 | Six-outcome imported classification verifier; P6.6 completion, non-financial Sync, Confirm & Pay, 44-check IMP/EXP, evidence-read, lock-order, lifecycle, atomic-outbox, wallet, customer-status, manual-task, and carrier-deadline regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Fresh identity-matched ticketed, held, cancelled, expired, and unconfirmed evidence receives an explicit durable operation/case route; incomplete or identity-conflicting evidence is assigned to critical Admin review. Negative outcomes expose the captured funds and require Accounts disposition without prematurely changing public status. Exact observation replay is idempotent, and the classifier contains no booking-status, wallet, reservation, ledger, event, or outbox mutation. The ordinary parallel Windows page worker crashed without an application diagnostic; the same production build completed with one worker. Dry run lists local `0043`–`0064`; none was applied, and no production record, wallet, email, migration, commit, push, or deployment was changed. |
| P6.8 | 2026-08-11 | Imported financial-disposition verifier; supplier-outcome/completion, maker-checker, captured-cancellation, resolution-contract, database-authorization, refund-guard, lock-order, audit, permissions, atomic-outbox, 44-check IMP/EXP, wallet, Sync, Confirm & Pay, customer-status, and manual-task regressions; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Five explicit dispositions are available across reloads. Accounts/Admin may propose only from fresh authoritative negative imported evidence; all proposals require an unchanged approval by a different Admin/Super Admin. Execution proves the protected capture/reservation/ledger, creates at most one refund credit, terminalizes the unfulfilled booking and operation/case atomically, and emits one event/outbox. No-refund/external-settlement paths do not fabricate wallet movement; manual-adjustment remains visibly open. A transient Windows/Node worker crash produced no application diagnostic; isolated one-worker production build completed. Dry run lists local `0043`–`0065`; none was applied, and no production record, wallet, email, migration, commit, push, or deployment was changed. |
| P6.9 | 2026-08-11 | Imported manual-ticket escalation verifier; original manual-task policy, financial disposition, supplier outcomes, observability, operation, lifecycle, and TypeScript/focused ESLint regressions; one-worker production build; diff check; linked migration dry run | 🟩 | The protected scheduler now executes the existing 30-minute unassigned warning, Admin-at-due, and Super-Admin-after-60-minutes-overdue policy in batches of at most 500. Concurrent workers skip locked booking roots; each mutation follows booking → operation → case. Due external operations become explicit reconciliation while active finance/approval states remain intact. No supplier/public/financial/event truth is inferred. Dry run lists local `0043`–`0066`; none was applied, and no production record, wallet, email, migration, commit, push, or deployment was changed. |
| P6.10 | 2026-08-11 | Explicit direct-import decision verifier; full IMP/EXP On Hold, Confirm & Pay, manual-task, customer-copy, non-financial Sync, completion, supplier-outcome, financial-disposition, escalation, atomic-outbox, wallet, and carrier-deadline regressions; TypeScript/focused ESLint; one-worker production build; linked migration dry run | 🟩 | Confirmed imports now expose two unambiguous actions. Import Only moves no wallet money and opens an Accounts case. Import & Charge re-retrieves complete supplier evidence, records a payload-bound five-minute authorization, and atomically consumes it for one exact User Payable debit. Stable request identities recover exact retries without a second debit; altered owner, evidence, Supplier Gross, User Payable, expired, or consumed authorization fails closed. The service application cannot call the legacy auto-charge RPC. Dry run lists local `0043`–`0067`; none was applied, and no production record, wallet, email, migration, commit, push, or deployment was changed. |
| P6.11 | 2026-08-12 | Imported-pricing invariant verifier; IMP/EXP wallet, Confirm & Pay, Sync, direct-import authorization, and TypeScript regressions; focused ESLint; one-worker production build; linked migration dry run | 🟩 | New/updated imported rows must store Supplier Gross consistently in supplier pricing and User Payable consistently in selling/payment/capture fields. User Payable and currency cannot change after import. Imported reservations and capture ledgers reject any different amount/currency, and capture metadata must retain both price truths. Read paths no longer use truthy fallbacks that could conflate a valid zero Supplier Gross with other pricing. Dry run lists local `0043`–`0068`; none was applied. |
| P6 gate | 2026-08-12 | Aggregate nine-verifier Phase 6 executable gate plus production build and linked migration dry run | 🟩 | Imported On Hold never auto-charges; Confirm & Pay captures once; Sync and manual completion never debit; negative manual-ticket outcomes retain captured-fund visibility until explicit maker-checker disposition; direct confirmed import is explicit; Supplier Gross and User Payable remain separated. No production record, wallet, email, migration, commit, push, or deployment was changed. |
| P7.1 | 2026-08-12 | Seven-label runtime-boundary verifier; lifecycle and complete email-template regressions; TypeScript/focused ESLint; one-worker production build | 🟩 | Exactly On Hold, Pending, In Progress, Confirmed, Expired, Unconfirmed, and Cancelled can render as customer booking/email status labels. Internal attempt, operation, and reconciliation labels cannot cross the public booking status field. No migration, database record, email, commit, push, or deployment was changed. |
| P7.2 | 2026-08-12 | Four-case customer In Progress semantic/copy matrix; imported-customer-copy and complete email-template regressions; TypeScript/focused ESLint; one-worker production build | 🟩 | Ticketing, cancellation, imported manual ticketing, and supplier verification each produce approved customer-safe copy under the unchanged In Progress label. Booking detail, list, action panel, and email paths use the safe sentence. No internal workflow label, database mutation, email send, commit, push, or deployment occurred. |
| P7.3 | 2026-08-12 | Processing-Since source verifier across ordinary/imported operation writers, public DTO mapping, detail/list, and email; In Progress copy/email regressions; TypeScript/focused ESLint; one-worker production build | 🟩 | Processing Since is the persisted operation start/claim instant for ordinary and imported workflows, never booking creation/submission time. Missing evidence remains null. No migration, record, email, commit, push, or deployment changed. |
| P7.4 | 2026-08-12 | Eleven-field lifecycle timestamp contract verifier; Processing-Since and customer-copy regressions; TypeScript/focused ESLint; one-worker production build; linked migration dry run | 🟩 | Migration `0069` records observation time for all future events, exposes exact timestamp provenance through a service-only view, and documents each timestamp’s meaning. Staff history keeps effective, observed, and persisted instants distinct and leaves unknown effective time unavailable. Dry run lists local `0043`–`0069`; none was applied, and no database record, email, commit, push, or deployment changed. |
| P7.5 | 2026-08-12 | Ordinary ticketing/cancellation writer plus grace/outbox verifier; atomic-outbox and timestamp regressions; TypeScript/focused ESLint | 🟩 | Both ordinary start writers persist In Progress before the supplier action. Their atomic outbox intent is pending but ineligible for exactly 120 seconds. No event history is deleted or rewritten, and no recipient expansion or email send is activated yet. |
| P7.6 | 2026-08-12 | Final-intent/supersession ordering and guard verifier; grace and atomic-outbox regressions; TypeScript/focused ESLint | 🟩 | Migration `0070` links an unexpired pending In Progress grace intent to its new Confirmed/Cancelled intent and completes it as superseded in the same event transaction. Expired, processing, sent, or unrelated intents are untouched. Recipient expansion/sending remains disabled until cutover. |
| P7.7 | 2026-08-12 | Imported capture/event ordering and immediate-policy verifier; Confirm & Pay, imported customer-copy, and supersession regressions; TypeScript/focused ESLint | 🟩 | The captured User Payable, durable operation/case, and imported In Progress event/outbox share one transaction. The imported source is immediately eligible, not grace-delayed, and carries the paid-manual-ticket customer message. No email was sent and no production state changed. |
| P7.8 | 2026-08-12 | Occurrence claim, concurrent-worker, normalized-address, registration replay, and legacy-ledger exclusion verifier; grace/supersession regressions; TypeScript/focused ESLint | 🟩 | Migration `0071` and its server adapter use lifecycle event/outbox identity rather than booking/status identity. One recipient row can succeed independently for each occurrence and cannot be duplicated by registration replay. Legacy delivery rows remain untouched. Sending is still disabled pending the snapshot/recipient completion cutover. |
| P7.9 | 2026-08-12 | Five-status re-entry, same-status suppression, approved audit-only reason, final-supersession, and immutable-history verifier; occurrence/grace/imported/supersession regressions; TypeScript/focused ESLint | 🟩 | Migration `0072` gives every material cross-status re-entry a new event-backed intent. Same-state non-terminal and explicitly approved repair occurrences remain visible as suppressed/completed outbox rows. Invalid suppression metadata aborts rather than silently sending or hiding an event. |
| P7.10 | 2026-08-12 | Event-transaction snapshot field/minimization, rollout-window suppression, status/version validation, and no-current-read renderer verifier; re-entry regression; TypeScript/focused ESLint | 🟩 | Migration `0073` enforces `bookingSnapshot` version 1. Rendering reconstructs the booking email document from that snapshot alone. Recipient addresses, contact phone, supplier tokens, and passenger passport fields are absent; snapshot/outbox status mismatch fails closed. |
| P7.11 | 2026-08-12 | Frozen-recipient, independent claim, stored-render-before-send, sent-terminal, failed-only-retry, legacy-cutover, and sequential-event verifier; snapshot/occurrence/supersession/email-template regressions; TypeScript/focused ESLint | 🟩 | Migration `0074` and the cutover worker deliver each visible address independently. Partial failure leaves sent rows untouched and requeues only pending/retry rows. Immediate route calls and the cron now share the occurrence worker. No email was sent by the verifier and no production schema/data changed. |
| P7.12 | 2026-08-12 | Central-mailer path, caller API, envelope BCC, snapshot/content exclusion, and visible-row exclusion verifier; partial-retry and full booking-email regressions; TypeScript/focused ESLint | 🟩 | The fixed archive address remains SMTP-envelope-only for every independently sent visible recipient. It cannot be supplied by callers and is not serialized into event/render/customer content. No test message was sent by this verification step. |
| P7.13 | 2026-08-12 | Bounded-backoff, stale-claim recovery, dead-letter escalation, address-free metrics, scheduler integration, and staff UI verifier; all Phase 7 focused regressions; TypeScript/focused ESLint | 🟩 | Migration `0075` adds durable retry/dead-letter timestamps, a 1-minute-to-24-hour backoff schedule, 15-minute stale-claim recovery, bounded escalation, and service-only delivery metrics. The protected cron runs recovery, delivery, and escalation in order; the staff metrics panel exposes pending, retry, dead-letter, and suppression counts without addresses. |
| P7 gate | 2026-08-12 | Aggregate 13-verifier Phase 7 executable gate; `npm run typecheck`; one-worker production build; linked migration dry run | 🟩 | Fast-final supersession, persistent/imported In Progress behavior, occurrence re-entry, snapshot rendering, independent recipient retry, hidden BCC, replay safety, and resilience metrics all pass. The production build completed successfully. Dry run lists local migrations `0043`–`0075`; none was applied, and no database record, email, commit, push, or deployment changed. |
| P8.1 | 2026-08-12 | Due-deadline partial-index structural verifier; linked migration dry run | 🟩 | Migration `0076` indexes `(ticketing_deadline_at, id)` only for actionable On Hold expiry candidates with airline PNR, deadline, and no unresolved operation. The verifier rejects mutable audit-time ordering. Dry run lists local migrations `0043`–`0076`; none was applied. |
| P8.2 | 2026-08-12 | Due/not-observed-before-limit structural verifier; lifecycle and atomic-event/outbox regressions | 🟩 | Migration `0077` replaces the broad oldest-updated-row sweep. Due and latest-not-Expired predicates precede the bounded limit; ordering matches the deadline/ID index, effective time is the deadline, observation time is explicit, and replay uses a deterministic key. No production schema/data or email changed. |
| P8.3 | 2026-08-12 | Composite-cursor and compatibility-wrapper structural verifier; P8.2 query regression | 🟩 | Migration `0078` adds `(ticketing_deadline_at, booking_id)` keyset pagination with strict cursor pairing and returns the last examined key. The service-compatible legacy RPC delegates to one cursor batch. No offset or `updated_at` scan remains. |
| P8.4 | 2026-08-12 | Candidate-lock/skip-locked/idempotency/no-booking-update structural verifier; keyset and atomic-outbox regressions | 🟩 | The `0078` batch query applies `FOR UPDATE OF booking SKIP LOCKED` after its bounded deadline/ID order. Concurrent callers cannot claim the same booking root, and the deterministic event key safely resolves a replay race without changing the booking row. |
| P8.5 | 2026-08-12 | Time-budget/cap/stop-reason worker verifier with a 541-row three-batch fixture; TypeScript and focused ESLint | 🟩 | The protected cron invokes a bounded 250-row, 20-batch, 10-second loop with 500 ms safety margin. The fixture drains 541 rows across three batches; source guards reject an unbounded loop and require cursor progress/error outcomes. |
| P8.6 | 2026-08-12 | Durable run/table/RPC transaction-boundary verifier; time-budget regression; TypeScript and focused ESLint | 🟩 | Migration `0079` stores a PII-free run ID, per-run deadline/ID cursor, batch/selected/inserted counts, timestamps, stop reason, and bounded outcome. The versioned batch wrapper holds the run lock while the event/outbox batch and cursor update execute in one transaction. No production schema/data changed. |
| P8.7 | 2026-08-12 | Booking-creation/PNR-Sync/import-Sync primary-path verifier; bounded repair/index/suppression/no-row-mutation checks; corrected JSONB expiry-index regression; TypeScript and focused ESLint | 🟩 | Migration `0080` adds imported-Sync Unconfirmed occurrence coverage and a 50-row audit-only repair backstop. The verifier proves all three primary write boundaries and rejects derived-status materialization. It also caught and corrected the still-unapplied expiry PNR predicate to use the immutable JSONB-array helper. |
| P8.8 | 2026-08-12 | Expiry writer → event trigger → outbox transaction/identity verifier; atomic-outbox and notification-reentry regressions | 🟩 | A material Expired occurrence is event-backed, immediately eligible, and produces exactly one outbox intent through the database event trigger. Effective time is the authoritative ticketing deadline; no application-side enqueue exists. |
| P8.9 | 2026-08-12 | Backlog/starvation/latency/run-health view and staff UI verifier; notification-metrics regression; TypeScript and focused ESLint | 🟩 | Migration `0081` adds identity-free derived lifecycle metrics and a targeted 24-hour expiry-latency index. Staff can see expiry backlog/starvation, sweep failures, and Unconfirmed repair backlog; the data contract also carries latency and last-run details. |
| P8.10 | 2026-08-12 | Protected-route global/local budget, one-at-a-time notification claim, cadence, bearer, and replay-idempotency verifier; Phase 7 regression; TypeScript/focused ESLint; one-worker production build | 🟩 | The route reserves 15 seconds below its 120-second platform limit and preserves the approved 15-minute cron. All scheduled steps are bounded/time-gated; email work never preclaims a batch near timeout. The production build passes. |
| P8 gate | 2026-08-12 | Aggregate 11-verifier Phase 8 gate; PostgreSQL-compatible migration execution/query-plan fixture with 100,000 rows; overlapping worker calls; 10,000- and 1,000,000-row starvation simulations; Phase 7 regression; TypeScript/focused ESLint; production build; diff check; linked migration dry run | 🟩 | Migrations `0076`–`0081` execute in the isolated fixture. The planner uses the due partial index and latest-event index; 2,000 prior observations do not starve later rows; 1,000 new events are unique across keyset/overlapping calls. Both large simulations drain fully. Dry run lists local `0043`–`0081`; none was applied, and no production record, email, commit, push, or deployment changed. |
| P9.1 | 2026-08-12 | Read-only snapshot safety verifier and live protected snapshot | 🟩 | Snapshot SHA-256 `32175f06a7d376aa802d49bc20eda3574b3250de9e5f6697a001af435935c440` covers 9 affected bookings, 10 related/aged attempts, 1 reservation/account/wallet, 4 ledger rows, 15 lifecycle events, and 15 legacy delivery rows. The full artifact is git-ignored and not reproduced here; no production mutation occurred. |
| P9.2 | 2026-08-12 | Protected-snapshot case projection and read-only post-migration subject/type verification | 🟩 | Ten booking case keys and one attempt case key exist in the linked database with zero missing or duplicate projected keys. The cases remain unresolved and explicitly owned; no sensitive row was printed. |
| P9.3 | 2026-08-12 | Protected local classification execution and seven-category/financial-equation/evidence-boundary verifier | 🟩 | Classification manifest SHA-256 `05818716c3219ba20c3bac6a3e0ffa405a86066844244d250430658bfe1eb71b` is bound to the P9.1 snapshot hash. Ten subjects classify as 2 ticketed/unpaid, 3 cancelled/unpaid, 1 cancelled/captured, and 4 unknown. No subject identifier was printed and no production call/mutation occurred. |
| P9.4 | 2026-08-12 | Deployment/authority/fresh-evidence prerequisite check | 🟥 | Schema and owned cases are live through `0082`, and the candidate application is Ready in Preview; the independently controlled production release, fresh five-minute evidence, and independent maker-checker actors remain outstanding. Performing resolution before those gates would bypass the approved architecture. No supplier read, case decision, wallet mutation, or email send was attempted. |
| P12.4 | 2026-08-12 | Protected snapshot verification; linked lint/list/dry-run; `supabase db push --linked`; forward migration `0082`; read-only post-migration audit | 🟩 | Linked history is aligned through `0082` and a follow-up dry run reports the database up to date. Live lint has zero errors. The additive backfill created 2 operations and 11 owned cases while all protected old-schema facts remained unchanged; outbox/delivery/worker-run counts remain zero. Recovery checkpoint SHA-256: `32175f06a7d376aa802d49bc20eda3574b3250de9e5f6697a001af435935c440`. No application deployment or remediation action occurred. |
| P12.11 | 2026-08-12 | `npm run verify:booking-remediation-post-migration` after additive schema rollout | 🟩 | First rollout-stage invariants pass: protected booking/wallet/event/email facts are unchanged, expected cases are present, metric views are readable, anonymous case reads are denied, and the audit used select-only calls with zero supplier, wallet, decision, or email side effects. This recurring gate must run again after every later application/feature stage. |
| P11.1 | 2026-08-12 | Lifecycle-document contradiction scan and `git diff --check` | 🟩 | `docs/08-BOOKING-LIFECYCLE.md` now defines the seven public meanings independently from operations/cases, restricts Pending, documents protected terminal correction and maker-checker, corrects direct-import and Sync/Complete behavior, and describes occurrence-aware event/outbox semantics. Outdated claims that Pending is the supplier-wallet-shortage path or that Confirmed/Cancelled silently prove completed finances were removed. |
| P11.2 | 2026-08-12 | Wallet-document role/flow contradiction scan and `git diff --check` | 🟩 | `docs/10-WALLET-SYSTEM.md` now documents exact case-bound capture/release/refund/settlement dispositions, immutable ledger consequences, Support versus Accounts proposal boundaries, independent Admin/Super Admin approval, explicit direct-import authorization, and generic release/refund guards. Cancelled no longer implies refund completion. |
| P11.3 | 2026-08-12 | API route inventory, request-schema comparison, outdated-flow scan, and `git diff --check` | 🟩 | `docs/13-API-ROUTES.md` now covers masked lifecycle/attempt/timeline/metrics reads; case-bound evidence and non-issuance attestation; domain-separated proposal and independent decision; the intentionally absent generic Set Status/Move Money endpoint; and narrow imported authorization, completion, and disposition execution APIs. Import and Sync behavior matches the v2 writers. |
| P11.4 | 2026-08-12 | IMP/EXP flow/migration/route inventory, contradiction scan, and `git diff --check` | 🟩 | `docs/17-IMP-EXP-IMPORTS.md` now covers Support task ownership and due/escalation policy, six-way Sync routing, non-financial verification, fresh evidence-bound Complete, captured failure dispositions, and explicit direct-import authorization. It no longer claims Sync completes Confirmed or that every direct confirmed import automatically charges. |
| P11.5 | 2026-08-12 | Migration `0043`–`0082` table/view/function/index/constraint inventory and `git diff --check` | 🟩 | `docs/12-DATABASE.md` now documents durable operations, cases/observations, occurrence events, outbox/per-recipient deliveries, worker runs, import authorizations, staff/metrics views, exact RPC families and lock order, scale indexes, maker-checker and imported pricing constraints, and rolling legacy-delivery compatibility. |
| P11.6 | 2026-08-12 | Architecture/booking-system data-flow review, outdated-flow scan, and `git diff --check` | 🟩 | The architecture and booking-system guides now separate attempts, durable operations, owned cases, business bookings, occurrence events, and notification delivery. Aged/unknown attempts remain internal cases rather than placeholder bookings, ambiguous supplier writes are never replayed, and imported Sync/Complete plus direct-import decisions match the protected implementation. |
| P11.7 | 2026-08-12 | Repository-wide Pending/supplier-wallet wording scan, source comment correction, and `git diff --check` | 🟩 | Permissions and API/business docs now call Pending a rare explicit prerequisite/compatibility state and do not claim it proves a supplier-wallet shortage or prior debit. The attempt-status API documentation was also corrected from nonexistent `pending` to `submitting`. Historical enum/migration compatibility values remain documented as legacy only. |
| P11.8 | 2026-08-12 | Repository-wide Cancelled/refund wording scan and `git diff --check` | 🟩 | Project and wallet architecture wording now distinguishes supplier cancellation truth from hold release, refund, retained capture, external settlement, and manual adjustment. The valid ordinary active-hold success message remains specific; no general documentation claims Cancelled proves refund completion. |
| P11.9 | 2026-08-12 | Permanent reconciliation governance/runbook review and `git diff --check` | 🟩 | `docs/18-BOOKING-RECONCILIATION-RUNBOOK.md` records the capability-specific role matrix, five-minute normalized evidence standard, case/operation SLAs and escalation, independent maker-checker sequence, scheduler observation lag, and emergency containment/forward-fix procedure. It explicitly forbids direct production-row repair and immutable-history edits. |
| P11.10 / P11 gate | 2026-08-12 | Nine-case-type runbook coverage plus `npm run verify:booking-lifecycle-documentation` and `git diff --check` | 🟩 | All nine database case types have owner, evidence, allowed outcome, escalation, and post-action verification playbooks. The permanent documentation verifier covers ten authoritative documents including deployment controls, finds zero direct database-mutation instructions and zero obsolete Pending/supplier-shortage or Cancelled/refund-complete claims. The documentation index links the new runbook. |
| P12.1 | 2026-08-12 | Full ESLint; TypeScript; one-worker Next.js production build; baseline lifecycle/observability/wallet/IMP-EXP/email/deadline checks; Phase 6–8 aggregate gates; documentation/remediation/post-migration gates; linked schema lint/list/dry-run | 🟩 | All application and aggregate checks pass. The stale observability verifier was narrowed to validate the typed public output instead of forbidding internal inputs used only to generate customer-safe copy. Linked migrations align through `0082`, dry run is empty, and live schema lint has zero errors (seven unused-variable/parameter warnings only). |
| P12.2 | 2026-08-12 | `npm run verify:booking-lifecycle-release` | 🟩 | A deterministic matrix ran 72 focused non-mutating verifiers covering T1–T37 plus fail-closed rollout controls and passed in 13.2 seconds. Mutating live verifiers and the email-send utility are explicitly excluded. Scheduler assertions require the independently gated bounded `runStep` wrappers around unchanged 100-row operation/attempt watchdog calls. |
| P12.3 | 2026-08-12 | Isolated PostgreSQL-compatible migration fixtures, protected production-anomaly snapshot/projection, linked additive rollout, and byte/field-level post-rollout comparison | 🟩 | Migration/backfill behavior was rehearsed against production-shaped anomaly and scale fixtures before rollout. The actual additive stage then confirmed all 11 projected cases and preserved every protected old-schema fact; the protected snapshot remains the forward-fix/compensating-action checkpoint. |
| P12.5 | 2026-08-12 | Vercel Preview deployment `dpl_52GtR4KSestDQvYkyRzoRSoRSHMQ`; immutable URL smoke checks; post-stage protected-snapshot audit | 🟩 | Deployment `https://shopontravels-9ct2b1qj0-babuas25s-projects.vercel.app` is Ready in Preview. A protected-bypass GET returned `200` for `/`; unauthenticated GET of `/api/admin/booking-lifecycle/metrics` returned `401`, confirming the staff boundary. Preview has no `CRON_SECRET`, so no scheduler ran. The recurring read-only audit again found all protected facts unchanged and zero supplier, wallet, case-decision, notification, worker, or email side effects. |
| T39 / rolling compatibility | 2026-08-12 | Existing production deployment GET; one-hour production error-log query; post-migration protected-snapshot audit | 🟩 | The unchanged production deployment returned `200` after migrations `0043`–`0082`; Vercel reported no production error-level runtime entries in the inspected one-hour window. Database truth remained unchanged and the old scheduler/app stayed compatible with the additive schema. |
| P12.5 final replacement stage | 2026-08-12 | Vercel Preview deployment `dpl_DD8FVzvVNCwEZ8Y5FhD6pnGy7g4U`; focused/full release gates; immutable URL and scheduler fail-closed smoke; recurring database audit | 🟩 | Final candidate deployment `https://shopontravels-kdlbuecvp-babuas25s-projects.vercel.app` is Ready. `/` returned `200`, unauthenticated lifecycle metrics returned `401`, and the protected cron returned `503` because Preview has no `CRON_SECRET`. All six rollout variables are absent, therefore false. The post-stage audit again found protected facts unchanged and zero supplier, wallet, decision, outbox, worker, or email effects. |
| P12.6–P12.9 release controls | 2026-08-12 | `npm run verify:booking-rollout-controls`; Phase 6–8 gates; TypeScript; full lint/build; 72-verifier release matrix; permanent rollout documentation | 🟩 | Six server-only exact-`true` switches independently gate operation workers, imported workers, staff reconciliation actions, imported manual actions, outbox delivery, and scalable sweep. All immediate/scheduled email entry points fail closed together; five imported-action routes include prior-authorization consumption; guarded UI is hidden; Import Only remains available; and the false scalable flag keeps the bounded compatibility observer. No production variable or deployment changed. |
| P12.6 production activation | 2026-08-12 | User authorization; application checkpoint `95c12aa1d53d29073cd871d7ffff4de9b1159541`; fail-closed deployment `dpl_DV5ssFvgTZGMdLGk51H6isptj8PE`; operation/watchdog deployment `dpl_12zrVfVYMW1oyhTndbrYNv9xo7V8`; scheduled request and recurring protected audit | 🟩 | The verified source is live at the canonical production alias. All six switches were first created as explicit false values; root and authentication-boundary smoke checks passed and the protected snapshot stayed unchanged. With only `BOOKING_LIFECYCLE_OPERATION_WORKERS_ENABLED=true`, the configured scheduler invoked `/api/cron/booking-status-emails` at 02:45 Asia/Dhaka and received `200`; Vercel showed no error-level log. The post-run audit preserved all protected facts, all 11 owned cases, and zero supplier, wallet, case-decision, outbox, worker-run, or email side effects. The fail-closed deployment is the application rollback checkpoint; switching the operation flag back to false is the behavior rollback. |
| P12.7 staged actions | 2026-08-12 | Reconciliation deployment `dpl_23Vxe9Vfs8EvZV45eHWijpfWzcwk`; imported-action deployment `dpl_DuhyxYYfweURf7sXjdM8DZAZs8mZ`; imported-worker deployment `dpl_ArQDHH6c7y47uupPvK2WoQoxiL34`; protected endpoint, scheduler, and recurring audit checks | 🟩 | Reconciliation actions were enabled first, followed by imported manual actions and then the independent imported SLA worker. Unauthenticated POSTs to all reconciliation and imported mutation entry points returned `401`; action stages showed no Vercel error logs and no protected-state drift. This activates staff Sync/verification without a debit path while database contracts enforce evidence, roles, prior authorization, atomicity, idempotency, and maker-checker. The 03:00 scheduler request returned `200`, with no error log; the post-run audit preserved all protected facts and zero supplier, wallet, case-decision, outbox, worker-run, or email effects. Each switch can be returned to false independently as rollback. |
| P12.8 notification outbox | 2026-08-12 | Deployment `dpl_8yvQ45YMzH5yiexdxcCJ91h1GMPQ`; zero-backlog preflight; public/auth smoke; scheduled request; recurring protected audit | 🟩 | `BOOKING_NOTIFICATION_OUTBOX_ENABLED=true` was deployed separately after verifying zero live outbox and delivery rows. Root returned `200`; unauthenticated metrics and cron requests returned `401`; no error log or protected-state drift was present after cutover. No test event or email was generated. The 03:15 scheduled recovery/delivery cycle returned `200`, and the post-run audit retained zero outbox/delivery rows, zero protected changes, and zero email side effects. Rollback is this switch back to false. |
| P12.9 scalable sweep | 2026-08-12 | Deployment `dpl_2eTXQxzp4msNuX7fB5H6XoJXiJzr`; public/auth smoke; 03:30 scheduled request; durable worker/aggregate metrics; recurring protected audit | 🟩 | `BOOKING_LIFECYCLE_SCALABLE_SWEEP_ENABLED=true` was deployed last, replacing the bounded compatibility observer with the durable keyset/time-budget worker and bounded Unconfirmed repair. The scheduled request returned `200` with no error log. Its single durable run succeeded with stop reason `drained`, one batch, zero selected, and zero inserted. Due-expiry, starved-expiry, and Unconfirmed-repair backlogs are zero; failed, bounded, and stale-running counts are zero; no 24-hour expiry observation existed, so average/p95/max latency are correctly zero. The post-run audit preserved every protected fact, all 11 owned cases, zero outbox/delivery rows, and no supplier, wallet, case-decision, or email side effects. Rollback is this switch back to false, which restores the bounded compatibility observer. |
| P12.10 / P9 remediation authority gate | 2026-08-12 | Live identity-free case-state aggregation; protected snapshot/classification; maker-checker verifier | 🟥 | All 11 projected cases remain explicitly open: 2 cancellation uncertainty, 1 legacy review, 1 attempt uncertainty, 4 historical inconsistency, 1 terminal conflict, and 2 imported payment conflict. Exactly zero have evidence fresh within five minutes, a proposal, an approval, or a resolution. Static and database contracts reject self-approval and stale/missing evidence. Resolving these records requires fresh supplier/portal evidence plus two different authorized human staff identities and case-specific business/financial judgment; automation must not impersonate either actor. No supplier read, proposal, decision, wallet change, status change, or email was attempted. |
| P9.9 | 2026-08-12 | Service-role read-only current stored/derived Pending counts and immutable occurrence count | 🟩 | Current stored Pending bookings are zero and current derived Pending bookings are zero. One historical Pending lifecycle occurrence remains as immutable audit history and does not represent an active anomaly. No booking, event, case, wallet, or email row changed. |
| P9.5 current gate | 2026-08-12 09:23 +06:00 | Identity-free read of `booking_attempt_reconciliation_queue_v` | 🟥 | The single case remains open with attempt state `submitting`, no operation identity, no PNR lookup eligibility, no stored fresh evidence, no reservation, and no recovered booking. AirTicketingDetails may be read, but an inconclusive result requires a real supplier-portal investigation. Destructive replay and automatic resolution are both false. An authorized Support/Admin/Super Admin investigator must obtain evidence and a separate authorized checker must approve any high-risk outcome; no attempt or case row was changed. |
| P9.6 current gate | 2026-08-12 09:23 +06:00 | Read-only target booking and case-state verification | 🟥 | The target remains Cancelled/Captured with captured funds present, zero refunded amount, and no authoritative cancellation timestamp. Its distinct historical-timestamp and terminal-financial cases are both open with no fresh evidence, proposal, approval, resolution, or financial disposition. Supplier truth and an explicit full/partial/no-refund/external-settlement/manual-adjustment decision must be made by authorized humans through maker-checker; no row or wallet value was changed. |
| P9.7 current gate | 2026-08-12 09:23 +06:00 | Read-only Cancelled/missing-timestamp and historical-case aggregation | 🟥 | Four Cancelled bookings still lack `cancelled_at`, and all four matching historical-inconsistency cases remain open. None has fresh evidence, a proposal, an approval, or a resolution. An exact supplier/portal cancellation instant must be acquired and approved; generic `updated_at` remains forbidden as an inferred replacement. No timestamp or case row was changed. |
| P9.8 current gate | 2026-08-12 09:23 +06:00 | Read-only Confirmed/Unpaid IMP_EXP and payment-conflict aggregation | 🟥 | Two imported bookings remain Confirmed/Unpaid, each with one open imported-payment-conflict case. Both cases have disposition `none` and neither has fresh evidence, a proposal, an approval, or a resolution. Authorized humans must select and independently approve external settlement, Import & Charge, or another explicit case-bound financial outcome. No booking, case, wallet, reservation, or ledger row changed. |
| P9.10 current before gate | 2026-08-12 09:29 +06:00 | `npm run verify:booking-lifecycle-release`; `npm run verify:booking-remediation-post-migration`; `npm run verify:wallet:live`; aggregate lifecycle/notification/worker reads | 🟥 | The before baseline passes: all 72 non-mutating verifiers are green; protected snapshot SHA-256 `32175f06a7d376aa802d49bc20eda3574b3250de9e5f6697a001af435935c440` is unchanged; all 11 projected cases remain present; wallet resources remain service-only and direct balance mutation is denied. Live delivery health is 3 sent and 2 superseded outbox occurrences with zero pending, processing, retry, or dead-letter rows. The latest durable worker run succeeded and drained, with zero expiry, starvation, Unconfirmed-repair, failed, bounded, or stale-running backlog. This item remains red because no authorized remediation batch exists for the required after comparison. |
| P9.11 current before gate | 2026-08-12 09:29 +06:00 | Protected artifact/hash plus identity-free reconciliation-case audit aggregation | 🟥 | Full sensitive before evidence remains in the git-ignored protected snapshot; the tracked record stores only its hash and counts. All 11 cases are open with disposition `none`; fresh evidence, proposal, approval, and resolution counts are each zero. No after evidence or approver history can be claimed until independent authorized staff act through the audited workflow. No case or audit row was changed. |
| Production health follow-up | 2026-08-12 09:29 +06:00 | Read-only aggregate metrics, latest worker outcomes, and production error-log review | 🟩 | Normal live activity has grown aggregate history to 138 lifecycle events, 5 outbox occurrences, 3 recipient deliveries, and 24 worker runs without protected-snapshot drift. Notification queues and dead letters are zero; the latest worker run succeeded with stop reason `drained`. One staff preview request encountered the US-Bangla supplier website device-check page; this is an external/provider session challenge, not a lifecycle worker, wallet, outbox, or database failure. It must be handled by an authorized staff investigator when acquiring case evidence. |
| F10 / P4.11 / P5.16 / P9.12 | 2026-08-12 10:26 +06:00 | Service-role read-only attempt/case/booking/reservation/account/ledger/observation queries; production Vercel request log; two safe AirTicketingDetails GETs; deployed route/adapter/RPC trace; documentation, attempt-queue, ticketed-resolution, and supplier-validation verifiers | 🟥 | The new case is the twelfth current open case. It has zero business bookings, one 4,060,098 BDT reconciliation reservation, one matching `booking_hold` ledger row, zero captures/releases/refunds, and one uncertainty observation. Supplier report evidence consistently says Issued/Completed/Paid and matches passenger/route identity when the actual schema is normalized, but lacks current-contract booking/ticket refs and returns the PNR in `ticketNumbers`. Existing focused verifiers pass, confirming their scope stops at attempt read planning or starts from an existing booking with idealized complete ticket evidence; none covers this real response shape or attempt-to-booking execution. Containment is correct; an executable attempt-only evidence/finalization path is absent. No production row, wallet amount, supplier booking/ticket, proposal, approval, or email was changed. |
| D11 Direct Ticket design | 2026-08-12 | Complete adapter/route/evidence/RPC/schema review; temporary-plan consistency review; `npm run verify:booking-lifecycle-documentation`; `git diff --check` | 🟨 | The proposed response/evidence profiles, future normal-path prevention, atomic attempt recovery, five additive migrations, application change set, T40–T42 test matrix, staged flags, and exact `06fac0c2` recovery runbook are documented. The documentation verifier passes all permanent-document checks and the diff has no whitespace errors. No application code, migration, supplier call, production row, wallet, booking, case decision, commit, push, or deployment was changed; implementation remains blocked on D11 approval. |
| P12.11 final production invariant gate | 2026-08-12 | Recurring protected audit after every deployment; final 72-verifier release matrix; TypeScript; full ESLint; linked migration dry run; final production error-log query | 🟩 | Every rollout stage passed the same protected comparison before progression. The final gate passed all 72 non-mutating verifiers, TypeScript, and lint; linked migrations remain current through `0082`; deployment `dpl_2eTXQxzp4msNuX7fB5H6XoJXiJzr` has no error-level log in the inspected window. All protected booking/attempt/wallet/ledger/event/legacy-delivery facts remain byte/field-equivalent to snapshot `32175f06a7d376aa802d49bc20eda3574b3250de9e5f6697a001af435935c440`; all 11 cases remain owned; outbox/delivery counts are zero; the only new automation evidence is one successful drained worker run. |
| P12.12 release record | 2026-08-12 | Commit/migration/deployment/flag/rollback inventory; remote branch ancestry and push | 🟩 | Production source commit `95c12aa1d53d29073cd871d7ffff4de9b1159541` plus rollout-record commits `a32262c61d5f1484974fb20de7f23db14085efc6` and `77ba5324553f5f3f13c0c8eee4230765729f678c` are published by fast-forward to `origin/development`. Linked local/remote migrations align through `0082`. Deployment sequence: all-false `dpl_DV5ssFvgTZGMdLGk51H6isptj8PE`; operation `dpl_12zrVfVYMW1oyhTndbrYNv9xo7V8`; reconciliation `dpl_23Vxe9Vfs8EvZV45eHWijpfWzcwk`; imported actions `dpl_DuhyxYYfweURf7sXjdM8DZAZs8mZ`; imported worker `dpl_ArQDHH6c7y47uupPvK2WoQoxiL34`; outbox `dpl_8yvQ45YMzH5yiexdxcCJ91h1GMPQ`; scalable sweep/final `dpl_2eTXQxzp4msNuX7fB5H6XoJXiJzr`. Final production flag state is true for operation workers, imported workers, reconciliation actions, imported manual actions, notification outbox, and scalable sweep. Snapshot `32175f06a7d376aa802d49bc20eda3574b3250de9e5f6697a001af435935c440` is the data checkpoint. Each behavior can be disabled independently; the all-false deployment is the application checkpoint; schema recovery remains forward-fix only. `main` was not merged or pushed because human remediation, compatibility, and final handoff gates remain. |
| P12.13 final temporary-file gate | 2026-08-12 | User-approval boundary review | 🟥 | The user authorized continued migration and rollout work but has not explicitly approved deletion of this temporary implementation-control document at final handoff. The file remains tracked and contains the active human-remediation, compatibility, and release checkpoints. It must not be deleted implicitly. |

---

# Definition of done

The lifecycle implementation is complete only when all of the following are
true:

- 🟩 All seven statuses have one precise public business meaning.
- 🟩 Customers see clear, safe status explanations and correct timestamps.
- 🟩 Staff can identify every active operation and reconciliation reason.
- 🟥 Every open case has ownership, evidence, SLA, actions, and escalation.
- 🟩 Every supplier uncertainty path terminates in an owned case or verified
  result without replaying a destructive write.
- 🟥 Every successful Direct Ticket response either atomically creates and
  settles one STR or creates one owned In Progress/attempt case with the original
  hold protected; no legacy-field mismatch can make supplier success invisible.
- 🟩 Booking truth and financial truth cannot silently disagree.
- 🟥 All money-changing reconciliation is atomic, idempotent, audited, and
  properly authorized.
- 🟩 Imported manual ticketing has a complete payment-to-verification workflow.
- 🟩 Fast intermediate emails are coalesced without losing event history.
- 🟩 Status re-entry can notify again using occurrence-based idempotency.
- 🟩 Processing Since uses the real operation start time.
- 🟩 Derived lifecycle observation scales without starvation.
- 🟩 Historical anomalies are resolved or explicitly owned.
- 🟥 Documentation and staff runbooks match production behavior.
- 🟥 All required tests and rollout gates pass.
- 🟥 The user approves final handoff and deletion of this temporary file.
