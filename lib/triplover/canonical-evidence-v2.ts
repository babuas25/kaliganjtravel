import 'server-only';

import { airlinePnrs as validAirlinePnrs } from '@/lib/flights/airline-pnr';

import {
  canonicalAirport,
  canonicalCarrier,
  canonicalCurrency,
  canonicalDate,
  canonicalEvidenceEnvelope,
  canonicalFlightNumber,
  canonicalLifecycleState,
  canonicalMoneyMinor,
  canonicalPassengerIdentity,
  canonicalTicketDocument,
  emptyBookingIdentity,
  evidenceRecord,
  evidenceStringList,
  evidenceText,
  type CanonicalItinerarySegment,
  type CanonicalPassengerIdentity,
  type CanonicalSupplierBookingIdentity,
  type CanonicalSupplierEvidenceV2,
  type CanonicalTicketDocument,
} from '@/lib/booking-lifecycle/canonical-supplier-evidence-v2';
import type { SupplierReadReceipt } from '@/lib/booking-lifecycle/supplier-evidence';
import type { PrivateBookingRefs } from '@/lib/flights/booking';
import type { TriploverSupplier } from '@/lib/triplover/config';
import { supplierLifecycleInstant } from '@/lib/triplover/time';

type UnknownRecord = Record<string, unknown>;

export type TriploverPnrAdapterInput = {
  supplier: TriploverSupplier;
  receipt: SupplierReadReceipt;
  request: PrivateBookingRefs & {
    pnr: string;
    bookingRefNumber: string;
    bookingCodeRef: string;
  };
  raw: UnknownRecord;
  envelopeUniqueTransIds: unknown;
  ticketingDeadlineAt: string | null;
};

export type TriploverTicketReportAdapterInput = {
  supplier: TriploverSupplier;
  receipt: SupplierReadReceipt;
  requestedUniqueTransId: string;
  requestedStatus: string;
  raw: UnknownRecord;
};

