import 'server-only';

import type { BookingRow } from '@/lib/db/flight-bookings';
import type { ShapontravelsBookingRead, ShapontravelsTicketRead } from './client';
import {
  matchingShapontravelsSavedTicketSnapshots,
  normalizeShapontravelsReceiptEnvelope,
  normalizeShapontravelsSavedBookingEnvelope,
  parseShapontravelsCurrentStatus,
  verifyShapontravelsBookingStatus,
} from './booking-status';
import { parseShapontravelsTicketEvidence, shapontravelsTicketIdentityReady } from './ticket';

export function canConfirmShaponExternalTicket(role: string): boolean {
  return role === 'admin' || role === 'superadmin';
}

/** Only the original uncertain Issue can reuse its protected wallet hold. */
export function isShaponTicketingRecovery(booking: BookingRow): boolean {
  const activeOperation = (booking as BookingRow & { active_operation_id?: string | null })
    .active_operation_id;
  return booking.status === 'in-progress' && booking.operation_kind === 'reconciliation' &&
    booking.operation_reason === 'ticketing_reconciliation' &&
    ['held', 'captured', 'reconciliation'].includes(booking.payment_state) && Boolean(activeOperation);
}

/** Other active operations remain protected by their own resolution workflows. */
export function canOfferShaponExternalTicketConfirmation(booking: BookingRow): boolean {
  const activeOperation = (booking as BookingRow & { active_operation_id?: string | null })
    .active_operation_id;
  const amount = Math.round(Number(booking.pricing_snapshot?.sellingPrice) * 100);
  const ordinaryHold = (booking.status === 'on-hold' || booking.status === 'pending') &&
    !booking.operation_kind && !activeOperation;
  return booking.supplier === 'shapontravels' && booking.supplier_account === 'shapontravels' &&
    booking.import_source === null && !booking.legacy_operational && !booking.direct_ticketing &&
    (ordinaryHold || isShaponTicketingRecovery(booking)) &&
    Boolean(booking.booking_owner_type && booking.booking_owner_key) &&
    booking.currency === 'BDT' && typeof booking.pricing_snapshot?.sellingPrice === 'number' &&
    Number.isSafeInteger(amount) && amount > 0 &&
    shapontravelsTicketIdentityReady(booking);
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function confirmedPaidReceipt(body: unknown, pnr: string): boolean {
  const envelope = object(body);
  const receipt = object(envelope?.publicReceipt);
  if (!envelope || !receipt) return false;
  return receipt.status === 'confirmed' && receipt.paymentState === 'paid' &&
    receipt.pendingReview === false && receipt.pnr === pnr &&
    (!Object.hasOwn(envelope, 'requiresReconciliation') || envelope.requiresReconciliation === false);
}

function ticketCurrentStatusAgrees(body: unknown): boolean {
  const envelope = object(body);
  if (!envelope) return false;
  if (!Object.hasOwn(envelope, 'currentStatus')) return true;
  const current = object(envelope.currentStatus);
  if (!current) return false;
  if (Object.keys(current).length === 2 && Object.hasOwn(current, 'status') &&
      Object.hasOwn(current, 'reviewRequired')) {
    return current.status === 'confirmed' && current.reviewRequired === false;
  }
  const parsed = parseShapontravelsCurrentStatus(current);
  return parsed?.status === 'confirmed' && parsed.reviewRequired === false;
}

/** Build a server-owned proof from two matching saved supplier reads; never Issue. */
export function verifyShaponExternalTicketConfirmation(
  booking: BookingRow,
  bookingRead: ShapontravelsBookingRead,
  ticketRead: ShapontravelsTicketRead,
  supplierPublicRef: string,
) {
  if (bookingRead.httpStatus !== 200 || ticketRead.httpStatus !== 200 ||
      !shapontravelsTicketIdentityReady(booking) || !/^STR[A-Z0-9]{6,32}$/.test(supplierPublicRef)) {
    return null;
  }
  const snapshots = [bookingRead.body, ticketRead.body].map(body => {
    const envelope = object(body);
    if (!envelope || !Object.hasOwn(envelope, 'savedBooking')) return { valid: true, body };
    const canonical = normalizeShapontravelsSavedBookingEnvelope(body);
    if (!canonical || canonical.savedBooking?.reference !== supplierPublicRef) return { valid: false, body };
    // Compare canonical passenger/flight/ticket snapshots even when successful
    // legacy wrappers coexist. Invalid canonical evidence cannot be bypassed.
    const savedEnvelope = { ...envelope };
    delete savedEnvelope.item1;
    delete savedEnvelope.item2;
    return { valid: true, body: savedEnvelope };
  });
  if (snapshots.some(snapshot => !snapshot.valid) ||
      !matchingShapontravelsSavedTicketSnapshots(snapshots[0].body, snapshots[1].body)) return null;
  const receiptIdentity = {
    uniqueTransId: booking.supplier_refs.uniqueTransId,
    itemCodeRef: booking.supplier_refs.itemCodeRef,
    priceCodeRef: booking.supplier_refs.priceCodeRef,
    bookingCodeRef: booking.booking_code_ref,
    bookingRefNumber: booking.booking_ref_number,
    pnr: booking.pnr,
    supplierPublicRef,
  };
  const status = verifyShapontravelsBookingStatus(bookingRead, receiptIdentity);
  const normalizedTicket = normalizeShapontravelsReceiptEnvelope(ticketRead.body);
  if (status.result !== 'verified' || status.currentStatusState !== 'available' ||
      status.currentStatus?.status !== 'confirmed' || status.currentStatus.reviewRequired !== false ||
      !normalizedTicket ||
      (normalizedTicket.savedBooking && normalizedTicket.savedBooking.reference !== supplierPublicRef) ||
      !confirmedPaidReceipt(bookingRead.body, booking.pnr!) ||
      !confirmedPaidReceipt(ticketRead.body, booking.pnr!) ||
      !ticketCurrentStatusAgrees(ticketRead.body)) return null;

  const passengerCount = Object.values(booking.passenger_counts)
    .reduce<number>((sum, count) => sum + (count ?? 0), 0);
  const evidence = parseShapontravelsTicketEvidence(ticketRead.body, {
    ...booking.supplier_refs,
    pnr: booking.pnr!,
    bookingRefNumber: booking.booking_ref_number!,
    bookingCodeRef: booking.booking_code_ref!,
    itinerary: booking.itinerary,
    expectedPassengerCount: passengerCount,
  });
  if (!evidence) return null;
  const { ticket, passengerTickets } = evidence;
  const envelope = object(ticketRead.body)!;
  const publicReceipt = object(envelope.publicReceipt)!;
  const issuedAt = publicReceipt.issuedAt;
  return {
    receiptIdentity,
    ticketProof: {
      verified: true,
      issued: true,
      paid: true,
      source: evidence.source,
      ...(evidence.schemaVersion ? { schemaVersion: evidence.schemaVersion } : {}),
      bookingStatus: 'Confirmed',
      paymentStatus: 'Paid',
      pnr: ticket.pnr,
      ticketCodeRef: ticket.ticketCodeRef,
      ticketNumbers: ticket.ticketNumbers,
      airlinesPnr: ticket.airlinesPnr,
      passengerCount,
      passengerTickets,
      ...(typeof issuedAt === 'string' &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(issuedAt) &&
        Number.isFinite(Date.parse(issuedAt))
        ? { issuedAt } : {}),
    },
    checkedAt: new Date().toISOString(),
  };
}
