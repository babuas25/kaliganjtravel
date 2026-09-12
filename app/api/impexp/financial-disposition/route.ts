import { z } from 'zod';

import { bookingLifecycleRolloutEnabled } from '@/lib/booking-lifecycle/rollout';
import {
  canApproveBookingReconciliation,
  canExecuteApprovedBookingReconciliation,
  canProposeBookingFinancialOutcome,
} from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import { decideBookingReconciliation } from '@/lib/db/booking-reconciliation-actions';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import {
  executeImportedManualTicketFinancialDisposition,
  proposeImportedManualTicketFinancialDisposition,
} from '@/lib/db/impexp-financial-disposition';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { dispatchBookingStatusEmails } from '@/lib/email/booking-status-delivery';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const shared = {
  bookingReference: z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/),
  caseId: z.string().uuid(),
  expectedCaseVersion: z.number().int().positive(),
};
const schema = z.discriminatedUnion('action', [
  z.object({
    ...shared,
    action: z.literal('propose'),
    requestId: z.string().uuid(),
    financialDisposition: z.enum([
      'full_refund',
      'partial_refund',
      'no_refund_due',
      'externally_settled',
      'manual_adjustment_required',
    ]),
    financialAmount: z.number().int().positive().nullable(),
    financialCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    externalSettlementReference: z.string().trim().min(1).max(255).nullable(),
    reason: z.string().trim().min(1).max(1000),
    confirmed: z.literal(true),
  }),
  z.object({
    ...shared,
    action: z.literal('approve'),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    ...shared,
    action: z.literal('reject'),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    rejectionReason: z.string().trim().min(1).max(1000),
  }),
  z.object({
    ...shared,
    action: z.literal('execute'),
    proposalHash: z.string().regex(/^[a-f0-9]{64}$/),
    requestId: z.string().uuid(),
  }),
]);

const MESSAGE: Record<string, string> = {
  FRESH_NEGATIVE_IMPORTED_EVIDENCE_REQUIRED:
    'Support must Sync fresh matching cancelled, expired, or unconfirmed supplier evidence before this financial action.',
  FINANCIAL_PROPOSAL_FORBIDDEN:
    'Accounts or administrator access is required to propose a financial disposition.',
  FINANCIAL_EXECUTION_FORBIDDEN:
    'Administrator access is required to execute an approved disposition.',
  CAPTURED_PAYMENT_MISMATCH:
    'The captured amount does not match protected User Payable. Reconciliation must remain open.',
  CAPTURE_LEDGER_MISMATCH:
    'The original wallet capture could not be proven from exactly one immutable ledger row.',
  INVALID_PARTIAL_REFUND:
    'The partial refund must be positive, below the outstanding capture, and use the booking currency.',
  SETTLEMENT_REFERENCE_REQUIRED:
    'An external settlement reference is required.',
  SELF_APPROVAL_FORBIDDEN:
    'The proposal maker cannot approve their own high-risk disposition.',
  APPROVED_FINANCIAL_PROPOSAL_REQUIRED:
    'A current independently approved proposal is required before execution.',
  MANUAL_ADJUSTMENT_REQUIRED:
    'This case is explicitly held for manual financial adjustment and cannot be auto-closed.',
};

export async function POST(request: Request) {
  const session = await getDashboardSession();
  if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_IMPORTED_FINANCIAL_ACTION',
      parsed.error.issues[0]?.message ?? 'Check the financial action.'
    );
  }
  const input = parsed.data;
  const authorized =
    input.action === 'propose'
      ? canProposeBookingFinancialOutcome(session.role)
      : input.action === 'execute'
        ? canExecuteApprovedBookingReconciliation(session.role)
        : canApproveBookingReconciliation(session.role);
  if (!authorized) {
    return walletFail(
      403,
      'IMPORTED_FINANCIAL_ACTION_FORBIDDEN',
      'This imported financial action is forbidden.'
    );
  }
  if (!bookingLifecycleRolloutEnabled('importedActions')) {
    return walletFail(
      503,
      'IMPORTED_MANUAL_ACTIONS_DISABLED',
      'Imported financial actions are not enabled for this rollout stage.'
    );
  }
  const limit = await checkActionLimit(
    'bookingReconciliationWrite',
    `user:${session.clerkId}`
  );
  if (!limit.ok) {
    return walletFail(
      429,
      'IMPORTED_FINANCIAL_RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds),
      { retryAfterSeconds: limit.retryAfterSeconds }
    );
  }
  const booking = await readBookingByPublicRef(input.bookingReference, {
    kind: 'all',
  });
  if (!booking || booking.import_source !== 'IMP_EXP') {
    return walletFail(
      404,
      'IMPORTED_BOOKING_NOT_FOUND',
      'Imported booking not found.'
    );
  }

  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: `booking.impexp.financial_disposition.${input.action}`,
    targetType: 'flight_booking',
    targetId: booking.id,
    metadata: {
      caseId: input.caseId,
      expectedCaseVersion: input.expectedCaseVersion,
      financialDisposition:
        input.action === 'propose' ? input.financialDisposition : null,
      externalReferenceStored: false,
      reasonStored: false,
    },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'IMPORTED_FINANCIAL_AUDIT_UNAVAILABLE',
      'The financial action could not be audited and was not performed.'
    );
  }

  const result =
    input.action === 'propose'
      ? await proposeImportedManualTicketFinancialDisposition({
          actorUserId: session.clerkId,
          bookingId: booking.id,
          caseId: input.caseId,
          expectedCaseVersion: input.expectedCaseVersion,
          requestId: input.requestId,
          financialDisposition: input.financialDisposition,
          financialAmount: input.financialAmount,
          financialCurrency: input.financialCurrency,
          externalSettlementReference: input.externalSettlementReference,
          reason: input.reason,
        })
      : input.action === 'execute'
        ? await executeImportedManualTicketFinancialDisposition({
            actorUserId: session.clerkId,
            bookingId: booking.id,
            caseId: input.caseId,
            expectedCaseVersion: input.expectedCaseVersion,
            proposalHash: input.proposalHash,
            requestId: input.requestId,
          })
        : await decideBookingReconciliation({
            action: input.action,
            actorUserId: session.clerkId,
            bookingId: booking.id,
            caseId: input.caseId,
            expectedCaseVersion: input.expectedCaseVersion,
            proposalHash: input.proposalHash,
            ...(input.action === 'reject'
              ? { rejectionReason: input.rejectionReason }
              : {}),
          });
  if (!result.ok) {
    await recordSecurityAuditEvent({
      ...audit,
      outcome: 'failed',
      metadata: {
        ...audit.metadata,
        failureCode: result.code ?? 'IMPORTED_FINANCIAL_ACTION_FAILED',
      },
    });
    const code = result.code ?? 'IMPORTED_FINANCIAL_ACTION_FAILED';
    return walletFail(
      code.endsWith('_FORBIDDEN') ? 403 : 409,
      code,
      MESSAGE[code] ?? 'The imported financial action was not accepted.'
    );
  }

  if (input.action === 'execute') {
    await dispatchBookingStatusEmails(booking.id);
  }
  return walletOk(result);
}
