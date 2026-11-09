import { SHAPON_CUTOVER_FAILURE, shaponCutoverPaused } from '@/lib/shapontravels/cutover';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDashboardSession } from '@/lib/dashboard/session';
import { canRefreshBookingSupplierDetails } from '@/lib/dashboard/booking-lifecycle';
import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { saveShapontravelsTicketingTime } from '@/lib/db/booking-ticketing-time';
import { shapontravelsTicketingTime } from '@/lib/shapontravels/ticketing-time';
import { BOOKING_PAYMENT_EFFECTS, previewShaponTicketPayment, type BookingPaymentEffect } from '@/lib/db/booking-payment-resolution';
import { dispatchBookingStatusEmails } from '@/lib/email/booking-status-delivery';
import { verifyShaponCancellationRecovery } from '@/lib/shapontravels/cancellation-recovery';
import { supabaseAdmin } from '@/lib/supabase/server';
import { shapontravelsReadBooking, shapontravelsReadTicket, shapontravelsReadCancellation } from '@/lib/shapontravels/client';
import { normalizeShapontravelsSavedBookingEnvelope, verifyShapontravelsBookingStatus } from '@/lib/shapontravels/booking-status';
import { recordShapontravelsCurrentStatus } from '@/lib/shapontravels/current-status-store';
import { parseShapontravelsTicketEvidence, shapontravelsTicketIdentityReady } from '@/lib/shapontravels/ticket';
import { parseShapontravelsCancellationReceipt, shapontravelsCancellationIdentityReady } from '@/lib/shapontravels/cancel';
import {
  canConfirmShaponExternalTicket,
  canOfferShaponExternalTicketConfirmation,
  isShaponTicketingRecovery,
  verifyShaponExternalTicketConfirmation,
} from '@/lib/shapontravels/external-ticket-confirmation';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const schema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
}).strict();

