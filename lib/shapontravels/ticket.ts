import 'server-only';

import type { BookedItinerary, PrivateBookingRefs } from '@/lib/flights/booking';
import type { SupplierWriteLifecycleHooks } from '@/lib/triplover/client';
import { completeTicketNumbers } from '@/lib/triplover/ticket-payload';
import type { TicketIssueOutcome } from '@/lib/triplover/ticket';
import { ShapontravelsWriteError, shapontravelsIssueRequest } from './client';
import {
  hasShapontravelsPlatformTickets,
  isShapontravelsTicketNumberSource,
  normalizeShapontravelsSavedTicketRows,
  normalizeShapontravelsTicketEvidenceEnvelope,
  parseShapontravelsCurrentStatus,
  shapontravelsAirlinePnrs,
  shapontravelsTicketRowsInPassengerOrder,
  shapontravelsWriteCurrentStatus,
  type ShapontravelsCurrentStatus,
  type ShapontravelsPassengerTicket,
} from './booking-status';

export type ShapontravelsTicketInput = PrivateBookingRefs & {
  pnr: string;
  bookingRefNumber: string;
  bookingCodeRef: string;
  expectedPassengerCount: number;
  /** Server-owned saved itinerary; never taken from the Issue request body. */
  itinerary?: BookedItinerary | null;
};

export type ShapontravelsTicketOutcome = TicketIssueOutcome & {
  airlinesPnr: string[];
  shaponCurrentStatus?: ShapontravelsCurrentStatus;
};

function receiptPassengerTickets(
  envelope: Record<string, unknown>,
  receipt: Record<string, unknown>,
  input: ShapontravelsTicketInput
): ShapontravelsPassengerTicket[] | null {
  const rows = shapontravelsTicketRowsInPassengerOrder(receipt.ticketInfoes, input.expectedPassengerCount);
  if (!rows) return null;
  const numeric = completeTicketNumbers(rows, input.expectedPassengerCount);
  if (numeric?.every(number => /^[0-9]{10,16}$/.test(number)) &&
      rows.every(row => row.ticketNumberSource == null)) {
    return rows.map(row => ({ ticketNumbers: (row.ticketNumbers as string[]).map(number => number.trim()),
      ticketNumberSource: null }));
  }

  // The API establishes issuance independently. A held PNR is never ticket proof.
  const current = envelope.publicReceipt && typeof envelope.publicReceipt === 'object' &&
    !Array.isArray(envelope.publicReceipt)
    ? envelope.publicReceipt as Record<string, unknown> : null;
  const legs = input.itinerary?.legs;
  const carrier = legs?.[0]?.segments?.[0]?.airlineCode;
  if (!current || current.status !== 'confirmed' || current.pendingReview !== false ||
      current.pnr !== input.pnr || (carrier !== '6E' && carrier !== 'J9') ||
      !Array.isArray(legs) ||
      !legs.every(leg => leg && Array.isArray(leg.segments) && leg.segments.length > 0 &&
        leg.segments.every(segment => segment && segment.airlineCode === carrier))) return null;
  const locators = receipt.airlinesPNR;
  if (!Array.isArray(locators) || locators.length === 0 ||
      !locators.every(value => typeof value === 'string' && /^[A-Z0-9]{6}$/.test(value)) ||
      new Set(locators).size !== locators.length) return null;

  const tickets: ShapontravelsPassengerTicket[] = [];
  const numericSeen = new Set<string>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const source = row.ticketNumberSource ?? null;
    if (!isShapontravelsTicketNumberSource(source) || !Array.isArray(row.ticketNumbers) ||
        row.ticketNumbers.length === 0 || new Set(row.ticketNumbers).size !== row.ticketNumbers.length) return null;
    if (source === 'platform_pnr') {
      if (!row.ticketNumbers.every((value: unknown) => {
        const match = typeof value === 'string' ? /^([A-Z0-9]{6})\/([1-9]|1\d|20)$/.exec(value) : null;
        return match && match[2] === String(index + 1) && locators.includes(match[1]);
      })) return null;
    } else if (source === 'airline_pnr') {
      if (!row.ticketNumbers.every((value: unknown) =>
        typeof value === 'string' && /^[A-Z0-9]{6}$/.test(value) && locators.includes(value))) return null;
    } else {
      if (!row.ticketNumbers.every((value: unknown) => {
        if (typeof value !== 'string' || !/^[0-9]{10,16}$/.test(value) || numericSeen.has(value)) return false;
        numericSeen.add(value); return true;
      })) return null;
    }
    tickets.push({ ticketNumbers: [...row.ticketNumbers], ticketNumberSource: source });
  }
  return tickets.some(row => row.ticketNumberSource !== null) ? tickets : null;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Avoid reserving wallet funds when a required supplier locator is absent. */
