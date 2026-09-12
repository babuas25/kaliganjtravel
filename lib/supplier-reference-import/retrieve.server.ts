import 'server-only';

import { passportRequiredFor } from '@/lib/airports/country';
import { BOOKING_CONTACT_DEFAULTS } from '@/lib/flights/booking';
import type {
  BookingGender,
  BookingPassengerType,
  BookingTitle,
  BookingTraveller,
} from '@/lib/flights/booking';
import type { ItineraryLeg, ItinerarySegment } from '@/lib/flights/types';
import { TriploverError, triploverCall } from '@/lib/triplover/client';
import { parseTriploverReferenceLog } from '@/lib/triplover/canonical-evidence-v2';
import type { TriploverReferenceImportSupplier } from '@/lib/triplover/config';
import {
  SUPPLIER_REFERENCE_IDENTITIES,
  supplierReferenceMatchesAccount,
} from '@/lib/supplier-reference-import/identity';
import { readPnr } from '@/lib/triplover/pnr';
import {
  reconcileSupplierFares,
  SupplierFareReconciliationError,
} from '@/lib/supplier-reference-import/fare-reconciliation';
import { supplierReferenceInstant } from '@/lib/supplier-reference-import/time';
import type {
  SupplierReferenceEvidence,
  SupplierReferenceLifecycle,
} from '@/lib/supplier-reference-import/types';

type UnknownRecord = Record<string, unknown>;

const REPORT_FILTERS = [
  'Confirmed',
  'Cancelled',
  'Refunded',
  'Created',
  'Booked',
] as const;

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function rows(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function text(...values: unknown[]): string {
  return values.find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  )?.trim() ?? '';
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function strictMoney(value: unknown, label: string, allowNegative = false): number {
  const parsed = typeof value === 'number' ? value :
    typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || (!allowNegative && parsed < 0)) {
    throw new TriploverError('protocol', `Supplier booking has an invalid ${label}.`);
  }
  return Math.round(parsed * 100) / 100;
}

function nonZero(value: unknown): boolean {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) >= 0.005;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TriploverError('protocol', `Supplier booking has an invalid ${label}.`);
  }
  return parsed;
}

