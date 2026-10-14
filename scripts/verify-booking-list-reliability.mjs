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
