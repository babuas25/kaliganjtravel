import { z } from 'zod';

import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { getDashboardSession } from '@/lib/dashboard/session';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { refundBooking } from '@/lib/db/wallet';
import { checkActionLimit } from '@/lib/rate-limit';
import { walletFail, walletOperationResponse } from '@/lib/wallet/http';
import { majorToMinor } from '@/lib/wallet/money';
import { canRefundBooking } from '@/lib/wallet/permissions';

const schema = z.object({
  bookingReference: z.string().trim().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
  amount: z.coerce.number().positive().max(100_000_000),
  requestId: z.string().uuid(),
  remarks: z.string().trim().min(3).max(1000),
});

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canRefundBooking(session.role)) {
    return walletFail(
      403,
      'REFUND_FORBIDDEN',
      'Accounts or administrator refund access is required.'
    );
  }
  const limit = await checkActionLimit('walletManage', `user:${session.clerkId}`);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', 'Too many wallet actions.');
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return walletFail(400, 'INVALID_REFUND', parsed.error.issues[0]?.message ?? 'Invalid refund.');
  const booking = await readBookingByPublicRef(
    parsed.data.bookingReference,
    bookingScopeFor(session)
  );
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  const hasIssuedTickets =
    Boolean(booking.issued_at) ||
    (Array.isArray(booking.ticket_numbers) && booking.ticket_numbers.length > 0);
  if (hasIssuedTickets) {
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'wallet.booking.refund',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'denied',
      metadata: {
        failureCode: 'TICKET_MANAGEMENT_REQUIRED',
        attemptedAmountMinor: majorToMinor(parsed.data.amount),
      },
    });
    return walletFail(
      409,
      'TICKET_MANAGEMENT_REQUIRED',
      'Issued tickets must be refunded through an approved Ticket Management request.'
    );
  }
  const result = await refundBooking(
    booking.id,
    majorToMinor(parsed.data.amount),
    session,
    parsed.data.requestId,
    parsed.data.remarks
  );
  await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'wallet.booking.refund',
    targetType: 'flight_booking',
    targetId: booking.id,
    outcome: result.ok ? 'succeeded' : 'failed',
    metadata: { code: result.code ?? null, amountMinor: majorToMinor(parsed.data.amount) },
  });
  return walletOperationResponse(result);
}
