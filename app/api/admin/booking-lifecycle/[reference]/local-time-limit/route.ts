import { z } from 'zod';

import {
  canDecideLocalTimeLimit,
  LOCAL_TIME_LIMIT_MAX_GRANT_MINUTES,
  LOCAL_TIME_LIMIT_MIN_GRANT_MINUTES,
} from '@/lib/booking-lifecycle/local-time-limit';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  decideBookingLocalTimeLimit,
  readBookingLocalTimeLimitContext,
} from '@/lib/db/booking-local-time-limit';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { dispatchBookingStatusEmails } from '@/lib/email/booking-status-delivery';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const approveSchema = z
  .object({
    action: z.literal('approve'),
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    grantedMinutes: z
      .number()
      .int('Minutes must be a whole number.')
      .min(
        LOCAL_TIME_LIMIT_MIN_GRANT_MINUTES,
        `Enter at least ${LOCAL_TIME_LIMIT_MIN_GRANT_MINUTES} minute.`
      )
      .max(
        LOCAL_TIME_LIMIT_MAX_GRANT_MINUTES,
        `Enter no more than ${LOCAL_TIME_LIMIT_MAX_GRANT_MINUTES} minutes.`
      ),
    verificationConfirmed: z.literal(true),
    verificationNote: z.string().trim().min(3).max(1000),
  })
  .strict();

const rejectSchema = z
  .object({
    action: z.literal('reject'),
    requestId: z.string().uuid(),
    expectedVersion: z.number().int().positive(),
    rejectionReason: z.string().trim().min(3).max(1000),
  })
  .strict();

const schema = z.discriminatedUnion('action', [approveSchema, rejectSchema]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  const [session, { reference }] = await Promise.all([
    getDashboardSession(),
    params,
  ]);
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canDecideLocalTimeLimit(session.role)) {
    return walletFail(403, 'TIME_LIMIT_DECISION_FORBIDDEN', 'Decision access is forbidden.');
  }
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) {
    return walletFail(400, 'INVALID_BOOKING_REFERENCE', 'Check the booking reference.');
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
      'INVALID_TIME_LIMIT_DECISION',
      parsed.error.issues[0]?.message ?? 'Check the decision.'
    );
  }
  const limit = await checkActionLimit(
    'bookingTimeLimitDecision',
    `user:${session.clerkId}`
  );
  if (!limit.ok) {
    return walletFail(
      429,
      'TIME_LIMIT_DECISION_RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds),
      { retryAfterSeconds: limit.retryAfterSeconds }
    );
  }
  const booking = await readBookingByPublicRef(reference, { kind: 'all' });
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  const result = await decideBookingLocalTimeLimit({
    bookingId: booking.id,
    requestId: parsed.data.requestId,
    expectedVersion: parsed.data.expectedVersion,
    actorUserId: session.clerkId,
    action: parsed.data.action,
    grantedMinutes:
      parsed.data.action === 'approve'
        ? parsed.data.grantedMinutes
        : undefined,
    reason:
      parsed.data.action === 'approve'
        ? parsed.data.verificationNote
        : parsed.data.rejectionReason,
  });
  await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: `flight.booking.local_time_limit.${parsed.data.action}`,
    targetType: 'flight_booking',
    targetId: booking.id,
    outcome: result.ok ? 'succeeded' : 'failed',
    metadata: {
      requestId: parsed.data.requestId,
      grantedMinutes:
        parsed.data.action === 'approve' ? parsed.data.grantedMinutes : null,
      supplierPortalVerified:
        parsed.data.action === 'approve' ? parsed.data.verificationConfirmed : false,
      failureCode: result.ok ? null : result.code ?? 'DECISION_FAILED',
      walletMutation: false,
    },
  });
  if (!result.ok) {
    const status = result.code === 'DECISION_FORBIDDEN' ? 403 : 409;
    return walletFail(
      status,
      result.code ?? 'TIME_LIMIT_DECISION_FAILED',
      result.code === 'SUPPLIER_DEADLINE_SUFFICIENT'
        ? 'The supplier now has at least 15 minutes remaining; the local request was closed.'
        : 'The time-limit decision was not accepted. Refresh and verify the booking again.'
    );
  }
  await dispatchBookingStatusEmails(booking.id);
  return walletOk({
    ...result,
    context: await readBookingLocalTimeLimitContext(booking.id),
  });
}
