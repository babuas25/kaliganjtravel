import 'server-only';

import type { BookedItinerary, PrivateBookingRefs } from '@/lib/flights/booking';
import type { SupplierWriteLifecycleHooks } from '@/lib/triplover/client';
import { completeTicketNumbers } from '@/lib/triplover/ticket-payload';
import type { TicketIssueOutcome } from '@/lib/triplover/ticket';
import { ShapontravelsWriteError, shapontravelsIssueRequest } from './client';

export type ShapontravelsTicketInput = PrivateBookingRefs & {
  pnr: string;
  bookingRefNumber: string;
  bookingCodeRef: string;
  expectedPassengerCount: number;
  /** Server-owned saved itinerary; never taken from the Issue request body. */
  itinerary?: BookedItinerary | null;
};

export type ShapontravelsTicketOutcome = TicketIssueOutcome & { airlinesPnr: string[] };

function receiptTicketNumbers(
  envelope: Record<string, unknown>,
  receipt: Record<string, unknown>,
  input: ShapontravelsTicketInput
): string[] | null {
  const rows = receipt.ticketInfoes;
  const numeric = completeTicketNumbers(rows, input.expectedPassengerCount);
  if (numeric?.every(number => /^[0-9]{10,16}$/.test(number)) &&
      Array.isArray(rows) && rows.every(row => row?.ticketNumberSource == null)) return numeric;

  // The API establishes issuance independently. A held PNR is never ticket proof.
  const current = envelope.publicReceipt && typeof envelope.publicReceipt === 'object' &&
    !Array.isArray(envelope.publicReceipt)
    ? envelope.publicReceipt as Record<string, unknown> : null;
  const itinerary = input.itinerary;
  if (!current || current.status !== 'confirmed' || current.pendingReview !== false ||
      current.pnr !== input.pnr || itinerary?.carrierCode !== '6E' ||
      !Array.isArray(itinerary.legs) || itinerary.legs.length === 0 ||
      !itinerary.legs.every(leg => leg && Array.isArray(leg.segments) && leg.segments.length > 0 &&
        leg.segments.every(segment => segment && segment.airlineCode === '6E')) ||
      !Array.isArray(rows) || !Number.isInteger(input.expectedPassengerCount) ||
      input.expectedPassengerCount <= 0 || rows.length !== input.expectedPassengerCount) return null;
  const locators = receipt.airlinesPNR;
  if (!Array.isArray(locators) || locators.length === 0 ||
      !locators.every(value => typeof value === 'string' && /^[A-Z0-9]{6}$/.test(value)) ||
      new Set(locators).size !== locators.length) return null;

  const numbers: string[] = [];
  const numericSeen = new Set<string>();
  let usesPnr = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !Array.isArray(row.ticketNumbers) ||
        row.ticketNumbers.length === 0 || new Set(row.ticketNumbers).size !== row.ticketNumbers.length) return null;
    if (row.ticketNumberSource === 'airline_pnr') {
      if (!row.ticketNumbers.every((value: unknown) =>
        typeof value === 'string' && /^[A-Z0-9]{6}$/.test(value) && locators.includes(value))) return null;
      usesPnr = true;
    } else {
      if (row.ticketNumberSource != null || !row.ticketNumbers.every((value: unknown) => {
        if (typeof value !== 'string' || !/^[0-9]{10,16}$/.test(value) || numericSeen.has(value)) return false;
        numericSeen.add(value); return true;
      })) return null;
    }
    // An IndiGo locator may identify several passengers; retain passenger order.
    numbers.push(...row.ticketNumbers);
  }
  return usesPnr ? numbers : null;
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
): Promise<ShapontravelsTicketOutcome> {
  const body = await shapontravelsIssueRequest({
    PNR: input.pnr,
    // The public API uses the PNR mirror. Rust resolves private supplier refs.
    BookingRefNumber: input.pnr,
    UniqueTransID: input.uniqueTransId,
    PriceCodeRef: input.priceCodeRef,
    ItemCodeRef: input.itemCodeRef,
    BookingCodeRef: input.bookingCodeRef,
  }, idempotencyKey, hooks);
  const outcome = parseShapontravelsTicketReceipt(body, input);
  if (!outcome) {
    throw new ShapontravelsWriteError(
      'protocol', 'UNVERIFIED_TICKET_RESPONSE', 200, null, null, null, 'NewTicket'
    );
  }
  return outcome;
}

/** Exact saved-ticket identity and passenger evidence, also used by read-only review. */
export function parseShapontravelsTicketReceipt(
  body: unknown,
  input: ShapontravelsTicketInput
): ShapontravelsTicketOutcome | null {
  const envelope = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  const receipt = envelope?.item1 && typeof envelope.item1 === 'object'
    ? envelope.item1 as Record<string, unknown> : null;
  const result = envelope?.item2 && typeof envelope.item2 === 'object'
    ? envelope.item2 as Record<string, unknown> : null;
  const ticketNumbers = envelope && receipt ? receiptTicketNumbers(envelope, receipt, input) : null;
  if (!receipt || result?.isSuccess !== true ||
      receipt.pnr !== input.pnr ||
      receipt.uniqueTransID !== input.uniqueTransId ||
      receipt.itemCodeRef !== input.itemCodeRef ||
      receipt.priceCodeRef !== input.priceCodeRef ||
      receipt.bookingCodeRef !== input.bookingCodeRef ||
      typeof receipt.ticketCodeRef !== 'string' ||
      !uuid.test(receipt.ticketCodeRef) ||
      !ticketNumbers) {
    return null;
  }
  return {
    pnr: input.pnr,
    bookingStatus: 'Confirmed',
    ticketCodeRef: receipt.ticketCodeRef,
    ticketNumbers,
    airlinesPnr: Array.isArray(receipt.airlinesPNR) && receipt.airlinesPNR.length > 0 &&
      receipt.airlinesPNR.every(value => typeof value === 'string' && /^[A-Z0-9]{6}$/.test(value))
      ? Array.from(new Set<string>(receipt.airlinesPNR)) : [input.pnr],
    warnings: [],
    message: null,
  };
}
