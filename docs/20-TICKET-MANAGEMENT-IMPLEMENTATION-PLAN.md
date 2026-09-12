# Ticket Management Implementation Plan

## Document status

- **Status:** Implementation authorized; Phases 0-11 and generic wallet
  authorization hardening are complete. Production migrations `0119`-`0129`
  are applied and verified while
  Ticket Management remains fail-closed with
  `TICKET_MANAGEMENT_ENABLED=false`. The owner accepted the absence of a
  separate Supabase staging rehearsal for this release. Gate 5 is blocked until
  a dedicated confirmed, unused production test booking is explicitly
  provisioned; an ordinary customer booking must not be used. Notification
  delivery, scheduler activation, and live wallet smoke remain unauthorized.
- **Created:** 2026-08-30
- **Scope:** Refund, Reissue, and VOID request management for confirmed/ticketed
  bookings.
- **Supplier model:** All supplier, airline, GDS, and portal work is performed
  manually outside ShopOnTravels. There is no supplier Refund, Reissue, VOID,
  or supplier-balance API dependency.
- **Change rule:** Update this document when a product decision changes, after
  completing a phase, or when verification reveals a new constraint. Do not
  mark a phase complete until its acceptance criteria have been checked.

This document is the implementation handoff and progress record for Ticket
Management. It does not authorize source changes, database migrations,
database application, dependency changes, commits, pushes, deployments, or
live financial actions.

## Objective

Build a shared Ticket Management domain for Refund, Reissue, and VOID that:

- exposes a clear customer request and quotation lifecycle;
- supports role-specific operational and financial actions;
- binds every settlement to the exact customer-approved quotation;
- always settles against the original booking owner wallet;
- supports partial passengers/tickets and multiple sequential requests;
- preserves current wallet, ledger, idempotency, concurrency, and audit safety;
- does not require a supplier API or mandatory evidence upload workflow; and
- does not overload the existing seven-status booking lifecycle.

## Agreed product contract

### Customer-facing statuses

```text
Requested
  -> In Progress
  -> Awaiting Confirmation
  -> Approved
  -> Completed

Awaiting Confirmation -> Rejected
Awaiting Confirmation -> Expired
Requested -> Rejected            (staff rejects the incoming request)
```

`Rejected` and `Expired` are terminal Ticket Management statuses. They retain
their own status and terminal reason rather than being immediately overwritten
by a generic Completed status.

Status meanings:

| Status | Meaning |
| --- | --- |
| Requested | Customer submitted a Refund, Reissue, or VOID request. |
| In Progress | Staff accepted the request and is manually checking rules and amounts. |
| Awaiting Confirmation | An immutable quotation and mandatory deadline are waiting for the customer. |
| Approved | Customer accepted the exact quotation; manual external processing may proceed. |
| Completed | Manual work and the required ShopOnTravels wallet settlement are complete. |
| Rejected | Staff rejected the incoming request or the customer rejected the quotation. |
| Expired | The customer did not decide before the published quotation deadline. |

### Role contract

| Capability | Customer / booking owner | Support | Accounts | Admin | Superadmin |
| --- | ---: | ---: | ---: | ---: | ---: |
| Submit request | Yes | No | No | No | No |
| View own request | Yes | No | No | No | No |
| View operational queue | No | Yes | Financial scope | Yes | Yes |
| Accept/reject Requested item | No | Yes | No by default | Yes | Yes |
| Investigate and prepare quotation | No | Yes | Optional financial participation | Yes | Yes |
| Publish quotation and deadline | No | Yes | If explicitly permitted | Yes | Yes |
| Approve/reject quotation | Yes | No | No | No | No |
| Assign Approved financial work | No | Yes | No by default | Yes | Yes |
| Final wallet settlement | No | No | Yes, when assigned | Yes, when assigned | Yes, when assigned |
| Arbitrary settlement amount | No | No | No | No | No |

Final settlement roles are exactly `staff_account`, `admin`, and
`superadmin`. The finalizer must also be the request's active financial
assignee. Reassignment must be explicit and audited; elevated roles do not
silently bypass the active assignment.

Customer approval is the authorization for the exact quotation. The ordinary
happy path does not add a separate mandatory evidence or maker/checker step.
Existing maker/checker and reconciliation controls remain applicable to
generic adjustments, accounting conflicts, and exceptional correction paths.

### Wallet contract

| Stage | Refund | Reissue | VOID net return | VOID additional payment |
| --- | --- | --- | --- | --- |
| Requested | None | None | None | None |
| In Progress | None | None | None | None |
| Awaiting Confirmation | None | None | None | None |
| Customer Approved | None | Available -> request Hold | None | Available -> request Hold |
| Manual external work | None | Hold remains | None | Hold remains |
| Authorized completion | Credit approved net amount | Hold -> Capture | Credit approved net amount | Hold -> Capture |
| Definitive failure/not performed | None | Hold -> Available | None | Hold -> Available |
| Rejected/Expired before approval | None | None | None | None |

The confirmation deadline applies only while Awaiting Confirmation. Once the
customer approves and a Hold exists, the quotation deadline must not release
that Hold automatically.

### Non-negotiable financial invariants

- Store money as positive integer minor units and use an explicit direction;
  do not use floating-point database amounts.
- Currency must match the original charged wallet account and booking.
- Settlement always uses `flight_bookings.charged_wallet_account_id` and the
  durable booking owner. It never resolves a wallet from the staff session.
- B2B and B2B-sub bookings continue to use the shared agency wallet; B2C uses
  the original customer wallet.
- Published quotations are immutable. A change creates a new version and
  requires a new deadline and customer decision.
- Final settlement reads its amount from the approved quotation in the
  database; the finalization request never supplies an editable amount.
- Request status, wallet balances, reservation, ledger, entitlement
  consumption, audit event, and Completed transition commit atomically.
- Exact retries replay the stored result. Reusing a request key with different
  intent fails.
- Support cannot call a final settlement, capture, release, refund, VOID
  credit, or unrestricted adjustment path.
- Refund and VOID cannot consume or return the same passenger/ticket/coupon
  entitlement twice.
- A failed or ambiguous local financial finalization fails closed and enters
  an explicit reconciliation/exception state; it never guesses.
- No existing immutable ledger or audit record is edited or deleted.

## Scope exclusions

This project does not include:

- supplier-side Refund, Reissue, or VOID API integration;
- supplier balance tracking or mirroring;
- mandatory evidence uploads or an evidence approval queue;
- replacing the normal initial booking Issue Now flow;
- changing historical wallet ledger rows;
- treating held-booking cancellation as ticket VOID;
- one-request-per-booking/action uniqueness;
- package, framework, or tooling upgrades; or
- a live database migration, push, deployment, or financial smoke test without
  separate explicit authorization.

Optional staff notes and external/manual operation references may be retained
as internal audit metadata, but are not a mandatory evidence workflow.

## Expected architecture boundaries

The eventual implementation is expected to add a dedicated domain rather than
placing Ticket Management transitions inside generic booking or wallet route
handlers.

Likely new areas:

- `lib/ticket-management/` — types, lifecycle contracts, authorization,
  quotation hashing, validation, and service orchestration.
- `lib/db/ticket-management.ts` — typed database/RPC adapters.
- `app/api/ticket-management/` — customer and staff API boundaries.
- `components/dashboard/ticket-management/` — internal queues, quotation,
  assignment, and settlement UI.
- `scripts/verify-ticket-management-*.mjs` — focused structural and behavioral
  verification.
- Future forward-only files under `supabase/migrations/` — numbers and names
  must be selected only after implementation is authorized and the local/remote
  migration ledger is rechecked.

Existing integration areas likely to change later:

