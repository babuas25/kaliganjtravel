import { airlinePnrModule } from './helpers/airline-pnr.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (file) => fs.readFileSync(file, 'utf8');
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create extension pgcrypto;
  create function public.touch_updated_at() returns trigger language plpgsql as $$
    begin new.updated_at = now(); return new; end; $$;
  create function public.jsonb_is_nonempty_array(value jsonb) returns boolean
    language sql as $$ select case when jsonb_typeof(value) = 'array'
      then jsonb_array_length(value) > 0 else false end $$;
  create table public.flight_bookings (
    id uuid primary key default gen_random_uuid(), public_ref text default 'STR260906000001',
    supplier text default 'triplover', import_source text, pnr text default 'GDS123',
    booking_ref_number text default 'REF123', airlines_pnr jsonb default '["AIR123"]',
    passengers jsonb default '{"travellers":[{"firstName":"Test","lastName":"Passenger"}]}',
    audience text default 'agency', agency_code text default 'AG1',
    hidden_from_user boolean default false, itinerary jsonb default '{"carrierCode":"BG"}',
    currency text default 'BDT', pricing_snapshot jsonb default '{"grossPrice":1000}',
    synced_at timestamptz, ticketing_deadline_at timestamptz, ticketing_time_limit text, deadline_source text,
    legacy_operational boolean default false, attempt_id uuid,
    status text default 'in-progress', payment_state text default 'held',
    operation_kind text default 'ticketing', operation_reason text,
    direct_ticketing boolean default false, issued_at timestamptz,
    charged_wallet_account_id uuid, payment_amount bigint, captured_amount bigint,
    issued_by_user_id text, booking_status text, ticket_code_ref text, ticket_numbers jsonb,
    warnings jsonb, supplier_message text, operation_request_id text,
    operation_actor_user_id text, operation_started_at timestamptz, operation_prior_status text
  );
  create table public.agencies (agency_code text, owner_user_id text);
  create table public.user_profiles (clerk_id text, agency_mobile text);
  insert into public.agencies values ('AG1', 'owner');
  insert into public.user_profiles values ('owner', '+8801700000000');
  create table public.booking_status_events (
    id bigint generated always as identity primary key, booking_id uuid,
    occurrence_id uuid default gen_random_uuid(), to_lifecycle_status text,
    event_snapshot jsonb default '{}', supplier_operation text,
    from_lifecycle_status text, stored_status_before text, stored_status_after text,
    operation_kind text, operation_reason text, actor_user_id text,
    supplier_evidence jsonb, idempotency_key text unique
  );
  create table public.wallet_accounts (
    id uuid primary key default gen_random_uuid(), available_balance bigint default 9000,
    hold_balance bigint default 1000
  );
  create table public.wallet_reservations (
    id uuid primary key default gen_random_uuid(), booking_id uuid, booking_attempt_id uuid,
    state text default 'held', amount bigint default 1000, currency text default 'BDT',
    wallet_account_id uuid, issued_by_user_id text, captured_at timestamptz,
    reconciliation_at timestamptz, reconciliation_reason text
  );
  create table public.wallet_ledger_entries (
    wallet_account_id uuid, transaction_type text, amount bigint, currency text,
    available_before bigint, available_after bigint, hold_before bigint, hold_after bigint,
    booking_id uuid, booking_reference text, reservation_id uuid, idempotency_key text unique,
    created_by_user_id text, created_by_role text, remarks text
  );
`);
await db.exec(`
  create function public.booking_ticketing_observation_overlap_v1(uuid,jsonb)
    returns uuid language sql as $$ select null::uuid $$;
  create function public.resolve_booking_lifecycle(text,jsonb,timestamptz,text)
    returns text language sql as $$ select $1 $$;
  create function public.record_booking_sync_case_v1(uuid,text,text,text,text,text,jsonb)
    returns void language sql as $$ select $$;
