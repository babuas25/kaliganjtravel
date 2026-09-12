import 'server-only';

import {
  CANONICAL_SUPPLIER_EVIDENCE_FRESHNESS_MS,
  isCanonicalSupplierEvidenceV2,
  type CanonicalExpectedBookingV2,
  type CanonicalItinerarySegment,
  type CanonicalPassengerIdentity,
  type CanonicalSupplierEvidenceV2,
  type CanonicalTicketDocument,
  type SupplierEvidencePurpose,
} from '@/lib/booking-lifecycle/canonical-supplier-evidence-v2';

export type SupplierEvidenceValidationIssue = {
  code: string;
  kind: 'missing' | 'mismatch' | 'stale' | 'invalid' | 'conflict';
  source: 'pnr' | 'ticket-report' | 'evidence-set';
};

export type SupplierEvidenceValidationResult = {
  contractVersion: 2;
  valid: boolean;
  complete: boolean;
  fresh: boolean;
  identityMatches: boolean;
  authoritativeFor: SupplierEvidencePurpose | null;
  issues: SupplierEvidenceValidationIssue[];
};

function normalized(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? '';
}

function sameExact(left: string | null, right: string | null): boolean {
  return Boolean(left && right && left === right);
}

function normalizedValues(values: string[]): string[] {
  return values.map(normalized).filter(Boolean).sort();
}

function sameStringMultiset(left: string[], right: string[]): boolean {
  return JSON.stringify(normalizedValues(left)) === JSON.stringify(normalizedValues(right));
}

function commonIssues(
  evidence: CanonicalSupplierEvidenceV2,
  expected: CanonicalExpectedBookingV2,
  source: 'pnr' | 'ticket-report',
  now: number
): SupplierEvidenceValidationIssue[] {
  const issues: SupplierEvidenceValidationIssue[] = [];
  if (!isCanonicalSupplierEvidenceV2(evidence)) {
    return [{ code: 'unsupported_evidence_contract', kind: 'invalid', source }];
  }
  if (evidence.source !== source) {
    issues.push({ code: 'evidence_source_mismatch', kind: 'mismatch', source });
  }
  if (
    evidence.supplierAccount !== expected.supplierAccount ||
    evidence.supplierFamily !== expected.supplierFamily
  ) {
    issues.push({ code: 'supplier_account_mismatch', kind: 'mismatch', source });
  }
  const requestAt = Date.parse(evidence.receipt.requestStartedAt);
  const responseAt = Date.parse(evidence.receipt.responseReceivedAt);
  const observedAt = Date.parse(evidence.observedAt);
  const freshUntil = Date.parse(evidence.freshUntil);
  if (
    !Number.isFinite(requestAt) ||
    !Number.isFinite(responseAt) ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(freshUntil) ||
    requestAt > responseAt ||
    observedAt !== responseAt ||
    freshUntil !== responseAt + CANONICAL_SUPPLIER_EVIDENCE_FRESHNESS_MS ||
    responseAt > now + 60_000
  ) {
    issues.push({ code: 'invalid_evidence_timestamps', kind: 'invalid', source });
  }
  if (Number.isFinite(freshUntil) && now > freshUntil) {
    issues.push({ code: 'evidence_stale', kind: 'stale', source });
  }
  if (
    evidence.receipt.httpStatus !== 200 ||
    !/^[a-f0-9]{64}$/.test(evidence.receipt.rawPayloadHash)
  ) {
    issues.push({ code: 'invalid_supplier_receipt', kind: 'invalid', source });
  }
  if (!sameExact(
    evidence.requestIdentity.transactionId,
    expected.bookingIdentity.transactionId
  )) {
    issues.push({ code: 'requested_transaction_mismatch', kind: 'mismatch', source });
  }
  return issues;
}

