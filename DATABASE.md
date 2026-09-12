# Database Guide — Shapon Travels International

Everything a developer needs to change, inspect, back up or restore the database.

Companion to [`projectmap.md`](./projectmap.md), which covers the app itself,
and [`MARKUP.md`](./MARKUP.md), which is the focused pricing-rules guide.

---

## 1. What you are working with

| | |
| --- | --- |
| Provider | Supabase (Postgres 17 + PostgREST) |
| Project ref | `gvbovgdjqmskcjgowppa` |
| Region | `ap-southeast-1` (Singapore) |
| Dashboard | https://supabase.com/dashboard/project/gvbovgdjqmskcjgowppa |
| Migrations | [`supabase/migrations/`](./supabase/migrations) |
| Files | **Not here.** Every uploaded file lives in Cloudinary — see § "Files: Cloudinary" in [`projectmap.md`](./projectmap.md). This database stores handles to them, never bytes and never URLs |
| Applied with | Supabase CLI (`supabase db push`) |

### Tables

| Table | Holds | Key |
| --- | --- | --- |
| `app_users` | One row per person who has opened the dashboard, mirroring Clerk | `clerk_id` |
| `user_profiles` | The dashboard profile form — 21 text fields | `clerk_id` → `app_users` on delete cascade |
| `agencies` | One row per B2B agency: its code and its owner | `agency_code` (`ST-B2B######`) |
| `staff_details` | Employment details for a sub user — separate from their travel profile | `user_id` → `app_users` on delete cascade |
| `upgrade_requests` | A customer's application to become a B2B partner, and the verdict on it | `user_id` → `app_users` on delete cascade |
| `markup_rules` | Private audience/airline/route selling-price rules, including the explicit LCC exception | `id` UUID |
| `flight_search_quotes` | Historical private quote table; retained for migration history, not the active quote authority | `id` UUID (`searchId`) |
| `flight_bookings` | Hold-only traveller drafts, supplier references and Booking outcomes | `id` UUID |

### Access model — read this before writing any query

- **RLS is enabled on every table, with no policies.** That denies `anon` and
  `authenticated` outright. It is not an oversight.
- **Only the server touches Postgres**, using `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS.
  The key is server-only and must never gain a `NEXT_PUBLIC_` prefix.
- **No browser ever queries the database.** If you find yourself importing a Supabase client into a
  `'use client'` file, stop — the pattern here is a server action or a server component.
- **Server actions take the user id from the session, never from the payload.** A server action is a
  public endpoint; trusting a caller-supplied id would let anyone overwrite anyone.

### There was a second, unrelated Supabase project

`.env.local` used to carry a `DATABASE_URL` pointing at `olepyalcftivchcoztdi`, along with
`JWKS_URL`, `JWKS_PUBLIC_KEY`, `FRONTEND_API_URL` and `BACKEND_API_URL`. Nothing in this app ever
read any of them — they were leftovers from another project — and they have been removed.

If you are working from an older copy of `.env.local`, delete those five lines. `DATABASE_URL` in
particular held a live Postgres password for a database this app does not use, so it was pure blast
radius: **rotate that password** if the file was ever shared or synced.

All data and storage live in `gvbovgdjqmskcjgowppa`. Check the project ref before running anything
destructive.

---

## 2. One-time setup

### 2.1 Install the CLI

```bash
npm install -g supabase
```

Confirm it is on your path — this guide was written against **2.109.1**:

```bash
supabase --version
```

### 2.2 Log in and link

```bash
supabase login
supabase link --project-ref gvbovgdjqmskcjgowppa
```

`link` writes `supabase/.temp/` (gitignored). You only do this once per machine.

### 2.3 Known snag: the CLI cannot read `.env.local`

Run any `supabase` command from the project root and it fails **before doing anything**:

```
{"_tag":"Error","error":{"code":"LegacyDbConfigLoadError",
 "message":"failed to parse environment file: .env.local"}}
