# Ticket Management Controlled Production Release Procedure

## Status and authority

- **Prepared:** 2026-08-30
- **State:** Gates 0-4 executed and verified through `0129`; Gate 5 blocked
  pending an explicitly dedicated confirmed, unused production test booking
- **Database scope:** Production migrations `0119` through `0129`
- **Application scope:** The reviewed Ticket Management and generic-wallet
  authorization release artifact
- **Staging decision:** The owner has accepted the risk of releasing without a
  separate Supabase staging rehearsal. This does not waive any production
  preflight, backup, dry-run, feature-flag, verification, or stop condition.
- **Current authority:** The dark-state database release is complete. Production
  Ticket Management remains disabled. No Gate 5 smoke, notification delivery,
  scheduler enablement, or wallet action is authorized against an ordinary
  customer booking.

## Non-negotiable controls

1. Use two people during the database window: one database operator and one
   independent reviewer/release owner.
2. Freeze unrelated schema and production releases until this procedure ends.
3. Pin the Supabase CLI to the repository-recorded version `2.116.0`.
4. Keep `TICKET_MANAGEMENT_ENABLED=false` explicitly set in Production until
   the database and dark-state verification gates pass.
5. Keep Ticket Management notification delivery and the expiry scheduler
   disabled. Migration `0126` creates intent rows only.
6. Never repair a failed migration by editing an applied migration, deleting
   migration-ledger rows, deleting immutable audit/ledger rows, or manually
   changing wallet balances.
7. Do not run any Ticket Management Approve, Complete, Hold, Capture, Release,
   Refund-credit, or payable-VOID action during the initial smoke test.

## Release evidence record

Before starting, create an operator record containing:

- approved Git commit SHA and deployment/artifact identifier;
- production Supabase project reference confirmed by both operators;
- database backup/PITR checkpoint and timestamp;
- current production deployment identifier;
- Production value of `TICKET_MANAGEMENT_ENABLED`;
- checksums for migrations `0119`-`0129`;
- output of migration list, database lint, migration dry run, apply, post-apply
  migration list, and empty follow-up dry run;
- all smoke-test request IDs, booking reference, actors, timestamps, and result;
- before/after wallet balance and ledger-count snapshots for the smoke booking.

Never place database passwords, service-role keys, access tokens, or customer
PII in the release record.

## Gate 0 — reviewed release artifact

Run from a clean checkout of the exact proposed release commit:

```bash
git status --short
git rev-parse HEAD
git diff --check
shasum -a 256 supabase/migrations/0119_ticket_management_core.sql \
  supabase/migrations/0120_ticket_management_lifecycle_assignment.sql \
  supabase/migrations/0121_ticket_management_entitlements.sql \
  supabase/migrations/0122_ticket_management_wallet_substrate.sql \
  supabase/migrations/0123_ticket_management_refund_settlement.sql \
  supabase/migrations/0124_ticket_management_reissue_settlement.sql \
  supabase/migrations/0125_ticket_management_void_settlement.sql \
  supabase/migrations/0126_ticket_management_notification_outbox.sql \
  supabase/migrations/0127_generic_wallet_authorization_hardening.sql \
  supabase/migrations/0128_ticket_management_single_passenger_entitlement.sql \
  supabase/migrations/0129_ticket_management_manual_single_passenger_entitlement.sql
npm run typecheck
npm run lint
npm run build
npm run verify:wallet
node scripts/verify-generic-wallet-authorization.mjs
node scripts/verify-booking-reconciliation-refund-guard.mjs
node scripts/verify-ticket-management-contracts.mjs
node scripts/verify-ticket-management-core.mjs
node scripts/verify-ticket-management-lifecycle.mjs
node scripts/verify-ticket-management-entitlements.mjs
node scripts/verify-ticket-management-entitlement-db.mjs
node scripts/verify-ticket-management-wallet-hold.mjs
node scripts/verify-ticket-management-void.mjs
node scripts/verify-ticket-management-api.mjs
node scripts/verify-ticket-management-ui.mjs
node scripts/verify-ticket-management-migration-rehearsal.mjs
npm run verify:booking-lifecycle-release
npm run verify:impexp-wallet
npm run verify:manual-booking-import
npm run verify:canonical-pricing-regression
npm run verify:staff-on-behalf-booking
```

