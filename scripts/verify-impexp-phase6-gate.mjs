import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const verifiers = [
  'verify-impexp-on-hold-unpaid.mjs',
  'verify-impexp-confirm-operation.mjs',
  'verify-imported-ticketing-resolution.mjs',
  'verify-impexp-sync-nonfinancial.mjs',
  'verify-impexp-manual-completion.mjs',
  'verify-impexp-supplier-outcomes.mjs',
  'verify-impexp-financial-disposition.mjs',
  'verify-impexp-manual-ticket-escalation.mjs',
  'verify-impexp-direct-import-decision.mjs',
  'verify-impexp-pricing-invariants.mjs',
  'verify-manual-booking-import.mjs',
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
      importedOnHoldAutomaticCharge: false,
      issueNowWalletEffect: 'Available to Hold',
      resolutionCaptureCount: 1,
      resolutionReleaseCount: 1,
      supplierSyncWalletMutation: false,
      manualCompletionAdditionalDebit: 0,
      negativeManualTicketCapturedFundsHidden: false,
      directConfirmedDecisionExplicit: true,
      supplierGrossAndUserPayableSeparated: true,
      verifierCount: verifiers.length,
    },
    null,
    2
  )
);
