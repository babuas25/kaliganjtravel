import { z } from 'zod';

import { bookingLifecycleRolloutEnabled } from '@/lib/booking-lifecycle/rollout';
import { canExecuteApprovedBookingReconciliation } from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  readBookingReconciliationActionState,
  resolveBookingReconciliationTicketed,
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
  confirmation: z.literal(true),
});

function failureMessage(code: string | undefined): string {
  switch (code) {
    case 'INDEPENDENT_APPROVAL_REQUIRED':
      return 'A different authorized reviewer must approve this ticketed capture first.';
    case 'AUTHORITATIVE_TICKET_EVIDENCE_REQUIRED':
    case 'TICKET_EVIDENCE_INCOMPLETE':
      return 'Refresh complete, matching ticket evidence before capturing the protected hold.';
    case 'TICKETED_PROPOSAL_REQUIRED':
    case 'CAPTURE_DISPOSITION_REQUIRED':
      return 'This action requires an approved ticketed capture proposal.';
    case 'SUPPLIER_UNIQUE_TRANS_ID_MISMATCH':
      return 'Supplier booking identity does not match the protected booking. No capture was made.';
    case 'FRESH_CASE_EVIDENCE_REQUIRED':
      return 'Evidence expired before execution. Record fresh evidence and submit a new reviewed proposal.';
    case 'BOOKING_STATE_CHANGED':
    case 'CASE_VERSION_CONFLICT':
    case 'PROPOSAL_CHANGED':
      return 'The case changed. Refresh it before attempting the approved capture.';
    default:
      return 'The approved ticketed capture was not completed. The existing hold remains protected.';
  }
}

/**
 * Executes one already-approved ticketed reconciliation. This endpoint never
 * calls NewTicket, reads a supplier, creates a reservation, or uses a generic
 * wallet capture path. The database RPC owns the exact atomic transition.
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
  if (!canExecuteApprovedBookingReconciliation(session.role)) {
    return walletFail(403, 'TICKETED_CAPTURE_FORBIDDEN', 'Resolution access is forbidden.');
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
      'INVALID_TICKETED_CAPTURE_CONFIRMATION',
      parsed.error.issues[0]?.message ?? 'Check the confirmation.'
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
    action: 'booking.reconciliation.confirm_ticketed',
    targetType: 'flight_booking',
    targetId: booking.id,
    metadata: {
      caseId: parsed.data.caseId,
      proposalHash: parsed.data.proposalHash,
      previousBookingStatus: booking.status,
      previousPaymentState: booking.payment_state,
      financialDisposition: 'capture_existing_hold',
      supplierWrite: false,
      newTicketRequest: false,
      genericWalletCapture: false,
    },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'RECONCILIATION_AUDIT_UNAVAILABLE',
      'The ticketed capture could not be audited and was not submitted.'
    );
  }

  const current = await readBookingReconciliationActionState(
    booking.id,
    parsed.data.caseId
  );
  if (
    !current ||
    current.version !== parsed.data.expectedCaseVersion ||
    current.proposalHash !== parsed.data.proposalHash
  ) {
    await recordSecurityAuditEvent({
      ...audit,
      outcome: 'failed',
      metadata: { ...audit.metadata, failureCode: 'CASE_VERSION_CONFLICT' },
    });
    return walletFail(
      409,
      'CASE_VERSION_CONFLICT',
      'The case changed. Refresh it before confirming ticketed capture.'
    );
  }
  if (!current.approvedAt || current.state !== 'awaiting_approval') {
    await recordSecurityAuditEvent({
      ...audit,
      outcome: 'failed',
      metadata: { ...audit.metadata, failureCode: 'INDEPENDENT_APPROVAL_REQUIRED' },
    });
    return walletFail(
      409,
      'INDEPENDENT_APPROVAL_REQUIRED',
      'A different authorized reviewer must approve the ticketed capture first.'
    );
  }
  if (
    current.proposedOutcome !== 'ticketed' ||
    current.financialDisposition !== 'capture_existing_hold'
  ) {
    await recordSecurityAuditEvent({
      ...audit,
      outcome: 'failed',
      metadata: { ...audit.metadata, failureCode: 'TICKETED_PROPOSAL_REQUIRED' },
    });
    return walletFail(
      409,
      'TICKETED_PROPOSAL_REQUIRED',
      'Only an approved ticketed capture proposal can use this action.'
    );
  }

  const result = await resolveBookingReconciliationTicketed({
    bookingId: booking.id,
    caseId: parsed.data.caseId,
    expectedCaseVersion: parsed.data.expectedCaseVersion,
    proposalHash: parsed.data.proposalHash,
    actorUserId: session.clerkId,
    requestKey: `reconciliation-ticketed-confirmation:v1:${parsed.data.requestId}`,
  });
  if (!result.ok) {
    await recordSecurityAuditEvent({
      ...audit,
      outcome: 'failed',
      metadata: {
        ...audit.metadata,
        failureCode: result.code ?? 'TICKETED_CAPTURE_FAILED',
      },
    });
    return walletFail(
      409,
      result.code ?? 'TICKETED_CAPTURE_FAILED',
      failureMessage(result.code)
    );
  }

  await recordSecurityAuditEvent({
    ...audit,
    outcome: 'succeeded',
    metadata: {
      ...audit.metadata,
      newBookingStatus: result.bookingStatus ?? 'confirmed',
      newPaymentState: result.paymentState ?? 'captured',
      capturedAmount: result.capturedAmount ?? null,
      ledgerEntryId: result.ledgerEntryId ?? null,
      supplierUniqueTransId: result.supplierUniqueTransId ?? null,
      supplierInternalBookingId: result.supplierInternalBookingId ?? null,
      walletMutation: result.walletMutation === true,
      resolutionKind: result.resolutionKind,
    },
  });
  return walletOk(result);
}
