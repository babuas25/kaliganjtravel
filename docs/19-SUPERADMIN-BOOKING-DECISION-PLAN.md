# Super Admin Booking Decision Plan

## Objective

Replace the Super Admin-facing Safety Cases workflow with a simple resolution
tool for stuck B2B/B2C Issue Now bookings. A Super Admin decision must not
require an evidence upload, proposal, maker/checker approval, or second
execution step.

The normal lane must derive Capture/Release/No Movement from proven local
reservation and ledger truth. When local accounting was not saved completely,
a separate, unmistakable Manual Supplier-Verified Resolution lane may apply an
audited customer-wallet adjustment from the Super Admin's manually verified
case. It must never invent a reservation or rewrite ledger history.

## Agreed product direction

- The Super Admin is the final authority for a manual booking decision.
- Supplier evidence may be displayed as optional context, but it cannot block a
  Super Admin decision.
- Resolution notes are optional.
- The UI must show the exact booking and wallet effect before submission.
- The UI must always show current Available and Hold balances and the exact
  before/after balances before any manual financial submission.
- Supplier amount and customer-wallet amount are separate facts. Supplier
  amount must never populate or determine the customer-wallet amount.
- Only an explicit Super Admin decision may invoke this override flow.
- Historical Safety Cases and their audit data must remain readable and must
  not be deleted or rewritten.
- Existing normal customer, agency, supplier, ticketing, cancellation, and
  wallet flows must continue to use their current rules.
- The exception lane is limited to stuck ordinary B2B/B2C Issue Now bookings.
  Instant Purchase, Manual Import, IMP/EXP, deposits, generic adjustments, and
  every other wallet flow remain unchanged.

## Final resolution design

Actual wallet reservation and immutable ledger state take priority over the
denormalized `flight_bookings.payment_state`. The resolver must not choose a
money movement from `payment_state` alone.

### Normal automatic lane

| Supplier result | Authoritative local state | Wallet effect |
| --- | --- | --- |
| Ticket issued | Already captured | Confirm only; no duplicate movement |
| Ticket issued | Matching active Hold | Capture the existing Hold exactly once |
| Ticket issued | Proven no money | Do not direct-charge in this resolution tool; require the manual lane if a verified customer-wallet settlement is needed |
| Still valid / restore | Matching active Hold | Release Hold to Available, then restore On Hold |
| Still valid / restore | Proven no money | Restore On Hold with no wallet movement |
| Not issued / cancel | Matching active Hold | Release Hold to Available, then cancel |
| Not issued / cancel | Proven no money | Cancel with no wallet movement |
| Any | Conflicting/incomplete local accounting | No automatic money movement; offer the explicit manual lane |

Expired Restore On Hold includes the new effective deadline. That deadline must
remain locally authoritative while supplier deadline facts remain preserved in
their dedicated columns and append-only observations.

### Manual Supplier-Verified Resolution lane

This lane is visible only when the normal local accounting lane cannot safely
operate. It records structured supplier verification but does not require a
file upload or second approver.

| Explicit customer-wallet action | Balance effect |
| --- | --- |
| No Customer Wallet Movement | Record the supplier/booking outcome only |
| Credit Available | Increase Available by the confirmed customer-wallet amount |
| Debit Available | Decrease Available by the confirmed customer-wallet amount; never below zero |
| Release Orphan Hold | Decrease Hold and increase Available by the same amount; never fabricate a reservation |
| Capture Orphan Hold | Decrease Hold by the confirmed amount; never fabricate a reservation |

Every manual resolution stores booking/reference, target user/agency wallet,
customer-wallet amount/currency, separately entered supplier amount/currency,
supplier outcome/reference, booking result, Super Admin identity, optional
note, timestamp, immutable ledger/audit identifiers, request key, request hash,
and balance snapshots. Records are immutable; any later correction must be a
separately authorized forward/reversal transaction, never an edit.

### Core invariants

- Actual reservation/ledger truth, not `payment_state`, selects the normal lane.
- The manual lane is never a fallback button for a clean normal state; the
  executor rechecks under lock and redirects to normal Capture/Release when it
  becomes provable.
- Supplier amount is informational evidence only. It is never copied into the
  customer-wallet amount.
- The target wallet comes from the booking's B2B/B2C owner and is shown before
  submission; it is not an arbitrary wallet selector.
