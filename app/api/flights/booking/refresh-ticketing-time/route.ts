import { z } from 'zod';

import { storedTicketReferences } from '@/lib/booking-lifecycle/ticketing-flow';
import { canRefreshBookingTicketingTime } from '@/lib/dashboard/booking-lifecycle';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { getDashboardSession } from '@/lib/dashboard/session';
import { saveBookingTicketingTime, saveShapontravelsTicketingTime } from '@/lib/db/booking-ticketing-time';
import { readBookingByPublicRef, type BookingRow } from '@/lib/db/flight-bookings';
import { checkActionLimit } from '@/lib/rate-limit';
import { isTriploverSupplier } from '@/lib/triplover/config';
import { readPnr } from '@/lib/triplover/pnr';
import { supabaseAdmin } from '@/lib/supabase/server';
import { shapontravelsReadBooking, shapontravelsRefreshTicketingDeadline } from '@/lib/shapontravels/client';
import { isCanonicalDeadlineTime } from '@/lib/shapontravels/deadline-time';
import { shapontravelsTicketingTime } from '@/lib/shapontravels/ticketing-time';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const schema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
}).strict();

const supplierDeadlineSchema = z.object({
  bookingId: z.string(),
  reference: z.string(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  deadlineAt: z.string().refine(value => isCanonicalDeadlineTime(value, '+06:00')).nullable(),
  available: z.boolean(),
  outcome: z.enum(['verified', 'no_verified_update', 'superseded']),
}).refine(value => value.available === (value.deadlineAt !== null));

function rateLimited(retryAfter: string | null) {
  const response = walletFail(429, 'REFRESH_RATE_LIMITED', 'Please wait a moment before refreshing again.');
  if (retryAfter) response.headers.set('Retry-After', retryAfter);
  return response;
}

async function refreshShapontravelsTicketingTime(booking: BookingRow, scope: ReturnType<typeof bookingScopeFor>) {
  const refs = storedTicketReferences(booking);
  if (!refs) return walletFail(409, 'SUPPLIER_REFERENCE_MISSING', 'The booking is missing supplier references.');
  const live = process.env.SHAPONTRAVELS_DEADLINE_REFRESH_ENABLED === 'true';
  if (live && (booking.status !== 'on-hold' || booking.operation_kind || booking.active_operation_id ||
      booking.booking_origin || booking.legacy_operational || booking.direct_ticketing || booking.issued_at ||
      booking.ticket_code_ref || (Array.isArray(booking.ticket_numbers) && booking.ticket_numbers.length))) {
    return walletFail(409, 'TICKETING_TIME_REFRESH_UNAVAILABLE', 'This booking is not eligible for a supplier time-limit refresh.');
  }
  const limit = await checkActionLimit('refreshTicketingTime', booking.id);
  if (!limit.ok) return rateLimited(String(limit.retryAfterSeconds));
  const db = supabaseAdmin();
  if (!db) return walletFail(503, 'BOOKING_STORAGE_FAILED', 'Booking storage is unavailable.');
  const { data: identity, error } = await db.from('flight_bookings')
    .select('supplier_public_ref').eq('id', booking.id).single();
  if (error) return walletFail(503, 'BOOKING_STORAGE_FAILED', 'Booking storage is unavailable.');
  const supplierPublicRef = identity?.supplier_public_ref;
  if (typeof supplierPublicRef !== 'string' || !/^STR[A-Z0-9]{6,32}$/.test(supplierPublicRef)) {
    return walletFail(409, 'SUPPLIER_REFERENCE_MISSING', 'The supplier STR reference is missing.');
  }

  try {
    let deadlineAt: string | null;
    let revision: number | null = null;
    let message: string | null = null;
    if (live) {
      const read = await shapontravelsRefreshTicketingDeadline(refs.bookingCodeRef);
      if (read.httpStatus === 429) return rateLimited(read.retryAfter);
      if ([403, 404, 409, 503].includes(read.httpStatus)) {
        return walletFail(read.httpStatus, 'TICKETING_TIME_REFRESH_UNAVAILABLE', 'The supplier time-limit refresh is unavailable for this booking.');
      }
      if (read.httpStatus !== 200) {
        return walletFail(read.httpStatus === 504 ? 504 : 502, 'TICKETING_TIME_REFRESH_FAILED',
          'The supplier time limit could not be refreshed. Please try again.');
      }
      const result = supplierDeadlineSchema.safeParse(read.body);
      if (!result.success || result.data.bookingId.toLowerCase() !== refs.bookingCodeRef.toLowerCase() ||
          result.data.reference !== supplierPublicRef) {
        return walletFail(502, 'TICKETING_TIME_UNVERIFIED', 'The supplier time limit could not be verified. Please contact support.');
      }
      const { outcome } = result.data;
      deadlineAt = result.data.deadlineAt;
      revision = result.data.revision;
      if (outcome === 'superseded') message = 'A newer check took precedence. The saved time limit is shown.';
      if (outcome === 'no_verified_update') message = 'The supplier did not return a new verified time limit.';
      if (revision === null && (outcome !== 'verified' || deadlineAt === null)) {
        const current = await readBookingByPublicRef(booking.public_ref, scope);
        if (current?.id !== booking.id) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
        return walletOk({ updated: false, ticketingDeadlineAt: current.ticketing_deadline_at,
          lastTicketingTime: current.supplier_ticketing_time_limit ?? current.ticketing_time_limit,
          message: message ?? 'The supplier did not return a verified time limit.' });
      }
    } else {
      const read = await shapontravelsReadBooking({ bookingId: refs.bookingCodeRef });
      const deadline = shapontravelsTicketingTime(read, { ...refs, supplierPublicRef });
      if (!deadline) return walletFail(502, 'TICKETING_TIME_UNVERIFIED', 'The saved ticketing time could not be verified. Please contact support.');
      deadlineAt = deadline.ticketingDeadlineAt;
    }
    const saved = await saveShapontravelsTicketingTime(booking, supplierPublicRef, deadlineAt, revision);
    if (!saved) return walletFail(409, 'BOOKING_CHANGED', 'The booking changed during the refresh. Refresh the page and try again.');
    return walletOk({ ...saved, message: message ?? (saved.ticketingDeadlineAt ? null
      : 'No ticketing time is saved by the supplier yet. Contact support to refresh the supplier time limit.') });
  } catch {
    return walletFail(502, 'TICKETING_TIME_REFRESH_FAILED', 'The ticketing time could not be refreshed. Please try again.');
  }
}

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
  const scope = bookingScopeFor(session);
  const booking = await readBookingByPublicRef(parsed.data.bookingReference, scope);
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if (booking.supplier === 'shapontravels' && booking.supplier_account === 'shapontravels' && !booking.import_source) {
    return refreshShapontravelsTicketingTime(booking, scope);
  }
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
