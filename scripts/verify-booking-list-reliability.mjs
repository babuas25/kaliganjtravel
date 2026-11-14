import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const typescript = require('typescript');

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const bookingDb = read('lib', 'db', 'flight-bookings.ts');
const dashboardBookings = read('lib', 'dashboard', 'bookings.ts');
const bookingsPage = read(
  'app',
  '(dashboard)',
  'dashboard',
  'bookings',
  'page.tsx'
);
const bookingsView = read(
  'components',
  'dashboard',
  'bookings',
  'BookingsView.tsx'
);
const bookingsTable = read(
  'components',
  'dashboard',
  'bookings',
  'BookingsTable.tsx'
);

const dashboardPageQuery = bookingDb.slice(
  bookingDb.indexOf('export async function listBookingDashboardPage'),
  bookingDb.indexOf('export async function listBookings')
);

assert.match(
  dashboardPageQuery,
  /const unavailable = \{ rows: \[\], total: 0, loadError: true \}/,
  'A failed database read must be distinct from a valid empty page'
);
assert.match(
  dashboardPageQuery,
  /if \(!supabase\) return unavailable/,
  'A missing database client must be reported as a load failure'
);
assert.match(
  dashboardPageQuery,
  /if \(error\) \{[\s\S]*?return unavailable/,
  'A failed list query must report a load failure'
);
assert.match(
  dashboardPageQuery,
  /total: count \?\? 0,[\s\S]*?loadError: false/,
  'A successful empty query must remain a valid empty page'
);
assert.match(dashboardBookings, /return \{ bookings, total, loadError \}/);
assert.match(bookingsPage, /loadError=\{bookingPage\.loadError\}/);
assert.match(bookingsView, /Bookings could not be loaded/);
assert.match(bookingsView, /temporary read error, not an empty booking result/);
assert.match(bookingsView, /router\.refresh\(\)/);
assert.match(bookingsTable, />\s*Refresh\s*<\/button>/);

const dashboardModule = { exports: {} };
const scopedReads = [];
const dashboardDependencies = {
  'server-only': {},
  '@/lib/db/flight-bookings': {
    listBookingDashboardPage: async (scope, query) => {
      scopedReads.push({ scope, query });
      const rows = ['13000.25', null, 0].map((supplierPayable, index) => ({
        id: String(index), public_ref: `KTT-FIXTURE-${index}`, status: 'confirmed',
        pnr: 'OLD-RESERVATION', supplier_reference: 'STR261115123456',
        reservation_pnr: index < 2 ? 'NEW-RESERVATION' : null,
        airline_pnr: index === 0 ? 'NEW001, NEW002' : '',
        passenger_counts: {}, fare: '14000.50', gross: '15000.00',
        supplier_payable: supplierPayable, creator_role: 'b2b',
      }));
      return { rows, total: rows.length, loadError: false };
    },
  },
  '@/lib/db/ticket-management': { listTicketManagementRequestReferencesForBookings: async () => new Map() },
  '@/lib/db/booking-lifecycle': { listStaffBookingLifecycle: async () => [] },
  '@/lib/dashboard/booking-lifecycle': {
    bookingLifecycleAccessForRole: role => ['superadmin', 'admin'].includes(role) ? 'staff' : null,
  },
  '@/lib/flights/airline-pnr': { airlinePnrs: values => values.map(value => value.trim()).filter(Boolean) },
  '@/lib/flights/booking-status': { resolvePublicBookingStatus: ({ status }) => status },
  '@/lib/flights/customer-status': { customerStatusMessage: () => null },
};
vm.runInNewContext(
  typescript.transpileModule(dashboardBookings, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  }).outputText,
  {
    exports: dashboardModule.exports,
    require: name => {
      assert.ok(Object.hasOwn(dashboardDependencies, name), `Unexpected booking list dependency ${name}`);
      return dashboardDependencies[name];
    },
    performance,
    process: { env: {} },
  }
);
const { listDashboardBookings } = dashboardModule.exports;
for (const sortKey of ['supplierPayable', 'profit']) {
  const query = { page: 2, pageSize: 25, sortKey, sortDirection: 'asc', amountMin: '100' };
  const superAdmin = await listDashboardBookings({ role: 'superadmin', clerkId: 'root' }, query);
  assert.deepEqual(Array.from(superAdmin.bookings, row => row.supplierPayable), [13000.25, null, 0]);
  assert.deepEqual(Array.from(superAdmin.bookings, row => [row.reservationPnr, row.airlinePnr]), [
    ['NEW-RESERVATION', 'NEW001, NEW002'], ['NEW-RESERVATION', ''], [undefined, ''],
  ]);
  assert.equal(superAdmin.bookings[0].supplierReference, 'STR261115123456');
  assert.doesNotMatch(JSON.stringify(superAdmin.bookings), /OLD-RESERVATION/);
  assert.equal(scopedReads.at(-1).query, query);
  for (const session of [
    { role: 'admin', clerkId: 'admin' },
    { role: 'b2b', clerkId: 'owner', agencyCode: 'agency-1' },
    { role: 'customer', clerkId: 'customer' },
  ]) {
    const page = await listDashboardBookings(session, query);
    assert(page.bookings.every(row => row.supplierPayable === null && row.fare === 14000.5));
    assert.equal(page.bookings[0].reservationPnr, 'NEW-RESERVATION');
    assert.equal(page.bookings[0].airlinePnr, 'NEW001, NEW002');
    assert.doesNotMatch(JSON.stringify(page.bookings), /OLD-RESERVATION/);
    const read = scopedReads.at(-1);
    assert.deepEqual({ ...read.query }, { ...query, sortKey: null });
    assert.equal(read.scope.kind, { admin: 'all', b2b: 'agency', customer: 'user' }[session.role]);
  }
}
assert.match(bookingsTable, /Reservation PNR:.*\n.*booking\.reservationPnr/);
assert.match(dashboardPageQuery, /shaponDisplayColumnMissing\(projectionRead\.error\)\s*\? await readPage\(baseSelect\)/);
const normalSort = { sortKey: 'fare', sortDirection: 'desc' };
await listDashboardBookings({ role: 'b2b', clerkId: 'owner', agencyCode: 'agency-1' }, normalSort);
assert.equal(scopedReads.at(-1).query, normalSort);

