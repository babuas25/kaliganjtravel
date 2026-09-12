import type { SupplierEvidenceValidationResult } from '@/lib/booking-lifecycle/canonical-supplier-evidence-validation-v2';
import type { ReconciliationLocalContext } from '@/lib/booking-lifecycle/reconciliation-decisions';

export type ReconciliationConfirmationRequirement =
  | 'confirm_supplier_outcome'
  | 'confirm_held_nonissuance_basis'
  | 'confirm_terminal_correction'
  | 'confirm_supplier_identity_exception'
  | 'confirm_incomplete_evidence_exception'
  | 'confirm_legacy_review_path'
  | 'confirm_financial_disposition'
  | 'confirm_manual_resolution_basis';

export type ReconciliationConfirmationBoundary = {
  explicitStaffConfirmationRequired: true;
  makerCheckerRequired: boolean;
  resolutionBlocked: boolean;
  nextStep:
    | 'supplier_identity_recovery'
    | 'fresh_or_independent_evidence_required'
    | 'manual_conflict_review'
    | 'outcome_specific_proposal';
  requirements: ReconciliationConfirmationRequirement[];
  identityException: boolean;
  incompleteEvidenceException: boolean;
  legacyUncertainty: boolean;
  terminalCorrection: boolean;
  heldNonissuanceUnproven: boolean;
  financialReviewRequired: boolean;
  financialDispositionConfirmationRequired: boolean;
  genericResolveAllowed: false;
  evidenceReadMayResolve: false;
  statusMutationAllowed: false;
  walletMutationAllowed: false;
};

type CandidateOutcome =
  | 'ticketed'
  | 'cancelled'
  | 'held_not_ticketed'
  | 'still_held'
  | null;

const IDENTITY_ISSUE_CODES = new Set([
  'expected_unique_transaction_missing',
  'expected_pnr_missing',
  'expected_supplier_pnr_missing',
  'expected_booking_reference_missing',
  'expected_booking_code_missing',
  'expected_operational_reference_chain_missing',
  'expected_passenger_identity_missing',
  'expected_route_identity_missing',
  'expected_itinerary_identity_missing',
  'expected_supplier_financial_missing',
  'unique_transaction_mismatch',
  'pnr_mismatch',
  'booking_code_mismatch',
  'passenger_identity_mismatch',
  'route_identity_mismatch',
]);

/**
 * Describes the authorization boundary after an evidence read. This function
 * never grants resolution authority. It makes every exceptional or potentially
 * financial path explicit so a later outcome-specific proposal can enforce the
 * required confirmation and maker-checker controls.
 */
export function assessReconciliationConfirmationBoundary(input: {
  caseType: string;
  validation: SupplierEvidenceValidationResult;
  local: ReconciliationLocalContext;
  candidateOutcome: CandidateOutcome;
  financialReviewRequired: boolean;
}): ReconciliationConfirmationBoundary {
  const identityException =
    !input.validation.identityMatches ||
    input.validation.issues.some(
      (issue) =>
        issue.kind === 'mismatch' || IDENTITY_ISSUE_CODES.has(issue.code)
    );
  const incompleteEvidenceException =
    !identityException &&
    (!input.validation.valid ||
      !input.validation.complete ||
      !input.validation.fresh ||
      !input.validation.authoritativeFor);
  const legacyUncertainty = input.caseType === 'legacy_review';
  const heldNonissuanceUnproven =
    input.candidateOutcome === 'held_not_ticketed' ||
    input.candidateOutcome === 'still_held';
  const terminalCorrection =
    (input.candidateOutcome === 'ticketed' &&
      input.local.storedStatus === 'cancelled') ||
    (input.candidateOutcome === 'cancelled' &&
      input.local.storedStatus === 'confirmed') ||
    (heldNonissuanceUnproven &&
      (input.local.hasLocalTicketEvidence ||
        input.local.storedStatus === 'confirmed' ||
        input.local.storedStatus === 'cancelled'));
  const financialReviewRequired =
    input.financialReviewRequired ||
    input.local.paymentState !== 'unpaid' ||
    input.candidateOutcome === 'ticketed';

  const requirements = new Set<ReconciliationConfirmationRequirement>();
  if (input.candidateOutcome) requirements.add('confirm_supplier_outcome');
  if (heldNonissuanceUnproven) {
    requirements.add('confirm_held_nonissuance_basis');
  }
  if (terminalCorrection) requirements.add('confirm_terminal_correction');
  if (identityException) {
    requirements.add('confirm_supplier_identity_exception');
  }
  if (incompleteEvidenceException) {
    requirements.add('confirm_incomplete_evidence_exception');
  }
  if (legacyUncertainty) requirements.add('confirm_legacy_review_path');
  if (financialReviewRequired) {
    requirements.add('confirm_financial_disposition');
  }
  if (requirements.size === 0) {
    requirements.add('confirm_manual_resolution_basis');
  }

  const resolutionBlocked =
    identityException ||
    incompleteEvidenceException ||
    input.candidateOutcome === null;
  const nextStep = identityException
    ? 'supplier_identity_recovery'
    : incompleteEvidenceException
      ? 'fresh_or_independent_evidence_required'
      : terminalCorrection || legacyUncertainty
        ? 'manual_conflict_review'
        : 'outcome_specific_proposal';

  return {
    explicitStaffConfirmationRequired: true,
    makerCheckerRequired:
      terminalCorrection ||
      identityException ||
      incompleteEvidenceException ||
      legacyUncertainty ||
      heldNonissuanceUnproven ||
      financialReviewRequired,
    resolutionBlocked,
    nextStep,
    requirements: Array.from(requirements),
    identityException,
    incompleteEvidenceException,
    legacyUncertainty,
    terminalCorrection,
    heldNonissuanceUnproven,
    financialReviewRequired,
    financialDispositionConfirmationRequired: financialReviewRequired,
    genericResolveAllowed: false,
    evidenceReadMayResolve: false,
    statusMutationAllowed: false,
    walletMutationAllowed: false,
  };
}
