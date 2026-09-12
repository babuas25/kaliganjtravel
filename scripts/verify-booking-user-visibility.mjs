import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const migration = read(
  'supabase',
  'migrations',
  '0117_booking_user_visibility.sql'
);
const bookingDb = read('lib', 'db', 'flight-bookings.ts');
const summary = read('lib', 'dashboard', 'data.ts');
const issuedTickets = read('lib', 'reports', 'issued-tickets.ts');
const statusRoute = read('app', 'api', 'flights', 'booking', 'status', 'route.ts');
const mutationRoute = read(
  'app',
  'api',
  'admin',
  'bookings',
  '[reference]',
  'visibility',
  'route.ts'
);
const visibilityDb = read('lib', 'db', 'booking-visibility.ts');
const bookingsPage = read(
  'app',
  '(dashboard)',
  'dashboard',
  'bookings',
  'page.tsx'
);
const bookingsTable = read(
  'components',
  'dashboard',
  'bookings',
  'BookingsTable.tsx'
);
const dashboardBookings = read('lib', 'dashboard', 'bookings.ts');

for (const required of [
  'hidden_from_user boolean not null default false',
  'booking_user_visibility_events',
  'booking_user_visibility_events_immutable_v1',
  'booking_user_hide_eligibility_v1',
  'booking_user_visibility_context_v1',
  'set_booking_user_visibility_v1',
  "v_actor_role not in ('superadmin', 'admin', 'staff_support')",
  "v_effective_status not in ('on-hold', 'cancelled', 'expired')",
  'reservation.booking_attempt_id = v_booking.attempt_id',
  'ledger.booking_reference = v_booking.public_ref',
  'reservation.id = ledger.reservation_id',
  "v_booking.payment_state = 'unpaid'",
  'v_booking.payment_amount is null',
  'v_booking.charged_wallet_account_id is null',
  'for update',
  'pg_advisory_xact_lock',
  "'walletMutation', false",
  "'supplierMutation', false",
  "'lifecycleMutation', false",
  'security_audit_events',
  'NOTIFICATION_DELIVERY_IN_PROGRESS',
  'to service_role',
]) {
  assert.ok(migration.includes(required), `Visibility migration omits ${required}`);
}

const executor = migration.match(
  /create or replace function public\.set_booking_user_visibility_v1\([\s\S]*?\n\$\$;/i
)?.[0] ?? '';
assert.ok(executor, 'Visibility mutation RPC is missing');
for (const forbidden of [
  /update\s+public\.wallet_/i,
  /insert\s+into\s+public\.wallet_/i,
  /delete\s+from\s+public\.wallet_/i,
  /insert\s+into\s+public\.booking_status_events/i,
  /insert\s+into\s+public\.booking_notification_outbox/i,
  /wallet_(?:reserve|capture|release|refund|mark_reconciliation)\s*\(/i,
]) {
  assert.doesNotMatch(executor, forbidden);
}
assert.doesNotMatch(
  executor,
  /set\s+(?:status|payment_state|supplier_refs|supplier_account)\s*=/i,
  'Visibility mutation must not alter lifecycle, wallet summary, or supplier binding'
);

assert.ok(
  (bookingDb.match(/query = query\.eq\('hidden_from_user', false\)/g) ?? [])
    .length >= 4 &&
    (bookingDb.match(/bookingUserVisibilitySchemaAvailable\(\)/g) ?? [])
      .length >= 4,
  'All shared non-staff booking readers must filter hidden bookings'
);
assert.match(summary, /scope\.kind !== 'all'[\s\S]*?hidden_from_user/);
assert.match(issuedTickets, /hidden_from_user/);
assert.match(statusRoute, /bookingScopeFor\(session\)/);
assert.match(mutationRoute, /canManageBookingUserVisibility\(session\.role\)/);
assert.match(mutationRoute, /setBookingUserVisibility/);
assert.match(visibilityDb, /bookingUserVisibilitySchemaAvailable/);
assert.match(visibilityDb, /error\.code === '42703'/);
assert.match(bookingsPage, /canManageBookingUserVisibility\(session\.role\)/);
assert.match(bookingsTable, /HIDEABLE_BOOKING_STATUSES/);
assert.match(bookingsTable, /booking\.isAgencyBooking/);
assert.match(bookingsTable, /\/api\/admin\/bookings\/\$\{encodeURIComponent\(booking\.referenceNo\)\}\/visibility/);
assert.match(dashboardBookings, /isAgencyBooking: Boolean\(row\.agency_code\)/);
const dashboardPageQuery = bookingDb.slice(
  bookingDb.indexOf('export async function listBookingDashboardPage'),
  bookingDb.indexOf('export async function listBookings')
);
assert.ok(
  dashboardPageQuery.indexOf("query.eq('hidden_from_user', false)") <
    dashboardPageQuery.indexOf('query.range(pageStart'),
  'Hidden booking filtering must be composed before pagination/counting'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      allowedRoles: ['superadmin', 'admin', 'staff_support'],
      hideStatuses: ['on-hold', 'cancelled', 'expired'],
      authoritativeWalletEvidence: ['reservation', 'ledger', 'attempt'],
      walletMutation: false,
      supplierMutation: false,
      lifecycleMutation: false,
      userReadersFiltered: true,
      immutableAudit: true,
    },
    null,
    2
  )
);