- Manual submission records an explicit Super Admin confirmation that the
  supplier-verified exception is a stuck B2B/B2C Issue Now case.
- Normal Capture/Release ledger rows and Manual Resolution ledger rows use
  distinct transaction types and reporting labels.
- No manual path creates a historical reservation or edits a ledger entry.
- Booking, operation/case, wallet mutation, resolution row, ledger, lifecycle
  event, and audit commit together or all roll back.
- Never double-charge, double-capture, double-release, double-credit, or
  double-debit.

## Implementation steps

### Approved 0108 imported-ticketing extension

This is a separate imported-booking workflow. It does not widen the ordinary
Super Admin Issue Resolution scope and does not change migration `0107`.

1. Preserve import-time accounting separation:
   - MANUAL/IMP-EXP On Hold import: no wallet movement.
   - Already Confirmed import: require complete ticket evidence and capture the
     assigned owner's User Payable directly exactly once.
2. Replace the imported owner `Confirm & Pay` action with `Issue Now`:
   - lock the imported On Hold/Unpaid booking and assigned wallet;
   - move Available to Hold with an active reservation and `booking_hold` ledger;
   - create the imported manual-ticketing operation/case;
   - move the booking to In Progress in the same transaction.
3. Add a dedicated Imported Booking Ticketing Resolution command/UI:
   - Confirm requires one ticket number per passenger plus Issued Date & Time
     and captures an active Hold exactly once;
   - Cancel requires Cancellation Date & Time plus reason and releases an
     active Hold exactly once;
   - old captured-before-ticketing rows confirm without another movement;
   - cancelling an old captured row requires an explicit refund disposition,
     never a Hold release.
4. Preserve existing terminal captured imports and historical reconciliation
   cases without rewriting them. Incomplete old accounting remains fail-closed.
5. Keep MANUAL/IMP-EXP excluded from `0107` automatic and Manual
   Supplier-Verified Resolution lanes. Keep normal Issue Now, Instant Purchase,
   deposits, generic wallet adjustments, supplier-wallet accounting, and every
   unrelated standard flow unchanged.
6. Add focused imported Hold/Capture/Release, legacy captured, authorization,
   evidence, cancellation-time, atomicity, idempotency, reporting, and
   regression verification before any live migration or deployment.

### Step 1 — Confirm current-state contracts

- Inventory every Safety Cases entry point, API route, database function, role
  check, navigation link, and verification script.
- Inventory all booking/payment combinations currently produced by standard,
  direct-ticket, IMP/EXP, and legacy flows.
- Inventory authoritative hold/capture/release/refund ledger transaction types
  and reservation states; do not treat `payment_state` as accounting truth.
- Record the database invariants that the new resolver must preserve.

Acceptance:

- Every affected route and function is identified before code changes.
- The wallet decision matrix covers every reachable payment state.
- Stale `payment_state` combinations are covered by reservation and ledger
  precedence rules.

### Step 2 — Define the Super Admin decision contract

- Define supplier results: Ticket Issued, Still Valid / Restore On Hold, and
  Not Issued / Cancel.
- Derive the normal automatic effect from actual local accounting.
- Define explicit manual effects: No Movement, Credit Available, Debit
  Available, Release Orphan Hold, and Capture Orphan Hold.
- Define the conditional financial inputs for captured cancellations.
- Make evidence identifiers and notes optional.
- Require a request UUID for idempotency.
- Restrict the contract to the `superadmin` role.

Acceptance:

- The contract cannot select an arbitrary wallet; the booking owner fixes it.
- The server derives permitted wallet effects from locked database state.
- The preview and executor classify accounting truth from reservation and
  ledger records before consulting `payment_state` as a consistency signal.

### Step 3 — Add an atomic database resolver

- Add a new forward-only Supabase migration; do not rewrite old migrations.
- Lock records in the established order: booking, active operation/case where
  relevant, reservation, wallet, then wallet account.
- Re-read booking and payment state inside the transaction.
- Lock and classify matching wallet reservation and immutable booking ledger
  history before deriving the financial action.
- Apply the booking decision and its derived wallet effect atomically.
- Reuse the established immutable ledger transaction types and balance
  before/after fields.
- Add lifecycle event, notification outbox intent, security/audit metadata, and
  idempotent replay behavior.
