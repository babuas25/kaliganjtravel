import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const sourcePath = path.join(
  process.cwd(),
  'lib',
  'booking-lifecycle',
  'reconciliation-decisions.ts'
);
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
  reportDiagnostics: true,
});
assert.equal(
  (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  ).length,
  0
);
const module = { exports: {} };
new vm.Script(transpiled.outputText, { filename: sourcePath }).runInNewContext({
  module,
  exports: module.exports,
});
const {
  classifyCancellationReconciliation,
  classifyLegacyReconciliation,
  classifyTicketingReconciliation,
} = module.exports;

const local = {
  storedStatus: 'in-progress',
  paymentState: 'reconciliation',
  hasLocalTicketEvidence: false,
};
const validation = (authoritativeFor) => ({
  valid: true,
  complete: true,
  fresh: true,
  identityMatches: true,
  authoritativeFor,
  issues: [],
});

const ticketed = classifyTicketingReconciliation({
  validation: validation('ticketed'),
  local,
});
assert.equal(ticketed.outcome, 'ticketed');
assert.equal(ticketed.supplierTruthAuthoritative, true);
assert.equal(ticketed.explicitStaffConfirmationRequired, true);
assert.equal(ticketed.financialReviewRequired, true);

const cancelled = classifyTicketingReconciliation({
  validation: validation('cancelled'),
  local,
});
assert.equal(cancelled.outcome, 'cancelled');
assert.equal(cancelled.supplierTruthAuthoritative, true);

const held = classifyTicketingReconciliation({
  validation: validation('held'),
  local,
});
assert.equal(held.outcome, 'held_not_ticketed');
assert.equal(held.supplierTruthAuthoritative, false);
assert.equal(held.explicitStaffConfirmationRequired, true);
assert.equal(
  held.reasonCode,
  'held_requires_explicit_nonissuance_confirmation'
);

const incomplete = classifyTicketingReconciliation({
  validation: {
    valid: false,
    complete: false,
    fresh: true,
    identityMatches: true,
    authoritativeFor: null,
    issues: [
      { code: 'air_ticketing_evidence_missing', kind: 'missing', source: 'evidence-set' },
    ],
  },
  local,
});
assert.equal(incomplete.outcome, 'unresolved_conflicting');
assert.equal(incomplete.evidenceAssessment, 'incomplete_or_stale');

const mismatch = classifyTicketingReconciliation({
  validation: {
    valid: false,
    complete: true,
    fresh: true,
    identityMatches: false,
    authoritativeFor: null,
    issues: [
      { code: 'unique_transaction_mismatch', kind: 'mismatch', source: 'pnr' },
    ],
  },
  local,
});
assert.equal(mismatch.outcome, 'unresolved_conflicting');
assert.equal(mismatch.evidenceAssessment, 'identity_or_supplier_conflict');

for (const [candidate, conflictingLocal] of [
  [
    'ticketed',
    { storedStatus: 'cancelled', paymentState: 'captured', hasLocalTicketEvidence: false },
  ],
  [
    'cancelled',
    { storedStatus: 'confirmed', paymentState: 'captured', hasLocalTicketEvidence: true },
  ],
  [
    'held',
    { storedStatus: 'in-progress', paymentState: 'held', hasLocalTicketEvidence: true },
  ],
]) {
  const conflict = classifyTicketingReconciliation({
    validation: validation(candidate),
    local: conflictingLocal,
  });
  assert.equal(conflict.outcome, 'unresolved_conflicting');
  assert.equal(conflict.evidenceAssessment, 'local_terminal_conflict');
  assert.ok(conflict.candidateOutcome);
}

for (const decision of [ticketed, cancelled, held, incomplete, mismatch]) {
  assert.equal(decision.automaticResolutionAllowed, false);
  assert.equal(decision.statusMutationAllowed, false);
  assert.equal(decision.walletMutationAllowed, false);
}

const cancellationCancelled = classifyCancellationReconciliation({
  validation: validation('cancelled'),
  local,
});
assert.equal(cancellationCancelled.outcome, 'cancelled');
assert.equal(cancellationCancelled.supplierTruthAuthoritative, true);
assert.equal(cancellationCancelled.explicitStaffConfirmationRequired, true);

const cancellationTicketed = classifyCancellationReconciliation({
  validation: validation('ticketed'),
  local,
});
assert.equal(cancellationTicketed.outcome, 'ticketed');
assert.equal(cancellationTicketed.supplierTruthAuthoritative, true);

const cancellationHeld = classifyCancellationReconciliation({
  validation: validation('held'),
  local,
});
assert.equal(cancellationHeld.outcome, 'still_held');
assert.equal(cancellationHeld.supplierTruthAuthoritative, false);
assert.equal(
  cancellationHeld.reasonCode,
  'cancellation_not_proven_booking_still_held'
);

const cancellationIncomplete = classifyCancellationReconciliation({
  validation: incomplete.validation ?? {
    valid: false,
    complete: false,
    fresh: true,
    identityMatches: true,
    authoritativeFor: null,
    issues: [
      { code: 'pnr_evidence_missing', kind: 'missing', source: 'evidence-set' },
    ],
  },
  local,
});
assert.equal(cancellationIncomplete.outcome, 'unresolved_conflicting');

const ticketedTerminalConflict = classifyCancellationReconciliation({
  validation: validation('ticketed'),
  local: {
    storedStatus: 'cancelled',
    paymentState: 'captured',
    hasLocalTicketEvidence: true,
  },
});
assert.equal(ticketedTerminalConflict.outcome, 'unresolved_conflicting');
assert.equal(
  ticketedTerminalConflict.evidenceAssessment,
  'local_terminal_conflict'
);

