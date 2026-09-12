import 'server-only';

import type { PrivateBookingRefs } from '@/lib/flights/booking';
import {
  TriploverError,
  triploverCall,
  type SupplierWriteLifecycleHooks,
} from '@/lib/triplover/client';
import type { TriploverSupplier } from '@/lib/triplover/config';

export type CancelBookingInput = PrivateBookingRefs & {
  supplier: TriploverSupplier;
  pnr: string;
  bookingRefNumber: string;
  bookingCodeRef: string;
};

export type CancelBookingOutcome = {
  isCancel: true;
  uniqueTransId: string;
  netRefund: number | null;
  refundPenalty: number | null;
};

/** Cancels one held Triplover booking. This destructive write is never retried. */
export async function cancelBooking(
  input: CancelBookingInput,
  lifecycleHooks?: SupplierWriteLifecycleHooks
): Promise<CancelBookingOutcome> {
  const call = await triploverCall('Cancel', '/api/Cancel', {
    PNR: input.pnr,
    BookingRefNumber: input.bookingRefNumber,
    UniqueTransID: input.uniqueTransId,
    PriceCodeRef: input.priceCodeRef,
    ItemCodeRef: input.itemCodeRef,
    BookingCodeRef: input.bookingCodeRef,
  }, { supplier: input.supplier, lifecycleHooks });
  if (!call.data || typeof call.data !== 'object') {
    throw new TriploverError('protocol', 'Triplover Cancel returned no result.');
  }
  const raw = call.data as {
    isCancel?: boolean;
    uniqueTransID?: string;
    netRefund?: number | null;
    refundPenalty?: number | null;
  };
  if (raw.isCancel !== true) {
    throw new TriploverError('supplier', 'The airline did not cancel this booking.');
  }
  return {
    isCancel: true,
    uniqueTransId: raw.uniqueTransID?.trim() || input.uniqueTransId,
    netRefund: typeof raw.netRefund === 'number' ? raw.netRefund : null,
    refundPenalty: typeof raw.refundPenalty === 'number' ? raw.refundPenalty : null,
  };
}
