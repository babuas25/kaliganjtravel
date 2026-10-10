import { NextRequest } from 'next/server';
import { z } from 'zod';

import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { createOperationRequestIdentity } from '@/lib/booking-lifecycle/operation-request';
import { classifySupplierWriteFailure } from '@/lib/booking-lifecycle/supplier-uncertainty';
import { bookingOperationSupplierWriteHooks } from '@/lib/booking-lifecycle/supplier-write-hooks';
import { getDashboardSession } from '@/lib/dashboard/session';
import { recordSupplierWriteUncertainty } from '@/lib/db/booking-operations';
import {
  beginBookingCancellation,
  readBookingByPublicRef,
  restoreBookingCancellation,
  restoreUnsentShaponCancellation,
  syncAirTicketingDetails,
  syncPnrDetails,
} from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { dispatchBookingStatusEmails } from '@/lib/email/booking-status-delivery';
import {
  finalizeBookingCancellation,
  markReservationForReconciliation,
} from '@/lib/db/wallet';
import { checkActionLimit } from '@/lib/rate-limit';
import {
  cancelShapontravelsBooking,
  shapontravelsCancellationIdentityReady,
  verifyShapontravelsCancellationEligibility,
} from '@/lib/shapontravels/cancel';
import { isShapontravelsConfigured, shapontravelsReadBooking } from '@/lib/shapontravels/client';
import { cancelBooking } from '@/lib/triplover/cancel';
import { readAirTicketingDetails } from '@/lib/triplover/air-ticketing-details';
import { isTriploverSupplier } from '@/lib/triplover/config';
import { pnrLookupLocators, readPnr } from '@/lib/triplover/pnr';
import { walletFail, walletOk } from '@/lib/wallet/http';
import { canCancelBooking } from '@/lib/wallet/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const schema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
  requestId: z.string().uuid(),
});