function isoInstant(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function isoDate(value: unknown): string {
  const instant = isoInstant(value);
  return instant ? instant.slice(0, 10) : '';
}

function localWallClock(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const normalized = value.trim().replace('T', ' ');
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(normalized);
  if (match) return match[1];
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value.trim();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(parsed));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

function passengerType(value: unknown): BookingPassengerType | null {
  const normalized = text(value).toUpperCase();
  return ['ADT', 'CHD', 'CNN', 'INF', 'INS'].includes(normalized)
    ? (normalized as BookingPassengerType)
    : null;
}

function genderOf(value: unknown, titleValue: unknown): BookingGender {
  const normalized = text(value).toLowerCase();
  if (normalized.startsWith('f')) return 'Female';
  if (normalized.startsWith('m')) return 'Male';
  return /^(mrs|ms|miss)$/i.test(text(titleValue).replace(/\.$/, ''))
    ? 'Female'
    : 'Male';
}

function titleOf(
  value: unknown,
  type: BookingPassengerType,
  gender: BookingGender,
): BookingTitle {
  const normalized = text(value).replace(/\.$/, '').toLowerCase();
  if (normalized === 'mrs') return 'Mrs';
  if (normalized === 'ms') return 'Ms';
  if (normalized === 'miss') return 'Miss';
  if (normalized === 'mstr' || normalized === 'master') return 'Mstr';
  if (normalized === 'mr') return 'Mr';
  if (type !== 'ADT') return gender === 'Female' ? 'Miss' : 'Mstr';
  return gender === 'Female' ? 'Ms' : 'Mr';
}

function ticketNumbers(value: UnknownRecord): string[] {
  return Array.from(
    new Set(
      [value.ticketNumbers, value.ticketNumber]
        .flatMap((item) =>
          typeof item === 'string' ? item.split(',') : [],
        )
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function baggage(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    const first = rows(parsed)[0];
    if (!first) return value.trim();
    const amount = number(first.Amount ?? first.amount);
    const unit = text(first.Units, first.units);
    return amount > 0 ? `${amount} ${unit}`.trim() : value.trim();
  } catch {
    return value.trim();
  }
}

function segmentOf(value: UnknownRecord): ItinerarySegment | null {
  const from = text(value.origin).toUpperCase();
  const to = text(value.destination).toUpperCase();
  const departure = localWallClock(value.departure);
  const arrival = localWallClock(value.arrival);
  const operatingCarrier = text(value.operationCarrier).toUpperCase();
  const cabinClass = text(value.cabinClass);
  const bookingClass = text(value.bookingCode);
  if (
    !from || !to || !departure || !arrival ||
    !/^[A-Z0-9]{2}$/.test(operatingCarrier) || !cabinClass || !bookingClass
  ) return null;
  return {
    from,
    fromAirport: text(value.originName, value.originCity, from),
    departureTerminal: text(value.originTerminal) || null,
    to,
    toAirport: text(value.destinationName, value.destinationCity, to),
    arrivalTerminal: text(value.destinationTerminal) || null,
    departure,
    arrival,
    airline: text(
      value.operationCarrierName,
      value.airlineName,
      value.operationCarrier,
    ),
    airlineCode: operatingCarrier,
    flightNumber: text(value.flightNumber),
    cabinClass,
    bookingClass,
    duration: text(value.travelTime) || null,
    aircraft: text(value.equipment) || null,
    baggage: baggage(value.baggageInfo),
    handBaggage: null,
    seatsLeft: null,
  };
}

function itineraryOf(segmentRows: UnknownRecord[]) {
  if (segmentRows.length === 0) {
    throw new TriploverError('protocol', 'Supplier booking has no itinerary segments.');
  }
  const grouped = new Map<string, ItinerarySegment[]>();
  const closedGroups = new Set<string>();
  let activeGroup: string | null = null;
  const carriers = new Set<string>();
  segmentRows.forEach((row, index) => {
    const segment = segmentOf(row);
    if (!segment) {
      throw new TriploverError(
        'protocol',
        `Supplier itinerary segment ${index + 1} is missing route, carrier, cabin, booking class, or schedule data.`,
      );
    }
    const rawGroup = row.groupName ?? row.group ?? row.segmentGroup;
    const key =
      (typeof rawGroup === 'string' && rawGroup.trim() !== '') ||
      (typeof rawGroup === 'number' && Number.isFinite(rawGroup))
        ? String(rawGroup).trim()
        : segmentRows.length === 1 ? '0' : '';
    if (!key) {
      throw new TriploverError(
        'protocol',
        'Connecting or multi-leg supplier itinerary is missing an explicit segment group.',
      );
    }
    if (activeGroup !== key) {
      if (closedGroups.has(key)) {
        throw new TriploverError('protocol', 'Supplier itinerary has non-contiguous segment groups.');
      }
      if (activeGroup !== null) closedGroups.add(activeGroup);
      activeGroup = key;
    }
    carriers.add(segment.airlineCode);
    const explicitMarketing = text(
      row.marketingCarrier,
      row.marketingAirline,
      row.airlineCode,
    ).toUpperCase();
    if (
      row.isCodeShared === true || row.isCodeshare === true ||
      (explicitMarketing && explicitMarketing !== segment.airlineCode)
    ) {
      throw new TriploverError(
        'protocol',
        'Supplier itinerary has an ambiguous marketing/operating carrier or codeshare.',
      );
    }
    const current = grouped.get(key) ?? [];
    current.push(segment);
    grouped.set(key, current);
  });
  const segments = Array.from(grouped.values()).flat();
  if (segments.length === 0) {
    throw new TriploverError(
      'protocol',
      'Supplier booking has no complete itinerary segments.',
    );
  }
  if (carriers.size !== 1) {
    throw new TriploverError(
      'protocol',
      'Supplier itinerary has multiple operating carriers without an authoritative plating carrier.',
    );
  }
  for (const group of Array.from(grouped.values())) {
    for (let index = 1; index < group.length; index += 1) {
      if (group[index - 1]!.to !== group[index]!.from) {
        throw new TriploverError('protocol', 'Supplier connecting itinerary is not continuous.');
      }
    }
  }
  const legs: ItineraryLeg[] = Array.from(grouped.values()).map((group) => ({
    from: group[0]!.from,
    to: group[group.length - 1]!.to,
    stops: Math.max(0, group.length - 1),
    segments: group,
    duration: group.length === 1 ? group[0]!.duration : null,
    departure: group[0]!.departure,
    arrival: group[group.length - 1]!.arrival,
  }));
  const lead = segments[0]!;
  return {
    itinerary: {
      carrierCode: lead.airlineCode,
      carrierName: lead.airline,
      refundable: false,
      legs,
    },
    airportCodes: segments.flatMap((segment) => [segment.from, segment.to]),
  };
}

function passengersOf(passengerRows: UnknownRecord[]) {
  if (passengerRows.length === 0) {
    throw new TriploverError('protocol', 'Supplier booking has no passengers.');
  }
  if (passengerRows.some((row) =>
    positiveInteger(row.passengerCount, 'individual passenger count') !== 1)) {
    throw new TriploverError(
      'protocol',
      'Supplier booking groups passengers without individual passenger records.',
    );
  }
  const travellers = passengerRows.map((passenger): BookingTraveller => {
    const type = passengerType(passenger.passengerType);
    const firstName = text(passenger.first, passenger.firstName);
    const lastName = text(passenger.last, passenger.lastName);
    if (!type || !firstName || !lastName) {
      throw new TriploverError(
        'protocol',
        'Supplier booking has incomplete passenger identity data.',
      );
    }
    const gender = genderOf(passenger.gender, passenger.title);
    return {
      passengerType: type,
      title: titleOf(passenger.title, type, gender),
      firstName,
      lastName,
      gender,
      dateOfBirth: isoDate(passenger.dateOfBirth),
      passportNumber: text(passenger.documentNumber) || undefined,
      passportExpiry: isoDate(passenger.expireDate) || undefined,
      issuingCountry:
        text(passenger.documentIssuingCountry).toUpperCase() || undefined,
      nationality: text(passenger.nationality).toUpperCase(),
    };
  });
  const lead =
    passengerRows.find((passenger) => passenger.isLeadPax === true) ??
    passengerRows[0]!;
  const email = text(lead.email).toLowerCase();
  return {
    travellers,
    contact: {
      phone: text(lead.phone),
      phoneCountryCode: text(lead.phoneCountryCode),
      // Missing supplier customer contact stays missing. Falling back to the
      // agency address would fabricate a customer recipient and could send a
      // status email to the wrong audience.
      customerEmail: email,
      email: BOOKING_CONTACT_DEFAULTS.email,
      countryCode: text(lead.documentIssuingCountry).toUpperCase() || 'BD',
      cityName: text(lead.cityName) || BOOKING_CONTACT_DEFAULTS.cityName,
    },
  };
}

function lifecycle(value: string): SupplierReferenceLifecycle | null {
  const status = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (
    status.includes('cancel') ||
    status.includes('refund') ||
    status === 'void' ||
    status === 'voided'
  ) return 'cancelled';
  if (
    status.includes('ticket') ||
    status.includes('issue') ||
    status.includes('confirm') ||
    status === 'completed'
  ) return 'confirmed';
  if (
    status.includes('book') ||
    status.includes('hold') ||
    status === 'created'
  ) return 'on-hold';
  return null;
}

function exactReference(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : '';
}

function containsPartialState(value: unknown): boolean {
  if (typeof value === 'string') return /partial/i.test(value);
  if (Array.isArray(value)) return value.some(containsPartialState);
  return Object.values(record(value)).some(containsPartialState);
}

function assertSupportedFinancialState(
  raw: UnknownRecord,
  ticket: UnknownRecord,
  lifecycleStatus: SupplierReferenceLifecycle,
): void {
  if (
    ticket.isReissued === true || containsPartialState(ticket.status) ||
    containsPartialState(ticket.refundStatus) || containsPartialState(raw.refundStatus)
  ) {
    throw new TriploverError(
      'protocol',
      'Reissued or partially cancelled/refunded supplier bookings cannot be priced safely.',
    );
  }
  const financialRows = [ticket, ...rows(raw.passengerInfo), ...rows(raw.fareBreakdown)];
  if (financialRows.some((row) =>
    nonZero(row.additionalCollection) || nonZero(row.reissueCharge))) {
    throw new TriploverError(
      'protocol',
      'Supplier booking has an additional collection or reissue charge that is unsupported for import-time pricing.',
    );
  }
  const fareRows = rows(raw.fareBreakdown);
  for (const row of fareRows) {
    const cancelled = Number(row.canceledCount ?? row.cancelledCount ?? 0);
    const count = positiveInteger(row.passengerCount, 'fare passenger count');
    if (Number.isFinite(cancelled) && cancelled > 0 && cancelled < count) {
      throw new TriploverError(
        'protocol',
        'Supplier fare contains a partial passenger cancellation.',
      );
    }
    if (cancelled >= count && lifecycleStatus !== 'cancelled') {
      throw new TriploverError(
        'protocol',
        'Supplier fare cancellation evidence conflicts with the live booking status.',
      );
    }
  }
  const segmentRows = rows(raw.segments);
  const terminalFlags = segmentRows.map((row) =>
    row.isCancelled === true || row.isCanceled === true || row.isRefunded === true);
  if (terminalFlags.some(Boolean) && !terminalFlags.every(Boolean)) {
    throw new TriploverError(
      'protocol',
      'Supplier itinerary is partially cancelled or refunded.',
    );
  }
  if (terminalFlags.every(Boolean) && terminalFlags.length > 0 && lifecycleStatus !== 'cancelled') {
    throw new TriploverError(
      'protocol',
      'Supplier segment financial state conflicts with the live booking status.',
    );
  }
}

function currencyOf(raw: UnknownRecord, ticket: UnknownRecord): 'BDT' {
  const reported = text(
    ticket.currency,
    ticket.currencyCode,
    raw.currency,
    raw.currencyCode,
  ).toUpperCase();
  if (reported && reported !== 'BDT') {
    throw new TriploverError(
      'protocol',
      `Supplier booking currency ${reported} is unsupported; Supplier API Import currently requires BDT.`,
    );
  }
  return 'BDT';
}

function assertSupplierReference(
  supplier: TriploverReferenceImportSupplier,
  supplierReference: string,
): void {
  const identity = SUPPLIER_REFERENCE_IDENTITIES[supplier];
  if (!supplierReferenceMatchesAccount(supplier, supplierReference)) {
    throw new TriploverError(
      'protocol',
      `${identity.prefix} references must be imported through ${identity.label}.`,
    );
  }
}

async function retrieveReport(
  supplier: TriploverReferenceImportSupplier,
  supplierReference: string,
): Promise<{ raw: UnknownRecord; ticket: UnknownRecord; referenceLog: UnknownRecord }> {
  let lastError: unknown;
  for (const filter of REPORT_FILTERS) {
    try {
      const call = await triploverCall(
        'AirTicketingDetails',
        `/api/B2BReport/AirTicketingDetails/${encodeURIComponent(supplierReference)}/${filter}`,
        null,
        { supplier, method: 'GET', topLevelPayload: true },
      );
      const raw = record(call.data);
      const ticket = record(raw.ticketInfo);
      if (Object.keys(ticket).length === 0) {
        throw new TriploverError(
          'supplier',
          'Supplier has no booking record for this reference.',
        );
      }
      const ticketEcho = exactReference(ticket.uniqueTransID);
      const referenceLog = parseTriploverReferenceLog(ticket.referenceLog);
      const logEcho = exactReference(referenceLog.UniqueTransID);
      if (ticketEcho !== supplierReference || logEcho !== supplierReference) {
        throw new TriploverError(
          'protocol',
          'Supplier returned a different transaction identity than the requested reference.',
        );
      }
      return { raw, ticket, referenceLog };
    } catch (error) {
      if (
        error instanceof TriploverError &&
        error.kind === 'protocol' &&
        error.message.includes('different transaction identity')
      ) throw error;
      lastError = error;
    }
  }
  throw lastError ?? new TriploverError(
    'supplier',
    'Supplier has no booking record for this reference.',
  );
}

export async function retrieveSupplierReferenceBooking(input: {
  supplierAccount: TriploverReferenceImportSupplier;
  supplierReference: string;
}): Promise<SupplierReferenceEvidence> {
  const supplierReference = input.supplierReference.trim().toUpperCase();
  assertSupplierReference(input.supplierAccount, supplierReference);
  const { raw, ticket, referenceLog } = await retrieveReport(
    input.supplierAccount,
    supplierReference,
  );
  const required = {
    uniqueTransId: exactReference(referenceLog.UniqueTransID),
    itemCodeRef: exactReference(referenceLog.ItemCodeRef),
    priceCodeRef: exactReference(referenceLog.PriceCodeRef),
    bookingCodeRef: exactReference(referenceLog.BookingCodeRef),
    pnr: exactReference(referenceLog.PNR),
    bookingRefNumber: exactReference(referenceLog.BookingRefNumber),
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length > 0) {
    throw new TriploverError(
      'protocol',
      `Supplier booking is missing required operational references: ${missing.join(', ')}.`,
    );
  }
  if (required.uniqueTransId !== supplierReference) {
    throw new TriploverError(
      'protocol',
      'Supplier reference log does not match the requested transaction.',
    );
  }

  const pnr = await readPnr({
    supplier: input.supplierAccount,
    uniqueTransId: required.uniqueTransId,
    itemCodeRef: required.itemCodeRef,
    priceCodeRef: required.priceCodeRef,
    bookingCodeRef: required.bookingCodeRef,
    pnr: required.pnr,
    bookingRefNumber: required.bookingRefNumber,
    carrierCode: text(rows(raw.segments)[0]?.operationCarrier),
    deadlineNotBefore: supplierReferenceInstant(
      input.supplierAccount,
      ticket.bookingDate,
    ),
  });
  if (
    pnr.pnr !== required.pnr ||
    pnr.supplierEchoedUniqueTransIds.length === 0 ||
    pnr.supplierEchoedUniqueTransIds.some((echo) => echo !== supplierReference)
  ) {
    throw new TriploverError(
      'protocol',
      'Live PNR verification returned a conflicting booking identity.',
    );
  }
  const reportStatus = text(ticket.status);
  const pnrStatus = text(pnr.status);
  const reportLifecycle = lifecycle(reportStatus);
  const pnrLifecycle = lifecycle(pnrStatus);
  if (!reportLifecycle || !pnrLifecycle) {
    throw new TriploverError(
      'protocol',
      `Supplier returned an unsupported booking status (${pnrStatus || reportStatus || 'unknown'}).`,
    );
  }
  if (reportLifecycle !== pnrLifecycle) {
    throw new TriploverError(
      'protocol',
      `Supplier report and live PNR disagree (${reportStatus} / ${pnrStatus}).`,
    );
  }
  assertSupportedFinancialState(raw, ticket, reportLifecycle);
  const currency = currencyOf(raw, ticket);

  const passengerRows = rows(raw.passengerInfo);
  const passengers = passengersOf(passengerRows);
  const { itinerary, airportCodes } = itineraryOf(rows(raw.segments));
  const supplierPayable = strictMoney(
    ticket.ticketingPrice,
    'authoritative ticketing payable',
  );
  if (supplierPayable <= 0) {
    throw new TriploverError('protocol', 'Supplier booking has no positive ticketing payable.');
  }
  let fareReconciliation: ReturnType<typeof reconcileSupplierFares>;
  try {
    fareReconciliation = reconcileSupplierFares({
      fareBreakdown: raw.fareBreakdown,
      passengers: passengerRows,
      payable: supplierPayable,
    });
  } catch (error) {
    if (error instanceof SupplierFareReconciliationError) {
      throw new TriploverError('protocol', error.message);
    }
    throw error;
  }
  const { supplierFares, supplierGross, supplierDiscount } = fareReconciliation;
  const allTickets = Array.from(
    new Set(passengerRows.flatMap((passenger) => ticketNumbers(passenger))),
  );
  if (
    reportLifecycle === 'confirmed' &&
    (allTickets.length !== passengers.travellers.length ||
      allTickets.some((ticketNumber) => !ticketNumber))
  ) {
    throw new TriploverError(
      'protocol',
      'Confirmed supplier booking does not contain one ticket number per passenger.',
    );
  }
  const airlinesPnr = Array.from(
    new Set(
      [
        ...pnr.airlinesPnr,
        ...text(ticket.airlinePNRs).split(','),
      ]
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  if (airlinesPnr.length === 0) {
    throw new TriploverError(
      'protocol',
      'Supplier booking has no airline PNR required for normal API operations.',
    );
  }
  const travelDate = itinerary.legs[0]?.departure.slice(0, 10) ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(travelDate)) {
    throw new TriploverError('protocol', 'Supplier booking has no valid travel date.');
  }
  if (!Number.isFinite(supplierGross) || supplierGross <= 0) {
    throw new TriploverError('protocol', 'Supplier booking has no valid supplier price.');
  }
  const passengerCounts = passengers.travellers.reduce<
    Partial<Record<BookingPassengerType, number>>
  >((counts, passenger) => {
    counts[passenger.passengerType] =
      (counts[passenger.passengerType] ?? 0) + 1;
    return counts;
  }, {});
  const bookedAt = supplierReferenceInstant(
    input.supplierAccount,
    ticket.bookingDate,
  );
  return {
    supplierAccount: input.supplierAccount,
    supplierReference,
    supplierStatus: pnrStatus,
    lifecycleStatus: reportLifecycle,
    storedStatus: reportLifecycle,
    currency,
    supplierPayable,
    supplierGross,
    supplierDiscount,
    passengerCounts,
    travelDate,
    itinerary,
    supplierFares,
    passengers,
    passportRequired: passportRequiredFor(airportCodes),
    supplierRefs: {
      uniqueTransId: required.uniqueTransId,
      itemCodeRef: required.itemCodeRef,
      priceCodeRef: required.priceCodeRef,
    },
    bookingCodeRef: required.bookingCodeRef,
    ticketCodeRef: text(ticket.ticketCodeRef) || null,
    pnr: pnr.pnr,
    bookingRefNumber: required.bookingRefNumber,
    airlinesPnr,
    ticketNumbers: allTickets,
    ticketingTimeLimit: pnr.rawLastTicketTime,
    ticketingDeadlineAt: pnr.ticketingDeadlineAt,
    bookedAt,
    issuedAt: reportLifecycle === 'confirmed'
      ? supplierReferenceInstant(input.supplierAccount, ticket.issueDate)
      : null,
    cancelledAt: reportLifecycle === 'cancelled'
      ? supplierReferenceInstant(
          input.supplierAccount,
          ticket.cancelDate ?? ticket.cancellationDate ?? ticket.adjustmentDate,
        )
      : null,
    // A live Booked/Held import must stay issuable through the ordinary
    // Issue Now path. direct_ticketing represents an already-ticketed outcome,
    // not merely a supplier offer/account capability.
    directTicketing: reportLifecycle === 'confirmed',
    supplierBookingId:
      Number.isSafeInteger(Number(ticket.bookingId)) ? Number(ticket.bookingId) : null,
    supplierMessage: text(ticket.statusReason) || null,
    retrievedAt: new Date().toISOString(),
  };
}
