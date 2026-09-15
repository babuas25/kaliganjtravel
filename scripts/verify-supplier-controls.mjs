import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

function source(...parts) {
  return fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
}

const config = source('lib', 'triplover', 'config.ts');
const envExample = source('.env.example');
const controls = source('lib', 'db', 'supplier-controls.ts');
const cache = source('lib', 'flights', 'search-cache.ts');
const searchRoute = source('app', 'api', 'flights', 'search', 'route.ts');
const prepareRoute = source('app', 'api', 'flights', 'booking', 'prepare', 'route.ts');
const bookingRoute = source('app', 'api', 'flights', 'booking', 'route.ts');
const issueRoute = source('app', 'api', 'flights', 'booking', 'issue', 'route.ts');
const cancelRoute = source('app', 'api', 'flights', 'booking', 'cancel', 'route.ts');
const refreshRoute = source(
  'app',
  'api',
  'flights',
  'booking',
  'refresh-details',
  'route.ts'
);
const pnr = source('lib', 'triplover', 'pnr.ts');
const book = source('lib', 'triplover', 'book.ts');
const ticket = source('lib', 'triplover', 'ticket.ts');
const cancel = source('lib', 'triplover', 'cancel.ts');
const airTicketingDetails = source('lib', 'triplover', 'air-ticketing-details.ts');
const reprice = source('lib', 'triplover', 'reprice.ts');
const fareRules = source('lib', 'triplover', 'fare-rules.ts');
const evidenceRead = source('lib', 'booking-lifecycle', 'supplier-evidence-read.ts');
const deadlineRefresh = source('lib', 'db', 'booking-pnr-refresh.ts');
const migration = source(
  'supabase',
  'migrations',
  '0085_supplier_accounts_and_operational_controls.sql'
);
const triploverAccountMigration = source(
  'supabase',
  'migrations',
  '0141_triplover_supplier_account.sql'
);
const ticketedResolver = source(
  'supabase',
  'migrations',
  '0094_booking_pnr_echoed_transaction_validation.sql'
);

for (const variable of [
  'FIRSTTRIP_SEARCH_BASE_URL',
  'FIRSTTRIP_BASE_URL',
  'FIRSTTRIP_EMAIL',
  'FIRSTTRIP_PASSWORD',
  'TAKEOFF_SEARCH_BASE_URL',
  'TAKEOFF_BASE_URL',
  'TAKEOFF_EMAIL',
  'TAKEOFF_PASSWORD',
  'TRIPLOVER_SEARCH_BASE_URL',
  'TRIPLOVER_BASE_URL',
  'TRIPLOVER_EMAIL',
  'TRIPLOVER_PASSWORD',
]) {
  assert.match(envExample, new RegExp(variable), `${variable} must be documented`);
}
assert.match(config, /process\.env\[`\$\{prefix\}_SEARCH_BASE_URL`\]/);
assert.match(config, /process\.env\[`\$\{prefix\}_BASE_URL`\]/);
assert.match(config, /process\.env\[`\$\{prefix\}_EMAIL`\]/);
assert.match(config, /process\.env\[`\$\{prefix\}_PASSWORD`\]/);
assert.doesNotMatch(config, /TRIPLOVER_SEARCH_BASE_URL|TRIPLOVER_BASE_URL/);
assert.match(config, /\['firsttrip', 'takeoff', 'triplover'\]/);
for (const table of [
  'flight_search_quotes',
  'booking_attempts',
  'flight_bookings',
  'supplier_operational_settings',
  'flight_search_supplier_limits',
  'flight_search_usage_events',
]) {
  assert.match(
    triploverAccountMigration,
    new RegExp(`alter table public\\.${table}`),
    `${table} must accept the direct Triplover account`
  );
}
assert.match(
  triploverAccountMigration,
  /supplier_account in \('firsttrip', 'takeoff', 'triplover'\)/,
  'bound workflow rows must accept the direct Triplover account'
);
assert.match(
  controls,
  /error\.code === 'PGRST205'[\s\S]*supplierControlsTableIsMissing\(error\)[\s\S]*legacyEnvironmentControls\(\)/,
  'legacy flags may be read only before the controls table exists'
);
assert.match(
  controls,
  /bookingEnabled: false[\s\S]*ticketingEnabled: false[\s\S]*source: 'unavailable'/,
  'non-schema database failures must fail closed'
);
assert.match(
  controls,
  /error\.code === '23514'[\s\S]*latest database migrations/,
  'an outdated supplier-account constraint must return an actionable save error'
);

