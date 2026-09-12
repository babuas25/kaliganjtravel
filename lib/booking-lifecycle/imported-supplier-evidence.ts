import 'server-only';

import { createHash } from 'crypto';

import {
  bookingPassengerIdentityHashes,
  bookingRouteSignature,
} from '@/lib/booking-lifecycle/supplier-evidence-validation';
import type { BookingRow } from '@/lib/db/flight-bookings';
import type { NormalizedBookingImport } from '@/lib/impexp/types';

const EVIDENCE_FRESHNESS_MS = 5 * 60_000;

export type ImportedSupplierEvidenceIssue = {
  code: string;
  kind: 'missing' | 'mismatch' | 'stale' | 'invalid' | 'conflict';
};

export type ImportedSupplierOutcomeClassification =
  | 'ticketed'
  | 'held'
  | 'cancelled'
  | 'expired'
  | 'unconfirmed'
  | 'conflicting';

export type ImportedSupplierOutcomeRule = {
  classification: ImportedSupplierOutcomeClassification;
  authoritative: boolean;
  reasonCode:
    | 'supplier_ticket_evidence_ready'
    | 'supplier_booking_still_held'
    | 'supplier_booking_cancelled'
    | 'supplier_booking_expired'
    | 'supplier_booking_unconfirmed'
    | 'supplier_evidence_conflicting';
  requiredAction:
    | 'complete_ticketing'
    | 'continue_supplier_follow_up'
    | 'financial_disposition_required'
    | 'admin_review_required';
  operationState: 'awaiting_external_action' | 'needs_reconciliation';
  caseState: 'assigned' | 'awaiting_supplier' | 'awaiting_finance';
  assignedTeam: 'support' | 'accounts' | 'admin';
  severity: 'high' | 'critical';
  priority: number;
  financialDispositionRequired: boolean;
};

export type ImportedSupplierEvidenceFacts = {
  version: 1;
  action: 'supplier_evidence_read';
  sourceKind: 'imported_supplier_manage_booking';
  bookingId: string;
  caseId: string;
  caseType: string;
  requestedPurpose: 'ticketed';
  acquiredAt: string;
  evidenceObservedAt: string;
  recordedSources: ['imported-supplier'];
  sourceResults: Array<{
    source: 'imported-supplier';
    state: 'recorded';
    reasonCode: null;
  }>;
  evidence: {
    importedSupplier: {
      schemaVersion: 1;
      normalizerVersion: 1;
      provider: string;
      source: 'airline-manage-booking';
      observedAt: string;
      freshUntil: string;
      receipt: {
        requestStartedAt: string;
        responseReceivedAt: string;
        supplierPayloadHash: string;
      };
      identity: {
        supplierReference: string;
        passengerIdentityHashes: string[];
        routeSignature: string;
      };
      facts: {
        supplierStatus: string;
        lifecycleStatus: string;
        pnr: string;
        airlinesPnr: string[];
        ticketNumbers: string[];
        passengerCount: number;
        ticketingDeadlineAt: string | null;
        issuedAt: null;
      };
    };
  };
  validation: {
    valid: boolean;
    complete: boolean;
    fresh: boolean;
    identityMatches: boolean;
    authoritativeFor: 'ticketed' | null;
    issues: ImportedSupplierEvidenceIssue[];
  };
  outcome: ImportedSupplierOutcomeRule;
  statusMutation: false;
  walletMutation: false;
  destructiveSupplierCall: false;
};

export type ImportedSupplierEvidenceReadIdentity = {
  observationKey: string;
  lockName: string;
};

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function strings(value: unknown): string[] {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .filter((item): item is string => typeof item === 'string')
        .map(normalized)
        .filter(Boolean)
    )
  ).sort();
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(strings(left)) === JSON.stringify(strings(right));
}

function travellerCount(passengers: unknown): number {
  if (!passengers || typeof passengers !== 'object' || Array.isArray(passengers)) {
    return 0;
  }
  const travellers = (passengers as { travellers?: unknown }).travellers;
  return Array.isArray(travellers) ? travellers.length : 0;
}

