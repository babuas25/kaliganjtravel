import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const route = read('app', 'api', 'cron', 'booking-status-emails', 'route.ts');
const delivery = read('lib', 'email', 'booking-status-delivery.ts');
const cronMigration = read(
  'supabase',
  'migrations',
  '0042_supabase_booking_status_email_cron.sql'
);
const expiry = read(
  'supabase',
  'migrations',
  '0078_booking_expiry_keyset_pagination.sql'
);
const unconfirmed = read(
  'supabase',
  'migrations',
  '0080_booking_unconfirmed_observation_paths.sql'
);

for (const required of [
  'export const maxDuration = 120',
  'SCHEDULER_WORK_BUDGET_MS = 105_000',
  "status: 'skipped', reason: 'time_budget'",
  'remainingMs()',
  'processBookingOperationWatchdog(100)',
  'processBookingAttemptWatchdog(100)',
  'processImportedManualTicketEscalations(100)',
  'batchSize: 250',
  'maxBatches: 20',
  'repairUnconfirmedBookingObservations(50)',
  'recoverStaleBookingNotificationClaims(100)',
  'dispatchPendingBookingStatusEmails(25',
  'escalateBookingNotificationDeadLetters(100)',
  'withinWorkBudget',
]) {
  assert.ok(route.includes(required), `Protected scheduler omits ${required}`);
}
assert.match(route, /process\.env\.CRON_SECRET[\s\S]*?Bearer \$\{secret\}/i);
assert.ok(
  cronMigration.includes("'*/15 * * * *'") &&
    cronMigration.includes('/api/cron/booking-status-emails'),
  'Approved 15-minute protected scheduler cadence must remain unchanged'
);
for (const required of [
  'while (outboxesProcessed < normalizedLimit)',
  'timeBudgetMs - safetyMarginMs',
  'claimBookingNotificationOutboxes(1)',
  'processOutboxClaim(claims[0], 1)',
  "stopReason = 'time_budget'",
  "stopReason = 'drained'",
]) {
  assert.ok(delivery.includes(required), `Bounded delivery omits ${required}`);
}
assert.doesNotMatch(delivery, /while\s*\(true\)/);
assert.ok(
  expiry.includes("'derived-expired:v1:'") &&
    expiry.includes('on conflict do nothing') &&
    unconfirmed.includes("'derived-unconfirmed:repair:v1:'") &&
    unconfirmed.includes('on conflict do nothing'),
  'Derived observation batches must remain idempotent under scheduler replay'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      cadenceMinutes: 15,
      platformMaxSeconds: 120,
      workBudgetSeconds: 105,
      expiryBatchCap: 20,
      notificationClaimsAtOnce: 1,
      protectedByBearerSecret: true,
      replayIdempotent: true,
    },
    null,
    2
  )
);
