import { spawnSync } from 'node:child_process';

const verifiers = [
  'verify-booking-due-deadline-index.mjs',
  'verify-booking-due-expiry-query.mjs',
  'verify-booking-expiry-keyset-pagination.mjs',
  'verify-booking-expiry-concurrent-claims.mjs',
  'verify-booking-expiry-time-budget-worker.mjs',
  'verify-booking-expiry-worker-runs.mjs',
  'verify-booking-unconfirmed-observation-paths.mjs',
  'verify-booking-expiry-atomic-outbox.mjs',
  'verify-booking-derived-lifecycle-metrics.mjs',
  'verify-booking-scheduler-bounds.mjs',
  'verify-booking-phase8-scale-plan.mjs',
];

for (const verifier of verifiers) {
  const result = spawnSync(process.execPath, [`scripts/${verifier}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      verifierCount: verifiers.length,
      oldest500Starvation: false,
      concurrentDuplicateExpiry: false,
      bookingRowMaterialization: false,
      boundedProtectedScheduler: true,
    },
    null,
    2
  )
);