Expected result: a clean checkout and every command exits zero. The disposable
migration rehearsal executes every migration through `0129` except historical
`0042`; historical migration `0042` is the sole
PGlite exclusion because it requires Supabase `pg_cron`, `pg_net`, and Vault.
It is already inside the production baseline and is not part of this release.

**Stop immediately** if the checkout is dirty, a checksum changes after
approval, or any command fails.

## Gate 1 — fail-closed application deployment

1. Explicitly set the Production server environment variable:

   ```text
   TICKET_MANAGEMENT_ENABLED=false
   ```

2. Confirm there is no configured schedule invoking
   `/api/cron/ticket-management`.
3. Deploy the exact reviewed application artifact while the flag is false.
4. With authenticated production accounts, verify:

   - Refund/Reissue/VOID quick actions are hidden;
   - the Manage Ticket Management workspace is hidden;
   - `/api/ticket-management` returns HTTP `503` with
     `TICKET_MANAGEMENT_DISABLED`;
   - an authorized call to `/api/cron/ticket-management` returns HTTP `503`
     with `TICKET_MANAGEMENT_DISABLED`;
   - existing booking, issue, cancellation, wallet, deposit, ledger, and report
     screens still operate normally.

The new application is deliberately deployed before the schema because every
Ticket Management entry point fails closed before accessing its new tables.

**Stop immediately** if any Ticket Management UI/action is available while the
flag is false, or if an existing booking/wallet path regresses. Roll back the
application artifact and leave the database unchanged.

## Gate 2 — production identity, backup, and migration-ledger preflight

Do not proceed until both operators verbally and in writing confirm the target
is the intended production project.

1. Confirm a current recoverable Supabase backup/PITR checkpoint and record its
   timestamp and retention window.
2. Confirm no unrelated migration or deployment is running.
3. Use the pinned CLI without changing the repository dependency manifest:

   ```bash
   npx --yes supabase@2.116.0 migration list --linked
   npx --yes supabase@2.116.0 db lint --linked
   npx --yes supabase@2.116.0 db push --linked --dry-run --skip-vault
   ```

4. For a fresh replay of this release, the migration ledger must show
   local/remote alignment through exactly `0118`. The dry run must list exactly
   these eleven files, in this order, and
   nothing else:

   1. `0119_ticket_management_core.sql`
   2. `0120_ticket_management_lifecycle_assignment.sql`
   3. `0121_ticket_management_entitlements.sql`
   4. `0122_ticket_management_wallet_substrate.sql`
   5. `0123_ticket_management_refund_settlement.sql`
   6. `0124_ticket_management_reissue_settlement.sql`
   7. `0125_ticket_management_void_settlement.sql`
   8. `0126_ticket_management_notification_outbox.sql`
   9. `0127_generic_wallet_authorization_hardening.sql`
   10. `0128_ticket_management_single_passenger_entitlement.sql`
   11. `0129_ticket_management_manual_single_passenger_entitlement.sql`

5. In the Supabase SQL editor, perform a read-only ledger cross-check:

   ```sql
   select version, name
     from supabase_migrations.schema_migrations
    order by version desc
    limit 15;
   ```

   The highest applied version must be `0118`; none of `0119`-`0129` may
   already exist.

6. Record read-only financial baselines before migration/smoke:

   ```sql
   select currency,
          count(*) as account_count,
          sum(available_balance) as available_total,
          sum(hold_balance) as hold_total
     from public.wallet_accounts
    group by currency
    order by currency;

   select count(*) as ledger_count, max(created_at) as latest_ledger_at
     from public.wallet_ledger_entries;
   ```

