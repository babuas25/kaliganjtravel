import 'server-only';

import { createHash } from 'node:crypto';

import type { SupplierReadReceipt } from '@/lib/booking-lifecycle/supplier-evidence';
import type { BookingRow } from '@/lib/db/flight-bookings';
import type { BookedItinerary, BookingPassengerType } from '@/lib/flights/booking';
import {
  isTriploverSupplier,
  type TriploverSupplier,
} from '@/lib/triplover/config';

export const CANONICAL_SUPPLIER_EVIDENCE_SCHEMA_VERSION = 2 as const;
export const CANONICAL_SUPPLIER_EVIDENCE_NORMALIZER_VERSION = 2 as const;
export const CANONICAL_SUPPLIER_EVIDENCE_FRESHNESS_MS = 5 * 60_000;

export type SupplierEvidencePurpose = 'held' | 'ticketed' | 'cancelled';
export type CanonicalEvidenceSource = 'pnr' | 'ticket-report';
export type CanonicalLifecycleState =
  | 'held'
  | 'ticketed'
  | 'cancelled'
  | 'refunded'
  | 'unknown';

export type CanonicalOperationalReferences = {
  itemCodeRef: string | null;
  priceCodeRef: string | null;
  bookingCodeRef: string | null;
};

export type CanonicalSupplierBookingIdentity = {
  /** Supplier transaction/workflow identifier. Never interchangeable with a PNR. */
  transactionId: string | null;
  /** Supplier's internal booking row identifier, normally numeric but kept opaque. */
  supplierBookingId: string | null;
  /** Supplier/GDS locator. */
  supplierPnr: string | null;
  /** Supplier booking reference when distinct from supplier PNR. */
  bookingReference: string | null;
  /** Airline record locators only. */
  airlinePnrs: string[];
  /** Supplier-returned locators classified without treating unlike concepts as aliases. */
  responseLocators: Array<{
    value: string;
    kind: 'supplier-pnr' | 'booking-reference' | 'airline-pnr' | 'unclassified';
  }>;
  /** Contradictions within one supplier response; never resolved by precedence. */
  identityConflicts: string[];
  /** Opaque request-chain references, kept as separately typed values. */
  operationalReferences: CanonicalOperationalReferences;
};

export type CanonicalPassengerIdentity = {
  sequence: number;
  passengerType: string;
  givenNames: string;
  surname: string;
  dateOfBirth: string | null;
  documentHash: string | null;
  identityHash: string;
};

export type CanonicalItinerarySegment = {
  sequence: number;
  origin: string;
  destination: string;
  marketingCarrier: string | null;
  operatingCarrier: string | null;
  flightNumber: string;
  travelDate: string;
  departureAt: string | null;
  arrivalAt: string | null;
  codeshare: boolean | null;
  codeshareAmbiguous: boolean;
};

export type CanonicalTicketDocument = {
  fullNumber: string;
  airlineAccountingCode: string | null;
  serialNumber: string | null;
  passengerIdentityHash: string | null;
  derivation: 'supplier-full-document' | 'iata-13-digit';
};

export type CanonicalFinancialEvidence = {
  currency: string | null;
  supplierPayableMinor: number | null;
  supplierGrossMinor: number | null;
  currencySource: 'supplier' | 'supplier-contract' | 'local-booking' | null;
};

export type CanonicalLifecycleEvidence = {
  state: CanonicalLifecycleState;
  rawStatus: string | null;
  rawBookedAt: string | null;
  rawIssuedAt: string | null;
  rawCancelledAt: string | null;
  rawTicketingDeadline: string | null;
  bookedAt: string | null;
  issuedAt: string | null;
  cancelledAt: string | null;
  ticketingDeadlineAt: string | null;
};

export type CanonicalEvidenceCompleteness = {
  bookingIdentity: boolean;
  passengers: boolean;
  itinerary: boolean;
  tickets: boolean;
  financial: boolean;
  lifecycle: boolean;
};

export type CanonicalSupplierEvidenceV2 = {
  schemaVersion: 2;
  normalizerVersion: 2;
  supplierFamily: 'triplover';
  supplierAccount: TriploverSupplier;
  adapterVersion: 2;
  source: CanonicalEvidenceSource;
  observedAt: string;
  freshUntil: string;
  receipt: SupplierReadReceipt;
  query: {
    requestedLifecycleState: CanonicalLifecycleState | null;
  };
  requestIdentity: CanonicalSupplierBookingIdentity;
  bookingIdentity: CanonicalSupplierBookingIdentity;
  passengers: CanonicalPassengerIdentity[];
  itinerary: CanonicalItinerarySegment[];
  tickets: CanonicalTicketDocument[];
  /** `ticketCodeRef` is workflow metadata, never airline ticket identity. */
  supplierWorkflowReference: string | null;
  lifecycle: CanonicalLifecycleEvidence;
  financial: CanonicalFinancialEvidence;
  completeness: CanonicalEvidenceCompleteness;
};

