import 'server-only';

import { createHash } from 'node:crypto';

import {
  canonicalExpectedBookingV2,
  type CanonicalExpectedBookingV2,
  type CanonicalSupplierEvidenceV2,
  type SupplierEvidencePurpose,
} from '@/lib/booking-lifecycle/canonical-supplier-evidence-v2';
import {
  validateCanonicalSupplierEvidenceV2,
  type SupplierEvidenceValidationResult,
} from '@/lib/booking-lifecycle/canonical-supplier-evidence-validation-v2';
import type {
  AirTicketingQueryStatus,
} from '@/lib/booking-lifecycle/supplier-evidence';
import {
  classifyCancellationReconciliation,
  classifyLegacyReconciliation,
  classifyTicketingReconciliation,
  type ReconciliationLocalContext,
} from '@/lib/booking-lifecycle/reconciliation-decisions';
import { assessReconciliationConfirmationBoundary } from '@/lib/booking-lifecycle/reconciliation-confirmation-boundary';
import type { BookingRow } from '@/lib/db/flight-bookings';
import {
  readAirTicketingDetails,
} from '@/lib/triplover/air-ticketing-details';
import { TriploverError } from '@/lib/triplover/client';
import { isTriploverSupplier } from '@/lib/triplover/config';
import { pnrLookupLocators, readPnr } from '@/lib/triplover/pnr';

export type SupplierEvidenceReadSourceResult = {
  source: 'pnr' | 'ticket-report';
  state: 'recorded' | 'unavailable' | 'failed';
  reasonCode: string | null;
  supplierErrorKind: string | null;
  httpStatus: number | null;
};

export type SupplierEvidenceReadFacts = {
  version: 2;
  evidenceContract: 'canonical_supplier_evidence_v2';
  action: 'supplier_evidence_read';
  bookingId: string;
  caseId: string;
  caseType: string;
  requestedPurpose: SupplierEvidencePurpose;
  requestedAirTicketingStatus: AirTicketingQueryStatus | null;
  acquiredAt: string;
  evidenceObservedAt: string | null;
  recordedSources: Array<'pnr' | 'ticket-report'>;
  sourceResults: SupplierEvidenceReadSourceResult[];
  localContext: ReconciliationLocalContext;
  expectedIdentity: CanonicalExpectedBookingV2;
  evidence: {
    pnr: CanonicalSupplierEvidenceV2 | null;
    ticketReport: CanonicalSupplierEvidenceV2 | null;
  };
  validation: SupplierEvidenceValidationResult;
  statusMutation: false;
  walletMutation: false;
  destructiveSupplierCall: false;
};

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0
      )
    : [];
}

function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Evidence facts contain a non-finite number.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  throw new Error('Evidence facts contain an unsupported value.');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function supplierEvidenceReadIdentity(input: {
  clientRequestNonce: string;
  bookingId: string;
  caseId: string;
  purpose: SupplierEvidencePurpose;
  airTicketingStatus: AirTicketingQueryStatus | null;
}): { observationKey: string; lockName: string } {
  const digest = sha256(
    canonical({
      version: 2,
      namespace: 'booking-reconciliation-evidence-read-v2',
      nonce: input.clientRequestNonce,
      bookingId: input.bookingId,
      caseId: input.caseId,
      purpose: input.purpose,
      airTicketingStatus: input.airTicketingStatus,
    })
  );
  return {
    observationKey: `evidence-read:v2:${digest}`,
    lockName: `booking-evidence-v2:${digest}`,
  };
}

export function supplierEvidenceFactsHash(
  facts: SupplierEvidenceReadFacts
): string {
  return sha256(canonical(facts));
}

export function expectedSupplierEvidenceIdentity(
  booking: BookingRow
): CanonicalExpectedBookingV2 {
  return canonicalExpectedBookingV2(booking);
}

function failedSource(
  source: SupplierEvidenceReadSourceResult['source'],
  error: unknown
): SupplierEvidenceReadSourceResult {
  if (error instanceof TriploverError) {
    return {
      source,
      state: 'failed',
      reasonCode: 'supplier_read_failed',
      supplierErrorKind: error.kind,
      httpStatus: error.status,
    };
  }
  return {
    source,
    state: 'failed',
    reasonCode: 'unexpected_read_failure',
    supplierErrorKind: null,
    httpStatus: null,
  };
}