- `components/flights/PostTicketActionsPreview.tsx`
- `components/flights/BookingActions.tsx`
- `components/flights/BookingDetails.tsx`
- `components/dashboard/bookings/BookingsTabs.tsx`
- `components/dashboard/bookings/BookingsView.tsx`
- `lib/roles.ts`
- `lib/wallet/permissions.ts`
- `lib/db/wallet.ts`
- `app/api/wallet/refunds/route.ts`
- `app/api/wallet/adjustments/route.ts`
- `app/api/wallet/adjustments/[id]/route.ts`
- `docs/04-ROLES-AND-PERMISSIONS.md`
- `docs/08-BOOKING-LIFECYCLE.md`
- `docs/10-WALLET-SYSTEM.md`
- `docs/12-DATABASE.md`
- `docs/13-API-ROUTES.md`
- `docs/14-SECURITY.md`

These paths are planning targets, not an instruction to change every file.
Implementation should keep the final diff as narrow as the verified contract
allows.

## Phase tracker

| Phase | Name | Status | Depends on |
| --- | --- | --- | --- |
| 0 | Baseline contracts and rollout boundary | Complete | None |
| 1 | Ticket Management domain and core data model | Complete | Phase 0 |
| 2 | Status lifecycle, quotation, decision, and deadline | Complete | Phase 1 |
| 3 | Role permissions, assignment, and authorization boundary | Complete | Phases 1-2 |
| 4 | Passenger/ticket entitlement protection | Complete — corrected | Phases 1-2 |
| 5 | Request-scoped wallet and ledger substrate | Complete | Phases 1, 3-4 |
| 6 | Refund final settlement | Complete — corrected | Phases 2-5 |
| 7 | Reissue Hold/Capture/Release | Complete | Phases 2-5 |
| 8 | VOID credit and additional-payment settlement | Complete | Phases 2-5 |
| 9 | APIs, events, notifications, and service integration | Complete | Phases 2-8 |
| 10 | Customer and staff UI integration | Complete | Phase 9 |
| 11 | Regression, security, migration, and release validation | Complete — dark-state production gates passed; Gate 5 pending safe fixture | Phases 1-10 |

## Phase 0 — Baseline contracts and rollout boundary

### Scope

- Reconfirm the effective application and database contracts immediately
  before implementation begins.
- Inventory every route that can currently credit, debit, hold, capture,
  release, refund, or adjust a wallet.
- Inventory the current migration ledger and active wallet/lifecycle functions.
- Define a disabled-by-default rollout boundary so unfinished Ticket Management
  APIs cannot mutate money.
- Freeze the state, role, quotation, assignment, and wallet matrices in tests
  before adding financial behavior.

### Files/areas expected to change

- This plan and relevant architecture documentation.
- New contract-only types/tests under `lib/ticket-management/` and `scripts/`.
- A rollout/feature-gate location only if the current architecture requires it.

### Database/migration requirements

- None during inventory and contract definition.
- Recheck the linked migration ledger read-only before choosing any future
  migration number.
- Document the expected forward-only migration sequence; do not edit historical
  migrations.

### Wallet/security considerations

- Treat actual wallet account, reservation, and ledger state as authoritative.
- Identify every service-role RPC that trusts a passed role rather than loading
  the canonical role from `app_users`.
- Confirm that customer-visible rollout cannot expose a half-built financial
  path.

### Dependencies

- None.

### Acceptance/verification criteria

- The current route/RPC authorization inventory is complete.
- The agreed role and wallet matrices are represented in executable contract
  tests or static verifiers.
- Every existing bypass candidate is listed in the Generic Path Handling
  section below.
- No application behavior, migration, database row, dependency, or deployment
  changes during this phase.

## Phase 1 — Ticket Management domain and core data model

### Scope

- Add an independent request identity for every Refund, Reissue, and VOID
  request.
- Keep Ticket Management status separate from `flight_bookings.status` and the
  public booking lifecycle.
- Preserve multiple sequential requests for the same booking/action.
- Store immutable request history and durable booking/wallet snapshots.
- Define terminal reasons separately from status, including staff rejection,
  customer rejection, confirmation expiry, refunded, reissued, and voided.

Recommended core records:

- `ticket_management_requests`
  - UUID and public request reference;
  - booking/action/status/version;
  - terminal outcome;
  - original booking owner type/key, charged wallet account, and currency;
  - requester and lifecycle timestamps;
  - active quote, active assignment, and settlement pointers where applicable.
- `ticket_management_request_events`
  - immutable transition/audit occurrences with actor, role, timestamps,
    request version, safe metadata, and idempotency identity.

### Files/areas expected to change

- Future forward-only migration(s).
- `lib/ticket-management/types.ts`
- `lib/ticket-management/lifecycle.ts`
- `lib/db/ticket-management.ts`
- Database and lifecycle documentation.

### Database/migration requirements

- Add tables, checks, indexes, foreign keys, immutable-event guards, and RLS or
  service-only access as appropriate.
- Use `on delete restrict` for financially relevant links. Do not cascade-delete
  request or audit history.
- Add an optimistic positive `version` field.
- Do not add uniqueness on `(booking_id, action)`.
- Index active queues by action/status/created time and customer history by
  durable owner identity.

### Wallet/security considerations

- Snapshot the original charged account and owner but verify them again against
  the locked booking during financial actions.
- Do not expose internal booking IDs, wallet account IDs, staff identities, or
  private notes through customer DTOs.
- Request creation performs no wallet movement.

### Dependencies

- Phase 0 contract inventory.

### Acceptance/verification criteria

- Multiple Refund/Reissue/VOID requests can coexist sequentially for one
  booking.
- Ticket Management status cannot mutate or be mistaken for booking status.
- Request and event records cannot be destructively deleted through normal
  application paths.
- Customer and staff read projections expose only their permitted fields.
- Creating a request changes no wallet, reservation, ledger, booking payment
  state, or supplier state.

## Phase 2 — Status lifecycle, quotation, decision, and deadline

### Scope

- Implement the allowed state-transition graph and reject all other
  transitions.
- Add immutable/versioned quotations and customer decisions.
- Require a future confirmation deadline before publishing a quotation.
- Use server/database time for approval, rejection, and expiry decisions.
- Support safe requotation without editing an approved quotation.

Recommended quotation facts:

- action and selected passenger/ticket scope;
- currency;
- supplier Gross Fare, Supplier Payable, and selected User Payable entitlement
  as separate immutable amounts;
- airline fee, fare difference, reissue fee, VOID fee, and service fee;
- final customer amount and direction (`credit`, `debit`, or `none`);
- staff note/details;
- quotation version/hash;
- published and deadline timestamps;
- publisher identity.

### Files/areas expected to change

- Future migration(s) for quotations, decisions, transition functions, deadline
  indexes, and immutable history.
- `lib/ticket-management/lifecycle.ts`
- `lib/ticket-management/quotation.ts`
- `lib/ticket-management/validation.ts`
- `lib/db/ticket-management.ts`
- A bounded expiry worker/cron integration if required.

### Database/migration requirements

- Add `ticket_management_quotes` and customer decision storage.
- Published quotations must be immutable; a correction creates a new version.
- Store quotation amounts as minor-unit integers.
- Add exactly-one active/published quotation constraints where applicable.
- Add atomic transition RPCs using expected request version and current status.
- Add an indexed, bounded expiry claim based on `clock_timestamp()`.
- Ensure approval-versus-expiry races serialize so exactly one terminal result
  wins.

### Wallet/security considerations

- Requested, In Progress, Awaiting Confirmation, Rejected, and Expired perform
  no wallet movement.
- Refund and net-return VOID approval perform no wallet movement.
- Reissue/payable-VOID approval will gain an atomic Hold only after Phase 5.
- Until the Hold integration exists, approval for debit-direction quotations
  must remain disabled by rollout gating.
- The browser countdown is display-only; the server deadline is authoritative.

### Dependencies

- Phase 1 request identity and versioning.

### Acceptance/verification criteria

- Only the agreed transitions succeed.
- Awaiting Confirmation is impossible without a complete quotation and future
  deadline.
- A quotation cannot be approved at or after its deadline.
- Duplicate approve/reject/expire calls replay or conflict without producing
  multiple decisions.
- Old quotation versions cannot be approved after requotation.
- Rejected and Expired remain visible terminal statuses with immutable causes.
- No status-only transition mutates a wallet.

