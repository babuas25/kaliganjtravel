import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { z } from 'zod';

import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { createOperationRequestIdentity, type OperationRequestIdentity } from '@/lib/booking-lifecycle/operation-request';
import { classifySupplierWriteFailure } from '@/lib/booking-lifecycle/supplier-uncertainty';
import { bookingOperationSupplierWriteHooks } from '@/lib/booking-lifecycle/supplier-write-hooks';
import { getDashboardSession, type DashboardSession } from '@/lib/dashboard/session';
import { recordSupplierWriteUncertainty } from '@/lib/db/booking-operations';
import {
  beginBookingCancellation,
  readBookingByPublicRef,
  restoreBookingCancellation,
  syncAirTicketingDetails,
  syncPnrDetails,
} from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { hasVerifiedTriploverIssuedStatus } from '@/lib/db/triplover-status-confirmation';
import {
  advanceShaponCancellationRetry,
  finalizeShaponPlatformCancellation,
  readShaponCancellationPublicRef,
  readBookingCancellationReplay,
  restoreShapontravelsCancellationNotSent,
} from '@/lib/db/shapontravels-cancellation';
import { dispatchBookingStatusEmails } from '@/lib/email/booking-status-delivery';
import {
  finalizeBookingCancellation,
  markReservationForReconciliation,
} from '@/lib/db/wallet';
import { checkActionLimit } from '@/lib/rate-limit';
import { cancelBooking } from '@/lib/triplover/cancel';
import { readAirTicketingDetails } from '@/lib/triplover/air-ticketing-details';
import { isTriploverSupplier } from '@/lib/triplover/config';
import {
  isShapontravelsConfigured,
  shapontravelsReadBooking,
  ShapontravelsWriteError,
} from '@/lib/shapontravels/client';
import { readShaponCancellationState } from '@/lib/shapontravels/cancellation-recovery';
import {
  cancelShapontravelsBooking,
  isShaponCancellationReadUnavailable,
  isShaponPreClosureRefusal,
  type ShapontravelsCancellationInput,
  shapontravelsCancellationIdentityReady,
  shapontravelsCancellationReferencesReady,
} from '@/lib/shapontravels/cancel';
import { recordShapontravelsCurrentStatus } from '@/lib/shapontravels/current-status-store';
import { parseShapontravelsCurrentStatusProjection } from '@/lib/shapontravels/current-status-projection';
import { pnrLookupLocators, readPnr } from '@/lib/triplover/pnr';
import { walletFail, walletOk } from '@/lib/wallet/http';
import { canCancelBooking } from '@/lib/wallet/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

const schema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
  requestId: z.string().uuid(),
  retryOriginal: z.literal(true).optional(),
});

async function readSavedCancellation(bookingId: string, input: ShapontravelsCancellationInput) {
  const supplierPublicRef = await readShaponCancellationPublicRef(bookingId);
  if (!supplierPublicRef) return null;
  const requestStartedAt = new Date().toISOString();
  const read = await shapontravelsReadBooking({ bookingId: input.bookingCodeRef });
  const saved = readShaponCancellationState(read, input, supplierPublicRef);
  return saved && { ...saved, supplierPublicRef, requestStartedAt };
}

