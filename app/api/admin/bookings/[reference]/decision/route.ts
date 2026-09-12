import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import { readBookingByPublicRefForSuperAdmin } from '@/lib/db/flight-bookings';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import {
  executeSuperAdminIssueResolution,
  executeSuperAdminManualFinancialResolution,
  previewSuperAdminIssueResolution,
  previewSuperAdminManualFinancialResolution,
  SUPERADMIN_MANUAL_WALLET_ACTIONS,
  SUPERADMIN_REFUND_DISPOSITIONS,
  SUPERADMIN_SUPPLIER_OUTCOMES,
} from '@/lib/db/superadmin-booking-decisions';
import { dispatchBookingStatusEmails } from '@/lib/email/booking-status-delivery';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supplierOutcome = z.enum(SUPERADMIN_SUPPLIER_OUTCOMES);
const refundDisposition = z.enum(SUPERADMIN_REFUND_DISPOSITIONS);
const manualWalletAction = z.enum(SUPERADMIN_MANUAL_WALLET_ACTIONS);
const nullableText = z.string().trim().max(255).nullable().optional();
const nullableNote = z.string().trim().max(1000).nullable().optional();
const nullableDeadline = z.string().datetime({ offset: true }).nullable().optional();
const nullableCurrency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/)
  .transform((value) => value.toUpperCase())
  .nullable()
  .optional();

const automaticPreviewSchema = z
  .object({
    mode: z.literal('automatic'),
    supplierOutcome,
    refundDisposition: refundDisposition.nullable().optional(),
    refundAmount: z.coerce.number().int().positive().nullable().optional(),
    externalSettlementReference: nullableText,
    newDeadlineAt: nullableDeadline,
  })
  .strict();

const manualPreviewSchema = z
  .object({
    mode: z.literal('manual'),
    supplierOutcome,
    issueNowCaseConfirmed: z.boolean(),
    customerWalletAction: manualWalletAction,
    customerWalletAmount: z.coerce.number().int().nonnegative(),
    customerAmountBasis: z.string().trim().max(1000).nullable().optional(),
    supplierReference: nullableText,
    supplierAmount: z.coerce.number().int().positive().nullable().optional(),
    supplierCurrency: nullableCurrency,
    newDeadlineAt: nullableDeadline,
  })
  .strict();

const automaticExecuteSchema = automaticPreviewSchema
  .extend({
    requestId: z.string().uuid(),
    note: nullableNote,
    moneyMovementConfirmed: z.boolean(),
  })
  .strict();

const manualExecuteSchema = manualPreviewSchema
  .extend({
    requestId: z.string().uuid(),
    note: nullableNote,
    manualEffectConfirmed: z.boolean(),
  })
  .strict();

const previewSchema = z.discriminatedUnion('mode', [
  automaticPreviewSchema,
  manualPreviewSchema,
]);
const executeSchema = z.discriminatedUnion('mode', [
  automaticExecuteSchema,
  manualExecuteSchema,
]);

