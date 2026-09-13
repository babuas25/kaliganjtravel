import { NextResponse } from 'next/server';
import { z } from 'zod';
import { BOOKING_READ_ERROR_CODE, BOOKING_READ_ERROR_MESSAGE } from '@/lib/db/booking-read-error';

import { getDashboardSession } from '@/lib/dashboard/session';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { readBookingAttempt } from '@/lib/db/booking-attempts';
import {
  publicBookingWithHeaderContact,
  readBookingByAttemptId,
} from '@/lib/db/flight-bookings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z.object({
  bookingId: z.string().uuid(),
  accessToken: z.string().min(32).max(128),
});

function fail(status: number, errorCode: string, errorMessage: string) {
  return NextResponse.json(
    { success: false, error: { errorCode, errorMessage } },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * Recovers the result after the booking POST's connection was lost. This never
 * calls the supplier, so polling it cannot create a duplicate booking.
 */
export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return fail(400, 'INVALID_BODY', 'Expected a JSON body.');
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return fail(400, 'INVALID_BOOKING', 'This booking link is invalid.');
  }

  let session: Awaited<ReturnType<typeof getDashboardSession>> = null;
  try {
    session = await getDashboardSession();
  } catch (error) {
    console.error('[booking-status] session lookup failed:', error);
  }
  if (!session) {
    return fail(401, 'SIGN_IN_REQUIRED', 'Please sign in to view this booking.');
  }

  let attempt: Awaited<ReturnType<typeof readBookingAttempt>>;
  try {
    attempt = await readBookingAttempt(parsed.data.bookingId, parsed.data.accessToken);
  } catch {
    return fail(503, BOOKING_READ_ERROR_CODE, BOOKING_READ_ERROR_MESSAGE);
  }
  if (
    !attempt ||
    (attempt.user_id !== session.clerkId &&
      attempt.created_by_user_id !== session.clerkId)
  ) {
    return fail(404, 'BOOKING_NOT_FOUND', 'This booking is unavailable.');
  }

  if (attempt.state === 'succeeded') {
    let booking: Awaited<ReturnType<typeof readBookingByAttemptId>>;
    try {
      booking = await readBookingByAttemptId(attempt.id, bookingScopeFor(session), true);
    } catch {
      return fail(503, BOOKING_READ_ERROR_CODE, BOOKING_READ_ERROR_MESSAGE);
    }
    if (!booking) {
      return fail(
        404,
        'BOOKING_NOT_FOUND',
        'This booking is unavailable.'
      );
    }
    return NextResponse.json(
      {
        success: true,
        phase: 'booking-created',
        data: await publicBookingWithHeaderContact(booking),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (attempt.state === 'submitting') {
    return NextResponse.json(
      { success: true, phase: 'processing' },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  if (attempt.state === 'failed') {
    if (attempt.error_code === 'SUPPLIER_DUPLICATE_BOOKING') {
      return fail(
        409,
        'SUPPLIER_DUPLICATE_BOOKING',
        'The airline rejected this booking because the same passenger already has a booking for this flight. Please check My Bookings or contact support. Do not submit the same booking again.'
      );
    }
    return fail(502, 'BOOKING_FAILED', 'The airline declined the booking. Search and verify the fare again.');
  }
  if (attempt.state === 'unknown') {
    return fail(503, 'BOOKING_OUTCOME_UNKNOWN', 'Booking status: Unconfirmed. The airline has not confirmed this booking. Do not submit again; contact support.');
  }

  return NextResponse.json(
    { success: true, phase: 'ready' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