async function retryShaponCancellation(
  bookingId: string, session: DashboardSession, operationRequest: OperationRequestIdentity,
  operationId: string, input: ShapontravelsCancellationInput,
) {
  const retryId = randomUUID();
  let responseRecorded = false;
  try {
    let saved = await readSavedCancellation(bookingId, input);
    if (!saved?.closure && saved?.canRetry !== true) {
      return walletFail(409, 'SHAPON_CANCEL_RETRY_UNAVAILABLE', 'The saved booking is not eligible to retry cancellation.');
    }
    if (!saved.closure) {
      const eligibleRead = saved;
      await cancelShapontravelsBooking(input, operationRequest.requestKey, {
        beforeRequest: async () => {
          const leased = await advanceShaponCancellationRetry(bookingId, session, operationRequest, operationId, retryId, null, input, eligibleRead);
          if (!leased) throw new Error('Shapon cancellation retry is no longer available.');
        },
        onResponse: async ({ httpStatus }) => {
          responseRecorded = await advanceShaponCancellationRetry(bookingId, session, operationRequest, operationId, retryId, httpStatus, input, eligibleRead);
        },
      });
      saved = await readSavedCancellation(bookingId, input);
    }
    if (saved?.closure) {
      const finalized = await finalizeShaponPlatformCancellation(
        bookingId, session, operationRequest, operationId, saved.closure
      );
      if (finalized.ok) {
        if (!finalized.replay) await dispatchBookingStatusEmails(bookingId).catch(() => undefined);
        return walletOk({ cancellation: { status: 'cancelled', walletMutation: false } });
      }
    }
  } catch (error) {
    if (responseRecorded && isShaponPreClosureRefusal(error)) {
      // Shapon did not close on this retry. The earlier unanswered request can
      // still reach its closure transaction under the same key.
      return walletFail(503, 'CANCEL_OUTCOME_UNKNOWN',
        'Shapon declined this retry. The original cancellation result is still being verified.');
    }
  }
  return walletFail(503, 'CANCEL_OUTCOME_UNKNOWN', 'The Shapon cancellation is still being verified. Check the saved result.');
}

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
  const shaponBooking = booking.supplier === 'shapontravels';
  if (booking.import_source === 'MANUAL' ||
      !['triplover', 'shapontravels'].includes(booking.supplier) ||
      (shaponBooking && booking.import_source !== null)) {
    return walletFail(
      409,
      'EXTERNAL_SUPPLIER_BOOKING',
      booking.import_source === 'MANUAL'
        ? 'Manual bookings are managed through the Manual Booking workflow.'
        : 'This imported booking must be managed in its external supplier system.'
    );
  }
  if (shaponBooking
      ? booking.supplier_account !== 'shapontravels'
      : !isTriploverSupplier(booking.supplier_account)) {
    return walletFail(
      409,
      'SUPPLIER_ACCOUNT_UNAVAILABLE',
      'This booking was created before supplier-account tracking. Please contact support.'
    );
  }
  if (!shaponBooking) {
    if (!canCancelBooking(session, booking)) {
      return walletFail(409, 'BOOKING_NOT_CANCELLABLE', 'Only a held, unissued booking can be cancelled.');
    }
    try {
      if (await hasVerifiedTriploverIssuedStatus(booking.id)) return walletFail(409,
        'SUPPLIER_ALREADY_ISSUED', 'The supplier has verified issued tickets. An Admin must review Refresh Status before taking another action.');
    } catch {
      return walletFail(503, 'STORAGE_ERROR', 'Supplier status verification is unavailable.');
    }
  }

  const supplierAccount = booking.supplier_account;
  const triploverAccount = isTriploverSupplier(supplierAccount) ? supplierAccount : null;
  const refs = booking.supplier_refs;
  const pnrLocators = shaponBooking
    ? (shapontravelsCancellationReferencesReady(booking)
        ? { pnr: booking.pnr ?? '', bookingRefNumber: booking.booking_ref_number ?? '' }
        : null)
    : pnrLookupLocators({
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
    ...(shaponBooking ? { supplierPublicRef: booking.supplier_public_ref } : {}),
  };
  const operationRequest = createOperationRequestIdentity({
    clientRequestNonce: parsed.data.requestId,
    action: 'cancellation',
    subjectType: 'booking',
    subjectId: booking.id,
    payload: supplierInput,
  });
  try {
    const replay = shaponBooking ? await readBookingCancellationReplay(booking.id, session, operationRequest) : null;
    if (replay?.state === 'succeeded') {
      return walletOk({ replay: true, operationId: replay.operationId,
        cancellation: shaponBooking ? { status: 'cancelled' } : replay.result });
    }
    if (shaponBooking && parsed.data.retryOriginal && replay?.state === 'needs_reconciliation') {
      return await retryShaponCancellation(booking.id, session, operationRequest, replay.operationId, supplierInput);
    }
    if (parsed.data.retryOriginal && !shaponBooking) {
      return walletFail(409, 'SHAPON_CANCEL_RETRY_UNAVAILABLE', 'This booking does not support Shapon cancellation retry.');
    }
    if (replay) {
      return walletFail(409,
        replay.state === 'failed' ? replay.errorCode ?? 'OPERATION_FAILED'
          : replay.state === 'needs_reconciliation' || replay.state === 'awaiting_external_action'
            ? 'RECONCILIATION_REQUIRED' : 'OPERATION_IN_PROGRESS',
        'This cancellation request already has a saved outcome. Refresh or contact support before taking further action.');
    }
  } catch {
    return walletFail(503, 'CANCELLATION_REPLAY_UNAVAILABLE',
      'The saved cancellation request could not be verified. No new cancellation was sent.');
  }
  if (shaponBooking && !isShapontravelsConfigured()) {
    return walletFail(503, 'SUPPLIER_UNAVAILABLE', 'Supplier cancellation is not configured.');
  }
  if (shaponBooking && (!canCancelBooking(session, booking) ||
      !shapontravelsCancellationIdentityReady(booking))) {
    return walletFail(409, 'BOOKING_NOT_CANCELLABLE',
      'Only eligible unpaid, unissued On Hold, Unconfirmed or Expired bookings can be cancelled.');
  }
  if (shaponBooking) {
    try {
      const saved = await readSavedCancellation(booking.id, supplierInput);
      if (saved) {
        await recordShapontravelsCurrentStatus({
          bookingId: booking.id, requestStartedAt: saved.requestStartedAt,
          expected: { ...supplierInput, bookingRefNumber: booking.booking_ref_number, pnr: booking.pnr,
            supplierPublicRef: saved.supplierPublicRef },
          status: saved.observation,
        });
      }
      if (!saved?.canRetry) {
        return walletFail(409, 'SUPPLIER_CANCELLATION_UNAVAILABLE',
          'The saved Shapon booking is not eligible for cancellation.');
      }
    } catch (error) {
      const current = parseShapontravelsCurrentStatusProjection(booking.shapon_current_status)?.currentStatus;
      const unavailable = isShaponCancellationReadUnavailable(error);
      if (!(!parsed.data.retryOriginal && unavailable &&
          current?.status === 'on-hold' && current.canCancel === true)) {
        return walletFail(502, 'SUPPLIER_STATUS_UNAVAILABLE',
          'The saved Shapon booking could not be checked. Try again shortly.');
      }
    }
  }
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
      cancellation: shaponBooking ? { status: 'cancelled' } : claim.operationResult ?? null,
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
    if (shaponBooking) {
      await cancelShapontravelsBooking(supplierInput, operationRequest.requestKey, supplierLifecycle);
      const saved = await readSavedCancellation(booking.id, supplierInput);
      if (!saved?.closure) {
        throw new ShapontravelsWriteError('protocol', 'SHAPON_SAVED_CLOSURE_UNVERIFIED',
          200, null, null, null, 'Cancel');
      }
      const finalized = await finalizeShaponPlatformCancellation(
        booking.id, session, operationRequest, claim.operationId, saved.closure
      );
      if (!finalized.ok) {
        throw new ShapontravelsWriteError('protocol', 'SHAPON_CLOSURE_STORAGE_UNAVAILABLE',
          200, null, null, null, 'Cancel');
      }
      await Promise.allSettled([
        recordSecurityAuditEvent({
          actorUserId: session.clerkId,
          actorRole: session.role,
          action: 'booking.shapon_platform_cancel',
          targetType: 'flight_booking',
          targetId: booking.id,
          outcome: 'succeeded',
          metadata: { walletMutation: false },
        }),
        dispatchBookingStatusEmails(booking.id),
      ]);
      return walletOk({ cancellation: { status: 'cancelled', walletMutation: false } });
    }

    const outcome = await cancelBooking({ ...supplierInput, supplier: triploverAccount! }, supplierLifecycle);
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
    const boundary = supplierLifecycle.boundarySnapshot();
    if (shaponBooking && boundary.supplierResponseRecorded && boundary.httpStatus === 409 &&
        isShaponPreClosureRefusal(error)) {
      const restored = await restoreShapontravelsCancellationNotSent(
        booking.id, session, operationRequest, claim.operationId, error.code, true
      );
      if (restored.ok) {
        await dispatchBookingStatusEmails(booking.id).catch(() => undefined);
        return walletFail(409, 'SHAPON_CANCEL_REFUSED', 'Shapon declined cancellation before closing the booking.');
      }
    }
    const supplierFailure = classifySupplierWriteFailure(error, boundary);
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
      if (!recorded.ok && !shaponBooking) {
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
        shaponBooking
          ? 'The Shapon cancellation is still being verified. Check the saved result.'
          : 'The airline cancellation outcome is unknown. Do not submit again; contact support.'
      );
    }

    if (shaponBooking) {
      // No supplier dispatch happened. The RPC verifies the durable boundary
      // independently; it never relies on an old Book receipt to prove a hold.
      const restored = supplierFailure.failureClass === 'not-sent'
        ? await restoreShapontravelsCancellationNotSent(
            booking.id, session, operationRequest, claim.operationId,
            supplierFailure.reasonCode
          )
        : { ok: false, code: 'SUPPLIER_CANCELLATION_REVIEW_REQUIRED' };
      await recordSecurityAuditEvent({
        actorUserId: session.clerkId,
        actorRole: session.role,
        action: 'wallet.booking.cancel.failed',
        targetType: 'flight_booking',
        targetId: booking.id,
        outcome: 'failed',
        metadata: {
          reason: message.slice(0, 500), restored: restored.ok,
          code: restored.code ?? null, supplier: 'shapontravels',
        },
      });
      await dispatchBookingStatusEmails(booking.id);
      return restored.ok
        ? walletFail(502, 'BOOKING_CANCEL_NOT_SENT', 'Cancellation was not sent to Shapon. Please try again after access is restored.')
        : walletFail(503, 'CANCEL_RESTORE_FAILED', 'Cancellation needs support review before another attempt.');
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

/** Check the original Shapon cancellation using the saved booking GET only. */
export async function PATCH(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  const limit = await checkActionLimit('flightBookingCancel', `status:user:${session.clerkId}`);
  if (!limit.ok) return walletFail(429, 'RATE_LIMITED', 'Too many cancellation checks.');
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return walletFail(400, 'INVALID_CANCEL_REQUEST', 'Check the booking reference.');

  const booking = await readBookingByPublicRef(parsed.data.bookingReference, bookingScopeFor(session));
  if (!booking || booking.supplier !== 'shapontravels' || booking.supplier_account !== 'shapontravels' ||
      booking.import_source !== null || !shapontravelsCancellationReferencesReady(booking)) {
    return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  }
  const input = {
    ...booking.supplier_refs,
    supplier: booking.supplier_account,
    pnr: booking.pnr ?? '',
    bookingRefNumber: booking.booking_ref_number ?? '',
    bookingCodeRef: booking.booking_code_ref!,
    supplierPublicRef: booking.supplier_public_ref,
  };
  const operationRequest = createOperationRequestIdentity({
    clientRequestNonce: parsed.data.requestId,
    action: 'cancellation', subjectType: 'booking', subjectId: booking.id, payload: input,
  });
  try {
    const replay = await readBookingCancellationReplay(booking.id, session, operationRequest);
    if (replay?.state === 'succeeded') return walletOk({ status: 'cancelled' });
    if (replay?.state === 'failed' && replay.callStarted === false) return walletOk({ status: 'failed' });
    if (!replay) {
      const eligible = canCancelBooking(session, booking) && shapontravelsCancellationIdentityReady(booking);
      const saved = eligible ? await readSavedCancellation(booking.id, input) : null;
      // The first HTTP request may have failed before reaching Kaliganj. If
      // it arrives later, the ordinary atomic claim still sees the same key.
      return walletOk({ status: saved?.canRetry ? 'retry-available' : 'not-recorded' });
    }
    const refused = replay.state === 'failed' && replay.errorCode === 'SHAPON_CANCEL_REFUSED';
    if (!refused && !['supplier_call_started', 'needs_reconciliation'].includes(replay.state)) {
      return walletOk({ status: 'checking' });
    }
    const saved = await readSavedCancellation(booking.id, input);
    if (refused) {
      if (!saved) return walletOk({ status: 'refused' });
      const storage = await recordShapontravelsCurrentStatus({
        bookingId: booking.id, requestStartedAt: saved.requestStartedAt,
        expected: { ...input, bookingRefNumber: booking.booking_ref_number, pnr: booking.pnr,
          supplierPublicRef: saved.supplierPublicRef },
        status: saved.observation,
      });
      return walletOk({ status: storage.projectionUpdated ? 'failed' : 'refused' });
    }
    if (!saved?.closure) {
      return walletOk({ status: replay.state === 'needs_reconciliation' && replay.retryAvailable && saved?.canRetry
        ? 'retry-available' : 'checking' });
    }
    const finalized = await finalizeShaponPlatformCancellation(
      booking.id, session, operationRequest, replay.operationId, saved.closure
    );
    if (!finalized.ok) return walletOk({ status: 'checking' });
    if (!finalized.replay) {
      await dispatchBookingStatusEmails(booking.id).catch(() => undefined);
    }
    return walletOk({ status: 'cancelled' });
  } catch {
    return walletFail(503, 'CANCELLATION_REPLAY_UNAVAILABLE',
      'The saved cancellation result could not be checked. Try checking again.');
  }
}
