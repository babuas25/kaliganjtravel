import { z } from 'zod';

import { bookingLifecycleRolloutEnabled } from '@/lib/booking-lifecycle/rollout';
import { bookingReconciliationProposalAuthority } from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import { proposeBookingReconciliation } from '@/lib/db/booking-reconciliation-actions';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const confirmationCode = z.enum([
  'confirm_supplier_outcome',
  'confirm_held_nonissuance_basis',
  'confirm_terminal_correction',
  'confirm_supplier_identity_exception',
  'confirm_incomplete_evidence_exception',
  'confirm_legacy_review_path',
  'confirm_financial_disposition',
  'confirm_fee_or_no_refund',
  'confirm_external_settlement',
  'confirm_historical_repair',
  'confirm_manual_resolution_basis',
]);
const bodySchema = z.object({
  caseId: z.string().uuid(),
  expectedCaseVersion: z.number().int().positive(),
  requestId: z.string().uuid(),
  domain: z.enum([
    'supplier_truth',
    'financial',
    'combined_supplier_financial',
  ]),
  proposedOutcome: z.enum([
    'ticketed',
    'cancelled',
    'held_not_ticketed',
    'financial_only',
    'historical_repair',
  ]),
  financialDisposition: z.enum([
    'none',
    'capture_existing_hold',
    'release_existing_hold',
    'full_refund',
    'partial_refund',
    'no_refund_due',
    'externally_settled',
    'manual_adjustment_required',
  ]),
  financialAmount: z.number().int().positive().nullable().default(null),
  financialCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
  externalSettlementReference: z.string().trim().min(1).max(255).nullable().default(null),
  evidenceObservationIds: z.array(z.string().uuid()).min(1).max(20),
  confirmationCodes: z.array(confirmationCode).min(1).max(20),
  reason: z.string().trim().min(1).max(1000),
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
      'INVALID_RECONCILIATION_PROPOSAL',
      parsed.error.issues[0]?.message ?? 'Check the proposal.'
    );
  }
  const authority = bookingReconciliationProposalAuthority({
    role: session.role,
    domain: parsed.data.domain,
    riskFlags: [],
  });
  if (!authority.proposalAllowed) {
    return walletFail(403, authority.reasonCode.toUpperCase(), 'Proposal access is forbidden.');
  }
  if (!bookingLifecycleRolloutEnabled('reconciliationActions')) {
    return walletFail(
      503,
      'RECONCILIATION_ACTIONS_DISABLED',
      'Reconciliation proposals are not enabled for this rollout stage.'
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
    action: 'booking.reconciliation.proposal_request',
    targetType: 'flight_booking',
    targetId: booking.id,
    metadata: {
      caseId: parsed.data.caseId,
      domain: parsed.data.domain,
      proposedOutcome: parsed.data.proposedOutcome,
      financialDisposition: parsed.data.financialDisposition,
      proposalBodyStored: false,
    },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'RECONCILIATION_AUDIT_UNAVAILABLE',
      'The proposal could not be audited and was not submitted.'
    );
  }
  const result = await proposeBookingReconciliation({
    bookingId: booking.id,
    caseId: parsed.data.caseId,
    expectedCaseVersion: parsed.data.expectedCaseVersion,
    requestKey: `reconciliation-proposal:v1:${parsed.data.requestId}`,
    actorUserId: session.clerkId,
    domain: parsed.data.domain,
    proposedOutcome: parsed.data.proposedOutcome,
    financialDisposition: parsed.data.financialDisposition,
    financialAmount: parsed.data.financialAmount,
    financialCurrency: parsed.data.financialCurrency,
    externalSettlementReference: parsed.data.externalSettlementReference,
    evidenceObservationIds: parsed.data.evidenceObservationIds,
    confirmationCodes: parsed.data.confirmationCodes,
    reason: parsed.data.reason,
  });
  if (!result.ok) {
    await recordSecurityAuditEvent({
      ...audit,
      outcome: 'failed',
      metadata: { ...audit.metadata, failureCode: result.code ?? 'PROPOSAL_FAILED' },
    });
    return walletFail(
      result.code === 'PROPOSAL_FORBIDDEN' ? 403 : 409,
      result.code ?? 'RECONCILIATION_PROPOSAL_FAILED',
      'The reconciliation proposal was not accepted.'
    );
  }
  return walletOk(result);
}
