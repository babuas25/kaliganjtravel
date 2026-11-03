import { z } from 'zod';
import { getDashboardSession } from '@/lib/dashboard/session';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { readBookingPaymentReturnContext } from '@/lib/db/booking-payment-resolution';
import { supabaseAdmin } from '@/lib/supabase/server';
import { checkActionLimit } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const isBookingReference = (reference: string): boolean => /^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference);

const money = z.number().finite().nonnegative().refine(value =>
  Number.isSafeInteger(Math.round(value * 100)) &&
  Math.abs(value * 100 - Math.round(value * 100)) < 0.000001);
const schema = z.object({
  requestId: z.string().uuid(),
  captureLedgerEntryId: z.string().uuid(),
  expectedCapturedAmount: money,
  expectedRefundedAmount: money,
  expectedRefundableAmount: money,
  expectedAvailableBalance: money,
  expectedHoldBalance: money,
  reason: z.string().trim().min(3).max(500).refine(value => !/[\u0000-\u001f\u007f]/.test(value)),
  confirmation: z.literal(true),
}).strict();

async function authorizedBooking(reference: string) {
  const session = await getDashboardSession();
  if (!session) return { response: walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.') };
  if (session.role !== 'admin' && session.role !== 'superadmin') {
    return { response: walletFail(403, 'PAYMENT_RETURN_FORBIDDEN', 'Only Admin or Super Admin can return booking payments.') };
  }
  if (!isBookingReference(reference)) {
    return { response: walletFail(400, 'INVALID_PAYMENT_RETURN_REQUEST', 'Check the booking reference.') };
  }
  const booking = await readBookingByPublicRef(reference, bookingScopeFor(session));
  if (!booking) return { response: walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.') };
  return { session, booking };
}

export async function GET(_request: Request, { params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;
  const access = await authorizedBooking(reference);
  if (access.response) return access.response;
  const context = await readBookingPaymentReturnContext({
    bookingId: access.booking!.id, actorUserId: access.session!.clerkId, actorRole: access.session!.role,
  });
  if (!context) return walletFail(409, 'PAYMENT_RETURN_REVIEW_REQUIRED',
    'The captured payment could not be verified. Review this booking’s payment history.');
  return walletOk(context);
}

/** Explicit Admin refund of the original captured booking payment; never changes supplier/status. */
export async function POST(request: Request, { params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;
  const access = await authorizedBooking(reference);
  if (access.response) return access.response;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return walletFail(400, 'INVALID_PAYMENT_RETURN_REQUEST', 'Check the return preview and reason.');
  const input = parsed.data;
  const captured = Math.round(input.expectedCapturedAmount * 100);
  const refunded = Math.round(input.expectedRefundedAmount * 100);
  const refundable = Math.round(input.expectedRefundableAmount * 100);
  if (refundable <= 0 || captured !== refunded + refundable) {
    return walletFail(400, 'INVALID_PAYMENT_RETURN_REQUEST', 'Refresh the remaining returnable amount.');
  }
  const limit = await checkActionLimit('bookingReconciliationWrite', `user:${access.session!.clerkId}`);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', 'Too many payment return requests.');
  const db = supabaseAdmin();
  if (!db) return walletFail(503, 'PAYMENT_RETURN_OUTCOME_UNKNOWN', 'Payment storage is unavailable. Retry the same request.');
  try {
    const { data, error } = await db.rpc('return_booking_payment_v1', {
      p_booking_id: access.booking!.id,
      p_actor_user_id: access.session!.clerkId,
      p_actor_role: access.session!.role,
      p_request_id: input.requestId,
      p_expected_capture_ledger_entry_id: input.captureLedgerEntryId,
      p_expected_refunded_amount: refunded,
      p_expected_refundable_amount: refundable,
      p_expected_available_balance: Math.round(input.expectedAvailableBalance * 100),
      p_expected_hold_balance: Math.round(input.expectedHoldBalance * 100),
      p_reason: input.reason,
      p_confirmation: input.confirmation,
    });
    if (error || !data || typeof data !== 'object' || Array.isArray(data) || typeof data.ok !== 'boolean') {
      return walletFail(503, 'PAYMENT_RETURN_OUTCOME_UNKNOWN', 'The return result is not verified. Retry the same request.');
    }
    if (!data.ok) {
      const forbidden = ['PAYMENT_RETURN_FORBIDDEN', 'CONFIRMATION_FORBIDDEN', 'ACTOR_ROLE_MISMATCH'].includes(data.code);
      return walletFail(forbidden ? 403 : 409,
        forbidden ? 'PAYMENT_RETURN_FORBIDDEN' : 'PAYMENT_RETURN_STATE_CHANGED',
        forbidden ? 'Payment return access is forbidden.' : 'The payment or wallet changed. Refresh the return preview before deciding.');
    }
    if (data.captureLedgerEntryId !== input.captureLedgerEntryId ||
        data.currency !== access.booking!.currency || data.returnedAmount !== refundable ||
        data.capturedAmount !== captured || data.refundedAmount !== captured) {
      return walletFail(503, 'PAYMENT_RETURN_OUTCOME_UNKNOWN', 'The saved return result could not be verified. Retry the same request.');
    }
    return walletOk({ returned: true, currency: data.currency,
      amount: data.returnedAmount / 100, refundedAmount: data.refundedAmount / 100,
      refundableAmount: 0, replay: data.replay === true });
  } catch {
    return walletFail(503, 'PAYMENT_RETURN_OUTCOME_UNKNOWN', 'The return result is not verified. Retry the same request.');
  }
}
