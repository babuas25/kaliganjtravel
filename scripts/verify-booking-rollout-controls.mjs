import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const config = read('lib', 'booking-lifecycle', 'rollout.ts');
const scheduler = read(
  'app',
  'api',
  'cron',
  'booking-status-emails',
  'route.ts'
);
const delivery = read('lib', 'email', 'booking-status-delivery.ts');

const environmentSwitches = [
  'BOOKING_LIFECYCLE_OPERATION_WORKERS_ENABLED',
  'BOOKING_LIFECYCLE_IMPORTED_WORKERS_ENABLED',
  'BOOKING_RECONCILIATION_ACTIONS_ENABLED',
  'BOOKING_IMPORTED_MANUAL_ACTIONS_ENABLED',
  'BOOKING_NOTIFICATION_OUTBOX_ENABLED',
  'BOOKING_LIFECYCLE_SCALABLE_SWEEP_ENABLED',
  'BOOKING_PNR_DEADLINE_REFRESH_ENABLED',
];
for (const name of environmentSwitches) {
  assert.match(config, new RegExp(`['\"]${name}['\"]`));
}
assert.doesNotMatch(config, /NEXT_PUBLIC_/);
assert.match(
  config,
  /process\.env\[BOOKING_LIFECYCLE_ROLLOUT_ENV\[feature\]\]\?\.trim\(\) === 'true'/,
  'Every server-side feature must fail closed unless its exact value is true'
);

assert.match(
  scheduler,
  /const rollout = bookingLifecycleRolloutState\(\)/
);
assert.match(scheduler, /rollout\.operationWorkers[\s\S]*?processBookingOperationWatchdog\(100\)/);
assert.match(scheduler, /rollout\.operationWorkers[\s\S]*?processBookingAttemptWatchdog\(100\)/);
assert.match(scheduler, /rollout\.importedWorkers[\s\S]*?processImportedManualTicketEscalations\(100\)/);
assert.match(scheduler, /rollout\.pnrDeadlineRefresh[\s\S]*?processBookingPnrRefreshJob\(\)/);
assert.match(scheduler, /rollout\.notificationOutbox[\s\S]*?recoverStaleBookingNotificationClaims\(100\)/);
assert.match(scheduler, /rollout\.notificationOutbox[\s\S]*?dispatchPendingBookingStatusEmails\(25/);
assert.match(scheduler, /rollout\.notificationOutbox[\s\S]*?escalateBookingNotificationDeadLetters\(100\)/);
assert.match(
  scheduler,
  /rollout\.scalableSweep[\s\S]*?processDerivedBookingStatusObservations\([\s\S]*?: await runStep\(5_000, \(\) => observeDerivedBookingStatuses\(500\)\)/,
  'Disabled scalable rollout must retain the bounded compatibility observer'
);
assert.match(scheduler, /reason: 'time_budget' \| 'rollout_disabled'/);
assert.ok(
  scheduler.indexOf("request.headers.get('authorization')") <
    scheduler.indexOf('bookingLifecycleRolloutState()'),
  'The scheduler must authenticate before exposing or evaluating rollout work'
);

for (const signature of [
  'sendBookingStatusEmailOnce',
  'dispatchBookingStatusEmails',
  'dispatchPendingBookingStatusEmails',
]) {
  const offset = delivery.indexOf(`function ${signature}`);
  assert.notEqual(offset, -1, `Missing ${signature}`);
  assert.match(
    delivery.slice(offset, offset + 900),
    /bookingLifecycleRolloutEnabled\('notificationOutbox'\)/,
    `${signature} must fail closed while occurrence delivery is disabled`
  );
}

const reconciliationRoutes = [
  ['evidence', 'route.ts'],
  ['reconciliation', 'proposal', 'route.ts'],
  ['reconciliation', 'decision', 'route.ts'],
  ['reconciliation', 'nonissuance-attestation', 'route.ts'],
];
for (const parts of reconciliationRoutes) {
  const route = read(
    'app',
    'api',
    'admin',
    'booking-lifecycle',
    '[reference]',
    ...parts
  );
  assert.match(route, /bookingLifecycleRolloutEnabled\('reconciliationActions'\)/);
  assert.match(route, /RECONCILIATION_ACTIONS_DISABLED/);
}

for (const name of [
  'authorize-charge',
  'complete-booking',
  'financial-disposition',
  'sync-booking',
]) {
  const route = read('app', 'api', 'impexp', name, 'route.ts');
  assert.match(route, /bookingLifecycleRolloutEnabled\(["']importedActions["']\)/);
  assert.match(route, /IMPORTED_MANUAL_ACTIONS_DISABLED/);
}
const importRoute = read('app', 'api', 'impexp', 'import-booking', 'route.ts');
assert.match(
  importRoute,
  /parsed\.data\.importDecision === "import_and_charge"[\s\S]*?bookingLifecycleRolloutEnabled\("importedActions"\)/
);
assert.match(importRoute, /IMPORTED_MANUAL_ACTIONS_DISABLED/);
assert.doesNotMatch(
  importRoute,
  /parsed\.data\.importDecision === "import_only"[\s\S]{0,200}?IMPORTED_MANUAL_ACTIONS_DISABLED/,
  'Import Only must remain available while manual financial actions are staged off'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      serverOnlySwitches: environmentSwitches.length,
      independentlyControlledSchedulerFamilies: 5,
      guardedReconciliationRoutes: reconciliationRoutes.length,
      guardedImportedRoutes: 5,
      notificationEntryPointsFailClosed: 3,
      compatibilityObserverRetained: true,
    },
    null,
    2
  )
);
