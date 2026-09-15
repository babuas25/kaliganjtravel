import { z } from 'zod';

import { storedTicketReferences } from '@/lib/booking-lifecycle/ticketing-flow';
import { canRefreshBookingTicketingTime } from '@/lib/dashboard/booking-lifecycle';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { getDashboardSession } from '@/lib/dashboard/session';
import { saveBookingTicketingTime } from '@/lib/db/booking-ticketing-time';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { checkActionLimit } from '@/lib/rate-limit';
import { isTriploverSupplier } from '@/lib/triplover/config';
import { readPnr } from '@/lib/triplover/pnr';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const schema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
}).strict();

/** Explicit time-limit switch action. The automatic booking/issue flow never calls it. */
export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canRefreshBookingTicketingTime(session.role)) {
    return walletFail(403, 'REFRESH_FORBIDDEN', 'You cannot refresh supplier details.');
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return walletFail(400, 'INVALID_REFRESH_REQUEST', 'Check the booking reference.');
  }
  const booking = await readBookingByPublicRef(
    parsed.data.bookingReference, bookingScopeFor(session)
  );
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if (booking.supplier !== 'triplover' || booking.import_source === 'MANUAL') {
    return walletFail(409, 'EXTERNAL_SUPPLIER_BOOKING', 'This booking does not support a PNR refresh.');
  }
  if (!isTriploverSupplier(booking.supplier_account)) {
    return walletFail(409, 'SUPPLIER_ACCOUNT_UNAVAILABLE', 'The supplier account is unavailable.');
  }
  const refs = storedTicketReferences(booking);
  if (!refs) {
    return walletFail(409, 'SUPPLIER_REFERENCE_MISSING', 'The booking is missing supplier references.');
  }
  const limit = await checkActionLimit('refreshTicketingTime', booking.id);
  if (!limit.ok) {
    return walletFail(429, 'REFRESH_RATE_LIMITED', 'Please wait a moment before refreshing again.');
  }

  try {
    const details = await readPnr({
      ...refs,
      supplier: booking.supplier_account,
      carrierCode: booking.itinerary?.carrierCode,
      deadlineNotBefore: booking.submission_started_at ?? booking.created_at,
      timeoutMs: 30_000,
    });
    // Ignore status, airline locators, tickets and every other returned field.
    // Identity is checked solely to avoid attaching another booking's TTL.
    if (details.pnr !== refs.pnr ||
        details.supplierEchoedUniqueTransIds.length === 0 ||
        details.supplierEchoedUniqueTransIds.some(value => value !== refs.uniqueTransId) ||
        details.reconciliationEvidenceV2.bookingIdentity.identityConflicts.length > 0) {
      return walletFail(502, 'SUPPLIER_IDENTITY_MISMATCH', 'The supplier response did not match this booking.');
    }
    if (!details.rawLastTicketTime || !details.ticketingDeadlineAt) {
      return walletOk({
        updated: false,
        ticketingDeadlineAt: booking.ticketing_deadline_at,
        lastTicketingTime: booking.supplier_ticketing_time_limit ?? booking.ticketing_time_limit,
      });
    }
    const saved = await saveBookingTicketingTime(booking, {
      rawLastTicketTime: details.rawLastTicketTime,
      ticketingDeadlineAt: details.ticketingDeadlineAt,
    });
    if (!saved) {
      return walletFail(409, 'BOOKING_CHANGED', 'The booking changed during the refresh. Refresh the page and try again.');
    }
    return walletOk({ updated: true, ...saved });
  } catch {
    return walletFail(502, 'TICKETING_TIME_REFRESH_FAILED', 'The ticketing time could not be refreshed. Please try again.');
  }
}
