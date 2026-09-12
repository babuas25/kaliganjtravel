import { z } from 'zod';

import { canManageBookingUserVisibility } from '@/lib/booking-visibility';
import { getDashboardSession } from '@/lib/dashboard/session';
import { setBookingUserVisibility } from '@/lib/db/booking-visibility';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const schema = z
  .object({
    action: z.enum(['hide', 'unhide']),
    requestId: z.string().uuid(),
    reason: z.string().trim().min(3).max(1000),
  })
  .strict();

const MESSAGES: Record<string, string> = {
  NOT_B2B_BOOKING: 'Only B2B agency bookings can be hidden from users.',
  STATUS_NOT_ELIGIBLE:
    'Only On Hold, Cancelled, or Expired bookings can be hidden.',
  WALLET_FOOTPRINT_FOUND:
    'This booking has wallet history and cannot be hidden.',
  FINANCIAL_SUMMARY_NOT_CLEAN:
    'This booking has financial markers and cannot be hidden.',
  ALREADY_HIDDEN: 'This booking is already hidden from the user.',
  ALREADY_VISIBLE: 'This booking is already visible to the user.',
  REQUEST_KEY_REUSED: 'This request identity was already used for another action.',
  NOTIFICATION_DELIVERY_IN_PROGRESS:
    'A booking email is currently being delivered. Wait a moment and try Hide again.',
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  const [session, { reference }] = await Promise.all([
    getDashboardSession(),
    params,
  ]);
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canManageBookingUserVisibility(session.role)) {
    return walletFail(
      403,
      'VISIBILITY_FORBIDDEN',
      'Booking visibility access is forbidden.'
    );
  }
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) {
    return walletFail(
      400,
      'INVALID_BOOKING_REFERENCE',
      'Check the booking reference.'
    );
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
      'INVALID_VISIBILITY_REQUEST',
      parsed.error.issues[0]?.message ?? 'Check the visibility request.'
    );
  }

  const limit = await checkActionLimit(
    'manageBookingVisibility',
    `user:${session.clerkId}`
  );
  if (!limit.ok) {
    return walletFail(
      429,
      'VISIBILITY_RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds),
      { retryAfterSeconds: limit.retryAfterSeconds }
    );
  }

  const result = await setBookingUserVisibility({
    bookingReference: reference,
    action: parsed.data.action,
    reason: parsed.data.reason,
    actorUserId: session.clerkId,
    requestKey: parsed.data.requestId,
  });
  if (!result.ok) {
    const code = result.code ?? 'VISIBILITY_CHANGE_FAILED';
    const status =
      code === 'BOOKING_NOT_FOUND'
        ? 404
        : code === 'VISIBILITY_FORBIDDEN'
          ? 403
          : code === 'INVALID_VISIBILITY_REQUEST'
            ? 400
            : code.includes('STORAGE') || code === 'VISIBILITY_INVALID_RESULT'
              ? 503
              : 409;
    return walletFail(
      status,
      code,
      MESSAGES[code] ??
        'The visibility change was not accepted. Refresh and verify the booking.'
    );
  }

  return walletOk(result);
}
