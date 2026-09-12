import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const authority = read(
  'supabase',
  'migrations',
  '0031_booking_lifecycle_authority.sql'
);
const sync = read(
  'supabase',
  'migrations',
  '0048_booking_supplier_sync_protection.sql'
);
const migration = read(
  'supabase',
  'migrations',
  '0080_booking_unconfirmed_observation_paths.sql'
);
const adapter = read('lib', 'db', 'flight-bookings.ts');
const cron = read('app', 'api', 'cron', 'booking-status-emails', 'route.ts');

assert.match(
  authority,
  /record_initial_booking_status_event[\s\S]*?resolve_booking_lifecycle[\s\S]*?'booking-created'/i,
  'Booking creation must record its resolver-derived Unconfirmed lifecycle'
);
assert.match(
  sync,
  /record_booking_pnr_refresh_v2[\s\S]*?v_after_lifecycle is distinct from v_before_lifecycle[\s\S]*?insert into public\.booking_status_events/i,
  'PNR Sync must record a changed Unconfirmed lifecycle in its transaction'
);
for (const required of [
  'ensure_import_sync_unconfirmed_event_v1',
  "new.import_source is distinct from 'IMP_EXP'",
  ") <> 'unconfirmed'",
  "'import-sync-unconfirmed:v1:'",
  'flight_bookings_unconfirmed_repair_idx',
  'record_unconfirmed_booking_repair_batch_v1',
  'for update of booking skip locked',
  "'notificationDisposition', 'audit_only'",
  "'suppressionReason', 'case_only_repair'",
]) {
  assert.ok(migration.includes(required), `Unconfirmed path omits ${required}`);
}
const repairStart = migration.indexOf(
  'create or replace function public.record_unconfirmed_booking_repair_batch_v1'
);
const repair = migration.slice(repairStart);
assert.doesNotMatch(
  repair,
  /update public\.flight_bookings/i,
  'Unconfirmed repair must not materialize the derived status on booking rows'
);
assert.ok(
  adapter.includes('repairUnconfirmedBookingObservations') &&
    cron.includes('repairUnconfirmedBookingObservations(50)'),
  'Protected scheduler must run only a small Unconfirmed repair backstop batch'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      primaryPaths: ['booking_creation', 'pnr_sync', 'import_sync'],
      repairBatchLimit: 50,
      repairNotificationPolicy: 'audit_only',
      storedDerivedStatusMutation: false,
    },
    null,
    2
  )
);
