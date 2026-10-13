import 'server-only';

import type { BookedItinerary, PrivateBookingRefs } from '@/lib/flights/booking';
import {
  TriploverError,
  triploverCall,
  type SupplierWriteLifecycleHooks,
} from '@/lib/triplover/client';
import type { TriploverSupplier } from '@/lib/triplover/config';
import { completeTicketNumbers } from '@/lib/triplover/ticket-payload';
import { canVerifyIndigoIssueResponse, indigoIssueReportMatches, verifyIndigoIssueReceipt, verifyIndigoTicketReport } from '@/lib/triplover/indigo-ticket';

export type TicketIssueInput = PrivateBookingRefs & {
  supplier: TriploverSupplier;
  pnr: string;
  bookingRefNumber: string;
  bookingCodeRef: string;
  expectedPassengerCount?: number;
  /** Context comes only from the scoped saved booking, outside the request identity. */
  savedBooking?: {
    itinerary: BookedItinerary | null;
    airlinePnrs: unknown;
    passengers: unknown;
    fares: unknown;
    supplierTotalPrice?: number;
    grossPrice?: number;
  };
};

export type TicketIssueOutcome = {
  pnr: string;
  bookingStatus: 'Confirmed';
  ticketCodeRef: string;
  ticketNumbers: string[];
  warnings: string[];
  message: string | null;
  airlinesPnr?: string[];
  ticketNumberSource?: 'airline_pnr';
};

/** Issues one held Triplover booking. This operation is never transport-retried. */
export async function issueTicket(
  input: TicketIssueInput,
  lifecycleHooks?: SupplierWriteLifecycleHooks
): Promise<TicketIssueOutcome> {
  const call = await triploverCall('NewTicket', '/api/ticket/NewTicket', {
    PNR: input.pnr,
    BookingRefNumber: input.bookingRefNumber,
    UniqueTransID: input.uniqueTransId,
    PriceCodeRef: input.priceCodeRef,
    ItemCodeRef: input.itemCodeRef,
    BookingCodeRef: input.bookingCodeRef,
  }, { supplier: input.supplier, lifecycleHooks });
  if (!call.data || typeof call.data !== 'object') {
    throw new TriploverError('protocol', 'Triplover NewTicket returned no ticket.');
  }
  const raw = call.data as {
    pnr?: string;
    ticketCodeRef?: string;
    ticketInfoes?: { ticketNumbers?: unknown }[];
    warnings?: unknown;
    message?: string;
  };
  const pnr = raw.pnr?.trim() || input.pnr;
  const ticketCodeRef = raw.ticketCodeRef?.trim() ?? '';
  let ticketNumbers = completeTicketNumbers(raw.ticketInfoes, input.expectedPassengerCount);
  let verifiedIndigo: ReturnType<typeof verifyIndigoIssueReceipt> = null;
  if (!ticketNumbers?.every(number => /^\d{10,16}$/.test(number))) {
    ticketNumbers = null;
    if (canVerifyIndigoIssueResponse(raw, input)) {
      verifiedIndigo = verifyIndigoIssueReceipt(raw, input);
      // A read can establish the issued result of this one call. Never repeat NewTicket.
      if (!verifiedIndigo && input.savedBooking?.itinerary?.carrierCode === '6E') {
        try {
          const report = await triploverCall('AirTicketingDetails',
            `/api/B2BReport/AirTicketingDetails/${encodeURIComponent(input.uniqueTransId)}/Confirmed`, null,
            { supplier: input.supplier, method: 'GET', topLevelPayload: true, timeoutMs: 5000 });
          verifiedIndigo = verifyIndigoTicketReport(report.data, input);
          if (verifiedIndigo && ((verifiedIndigo.ticketCodeRef && verifiedIndigo.ticketCodeRef !== ticketCodeRef) ||
              !indigoIssueReportMatches(raw, verifiedIndigo, input))) verifiedIndigo = null;
        } catch {
          // Unavailable or incomplete proof retains the existing reconciliation path.
        }
      }
      ticketNumbers = verifiedIndigo?.ticketNumbers ?? null;
    }
  }
  if (!ticketCodeRef || !ticketNumbers) {
    throw new TriploverError(
      'protocol',
      'Triplover NewTicket returned an incomplete ticket response.'
    );
  }
  return {
    pnr,
    bookingStatus: 'Confirmed',
    ticketCodeRef,
    ticketNumbers,
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.filter(
          (value): value is string => typeof value === 'string'
        )
      : [],
    message: raw.message ?? null,
    ...(verifiedIndigo ? {
      airlinesPnr: verifiedIndigo.airlinesPnr,
      ...(ticketNumbers.some(number => verifiedIndigo?.airlinesPnr.includes(number))
        ? { ticketNumberSource: 'airline_pnr' as const } : {}),
    } : {}),
  };
}
