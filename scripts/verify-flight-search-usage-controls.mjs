import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const migration = read('supabase', 'migrations', '0138_flight_search_usage_controls.sql');
const reportMigration = read('supabase', 'migrations', '0139_flight_search_actor_routes_and_agencies.sql');
const travelDateMigration = read('supabase', 'migrations', '0140_flight_search_route_travel_dates.sql');
const route = read('app', 'api', 'flights', 'search', 'route.ts');
const page = read('app', '(dashboard)', 'dashboard', 'search-control', 'page.tsx');
const actions = read('app', '(dashboard)', 'dashboard', 'search-control', 'actions.ts');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const compiledUsage = ts.transpileModule(read('lib', 'db', 'flight-search-usage.ts'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

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

// Execute the real registration helper against a REST-shaped adapter backed
// by this migrated PostgreSQL schema. Only transport failures are synthetic.
function registrationHarness({ upsertError, eventError, commitBeforeError = false, eventThrows, removeActorAfterUpsert = false } = {}) {
  const calls = [], logs = [], databaseErrors = [];
  const supabase = {
    from(table) {
      if (table === 'app_users') return {
        async upsert(row, options) {
          calls.push('actor-upsert');
          assert.deepEqual(JSON.parse(JSON.stringify(options)), { onConflict: 'clerk_id', ignoreDuplicates: true });
          if (upsertError) return { error: upsertError };
          await db.query('insert into public.app_users (clerk_id) values ($1) on conflict (clerk_id) do nothing', [row.clerk_id]);
          if (removeActorAfterUpsert) await db.query('delete from public.app_users where clerk_id=$1', [row.clerk_id]);
          return { error: null };
        },
      };
      assert.equal(table, 'flight_search_usage_events');
      return {
        insert(row) { return {
          select(columns) {
            assert.equal(columns, 'id');
            return {
              async maybeSingle() {
                calls.push('event-insert');
                if (eventThrows) throw eventThrows;
                if (eventError && !commitBeforeError) return { data: null, error: eventError };
                const columns = Object.keys(row);
                try {
                  const inserted = await db.query(
                    `insert into public.flight_search_usage_events (${columns.join(',')}) values (${columns.map((_, index) => `$${index + 1}`).join(',')}) returning id`,
                    Object.values(row).map((value) => Array.isArray(value) ? JSON.stringify(value) : value)
                  );
                  return eventError ? { data: null, error: eventError } : { data: inserted.rows[0], error: null };
                } catch (error) {
                  databaseErrors.push(error);
                  return { data: null, error: { code: error.code, message: error.message } };
                }
              },
            };
          },
        }; },
      };
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(compiledUsage, {
    module, exports: module.exports,
    require(id) {
      if (id === 'server-only') return {};
      if (id === 'node:crypto') return require(id);
      if (id === '@/lib/flights/supplier') return { isFlightReadSupplier: (value) => ['takeoff', 'firsttrip', 'triplover', 'shapontravels'].includes(value) };
      if (id === '@/lib/supabase/server') return { supabaseAdmin: () => supabase };
      throw new Error(`Unexpected usage import: ${id}`);
    },
    console: { error: (...args) => logs.push(args) }, process: { env: { NODE_ENV: 'production' } },
  });
  return { ...module.exports, calls, logs, databaseErrors };
}
function registrationInput(actorUserId = 'user_two', overrides = {}) {
  return {
    traceId: require('node:crypto').randomUUID(), actorUserId,
    actorKey: `user:${actorUserId}`, actorRole: 'agency', agencyCode: 'ST-B2B123456',
    supplier: 'takeoff', requestMode: 'json',
    search: { tripType: 'oneway', routes: [{ origin: 'DAC', destination: 'CXB', departureDate: '2026-11-10' }],
      adults: 1, children: 0, infants: 0, childrenAges: [], cabinClass: 1, preferredCarriers: [] },
    ...overrides,
  };
}
const insertFirst = { actorRegistryStrategy: 'insert-first' };
{
  const h = registrationHarness();
  const eventId = await h.beginFlightSearchUsage(registrationInput(), insertFirst);
  assert.ok(eventId);
  assert.deepEqual(h.calls, ['event-insert'], 'an existing agency actor must use one database request');
  const row = (await db.query('select actor_user_id, supplier_api_hit from public.flight_search_usage_events where id=$1', [eventId])).rows[0];
  assert.equal(row.actor_user_id, 'user_two');
  assert.equal(row.supplier_api_hit, false, 'registration never spends a supplier hit');
}
{
  const h = registrationHarness();
  assert.ok(await h.beginFlightSearchUsage(registrationInput('missing_agency_actor'), insertFirst));
  assert.deepEqual(h.calls, ['event-insert', 'actor-upsert', 'event-insert']);
  assert.equal(h.databaseErrors.length, 1);
  assert.equal(h.databaseErrors[0].code, '23503');
  assert.ok(h.databaseErrors[0].message.includes('"flight_search_usage_events_actor_user_id_fkey"'), 'the real migrated FK must match the conservative retry gate');
}
{
  const h = registrationHarness({ upsertError: { code: 'XX001', message: 'registry unavailable' } });
  assert.equal(await h.beginFlightSearchUsage(registrationInput('unrepairable_agency_actor'), insertFirst), null);
  assert.deepEqual(h.calls, ['event-insert', 'actor-upsert']);
  assert.equal(h.logs.length, 1);
  const claim = await h.claimFlightSearchSupplierHit({ eventId: null, supplier: 'takeoff', userId: 'unrepairable_agency_actor' });
  assert.equal(claim.allowed, false, 'a failed registry repair cannot admit production supplier Search');
}
{
  const h = registrationHarness({ removeActorAfterUpsert: true });
  assert.equal(await h.beginFlightSearchUsage(registrationInput('deleted_during_repair'), insertFirst), null);
  assert.deepEqual(h.calls, ['event-insert', 'actor-upsert', 'event-insert'], 'a repeated definitive FK failure is retried only once');
  assert.equal(h.databaseErrors.length, 2);
}
// Preserve legacy defaults and reject the optimization for an internal actor
// or an agency claim without a resolved code.
for (const [options, overrides] of [[undefined, {}], [insertFirst, { actorRole: 'superadmin', agencyCode: null }], [insertFirst, { agencyCode: null }]]) {
  const h = registrationHarness();
  assert.ok(await h.beginFlightSearchUsage(registrationInput('user_two', overrides), options));
  assert.deepEqual(h.calls, ['actor-upsert', 'event-insert']);
}
for (const error of [
  { code: 'READ_NETWORK', message: 'transport outcome unknown' },
  { code: '57014', message: 'request timed out' },
  { code: '23505', message: 'duplicate trace_id' },
  { code: '23503', message: 'violates foreign key constraint "some_other_fk"' },
  { code: '23503', message: 'foreign key failure without confirmed actor constraint' },
  { code: 'PGRST205', message: 'missing usage table' },
]) {
  const h = registrationHarness({ eventError: error });
  assert.equal(await h.beginFlightSearchUsage(registrationInput(), insertFirst), null);
  assert.deepEqual(h.calls, ['event-insert'], 'non-definitive errors never replay usage registration');
  if (error.code === 'PGRST205') assert.equal(h.logs.length, 0, 'missing-schema logging behavior stays unchanged');
}
{
  const request = registrationInput();
  const h = registrationHarness({ eventError: { code: 'READ_NETWORK', message: 'response lost after commit' }, commitBeforeError: true });
  assert.equal(await h.beginFlightSearchUsage(request, insertFirst), null);
  assert.deepEqual(h.calls, ['event-insert']);
  const committed = (await db.query('select count(*)::integer as count from public.flight_search_usage_events where trace_id=$1', [request.traceId])).rows[0];
  assert.equal(committed.count, 1, 'an ambiguous committed event must never be replayed');
}
{
  const h = registrationHarness({ eventThrows: new Error('transport disconnected') });
  await assert.rejects(() => h.beginFlightSearchUsage(registrationInput(), insertFirst), /transport disconnected/);
  assert.deepEqual(h.calls, ['event-insert']);
}

console.log(JSON.stringify({
  checks: 'passed',
  websiteRequests: 4,
  supplierApiHits: 2,
  userDailyLimitEnforced: true,
  supplierDailyLimitEnforced: true,
  agencyNameResolved: true,
  searchedRoutesReported: true,
  routeTravelDatesReported: true,
  agencyRegistrationRoundTripRemoved: true,
  actorForeignKeyRecoveryVerified: true,
  ambiguousRegistrationNeverReplayed: true,
  timezone: 'Asia/Dhaka',
}));
await db.close();
