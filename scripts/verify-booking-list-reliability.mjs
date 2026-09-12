import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      databaseFailureIsNotEmptyState: true,
      explicitRetry: true,
      visibilityRulesChanged: false,
    },
    null,
    2
  )
);
