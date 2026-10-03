import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';
import type { ShapontravelsBookingStatus, ShapontravelsExpectedBooking } from './booking-status';
import type { BookingStatus } from '@/lib/flights/booking-status';
import { parseShapontravelsCurrentStatusProjection } from './current-status-projection';

export type ShapontravelsStatusStorage = 'saved' | 'unavailable' | 'not_recorded';

/** Save only receipt-bound metadata; this never changes a booking or wallet row. */
export async function recordShapontravelsCurrentStatus(input: {
  bookingId: string;
  requestStartedAt: string;
  expected: ShapontravelsExpectedBooking;
  status: ShapontravelsBookingStatus;
}): Promise<{
  projectionUpdated: boolean;
  currentStatusStorage: ShapontravelsStatusStorage;
  displayStatus?: BookingStatus;
  displayReviewRequired?: boolean;
}> {
  const { status, expected } = input;
  if (status.result !== 'verified' || status.currentStatusState !== 'available' ||
      !status.currentStatus || !expected.supplierPublicRef) {
    return { projectionUpdated: false, currentStatusStorage: 'not_recorded' };
  }
  const db = supabaseAdmin();
  if (!db) return { projectionUpdated: false, currentStatusStorage: 'unavailable' };
  try {
    const { data, error } = await db.rpc('record_shapon_booking_current_status_v1', {
      p_booking_id: input.bookingId,
      p_request_started_at: input.requestStartedAt,
      p_supplier_public_ref: expected.supplierPublicRef,
      p_receipt_identity: { ...expected, originalBookingStatus: status.originalBookingStatus },
      p_current_status: status.currentStatus,
    });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
      // A missing forward migration must not break the existing supplier check.
      console.error('[shapontravels] current status storage unavailable', {
        bookingId: input.bookingId, code: error?.code ?? 'INVALID_RESPONSE',
      });
      return { projectionUpdated: false, currentStatusStorage: 'unavailable' };
    }
    const result = data as { recorded?: unknown; projectionUpdated?: unknown; currentStatus?: unknown };
    const projection = result.recorded === true
      ? parseShapontravelsCurrentStatusProjection(result.currentStatus) : null;
    return {
      projectionUpdated: result.recorded === true && result.projectionUpdated === true,
      currentStatusStorage: result.recorded === true ? 'saved' : 'not_recorded',
      ...(projection ? {
        displayStatus: projection.effectiveStatus,
        displayReviewRequired: projection.reviewRequired,
      } : {}),
    };
  } catch {
    return { projectionUpdated: false, currentStatusStorage: 'unavailable' };
  }
}