```

The CLI auto-loads `.env.local`, and that file contains an unquoted multi-line PEM
(`JWKS_PUBLIC_KEY`). Strict dotenv parsers reject a value spanning several lines. Next.js happens to
tolerate it, so nothing else surfaced the problem.

**Fix it once** — wrap the value in double quotes:

```
JWKS_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
MIIB...
-----END PUBLIC KEY-----"
```

**Or work around it** — run the CLI against a directory that has `supabase/` but no `.env.local`:

```bash
supabase db push --linked --workdir /path/to/clean/copy
```

---

## 3. Changing the schema — the everyday loop

### Step 1 — create the migration file

```bash
supabase migration new add_bookings_table
```

Creates `supabase/migrations/<timestamp>_add_bookings_table.sql`. Always let the CLI name it: the
timestamp prefix is the version, and it decides apply order.

### Step 2 — write the SQL

Rules this project follows:

1. **Idempotent.** `create table if not exists`, `create or replace function`,
   `drop trigger if exists` before `create trigger`. A migration you can re-run without fear is a
   migration you can debug.
2. **Forward-only.** Never edit a migration that has been pushed — it is already applied on the
   remote and the CLI tracks it by version. Fix it with a *new* migration.
3. **Enable RLS on every new table**, with no policies unless a browser genuinely needs access:
   ```sql
   alter table public.your_table enable row level security;
   ```
4. **Column names are the snake_case of the app's field names.** `lib/db/profiles.ts` converts
   `dateOfBirth` → `date_of_birth` mechanically, so a mismatched name silently reads as blank
   instead of erroring. Renaming a field in `lib/profile.ts` means renaming the column here.
5. **Everything nullable**, with blanks stored as `NULL` rather than `''`. A profile is filled in
   over time, and `''` fails a `date` column outright.
6. **Add the `updated_at` trigger** to any table with an `updated_at` column:
   ```sql
   drop trigger if exists your_table_touch_updated_at on public.your_table;
   create trigger your_table_touch_updated_at
     before update on public.your_table
     for each row execute function public.touch_updated_at();
   ```
   `touch_updated_at()` already exists — `0001_users_and_profiles.sql` created it.

### Step 3 — check what is pending

```bash
supabase migration list --linked
```

`local` filled and `remote` empty means the migration has not been applied yet:

```json
{"migrations":[{"local":"0001","remote":"","time":"0001"}]}
```

### Step 4 — apply it

```bash
supabase db push --linked
```

Expect:

```
Applying migration 0001_users_and_profiles.sql...
Finished supabase db push.
```

`NOTICE ... does not exist, skipping` lines are normal — that is `drop ... if exists` doing nothing
on a first run.

### Step 5 — verify against the live database

Do not trust "no error" as proof. A short Node script using the service key is the fastest check:

```js
// probe.cjs — run with `node probe.cjs`, then delete it
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const env = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const sb = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

sb.from('app_users')
  .select('*')
  .limit(1)
  .then(({ data, error }) =>
    console.log(error ? `MISSING — ${error.message}` : `EXISTS, ${data.length} row(s)`)
  );
```

> **Trap:** do **not** verify with `.select('*', { head: true })`. PostgREST answers a missing table
> with a bodyless 404, so supabase-js reports *no error* and a `null` count — a missing table looks
> like an empty one. Always use a real `GET`.

---

## 4. Downloading the database (backup)

`supabase db dump` shells out to `pg_dump` **inside a Docker container**. Without Docker you get:

```
{"_tag":"Error","error":{"code":"LegacyDockerRunError",
 "message":"failed to run docker. Docker Desktop is a prerequisite..."}}
```

Neither Docker nor `pg_dump` is installed on this machine today, so pick one route first.

### Route A — Docker (recommended, one toolchain)

Install [Docker Desktop](https://docs.docker.com/desktop), start it, then:

```bash
mkdir -p backups
supabase db dump --linked -f backups/schema.sql
supabase db dump --linked --data-only --use-copy -f backups/data.sql
supabase db dump --linked --role-only -f backups/roles.sql
```

| Flag | Gives you |
| --- | --- |
| *(none)* | Schema only — tables, functions, triggers, RLS |
| `--data-only` | Rows only. Add `--use-copy` for `COPY` instead of `INSERT` (much faster to restore) |
| `--role-only` | Cluster roles |
| `-s public` | Restrict to one schema |
| `-x public.audit_log` | Exclude a table from a data dump |

### Route B — native Postgres client, no Docker

Install the PostgreSQL client tools (they include `pg_dump` and `psql`), then dump straight from the
pooler. Get the connection string from
**Dashboard → Project Settings → Database → Connection string → URI**:

```bash
pg_dump "postgresql://postgres.gvbovgdjqmskcjgowppa:<DB-PASSWORD>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres" \
  --schema-only --schema public -f backups/schema.sql