- Add an immutable, booking-bound manual financial resolution record and
  distinct append-only ledger transaction types.
- Store supplier and customer-wallet amounts separately and validate that no
  database or UI default copies one into the other.
- Recheck normal accounting after locks and reject the manual path if a normal
  Capture/Release has become available.
- Implement a real active Super Admin local-deadline authority so supplier
  refresh preserves supplier history without overwriting the effective date.
- Resolve or supersede an open historical case without deleting its evidence,
  proposal, approval, or resolution history.

Acceptance:

- No direct or unaudited wallet mutation is possible.
- No balance becomes negative.
- A retry cannot capture, release, or refund twice.
- A stale `payment_state` cannot cause the wrong wallet action.
- Any validation failure leaves all involved records unchanged.

### Step 4 — Add the server API boundary

- Add a Super Admin-only API route for previewing and applying a decision.
- Validate booking reference, decision, deadline, refund selection, amount,
  currency, settlement reference, optional note, and request UUID.
- Return a plain preview containing the expected booking and wallet result.
- Record attempted, failed, and successful security audit events.
- Dispatch existing booking notifications only after a successful commit.

Acceptance:

- Non-Super Admin roles receive a forbidden response.
- Evidence is never a required request field.
- Database conflict/error codes produce understandable UI messages.

### Step 5 — Build the Booking Decisions UI

- Add a `Super Admin Decision` panel to the booking detail page.
- Show current stored status, computed lifecycle status, payment state,
  reservation state, captured amount, refunded amount, and outstanding amount.
- Present the supplier-result choices and only the valid contextual action.
- Display the exact wallet effect before enabling Apply Decision.
- For manual resolution, always display current and resulting Available/Hold
  balances and visibly separate supplier facts from customer-wallet movement.
- Require exact-effect confirmation for every manual supplier-verified
  resolution, and for automatic decisions whenever money will move.
- Preserve historical supplier evidence and cases in storage/read APIs, but do
  not render their proposal/evidence workflow inside the simplified Super
  Admin resolution panel.
- Do not show proposal, approval, evidence freshness, or supersession controls
  in the new decision flow.

Acceptance:

- A simple unpaid On Hold/Expired cancellation takes one decision submission.
- An existing held amount is clearly shown as captured or released; Restore On
  Hold never leaves an Issue Now Hold stuck.
- A captured cancellation cannot proceed without a financial disposition.
- No supplier amount field can populate the customer-wallet amount field.
- Manual resolution is absent for Instant Purchase, Manual Import, IMP/EXP,
  deposits, generic adjustments, and non-booking wallet screens.

### Step 6 — Retire the active Safety Cases experience safely

- Remove or rename the Super Admin navigation entry.
- Redirect the active Safety Cases page to the relevant booking decision queue
  or hide it after the replacement is verified.
- Preserve all historical tables, records, and read paths.
- Do not drop old APIs/functions until their production usage is confirmed to
  be zero; deprecate them first.

Acceptance:

- No historical case or evidence data is deleted.
- Existing bookmarks have a safe destination.

### Step 7 — Verification and regression coverage

- Add focused contract tests for every row in the wallet decision matrix.
- Verify unpaid cancellation performs no ledger movement.
- Verify an active hold is released even when `payment_state` says `unpaid`.
- Verify held confirmation captures exactly once.
- Verify held cancellation releases exactly once.
- Verify a stale `held` state without a real Hold never triggers automatic
  Capture or direct charge and is routed to the explicit manual lane.
- Verify a supplier-issued/no-local-hold case can use only an audited manual
  customer-wallet action with an independent amount and exact balance preview.
- Verify captured cancellation supports full, partial, no-refund, and external
  settlement without duplicate movement.
- Verify retained `legacy_operational=true` rows are reachable by exact
  reference for Super Admin without entering normal lifecycle lists/workers.
- Verify legacy/no-wallet decisions do not create a wallet.
- Verify evidence is optional and non-Super Admin access is forbidden.
- Run existing wallet, booking lifecycle, IMP/EXP, reconciliation, typecheck,
  lint, and production build checks.

Acceptance:

- All new focused tests pass.
- Existing wallet and lifecycle verification remains green, or any intentional
  contract replacement is documented with its updated test.

### Step 8 — Documentation and deployment handoff

