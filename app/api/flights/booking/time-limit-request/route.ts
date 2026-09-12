import { z } from 'zod';

import { canRequestLocalTimeLimit } from '@/lib/booking-lifecycle/local-time-limit';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  readBookingLocalTimeLimitContext,
  requestBookingLocalTimeLimit,
} from '@/lib/db/booking-local-time-limit';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z
  .object({
    bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
    requestId: z.string().uuid(),
  })
  .strict();

const ERROR_MESSAGE: Record<string, string> = {
  REQUEST_FORBIDDEN: 'You cannot request a local time limit for this booking.',
  BOOKING_NOT_ELIGIBLE: 'This booking is not eligible for a local time limit.',
  BOOKING_UNCONFIRMED: 'The airline PNR must be verified first.',
  BOOKING_RECONCILIATION_REQUIRED:
    'This booking is already under supplier reconciliation.',
  LOCAL_TIME_LIMIT_ACTIVE: 'A local time limit is already active.',
  SUPPLIER_DEADLINE_SUFFICIENT:
    'The supplier deadline has at least 15 minutes remaining.',
  LOCAL_TIME_LIMIT_REQUEST_WINDOW_EXPIRED:
    'The supplier deadline expired at least 3 hours ago. A new time-limit request is no longer available.',
};

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canRequestLocalTimeLimit(session.role)) {
    return walletFail(403, 'TIME_LIMIT_REQUEST_FORBIDDEN', 'Request access is forbidden.');
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_TIME_LIMIT_REQUEST',
      'Check the booking reference. Minutes cannot be requested by the user.'
    );
  }
  const limit = await checkActionLimit(
    'bookingTimeLimitRequest',
    `user:${session.clerkId}`
  );
  if (!limit.ok) {
    return walletFail(
      429,
      'TIME_LIMIT_REQUEST_RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds),
      { retryAfterSeconds: limit.retryAfterSeconds }
    );
  }
  const booking = await readBookingByPublicRef(
    parsed.data.bookingReference,
    bookingScopeFor(session)
  );
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if (booking.import_source === 'MANUAL') {
    return walletFail(
      409,
      'MANUAL_BOOKING_NO_SUPPLIER_ACTION',
      'Manual bookings do not support supplier time-limit actions.'
    );
  }
  const result = await requestBookingLocalTimeLimit({
    bookingId: booking.id,
    session,
    requestKey: parsed.data.requestId,
  });
  await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'flight.booking.local_time_limit.request',
    targetType: 'flight_booking',
    targetId: booking.id,
    outcome: result.ok ? 'succeeded' : 'failed',
    metadata: {
      requestId: result.requestId ?? null,
      replay: result.replay ?? false,
      failureCode: result.ok ? null : result.code ?? 'REQUEST_FAILED',
      requestedMinutes: false,
      walletMutation: false,
    },
  });
  if (!result.ok) {
    const code = result.code ?? 'TIME_LIMIT_REQUEST_FAILED';
    return walletFail(
      code === 'LOCAL_TIME_LIMIT_REQUEST_WINDOW_EXPIRED' ? 410 : 409,
      code,
      ERROR_MESSAGE[code] ?? 'The request was not accepted.'
    );
  }
  return walletOk({
    ...result,
    context: await readBookingLocalTimeLimitContext(booking.id),
  });
}