function unavailableSource(
  source: SupplierEvidenceReadSourceResult['source'],
  reasonCode: string
): SupplierEvidenceReadSourceResult {
  return {
    source,
    state: 'unavailable',
    reasonCode,
    supplierErrorKind: null,
    httpStatus: null,
  };
}

function recordedSource(
  source: SupplierEvidenceReadSourceResult['source']
): SupplierEvidenceReadSourceResult {
  return {
    source,
    state: 'recorded',
    reasonCode: null,
    supplierErrorKind: null,
    httpStatus: 200,
  };
}

export function airStatusForEvidencePurpose(input: {
  purpose: SupplierEvidencePurpose;
  cancellationReportStatus?: 'Cancelled' | 'Refunded';
}): AirTicketingQueryStatus | null {
  if (input.purpose === 'held') return null;
  if (input.purpose === 'ticketed') return 'Confirmed';
  return input.cancellationReportStatus ?? 'Cancelled';
}

export async function acquireSupplierEvidence(input: {
  booking: BookingRow;
  caseId: string;
  caseType: string;
  purpose: SupplierEvidencePurpose;
  cancellationReportStatus?: 'Cancelled' | 'Refunded';
}): Promise<SupplierEvidenceReadFacts> {
  const expected = expectedSupplierEvidenceIdentity(input.booking);
  const supplier = isTriploverSupplier(input.booking.supplier_account)
    ? input.booking.supplier_account
    : null;
  const airTicketingStatus = airStatusForEvidencePurpose(input);
  const pnrLocators = pnrLookupLocators({
    pnr: input.booking.pnr,
    bookingRefNumber: input.booking.booking_ref_number,
  });
  const pnrReady = Boolean(
    supplier &&
      expected.bookingIdentity.transactionId &&
      pnrLocators &&
      expected.bookingIdentity.operationalReferences.bookingCodeRef &&
      input.booking.supplier_refs?.itemCodeRef?.trim() &&
      input.booking.supplier_refs?.priceCodeRef?.trim()
  );

  const pnrRead = supplier && pnrLocators && pnrReady
    ? readPnr({
        ...input.booking.supplier_refs,
        supplier,
        ...pnrLocators,
        bookingCodeRef:
          expected.bookingIdentity.operationalReferences.bookingCodeRef!,
        carrierCode: input.booking.itinerary?.carrierCode,
        deadlineNotBefore:
          input.booking.submission_started_at ?? input.booking.created_at,
      })
        .then((result) => ({
          evidence: result.reconciliationEvidenceV2,
          result: recordedSource('pnr'),
        }))
        .catch((error: unknown) => ({
          evidence: null,
          result: failedSource('pnr', error),
        }))
    : Promise.resolve({
        evidence: null,
        result: unavailableSource('pnr', 'local_reference_chain_incomplete'),
      });

  const airRead = airTicketingStatus
      ? supplier && expected.bookingIdentity.transactionId
      ? readAirTicketingDetails(
          expected.bookingIdentity.transactionId,
          airTicketingStatus,
          supplier
        )
          .then((result) => ({
            evidence: result.reconciliationEvidenceV2 ?? null,
            result: recordedSource('ticket-report'),
          }))
          .catch((error: unknown) => ({
            evidence: null,
            result: failedSource('ticket-report', error),
          }))
      : Promise.resolve({
          evidence: null,
          result: unavailableSource(
            'ticket-report',
            supplier ? 'unique_transaction_missing' : 'supplier_account_missing'
          ),
        })
    : Promise.resolve(null);

  const [pnrResult, airResult] = await Promise.all([pnrRead, airRead]);
  const pnr = pnrResult.evidence;
  const ticketReport = airResult?.evidence ?? null;
  const sourceResults = [
    pnrResult.result,
    ...(airResult ? [airResult.result] : []),
  ];
  const evidenceTimes = [pnr, ticketReport]
    .filter(
      (evidence): evidence is CanonicalSupplierEvidenceV2 => evidence !== null
    )
    .map((evidence) => evidence.receipt.responseReceivedAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort();
  const acquiredAt = new Date().toISOString();
  const validation = validateCanonicalSupplierEvidenceV2({
    purpose: input.purpose,
    expected,
    pnr,
    ticketReport,
    now: Date.parse(acquiredAt),
  });

  return {
    version: 2,
    evidenceContract: 'canonical_supplier_evidence_v2',
    action: 'supplier_evidence_read',
    bookingId: input.booking.id,
    caseId: input.caseId,
    caseType: input.caseType,
    requestedPurpose: input.purpose,
    requestedAirTicketingStatus: airTicketingStatus,
    acquiredAt,
    evidenceObservedAt: evidenceTimes.at(-1) ?? null,
    recordedSources: sourceResults
      .filter((result) => result.state === 'recorded')
      .map((result) => result.source),
    sourceResults,
    localContext: {
      storedStatus: input.booking.status,
      paymentState: input.booking.payment_state,
      // ticketCodeRef is an opaque supplier workflow reference. Only actual
      // ticket document numbers count as local ticket identity in V2.
      hasLocalTicketEvidence: strings(input.booking.ticket_numbers).length > 0,
    },
    expectedIdentity: expected,
    evidence: { pnr, ticketReport },
    validation,
    statusMutation: false,
    walletMutation: false,
    destructiveSupplierCall: false,
  };
}

export function isSupplierEvidenceReadFacts(
  value: unknown
): value is SupplierEvidenceReadFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const facts = value as Partial<SupplierEvidenceReadFacts>;
  return (
    facts.version === 2 &&
    facts.evidenceContract === 'canonical_supplier_evidence_v2' &&
    facts.action === 'supplier_evidence_read' &&
    typeof facts.bookingId === 'string' &&
    typeof facts.caseId === 'string' &&
    typeof facts.caseType === 'string' &&
    typeof facts.acquiredAt === 'string' &&
    Array.isArray(facts.recordedSources) &&
    Array.isArray(facts.sourceResults) &&
    !!facts.validation &&
    typeof facts.validation === 'object' &&
    Array.isArray(facts.validation.issues)
  );
}