function outcomeRule(input: {
  classification: ImportedSupplierOutcomeClassification;
  authoritative: boolean;
}): ImportedSupplierOutcomeRule {
  switch (input.classification) {
    case 'ticketed':
      return {
        classification: 'ticketed',
        authoritative: input.authoritative,
        reasonCode: 'supplier_ticket_evidence_ready',
        requiredAction: 'complete_ticketing',
        operationState: 'awaiting_external_action',
        caseState: 'assigned',
        assignedTeam: 'support',
        severity: 'high',
        priority: 70,
        financialDispositionRequired: false,
      };
    case 'held':
      return {
        classification: 'held',
        authoritative: input.authoritative,
        reasonCode: 'supplier_booking_still_held',
        requiredAction: 'continue_supplier_follow_up',
        operationState: 'awaiting_external_action',
        caseState: 'awaiting_supplier',
        assignedTeam: 'support',
        severity: 'high',
        priority: 40,
        financialDispositionRequired: false,
      };
    case 'cancelled':
      return {
        classification: 'cancelled',
        authoritative: input.authoritative,
        reasonCode: 'supplier_booking_cancelled',
        requiredAction: 'financial_disposition_required',
        operationState: 'needs_reconciliation',
        caseState: 'awaiting_finance',
        assignedTeam: 'accounts',
        severity: 'critical',
        priority: 90,
        financialDispositionRequired: true,
      };
    case 'expired':
      return {
        classification: 'expired',
        authoritative: input.authoritative,
        reasonCode: 'supplier_booking_expired',
        requiredAction: 'financial_disposition_required',
        operationState: 'needs_reconciliation',
        caseState: 'awaiting_finance',
        assignedTeam: 'accounts',
        severity: 'critical',
        priority: 90,
        financialDispositionRequired: true,
      };
    case 'unconfirmed':
      return {
        classification: 'unconfirmed',
        authoritative: input.authoritative,
        reasonCode: 'supplier_booking_unconfirmed',
        requiredAction: 'financial_disposition_required',
        operationState: 'needs_reconciliation',
        caseState: 'awaiting_finance',
        assignedTeam: 'accounts',
        severity: 'critical',
        priority: 90,
        financialDispositionRequired: true,
      };
    case 'conflicting':
      return {
        classification: 'conflicting',
        authoritative: false,
        reasonCode: 'supplier_evidence_conflicting',
        requiredAction: 'admin_review_required',
        operationState: 'needs_reconciliation',
        caseState: 'assigned',
        assignedTeam: 'admin',
        severity: 'critical',
        priority: 100,
        financialDispositionRequired: false,
      };
  }
}

export function importedSupplierPayloadHash(payload: unknown): string {
  return sha256(canonical(payload));
}

export function importedSupplierEvidenceReadIdentity(input: {
  requestId: string;
  bookingId: string;
  caseId: string;
}): ImportedSupplierEvidenceReadIdentity {
  const fingerprint = sha256(
    canonical({
      version: 1,
      action: 'imported_supplier_evidence_read',
      requestId: input.requestId,
      bookingId: input.bookingId,
      caseId: input.caseId,
      purpose: 'ticketed',
    })
  );
  return {
    observationKey: `evidence-read:v1:${fingerprint}`,
    lockName: `impexp-evidence:v1:${fingerprint}`,
  };
}

export function importedSupplierEvidenceFactsHash(
  facts: ImportedSupplierEvidenceFacts
): string {
  return sha256(canonical(facts));
}