export function shapontravelsTicketIdentityReady(booking: {
  pnr: string | null;
  booking_ref_number: string | null;
  booking_code_ref: string | null;
  supplier_refs: PrivateBookingRefs | null;
  passenger_counts: Partial<Record<string, number>> | null;
}): boolean {
  const count = booking.passenger_counts
    ? Object.values(booking.passenger_counts).reduce<number>(
        (sum, value) => sum + (typeof value === 'number' ? value : NaN), 0
      )
    : 0;
  // Public Book references mirror the PNR; retained older receipts may use a UUID.
  // The platform booking and quote identities still require their own UUIDs.
  return Boolean(
    booking.pnr && booking.pnr.trim().length > 2 &&
    booking.booking_ref_number &&
      (booking.booking_ref_number === booking.pnr ||
        uuid.test(booking.booking_ref_number)) &&
    booking.booking_code_ref && uuid.test(booking.booking_code_ref) &&
    booking.supplier_refs?.uniqueTransId && uuid.test(booking.supplier_refs.uniqueTransId) &&
    booking.supplier_refs.itemCodeRef && uuid.test(booking.supplier_refs.itemCodeRef) &&
    booking.supplier_refs.priceCodeRef && uuid.test(booking.supplier_refs.priceCodeRef) &&
    Number.isInteger(count) && count > 0
  );
}

/** Issues a saved hold once and accepts only a fully matched ticket receipt. */
export async function issueShapontravelsTicket(
  input: ShapontravelsTicketInput,
  idempotencyKey: string,
  hooks: SupplierWriteLifecycleHooks
): Promise<ShapontravelsTicketOutcome & { passengerTickets?: ShapontravelsPassengerTicket[] }> {
  const body = await shapontravelsIssueRequest({
    PNR: input.pnr,
    // The public API uses the PNR mirror. Rust resolves private supplier refs.
    BookingRefNumber: input.pnr,
    UniqueTransID: input.uniqueTransId,
    PriceCodeRef: input.priceCodeRef,
    ItemCodeRef: input.itemCodeRef,
    BookingCodeRef: input.bookingCodeRef,
  }, idempotencyKey, hooks);
  const evidence = parseWrappedTicketEvidence(body, input);
  if (!evidence) {
    throw new ShapontravelsWriteError(
      'protocol', 'UNVERIFIED_TICKET_RESPONSE', 200, null, null, null, 'NewTicket'
    );
  }
  return { ...evidence.ticket,
    ...(evidence.passengerTickets.some(row => row.ticketNumberSource !== null)
      ? { passengerTickets: evidence.passengerTickets } : {}),
    shaponCurrentStatus: shapontravelsWriteCurrentStatus(body, input.bookingCodeRef) };
}

/** Exact saved-ticket identity and passenger evidence, also used by read-only review. */
export function parseShapontravelsTicketReceipt(
  body: unknown,
  input: ShapontravelsTicketInput
): ShapontravelsTicketOutcome | null {
  return parseWrappedTicketEvidence(body, input)?.ticket ?? null;
}

function parseWrappedTicketEvidence(body: unknown, input: ShapontravelsTicketInput) {
  const envelope = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  const receipt = envelope?.item1 && typeof envelope.item1 === 'object'
    ? envelope.item1 as Record<string, unknown> : null;
  const result = envelope?.item2 && typeof envelope.item2 === 'object'
    ? envelope.item2 as Record<string, unknown> : null;
  const passengerTickets = envelope && receipt ? receiptPassengerTickets(envelope, receipt, input) : null;
  if (!receipt || result?.isSuccess !== true ||
      receipt.pnr !== input.pnr ||
      receipt.uniqueTransID !== input.uniqueTransId ||
      receipt.itemCodeRef !== input.itemCodeRef ||
      receipt.priceCodeRef !== input.priceCodeRef ||
      receipt.bookingCodeRef !== input.bookingCodeRef ||
      typeof receipt.ticketCodeRef !== 'string' ||
      !uuid.test(receipt.ticketCodeRef) ||
      !passengerTickets) {
    return null;
  }
  const ticket: ShapontravelsTicketOutcome = {
    pnr: input.pnr,
    bookingStatus: 'Confirmed',
    ticketCodeRef: receipt.ticketCodeRef,
    ticketNumbers: passengerTickets.flatMap(row => row.ticketNumbers),
    airlinesPnr: shapontravelsAirlinePnrs(receipt.airlinesPNR),
    warnings: [],
    message: null,
  };
  return { ticket, passengerTickets, source: 'supplier_ticket_details' as const };
}