## Phase 3 — Role permissions, assignment, and authorization boundary

### Scope

- Add Ticket Management-specific permissions rather than using broad generic
  wallet access.
- Implement role-dependent actions for customers, Support, Accounts, Admin,
  and Superadmin.
- Add active financial assignment and immutable assignment history.
- Require the final settlement actor to be both authorized and actively
  assigned.

Recommended permission boundaries:

- `canCreateOwnTicketRequest`
- `canOperateTicketRequest`
- `canPublishTicketQuotation`
- `canAssignTicketSettlement`
- `canFinalizeTicketSettlement`

### Files/areas expected to change

- `lib/roles.ts`
- `lib/wallet/permissions.ts` or a dedicated
  `lib/ticket-management/permissions.ts`
- `lib/dashboard/bookings.ts` and Ticket Management read scopes.
- Future migration(s) for assignment records and database authorization.
- New assignment API/service and audit tests.

### Database/migration requirements

- Add active assignment fields or a dedicated assignment table plus immutable
  assignment events.
- Validate the target user exists and currently has role `staff_account`,
  `admin`, or `superadmin`.
- Assignment/reassignment must check expected request version and Approved
  status.
- Financial RPCs must load the actor's canonical current role from
  `app_users`; do not trust a caller-provided role string.
- Recheck that the actor is the active assignee under the same transaction lock
  used for settlement.

### Wallet/security considerations

- Assignment does not itself grant wallet access or move money.
- Support may assign but cannot be assigned as financial finalizer.
- No implicit Admin/Superadmin override: reassign first, then settle, so the
  audit trail remains explicit.
- A user whose role changes after assignment must fail authorization until the
  request is reassigned.

### Dependencies

- Phase 1 request/event model.
- Phase 2 Approved state and quotation identity.

### Acceptance/verification criteria

- Support can perform only the agreed operational actions.
- Support receives a forbidden result from every Ticket Management wallet RPC,
  including direct crafted requests.
- Accounts/Admin/Superadmin cannot settle unless currently assigned.
- Customer/agency users cannot access internal assignment or settlement data.
- Every assignment and reassignment records old/new assignee, actor, role,
  timestamp, request version, and reason where supplied.
- API checks and database checks independently enforce the same role matrix.

## Phase 4 — Passenger/ticket entitlement protection

### Scope

- Freeze the selected passengers, ticket numbers, and coupon/segment scope per
  request.
- Define a deterministic financial entitlement basis for partial Refund and
  VOID processing.
- Track entitlement consumption independently from net wallet credit.
- Record Reissue lineage from old tickets/coupons to new tickets/coupons.
- Prevent Refund plus VOID, or repeated requests, from consuming the same
  entitlement twice.

### Files/areas expected to change

- Future migration(s) for request selections, ticket/coupon entitlement,
  settlement allocation, and Reissue lineage.
- `lib/ticket-management/entitlements.ts`
- Booking snapshot/read adapters in `lib/db/flight-bookings.ts` where necessary.
- Ticket Management request and quotation validators.

### Database/migration requirements

- Add durable request-passenger/ticket rows rather than relying only on array
  indexes in booking JSON.
- Add original entitlement, consumed entitlement, remaining entitlement,
  currency, ticket state, and lineage constraints.
- Lock selected entitlement rows during quotation publication, approval where
  required, and final settlement.
- Add uniqueness/partial uniqueness preventing incompatible active or settled
  claims against the same coupon.
- Define a safe treatment for legacy bookings whose per-ticket financial
  allocation cannot be proven; fail closed rather than splitting equally by
  assumption.

### Wallet/security considerations

- `captured_amount - refunded_amount` remains a booking-wide final ceiling but
  is not the sole partial-settlement control.
- Airline/VOID fees and service fees reduce net customer credit while the
  associated User Payable ticket entitlement is still consumed.
- Reissue additional payments must remain separately attributable so later
  refundability is a deliberate policy, not an accidental aggregate.

### Dependencies

- Phase 1 request identity.
- Phase 2 quotation scope/version.

### Acceptance/verification criteria

- Passenger 1 can be settled independently and Passenger 2 remains eligible
  for a later request where the source booking supports deterministic
  allocation.
- A fully consumed ticket cannot expose a false remaining entitlement merely
  because penalties reduced the wallet credit.
- The same coupon cannot be both refunded and voided.
- A Reissued ticket points to its predecessor and becomes the active target for
  later requests.
- Unknown or inconsistent legacy allocation blocks partial settlement without
  mutating money.

## Phase 5 — Request-scoped wallet and ledger substrate

### Scope

- Add request-scoped Hold/Capture/Release support without reusing the already
  captured original booking reservation.
- Link every Ticket Management wallet entry explicitly to its request,
  quotation, reservation where applicable, and booking.
- Establish the common lock order and idempotency contract used by all three
  actions.

Preferred additive design:

- extend `wallet_reservations` with a nullable
  `ticket_management_request_id` subject;
- update the exactly-one-subject constraint to allow booking, booking attempt,
  or Ticket Management request;
- add one request-scoped reservation per applicable approved quotation;
- add explicit Ticket Management request/quotation linkage to ledger entries;
- add distinct reporting-safe transaction types for post-ticket hold, capture,
  release, and VOID credit while retaining `refund` for request-bound Refund
  credit if its semantics remain exact.

### Files/areas expected to change

- Future wallet migration(s).
- `lib/db/wallet.ts`
- `lib/wallet/money.ts`
- `lib/wallet/http.ts`
- Ticket Management wallet service/RPC adapters.
- Wallet reporting mappings and documentation.

### Database/migration requirements

- Add request subject/link columns, checks, unique indexes, and transaction
  types through forward-only migrations.
- Keep ledger entries immutable.
- Preserve nonnegative Available and Hold balances and currency guards.
- Add request-bound reserve, capture, and release functions; do not widen the
  initial ticketing RPC contracts.
- Use a consistent lock order such as booking -> request -> quote/decision ->
  entitlement -> assignment -> reservation -> wallet -> account.
- Store terminal/replay result identity so a lost HTTP response can be safely
  recovered.

### Wallet/security considerations

- Always select the original `charged_wallet_account_id`; never offer an
  arbitrary wallet selector.
- Debit-direction approval and Hold creation must be one transaction.
- Settlement and request completion must be one transaction.
- Release is permitted only for an active request Hold and cannot release the
  original captured booking reservation.
- Canonical database roles and active assignment are checked at capture/release
  time.

### Dependencies

- Phase 1 request IDs.
- Phase 3 authorization/assignment.
- Phase 4 entitlement locks.

### Acceptance/verification criteria

- The original booking reservation remains unchanged.
- Insufficient balance leaves quotation approval, request status, balances,
  reservation, ledger, and events unchanged.
- Duplicate Hold/Capture/Release requests cannot move money twice.
- A request key reused with another amount, quote, wallet, or action fails.
- No balance becomes negative and no cross-currency reservation is possible.
- Existing Issue Now and imported ticketing reservation tests remain unchanged
  and green.

## Phase 6 — Refund final settlement

### Scope

- Implement assigned Accounts/Admin/Superadmin completion of an Approved Refund.
- Credit the immutable customer-approved net Refund amount to the original
  customer/agency Available balance.
- Consume the selected User Payable passenger/ticket entitlement and complete the
  request atomically.
- Keep manual supplier handling outside ShopOnTravels; no mandatory evidence
  upload is introduced.

### Files/areas expected to change

- Future request-bound Refund settlement migration/RPC.
- `lib/ticket-management/refund.ts`
- `lib/db/ticket-management.ts`
- `lib/db/wallet.ts`
- Future Refund completion API and staff UI.
- Wallet and Ticket Management verification scripts.

### Database/migration requirements

- Add a request-bound Refund settlement function or exact common settlement
  function with Refund-specific guards.
- Read the amount from the approved quotation; do not accept a settlement
  amount parameter.
- Reuse locked captured-reservation/account identity and booking-wide
  outstanding checks.