/** Read Shapon's saved records; never request supplier sync or new issuance. */
export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canRefreshBookingSupplierDetails(session.role)) {
    return walletFail(403, 'REFRESH_FORBIDDEN', 'Supplier status is restricted to booking staff.');
  }
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return walletFail(400, 'INVALID_REQUEST', 'Check the booking reference.');

  const booking = await readBookingByPublicRef(
    parsed.data.bookingReference, bookingScopeFor(session)
  );
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if (booking.supplier !== 'shapontravels' ||
      booking.supplier_account !== 'shapontravels' || booking.import_source) {
    return walletFail(409, 'SUPPLIER_UNAVAILABLE', 'This is not a Shapontravels API booking.');
  }
  if (shaponCutoverPaused(booking.supplier)) return walletFail(...SHAPON_CUTOVER_FAILURE);
  const refs = booking.supplier_refs;
  if (!booking.booking_code_ref || !refs?.uniqueTransId ||
      !refs.itemCodeRef || !refs.priceCodeRef) {
    return walletFail(409, 'SUPPLIER_REFERENCE_MISSING', 'Supplier lookup details are missing.');
  }
  const db = supabaseAdmin();
  if (!db) return walletFail(503, 'BOOKING_STORAGE_FAILED', 'Booking storage is unavailable.');
  const { data: identity, error } = await db.from('flight_bookings')
    .select('supplier_public_ref')
    .eq('id', booking.id)
    .single();
  if (error) return walletFail(503, 'BOOKING_STORAGE_FAILED', 'Booking storage is unavailable.');
  const supplierPublicRef = identity?.supplier_public_ref;
  if (!supplierPublicRef) {
    return walletFail(409, 'SUPPLIER_REFERENCE_MISSING', 'The supplier STR reference is missing.');
  }

  try {
    const requestStartedAt = new Date().toISOString();
    const read = await shapontravelsReadBooking({ bookingId: booking.booking_code_ref });
    if (read.httpStatus === 200 && read.body && typeof read.body === 'object' &&
        Object.hasOwn(read.body, 'savedBooking') &&
        !normalizeShapontravelsSavedBookingEnvelope(read.body)) {
      return walletFail(409, 'SUPPLIER_SAVED_STATUS_UNVERIFIED',
        'The saved Shapon booking details are inconsistent. No booking change was made.');
    }
    const expected = {
      uniqueTransId: refs.uniqueTransId,
      itemCodeRef: refs.itemCodeRef,
      priceCodeRef: refs.priceCodeRef,
      bookingCodeRef: booking.booking_code_ref,
      bookingRefNumber: booking.booking_ref_number,
      pnr: booking.pnr,
      supplierPublicRef,
    };
    const status = verifyShapontravelsBookingStatus(read, expected);
    if (status.result === 'mismatch' || status.result === 'unverified') {
      console.error('[shapontravels] booking status identity unverified', {
        bookingId: booking.id, result: status.result,
      });
      return walletFail(409, 'SUPPLIER_IDENTITY_UNVERIFIED',
        'Supplier details did not verify against this booking. Staff reconciliation is required.');
    }
    const deadline = shapontravelsTicketingTime(read, expected);
    const savedDeadline = deadline ? await saveShapontravelsTicketingTime(booking, deadline) : null;
    const storage = await recordShapontravelsCurrentStatus({
      bookingId: booking.id, requestStartedAt, expected, status,
    });
    let supplierTicket: {
      result: 'verified' | 'pending' | 'not_found' | 'unverified' | 'unavailable';
      ticketCount?: number;
      ticketCodeRef?: string;
    } | null = null;
    let externalTicketConfirmation: {
      eligible: true; amount: number; currency: string;
      paymentEffect: BookingPaymentEffect;
      recovery?: true; existingHoldAmount?: number;
    } | null = null;
    let cancellationResolved = false;
    const resolveCancellation = async (
      cancellation: NonNullable<ReturnType<typeof verifyShaponCancellationRecovery>>,
    ) => {
      const { data: resolved, error: resolutionError } = await db.rpc(
        'resolve_shapon_cancelled_refresh_v1', {
          p_booking_id: booking.id,
          p_actor_user_id: session.clerkId,
          p_actor_role: session.role,
          p_request_id: randomUUID(),
          p_receipt_identity: cancellation.receiptIdentity,
          p_cancellation_proof: cancellation.cancellationProof,
          p_checked_at: cancellation.checkedAt,
        },
      );
      cancellationResolved = !resolutionError && resolved?.ok === true;
      if (cancellationResolved && resolved?.replay !== true) {
        try {
          await dispatchBookingStatusEmails(booking.id);
        } catch {
          console.error('[shapontravels] cancellation notification delivery failed', {
            bookingId: booking.id,
          });
        }
      }
    };
    const mayResolveCancellation = canConfirmShaponExternalTicket(session.role) &&
      status.currentStatus?.status === 'cancelled';
    // Canonical saved-v1 explicitly contains the complete cancellation/payment/
    // ticket state. An unticketed booking need not have a /ticket resource.
    const savedCancellation = mayResolveCancellation
      ? verifyShaponCancellationRecovery(booking, read, null, supplierPublicRef) : null;
    if (savedCancellation) await resolveCancellation(savedCancellation);

    const cancellationActive = booking.operation_reason === 'cancellation' ||
      booking.operation_reason === 'cancellation_reconciliation';
    let supplierCancellation: {
      result: 'verified' | 'pending' | 'not_found' | 'unverified' | 'unavailable';
    } | null = null;
    if (cancellationActive && !savedCancellation) {
      if (!shapontravelsCancellationIdentityReady(booking)) {
        supplierCancellation = { result: 'unverified' };
      } else {
        try {
          const cancellationRead = await shapontravelsReadCancellation(booking.booking_code_ref);
          const result = cancellationRead.httpStatus === 202 ? 'pending'
            : cancellationRead.httpStatus === 404 ? 'not_found'
              : parseShapontravelsCancellationReceipt(cancellationRead.body, {
                  ...refs, pnr: booking.pnr!, bookingRefNumber: booking.booking_ref_number!,
                  bookingCodeRef: booking.booking_code_ref, supplierPublicRef,
                }) ? 'verified' : 'unverified';
          supplierCancellation = { result };
        } catch {
          supplierCancellation = { result: 'unavailable' };
        }
      }
    }
    if (!savedCancellation && (mayResolveCancellation || (!cancellationActive &&
        (booking.status === 'in-progress' || booking.payment_state === 'reconciliation' ||
          status.currentStatus?.status === 'confirmed')))) {
      if (!shapontravelsTicketIdentityReady(booking)) {
        supplierTicket = { result: 'unverified' };
      } else {
        try {
          const ticketRead = await shapontravelsReadTicket(booking.booking_code_ref);
          if (ticketRead.httpStatus === 202) {
            supplierTicket = { result: 'pending' };
          } else if (ticketRead.httpStatus === 404) {
            supplierTicket = { result: 'not_found' };
          } else {
            if (mayResolveCancellation) {
              const cancellation = verifyShaponCancellationRecovery(
                booking, read, ticketRead, supplierPublicRef,
              );
              if (cancellation) await resolveCancellation(cancellation);
            }
            const evidence = parseShapontravelsTicketEvidence(ticketRead.body, {
              ...refs,
              pnr: booking.pnr!,
              bookingRefNumber: booking.booking_ref_number!,
              bookingCodeRef: booking.booking_code_ref,
              itinerary: booking.itinerary,
              expectedPassengerCount: Object.values(booking.passenger_counts)
                .reduce<number>((sum, value) => sum + (value ?? 0), 0),
            });
            const ticket = evidence?.ticket;
            supplierTicket = ticket
              ? { result: 'verified', ticketCount: evidence!.passengerTickets.length,
                  ...(ticket.ticketCodeRef ? { ticketCodeRef: ticket.ticketCodeRef } : {}) }
              : { result: 'unverified' };
            if (cancellationResolved) supplierTicket = null;
            if (ticket && canConfirmShaponExternalTicket(session.role) &&
                canOfferShaponExternalTicketConfirmation(booking) &&
                verifyShaponExternalTicketConfirmation(booking, read, ticketRead, supplierPublicRef)) {
              const recovery = isShaponTicketingRecovery(booking);
              const payment = await previewShaponTicketPayment({
                bookingId: booking.id, actorUserId: session.clerkId, actorRole: session.role,
              });
              if (payment.ok && payment.eligible && payment.paymentEffect &&
                  BOOKING_PAYMENT_EFFECTS.includes(payment.paymentEffect) &&
                  Number.isSafeInteger(payment.amount) && Number(payment.amount) > 0 &&
                  Number.isSafeInteger(payment.existingHoldAmount) && Number(payment.existingHoldAmount) >= 0 &&
                  payment.currency === booking.currency) {
                externalTicketConfirmation = {
                  eligible: true,
                  amount: payment.amount! / 100,
                  currency: booking.currency,
                  paymentEffect: payment.paymentEffect,
                  existingHoldAmount: payment.existingHoldAmount! / 100,
                  ...(recovery ? { recovery: true } : {}),
                };
              }
            }
          }
        } catch {
          supplierTicket = { result: 'unavailable' };
        }
      }
    }
    if (cancellationResolved) supplierCancellation = null;
    return walletOk({ ...status, supplierTicket, supplierCancellation, externalTicketConfirmation, ...storage,
      lookupMode: 'shapon_saved_status', supplierSyncPerformed: false,
      ticketingTimeUpdated: savedDeadline?.updated === true,
      ...(savedDeadline ? { ticketingDeadlineAt: savedDeadline.ticketingDeadlineAt } : {}),
      ...(cancellationResolved ? {
        cancellationResolved: true, displayStatus: 'cancelled', displayReviewRequired: false,
      } : {}),
      projectionUpdated: storage.projectionUpdated || cancellationResolved });
  } catch (error) {
    console.error('[shapontravels] booking status read failed', {
      bookingId: booking.id,
      code: error instanceof Error ? error.message : 'unknown',
    });
    return walletFail(502, 'SUPPLIER_STATUS_UNAVAILABLE',
      'Saved Shapon status is temporarily unavailable. Refresh again to verify the local booking.');
  }
}