- Update lifecycle, wallet, API, roles/permissions, and reconciliation docs.
- Document rollback behavior and feature-flag/rollout order if required.
- Record migration name, verification commands, and their results below.

Acceptance:

- Deployment can be completed without editing historical wallet data.
- Operators can identify whether a decision changed booking state, wallet
  state, both, or neither.

## Progress log

Update this section immediately after completing each implementation step.
Do not mark a step complete until its acceptance conditions have been checked.

| Date | Step | Status | Progress / evidence |
| --- | --- | --- | --- |
| 2026-08-23 | Plan creation | Complete | Created this plan before implementation. Recorded the agreed authority model, wallet matrix, atomicity requirements, phased work, and acceptance checks. |
| 2026-08-23 | Wallet matrix correction | Complete | Updated the plan so matching reservation and immutable ledger truth take priority over stale `payment_state`, including charge-on-confirm and release-on-cancel rules. |
| 2026-08-23 | Implementation authorization | Approved | User explicitly approved the corrected plan and requested implementation and verification. |
| 2026-08-23 | Step 1 — Current-state contracts | Complete | Inventoried the active Safety Cases page/workspace/navigation and reconciliation routes; booking detail integration point; migrations through `0105`; wallet owner/account/reservation/ledger schemas; `booking_hold`, `booking_confirm`, `hold_release`, and `refund` ledger types; booking-operation/case lock order; lifecycle event/outbox triggers; IMP/EXP and manual frozen `user_payable_amount` invariants. The new resolver will be migration `0106` and will classify actual accounting truth before checking `payment_state`. |
| 2026-08-23 | Step 2 — Decision contract | Complete | Added typed one-step decisions and conditional refund inputs. Evidence and notes are optional; request UUID, Super Admin database authorization, immutable audit identity, and exact money-movement confirmation are enforced. |
| 2026-08-23 | Step 3 — Atomic resolver | Complete | Added forward migration `0106_superadmin_booking_decisions.sql` with reservation/ledger accounting classification, fail-closed conflicts, booking→operation→case→reservation→wallet→account locking, direct charge/capture/release/refund/no-movement paths, immutable ledger/audit rows, lifecycle event/outbox integration, and idempotent replay. |
| 2026-08-23 | Step 4 — API boundary | Complete | Added Super Admin-only preview/apply API with validation, rate limiting, attempted/succeeded/failed security audit events, plain conflict messages, exact money preview, and post-commit notification dispatch. |
| 2026-08-23 | Step 5 — Booking Decisions UI | Complete | Added the booking-detail `Super Admin Decision` panel showing stored/lifecycle/payment/accounting truth, stale-state warning, decision-specific fields, exact wallet effect, optional note, and confirmation only when wallet money moves. |
| 2026-08-23 | Step 6 — Safety Cases retirement | Complete | Renamed navigation to Booking Decisions, redirected the old `/dashboard/safety-cases` bookmark to bookings, hid the old Super Admin imported maker/checker panel, and retained all historical case/evidence code and database records. |
| 2026-08-23 | Step 7 — Verification | Complete | Added the focused `verify:superadmin-booking-decisions` suite and passed wallet, lifecycle, outbox, IMP/EXP, pricing, cancellation, authorization, lock-order, release/refund guard, terminal-correction, typecheck, lint, migration-order, documentation, and production-build checks. |
| 2026-08-23 | Step 8 — Documentation/handoff | Complete | Updated roles, lifecycle, wallet, database, API, reconciliation runbook, and documentation index. Deployment requires migration `0106` before the application release; rollback keeps the additive immutable schema/history and rolls back only application exposure. |
| 2026-08-23 | Final operational clarification | Approved | Replaced the broad generic matrix with a stuck B2B/B2C Issue Now resolver: automatic local Capture/Release/No Movement plus a separate Super Admin Manual Supplier-Verified Resolution lane for incomplete local accounting. Supplier and customer-wallet amounts are independent. Manual preview must show current and resulting Available/Hold balances. Standard payment/import/deposit flows remain unchanged. |
| 2026-08-23 | Revision implementation | Complete | Implemented forward migration `0107`, V2 decision/API/UI contracts, deadline authority, the audited manual-resolution ledger contract, retained-history access, documentation, and expanded verification. No migration was applied to the live database and no deployment or wallet/booking action was performed. |
| 2026-08-24 | V2 database contract | Complete | Added `0107_superadmin_issue_resolution.sql`: durable Super Admin deadline authority; strict automatic Capture/Release/No Movement resolver; immutable manual-resolution records and distinct ledger types; independent supplier/customer amounts; balance snapshots; protection for Hold allocated to other bookings; explicit Issue Now case attestation; locked re-preview; idempotent replay; terminal/double-resolution guard; and explicit access for eligible retained historical rows. The explicit resolver writes a modern decided result while retained rows keep `legacy_operational=true` and remain excluded from normal workers. The migration has not been applied to any live database. |
| 2026-08-24 | V2 API and UI | Complete | Replaced the old generic decision dropdown with supplier outcomes and separate automatic/manual modes. Manual preview always shows current and exact resulting Available/Hold balances, never copies supplier amount, and requires exact-effect confirmation. Added a Super Admin-only exact-reference path and old-status normalization for retained historical bookings while normal lists/workers continue excluding them. |
| 2026-08-24 | V2 verification and handoff | Complete | Focused contracts, PostgreSQL parsing, full disposable migration-chain compilation, automatic/manual wallet execution matrices, retained legacy execution, migration order, typecheck, lint, affected wallet/lifecycle/reconciliation/IMP-EXP regressions, documentation checks, and the production build all passed. Live migration and deployment remain separately gated. |
| 2026-08-24 | Pre-deployment cleanup and readiness audit | Complete | Proved the old Safety Cases workspace and its two private readers had no production references after the compatibility redirect, then removed them and the duplicate Safety Cases navigation entry. Removed the retired reader's dead disabled-state API and updated historical contract verifiers so they no longer assert deleted UI. Retained the redirect, reconciliation APIs/database history, migrations, and active regression contracts because they still protect bookmarks, immutable history, or out-of-scope reconciliation flows. Full typecheck, lint, build, SQL parsing, disposable migration execution, focused authorization/accounting tests, and broad wallet/lifecycle/reconciliation/IMP-EXP regressions passed. Production schema probing shows contracts through `0105` and not `0106`/`0107`, but the exact remote migration ledger remains a deployment gate because this checkout is not linked and the direct database host was unavailable. No live migration, deployment, booking, wallet, or database write was performed. |