- Record request ID, quote ID/hash/version, entitlement consumption, ledger ID,
  finalizer, assignment, and completion event in one transaction.

### Wallet/security considerations

- Customer Approved causes no Refund wallet movement.
- Finalizer roles: assigned Accounts/Admin/Superadmin only.
- Support is forbidden by canonical database role.
- Net credit equals the approved quotation result; penalties and service fees
  are breakdown facts, not separate arbitrary debits.
- A replay returns the original wallet transaction and completion result.

### Dependencies

- Phases 2-5.

### Acceptance/verification criteria

- Refund completion credits exactly the approved net amount once.
- The credit lands in the original charged customer/agency account.
- Finalizer cannot alter the amount or currency.
- Excess, overlapping, or already-consumed entitlement fails without mutation.
- Settlement and Completed status are atomic.
- Support, unassigned Accounts, customers, and media staff are forbidden.

## Phase 7 — Reissue Hold/Capture/Release

### Scope

- Hold the exact additional Reissue payment when the customer approves.
- Allow assigned Accounts/Admin/Superadmin to capture after manual Reissue
  completion or release when it was definitively not performed.
- Preserve old-to-new ticket lineage and the approved fare/fee breakdown.

### Files/areas expected to change

- Future Reissue wallet migration/RPCs.
- `lib/ticket-management/reissue.ts`
- Ticket Management approval, capture, release, and requotation services.
- Future Reissue API and staff/customer UI.
- Focused concurrency and balance verification scripts.

### Database/migration requirements

- Customer approval and Available -> Hold must commit atomically.
- Capture/release must reference the exact request reservation and approved
  quotation.
- Freeze an immutable per-passenger fare-difference allocation with the quote;
  finalization cannot redistribute the approved total between passengers.
- Add finalizer identity, ledger links, completion/release reason, and ticket
  lineage transactionally.
- Add a controlled reopen/requote function that releases the old Hold before
  returning to In Progress when no manual external action has been completed.

### Wallet/security considerations

- Final capture and release roles: assigned Accounts/Admin/Superadmin only.
- Support may record operational progress and assign the request but cannot
  capture or release.
- The quotation deadline does not release a post-approval Hold.
- If the actual amount changes, release the old Hold, supersede the quotation,
  return to In Progress, and require a new deadline/approval.
- If manual Reissue has already happened and the amount differs, fail into an
  explicit financial exception/reconciliation path instead of requoting or
  silently charging.
- Only captured fare difference increases successor-ticket User Payable
  entitlement. Airline Reissue fee and ShopOnTravels service fee remain
  separately audited and non-refundable by default.
- The booking captured-total accounting field increases by the full captured
  Reissue payment so it continues to equal actual customer funds received;
  this accounting total is distinct from refundable successor entitlement.

### Dependencies

- Phases 2-5.

### Acceptance/verification criteria

- Approval with sufficient balance creates one exact Hold and sets Approved.
- Approval with insufficient/frozen/mismatched wallet changes nothing.
- Successful completion captures once and marks Completed — Reissued.
- Definitive non-performance releases once and does not mark Reissued.
- Duplicate, concurrent, or stale capture/release calls cannot produce two
  terminal wallet effects.
- Old and new ticket identities are retained for later requests.

## Phase 8 — VOID credit and additional-payment settlement

### Scope

- Implement both approved net-return VOID and approved additional-payment VOID.
- Use the same operational/assignment model while keeping VOID financial
  semantics distinct from held-booking cancellation and Refund.
- Consume selected ticket/coupon entitlement so Refund and VOID cannot both
  return the same value.

### Files/areas expected to change

- Local migration `0125_ticket_management_void_settlement.sql`.
- `lib/ticket-management/void.ts`
- Ticket Management completion and payable-VOID release/requotation RPCs.
- Future VOID APIs and UI.
- Focused VOID and disposable-database settlement verification scripts.

### Database/migration requirements

- Net-return VOID: request-bound credit from the immutable approved quotation.
- Additional-payment VOID: request Hold on approval and Capture/Release on the
  assigned final action.
- Add VOID-specific ledger/reporting identity and entitlement state.
- Prohibit use of the held-booking cancellation RPC as Ticket Management VOID.

### Wallet/security considerations

- Net-return approval causes no movement; authorized completion credits once.
- Additional-payment approval creates the exact Hold; completion captures and
  definitive non-performance releases.
- Finalizer roles and active assignment rules match Refund/Reissue.
- No arbitrary manual adjustment or generic Refund call may stand in for VOID.

### Dependencies

- Phases 2-5.

### Acceptance/verification criteria

- Net-return VOID credits exactly the approved amount once.
- Payable VOID holds, captures, or releases exactly once.
- VOID cannot target an already refunded/voided coupon.
- Existing booking cancellation behavior and tests are unchanged.
- Staff session identity never selects the target wallet.

## Phase 9 — APIs, events, notifications, and service integration

### Scope

- Expose narrow customer, operational staff, assignment, and financial
  finalization endpoints.
- Create safe customer/staff DTOs and error contracts.
- Add immutable Ticket Management events and transactional notification outbox
  intents where notifications are required.
- Keep external manual supplier work outside the API design.

Expected API groups:

- customer create/list/detail;
- customer approve/reject quotation;
- staff queue/detail/accept/reject;
- quotation draft/publish/requote;
- financial assignment/reassignment;
- assigned Refund completion;
- assigned Reissue/VOID capture or release;
- bounded system expiry.

### Files/areas expected to change

- `app/api/ticket-management/route.ts`
- `app/api/ticket-management/[requestId]/route.ts`
- `app/api/ticket-management/[requestId]/actions/route.ts`
- `app/api/ticket-management/assignees/route.ts`
- `app/api/cron/ticket-management/route.ts`
- `lib/ticket-management/http.ts`
- `lib/ticket-management/service.ts`
- `lib/db/ticket-management.ts`
- `lib/rate-limit.ts`
- Local migration `0126_ticket_management_notification_outbox.sql`.
- API, notification, security, and database documentation.

No renderer, recipient-expansion worker, email sender, supplier endpoint, or
evidence endpoint was added in this phase.

### Database/migration requirements

- Add Ticket Management outbox/event tables or safely generalize the current
  outbox without passing Ticket Management statuses through booking-status
  constraints.
- Store render-safe snapshots and immutable occurrence identities.
- Keep financial settlement, completion event, and outbox intent in the same
  transaction.
- Phase 9 uses a dedicated service-only
  `ticket_management_notification_outbox`. An after-insert request-event
  trigger creates audience-scoped, occurrence-unique intents in the same
  transaction. Delivery remains deliberately disabled.

### Wallet/security considerations

- Rate-limit every mutation by actor and request identity.
- Use schemas that do not accept arbitrary final settlement amount/account.
- Record attempted, denied, failed, and successful privileged actions.
- Do not expose service-role RPCs or internal wallet IDs to clients.
- Do not add supplier execution or evidence-upload endpoints.

### Dependencies

- Phases 2-8.

### Acceptance/verification criteria

- Every API action maps to one allowed role/state transition.
- Direct calls cannot bypass assignment, quote binding, deadline, entitlement,
  or wallet ownership.
- Customer payloads contain no staff-only audit or wallet internals.
- Notification retries cannot duplicate wallet or lifecycle mutations.
- API error/replay responses are deterministic and understandable.

## Phase 10 — Customer and staff UI integration

### Scope

- Replace the current UI-only preview with live, role-aware Ticket Management
  data only after the backend phases are verified.
- Preserve the agreed booking-page interaction: each Refund/Reissue/VOID quick
  action expands below its button like Share; it is not a popup.
- Use the ShopOnTravels theme rather than copying TripFeels colors.
- Keep the forms compact and ensure every section title remains visible.
- Keep `In Progress` in the Ticket Management status tabs.

Customer UI:

- create Refund/Reissue/VOID request with passenger/ticket selection;
- show current status and immutable quotation breakdown;
- show deadline and countdown;
- allow Approve/Reject only while the server considers the quote actionable;
- show Hold/payment result and final outcome without internal audit details.

