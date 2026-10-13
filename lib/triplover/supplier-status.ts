import 'server-only';

import type { BookingRow } from '@/lib/db/flight-bookings';
import { storedTicketReferences } from '@/lib/booking-lifecycle/ticketing-flow';
import { triploverCall } from '@/lib/triplover/client';
import { isTriploverSupplier } from '@/lib/triplover/config';
import { verifyTriploverTicketReport } from '@/lib/triplover/indigo-ticket';
import { supplierLifecycleInstant } from '@/lib/triplover/time';
import type { TicketIssueInput } from '@/lib/triplover/ticket';

export type TriploverSupplierStatusFacts = {
  verified: boolean;
  verifiedStatus: 'issued' | 'held' | 'cancelled' | 'unknown';
  supplierStatus: string | null;
  pnr: string | null;
  airlinePnrs: string[];
  tickets: Array<{ passengerIndex: number; ticketNumbers: string[] }>;
  ticketCodeRef: string | null;
  issuedAt: string | null;
  supplierPayableMinor: number | null;
  currency: 'BDT';
  reason: string | null;
  source: 'ticket_report' | 'pnr' | 'unavailable';
  rawPayloadHash: string | null;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function canCheckTriploverSupplierStatus(booking: BookingRow): boolean {
  return booking.supplier === 'triplover' && isTriploverSupplier(booking.supplier_account) &&
    !booking.legacy_operational && !booking.import_source && !booking.direct_ticketing &&
    booking.currency === 'BDT' && Boolean(storedTicketReferences(booking));
}

export function triploverTicketInputForBooking(booking: BookingRow): TicketIssueInput | null {
  if (!canCheckTriploverSupplierStatus(booking)) return null;
  const refs = storedTicketReferences(booking)!;
  return {
    ...refs,
    supplier: booking.supplier_account as TicketIssueInput['supplier'],
    expectedPassengerCount: Object.values(booking.passenger_counts).reduce((sum, count) => sum + count, 0),
    savedBooking: {
      itinerary: booking.itinerary, airlinePnrs: booking.airlines_pnr,
      passengers: booking.passengers, fares: booking.fares,
      supplierTotalPrice: booking.pricing_snapshot.supplierTotalPrice,
      grossPrice: booking.pricing_snapshot.grossPrice,
    },
  };
}

/** Supplier reads only. The caller records this proof without changing booking/payment truth. */
export async function readTriploverSupplierStatus(booking: BookingRow): Promise<TriploverSupplierStatusFacts> {
  const input = triploverTicketInputForBooking(booking);
  if (!input) throw new Error('This booking does not support supplier status verification.');
  const unknown: TriploverSupplierStatusFacts = {
    verified: false, verifiedStatus: 'unknown', supplierStatus: null,
    pnr: input.pnr, airlinePnrs: [], tickets: [], ticketCodeRef: null, issuedAt: null,
    supplierPayableMinor: null, currency: 'BDT', reason: 'SUPPLIER_UNAVAILABLE',
    source: 'unavailable', rawPayloadHash: null,
  };
  const [pnrRead, reportRead] = await Promise.allSettled([
    triploverCall('Pnr', '/api/pnr', {
      PNR: input.pnr, BookingRefNumber: input.bookingRefNumber,
      UniqueTransID: input.uniqueTransId, PriceCodeRef: input.priceCodeRef,
      ItemCodeRef: input.itemCodeRef, BookingCodeRef: input.bookingCodeRef,
    }, { supplier: input.supplier, timeoutMs: 15000 }),
    // Active IndiGo PNRs can be held or ticketed; the independent report is mandatory.
    triploverCall('AirTicketingDetails',
      `/api/B2BReport/AirTicketingDetails/${encodeURIComponent(input.uniqueTransId)}/Confirmed`, null,
      { supplier: input.supplier, method: 'GET', topLevelPayload: true, timeoutMs: 15000 }),
  ]);
  const pnr = pnrRead.status === 'fulfilled' ? record(pnrRead.value.data) : {};
  const report = reportRead.status === 'fulfilled' ? record(reportRead.value.data) : {};
  const ticket = record(report.ticketInfo);
  const pnrStatus = text(pnr.status);
  const reportedStatus = text(ticket.status) ?? pnrStatus;
  const pnrConflicts = pnrRead.status === 'fulfilled' && (
    pnr.pnr !== input.pnr ||
    ['uniqueTransID', 'uniqueTransId', 'UniqueTransID'].some(key => pnr[key] != null && pnr[key] !== '' && pnr[key] !== input.uniqueTransId) ||
    ['itemCodeRef', 'priceCodeRef', 'bookingCodeRef'].some(key => pnr[key] != null && pnr[key] !== '' && pnr[key] !== input[key as 'itemCodeRef' | 'priceCodeRef' | 'bookingCodeRef'])
  );
  if (pnrConflicts) return { ...unknown, supplierStatus: reportedStatus, reason: 'SUPPLIER_IDENTITY_MISMATCH' };
  const verified = reportRead.status === 'fulfilled' ? verifyTriploverTicketReport(report, input) : null;
  if (verified) {
    if (['cancelled', 'canceled', 'refunded', 'voided'].includes(pnrStatus?.toLowerCase() ?? '') ||
        ['isCancelled', 'isCanceled', 'isRefunded', 'isVoided'].some(key => pnr[key] === true)) {
      return { ...unknown, supplierStatus: reportedStatus, reason: 'SUPPLIER_STATUS_CONFLICT' };
    }
    return {
      verified: true, verifiedStatus: 'issued', supplierStatus: 'Issued', pnr: input.pnr,
      airlinePnrs: verified.airlinesPnr,
      tickets: verified.passengerTickets.map((ticketNumbers, passengerIndex) => ({ passengerIndex, ticketNumbers })),
      ticketCodeRef: verified.ticketCodeRef,
      issuedAt: supplierLifecycleInstant(input.supplier, ticket.issueDate),
      supplierPayableMinor: Math.round(input.savedBooking!.supplierTotalPrice! * 100),
      currency: 'BDT', reason: null, source: 'ticket_report',
      rawPayloadHash: reportRead.status === 'fulfilled' ? reportRead.value.receipt.rawPayloadHash : null,
    };
  }
  // A returned locator without a transaction echo cannot authorize a decided outcome.
  const pnrIdentityMatches = pnrRead.status === 'fulfilled' && pnr.pnr === input.pnr &&
    [pnr.uniqueTransID, pnr.uniqueTransId, pnr.UniqueTransID].some(value => value === input.uniqueTransId);
  const normalizedStatus = pnrStatus?.toLowerCase();
  const reportClaimsIssued = ['issued', 'ticketed', 'confirmed'].includes(text(ticket.status)?.toLowerCase() ?? '');
  if (pnrIdentityMatches && !reportClaimsIssued && ['booked', 'created', 'held', 'cancelled', 'canceled'].includes(normalizedStatus ?? '')) {
    return {
      ...unknown, verified: true,
      verifiedStatus: normalizedStatus === 'cancelled' || normalizedStatus === 'canceled' ? 'cancelled' : 'held',
      supplierStatus: pnrStatus, reason: 'NO_ISSUED_TICKET_PROOF', source: 'pnr',
      rawPayloadHash: pnrRead.status === 'fulfilled' ? pnrRead.value.receipt.rawPayloadHash : null,
    };
  }
  return {
    ...unknown, supplierStatus: reportedStatus,
    reason: reportRead.status === 'fulfilled' ? 'TICKET_EVIDENCE_INCOMPLETE' :
      pnrRead.status === 'fulfilled' ? 'ISSUANCE_NOT_VERIFIED' : 'SUPPLIER_UNAVAILABLE',
    source: reportRead.status === 'fulfilled' ? 'ticket_report' : pnrRead.status === 'fulfilled' ? 'pnr' : 'unavailable',
    rawPayloadHash: reportRead.status === 'fulfilled' ? reportRead.value.receipt.rawPayloadHash :
      pnrRead.status === 'fulfilled' ? pnrRead.value.receipt.rawPayloadHash : null,
  };
}
