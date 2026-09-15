import { z } from 'zod';
import { usesStoredBookingReferences } from '@/lib/booking-lifecycle/ticketing-flow';

import { getDashboardSession } from '@/lib/dashboard/session';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { readBookingByPublicRef, syncPnrDetails } from '@/lib/db/flight-bookings';
import { claimBookingDeadlineRead, finishBookingDeadlineRead } from '@/lib/db/booking-deadline-read-budget';
import { isTriploverSupplier } from '@/lib/triplover/config';
import { pnrLookupLocators, readPnr } from '@/lib/triplover/pnr';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const schema = z.object({ bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/) });

/** Safe, scoped deadline enrichment; never exposes supplier evidence or refs. */
export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (session.role === 'staff_media') return walletFail(403, 'REFRESH_FORBIDDEN', 'Booking access is unavailable.');
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return walletFail(400, 'INVALID_REFRESH_REQUEST', 'Check the booking reference.');

  const booking = await readBookingByPublicRef(parsed.data.bookingReference, bookingScopeFor(session));
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  // Also terminates requests from browser tabs opened before the rollout.
  if (usesStoredBookingReferences(booking) || booking.ticketing_deadline_at) {
    return walletOk({ ticketingDeadlineAt: booking.ticketing_deadline_at, complete: true });
  }
  if (booking.supplier !== 'triplover' || booking.import_source === 'MANUAL' ||
      !['on-hold', 'pending'].includes(booking.status) || booking.operation_kind) {
    return walletOk({ ticketingDeadlineAt: null, complete: true });
  }
  if (!isTriploverSupplier(booking.supplier_account)) {
    return walletFail(409, 'SUPPLIER_ACCOUNT_UNAVAILABLE', 'Supplier deadline refresh is unavailable.');
  }
  const refs = booking.supplier_refs;
  const locators = pnrLookupLocators({ pnr: booking.pnr, bookingRefNumber: booking.booking_ref_number });
  if (!locators || !booking.booking_code_ref || !refs?.uniqueTransId || !refs.itemCodeRef || !refs.priceCodeRef) {
    return walletFail(409, 'SUPPLIER_REFERENCE_MISSING', 'Supplier deadline refresh is unavailable.');
  }
  let claimToken: string | undefined;
  try {
    const claim = await claimBookingDeadlineRead(booking.id);
    if (!claim.claimed) return walletOk({ ticketingDeadlineAt: null, complete: claim.complete });
    claimToken = claim.claimToken;
    const details = await readPnr({
      ...refs,
      ...locators,
      supplier: booking.supplier_account,
      bookingCodeRef: booking.booking_code_ref,
      carrierCode: booking.itinerary?.carrierCode,
      deadlineNotBefore: booking.submission_started_at ?? booking.created_at,
      timeoutMs: 15_000,
    });
    if (!details.ticketingDeadlineAt) return walletOk({ ticketingDeadlineAt: null, complete: false });
    const refreshed = await syncPnrDetails(booking.id, details, session, 'ordinary_sync');
    return walletOk({
      ticketingDeadlineAt: refreshed.ticketing_deadline_at,
      complete: Boolean(refreshed.ticketing_deadline_at) || !['on-hold', 'pending'].includes(refreshed.status),
    });
  } catch {
    return walletFail(502, 'DEADLINE_REFRESH_FAILED', 'The supplier time limit is not available yet.');
  } finally {
    if (claimToken) await finishBookingDeadlineRead(booking.id, claimToken);
  }
}
