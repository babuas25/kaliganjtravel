import 'server-only';

import type { BookingRow } from '@/lib/db/flight-bookings';
import type { ShapontravelsBookingRead, ShapontravelsTicketRead } from './client';
import { parseShapontravelsCurrentStatus, verifyShapontravelsBookingStatus } from './booking-status';
import { parseShapontravelsTicketReceipt, shapontravelsTicketIdentityReady } from './ticket';

export function canConfirmShaponExternalTicket(role: string): boolean {
  return role === 'admin' || role === 'superadmin';
}

/** An externally issued ticket must not bypass another local financial operation. */
export function canOfferShaponExternalTicketConfirmation(booking: BookingRow): boolean {
  const activeOperation = (booking as BookingRow & { active_operation_id?: string | null })
    .active_operation_id;
  const amount = Math.round(Number(booking.pricing_snapshot?.sellingPrice) * 100);
  return booking.supplier === 'shapontravels' && booking.supplier_account === 'shapontravels' &&
    booking.import_source === null && !booking.legacy_operational && !booking.direct_ticketing &&
    (booking.status === 'on-hold' || booking.status === 'pending') &&
    (booking.payment_state === 'unpaid' || booking.payment_state === 'released') &&
    !booking.operation_kind && !activeOperation && !booking.issued_at &&
    !booking.ticket_code_ref &&
    (booking.ticket_numbers == null ||
      (Array.isArray(booking.ticket_numbers) && booking.ticket_numbers.length === 0)) &&
    Number(booking.captured_amount ?? 0) === 0 && Number(booking.refunded_amount ?? 0) === 0 &&
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
  if (status.result !== 'verified' || status.currentStatusState !== 'available' ||
      status.currentStatus?.status !== 'confirmed' || status.currentStatus.reviewRequired !== false ||
      !confirmedPaidReceipt(bookingRead.body, booking.pnr!) ||
      !confirmedPaidReceipt(ticketRead.body, booking.pnr!) ||
      !ticketCurrentStatusAgrees(ticketRead.body)) return null;

  const passengerCount = Object.values(booking.passenger_counts)
    .reduce<number>((sum, count) => sum + (count ?? 0), 0);
  const ticket = parseShapontravelsTicketReceipt(ticketRead.body, {
    ...booking.supplier_refs,
    pnr: booking.pnr!,
    bookingRefNumber: booking.booking_ref_number!,
    bookingCodeRef: booking.booking_code_ref!,
    itinerary: booking.itinerary,
    expectedPassengerCount: passengerCount,
  });
  if (!ticket) return null;
  const envelope = object(ticketRead.body)!;
  const receipt = object(envelope.item1)!;
  const passengerTickets = (receipt.ticketInfoes as Record<string, unknown>[]).map(row => ({
    ticketNumbers: row.ticketNumbers as string[],
    ticketNumberSource: row.ticketNumberSource === 'airline_pnr' ? 'airline_pnr' : null,
  }));
  const publicReceipt = object(envelope.publicReceipt)!;
  const issuedAt = publicReceipt.issuedAt;
  return {
    receiptIdentity,
    ticketProof: {
      verified: true,
      issued: true,
      paid: true,
      source: 'supplier_ticket_details',
      bookingStatus: 'Confirmed',
      paymentStatus: 'Paid',
      pnr: ticket.pnr,
      ticketCodeRef: ticket.ticketCodeRef,
      ticketNumbers: ticket.ticketNumbers,
      airlinesPnr: ticket.airlinesPnr,
      passengerCount,
      passengerTickets,
      ...(typeof issuedAt === 'string' && Number.isFinite(Date.parse(issuedAt))
        ? { issuedAt } : {}),
    },
    checkedAt: new Date().toISOString(),
  };
}
