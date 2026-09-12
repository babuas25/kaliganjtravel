import type { SupplierEvidenceValidationResult } from '@/lib/booking-lifecycle/canonical-supplier-evidence-validation-v2';
import type { StoredBookingStatus } from '@/lib/flights/booking-status';

export type ReconciliationLocalContext = {
  storedStatus: StoredBookingStatus;
  paymentState: string;
  hasLocalTicketEvidence: boolean;
};

export type TicketingReconciliationOutcome =
  | 'ticketed'
  | 'held_not_ticketed'
  | 'cancelled'
  | 'unresolved_conflicting';

export type TicketingReconciliationDecision = {
  outcome: TicketingReconciliationOutcome;
  candidateOutcome: Exclude<
    TicketingReconciliationOutcome,
    'unresolved_conflicting'
  > | null;
  evidenceAssessment:
    | 'authoritative_positive'
    | 'held_positive_nonissuance_unproven'
    | 'incomplete_or_stale'
    | 'identity_or_supplier_conflict'
    | 'local_terminal_conflict';
  reasonCode: string;
  supplierTruthAuthoritative: boolean;
  explicitStaffConfirmationRequired: boolean;
  financialReviewRequired: boolean;
  automaticResolutionAllowed: false;
  statusMutationAllowed: false;
  walletMutationAllowed: false;
};

export type CancellationReconciliationOutcome =
  | 'cancelled'
  | 'still_held'
  | 'ticketed'
  | 'unresolved_conflicting';

export type CancellationReconciliationDecision = {
  outcome: CancellationReconciliationOutcome;
  candidateOutcome: Exclude<
    CancellationReconciliationOutcome,
    'unresolved_conflicting'
  > | null;
  evidenceAssessment:
    | 'authoritative_positive'
    | 'held_positive_nonissuance_unproven'
    | 'incomplete_or_stale'
    | 'identity_or_supplier_conflict'
    | 'local_terminal_conflict';
  reasonCode: string;
  supplierTruthAuthoritative: boolean;
  explicitStaffConfirmationRequired: boolean;
  financialReviewRequired: boolean;
  terminalCorrectionRequired: boolean;
  automaticResolutionAllowed: false;
  statusMutationAllowed: false;
  walletMutationAllowed: false;
};

export type LegacyEvidenceClassification = {
  classification:
    | 'ticketed_candidate'
    | 'cancelled_candidate'
    | 'held_candidate'
    | 'identity_incomplete'
    | 'evidence_incomplete'
    | 'conflicting_unresolved';
  candidateOutcome: 'ticketed' | 'cancelled' | 'held_not_ticketed' | null;
  reviewPath:
    | 'ticketing_resolution'
    | 'cancellation_resolution'
    | 'held_nonissuance_review'
    | 'supplier_identity_recovery'
    | 'fresh_evidence_required'
    | 'manual_conflict_review';
  reasonCode: string;
  supplierTruthAuthoritative: boolean;
  explicitOutcomeActionRequired: true;
  makerCheckerRequired: true;
  genericResolveAllowed: false;
  automaticResolutionAllowed: false;
  statusMutationAllowed: false;
  walletMutationAllowed: false;
};

const blocked = (
  input: Pick<
    TicketingReconciliationDecision,
    'candidateOutcome' | 'evidenceAssessment' | 'reasonCode'
  >
): TicketingReconciliationDecision => ({
  outcome: 'unresolved_conflicting',
  candidateOutcome: input.candidateOutcome,
  evidenceAssessment: input.evidenceAssessment,
  reasonCode: input.reasonCode,
  supplierTruthAuthoritative: false,
  // Invalid evidence cannot authorize a resolution. Any later manual
  // exception path must still capture an explicit staff confirmation.
  explicitStaffConfirmationRequired: true,
  financialReviewRequired: false,
  automaticResolutionAllowed: false,
  statusMutationAllowed: false,
  walletMutationAllowed: false,
});

/**
 * Classifies evidence for a ticketing-uncertainty case without resolving it.
 * Phase 4 decisions are advisory/read-only; Phase 5 owns protected status and
 * financial execution after explicit authorization.
 */
