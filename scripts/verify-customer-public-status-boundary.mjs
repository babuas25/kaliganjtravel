import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const status = read('lib', 'flights', 'booking-status.ts');
const bookingTypes = read('lib', 'flights', 'booking.ts');
const bookingDb = read('lib', 'db', 'flight-bookings.ts');
const dashboard = read('lib', 'dashboard', 'bookings.ts');
const dashboardData = read('lib', 'dashboard', 'data.ts');
const delivery = read('lib', 'email', 'booking-status-delivery.ts');
const notificationDb = read('lib', 'db', 'booking-notifications.ts');
const details = read('components', 'flights', 'BookingDetails.tsx');
const table = read('components', 'dashboard', 'bookings', 'BookingsTable.tsx');

const publicStatuses = [
  'on-hold',
  'pending',
  'in-progress',
  'confirmed',
  'expired',
  'unconfirmed',
  'cancelled',
];
const statusArray = status.match(
  /export const BOOKING_STATUSES = \[([\s\S]*?)\] as const;/
)?.[1] ?? '';
const declared = Array.from(statusArray.matchAll(/'([^']+)'/g), (match) => match[1]);
assert.deepEqual(declared, publicStatuses, 'Customer status vocabulary changed');

for (const label of [
  "'on-hold': 'On Hold'",
  "pending: 'Pending'",
  "'in-progress': 'In Progress'",
  "confirmed: 'Confirmed'",
  "expired: 'Expired'",
  "unconfirmed: 'Unconfirmed'",
  "cancelled: 'Cancelled'",
]) {
  assert.ok(status.includes(label), `Public status label omits ${label}`);
}
for (const required of [
  'isBookingStatus(value: unknown)',
  'resolvePublicBookingStatus(',
  'Internal operation/attempt/case states',
]) {
  assert.ok(status.includes(required), `Runtime public boundary omits ${required}`);
}

const publicAttempt = bookingTypes.match(
  /export type PublicBookingAttempt[\s\S]*?\n};/
)?.[0] ?? '';
const publicBooking = bookingTypes.match(
  /export type PublicBooking = [\s\S]*?\n};/
)?.[0] ?? '';
assert.ok(publicAttempt, 'Public booking-attempt DTO was not found');
assert.doesNotMatch(
  publicAttempt,
  /\bstatus\s*:/,
  'Internal attempt state must not become a customer booking status'
);
assert.match(publicBooking, /status: BookingStatus;/);
assert.doesNotMatch(
  publicBooking,
  /\b(?:operation|reconciliation|caseState|attemptState)\w*\s*:/,
  'Public booking DTO must not expose internal lifecycle labels'
);

for (const [source, label] of [
  [bookingDb, 'public booking read'],
  [dashboard, 'booking list read'],
  [dashboardData, 'dashboard summary/activity read'],
]) {
  assert.ok(
    source.includes('resolvePublicBookingStatus({'),
    `${label} does not use the seven-value runtime boundary`
  );
}
assert.ok(
  notificationDb.includes('isBookingStatus(row.lifecycle_status)') &&
    delivery.includes('claimBookingNotificationOutboxes'),
  'Occurrence email claims must filter statuses through the seven-value runtime boundary'
);
assert.ok(
  bookingDb.includes('isBookingStatus(job.lifecycle_status)'),
  'Raw email queue statuses must be filtered through the public vocabulary'
);
assert.ok(
  dashboard.includes('if (bookingLifecycleAccessForRole(session.role)') &&
    dashboard.includes('lifecycleIndicator?: BookingLifecycleIndicator'),
  'Operational indicators must remain optional and staff-role gated'
);
for (const source of [details, table]) {
  assert.ok(
    source.includes('BOOKING_STATUS_LABELS'),
    'Customer-visible status rendering must use canonical labels'
  );
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      publicStatusCount: publicStatuses.length,
      publicStatuses,
      internalAttemptStatesExposedAsStatus: false,
      internalOperationStatesExposedToCustomers: false,
      runtimeDatabaseBoundary: true,
      statusEmailQueueBoundary: true,
    },
    null,
    2
  )
);
