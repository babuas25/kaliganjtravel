import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0073_booking_notification_render_snapshot.sql'
);
const renderer = read('lib', 'email', 'booking-event-snapshot.ts');

for (const required of [
  'before insert on public.booking_notification_outbox',
  "- 'bookingSnapshot'",
  "'snapshotVersion', 1",
  "'lifecycleStatus', v_event.to_lifecycle_status",
  "'paymentState', v_booking.payment_state",
  "'processingSince'",
  "'issuedAt'",
  "'cancelledAt'",
  "'headerContact'",
  "'travellers', v_travellers",
]) {
  assert.ok(migration.includes(required), `Render snapshot omits ${required}`);
}
for (const passengerField of [
  'passengerType',
  'title',
  'firstName',
  'lastName',
  'gender',
  'dateOfBirth',
  'nationality',
]) {
  assert.ok(
    migration.includes(`'${passengerField}'`),
    `Minimized traveller omits ${passengerField}`
  );
}
assert.doesNotMatch(
  migration.slice(
    migration.indexOf("select coalesce(jsonb_agg(jsonb_build_object("),
    migration.indexOf('-- Remove any caller-provided bookingSnapshot')
  ),
  /passportNumber|passportExpiry|customerEmail|phoneCountryCode|'phone'/i,
  'Render snapshot must not retain unused passenger/contact secrets'
);
assert.match(
  migration,
  /pre_snapshot_cutover_legacy_delivery/i,
  'Unrenderable rollout-window intents must be retained as explicit non-send evidence'
);

for (const required of [
  'bookingEmailDocumentFromEventSnapshot',
  'bookingStatusEmailFromEventSnapshot',
  'eventSnapshotSchema.parse(eventSnapshot)',
  'snapshot.lifecycleStatus !== expectedStatus',
  'bookingStatusEmail(',
]) {
  assert.ok(renderer.includes(required), `Snapshot renderer omits ${required}`);
}
assert.doesNotMatch(
  renderer,
  /readBookingById|publicBookingWithHeaderContact|supabaseAdmin|\.from\(/,
  'Snapshot renderer must not read a newer booking/profile row'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      snapshotVersion: 1,
      capturedAtEventTransaction: true,
      recipientAddressesStored: false,
      passengerPassportFieldsStored: false,
      currentBookingReadDuringRender: false,
      statusSnapshotMismatchFailsClosed: true,
    },
    null,
    2
  )
);