export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  const limit = await checkActionLimit('flightBookingCancel', `user:${session.clerkId}`);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', 'Too many cancellation attempts.');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return walletFail(400, 'INVALID_CANCEL_REQUEST', 'Check the booking reference.');
  }

  const booking = await readBookingByPublicRef(
    parsed.data.bookingReference,
    bookingScopeFor(session)
  );
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if (booking.import_source === 'MANUAL' ||
      !['triplover', 'shapontravels'].includes(booking.supplier) ||
      (booking.supplier === 'shapontravels' && booking.import_source !== null)) {
    return walletFail(
      409,
      'EXTERNAL_SUPPLIER_BOOKING',
      booking.import_source === 'MANUAL'
        ? 'Manual bookings are managed through the Manual Booking workflow.'
        : 'This imported booking must be managed in its external supplier system.'
    );
  }
  const triploverAccount = isTriploverSupplier(booking.supplier_account)
    ? booking.supplier_account : null;
  if (booking.supplier === 'shapontravels'
      ? booking.supplier_account !== 'shapontravels'
      : !triploverAccount) {
    return walletFail(
      409,
      'SUPPLIER_ACCOUNT_UNAVAILABLE',
      'This booking was created before supplier-account tracking. Please contact support.'
    );
  }
  const supplierAccount = booking.supplier === 'shapontravels'
    ? 'shapontravels' : triploverAccount!;
  if (!canCancelBooking(session, booking)) {
    return walletFail(
      409,
      'BOOKING_NOT_CANCELLABLE',
      booking.supplier === 'shapontravels'
        ? 'Only an unissued On Hold, Pending, Unconfirmed, or Expired booking can be cancelled.'
        : 'Only a held, unissued booking can be cancelled.'
    );
  }

  if (supplierAccount === 'shapontravels' &&
      !shapontravelsCancellationIdentityReady(booking)) {
    return walletFail(409, 'SUPPLIER_REFERENCES_MISSING',
      'This booking is missing verified supplier cancellation references.');
  }
  if (supplierAccount === 'shapontravels' && !isShapontravelsConfigured()) {
    return walletFail(503, 'SUPPLIER_ACCOUNT_UNAVAILABLE',
      'Shapontravels cancellation is unavailable on this server.');
  }

  const refs = booking.supplier_refs;
  const pnrLocators = pnrLookupLocators({
    pnr: booking.pnr,
    bookingRefNumber: booking.booking_ref_number,
  });
  if (!pnrLocators || !booking.booking_code_ref || !refs?.uniqueTransId ||
      !refs.itemCodeRef || !refs.priceCodeRef) {
    return walletFail(
      409,
      'SUPPLIER_REFERENCES_MISSING',
      'This booking is missing supplier references and needs reconciliation.'
    );
  }

  const supplierInput = {
    ...refs,
    supplier: supplierAccount,
    ...pnrLocators,
    bookingCodeRef: booking.booking_code_ref,
    ...(supplierAccount === 'shapontravels'
      ? { supplierPublicRef: booking.supplier_public_ref } : {}),
  };
  if (supplierAccount === 'shapontravels') {
    try {
      // Cancellation has its own supplier capability. An expired issue
      // deadline or canIssue=false must not prevent releasing an unticketed PNR.
      const read = await shapontravelsReadBooking({ bookingId: supplierInput.bookingCodeRef });
      if (!verifyShapontravelsCancellationEligibility(read, supplierInput)) {
        return walletFail(409, 'SUPPLIER_CANCELLATION_UNAVAILABLE',
          'The supplier has not verified this booking as eligible for cancellation. Refresh the supplier status or contact support.');
      }
    } catch {
      return walletFail(502, 'SUPPLIER_STATUS_UNAVAILABLE',
        'The supplier cancellation status could not be verified. Try again shortly.');
    }
  }
  const operationRequest = createOperationRequestIdentity({
    clientRequestNonce: parsed.data.requestId,
    action: 'cancellation',
    subjectType: 'booking',
    subjectId: booking.id,
    payload: supplierInput,
  });
  const claim = await beginBookingCancellation(
    booking.id,
    session,
    operationRequest
  );
  if (!claim.ok) {
    return walletFail(
      claim.code === 'BOOKING_EXPIRED' ? 410 : 409,
      claim.code ?? 'CANCEL_IN_PROGRESS',
      claim.code === 'BOOKING_EXPIRED'
        ? 'The airline ticketing deadline has passed.'
        : claim.code === 'BOOKING_UNCONFIRMED'
          ? 'The airline PNR must be verified before cancellation.'
          : 'This booking is already being changed or is not cancellable. Refresh before trying again.'
    );
  }
  if (claim.replay) {
    return walletOk({
      replay: true,
      operationId: claim.operationId ?? null,
      cancellation: claim.operationResult ?? null,
    });
  }
  if (!claim.operationId) {
    return walletFail(
      503,
      'OPERATION_IDENTITY_MISSING',
      'Cancellation was not sent to the airline because its operation identity could not be verified.'
    );
  }
  const supplierLifecycle = bookingOperationSupplierWriteHooks(
    claim.operationId,
    operationRequest
  );

  try {
    const outcome = supplierAccount === 'shapontravels'
      ? await cancelShapontravelsBooking(
          supplierInput, operationRequest.requestKey, supplierLifecycle
        )
      : await cancelBooking(
          { ...supplierInput, supplier: triploverAccount! }, supplierLifecycle
        );
    const finalized = await finalizeBookingCancellation(
      booking.id,
      session,
      operationRequest,
      claim.operationId,
      'Booking cancelled with supplier',
      outcome
    );
    if (!finalized.ok) {
      return walletFail(
        503,
        'CANCEL_RECONCILIATION_REQUIRED',
        'The airline cancelled the booking, but wallet finalization needs Accounts review. Do not submit again.'
      );
    }
    // The atomic database finalization is already complete. Delivery or
    // ancillary audit failures must not reopen supplier uncertainty.
    try {
      await recordSecurityAuditEvent({
        actorUserId: session.clerkId,
        actorRole: session.role,
        action: 'wallet.booking.cancel',
        targetType: 'flight_booking',
        targetId: booking.id,
        outcome: 'succeeded',
        metadata: { reservationId: finalized.reservationId ?? null },
      });
    } catch (auditError) {
      console.error('[booking] cancellation audit delivery failed:', auditError);
    }
    try {
      await dispatchBookingStatusEmails(booking.id);
    } catch (deliveryError) {
      console.error('[booking] cancellation notification delivery failed:', deliveryError);
    }
    return walletOk({ cancellation: outcome, wallet: finalized });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Supplier cancellation failed';
    const supplierFailure = classifySupplierWriteFailure(
      error,
      supplierLifecycle.boundarySnapshot()
    );
    if (supplierFailure.failureClass === 'uncertain') {
      const recorded = await recordSupplierWriteUncertainty({
        subject: {
          bookingId: booking.id,
          operationId: claim.operationId,
        },
        actorUserId: session.clerkId,
        actorRole: session.role,
        request: operationRequest,
        classification: supplierFailure,
        errorMessage: message,
      });
      if (!recorded.ok) {
        await markReservationForReconciliation(
          { bookingId: booking.id },
          `${supplierFailure.reasonCode}: ${message}`
        );
      }
      await recordSecurityAuditEvent({
        actorUserId: session.clerkId,
        actorRole: session.role,
        action: 'wallet.booking.cancel.unknown',
        targetType: 'flight_booking',
        targetId: booking.id,
        outcome: 'failed',
        metadata: {
          reason: message.slice(0, 500),
          failureClass: supplierFailure.failureClass,
          reasonCode: supplierFailure.reasonCode,
          caseId: recorded.caseId ?? null,
          observationId: recorded.observationId ?? null,
        },
      });
      await dispatchBookingStatusEmails(booking.id);
      return walletFail(
        503,
        'CANCEL_OUTCOME_UNKNOWN',
        'The airline cancellation outcome is unknown. Do not submit again; contact support.'
      );
    }

    if (supplierAccount === 'shapontravels') {
      let restored: { ok: boolean; code?: string } = { ok: false };
      if (supplierFailure.failureClass === 'not-sent') {
        restored = await restoreUnsentShaponCancellation(
          booking.id, session.clerkId, operationRequest, claim.operationId
        );
      }
      if (!restored.ok) {
        await markReservationForReconciliation(
          { bookingId: booking.id }, `Cancellation could not restore a verified hold: ${message}`
        );
      }
      await recordSecurityAuditEvent({
        actorUserId: session.clerkId,
        actorRole: session.role,
        action: 'wallet.booking.cancel.failed',
        targetType: 'flight_booking',
        targetId: booking.id,
        outcome: 'failed',
        metadata: { reason: message.slice(0, 500), restored: restored.ok,
          failureClass: supplierFailure.failureClass, code: restored.code ?? null },
      });
      await dispatchBookingStatusEmails(booking.id);
      return restored.ok
        ? walletFail(502, 'BOOKING_CANCEL_FAILED', 'Cancellation was not completed. Please try again shortly.')
        : walletFail(503, 'CANCEL_RESTORE_FAILED',
            'Cancellation was not completed, and the booking needs support review before another attempt.');
    }

    // A supplier may report failure when the booking was already cancelled in
    // its portal. Reconcile that decided state before restoring our local hold.
    try {
      const details = await readAirTicketingDetails(
        refs.uniqueTransId,
        'Cancelled',
        triploverAccount!
      );
      if (details.supplierStatus?.toLowerCase() === 'cancelled') {
        const finalized = await finalizeBookingCancellation(
          booking.id,
          session,
          operationRequest,
          claim.operationId,
          'Booking cancellation confirmed by AirTicketingDetails',
          details
        );
        if (!finalized.ok) {
          return walletFail(
            503,
            'CANCEL_RECONCILIATION_REQUIRED',
            'The airline cancelled the booking, but wallet finalization needs Accounts review.'
          );
        }
        await syncAirTicketingDetails(
          booking.id,
          details,
          session,
          'cancellation_verification'
        );
        await recordSecurityAuditEvent({
          actorUserId: session.clerkId,
          actorRole: session.role,
          action: 'wallet.booking.cancel.reconciled',
          targetType: 'flight_booking',
          targetId: booking.id,
          outcome: 'succeeded',
          metadata: { initialSupplierMessage: message.slice(0, 500) },
        });
        await dispatchBookingStatusEmails(booking.id);
        return walletOk({ cancellation: details, wallet: finalized });
      }
    } catch {
      // No cancelled report exists; continue with the normal restore path.
    }

    let restored: { ok: boolean; code?: string } = {
      ok: false,
      code: 'HELD_BOOKING_NOT_VERIFIED',
    };
    try {
      const pnr = await readPnr({
        ...refs,
        supplier: triploverAccount!,
        ...pnrLocators,
        bookingCodeRef: booking.booking_code_ref,
        carrierCode: booking.itinerary?.carrierCode,
        deadlineNotBefore: booking.submission_started_at ?? booking.created_at,
      });
      await syncPnrDetails(
        booking.id,
        pnr,
        session,
        'cancellation_verification'
      );
      const normalizedPnrStatus = pnr.status?.trim().toLowerCase();
      if (
        normalizedPnrStatus === 'booked' ||
        normalizedPnrStatus === 'created' ||
        normalizedPnrStatus === 'held'
      ) {
        restored = await restoreBookingCancellation(
          booking.id,
          session.clerkId,
          operationRequest,
          claim.operationId,
          {
            pnrStatus: pnr.status,
            airlinePnrCount: pnr.airlinesPnr.length,
            lastTicketTime: pnr.lastTicketTime,
          }
        );
      }
    } catch {
      // Without a fresh, valid held PNR the refusal is not safe to restore.
    }
    if (!restored.ok) {
      await markReservationForReconciliation(
        { bookingId: booking.id },
        `Cancellation refusal could not verify a live hold: ${message}`
      );
    }
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'wallet.booking.cancel.failed',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'failed',
      metadata: {
        reason: message.slice(0, 500),
        restored: restored.ok,
        code: restored.code ?? null,
      },
    });
    await dispatchBookingStatusEmails(booking.id);
    return restored.ok
      ? walletFail(502, 'BOOKING_CANCEL_FAILED', message)
      : walletFail(
          503,
          'CANCEL_RESTORE_FAILED',
          'The airline declined cancellation, but the booking needs support review before another attempt.'
        );
  }
}
