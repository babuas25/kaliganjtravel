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
import {
  matchingShapontravelsCanonicalTicketSnapshots,
  matchingShapontravelsPayableSnapshots,
  normalizeShapontravelsReceiptEnvelope,
  normalizeShapontravelsSavedBookingEnvelope,
  shapontravelsAirlinePnrs,
  shapontravelsDisplayLocators,
  shapontravelsPayableSnapshot,
  verifyShapontravelsBookingStatus,
  type ShapontravelsDisplayLocators,
} from '@/lib/shapontravels/booking-status';
import { recordShapontravelsCurrentStatus } from '@/lib/shapontravels/current-status-store';
import { readShapontravelsSavedPayable, type ShapontravelsSavedPayable } from '@/lib/shapontravels/saved-fares';
import { parseShapontravelsTicketEvidence, shapontravelsPayableHasTickets, shapontravelsTicketIdentityReady } from '@/lib/shapontravels/ticket';
import { parseShapontravelsCancellationReceipt, shapontravelsCancellationReferencesReady } from '@/lib/shapontravels/cancel';
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

function locatorField(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key] : undefined;
}

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
    const expectedPassengerCount = Object.values(booking.passenger_counts)
      .reduce<number>((sum, value) => sum + (value ?? 0), 0);
    const hasSavedBooking = read.httpStatus === 200 && read.body && typeof read.body === 'object' &&
      Object.hasOwn(read.body, 'savedBooking');
    const savedBooking = hasSavedBooking ? normalizeShapontravelsSavedBookingEnvelope(read.body) : null;
    const expected = {
      uniqueTransId: refs.uniqueTransId,
      itemCodeRef: refs.itemCodeRef,
      priceCodeRef: refs.priceCodeRef,
      bookingCodeRef: booking.booking_code_ref,
      bookingRefNumber: booking.booking_ref_number,
      pnr: booking.pnr,
      supplierPublicRef,
    };
    const status = verifyShapontravelsBookingStatus(read, expected, booking.booking_code_ref);
    const recordDisplay = async (
      payable: ShapontravelsSavedPayable | null,
      locators: ShapontravelsDisplayLocators | null,
    ) => {
      try {
        const { data, error } = await db.rpc('record_shapon_booking_supplier_payable_v1', {
          p_booking_id: booking.id,
          p_request_started_at: requestStartedAt,
          p_supplier_public_ref: supplierPublicRef,
          p_receipt_identity: expected,
          p_supplier_payable_minor: payable?.supplierPayableMinor ?? null,
          p_special_discount_minor: payable?.specialDiscountMinor ?? null,
          p_currency: 'BDT',
          p_display_pnr: locators?.pnr ?? null,
          p_airline_pnrs: locators?.airlinePnrs ?? null,
        });
        return !error && data?.recorded === true;
      } catch {
        return false;
      }
    };

    const cancellationActive = booking.operation_reason === 'cancellation' ||
      booking.operation_reason === 'cancellation_reconciliation';
    const displayEligible = hasSavedBooking && booking.currency === 'BDT' &&
      !booking.direct_ticketing && !booking.legacy_operational &&
      shapontravelsTicketIdentityReady(booking) &&
      booking.status !== 'cancelled' && booking.operation_kind !== 'cancellation' && !cancellationActive &&
      read.supplierPublicRef === supplierPublicRef;
    const snapshot = displayEligible
      ? shapontravelsPayableSnapshot(read.body, expected, expectedPassengerCount) : null;
    const currentLocators = shapontravelsDisplayLocators(snapshot?.savedBooking, snapshot?.envelope);
    const needsDisplayOnlyCheck = !savedBooking || status.result !== 'verified' ||
      status.currentStatus?.reviewRequired !== false;
    if (needsDisplayOnlyCheck && snapshot?.savedBooking &&
        (snapshot.savedBooking.status !== 'on-hold' ||
          (['on-hold', 'pending'].includes(booking.status) && booking.payment_state === 'unpaid'))) {
      // Compare the two saved views by stable booking identity. An accepted
      // display observation grants no permission to act on the new locator.
      const payable = readShapontravelsSavedPayable(
        snapshot.savedBooking, snapshot.envelope, 'display-observation',
      );
      const updatedPnr = snapshot.savedBooking.pnr;
      if ((currentLocators || payable) && typeof updatedPnr === 'string') {
        const ticketRead = await shapontravelsReadTicket(booking.booking_code_ref).catch(() => null);
        const ticket = ticketRead?.httpStatus === 200
          ? shapontravelsPayableSnapshot(ticketRead.body, expected, expectedPassengerCount) : null;
        if (ticket?.savedBooking && matchingShapontravelsPayableSnapshots(snapshot.savedBooking, ticket.savedBooking)) {
          const locators = currentLocators && shapontravelsDisplayLocators(ticket.savedBooking, ticket.envelope);
          const validatedPayable = payable &&
            readShapontravelsSavedPayable(ticket.savedBooking, ticket.envelope, 'display-observation') ? payable : null;
          const ticketEvidenceMatches = ticket.savedBooking.ticketingState === 'not_issued' ||
            shapontravelsPayableHasTickets(ticket.savedBooking, ticket.envelope, {
              ...refs, pnr: updatedPnr, bookingRefNumber: updatedPnr,
              bookingCodeRef: booking.booking_code_ref,
              itinerary: booking.itinerary, expectedPassengerCount,
            });
          if (ticketEvidenceMatches && (locators || validatedPayable)) {
            if (!await recordDisplay(validatedPayable, locators)) {
              return walletFail(503, 'SUPPLIER_DETAILS_STORAGE_FAILED',
                'Saved supplier details could not be refreshed. Please try again.');
            }
            return walletOk({
              lookupMode: 'shapon_saved_status', supplierSyncPerformed: false,
              projectionUpdated: true, savedDetailsAvailable: true,
            });
          }
        }
      }
    }
    if (hasSavedBooking && !savedBooking) {
      return walletFail(409, 'SUPPLIER_SAVED_STATUS_UNVERIFIED',
        'The saved Shapon booking details are inconsistent. No booking change was made.');
    }
    if (status.result === 'mismatch' || status.result === 'unverified') {
      console.error('[shapontravels] booking status identity unverified', {
        bookingId: booking.id, result: status.result,
      });
      return walletFail(409, 'SUPPLIER_IDENTITY_UNVERIFIED',
        'Supplier details did not verify against this booking. Staff reconciliation is required.');
    }
    const deadline = shapontravelsTicketingTime(read, expected);
    const savedDeadline = deadline
      ? await saveShapontravelsTicketingTime(booking, supplierPublicRef, deadline.ticketingDeadlineAt) : null;
    const bookingUpdatedAt = savedDeadline?.updated ? savedDeadline.updatedAt : booking.updated_at;
    const currentStatus = status.currentStatus?.status;
    const savedPayable = booking.currency === 'BDT' && status.result === 'verified' &&
      status.currentStatusState === 'available' && status.currentStatus?.reviewRequired === false && savedBooking
      ? readShapontravelsSavedPayable(savedBooking.savedBooking, savedBooking.envelope) : null;
    const locatorStatusMatches = (currentStatus === 'confirmed' && booking.status === 'confirmed') ||
      (currentStatus === 'on-hold' && ['on-hold', 'pending'].includes(booking.status));
    const locatorIdentityMatches = !hasSavedBooking || savedBooking?.savedBooking?.bookingId === booking.booking_code_ref;
    let airlineLocatorRefresh: { bookingUpdatedAt: string; locators: string[] } | undefined;
    if (read.httpStatus === 200 && status.result === 'verified' && locatorIdentityMatches &&
        locatorStatusMatches && status.currentStatus?.reviewRequired === false &&
        bookingUpdatedAt && booking.pnr && !booking.operation_kind) {
      const existing = shapontravelsAirlinePnrs(booking.airlines_pnr);
      const unverified = booking.shapon_unverified_airline_pnr?.trim().toUpperCase();
      if (!existing.length || (existing.length === 1 && existing[0] === unverified)) {
        const receipt = savedBooking ?? normalizeShapontravelsReceiptEnvelope(read.body);
        const locators = shapontravelsAirlinePnrs(receipt?.receipt.airlinesPNR);
        const mirrors = [
          locatorField(receipt?.envelope.publicReceipt, 'airlinePnrs'),
          locatorField(receipt?.envelope.item1, 'airlinesPNR'),
        ];
        if (locators.length && mirrors.every(value => {
          if (value === undefined) return true;
          const mirror = shapontravelsAirlinePnrs(value);
          return mirror.length === locators.length && mirror.every(locator => locators.includes(locator));
        })) {
          airlineLocatorRefresh = { bookingUpdatedAt, locators };
        }
      }
    }
    const storage = await recordShapontravelsCurrentStatus({
      bookingId: booking.id, requestStartedAt, expected, status,
      ...(airlineLocatorRefresh ? { airlineLocatorRefresh } : {}),
    });
    let savedDetailsAvailable = false;
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

    let supplierCancellation: {
      result: 'verified' | 'pending' | 'not_found' | 'unverified' | 'unavailable';
    } | null = null;
    if (cancellationActive && !savedCancellation) {
      if (!shapontravelsCancellationReferencesReady(booking)) {
        supplierCancellation = { result: 'unverified' };
      } else {
        try {
          const cancellationRead = await shapontravelsReadCancellation(booking.booking_code_ref);
          const result = cancellationRead.httpStatus === 202 ? 'pending'
            : cancellationRead.httpStatus === 404 ? 'not_found'
              : parseShapontravelsCancellationReceipt(cancellationRead.body, {
                  ...refs, pnr: booking.pnr ?? '', bookingRefNumber: booking.booking_ref_number ?? '',
                  bookingCodeRef: booking.booking_code_ref!,
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
              expectedPassengerCount,
            });
            const ticket = evidence?.ticket;
            if (ticket && displayEligible && (savedPayable || currentLocators) && savedBooking?.savedBooking) {
              const canonicalTicket = normalizeShapontravelsSavedBookingEnvelope(ticketRead.body);
              if (ticketRead.httpStatus === 200 && canonicalTicket?.savedBooking) {
                const locators = currentLocators &&
                  matchingShapontravelsPayableSnapshots(savedBooking.savedBooking, canonicalTicket.savedBooking)
                  ? shapontravelsDisplayLocators(canonicalTicket.savedBooking, canonicalTicket.envelope) : null;
                const payable = savedPayable &&
                  matchingShapontravelsCanonicalTicketSnapshots(savedBooking.savedBooking, canonicalTicket.savedBooking) &&
                  readShapontravelsSavedPayable(canonicalTicket.savedBooking, canonicalTicket.envelope) ? savedPayable : null;
                if (locators || payable) savedDetailsAvailable = await recordDisplay(payable, locators);
              }
            }
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
    const airlinePnrsUpdated = storage.airlinePnrsUpdated === true;
    return walletOk({ ...status, supplierTicket, supplierCancellation, externalTicketConfirmation, ...storage,
      lookupMode: 'shapon_saved_status', supplierSyncPerformed: false,
      airlinePnrsUpdated,
      ticketingTimeUpdated: savedDeadline?.updated === true,
      ...(savedDeadline ? { ticketingDeadlineAt: savedDeadline.ticketingDeadlineAt } : {}),
      ...(cancellationResolved ? {
        cancellationResolved: true, displayStatus: 'cancelled', displayReviewRequired: false,
      } : {}),
      projectionUpdated: storage.projectionUpdated || cancellationResolved || airlinePnrsUpdated ||
        savedDetailsAvailable, ...(savedDetailsAvailable ? { savedDetailsAvailable: true } : {}) });
  } catch (error) {
    console.error('[shapontravels] booking status read failed', {
      bookingId: booking.id,
      code: error instanceof Error ? error.message : 'unknown',
    });
    return walletFail(502, 'SUPPLIER_STATUS_UNAVAILABLE',
      'Saved Shapon status is temporarily unavailable. Refresh again to verify the local booking.');
  }
}
