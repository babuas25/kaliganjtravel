import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const migration = read('supabase', 'migrations', '0138_flight_search_usage_controls.sql');
const reportMigration = read('supabase', 'migrations', '0139_flight_search_actor_routes_and_agencies.sql');
const travelDateMigration = read('supabase', 'migrations', '0140_flight_search_route_travel_dates.sql');
const route = read('app', 'api', 'flights', 'search', 'route.ts');
const page = read('app', '(dashboard)', 'dashboard', 'search-control', 'page.tsx');
const actions = read('app', '(dashboard)', 'dashboard', 'search-control', 'actions.ts');

for (const required of [
  'flight_search_usage_events',
  'flight_search_supplier_limits',
  'flight_search_user_controls',
  'flight_search_daily_counters',
  'claim_flight_search_supplier_hit_v1',
  "timezone('Asia/Dhaka'",
]) {
  assert.ok(migration.includes(required), `Search usage migration is missing ${required}`);
}
assert.match(route, /requestMode: 'stream'[\s\S]*claimFlightSearchSupplierHit/);
assert.match(route, /requestMode: 'json'[\s\S]*claimFlightSearchSupplierHit/);
assert.match(route, /USER_DAILY_LIMIT_REACHED/);
assert.match(route, /SUPPLIER_DAILY_LIMIT_REACHED/);
assert.match(page, /session\.role !== 'superadmin'/);
assert.match(actions, /recordSecurityAuditEvent/);

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create table public.app_users (
    clerk_id text primary key,
    email text,
    first_name text,
    last_name text,
    role text not null default 'customer',
    agency_code text
  );
  create table public.agencies (
    agency_code text primary key,
    owner_user_id text unique
  );
  create table public.user_profiles (
    clerk_id text primary key,
    agency_name text
  );
`);
await db.exec(migration);
await db.exec(reportMigration);
await db.exec(travelDateMigration);
await db.exec(`
  insert into public.app_users (clerk_id,email,first_name,last_name,role,agency_code)
  values ('user_one','one@example.test','One','User','customer',null),
         ('user_two','two@example.test','Two','User','b2b','ST-B2B123456');
  insert into public.agencies (agency_code,owner_user_id)
  values ('ST-B2B123456','user_two');
  insert into public.user_profiles (clerk_id,agency_name)
  values ('user_two','Fly Better Agency');
  update public.flight_search_supplier_limits
     set daily_limit = 2 where supplier = 'takeoff';
  insert into public.flight_search_user_controls (
    user_id,search_enabled,daily_limit
  ) values ('user_one',true,1);
`);

async function event(trace, userId, destination = 'CXB') {
  const result = await db.query(`
    insert into public.flight_search_usage_events (
      trace_id,actor_user_id,actor_key_hash,actor_role,supplier_account,
      request_mode,trip_type,routes,adults,children,infants,cabin_class
    ) values (
      $1,$2,'sha256:${'a'.repeat(64)}','customer','takeoff','json',
      'oneway',jsonb_build_array(jsonb_build_object(
        'origin','DAC','destination',$3::text,'departureDate','2026-09-02'
      )),
      1,0,0,1
    ) returning id
  `, [trace, userId, destination]);
  return result.rows[0].id;
}

async function claim(eventId, userId) {
  const result = await db.query(
    `select * from public.claim_flight_search_supplier_hit_v1($1,'takeoff',$2)`,
    [eventId, userId]
  );
  return result.rows[0];
}

const first = await claim(await event('00000000-0000-0000-0000-000000000001', 'user_one'), 'user_one');
assert.equal(first.allowed, true);
const userBlocked = await claim(await event('00000000-0000-0000-0000-000000000002', 'user_one'), 'user_one');
assert.equal(userBlocked.allowed, false);
assert.equal(userBlocked.result_code, 'USER_DAILY_LIMIT_REACHED');
const secondUser = await claim(await event('00000000-0000-0000-0000-000000000003', 'user_two', 'CGP'), 'user_two');
assert.equal(secondUser.allowed, true);
const supplierBlocked = await claim(await event('00000000-0000-0000-0000-000000000004', null), null);
assert.equal(supplierBlocked.allowed, false);
assert.equal(supplierBlocked.result_code, 'SUPPLIER_DAILY_LIMIT_REACHED');

const totals = await db.query(`
  select * from public.flight_search_usage_totals_v1(
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour'
  )
`);
assert.equal(Number(totals.rows[0].request_count), 4);
assert.equal(Number(totals.rows[0].supplier_api_hit_count), 2);
assert.equal(Number(totals.rows[0].blocked_count), 2);

const actors = await db.query(`
  select * from public.flight_search_usage_by_actor_v2(
    clock_timestamp() - interval '1 hour', clock_timestamp() + interval '1 hour'
  )
`);
const agencyActor = actors.rows.find((row) => row.user_id === 'user_two');
assert.equal(agencyActor.agency_name, 'Fly Better Agency');
assert.equal(Number(agencyActor.distinct_route_count), 1);
assert.deepEqual(agencyActor.searched_routes, [
  {
    route: 'DAC → CGP',
    departureDates: ['2026-09-02'],
    requestCount: 1,
    lastSearchedAt: agencyActor.searched_routes[0].lastSearchedAt,
  },
]);
const customerActor = actors.rows.find((row) => row.user_id === 'user_one');
assert.equal(customerActor.searched_routes[0].route, 'DAC → CXB');
assert.equal(customerActor.searched_routes[0].requestCount, 2);
assert.deepEqual(customerActor.searched_routes[0].departureDates, ['2026-09-02']);

console.log(JSON.stringify({
  checks: 'passed',
  websiteRequests: 4,
  supplierApiHits: 2,
  userDailyLimitEnforced: true,
  supplierDailyLimitEnforced: true,
  agencyNameResolved: true,
  searchedRoutesReported: true,
  routeTravelDatesReported: true,
  timezone: 'Asia/Dhaka',
}));
await db.close();
