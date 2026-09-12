import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const checkout = read('components', 'flights', 'BookingCheckout.tsx');
const actions = read('components', 'flights', 'BookingActions.tsx');
const details = read('components', 'flights', 'BookingDetails.tsx');
const bookingPage = read(
  'app',
  '(dashboard)',
  'dashboard',
  'bookings',
  '[reference]',
  'page.tsx'
);
const refreshRoute = read(
  'app',
  'api',
  'flights',
  'booking',
  'refresh-details',
  'route.ts'
);

assert.match(
  checkout,
  /dashboard\/bookings\/\$\{encodeURIComponent\([^)]*publicRef\)\}\?created=1/,
  'Successful booking navigation must mark the booking as newly created.'
);
assert.match(
  bookingPage,
  /autoRefreshDeadline=\{row\.supplier === 'triplover' && row\.import_source !== 'MANUAL'\}/,
  'All eligible booking detail pages should recover missing deadlines, including reopened bookings.'
);
assert.match(
  details,
  /ticketingDeadlineAt=\{booking\.ticketingDeadlineAt\}/,
  'The retry controller must receive the currently stored deadline.'
);
assert.match(
  actions,
  /DEADLINE_AUTO_REFRESH_DELAYS_MS = \[\s*5_000,\s*10_000,\s*15_000,[\s\S]*?30_000,[\s\S]*?45_000,[\s\S]*?120_000,[\s\S]*?240_000,[\s\S]*?360_000,[\s\S]*?\] as const/,
  'Deadline refresh attempts must cover the early 5/10/15-second checks, 30/45-second fallback and the slow 2/4/6-minute PNR window.'
);
assert.match(
  actions,
  /if \(\s*!automatic &&[\s\S]*?router\.refresh\(\);[\s\S]*?return Boolean\(body\.data\?\.ticketingDeadlineAt\)/,
  'An intermediate automatic PNR response must not reload the page and cancel its remaining retries.'
);
assert.match(
  actions,
  /if \(deadlineAvailable\) \{\s*completedDeadlineRefresh.current = bookingReference;\s*clearCreatedBookingMarker\(\);\s*router\.refresh\(\);\s*return;[\s\S]*?clearCreatedBookingMarker\(\);\s*router\.refresh\(\);/,
  'The page should refresh once when a deadline is found or after the complete retry window.'
);
assert.match(
  actions,
  /status === 'on-hold' \|\| status === 'unconfirmed' \|\| status === 'pending'/,
  'Only non-terminal booking states should be eligible for automatic refresh.'
);
assert.match(
  refreshRoute,
  /walletOk\(\{ details, source, ticketingDeadlineAt \}\)/,
  'The refresh endpoint must report whether the persisted deadline is available.'
);

const autoEffect = actions.slice(actions.indexOf('  useEffect(() => {\n    if (\n      !autoRefreshDeadline'), actions.indexOf('  async function requestTimeLimit'));
assert.ok(autoEffect.length > 0);
assert.doesNotMatch(autoEffect, /!allowSupplierRefresh|query\.created/,
  'Automatic deadline acquisition must not depend on admin refresh permission or a URL marker');
assert.match(actions, /automatic\s*\? '\/api\/flights\/booking\/refresh-deadline'/);

console.log(
  'Booking deadline auto-refresh verified: new bookings retry through the fast and slow PNR windows without page reloads cancelling the sequence.'
);
