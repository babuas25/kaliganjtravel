import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { dispatchBookingStatusEmails } from '@/lib/email/booking-status-delivery';
import { supabaseAdmin } from '@/lib/supabase/server';
import { checkActionLimit } from '@/lib/rate-limit';
import { shapontravelsReadBooking, shapontravelsReadTicket } from '@/lib/shapontravels/client';
import {
  canConfirmShaponExternalTicket,
  canOfferShaponExternalTicketConfirmation,
  verifyShaponExternalTicketConfirmation,
} from '@/lib/shapontravels/external-ticket-confirmation';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const schema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
  requestId: z.string().uuid(),
  chargeWallet: z.boolean(),
});

type ConfirmationResult = {
  ok: boolean;
  code?: string;
  replay?: boolean;
  chargeWallet?: boolean;
  chargedAmount?: number;
  currency?: string;
  available?: number;
  required?: number;
};

const failureMessages: Record<string, string> = {
  INSUFFICIENT_FUNDS: 'The booking owner’s wallet does not have enough available balance.',
  WALLET_FROZEN: 'The booking owner’s wallet is frozen.',
  WALLET_NOT_FOUND: 'The booking owner does not have a wallet.',
  WALLET_ACCOUNT_NOT_FOUND: 'The booking owner has no wallet account for this currency.',
  INVALID_BOOKING_AMOUNT: 'The booking has no valid selling amount.',
  BOOKING_OWNER_REQUIRED: 'The booking has no wallet owner.',
  CONFIRM_FORBIDDEN: 'Only Admin or Super Admin can confirm an externally issued ticket.',
  CONFIRMATION_FORBIDDEN: 'Only Admin or Super Admin can confirm an externally issued ticket.',
  ACTOR_ROLE_MISMATCH: 'Your administrator role has changed. Reload the page before confirming.',
  BOOKING_NOT_ELIGIBLE: 'This booking cannot be confirmed through this action. Refresh its status.',
  ALREADY_CONFIRMED: 'This booking has already been confirmed. Refresh its status.',
  BOOKING_ALREADY_CONFIRMED: 'This booking has already been confirmed. Refresh its status.',
  BOOKING_CONFIRMATION_CONFLICT: 'An existing ticket, payment or booking operation needs staff review.',
  SUPPLIER_BOOKING_UNSUPPORTED: 'This action is available only for a held Shapontravels API booking.',
  CONFIRMATION_REQUEST_CONFLICT: 'This confirmation request was already used for a different decision.',
  CONFIRMATION_IDEMPOTENCY_CONFLICT: 'This confirmation request was already used for a different decision.',
  SUPPLIER_IDENTITY_UNVERIFIED: 'Supplier ticket details did not match the saved booking.',
  INVALID_TICKET_PROOF: 'The supplier ticket and payment could not be verified.',
  TICKET_EVIDENCE_UNVERIFIED: 'The supplier ticket and payment could not be verified.',
  TICKET_ALREADY_ASSIGNED: 'This ticket is already attached to another booking. Staff must investigate.',
  RECONCILIATION_REQUIRED: 'An existing booking operation or payment needs staff reconciliation.',
};

