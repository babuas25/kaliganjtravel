import 'server-only';

import type { PrivateBookingRefs } from '@/lib/flights/booking';
import {
  TriploverError,
  triploverCall,
  type SupplierWriteLifecycleHooks,
} from '@/lib/triplover/client';
import type { TriploverSupplier } from '@/lib/triplover/config';
import { completeTicketNumbers } from '@/lib/triplover/ticket-payload';

export type TicketIssueInput = PrivateBookingRefs & {
  supplier: TriploverSupplier;
  pnr: string;
  bookingRefNumber: string;
  bookingCodeRef: string;
  expectedPassengerCount?: number;
};

export type TicketIssueOutcome = {
  pnr: string;
  bookingStatus: 'Confirmed';
  ticketCodeRef: string;
  ticketNumbers: string[];
  warnings: string[];
  message: string | null;
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
  const ticketNumbers = completeTicketNumbers(raw.ticketInfoes, input.expectedPassengerCount);
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
  };
}