export type CanonicalExpectedBookingV2 = {
  supplierFamily: 'triplover';
  supplierAccount: TriploverSupplier | null;
  bookingIdentity: CanonicalSupplierBookingIdentity;
  passengers: CanonicalPassengerIdentity[];
  itinerary: CanonicalItinerarySegment[];
  tickets: CanonicalTicketDocument[];
  supplierWorkflowReference: string | null;
  financial: CanonicalFinancialEvidence;
};

type UnknownRecord = Record<string, unknown>;

export function evidenceRecord(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

export function evidenceText(...values: unknown[]): string {
  return values.find(
    (value): value is string => typeof value === 'string' && value.trim() !== ''
  )?.trim() ?? '';
}

export function evidenceStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) =>
    typeof item === 'string'
      ? item.split(',').map((part) => part.trim()).filter(Boolean)
      : []
  );
}

function identityText(value: unknown): string {
  return evidenceText(value)
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalPassengerIdentity(input: {
  sequence: number;
  passengerType?: unknown;
  first?: unknown;
  middle?: unknown;
  last?: unknown;
  dateOfBirth?: unknown;
  documentNumber?: unknown;
}): CanonicalPassengerIdentity | null {
  const passengerType = identityText(input.passengerType);
  const givenNames = evidenceText(input.first, input.middle)
    ? [evidenceText(input.first), evidenceText(input.middle)]
        .filter(Boolean)
        .join(' ')
    : '';
  const surname = evidenceText(input.last);
  if (!passengerType || !givenNames || !surname) return null;
  const dateOfBirth = canonicalDate(input.dateOfBirth);
  const document = identityText(input.documentNumber);
  const core = [passengerType, identityText(givenNames), identityText(surname)].join('|');
  return {
    sequence: input.sequence,
    passengerType,
    givenNames,
    surname,
    dateOfBirth,
    documentHash: document ? sha256(document) : null,
    identityHash: sha256(core),
  };
}

export function canonicalDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  if (match) return match[1];
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : null;
}

export function canonicalCarrier(value: unknown): string | null {
  const carrier = identityText(value);
  return /^[A-Z0-9]{2,3}$/.test(carrier) ? carrier : null;
}

export function canonicalAirport(value: unknown): string {
  const airport = identityText(value);
  return /^[A-Z0-9]{3}$/.test(airport) ? airport : '';
}

export function canonicalFlightNumber(value: unknown): string {
  return identityText(value);
}

export function canonicalTicketDocument(
  value: unknown,
  passengerIdentityHash: string | null = null
): CanonicalTicketDocument | null {
  const fullNumber = identityText(value);
  if (!fullNumber) return null;
  const iata = /^(\d{3})(\d{10})$/.exec(fullNumber);
  return {
    fullNumber,
    airlineAccountingCode: iata?.[1] ?? null,
    serialNumber: iata?.[2] ?? null,
    passengerIdentityHash,
    derivation: iata ? 'iata-13-digit' : 'supplier-full-document',
  };
}