/** Resolve a saved, paid supplier ticket without submitting a new ticket request. */
export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canConfirmShaponExternalTicket(session.role)) {
    return walletFail(403, 'CONFIRM_FORBIDDEN', failureMessages.CONFIRM_FORBIDDEN);
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return walletFail(400, 'INVALID_CONFIRMATION_REQUEST', 'Check the booking reference and wallet charge choice.');
  }
  const limit = await checkActionLimit('bookingReconciliationWrite', `user:${session.clerkId}`);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', 'Too many ticket confirmation requests.');
  const booking = await readBookingByPublicRef(parsed.data.bookingReference, bookingScopeFor(session));
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  const db = supabaseAdmin();
  if (!db) return walletFail(503, 'CONFIRMATION_STORAGE_UNAVAILABLE', 'Ticket confirmation storage is unavailable.');

  let confirmationAttempted = false;
  try {
    // A retry after a committed response was lost must succeed even though the
    // booking is now Confirmed and the supplier might temporarily be offline.
    const { data: previous, error: replayError } = await db
      .from('shapon_external_ticket_confirmations').select('request_id')
      .eq('request_id', parsed.data.requestId).maybeSingle();
    if (replayError) {
      return walletFail(503, 'CONFIRMATION_STORAGE_UNAVAILABLE', 'Ticket confirmation storage is unavailable.');
    }
    let evidence: ReturnType<typeof verifyShaponExternalTicketConfirmation> = null;
    if (!previous) {
      if (!canOfferShaponExternalTicketConfirmation(booking)) {
        return walletFail(409, 'BOOKING_NOT_ELIGIBLE', failureMessages.BOOKING_NOT_ELIGIBLE);
      }
      const { data: identity, error } = await db.from('flight_bookings')
        .select('supplier_public_ref').eq('id', booking.id).single();
      if (error) return walletFail(503, 'CONFIRMATION_STORAGE_UNAVAILABLE', 'Booking storage is unavailable.');
      if (!identity?.supplier_public_ref) {
        return walletFail(409, 'SUPPLIER_IDENTITY_UNVERIFIED', failureMessages.SUPPLIER_IDENTITY_UNVERIFIED);
      }
      const [bookingRead, ticketRead] = await Promise.all([
        shapontravelsReadBooking({ bookingId: booking.booking_code_ref! }),
        shapontravelsReadTicket(booking.booking_code_ref!),
      ]);
      evidence = verifyShaponExternalTicketConfirmation(
        booking, bookingRead, ticketRead, identity.supplier_public_ref,
      );
      if (!evidence) {
        return walletFail(409, 'SUPPLIER_TICKET_NOT_CONFIRMED',
          'A matching issued and paid supplier ticket is required. Refresh and check the supplier ticket.');
      }
    }
    confirmationAttempted = true;
    const { data, error } = await db.rpc('confirm_shapon_external_ticket_v1', {
      p_booking_id: booking.id,
      p_actor_user_id: session.clerkId,
      p_actor_role: session.role,
      p_request_id: parsed.data.requestId,
      p_charge_wallet: parsed.data.chargeWallet,
      p_receipt_identity: evidence?.receiptIdentity ?? null,
      p_ticket_proof: evidence?.ticketProof ?? null,
      p_checked_at: evidence?.checkedAt ?? null,
    });
    if (error || !data || typeof data !== 'object' || Array.isArray(data) ||
        typeof (data as ConfirmationResult).ok !== 'boolean') {
      console.error('[shapontravels] external confirmation response unavailable', {
        bookingId: booking.id, code: error?.code ?? 'INVALID_RESPONSE',
      });
      return walletFail(503, 'CONFIRMATION_OUTCOME_UNKNOWN',
        'The confirmation result could not be read. Retry the same wallet charge choice to check the saved decision.');
    }
    const result = data as ConfirmationResult;
    if (!result.ok) {
      const code = result.code ?? 'BOOKING_NOT_ELIGIBLE';
      const forbidden = ['CONFIRM_FORBIDDEN', 'CONFIRMATION_FORBIDDEN', 'ACTOR_ROLE_MISMATCH'].includes(code);
      return walletFail(forbidden ? 403 : code === 'BOOKING_NOT_FOUND' ? 404 : 409, code,
        failureMessages[code] ?? 'The ticket confirmation could not be completed. Refresh the booking.', {
          ...(typeof result.available === 'number' ? { available: result.available } : {}),
          ...(typeof result.required === 'number' ? { required: result.required } : {}),
        });
    }
    if (typeof result.chargeWallet !== 'boolean' || result.chargeWallet !== parsed.data.chargeWallet ||
        !Number.isSafeInteger(result.chargedAmount) || Number(result.chargedAmount) < 0 ||
        result.currency !== booking.currency ||
        (result.chargeWallet ? Number(result.chargedAmount) <= 0 : result.chargedAmount !== 0)) {
      return walletFail(503, 'CONFIRMATION_OUTCOME_UNKNOWN',
        'The saved confirmation result could not be verified. Retry the same wallet charge choice.');
    }
    // The database has already committed. Delivery/audit transport failures
    // cannot change that result or send the Admin down a second-charge path.
    if (!result.replay) {
      try {
        await recordSecurityAuditEvent({
          actorUserId: session.clerkId, actorRole: session.role,
          action: 'flight.booking.external_ticket.confirm', targetType: 'flight_booking',
          targetId: booking.id, outcome: 'succeeded',
          metadata: { chargeWallet: result.chargeWallet, requestId: parsed.data.requestId },
        });
      } catch {
        console.error('[shapontravels] external confirmation audit delivery failed', { bookingId: booking.id });
      }
      try {
        await dispatchBookingStatusEmails(booking.id);
      } catch {
        console.error('[shapontravels] external confirmation notification delivery failed', { bookingId: booking.id });
      }
    }
    return walletOk({
      confirmed: true, charged: result.chargeWallet === true,
      amount: Number(result.chargedAmount ?? 0) / 100,
      currency: result.currency ?? booking.currency, replay: result.replay === true,
    });
  } catch {
    return confirmationAttempted
      ? walletFail(503, 'CONFIRMATION_OUTCOME_UNKNOWN',
          'The confirmation result could not be read. Retry the same wallet charge choice to check the saved decision.')
      : walletFail(502, 'SUPPLIER_STATUS_UNAVAILABLE',
          'Supplier ticket verification is unavailable. Retry the same confirmation choice.');
  }
}
