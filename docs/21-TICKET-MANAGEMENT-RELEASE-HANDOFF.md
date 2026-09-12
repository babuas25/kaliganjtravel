# Ticket Management Release Handoff

- **Prepared:** 2026-08-30
- **Scope:** Refund, Reissue, and VOID Ticket Management
- **Implementation state:** Phases 0-11 implemented and locally validated
- **Release state:** **Controlled production procedure prepared; execution not approved**
- **Default rollout state:** Visible in local `next dev`; production is disabled
  unless the server-only `TICKET_MANAGEMENT_ENABLED=true` switch is set

This document is a deployment handoff only. Preparing it did not apply a
migration, contact a linked database, move wallet funds, send a notification,
commit, push, or deploy anything.

## Release risk and resolved security gate

### 1. Generic wallet authorization — resolved locally

The dedicated Ticket Management database functions derive the actor role from
`app_users`, require an active assignment, and allow final settlement only for
Accounts Staff, Admin, or Superadmin. Support cannot use those functions to
Credit, Capture, or Release.

The former generic-wallet blocker has been hardened locally:

- wallet read visibility and mutation authority are separate capabilities;
- Support has read-only visibility and no generic mutation controls or routes;
- generic adjustment creation/review validates canonical `app_users` roles,
  rejects role spoofing, and retains maker/checker;
- The lower `wallet_refund_booking` RPC is not bound to a Ticket Management
  request or approved quotation. The application Refund route now blocks
  issued/ticketed bookings, and the RPC remains service-only with its existing
  canonical Accounts/Admin/Superadmin role check.

`npm run verify:wallet` and the dedicated adversarial generic-wallet verifier
now pass.

### 2. Missing Supabase staging rehearsal — accepted release risk

The complete local migration chain was executed in disposable PGlite through
`0127`, except historical migration `0042`, which requires Supabase-only
`pg_cron`, `pg_net`, and Vault secrets. The rehearsal supplied the exact
production-shaped historical rows required by migrations `0034`, `0036`, and
`0039` and executed 125 of 126 migrations.

The owner decided on 2026-08-30 not to create a separate Supabase staging
environment for this release and explicitly accepted the resulting release
risk. The local disposable chain still covers 125 of 126 migrations; the only
excluded historical migration is Supabase-only `0042`, which is already in the
production baseline and is not part of migrations `0119`-`0127`.

This acceptance does not authorize production execution or waive a current
backup/PITR checkpoint, exact migration-ledger alignment through `0118`, pinned
CLI dry run, fail-closed application deployment, two-person migration window,
dark-state schema/security checks, non-financial smoke, or stop conditions.

## Exact new migrations and order

Apply only after an authorized review confirms the linked migration ledger is
still aligned through `0118`:

1. `0119_ticket_management_core.sql`
2. `0120_ticket_management_lifecycle_assignment.sql`
3. `0121_ticket_management_entitlements.sql`
4. `0122_ticket_management_wallet_substrate.sql`
5. `0123_ticket_management_refund_settlement.sql`
6. `0124_ticket_management_reissue_settlement.sql`
7. `0125_ticket_management_void_settlement.sql`
8. `0126_ticket_management_notification_outbox.sql`
9. `0127_generic_wallet_authorization_hardening.sql`

Never edit these files after they have been applied. Any correction must be a
new forward migration.

## Controlled production release procedure

The exact operator runbook is maintained in
`docs/22-TICKET-MANAGEMENT-PRODUCTION-RELEASE-PROCEDURE.md`. It is the authority
for preflight, deployment order, ledger verification, production migration,
smoke tests, enablement, and rollback/stop decisions.

Summary only:

1. Approve one immutable release artifact and migration checksums.
2. Explicitly set `TICKET_MANAGEMENT_ENABLED=false` and deploy the application
   fail closed.
3. Verify production identity, backup/PITR, ledger alignment through `0118`,
   lint, and an exact nine-file dry run.