const freshnessModule = { exports: {} };
vm.runInNewContext(
  typescript.transpileModule(read('lib', 'dashboard', 'booking-list-freshness.ts'), {
    compilerOptions: { module: typescript.ModuleKind.CommonJS },
  }).outputText,
  { exports: freshnessModule.exports }
);
const { BOOKING_LIST_FRESHNESS_MS, bookingListNeedsRefresh } = freshnessModule.exports;
const loadedAt = 1_000_000;
const needsRefresh = (now, lastRefreshRequestedAt = null, serverLoadedAt = loadedAt) =>
  bookingListNeedsRefresh({ serverLoadedAt, lastRefreshRequestedAt, now });

assert.equal(needsRefresh(loadedAt), false, 'A freshly server-rendered list needs no mount refresh');
assert.equal(
  needsRefresh(loadedAt + BOOKING_LIST_FRESHNESS_MS - 1),
  false,
  'Returning to a recently loaded list must not start another server execution'
);
assert.equal(
  needsRefresh(loadedAt + BOOKING_LIST_FRESHNESS_MS),
  true,
  'A restored stale list must refresh at the freshness boundary'
);
const refreshRequestedAt = loadedAt + BOOKING_LIST_FRESHNESS_MS;
assert.equal(
  needsRefresh(refreshRequestedAt + 1, refreshRequestedAt),
  false,
  'Paired pageshow/visibility events must share the refresh already requested'
);
assert.equal(
  needsRefresh(refreshRequestedAt + BOOKING_LIST_FRESHNESS_MS, refreshRequestedAt),
  true,
  'A failed or unfinished refresh must not suppress a later stale-list recheck forever'
);
const refreshedAt = refreshRequestedAt + 2_000;
assert.equal(
  needsRefresh(refreshedAt + BOOKING_LIST_FRESHNESS_MS - 1, refreshRequestedAt, refreshedAt),
  false,
  'A new server snapshot resets freshness using its own load time'
);
assert.equal(
  needsRefresh(loadedAt, null, loadedAt + 10 * 60_000),
  true,
  'A client clock behind the server must still recheck a restored list'
);
assert.equal(
  needsRefresh(loadedAt, loadedAt, loadedAt + 10 * 60_000),
  false,
  'Clock skew must not turn paired browser events into duplicate requests'
);
assert.equal(
  needsRefresh(loadedAt, loadedAt + 60_000, loadedAt - 60_000),
  true,
  'A backwards client-clock change must not indefinitely suppress refresh'
);
assert.equal(needsRefresh(loadedAt, null, NaN), true, 'Invalid timestamps must not establish freshness');
assert.equal(
  needsRefresh(loadedAt + 60_000, loadedAt + 60_000, loadedAt + 10 * 60_000),
  false,
  'Locally receiving a slow refresh still establishes a fresh snapshot under clock skew'
);
assert.match(bookingsPage, /serverLoadedAt=\{Date\.now\(\)\}/);
assert.match(bookingsView, /serverLoadedAt > latestServerLoadedAt\.current[\s\S]*?lastRefreshRequestedAt\.current = Date\.now\(\)/);
assert.match(bookingsView, /isPending\) return;[\s\S]*?bookingListNeedsRefresh\(/);
const manualRefresh = bookingsView.slice(
  bookingsView.indexOf('const refreshBookings ='),
  bookingsView.indexOf('const refreshIfStale =')
);
assert.doesNotMatch(manualRefresh, /bookingListNeedsRefresh\(/, 'Explicit Refresh/Retry bypasses freshness');

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      databaseFailureIsNotEmptyState: true,
      explicitRetry: true,
      freshMountSkipsRefresh: true,
      staleSnapshotsRefresh: true,
      automaticRefreshEventsCoalesced: true,
      visibilityRulesChanged: false,
    },
    null,
    2
  )
);
