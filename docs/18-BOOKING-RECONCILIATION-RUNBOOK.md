# Booking Reconciliation Operations

This guide is the staff operating contract for booking and booking-attempt
uncertainty. It never authorizes direct database edits. Staff use the booking
dashboard and its audited case actions; lifecycle or wallet changes occur only
through the named, idempotent database workflows described here.

## Roles and Separation of Duties

| Capability | Authorized roles |
| --- | --- |
| View operational cases | Support, Accounts, Admin, Super Admin |
| Acquire supplier evidence | Support, Admin, Super Admin |
| View normalized financial evidence | Accounts, Admin, Super Admin |
| Propose supplier/lifecycle truth | Support, Admin, Super Admin |
| Propose wallet/refund/settlement truth | Accounts, Admin, Super Admin |
| Propose a combined supplier + financial outcome | Admin, Super Admin |
| Approve/reject high-risk outcome | Admin, Super Admin, different user from maker |
| Execute approved outcome | Approving authorized actor or trusted worker through the exact case action |

The database re-reads the current role at every decision/execution call. A
demotion takes effect immediately. No Admin or Super Admin can approve their own
proposal, and using another browser/session for the same person does not satisfy
maker-checker.

Customers, B2B owners, and B2B sub-users never see cases. Their ordinary booking
and Confirm & Pay permissions are separate workflows.

## Super Admin Issue Now Resolution

The evidence/maker-checker procedures below remain the normal workflow for
Support, Accounts, and Admin. Super Admin may instead make an explicit one-step
decision from the booking detail page without evidence, a proposal, a different
checker, or a second execution action.

This override never sends a supplier Book/Ticket/Cancel request. Proven local
accounting derives automatic Capture/Release/Refund/No Movement. If local
accounting is incomplete, Super Admin may use the clearly separate
supplier-verified manual lane for this booking owner's wallet after reviewing
current and resulting Available/Hold balances. The customer-wallet amount is
entered independently; supplier amount never determines it. The manual action
uses a distinct append-only ledger transaction, protects Hold assigned to other
bookings, never fabricates a reservation, and commits with immutable resolution
and audit records. Historical cases/evidence remain retained. This exception is
not available for Instant Purchase, imports, deposits, or generic adjustments.

## Evidence Standard

Decision evidence is fresh for five minutes from successful response receipt.
Use the case’s Acquire Evidence or imported Sync action so the system stores:

- supplier source and read purpose;
- request start and complete-response time;
- booking, provider, supplier reference, PNR, route, and passenger identity
  matches;
- normalized lifecycle, tickets, cancellation, and financial facts;
- protected raw-payload SHA-256 hash and normalizer version.

Ticket issuance requires complete identity-matching PNR and ticket-detail
evidence, including exactly one non-empty ticket for each stored passenger.
Cancellation with ticket/captured history requires both cancellation and
ticket/financial evidence. A Held read or one negative endpoint cannot prove
non-issuance after an uncertain write; record the approved manual supplier-
portal attestation and use the non-issuance workflow.

Do not reuse the historical remediation snapshot as decision evidence. Do not
paste raw supplier/passenger payloads into reasons, tickets, chat, or email.
When evidence is stale, acquire it again under a new request identity; never
change the stored observation.

## SLA and Escalation

| Work type | Initial owner | Target | Escalation |
| --- | --- | --- | --- |
| Active Triplover Book/NewTicket/Cancel | Support | Watchdog marks reconciliation after 3 minutes from supplier-call start | Admin at detection; Super Admin if unresolved at 2 hours |
| Ticketing/cancellation uncertainty | Support | 30 minutes from case opening | Admin at due time; Super Admin at 2 hours open |
| Imported manual ticketing | Support | Earlier of capture + 2 hours or deadline − 60 minutes | Unassigned warning at 30 minutes; Admin at due; Super Admin after 60 overdue minutes |
| Terminal/direct-ticket payment conflict | Admin with Accounts | Propose/resolve within 60 minutes | Immediate Admin attention; Super Admin at 2 hours |
| Unknown/submitting attempt | Support | 15 minutes from watchdog detection | Admin at 60 minutes; Super Admin at 2 hours |
| Legacy/historical inconsistency | Admin | Triage in one business day | Super Admin after three business days without approved plan |

The protected scheduler is bounded and normally runs every 15 minutes. A
three-minute watchdog condition can therefore be observed roughly 3–18 minutes
after the supplier call began. Metrics distinguish operation age, case SLA,
notification retries/dead letters, expiry backlog/latency, and worker health.

### Production rollout controls

Every behavior switch is server-only, defaults off, and enables work only when
its exact value is `true`. Change one family at a time, redeploy, run the
read-only invariant audit, and record the deployment and queue metrics before
continuing.