Staff UI:

- role-filtered request queues and status tabs;
- Accept/Reject and In Progress actions;
- quotation breakdown, mandatory deadline, and publish/requote actions;
- Approved-request assignment/reassignment;
- Support operational processing without settlement buttons;
- assigned Accounts/Admin/Superadmin exact-effect finalization;
- read-only audit timeline with quotation versions, assignment, actors,
  timestamps, and wallet transaction IDs.

### Files/areas expected to change

- `components/flights/PostTicketActionsPreview.tsx`
- `components/flights/BookingActions.tsx`
- `components/flights/BookingDetails.tsx`
- `components/dashboard/bookings/BookingsTabs.tsx`
- `components/dashboard/bookings/BookingsView.tsx`
- New `components/dashboard/ticket-management/` components.
- Dashboard navigation/route pages only where required.

### Database/migration requirements

- None beyond the verified contracts from earlier phases.
- UI work must not add direct table writes or client-side financial authority.

### Wallet/security considerations

- Finalization screens display the approved amount as read-only.
- Wallet effect preview comes from a server read/preview contract and is
  revalidated inside the final transaction.
- Buttons are hidden/disabled by role for usability, but server and database
  authorization remain authoritative.
- Remove the voluntary/involuntary helper descriptions previously identified
  as unnecessary; retain the choices themselves where applicable.

### Dependencies

- Phase 9 verified APIs and read models.

### Acceptance/verification criteria

- No Ticket Management action opens a modal/popup; quick actions expand inline.
- Titles, quotation fields, deadline, countdown, passenger selections, and
  actions are readable at supported desktop/mobile widths.
- Support never sees a usable wallet settlement control.
- Financial finalizers cannot edit the approved amount.
- Requote clearly invalidates the old approval and requires a new deadline.
- Requested, In Progress, Awaiting Confirmation, Approved, Completed,
  Rejected, and Expired filters show the correct records.
- Accessibility, loading, conflict, expiry, replay, and insufficient-balance
  states are covered.

## Phase 11 — Regression, security, migration, and release validation

### Scope

- Verify every lifecycle and wallet matrix row, role boundary, concurrency race,
  migration constraint, API contract, and UI state.
- Prove existing booking, wallet, import, reconciliation, and notification flows
  remain unchanged.
- Prepare a separate deployment handoff; do not apply or deploy as part of
  implementation verification without authorization.

### Files/areas expected to change

- New focused `scripts/verify-ticket-management-*.mjs` checks.
- Existing verifier updates only where the intended contract legitimately
  changes.
- Unit/integration/component tests in the repository's established locations.
- Documentation listed in the Expected Architecture Boundaries section.
- This plan's progress and verification logs.

### Database/migration requirements

- Parse and execute the full forward migration chain in a disposable database.
- Test new migrations on production-shaped fixtures without using the live
  database.
- Run linked migration inspection/dry-run only after separate authorization if
  it contacts external infrastructure.
- Never edit an applied migration; use forward fixes.

### Wallet/security considerations

Required adversarial coverage includes:

- simultaneous customer Approve versus deadline Expire;
- double Approve and double finalization;
- concurrent Refund/VOID claims on one coupon;
- Capture versus Release races;
- reassignment during finalization;
- assigned user's role revoked before finalization;
- Support-crafted direct wallet calls;
- stale quote version/hash and changed idempotency payload;
- wrong wallet, owner, currency, or booking;
- final amount supplied or altered by the client;
- generic Refund/adjustment bypass attempts;
- lost response followed by exact retry;
- atomic rollback after injected ledger, event, or completion failure.

### Dependencies

- Phases 1-10.

### Acceptance/verification criteria

- Focused lifecycle, permissions, assignment, entitlement, Refund, Reissue,
  VOID, idempotency, and concurrency suites pass.
- Existing wallet, booking lifecycle, booking operation, reconciliation,
  imported booking, outbox/email, role, and security suites remain green or an
  intentional replacement is explicitly documented.
- TypeScript, focused/full ESLint, production build, migration order, SQL
  parsing, disposable migration execution, and `git diff --check` pass.
- No live database mutation, wallet action, email, commit, push, or deployment
  occurs during verification unless separately authorized.
- The deployment handoff lists exact migrations, release ordering, monitoring,
  rollback/forward-correction behavior, and remaining risks.

## Existing generic path handling

The following current paths require deliberate handling. They must not be
changed merely as a side effect of early Ticket Management work.

### Broad `hasFinancialAccess`

This former blocker is resolved. `lib/wallet/permissions.ts` now separates
read-only wallet visibility (`canReadWallet`) from mutation authority
(`canManageWallet`). Support retains operational read visibility but is absent
from the mutation role set.

Implemented handling:

1. Reports, ledger, wallet queues, and wallet summaries use read permission.
2. Adjustment creation/review, deposit decisions, wallet status changes,
   decision-email resend, held-booking cancellation, and generic Refund use
   Accounts/Admin/Superadmin-only mutation permission.
3. The financial manager renders a read-only Support surface without mutation
   controls.
4. Application and disposable-database adversarial regressions enforce the
   split.

### Generic wallet adjustment routes

`app/api/wallet/adjustments/route.ts` and
`app/api/wallet/adjustments/[id]/route.ts` now use separate read and mutation
permissions. Migration `0127_generic_wallet_authorization_hardening.sql`
validates the creator and reviewer against `app_users`, rejects Support and
spoofed roles, preserves maker/checker, and makes requester identity immutable.

Implemented handling:

- Never route Ticket Management through generic adjustments.
- Added explicit canonical database authorization for generic adjustment roles.
- Preserve maker/checker and immutable ledger behavior.
- Verified Accounts/Admin/Superadmin workflows after narrowing access.

### Generic Refund route and RPC

`app/api/wallet/refunds/route.ts` accepts a caller-provided booking, amount,
request UUID, and remarks. `wallet_refund_booking` safely checks role,
captured-minus-refunded, wallet identity, locking, and idempotency, but is not
bound to a Ticket Management request or approved quotation.

Planned handling:

- Reuse its locking, original-account, outstanding, ledger, and idempotency
  invariants inside the new request-bound Refund settlement.
- Do not call the generic route from Ticket Management.
- The application-level generic Refund route now rejects issued/ticketed
  bookings with `TICKET_MANAGEMENT_REQUIRED`; post-ticket Refund must use the
  request-bound flow. The lower generic RPC retains the canonical
  Accounts/Admin/Superadmin lookup added in migration `0059`, and migration
  `0127` reasserts its service-role-only execution boundary.
- Add direct-API bypass regression tests.

### Initial-ticketing Hold/Capture/Release RPCs

The current booking reservation is unique per booking and is already captured
for a ticketed booking. Existing capture/release functions also mutate initial
booking payment/lifecycle state and therefore are not post-ticket Reissue/VOID
functions.

Planned handling:

- Leave initial ticketing RPC behavior unchanged.
- Add request-scoped reservations and dedicated functions.
- Enforce canonical roles and active assignment at the new database boundary.
- Add regression tests proving a Ticket Management release cannot release the
  original booking reservation.

## Cross-phase verification matrix

| Concern | Primary phase | Final verification |
| --- | --- | --- |
| Independent multiple requests | 1 | Sequential passenger/action fixtures |
| Allowed statuses/transitions | 2 | Transition table and stale-version tests |
| Deadline/approval race | 2 | Concurrent database transaction test |
| Support operational-only access | 3 | API and direct-RPC forbidden tests |
| Assignment and role revocation | 3 | Concurrent reassignment/finalization tests |
| Partial passenger/ticket safety | 4 | Entitlement consumption fixtures |
| Original wallet ownership | 5 | B2C, B2B, B2B-sub, staff-actor fixtures |
| Idempotent Hold/Capture/Release | 5, 7-8 | Exact replay and payload-conflict tests |
| Approved Refund amount binding | 6 | Client amount omission/tamper tests |
| Requote after approval | 2, 7-8 | Old Hold release and old quote rejection tests |
| Refund versus VOID double return | 4, 6, 8 | Concurrent coupon settlement test |
| Atomic Completed transition | 6-8 | Injected failure/rollback tests |
| Generic-path bypass prevention | 3, 6, 11 | Direct generic route/RPC tests |
| UI role/action correctness | 10 | Component and end-to-end interaction tests |
| Existing flow regression | 11 | Established repository verifier suites |

