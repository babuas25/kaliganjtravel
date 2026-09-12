import { z } from 'zod';

import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  publicBookingWithHeaderContact,
  readBookingByPublicRef,
} from '@/lib/db/flight-bookings';
import {
  recordSecurityAuditEvent,
  securitySubjectHash,
} from '@/lib/db/security';
import { sendBookingStatusNotification } from '@/lib/email/notifications';
import type { BookingTraveller } from '@/lib/flights/booking';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const requestSchema = z
  .object({
    bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
    email: z.string().trim().email().max(254),
  })
  .strict();

const travellerSchema = z.object({
  passengerType: z.enum(['ADT', 'CHD', 'CNN', 'INF', 'INS']),
  title: z.enum(['Mr', 'Mrs', 'Ms', 'Mstr', 'Miss']),
  firstName: z.string(),
  lastName: z.string(),
  gender: z.enum(['Male', 'Female']),
  dateOfBirth: z.string(),
  passportNumber: z.string().optional(),
  passportExpiry: z.string().optional(),
  issuingCountry: z.string().optional(),
  nationality: z.string(),
});

function storedTravellers(value: unknown): BookingTraveller[] | null {
  if (!value || typeof value !== 'object') return null;
  const result = z
    .array(travellerSchema)
    .safeParse((value as { travellers?: unknown }).travellers);
  return result.success ? result.data : null;
}

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (session.role === 'staff_media') {
    return walletFail(403, 'BOOKING_SHARE_FORBIDDEN', 'Booking access is forbidden.');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_BOOKING_SHARE_REQUEST',
      'Enter a valid email address.'
    );
  }

  const booking = await readBookingByPublicRef(
    parsed.data.bookingReference,
    bookingScopeFor(session)
  );
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if ((booking.lifecycle_status ?? booking.status) !== 'confirmed') {
    return walletFail(
      409,
      'BOOKING_NOT_CONFIRMED',
      'Only a confirmed booking can be shared by email.'
    );
  }

  const limit = await checkActionLimit(
    'bookingConfirmationShare',
    `user:${session.clerkId}`
  );
  if (!limit.ok) {
    return walletFail(
      429,
      'BOOKING_SHARE_RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds),
      { retryAfterSeconds: limit.retryAfterSeconds }
    );
  }

  const email = parsed.data.email.toLowerCase();
  const recipientHash = securitySubjectHash(email);
  const travellers = storedTravellers(booking.passengers);
  if (!travellers) {
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'flight.booking.confirmation.shared',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'failed',
      metadata: { recipientHash, reason: 'invalid_stored_travellers' },
    });
    return walletFail(
      503,
      'BOOKING_EMAIL_UNAVAILABLE',
      'The confirmation email could not be prepared. Please try again.'
    );
  }

  try {
    const result = await sendBookingStatusNotification({
      recipients: [email],
      status: 'confirmed',
      booking: await publicBookingWithHeaderContact(booking),
      travellers,
    });
    if (result.delivered !== 1) {
      throw new Error('The mail transport did not confirm delivery.');
    }
  } catch (error) {
    console.error('[email] confirmed booking share failed:', booking.public_ref, error);
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'flight.booking.confirmation.shared',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'failed',
      metadata: { recipientHash },
    });
    return walletFail(
      503,
      'BOOKING_EMAIL_DELIVERY_FAILED',
      'The confirmation email could not be delivered. Please try again.'
    );
  }

  await recordSecurityAuditEvent({
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'flight.booking.confirmation.shared',
    targetType: 'flight_booking',
    targetId: booking.id,
    outcome: 'succeeded',
    metadata: { recipientHash },
  });
  return walletOk({ delivered: true });
}
