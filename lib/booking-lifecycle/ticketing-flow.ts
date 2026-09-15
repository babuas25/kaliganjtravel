import type { PrivateBookingRefs } from '@/lib/flights/booking';

/** Keep both Book locators: some supplier accounts return distinct values. */
export function storedTicketReferences(booking: {
  pnr: string | null;
  booking_ref_number: string | null;
  booking_code_ref: string | null;
  supplier_refs: PrivateBookingRefs | null;
}): (PrivateBookingRefs & {
  pnr: string;
  bookingRefNumber: string;
  bookingCodeRef: string;
}) | null {
  const pnr = booking.pnr?.trim() || booking.booking_ref_number?.trim();
  const bookingRefNumber = booking.booking_ref_number?.trim() || pnr;
  const bookingCodeRef = booking.booking_code_ref;
  const refs = booking.supplier_refs;
  if (!pnr || !bookingRefNumber || !bookingCodeRef?.trim() ||
      !refs?.uniqueTransId?.trim() || !refs.itemCodeRef?.trim() ||
      !refs.priceCodeRef?.trim()) return null;
  // Opaque tokens are validated without rewriting their contents.
  return { ...refs, pnr, bookingRefNumber, bookingCodeRef };
}

/**
 * Supplier certification flow: Search -> Reprice -> Book -> NewTicket.
 * API-created bookings retain their references for immediate or delayed issue;
 * a missing deadline must not introduce a PNR read into that flow. Imported
 * and legacy bookings retain their separate verification workflows.
 */
export function usesStoredBookingReferences(booking: {
  supplier: string;
  supplier_account: string | null;
  import_source?: string | null;
  legacy_operational?: boolean;
}): boolean {
  return booking.supplier === 'triplover' &&
    booking.import_source == null &&
    !booking.legacy_operational &&
    ['firsttrip', 'takeoff', 'triplover'].includes(booking.supplier_account ?? '');
}
