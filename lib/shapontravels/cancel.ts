import 'server-only';

import type { PrivateBookingRefs } from '@/lib/flights/booking';
import type { CancelBookingOutcome } from '@/lib/triplover/cancel';
import type { SupplierWriteLifecycleHooks } from '@/lib/triplover/client';
import type { ShapontravelsBookingRead } from './client';
import { ShapontravelsWriteError, shapontravelsCancelRequest } from './client';
import { verifyShapontravelsBookingStatus } from './booking-status';

export type ShapontravelsCancelInput = PrivateBookingRefs & {
  pnr: string;
  bookingRefNumber: string;
  bookingCodeRef: string;
  supplierPublicRef?: string | null;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const accountingFields = [
  'baseFare', 'tax', 'fees', 'surcharge', 'amoundPaid', 'amountPaid',
  'amountHeld', 'refundPenalty', 'netRefund',
] as const;

/** Require saved platform identities before claiming a cancellation operation. */
export function shapontravelsCancellationIdentityReady(booking: {
  pnr: string | null;
  booking_ref_number: string | null;
  booking_code_ref: string | null;
  supplier_refs: PrivateBookingRefs | null;
}): boolean {
  return Boolean(
    booking.pnr && booking.pnr === booking.pnr.trim() && booking.pnr.length > 2 &&
    booking.booking_ref_number &&
      (booking.booking_ref_number === booking.pnr || uuid.test(booking.booking_ref_number)) &&
    booking.booking_code_ref && uuid.test(booking.booking_code_ref) &&
    booking.supplier_refs?.uniqueTransId && uuid.test(booking.supplier_refs.uniqueTransId) &&
    booking.supplier_refs.itemCodeRef && uuid.test(booking.supplier_refs.itemCodeRef) &&
    booking.supplier_refs.priceCodeRef && uuid.test(booking.supplier_refs.priceCodeRef)
  );
}

/** Use a fresh owner-scoped receipt's explicit Cancel grant, independently of Issue. */
export function verifyShapontravelsCancellationEligibility(
  read: ShapontravelsBookingRead,
  input: ShapontravelsCancelInput
): boolean {
  if (!shapontravelsCancellationIdentityReady({
    pnr: input.pnr,
    booking_ref_number: input.bookingRefNumber,
    booking_code_ref: input.bookingCodeRef,
    supplier_refs: input,
  })) return false;
  const verified = verifyShapontravelsBookingStatus(read, input);
  const body = read.body && typeof read.body === 'object' && !Array.isArray(read.body)
    ? read.body as Record<string, unknown> : null;
  const current = body?.currentStatus && typeof body.currentStatus === 'object' && !Array.isArray(body.currentStatus)
    ? body.currentStatus as Record<string, unknown> : null;
  const receipt = body?.publicReceipt && typeof body.publicReceipt === 'object' && !Array.isArray(body.publicReceipt)
    ? body.publicReceipt as Record<string, unknown> : null;
  const actions = receipt?.actions && typeof receipt.actions === 'object' && !Array.isArray(receipt.actions)
    ? receipt.actions as Record<string, unknown> : null;
  return verified.result === 'verified' && verified.currentStatusState === 'available' &&
    !verified.ticketedEvidencePresent && current?.reviewRequired === false &&
    receipt?.pendingReview === false && actions?.canCancel === true &&
    receipt.status === current.status &&
    ['on-hold', 'pending', 'unconfirmed', 'expired'].includes(receipt.status as string) &&
    (receipt.tickets == null || (Array.isArray(receipt.tickets) && receipt.tickets.length === 0));
}

/** Cancels a saved hold once and accepts only an exactly matched success receipt. */
export async function cancelShapontravelsBooking(
  input: ShapontravelsCancelInput,
  idempotencyKey: string,
  hooks: SupplierWriteLifecycleHooks
): Promise<CancelBookingOutcome> {
  if (!shapontravelsCancellationIdentityReady({
    pnr: input.pnr,
    booking_ref_number: input.bookingRefNumber,
    booking_code_ref: input.bookingCodeRef,
    supplier_refs: input,
  })) {
    throw new ShapontravelsWriteError(
      'protocol', 'INVALID_CANCELLATION_IDENTITY', null, null, null, null, 'Cancel'
    );
  }
  const body = await shapontravelsCancelRequest({
    PNR: input.pnr,
    // Public references identify platform records; old UUID receipts use the
    // current API's verified PNR mirror when the supplier resolves its hold.
    BookingRefNumber: input.pnr,
    UniqueTransID: input.uniqueTransId,
    PriceCodeRef: input.priceCodeRef,
    ItemCodeRef: input.itemCodeRef,
    BookingCodeRef: input.bookingCodeRef,
  }, idempotencyKey, hooks);
  const outcome = parseShapontravelsCancellationReceipt(body, input);
  if (!outcome) {
    throw new ShapontravelsWriteError(
      'protocol', 'UNVERIFIED_CANCELLATION_RESPONSE', 200, null, null, null, 'Cancel'
    );
  }
  return outcome;
}

/** A receipt confirms cancellation only for the saved booking and quote. */
export function parseShapontravelsCancellationReceipt(
  body: unknown,
  input: ShapontravelsCancelInput
): CancelBookingOutcome | null {
  const envelope = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown> : null;
  const receipt = envelope?.item1 && typeof envelope.item1 === 'object' && !Array.isArray(envelope.item1)
    ? envelope.item1 as Record<string, unknown> : null;
  const result = envelope?.item2 && typeof envelope.item2 === 'object' && !Array.isArray(envelope.item2)
    ? envelope.item2 as Record<string, unknown> : null;
  if (!shapontravelsCancellationIdentityReady({
    pnr: input.pnr,
    booking_ref_number: input.bookingRefNumber,
    booking_code_ref: input.bookingCodeRef,
    supplier_refs: input,
  }) || !receipt || result?.isSuccess !== true || receipt.isCancel !== true ||
      receipt.uniqueTransID !== input.uniqueTransId ||
      receipt.itemCodeRef !== input.itemCodeRef ||
      receipt.priceCodeRef !== input.priceCodeRef ||
      receipt.bookingCodeRef !== input.bookingCodeRef ||
      (receipt.pnr !== undefined && receipt.pnr !== input.pnr) ||
      (receipt.ticketCodeRef != null && receipt.ticketCodeRef !== '') ||
      (receipt.ticketInfoes != null &&
        (!Array.isArray(receipt.ticketInfoes) || receipt.ticketInfoes.length > 0)) ||
      (receipt.ticketNumbers != null && receipt.ticketNumbers !== '' &&
        (!Array.isArray(receipt.ticketNumbers) || receipt.ticketNumbers.length > 0)) ||
      accountingFields.some(field => receipt[field] != null && receipt[field] !== 0)) {
    return null;
  }
  return {
    isCancel: true,
    uniqueTransId: input.uniqueTransId,
    // The held-cancellation contract provides no monetary refund evidence.
    netRefund: null,
    refundPenalty: null,
  };
}