**Stop immediately** for any project-identity doubt, missing backup/PITR,
ledger gap or drift, earlier pending migration, unexpected tenth migration,
lint error, dry-run error, or dry-run order mismatch. Do not use migration
repair commands to make the ledger appear aligned.

## Gate 3 — controlled database migration

Keep `TICKET_MANAGEMENT_ENABLED=false`. During the approved maintenance window,
the database operator runs and the reviewer watches the complete output:

```bash
npx --yes supabase@2.116.0 db push --linked --skip-vault
```

Do not interrupt a running migration command unless the database connection is
already lost or Supabase instructs the operator to stop. When it returns:

```bash
npx --yes supabase@2.116.0 migration list --linked
npx --yes supabase@2.116.0 db push --linked --dry-run --skip-vault
npx --yes supabase@2.116.0 db lint --linked
```

Expected result:

- `0119`-`0129` are applied once and aligned locally/remotely;
- the follow-up dry run reports the database is up to date;
- lint reports no new error.

**Stop immediately** if the apply returns non-zero, the ledger is only partly
advanced, the follow-up dry run is non-empty, or lint reports a new error. Keep
the feature flag false, capture all output and the exact last applied version,
and prepare a new reviewed forward migration. Do not rerun blindly.

## Gate 4 — dark-state schema and authorization verification

While the feature remains disabled, run these read-only checks in the Supabase
SQL editor:

```sql
select version, name
  from supabase_migrations.schema_migrations
 where version between '0119' and '0129'
 order by version;

select relname, relrowsecurity
  from pg_class
 where relnamespace = 'public'::regnamespace
   and relname in (
     'ticket_management_requests',
     'ticket_management_request_events',
     'ticket_management_quotes',
     'ticket_management_customer_decisions',
     'ticket_management_assignments',
     'ticket_management_ticket_entitlements',
     'ticket_management_request_selections',
     'ticket_management_entitlement_claims',
     'ticket_management_reissue_quote_terms',
     'ticket_management_reissue_quote_allocations',
     'ticket_management_reissue_completions',
     'ticket_management_reissue_lineages',
     'ticket_management_void_completions',
     'ticket_management_notification_outbox'
   )
 order by relname;

select proname
  from pg_proc
 where pronamespace = 'public'::regnamespace
   and proname in (
     'create_ticket_management_request_v2',
     'review_ticket_management_request_v1',
     'publish_ticket_management_quote_v1',
     'publish_ticket_management_reissue_quote_v1',
     'decide_ticket_management_quote_v2',
     'assign_ticket_management_settlement_v1',
     'complete_ticket_management_refund_v1',
     'complete_ticket_management_reissue_v1',
     'release_and_reopen_ticket_management_reissue_v1',
     'complete_ticket_management_void_v1',
     'release_and_reopen_ticket_management_void_v1',
     'expire_ticket_management_quotes_v1',
     'wallet_review_adjustment',
     'enforce_wallet_adjustment_request_actor_v1'
   )
 order by proname;

select p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_execute
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and (
     p.proname like '%ticket_management%'
     or p.proname in ('wallet_review_adjustment', 'wallet_refund_booking')
   )
 order by p.proname, p.oid;
```

Expected result: eleven ledger rows; every listed table exists with RLS enabled;
all required functions exist; mutation RPCs are unavailable to `anon` and
`authenticated` and available only through the server/service boundary.

Also repeat the Gate 1 application checks. **Stop** for a missing object,
unexpected grant, API storage error while disabled, or any changed wallet
baseline. Keep the schema in place, keep the feature disabled, and correct
forward only.

## Gate 5 — controlled non-financial production smoke

This gate requires a fresh approval after Gates 0-4 evidence is reviewed.
Because the feature flag is global, schedule a short monitored activation
window and use a dedicated production test customer/agency with a confirmed,
unused test ticket. Do not use an ordinary customer's booking.

