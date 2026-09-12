import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const backupDirectory = path.join(process.cwd(), 'backups');
const snapshots = fs
  .readdirSync(backupDirectory)
  .filter((name) => /^booking-remediation-\d{4}-.*\.json$/.test(name))
  .sort();
assert.ok(snapshots.length > 0, 'A protected remediation snapshot is required');
const snapshot = JSON.parse(
  fs.readFileSync(path.join(backupDirectory, snapshots.at(-1)), 'utf8')
);
assert.equal(snapshot.format, 'kaliganj-travels-booking-remediation-snapshot-v1');

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0044_booking_lifecycle_observability.sql'
  ),
  'utf8'
);
const model = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0043_booking_lifecycle_internal_model.sql'
  ),
  'utf8'
);

const projected = [];
for (const booking of snapshot.tables.flight_bookings) {
  if (booking.operation_kind === 'reconciliation' && booking.operation_reason) {
    const caseType = {
      legacy_reconciliation: 'legacy_review',
      terminal_state_conflict: 'terminal_conflict',
      direct_ticket_payment_reconciliation: 'direct_ticket_payment_failure',
      cancellation_reconciliation: 'cancellation_uncertainty',
    }[booking.operation_reason] ?? 'ticketing_uncertainty';
    projected.push({ subject: `booking:${booking.id}`, caseType });
  }
  if (booking.status === 'cancelled' && !booking.cancelled_at) {
    projected.push({
      subject: `booking:${booking.id}`,
      caseType: 'historical_inconsistency',
    });
  }
  if (
    booking.status === 'cancelled' &&
    Number(booking.captured_amount) > Number(booking.refunded_amount)
  ) {
    projected.push({ subject: `booking:${booking.id}`, caseType: 'terminal_conflict' });
  }
  if (booking.status === 'confirmed' && booking.payment_state === 'unpaid') {
    projected.push({
      subject: `booking:${booking.id}`,
      caseType:
        booking.import_source === 'IMP_EXP'
          ? 'imported_payment_conflict'
          : 'direct_ticket_payment_failure',
    });
  }
}
for (const attempt of snapshot.tables.booking_attempts) {
  if (!['submitting', 'unknown'].includes(attempt.state)) continue;
  projected.push({ subject: `attempt:${attempt.id}`, caseType: 'attempt_uncertainty' });
}

const keys = projected.map((item) => `${item.subject}:${item.caseType}`);
assert.equal(new Set(keys).size, keys.length, 'Backfill projected a duplicate open case');
assert.equal(
  projected.filter((item) => item.subject.startsWith('booking:')).length,
  10,
  'Current nine affected bookings should project ten anomaly cases'
);
assert.equal(
  projected.filter((item) => item.subject.startsWith('attempt:')).length,
  1,
  'Only the aged unresolved attempt should project an attempt case'
);

for (const required of [
  "booking.operation_kind = 'reconciliation'",
  "attempt.state in ('submitting', 'unknown')",
  "'cancelled_missing_authoritative_timestamp'",
  "'cancelled_with_outstanding_captured_funds'",
  "'imported_confirmed_unpaid'",
  'on conflict do nothing',
]) {
  assert.ok(migration.includes(required), `Case backfill omits ${required}`);
}
for (const required of [
  'booking_reconciliation_cases_one_open_booking_type_idx',
  'booking_reconciliation_cases_one_open_attempt_type_idx',
]) {
  assert.ok(model.includes(required), `Case uniqueness omits ${required}`);
}

const counts = Object.fromEntries(
  [...new Set(projected.map((item) => item.caseType))]
    .sort()
    .map((caseType) => [
      caseType,
      projected.filter((item) => item.caseType === caseType).length,
    ])
);
console.log(
  JSON.stringify(
    {
      checks: 'passed',
      affectedBookings: snapshot.tables.flight_bookings.length,
      projectedBookingCases: 10,
      projectedAttemptCases: 1,
      caseTypes: counts,
      duplicateOpenCaseKeys: 0,
      productionMutations: false,
      sensitiveRowsPrinted: false,
    },
    null,
    2
  )
);