4. Apply `0119`-`0127` once during a two-person maintenance window.
5. Verify ledger, schema, RLS, RPC grants, empty follow-up dry run, and unchanged
   wallet baselines while the feature remains disabled.
6. Obtain a fresh approval for a monitored, non-financial production smoke
   ending in customer Rejected with zero wallet movement.
7. Make a separate Hold/Enable decision. Scheduler and notification delivery
   remain separately disabled.

Notification rows are intents only. Recipient expansion, rendering, and
delivery remain disabled and require separate approval.

## Post-enablement validation and monitoring coverage

Only the non-financial Rejected lifecycle in the controlled runbook is a
pre-enable production smoke. The financial and concurrency cases below remain
covered by disposable local regressions and must be monitored as authorized
real production cases occur; do not manufacture wallet movements merely to
repeat them in production.

- Customer ownership for B2C, agency, and sub-user bookings.
- Requested → In Progress → Awaiting Confirmation → Approved → Completed.
- Requested/awaiting rejection and deadline expiry.
- Requotation invalidates the old approval and requires a new deadline.
- Support can operate, quote, and assign but cannot Credit/Capture/Release.
- Accounts/Admin/Superadmin can settle only while actively assigned.
- Role revocation or reassignment immediately prevents finalization.
- Refund and net-return VOID credit only the original booking owner wallet.
- Reissue/payable VOID Hold, Capture, and Release use only the request-scoped
  reservation and never the initial booking reservation.
- Exact retry is a replay; changed payload with the same key is rejected.
- Concurrent entitlement, approval/expiry, Capture/Release, and finalization
  contenders produce exactly one valid winner.
- Injected failures leave request, entitlement, reservation, wallet, ledger,
  completion, audit, and outbox state atomic.
- Imported/manual bookings without authoritative passenger User Payable
  allocation fail closed.

## Monitoring after enablement

Monitor by action, role, and error code:

- request/quote/decision/assignment/finalization counts;
- `REQUEST_VERSION_CONFLICT`, idempotency conflicts, and entitlement conflicts;
- forbidden Support settlement attempts and inactive-assignee attempts;
- expired quotation backlog and scheduler failures;
- request-scoped reservations left active beyond their operational window;
- wallet Hold/Capture/Release totals versus completion records;
- Refund/VOID credits versus approved quotation amounts;
- notification outbox growth (delivery remains disabled);
- security audit write failures, which must fail privileged actions closed.

Alert on any mismatch between a completed request and its wallet completion,
ledger entry, entitlement consumption, or original booking owner account.

## Rollback and forward correction

The immediate operational rollback is to set
`TICKET_MANAGEMENT_ENABLED=false`. This hides the Manage workspace and customer
quick actions and makes Ticket Management APIs/scheduler return a disabled
response without reversing financial history.

Do not down-migrate completed financial records, delete immutable audit rows,
or reverse wallet ledger entries manually. After any financial write, use a
reviewed forward migration or an existing authorized reconciliation mechanism.
If a defect is found before any Ticket Management settlement, keep the feature
disabled and ship a forward application/database correction.

## Local verification evidence

Passed locally:

- all Ticket Management contract, lifecycle, entitlement, migration, API, UI,
  Refund, Reissue, VOID, Hold/Capture/Release, replay, race, role-revocation,
  reassignment, and injected-rollback checks;
- TypeScript and full ESLint;
- optimized Next.js production build;
- migration ordering and `git diff --check`;
- booking lifecycle, operation, cancellation, reconciliation authorization and
  lock-order checks;
- IMP/EXP wallet/pricing, manual booking, canonical pricing, notification
  outbox/snapshot, rollout-control, and security-hardening checks.

No known local wallet or Ticket Management regression remains failing. The
missing staging rehearsal is an accepted risk; production execution remains a
separate approval governed by the controlled procedure above.