export function staffSupplierEvidenceReadResult(
  facts: SupplierEvidenceReadFacts
) {
  const ticketingDecision = classifyTicketingReconciliation({
    validation: facts.validation,
    local: facts.localContext,
  });
  const cancellationDecision = facts.caseType.includes('cancellation')
    ? classifyCancellationReconciliation({
        validation: facts.validation,
        local: facts.localContext,
      })
    : null;
  const legacyClassification = facts.caseType === 'legacy_review'
    ? classifyLegacyReconciliation({
        validation: facts.validation,
        local: facts.localContext,
      })
    : null;
  const controllingDecision = legacyClassification
    ? {
        candidateOutcome: legacyClassification.candidateOutcome,
        financialReviewRequired:
          legacyClassification.candidateOutcome === 'ticketed' ||
          facts.localContext.paymentState !== 'unpaid',
      }
    : cancellationDecision ?? ticketingDecision;
  const confirmationBoundary = assessReconciliationConfirmationBoundary({
    caseType: facts.caseType,
    validation: facts.validation,
    local: facts.localContext,
    candidateOutcome: controllingDecision.candidateOutcome,
    financialReviewRequired: controllingDecision.financialReviewRequired,
  });
  return {
    purpose: facts.requestedPurpose,
    requestedAirTicketingStatus: facts.requestedAirTicketingStatus,
    acquiredAt: facts.acquiredAt,
    evidenceObservedAt: facts.evidenceObservedAt,
    recordedSources: facts.recordedSources,
    sourceResults: facts.sourceResults,
    validation: {
      valid: facts.validation.valid,
      complete: facts.validation.complete,
      fresh: facts.validation.fresh,
      identityMatches: facts.validation.identityMatches,
      authoritativeFor: facts.validation.authoritativeFor,
      issueCodes: facts.validation.issues.map((issue) => issue.code),
    },
    supplierIdentifiers: facts.evidence.ticketReport
      ? {
          supplierUniqueTransId:
            facts.evidence.ticketReport.bookingIdentity.transactionId,
          supplierInternalBookingId:
            facts.evidence.ticketReport.bookingIdentity.supplierBookingId,
        }
      : null,
    ticketingDecision,
    cancellationDecision,
    legacyClassification,
    confirmationBoundary,
    statusMutation: false as const,
    walletMutation: false as const,
    destructiveSupplierCall: false as const,
  };
}
