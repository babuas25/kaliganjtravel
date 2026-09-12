# Database Architecture

This document provides a comprehensive overview of the ShoponTravels database architecture, including tables, views, functions, relationships, and security considerations.

**See also:** [`DATABASE.md`](../DATABASE.md) - Database operations guide (migration workflow, backup/restore, CLI setup)

## Table of Contents

1. [Database Overview](#database-overview)
2. [Access Model](#access-model)
3. [Migration System](#migration-system)
4. [Key Tables](#key-tables)
5. [Important Views](#important-views)
6. [Key Database Functions and RPCs](#key-database-functions-and-rpcs)
7. [Indexes and Performance](#indexes-and-performance)
8. [Data Relationships and Foreign Keys](#data-relationships-and-foreign-keys)
9. [Security Triggers and Constraints](#security-triggers-and-constraints)

---

## Database Overview

### Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Database Provider | Supabase | - |
| Database Engine | PostgreSQL | 17 |
| REST API Layer | PostgREST | - |
| Project Reference | `gvbovgdjqmskcjgowppa` | - |
| Region | `ap-southeast-1` (Singapore) | - |
| Dashboard | https://supabase.com/dashboard/project/gvbovgdjqmskcjgowppa | - |

### Database Characteristics

- **Server-Only Access**: The browser never queries the database directly. All database access goes through server-side code using the service role key.
- **Row-Level Security (RLS)**: Enabled on all tables with no policies, which denies `anon` and `authenticated` roles outright. Only the service role bypasses RLS.
- **Idempotent Migrations**: All migration files are safe to re-run using `create if not exists`, `create or replace`, and `drop if exists` patterns.
- **Forward-Only Schema**: Migrations are never edited after being pushed. Fixes are done with new migrations.
- **Snake Case Columns**: Database column names are snake_case versions of the app's camelCase field names. `lib/db/profiles.ts` handles the conversion mechanically.

### Time Zone Handling

All timestamps are stored as `timestamptz` (timestamp with time zone). Business operations use the Asia/Dhaka time zone for:
- Booking reference allocation (`STRYYMMDD######`)
- Deposit reference allocation (`STDYYMMDD######`)
- Booking deadline parsing and evaluation

---

## Access Model

### Critical Security Principle

**The browser never queries the database.** This is enforced by:

1. **RLS Enabled, No Policies**: Every table has RLS enabled with zero policies. This denies `anon` and `authenticated` roles completely.
2. **Service Role Only**: Only the server-side Supabase client (using `SUPABASE_SERVICE_ROLE_KEY`) can access the database. This key bypasses RLS.
3. **No Client-Side Imports**: Never import a Supabase client into a `'use client'` file. All database access goes through server actions or server components.
4. **Session-Based Authorization**: Server actions take the user ID from the session, never from the payload. A server action is a public endpoint; trusting a caller-supplied ID would allow anyone to overwrite anyone.

### Key Constraint

> **NEVER** add a `NEXT_PUBLIC_` prefix to `SUPABASE_SERVICE_ROLE_KEY`. This key must remain server-only.

### Authorization Flow

```
User Action
    ↓
Server Action / API Route
    ↓
Session Validation (Clerk)
    ↓
Service Role Client (Supabase)
    ↓
Database (RLS bypassed)
```

### Related Documentation

- [Authentication](03-AUTHENTICATION.md) - Clerk integration and session management
- [Roles and Permissions](04-ROLES-AND-PERMISSIONS.md) - Role-based access control
- [Security](14-SECURITY.md) - Security practices and audit logging

---

## Migration System

### Migration Location

All database migrations are located in [`supabase/migrations/`](../supabase/migrations/). Files are named with a timestamp prefix that determines apply order:

```
0001_users_and_profiles.sql
0002_agencies_and_sub_users.sql
0003_staff_details.sql
...
0036_correct_ambiguous_pnr_deadline_by_booking_time.sql
0037_impexp_booking_imports.sql
0038_impexp_passenger_details.sql
0039_fix_us_bangla_pnr_month_day_deadlines.sql
0040_impexp_wallet_and_sync.sql
```

### Migration Workflow

1. **Create Migration**
   ```bash
   supabase migration new descriptive_name
   ```
   Creates `supabase/migrations/<timestamp>_descriptive_name.sql`

2. **Write SQL** following project rules:
   - Idempotent statements (`create table if not exists`, `create or replace function`)
   - Forward-only (never edit pushed migrations)
   - Enable RLS on every new table with no policies
   - Use snake_case column names
   - Make everything nullable (store blanks as `NULL`, not `''`)
   - Add `updated_at` trigger for tables with `updated_at` column

3. **Check Pending Migrations**
   ```bash
   supabase migration list --linked
   ```

4. **Apply Migration**
   ```bash
   supabase db push --linked
   ```

5. **Verify** against live database using a service role client script

### Migration File Organization

Migrations are organized by domain:

| # | Migration | Domain |
|---|-----------|--------|
| 0001 | Users and Profiles | User management |
| 0002 | Agencies and Sub Users | Agency management |
| 0003 | Staff Details | Staff management |
| 0004 | Upgrade Requests | B2B onboarding |
| 0005 | Document Uploads | File storage |
| 0006-0014 | Markup Rules | Pricing system |
| 0008 | Flight Search Quotes | Search caching |
| 0009 | Flight Bookings | Booking storage |
| 0015-0017 | Booking Architecture | Booking lifecycle |
| 0018 | Security Hardening | Security primitives |
| 0019-0024 | Wallet System | Payment processing |
| 0025-0036 | Booking Refinements | Lifecycle enhancements |
| 0037-0040 | IMP/EXP Imports | Imported booking identity, passenger details, wallet capture, and Sync |

### Common Patterns

#### Updated_at Trigger

Every table with an `updated_at` column uses the shared trigger:

```sql
drop trigger if exists table_name_touch_updated_at on public.table_name;
create trigger table_name_touch_updated_at
  before update on public.table_name
  for each row execute function public.touch_updated_at();
```

The `touch_updated_at()` function is defined in [`0001_users_and_profiles.sql`](../supabase/migrations/0001_users_and_profiles.sql).

#### RLS and Permissions

Standard pattern for every table:

```sql
alter table public.table_name enable row level security;
revoke all on table public.table_name from anon, authenticated;
grant select, insert, update, delete on table public.table_name to service_role;
```

For functions:

```sql
revoke execute on function public.function_name(...)
  from public, anon, authenticated;
grant execute on function public.function_name(...) to service_role;
```

### See Also

[`DATABASE.md`](../DATABASE.md) - Detailed migration workflow, CLI setup, backup/restore procedures

---

## Key Tables

### User and Identity Tables

#### app_users

**Purpose**: One row per person who has opened the dashboard, mirroring Clerk authentication.

**Primary Key**: `clerk_id` (text)

**Key Columns**:
- `clerk_id` - Clerk user ID (primary key)
- `email` - User email
- `first_name`, `last_name` - User name
- `role` - Mirror of Clerk publicMetadata.role (customer, b2b, admin, superadmin, staff)
- `agency_code` - FK to `agencies.agency_code` (nullable, set null on delete)
- `created_at`, `updated_at`, `last_seen_at` - Timestamps

**Indexes**:
- `app_users_role_idx` on `(role)`
- `app_users_email_idx` on `(email)`
- `app_users_agency_code_idx` on `(agency_code, role)`

**Migration**: [`0001_users_and_profiles.sql`](../supabase/migrations/0001_users_and_profiles.sql), [`0002_agencies_and_sub_users.sql`](../supabase/migrations/0002_agencies_and_sub_users.sql)

**Relationships**:
- `user_profiles.clerk_id` → `app_users.clerk_id` (cascade delete)
- `agencies.owner_user_id` → `app_users.clerk_id` (set null on delete)
- `staff_details.user_id` → `app_users.clerk_id` (cascade delete)
- `upgrade_requests.user_id` → `app_users.clerk_id` (cascade delete)

#### user_profiles

**Purpose**: The dashboard profile form with 21 text fields for personal, passport, contact, and business information.

**Primary Key**: `clerk_id` (references `app_users.clerk_id`)

**Key Columns**:
- Personal: `given_name`, `surname`, `gender`, `date_of_birth`, `address`
- Passport: `nationality`, `passport_no`, `passport_expiry`
- Contact: `mobile`, `email`
- Business (B2B): `agency_name`, `agency_address`, `agency_email`, `agency_mobile`, `website`, `facebook_page`
- Bank: `bank_name`, `account_name`, `account_number`, `routing_number`, `swift_code`, `branch_code`

**Notes**:
- Everything is nullable (profile filled in over time)
- Blank inputs stored as `NULL`, never `''`
- Business documents stored in Cloudinary, not database

**Migration**: [`0001_users_and_profiles.sql`](../supabase/migrations/0001_users_and_profiles.sql)

---

### Agency and Staff Tables

#### agencies

**Purpose**: One row per B2B agency with a branded, human-readable code.

**Primary Key**: `agency_code` (text, format `ST-B2B######`)

**Key Columns**:
- `agency_code` - Primary key, validated by check constraint `^ST-B2B[0-9]{6}$`
- `owner_user_id` - FK to `app_users.clerk_id` (nullable, set null on delete)
- `created_at`, `updated_at` - Timestamps

**Constraints**:
- `agency_code` format check
- `owner_user_id` unique (one owner per agency)

**Notes**:
- Agency outlives owner (set null on delete)
- Source of truth for parent-agency relationship
- Provider metadata may mirror `agency_code` for convenience, but database is authoritative

**Migration**: [`0002_agencies_and_sub_users.sql`](../supabase/migrations/0002_agencies_and_sub_users.sql)

#### staff_details

**Purpose**: Employment details for agency sub users, separate from their travel profile.

**Primary Key**: `user_id` (references `app_users.clerk_id`)

**Key Columns**:
- `designation`, `email`, `phone`, `alternative_phone`, `address`, `qualification`
- `created_at`, `updated_at` - Timestamps

**Design Rationale**:
- Separate table from `user_profiles` because:
  - Staff fields never reach profile completion meter
  - Staff record can be deleted without touching passport/bank/login
  - `saveProfileAction` remains strict (only edits session user's own row)
- No `agency_code` column here (use `app_users.agency_code` as authority)

**Migration**: [`0003_staff_details.sql`](../supabase/migrations/0003_staff_details.sql)

---

### B2B Onboarding Tables

#### upgrade_requests

**Purpose**: Customer application to become a B2B partner, and the verdict on it.

**Primary Key**: `user_id` (references `app_users.clerk_id`)

**Key Columns**:
- Business info: `agency_name`, `business_mobile`, `business_email`, `business_address`
- Personal info: `full_name`, `business_type` (proprietor/partner), `personal_mobile`, `personal_address`
- Status: `status` (pending/accepted/rejected)
- Review: `reviewed_by`, `reviewed_at`, `review_note`
- `created_at`, `updated_at` - Timestamps

**Design Rationale**:
- One row per user, not per attempt (rejected requests resubmitted over the top)
- Never decides role (role lives in Clerk and `app_users.role`)
- Separate table to keep application immutable while profile is editable
- Supporting documents stored in Cloudinary

**Migration**: [`0004_upgrade_requests.sql`](../supabase/migrations/0004_upgrade_requests.sql)

---

### Pricing Tables

#### markup_rules

**Purpose**: Private audience/airline/route selling-price rules, including LCC exception.

**Primary Key**: `id` (UUID)

**Key Columns**:
- Target: `audience` (b2c/agency), `agency_code` (nullable), `airline_code`, `origin`, `destination`, `bidirectional`
- Rule: `markup_type` (fixed/percentage), `value`, `active`
- Metadata: `created_by`, `created_at`, `updated_at`

**Constraints**:
- Audience/target check: B2C rules never name an agency; agency rules always do
- Route pair check: Airline-only rules leave route fields empty; route rules need both
- Value check: Percentage capped at 100, fixed amount bounded at 1,000,000
- Unique scope: Coalesced nullable fields to prevent duplicate-looking rules

**Indexes**:
- `markup_rules_scope_unique_idx` on `(audience, coalesce(agency_code,''), airline_code, coalesce(origin,''), coalesce(destination,''), bidirectional)`
- `markup_rules_lookup_idx` on `(audience, agency_code, airline_code, active)`

**Migration**: [`0006_markup_rules.sql`](../supabase/migrations/0006_markup_rules.sql), [`0007_capped_and_lcc_markup.sql`](../supabase/migrations/0007_capped_and_lcc_markup.sql), [`0010-0014`](../supabase/migrations/) (markup enhancements)

**Related**: [Pricing and Markup](06-PRICING-AND-MARKUP.md)

---

### Search and Booking Tables

#### flight_search_quotes

**Purpose**: Private, expiring Triplover Search/RePrice reference chains and pricing snapshots.

**Primary Key**: `id` (UUID, used as `searchId` in app)

**Key Columns**:
- `unique_trans_id` - Supplier transaction identifier
- `itinerary_refs` - JSONB object with supplier references
- `expires_at` - Quote expiry timestamp
- `created_at`, `updated_at` - Timestamps

**Security**:
- RLS enabled with no policies
- Additional revoke on `anon` and `authenticated`
- Only service role may read or mutate supplier references

**Indexes**:
- `flight_search_quotes_expires_at_idx` on `(expires_at)`

**Migration**: [`0008_flight_search_quotes.sql`](../supabase/migrations/0008_flight_search_quotes.sql)

#### flight_bookings

**Purpose**: Durable normal, direct-ticket, and imported booking records with supplier, lifecycle, ownership, and payment outcomes.

**Primary Key**: `id` (UUID)

**Key Columns**:
- Access: `access_token_hash` (SHA-256 hash, unique), `public_ref` (STRYYMMDD######)
- Ownership: `user_id`, `audience` (b2c/agency/superadmin), `agency_code`, `booking_owner_type`, `booking_owner_key`
- Reference: `search_id`, `itinerary_id`, `attempt_id` (FK to `booking_attempts`)
- Status: `status` (on-hold/pending/in-progress/confirmed/cancelled), `lifecycle_status` (computed)
- Pricing: `currency`, `pricing_snapshot`, `supplier_gross_amount`, `user_payable_amount`, `passenger_counts`, `payment_amount`, `captured_amount`, `refunded_amount`
- Supplier: `supplier`, `supplier_refs`, `pnr`, `airlines_pnr`, `booking_code_ref`, `ticket_code_ref`, `ticket_numbers`
- Deadlines: `ticketing_deadline_at`, `deadline_source`, `expires_at`
- Operations: `operation_kind`, `operation_reason`, `operation_request_id`, `operation_actor_user_id`, `operation_started_at`, `operation_prior_status`
- Timestamps: `repriced_at`, `accepted_at`, `submission_started_at`, `issued_at`, `cancelled_at`, `synced_at`
- Legacy: `legacy_operational` (boolean, marks pre-lifecycle rows)
- Import: `import_source`, `imported_by_user_id`, `import_metadata`

**Indexes**:
- `flight_bookings_user_created_idx` on `(user_id, created_at desc)`
- `flight_bookings_status_idx` on `(status, updated_at desc)`
- `flight_bookings_expires_idx` on `(expires_at)`
- `flight_bookings_wallet_account_idx` on `(charged_wallet_account_id, created_at desc)`
- `flight_bookings_owner_idx` on `(booking_owner_type, booking_owner_key, created_at desc)`
- `flight_bookings_active_operation_idx` on `(operation_started_at)` where `status = 'in-progress' and not legacy_operational`
- `flight_bookings_impexp_supplier_reference_key` unique on `(supplier, booking_ref_number)` for `import_source = 'IMP_EXP'`
- `flight_bookings_impexp_created_idx` on imported creation time

**Migration**: [`0009_flight_bookings.sql`](../supabase/migrations/0009_flight_bookings.sql), [`0015_booking_itinerary_snapshot.sql`](../supabase/migrations/0015_booking_itinerary_snapshot.sql), [`0017_booking_lifecycle.sql`](../supabase/migrations/0017_booking_lifecycle.sql), [`0019_wallet_core.sql`](../supabase/migrations/0019_wallet_core.sql), [`0031_booking_lifecycle_authority.sql`](../supabase/migrations/0031_booking_lifecycle_authority.sql), [`0037_impexp_booking_imports.sql`](../supabase/migrations/0037_impexp_booking_imports.sql), [`0038_impexp_passenger_details.sql`](../supabase/migrations/0038_impexp_passenger_details.sql), [`0040_impexp_wallet_and_sync.sql`](../supabase/migrations/0040_impexp_wallet_and_sync.sql)

**Related**: [Booking System](07-BOOKING-SYSTEM.md), [Booking Lifecycle](08-BOOKING-LIFECYCLE.md), [IMP/EXP Imports](17-IMP-EXP-IMPORTS.md)

#### booking_attempts

**Purpose**: Operational layer: one row per fare selection sent to supplier. Audit and recovery only, never a business booking.

**Primary Key**: `id` (UUID)

**Key Columns**:
- Access: `access_token_hash` (SHA-256 hash, unique)
- Ownership: `user_id`, `audience`, `agency_code`
- Supplier: `supplier` (default 'triplover'), `state` (draft/submitting/succeeded/failed/unknown)
- References: `search_id`, `itinerary_id`, `unique_trans_id`, `item_code_ref`, `price_code_ref`, `booking_code_ref`, `pnr`
- Snapshots: `offer_snapshot` (JSONB), `passenger_snapshot` (JSONB, cleared on success)
- Timing: `expires_at`, `submitted_at`, `resolved_at`
- Error: `error_code`, `supplier_message`, `warnings`

**Indexes**:
- `booking_attempts_user_created_idx` on `(user_id, created_at desc)`
- `booking_attempts_state_idx` on `(state, updated_at desc)`
- `booking_attempts_in_flight_idx` on `(submitted_at)` where `state = 'submitting'` (orphan sweep)
- `booking_attempts_unique_trans_idx` on `(unique_trans_id)` (reconciliation)

**Migration**: [`0016_booking_attempts.sql`](../supabase/migrations/0016_booking_attempts.sql)

---

### Booking Lifecycle Tables

#### booking_ref_counters

**Purpose**: One row per Dhaka day holding the last public booking reference issued.

**Primary Key**: `ref_date` (date)

**Key Columns**:
- `ref_date` - Date in Asia/Dhaka timezone
- `last_value` - Last issued counter value (0-999999)
- `updated_at` - Timestamp

**Functions**:
- `allocate_booking_ref_for(p_date)` - Allocate reference for specific date
- `allocate_booking_ref()` - Allocate reference for current Dhaka date

**Migration**: [`0017_booking_lifecycle.sql`](../supabase/migrations/0017_booking_lifecycle.sql)

#### booking_status_events

**Purpose**: Append-only, occurrence-aware audit trail of booking lifecycle and
material financial outcomes.

**Primary Key**: `id` (bigserial, generated always as identity)

**Key Columns**:
- `booking_id` - FK to `flight_bookings.id`
- Status: `from_lifecycle_status`, `to_lifecycle_status`, `stored_status_before`, `stored_status_after`
- Operation: `operation_kind`, `operation_reason`, `actor_user_id`
- Supplier: `supplier_operation`, `supplier_evidence` (JSONB)
- Idempotency/provenance: `idempotency_key`, `operation_id`,
  `reconciliation_case_id`, `occurrence_id`, `occurrence_number`
- Time semantics: `effective_at` (authoritative business time), `observed_at`
  (local observation time), and `created_at` (persistence time)
- `event_snapshot`, `event_version` - immutable render-safe notification facts

**Lifecycle Statuses**: on-hold, pending, in-progress, confirmed, expired, unconfirmed, cancelled

**Indexes**:
- `booking_status_events_idempotency_idx` on `(booking_id, idempotency_key, to_lifecycle_status)` where `idempotency_key is not null`
- `booking_status_events_booking_created_idx` on `(booking_id, created_at desc)`

**Migration**: [`0031_booking_lifecycle_authority.sql`](../supabase/migrations/0031_booking_lifecycle_authority.sql)

**Related**: [Booking Lifecycle](08-BOOKING-LIFECYCLE.md)

#### booking_operations

**Purpose**: Durable identity and state for ticketing, cancellation, and imported
manual-ticket work, independent of the seven public statuses.

Each row binds a unique request key/payload hash, actor/source, prior state,
supplier operation/identities/evidence, policy version, claim/call/response/due/
reconciliation/completion times, and terminal error. A partial unique index
allows only one unresolved operation per booking. Ambiguous supplier writes end
in `needs_reconciliation` and are not replayed.

#### booking_reconciliation_cases and booking_reconciliation_observations

**Purpose**: Own uncertainty for exactly one booking or booking attempt.

Cases persist type/state, opening provenance, Support/Accounts/Admin ownership,
SLA/escalation, normalized evidence references, proposal hash/version,
maker/checker identities, exact financial disposition, and immutable resolution
metadata. Partial unique indexes permit only one unresolved case per subject and
case type. Observations are append-only, request/payload-hash idempotent, bound to
the case/subject/supplier identity, and store protected raw-payload hashes plus
normalized facts instead of exposing raw passenger evidence.

#### booking_notification_outbox and booking_notification_deliveries

**Purpose**: Transactional, occurrence-based customer notification delivery.

Each lifecycle event creates one outbox intent in the same transaction. The row
stores a render-safe event snapshot, send/grace/suppress policy, availability,
supersession, bounded attempts, claim state, and dead-letter/escalation facts.
Recipient rows are expanded once, normalize/hash the address, mark fixed BCC as
hidden envelope-only delivery, and retry failed recipients independently without
resending successful recipients. Legacy `booking_status_email_deliveries` remains
only for rolling compatibility and is not the new idempotency authority.

#### booking_lifecycle_worker_runs and impexp_import_charge_authorizations

Worker runs persist PII-free expiry sweep cursor, counts, stop reason, timing,
and outcome so keyset batches are observable without a global starvation-prone
watermark. Direct confirmed Import & Charge authorizations are five-minute,
one-use, payload/owner/amount/supplier-bound records; they contain hashes and
normalized identities, never raw passenger payloads.

**Migrations**: `0043`–`0082`

---

### Wallet Tables

#### wallets

**Purpose**: Wallet ownership records for users and agencies.

**Primary Key**: `id` (UUID)

**Key Columns**:
- `owner_type` - 'user' or 'agency'
- `owner_key` - Clerk user ID or agencies.agency_code (durable external key, not FK)
- `status` - 'active' or 'frozen'
- `frozen_at`, `frozen_by`, `freeze_reason` - Freeze details
- `created_at`, `updated_at` - Timestamps

**Unique Constraint**: `(owner_type, owner_key)`

**Notes**:
- `owner_key` intentionally not a foreign key so financial history survives deletion or replacement of identity provider record

**Migration**: [`0019_wallet_core.sql`](../supabase/migrations/0019_wallet_core.sql)

**Related**: [Wallet System](10-WALLET-SYSTEM.md)

#### wallet_accounts

**Purpose**: Currency-specific accounts within a wallet.

**Primary Key**: `id` (UUID)

**Key Columns**:
- `wallet_id` - FK to `wallets.id` (restrict on delete)
- `currency` - 3-letter ISO currency code
- `available_balance` - Available funds in minor units (non-negative)
- `hold_balance` - Reserved/hold funds in minor units (non-negative)
- `created_at`, `updated_at` - Timestamps

**Unique Constraint**: `(wallet_id, currency)`

**Indexes**:
- `wallet_accounts_wallet_idx` on `(wallet_id, currency)`

**Migration**: [`0019_wallet_core.sql`](../supabase/migrations/0019_wallet_core.sql)

#### wallet_ledger_entries

**Purpose**: Immutable audit trail of all wallet balance changes.

**Primary Key**: `id` (UUID)

**Key Columns**:
- `wallet_account_id` - FK to `wallet_accounts.id` (restrict on delete)
- `transaction_type` - deposit, booking_hold, booking_confirm, hold_release, refund, manual_credit, manual_debit, adjustment, reversal
- `amount` - Transaction amount in minor units (positive)
- `currency` - 3-letter ISO currency code
- Balances: `available_before`, `available_after`, `hold_before`, `hold_after`
- References: `booking_id`, `deposit_request_id`, `adjustment_request_id`
- Metadata: `related_entity_type`, `related_entity_id`, `created_by_user_id`, `remarks`
- `created_at` - Timestamp

**Security**:
- Immutable: trigger prevents updates and deletes
- Foreign key restrict on delete prevents orphaned ledger entries

**Migration**: [`0019_wallet_core.sql`](../supabase/migrations/0019_wallet_core.sql)

#### wallet_reservations

**Purpose**: Temporary holds on wallet funds for booking operations.

**Primary Key**: `id` (UUID)

**Key Columns**:
- `wallet_account_id` - FK to `wallet_accounts.id` (restrict on delete)
- `booking_id` - FK to `flight_bookings.id` (restrict on delete, nullable)
- `booking_attempt_id` - FK to `booking_attempts.id` (restrict on delete, nullable)
- `amount` - Reserved amount in minor units (positive)
- `currency` - 3-letter ISO currency code
- `state` - active, captured, released, reconciliation
- `cycle` - Retry cycle number (positive, default 1)
- Actors: `requested_by_user_id`, `issued_by_user_id`
- Timing: `supplier_call_started_at`, `captured_at`, `released_at`, `reconciliation_at`
- Reasons: `reconciliation_reason`, `release_reason`
- `created_at`, `updated_at` - Timestamps

**Constraint**: Exactly one of `booking_id` or `booking_attempt_id` must be non-null

**Indexes**:
- `wallet_reservations_booking_key` on `(booking_id)` where `booking_id is not null` (unique)
- `wallet_reservations_attempt_key` on `(booking_attempt_id)` where `booking_attempt_id is not null` (unique)
- `wallet_reservations_state_idx` on `(state, updated_at desc)`

**Migration**: [`0019_wallet_core.sql`](../supabase/migrations/0019_wallet_core.sql)

#### superadmin_booking_decisions

**Purpose**: Immutable audit record for the one-step Super Admin booking
decision override.

**Key Columns**:

- `booking_id`, unique `request_key`, `actor_user_id`, fixed
  `actor_role = 'superadmin'`, and selected `decision`
- optional `note`
- immutable `request_snapshot`, authoritative reservation/ledger
  `accounting_snapshot`, and atomic `result`

The associated classifier and executor use booking → operation → case →
reservation → wallet → account locking. `payment_state` is recorded as a stale
signal but never independently authorizes charge, capture, release, or refund.
An immutable trigger rejects update/delete and service-role-only grants protect
the table/functions.

`0107_superadmin_issue_resolution.sql` adds the scoped V2 Issue Now resolver,
immutable `superadmin_manual_financial_resolutions`, immutable
`superadmin_booking_deadline_overrides`, distinct `superadmin_resolution_*`
ledger types, and booking pointers to the active Super Admin deadline and last
manual resolution. Supplier/customer amounts and Available/Hold before/after
snapshots are stored separately. Retained historical rows keep
`legacy_operational=true` and remain outside normal lifecycle views/workers.

**Migrations**: [`0106_superadmin_booking_decisions.sql`](../supabase/migrations/0106_superadmin_booking_decisions.sql), [`0107_superadmin_issue_resolution.sql`](../supabase/migrations/0107_superadmin_issue_resolution.sql)

#### wallet_deposit_requests

**Purpose**: Deposit request workflow with method-specific fields and approval process.

**Primary Key**: `id` (UUID)

**Key Columns**:
- `wallet_account_id` - FK to `wallet_accounts.id` (restrict on delete)
- `public_ref` - Customer-facing reference (STDYYMMDD######, immutable)
- Amount: `amount`, `currency`
- Method: `method` (cash, bank, bank_transfer, mobile, cheque)
- Method-specific fields:
  - Cash: `branch_id`, `received_by_user_id`
  - Bank: `company_bank_account_id`, `deposit_date`, `reference_number`, `attachment`
  - Bank Transfer: `company_bank_account_id`, `user_bank_account` (JSONB), `deposit_date`, `reference_number`, `attachment`
  - Mobile: `mfs_provider`, `mfs_account_id`, `mfs_payment_type`, `deposit_date`, `reference_number`, `gateway_fee_bps`, `gross_amount`, `attachment`
  - Cheque: `cheque_issued_date`, `cheque_issued_bank`, `payment_date`, `company_bank_account_id`, `reference_number`, `attachment`
- Status: `status` (pending, approved, rejected)
- Review: `reviewed_by_user_id`, `review_remarks`, `reviewed_at`
- `ledger_entry_id` - FK to `wallet_ledger_entries.id` (restrict on delete)
- `requested_by_user_id`, `requested_at`, `updated_at` - Timestamps

**Indexes**:
- `wallet_deposit_queue_idx` on `(status, requested_at desc)`
- `wallet_deposit_requests_public_ref_key` on `(public_ref)` (unique)

**Migration**: [`0019_wallet_core.sql`](../supabase/migrations/0019_wallet_core.sql), [`0022_deposit_public_references.sql`](../supabase/migrations/0022_deposit_public_references.sql), [`0023_deposit_channels.sql`](../supabase/migrations/0023_deposit_channels.sql), [`0024_bank_transfer_deposits.sql`](../supabase/migrations/0024_bank_transfer_deposits.sql)

#### wallet_adjustment_requests

**Purpose**: Maker-checker adjustment workflow for manual credits/debits.

**Primary Key**: `id` (UUID)

**Key Columns**:
- `wallet_account_id` - FK to `wallet_accounts.id` (restrict on delete)
- `adjustment_type` - credit or debit
- `amount`, `currency`
- `reason` - Text (1-1000 characters)
- Status: `status` (pending, approved, rejected)
- Request: `requested_by_user_id`, `requested_by_role`, `requested_at`
- Review: `reviewed_by_user_id`, `review_remarks`, `reviewed_at`
- `ledger_entry_id` - FK to `wallet_ledger_entries.id` (restrict on delete)
- `updated_at` - Timestamp

**Indexes**:
- `wallet_adjustment_queue_idx` on `(status, requested_at desc)`

**Migration**: [`0019_wallet_core.sql`](../supabase/migrations/0019_wallet_core.sql)

#### deposit_ref_counters

**Purpose**: One row per Dhaka day holding the last deposit reference issued.

**Primary Key**: `ref_date` (date)

**Key Columns**:
- `ref_date` - Date in Asia/Dhaka timezone
- `last_value` - Last issued counter value (0-999999)
- `updated_at` - Timestamp

**Functions**:
- `allocate_deposit_ref_for(p_date)` - Allocate reference for specific date
- `allocate_deposit_ref()` - Allocate reference for current Dhaka date

**Migration**: [`0022_deposit_public_references.sql`](../supabase/migrations/0022_deposit_public_references.sql)

---

### Security Tables

#### security_rate_limits

**Purpose**: Deployment-wide rate limiting for security-sensitive operations.

**Primary Key**: `key` (text, 1-512 characters)

**Key Columns**:
- `key` - Rate limit key (e.g., IP address, user ID)
- `count` - Current count (>= 1)
- `reset_at` - Window reset timestamp
- `updated_at` - Timestamp

**Function**:
- `consume_security_rate_limit(p_key, p_limit, p_window_ms)` - Atomically consumes one allowance and returns retry window

**Migration**: [`0018_security_hardening.sql`](../supabase/migrations/0018_security_hardening.sql)

#### security_operation_locks

**Purpose**: Cross-instance locks for privileged identity mutations.

**Primary Key**: `name` (text, 1-100 characters)

**Key Columns**:
- `name` - Lock name
- `holder` - UUID of lock holder
- `locked_until` - Lease expiration
- `updated_at` - Timestamp

**Functions**:
- `try_acquire_security_lock(p_name, p_holder, p_lease_seconds)` - Try to acquire lock
- `release_security_lock(p_name, p_holder)` - Release lock

**Migration**: [`0018_security_hardening.sql`](../supabase/migrations/0018_security_hardening.sql)

#### security_audit_events

**Purpose**: Append-only server-side trail of privileged identity and sensitive-data operations.

**Primary Key**: `id` (UUID)

**Key Columns**:
- `actor_user_id` - User ID who performed action (1-255 characters)
- `actor_role` - Role of actor (1-50 characters)
- `action` - Action performed (1-100 characters)
- `target_type` - Type of target (1-50 characters)
- `target_id` - ID of target (nullable, <= 512 characters)
- `outcome` - attempted, succeeded, failed, denied
- `metadata` - JSONB object with additional context
- `created_at` - Timestamp

**Indexes**:
- `security_audit_events_actor_created_idx` on `(actor_user_id, created_at desc)`
- `security_audit_events_target_created_idx` on `(target_type, target_id, created_at desc)`

**Migration**: [`0018_security_hardening.sql`](../supabase/migrations/0018_security_hardening.sql)

**Related**: [Security](14-SECURITY.md)

---

## Important Views

### booking_lifecycle_v

**Purpose**: Computed view that adds `lifecycle_status` to flight bookings.

**Definition**:
```sql
create or replace view public.booking_lifecycle_v
with (security_invoker = true)
as
select
  fb.*,
  public.resolve_booking_lifecycle(
    fb.status, fb.airlines_pnr, fb.ticketing_deadline_at, fb.operation_kind
  ) as lifecycle_status
from public.flight_bookings fb
where not fb.legacy_operational;
```

**Key Features**:
- Uses `resolve_booking_lifecycle()` function to compute lifecycle status
- Excludes legacy operational rows (`legacy_operational = false`)
- Security invoker ensures RLS is respected

**Lifecycle Statuses**:
- `cancelled` - Booking cancelled
- `confirmed` - Booking confirmed and ticketed
- `in-progress` - Operation in progress (has operation_kind)
- `pending` - Pending processing
- `unconfirmed` - On-hold but no airline PNR
- `expired` - On-hold but deadline passed
- `on-hold` - Default on-hold state

**Migration**: [`0031_booking_lifecycle_authority.sql`](../supabase/migrations/0031_booking_lifecycle_authority.sql)

Migration [`0040_impexp_wallet_and_sync.sql`](../supabase/migrations/0040_impexp_wallet_and_sync.sql)
rebuilds this `fb.*` view after adding imported pricing columns so canonical
reads expose `supplier_gross_amount` and `user_payable_amount`.

**Related**: [Booking Lifecycle](08-BOOKING-LIFECYCLE.md)

### Lifecycle staff and metrics views

- `booking_lifecycle_staff_v` — one staff row per booking with current operation,
  primary open case, reservation, evidence freshness, SLA, and conflict flags;
  excludes passenger/contact/raw evidence/proposal/recipient data.
- `booking_lifecycle_timestamps_v` — exact independently stored submission,
  claim, supplier call/response, case, event effective/observed, terminal,
  deadline, and completion timestamps; unknown facts stay `NULL`.
- `booking_lifecycle_metrics_v` — open case, aged operation/attempt, SLA,
  terminal-conflict, and wallet-inconsistency counts/oldest timestamps.
- `booking_notification_metrics_v` — pending/processing/retry/dead-letter,
  suppression, and delivery health without addresses.
- `booking_derived_lifecycle_metrics_v` — due-expiry backlog/starvation,
  observation latency, sweep-run health, and Unconfirmed repair backlog.

All are `security_invoker` views and are granted only to `service_role`; the
application applies the staff role/capability boundary before serialization.

### booking_payment_report_v

**Purpose**: Payment-focused view joining booking lifecycle with payment state.

**Definition**:
```sql
create or replace view public.booking_payment_report_v
with (security_invoker = true)
as
select
  fb.id as booking_id,
  fb.public_ref,
  fb.booking_owner_type,
  fb.booking_owner_key,
  fb.booked_by_user_id,
  fb.issued_by_user_id,
  fb.charged_wallet_account_id,
  fb.payment_state,
  fb.payment_amount,
  fb.captured_amount,
  fb.refunded_amount,
  fb.currency,
  fb.lifecycle_status as booking_status,
  fb.created_at,
  fb.issued_at
from public.booking_lifecycle_v fb;
```

**Migration**: [`0031_booking_lifecycle_authority.sql`](../supabase/migrations/0031_booking_lifecycle_authority.sql)

Migration [`0040_impexp_wallet_and_sync.sql`](../supabase/migrations/0040_impexp_wallet_and_sync.sql)
rebuilds this dependent view after `booking_lifecycle_v` is recreated.

### wallet_report_v

**Purpose**: Aggregated wallet balances and transaction history (security-restricted).

**Note**: This view has additional security restrictions applied in [`0020_wallet_report_view_security.sql`](../supabase/migrations/0020_wallet_report_view_security.sql).

**Migration**: [`0019_wallet_core.sql`](../supabase/migrations/0019_wallet_core.sql), [`0020_wallet_report_view_security.sql`](../supabase/migrations/0020_wallet_report_view_security.sql)

---

## Key Database Functions and RPCs

### Lifecycle Functions

#### resolve_booking_lifecycle(p_status, p_airlines_pnr, p_ticketing_deadline_at, p_operation_kind)

**Purpose**: Compute the lifecycle status from stored booking data.

**Returns**: text (lifecycle status)

**Logic**:
```sql
select case
  when p_status = 'cancelled' then 'cancelled'
  when p_status = 'confirmed' then 'confirmed'
  when p_status = 'in-progress' or p_operation_kind is not null then 'in-progress'
  when p_status = 'pending' then 'pending'
  when p_status = 'on-hold'
    and not public.jsonb_is_nonempty_array(p_airlines_pnr) then 'unconfirmed'
  when p_status = 'on-hold'
    and p_ticketing_deadline_at is not null
    and p_ticketing_deadline_at <= now() then 'expired'
  else 'on-hold'
end
```

**Migration**: [`0031_booking_lifecycle_authority.sql`](../supabase/migrations/0031_booking_lifecycle_authority.sql)

#### Durable operation and reconciliation RPC families

- Operation claims/finalizers: `claim_booking_operation_identity`,
  `wallet_begin_booking_issue_v2`, `begin_booking_cancellation_v2`, supplier
  call/response markers, atomic success/failure finalizers, and bounded operation
  and attempt watchdogs.
- Evidence/decision: `record_booking_reconciliation_evidence_read_v1`,
  `close_booking_reconciliation_no_change_v1`,
  `record_booking_nonissuance_attestation_v1`,
  `propose_booking_reconciliation_v1`,
  `approve_booking_reconciliation_v1`, and
  `reject_booking_reconciliation_v1`.
- Exact execution: ticketed capture, definitive non-issuance release,
  unpaid/held/captured cancellation variants, terminal Confirmed correction,
  and historical repair. There is no public generic Set Status/Move Money RPC.

Every high-risk execution re-reads the actor role, proposal version/hash, fresh
case-bound evidence, and current booking/payment facts while locking booking →
operation → case → reservation → wallet → currency account. Service role cannot
call the private generic validators/engines.

#### jsonb_is_nonempty_array(p_value)

**Purpose**: Check if a JSONB value is a non-empty array.

**Returns**: boolean

**Migration**: [`0031_booking_lifecycle_authority.sql`](../supabase/migrations/0031_booking_lifecycle_authority.sql)

### Reference Allocation Functions

#### allocate_booking_ref_for(p_date)

**Purpose**: Allocate a booking reference for a specific date.

**Returns**: text (format: STRYYMMDD######)

**Behavior**: Atomic increment of daily counter with conflict handling.

**Migration**: [`0017_booking_lifecycle.sql`](../supabase/migrations/0017_booking_lifecycle.sql)

#### allocate_booking_ref()

**Purpose**: Allocate a booking reference for current Dhaka date.

**Returns**: text (format: STRYYMMDD######)

**Migration**: [`0017_booking_lifecycle.sql`](../supabase/migrations/0017_booking_lifecycle.sql)

#### allocate_deposit_ref_for(p_date)

**Purpose**: Allocate a deposit reference for a specific date.

**Returns**: text (format: STDYYMMDD######)

**Behavior**: Atomic increment of daily counter with capacity check (max 999999).

**Migration**: [`0022_deposit_public_references.sql`](../supabase/migrations/0022_deposit_public_references.sql)

#### allocate_deposit_ref()

**Purpose**: Allocate a deposit reference for current Dhaka date.

**Returns**: text (format: STDYYMMDD######)

**Migration**: [`0022_deposit_public_references.sql`](../supabase/migrations/0022_deposit_public_references.sql)

### Wallet Functions

#### wallet_ensure_account(p_owner_type, p_owner_key, p_currency)

**Purpose**: Ensure a wallet account exists for a given owner and currency, creating it if necessary.

**Returns**: `wallet_accounts` record

**Behavior**:
- Validates owner type and currency
- Creates wallet if doesn't exist (idempotent)
- Creates currency account if doesn't exist (idempotent)
- Returns the account record

**Migration**: [`0019_wallet_core.sql`](../supabase/migrations/0019_wallet_core.sql)

#### wallet_begin_booking_issue(p_booking_id, p_actor_user_id, p_actor_role, p_idempotency_key)

**Purpose**: Atomically validate lifecycle and wallet eligibility, reserve funds, and claim supplier-write slot.

**Returns**: JSONB with operation result

**Migration**: [`0031_booking_lifecycle_authority.sql`](../supabase/migrations/0031_booking_lifecycle_authority.sql)

### Imported Booking Functions

#### create_impexp_booking_v2(..., p_import_decision, p_charge_authorization_id, p_request_key)

**Purpose**: Atomically create or safely re-import a provider/reference booking
with an explicit `import_only` or `import_and_charge` decision.

**Behavior**:
- Requires an eligible assigned B2C/B2B/B2B sub-user and resolves the financial owner
- Requires an existing wallet currency account; does not create/fallback to an operator wallet
- Stores Supplier Gross and User Payable separately in minor units
- Held import creates On Hold/Unpaid without a debit
- Direct confirmed Import Only creates Confirmed/Unpaid plus an Accounts case and no debit
- Direct confirmed Import & Charge consumes a fresh matching one-use authorization and captures User Payable once
- Serializes provider/reference identity and preserves assignment/User Payable on re-import

`authorize_impexp_import_charge_v1` records the prior authorization without a
wallet mutation. The legacy direct-confirmed auto-charge signature is revoked
from `service_role`.

#### wallet_confirm_impexp_booking(p_booking_id, p_actor_user_id, p_idempotency_key)

**Purpose**: Atomically authorize and capture an assigned held import without a supplier Issue Ticket call.

**Behavior**: Locks booking/account, resolves exact owner/shared agency wallet,
validates active status and funds, deducts User Payable, creates the immutable
payment record plus durable manual-ticket operation/Support case/due time, and
changes On Hold/Unpaid to In Progress/Captured.

#### sync_impexp_booking_v2(p_actor_user_id, p_booking_id, p_supplier_gross_amount, p_data)

**Purpose**: Apply authoritative external supplier evidence without a financial mutation.

**Behavior**: Stores a normalized payload-hashed observation and routes the
manual-ticket case. A matching lifecycle can enrich supplier fields; disagreement
cannot overwrite protected lifecycle/ticket/payment truth. It never updates User
Payable, assignment/ownership, payment attribution, wallet balances,
reservations, or ledger rows.

`complete_impexp_manual_ticketing_v1` consumes only fresh complete matching
ticket evidence and completes booking/operation/case/event/outbox without
another debit. `propose_impexp_manual_ticket_financial_v1` and
`execute_impexp_manual_ticket_financial_v1` implement maker-checker negative
outcomes. `process_impexp_manual_ticket_escalations_v1` advances only ownership/
escalation state.

The original compatibility functions are defined in `0040`; protected v2 and
manual-ticket functions are defined in migrations `0062`–`0067`.

The application read projection does not collapse the two imported amounts.
`publicBooking()` uses `supplier_gross_amount` (falling back to snapshot gross)
plus stored supplier fare rows for imported web/PDF/email tickets. Wallet,
ledger, reservation, and payment projections continue to use
`user_payable_amount`. This ticket correction requires no balance update,
backfill, or new migration.

### Security Functions

#### consume_security_rate_limit(p_key, p_limit, p_window_ms)

**Purpose**: Atomically consume one deployment-wide rate limit allowance.

**Returns**: table (allowed boolean, retry_after_seconds integer)

**Behavior**:
- Deletes expired entries (older than 1 day)
- Upserts key with incremented count
- Returns whether allowed and retry window

**Migration**: [`0018_security_hardening.sql`](../supabase/migrations/0018_security_hardening.sql)

#### try_acquire_security_lock(p_name, p_holder, p_lease_seconds)

**Purpose**: Try to acquire a cross-instance lock for privileged operations.

**Returns**: boolean (acquired or not)

**Behavior**:
- Acquires if lock doesn't exist or is expired
- Holder can re-acquire (extend lease)
- Default lease: 60 seconds

**Migration**: [`0018_security_hardening.sql`](../supabase/migrations/0018_security_hardening.sql)

#### release_security_lock(p_name, p_holder)

**Purpose**: Release a security lock.

**Returns**: boolean (released or not)

**Behavior**:
- Only holder can release
- Returns false if lock not found or holder mismatch

**Migration**: [`0018_security_hardening.sql`](../supabase/migrations/0018_security_hardening.sql)

#### enforce_security_retention()

**Purpose**: Clean up expired security-sensitive data.

**Returns**: JSONB with deletion counts

**Behavior**:
- Deletes draft booking attempts older than 7 days
- Deletes failed booking attempts older than 90 days
- Clears passenger snapshots from succeeded/unknown attempts older than 90 days
- Deletes expired rate limit entries
- Deletes expired operation locks

**Migration**: [`0018_security_hardening.sql`](../supabase/migrations/0018_security_hardening.sql)

### Utility Functions

#### touch_updated_at()

**Purpose**: Shared trigger function to update `updated_at` timestamp.

**Returns**: trigger

**Migration**: [`0001_users_and_profiles.sql`](../supabase/migrations/0001_users_and_profiles.sql)

#### parse_triplover_booking_deadline(p_value)

**Purpose**: Parse Triplover booking deadline (DD/MM/YYYY HH24:MI:SS or ISO format) to timestamptz.

**Returns**: timestamptz

**Behavior**:
- Parses DD/MM/YYYY HH24:MI:SS format (production)
- Parses ISO format (fixtures/imports)
- Returns null for empty/invalid input
- Interprets dates in Asia/Dhaka timezone

**Migration**: [`0017_booking_lifecycle.sql`](../supabase/migrations/0017_booking_lifecycle.sql)

---

## Indexes and Performance

### User and Identity Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| `app_users` | `app_users_role_idx` on `(role)` | Filter by role |
| `app_users` | `app_users_email_idx` on `(email)` | Email lookup |
| `app_users` | `app_users_agency_code_idx` on `(agency_code, role)` | Agency member listing |

### Agency Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| `agencies` | Primary key on `agency_code` | Agency lookup |
| `app_users` | `app_users_agency_code_idx` on `(agency_code, role)` | Agency member listing |

### Markup Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| `markup_rules` | `markup_rules_scope_unique_idx` on `(audience, coalesce(agency_code,''), airline_code, coalesce(origin,''), coalesce(destination,''), bidirectional)` | Prevent duplicate rules |
| `markup_rules` | `markup_rules_lookup_idx` on `(audience, agency_code, airline_code, active)` | Rule lookup for pricing |

### Search and Booking Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| `flight_search_quotes` | `flight_search_quotes_expires_at_idx` on `(expires_at)` | Expired quote cleanup |
| `flight_bookings` | `flight_bookings_user_created_idx` on `(user_id, created_at desc)` | User booking history |
| `flight_bookings` | `flight_bookings_status_idx` on `(status, updated_at desc)` | Status-based queries |
| `flight_bookings` | `flight_bookings_expires_idx` on `(expires_at)` | Expired booking cleanup |
| `flight_bookings` | `flight_bookings_wallet_account_idx` on `(charged_wallet_account_id, created_at desc)` | Wallet transaction history |
| `flight_bookings` | `flight_bookings_owner_idx` on `(booking_owner_type, booking_owner_key, created_at desc)` | Owner booking history |
| `flight_bookings` | `flight_bookings_active_operation_idx` on `(operation_started_at)` where `status = 'in-progress'` | Active operation tracking |
| `booking_attempts` | `booking_attempts_user_created_idx` on `(user_id, created_at desc)` | User attempt history |
| `booking_attempts` | `booking_attempts_state_idx` on `(state, updated_at desc)` | State-based queries |
| `booking_attempts` | `booking_attempts_in_flight_idx` on `(submitted_at)` where `state = 'submitting'` | Orphan sweep (in-flight attempts) |
| `booking_attempts` | `booking_attempts_unique_trans_idx` on `(unique_trans_id)` | Supplier reconciliation |

### Lifecycle Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| `booking_status_events` | `booking_status_events_idempotency_idx` on `(booking_id, idempotency_key, to_lifecycle_status)` where `idempotency_key is not null` | Idempotent status transitions |
| `booking_status_events` | `booking_status_events_booking_created_idx` on `(booking_id, created_at desc)` | Booking event history |
| `booking_operations` | one-active-per-booking partial unique index | Prevent overlapping unresolved operations |
| `booking_operations` | claim/call/reconciliation/due indexes | Watchdog and staff queues |
| `booking_reconciliation_cases` | one-open-subject/type partial unique indexes | Deduplicate owned anomaly cases |
| `booking_reconciliation_cases` | state/team/due indexes | Staff queues and SLA escalation |
| `booking_reconciliation_observations` | request identity and case/observed indexes | Idempotent evidence history/freshness |
| `booking_notification_outbox` | state/available and supersession indexes | Bounded claim/retry/coalescing |
| `booking_notification_deliveries` | outbox/address unique and retry indexes | Per-recipient idempotency/retry |
| `flight_bookings` | `flight_bookings_due_expiry_observation_idx` on `(ticketing_deadline_at, id)` with actionable partial predicate | Due-only keyset expiry scan |
| `booking_status_events` | latest lifecycle/expiry latency indexes | Not-yet-observed checks and monitoring |
| `booking_lifecycle_worker_runs` | worker/run-state indexes | Recent run health |

### Wallet Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| `wallets` | `wallets_status_idx` on `(status, updated_at desc)` | Frozen wallet listing |
| `wallet_accounts` | `wallet_accounts_wallet_idx` on `(wallet_id, currency)` | Wallet account lookup |
| `wallet_reservations` | `wallet_reservations_booking_key` on `(booking_id)` where `booking_id is not null` (unique) | Booking reservation lookup |
| `wallet_reservations` | `wallet_reservations_attempt_key` on `(booking_attempt_id)` where `booking_attempt_id is not null` (unique) | Attempt reservation lookup |
| `wallet_reservations` | `wallet_reservations_state_idx` on `(state, updated_at desc)` | State-based queries |
| `wallet_deposit_requests` | `wallet_deposit_queue_idx` on `(status, requested_at desc)` | Pending deposit queue |
| `wallet_deposit_requests` | `wallet_deposit_requests_public_ref_key` on `(public_ref)` (unique) | Public reference lookup |
| `wallet_adjustment_requests` | `wallet_adjustment_queue_idx` on `(status, requested_at desc)` | Pending adjustment queue |

### Security Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| `security_rate_limits` | `security_rate_limits_reset_at_idx` on `(reset_at)` | Expired entry cleanup |
| `security_audit_events` | `security_audit_events_actor_created_idx` on `(actor_user_id, created_at desc)` | Actor audit trail |
| `security_audit_events` | `security_audit_events_target_created_idx` on `(target_type, target_id, created_at desc)` | Target audit trail |

### Performance Considerations

1. **Partial Indexes**: Used frequently for filtered queries (e.g., `where state = 'submitting'`, `where idempotency_key is not null`). These reduce index size and improve write performance.

2. **Composite Indexes**: Used for common query patterns (e.g., `(user_id, created_at desc)` for user history, `(status, updated_at desc)` for status-based listings).

3. **Unique Indexes with Coalesce**: Used in `markup_rules` to handle NULL values correctly in uniqueness constraints (PostgreSQL treats NULLs as distinct in ordinary unique indexes).

4. **Foreign Key Indexes**: PostgreSQL automatically creates indexes for foreign keys. Additional indexes are added for query patterns not covered by FK indexes.

5. **JSONB Indexes**: Not currently used, but `jsonb_typeof()` checks and `->>` operators are used in queries. Consider GIN indexes if JSONB query patterns become complex.

6. **Timestamp Indexes**: All tables with timestamp-based queries have indexes on the relevant timestamp columns (usually `created_at` or `updated_at`).

---

## Data Relationships and Foreign Keys

### Entity Relationship Diagram (Simplified)

```
app_users (clerk_id PK)
    ├── user_profiles (clerk_id FK, cascade)
    ├── staff_details (user_id FK, cascade)
    ├── upgrade_requests (user_id FK, cascade)
    ├── flight_bookings (user_id FK, set null)
    ├── booking_attempts (user_id FK, set null)
    └── agencies (owner_user_id FK, set null)

agencies (agency_code PK)
    ├── app_users (agency_code FK, set null)
    └── markup_rules (agency_code FK, cascade)

wallets (id PK)
    └── wallet_accounts (wallet_id FK, restrict)

wallet_accounts (id PK)
    ├── wallet_ledger_entries (wallet_account_id FK, restrict)
    ├── wallet_reservations (wallet_account_id FK, restrict)
    ├── wallet_deposit_requests (wallet_account_id FK, restrict)
    ├── wallet_adjustment_requests (wallet_account_id FK, restrict)
    └── flight_bookings (charged_wallet_account_id FK, restrict)

flight_bookings (id PK)
    ├── booking_attempts (attempt_id FK, nullable)
    ├── booking_status_events (booking_id FK, restrict)
    └── wallet_reservations (booking_id FK, restrict, nullable)

booking_attempts (id PK)
    ├── flight_bookings (attempt_id FK, nullable)
    └── wallet_reservations (booking_attempt_id FK, restrict, nullable)

flight_search_quotes (id PK)
    └── flight_bookings (search_id FK, not enforced)

booking_ref_counters (ref_date PK)
    └── allocate_booking_ref_for() function

deposit_ref_counters (ref_date PK)
    └── allocate_deposit_ref_for() function
```

### Foreign Key Cascade Rules

| Relationship | On Delete | Rationale |
|--------------|-----------|-----------|
| `user_profiles.clerk_id` → `app_users.clerk_id` | CASCADE | Profile belongs to user, delete with user |
| `staff_details.user_id` → `app_users.clerk_id` | CASCADE | Staff details belong to user, delete with user |
| `upgrade_requests.user_id` → `app_users.clerk_id` | CASCADE | Request belongs to user, delete with user |
| `agencies.owner_user_id` → `app_users.clerk_id` | SET NULL | Agency outlives owner, unowned agency can't be administered |
| `app_users.agency_code` → `agencies.agency_code` | SET NULL | User outlives agency, user becomes agency-less |
| `markup_rules.agency_code` → `agencies.agency_code` | CASCADE | Agency rules deleted with agency |
| `flight_bookings.user_id` → `app_users.clerk_id` | SET NULL | Booking outlives user, keep for audit |
| `booking_attempts.user_id` → `app_users.clerk_id` | SET NULL | Attempt outlives user, keep for audit |
| `wallet_accounts.wallet_id` → `wallets.id` | RESTRICT | Prevent wallet deletion with accounts |
| `wallet_ledger_entries.wallet_account_id` → `wallet_accounts.id` | RESTRICT | Immutable ledger, prevent orphaned entries |
| `wallet_reservations.wallet_account_id` → `wallet_accounts.id` | RESTRICT | Prevent account deletion with active reservations |
| `wallet_deposit_requests.wallet_account_id` → `wallet_accounts.id` | RESTRICT | Prevent account deletion with pending requests |
| `wallet_adjustment_requests.wallet_account_id` → `wallet_accounts.id` | RESTRICT | Prevent account deletion with pending requests |
| `flight_bookings.charged_wallet_account_id` → `wallet_accounts.id` | RESTRICT | Prevent account deletion with charged bookings |
| `wallet_ledger_entries.booking_id` → `flight_bookings.id` | RESTRICT | Prevent booking deletion with ledger entries |
| `wallet_ledger_entries.deposit_request_id` → `wallet_deposit_requests.id` | RESTRICT | Prevent request deletion with ledger entries |
| `wallet_ledger_entries.adjustment_request_id` → `wallet_adjustment_requests.id` | RESTRICT | Prevent request deletion with ledger entries |
| `wallet_reservations.booking_id` → `flight_bookings.id` | RESTRICT | Prevent booking deletion with active reservations |
| `wallet_reservations.booking_attempt_id` → `booking_attempts.id` | RESTRICT | Prevent attempt deletion with active reservations |
| `booking_status_events.booking_id` → `flight_bookings.id` | RESTRICT | Prevent booking deletion with event history |

### Key Design Decisions

1. **SET NULL for User References**: `user_id` on bookings and attempts uses SET NULL so financial and audit records survive user deletion.

2. **RESTRICT for Financial Tables**: All wallet-related foreign keys use RESTRICT to prevent accidental deletion of accounts with history.

3. **CASCADE for Dependent Data**: User profiles, staff details, and upgrade requests cascade with user deletion as they are dependent on the user's existence.

4. **Agency Durability**: `agencies.owner_user_id` uses SET NULL so the agency record survives owner deletion. Sub users and bookings can continue to reference the agency.

5. **Non-FK Owner Keys**: `wallets.owner_key` and `flight_bookings.booking_owner_key` are not foreign keys to ensure financial history survives identity provider replacement.

6. **No FK for search_id**: `flight_bookings.search_id` references `flight_search_quotes.id` but is not enforced as a foreign key because quotes expire and are cleaned up independently.

---

## Security Triggers and Constraints

### Immutable Ledger Trigger

**Function**: `prevent_wallet_ledger_mutation()`

**Purpose**: Prevent updates and deletes on `wallet_ledger_entries`.

**Trigger**: `wallet_ledger_immutable` (before update or delete on `wallet_ledger_entries`)

**Behavior**: Raises exception 'wallet ledger entries are immutable' on any update or delete.

**Migration**: [`0019_wallet_core.sql`](../supabase/migrations/0019_wallet_core.sql)

### Passenger Data Cleanup Trigger

**Function**: `clear_succeeded_attempt_passengers()`

**Purpose**: Clear passenger snapshot from booking attempts when they succeed (data minimization).

**Trigger**: `booking_attempts_clear_succeeded_passengers` (before insert or update on `booking_attempts`)

**Behavior**: Sets `passenger_snapshot` to NULL when `state = 'succeeded'`.

**Migration**: [`0018_security_hardening.sql`](../supabase/migrations/0018_security_hardening.sql)

### Deposit Reference Immutability Trigger

**Function**: `prevent_deposit_public_ref_change()`

**Purpose**: Prevent changes to deposit request public references.

**Trigger**: `wallet_deposit_public_ref_immutable` (before update on `wallet_deposit_requests`)

**Behavior**: Raises exception 'deposit request reference is immutable' if `public_ref` changes.

**Migration**: [`0022_deposit_public_references.sql`](../supabase/migrations/0022_deposit_public_references.sql)

### Wallet Ownership Trigger

**Function**: `set_booking_wallet_ownership()`

**Purpose**: Automatically set booking wallet ownership based on audience and agency/user.

**Trigger**: `flight_bookings_set_wallet_ownership` (before insert or update on `flight_bookings`)

**Behavior**:
- Sets `booked_by_user_id` to `user_id` if not set
- Sets `booking_owner_type` and `booking_owner_key` based on:
  - `agency` audience → `booking_owner_type = 'agency'`, `booking_owner_key = agency_code`
  - `b2c` audience → `booking_owner_type = 'user'`, `booking_owner_key = user_id`

**Migration**: [`0019_wallet_core.sql`](../supabase/migrations/0019_wallet_core.sql)

### Initial Status Event Trigger

**Function**: `record_initial_booking_status_event()`

**Purpose**: Record initial lifecycle status event when booking is created.

**Trigger**: `flight_bookings_initial_status_event` (after insert on `flight_bookings`)

**Behavior**: Inserts into `booking_status_events` with initial lifecycle status and supplier evidence.

**Migration**: [`0031_booking_lifecycle_authority.sql`](../supabase/migrations/0031_booking_lifecycle_authority.sql)

### Check Constraints

#### Markup Rules Constraints

- `markup_rules_audience_target_check`: B2C rules must have NULL agency_code; agency rules must have non-NULL agency_code
- `markup_rules_route_pair_check`: Airline-only rules have NULL origin/destination; route rules have both non-NULL and distinct
- `markup_rules_value_check`: Percentage must be 0-100; fixed amount must be 0-1,000,000

#### Agency Code Constraint

- `agencies.agency_code`: Must match pattern `^ST-B2B[0-9]{6}$`

#### Upgrade Request Constraints

- `upgrade_requests.business_type`: Must be 'proprietor' or 'partner'
- `upgrade_requests.status`: Must be 'pending', 'accepted', or 'rejected'

#### Markup Rule Value Constraints

- `markup_rules.airline_code`: Must match pattern `^[A-Z0-9]{2}$`
- `markup_rules.origin` / `destination`: If not NULL, must match pattern `^[A-Z]{3}$`

#### Booking Status Constraints

- `flight_bookings.status`: Must be 'on-hold', 'pending', 'in-progress', 'confirmed', or 'cancelled'
- `flight_bookings.audience`: Must be 'b2c', 'agency', or 'superadmin'
- `flight_bookings.deadline_source`: Must be 'supplier', 'pnr_call', or 'assumed'

#### Booking Attempt State Constraints

- `booking_attempts.state`: Must be 'draft', 'submitting', 'succeeded', 'failed', or 'unknown'
- `booking_attempts.audience`: Must be 'b2c', 'agency', or 'superadmin'

#### Wallet Constraints

- `wallets.owner_type`: Must be 'user' or 'agency'
- `wallets.status`: Must be 'active' or 'frozen'
- `wallet_accounts.currency`: Must match pattern `^[A-Z]{3}$`
- `wallet_accounts.available_balance`: Must be >= 0
- `wallet_accounts.hold_balance`: Must be >= 0

#### Wallet Ledger Constraints

- `wallet_ledger_entries.transaction_type`: Must be one of: deposit, booking_hold, booking_confirm, hold_release, refund, manual_credit, manual_debit, adjustment, reversal
- `wallet_ledger_entries.amount`: Must be > 0
- `wallet_ledger_entries.currency`: Must match pattern `^[A-Z]{3}$`
- `wallet_ledger_entries.available_before/after`: Must be >= 0
- `wallet_ledger_entries.hold_before/after`: Must be >= 0

#### Wallet Reservation Constraints

- `wallet_reservations.amount`: Must be > 0
- `wallet_reservations.currency`: Must match pattern `^[A-Z]{3}$`
- `wallet_reservations.state`: Must be 'active', 'captured', 'released', or 'reconciliation'
- `wallet_reservations.cycle`: Must be > 0
- `wallet_reservations`: Exactly one of `booking_id` or `booking_attempt_id` must be non-null

#### Deposit Request Constraints

- `wallet_deposit_requests.method`: Must be 'cash', 'bank', 'bank_transfer', 'mobile', or 'cheque'
- `wallet_deposit_requests.status`: Must be 'pending', 'approved', or 'rejected'
- `wallet_deposit_requests.public_ref`: Must match pattern `^STD[0-9]{12}$`
- `wallet_deposit_requests.method` fields: Complex check ensuring all required fields are present for each method

#### Adjustment Request Constraints

- `wallet_adjustment_requests.adjustment_type`: Must be 'credit' or 'debit'
- `wallet_adjustment_requests.status`: Must be 'pending', 'approved', or 'rejected'
- `wallet_adjustment_requests.reason`: Must be 1-1000 characters

#### Booking Lifecycle Constraints

- `flight_bookings.booking_owner_type`: Must be 'user' or 'agency'
- `flight_bookings.payment_state`: Must be 'unpaid', 'held', 'captured', 'released', 'reconciliation', 'partially-refunded', or 'refunded'
- `flight_bookings.captured_amount`: Must be >= 0
- `flight_bookings.refunded_amount`: Must be >= 0 and <= captured_amount
- `flight_bookings.import_source`: NULL or `IMP_EXP`
- `flight_bookings.supplier_gross_amount`: NULL or >= 0 minor units
- `flight_bookings.user_payable_amount`: NULL or > 0 minor units
- Imported payment RPCs require non-NULL protected owner and User Payable data; historical rows missing them require reconciliation
- `flight_bookings.active_operation_id` references `booking_operations`; final
  FK validation is deferred until compatibility cleanup
- New/updated IMP_EXP On Hold rows must be Unpaid with no charged account or
  captured/refunded amount; imported User Payable/currency become immutable
- IMP_EXP reservation/capture ledger amount and currency must equal protected
  User Payable/payment facts
- `booking_operations` permits only named kind/state values and at most one
  unresolved row per booking
- `booking_reconciliation_cases` references exactly one booking or attempt,
  permits named case/state/disposition values, and at most one unresolved case
  per subject/type
- Proposal/approval/resolution structure is enforced by database RPC contracts;
  high-risk maker and checker IDs cannot be the same

#### Booking Status Events Constraints

- `booking_status_events.from_lifecycle_status`: If not NULL, must be one of the seven lifecycle statuses
- `booking_status_events.to_lifecycle_status`: Must be one of the seven lifecycle statuses
- `occurrence_id` is unique; one event/notification intent represents one
  material occurrence, including approved same-status financial outcomes
- `effective_at`, `observed_at`, and persistence time have distinct meanings;
  future inserts always receive `observed_at`

#### Notification Constraints

- One outbox intent per lifecycle event/notification kind
- Outbox state/policy/attempt/suppression/supersession combinations are checked
- Render snapshot status/version must match the event and contains no recipient
  addresses or passport/contact secrets
- One email delivery per outbox/normalized address hash; recipient set becomes
  immutable after expansion; sent recipients are terminal

#### Security Constraints

- `security_rate_limits.key`: Must be 1-512 characters
- `security_rate_limits.count`: Must be >= 1
- `security_operation_locks.name`: Must be 1-100 characters
- `security_audit_events.actor_user_id`: Must be 1-255 characters
- `security_audit_events.actor_role`: Must be 1-50 characters
- `security_audit_events.action`: Must be 1-100 characters
- `security_audit_events.target_type`: Must be 1-50 characters
- `security_audit_events.target_id`: If not NULL, must be <= 512 characters
- `security_audit_events.outcome`: Must be 'attempted', 'succeeded', 'failed', or 'denied'

### RLS and Grant Patterns

All tables follow this security pattern:

```sql
-- Enable RLS
alter table public.table_name enable row level security;

-- Deny browser access
revoke all on table public.table_name from anon, authenticated;

-- Grant service role access
grant select, insert, update, delete on table public.table_name to service_role;
```

Functions follow this pattern:

```sql
-- Deny browser execution
revoke execute on function public.function_name(...)
  from public, anon, authenticated;

-- Grant service role execution
grant execute on function public.function_name(...) to service_role;
```

Views with security invoker:

```sql
create or replace view public.view_name
with (security_invoker = true)
as
-- view definition
```

The `security_invoker` option ensures RLS is checked against the caller's permissions, not the view owner's permissions.

---

## Ticket Management Database Domain

Local forward-only migrations `0119` through `0126` define the independent
Ticket Management request lifecycle, immutable versioned quotations and
decisions, assignment history, passenger/ticket User Payable entitlements,
request-scoped wallet Hold/Capture/Release, dedicated Refund/Reissue/VOID
completion, and transactional notification intents.

The domain remains service-only under RLS. Customer and staff access is through
server read models and guarded RPCs. Financial completion reads the original
booking owner/charged wallet, exact approved quote, active assignment, request
version, and selected entitlement under lock. No final amount or wallet account
is supplied by an API caller.

`ticket_management_notification_outbox` is populated after immutable request
events are inserted. Its `(event_id, audience)` and occurrence-key uniqueness
make intent creation retry-safe. It stores no recipient address and Phase 9 has
no claimant/delivery worker.

These migrations are local repository artifacts only at the Phase 9 review
checkpoint; none was applied to a linked or live database.

## Related Documentation

- [`DATABASE.md`](../DATABASE.md) - Database operations guide (migration workflow, CLI setup, backup/restore)
- [Authentication](03-AUTHENTICATION.md) - Clerk integration and session management
- [Roles and Permissions](04-ROLES-AND-PERMISSIONS.md) - Role-based access control
- [Pricing and Markup](06-PRICING-AND-MARKUP.md) - Markup rules and pricing system
- [Booking System](07-BOOKING-SYSTEM.md) - Booking creation and processing
- [Booking Lifecycle](08-BOOKING-LIFECYCLE.md) - Booking status transitions and state management
- [Wallet System](10-WALLET-SYSTEM.md) - Wallet architecture and payment processing
- [Security](14-SECURITY.md) - Security practices and audit logging
- [IMP/EXP Imports](17-IMP-EXP-IMPORTS.md) - Imported pricing, wallet, lifecycle, and Sync database rules