function requiredLocalIdentityIssues(
  expected: CanonicalExpectedBookingV2,
  purpose: SupplierEvidencePurpose
): SupplierEvidenceValidationIssue[] {
  const issues: SupplierEvidenceValidationIssue[] = [];
  const identity = expected.bookingIdentity;
  if (!identity.transactionId) {
    issues.push({ code: 'expected_unique_transaction_missing', kind: 'missing', source: 'evidence-set' });
  }
  if (!identity.supplierPnr) {
    issues.push({ code: 'expected_supplier_pnr_missing', kind: 'missing', source: 'evidence-set' });
  }
  if (!identity.bookingReference) {
    issues.push({ code: 'expected_booking_reference_missing', kind: 'missing', source: 'evidence-set' });
  }
  if (
    !identity.operationalReferences.itemCodeRef ||
    !identity.operationalReferences.priceCodeRef ||
    !identity.operationalReferences.bookingCodeRef
  ) {
    issues.push({ code: 'expected_operational_reference_chain_missing', kind: 'missing', source: 'evidence-set' });
  }
  if (purpose !== 'held') {
    if (expected.passengers.length === 0) {
      issues.push({ code: 'expected_passenger_identity_missing', kind: 'missing', source: 'evidence-set' });
    }
    if (expected.itinerary.length === 0) {
      issues.push({ code: 'expected_itinerary_identity_missing', kind: 'missing', source: 'evidence-set' });
    }
    if (
      !expected.financial.currency ||
      (expected.financial.supplierPayableMinor ?? 0) <= 0
    ) {
      issues.push({ code: 'expected_supplier_financial_missing', kind: 'missing', source: 'evidence-set' });
    }
  }
  return issues;
}

function pnrIssues(
  evidence: CanonicalSupplierEvidenceV2,
  expected: CanonicalExpectedBookingV2,
  purpose: SupplierEvidencePurpose,
  now: number
): SupplierEvidenceValidationIssue[] {
  const issues = commonIssues(evidence, expected, 'pnr', now);
  const request = evidence.requestIdentity;
  const expectedIdentity = expected.bookingIdentity;
  if (!sameExact(request.supplierPnr, expectedIdentity.supplierPnr)) {
    issues.push({ code: 'requested_supplier_pnr_mismatch', kind: 'mismatch', source: 'pnr' });
  }
  if (!sameExact(request.bookingReference, expectedIdentity.bookingReference)) {
    issues.push({ code: 'requested_booking_reference_mismatch', kind: 'mismatch', source: 'pnr' });
  }
  for (const field of ['itemCodeRef', 'priceCodeRef', 'bookingCodeRef'] as const) {
    if (!sameExact(
      request.operationalReferences[field],
      expectedIdentity.operationalReferences[field]
    )) {
      issues.push({ code: `${field}_mismatch`, kind: 'mismatch', source: 'pnr' });
    }
  }
  if (!sameExact(
    evidence.bookingIdentity.transactionId,
    expectedIdentity.transactionId
  )) {
    issues.push({ code: 'pnr_supplier_transaction_echo_mismatch', kind: 'mismatch', source: 'pnr' });
  }
  if (evidence.bookingIdentity.identityConflicts.length > 0) {
    issues.push({ code: 'pnr_internal_identity_conflict', kind: 'conflict', source: 'pnr' });
  }
  if (evidence.bookingIdentity.responseLocators.length === 0) {
    issues.push({ code: 'pnr_response_locator_missing', kind: 'missing', source: 'pnr' });
  } else {
    for (const locator of evidence.bookingIdentity.responseLocators) {
      const accepted = locator.kind === 'supplier-pnr'
        ? normalized(locator.value) === normalized(expectedIdentity.supplierPnr)
        : locator.kind === 'booking-reference'
          ? normalized(locator.value) === normalized(expectedIdentity.bookingReference)
          : locator.kind === 'airline-pnr'
            ? normalizedValues(expectedIdentity.airlinePnrs).includes(normalized(locator.value))
            : false;
      if (!accepted) {
        issues.push({ code: 'pnr_typed_locator_mismatch', kind: 'mismatch', source: 'pnr' });
      }
    }
  }
  if (evidence.lifecycle.state !== purpose &&
    !(purpose === 'cancelled' && evidence.lifecycle.state === 'refunded')) {
    issues.push({ code: 'pnr_status_conflict', kind: 'conflict', source: 'pnr' });
  }
  if (!evidence.completeness.bookingIdentity) {
    issues.push({ code: 'pnr_booking_identity_incomplete', kind: 'missing', source: 'pnr' });
  }
  if (!evidence.completeness.lifecycle) {
    issues.push({ code: 'pnr_lifecycle_incomplete', kind: 'missing', source: 'pnr' });
  }
  return issues;
}