## Decisions requiring confirmation before their implementation phase

These do not block approval of the plan, but the relevant phase must resolve
and record them before financial code is written:

Resolved entitlement decision: ordinary-booking passenger fare rows are usable
only when their direct minor-unit amounts sum exactly to wallet-captured User
Payable. Imported/manual supplier-face fare rows are not authoritative and fail
closed. No proportional or equal allocation is permitted.

1. **Generic Refund compatibility:** choose whether the current arbitrary-amount
   route is deprecated, request-bound, or retained as a separately protected
   emergency path.
2. **Generic Support adjustment scope:** inventory existing operational use and
   define the exact replacement permissions before removing Support mutation
   access.
Resolved Reissue refundability decision: the captured fare-difference component
is added to the successor ticket's future User Payable entitlement. Airline
Reissue fee and ShopOnTravels service fee are separately audited and are not
added to future Refund/VOID entitlement by default. Per-passenger fare-
difference allocation is frozen before customer approval and cannot be changed
by the finalizer.

3. **Reissue financial exception resolution:** define the explicit controlled
   reconciliation operation for a case where the manual supplier/GDS Reissue
   has already occurred but the external amount differs from the approved
   quotation. Ordinary completion remains fail-closed and cannot charge a
   changed amount.
Resolved notification-intent decision: Phase 9 atomically queues customer
intents for acceptance, staff rejection, quote publication, expiry,
requotation, and completion, and internal intents for new requests, customer
decisions, completion, and financial exceptions. The rows contain render-safe
snapshots only. Recipient expansion, rendering, and delivery remain disabled
until separately approved.

## Progress log

Update this table immediately after each authorized phase. Include the exact
verification evidence and state whether any database, external service, or live
financial action occurred.