| Environment switch | Controlled behavior |
| --- | --- |
| `BOOKING_LIFECYCLE_OPERATION_WORKERS_ENABLED` | Operation and attempt watchdogs |
| `BOOKING_LIFECYCLE_IMPORTED_WORKERS_ENABLED` | Imported manual-ticket SLA escalation |
| `BOOKING_RECONCILIATION_ACTIONS_ENABLED` | Supplier evidence, attestation, proposal, and decision endpoints |
| `BOOKING_IMPORTED_MANUAL_ACTIONS_ENABLED` | Imported Sync, charge authorization, completion, and financial disposition endpoints/UI |
| `BOOKING_NOTIFICATION_OUTBOX_ENABLED` | Immediate and scheduled occurrence-outbox email delivery, claim recovery, and dead-letter escalation |
| `BOOKING_LIFECYCLE_SCALABLE_SWEEP_ENABLED` | Keyset/time-budget expiry worker and unconfirmed repair |

While the scalable switch is off, the scheduler retains the bounded legacy
expiry observer for rolling compatibility. While notification delivery is off,
new occurrence intents stay durable in the outbox and no immediate or scheduled
email entry point sends them. Inspect the queued occurrences before enabling
delivery; do not use a manual mail send as a rollout test.

## Maker-Checker Sequence

1. Confirm the correct subject and open case; do not create a duplicate case.
2. Acquire fresh case-bound evidence and review all validation issue codes.
3. Select the narrow outcome and only its required financial disposition.
4. Record the reason and required confirmation codes without raw PII.
5. Submit the proposal. Record its case version and proposal hash.
6. A different Admin/Super Admin rechecks evidence, current facts, amount,
   currency, and consequences, then approves or rejects the unchanged proposal.
7. Execute only the named action shown for the approved proposal. A conflict or
   stale-evidence response means stop, refresh the case, and begin a new proposal.
8. Confirm operation/case state, ledger/balance equation, lifecycle event, and
   notification decision. Exact replay is for response recovery only; do not
   substitute another request ID after an uncertain execution response.

## Emergency Stop and Containment

Stop the affected rollout/action when any of these occurs:

- duplicate or unexplained wallet movement;
- status/payment truth changes without an event and owned case/disposition;
- supplier write retry after an ambiguous response;
- self-approval or role-boundary failure;
- notification to an unexpected visible recipient or exposed hidden copy;
- growing worker backlog with no cursor/run progress;
- security audit failure for evidence, proposal, decision, or execution.

Containment procedure:

1. Stop submitting the affected UI action and preserve its request ID, case ID,
   proposal hash, time, and safe error code. Do not retry with a new identity.
2. Notify Admin/Super Admin and Accounts immediately for any money risk. Use the
   approved wallet-freeze control when an owner account may be exposed.
3. Set the affected server-only rollout switch to false and redeploy through the
   hosting control owned by the release operator. Use deployment rollback for a
   broader application fault. Do not roll back additive schema or edit
   production rows manually.
4. Capture read-only aggregate metrics, audit records, operation/case state, and
   the protected backup identifier. Keep raw supplier/passenger evidence inside
   its restricted storage boundary.
5. Roll back only the application stage when safe, or deploy a reviewed forward
   fix. Re-run lifecycle, wallet, ledger, event, notification, and access-control
   gates before re-enabling.
6. Any correction uses a new approved case outcome/ledger entry; never update or
   delete immutable history.

## Case-Type Playbooks

Every playbook starts by confirming the subject, open case type/state, current
operation, reservation/payment facts, due time, and prior observations. If the
dashboard does not expose the required named action, leave the case owned and
escalate; never replace it with a generic booking or wallet action.

### `ticketing_uncertainty`

**Owner:** Support; involve Accounts for hold/capture consequences.

1. Acquire fresh Ticketed evidence using PNR and AirTicketingDetails.
2. If tickets are complete and identities agree, propose `ticketed` with
   `capture_existing_hold`; a different Admin/Super Admin approves and executes
   the ticketed-capture action.
3. If supplier truth is Held, do not release from the read alone. Record the
   approved non-issuance attestation, propose `held_not_ticketed` with
   `release_existing_hold`, then obtain independent approval/execution.
4. If endpoints disagree or evidence is incomplete, keep the case open and
   escalate. Never call NewTicket again.
5. Verify one capture or release ledger consequence, reservation terminal state,
   completed/failed operation, resolved case, and one material occurrence.

### `cancellation_uncertainty`

**Owner:** Support for supplier truth; Accounts for financial disposition.

1. Acquire fresh Cancelled evidence and, when ticket/captured history exists,
   ticket/financial evidence too.
2. For exact Unpaid/no-reservation truth, propose the no-wallet cancellation.
3. For an active hold, propose `release_existing_hold`; this is a hold release,
   not a refund.
4. For captured funds, Accounts proposes full/partial refund, no refund due,
   external settlement, or manual adjustment. A different Admin/Super Admin
   approves.
5. If cancellation is not authoritative, reject the proposal and keep the
   original lifecycle protected. Never infer cancellation time from `updated_at`.

### `legacy_review`

**Owner:** Admin; collaborate with Support/Accounts according to the missing
supplier or financial fact.

1. Classify the legacy row without changing it.
2. Acquire current supplier evidence and locate authoritative historical records
   for any claimed effective timestamp or settlement.