function passengerComparisonKey(passenger: CanonicalPassengerIdentity): string {
  return [
    passenger.identityHash,
    passenger.dateOfBirth ?? '',
    passenger.documentHash ?? '',
  ].join('|');
}

function passengerIssues(
  observed: CanonicalPassengerIdentity[],
  expected: CanonicalPassengerIdentity[]
): SupplierEvidenceValidationIssue[] {
  const source = 'ticket-report' as const;
  const observedCore = observed.map((value) => value.identityHash).sort();
  const expectedCore = expected.map((value) => value.identityHash).sort();
  if (JSON.stringify(observedCore) !== JSON.stringify(expectedCore)) {
    return [{ code: 'passenger_identity_mismatch', kind: 'mismatch', source }];
  }
  const expectedByHash = new Map<string, CanonicalPassengerIdentity[]>();
  for (const passenger of expected) {
    const group = expectedByHash.get(passenger.identityHash) ?? [];
    group.push(passenger);
    expectedByHash.set(passenger.identityHash, group);
  }
  const observedByHash = new Map<string, CanonicalPassengerIdentity[]>();
  for (const passenger of observed) {
    const group = observedByHash.get(passenger.identityHash) ?? [];
    group.push(passenger);
    observedByHash.set(passenger.identityHash, group);
  }
  for (const [hash, expectedGroup] of Array.from(expectedByHash.entries())) {
    const observedGroup = observedByHash.get(hash) ?? [];
    const comparableExpected = expectedGroup.map(passengerComparisonKey).sort();
    const comparableObserved = observedGroup.map(passengerComparisonKey).sort();
    if (
      comparableExpected.length === comparableObserved.length &&
      comparableExpected.some((key, index) => {
        const expectedParts = key.split('|');
        const observedParts = comparableObserved[index]!.split('|');
        return (
          (expectedParts[1] && observedParts[1] && expectedParts[1] !== observedParts[1]) ||
          (expectedParts[2] && observedParts[2] && expectedParts[2] !== observedParts[2])
        );
      })
    ) {
      return [{ code: 'passenger_secondary_identity_mismatch', kind: 'mismatch', source }];
    }
  }
  return [];
}

function effectiveCarrier(segment: CanonicalItinerarySegment): string {
  return normalized(segment.marketingCarrier ?? segment.operatingCarrier);
}

function segmentMatches(
  observed: CanonicalItinerarySegment,
  expected: CanonicalItinerarySegment
): boolean {
  if (observed.codeshareAmbiguous) return false;
  if (
    observed.sequence !== expected.sequence ||
    normalized(observed.origin) !== normalized(expected.origin) ||
    normalized(observed.destination) !== normalized(expected.destination) ||
    normalized(observed.flightNumber) !== normalized(expected.flightNumber) ||
    observed.travelDate !== expected.travelDate ||
    effectiveCarrier(observed) !== effectiveCarrier(expected)
  ) return false;
  if (
    observed.marketingCarrier &&
    observed.operatingCarrier &&
    observed.marketingCarrier !== observed.operatingCarrier
  ) {
    // Local booking evidence must carry both identities before a codeshare can
    // be treated as the same itinerary. Missing carrier semantics fail closed.
    return Boolean(
      expected.marketingCarrier &&
      expected.operatingCarrier &&
      normalized(observed.marketingCarrier) === normalized(expected.marketingCarrier) &&
      normalized(observed.operatingCarrier) === normalized(expected.operatingCarrier)
    );
  }
  return true;
}