1. Record the test booking's wallet account balances, wallet ledger count, and
   absence of existing active Ticket Management claims.
2. Set `TICKET_MANAGEMENT_ENABLED=true`, redeploy the same artifact, and verify
   the deployment environment reports the exact value `true`.
3. Perform only this no-wallet lifecycle:

   - owner submits one Refund request for the test passenger;
   - Support accepts it (`Requested → In Progress`);
   - Support publishes a credit quotation with a future deadline and exact
     separated Gross, Supplier Payable, User Payable, airline fee, service fee,
     and final customer amount (`In Progress → Awaiting Confirmation`);
   - customer rejects the quotation (`Awaiting Confirmation → Rejected`).

4. Verify:

   - the booking owner, charged wallet account, passenger/ticket selection,
     quote version, deadline, events, and customer decision are correct;
   - Support can read/operate but sees no wallet settlement action;
   - Accounts/Admin/Superadmin can read the request, but no completion control
     is applicable after rejection;
   - no Ticket Management reservation exists for the request;
   - no wallet ledger entry references the request;
   - available and Hold balances and the global wallet totals exactly match the
     pre-smoke snapshot;
   - the notification outbox may contain render-safe intent rows, but no
     delivery was attempted.

5. Confirm Support receives HTTP `403` from generic adjustment creation/review
   and generic Refund mutation attempts. Use requests that fail authorization
   before a valid target or amount is processed; they must create no database
   or wallet record.
6. Keep the expiry scheduler unscheduled during this smoke.

**Stop and immediately set `TICKET_MANAGEMENT_ENABLED=false`** for any wrong
role control, ownership mismatch, unexpected reservation/ledger row, wallet
balance change, notification delivery, duplicate request/event, server error,
or audit failure. Do not continue to a financial smoke.

## Gate 6 — enablement decision

After the non-financial smoke evidence is approved, choose one outcome:

- **Hold:** set `TICKET_MANAGEMENT_ENABLED=false` and leave the additive schema
  installed while issues are corrected forward.
- **Enable:** keep `TICKET_MANAGEMENT_ENABLED=true`, monitor continuously, and
  authorize real requests. Financial completion remains restricted to the
  actively assigned Accounts/Admin/Superadmin actor and the immutable approved
  quotation.

The expiry scheduler is a separate enablement decision. Configure its
authenticated invocation only after quotation/deadline behavior is stable.
Notification delivery remains a separate future approval; outbox creation does
not authorize sending.

## Rollback and stop policy

### Before database migration

- Set/keep the flag false.
- Roll back the application deployment to the prior artifact if needed.
- Do not run `db push`.

### After a partial or failed migration

- Keep the flag false and stop all releases.
- Record the last successful migration and full error output.
- Do not delete ledger rows, mark migrations applied manually, down-migrate, or
  rerun blindly.
- Diagnose against a schema copy when possible and deliver a new forward-only
  correction reviewed by both operators.

### After all migrations but before financial activity

- Set/keep the flag false.
- The additive schema may remain installed.
- Roll back the application artifact only if the prior version is verified
  compatible with the additive schema.
- Correct defects through a new forward migration/application release.

### After any Hold, Capture, Release, Refund, VOID, or Reissue settlement

- Immediately set the feature flag false to stop new Ticket Management work.
- Never down-migrate financial history, delete audit/outbox/entitlement rows,
  edit immutable ledger entries, or change balances manually.
- Preserve the request, quotation, assignment, wallet, ledger, entitlement,
  and audit evidence.
- Use only a reviewed forward correction or an existing authorized
  reconciliation operation.

## Final release completion criteria

The release is complete only when:

- all Gates 0-4 pass and their evidence is retained;
- the separately approved Gate 5 smoke terminates in Rejected with zero wallet
  movement;
- Support financial-denial checks pass;
- no new production error or audit failure appears during the observation
  window;
- the release owner explicitly approves Gate 6 enablement or explicitly chooses
  Hold.