export function canonicalMoneyMinor(value: unknown): number | null {
  const amount =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0) return null;
  const minor = Math.round(amount * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function canonicalCurrency(value: unknown): string | null {
  const currency = identityText(value);
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

export function canonicalLifecycleState(value: unknown): CanonicalLifecycleState {
  const status = identityText(value);
  if (['BOOKED', 'CREATED', 'HELD', 'ONHOLD'].includes(status)) return 'held';
  if (['CONFIRMED', 'ISSUED', 'TICKETED'].includes(status)) return 'ticketed';
  if (['CANCELLED', 'CANCELED'].includes(status)) return 'cancelled';
  if (status === 'REFUNDED') return 'refunded';
  return 'unknown';
}

export function emptyOperationalReferences(): CanonicalOperationalReferences {
  return { itemCodeRef: null, priceCodeRef: null, bookingCodeRef: null };
}

export function emptyBookingIdentity(): CanonicalSupplierBookingIdentity {
  return {
    transactionId: null,
    supplierBookingId: null,
    supplierPnr: null,
    bookingReference: null,
    airlinePnrs: [],
    responseLocators: [],
    identityConflicts: [],
    operationalReferences: emptyOperationalReferences(),
  };
}

export function canonicalEvidenceEnvelope(input: Omit<CanonicalSupplierEvidenceV2,
  'schemaVersion' | 'normalizerVersion' | 'supplierFamily' | 'adapterVersion' |
  'observedAt' | 'freshUntil'>): CanonicalSupplierEvidenceV2 {
  const observedAt = input.receipt.responseReceivedAt;
  return {
    schemaVersion: CANONICAL_SUPPLIER_EVIDENCE_SCHEMA_VERSION,
    normalizerVersion: CANONICAL_SUPPLIER_EVIDENCE_NORMALIZER_VERSION,
    supplierFamily: 'triplover',
    adapterVersion: 2,
    observedAt,
    freshUntil: new Date(
      Date.parse(observedAt) + CANONICAL_SUPPLIER_EVIDENCE_FRESHNESS_MS
    ).toISOString(),
    ...input,
  };
}

function localPassengerRows(passengers: unknown): UnknownRecord[] {
  const snapshot = evidenceRecord(passengers);
  const values = Array.isArray(passengers)
    ? passengers
    : Array.isArray(snapshot.travellers)
      ? snapshot.travellers
      : [];
  return values.map(evidenceRecord);
}

function expectedPassengers(passengers: unknown): CanonicalPassengerIdentity[] {
  return localPassengerRows(passengers).flatMap((passenger, index) => {
    const identity = canonicalPassengerIdentity({
      sequence: index,
      passengerType: passenger.passengerType,
      first: passenger.firstName,
      middle: passenger.middleName,
      last: passenger.lastName,
      dateOfBirth: passenger.dateOfBirth,
      documentNumber: passenger.passportNumber,
    });
    return identity ? [identity] : [];
  });
}

export function canonicalSegmentsFromBookedItinerary(
  itinerary: BookedItinerary | null
): CanonicalItinerarySegment[] {
  if (!itinerary) return [];
  return itinerary.legs.flatMap((leg) =>
    leg.segments.map((segment) => {
      const carrier = canonicalCarrier(segment.airlineCode);
      return {
        sequence: 0,
        origin: canonicalAirport(segment.from),
        destination: canonicalAirport(segment.to),
        marketingCarrier: carrier,
        operatingCarrier: null,
        flightNumber: canonicalFlightNumber(segment.flightNumber),
        travelDate: canonicalDate(segment.departure) ?? '',
        departureAt: null,
        arrivalAt: null,
        codeshare: null,
        codeshareAmbiguous: false,
      };
    })
  ).map((segment, sequence) => ({ ...segment, sequence }));
}

function expectedTicketDocuments(ticketNumbers: unknown): CanonicalTicketDocument[] {
  return evidenceStringList(ticketNumbers).flatMap((value) => {
    const ticket = canonicalTicketDocument(value);
    return ticket ? [ticket] : [];
  });
}

function supplierPayableFromBooking(booking: BookingRow): number | null {
  return canonicalMoneyMinor(booking.pricing_snapshot?.supplierTotalPrice);
}

export function canonicalExpectedBookingV2(
  booking: BookingRow
): CanonicalExpectedBookingV2 {
  return {
    supplierFamily: 'triplover',
    supplierAccount: isTriploverSupplier(booking.supplier_account)
      ? booking.supplier_account : null,
    bookingIdentity: {
      transactionId: evidenceText(booking.supplier_refs?.uniqueTransId) || null,
      supplierBookingId: null,
      supplierPnr: evidenceText(booking.pnr) || null,
      bookingReference: evidenceText(booking.booking_ref_number) || null,
      airlinePnrs: evidenceStringList(booking.airlines_pnr),
      responseLocators: [],
      identityConflicts: [],
      operationalReferences: {
        itemCodeRef: evidenceText(booking.supplier_refs?.itemCodeRef) || null,
        priceCodeRef: evidenceText(booking.supplier_refs?.priceCodeRef) || null,
        bookingCodeRef: evidenceText(booking.booking_code_ref) || null,
      },
    },
    passengers: expectedPassengers(booking.passengers),
    itinerary: canonicalSegmentsFromBookedItinerary(booking.itinerary),
    tickets: expectedTicketDocuments(booking.ticket_numbers),
    supplierWorkflowReference: evidenceText(booking.ticket_code_ref) || null,
    financial: {
      currency: canonicalCurrency(booking.currency),
      supplierPayableMinor: supplierPayableFromBooking(booking),
      supplierGrossMinor: canonicalMoneyMinor(booking.pricing_snapshot?.grossPrice),
      currencySource: 'local-booking',
    },
  };
}

export function isCanonicalSupplierEvidenceV2(
  value: unknown
): value is CanonicalSupplierEvidenceV2 {
  const evidence = evidenceRecord(value);
  return (
    evidence.schemaVersion === 2 &&
    evidence.normalizerVersion === 2 &&
    evidence.supplierFamily === 'triplover' &&
    isTriploverSupplier(evidence.supplierAccount) &&
    (evidence.source === 'pnr' || evidence.source === 'ticket-report') &&
    Array.isArray(evidence.passengers) &&
    Array.isArray(evidence.itinerary) &&
    Array.isArray(evidence.tickets) &&
    Object.keys(evidenceRecord(evidence.query)).length > 0 &&
    Object.keys(evidenceRecord(evidence.bookingIdentity)).length > 0 &&
    Object.keys(evidenceRecord(evidence.requestIdentity)).length > 0 &&
    Object.keys(evidenceRecord(evidence.lifecycle)).length > 0 &&
    Object.keys(evidenceRecord(evidence.financial)).length > 0 &&
    Object.keys(evidenceRecord(evidence.completeness)).length > 0 &&
    Object.keys(evidenceRecord(evidence.receipt)).length > 0
  );
}

export function canonicalPassengerType(value: unknown): BookingPassengerType | null {
  const type = identityText(value);
  return ['ADT', 'CHD', 'CNN', 'INF', 'INS'].includes(type)
    ? (type as BookingPassengerType)
    : null;
}