const MESSAGE: Record<string, string> = {
  SUPERADMIN_DECISION_FORBIDDEN: 'Only Super Admin can make this booking decision.',
  BOOKING_NOT_FOUND: 'Booking not found or this historical booking is outside the safe Issue Now scope.',
  ISSUE_RESOLUTION_SCOPE_FORBIDDEN: 'This panel is limited to ordinary stuck B2B/B2C Triplover Issue Now bookings.',
  ISSUE_NOW_CASE_CONFIRMATION_REQUIRED: 'Confirm that this is the stuck Issue Now case you verified before using the manual lane.',
  BOOKING_OWNER_REQUIRED: 'The booking has no B2B/B2C wallet owner.',
  INVALID_USER_PAYABLE: 'The local User Payable record is incomplete. Use the manual supplier-verified lane if appropriate.',
  MULTIPLE_RESERVATIONS: 'More than one wallet reservation matches this booking.',
  MULTIPLE_CAPTURE_LEDGER_ENTRIES: 'More than one capture exists for this booking.',
  CAPTURE_ACCOUNTING_CONFLICT: 'The captured payment, reservation, and ledger do not agree.',
  CAPTURE_LEDGER_MISSING: 'The booking claims a captured payment but its authoritative capture entry is missing.',
  ACTIVE_HOLD_ACCOUNTING_CONFLICT: 'The reservation and actual wallet Hold do not agree.',
  RELEASE_ACCOUNTING_CONFLICT: 'The released reservation still has an unresolved ledger Hold.',
  RESERVATION_LEDGER_MISMATCH: 'Wallet ledger history exists without a matching booking reservation.',
  MANUAL_RESOLUTION_REQUIRED: 'Local accounting is incomplete. Use the explicit supplier-verified manual resolution lane.',
  NORMAL_ACCOUNTING_AVAILABLE: 'Complete local accounting is available. Use the normal automatic resolution lane.',
  REFUND_DECISION_REQUIRED: 'Choose Full Refund, Partial Refund, No Refund, or Externally Settled.',
  INVALID_PARTIAL_REFUND: 'The partial refund must be above zero and below the outstanding captured amount.',
  SETTLEMENT_REFERENCE_REQUIRED: 'Enter the external settlement reference.',
  PAID_BOOKING_CANNOT_BE_HELD: 'A paid booking cannot be restored to On Hold.',
  FUTURE_DEADLINE_REQUIRED: 'Enter a future Super Admin deadline for the restored booking.',
  WALLET_OWNER_NOT_FOUND: 'The booking owner does not have a wallet.',
  WALLET_ACCOUNT_NOT_FOUND: 'The booking owner has no wallet account for this currency.',
  WALLET_FROZEN: 'This wallet is frozen and cannot be debited.',
  INSUFFICIENT_FUNDS: 'The wallet does not have enough Available balance for this debit.',
  INSUFFICIENT_HOLD_BALANCE: 'The wallet does not have enough Hold balance for this action.',
  RESERVATION_ACCOUNT_CONFLICT: 'The matching reservation belongs to a different wallet account or currency.',
  MANUAL_ACTIVE_RESERVATION_ACTION_REQUIRED: 'This incomplete case still has a matching active reservation. Choose Release from Hold or Capture from Hold so it is closed safely.',
  MANUAL_RESERVATION_AMOUNT_CONFLICT: 'The customer-wallet amount must exactly match the incomplete active reservation amount.',
  MANUAL_CUSTOMER_AMOUNT_REQUIRED: 'Enter the customer-wallet amount and explain how it was verified.',
  MANUAL_AMOUNT_NOT_ALLOWED: 'No wallet movement must use a zero customer-wallet amount.',
  SUPPLIER_AMOUNT_PAIR_REQUIRED: 'Supplier amount and supplier currency must be entered together.',
  INVALID_SUPPLIER_AMOUNT: 'Check the optional supplier amount and currency.',
  MANUAL_ACTION_OUTCOME_CONFLICT: 'The selected customer-wallet action conflicts with the verified supplier outcome.',
  MANUAL_EFFECT_CONFIRMATION_REQUIRED: 'Confirm the exact customer-wallet before/after effect before submission.',
  MANUAL_SUPPLIER_EFFECT_DUPLICATE: 'This supplier reference and wallet effect were already recorded for this booking.',
  MONEY_MOVEMENT_CONFIRMATION_REQUIRED: 'Confirm the displayed wallet movement before applying this decision.',
  DECISION_IDEMPOTENCY_CONFLICT: 'This request identity was already used for a different decision.',
  MANUAL_RESOLUTION_IDEMPOTENCY_CONFLICT: 'This request identity was already used for a different manual resolution.',
  ACCOUNTING_STATE_CHANGED: 'The wallet state changed. Refresh and preview the decision again.',
  RESERVATION_CHANGED: 'The wallet reservation changed. Refresh before deciding.',
  ACTIVE_HOLD_CHANGED: 'The active wallet Hold changed. Refresh before deciding.',
  REFUND_ACCOUNTING_CHANGED: 'The refundable balance changed. Refresh before deciding.',
  ALREADY_RESOLVED: 'This booking and wallet outcome are already resolved.',
  STORAGE_ERROR: 'The resolution could not be stored. No booking or wallet change was committed.',
};

function message(code: string | undefined): string {
  return (
    MESSAGE[code ?? ''] ??
    'The resolution was not accepted because the booking or accounting state is not safe.'
  );
}

function status(code: string | undefined): number {
  if (code === 'SUPERADMIN_DECISION_FORBIDDEN') return 403;
  if (code === 'BOOKING_NOT_FOUND') return 404;
  if (code === 'STORAGE_ERROR' || code === 'STORAGE_UNAVAILABLE') return 503;
  return 409;
}

