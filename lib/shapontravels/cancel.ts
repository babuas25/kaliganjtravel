import 'server-only';

import type { PrivateBookingRefs } from '@/lib/flights/booking';
import type { SupplierWriteLifecycleHooks } from '@/lib/triplover/client';
import { ShapontravelsReadError, ShapontravelsWriteError, shapontravelsCancelRequest } from './client';
import type { BookingStatus } from '@/lib/flights/booking-status';
import { parseShapontravelsCurrentStatusProjection } from './current-status-projection';

export type ShapontravelsCancellationInput = PrivateBookingRefs & {
  pnr: string;
  bookingRefNumber: string;
  bookingCodeRef: string;
};

const SHAPON_CANCELLABLE_STATUSES: readonly BookingStatus[] = ['on-hold', 'unconfirmed', 'expired'];

export type ShaponPlatformCancellation = {
  isCancel: true;
  status: 'cancelled';
  walletMutation: false;
  uniqueTransId: string;
  itemCodeRef: string;
  priceCodeRef: string;
  bookingCodeRef: string;
};

export type ShaponSavedCancellation = ShaponPlatformCancellation & {
  supplierPublicRef: string;
  savedBookingId: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const accountingFields = [
  'baseFare', 'tax', 'fees', 'surcharge', 'amoundPaid', 'amountPaid',
  'amountHeld', 'refundPenalty', 'netRefund',
] as const;

export function shapontravelsCancellationReferencesReady(booking: {
  pnr: string | null;
  booking_ref_number: string | null;
  booking_code_ref: string | null;
  supplier_refs: PrivateBookingRefs | null;
}): boolean {
  return Boolean(
    (booking.pnr
      ? booking.pnr === booking.pnr.trim() && booking.pnr.length > 2 && Boolean(booking.booking_ref_number &&
        (booking.booking_ref_number === booking.pnr || UUID.test(booking.booking_ref_number)))
      : !booking.booking_ref_number) &&
    booking.booking_code_ref && UUID.test(booking.booking_code_ref) &&
    booking.supplier_refs?.uniqueTransId && UUID.test(booking.supplier_refs.uniqueTransId) &&
    booking.supplier_refs.itemCodeRef && UUID.test(booking.supplier_refs.itemCodeRef) &&
    booking.supplier_refs.priceCodeRef && UUID.test(booking.supplier_refs.priceCodeRef)
  );
}

/** Cancel requires saved Book identities, without ticketing's funding/count gates. */
export function shapontravelsCancellationIdentityReady(booking: {
  pnr: string | null;
  booking_ref_number: string | null;
  booking_code_ref: string | null;
  supplier_refs: PrivateBookingRefs | null;
  lifecycle_status?: BookingStatus | null;
  payment_state: string;
  shapon_current_status?: unknown;
  ticket_code_ref?: string | null;
  ticket_numbers?: unknown;
}): boolean {
  if (booking.payment_state !== 'unpaid' || !booking.lifecycle_status ||
      !SHAPON_CANCELLABLE_STATUSES.includes(booking.lifecycle_status) ||
      (!booking.pnr && booking.lifecycle_status !== 'unconfirmed') ||
      !shapontravelsCancellationReferencesReady(booking) || booking.ticket_code_ref ||
      (booking.ticket_numbers != null &&
        (!Array.isArray(booking.ticket_numbers) || booking.ticket_numbers.length !== 0))) return false;
  if (booking.shapon_current_status == null) return true;
  const saved = parseShapontravelsCurrentStatusProjection(booking.shapon_current_status);
  return Boolean(saved && SHAPON_CANCELLABLE_STATUSES.includes(saved.currentStatus.status) &&
    SHAPON_CANCELLABLE_STATUSES.includes(saved.effectiveStatus) &&
    (saved.currentStatus.canCancel === true || (saved.currentStatus.canCancel !== false &&
      saved.currentStatus.reviewRequired === false &&
      (!saved.reviewRequired || saved.currentStatus.status !== 'on-hold'))));
}

export function isShaponPreClosureRefusal(error: unknown): error is ShapontravelsWriteError {
  return error instanceof ShapontravelsWriteError && error.operation === 'Cancel' && error.status === 409 &&
    (error.code === 'TICKET_ISSUE_ALREADY_RESERVED' || error.code === 'LOCAL_CANCELLATION_NOT_ELIGIBLE');
}

/** A failed read is distinct from a verified denial or mismatched identity. */
export function isShaponCancellationReadUnavailable(error: unknown): boolean {
  return error instanceof ShapontravelsReadError &&
    (error.code === 'BOOKING_READ_NETWORK' || (error.status !== null && error.status >= 500));
}

/** The echoed identities prove Shapon platform closure for this booking. */
export function parseShapontravelsCancellationReceipt(
  body: unknown,
  input: ShapontravelsCancellationInput
): ShaponPlatformCancellation | null {
  const object = (value: unknown): Record<string, unknown> | null =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  const envelope = object(body);
  const receipt = object(envelope?.item1);
  const result = object(envelope?.item2);
  if (!shapontravelsCancellationReferencesReady({
    pnr: input.pnr || null,
    booking_ref_number: input.bookingRefNumber || null,
    booking_code_ref: input.bookingCodeRef,
    supplier_refs: input,
  }) || !receipt || result?.isSuccess !== true || receipt.isCancel !== true ||
      receipt.uniqueTransID !== input.uniqueTransId ||
      receipt.itemCodeRef !== input.itemCodeRef ||
      receipt.priceCodeRef !== input.priceCodeRef ||
      receipt.bookingCodeRef !== input.bookingCodeRef ||
      (receipt.pnr != null && receipt.pnr !== input.pnr) ||
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
    status: 'cancelled',
    walletMutation: false,
    uniqueTransId: input.uniqueTransId,
    itemCodeRef: input.itemCodeRef,
    priceCodeRef: input.priceCodeRef,
    bookingCodeRef: input.bookingCodeRef,
  };
}

export async function cancelShapontravelsBooking(
  input: ShapontravelsCancellationInput,
  idempotencyKey: string,
  hooks: SupplierWriteLifecycleHooks
): Promise<ShaponPlatformCancellation> {
  const body = await shapontravelsCancelRequest({
    PNR: input.pnr,
    BookingRefNumber: input.pnr,
    UniqueTransID: input.uniqueTransId,
    PriceCodeRef: input.priceCodeRef,
    ItemCodeRef: input.itemCodeRef,
    BookingCodeRef: input.bookingCodeRef,
  }, idempotencyKey, hooks);
  const outcome = parseShapontravelsCancellationReceipt(body, input);
  if (!outcome) {
    throw new ShapontravelsWriteError('protocol', 'UNVERIFIED_CANCEL_RESPONSE',
      200, null, null, null, 'Cancel');
  }
  return outcome;
}
