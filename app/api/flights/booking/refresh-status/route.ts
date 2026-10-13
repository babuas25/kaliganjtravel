import { NextRequest } from 'next/server';
import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { readBookingByPublicRef, type BookingRow } from '@/lib/db/flight-bookings';
import { recordTriploverStatusCheck, triploverStatusCheckContext } from '@/lib/db/triplover-status-confirmation';
import { canCheckTriploverSupplierStatus, readTriploverSupplierStatus } from '@/lib/triplover/supplier-status';
import { checkActionLimit } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const schema = z.object({ bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/) }).strict();

export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (session.role !== 'admin' && session.role !== 'superadmin') return walletFail(403, 'REFRESH_FORBIDDEN', 'Only Admin or Super Admin can verify supplier status.');
  const payload = await request.json().catch(() => null);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return walletFail(400, 'INVALID_REFRESH_REQUEST', 'Check the booking reference.');
  const booking = await readBookingByPublicRef(parsed.data.bookingReference, bookingScopeFor(session));
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if (!canCheckTriploverSupplierStatus(booking)) return walletFail(409, 'STATUS_CHECK_UNAVAILABLE', 'This booking does not support this supplier status check.');
  const limit = await checkActionLimit('refreshTicketingTime', booking.id);
  if (!limit.ok) return walletFail(429, 'REFRESH_RATE_LIMITED', 'Please wait a moment before checking again.');
  const actor = { clerkId: session.clerkId, role: session.role };
  try {
    const context = await triploverStatusCheckContext(booking.id, actor);
    const checkedBooking = context.booking as BookingRow | undefined;
    if (context.ok !== true || typeof context.bookingSnapshotHash !== 'string' || !checkedBooking ||
        checkedBooking.id !== booking.id || !canCheckTriploverSupplierStatus(checkedBooking)) return walletFail(409, 'BOOKING_CHANGED', 'The booking is not ready for this check. Refresh the page.');
    const facts = await readTriploverSupplierStatus(checkedBooking);
    const check = await recordTriploverStatusCheck(booking.id, actor, context.bookingSnapshotHash, facts);
    if (!check) return walletFail(409, 'BOOKING_CHANGED', 'The booking changed during verification. Refresh Status again.');
    const { ticketCodeRef: _ticketCodeRef, rawPayloadHash: _rawPayloadHash, supplierPayableMinor: _supplierPayableMinor, ...visible } = check;
    return walletOk({ check: { ...visible, localStatus: checkedBooking.lifecycle_status ?? checkedBooking.status, paymentState: checkedBooking.payment_state } });
  } catch {
    return walletFail(503, 'STATUS_CHECK_UNAVAILABLE', 'Supplier status could not be checked. The booking and payment remain unchanged.');
  }
}