## Verification log

| Date | Command / check | Result | Notes |
| --- | --- | --- | --- |
| 2026-08-23 | Plan-file review | Pass | Plan explicitly forbids evidence as a Super Admin gate and forbids direct/arbitrary wallet edits. |
| 2026-08-23 | Corrected wallet-matrix review | Pass | Confirm and Cancel now derive their effect from actual hold/capture/release/refund history and fail closed on ambiguity. |
| 2026-08-23 | Step 1 contract inventory | Pass | Confirmed one reservation per booking/attempt, immutable unique-idempotency ledger, non-negative account constraints, booking-owner wallet identity, terminal lifecycle events/outbox, and active operation/case preservation requirements. |
| 2026-08-23 | `npm run typecheck` | Pass | New database boundary, API, booking page integration, and client decision panel compile without TypeScript errors. |
| 2026-08-23 | `npm run verify:superadmin-booking-decisions` | Pass | Focused static contract checks cover ledger/reservation precedence, all corrected Confirm/Cancel branches, idempotency, lock order, evidence independence, API authorization/audit, UI preview, and compatibility redirect. |
| 2026-08-23 | `npm run verify:migration-order` | Pass | Forward migration `0106` follows the repository migration sequence. |
| 2026-08-23 | `npm run lint` | Pass | ESLint completed without findings. |
| 2026-08-23 | Existing wallet/lifecycle regression group | Pass | `verify:wallet`, `verify:booking-lifecycle`, `verify:booking-lifecycle-atomic-outbox`, `verify:on-hold-cancellation`, and legacy `verify:booking-safety-cases` all passed. |
| 2026-08-23 | Existing IMP/EXP regression group | Pass | Wallet, On Hold/Unpaid, pricing invariants, manual completion, financial disposition, and direct-import decision suites all passed. |
| 2026-08-23 | Existing reconciliation regression group | Pass | Resolution contracts, lock order, ticketed, unpaid/held/captured cancellation, terminal corrections, database authorization, permissions, and generic release/refund guards all passed. |
| 2026-08-23 | `npm run verify:booking-lifecycle-documentation` | Pass | Permanent lifecycle/runbook documentation contains no direct-database mutation instruction or invalid refund implication. |
| 2026-08-23 | `npm run build` | Pass | Final Next.js production build compiled, typechecked, generated pages, and registered `/api/admin/bookings/[reference]/decision`. |
| 2026-08-24 | `npm run typecheck` (V2 revision) | Pass | V2 database wrappers, dual-mode API, historical Super Admin reader, exact-reference access, wallet ledger vocabulary, and resolution panel compile without TypeScript errors. |
| 2026-08-24 | `npm run verify:superadmin-booking-decisions` (V2 revision) | Pass | Confirms strict Issue Now scope, actual-accounting precedence, no automatic direct charge, Restore/Cancel Hold release, deadline authority, independent supplier/customer amounts, manual balance previews, immutable/idempotent manual entries, historical access, and UI/API gates. |
| 2026-08-24 | PostgreSQL parser checks | Pass | `pglast` parsed migration `0106` (17 statements) and `0107` (43 statements); `sqlfluff parse` parsed the complete `0107` file with the large-file skip disabled. |
| 2026-08-24 | Disposable full migration chain | Pass | PGlite compiled 106 applicable migrations/contracts, excluding only the repository's `pg_cron` migration and data-only historical assertion blocks that require production rows. All five V2 RPC signatures were present. Nothing was applied to the live database. |
| 2026-08-24 | Disposable automatic/manual financial matrix | Pass | Verified manual debit with independent supplier/customer amounts and exact before/after balances; idempotent replay moved money once. Verified active-Hold release preview/execution/replay, exact balances, and exactly one release ledger entry. |
| 2026-08-24 | Disposable retained-history execution | Pass | A real `legacy_operational=true`, stored `held`, unpaid booking opened as On Hold, previewed Cancel with no movement, resolved to modern `cancelled`, retained its legacy flag, and created zero wallet ledger entries. A second retained `held` row with a proven active Hold previewed Capture, confirmed successfully, reduced Hold exactly once, created exactly one capture entry, retained its legacy flag, and replayed without duplicate movement. |
| 2026-08-24 | Disposable deadline-authority execution | Pass | Restored an expired retained booking with a future Super Admin deadline, simulated a later legacy supplier-deadline refresh, and verified that the Super Admin effective deadline and active pointer remained unchanged while the supplier deadline was separately updated and the immutable override history remained readable. |
| 2026-08-24 | `npm run verify:migration-order` | Pass | Forward migrations remain ordered through `0107`. |
| 2026-08-24 | `npm run lint` | Pass | ESLint completed without findings after the V2 and retained-history changes. |
| 2026-08-24 | Existing regression groups (V2 revision) | Pass | Wallet, lifecycle/outbox, On Hold cancellation, resolution contracts, reconciliation lock/release/refund guards, Safety Cases compatibility, terminal corrections, IMP/EXP wallet/On Hold/financial/pricing/direct-import, local deadline, and lifecycle documentation suites all passed. |
| 2026-08-24 | `npm run build` (V2 revision) | Pass | The optimized Next.js build completed and registered the decision API and booking detail routes. |
| 2026-08-24 | Obsolete-code reference audit and cleanup | Pass | Removed only the unreferenced `BookingSafetyCasesWorkspace`, its dashboard reader, its database reader, the duplicate navigation link/import, and the evidence reader's now-unreachable disabled branches. Retained the Super Admin-only compatibility redirect and all historical database/audit/reconciliation contracts. Static reference searches and TypeScript compilation confirm no surviving production dependency on the deleted modules. |
| 2026-08-24 | Final SQL and disposable execution readiness | Pass | `pglast` parsed `0106` (17 statements) and `0107` (43 statements); SQLFluff parsed both complete files; the disposable migration chain compiled 106 applicable migrations and exercised Super Admin-only authorization, no-money Cancel/Restore, Hold Capture/Release, paid/no-duplicate confirmation, manual resolution and replay, independent supplier/customer amounts, exact balance previews, retained legacy resolution, historical-case preservation, and deadline authority. |
| 2026-08-24 | Final application verification | Pass | `npm run typecheck`, `npm run lint`, `npm run build`, the focused Super Admin suite, and the broad active wallet, booking, lifecycle, reconciliation, notification, deadline, manual-booking, and IMP/EXP suites passed after cleanup. The public-status boundary and legacy deadline verifier were corrected to test the active contracts and then passed. |
| 2026-08-24 | Production migration-state verification | Complete | The linked production ledger was verified directly: local and remote migrations are aligned through `0105`, only `0106` and `0107` are pending, and no earlier pending migration or visible drift exists. Read-only production compatibility probes found zero rows outside the expanded ledger-type, deadline-source, legacy-status, or modern-status constraints. |
| 2026-08-24 | Live-mutating security-hardening suite | Intentionally not run | The existing security-hardening verifier writes rate-limit, lock, and audit rows and invokes retention enforcement against the configured database. Running it would violate the explicit no-database-action instruction. Equivalent Super Admin authorization was checked statically and in the disposable database; run the mutating suite only in an authorized staging environment. |
| 2026-08-24 | Local System Reports storage failure | Complete | Root cause was a misnamed local environment file: credentials were stored in `env.local`, which Next.js does not auto-load. Renamed it to the ignored standard `.env.local` without changing credential values and restarted only the local development server. Next now reports `.env.local` as loaded; read-only queries against lifecycle metrics, notification metrics, derived metrics, and attempt-reconciliation views all succeeded. Disabled Next's development-only agent-rule generator and removed its two proven temporary files so they no longer reappear. Typecheck, ESLint, production build, and diff checks passed. The available browser automation session was signed out and correctly redirected to sign-in, so authenticated visual verification was not bypassed. No migration, deployment, booking, wallet, or database write was performed. |
| 2026-08-24 | Linked production migration dry run | Complete | `npx supabase db push --linked --dry-run --skip-vault` exited successfully and reported exactly `0106_superadmin_booking_decisions.sql`, then `0107_superadmin_issue_resolution.sql`, with no seeds or roles. The dry run explicitly made no database change. |
| 2026-08-24 | Booking-list column labels | Complete | Updated both desktop and mobile booking-list labels from `Fare` to `User Payable` and from `Lifecycle Time` to the grammatically appropriate `Issued At`. Sorting keys, displayed values, lifecycle logic, and accounting behavior are unchanged. TypeScript, ESLint, and diff checks passed. |
| 2026-08-24 | Production migration application | Complete | User authorized proceeding after the linked dry run. Applied only `0106`, then `0107`, with Vault updates disabled. The linked ledger now reports local/remote alignment through `0107`; all three immutable resolution tables are readable, and the V2 context RPC is exposed with its Super Admin authorization guard active. No application deployment or booking/wallet resolution was performed during migration. |
| 2026-08-24 | 0108 imported-ticketing architecture | Complete | Added forward-only `0108_imported_booking_ticketing_resolution.sql`. On Hold imports remain no-money; owner Issue Now atomically creates an active User Payable Hold; dedicated Support/Admin/Super Admin resolution captures or releases that Hold exactly once; legacy captured In Progress imports confirm without another debit or cancel only with an explicit refund disposition; already Confirmed imports remain direct one-time captures. The old Manual Status confirmation bypass is blocked at both API and database boundaries, imported bookings remain excluded from `0107`, and unsafe historical accounting now displays a clear fail-closed reason. |
| 2026-08-24 | 0108 implementation verification | Complete with unrelated baseline exceptions | Full-schema PGlite execution passed through `0108`, including the production wallet/lifecycle triggers, active Hold Capture/Release, legacy captured full refund, idempotent replay, immutable resolution history, role authorization, exact before/after wallet preview, direct confirmed import, and no supplier call. TypeScript, ESLint, production build, dry-run (`0108` only), and all focused wallet/IMP-EXP/manual/imported-resolution suites passed. Of 98 non-live repository verifiers, 93 passed; five unrelated pre-existing/environmental checks remain: two stale flight verifier/data assumptions and three remediation checks requiring absent `backups/` snapshots. No live migration or deployment was performed. |
| 2026-08-24 | 0108 pre-deployment diff audit | Complete | Audited all 30 modified/untracked paths. Twenty-nine paths belong to the approved imported Issue Now Hold, dedicated staff resolution, legacy-capture compatibility, UI/API boundary, documentation, or active contract verification. Excluded the unrelated booking-list label-only change from the `0108` commit. Confirmed no environment files, backups, dumps, generated output, debug code, or `STR260824000001` deadline repair is included. |
| 2026-08-24 | 0108 staged release verification | Complete | Verified the exact Git index in an isolated checkout: TypeScript, ESLint, full-schema imported-resolution execution, migration order, imported Hold/confirmation/status/notification/wallet suites, manual-import backward compatibility, and customer messaging passed. The production build then passed with the working tree exactly matching the staged index and registered the new imported ticketing-resolution API route. No production migration or deployment command was run. |
| 2026-08-24 | 0108 migration and development deployment gate | Blocked after migration | Reverified approved commit `9e5fc5a`, clean release scope, exact `0108`-only dry run, fresh TypeScript/ESLint/build/focused regressions, then applied only migration `0108`. The linked ledger and empty follow-up dry run prove alignment through `0108`; the new table/RPCs and fail-closed authorization probe passed. `origin/development` remains exactly `9e5fc5a` and `main` was untouched. Vercel automatically built that commit as a Ready Preview, but the Preview cannot authenticate because Clerk rejects the Preview-domain request, while the current Production deployment remains commit `4301e9f`. Stopped before promotion or authenticated/UI/financial smoke testing; no booking or wallet action occurred. |

