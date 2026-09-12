import { z } from 'zod';

import { bookingLifecycleRolloutEnabled } from '@/lib/booking-lifecycle/rollout';
import { canExecuteApprovedBookingReconciliation } from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  confirmBookingReconciliationCancelledCaptured,
  proposeBookingReconciliation,
  readBookingReconciliationActionState,
  resolveBookingReconciliationCancelledUnpaid,
} from '@/lib/db/booking-reconciliation-actions';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  caseId: z.string().uuid(),
  expectedCaseVersion: z.number().int().positive(),
  evidenceObservationId: z.string().uuid(),
  requestId: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000),
  confirmation: z.literal(true),
});

function failureMessage(code: string | undefined): string {
  if (code === 'INDEPENDENT_APPROVAL_REQUIRED') {
    return 'A different authorized reviewer must approve this high-risk proposal.';
  }
  if (code === 'AUTHORITATIVE_CANCELLATION_EVIDENCE_REQUIRED') {
    return 'Refresh a matching cancelled supplier report before confirming cancellation.';
  }
  if (code === 'BOOKING_NOT_CAPTURED_CANCELLATION_CONFIRMABLE') {
    return 'This booking is not in a safely supported captured-cancellation state.';
  }
  if (code === 'HELD_FINANCIAL_REVIEW_REQUIRED') {
    return 'An active payment hold needs a reviewed release outcome; it cannot be cancelled through the no-money confirmation path.';
  }
  if (code === 'TERMINAL_CORRECTION_REQUIRES_SEPARATE_REVIEW') {
    return 'A confirmed booking needs the existing terminal-correction review path. This cancellation-only action will not create a conflicting proposal.';
  }
  return 'The cancellation confirmation was not accepted. The booking and wallet remain protected.';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  const [session, { reference }] = await Promise.all([
    getDashboardSession(),
    params,
  ]);
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canExecuteApprovedBookingReconciliation(session.role)) {
    return walletFail(403, 'CANCELLATION_CONFIRMATION_FORBIDDEN', 'Resolution access is forbidden.');
  }
  if (!bookingLifecycleRolloutEnabled('reconciliationActions')) {
    return walletFail(503, 'RECONCILIATION_ACTIONS_DISABLED', 'Reconciliation actions are not enabled for this rollout stage.');
  }
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) {
    return walletFail(400, 'INVALID_BOOKING_REFERENCE', 'Check the booking reference.');
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return walletFail(400, 'INVALID_CANCELLATION_CONFIRMATION', parsed.error.issues[0]?.message ?? 'Check the confirmation.');
  }
  const limit = await checkActionLimit('bookingReconciliationWrite', `user:${session.clerkId}`);
  if (!limit.ok) {
    return walletFail(429, 'RECONCILIATION_RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds), {
      retryAfterSeconds: limit.retryAfterSeconds,
    });
  }

  const booking = await readBookingByPublicRef(reference, { kind: 'all' });
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  if (booking.payment_state === 'held') {
    return walletFail(
      409,
      'HELD_FINANCIAL_REVIEW_REQUIRED',
      'This booking has an active payment hold. A reviewed release outcome is required; no automatic release will be made.'
    );
  }
  if (booking.status === 'confirmed') {
    return walletFail(
      409,
      'TERMINAL_CORRECTION_REQUIRES_SEPARATE_REVIEW',
      'This confirmed booking needs a separately approved terminal-correction review. No cancellation proposal was created.'
    );
  }

  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'booking.reconciliation.confirm_cancelled',
    targetType: 'flight_booking',
    targetId: booking.id,
    metadata: {
      caseId: parsed.data.caseId,
      evidenceObservationId: parsed.data.evidenceObservationId,
      previousBookingStatus: booking.status,
      previousPaymentState: booking.payment_state,
      reasonRecorded: true,
      confirmationRecorded: true,
      supplierWrite: false,
      walletMutationRequested: false,
    },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(503, 'RECONCILIATION_AUDIT_UNAVAILABLE', 'The action could not be audited and was not submitted.');
  }

  try {
    const current = await readBookingReconciliationActionState(booking.id, parsed.data.caseId);
    if (!current) {
      await recordSecurityAuditEvent({ ...audit, outcome: 'failed', metadata: { ...audit.metadata, failureCode: 'CASE_NOT_FOUND' } });
      return walletFail(404, 'CASE_NOT_FOUND', 'Safety case not found for this booking.');
    }
    if (current.version !== parsed.data.expectedCaseVersion) {
      await recordSecurityAuditEvent({ ...audit, outcome: 'failed', metadata: { ...audit.metadata, failureCode: 'CASE_VERSION_CONFLICT' } });
      return walletFail(409, 'CASE_VERSION_CONFLICT', 'The case changed. Refresh it before confirming cancellation.');
    }

    let proposalHash = current.proposalHash;
    let caseVersion = current.version;
    const existingCancellationProposal =
      current.proposedOutcome === 'cancelled' &&
      current.financialDisposition === 'none' &&
      Boolean(proposalHash);

    if (!existingCancellationProposal) {
      const proposal = await proposeBookingReconciliation({
        bookingId: booking.id,
        caseId: parsed.data.caseId,
        expectedCaseVersion: parsed.data.expectedCaseVersion,
        requestKey: `reconciliation-cancelled-proposal:v1:${parsed.data.requestId}`,
        actorUserId: session.clerkId,
        domain: 'supplier_truth',
        proposedOutcome: 'cancelled',
        financialDisposition: 'none',
        financialAmount: null,
        financialCurrency: null,
        externalSettlementReference: null,
        evidenceObservationIds: [parsed.data.evidenceObservationId],
        confirmationCodes: ['confirm_supplier_outcome'],
        reason: parsed.data.reason,
      });
      if (!proposal.ok || !proposal.proposalHash || !proposal.caseVersion) {
        await recordSecurityAuditEvent({ ...audit, outcome: 'failed', metadata: { ...audit.metadata, failureCode: proposal.code ?? 'PROPOSAL_FAILED' } });
        return walletFail(409, proposal.code ?? 'CANCELLATION_PROPOSAL_FAILED', failureMessage(proposal.code));
      }
      proposalHash = proposal.proposalHash;
      caseVersion = proposal.caseVersion;
      if (proposal.makerCheckerRequired) {
        await recordSecurityAuditEvent({
          ...audit,
          outcome: 'succeeded',
          metadata: { ...audit.metadata, newCaseState: 'awaiting_approval', statusMutation: false, walletMutation: false, makerCheckerRequired: true },
        });
        return walletOk({
          ...proposal,
          pendingApproval: true,
          statusMutation: false,
          walletMutation: false,
        });
      }
    }

    const requestKey = `reconciliation-cancelled-confirmation:v1:${parsed.data.requestId}`;
    const result =
      booking.payment_state === 'unpaid' && booking.captured_amount === 0
        ? await resolveBookingReconciliationCancelledUnpaid({
            bookingId: booking.id,
            caseId: parsed.data.caseId,
            expectedCaseVersion: caseVersion,
            proposalHash: proposalHash!,
            actorUserId: session.clerkId,
            requestKey,
          })
        : await confirmBookingReconciliationCancelledCaptured({
            bookingId: booking.id,
            caseId: parsed.data.caseId,
            expectedCaseVersion: caseVersion,
            proposalHash: proposalHash!,
            actorUserId: session.clerkId,
            requestKey,
          });
    if (!result.ok) {
      await recordSecurityAuditEvent({ ...audit, outcome: 'failed', metadata: { ...audit.metadata, failureCode: result.code ?? 'CANCELLATION_CONFIRMATION_FAILED' } });
      return walletFail(409, result.code ?? 'CANCELLATION_CONFIRMATION_FAILED', failureMessage(result.code));
    }
    await recordSecurityAuditEvent({
      ...audit,
      outcome: 'succeeded',
      metadata: {
        ...audit.metadata,
        newBookingStatus: result.paymentState ? 'cancelled' : undefined,
        newPaymentState: result.paymentState,
        statusMutation: true,
        walletMutation: false,
        resolutionKind: result.resolutionKind,
      },
    });
    return walletOk(result);
  } catch (error) {
    console.error('[reconciliation] confirm cancelled failed:', error);
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed', metadata: { ...audit.metadata, failureCode: 'UNEXPECTED_CANCELLATION_CONFIRMATION_FAILURE' } });
    return walletFail(503, 'CANCELLATION_CONFIRMATION_UNAVAILABLE', 'The action could not be completed. No supplier write was sent.');
  }
}
