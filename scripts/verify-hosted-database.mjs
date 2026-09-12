import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import nextEnv from '@next/env';
import { expectedProjectRef, root } from './helpers/fresh-database.mjs';

// Read-only hosted verification. No migration, fixtures, SMS or email calls.
nextEnv.loadEnvConfig(root);
const api = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
assert.equal(api.hostname, `${expectedProjectRef}.supabase.co`);
assert.equal(api.protocol, 'https:');
const workdir = path.join(root, 'supabase/fresh-install');
assert.equal(fs.readFileSync(path.join(workdir, 'supabase/.temp/project-ref'), 'utf8').trim(), expectedProjectRef);
const source = new URL(process.env.DATABASE_URL);
assert.ok(source.hostname === `db.${expectedProjectRef}.supabase.co` ||
  (source.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(source.username) === `postgres.${expectedProjectRef}`));
const database = new URL(fs.readFileSync(path.join(workdir, 'supabase/.temp/pooler-url'), 'utf8').trim());
assert.equal(decodeURIComponent(database.username), `postgres.${expectedProjectRef}`);
assert.ok(database.hostname.endsWith('.pooler.supabase.com'));
const password = decodeURIComponent(source.password);
assert.ok(password);
database.password = password;
const sql = spawnSync('npx', ['--offline', 'supabase', 'db', 'query', '--db-url', database.href,
  '--file', path.join(workdir, 'verify-hosted.sql'), '--output', 'json'],
{ cwd: root, encoding: 'utf8', timeout: 60000 });
if (sql.status !== 0) {
  console.error((sql.stderr || 'Hosted SQL verification failed').split(database.href).join('[DB_URL]').split(password).join('[REDACTED]'));
  process.exit(1);
}
const result = JSON.parse(sql.stdout).rows[0].verification;
assert.equal(result.table_count, 82);
assert.deepEqual(result.tables_without_rls, []);
const nonempty = Object.fromEntries(Object.entries(result.row_counts).filter(([, count]) => count > 0).sort(([a], [b]) => a.localeCompare(b)));
const postSetup = process.argv.includes('--post-setup');
const operationalTables = new Set([
  'security_audit_events', 'security_rate_limits',
  'flight_search_usage_events', 'flight_search_daily_counters',
]);
const checkedCounts = postSetup
  ? Object.fromEntries(Object.entries(nonempty).filter(([table]) => !operationalTables.has(table)))
  : nonempty;
// Security checks and application searches create operational records.
// Strict initial-empty checks remain the default; post-setup reports these rows
// without relaxing the empty user, booking, wallet or other business tables.
assert.deepEqual(checkedCounts, {
  announcement_slider_settings: 1, company_settings: 1, flight_search_supplier_limits: 3,
  homepage_offer_settings: 1, homepage_travel_offers: 3, promotional_popup_settings: 1,
  supplier_operational_settings: 1,
}, 'Unexpected records: this verification is intended for an unused fresh installation');
assert.deepEqual(result.migration_versions, ['20260911000000', '20260911010000']);
assert.equal(result.company_name, 'Kaliganj Travels');
assert.deepEqual(result.company_contact, { license: null, phone: '+880 1795-271171',
  email: 'support@kaliganjtravel.com', address: '1st Floor, Janata Super Market, Kaligonj, Jhenaidah, Bangladesh' });
assert.equal(result.active_or_imaged_offers, 0);
assert.deepEqual(result.supplier, { active: 'triplover', booking_enabled: false, ticketing_enabled: false });

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(serviceKey, 'Missing service key');
async function get(route, key = serviceKey) {
  const response = await fetch(new URL(`/rest/v1/${route}`, api), {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`REST verification failed (${response.status}) for ${route.split('?')[0]}`);
  return response.json();
}
const routes = ['app_users', 'flight_bookings', 'wallet_ledger_entries', 'booking_notification_outbox',
  'ticket_management_requests', 'booking_lifecycle_v', 'booking_dashboard_creator_v'];
const checks = await Promise.allSettled(routes.map(async (route) => {
  assert.deepEqual(await get(`${route}?select=*&limit=1`), [], route);
  return route;
}));
for (const check of checks) if (check.status === 'rejected') throw check.reason;
const controls = await get('supplier_operational_settings?select=active_supplier,booking_enabled,ticketing_enabled');
assert.deepEqual(controls, [{ active_supplier: 'triplover', booking_enabled: false, ticketing_enabled: false }]);
const rpc = await get('rpc/resolve_booking_lifecycle?p_status=cancelled&p_airlines_pnr=[]&p_ticketing_deadline_at=2030-01-01T00:00:00Z&p_operation_kind=none');
assert.equal(rpc, 'cancelled');
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
assert.ok(anon);
const denied = await fetch(new URL('/rest/v1/company_settings?select=*', api), {
  headers: { apikey: anon, Authorization: `Bearer ${anon}` }, signal: AbortSignal.timeout(20000),
});
assert.ok([401, 403].includes(denied.status), 'Anonymous access to company settings must be denied');
console.log(JSON.stringify({ projectRef: expectedProjectRef, verifiedAt: new Date().toISOString(),
  status: 'passed', tableCount: result.table_count, functionCount: result.public_function_count,
  nonemptyTables: nonempty, postSetup, businessTablesEmpty: true, allTablesHaveRls: true,
  migrationVersions: result.migration_versions, companyContact: result.company_contact, restChecks: routes.length + 1,
  readOnlyRpc: 'passed', anonymousSettingsAccess: 'denied', supplier: result.supplier,
  databasePasswordFieldsMatch: password === process.env.SUPABASE_DB_PASSWORD,
}, null, 2));
