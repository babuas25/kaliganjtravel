import 'server-only';

import type { BookingRow } from '@/lib/db/flight-bookings';
import type { ShaponSavedCancellation, ShapontravelsCancellationInput } from './cancel';
import type { ShapontravelsBookingRead, ShapontravelsTicketRead } from './client';
import {
  normalizeShapontravelsReceiptEnvelope,
  normalizeShapontravelsSavedBookingEnvelope,
  verifyShapontravelsBookingStatus,
  type ShapontravelsBookingStatus,
} from './booking-status';

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

/** Verify the exact native saved resource and its current platform actions. */
export function readShaponCancellationState(
  read: ShapontravelsBookingRead,
  input: ShapontravelsCancellationInput,
  supplierPublicRef: string,
): { closure: ShaponSavedCancellation | null; canRetry: boolean; observation: ShapontravelsBookingStatus } | null {
  const saved = normalizeShapontravelsSavedBookingEnvelope(read.body);
  if (read.httpStatus !== 200 || !saved?.savedBooking ||
      saved.savedBooking.bookingId !== input.bookingCodeRef ||
      saved.savedBooking.reference !== supplierPublicRef) return null;
  const status = verifyShapontravelsBookingStatus(read, {
    ...input, bookingRefNumber: input.bookingRefNumber || null, pnr: input.pnr || null, supplierPublicRef,
  });
  const receipt = object(saved.envelope.publicReceipt);
  const payment = object(saved.savedBooking.payment);
  if (status.result !== 'verified' || status.currentStatusState !== 'available' ||
      !status.currentStatus || (saved.receipt.pnr ?? null) !== (input.pnr || null)) return null;
  if (status.ticketedEvidencePresent || saved.savedBooking.paymentState !== 'unpaid' ||
      saved.savedBooking.issuedAt != null || receipt?.paymentState !== 'unpaid' || receipt.issuedAt != null ||
      (payment?.state != null && payment.state !== 'unpaid' && payment.state !== 'released') ||
      !Array.isArray(receipt.tickets) || receipt.tickets.length !== 0) {
    return { closure: null, canRetry: false, observation: status };
  }

  const canRetry = ['on-hold', 'unconfirmed', 'expired'].includes(status.currentStatus.status) &&
    status.currentStatus.canCancel === true;
  const closed = status.currentStatus.status === 'cancelled' &&
    status.currentStatus.reviewRequired === false && saved.savedBooking.requiresReconciliation === false;
  return { canRetry, observation: status, closure: closed ? {
    isCancel: true, status: 'cancelled', walletMutation: false,
    uniqueTransId: input.uniqueTransId, itemCodeRef: input.itemCodeRef,
    priceCodeRef: input.priceCodeRef, bookingCodeRef: input.bookingCodeRef,
    supplierPublicRef, savedBookingId: input.bookingCodeRef,
  } : null };
}

