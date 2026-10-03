import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const require = createRequire(import.meta.url);
const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function loadTypeScript(path, dependencies = {}) {
  const compiled = ts.transpileModule(read(path), {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal((compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  ).length, 0, `${path} must transpile`);
  const module = { exports: {} };
  new vm.Script(compiled.outputText, { filename: path }).runInNewContext({
    module, exports: module.exports, console, Response,
    require(specifier) {
      if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier];
      assert.ok(!specifier.startsWith('@/'), `Unexpected dependency: ${specifier}`);
      return require(specifier);
    },
  });
  return module.exports;
}

const permissions = loadTypeScript('lib/wallet/permissions.ts', {
  '@/lib/impexp/booking-source': { isExternalBookingSource: () => false },
  '@/lib/shapontravels/current-status-projection': loadTypeScript('lib/shapontravels/current-status-projection.ts', {
    './booking-status': loadTypeScript('lib/shapontravels/booking-status.ts'),
    '@/lib/flights/booking-status': loadTypeScript('lib/flights/booking-status.ts'),
  }),
});
const http = loadTypeScript('lib/wallet/http.ts', {
  'next/server': { NextResponse: {
    json: (body, options) => new Response(JSON.stringify(body), options),
  } },
});

const agencyCode = 'ST-B2B924493';
const wallet = (id, ownerType, ownerKey, status = 'active') => ({
  id, ownerType, ownerKey, status,
  accounts: [{ id: `${id}-account`, currency: 'BDT', availableBalance: 0, holdBalance: 0 }],
});
const baseWallets = [
  wallet('target', 'agency', agencyCode),
  wallet('frozen', 'agency', 'ST-B2B000002', 'frozen'),
  wallet('unowned', 'agency', 'ST-B2B000003'),
  wallet('missing-owner', 'agency', 'ST-B2B000004'),
  wallet('deleted-agency', 'agency', 'ST-B2B000005'),
  wallet('customer', 'user', 'customer-owner'),
  wallet('email-only', 'user', 'email-only-owner'),
  wallet('deleted-user', 'user', 'deleted-user-owner'),
];
baseWallets[1].accounts[0].availableBalance = 950000;

function fixture(patch = {}) {
  return {
    session: { clerkId: 'operator', role: 'superadmin' },
    wallets: structuredClone(baseWallets),
    agencies: [
      { agencyCode, label: 'KALIGANJ TOUR AND TRAVEL' },
      { agencyCode: 'ST-B2B000002', label: 'Funded agency' },
      { agencyCode: 'ST-B2B000003', label: 'Unowned agency' },
      { agencyCode: 'ST-B2B000004', label: 'Agency with deleted owner' },
    ],
    rows: {
      agencies: [
        { agency_code: agencyCode, owner_user_id: 'partner-owner' },
        { agency_code: 'ST-B2B000002', owner_user_id: 'funded-owner' },
        { agency_code: 'ST-B2B000003', owner_user_id: null },
        { agency_code: 'ST-B2B000004', owner_user_id: 'deleted-partner' },
      ],
      app_users: [
        { clerk_id: 'partner-owner', email: 'kaligonjtourtravels@gmail.com',
          first_name: 'Partner', last_name: 'Owner' },
        { clerk_id: 'funded-owner', email: 'funded@example.com', first_name: null, last_name: null },
        { clerk_id: 'customer-owner', email: 'customer@example.com', first_name: 'Jane', last_name: 'Doe' },
        { clerk_id: 'email-only-owner', email: 'email-only@example.com', first_name: null, last_name: null },
        // Neither a member nor a record keyed by the agency ID owns its wallet.
        { clerk_id: 'sub-user', agency_code: agencyCode, email: 'member@example.com' },
        { clerk_id: agencyCode, email: 'wrong-owner@example.com' },
      ],
    },
    calls: [],
    ...patch,
  };
}

let state = fixture();
const noMutation = () => { throw new Error('A wallet listing must not mutate financial data'); };
const supabase = {
  from(table) {
    assert.ok(['agencies', 'app_users'].includes(table), `Unexpected table: ${table}`);
    return {
      select(columns) {
        assert.equal(columns, table === 'agencies'
          ? 'agency_code, owner_user_id' : 'clerk_id, email, first_name, last_name');
        return {
          async in(column, ids) {
            state.calls.push({ operation: table, column, ids: [...ids] });
            assert.equal(column, table === 'agencies' ? 'agency_code' : 'clerk_id');
            assert.equal(new Set(ids).size, ids.length, 'Lookup IDs must be deduplicated');
            assert.ok(ids.every((id) => typeof id === 'string' && id), 'Null owner IDs must be omitted');
            if (state.rejectTable === table) throw new Error('Storage read failed');
            return {
              data: state.rows[table].filter((row) => ids.includes(row[column])),
              error: state.errorTable === table ? { message: 'Storage read failed' } : null,
            };
          },
        };
      },
    };
  },
};
const route = loadTypeScript('app/api/wallet/admin/route.ts', {
  '@/lib/dashboard/session': { getDashboardSession: async () => state.session },
  '@/lib/db/agencies': { listAgencies: async () => {
    state.calls.push({ operation: 'listAgencies' });
    if (state.failAgencies) throw new Error('Agency read failed');
    return state.agencies;
  } },
  '@/lib/db/security': { recordSecurityAuditEvent: noMutation },
  '@/lib/db/wallet': {
    listWallets: async () => {
      state.calls.push({ operation: 'listWallets' });
      if (state.failWallets) throw new Error('Wallet read failed');
      return state.wallets;
    },
    setWalletStatus: noMutation,
  },
  '@/lib/rate-limit': { checkActionLimit: noMutation },
  '@/lib/supabase/server': { supabaseAdmin: () => state.missingStorage ? null : supabase },
  '@/lib/wallet/http': http,
  '@/lib/wallet/permissions': permissions,
});

async function getWallets(patch = {}) {
  state = fixture(patch);
  const response = await route.GET();
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return { status: response.status, body: await response.json() };
}

const listing = await getWallets();
assert.equal(listing.status, 200);
const listed = listing.body.data.wallets;
assert.equal(listed.length, baseWallets.length, 'Durable wallet rows must remain visible');
assert.equal(listed[0].ownerName, 'KALIGANJ TOUR AND TRAVEL');
assert.equal(listed[0].ownerEmail, 'kaligonjtourtravels@gmail.com');
assert.equal(listed[1].ownerEmail, 'funded@example.com');
assert.deepEqual(listed.slice(2, 5).map((item) => item.ownerEmail), [null, null, null]);
assert.equal(listed[4].ownerName, 'Unnamed agency');
assert.equal(listed[5].ownerName, 'Jane Doe');
assert.equal(listed[5].ownerEmail, 'customer@example.com');
assert.equal(listed[6].ownerName, 'email-only@example.com');
assert.equal(listed[7].ownerName, 'B2C customer');
assert.equal(listed[7].ownerEmail, null);
for (let index = 0; index < listed.length; index += 1) {
  const { ownerName, ownerEmail, ...financialData } = listed[index];
  assert.deepEqual(financialData, baseWallets[index], 'Listing must preserve balance and wallet state');
}
assert.deepEqual(state.wallets, baseWallets, 'Listing must not mutate its stored rows');
const userLookup = state.calls.find((call) => call.operation === 'app_users');
assert.deepEqual(new Set(userLookup.ids), new Set([
  'customer-owner', 'email-only-owner', 'deleted-user-owner',
  'partner-owner', 'funded-owner', 'deleted-partner',
]));

for (const role of ['superadmin', 'admin', 'staff_support', 'staff_account']) {
  assert.equal((await getWallets({ session: { clerkId: 'operator', role } })).status, 200);
}
for (const session of [null, { role: 'customer' }, { role: 'b2b' }, { role: 'b2b_sub' }]) {
  const result = await getWallets({ session });
  assert.equal(result.status, session ? 403 : 401);
  assert.equal(result.body.error.errorCode, session ? 'FORBIDDEN' : 'SIGN_IN_REQUIRED');
  assert.equal(state.calls.length, 0, 'Denied callers must not access wallet storage');
}
for (const patch of [
  { missingStorage: true }, { failWallets: true }, { failAgencies: true },
  { errorTable: 'agencies' }, { errorTable: 'app_users' },
  { rejectTable: 'agencies' }, { rejectTable: 'app_users' },
]) {
  const result = await getWallets(patch);
  assert.equal(result.status, 503, JSON.stringify(patch));
  assert.equal(result.body.error.errorCode, 'STORAGE_ERROR');
  assert.equal(result.body.success, false);
  assert.equal(result.body.data, undefined, 'A failed lookup must not return partial wallet metadata');
}
assert.equal((await getWallets({ wallets: [] })).body.data.wallets.length, 0);
assert.ok(!state.calls.some((call) => ['agencies', 'app_users'].includes(call.operation)));
assert.equal((await getWallets({ wallets: [baseWallets[5]] })).body.data.wallets[0].ownerEmail, 'customer@example.com');
assert.ok(!state.calls.some((call) => call.operation === 'agencies'));
assert.equal((await getWallets({ wallets: [baseWallets[2]] })).body.data.wallets[0].ownerEmail, null);
assert.ok(!state.calls.some((call) => call.operation === 'app_users'));

// Execute the installed schema and real provisioning migration in Postgres.
// No mocked account helper or static source assertions can stand in for this.
const db = new PGlite({ extensions: { pgcrypto } });
try {
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create schema storage; alter default privileges in schema public grant all on tables to service_role;');
  await db.exec(read('supabase/fresh-install/supabase/migrations/20260911000000_kaliganj_baseline.sql'));
  await db.exec(`
    insert into app_users(clerk_id, role) values
      ('partner-owner', 'b2b'), ('funded-owner', 'b2b'),
      ('frozen-owner', 'b2b'), ('usd-owner', 'b2b'),
      ('new-owner', 'b2b'), ('customer-owner', 'customer');
    insert into agencies(agency_code, owner_user_id) values
      ('${agencyCode}', 'partner-owner'), ('ST-B2B000002', 'funded-owner'),
      ('ST-B2B000003', 'frozen-owner'), ('ST-B2B000004', 'usd-owner'),
      ('ST-B2B000005', null);
  `);
  assert.equal((await db.query('select count(*)::int as count from wallets')).rows[0].count, 0);
  for (const [type, key, currency] of [
    ['agency', 'ST-B2B000002', 'BDT'], ['agency', 'ST-B2B000003', 'BDT'],
    ['agency', 'ST-B2B000004', 'USD'], ['user', 'customer-owner', 'BDT'],
  ]) {
    await db.query('select public.wallet_ensure_account($1,$2,$3)', [type, key, currency]);
  }
  await db.exec(`
    update wallet_accounts a set available_balance = 900000, hold_balance = 50000
      from wallets w where w.id = a.wallet_id and w.owner_key = 'ST-B2B000002';
    update wallet_accounts a set available_balance = 450000, hold_balance = 50000
      from wallets w where w.id = a.wallet_id and w.owner_key = 'ST-B2B000003';
    update wallets set status = 'frozen', frozen_at = '2026-09-20T00:00:00Z',
      frozen_by = 'operator', freeze_reason = 'Existing freeze'
      where owner_key = 'ST-B2B000003';
    update wallet_accounts a set available_balance = 20000
      from wallets w where w.id = a.wallet_id and w.owner_key = 'ST-B2B000004';
    update wallet_accounts a set available_balance = 40000
      from wallets w where w.id = a.wallet_id and w.owner_type = 'user';
    insert into wallet_ledger_entries(
      wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after,
      idempotency_key, created_by_user_id, created_by_role
    ) select a.id, 'deposit', a.available_balance + a.hold_balance, a.currency,
      0, a.available_balance + a.hold_balance, 0, 0,
      'fixture-deposit:' || a.id, 'operator', 'superadmin'
      from wallet_accounts a;
    insert into wallet_ledger_entries(
      wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after,
      idempotency_key, created_by_user_id, created_by_role
    ) select a.id, 'booking_hold', a.hold_balance, a.currency,
      a.available_balance + a.hold_balance, a.available_balance, 0, a.hold_balance,
      'fixture-hold:' || a.id, 'operator', 'superadmin'
      from wallet_accounts a where a.hold_balance > 0;
  `);

  const rows = async (table) => (await db.query(`select row_to_json(t) as row from ${table} t order by id`)).rows.map((row) => row.row);
  const originalWallets = await rows('wallets');
  const originalAccounts = await rows('wallet_accounts');
  const originalLedger = await rows('wallet_ledger_entries');
  const walletGrants = async () => (await db.query("select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name like 'wallet%' order by table_name, grantee, privilege_type")).rows;
  const originalGrants = await walletGrants();
  const migration = read('supabase/fresh-install/supabase/migrations/20261002000000_agency_wallet_provisioning.sql');
  await db.exec(migration);

  const accounts = (await db.query(`
    select w.owner_key, w.status, a.currency,
      a.available_balance::int, a.hold_balance::int
      from wallets w join wallet_accounts a on a.wallet_id = w.id
      where w.owner_type = 'agency' order by w.owner_key, a.currency
  `)).rows;
  assert.equal(accounts.filter((account) => account.currency === 'BDT').length, 5,
    'Every existing agency must gain one BDT account');
  assert.deepEqual(accounts.find((account) => account.owner_key === agencyCode), {
    owner_key: agencyCode, status: 'active', currency: 'BDT', available_balance: 0, hold_balance: 0,
  }, 'The reported partner must be discoverable before their first wallet visit');
  const usdAgencyAccounts = accounts.filter((account) => account.owner_key === 'ST-B2B000004');
  assert.deepEqual(usdAgencyAccounts.map((account) => [account.currency, account.available_balance]),
    [['BDT', 0], ['USD', 20000]], 'Provisioning must preserve other currencies');
  for (const [table, original] of [['wallets', originalWallets], ['wallet_accounts', originalAccounts]]) {
    const current = new Map((await rows(table)).map((row) => [row.id, row]));
    for (const row of original) assert.deepEqual(current.get(row.id), row,
      `${table}: provisioning changed an existing row, identity, balance, freeze or timestamp`);
  }

  assert.equal((await db.query("select has_function_privilege('service_role', 'public.provision_agency_wallet()', 'execute') as allowed")).rows[0].allowed, false,
    'The trigger function must not become a directly callable RPC');
  await db.exec('set role service_role');
  await db.query('insert into agencies(agency_code,owner_user_id) values($1,$2)', ['ST-B2B000006', 'new-owner']);
  await db.exec('reset role');
  assert.deepEqual((await db.query(`
    select w.status, a.currency, a.available_balance::int, a.hold_balance::int
      from wallets w join wallet_accounts a on a.wallet_id = w.id
      where w.owner_type = 'agency' and w.owner_key = 'ST-B2B000006'
  `)).rows, [{ status: 'active', currency: 'BDT', available_balance: 0, hold_balance: 0 }],
  'A newly inserted agency must immediately have one zero-balance account');
  const provisionedWallets = await rows('wallets');
  const provisionedAccounts = await rows('wallet_accounts');
  await db.exec(migration);
  assert.deepEqual(await rows('wallets'), provisionedWallets, 'Migration replay must preserve wallet rows');
  assert.deepEqual(await rows('wallet_accounts'), provisionedAccounts, 'Migration replay must preserve account rows');
  assert.deepEqual(await rows('wallet_ledger_entries'), originalLedger, 'Provisioning must not create or change ledger entries');
  assert.deepEqual(await walletGrants(), originalGrants, 'Provisioning must not grant direct financial table privileges');
  for (const table of ['wallet_deposit_requests', 'wallet_adjustment_requests', 'wallet_reservations']) {
    assert.equal((await db.query(`select count(*)::int as count from ${table}`)).rows[0].count, 0,
      `Provisioning must not initiate financial activity in ${table}`);
  }
} finally {
  await db.close();
}

console.log('Wallet discovery passed: canonical agency email, customer metadata, authorization/storage failures, zero-balance insert/backfill, preserved funds/freezes/history, and idempotent replay.');
