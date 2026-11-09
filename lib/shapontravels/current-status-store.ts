import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';
import type { BookingRow } from '@/lib/db/flight-bookings';
import type { ShapontravelsBookingStatus, ShapontravelsCurrentStatus, ShapontravelsExpectedBooking } from './booking-status';
import type { BookingStatus } from '@/lib/flights/booking-status';
import { parseShapontravelsCurrentStatusProjection } from './current-status-projection';

export type ShapontravelsStatusStorage = 'saved' | 'unavailable' | 'not_recorded';

/** Keep an already verified write response without another supplier request. */
export async function recordShapontravelsWriteStatus(
  booking: BookingRow,
  currentStatus: ShapontravelsCurrentStatus,
  observedAt: string,
  options: { supplierPublicRef?: string | null; issueResponse?: true } = {},
): Promise<void> {
  const refs = booking.supplier_refs;
  if (!booking.booking_code_ref || !refs?.uniqueTransId || !refs.itemCodeRef || !refs.priceCodeRef) return;
  try {
    let { supplierPublicRef } = options;
    if (!supplierPublicRef) {
      const stored = await supabaseAdmin()?.from('flight_bookings')
        .select('supplier_public_ref').eq('id', booking.id).maybeSingle();
      supplierPublicRef = stored?.data?.supplier_public_ref;
    }
    if (!supplierPublicRef) return;
    await recordShapontravelsCurrentStatus({
      bookingId: booking.id,
      // Preserve PostgreSQL microseconds when clamping a pre-creation Book.
      requestStartedAt: Date.parse(booking.created_at) >= Date.parse(observedAt) ? booking.created_at : observedAt,
      issueResponse: options.issueResponse,
      expected: { ...refs, bookingCodeRef: booking.booking_code_ref,
        bookingRefNumber: booking.booking_ref_number, pnr: booking.pnr, supplierPublicRef },
      status: {
        result: 'verified', currentStatus, currentStatusState: 'available',
        originalBookingStatus: booking.booking_status, supplierStatus: null, supplierPublicRef,
        pnr: booking.pnr, ticketingTimeLimit: null,
        ticketedEvidencePresent: currentStatus.status === 'confirmed', checkedAt: observedAt,
      },
    });
  } catch {
    console.error('[shapontravels] write status storage unavailable', { bookingId: booking.id });
  }
}

/** Save receipt-bound metadata and, for an eligible refresh, its explicit display locator. */
export async function recordShapontravelsCurrentStatus(input: {
  bookingId: string;
  requestStartedAt: string;
  issueResponse?: true;
  airlineLocatorRefresh?: { bookingUpdatedAt: string; locators: string[] };
  expected: ShapontravelsExpectedBooking;
  status: ShapontravelsBookingStatus;
}): Promise<{
  projectionUpdated: boolean;
  currentStatusStorage: ShapontravelsStatusStorage;
  displayStatus?: BookingStatus;
  displayReviewRequired?: boolean;
  airlinePnrsUpdated?: boolean;
}> {
  const { status, expected } = input;
  if (status.result !== 'verified' || status.currentStatusState !== 'available' ||
      !status.currentStatus || !expected.supplierPublicRef) {
    return { projectionUpdated: false, currentStatusStorage: 'not_recorded' };
  }
  const db = supabaseAdmin();
  if (!db) return { projectionUpdated: false, currentStatusStorage: 'unavailable' };
  const { canCancel, canIssue, ...currentStatus } = status.currentStatus;
  try {
    const { data, error } = await db.rpc('record_shapon_booking_current_status_v1', {
      p_booking_id: input.bookingId,
      p_request_started_at: input.requestStartedAt,
      p_supplier_public_ref: expected.supplierPublicRef,
      p_receipt_identity: { ...expected, originalBookingStatus: status.originalBookingStatus,
        ...(input.issueResponse ? { issueResponse: true } : {}),
        ...(input.airlineLocatorRefresh ? { airlineLocatorRefresh: input.airlineLocatorRefresh } : {}),
        ...(typeof canIssue === 'boolean' ? { canIssue } : {}),
        ...(typeof canCancel === 'boolean' ? { canCancel } : {}) },
      p_current_status: currentStatus,
    });
    if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
      // A missing forward migration must not break the existing supplier check.
      console.error('[shapontravels] current status storage unavailable', {
        bookingId: input.bookingId, code: error?.code ?? 'INVALID_RESPONSE',
      });
      return { projectionUpdated: false, currentStatusStorage: 'unavailable' };
    }
    const result = data as {
      recorded?: unknown; projectionUpdated?: unknown; currentStatus?: unknown; airlinePnrsUpdated?: unknown;
    };
    const projection = result.recorded === true
      ? parseShapontravelsCurrentStatusProjection(result.currentStatus) : null;
    return {
      projectionUpdated: result.recorded === true && result.projectionUpdated === true,
      currentStatusStorage: result.recorded === true ? 'saved' : 'not_recorded',
      ...(input.airlineLocatorRefresh ? { airlinePnrsUpdated: result.recorded === true && result.airlinePnrsUpdated === true } : {}),
      ...(projection ? {
        displayStatus: projection.currentStatus.status,
        displayReviewRequired: projection.reviewRequired,
      } : {}),
    };
  } catch {
    return { projectionUpdated: false, currentStatusStorage: 'unavailable' };
  }
}
