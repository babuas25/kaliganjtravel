import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const verifiers = [
  'verify-customer-public-status-boundary.mjs',
  'verify-customer-in-progress-messages.mjs',
  'verify-customer-processing-since.mjs',
  'verify-booking-lifecycle-timestamps.mjs',
  'verify-booking-in-progress-notification-grace.mjs',
  'verify-booking-notification-supersession.mjs',
  'verify-impexp-prompt-in-progress-notification.mjs',
  'verify-booking-notification-occurrence-delivery.mjs',
  'verify-booking-notification-reentry-policy.mjs',
  'verify-booking-notification-snapshot-rendering.mjs',
  'verify-booking-notification-partial-recipient-retry.mjs',
  'verify-booking-notification-hidden-bcc.mjs',
  'verify-booking-notification-resilience-metrics.mjs',
];

for (const verifier of verifiers) {
  const result = spawnSync(process.execPath, [`scripts/${verifier}`], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `${verifier} failed:\n${result.stdout}\n${result.stderr}`
  );
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      publicStatusCount: 7,
      ordinaryInProgressGraceSeconds: 120,
      fastFinalEmailCount: 1,
      importedPaidInProgressImmediate: true,
      occurrenceIdempotency: true,
      materialReentryEnabled: true,
      eventSnapshotRendering: true,
      successfulRecipientResentOnPartialFailure: false,
      hiddenBccEnvelopeOnly: true,
      retryDeadLetterMetricsEnabled: true,
      verifierCount: verifiers.length,
    },
    null,
    2
  )
);
