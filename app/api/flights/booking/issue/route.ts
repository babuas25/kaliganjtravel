import { NextRequest } from 'next/server';
import { z } from 'zod';
import { isBookingCurrency, UNSUPPORTED_CURRENCY_MESSAGE } from '@/lib/currency';

import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { createOperationRequestIdentity } from '@/lib/booking-lifecycle/operation-request';
import { storedTicketReferences } from '@/lib/booking-lifecycle/ticketing-flow';
import { classifySupplierWriteFailure } from '@/lib/booking-lifecycle/supplier-uncertainty';
import { bookingOperationSupplierWriteHooks } from '@/lib/booking-lifecycle/supplier-write-hooks';
import { reconcilePostTicketingRace } from '@/lib/booking-lifecycle/post-ticketing-reconciliation.server';
import { getDashboardSession } from '@/lib/dashboard/session';
import { recordSupplierWriteUncertainty } from '@/lib/db/booking-operations';
import { readBookingLocalTimeLimitContext } from '@/lib/db/booking-local-time-limit';
import {
  publicBookingWithHeaderContact,
  readBookingByPublicRef,
  syncAirTicketingDetails,
} from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { dispatchBookingStatusEmails } from '@/lib/email/booking-status-delivery';
import {
  beginLegacyManualIssue,
  beginBookingIssue,
  ensureWalletForOwner,
  failBookingIssue,
  finalizeBookingIssue,
  finalizeManualIssue,
  markReservationForReconciliation,
} from '@/lib/db/wallet';
import { checkActionLimit } from '@/lib/rate-limit';
import { TriploverError } from '@/lib/triplover/client';
import { getSupplierOperationalControls } from '@/lib/db/supplier-controls';
import { enrichIssuedTicket } from '@/lib/triplover/issued-ticket-enrichment';
import { isTriploverSupplier } from '@/lib/triplover/config';
import { issueTicket } from '@/lib/triplover/ticket';
import { walletFail, walletOk, walletOperationResponse } from '@/lib/wallet/http';
import { canIssueBooking } from '@/lib/wallet/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const schema = z.object({
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
  requestId: z.string().uuid(),
});

function supplierWalletIsInsufficient(error: unknown): boolean {
  return error instanceof TriploverError && error.kind === 'supplier' &&
    /(?:insufficient|not enough|low)\s+(?:api\s+|supplier\s+)?(?:wallet\s+)?balance|(?:api|supplier|wallet)[^.]{0,60}(?:insufficient|not enough|low)[^.]{0,30}balance|balance[^.]{0,40}(?:insufficient|not enough|too low)|(?:(?:you\s+)?(?:do not|don't|does not|doesn't)\s+have|have no)\s+(?:enough\s+)?balance|no\s+balance\s+for\s+(?:full\s+)?payment/i.test(error.message);
}

export async function GET(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  const supplierControls = await getSupplierOperationalControls();
  if (!supplierControls.ticketingEnabled) {
    return walletFail(
      503,
      'TICKETING_DISABLED',
      'Wallet ticket issuance is awaiting operational activation.'
    );
  }
  const reference = request.nextUrl.searchParams.get('reference') ?? '';
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) {
    return walletFail(
      400,
      'INVALID_BOOKING_REFERENCE',
      'Check the booking reference.'
    );
  }
  const booking = await readBookingByPublicRef(
    reference,
    bookingScopeFor(session)
  );
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if (!isBookingCurrency(booking.currency)) {
    return walletFail(409, 'UNSUPPORTED_CURRENCY', UNSUPPORTED_CURRENCY_MESSAGE);
  }
  if (booking.import_source === 'MANUAL' || booking.supplier !== 'triplover') {
    return walletFail(
      409,
      'EXTERNAL_SUPPLIER_BOOKING',
      booking.import_source === 'MANUAL'
        ? 'Manual bookings are issued only through the Manual Booking workflow.'
        : 'This imported booking must be managed in its external supplier system.'
    );
  }
  if (!isTriploverSupplier(booking.supplier_account)) {
    return walletFail(
      409,
      'SUPPLIER_ACCOUNT_UNAVAILABLE',
      'This booking was created before supplier-account tracking. Please contact support.'
    );
  }
  const localTimeLimit = await readBookingLocalTimeLimitContext(booking.id);
  if (
    localTimeLimit.localGrantActive &&
    localTimeLimit.localDeadlineAt &&
    Date.parse(localTimeLimit.localDeadlineAt) <= Date.now()
  ) {
    return walletFail(410, 'BOOKING_EXPIRED', 'The approved local ticketing deadline has passed.');
  }
  if (localTimeLimit.requestRequired && !localTimeLimit.localDeadlineActive) {
    return walletFail(
      409,
      'LOCAL_TIME_LIMIT_REQUIRED',
      'Request a verified local time limit before ticketing.'
    );
  }
  if (!canIssueBooking(session, booking)) {
    return walletFail(403, 'ISSUE_FORBIDDEN', 'You cannot issue this booking.');
  }
  if (!booking.booking_owner_type || !booking.booking_owner_key) {
    return walletFail(
      409,
      'BOOKING_OWNER_REQUIRED',
      'The booking has no wallet owner.'
    );
  }
  let wallet;
  try {
    wallet = await ensureWalletForOwner(
      {
        ownerType: booking.booking_owner_type,
        ownerKey: booking.booking_owner_key,
      },
      booking.currency
    );
  } catch {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }
  if (!wallet) {
    return walletFail(503, 'STORAGE_ERROR', 'Wallet storage is unavailable.');
  }
  return walletOk({
    wallet,
    requiredAmount: booking.payment_state === 'captured'
      ? 0
      : Math.round(Number(booking.pricing_snapshot.sellingPrice) * 100),
    paymentState: booking.payment_state,
  });
}

