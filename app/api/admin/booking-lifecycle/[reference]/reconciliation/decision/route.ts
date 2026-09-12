import { z } from 'zod';

import { bookingLifecycleRolloutEnabled } from '@/lib/booking-lifecycle/rollout';
import { canApproveBookingReconciliation } from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import { decideBookingReconciliation } from '@/lib/db/booking-reconciliation-actions';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    action: z.enum(['approve', 'reject']),
    caseId: z.string().uuid(),
    expectedCaseVersion: z.number().int().positive(),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    rejectionReason: z.string().trim().min(1).max(1000).optional(),
  })
  .superRefine((value, context) => {
    if (value.action === 'reject' && !value.rejectionReason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejectionReason'],
        message: 'A rejection reason is required.',
      });
    }
  });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  const [session, { reference }] = await Promise.all([
    getDashboardSession(),
    params,
  ]);
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (!canApproveBookingReconciliation(session.role)) {
    return walletFail(403, 'RECONCILIATION_DECISION_FORBIDDEN', 'Approval access is forbidden.');
  }
  if (!bookingLifecycleRolloutEnabled('reconciliationActions')) {
    return walletFail(
      503,
      'RECONCILIATION_ACTIONS_DISABLED',
      'Reconciliation decisions are not enabled for this rollout stage.'
    );
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
    return walletFail(
      400,
      'INVALID_RECONCILIATION_DECISION',
      parsed.error.issues[0]?.message ?? 'Check the decision.'
    );
  }
  const limit = await checkActionLimit(
    'bookingReconciliationWrite',
    `user:${session.clerkId}`
  );
  if (!limit.ok) {
    return walletFail(
      429,
      'RECONCILIATION_RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds),
      { retryAfterSeconds: limit.retryAfterSeconds }
    );
  }
  const booking = await readBookingByPublicRef(reference, { kind: 'all' });
  if (!booking) return walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
  const result = await decideBookingReconciliation({
    action: parsed.data.action,
    bookingId: booking.id,
    caseId: parsed.data.caseId,
    expectedCaseVersion: parsed.data.expectedCaseVersion,
    proposalHash: parsed.data.proposalHash,
    actorUserId: session.clerkId,
    rejectionReason: parsed.data.rejectionReason,
  });
  if (!result.ok) {
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: `booking.reconciliation.${parsed.data.action}_request`,
      targetType: 'flight_booking',
      targetId: booking.id,
      outcome: 'failed',
      metadata: {
        caseId: parsed.data.caseId,
        proposalHash: parsed.data.proposalHash,
        failureCode: result.code ?? 'DECISION_FAILED',
        rejectionReasonStored: false,
      },
    });
    return walletFail(
      result.code === 'APPROVAL_FORBIDDEN' || result.code === 'REJECTION_FORBIDDEN'
        ? 403
        : 409,
      result.code ?? 'RECONCILIATION_DECISION_FAILED',
      'The reconciliation decision was not accepted.'
    );
  }
  return walletOk(result);
}
