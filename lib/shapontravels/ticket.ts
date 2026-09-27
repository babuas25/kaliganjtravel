import 'server-only';

import type { PrivateBookingRefs } from '@/lib/flights/booking';
import type { SupplierWriteLifecycleHooks } from '@/lib/triplover/client';
import { completeTicketNumbers } from '@/lib/triplover/ticket-payload';
import type { TicketIssueOutcome } from '@/lib/triplover/ticket';
import { ShapontravelsWriteError, shapontravelsIssueRequest } from './client';

export type ShapontravelsTicketInput = PrivateBookingRefs & {
  pnr: string;
  bookingRefNumber: string;
  bookingCodeRef: string;
  expectedPassengerCount: number;
};

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
  return Boolean(
    booking.pnr && booking.pnr.trim().length > 2 &&
    booking.booking_ref_number && uuid.test(booking.booking_ref_number) &&
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
): Promise<TicketIssueOutcome> {
  const body = await shapontravelsIssueRequest({
    PNR: input.pnr,
    BookingRefNumber: input.bookingRefNumber,
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
): TicketIssueOutcome | null {
  const envelope = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  const receipt = envelope?.item1 && typeof envelope.item1 === 'object'
    ? envelope.item1 as Record<string, unknown> : null;
  const result = envelope?.item2 && typeof envelope.item2 === 'object'
    ? envelope.item2 as Record<string, unknown> : null;
  const ticketNumbers = completeTicketNumbers(
    receipt?.ticketInfoes, input.expectedPassengerCount
  );
  if (!receipt || result?.isSuccess !== true ||
      receipt.pnr !== input.pnr ||
      receipt.uniqueTransID !== input.uniqueTransId ||
      receipt.itemCodeRef !== input.itemCodeRef ||
      receipt.priceCodeRef !== input.priceCodeRef ||
      receipt.bookingCodeRef !== input.bookingCodeRef ||
      typeof receipt.ticketCodeRef !== 'string' ||
      !uuid.test(receipt.ticketCodeRef) ||
      !ticketNumbers?.every(number => /^[0-9]{10,16}$/.test(number))) {
    return null;
  }
  return {
    pnr: input.pnr,
    bookingStatus: 'Confirmed',
    ticketCodeRef: receipt.ticketCodeRef,
    ticketNumbers,
    warnings: [],
    message: null,
  };
}