function exact(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Shared parser used by reconciliation and supplier-reference import. */
export function parseTriploverReferenceLog(value: unknown): UnknownRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return evidenceRecord(value);
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return evidenceRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function exactEchoes(payload: UnknownRecord, envelope: unknown): string[] {
  const values = [
    payload.uniqueTransID,
    payload.uniqueTransId,
    payload.UniqueTransID,
    payload.UniqueTransId,
    ...(Array.isArray(envelope) ? envelope : []),
  ];
  return Array.from(
    new Set(values.filter((value): value is string =>
      typeof value === 'string' && value.trim().length > 0))
  );
}

function classifiedResponseLocators(input: {
  responsePnr: string | null;
  requestedSupplierPnr: string | null;
  requestedBookingReference: string | null;
  airlinePnrs: string[];
}): CanonicalSupplierBookingIdentity['responseLocators'] {
  if (!input.responsePnr) return [];
  const normalized = input.responsePnr.toUpperCase();
  const kind = input.requestedSupplierPnr?.toUpperCase() === normalized
    ? 'supplier-pnr'
    : input.requestedBookingReference?.toUpperCase() === normalized
      ? 'booking-reference'
      : input.airlinePnrs.some((pnr) => pnr.toUpperCase() === normalized)
        ? 'airline-pnr'
        : 'unclassified';
  return [{ value: input.responsePnr, kind }];
}

function passengerRows(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(evidenceRecord) : [];
}

function canonicalPassengers(value: unknown): {
  passengers: CanonicalPassengerIdentity[];
  complete: boolean;
} {
  const rows = passengerRows(value);
  let declaredCount = 0;
  let countValid = true;
  const passengers = rows.flatMap((outer, sequence) => {
    const passenger = evidenceRecord(outer.passengerInfo ?? outer);
    const name = evidenceRecord(passenger.nameElement ?? passenger.name);
    const countValue = outer.passengerCount ?? passenger.passengerCount ?? 1;
    const count = Number(countValue);
    if (!Number.isSafeInteger(count) || count <= 0) countValid = false;
    else declaredCount += count;
    const identity = canonicalPassengerIdentity({
      sequence,
      passengerType: evidenceText(
        passenger.passengerType,
        passenger.paxType,
        passenger.ptc
      ),
      // Both FirstTrip and TakeOff currently use the flat first/last shape.
      // Nested aliases remain accepted because older Triplover report payloads
      // used them and the supplier-reference importer already supports both.
      first: evidenceText(
        passenger.first,
        passenger.firstName,
        passenger.givenName,
        name.firstName,
        name.givenName
      ),
      middle: evidenceText(passenger.middle, passenger.middleName, name.middleName),
      last: evidenceText(
        passenger.last,
        passenger.lastName,
        passenger.surname,
        name.lastName,
        name.surname
      ),
      dateOfBirth: passenger.dateOfBirth,
      documentNumber: evidenceText(
        passenger.documentNumber,
        passenger.passportNumber
      ),
    });
    return identity ? [identity] : [];
  });
  return {
    passengers,
    complete:
      rows.length > 0 &&
      countValid &&
      declaredCount === passengers.length &&
      passengers.length === rows.length,
  };
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function canonicalSegments(
  supplier: TriploverSupplier,
  value: unknown
): { itinerary: CanonicalItinerarySegment[]; complete: boolean } {
  const rows = Array.isArray(value) ? value.map(evidenceRecord) : [];
  let complete = rows.length > 0;
  const itinerary = rows.map((segment, sequence) => {
    const marketingCarrier = canonicalCarrier(evidenceText(
      segment.marketingCarrier,
      segment.marketingAirline,
      segment.airlineCode
    ));
    const operatingCarrier = canonicalCarrier(evidenceText(
      segment.operationCarrier,
      segment.operatingCarrier
    ));
    const codeshare = booleanOrNull(segment.isCodeShared ?? segment.isCodeshare);
    const codeshareAmbiguous =
      codeshare === true && (!marketingCarrier || !operatingCarrier);
    const origin = canonicalAirport(
      evidenceText(segment.origin, segment.from, segment.originCode)
    );
    const destination = canonicalAirport(
      evidenceText(segment.destination, segment.to, segment.destinationCode)
    );
    const flightNumber = canonicalFlightNumber(
      evidenceText(segment.flightNumber, segment.flightNo)
    );
    const travelDate = canonicalDate(segment.departure) ?? '';
    if (
      !origin ||
      !destination ||
      !flightNumber ||
      !travelDate ||
      (!marketingCarrier && !operatingCarrier) ||
      codeshareAmbiguous
    ) complete = false;
    return {
      sequence,
      origin,
      destination,
      marketingCarrier,
      operatingCarrier,
      flightNumber,
      travelDate,
      departureAt: supplierLifecycleInstant(supplier, segment.departure),
      arrivalAt: supplierLifecycleInstant(supplier, segment.arrival),
      codeshare,
      codeshareAmbiguous,
    };
  });
  return { itinerary, complete };
}

function canonicalTickets(
  passengers: CanonicalPassengerIdentity[],
  value: unknown
): CanonicalTicketDocument[] {
  return passengerRows(value).flatMap((outer, index) => {
    const passenger = evidenceRecord(outer.passengerInfo ?? outer);
    const passengerHash = passengers[index]?.identityHash ?? null;
    return evidenceStringList(
      passenger.ticketNumbers ?? passenger.ticketNumber
    ).flatMap((number) => {
      const ticket = canonicalTicketDocument(number, passengerHash);
      return ticket ? [ticket] : [];
    });
  });
}

function reportCurrency(
  supplier: TriploverSupplier,
  raw: UnknownRecord,
  ticket: UnknownRecord
) {
  const reported = canonicalCurrency(evidenceText(
    ticket.currency,
    ticket.currencyCode,
    raw.currency,
    raw.currencyCode
  ));
  if (reported) {
    return { currency: reported, currencySource: 'supplier' as const };
  }
  // The integrated Triplover contracts settle these report values in BDT.
  // This is provider configuration at the adapter boundary, not a
  // local-booking fallback or a reconciliation exemption.
  const contractCurrency: Record<TriploverSupplier, 'BDT'> = {
    firsttrip: 'BDT',
    takeoff: 'BDT',
    triplover: 'BDT',
  };
  return {
    currency: contractCurrency[supplier],
    currencySource: 'supplier-contract' as const,
  };
}

function reportBookingIdentity(
  ticket: UnknownRecord,
  log: UnknownRecord
): CanonicalSupplierBookingIdentity {
  const ticketTransactionId = exact(ticket.uniqueTransID);
  const logTransactionId = exact(log.UniqueTransID);
  const ticketPnr = exact(ticket.pnr);
  const logPnr = exact(log.PNR);
  const identityConflicts: string[] = [];
  if (
    ticketTransactionId &&
    logTransactionId &&
    ticketTransactionId !== logTransactionId
  ) identityConflicts.push('transaction_id_conflict');
  if (ticketPnr && logPnr && ticketPnr !== logPnr) {
    identityConflicts.push('supplier_pnr_conflict');
  }
  const supplierPnr = logPnr ?? ticketPnr;
  const bookingReference = exact(log.BookingRefNumber);
  const airlinePnrs = validAirlinePnrs(ticket.airlinePNRs);
  return {
    transactionId: ticketTransactionId ?? logTransactionId,
    supplierBookingId:
      typeof ticket.bookingId === 'number' && Number.isSafeInteger(ticket.bookingId)
        ? String(ticket.bookingId)
        : exact(ticket.bookingId),
    supplierPnr,
    bookingReference,
    airlinePnrs,
    responseLocators: [
      ...(supplierPnr ? [{ value: supplierPnr, kind: 'supplier-pnr' as const }] : []),
      ...(bookingReference
        ? [{ value: bookingReference, kind: 'booking-reference' as const }]
        : []),
      ...airlinePnrs.map((value) => ({ value, kind: 'airline-pnr' as const })),
    ],
    identityConflicts,
    operationalReferences: {
      itemCodeRef: exact(log.ItemCodeRef),
      priceCodeRef: exact(log.PriceCodeRef),
      bookingCodeRef: exact(log.BookingCodeRef),
    },
  };
}

export function adaptTriploverPnrEvidenceV2(
  input: TriploverPnrAdapterInput
): CanonicalSupplierEvidenceV2 {
  const responsePnr = exact(input.raw.pnr);
  const airlinePnrs = validAirlinePnrs(input.raw.airlinePNRs);
  const echoes = exactEchoes(input.raw, input.envelopeUniqueTransIds);
  const requestIdentity: CanonicalSupplierBookingIdentity = {
    transactionId: input.request.uniqueTransId,
    supplierBookingId: null,
    supplierPnr: input.request.pnr,
    bookingReference: input.request.bookingRefNumber,
    airlinePnrs: [],
    responseLocators: [],
    identityConflicts: [],
    operationalReferences: {
      itemCodeRef: input.request.itemCodeRef,
      priceCodeRef: input.request.priceCodeRef,
      bookingCodeRef: input.request.bookingCodeRef,
    },
  };
  const bookingIdentity: CanonicalSupplierBookingIdentity = {
    ...emptyBookingIdentity(),
    transactionId: echoes.length === 1 ? echoes[0]! : null,
    airlinePnrs,
    responseLocators: classifiedResponseLocators({
      responsePnr,
      requestedSupplierPnr: input.request.pnr,
      requestedBookingReference: input.request.bookingRefNumber,
      airlinePnrs,
    }),
    identityConflicts:
      echoes.length > 1 ? ['transaction_id_conflict'] : [],
  };
  return canonicalEvidenceEnvelope({
    supplierAccount: input.supplier,
    source: 'pnr',
    receipt: input.receipt,
    query: { requestedLifecycleState: null },
    requestIdentity,
    bookingIdentity,
    passengers: [],
    itinerary: [],
    tickets: [],
    supplierWorkflowReference: null,
    lifecycle: {
      state: canonicalLifecycleState(input.raw.status),
      rawStatus: exact(input.raw.status),
      rawBookedAt: null,
      rawIssuedAt: null,
      rawCancelledAt: null,
      rawTicketingDeadline: exact(input.raw.lastTicketTime),
      bookedAt: null,
      issuedAt: null,
      cancelledAt: null,
      ticketingDeadlineAt: input.ticketingDeadlineAt,
    },
    financial: {
      currency: null,
      supplierPayableMinor: null,
      supplierGrossMinor: null,
      currencySource: null,
    },
    completeness: {
      bookingIdentity:
        echoes.length === 1 &&
        Boolean(responsePnr) &&
        airlinePnrs.length > 0,
      passengers: false,
      itinerary: false,
      tickets: false,
      financial: false,
      lifecycle: canonicalLifecycleState(input.raw.status) !== 'unknown',
    },
  });
}

export function adaptTriploverTicketReportEvidenceV2(
  input: TriploverTicketReportAdapterInput
): CanonicalSupplierEvidenceV2 {
  const ticket = evidenceRecord(input.raw.ticketInfo);
  const log = parseTriploverReferenceLog(ticket.referenceLog);
  const parsedPassengers = canonicalPassengers(input.raw.passengerInfo);
  const parsedItinerary = canonicalSegments(input.supplier, input.raw.segments);
  const tickets = canonicalTickets(parsedPassengers.passengers, input.raw.passengerInfo);
  const currency = reportCurrency(input.supplier, input.raw, ticket);
  const state = canonicalLifecycleState(ticket.status);
  const bookingIdentity = reportBookingIdentity(ticket, log);
  const rawCancellation =
    ticket.cancelDate ?? ticket.cancellationDate ?? ticket.adjustmentDate;
  const rawDeadline = ticket.lastTicketTime ?? ticket.ticketingTimeLimit;
  return canonicalEvidenceEnvelope({
    supplierAccount: input.supplier,
    source: 'ticket-report',
    receipt: input.receipt,
    query: {
      requestedLifecycleState: canonicalLifecycleState(input.requestedStatus),
    },
    requestIdentity: {
      ...emptyBookingIdentity(),
      transactionId: input.requestedUniqueTransId,
    },
    bookingIdentity,
    passengers: parsedPassengers.passengers,
    itinerary: parsedItinerary.itinerary,
    tickets,
    supplierWorkflowReference: exact(ticket.ticketCodeRef),
    lifecycle: {
      state,
      rawStatus: exact(ticket.status),
      rawBookedAt: exact(ticket.bookingDate),
      rawIssuedAt: exact(ticket.issueDate),
      rawCancelledAt: exact(rawCancellation),
      rawTicketingDeadline: exact(rawDeadline),
      bookedAt: supplierLifecycleInstant(input.supplier, ticket.bookingDate),
      issuedAt:
        state === 'ticketed'
          ? supplierLifecycleInstant(input.supplier, ticket.issueDate)
          : null,
      cancelledAt:
        state === 'cancelled' || state === 'refunded'
          ? supplierLifecycleInstant(
              input.supplier,
              rawCancellation
            )
          : null,
      ticketingDeadlineAt: supplierLifecycleInstant(
        input.supplier,
        rawDeadline
      ),
    },
    financial: {
      currency: currency.currency,
      supplierPayableMinor: canonicalMoneyMinor(ticket.ticketingPrice),
      supplierGrossMinor: canonicalMoneyMinor(
        ticket.grossPrice ?? ticket.supplierGross
      ),
      currencySource: currency.currencySource,
    },
    completeness: {
      bookingIdentity: Boolean(
        bookingIdentity.transactionId &&
          bookingIdentity.identityConflicts.length === 0 &&
          bookingIdentity.supplierBookingId &&
          bookingIdentity.supplierPnr &&
          bookingIdentity.bookingReference &&
          bookingIdentity.operationalReferences.itemCodeRef &&
          bookingIdentity.operationalReferences.priceCodeRef &&
          bookingIdentity.operationalReferences.bookingCodeRef
      ),
      passengers: parsedPassengers.complete,
      itinerary: parsedItinerary.complete,
      tickets:
        state !== 'ticketed' ||
        (tickets.length > 0 && tickets.length === parsedPassengers.passengers.length),
      financial: Boolean(
        currency.currency &&
          (canonicalMoneyMinor(ticket.ticketingPrice) ?? 0) > 0
      ),
      lifecycle:
        state !== 'unknown' &&
        (state !== 'ticketed' || Boolean(supplierLifecycleInstant(input.supplier, ticket.issueDate))) &&
        (!['cancelled', 'refunded'].includes(state) ||
          Boolean(supplierLifecycleInstant(
            input.supplier,
            rawCancellation
          ))),
    },
  });
}