export type ShapontravelsTicketEvidence = {
  ticket: Omit<ShapontravelsTicketOutcome, 'ticketCodeRef'> & { ticketCodeRef: string | null };
  passengerTickets: ShapontravelsPassengerTicket[];
  source: 'supplier_ticket_details' | 'supplier_saved_ticket_details';
  schemaVersion?: 1;
};

/**
 * Saved ticket reads can omit a ticket UUID after a supplier Admin decision.
 * Their numeric passenger tickets still prove issuance when the complete saved
 * identity and both public projections agree. This never authorizes NewTicket.
 */
export function parseShapontravelsTicketEvidence(
  body: unknown,
  input: ShapontravelsTicketInput
): ShapontravelsTicketEvidence | null {
  const normalized = normalizeShapontravelsTicketEvidenceEnvelope(body);
  if (!normalized) return null;
  const { envelope, receipt, savedBooking } = normalized;
  if (!savedBooking) {
    return parseWrappedTicketEvidence(body, input);
  }
  const current = parseShapontravelsCurrentStatus(envelope.currentStatus);
  const publicReceipt = envelope.publicReceipt as Record<string, unknown>;
  if (savedBooking.status !== 'confirmed' || savedBooking.reviewRequired !== false ||
      savedBooking.requiresReconciliation !== false || savedBooking.paymentState !== 'paid' ||
      current?.status !== 'confirmed' || current.reviewRequired !== false ||
      publicReceipt.status !== 'confirmed' || publicReceipt.pendingReview !== false ||
      publicReceipt.paymentState !== 'paid' || publicReceipt.pnr !== input.pnr ||
      receipt.pnr !== input.pnr || receipt.uniqueTransID !== input.uniqueTransId ||
      receipt.itemCodeRef !== input.itemCodeRef || receipt.priceCodeRef !== input.priceCodeRef ||
      receipt.bookingCodeRef !== input.bookingCodeRef ||
      savedBooking.passengerCount !== input.expectedPassengerCount ||
      !(receipt.ticketCodeRef === null ||
        typeof receipt.ticketCodeRef === 'string' && uuid.test(receipt.ticketCodeRef))) return null;
  const rows = normalizeShapontravelsSavedTicketRows(savedBooking);
  if (!rows) return null;
  const passengerTickets = receiptPassengerTickets(envelope, { ...receipt, ticketInfoes: rows }, input);
  if (!passengerTickets || (receipt.ticketCodeRef === null &&
      passengerTickets.some(row => row.ticketNumberSource !== null))) return null;
  const wrappedRows = (envelope.item1 as Record<string, unknown> | undefined)?.ticketInfoes;
  if (Array.isArray(wrappedRows) && (hasShapontravelsPlatformTickets(wrappedRows) ||
      passengerTickets.some(row => row.ticketNumberSource === 'platform_pnr'))) {
    // Saved GET mirrors canonical segment rows into the legacy wrapper. A
    // matching set of strings alone would miss a contradictory passenger slot.
    const platformNumbers = new Set(passengerTickets.flatMap(row =>
      row.ticketNumberSource === 'platform_pnr' ? row.ticketNumbers : []));
    if (!wrappedRows.every((row, index) => {
      if (row.ticketNumberSource !== 'platform_pnr') {
        return row.ticketNumbers.every((number: string) => !platformNumbers.has(number));
      }
      const slot = Object.hasOwn(row, 'passengerIndex') ? row.passengerIndex : index;
      const match = Number.isInteger(slot) ? passengerTickets[slot] : null;
      return match?.ticketNumberSource === 'platform_pnr' &&
        row.ticketNumbers.every((number: string) => match.ticketNumbers.includes(number));
    })) return null;
  }
  return {
    ticket: {
      pnr: input.pnr, bookingStatus: 'Confirmed', ticketCodeRef: receipt.ticketCodeRef as string | null,
      ticketNumbers: passengerTickets.flatMap(row => row.ticketNumbers),
      airlinesPnr: shapontravelsAirlinePnrs(receipt.airlinesPNR),
      warnings: [], message: null,
    },
    passengerTickets,
    source: 'supplier_saved_ticket_details', schemaVersion: 1,
  };
}
