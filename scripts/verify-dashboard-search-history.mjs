import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';

function source(...parts) {
  return fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
}

const migration = source('supabase', 'migrations', '0113_flight_search_history.sql');
const repository = source('lib', 'db', 'flight-search-history.ts');
const api = source('app', 'api', 'flights', 'search', 'route.ts');
const page = source('app', '(dashboard)', 'dashboard', 'flight-search', 'page.tsx');
const cards = source('components', 'dashboard', 'FlightSearchSuggestions.tsx');

assert.match(migration, /create table if not exists public\.flight_search_history/);
assert.match(migration, /unique \(user_id, search_key\)/);
assert.match(migration, /enable row level security/);
assert.match(migration, /revoke all[\s\S]*from anon, authenticated/);
assert.match(migration, /popular_flight_searches_v1/);
assert.match(migration, /count\(distinct e\.user_id\)[\s\S]*greatest\(p_min_distinct_users, 2\)/);
assert.doesNotMatch(
  migration.match(/returns table \([\s\S]*?\)\nlanguage sql/)?.[0] ?? '',
  /user_id/,
  'the popular-search result must not expose user identity'
);

assert.match(repository, /recordFlightSearch[\s\S]*flight_search_history[\s\S]*onConflict: 'user_id,search_key'/);
assert.match(repository, /getFlightSearchSuggestions[\s\S]*\.eq\('user_id', userId\)[\s\S]*popular_flight_searches_v1/);
assert.match(repository, /popular[\s\S]*Array\.from\(\{ length: children \}, \(\) => 8\)/);
assert.equal(
  [...api.matchAll(/recordFlightSearch\(/g)].length,
  2,
  'both SSE and JSON success paths must record the search'
);
assert.match(page, /getFlightSearchSuggestions\(session\.clerkId\)/);
assert.match(page, /decodeSearchParams\(params\)/);
assert.match(page, /<FlightSearchSuggestions suggestions=\{suggestions\}/);
assert.match(cards, /Recent searches/);
assert.match(cards, /Popular searches/);
assert.match(cards, /\/flights\?\$\{encodeSearchParams\(item\.input\)\}/);
assert.match(cards, /prefetch=\{false\}/, 'Suggestions must not start results navigation before a click');
assert.match(cards, /snap-x snap-mandatory/);

// A persisted usage event proves the user FK exists. The history writer may
// skip the redundant upsert only for that explicitly confirmed caller.
const compiledHistory = ts.transpileModule(repository, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const sampleSearch = {
  tripType: 'oneway',
  routes: [{ origin: 'DAC', destination: 'SIN', departureDate: '2026-10-31' }],
  adults: 1, children: 0, infants: 0, childrenAges: [],
  cabinClass: 1, preferredCarriers: [],
};
for (const [userRegistered, stubFails] of [[false, false], [true, false], [false, true]]) {
  const calls = [];
  const module = { exports: {} };
  const dependencies = {
    'server-only': {},
    'node:crypto': { createHash },
    '@/lib/flights/cabin': { isCabinClassValue: () => true },
    '@/lib/supabase/server': { supabaseAdmin: () => ({
      from: table => ({ upsert: async (payload, options) => {
        calls.push({ table, payload, options });
        return { error: table === 'app_users' && stubFails ? { message: 'fixture failure' } : null };
      } }),
    }) },
  };
  vm.runInNewContext(compiledHistory, {
    module, exports: module.exports,
    require: name => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected history import ${name}`);
      return dependencies[name];
    },
    console: { error() {} },
  });
  await module.exports.recordFlightSearch('u1', sampleSearch, { userRegistered });
  assert.deepEqual(calls.map(call => call.table), userRegistered
    ? ['flight_search_history']
    : stubFails ? ['app_users'] : ['app_users', 'flight_search_history']);
  const saved = calls.find(call => call.table === 'flight_search_history');
  if (saved) {
    assert.equal(saved.payload.user_id, 'u1');
    assert.equal(saved.payload.routes[0].destination, 'SIN');
    assert.equal(saved.options.onConflict, 'user_id,search_key');
  }
}

const database = new PGlite();
try {
  await database.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.app_users (clerk_id text primary key);
  `);
  await database.exec(migration);
  await database.exec(`
    insert into public.app_users (clerk_id) values ('u1'), ('u2'), ('u3');

    insert into public.flight_search_history (
      user_id, search_key, popularity_key, trip_type, routes,
      first_departure_date, adults, children, infants, cabin_class, searched_at
    ) values
      (
        'u1', repeat('1', 64), repeat('a', 64), 'oneway',
        '[{"origin":"DAC","destination":"SIN","departureDate":"2026-09-10"}]',
        '2026-09-10', 1, 0, 0, 1, '2026-08-25T10:00:00Z'
      ),
      (
        'u2', repeat('2', 64), repeat('a', 64), 'oneway',
        '[{"origin":"DAC","destination":"SIN","departureDate":"2026-09-11"}]',
        '2026-09-11', 2, 0, 0, 1, '2026-08-26T10:00:00Z'
      ),
      (
        'u3', repeat('3', 64), repeat('b', 64), 'oneway',
        '[{"origin":"DAC","destination":"CXB","departureDate":"2026-09-12"}]',
        '2026-09-12', 1, 0, 0, 1, '2026-08-26T11:00:00Z'
      );
  `);

  const popular = await database.query(`
    select *
    from public.popular_flight_searches_v1(
      '2026-08-01T00:00:00Z', '2026-08-26', 5, 2
    )
  `);
  assert.equal(popular.rows.length, 1);
  assert.equal(Number(popular.rows[0].distinct_user_count), 2);
  assert.equal(Number(popular.rows[0].search_count), 2);
  assert.equal(popular.rows[0].user_id, undefined);
  assert.equal(popular.rows[0].adults, 2);
} finally {
  await database.close();
}

console.log('dashboard flight-search history verification passed');