function ticketNumbers(values: CanonicalTicketDocument[]): string[] {
  return values.map((ticket) => ticket.fullNumber);
}

function reportIssues(
  evidence: CanonicalSupplierEvidenceV2,
  expected: CanonicalExpectedBookingV2,
  purpose: Exclude<SupplierEvidencePurpose, 'held'>,
  now: number
): SupplierEvidenceValidationIssue[] {
  const issues = commonIssues(evidence, expected, 'ticket-report', now);
  const identity = evidence.bookingIdentity;
  const expectedIdentity = expected.bookingIdentity;
  if (identity.identityConflicts.length > 0) {
    issues.push({
      code: 'ticket_report_internal_identity_conflict',
      kind: 'conflict',
      source: 'ticket-report',
    });
  }
  if (!sameExact(identity.transactionId, expectedIdentity.transactionId)) {
    issues.push({ code: 'ticket_report_transaction_mismatch', kind: 'mismatch', source: 'ticket-report' });
  }
  if (!sameExact(identity.supplierPnr, expectedIdentity.supplierPnr)) {
    issues.push({ code: 'supplier_pnr_mismatch', kind: 'mismatch', source: 'ticket-report' });
  }
  if (!sameExact(identity.bookingReference, expectedIdentity.bookingReference)) {
    issues.push({ code: 'booking_reference_mismatch', kind: 'mismatch', source: 'ticket-report' });
  }
  for (const field of ['itemCodeRef', 'priceCodeRef', 'bookingCodeRef'] as const) {
    if (!sameExact(
      identity.operationalReferences[field],
      expectedIdentity.operationalReferences[field]
    )) {
      issues.push({ code: `${field}_mismatch`, kind: 'mismatch', source: 'ticket-report' });
    }
  }
  if (!sameStringMultiset(identity.airlinePnrs, expectedIdentity.airlinePnrs)) {
    issues.push({ code: 'airline_pnr_mismatch', kind: 'mismatch', source: 'ticket-report' });
  }
  const expectedState = purpose === 'ticketed' ? 'ticketed' : ['cancelled', 'refunded'];
  if (
    typeof expectedState === 'string'
      ? evidence.query.requestedLifecycleState !== expectedState
      : !expectedState.includes(evidence.query.requestedLifecycleState ?? 'unknown')
  ) {
    issues.push({ code: 'ticket_report_query_state_mismatch', kind: 'mismatch', source: 'ticket-report' });
  }
  if (
    typeof expectedState === 'string'
      ? evidence.lifecycle.state !== expectedState
      : !expectedState.includes(evidence.lifecycle.state)
  ) {
    issues.push({ code: 'ticket_report_status_conflict', kind: 'conflict', source: 'ticket-report' });
  }
  if (!evidence.completeness.bookingIdentity) {
    issues.push({ code: 'ticket_report_booking_identity_incomplete', kind: 'missing', source: 'ticket-report' });
  }
  if (!evidence.completeness.passengers) {
    issues.push({ code: 'ticket_report_passengers_incomplete', kind: 'missing', source: 'ticket-report' });
  } else {
    issues.push(...passengerIssues(evidence.passengers, expected.passengers));
  }
  if (!evidence.completeness.itinerary) {
    issues.push({ code: 'ticket_report_itinerary_incomplete', kind: 'missing', source: 'ticket-report' });
  } else if (
    evidence.itinerary.length !== expected.itinerary.length ||
    evidence.itinerary.some((segment, index) =>
      !expected.itinerary[index] || !segmentMatches(segment, expected.itinerary[index]!))
  ) {
    const codeshare = evidence.itinerary.some((segment) =>
      segment.codeshareAmbiguous ||
      Boolean(segment.marketingCarrier && segment.operatingCarrier &&
        segment.marketingCarrier !== segment.operatingCarrier));
    issues.push({
      code: codeshare ? 'codeshare_identity_ambiguous' : 'itinerary_identity_mismatch',
      kind: codeshare ? 'conflict' : 'mismatch',
      source: 'ticket-report',
    });
  }
  if (!evidence.completeness.financial) {
    issues.push({ code: 'ticket_report_financial_incomplete', kind: 'missing', source: 'ticket-report' });
  } else {
    if (normalized(evidence.financial.currency) !== normalized(expected.financial.currency)) {
      issues.push({ code: 'supplier_currency_mismatch', kind: 'mismatch', source: 'ticket-report' });
    }
    if (evidence.financial.supplierPayableMinor !== expected.financial.supplierPayableMinor) {
      issues.push({ code: 'supplier_payable_mismatch', kind: 'mismatch', source: 'ticket-report' });
    }
  }
  if (!evidence.completeness.lifecycle) {
    issues.push({ code: 'ticket_report_lifecycle_incomplete', kind: 'missing', source: 'ticket-report' });
  }
  if (purpose === 'ticketed') {
    if (!evidence.completeness.tickets || evidence.tickets.length === 0) {
      issues.push({ code: 'authoritative_ticket_documents_missing', kind: 'missing', source: 'ticket-report' });
    } else if (
      expected.tickets.length > 0 &&
      !sameStringMultiset(ticketNumbers(evidence.tickets), ticketNumbers(expected.tickets))
    ) {
      issues.push({ code: 'ticket_document_identity_mismatch', kind: 'mismatch', source: 'ticket-report' });
    }
  }
  // supplierWorkflowReference/ticketCodeRef is deliberately never compared as
  // ticket identity. It remains immutable opaque workflow metadata only.
  return issues;
}