export function importedSupplierEvidenceFacts(input: {
  booking: BookingRow;
  caseId: string;
  caseType: string;
  normalized: NormalizedBookingImport;
  requestStartedAt: string;
  responseReceivedAt: string;
  supplierPayloadHash: string;
  now?: number;
}): ImportedSupplierEvidenceFacts {
  const now = input.now ?? Date.now();
  const issues: ImportedSupplierEvidenceIssue[] = [];
  const expectedPassengers = bookingPassengerIdentityHashes(input.booking.passengers);
  const observedPassengers = bookingPassengerIdentityHashes(
    input.normalized.passengers
  );
  const expectedRoute = bookingRouteSignature(input.booking.itinerary);
  const observedRoute = bookingRouteSignature(input.normalized.itinerary);
  const expectedPassengerCount = travellerCount(input.booking.passengers);
  const observedPassengerCount = travellerCount(input.normalized.passengers);
  const ticketNumbers = strings(input.normalized.ticketNumbers);
  const airlinesPnr = strings(input.normalized.airlinesPnr);
  const requestAt = Date.parse(input.requestStartedAt);
  const responseAt = Date.parse(input.responseReceivedAt);
  const safeResponseAt = Number.isFinite(responseAt) ? responseAt : now;

  if (
    !Number.isFinite(requestAt) ||
    !Number.isFinite(responseAt) ||
    requestAt > responseAt ||
    responseAt > now + 60_000
  ) {
    issues.push({ code: 'invalid_evidence_timestamps', kind: 'invalid' });
  }
  if (Number.isFinite(responseAt) && now > responseAt + EVIDENCE_FRESHNESS_MS) {
    issues.push({ code: 'evidence_stale', kind: 'stale' });
  }
  if (!/^[a-f0-9]{64}$/.test(input.supplierPayloadHash)) {
    issues.push({ code: 'invalid_supplier_payload_hash', kind: 'invalid' });
  }
  if (normalized(input.normalized.provider) !== normalized(input.booking.supplier)) {
    issues.push({ code: 'supplier_provider_mismatch', kind: 'mismatch' });
  }
  if (
    normalized(input.normalized.supplierReference) !==
    normalized(input.booking.booking_ref_number)
  ) {
    issues.push({ code: 'supplier_reference_mismatch', kind: 'mismatch' });
  }
  if (expectedPassengers.length === 0 || expectedPassengerCount === 0) {
    issues.push({ code: 'expected_passenger_identity_missing', kind: 'missing' });
  } else if (
    observedPassengerCount !== expectedPassengerCount ||
    !sameSet(observedPassengers, expectedPassengers)
  ) {
    issues.push({ code: 'passenger_identity_mismatch', kind: 'mismatch' });
  }
  if (!expectedRoute) {
    issues.push({ code: 'expected_route_identity_missing', kind: 'missing' });
  } else if (normalized(observedRoute) !== normalized(expectedRoute)) {
    issues.push({ code: 'route_identity_mismatch', kind: 'mismatch' });
  }
  if (
    input.normalized.lifecycleStatus !== 'confirmed' ||
    input.normalized.storedStatus !== 'confirmed'
  ) {
    issues.push({ code: 'supplier_status_not_ticketed', kind: 'conflict' });
  }
  if (!normalized(input.normalized.pnr) || airlinesPnr.length === 0) {
    issues.push({ code: 'airline_pnr_missing', kind: 'missing' });
  }
  if (ticketNumbers.length === 0) {
    issues.push({ code: 'ticket_numbers_missing', kind: 'missing' });
  } else if (
    expectedPassengerCount > 0 &&
    ticketNumbers.length !== expectedPassengerCount
  ) {
    issues.push({ code: 'ticket_passenger_count_mismatch', kind: 'mismatch' });
  }

  const complete = !issues.some((issue) => issue.kind === 'missing');
  const fresh = !issues.some(
    (issue) => issue.kind === 'stale' || issue.code === 'invalid_evidence_timestamps'
  );
  const identityIssueCodes = new Set([
    'supplier_provider_mismatch',
    'supplier_reference_mismatch',
    'expected_passenger_identity_missing',
    'passenger_identity_mismatch',
    'expected_route_identity_missing',
    'route_identity_mismatch',
  ]);
  const identityMatches = !issues.some((issue) =>
    identityIssueCodes.has(issue.code)
  );
  const valid = issues.length === 0;
  const receiptValid = !issues.some(
    (issue) =>
      issue.code === 'invalid_evidence_timestamps' ||
      issue.code === 'invalid_supplier_payload_hash'
  );
  const baseAuthoritative = receiptValid && fresh && identityMatches;
  const lifecycleStatus = input.normalized.lifecycleStatus;
  const ticketedEvidenceComplete =
    lifecycleStatus === 'confirmed' &&
    input.normalized.storedStatus === 'confirmed' &&
    Boolean(normalized(input.normalized.pnr)) &&
    airlinesPnr.length > 0 &&
    expectedPassengerCount > 0 &&
    ticketNumbers.length === expectedPassengerCount;
  const classification: ImportedSupplierOutcomeClassification =
    !baseAuthoritative
      ? 'conflicting'
      : lifecycleStatus === 'confirmed'
        ? ticketedEvidenceComplete && valid
          ? 'ticketed'
          : 'conflicting'
        : lifecycleStatus === 'cancelled'
          ? 'cancelled'
          : lifecycleStatus === 'expired'
            ? 'expired'
            : lifecycleStatus === 'unconfirmed'
              ? 'unconfirmed'
              : ticketNumbers.length > 0
                ? 'conflicting'
                : 'held';
  const observedAt = new Date(safeResponseAt).toISOString();

  return {
    version: 1,
    action: 'supplier_evidence_read',
    sourceKind: 'imported_supplier_manage_booking',
    bookingId: input.booking.id,
    caseId: input.caseId,
    caseType: input.caseType,
    requestedPurpose: 'ticketed',
    acquiredAt: new Date(now).toISOString(),
    evidenceObservedAt: observedAt,
    recordedSources: ['imported-supplier'],
    sourceResults: [
      { source: 'imported-supplier', state: 'recorded', reasonCode: null },
    ],
    evidence: {
      importedSupplier: {
        schemaVersion: 1,
        normalizerVersion: 1,
        provider: input.normalized.provider,
        source: 'airline-manage-booking',
        observedAt,
        freshUntil: new Date(
          safeResponseAt + EVIDENCE_FRESHNESS_MS
        ).toISOString(),
        receipt: {
          requestStartedAt: input.requestStartedAt,
          responseReceivedAt: input.responseReceivedAt,
          supplierPayloadHash: input.supplierPayloadHash,
        },
        identity: {
          supplierReference: input.normalized.supplierReference,
          passengerIdentityHashes: observedPassengers,
          routeSignature: observedRoute,
        },
        facts: {
          supplierStatus: input.normalized.orderStatus,
          lifecycleStatus: input.normalized.lifecycleStatus,
          pnr: normalized(input.normalized.pnr),
          airlinesPnr,
          ticketNumbers,
          passengerCount: observedPassengerCount,
          ticketingDeadlineAt: input.normalized.ticketingDeadlineAt,
          issuedAt: null,
        },
      },
    },
    validation: {
      valid,
      complete,
      fresh,
      identityMatches,
      authoritativeFor: valid ? 'ticketed' : null,
      issues,
    },
    outcome: outcomeRule({
      classification,
      authoritative: baseAuthoritative && classification !== 'conflicting',
    }),
    statusMutation: false,
    walletMutation: false,
    destructiveSupplierCall: false,
  };
}

export function isImportedSupplierEvidenceFacts(
  value: unknown
): value is ImportedSupplierEvidenceFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const facts = value as Partial<ImportedSupplierEvidenceFacts>;
  return (
    facts.version === 1 &&
    facts.action === 'supplier_evidence_read' &&
    facts.sourceKind === 'imported_supplier_manage_booking' &&
    facts.requestedPurpose === 'ticketed' &&
    typeof facts.bookingId === 'string' &&
    typeof facts.caseId === 'string' &&
    Boolean(facts.validation && typeof facts.validation === 'object')
  );
}

export function staffImportedSupplierEvidenceResult(
  facts: ImportedSupplierEvidenceFacts
) {
  return {
    validation: {
      valid: facts.validation.valid,
      complete: facts.validation.complete,
      fresh: facts.validation.fresh,
      identityMatches: facts.validation.identityMatches,
      authoritativeFor: facts.validation.authoritativeFor,
      issueCodes: facts.validation.issues.map((issue) => issue.code),
    },
    outcome: facts.outcome,
    statusMutation: false as const,
    walletMutation: false as const,
    destructiveSupplierCall: false as const,
  };
}
