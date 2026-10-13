import { NextRequest } from 'next/server';
import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { previewTriploverIssuedHold, confirmTriploverIssuedHold } from '@/lib/db/triplover-status-confirmation';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const reference = z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/);
const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('preview'), bookingReference: reference, checkId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('confirm'), bookingReference: reference, checkId: z.string().uuid(),
    previewHash: z.string().regex(/^[a-f0-9]{32,64}$/), requestId: z.string().uuid(), confirmed: z.literal(true) }).strict(),
]);

export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (session.role !== 'admin' && session.role !== 'superadmin') return walletFail(403, 'CONFIRMATION_FORBIDDEN', 'Only Admin or Super Admin can confirm this supplier result.');
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return walletFail(400, 'INVALID_CONFIRMATION_REQUEST', 'Review and confirm the current preview.');
  const booking = await readBookingByPublicRef(parsed.data.bookingReference, bookingScopeFor(session));
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  const actor = { clerkId: session.clerkId, role: session.role };
  try {
    if (parsed.data.action === 'preview') {
      const preview = await previewTriploverIssuedHold(booking.id, actor, parsed.data.checkId);
      return walletOk({ preview });
    }
    // Database replay is resolved before freshness/state checks. No supplier request is made here.
    const result = await confirmTriploverIssuedHold(booking.id, actor, parsed.data);
    if (result.ok !== true) return walletFail(409, String(result.code ?? 'CONFIRMATION_UNAVAILABLE'), 'The confirmation is unavailable or the booking changed. Refresh Status and review again.');
    const fields = ['ok', 'replay', 'bookingReference', 'bookingStatus', 'paymentState', 'currency', 'walletEffect', 'amount'];
    return walletOk({ result: Object.fromEntries(fields.filter(key => Object.hasOwn(result, key)).map(key => [key, result[key]])) });
  } catch {
    return walletFail(503, 'CONFIRMATION_OUTCOME_UNKNOWN', 'The saved result could not be read. Retry the same confirmation before taking another action.');
  }
}
