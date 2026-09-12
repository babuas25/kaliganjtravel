import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const bookingType = read('lib', 'flights', 'booking.ts');
const bookingDb = read('lib', 'db', 'flight-bookings.ts');
const dashboard = read('lib', 'dashboard', 'bookings.ts');
const details = read('components', 'flights', 'BookingDetails.tsx');
const email = read('lib', 'email', 'booking-template.ts');
const ordinaryWriter = read(
  'supabase',
  'migrations',
  '0031_booking_lifecycle_authority.sql'
);
const operationIdentity = read(
  'supabase',
  'migrations',
  '0045_booking_operation_claims.sql'
);
const importedWriter = read(
  'supabase',
  'migrations',
  '0062_impexp_confirm_manual_ticket_operation.sql'
);

for (const required of [
  'processingSince?: string | null',
  'Actual active-operation claim/start instant',
]) {
  assert.ok(bookingType.includes(required), `Public booking omits ${required}`);
}
assert.ok(
  bookingDb.includes(
    "status === 'in-progress' ? row.operation_started_at : null"
  ),
  'Public booking must use the persisted operation start only for In Progress'
);
assert.doesNotMatch(
  bookingDb,
  /processingSince:[\s\S]{0,120}(?:submission_started_at|created_at)/,
  'Processing Since must not fall back to booking/submission creation time'
);
assert.ok(
  dashboard.includes(
    "if (status === 'in-progress') return row.operation_started_at;"
  ),
  'Booking-list lifecycle time must use operation start'
);
assert.ok(
  details.includes("['Processing since', booking.processingSince]"),
  'Booking detail must label the actual operation start'
);
assert.ok(
  email.includes(
    "if (status === 'in-progress') return booking.processingSince ?? null;"
  ) && email.includes("activityLabel: 'Processing Since'"),
  'In Progress email must use the operation start'
);

for (const required of [
  "operation_started_at = now()",
  "status = 'in-progress'",
]) {
  assert.ok(
    ordinaryWriter.includes(required),
    `Ordinary operation writer omits ${required}`
  );
}
assert.ok(
  operationIdentity.includes(
    'external_action_due_at, policy_version, claimed_at'
  ) && operationIdentity.includes('p_external_action_due_at, 1, now()'),
  'Durable operation identity must persist the actual claim instant'
);
assert.ok(
  importedWriter.includes('operation_started_at = v_now') &&
    importedWriter.includes('policy_version, claimed_at, external_action_due_at'),
  'Imported manual ticketing must share one operation-start/claim instant'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      pageProcessingSince: 'operation_started_at',
      listLifecycleTime: 'operation_started_at',
      emailProcessingSince: 'processingSince',
      bookingCreatedFallbackUsed: false,
      importedClaimTimeAligned: true,
    },
    null,
    2
  )
);