assert.match(
  searchRoute,
  /getSupplierOperationalControls\(\)[\s\S]*isTriploverConfigured\(supplierControls\.activeSupplier\)[\s\S]*searchFlights\([\s\S]*supplierControls\.activeSupplier/,
  'only a new Search may read the active database supplier'
);
assert.match(
  cache,
  /const QUOTE_KEY_PREFIX = 'flight:quote:v4:'/,
  'temporary Search references must use the shared Redis namespace'
);
assert.match(
  cache,
  /a:\s*supplierAccount,[\s\S]*u:\s*uniqueTransId,[\s\S]*e:\s*expiresAt,[\s\S]*r:\s*compactGraph\.refs/,
  'the compact Redis quote payload must persist the supplier account and private references'
);
assert.match(
  cache,
  /deflateRawSync[\s\S]*QUOTE_ENCODING_PREFIX[\s\S]*inflateRawSync/,
  'the immutable quote graph must remain losslessly compressed within the Redis budget'
);
assert.match(
  cache,
  /PTTL', KEYS\[1\][\s\S]*KEYS\[2\][\s\S]*PX', rootTtl/,
  'a RePrice selection must be atomically isolated and bounded by the quote TTL'
);
assert.match(
  cache,
  /supplierAccount: supplierAccount\.trim\(\)\.toLowerCase\(\) as TriploverSupplier/,
  'the authoritative Redis read must hydrate its supplier account'
);
assert.doesNotMatch(
  cache,
  /supabaseAdmin|persist_flight_search_quote_v1|persist_flight_reprice_selection_v1/,
  'temporary Search references must not use Supabase RPCs'
);
assert.match(
  prepareRoute, /supplierAccount: search\.supplierAccount/);
assert.match(
  bookingRoute,
  /SUPPLIER_ACCOUNT_UNAVAILABLE[\s\S]*const supplierAccount = current\.supplier_account[\s\S]*bookFlight\([\s\S]*supplierAccount/,
  'a booking must use the account stored on its attempt, never the active supplier'
);
assert.match(
  reprice,
  /triploverCall\('RePrice',[\s\S]*?\{ supplier: search\.supplierAccount \}/,
  'a RePrice must use the supplier account stored in its search reference'
);
assert.match(
  fareRules,
  /triploverCall\('FareRules',[\s\S]*?\{ supplier: search\.supplierAccount \}/,
  'post-search FareRules must use the supplier account stored in its search reference'
);
assert.match(
  pnr,
  /supplier: TriploverSupplier[\s\S]*supplier === 'takeoff'/,
  'PNR reads and deadline parsing must receive the persisted account explicitly'
);
assert.match(
  airTicketingDetails,
  /supplier: TriploverSupplier[\s\S]*?triploverCall\([\s\S]*?\{ supplier, method: 'GET', topLevelPayload: true(?:, timeoutMs)? \}/,
  'AirTicketingDetails must receive and forward an explicit bound supplier account'
);
assert.match(
  ticket,
  /supplier: TriploverSupplier[\s\S]*?triploverCall\('NewTicket',[\s\S]*?\{ supplier: input\.supplier, lifecycleHooks \}/,
  'NewTicket must use the supplier account supplied by the persisted booking workflow'
);
assert.match(
  cancel,
  /supplier: TriploverSupplier[\s\S]*?triploverCall\('Cancel',[\s\S]*?\{ supplier: input\.supplier, lifecycleHooks \}/,
  'Cancel must use the supplier account supplied by the persisted booking workflow'
);
assert.match(
  issueRoute,
  /const supplierAccount = booking\.supplier_account;[\s\S]*?supplier: supplierAccount[\s\S]*?issueTicket\(supplierInput[\s\S]*?enrichIssuedTicket\([\s\S]*?supplierAccount/,
  'an existing booking must use its persisted supplier account for Issue and its follow-up ticket read'
);
assert.match(
  cancelRoute,
  /const supplierAccount = booking\.supplier_account;[\s\S]*?supplier: supplierAccount[\s\S]*?cancelBooking\(supplierInput[\s\S]*?readAirTicketingDetails\([\s\S]*?supplierAccount[\s\S]*?readPnr\([\s\S]*?supplier: supplierAccount/,
  'an existing booking must use its persisted supplier account for Cancel and reconciliation reads'
);
assert.match(
  refreshRoute,
  /const supplierAccount = booking\.supplier_account;[\s\S]*?readLatestAirTicketingDetails\([\s\S]*?supplierAccount[\s\S]*?readPnr\([\s\S]*?supplier: supplierAccount/,
  'manual supplier-detail refresh must use the booking-bound supplier for every read'
);
assert.match(
  evidenceRead,
  /input\.booking\.supplier_account[\s\S]*?readPnr\([\s\S]*?supplier,[\s\S]*?readAirTicketingDetails\([\s\S]*?supplier\n\s*\)/,
  'reconciliation evidence reads must derive and pass the supplier only from the locked booking'
);
assert.doesNotMatch(
  deadlineRefresh,
  /readPnr|syncPnrDetails/,
  'retired post-Book deadline jobs must not call any supplier account'
);
assert.match(
  ticketedResolver,
  /v_booking\.supplier_account is distinct from 'takeoff'/,
  'the ticketed resolver must scope the manual-ticket profile to the locked booking supplier'
);
for (const [label, boundOperationSource] of [
  ['RePrice', reprice],
  ['FareRules', fareRules],
  ['Book', bookingRoute],
  ['PNR', pnr],
  ['AirTicketingDetails', airTicketingDetails],
  ['NewTicket', ticket],
  ['Cancel', cancel],
  ['Issue route', issueRoute],
  ['Cancel route', cancelRoute],
  ['supplier refresh', refreshRoute],
  ['evidence read', evidenceRead],
  ['deadline refresh', deadlineRefresh],
  ['ticketed resolver', ticketedResolver],
]) {
  assert.doesNotMatch(
    boundOperationSource,
    /activeSupplier|active_supplier/,
    `${label} must not select an existing supplier from the global active supplier`
  );
}
assert.doesNotMatch(
  book,
  /readPnr\(/,
  'the irreversible Book path must not wait for supplier-specific PNR propagation'
);
assert.match(migration, /create table if not exists public\.supplier_operational_settings/);
assert.match(migration, /copy_booking_supplier_account_from_attempt/);
assert.match(migration, /Historical rows are intentionally left NULL/);
assert.match(migration, /check \(not ticketing_enabled or booking_enabled\)/);

// Apply the migration to a minimal disposable PostgreSQL database. This proves
// the dependent lifecycle view keeps its original output order, receives the
// appended supplier account, and the final-booking trigger copies the account
// from an attempt without requiring a production database connection.
const database = new PGlite();
try {
  await database.exec(`
    create role service_role;
    create role anon;
    create role authenticated;
    create table public.flight_search_quotes (id uuid primary key);
    create table public.booking_attempts (
      id uuid primary key,
      created_at timestamptz not null default now()
    );
    create table public.flight_bookings (
      id uuid primary key,
      attempt_id uuid,
      supplier text not null default 'triplover',
      legacy_operational boolean not null default false,
      status text,
      airlines_pnr jsonb,
      ticketing_deadline_at timestamptz,
      operation_kind text,
      created_at timestamptz not null default now()
    );
    create function public.resolve_booking_lifecycle(text, jsonb, timestamptz, text)
    returns text language sql as $function$ select 'on-hold'::text $function$;
    create view public.booking_lifecycle_v with (security_invoker = true) as
    select fb.id, fb.attempt_id, fb.supplier, fb.legacy_operational, fb.status,
      fb.airlines_pnr, fb.ticketing_deadline_at, fb.operation_kind, fb.created_at,
      public.resolve_booking_lifecycle(
        fb.status, fb.airlines_pnr, fb.ticketing_deadline_at, fb.operation_kind
      ) as lifecycle_status
    from public.flight_bookings fb
    where not fb.legacy_operational;
  `);
  await database.exec(migration);
  await database.exec(`
    alter table public.flight_bookings
      add column direct_ticketing boolean not null default false,
      add column import_source text,
      add column pnr text,
      add column booking_code_ref text,
      add column supplier_refs jsonb not null default '{}'::jsonb,
      add column itinerary jsonb not null default '{}'::jsonb,
      add column submission_started_at timestamptz;
    create table public.flight_search_supplier_limits (
      supplier text primary key check (supplier in ('firsttrip', 'takeoff')),
      daily_limit integer,
      version integer not null default 1
    );
    insert into public.flight_search_supplier_limits (supplier, daily_limit)
    values ('firsttrip', null), ('takeoff', null);
    create table public.flight_search_user_controls (
      user_id text primary key,
      search_enabled boolean not null default true,
      daily_limit integer
    );
    create table public.flight_search_daily_counters (
      scope_type text not null,
      scope_key text not null,
      usage_date date not null,
      hit_count integer not null default 0,
      updated_at timestamptz not null default now(),
      primary key (scope_type, scope_key, usage_date)
    );
    create table public.flight_search_usage_events (
      id uuid primary key,
      supplier_account text not null
        check (supplier_account in ('firsttrip', 'takeoff')),
      outcome text,
      http_status integer,
      error_code text,
      completed_at timestamptz,
      supplier_api_hit boolean not null default false
    );
    create table public.booking_pnr_refresh_jobs (
      id uuid primary key default gen_random_uuid(),
      booking_id uuid not null unique,
      carrier_group text not null,
      next_attempt_at timestamptz not null,
      state text not null default 'pending',
      claimed_at timestamptz,
      claimed_by text,
      last_error_code text,
      completed_at timestamptz,
      completion_reason text
    );
    create function public.booking_pnr_refresh_initial_due_at_v1(text, timestamptz)
    returns timestamptz language sql as $function$ select $2 $function$;
  `);
  await database.exec(triploverAccountMigration);
  await database.exec(`
    insert into public.booking_attempts (id, supplier_account)
    values ('00000000-0000-4000-8000-000000000001', 'triplover');
    insert into public.flight_bookings (
      id, attempt_id, supplier, legacy_operational
    ) values (
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
      'triplover', false
    );
  `);
  const copied = await database.query(
    "select supplier_account from public.flight_bookings where id = '00000000-0000-4000-8000-000000000002'"
  );
  assert.equal(copied.rows[0]?.supplier_account, 'triplover');
  const directLimit = await database.query(
    "select daily_limit from public.flight_search_supplier_limits where supplier = 'triplover'"
  );
  assert.equal(directLimit.rows.length, 1, 'direct Triplover must receive a search-limit row');
  const lifecycleColumns = await database.query(`
    select column_name
    from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_lifecycle_v'
    order by ordinal_position
  `);
  assert.equal(
    lifecycleColumns.rows.at(-1)?.column_name,
    'supplier_account',
    'supplier_account must be appended without changing dependent view columns'
  );
  await assert.rejects(
    database.exec(`
      insert into public.supplier_operational_settings (
        id, active_supplier, booking_enabled, ticketing_enabled
      ) values ('triplover', 'takeoff', false, true)
    `),
    /supplier_operational_settings_check/
  );
} finally {
  await database.close();
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      activeSelection: 'database/Super Admin for new searches only',
      workflowBinding: [
        'search cache / RePrice / FareRules',
        'booking attempt / Book',
        'PNR / AirTicketingDetails / NewTicket / Cancel',
        'deadline refresh / reconciliation evidence / resolver',
      ],
      migration: 'applied in disposable PostgreSQL with account-copy trigger',
      legacyFallback: 'only while the database control row/table is absent',
      failClosed: true,
    },
    null,
    2
  )
);
