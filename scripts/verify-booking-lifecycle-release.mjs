import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
);

const checks = [
  'verify:migration-order',
  'verify:booking-lifecycle',
  'verify:booking-observability',
  'verify:booking-operation',
  'verify:booking-attempt-reconciliation',
  'verify:booking-post-write-finalization',
  'verify:booking-issue-ui-recovery',
  'verify:supplier-write-uncertainty',
  'verify:reconciliation-observations',
  'verify:supplier-evidence-contracts',
  'verify:supplier-evidence-validation',
  'verify:booking-evidence-read',
  'verify:booking-reconciliation-decisions',
  'verify:booking-no-change-closure',
  'verify:booking-confirmation-boundary',
  'verify:booking-sync-protection',
  'verify:booking-reconciliation-audit',
  'verify:booking-reconciliation-permissions',
  'verify:booking-maker-checker',
  'verify:booking-stale-approved-proposal-supersession',
  'verify:booking-reconciliation-superseded-terminal-compatibility',
  'verify:booking-resolution-contracts',
  'verify:booking-reconciliation-db-authorization',
  'verify:booking-reconciliation-lock-order',
  'verify:booking-ticketed-reconciliation',
  'verify:booking-nonissuance-reconciliation',
  'verify:booking-unpaid-cancellation-reconciliation',
  'verify:booking-held-cancellation-reconciliation',
  'verify:booking-captured-cancellation-reconciliation',
  'verify:booking-terminal-corrections',
  'verify:booking-reconciliation-release-guard',
  'verify:booking-reconciliation-refund-guard',
  'verify:booking-lifecycle-atomic-outbox',
  'verify:impexp-confirm-operation',
  'verify:impexp-customer-status',
  'verify:impexp-manual-task',
  'verify:impexp-on-hold-unpaid',
  'verify:impexp-sync-nonfinancial',
  'verify:impexp-manual-completion',
  'verify:impexp-supplier-outcomes',
  'verify:impexp-financial-disposition',
  'verify:impexp-manual-ticket-escalation',
  'verify:impexp-direct-import-decision',
  'verify:impexp-pricing-invariants',
  'verify:impexp-phase6-gate',
  'verify:customer-public-status-boundary',
  'verify:customer-in-progress-messages',
  'verify:customer-processing-since',
  'verify:booking-lifecycle-timestamps',
  'verify:booking-in-progress-grace',
  'verify:booking-notification-supersession',
  'verify:impexp-prompt-in-progress-notification',
  'verify:booking-notification-occurrence-delivery',
  'verify:booking-notification-reentry',
  'verify:booking-notification-snapshot-rendering',
  'verify:booking-notification-partial-retry',
  'verify:booking-notification-hidden-bcc',
  'verify:booking-notification-resilience',
  'verify:booking-phase7-gate',
  'verify:booking-due-deadline-index',
  'verify:booking-due-expiry-query',
  'verify:booking-expiry-keyset',
  'verify:booking-expiry-concurrency',
  'verify:booking-expiry-time-budget',
  'verify:booking-expiry-worker-runs',
  'verify:booking-unconfirmed-paths',
  'verify:booking-expiry-atomic-outbox',
  'verify:booking-derived-lifecycle-metrics',
  'verify:booking-scheduler-bounds',
  'verify:booking-phase8-gate',
  'verify:booking-phase8-scale-plan',
  'verify:booking-email',
  'verify:pnr-deadline',
  'verify:booking-pnr-refresh',
  'verify:wallet',
  'verify:impexp-wallet',
  'verify:booking-lifecycle-documentation',
  'verify:booking-rollout-controls',
];

const forbidden = new Set([
  'verify:booking-lifecycle:live',
  'verify:wallet:live',
  'verify:email',
]);
assert.equal(
  checks.some((name) => forbidden.has(name)),
  false,
  'Release matrix must not include mutating live or email-send utilities'
);

const startedAt = Date.now();
for (const name of checks) {
  const command = packageJson.scripts[name];
  assert.match(command ?? '', /^node\s+\S+\.mjs$/, `Unsupported verifier command: ${name}`);
  const script = command.replace(/^node\s+/, '');
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    env: { ...process.env, CIRCLE_NODE_TOTAL: '1' },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(`Release verifier failed: ${name}\n`);
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    process.exit(result.status ?? 1);
  }
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      verifierCount: checks.length,
      mutatingLiveVerifiers: 0,
      emailSendUtilities: 0,
      durationMs: Date.now() - startedAt,
    },
    null,
    2
  )
);
