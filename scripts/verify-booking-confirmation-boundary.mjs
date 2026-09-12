import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const modulePath = path.join(
  process.cwd(),
  'lib',
  'booking-lifecycle',
  'reconciliation-confirmation-boundary.ts'
);
const source = fs.readFileSync(modulePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: modulePath,
  reportDiagnostics: true,
});
assert.equal(
  (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  ).length,
  0
);
const loaded = { exports: {} };
new vm.Script(transpiled.outputText, { filename: modulePath }).runInNewContext({
  module: loaded,
  exports: loaded.exports,
  Set,
  Array,
});
const { assessReconciliationConfirmationBoundary } = loaded.exports;

const local = (storedStatus = 'in-progress', paymentState = 'unpaid') => ({
  storedStatus,
  paymentState,
  hasLocalTicketEvidence: storedStatus === 'confirmed',
});
const validation = (overrides = {}) => ({
  valid: true,
  complete: true,
  fresh: true,
  identityMatches: true,
  authoritativeFor: 'cancelled',
  issues: [],
  ...overrides,
});
const assess = (overrides = {}) =>
  assessReconciliationConfirmationBoundary({
    caseType: 'cancellation_uncertainty',
    validation: validation(),
    local: local(),
    candidateOutcome: 'cancelled',
    financialReviewRequired: false,
    ...overrides,
  });

const terminal = assess({
  local: local('confirmed', 'captured'),
});
assert.equal(terminal.terminalCorrection, true);
assert.equal(terminal.makerCheckerRequired, true);
assert.ok(terminal.requirements.includes('confirm_terminal_correction'));
assert.ok(terminal.requirements.includes('confirm_financial_disposition'));

const identity = assess({
  validation: validation({
    valid: false,
    identityMatches: false,
    authoritativeFor: null,
    issues: [
      { code: 'unique_transaction_mismatch', kind: 'mismatch', source: 'pnr' },
    ],
  }),
  candidateOutcome: null,
});
assert.equal(identity.identityException, true);
assert.equal(identity.resolutionBlocked, true);
assert.equal(identity.nextStep, 'supplier_identity_recovery');
assert.ok(identity.requirements.includes('confirm_supplier_identity_exception'));

const incomplete = assess({
  validation: validation({
    valid: false,
    complete: false,
    authoritativeFor: null,
    issues: [
      { code: 'air_ticketing_evidence_missing', kind: 'missing', source: 'evidence-set' },
    ],
  }),
  candidateOutcome: null,
});
assert.equal(incomplete.incompleteEvidenceException, true);
assert.equal(incomplete.resolutionBlocked, true);
assert.equal(incomplete.nextStep, 'fresh_or_independent_evidence_required');

const legacy = assess({
  caseType: 'legacy_review',
  candidateOutcome: 'ticketed',
  validation: validation({ authoritativeFor: 'ticketed' }),
});
assert.equal(legacy.legacyUncertainty, true);
assert.equal(legacy.makerCheckerRequired, true);
assert.ok(legacy.requirements.includes('confirm_legacy_review_path'));

const held = assess({
  candidateOutcome: 'held_not_ticketed',
  validation: validation({ authoritativeFor: 'held' }),
});
assert.equal(held.heldNonissuanceUnproven, true);
assert.ok(held.requirements.includes('confirm_held_nonissuance_basis'));

const financial = assess({
  local: local('in-progress', 'held'),
  financialReviewRequired: true,
});
assert.equal(financial.financialDispositionConfirmationRequired, true);
assert.ok(financial.requirements.includes('confirm_financial_disposition'));

for (const boundary of [terminal, identity, incomplete, legacy, held, financial]) {
  assert.equal(boundary.explicitStaffConfirmationRequired, true);
  assert.equal(boundary.genericResolveAllowed, false);
  assert.equal(boundary.evidenceReadMayResolve, false);
  assert.equal(boundary.statusMutationAllowed, false);
  assert.equal(boundary.walletMutationAllowed, false);
}

const evidenceReader = fs.readFileSync(
  path.join(process.cwd(), 'components', 'dashboard', 'bookings', 'BookingEvidenceReader.tsx'),
  'utf8'
);
assert.match(evidenceReader, /Controlled next step/);
assert.match(evidenceReader, /A different authorized approver is required/);
assert.doesNotMatch(evidenceReader, />\s*Resolve\s*</i);

const evidenceRoute = fs.readFileSync(
  path.join(process.cwd(), 'app', 'api', 'admin', 'booking-lifecycle', '[reference]', 'evidence', 'route.ts'),
  'utf8'
);
assert.doesNotMatch(
  evidenceRoute,
  /walletCapture|walletRelease|walletRefund|setBookingStatus|resolve_booking_reconciliation/i
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      coveredRisks: [
        'terminal_correction',
        'identity_exception',
        'incomplete_evidence',
        'legacy_uncertainty',
        'held_nonissuance',
        'financial_consequence',
      ],
      explicitStaffConfirmationRequired: true,
      makerCheckerRequiredForHighRisk: true,
      genericResolveAllowed: false,
      statusMutationAllowed: false,
      walletMutationAllowed: false,
    },
    null,
    2
  )
);