## Decisions and changes to scope

Record any later product decision here before implementing it.

| Date | Decision | Reason | Approved by |
| --- | --- | --- | --- |
| 2026-08-23 | Initial scope recorded; implementation not started | User requested a maintained step-by-step plan and progress record before proceeding. | User |
| 2026-08-23 | Actual reservation/ledger state overrides stale `payment_state` | Prevent double charges and ensure real holds are captured/released even when the booking summary is stale. | User |
| 2026-08-23 | Manual supplier-verified financial exception is a separate audited lane | Missing local accounting must not make a manually verifiable stuck case permanently impossible; it must remain visibly distinct from normal Hold Capture/Release. | User |
| 2026-08-23 | Supplier and customer-wallet amounts are independent inputs | Supplier-wallet movement is not proof of the B2B/B2C wallet amount. | User |
| 2026-08-23 | Exception limited to stuck ordinary B2B/B2C Issue Now | Preserve Instant Purchase, Manual Import, IMP/EXP, deposits, and all other standard flows unchanged. | User |
| 2026-08-24 | Retained historical rows use an explicit Super Admin read/resolution path while keeping `legacy_operational=true` | Makes safely resolvable old bookings reachable without adding them to normal lifecycle lists, schedulers, or supplier workers. | User-approved historical coverage goal |
| 2026-08-24 | Imported Issue Now uses Hold, not pre-ticketing capture | Imported On Hold creation has no wallet effect; the owner protects User Payable only when choosing Issue Now, then staff Capture/Release follows the verified external outcome. | User |
| 2026-08-24 | Imported resolution remains separate from `0107` | Imported ticket evidence, cancellation timestamps, and legacy captured handling are source-specific and must not widen the ordinary stuck Triplover Issue Now exception lane. | User |

