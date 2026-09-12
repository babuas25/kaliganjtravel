import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const actions = read('components', 'flights', 'BookingActions.tsx');
const route = read(
  'app',
  'api',
  'flights',
  'booking',
  'share-confirmation',
  'route.ts'
);
const rateLimit = read('lib', 'rate-limit.ts');

assert.match(actions, /\{ticketed && \(/, 'Share UI must render only for confirmed bookings');
assert.match(actions, /\n\s+Share\n/, 'Quick Actions must include Share');
assert.match(actions, /type="email"/, 'Share must use an email input');
assert.match(actions, /Send Email/, 'Share must include the requested send action');
assert.match(
  actions,
  /\/api\/flights\/booking\/share-confirmation/,
  'Share UI must call the protected booking endpoint'
);

assert.match(route, /getDashboardSession\(\)/, 'Share endpoint must require a session');
assert.match(route, /bookingScopeFor\(session\)/, 'Booking lookup must use viewer scope');
assert.match(
  route,
  /\(booking\.lifecycle_status \?\? booking\.status\) !== 'confirmed'/,
  'Endpoint must reject non-confirmed bookings'
);
assert.match(
  route,
  /sendBookingStatusNotification\(\{[\s\S]*status: 'confirmed'/,
  'Share must reuse the confirmed booking email and ticket PDF sender'
);
assert.match(
  route,
  /securitySubjectHash\(email\)/,
  'Audit metadata must hash the recipient address'
);
assert.doesNotMatch(
  route,
  /metadata:\s*\{[^}]*\bemail\b/,
  'Audit metadata must not store the recipient email address'
);
assert.match(
  rateLimit,
  /bookingConfirmationShare:\s*\{\s*limit:\s*20,\s*windowMs:\s*HOUR\s*\}/,
  'Arbitrary-address confirmation sharing must be rate limited'
);

console.log('Confirmed booking email sharing verification passed.');
