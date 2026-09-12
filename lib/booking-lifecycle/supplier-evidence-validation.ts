import 'server-only';

import { createHash } from 'crypto';

import type {
  NormalizedAirTicketingEvidence,
  NormalizedPnrEvidence,
  NormalizedSupplierEvidence,
} from '@/lib/booking-lifecycle/supplier-evidence';
import type { BookedItinerary } from '@/lib/flights/booking';
import type { TriploverSupplier } from '@/lib/triplover/config';

export type SupplierEvidencePurpose = 'held' | 'ticketed' | 'cancelled';

/**
 * Generic supplier ticket evidence always needs a supplier ticket-code
 * reference. TakeOff's manual-portal report is the narrow documented
 * exception: it can omit that field while echoing stronger transaction and
 * booking identifiers instead.
 */
export type TicketedEvidenceProfile =
  | 'generic'
  | 'takeoff_manual_ticket';

export type ExpectedSupplierEvidenceIdentity = {
  uniqueTransId: string;
  /**
   * The original persisted supplier identifier, retained byte-for-byte only
   * for optional supplier echoes. Generic request-identity matching continues
   * to use `uniqueTransId` so an absent PNR echo cannot change that contract.
   */
  exactUniqueTransId?: string | null;
  acceptedPnr: string[];
  bookingCodeRef: string;
  passengerIdentityHashes: string[];
  routeSignature: string;
  ticketCodeRef?: string | null;
  ticketNumbers?: string[];
  /** Persisted account that selected the Triplover credential set. */
  supplierAccount?: TriploverSupplier | null;
  /** Explicitly scoped exception for TakeOff manual-portal ticket reports. */
  ticketedEvidenceProfile?: TicketedEvidenceProfile;
};

export type SupplierEvidenceValidationIssue = {
  code: string;
  kind: 'missing' | 'mismatch' | 'stale' | 'invalid' | 'conflict';
  source: 'pnr' | 'air-ticketing-details' | 'evidence-set';
};

export type SupplierEvidenceValidationResult = {
  valid: boolean;
  complete: boolean;
  fresh: boolean;
  identityMatches: boolean;
  authoritativeFor: SupplierEvidencePurpose | null;
  /** Null unless valid ticketed evidence selected one of the safe profiles. */
  ticketedProfile: TicketedEvidenceProfile | null;
  issues: SupplierEvidenceValidationIssue[];
};

