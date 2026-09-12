import { z } from 'zod';

import { bookingLifecycleRolloutEnabled } from '@/lib/booking-lifecycle/rollout';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  supersedeStaleApprovedBookingReconciliation,
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
  requestId: z.string().uuid(),
  reason: z.string().trim().min(3).max(1000),
  confirmation: z.literal(true),
});

function failureMessage(code: string | undefined): string {
  switch (code) {
    case 'SUPERSESSION_FORBIDDEN':
      return 'Only a Super Admin may supersede an approved stale proposal.';
    case 'APPROVED_PROPOSAL_REQUIRED':
    case 'STALE_TICKETED_CAPTURE_PROPOSAL_REQUIRED':
      return 'Only an unresolved approved ticketed-capture proposal can be superseded.';
    case 'PROPOSAL_EVIDENCE_NOT_EXPIRED':
      return 'The proposal-bound evidence is still fresh. The approved proposal remains executable.';
    case 'EVIDENCE_CASE_MISMATCH':
    case 'PROPOSAL_EVIDENCE_INVALID':
      return 'The proposal evidence cannot be safely superseded. No case or financial change was made.';
    case 'BOOKING_NOT_STALE_CAPTURE_RECONCILIATION':
    case 'OPERATION_NOT_RECONCILING':
    case 'CASE_OPERATION_CHANGED':
      return 'The protected booking or operation changed. Refresh the case before taking any action.';
    case 'CASE_VERSION_CONFLICT':
      return 'The case changed. Refresh it before superseding the stale proposal.';
    case 'PROPOSAL_ALREADY_SUPERSEDED':
    case 'PROPOSAL_SUPERSEDED':
      return 'This approved proposal was already superseded. Refresh the open successor case.';
    default:
      return 'The stale approved proposal was not superseded. No booking, supplier, or wallet action was taken.';
  }
}

/**
 * Creates an auditable successor review cycle for exactly one stale approved
 * ticketed-capture proposal. This endpoint never reads/writes a supplier and
 * never touches booking, reservation, wallet, ledger, or payment truth.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  const [session, { reference }] = await Promise.all([
    getDashboardSession(),
    params,
  ]);
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  if (session.role !== 'superadmin') {
    return walletFail(
      403,
      'SUPERSESSION_FORBIDDEN',
      'Only a Super Admin may supersede an approved stale proposal.'
    );
  }
  if (!bookingLifecycleRolloutEnabled('reconciliationActions')) {
    return walletFail(
      503,
      'RECONCILIATION_ACTIONS_DISABLED',
      'Reconciliation actions are not enabled for this rollout stage.'
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
      'INVALID_PROPOSAL_SUPERSESSION',
      parsed.error.issues[0]?.message ?? 'Check the supersession confirmation.'
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

  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: 'booking.reconciliation.supersede_stale_approved_proposal_request',
    targetType: 'flight_booking',
    targetId: booking.id,
    metadata: {
      caseId: parsed.data.caseId,
      proposalHash: parsed.data.proposalHash,
      supersedeReasonRecorded: true,
      bookingMutation: false,
      walletMutation: false,
      reservationMutation: false,
      ledgerMutation: false,
      supplierWrite: false,
    },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'RECONCILIATION_AUDIT_UNAVAILABLE',
      'The supersession could not be audited and was not submitted.'
    );
  }

  const result = await supersedeStaleApprovedBookingReconciliation({
    bookingId: booking.id,
    caseId: parsed.data.caseId,
    expectedCaseVersion: parsed.data.expectedCaseVersion,
    proposalHash: parsed.data.proposalHash,
    actorUserId: session.clerkId,
    requestKey: `reconciliation-stale-proposal-supersede:v1:${parsed.data.requestId}`,
    reason: parsed.data.reason,
  });
  if (!result.ok) {
    await recordSecurityAuditEvent({
      ...audit,
      outcome: 'failed',
      metadata: {
        ...audit.metadata,
        failureCode: result.code ?? 'PROPOSAL_SUPERSESSION_FAILED',
      },
    });
    return walletFail(
      result.code === 'SUPERSESSION_FORBIDDEN' ? 403 : 409,
      result.code ?? 'PROPOSAL_SUPERSESSION_FAILED',
      failureMessage(result.code)
    );
  }

  await recordSecurityAuditEvent({
    ...audit,
    outcome: 'succeeded',
    metadata: {
      ...audit.metadata,
      replay: result.replay === true,
      supersessionId: result.supersessionId ?? null,
      successorCaseId: result.successorCaseId ?? null,
      requiresFreshEvidence: result.requiresFreshEvidence === true,
    },
  });
  return walletOk(result);
}