/** Stored Shapon cancellation evidence can finish only its original unpaid operation. */
export function verifyShaponCancellationRecovery(
  booking: BookingRow,
  bookingRead: ShapontravelsBookingRead,
  ticketRead: ShapontravelsTicketRead | null,
  supplierPublicRef: string,
) {
  const operation = (booking as BookingRow & { active_operation_id?: string | null })
    .active_operation_id;
  if (booking.supplier !== 'shapontravels' || booking.supplier_account !== 'shapontravels' ||
      booking.import_source !== null || booking.direct_ticketing || booking.legacy_operational ||
      booking.status !== 'in-progress' || booking.operation_kind !== 'reconciliation' ||
      booking.operation_reason !== 'cancellation_reconciliation' || !operation ||
      booking.payment_state !== 'unpaid' || Number(booking.captured_amount) !== 0 ||
      Number(booking.refunded_amount) !== 0 || booking.charged_wallet_account_id != null ||
      booking.payment_amount != null || booking.issued_at || booking.ticket_code_ref ||
      (booking.ticket_numbers != null &&
        (!Array.isArray(booking.ticket_numbers) || booking.ticket_numbers.length > 0)) ||
      bookingRead.httpStatus !== 200) return null;

  const identity = {
    ...booking.supplier_refs,
    bookingCodeRef: booking.booking_code_ref,
    bookingRefNumber: booking.booking_ref_number,
    pnr: booking.pnr,
    supplierPublicRef,
  };
  const bookingEnvelope = object(bookingRead.body);
  const canonical = bookingEnvelope && Object.hasOwn(bookingEnvelope, 'savedBooking')
    ? normalizeShapontravelsSavedBookingEnvelope(bookingRead.body) : null;
  // A supplied but inconsistent canonical record must never fall back to a
  // partial legacy wrapper. A complete saved booking carries its own explicit
  // no-ticket evidence, so no ticket resource or supplier synchronization is needed.
  if (bookingEnvelope && Object.hasOwn(bookingEnvelope, 'savedBooking') && !canonical) return null;
  if (!canonical && ticketRead?.httpStatus !== 200) return null;
  if (ticketRead && ticketRead.httpStatus !== 200 &&
      !(canonical && ticketRead.httpStatus === 404 && object(ticketRead.body)?.error === 'NOT_FOUND')) return null;

  const reads = [bookingRead];
  if (ticketRead?.httpStatus === 200) reads.push({ ...ticketRead, supplierPublicRef });
  let cancelledAt: string | undefined;
  let observationSource: string | null = null;
  let observationVerified = false;
  let supplierCheckedAt: string | null = null;
  for (const read of reads) {
    const envelopeBody = object(read.body);
    const hasCanonical = envelopeBody && Object.hasOwn(envelopeBody, 'savedBooking');
    const normalized = hasCanonical
      ? normalizeShapontravelsSavedBookingEnvelope(read.body)
      : normalizeShapontravelsReceiptEnvelope(read.body);
    if (!normalized) return null;
    const status = verifyShapontravelsBookingStatus(read, identity);
    const { envelope, receipt, savedBooking } = normalized;
    const publicReceipt = object(envelope.publicReceipt);
    const supplierPayment = object(savedBooking?.payment);
    if (status.result !== 'verified' || status.currentStatusState !== 'available' ||
        status.currentStatus?.status !== 'cancelled' || status.currentStatus.reviewRequired !== false ||
        envelope.requiresReconciliation !== false || publicReceipt?.status !== 'cancelled' ||
        publicReceipt.pendingReview !== false || publicReceipt.pnr !== booking.pnr ||
        publicReceipt.paymentState !== 'unpaid' || publicReceipt.issuedAt != null ||
        (savedBooking && !Array.isArray(publicReceipt.tickets)) ||
        (Array.isArray(publicReceipt.tickets) && publicReceipt.tickets.length !== 0) ||
        receipt.issuedAt != null || receipt.ticketCodeRef != null ||
        !Array.isArray(receipt.ticketInfoes) || receipt.ticketInfoes.length !== 0 ||
        (Object.hasOwn(envelope, 'paymentState') && envelope.paymentState !== 'unpaid') ||
        (Object.hasOwn(envelope, 'customerPaymentState') && envelope.customerPaymentState !== 'unpaid') ||
        (savedBooking && (savedBooking.reference !== supplierPublicRef ||
          savedBooking.bookingId !== booking.booking_code_ref ||
          savedBooking.requiresReconciliation !== false || savedBooking.reviewRequired !== false ||
          savedBooking.paymentState !== 'unpaid' || savedBooking.issuedAt != null ||
          savedBooking.ticketCodeRef != null || !Array.isArray(savedBooking.ticketInfoes) ||
          savedBooking.ticketInfoes.length !== 0 ||
          (supplierPayment?.state != null &&
            supplierPayment.state !== 'unpaid' && supplierPayment.state !== 'released')))) return null;
    if (observationSource === null) {
      observationSource = status.currentStatus.source;
      observationVerified = status.currentStatus.verified;
      supplierCheckedAt = status.currentStatus.supplierCheckedAt;
    }
    // Missing or timezone-less supplier times never become invented instants.
    for (const timestamp of [publicReceipt.cancelledAt, savedBooking?.cancelledAt]) {
      if (typeof timestamp === 'string' &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) &&
          Number.isFinite(Date.parse(timestamp))) {
        const instant = new Date(timestamp).toISOString();
        if (cancelledAt && cancelledAt !== instant) return null;
        cancelledAt = instant;
      }
    }
  }
  return {
    receiptIdentity: identity,
    cancellationProof: {
      verified: true, cancelled: true, source: 'supplier_booking_details',
      status: 'cancelled', pendingReview: false, requiresReconciliation: false,
      pnr: booking.pnr, ticketCount: 0,
      evidenceKind: canonical ? 'shapon_saved_booking_v1' : 'matching_saved_receipts',
      supplierSyncPerformed: false,
      supplierStatusSource: observationSource,
      supplierObservationVerified: observationVerified,
      supplierCheckedAt,
      ...(cancelledAt ? { cancelledAt } : {}),
    },
    checkedAt: new Date().toISOString(),
  };
}