`);
await db.exec(read('supabase/migrations/0148_booking_issued_sms.sql'));
await db.exec(read('supabase/migrations/0154_booking_airline_pnr_integrity.sql'));

const insert = async (extra = '') => (await db.query(
  `insert into public.flight_bookings ${extra || 'default values'} returning id`
)).rows[0].id;
const booking = async (id) => (await db.query('select * from flight_bookings where id=$1', [id])).rows[0];
const refresh = async (id, incoming) => db.query(
  `select record_booking_pnr_refresh_v2($1,'staff','admin','ordinary_sync','Held',$2,null,null,'{}')`,
  [id, JSON.stringify(incoming)]
);
const id = await insert(`(status) values ('on-hold')`);
for (const incoming of [['GDS123'], [' ref123 '], ['GDS123', 'REF123']]) {
  await refresh(id, incoming);
  assert.deepEqual((await booking(id)).airlines_pnr, ['AIR123'], 'Reservation echo must not replace airline locator');
}
await refresh(id, ['NEW123', 'AIR456']);
assert.deepEqual((await booking(id)).airlines_pnr, ['NEW123', 'AIR456'], 'Accept real updates and multiple airlines');
const shared = await insert(`(status,airlines_pnr) values ('on-hold','[]')`);
await refresh(shared, ['GDS123']);
assert.deepEqual((await booking(shared)).airlines_pnr, ['GDS123'], 'Allow a shared GDS/airline locator when no distinct locator exists');
const manual = await insert(`(import_source) values ('MANUAL')`);
await db.query(`update flight_bookings set airlines_pnr='["GDS123"]' where id=$1`, [manual]);
assert.deepEqual((await booking(manual)).airlines_pnr, ['GDS123'], 'Allow explicit manual corrections');

await refresh(id, []);
assert.deepEqual((await booking(id)).airlines_pnr, ['NEW123', 'AIR456']);
await db.query(`update flight_bookings set status='in-progress' where id=$1`, [id]);
const outcome = { pnr: 'GDS123', airlinesPnr: ['BG7890'], bookingStatus: 'Confirmed',
  ticketCodeRef: 'TICKET-REF', ticketNumbers: ['9971234567890'], warnings: [] };
const account = (await db.query('insert into wallet_accounts default values returning id')).rows[0].id;
await db.query('insert into wallet_reservations(booking_id,wallet_account_id) values ($1,$2)', [id, account]);
const capture = async (value) => (await db.query(
  `select wallet_capture_reservation($1,'staff','admin','pnr-test',$2) as result`, [id, value]
)).rows[0].result;
assert.equal((await capture({ ...outcome, ticketNumbers: [] })).ok, false);
assert.equal((await booking(id)).status, 'in-progress');
assert.equal((await capture(outcome)).ok, true);
const sms = async (bookingId) => (await db.query(
  'select content_snapshot from booking_issued_sms_deliveries where booking_id=$1', [bookingId]
)).rows[0].content_snapshot;
assert.equal((await sms(id)).pnr, 'BG7890', 'New locator must be present when event creates SMS');
assert.equal((await sms(id)).pnrType, 'airline');
assert.equal((await booking(id)).pnr, 'GDS123', 'Keep supplier write locator separate');
assert.equal((await capture({ ...outcome, airlinesPnr: ['WRONG1'] })).replay, true);
assert.deepEqual((await booking(id)).airlines_pnr, ['BG7890']);
assert.equal((await db.query('select count(*)::int as n from wallet_ledger_entries')).rows[0].n, 1);
await db.query(`update flight_bookings set airlines_pnr='["LATER1"]' where id=$1`, [id]);
assert.equal((await sms(id)).pnr, 'BG7890', 'Event snapshot stays immutable after later edits');

const legacy = await insert(`(payment_state,operation_reason) values ('captured','legacy_reconciliation')`);
assert.equal((await db.query(`select wallet_finalize_manual_issue($1,'staff','admin',$2) as result`,
  [legacy, outcome])).rows[0].result.ok, true);
assert.equal((await sms(legacy)).pnr, 'BG7890', 'Manual finalization also enriches before snapshot');
const missing = await insert(`(airlines_pnr) values ('[]')`);
await db.query(`insert into booking_status_events(booking_id,to_lifecycle_status) values ($1,'confirmed')`, [missing]);
assert.equal((await sms(missing)).pnr, 'Not available', 'Never substitute the reservation PNR');
const whitespace = await insert(`(airlines_pnr) values ('[" ", "BG2345"]')`);
await db.query(`insert into booking_status_events(booking_id,to_lifecycle_status) values ($1,'confirmed')`, [whitespace]);
assert.equal((await sms(whitespace)).pnr, 'BG2345');
// Historical TakeOff rows in the screenshot contain ["BG"]. Rollout must
// hide that token without silently rewriting their lifecycle/audit history.
const historical = await insert(`(status,airlines_pnr) values ('on-hold','["BG"]')`);
await db.exec(`create table booking_notification_outbox (booking_id uuid, event_snapshot jsonb)`);
const recoverable = await insert(`(status,airlines_pnr) values ('cancelled','["BG"]')`);
const ambiguous = await insert(`(status,airlines_pnr) values ('on-hold','["BG"]')`);
const wrongIdentity = await insert(`(status,airlines_pnr) values ('on-hold','["BG"]')`);
for (const [target, pnrs, identity] of [
  [recoverable, ['WIRPVM'], recoverable],
  [recoverable, ['BG'], recoverable],
  [ambiguous, ['FIRST1'], ambiguous],
  [ambiguous, ['SECOND'], ambiguous],
  [wrongIdentity, ['WRONG1'], recoverable],
]) {
  await db.query('insert into booking_notification_outbox values ($1,$2)', [target, {
    bookingSnapshot: { bookingId: identity, publicRef: 'STR260906000001', airlinesPnr: pnrs },
  }]);
}
await db.exec(read('supabase/migrations/0155_booking_airline_pnr_carrier_code_validation.sql'));
assert.deepEqual((await booking(recoverable)).airlines_pnr, ['WIRPVM']);
assert.equal((await booking(recoverable)).status, 'cancelled');
assert.equal((await booking(recoverable)).pnr, 'GDS123');
assert.deepEqual((await booking(ambiguous)).airlines_pnr, ['BG']);
assert.deepEqual((await booking(wrongIdentity)).airlines_pnr, ['BG']);
assert.equal((await db.query('select count(*)::int as n from booking_issued_sms_deliveries where booking_id=$1', [recoverable])).rows[0].n, 0);

assert.deepEqual((await booking(historical)).airlines_pnr, ['BG']);
assert.deepEqual(airlinePnrModule.airlinePnrs((await booking(historical)).airlines_pnr), []);
const badNew = await insert(`(airlines_pnr) values ('["BG"]')`);
assert.deepEqual((await booking(badNew)).airlines_pnr, []);
const mixedNew = await insert(`(airlines_pnr) values ('["BG", " LVJNCI ", "LVJNCI"]')`);
assert.deepEqual((await booking(mixedNew)).airlines_pnr, ['LVJNCI']);
await db.query(`update flight_bookings set airlines_pnr='["BG"]' where id=$1`, [mixedNew]);
assert.deepEqual((await booking(mixedNew)).airlines_pnr, ['LVJNCI']);
await db.query(`insert into booking_status_events(booking_id,to_lifecycle_status) values ($1,'confirmed')`, [historical]);
assert.equal((await sms(historical)).pnr, 'Not available');
await refresh(historical, ['BG']);
assert.deepEqual((await booking(historical)).airlines_pnr, []);
for (const raw of [null, ['BG'], [' bg ', 'BS', '2A'], [null, 123, '']]) {
  assert.deepEqual(airlinePnrModule.airlinePnrs(raw), []);
}
assert.deepEqual(airlinePnrModule.airlinePnrs(['BG', ' LVJNCI ', 'LVJNCI', 'HZ9P0R']), ['LVJNCI', 'HZ9P0R']);
await db.close();
console.log('Airline PNR integrity, atomic snapshots, financial guards, and replay checks passed.');

// Exercise report enrichment without supplier writes or external requests.
let suppliedReport;
const enrichmentModule = { exports: {} };
const compiled = ts.transpileModule(read('lib/triplover/issued-ticket-enrichment.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('exports', 'require', compiled)(enrichmentModule.exports, (specifier) => {
  if (specifier === 'server-only') return {};
  assert.equal(specifier, '@/lib/triplover/air-ticketing-details');
  return { readAirTicketingDetails: async (...args) => {
    assert.deepEqual(args, ['TX1', 'Confirmed', 'takeoff', 5000]);
    if (suppliedReport instanceof Error) throw suppliedReport;
    return suppliedReport;
  } };
});
const enrich = () => enrichmentModule.exports.enrichIssuedTicket(outcome, 'TX1', 'takeoff');
const validReport = { ...outcome, supplierStatus: 'Confirmed', airlinesPnr: ['BG7890'],
  reconciliationEvidenceV2: { bookingIdentity: { transactionId: 'TX1', identityConflicts: [] } } };
suppliedReport = validReport;
assert.deepEqual((await enrich()).outcome.airlinesPnr, ['BG7890']);
for (const report of [
  new Error('Report temporarily unavailable'),
  { ...validReport, ticketNumbers: ['STALE-TICKET'] },
  { ...validReport, ticketCodeRef: 'OTHER-ISSUE' },
  { ...validReport, supplierStatus: 'Cancelled' },
  { ...validReport, reconciliationEvidenceV2: { bookingIdentity: { transactionId: 'OTHER', identityConflicts: [] } } },
  { ...validReport, reconciliationEvidenceV2: { bookingIdentity: { transactionId: 'TX1', identityConflicts: ['transaction_id_conflict'] } } },
]) {
  suppliedReport = report;
  const result = await enrich();
  assert.deepEqual(result.outcome.ticketNumbers, outcome.ticketNumbers);
  assert.deepEqual(result.outcome.airlinesPnr, []);
  assert.equal(result.ticketDetails, null);
}
console.log('Matching report enrichment, stale/mismatched report rejection and failure fallback passed.');