async function authorizedBooking(reference: string) {
  const session = await getDashboardSession();
  if (!session) return { response: walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.') };
  if (session.role !== 'superadmin') {
    return {
      response: walletFail(
        403,
        'SUPERADMIN_DECISION_FORBIDDEN',
        'Only Super Admin can make this booking decision.'
      ),
    };
  }
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) {
    return {
      response: walletFail(400, 'INVALID_BOOKING_REFERENCE', 'Check the booking reference.'),
    };
  }
  const booking = await readBookingByPublicRefForSuperAdmin(reference);
  if (!booking) {
    return { response: walletFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.') };
  }
  return { session, booking };
}

function queryPayload(request: Request): Record<string, unknown> {
  const query = Object.fromEntries(new URL(request.url).searchParams.entries());
  if (query.mode === 'manual') {
    return {
      mode: 'manual',
      supplierOutcome: query.supplierOutcome,
      issueNowCaseConfirmed: query.issueNowCaseConfirmed === 'true',
      customerWalletAction: query.customerWalletAction,
      customerWalletAmount: query.customerWalletAmount || 0,
      customerAmountBasis: query.customerAmountBasis || null,
      supplierReference: query.supplierReference || null,
      supplierAmount: query.supplierAmount || null,
      supplierCurrency: query.supplierCurrency || null,
      newDeadlineAt: query.newDeadlineAt || null,
    };
  }
  return {
    mode: query.mode,
    supplierOutcome: query.supplierOutcome,
    refundAmount: query.refundAmount || null,
    refundDisposition: query.refundDisposition || null,
    externalSettlementReference: query.externalSettlementReference || null,
    newDeadlineAt: query.newDeadlineAt || null,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  const { reference } = await params;
  const authorization = await authorizedBooking(reference);
  if ('response' in authorization) return authorization.response;

  const parsed = previewSchema.safeParse(queryPayload(request));
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_SUPERADMIN_RESOLUTION_PREVIEW',
      parsed.error.issues[0]?.message ?? 'Check the resolution preview.'
    );
  }
  const common = {
    actorUserId: authorization.session.clerkId,
    bookingId: authorization.booking.id,
  };
  const result =
    parsed.data.mode === 'automatic'
      ? await previewSuperAdminIssueResolution({
          ...common,
          supplierOutcome: parsed.data.supplierOutcome,
          refundDisposition: parsed.data.refundDisposition ?? null,
          refundAmount: parsed.data.refundAmount ?? null,
          externalSettlementReference:
            parsed.data.externalSettlementReference ?? null,
          newDeadlineAt: parsed.data.newDeadlineAt ?? null,
        })
      : await previewSuperAdminManualFinancialResolution({
          ...common,
          supplierOutcome: parsed.data.supplierOutcome,
          issueNowCaseConfirmed: parsed.data.issueNowCaseConfirmed,
          customerWalletAction: parsed.data.customerWalletAction,
          customerWalletAmount: parsed.data.customerWalletAmount,
          customerAmountBasis: parsed.data.customerAmountBasis ?? null,
          supplierReference: parsed.data.supplierReference ?? null,
          supplierAmount: parsed.data.supplierAmount ?? null,
          supplierCurrency: parsed.data.supplierCurrency ?? null,
          newDeadlineAt: parsed.data.newDeadlineAt ?? null,
        });
  if (!result.ok) {
    return walletFail(
      status(result.code),
      result.code ?? 'RESOLUTION_PREVIEW_FAILED',
      message(result.code),
      result
    );
  }
  return walletOk(result);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  const { reference } = await params;
  const authorization = await authorizedBooking(reference);
  if ('response' in authorization) return authorization.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = executeSchema.safeParse(body);
  if (!parsed.success) {
    return walletFail(
      400,
      'INVALID_SUPERADMIN_RESOLUTION',
      parsed.error.issues[0]?.message ?? 'Check the booking resolution.'
    );
  }
  const limit = await checkActionLimit(
    'bookingReconciliationWrite',
    `user:${authorization.session.clerkId}`
  );
  if (!limit.ok) {
    return walletFail(
      429,
      'SUPERADMIN_DECISION_RATE_LIMITED',
      rateLimitMessage(limit.retryAfterSeconds),
      { retryAfterSeconds: limit.retryAfterSeconds }
    );
  }

  const common = {
    actorUserId: authorization.session.clerkId,
    bookingId: authorization.booking.id,
  };
  const preview =
    parsed.data.mode === 'automatic'
      ? await previewSuperAdminIssueResolution({
          ...common,
          supplierOutcome: parsed.data.supplierOutcome,
          refundDisposition: parsed.data.refundDisposition ?? null,
          refundAmount: parsed.data.refundAmount ?? null,
          externalSettlementReference:
            parsed.data.externalSettlementReference ?? null,
          newDeadlineAt: parsed.data.newDeadlineAt ?? null,
        })
      : await previewSuperAdminManualFinancialResolution({
          ...common,
          supplierOutcome: parsed.data.supplierOutcome,
          issueNowCaseConfirmed: parsed.data.issueNowCaseConfirmed,
          customerWalletAction: parsed.data.customerWalletAction,
          customerWalletAmount: parsed.data.customerWalletAmount,
          customerAmountBasis: parsed.data.customerAmountBasis ?? null,
          supplierReference: parsed.data.supplierReference ?? null,
          supplierAmount: parsed.data.supplierAmount ?? null,
          supplierCurrency: parsed.data.supplierCurrency ?? null,
          newDeadlineAt: parsed.data.newDeadlineAt ?? null,
        });
  if (!preview.ok) {
    return walletFail(
      status(preview.code),
      preview.code ?? 'RESOLUTION_PREVIEW_FAILED',
      message(preview.code),
      preview
    );
  }

  const moneyMoves =
    parsed.data.mode === 'automatic'
      ? ['capture_hold', 'release_hold', 'refund'].includes(
          'walletEffect' in preview ? preview.walletEffect ?? '' : ''
        )
      : parsed.data.customerWalletAction !== 'none';
  const effectConfirmed =
    parsed.data.mode === 'automatic'
      ? parsed.data.moneyMovementConfirmed
      : parsed.data.manualEffectConfirmed;
  if (moneyMoves && !effectConfirmed) {
    const code =
      parsed.data.mode === 'automatic'
        ? 'MONEY_MOVEMENT_CONFIRMATION_REQUIRED'
        : 'MANUAL_EFFECT_CONFIRMATION_REQUIRED';
    return walletFail(409, code, message(code), preview);
  }

  const audit = {
    actorUserId: authorization.session.clerkId,
    actorRole: authorization.session.role,
    action:
      parsed.data.mode === 'automatic'
        ? 'booking.superadmin_issue_resolution.apply'
        : 'booking.superadmin_manual_financial_resolution.apply',
    targetType: 'flight_booking',
    targetId: authorization.booking.id,
    metadata: {
      requestId: parsed.data.requestId,
      mode: parsed.data.mode,
      supplierOutcome: parsed.data.supplierOutcome,
      walletEffect:
        'walletEffect' in preview ? preview.walletEffect : undefined,
      customerWalletAction:
        'customerWalletAction' in preview
          ? preview.customerWalletAction
          : undefined,
      customerWalletAmount:
        'customerWalletAmount' in preview
          ? preview.customerWalletAmount
          : undefined,
      availableBefore: preview.availableBefore,
      availableAfter: preview.availableAfter,
      holdBefore: preview.holdBefore,
      holdAfter: preview.holdAfter,
      supplierAmountDeterminesCustomerAmount: false,
      evidenceRequired: false,
      noteRecorded: Boolean(parsed.data.note),
    },
  } as const;
  if (!(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))) {
    return walletFail(
      503,
      'SUPERADMIN_DECISION_AUDIT_UNAVAILABLE',
      'The resolution could not be audited and was not submitted.'
    );
  }

  const result =
    parsed.data.mode === 'automatic'
      ? await executeSuperAdminIssueResolution({
          ...common,
          requestId: parsed.data.requestId,
          supplierOutcome: parsed.data.supplierOutcome,
          refundDisposition: parsed.data.refundDisposition ?? null,
          refundAmount: parsed.data.refundAmount ?? null,
          externalSettlementReference:
            parsed.data.externalSettlementReference ?? null,
          newDeadlineAt: parsed.data.newDeadlineAt ?? null,
          note: parsed.data.note ?? null,
          moneyMovementConfirmed: parsed.data.moneyMovementConfirmed,
        })
      : await executeSuperAdminManualFinancialResolution({
          ...common,
          requestId: parsed.data.requestId,
          supplierOutcome: parsed.data.supplierOutcome,
          issueNowCaseConfirmed: parsed.data.issueNowCaseConfirmed,
          customerWalletAction: parsed.data.customerWalletAction,
          customerWalletAmount: parsed.data.customerWalletAmount,
          customerAmountBasis: parsed.data.customerAmountBasis ?? null,
          supplierReference: parsed.data.supplierReference ?? null,
          supplierAmount: parsed.data.supplierAmount ?? null,
          supplierCurrency: parsed.data.supplierCurrency ?? null,
          newDeadlineAt: parsed.data.newDeadlineAt ?? null,
          note: parsed.data.note ?? null,
          manualEffectConfirmed: parsed.data.manualEffectConfirmed,
        });
  await recordSecurityAuditEvent({
    ...audit,
    outcome: result.ok ? 'succeeded' : 'failed',
    metadata: {
      ...audit.metadata,
      failureCode: result.ok ? null : result.code ?? 'SUPERADMIN_RESOLUTION_FAILED',
      resultingBookingStatus: result.bookingStatus,
      replay: result.replay ?? false,
    },
  });
  if (!result.ok) {
    return walletFail(
      status(result.code),
      result.code ?? 'SUPERADMIN_RESOLUTION_FAILED',
      message(result.code)
    );
  }
  await dispatchBookingStatusEmails(authorization.booking.id);
  return walletOk(result);
}
