import { z } from 'zod';
import { getDashboardSession } from '@/lib/dashboard/session';
import { canRefreshBookingSupplierDetails } from '@/lib/dashboard/booking-lifecycle';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { supabaseAdmin } from '@/lib/supabase/server';
import { shapontravelsReadBooking } from '@/lib/shapontravels/client';
import { verifyShapontravelsBookingStatus } from '@/lib/shapontravels/booking-status';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const schema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
});

/** Staff-only supplier verification. No local booking or wallet state changes. */
export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canRefreshBookingSupplierDetails(session.role)) {
    return walletFail(403, 'REFRESH_FORBIDDEN', 'Supplier status is restricted to booking staff.');
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return walletFail(400, 'INVALID_REQUEST', 'Check the booking reference.');

  const booking = await readBookingByPublicRef(
    parsed.data.bookingReference, bookingScopeFor(session)
  );
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if (booking.supplier !== 'shapontravels' ||
      booking.supplier_account !== 'shapontravels' || booking.import_source) {
    return walletFail(409, 'SUPPLIER_UNAVAILABLE', 'This is not a Shapontravels API booking.');
  }
  const refs = booking.supplier_refs;
  if (!booking.booking_code_ref || !refs?.uniqueTransId ||
      !refs.itemCodeRef || !refs.priceCodeRef) {
    return walletFail(409, 'SUPPLIER_REFERENCE_MISSING', 'Supplier lookup details are missing.');
  }
  const db = supabaseAdmin();
  if (!db) return walletFail(503, 'BOOKING_STORAGE_FAILED', 'Booking storage is unavailable.');
  const { data: identity, error } = await db.from('flight_bookings')
    .select('supplier_public_ref')
    .eq('id', booking.id)
    .single();
  if (error) return walletFail(503, 'BOOKING_STORAGE_FAILED', 'Booking storage is unavailable.');
  const supplierPublicRef = identity?.supplier_public_ref;
  if (!supplierPublicRef) {
    return walletFail(409, 'SUPPLIER_REFERENCE_MISSING', 'The supplier STR reference is missing.');
  }

  try {
    const read = await shapontravelsReadBooking({ bookingId: booking.booking_code_ref });
    const status = verifyShapontravelsBookingStatus(read, {
      uniqueTransId: refs.uniqueTransId,
      itemCodeRef: refs.itemCodeRef,
      priceCodeRef: refs.priceCodeRef,
      bookingCodeRef: booking.booking_code_ref,
      bookingRefNumber: booking.booking_ref_number,
      pnr: booking.pnr,
      supplierPublicRef,
    });
    if (status.result === 'mismatch' || status.result === 'unverified') {
      console.error('[shapontravels] booking status identity unverified', {
        bookingId: booking.id, result: status.result,
      });
      return walletFail(409, 'SUPPLIER_IDENTITY_UNVERIFIED',
        'Supplier details did not verify against this booking. Staff reconciliation is required.');
    }
    return walletOk(status);
  } catch (error) {
    console.error('[shapontravels] booking status read failed', {
      bookingId: booking.id,
      code: error instanceof Error ? error.message : 'unknown',
    });
    return walletFail(502, 'SUPPLIER_STATUS_UNAVAILABLE',
      'Supplier status is temporarily unavailable. No booking change was made.');
  }
}