export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  const supplierControls = await getSupplierOperationalControls();
  if (!supplierControls.ticketingEnabled) {
    return walletFail(
      503,
      'TICKETING_DISABLED',
      'Wallet ticket issuance is awaiting operational activation.'
    );
  }
  const limit = await checkActionLimit(
    'flightTicketIssue',
    `user:${session.clerkId}`
  );
  if (!limit.ok) {
    return walletFail(429, 'RATE_LIMITED', 'Too many ticket-issuance attempts.');
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return walletFail(400, 'INVALID_ISSUE_REQUEST', 'Check the booking reference.');
  }
  const booking = await readBookingByPublicRef(
    parsed.data.bookingReference,
    bookingScopeFor(session)
  );
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if (!isBookingCurrency(booking.currency)) {
    return walletFail(409, 'UNSUPPORTED_CURRENCY', UNSUPPORTED_CURRENCY_MESSAGE);
  }
  if (booking.import_source === 'MANUAL' || booking.supplier !== 'triplover') {
    return walletFail(
      409,
      'EXTERNAL_SUPPLIER_BOOKING',
      booking.import_source === 'MANUAL'
        ? 'Manual bookings are issued only through the Manual Booking workflow.'
        : 'This imported booking must be managed in its external supplier system.'
    );
  }
  if (!isTriploverSupplier(booking.supplier_account)) {
    return walletFail(
      409,
      'SUPPLIER_ACCOUNT_UNAVAILABLE',
      'This booking was created before supplier-account tracking. Please contact support.'
    );
  }
  const supplierAccount = booking.supplier_account;
  const localTimeLimit = await readBookingLocalTimeLimitContext(booking.id);
  if (
    localTimeLimit.localGrantActive &&
    localTimeLimit.localDeadlineAt &&
    Date.parse(localTimeLimit.localDeadlineAt) <= Date.now()
  ) {
    return walletFail(410, 'BOOKING_EXPIRED', 'The approved local ticketing deadline has passed.');
  }
  if (localTimeLimit.requestRequired && !localTimeLimit.localDeadlineActive) {
    return walletFail(
      409,
      'LOCAL_TIME_LIMIT_REQUIRED',
      'Request a verified local time limit before ticketing.'
    );
  }
  if (!canIssueBooking(session, booking)) {
    return walletFail(403, 'ISSUE_FORBIDDEN', 'You cannot issue this booking.');
  }
  const refs = storedTicketReferences(booking);
  if (!refs) {
    return walletFail(
      409,
      'SUPPLIER_REFERENCES_MISSING',
      'This booking is missing supplier references and needs reconciliation.'
    );
  }

  const manuallyQueued = booking.status === 'pending' && booking.payment_state === 'captured';
  const supplierInput = {
    ...refs,
    supplier: supplierAccount,
    expectedPassengerCount: booking.passenger_counts
      ? Object.values(booking.passenger_counts).reduce((sum, count) => sum + count, 0)
      : undefined,
  };
  const operationRequest = createOperationRequestIdentity({
    clientRequestNonce: parsed.data.requestId,
    action: 'ticketing',
    subjectType: 'booking',
    subjectId: booking.id,
    payload: supplierInput,
  });
  const reserved = manuallyQueued
    ? await beginLegacyManualIssue(
        booking.id,
        session,
        operationRequest
      )
    : await beginBookingIssue(
        booking.id,
        session,
        operationRequest
      );
  if (!reserved.ok) {
    if (reserved.code === 'STORAGE_ERROR') {
      await markReservationForReconciliation(
        { bookingId: booking.id },
        'Wallet reservation response was lost before supplier ticketing started'
      );
      return walletFail(
        503,
        'WALLET_RESERVATION_UNKNOWN',
        'No airline request was sent, but the wallet reservation outcome needs Accounts review.'
      );
    }
    return walletOperationResponse(reserved);
  }
  if (reserved.replay) {
    const replayed = await readBookingByPublicRef(
      parsed.data.bookingReference,
      bookingScopeFor(session)
    );
    return walletOk({
      replay: true,
      operationId: reserved.operationId ?? null,
      booking: replayed
        ? await publicBookingWithHeaderContact(replayed)
        : null,
    });
  }
  if (!reserved.operationId) {
    return walletFail(
      503,
      'OPERATION_IDENTITY_MISSING',
      'Ticketing was not sent to the airline because its operation identity could not be verified.'
    );
  }
  const supplierLifecycle = bookingOperationSupplierWriteHooks(
    reserved.operationId,
    operationRequest
  );

  try {
    const outcome = await issueTicket(supplierInput, supplierLifecycle);
    const { outcome: enrichedOutcome, ticketDetails } = await enrichIssuedTicket(
      outcome, refs.uniqueTransId, supplierAccount
    );
    const captured = manuallyQueued
      ? await finalizeManualIssue(
          booking.id,
          session,
          operationRequest,
          reserved.operationId,
          enrichedOutcome
        )
      : await finalizeBookingIssue(
          booking.id,
          session,
          operationRequest,
          reserved.operationId,
          enrichedOutcome
        );
    if (!captured.ok) {
      await recordSecurityAuditEvent({
        actorUserId: session.clerkId,
        actorRole: session.role,
        action: 'wallet.booking.issue.capture_failed',
        targetType: 'flight_booking',
        targetId: booking.id,
        outcome: 'failed',
        metadata: { code: captured.code ?? null },
      });
      await dispatchBookingStatusEmails(booking.id);
      return walletFail(
        503,
        'PAYMENT_RECONCILIATION_REQUIRED',
        'Tickets were issued, but payment finalization needs reconciliation. Do not submit again.'
      );
    }
    if (ticketDetails) {
      try {
        await syncAirTicketingDetails(
          booking.id, ticketDetails, session, 'ordinary_sync'
        );
      } catch (terminalRefreshError) {
        console.error('[booking] ticket terminal refresh after issue failed:', terminalRefreshError);
      }
    }
    const updated = await readBookingByPublicRef(
      parsed.data.bookingReference,
      bookingScopeFor(session)
    );
    if (updated) {
      try {
        await reconcilePostTicketingRace({
          booking: updated,
          operationId: reserved.operationId,
        });
      } catch (reconciliationError) {
        // Ticketing and wallet capture are already complete. The open case and
        // watchdog remain authoritative if the fresh verifier is unavailable.
        console.error(
          '[booking] post-ticketing race reconciliation failed:',
          reconciliationError
        );
      }
    }
    if (updated) await dispatchBookingStatusEmails(updated.id);
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'wallet.booking.issue',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'succeeded',
      metadata: { walletAccountId: reserved.accountId ?? null },
    });
    return walletOk({
      booking: updated ? await publicBookingWithHeaderContact(updated) : null,
      wallet: captured,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Supplier issue failed';
    const supplierFailure = classifySupplierWriteFailure(
      error,
      supplierLifecycle.boundarySnapshot()
    );
    const supplierBalanceUnverified = supplierWalletIsInsufficient(error);
    if (
      supplierFailure.failureClass === 'uncertain' ||
      supplierBalanceUnverified
    ) {
      const recorded =
        supplierFailure.failureClass === 'uncertain'
          ? await recordSupplierWriteUncertainty({
              subject: {
                bookingId: booking.id,
                operationId: reserved.operationId,
              },
              actorUserId: session.clerkId,
              actorRole: session.role,
              request: operationRequest,
              classification: supplierFailure,
              errorMessage: message,
            })
          : { ok: false };
      if (!recorded.ok) {
        await markReservationForReconciliation(
          { bookingId: booking.id },
          `${supplierFailure.reasonCode}: ${message}`
        );
      }
      await recordSecurityAuditEvent({
        actorUserId: session.clerkId,
        actorRole: session.role,
        action: supplierBalanceUnverified
          ? 'wallet.booking.issue.supplier_balance_unverified'
          : 'wallet.booking.issue.unknown',
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
        supplierBalanceUnverified
          ? 'SUPPLIER_BALANCE_RECONCILIATION_REQUIRED'
          : 'ISSUE_OUTCOME_UNKNOWN',
        supplierBalanceUnverified
          ? 'Supplier funding may be insufficient. Your payment position is preserved while Accounts verifies the ticket; do not submit again.'
          : 'The airline outcome is unknown. Funds remain protected; do not submit again.'
      );
    }

    if (manuallyQueued) {
      await markReservationForReconciliation({ bookingId: booking.id }, message);
      await dispatchBookingStatusEmails(booking.id);
      return walletFail(
        503,
        'LEGACY_PAYMENT_RECONCILIATION_REQUIRED',
        'This previously paid manual ticket could not be issued. Accounts must reconcile it before another attempt.'
      );
    }

    const released = await failBookingIssue(
      booking.id,
      session,
      operationRequest,
      reserved.operationId,
      message
    );
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: 'wallet.booking.issue.failed',
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'failed',
      metadata: { released: released.ok, reason: message.slice(0, 500) },
    });
    await dispatchBookingStatusEmails(booking.id);
    return released.ok
      ? walletFail(
          502,
          'TICKET_ISSUE_FAILED',
          'The airline declined ticket issuance. The full wallet hold was released.'
        )
      : walletFail(
          503,
          'HOLD_RELEASE_FAILED',
          'Issuance failed, but the wallet hold could not be released automatically. Contact Accounts.'
        );
  }
}