3. Propose only the narrow historical repair supported by those records. Include
   `confirm_legacy_review_path` and any applicable terminal/financial confirmation.
4. Require independent approval. Timestamp-only repair is notification-
   suppressed but still creates immutable audit/event decision history.
5. If exact evidence is unavailable, record the investigation and keep the case
   owned rather than inventing truth.

### `terminal_conflict`

**Owner:** Admin with Accounts collaboration; immediate high-risk attention.

1. Acquire fresh evidence for both the asserted terminal outcome and all money/
   ticket consequences.
2. Confirmed → Cancelled uses only a named captured-cancellation disposition.
3. Cancelled → Confirmed is allowed only with complete matching ticket evidence,
   captured and unrefunded matching reservation truth, and no wallet movement.
4. Any unpaid, held, released, refunded, or identity-mismatched reverse
   correction stays blocked for a different controlled workflow.
5. Require a different checker and verify cleared/retained terminal fields in
   immutable resolution metadata.

### `direct_ticket_payment_failure`

**Owner:** Admin with Accounts.

1. Confirm complete ticket evidence and the exact booking owner/currency/payment
   facts.
2. Locate the protected reservation/ledger obligation. Never create a debit from
   ticket status alone or use the generic refund endpoint.
3. Propose the exact supported financial consequence, obtain independent
   approval, and execute only the case-bound action.
4. If no safe captured/held obligation exists, use
   `manual_adjustment_required` and keep the inconsistency visible.
5. Verify booking ticket truth remains Confirmed while payment truth/case state
   reports the actual outcome.

### `imported_manual_ticketing`

**Owner:** Support until fresh negative evidence routes it to Accounts.

1. Use imported Sync; do not use Triplover Issue/Cancel/Refresh.
2. Ticketed evidence enables Complete. Complete reuses the original capture and
   must report zero additional debit.
3. Held evidence remains Support follow-up until the task deadline.
4. Cancelled/Expired/Unconfirmed evidence routes to Accounts; conflict routes to
   critical Admin reconciliation.
5. Verify the persisted due/escalation state and original single capture fact
   bundle before any terminal action.

### `imported_payment_conflict`

**Owner:** Accounts with Admin/Super Admin checker.

1. Confirm whether the booking was intentionally imported through Import Only
   and review supplier ticket evidence, owner, User Payable, Supplier Gross, and
   currency.
2. Do not call the expired import authorization or legacy auto-charge RPC.
3. Resolve through the available approved payment workflow: documented external
   settlement, a newly authorized case-bound financial obligation, or explicit
   manual adjustment. Keep Confirmed ticket truth visible throughout.
4. Never use Supplier Gross as the debit amount.
5. Verify any wallet movement has one new immutable key and the case records the
   exact disposition; otherwise leave it open.

### `attempt_uncertainty`

**Owner:** Support; escalate aged cases to Admin.

1. Review the attempt timeline and immutable Book-call request/response boundary.
2. Use stored supplier references for read-only supplier investigation. Do not
   replay Book and do not create a placeholder Pending/In Progress booking.
3. Definitive non-creation may resolve the attempt failed through the controlled
   attempt workflow. Authoritative proof of a real booking may use only the
   atomic attempt-to-booking recovery action when available.
4. If identifiers/evidence are insufficient or conflicting, retain the case and
   escalate; the absence of a public reference is expected.
5. Verify no wallet reservation/ledger or customer event was fabricated.

### `historical_inconsistency`

**Owner:** Admin; Accounts joins for any payment inconsistency.

1. Identify the exact missing/contradictory fact (for example `cancelled_at`).
2. Accept only an authoritative source containing the exact business-effective
   value. A generic booking update time is never a substitute.
3. Submit a version-bound historical repair proposal with the required
   confirmation code and independent checker.
4. Pure timestamp repair is notification-suppressed. A newly material travel or
   money outcome follows normal event/outbox policy and cannot be silently
   suppressed.
5. When evidence cannot establish the fact, keep it unknown and the case owned.

## Batch Verification After Any Resolution

- No ad hoc booking, wallet, reservation, ledger, event, case, or outbox write.
- Reservation amount/currency and captured/refunded equations reconcile.
- Exactly one idempotent ledger consequence where money moved; none otherwise.
- Operation and case state agree with the outcome and retain maker/checker audit.
- Event occurrence and notification decision exist; hidden copies remain
  envelope-only and no completed recipient is resent.
- Staff metrics no longer count a resolved case, or still show the intentionally
  open manual-adjustment case.
- Record the deployment/version, case batch, protected before/after evidence,
  verifier output, and rollback/forward-fix checkpoint without passenger PII.

## References

- [Booking Lifecycle](08-BOOKING-LIFECYCLE.md)
- [Wallet System](10-WALLET-SYSTEM.md)
- [Database Architecture](12-DATABASE.md)
- [API Routes](13-API-ROUTES.md)
- [Security](14-SECURITY.md)
- [Deployment](15-DEPLOYMENT.md)
- [IMP/EXP Imports](17-IMP-EXP-IMPORTS.md)
