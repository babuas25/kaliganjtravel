# Kaliganj Travels — fresh database installation

Prepared 2026-09-11 for project `ljzoizsogbirlvlsrwzi`.

**Status: installed and verified on hosted Supabase, 2026-09-11.**

**Request prefixes, 2026-09-12:** applied `20260912010000_kt_request_references.sql`.
Deposits now use `KTDYYMMDD######`; Refund, Reissue and VOID use `KTRR`, `KTRE`
and `KTRV` plus their existing 12-character hexadecimal suffix format. Existing
request references are converted while IDs and deposit counters remain intact.
The reference-change protection is restored within the same migration transaction.
Historical notification snapshots retain their original contents. Validate with
`node scripts/verify-kt-request-references.mjs`; the full fresh-install migration
chain also passed in a disposable PGlite database. Hosted verification confirmed
`STD260912000001` became `KTD260912000001` with its identity and financial fields unchanged.

**Cash deposit fix, 2026-09-12:** applied `20260912000000_kaliganj_head_branch.sql`
to configure active **Head Branch** at the Kaliganj office address. The initial
branch catalog was empty. Verified the hosted active-branch query returns the
new entry. `node scripts/verify-cash-deposit-branch.mjs` tests the frozen baseline
plus this migration, repeat application, and a cash deposit referencing the branch
without crediting a wallet. The fresh-install checker verifies the installed baseline against its recorded
SHA-256 before rehearsing it; later historical source edits do not require regeneration.

**Later update, 2026-09-11:** forward migration `20260911010000` installed public company contacts from `kaliganjtravel.com`. Application rebranding is complete locally; see `../../docs/24-KALIGANJ-REBRANDING.md`. `installation.json` remains the original baseline receipt. Hosted checks now use `npm run verify:hosted-database -- --post-setup` to report security audit/rate-limit records created by verification while still requiring empty business tables. The default initial-empty check remains strict.

Project `ljzoizsogbirlvlsrwzi` had zero public application tables/views before installation. Only baseline `20260911000000` was applied, without seeds or a backup restore. Hosted verification passed: **82 tables, 303 public functions, all table RLS enabled, all business tables empty**, eight REST checks and a read-only lifecycle RPC. Anonymous access to company settings is denied. A post-install CLI dry run reports no pending migrations or seeds. See `installation.json` for the timestamp, checksum and verification receipt.

The stale local `SUPABASE_DB_PASSWORD` was aligned with the successfully authenticated password already in `DATABASE_URL`; no remote password was changed. No credential is stored in this directory.

This is a new installation, not a data migration or a backup restore. The generator reads only local SQL source files. It never reads `.env`, logs into a service, queries an existing database, downloads media, or copies users/bookings/wallets. Tests use an in-memory PGlite database and dispose of synthetic test records when finished.

## Files and regeneration

Local verification from the application root:

```bash
node scripts/verify-fresh-database.mjs
```

For the currently unused hosted database: `npm run verify:hosted-database`. This check deliberately expects no business records; after real onboarding/usage starts, use ordinary health checks instead of this initial-empty-state assertion.

The baseline is now frozen. `scripts/prepare-fresh-database.mjs` refuses regeneration when `installation.json` exists. Do not remove that receipt to overwrite an applied migration; add new forward migrations here.

- `supabase/migrations/20260911000000_kaliganj_baseline.sql` in **this directory** is the new standalone baseline.
- `manifest.json` records the SHA-256 of each of the 159 legacy source files, each prepared section, and the final artifact.
- The generator's reviewed transformations are in `scripts/helpers/fresh-database.mjs` at the application root.
- The original application-root `supabase/migrations/` files remain unchanged for reference and existing source-based tests. They are **not** the migration history for the new project.

The generated baseline is intentionally in a separate Supabase CLI workdir. This prevents the CLI from treating the original booking-specific repair migrations as pending migrations on the new database. Future Kaliganj database migrations belong alongside this baseline, with newer versions. Once the baseline is applied, do not regenerate/edit it for subsequent production changes; use forward migrations.

## Changes from the old installation

1. Preserve all schema/function work from `0034`; omit its historical booking repair. Omit `0036` and `0039` entirely because they are historical booking-only repairs. Omit the one historical email-error update in `0035`.
2. Remove the old company branch and promotional message/offer seeds. No company bank account, payment recipient, user or historical transaction is seeded.
3. The homepage editor requires three pre-existing offer IDs. Create **three new inactive placeholder slots** with new UUIDs, no images, and no old offer claims. These are new editor scaffolding, not transferred offers. Configure them before publishing.
4. Create `company_settings` with the name `Kaliganj Travels`. License, phone, email and address remain NULL until real details are supplied. Notification snapshots read this table and display `--` for unspecified fields; no old company fallback remains in the prepared SQL.
5. Create an empty `company_admin_sms_recipients` table. Future B2B deposits enqueue SMS only for enabled rows in this table. No configured recipients means no admin SMS is queued; adding recipients later does not retroactively queue earlier deposits.
6. Select `triplover` in `supplier_operational_settings`, with booking and ticketing **disabled** until setup/testing is complete. FirstTrip/TakeOff remain supported but unconfigured. Their entries in the supplier limit catalog are configuration placeholders, not credentials or old business data.
7. Defer platform cron/Vault installation (`0042`). No workers or external requests are started by this baseline.
8. Enable RLS on `booking_reconciliation_proposal_supersessions`, whose original migration revoked client grants but omitted RLS. Preserve the existing RPC-only grants.
9. Keep booking/agency reference formats (`STR...`, `ST-B2B...`) to preserve application validation compatibility. Counters start empty; retaining a format does not transfer old references or records.