## Deployment and rollback

**Do not deploy the application or apply migration `0108` to the live database
until the user separately authorizes deployment.** Migrations `0106` and `0107`
are already present in the linked production ledger.

1. Confirm the release commit is pushed and the linked ledger still shows only
   `0108_imported_booking_ticketing_resolution.sql` pending.
2. Start a coordinated release window and temporarily pause imported-booking
   Issue Now/manual-status actions so the old application cannot call the
   replaced imported-ticketing RPC boundary during the cutover.
3. Apply only migration `0108` with `npx supabase db push --linked --skip-vault`.
4. Immediately deploy the matching application revision, then restore imported
   booking actions.
5. Smoke-test read-only context/preview first for an active Hold and a legacy
   captured imported In Progress booking. Use a separately authorized controlled
   booking for the first live Capture/Release test.
6. Monitor security audit failures, imported resolution conflict codes, wallet
   ledger entries, lifecycle outbox rows, and notification delivery.
7. For application rollback, restore the previous application bundle but keep
   migrations `0106`, `0107`, and additive `0108` immutable history. Pause
   imported booking actions because the old application labels/behavior do not
   match the `0108` RPC semantics. Never drop the tables/functions or reverse a
   wallet ledger entry by editing history.
8. Any incorrect committed financial decision is corrected by a new audited
   forward transaction, never by updating/deleting the ledger or decision row.