const heldTicketConflict = classifyCancellationReconciliation({
  validation: validation('held'),
  local: {
    storedStatus: 'in-progress',
    paymentState: 'held',
    hasLocalTicketEvidence: true,
  },
});
assert.equal(heldTicketConflict.outcome, 'unresolved_conflicting');

const confirmedToCancelled = classifyCancellationReconciliation({
  validation: validation('cancelled'),
  local: {
    storedStatus: 'confirmed',
    paymentState: 'captured',
    hasLocalTicketEvidence: true,
  },
});
assert.equal(confirmedToCancelled.outcome, 'cancelled');
assert.equal(confirmedToCancelled.terminalCorrectionRequired, true);

for (const decision of [
  cancellationCancelled,
  cancellationTicketed,
  cancellationHeld,
  cancellationIncomplete,
  ticketedTerminalConflict,
  heldTicketConflict,
  confirmedToCancelled,
]) {
  assert.equal(decision.automaticResolutionAllowed, false);
  assert.equal(decision.statusMutationAllowed, false);
  assert.equal(decision.walletMutationAllowed, false);
}

const legacyTicketed = classifyLegacyReconciliation({
  validation: validation('ticketed'),
  local,
});
assert.equal(legacyTicketed.classification, 'ticketed_candidate');
assert.equal(legacyTicketed.reviewPath, 'ticketing_resolution');
assert.equal(legacyTicketed.supplierTruthAuthoritative, true);

const legacyCancelled = classifyLegacyReconciliation({
  validation: validation('cancelled'),
  local,
});
assert.equal(legacyCancelled.classification, 'cancelled_candidate');
assert.equal(legacyCancelled.reviewPath, 'cancellation_resolution');

const legacyHeld = classifyLegacyReconciliation({
  validation: validation('held'),
  local,
});
assert.equal(legacyHeld.classification, 'held_candidate');
assert.equal(legacyHeld.reviewPath, 'held_nonissuance_review');
assert.equal(legacyHeld.supplierTruthAuthoritative, false);

const legacyIdentityMissing = classifyLegacyReconciliation({
  validation: {
    valid: false,
    complete: false,
    fresh: true,
    identityMatches: false,
    authoritativeFor: null,
    issues: [
      { code: 'expected_pnr_missing', kind: 'missing', source: 'evidence-set' },
    ],
  },
  local,
});
assert.equal(legacyIdentityMissing.classification, 'identity_incomplete');
assert.equal(legacyIdentityMissing.reviewPath, 'supplier_identity_recovery');

const legacyIncomplete = classifyLegacyReconciliation({
  validation: {
    valid: false,
    complete: false,
    fresh: false,
    identityMatches: true,
    authoritativeFor: null,
    issues: [
      { code: 'evidence_stale', kind: 'stale', source: 'pnr' },
    ],
  },
  local,
});
assert.equal(legacyIncomplete.classification, 'evidence_incomplete');
assert.equal(legacyIncomplete.reviewPath, 'fresh_evidence_required');

const legacyConflict = classifyLegacyReconciliation({
  validation: validation('ticketed'),
  local: {
    storedStatus: 'cancelled',
    paymentState: 'captured',
    hasLocalTicketEvidence: true,
  },
});
assert.equal(legacyConflict.classification, 'conflicting_unresolved');
assert.equal(legacyConflict.reviewPath, 'manual_conflict_review');
assert.equal(legacyConflict.candidateOutcome, 'ticketed');

for (const classification of [
  legacyTicketed,
  legacyCancelled,
  legacyHeld,
  legacyIdentityMissing,
  legacyIncomplete,
  legacyConflict,
]) {
  assert.equal(classification.explicitOutcomeActionRequired, true);
  assert.equal(classification.makerCheckerRequired, true);
  assert.equal(classification.genericResolveAllowed, false);
  assert.equal(classification.automaticResolutionAllowed, false);
  assert.equal(classification.statusMutationAllowed, false);
  assert.equal(classification.walletMutationAllowed, false);
}

const evidenceRoute = fs.readFileSync(
  path.join(
    process.cwd(),
    'app',
    'api',
    'admin',
    'booking-lifecycle',
    '[reference]',
    'evidence',
    'route.ts'
  ),
  'utf8'
);
assert.doesNotMatch(
  evidenceRoute,
  /resolve|finalize|syncPnrDetails|syncAirTicketingDetails|walletCapture|walletRelease/
);
const evidenceComponent = fs.readFileSync(
  path.join(
    process.cwd(),
    'components',
    'dashboard',
    'bookings',
    'BookingEvidenceReader.tsx'
  ),
  'utf8'
);
assert.doesNotMatch(evidenceComponent, />\s*Resolve\s*</i);
assert.doesNotMatch(evidenceComponent, /\/resolve(?:\W|$)/i);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      outcomes: [
        'ticketed',
        'held_not_ticketed',
        'cancelled',
        'unresolved_conflicting',
      ],
      cancellationOutcomes: [
        'cancelled',
        'still_held',
        'ticketed',
        'unresolved_conflicting',
      ],
      legacyClassifications: [
        'ticketed_candidate',
        'cancelled_candidate',
        'held_candidate',
        'identity_incomplete',
        'evidence_incomplete',
        'conflicting_unresolved',
      ],
      legacyGenericResolveAllowed: false,
      heldRequiresNonissuanceConfirmation: true,
      terminalConflictFailsClosed: true,
      automaticResolutionAllowed: false,
      statusMutationAllowed: false,
      walletMutationAllowed: false,
    },
    null,
    2
  )
);