function identityPart(value: string): string {
  return value.normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function passengerEvidenceIdentityHash(input: {
  passengerType?: string | null;
  firstName: string;
  lastName: string;
}): string {
  return createHash('sha256')
    .update(
      [input.passengerType ?? '', input.firstName, input.lastName]
        .map((value) => identityPart(value))
        .join('|'),
      'utf8'
    )
    .digest('hex');
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function bookingPassengerIdentityHashes(passengers: unknown): string[] {
  const snapshot = record(passengers);
  const rows = Array.isArray(passengers)
    ? passengers
    : Array.isArray(snapshot.travellers)
      ? snapshot.travellers
      : [];
  return Array.from(
    new Set(
      rows.flatMap((value) => {
        const passenger = record(value);
        const firstName = text(passenger.firstName);
        const lastName = text(passenger.lastName);
        if (!firstName || !lastName) return [];
        return [
          passengerEvidenceIdentityHash({
            passengerType: text(passenger.passengerType),
            firstName,
            lastName,
          }),
        ];
      })
    )
  ).sort();
}

export function bookingRouteSignature(
  itinerary: BookedItinerary | null
): string {
  if (!itinerary) return '';
  return itinerary.legs
    .flatMap((leg) =>
      leg.segments.length > 0
        ? leg.segments.map(
            (segment) =>
              `${segment.from.trim().toUpperCase()}-${segment.to
                .trim()
                .toUpperCase()}`
          )
        : [`${leg.from.trim().toUpperCase()}-${leg.to.trim().toUpperCase()}`]
    )
    .join('|');
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

/** Unlike generic supplier matching, this preserves the provider's exact ID. */
function exactText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringValues(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function normalizedSet(values: unknown): string[] {
  return Array.from(
    new Set(stringValues(values).map(normalized).filter(Boolean))
  ).sort();
}

function sameSet(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(normalizedSet(left)) === JSON.stringify(normalizedSet(right))
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

function validTimestamp(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function ticketedEvidenceProfile(
  expected: ExpectedSupplierEvidenceIdentity,
  purpose: SupplierEvidencePurpose
): TicketedEvidenceProfile | null {
  if (purpose !== 'ticketed') return null;
  return expected.ticketedEvidenceProfile === 'takeoff_manual_ticket'
    ? 'takeoff_manual_ticket'
    : 'generic';
}

function hasEvidenceEnvelope(value: unknown): value is NormalizedSupplierEvidence {
  const evidence = record(value);
  return (
    Object.keys(evidence).length > 0 &&
    Object.keys(record(evidence.receipt)).length > 0 &&
    Object.keys(record(evidence.identity)).length > 0 &&
    Object.keys(record(evidence.facts)).length > 0
  );
}

function commonIssues(
  evidence: NormalizedSupplierEvidence,
  expectedUniqueTransId: string,
  expectedSource: 'pnr' | 'air-ticketing-details',
  now: number
): SupplierEvidenceValidationIssue[] {
  const issues: SupplierEvidenceValidationIssue[] = [];
  const source = expectedSource;
  const requestAt = Date.parse(evidence.receipt.requestStartedAt);
  const responseAt = Date.parse(evidence.receipt.responseReceivedAt);
  const observedAt = Date.parse(evidence.observedAt);
  const freshUntil = Date.parse(evidence.freshUntil);
  if (
    evidence.schemaVersion !== 1 ||
    evidence.normalizerVersion !== 1 ||
    evidence.supplier !== 'triplover'
  ) {
    issues.push({ code: 'unsupported_evidence_contract', kind: 'invalid', source });
  }
  if (evidence.source !== expectedSource) {
    issues.push({ code: 'evidence_source_mismatch', kind: 'mismatch', source });
  }
  if (
    !Number.isFinite(requestAt) ||
    !Number.isFinite(responseAt) ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(freshUntil) ||
    requestAt > responseAt ||
    observedAt !== responseAt ||
    freshUntil !== responseAt + 5 * 60_000 ||
    responseAt > now + 60_000
  ) {
    issues.push({ code: 'invalid_evidence_timestamps', kind: 'invalid', source });
  }
  if (Number.isFinite(freshUntil) && now > freshUntil) {
    issues.push({ code: 'evidence_stale', kind: 'stale', source });
  }
  if (
    evidence.receipt.httpStatus !== 200 ||
    !/^[a-f0-9]{64}$/.test(normalized(evidence.receipt.rawPayloadHash).toLowerCase())
  ) {
    issues.push({ code: 'invalid_supplier_receipt', kind: 'invalid', source });
  }
  if (
    normalized(evidence.identity.uniqueTransId) !==
    normalized(expectedUniqueTransId)
  ) {
    issues.push({ code: 'unique_transaction_mismatch', kind: 'mismatch', source });
  }
  return issues;
}

function pnrIssues(
  evidence: NormalizedPnrEvidence,
  expected: ExpectedSupplierEvidenceIdentity,
  purpose: SupplierEvidencePurpose,
  now: number
): SupplierEvidenceValidationIssue[] {
  const issues = commonIssues(evidence, expected.uniqueTransId, 'pnr', now);
  const acceptedPnr = normalizedSet(expected.acceptedPnr);
  for (const [code, value] of [
    ['requested_pnr_mismatch', evidence.identity.requestedPnr],
    ['booking_reference_mismatch', evidence.identity.bookingRefNumber],
    ['response_pnr_mismatch', evidence.facts.responsePnr],
  ] as const) {
    if (!acceptedPnr.includes(normalized(value))) {
      issues.push({ code, kind: 'mismatch', source: 'pnr' });
    }
  }
  if (
    normalized(evidence.identity.bookingCodeRef) !==
    normalized(expected.bookingCodeRef)
  ) {
    issues.push({ code: 'booking_code_mismatch', kind: 'mismatch', source: 'pnr' });
  }
  if (!normalized(evidence.identity.itemCodeRef) || !normalized(evidence.identity.priceCodeRef)) {
    issues.push({ code: 'supplier_reference_chain_incomplete', kind: 'missing', source: 'pnr' });
  }
  const pnrEchoes = evidence.facts.supplierEchoedUniqueTransIds;
  if (pnrEchoes !== undefined && pnrEchoes !== null) {
    if (
      !Array.isArray(pnrEchoes) ||
      pnrEchoes.some(
        (value) => typeof value !== 'string' || value.trim().length === 0
      )
    ) {
      issues.push({
        code: 'pnr_supplier_unique_transaction_invalid',
        kind: 'invalid',
        source: 'pnr',
      });
    } else {
      const expectedExactUniqueTransId = exactText(
        expected.exactUniqueTransId ?? expected.uniqueTransId
      );
      for (const echoedUniqueTransId of pnrEchoes) {
        // An echoed PNR transaction ID is supplier evidence, not request
        // metadata. Once present, it must bind byte-for-byte to the stored
        // supplier reference; no trimming/case normalization is permitted.
        if (echoedUniqueTransId !== expectedExactUniqueTransId) {
          issues.push({
            code: 'pnr_supplier_unique_transaction_mismatch',
            kind: 'mismatch',
            source: 'pnr',
          });
          break;
        }
      }
    }
  }
  const status = normalized(evidence.facts.supplierStatus).replace(/[\s_-]+/g, '');
  const acceptedStatuses: Record<SupplierEvidencePurpose, string[]> = {
    held: ['BOOKED', 'CREATED', 'HELD', 'ONHOLD'],
    ticketed: ['CONFIRMED', 'ISSUED', 'TICKETED'],
    cancelled: ['CANCELLED', 'CANCELED', 'REFUNDED'],
  };
  if (!acceptedStatuses[purpose].includes(status)) {
    issues.push({ code: 'pnr_status_conflict', kind: 'conflict', source: 'pnr' });
  }
  if (purpose === 'held' && normalizedSet(evidence.facts.airlinesPnr).length === 0) {
    issues.push({ code: 'airline_pnr_missing', kind: 'missing', source: 'pnr' });
  }
  return issues;
}

function ticketingIssues(
  evidence: NormalizedAirTicketingEvidence,
  expected: ExpectedSupplierEvidenceIdentity,
  purpose: Exclude<SupplierEvidencePurpose, 'held'>,
  now: number
): SupplierEvidenceValidationIssue[] {
  const issues = commonIssues(
    evidence,
    expected.uniqueTransId,
    'air-ticketing-details',
    now
  );
  if (!normalizedSet(expected.acceptedPnr).includes(normalized(evidence.facts.pnr))) {
    issues.push({ code: 'ticketing_pnr_mismatch', kind: 'mismatch', source: 'air-ticketing-details' });
  }
  const allowedQuery = purpose === 'ticketed'
    ? ['CONFIRMED']
    : ['CANCELLED', 'REFUNDED'];
  if (!allowedQuery.includes(normalized(evidence.identity.queryStatus))) {
    issues.push({ code: 'ticketing_query_status_mismatch', kind: 'mismatch', source: 'air-ticketing-details' });
  }
  const supplierStatus = normalized(evidence.facts.supplierStatus).replace(/[\s_-]+/g, '');
  const allowedStatus = purpose === 'ticketed'
    ? ['CONFIRMED', 'ISSUED', 'TICKETED']
    : ['CANCELLED', 'CANCELED', 'REFUNDED'];
  if (!allowedStatus.includes(supplierStatus)) {
    issues.push({ code: 'ticketing_status_conflict', kind: 'conflict', source: 'air-ticketing-details' });
  }
  if (normalizedSet(expected.passengerIdentityHashes).length === 0) {
    issues.push({ code: 'expected_passenger_identity_missing', kind: 'missing', source: 'evidence-set' });
  } else if (
    evidence.facts.passengerCount !==
      normalizedSet(expected.passengerIdentityHashes).length ||
    !sameSet(evidence.facts.passengerIdentityHashes, expected.passengerIdentityHashes)
  ) {
    issues.push({ code: 'passenger_identity_mismatch', kind: 'mismatch', source: 'air-ticketing-details' });
  }
  if (!normalized(expected.routeSignature)) {
    issues.push({ code: 'expected_route_identity_missing', kind: 'missing', source: 'evidence-set' });
  } else if (
    normalized(evidence.facts.routeSignature) !== normalized(expected.routeSignature)
  ) {
    issues.push({ code: 'route_identity_mismatch', kind: 'mismatch', source: 'air-ticketing-details' });
  }
  if (purpose === 'ticketed') {
    const profile = ticketedEvidenceProfile(expected, purpose);
    if (
      profile === 'takeoff_manual_ticket' &&
      expected.supplierAccount !== 'takeoff'
    ) {
      issues.push({
        code: 'takeoff_manual_ticket_profile_forbidden',
        kind: 'invalid',
        source: 'evidence-set',
      });
    }
    if (profile === 'takeoff_manual_ticket') {
      const echoedUniqueTransId = exactText(
        evidence.facts.ticketInfoUniqueTransId
      );
      const expectedUniqueTransId = exactText(expected.uniqueTransId);
      if (!echoedUniqueTransId) {
        issues.push({
          code: 'ticket_info_unique_transaction_missing',
          kind: 'missing',
          source: 'air-ticketing-details',
        });
      } else if (echoedUniqueTransId !== expectedUniqueTransId) {
        issues.push({
          code: 'ticket_info_unique_transaction_mismatch',
          kind: 'mismatch',
          source: 'air-ticketing-details',
        });
      }
      if (!positiveSafeInteger(evidence.facts.supplierBookingId)) {
        issues.push({
          code: 'supplier_booking_id_missing_or_invalid',
          kind: 'missing',
          source: 'air-ticketing-details',
        });
      }
      if (!validTimestamp(evidence.facts.issuedAt)) {
        issues.push({
          code: 'issued_at_missing_or_invalid',
          kind: 'missing',
          source: 'air-ticketing-details',
        });
      }
    } else if (!normalized(evidence.facts.ticketCodeRef)) {
      // Preserve the generic contract. Only the explicit, TakeOff-scoped
      // profile above can use the stronger portal identifiers in its place.
      issues.push({ code: 'ticket_code_missing', kind: 'missing', source: 'air-ticketing-details' });
    }
    if (normalizedSet(evidence.facts.ticketNumbers).length === 0) {
      issues.push({ code: 'ticket_numbers_missing', kind: 'missing', source: 'air-ticketing-details' });
    }
  }
  if (
    expected.ticketCodeRef &&
    normalized(evidence.facts.ticketCodeRef) !== normalized(expected.ticketCodeRef)
  ) {
    issues.push({ code: 'ticket_code_mismatch', kind: 'mismatch', source: 'air-ticketing-details' });
  }
  if (
    normalizedSet(expected.ticketNumbers).length > 0 &&
    !sameSet(evidence.facts.ticketNumbers, expected.ticketNumbers)
  ) {
    issues.push({ code: 'ticket_numbers_mismatch', kind: 'mismatch', source: 'air-ticketing-details' });
  }
  return issues;
}

export function validateSupplierEvidenceSet(input: {
  purpose: SupplierEvidencePurpose;
  expected: ExpectedSupplierEvidenceIdentity;
  pnr?: unknown;
  airTicketing?: unknown;
  now?: number;
}): SupplierEvidenceValidationResult {
  const now = input.now ?? Date.now();
  const issues: SupplierEvidenceValidationIssue[] = [];
  if (!normalized(input.expected.uniqueTransId)) {
    issues.push({
      code: 'expected_unique_transaction_missing',
      kind: 'missing',
      source: 'evidence-set',
    });
  }
  if (normalizedSet(input.expected.acceptedPnr).length === 0) {
    issues.push({
      code: 'expected_pnr_missing',
      kind: 'missing',
      source: 'evidence-set',
    });
  }
  if (!normalized(input.expected.bookingCodeRef)) {
    issues.push({
      code: 'expected_booking_code_missing',
      kind: 'missing',
      source: 'evidence-set',
    });
  }
  if (!input.pnr) {
    issues.push({ code: 'pnr_evidence_missing', kind: 'missing', source: 'evidence-set' });
  } else if (!hasEvidenceEnvelope(input.pnr)) {
    issues.push({ code: 'pnr_evidence_malformed', kind: 'invalid', source: 'pnr' });
  } else {
    issues.push(
      ...pnrIssues(
        input.pnr as NormalizedPnrEvidence,
        input.expected,
        input.purpose,
        now
      )
    );
  }
  if (input.purpose !== 'held') {
    if (!input.airTicketing) {
      issues.push({ code: 'air_ticketing_evidence_missing', kind: 'missing', source: 'evidence-set' });
    } else if (!hasEvidenceEnvelope(input.airTicketing)) {
      issues.push({
        code: 'air_ticketing_evidence_malformed',
        kind: 'invalid',
        source: 'air-ticketing-details',
      });
    } else {
      issues.push(
        ...ticketingIssues(
          input.airTicketing as NormalizedAirTicketingEvidence,
          input.expected,
          input.purpose,
          now
        )
      );
    }
  }
  const complete = !issues.some(
    (issue) => issue.kind === 'missing' || issue.code.endsWith('_malformed')
  );
  const fresh = !issues.some(
    (issue) =>
      issue.kind === 'stale' || issue.code === 'invalid_evidence_timestamps'
  );
  const identityMatches = !issues.some(
    (issue) =>
      issue.kind === 'mismatch' || issue.code.startsWith('expected_')
  );
  const valid = issues.length === 0;
  return {
    valid,
    complete,
    fresh,
    identityMatches,
    authoritativeFor: valid ? input.purpose : null,
    ticketedProfile:
      valid && input.purpose === 'ticketed'
        ? ticketedEvidenceProfile(input.expected, input.purpose)
        : null,
    issues,
  };
}