pg_dump "postgresql://postgres.gvbovgdjqmskcjgowppa:<DB-PASSWORD>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres" \
  --data-only --schema public -f backups/data.sql
```

### Route C — Dashboard, no tooling at all

- **Table Editor → *table* → Export → CSV** for a single table. Fine for a few hundred rows.
- **Database → Backups** for scheduled backups and point-in-time recovery. Note this is a **paid**
  feature; the free tier has no automatic backups, so on the free plan Route A or B *is* your backup.

### Rules for dump files

- **Never commit them.** `backups/` is gitignored. These files contain passport numbers and bank
  account details — treat a dump exactly like the database itself.
- **Never share `--dry-run` output.** `supabase db dump --dry-run` prints the generated script
  including `PGPASSWORD=` for the CLI's temporary login role, in plaintext.

---

## 5. Uploading / restoring a database file

### Restoring a dump

Order matters: roles, then schema, then data.

```bash
psql "postgresql://postgres.gvbovgdjqmskcjgowppa:<DB-PASSWORD>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres" \
  -f backups/schema.sql

psql "postgresql://postgres.gvbovgdjqmskcjgowppa:<DB-PASSWORD>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres" \
  -f backups/data.sql
```

**Restore into a scratch project first.** Verify there, then repeat against the target. A restore
over a live database is not reversible.

### Moving a schema between projects

Never hand-copy DDL. Point the CLI at the source and let it write the migration:

```bash
supabase db pull            # writes a migration matching the linked remote
supabase db push --linked   # apply it to the target
```

### Small one-off SQL

For a quick fix, the [SQL Editor](https://supabase.com/dashboard/project/gvbovgdjqmskcjgowppa/sql/new)
is fine — but anything that changes the schema **must** also land in `supabase/migrations/`, or the
next developer's database will not match yours.

---

## 6. Rolling back

There is no `db pop`. Postgres has no undo.

1. Write a **new** migration that reverses the change (`drop column`, `drop table`).
2. `supabase db push --linked`.

If a migration is recorded as applied but did not really run — or vice versa — repair the history
rather than editing the table by hand:

```bash
supabase migration repair --status reverted <version>
supabase migration repair --status applied  <version>
```

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Could not find the table 'public.x' in the schema cache` | The migration has not been applied | `supabase db push --linked` |
| Same error *right after* a successful push | PostgREST's schema cache is briefly stale | Wait a few seconds, or `notify pgrst, 'reload schema';` in the SQL Editor |
| `LegacyDbConfigLoadError: failed to parse environment file: .env.local` | Unquoted multi-line PEM in `.env.local` | Quote it, or use `--workdir` (§2.3) |
| `LegacyDockerRunError: failed to run docker` | `db dump` needs Docker | Install Docker Desktop, or use Route B (§4) |
| A missing table reports "no error" | Verified with a `HEAD` request | Use a real `GET` (§3, Step 5) |
| `violates foreign key constraint` on `user_profiles` | No matching `app_users` row | `recordUserVisit()` creates it on dashboard load; check that ran first |
| Dashboard renders but `[db] ... failed` logs | Handled degradation, by design | Read the message — the app stays up, the write did not happen |

---

## 8. Current schema

Source of truth:

- [`0001_users_and_profiles.sql`](./supabase/migrations/0001_users_and_profiles.sql)
- [`0002_agencies_and_sub_users.sql`](./supabase/migrations/0002_agencies_and_sub_users.sql)
- [`0003_staff_details.sql`](./supabase/migrations/0003_staff_details.sql)
- [`0004_upgrade_requests.sql`](./supabase/migrations/0004_upgrade_requests.sql)
- [`0005_document_uploads.sql`](./supabase/migrations/0005_document_uploads.sql)
- [`0006_markup_rules.sql`](./supabase/migrations/0006_markup_rules.sql)
- [`0007_capped_and_lcc_markup.sql`](./supabase/migrations/0007_capped_and_lcc_markup.sql)
- [`0008_flight_search_quotes.sql`](./supabase/migrations/0008_flight_search_quotes.sql)
- [`0009_flight_bookings.sql`](./supabase/migrations/0009_flight_bookings.sql)
- [`0010_all_airlines_markup.sql`](./supabase/migrations/0010_all_airlines_markup.sql)
- [`0011_all_airlines_route_markup.sql`](./supabase/migrations/0011_all_airlines_route_markup.sql)
- [`0012_all_b2b_markup_audience.sql`](./supabase/migrations/0012_all_b2b_markup_audience.sql)
- [`0013_negative_markup_discounts.sql`](./supabase/migrations/0013_negative_markup_discounts.sql)
- [`0014_prevent_overlapping_markup_routes.sql`](./supabase/migrations/0014_prevent_overlapping_markup_routes.sql)

The linked remote project was verified synchronized through `0014` on
2026-07-30 with `supabase db push --linked --dry-run`.

### `app_users`

| Column | Type | Notes |
| --- | --- | --- |
| `clerk_id` | `text` | Primary key — the Clerk user id |
| `email` | `text` | Indexed |
| `first_name`, `last_name` | `text` | Mirrored from Clerk |
| `role` | `text` | Indexed. Mirror of Clerk `publicMetadata.role`, default `customer` |
| `created_at`, `updated_at`, `last_seen_at` | `timestamptz` | `updated_at` maintained by trigger |

**Clerk stays authoritative for role.** `app_users.role` is a mirror for listing and filtering, and
is written from Clerk's metadata — deliberately *not* from the session's effective role, so the dev
"View as" switcher can never rewrite someone's real role.

| Column | Type | Notes |
| --- | --- | --- |
| `agency_code` | `text` | → `agencies`, `on delete set null`. Which agency this person belongs to; set for the owner too. Indexed together with `role` |

### `agencies`

One row per B2B agency. **This table, not Clerk metadata, is the authority on who belongs to which
agency** — every sub-user permission check reads it.

| Column | Type | Notes |
| --- | --- | --- |
| `agency_code` | `text` | Primary key. `check (agency_code ~ '^ST-B2B[0-9]{6}$')` — a malformed code cannot be stored, whatever wrote it |
| `owner_user_id` | `text` | Unique, → `app_users`, `on delete set null`. The B2B partner who owns it |
| `created_at`, `updated_at` | `timestamptz` | `updated_at` maintained by trigger |

**The primary key is how uniqueness is enforced.** `lib/db/agencies.ts` inserts a random candidate
and retries on `23505` rather than checking whether a code is free first — a check-then-insert would
let two concurrent requests agree that the same code was free. Do not add an application-level
"is this code taken" query; it would be both slower and wrong.

**An agency outlives its owner**, which is why `owner_user_id` is nullable and clears rather than
cascades: the sub users and (later) the bookings still point at the agency. An agency with no owner
is simply one nobody can administer — the ownership check fails closed on NULL.

### `staff_details`

One row per sub user, holding their place in an agency: `designation`, `email`, `phone`,
`alternative_phone`, `address`, `qualification`. Keyed by `user_id` → `app_users` **on delete
cascade**, so removing an account takes its employment details with it.

**Deliberately not columns on `user_profiles`.** These are employment facts about a person inside an
agency; the profile is that person's own travel identity. Keeping them apart is what lets a staff
record be deleted without touching a passport or bank account, and keeps staff fields out of the
profile completion meter.

**There is no `agency_code` column here on purpose.** Which agency a person belongs to is already
answered by `app_users.agency_code`, and that is the authority. A copy on this table would be a
second answer free to drift from it — listing an agency's staff joins through `app_users` instead.

### `user_profiles`

`clerk_id` (PK, cascades from `app_users`), `created_at`, `updated_at`, plus:

| Group | Columns |
| --- | --- |
| Personal | `given_name`, `surname`, `gender`, `date_of_birth`, `address` |
| Passport | `nationality`, `passport_no`, `passport_expiry` |
| Contact | `mobile`, `email` |
| Business (B2B) | `agency_name`, `agency_address`, `agency_email`, `agency_mobile`, `website`, `facebook_page` |
| Bank | `bank_name`, `account_name`, `account_number`, `routing_number`, `swift_code`, `branch_code` |

| Column | Type | Notes |
| --- | --- | --- |
| `documents` | `jsonb` | The five B2B uploads. Default `{}` |

**`documents` holds Cloudinary handles, not URLs**, keyed by the file field names in
`lib/profile.ts` — `tradeLicense`, `tinCertificate`, `travelAgencyLicense`, `nidCard`, `logo`:

```json
{ "tradeLicense": { "publicId": "shapon/business-docs/user_x/abc", "format": "pdf", "uploadedAt": "..." } }
```

A missing key means never uploaded. `lib/documents.ts` is the contract and drops anything malformed
rather than trusting it, because a bad handle would otherwise reach the URL signer and throw at
render time.

**`jsonb` rather than a column pair per document.** The alternative was
`trade_license_public_id` + `trade_license_format` and so on — ten columns, and a migration every
time a document type is added or renamed. Which documents exist is a product decision that lives in
`lib/profile.ts`; the schema does not need an opinion about it. Nothing is queried *by* document —
they are read as a unit with the row that owns them — so there is no index to lose.

### `upgrade_requests`

One row per customer who has applied to become a B2B partner. Keyed by `user_id` → `app_users` **on
delete cascade**, so removing an account takes its application with it.

| Group | Columns |
| --- | --- |
| Business info | `agency_name`, `business_mobile`, `business_email`, `business_address` |
| Personal info | `full_name`, `business_type`, `personal_mobile`, `personal_address` |
| Attachments | `documents jsonb` — an **array** of Cloudinary handles. Default `[]` |
| Verdict | `status`, `reviewed_by`, `reviewed_at`, `review_note` |

`business_type` carries `check (business_type in ('proprietor', 'partner'))` and `status`
`check (status in ('pending', 'accepted', 'rejected'))`, default `pending`. `status` is indexed —
the roster asks this table exactly one question, "which of these people have something waiting?".

**One row per user, not one per attempt.** Resubmitting after a rejection upserts over the top, which
is what makes that question a primary-key lookup rather than a max-by-date over a history. Keeping
every attempt is a later migration if it is ever wanted.

**The field columns are nullable even though every field is required at submission.** The
requirement is `upgradeBlockedReason()` in `lib/upgrade.ts`, enforced by the server action; a
`not null` here would make a future "save a draft" a migration for no gain today.

**This table never decides anybody's role.** It records that somebody asked and what an admin
answered. Granting `b2b` is still `mirrorUserRole()` plus the Clerk write, and the agency is minted
by `resolveAgency()` on the new partner's next dashboard load. `reviewed_by` is not a foreign key on
purpose — the decision should outlive the admin's account.

**An array, not a map**, unlike `user_profiles.documents`: these are unnamed supporting files — the
applicant attaches whatever they have — rather than five named slots.

**Cloudinary is the store, and these are uploaded as `type: 'authenticated'`.** The default upload
type is readable by anyone holding the URL, with no session and no expiry, which is not a default
that a trade licence or an NID card can have. Reviewers open them through five-minute signed links
minted per view. See `lib/cloudinary.ts` and § "Files: Cloudinary" in
[`projectmap.md`](./projectmap.md).

### `markup_rules`

For the complete pricing flow, rule precedence, formulas, and development
checklist, see [`MARKUP.md`](./MARKUP.md).

Private Super Admin commercial-pricing rules. Each scope is unique across audience/agency, optional
airline, optional route and directionality. `audience = 'b2c'` targets public customers,
`audience = 'b2b'` targets every B2B agency and its sub-users, and both require
`agency_code is null`. Agency-specific rules require a valid agency foreign key. A null
`airline_code` is the all-airlines target and may cover every route or one specific route.

| Group | Columns |
| --- | --- |
| Target | `audience`, `agency_code`, `airline_code`, `origin`, `destination`, `bidirectional` |
| Calculation | `markup_type`, `value`, `lcc_service_margin`, `active` |
| Audit | `created_by`, `created_at`, `updated_at` |