## Verified empty-state contract

The test applies the **exact generated SQL artifact**, including its transaction and empty-schema guard, with no historical booking fixtures.

It creates 82 public tables. Only these contain rows immediately after installation:

| Table | Rows | Purpose |
|---|---:|---|
| `company_settings` | 1 | New company name, contact fields unset |
| `supplier_operational_settings` | 1 | Triplover selected; booking/ticketing off |
| `flight_search_supplier_limits` | 3 | Supported supplier catalog, no credentials |
| `announcement_slider_settings` | 1 | Empty slider configuration |
| `homepage_offer_settings` | 1 | New heading/configuration |
| `homepage_travel_offers` | 3 | New, inactive editor slots with no assets |
| `promotional_popup_settings` | 1 | Disabled popup, no slides |

Every other public table is asserted empty, including users, agencies, staff, documents, bookings, passengers, wallet/accounts/ledger, payment branches/accounts, notification queues, search history, counters and audit records.

The test also verifies RLS on every public table, denies client-role access to the new settings tables, refuses reruns against an existing schema, and uses newly invented test records to verify:

- No configured SMS recipients → no admin deliveries.
- Enabled/disabled recipient settings → only the enabled test number is queued and claimable, with no real SMS send.
- A deposit request leaves wallet balance at zero.
- New booking snapshots use new company settings; subsequent configuration edits do not alter old snapshots.

PGlite validates PostgreSQL schema and trigger behavior. It does **not** prove hosted PostgREST schema-cache behavior, provider credentials, Clerk/Vercel setup, pg_cron/pg_net/Vault operation, or every application's end-to-end workflow.

## Hosted installation record and future migrations

The commands below were used for this new hosted project before applying the baseline. The SQL refuses an existing public table/view schema and never drops an existing project to force installation. Do not attempt to install the baseline again.

Both workdirs now link to the new project, but future migrations must use this separate workdir:

```bash
npx supabase link --workdir supabase/fresh-install --project-ref ljzoizsogbirlvlsrwzi
cat supabase/fresh-install/supabase/.temp/project-ref
npx supabase db push --workdir supabase/fresh-install --dry-run
```

The linked ref must be exactly `ljzoizsogbirlvlsrwzi`. The initial dry run showed only `20260911000000_kaliganj_baseline.sql`; after installation it shows no pending migrations. Do not use root `db push` and do not restore any backup/seed from the previous company. Do not disable the empty-schema guard to get past an unexpected existing database.

For hosted cron setup later, create new-project Vault entries `booking_status_app_url` and `booking_status_cron_secret` matching the new deployment and `CRON_SECRET`. The logic in original `0042` can then be adapted into a new forward migration here. Also configure the ticket-management expiry schedule. Do not start schedulers until new email/SMS/booking services and their recipients are ready.

## Work still needed before the application goes live

Super Admin email confirmed by the user: `kaliganjtravels@gmail.com`.
An exact email lookup in the configured new Clerk instance on 2026-09-11 returned no users.
The owner must first establish their sign-in account in that instance; then assign
`publicMetadata.role = "superadmin"` and mirror the new Clerk user ID into the new database.
No passwordless exception, invitation email, verified-email bypass, or role grant has been created.
This is the intended login identity only; it does not set SMTP sender, BCC or notification recipients.

- Hosted baseline installation and initial REST/RPC checks are complete; full application workflow tests remain pending.
- New Clerk superadmin and user/role setup. No previous Clerk user IDs are imported.
- Published company contact information is populated. Licence and administrative SMS recipients remain unconfigured.
- Application branding, supplier-facing booking contact, email templates and Cloudinary namespace are updated. Real SMTP/SMS delivery and media service verification remain pending.
- Application identity, logo, theme, supplier contact and email/PDF/report branding were updated in the later rebranding step. Remaining service onboarding is listed in the current rebranding notes.
- Configure new branches/payment accounts, markup and service flags. Existing env flags do not override the baseline's database booking/ticketing gates.
- Verify Redis/Cloudinary/Triplover, then email/SMS and any later FirstTrip/TakeOff credentials, before enabling the respective features.
- No old database, repository, deployment or service account was modified by these preparation scripts.