export function classifyTicketingReconciliation(input: {
  validation: SupplierEvidenceValidationResult;
  local: ReconciliationLocalContext;
}): TicketingReconciliationDecision {
  if (!input.validation.valid || !input.validation.authoritativeFor) {
    const conflict = input.validation.issues.some(
      (issue) => issue.kind === 'mismatch' || issue.kind === 'conflict'
    );
    return blocked({
      candidateOutcome: null,
      evidenceAssessment: conflict
        ? 'identity_or_supplier_conflict'
        : 'incomplete_or_stale',
      reasonCode: conflict
        ? 'supplier_evidence_conflicting'
        : 'supplier_evidence_incomplete_or_stale',
    });
  }

  const candidate =
    input.validation.authoritativeFor === 'held'
      ? 'held_not_ticketed'
      : input.validation.authoritativeFor;
  const localConflict =
    (candidate === 'ticketed' && input.local.storedStatus === 'cancelled') ||
    (candidate === 'cancelled' && input.local.storedStatus === 'confirmed') ||
    (candidate === 'held_not_ticketed' &&
      (input.local.hasLocalTicketEvidence ||
        input.local.storedStatus === 'confirmed' ||
        input.local.storedStatus === 'cancelled'));
  if (localConflict) {
    return blocked({
      candidateOutcome: candidate,
      evidenceAssessment: 'local_terminal_conflict',
      reasonCode: 'supplier_truth_conflicts_with_local_terminal_truth',
    });
  }

  if (candidate === 'held_not_ticketed') {
    return {
      outcome: candidate,
      candidateOutcome: candidate,
      evidenceAssessment: 'held_positive_nonissuance_unproven',
      reasonCode: 'held_requires_explicit_nonissuance_confirmation',
      // A PNR can positively prove Held, but one read cannot prove that no
      // separate ticket record exists. Never automate release from this alone.
      supplierTruthAuthoritative: false,
      explicitStaffConfirmationRequired: true,
      financialReviewRequired: true,
      automaticResolutionAllowed: false,
      statusMutationAllowed: false,
      walletMutationAllowed: false,
    };
  }

  return {
    outcome: candidate,
    candidateOutcome: candidate,
    evidenceAssessment: 'authoritative_positive',
    reasonCode:
      candidate === 'ticketed'
        ? 'complete_ticket_evidence_matches'
        : 'complete_cancellation_evidence_matches',
    supplierTruthAuthoritative: true,
    explicitStaffConfirmationRequired: true,
    financialReviewRequired: true,
    automaticResolutionAllowed: false,
    statusMutationAllowed: false,
    walletMutationAllowed: false,
  };
}

const blockedCancellation = (
  input: Pick<
    CancellationReconciliationDecision,
    'candidateOutcome' | 'evidenceAssessment' | 'reasonCode'
  >
): CancellationReconciliationDecision => ({
  outcome: 'unresolved_conflicting',
  candidateOutcome: input.candidateOutcome,
  evidenceAssessment: input.evidenceAssessment,
  reasonCode: input.reasonCode,
  supplierTruthAuthoritative: false,
  explicitStaffConfirmationRequired: true,
  financialReviewRequired: false,
  terminalCorrectionRequired: input.candidateOutcome !== null,
  automaticResolutionAllowed: false,
  statusMutationAllowed: false,
  walletMutationAllowed: false,
});

/** Classifies a cancellation-uncertainty read without changing local truth. */
export function classifyCancellationReconciliation(input: {
  validation: SupplierEvidenceValidationResult;
  local: ReconciliationLocalContext;
}): CancellationReconciliationDecision {
  if (!input.validation.valid || !input.validation.authoritativeFor) {
    const conflict = input.validation.issues.some(
      (issue) => issue.kind === 'mismatch' || issue.kind === 'conflict'
    );
    return blockedCancellation({
      candidateOutcome: null,
      evidenceAssessment: conflict
        ? 'identity_or_supplier_conflict'
        : 'incomplete_or_stale',
      reasonCode: conflict
        ? 'supplier_evidence_conflicting'
        : 'supplier_evidence_incomplete_or_stale',
    });
  }

  const candidate: Exclude<
    CancellationReconciliationOutcome,
    'unresolved_conflicting'
  > =
    input.validation.authoritativeFor === 'held'
      ? 'still_held'
      : input.validation.authoritativeFor;
  const terminalConflict =
    (candidate === 'ticketed' && input.local.storedStatus === 'cancelled') ||
    (candidate === 'still_held' &&
      (input.local.hasLocalTicketEvidence ||
        input.local.storedStatus === 'confirmed' ||
        input.local.storedStatus === 'cancelled'));
  if (terminalConflict) {
    return blockedCancellation({
      candidateOutcome: candidate,
      evidenceAssessment: 'local_terminal_conflict',
      reasonCode: 'supplier_truth_conflicts_with_local_terminal_truth',
    });
  }

  if (candidate === 'still_held') {
    return {
      outcome: candidate,
      candidateOutcome: candidate,
      evidenceAssessment: 'held_positive_nonissuance_unproven',
      reasonCode: 'cancellation_not_proven_booking_still_held',
      supplierTruthAuthoritative: false,
      explicitStaffConfirmationRequired: true,
      financialReviewRequired: true,
      terminalCorrectionRequired: false,
      automaticResolutionAllowed: false,
      statusMutationAllowed: false,
      walletMutationAllowed: false,
    };
  }

  return {
    outcome: candidate,
    candidateOutcome: candidate,
    evidenceAssessment: 'authoritative_positive',
    reasonCode:
      candidate === 'cancelled'
        ? 'complete_cancellation_evidence_matches'
        : 'ticket_evidence_proves_cancellation_not_effective',
    supplierTruthAuthoritative: true,
    explicitStaffConfirmationRequired: true,
    financialReviewRequired: true,
    terminalCorrectionRequired:
      candidate === 'cancelled' && input.local.storedStatus === 'confirmed',
    automaticResolutionAllowed: false,
    statusMutationAllowed: false,
    walletMutationAllowed: false,
  };
}