| Date | Phase | Status | Progress / verification evidence |
| --- | --- | --- | --- |
| 2026-08-30 | Plan creation | Complete | Created the maintained implementation plan from the final audit and agreed requirements. No implementation, migration, package/tooling, database, commit, push, or deployment action was performed. |
| 2026-08-30 | Phase 0 | Complete | User authorized careful step-by-step implementation. Verified the linked migration ledger read-only and confirmed local/remote alignment through `0118`. Added lifecycle/role contract modules and `verify-ticket-management-contracts.mjs`; the focused verifier, TypeScript, and `git diff --check` passed. No database mutation, dependency, commit, push, or deployment occurred. |
| 2026-08-30 | Phase 1 | Complete | Added forward-only local migration `0119_ticket_management_core.sql` with independent request UUID/public reference, booking-owner and charged-account snapshots, payload-bound request identity, status/outcome/version constraints, service-only RLS, immutable request events, and no one-request-per-action uniqueness. Disposable PGlite verified duplicate sequential requests, terminal/action constraints, immutable history, delete protection, and RLS. Focused contracts, TypeScript, migration order, and diff checks passed. Migration was not applied to any linked/live database. |
| 2026-08-30 | Phase 2 | Complete | Added local migration `0120_ticket_management_lifecycle_assignment.sql` with immutable versioned quotations and customer decisions, exact action-specific amount formulas, mandatory future deadlines, expected-version transition RPCs, serialized approve/reject/expiry decisions, bounded expiry, and requotation that preserves prior approvals. Debit-direction approval remains fail-closed with `WALLET_HOLD_REQUIRED` until Phase 5. Disposable PGlite lifecycle tests passed; no linked/live database was changed. |
| 2026-08-30 | Phase 3 | Complete | Added canonical-role operational authorization and immutable assignment history in migration `0120`. Support/Admin/Superadmin may review, quote, and assign; only Accounts/Admin/Superadmin are valid settlement assignees. Assignment changes no wallet state. PGlite verified forbidden Accounts operational review, forbidden Support assignment target, valid Accounts assignment, and historical preservation. Contract, TypeScript, migration-order, and diff checks passed. No linked/live database, package, commit, push, or deployment action occurred. |
| 2026-08-30 | Phase 4 | Complete — corrected | Added immutable passenger/ticket selections and exclusive claims. Corrected allocation to use only exact passenger-level User Payable fare amounts whose minor-unit sum equals the captured wallet amount; removed Gross-weighted proportional scaling and remainder redistribution. Imported/manual bookings fail closed because their fare rows are supplier face values without authoritative passenger User Payable allocation. Quotation publication binds Refund/VOID User Payable exactly to selected remaining entitlement. No wallet movement or linked/live database action occurred. |
| 2026-08-30 | Phase 5 | Complete | Added local migration `0122_ticket_management_wallet_substrate.sql`: request-scoped reservation subjects, request/quote-linked ledger entries, distinct Hold/Capture/Release transaction types, atomic debit approval + Hold on the original charged account, and private assignment/role-guarded Capture/Release primitives. The original booking reservation is never reused. Disposable PGlite verified insufficient-balance rollback, original-reservation preservation, Support denial, assigned Accounts capture, release restoration, and replay safety. Full Ticket Management verifiers, migration ordering, TypeScript, and diff checks passed. No linked/live database, package, commit, push, or deployment action occurred. |
| 2026-08-30 | Phase 6 | Complete — corrected | Refund quotations and settlement now keep supplier Gross Fare, Supplier Payable, selected User Payable entitlement, airline fee, service fee, and final customer credit explicitly separate. Final credit is calculated only as User Payable entitlement minus airline fee minus service fee; Gross and Supplier Payable are immutable audit/economic facts and never drive customer credit. The assigned financial actor consumes User Payable entitlement and credits the approved final amount to the original wallet. The BDT 10,000 / 9,000 / 9,500 / 2,000 / 500 = BDT 7,000 regression case passes. No linked/live database or external action occurred. |
| 2026-08-30 | Phase 4/6 financial-model review | Complete | User clarified that Refund/VOID customer calculations must never use supplier Gross Fare. Renamed and separated all quotation components, removed Gross-weighted passenger allocation, added fail-closed imported/manual coverage, and updated audit metadata to use `userPayableEntitlementConsumed`. Phase 7 remains paused pending review. |
| 2026-08-30 | Phase 4/6 correction regression | Review checkpoint | All six focused Ticket Management contract/PGlite suites, TypeScript, focused ESLint, migration ordering, and diff checks passed. Existing IMP/EXP wallet/pricing, manual-booking, and canonical-pricing regressions passed. The existing generic `verify:wallet` suite still fails its non-Accounts-staff assertion because `lib/wallet/permissions.ts` includes `staff_support` in broad `FINANCIAL_ROLES`; this pre-existing generic authorization path was not changed as part of the calculation correction and remains a separately recorded security decision. No linked/live database, dependency, commit, push, or deployment action occurred. |
| 2026-08-30 | Phase 7 | Complete — review checkpoint | Added local migration `0124_ticket_management_reissue_settlement.sql` and the Reissue contract helper. Reissue quotes now freeze exact per-passenger fare-difference allocation. Assigned Accounts/Admin/Superadmin completion atomically captures the approved Hold, records the separated supplier/fare-difference/airline-fee/service-fee facts, consumes predecessor entitlements, creates successor lineage, updates active ticket identities, and carries forward only prior User Payable plus fare difference. The booking captured-total accounting field increases by the full actual Reissue capture while airline/service fees remain excluded from successor refundable entitlement. Assigned non-performance atomically releases the whole Hold and reopens In Progress; a replacement quote can create a fresh Hold. Support denial, allocation mismatch rollback, replay safety, successor selection, later Refund of the successor entitlement, and the BDT 500 fare-difference versus BDT 500 non-refundable-fee split passed in disposable PostgreSQL. All focused Ticket Management suites, TypeScript, ESLint, migration order, diff checks, IMP/EXP wallet/pricing, manual booking, and canonical pricing regressions passed. The known pre-existing generic `verify:wallet` Support-role assertion remains failing and unchanged. No linked/live database, dependency, commit, push, or deployment action occurred. |
| 2026-08-30 | Phase 8 | Complete — review checkpoint | Added local migration `0125_ticket_management_void_settlement.sql`, the pure VOID calculation contract, and focused isolation checks. Net-return completion by the assigned Accounts/Admin/Superadmin role credits exactly `User Payable entitlement - airline VOID fee - service fee` to the original booking owner wallet, never a staff wallet. Payable VOID customer approval uses the request Hold; authorized completion captures it and increases booking captured-total accounting by the actual additional payment, while non-performance releases the whole Hold and returns In Progress for a new quote and approval. Both directions consume the selected entitlement as `voided`, retain separated supplier/User Payable/fee facts, complete atomically, and replay safely. Disposable PostgreSQL verified no movement on net-return approval, Support denial, exact credit, exact capture, release/requote, original reservation preservation, duplicate-call safety, and rejection of a later Refund against a voided ticket. The dedicated migration contains no held-booking cancellation, generic reservation-release, or generic booking-refund call. All focused Ticket Management suites, TypeScript, ESLint, migration ordering, diff checks, held-booking cancellation regressions, IMP/EXP wallet/pricing, manual booking, and canonical pricing regressions passed. The known pre-existing generic `verify:wallet` Support-role assertion remains unchanged. No linked/live database, dependency, commit, push, or deployment action occurred. |
| 2026-08-30 | Phase 9 | Complete — review checkpoint | Added customer/staff list and detail reads, owner-scoped creation, a strict role-aware action endpoint, financial assignee discovery, bounded authenticated expiry, safe response/error contracts, and actor-plus-target rate limits. Final settlement requests cannot carry an amount or wallet account; the service reads the request action and database-approved quotation, and customer DTOs exclude supplier economics, staff audit identities, entitlement IDs, and wallet ledger/reservation IDs. Added local migration `0126_ticket_management_notification_outbox.sql` for atomic render-safe notification intents only; no renderer, recipient expansion, or delivery was enabled. The generic application Refund route now rejects issued/ticketed bookings in favor of Ticket Management while the lower generic RPC remains unchanged. All eight focused Ticket Management suites, TypeScript, focused ESLint, migration ordering, diff checks, booking-notification occurrence/snapshot, held cancellation, IMP/EXP wallet/pricing, manual booking, and canonical pricing regressions passed. The known pre-existing generic `verify:wallet` Support-role assertion remains failing and unchanged. No linked/live database, dependency, commit, push, deployment, supplier action, notification delivery, or live wallet action occurred. |
| 2026-08-30 | Phase 10 | Complete — review checkpoint | Connected the booking-page Refund/Reissue/VOID quick actions to the live API while retaining compact expand-below-button behavior and ShopOnTravels theme colors. Customers can select passengers, submit requests, view current status and exact quotation, see deadline/countdown, approve/reject, and start a later request after a terminal outcome. The Manage tab now loads role-scoped Refund/Reissue/VOID queues with all seven status filters including In Progress and Completed. Support/Admin/Superadmin can review, quote with explicitly separated Gross/Supplier Payable/User Payable/fees, requote, and assign; only the active assigned Accounts/Admin/Superadmin UI exposes exact approved completion/release controls. Reissue completion uses the frozen per-passenger fare-difference allocation and requires replacement ticket numbers. Added a strict minor-unit client parser and focused UI contract verifier. Browser QA confirmed desktop/mobile tab layout, graceful unavailable-storage state without applying migrations, and that Superadmin/staff booking detail does not expose customer request buttons. All nine Ticket Management suites, TypeScript, focused ESLint, migration ordering, diff checks, and adjacent booking notification/cancellation/import/pricing regressions passed. The known pre-existing generic `verify:wallet` Support-role assertion remains unchanged. No linked/live database, dependency, commit, push, deployment, supplier action, notification delivery, or live wallet action occurred. |
| 2026-08-30 | Phase 11 | Complete — release blocked | Added a server-only `TICKET_MANAGEMENT_ENABLED` rollout boundary across APIs, scheduler, customer quick actions, and the Manage workspace. Local `next dev` defaults on for UI review; production remains fail-closed unless explicitly enabled. Added a disposable forward-chain rehearsal with production-shaped historical fixtures: 124/125 migrations executed through `0126`; Supabase-only `0042` was statically verified because PGlite cannot supply `pg_cron`, `pg_net`, or Vault. Added adversarial coverage for Approve/Expire, Refund/VOID entitlement claims, Capture/Release, reassignment, role revocation, changed idempotency payloads, exact retries, Support settlement denial, and injected-ledger atomic rollback. All Ticket Management suites, TypeScript, full ESLint, optimized production build, migration order, diff checks, and the selected booking/import/pricing/outbox/security regression matrix passed. Browser QA confirmed both enabled UI and explicit-disabled hiding behavior. Release is blocked because the existing generic `hasFinancialAccess`/adjustment surface still grants Support financial access and `verify:wallet` remains red, and because an isolated Supabase staging apply is still required. No linked/live database, dependency, notification, commit, push, deployment, supplier, or live wallet action occurred. See `docs/21-TICKET-MANAGEMENT-RELEASE-HANDOFF.md`. |
| 2026-08-30 | Post-release entitlement correction | Migration `0128` applied in production dark state; acceptance exception found | Added the booking-level single-passenger allocator and applied it after an immutable release, verified backup, exact dry run, and full regressions. Schema, function grants, migration ledger, and unchanged wallet aggregates passed. The read-only `STR260823000011` check then proved the booking remained fail-closed because its `import_source` is `MANUAL` and the earlier blanket imported-booking gate executes before the single-passenger branch. No request, entitlement, wallet movement, smoke, scheduler, notification, or enablement occurred. |
| 2026-08-30 | MANUAL single-passenger correction | Complete — migration `0129` applied in production dark state | Added and released a narrow forward wrapper around the unchanged/revoked `0128` allocator. Only `MANUAL` bookings with exactly one proved passenger, one unique proved ticket, captured payment on an original charged wallet account, positive booking-level `user_payable_amount`, and exact User Payable/Captured/resolved-entitlement equality may allocate. `IMP_EXP`, MANUAL multi-passenger, missing User Payable, mismatched, ambiguous-ticket, unpaid, and wallet-unbound cases remain fail-closed. The migration performs no backfill or historical booking/pricing/wallet/entitlement mutation. Production ledger, schema/permissions, wallet baselines, and an empty follow-up dry run passed; `STR260823000011` resolves read-only to exactly BDT 37,643 while preserving BDT 40,619 stored Gross. Ticket Management remained disabled and no smoke, scheduler, notification, or wallet action occurred. Immutable release commit: `4dd09b21b75f69f9e76284370e550d5349bec76a`. |
| 2026-08-30 | Phase 10 booking-page visibility correction | Complete — local review | Separated booking-page action visibility from booking-owner mutation authority. Refund/Reissue/VOID now remain visible and expandable for Support, Accounts, Admin, and Superadmin on confirmed bookings; staff can read an existing request or see owner-submission guidance, but cannot submit, approve/reject, or start another customer request. Customer/B2B owner behavior is unchanged. No database, dependency, commit, push, deployment, supplier, notification, or wallet action occurred. |
| 2026-08-30 | Generic wallet authorization hardening | Complete — staging rehearsal required | Split wallet read visibility from mutation authority. Support retains read-only wallet/report visibility but cannot create/review manual adjustments, decide deposits, freeze/activate wallets, resend decision emails, cancel a wallet-backed hold, or use generic Refund. Added local forward migration `0127_generic_wallet_authorization_hardening.sql` with canonical `app_users` creator/reviewer checks, role-spoof denial, requester immutability, maker/checker preservation, and the existing service-only canonical generic Refund boundary. The formerly failing `verify:wallet` check and the full Ticket Management/wallet/booking/import/pricing regression matrix pass. No linked/live database, dependency, notification, commit, push, deployment, supplier, or live wallet action occurred. |
| 2026-08-30 | Isolated Supabase staging prerequisite audit | Blocked safely — staging target required | User approved continuing to the staging rehearsal. Read-only local inspection found that `.env.local` and `supabase/.temp` resolve to the same existing non-staging linked project. No separate staging project URL/database credential, Supabase CLI, Docker runtime, or local PostgreSQL runtime is available. The linked project was not queried or mutated, no CLI/tooling was installed, and no migration was applied. Rehearsal requires an explicitly identified isolated Supabase staging project plus an authorized connection method. |
| 2026-08-30 | Controlled production release procedure | Prepared — execution approval required | Owner declined a separate staging environment and accepted that missing rehearsal as a release risk. Added the exact production runbook covering immutable artifact verification, explicit fail-closed deployment, production identity and backup/PITR, migration-ledger alignment through `0118`, pinned CLI lint/dry-run, ordered `0119`-`0127` application, dark-state schema/RLS/grant checks, a separately approved non-financial smoke ending Rejected with zero wallet movement, enablement, monitoring, and forward-only rollback/stop conditions. No production query, migration, flag change, deployment, Git publication, smoke write, notification, supplier action, or wallet action occurred. |
| 2026-08-30 | Production Gate 0 attempt | Stopped — immutable artifact and explicit local flag required | Owner reported the fail-closed deployment complete and authorized proceeding. Gate 0 found the entire Ticket Management release still modified/untracked against local HEAD `6df466e`, while `origin/main` is older; therefore no clean immutable release commit exists in this workspace. `TICKET_MANAGEMENT_ENABLED` is absent from both `.env.local` and the shell, so local development defaults enabled rather than explicitly false. No Vercel project link is present to verify the deployed artifact/flag. Per the approved stop conditions, no Supabase CLI was installed, no production query/dry-run/migration was attempted, and no environment, Git, deployment, notification, supplier, or wallet state was changed. |
| 2026-08-31 | Production dark-state release | Gates 0-4 complete through `0129` | The controlled releases through migration `0129` completed with verified manual logical backups, exact migration-ledger/dry-run checks, schema and privilege checks, unchanged wallet baselines, and Ticket Management kept fail-closed. The current recovery evidence for `0129` is stored outside the repository at `/Users/ashifbabu/Backups/shopontravels/20260830T192804+0600-pre-0129/RELEASE-EVIDENCE.txt`. No Gate 5 smoke, feature enablement, scheduler, notification delivery, or wallet action occurred. |
| 2026-08-31 | Local UI visibility verification | Complete | Explicitly set the ignored local development override to `TICKET_MANAGEMENT_ENABLED=true` and reloaded the application. Browser QA verified the customer and staff My Bookings pages show the Manage tab, the Manage workspace shows Refund/Reissue/VOID with all lifecycle filters including In Progress, and an eligible confirmed booking shows compact expand-below-button Refund/Reissue/VOID actions. No request was submitted and no production state changed. |
| 2026-08-31 | Gate 5 test-booking discovery | Blocked safely — dedicated fixture required | A read-only production query searched confirmed/ticketed/issued bookings for explicit test/demo markers in passenger/import metadata and found zero candidates. Per the approved release procedure, no ordinary customer booking was selected. Production remains `TICKET_MANAGEMENT_ENABLED=false`; no request, wallet, scheduler, or notification action occurred. |

