import { z } from 'zod';

import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { getDashboardSession, type DashboardSession } from '@/lib/dashboard/session';
import {
  BookingManualSmsError,
  BOOKING_MANUAL_SMS_MAX_SENDS,
  claimBookingManualSmsSend,
  failBookingManualSmsSend,
  markBookingManualSmsSent,
  readBookingManualSmsStatus,
} from '@/lib/db/booking-manual-sms';
import { readBookingByPublicRef, type BookingRow } from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent, securitySubjectHash } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { bookingIssuedSmsMessage } from '@/lib/sms/booking-issued-message';
import { bookingIssuedSmsSnapshotFromBooking } from '@/lib/sms/booking-issued-snapshot';
import { sendBulkSmsBdText } from '@/lib/sms/bulksmsbd';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const referenceSchema = z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/);
const sendSchema = z.object({
  bookingReference: referenceSchema,
  requestId: z.string().uuid(),
  recipientNumber: z.string().trim().min(8).max(30),
  message: z.string().trim().min(1).max(480),
}).strict();

function canShareSms(session: DashboardSession): boolean {
  return (
    session.role === 'superadmin' ||
    session.role === 'admin' ||
    session.role === 'staff_support' ||
    ((session.role === 'b2b' || session.role === 'b2b_sub') && Boolean(session.agencyCode))
  );
}

async function authorisedBooking(
  session: DashboardSession,
  bookingReference: string
): Promise<BookingRow | Response> {
  if (!canShareSms(session)) {
    return walletFail(403, 'BOOKING_SMS_FORBIDDEN', 'You are not allowed to share bookings by SMS.');
  }
  const booking = await readBookingByPublicRef(
    bookingReference,
    bookingScopeFor(session)
  );
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  const agencyUser = session.role === 'b2b' || session.role === 'b2b_sub';
  if (
    booking.audience !== 'agency' ||
    !booking.agency_code ||
    (agencyUser && booking.agency_code !== session.agencyCode) ||
    booking.hidden_from_user
  ) {
    return walletFail(403, 'BOOKING_SMS_FORBIDDEN', 'SMS sharing is unavailable for this booking.');
  }
  if ((booking.lifecycle_status ?? booking.status) !== 'confirmed') {
    return walletFail(409, 'BOOKING_NOT_CONFIRMED', 'Only a confirmed booking can be sent by SMS.');
  }
  return booking;
}

function previewData(
  booking: BookingRow,
  status: Awaited<ReturnType<typeof readBookingManualSmsStatus>>
) {
  const snapshot = bookingIssuedSmsSnapshotFromBooking(booking);
  return {
    message: bookingIssuedSmsMessage(snapshot),
    recipientNumber: status.recipientNumber,
    senderId: process.env.BULKSMSBD_SENDER_ID?.trim() || 'Not configured',
    sentCount: status.sentCount,
    maxSends: BOOKING_MANUAL_SMS_MAX_SENDS,
    remainingSends: status.remainingSends,
    canSend: status.remainingSends > 0,
  };
}

function smsErrorResponse(error: unknown): Response {
  if (error instanceof BookingManualSmsError) {
    const status =
      error.code === 'BOOKING_SMS_LIMIT_REACHED' ||
      error.code === 'BOOKING_SMS_RECIPIENT_ALREADY_USED'
        ? 409
        : error.code === 'BOOKING_SMS_RECIPIENT_UNAVAILABLE' ||
            error.code === 'BOOKING_SMS_MESSAGE_INVALID'
          ? 400
          : 503;
    return walletFail(status, error.code, error.message);
  }
  if (error instanceof Error && error.message.includes('(code 1032)')) {
    return walletFail(
      503,
      'BOOKING_SMS_IP_NOT_WHITELISTED',
      'BulkSMSBD has not whitelisted this server IP. Please contact the SMS provider.'
    );
  }
  if (error instanceof Error && error.message.includes('(code 1012)')) {
    return walletFail(
      503,
      'BOOKING_SMS_MASKING_LANGUAGE_REJECTED',
      'BulkSMSBD rejected this masking message language. Please contact the SMS provider.'
    );
  }
  console.error('[sms] booking share failed:', error);
  return walletFail(
    503,
    'BOOKING_SMS_DELIVERY_FAILED',
    'The confirmation SMS could not be delivered. Please try again.'
  );
}

export async function GET(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  const parsed = referenceSchema.safeParse(new URL(request.url).searchParams.get('bookingReference'));
  if (!parsed.success) {
    return walletFail(400, 'INVALID_BOOKING_SMS_REQUEST', 'Enter a valid booking reference.');
  }
  const booking = await authorisedBooking(session, parsed.data);
  if (booking instanceof Response) return booking;
  try {
    const status = await readBookingManualSmsStatus(booking.id);
    return walletOk(previewData(booking, status));
  } catch (error) {
    return smsErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = sendSchema.safeParse(body);
  if (!parsed.success) {
    return walletFail(400, 'INVALID_BOOKING_SMS_REQUEST', 'The SMS request is invalid.');
  }
  const booking = await authorisedBooking(session, parsed.data.bookingReference);
  if (booking instanceof Response) return booking;

  const limit = await checkActionLimit('bookingSmsShare', `user:${session.clerkId}`);
  if (!limit.ok) {
    return walletFail(
      429,
      'BOOKING_SMS_RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds),
      { retryAfterSeconds: limit.retryAfterSeconds }
    );
  }

  let claim: Awaited<ReturnType<typeof claimBookingManualSmsSend>>;
  try {
    claim = await claimBookingManualSmsSend({
      bookingId: booking.id,
      actorUserId: session.clerkId,
      requestId: parsed.data.requestId,
      recipientNumber: parsed.data.recipientNumber,
      messageText: parsed.data.message,
    });
  } catch (error) {
    return smsErrorResponse(error);
  }

  if (claim.claimState === 'sent') {
    return walletOk({
      delivered: true,
      sentCount: claim.sentCount,
      maxSends: BOOKING_MANUAL_SMS_MAX_SENDS,
      remainingSends: claim.remainingSends,
    });
  }
  if (claim.claimState === 'processing') {
    return walletFail(
      409,
      'BOOKING_SMS_IN_PROGRESS',
      'This SMS send is already in progress. Please wait.'
    );
  }

  const recipientHash = securitySubjectHash(claim.recipientNumber);
  try {
    const result = await sendBulkSmsBdText({
      to: claim.recipientNumber,
      message: claim.messageText,
    });
    const sentCount = await markBookingManualSmsSent({
      deliveryId: claim.deliveryId,
      claimToken: claim.claimToken,
      providerMessageId: result.providerMessageId,
    });
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'flight.booking.confirmation.sms_shared',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'succeeded',
      metadata: { recipientHash, sentCount },
    });
    return walletOk({
      delivered: true,
      sentCount,
      maxSends: BOOKING_MANUAL_SMS_MAX_SENDS,
      remainingSends: Math.max(0, BOOKING_MANUAL_SMS_MAX_SENDS - sentCount),
    });
  } catch (error) {
    console.error('[sms] confirmed booking share failed:', booking.public_ref, error);
    try {
      await failBookingManualSmsSend({
        deliveryId: claim.deliveryId,
        claimToken: claim.claimToken,
        error: error instanceof Error ? error.message : 'SMS delivery failed.',
      });
    } catch (recordError) {
      console.error('[sms] manual booking share failure could not be stored:', recordError);
    }
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'flight.booking.confirmation.sms_shared',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'failed',
      metadata: { recipientHash },
    });
    return smsErrorResponse(error);
  }
}