/**
 * Legacy evidence can select a controlled review path, never a generic status
 * setter. Historical identity gaps and contradictions remain explicit cases.
 */
export function classifyLegacyReconciliation(input: {
  validation: SupplierEvidenceValidationResult;
  local: ReconciliationLocalContext;
}): LegacyEvidenceClassification {
  const expectedIdentityMissing = input.validation.issues.some((issue) =>
    [
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
    ].includes(issue.code)
  );
  if (expectedIdentityMissing) {
    return {
      classification: 'identity_incomplete',
      candidateOutcome: null,
      reviewPath: 'supplier_identity_recovery',
      reasonCode: 'legacy_supplier_identity_incomplete',
      supplierTruthAuthoritative: false,
      explicitOutcomeActionRequired: true,
      makerCheckerRequired: true,
      genericResolveAllowed: false,
      automaticResolutionAllowed: false,
      statusMutationAllowed: false,
      walletMutationAllowed: false,
    };
  }

  if (!input.validation.valid || !input.validation.authoritativeFor) {
    const conflict = input.validation.issues.some(
      (issue) => issue.kind === 'mismatch' || issue.kind === 'conflict'
    );
    return {
      classification: conflict
        ? 'conflicting_unresolved'
        : 'evidence_incomplete',
      candidateOutcome: null,
      reviewPath: conflict
        ? 'manual_conflict_review'
        : 'fresh_evidence_required',
      reasonCode: conflict
        ? 'legacy_evidence_conflicting'
        : 'legacy_evidence_incomplete_or_stale',
      supplierTruthAuthoritative: false,
      explicitOutcomeActionRequired: true,
      makerCheckerRequired: true,
      genericResolveAllowed: false,
      automaticResolutionAllowed: false,
      statusMutationAllowed: false,
      walletMutationAllowed: false,
    };
  }

  const candidate =
    input.validation.authoritativeFor === 'held'
      ? 'held_not_ticketed'
      : input.validation.authoritativeFor;
  const localConflict =
    (candidate === 'ticketed' && input.local.storedStatus === 'cancelled') ||
    (candidate === 'held_not_ticketed' &&
      (input.local.hasLocalTicketEvidence ||
        input.local.storedStatus === 'confirmed' ||
        input.local.storedStatus === 'cancelled'));
  if (localConflict) {
    return {
      classification: 'conflicting_unresolved',
      candidateOutcome: candidate,
      reviewPath: 'manual_conflict_review',
      reasonCode: 'legacy_evidence_conflicts_with_local_truth',
      supplierTruthAuthoritative: false,
      explicitOutcomeActionRequired: true,
      makerCheckerRequired: true,
      genericResolveAllowed: false,
      automaticResolutionAllowed: false,
      statusMutationAllowed: false,
      walletMutationAllowed: false,
    };
  }

  return {
    classification:
      candidate === 'ticketed'
        ? 'ticketed_candidate'
        : candidate === 'cancelled'
          ? 'cancelled_candidate'
          : 'held_candidate',
    candidateOutcome: candidate,
    reviewPath:
      candidate === 'ticketed'
        ? 'ticketing_resolution'
        : candidate === 'cancelled'
          ? 'cancellation_resolution'
          : 'held_nonissuance_review',
    reasonCode:
      candidate === 'held_not_ticketed'
        ? 'legacy_held_requires_nonissuance_review'
        : 'legacy_positive_evidence_requires_outcome_specific_resolution',
    supplierTruthAuthoritative: candidate !== 'held_not_ticketed',
    explicitOutcomeActionRequired: true,
    makerCheckerRequired: true,
    genericResolveAllowed: false,
    automaticResolutionAllowed: false,
    statusMutationAllowed: false,
    walletMutationAllowed: false,
  };
}