`markup_type` accepts `fixed`, `percentage`, or `margin_share`. Fixed amounts may be from
BDT -1,000,000 through BDT 1,000,000 and percentages from -100 through 100, excluding zero;
negative values are discounts. Margin share is 0 through 100, with two-decimal input precision in
the current UI and server normalization. The `lcc_service_margin` exception
may use only positive fixed or percentage values because LCC supplier payable normally equals
gross and therefore has no supplier-to-gross margin to share.

Normal pricing is capped at gross in application code. `lcc_service_margin = true` is the explicit,
auditable permission to add the rule above safe gross—the greater of calculated gross and supplier
payable—and expose it as a separate fare component. This protects against inconsistent supplier
payloads whose payable value is unexpectedly above calculated gross.
Discounts start from supplier payable and cannot reduce taxes or AIT.
Rule precedence is airline + route, all-airlines + route, airline-wide, then the all-airlines and
all-routes fallback. Within matching B2B rules, a specific-agency rule takes priority over the
all-B2B fallback. Rules never stack. The
`public.prevent_overlapping_markup_routes()` trigger rejects the same directed route and any overlap
involving a bidirectional route within the same audience/agency/airline scope, while still allowing
opposite one-way rules.

The Super Admin builder uses the same `priceOffer()` function as Search and RePrice for its sample
preview. It disables saving incomplete drafts, explains the missing field, normalizes incompatible
values when calculation types change, and turns LCC mode off for non-positive input. These are UX
guards only; `validateMarkupRuleInput()` and the database constraints remain authoritative.

### `flight_search_quotes`

Historical capability store for the Search → RePrice → Booking chain. It remains in Supabase for
migration compatibility, but active searches no longer write or read it. The shared Redis quote
graph (`flight:quote:v4:{<searchId>}`) is the temporary authority; only `booking_attempts` is the
durable handoff before Book.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | Primary key; generated by the application and exposed as opaque `searchId` |
| `unique_trans_id` | `text` | Triplover Search transaction reference; server-only |
| `itinerary_refs` | `jsonb` | Map from our itinerary ids to item/segment refs, pricing context, Search snapshot and optional RePrice snapshot |
| `expires_at` | `timestamptz` | Search capability expires 20 minutes after creation; indexed |
| `created_at`, `updated_at` | `timestamptz` | `updated_at` maintained by trigger |

RLS remains enabled with no browser policies, and table privileges remain explicitly revoked from
`anon` and `authenticated`. Redis Cloud is shared across Vercel instances and retains the private
reference graph only for its absolute quote TTL; no process-memory quote fallback exists. Prepare
copies the verified RePrice references and full public offer snapshot into `booking_attempts`, so
Book does not depend on Redis after Prepare succeeds.

### `flight_bookings`

Private hold-only checkout state. A random access token is returned once to the browser and only its
SHA-256 hash is stored. The row copies the accepted RePrice snapshot and supplier references so
they never need to be accepted from the client.

Statuses are `draft`, `submitting`, `held`, `ticketed`, `failed`, or `unknown`. The transition from
`draft` to `submitting` is a conditional database update before Triplover Book. It is the
idempotency gate: a second request cannot replay the irreversible supplier call. Network,
unparseable-response and upstream-5xx failures become `unknown` and must not be retried.

Traveller/passport data is stored only when submission starts. RLS has no browser policies and
table privileges are revoked from `anon` and `authenticated`. Fares whose RePrice result has
`bookable: false` never receive a draft because Triplover could ticket them immediately; this
application supports Book-and-hold only.

---

## 9. Environment variables

```
NEXT_PUBLIC_SUPABASE_URL     # https://gvbovgdjqmskcjgowppa.supabase.co — safe in the browser
SUPABASE_SERVICE_ROLE_KEY    # secret. Bypasses RLS. Server-only, never NEXT_PUBLIC_
```

Set both in `.env.local` for development **and** in Vercel → Project → Settings → Environment
Variables for production. Without them the app degrades quietly: the profile form reports the
database is unconfigured and the site falls back to its built-in logo.