export function validateCanonicalSupplierEvidenceV2(input: {
  purpose: SupplierEvidencePurpose;
  expected: CanonicalExpectedBookingV2;
  pnr?: unknown;
  ticketReport?: unknown;
  now?: number;
}): SupplierEvidenceValidationResult {
  const now = input.now ?? Date.now();
  const issues = requiredLocalIdentityIssues(input.expected, input.purpose);
  if (!input.pnr || !isCanonicalSupplierEvidenceV2(input.pnr)) {
    issues.push({
      code: input.pnr ? 'pnr_evidence_malformed' : 'pnr_evidence_missing',
      kind: input.pnr ? 'invalid' : 'missing',
      source: 'pnr',
    });
  } else {
    issues.push(...pnrIssues(input.pnr, input.expected, input.purpose, now));
  }
  if (input.purpose !== 'held') {
    if (!input.ticketReport || !isCanonicalSupplierEvidenceV2(input.ticketReport)) {
      issues.push({
        code: input.ticketReport
          ? 'ticket_report_evidence_malformed'
          : 'ticket_report_evidence_missing',
        kind: input.ticketReport ? 'invalid' : 'missing',
        source: 'ticket-report',
      });
    } else {
      issues.push(...reportIssues(
        input.ticketReport,
        input.expected,
        input.purpose,
        now
      ));
    }
  }
  const complete = !issues.some((issue) => issue.kind === 'missing' || issue.kind === 'invalid');
  const fresh = !issues.some((issue) => issue.kind === 'stale' || issue.code === 'invalid_evidence_timestamps');
  const identityMatches = !issues.some((issue) =>
    issue.kind === 'mismatch' ||
    issue.code.startsWith('expected_') ||
    issue.code.includes('identity_') ||
    issue.code.includes('_pnr_') ||
    issue.code.includes('reference'));
  const valid = issues.length === 0;
  return {
    contractVersion: 2,
    valid,
    complete,
    fresh,
    identityMatches,
    authoritativeFor: valid ? input.purpose : null,
    issues,
  };
}
