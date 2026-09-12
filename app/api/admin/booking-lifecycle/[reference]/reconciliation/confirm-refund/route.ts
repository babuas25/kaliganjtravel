import { z } from 'zod';

import { bookingLifecycleRolloutEnabled } from '@/lib/booking-lifecycle/rollout';
import { canExecuteApprovedBookingReconciliation } from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  readBookingReconciliationActionState,
  resolveBookingReconciliationRefund,
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
  proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceObservationId: z.string().uuid(),
  requestId: z.string().uuid(),
  confirmation: z.literal(true),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  const [session, { reference }] = await Promise.all([getDashboardSession(), params]);
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canExecuteApprovedBookingReconciliation(session.role)) {
    return walletFail(403, 'REFUND_CONFIRMATION_FORBIDDEN', 'Refund resolution access is forbidden.');
  }
  if (!bookingLifecycleRolloutEnabled('reconciliationActions')) {
    return walletFail(503, 'RECONCILIATION_ACTIONS_DISABLED', 'Reconciliation actions are not enabled for this rollout stage.');
  }
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) return walletFail(400, 'INVALID_BOOKING_REFERENCE', 'Check the booking reference.');
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return walletFail(400, 'INVALID_REFUND_CONFIRMATION', parsed.error.issues[0]?.message ?? 'Check the confirmation.');
  const limit = await checkActionLimit('bookingReconciliationWrite', `user:${session.clerkId}`);
  if (!limit.ok) return walletFail(429, 'RECONCILIATION_RATE_LIMITED', rateLimitMessage(limit.retryAfterSeconds), { retryAfterSeconds: limit.retryAfterSeconds });

  const booking = await readBookingByPublicRef(reference, { kind: 'all' });
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'booking.reconciliation.confirm_refund',
    targetType: 'flight_booking',
    targetId: booking.id,
    metadata: {
      caseId: parsed.data.caseId,
      evidenceObservationId: parsed.data.evidenceObservationId,
      previousBookingStatus: booking.status,
      previousPaymentState: booking.payment_state,
      proposalReasonAlreadyRecorded: true,
      confirmationRecorded: true,
      supplierWrite: false,
    },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(503, 'RECONCILIATION_AUDIT_UNAVAILABLE', 'The refund could not be audited and was not submitted.');
  }

  const current = await readBookingReconciliationActionState(booking.id, parsed.data.caseId);
  if (!current || current.version !== parsed.data.expectedCaseVersion || current.proposalHash !== parsed.data.proposalHash) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed', metadata: { ...audit.metadata, failureCode: 'CASE_VERSION_CONFLICT' } });
    return walletFail(409, 'CASE_VERSION_CONFLICT', 'The case changed. Refresh it before confirming a refund.');
  }
  if (!current.approvedAt || current.state !== 'awaiting_approval') {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed', metadata: { ...audit.metadata, failureCode: 'INDEPENDENT_APPROVAL_REQUIRED' } });
    return walletFail(409, 'INDEPENDENT_APPROVAL_REQUIRED', 'A different authorized reviewer must approve the financial proposal first.');
  }
  if (current.financialDisposition !== 'full_refund' && current.financialDisposition !== 'partial_refund') {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed', metadata: { ...audit.metadata, failureCode: 'REFUND_DISPOSITION_REQUIRED' } });
    return walletFail(409, 'REFUND_DISPOSITION_REQUIRED', 'Only an approved full or partial refund can use Confirm Refund.');
  }

  const result = await resolveBookingReconciliationRefund({
    bookingId: booking.id,
    caseId: parsed.data.caseId,
    expectedCaseVersion: parsed.data.expectedCaseVersion,
    proposalHash: parsed.data.proposalHash,
    actorUserId: session.clerkId,
    requestKey: `reconciliation-refund-confirmation:v1:${parsed.data.requestId}`,
    disposition: current.financialDisposition,
  });
  if (!result.ok) {
    await recordSecurityAuditEvent({ ...audit, outcome: 'failed', metadata: { ...audit.metadata, failureCode: result.code ?? 'REFUND_CONFIRMATION_FAILED', financialDisposition: current.financialDisposition } });
    return walletFail(409, result.code ?? 'REFUND_CONFIRMATION_FAILED', 'The approved refund was not completed. The wallet remains protected.');
  }
  await recordSecurityAuditEvent({ ...audit, outcome: 'succeeded', metadata: { ...audit.metadata, newBookingStatus: 'cancelled', newPaymentState: result.paymentState, financialDisposition: current.financialDisposition, refundAmount: result.refundAmount ?? null, walletMutation: result.walletMutation === true } });
  return walletOk(result);
}