## Decision log

| Date | Decision | Reason | Status |
| --- | --- | --- | --- |
| 2026-08-30 | Use an independent Ticket Management lifecycle | Booking status and Ticket Management request status represent different facts. | Agreed |
| 2026-08-30 | No supplier Refund/Reissue/VOID or balance API dependency | External work is performed manually through supplier portals, GDS, airlines, or other channels. | Agreed |
| 2026-08-30 | No mandatory evidence upload/verification workflow | Internal request, assignment, actor, quote, timestamp, and wallet audit history are sufficient for the ordinary path. | Agreed |
| 2026-08-30 | Support owns operational work but cannot settle wallets | Preserves role separation and current booking-owner wallet security direction. | Agreed |
| 2026-08-30 | Accounts/Admin/Superadmin may settle only when assigned | Makes responsibility explicit and auditable. | Agreed |
| 2026-08-30 | Final settlement uses the immutable approved quotation | Prevents arbitrary amount changes and Support/financial-role bypass. | Agreed |
| 2026-08-30 | Reissue/payable VOID Hold occurs atomically with customer approval | Protects funds before manual external work without holding money before consent. | Agreed |
| 2026-08-30 | Refund/net-return VOID credit occurs only at authorized completion | Customer approval is consent, not wallet settlement. | Agreed |
| 2026-08-30 | Amount changes require requotation and new customer approval | An approved quote cannot be overwritten. | Agreed |
| 2026-08-30 | Multiple sequential requests and partial passengers/tickets are required | One request per action/booking cannot represent real post-ticket operations safely. | Agreed |
| 2026-08-30 | Refund/VOID customer basis is selected User Payable entitlement | Supplier Gross Fare and Supplier Payable are separate audit/economic facts; neither may drive the customer wallet amount. Partial processing requires authoritative passenger User Payable allocation and otherwise fails closed. | Agreed |
| 2026-08-30 | Single-passenger booking-level User Payable is authoritative when reconciled to capture | Exactly one proved passenger/ticket has no partial-allocation ambiguity, so its positive booking-level User Payable may be used when it equals captured amount. Multi-passenger bookings still require exact authoritative per-passenger allocation. | Agreed; implemented in production by `0128` and the narrow `0129` MANUAL correction |
| 2026-08-30 | MANUAL exception is limited to authoritative single-passenger capture | A MANUAL booking may bypass the imported-booking allocation exclusion only with one proved passenger/ticket, explicit positive booking-level User Payable, captured payment bound to a charged wallet account, and exact reconciliation. IMP_EXP and all ambiguous or multi-passenger imports stay blocked. | Agreed; migration `0129` applied and verified in production dark state |
| 2026-08-30 | Reissue successor entitlement includes only carried User Payable plus captured fare difference | Airline Reissue fee and ShopOnTravels service fee remain separate and non-refundable by default; immutable per-passenger quote allocation prevents finalizer redistribution. | Agreed and implemented in Phase 7 |
| 2026-08-30 | VOID uses a dedicated request-bound settlement path | Net return credits only the approved User Payable-based amount; additional payment captures only its request Hold. Neither path reuses held-booking cancellation or generic booking-refund RPCs. | Agreed and implemented in Phase 8 |
| 2026-08-30 | Ticket Management notification delivery remains disabled | Phase 9 stores occurrence-unique, audience-scoped, render-safe intents transactionally; recipient policy, rendering, and delivery require separate approval. | Agreed and implemented in Phase 9 |
| 2026-08-30 | Issued/ticketed application Refunds require Ticket Management | Prevents the generic amount-bearing Refund API from bypassing approved quotation, assignment, and entitlement controls. The lower generic RPC is unchanged and remains a recorded hardening concern. | Agreed and implemented in Phase 9 |
| 2026-08-30 | Begin step-by-step implementation | User approved proceeding carefully from Phase 0 while retaining separate authorization gates for live database, dependencies, Git publication, and deployment. | Approved |

## Implementation authorization gate

The user authorized careful step-by-step implementation through Phase 11 and
the controlled dark-state production application of migrations `0119`-`0129`.
The next release step is Gate 5, which remains blocked until an explicitly
dedicated, confirmed, unused test booking is available. Existing authority does
not authorize:

- changing packages, dependencies, or tooling;
- sending notifications to real recipients;
- performing live wallet actions;
- using an ordinary customer booking for release smoke;
- enabling the expiry scheduler; or
- enabling production Ticket Management before Gate 5 evidence is approved.

Each of those actions requires its own scope and authorization when applicable.
