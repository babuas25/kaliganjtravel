import { z } from 'zod';
import { after } from 'next/server';

import { getDashboardSession } from '@/lib/dashboard/session';
import { recordSecurityAuditEvent } from '@/lib/db/security';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import {
  ticketManagementFail,
  ticketManagementResultResponse,
} from '@/lib/ticket-management/http';
import {
  authorizeTicketManagementAction,
  performTicketManagementAction,
  sanitizeTicketManagementResult,
  type TicketManagementActionInput,
} from '@/lib/ticket-management/service';
import { ticketManagementRolloutEnabled } from '@/lib/ticket-management/rollout';
import { dispatchPendingTicketManagementEmails } from '@/lib/email/ticket-management-delivery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const requestKey = z.string().uuid();
const expectedVersion = z.number().int().positive();
const note = z.string().trim().max(2000).nullable().optional();
const reason = z.string().trim().min(1).max(2000);
const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const actionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('review'),
    decision: z.enum(['accept', 'reject']),
    expectedVersion,
    requestKey,
    note,
  }).strict(),
  z.object({
    action: z.literal('publish-quote'),
    expectedVersion,
    requestKey,
    direction: z.enum(['credit', 'debit', 'none']),
    currency: z.string().regex(/^[A-Z]{3}$/),
    userPayableEntitlementAmountMinor: money,
    fareDifferenceMinor: money,
    airlineFeeMinor: money,
    voidFeeMinor: money,
    serviceFeeMinor: money,
    customerAmountMinor: money,
    confirmationDeadlineAt: z.string().datetime({ offset: true }),
    details: z.string().trim().max(4000).nullable().optional(),
    reissueFareDifferenceAllocations: z.array(z.object({
      entitlementId: z.string().uuid(),
      fareDifferenceAmountMinor: money,
    }).strict()).min(1).max(20).optional(),
  }).strict(),
  z.object({
    action: z.literal('customer-decision'),
    quoteId: z.string().uuid(),
    decision: z.enum(['approved', 'rejected']),
    expectedVersion,
    requestKey,
    note,
  }).strict(),
  z.object({
    action: z.literal('requote'),
    expectedVersion,
    requestKey,
    reason,
  }).strict(),
  z.object({
    action: z.literal('assign'),
    assigneeUserId: z.string().trim().min(1).max(255),
    expectedVersion,
    requestKey,
    reason: z.string().trim().max(2000).nullable().optional(),
  }).strict(),
  z.object({
    action: z.literal('complete-refund'),
    expectedVersion,
    requestKey,
    note,
  }).strict(),
  z.object({
    action: z.literal('complete-reissue'),
    expectedVersion,
    requestKey,
    newTickets: z.array(z.object({
      predecessorEntitlementId: z.string().uuid(),
      newTicketNumber: z.string().trim().min(1).max(80),
      fareDifferenceAmountMinor: money,
    }).strict()).min(1).max(20),
    note,
  }).strict(),
  z.object({
    action: z.literal('release-reissue'),
    expectedVersion,
    requestKey,
    reason,
  }).strict(),
  z.object({
    action: z.literal('complete-void'),
    expectedVersion,
    requestKey,
    note,
  }).strict(),
  z.object({
    action: z.literal('release-void'),
    expectedVersion,
    requestKey,
    reason,
  }).strict(),
]);

function mutationLimit(action: TicketManagementActionInput['action']) {
  if (action === 'customer-decision') return 'ticketManagementCustomer' as const;
  if (action.startsWith('complete-') || action.startsWith('release-')) {
    return 'ticketManagementSettlement' as const;
  }
  return 'ticketManagementOperations' as const;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ requestId: string }> }
) {
  const [session, routeParams] = await Promise.all([
    getDashboardSession(),
    params,
  ]);
  if (!session) {
    return ticketManagementFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  }
  if (!ticketManagementRolloutEnabled()) {
    return ticketManagementFail(
      503,
      'TICKET_MANAGEMENT_DISABLED',
      'Ticket Management is not enabled.'
    );
  }
  const parsedRequestId = z.string().uuid().safeParse(routeParams.requestId);
  if (!parsedRequestId.success) {
    return ticketManagementFail(400, 'INVALID_REQUEST_ID', 'Invalid request ID.');
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return ticketManagementFail(
      400,
      'INVALID_TICKET_MANAGEMENT_ACTION',
      parsed.error.issues[0]?.message ?? 'Check the action.'
    );
  }
  const authorization = authorizeTicketManagementAction(session, parsed.data.action);
  if (!authorization.ok) {
    await recordSecurityAuditEvent({
      actorUserId: session.clerkId,
      actorRole: session.role,
      action: `ticket_management.${parsed.data.action}`,
      targetType: 'ticket_management_request',
      targetId: parsedRequestId.data,
      outcome: 'denied',
      metadata: { failureCode: authorization.code },
    });
    return ticketManagementFail(403, authorization.code, authorization.message);
  }
  const limitName = mutationLimit(parsed.data.action);
  const [actorLimit, requestLimit] = await Promise.all([
    checkActionLimit(limitName, `user:${session.clerkId}`),
    checkActionLimit(limitName, `request:${parsedRequestId.data}`),
  ]);
  const limited = !actorLimit.ok
    ? actorLimit
    : !requestLimit.ok
      ? requestLimit
      : null;
  if (limited) {
    return ticketManagementFail(
      429,
      'TICKET_MANAGEMENT_RATE_LIMITED',
      rateLimitMessage(limited.retryAfterSeconds),
      { retryAfterSeconds: limited.retryAfterSeconds }
    );
  }
  const audit = {
    actorUserId: session.clerkId,
    actorRole: session.role,
    action: `ticket_management.${parsed.data.action}`,
    targetType: 'ticket_management_request',
    targetId: parsedRequestId.data,
    metadata: {
      expectedVersion: parsed.data.expectedVersion,
      requestKey: parsed.data.requestKey,
      amountInputAccepted:
        parsed.data.action === 'publish-quote',
      supplierCommercialAmountInputAccepted: false,
      finalSettlementAmountInputAccepted: false,
      walletAccountInputAccepted: false,
    },
  } as const;
  if (
    authorization.privileged &&
    !(await recordSecurityAuditEvent({ ...audit, outcome: 'attempted' }))
  ) {
    return ticketManagementFail(
      503,
      'TICKET_MANAGEMENT_AUDIT_UNAVAILABLE',
      'The privileged action could not be audited and was not performed.'
    );
  }

  let result;
  try {
    result = await performTicketManagementAction(
      parsedRequestId.data,
      session,
      parsed.data
    );
  } catch (error) {
    console.error('[ticket-management] action failed:', error);
    result = { ok: false, code: 'STORAGE_ERROR' };
  }
  await recordSecurityAuditEvent({
    ...audit,
    outcome: result.ok ? 'succeeded' : 'failed',
    metadata: {
      ...audit.metadata,
      replay: result.replay ?? false,
      failureCode: result.ok ? null : result.code ?? 'ACTION_FAILED',
    },
  });
  if (result.ok) {
    after(async () => {
      try {
        await dispatchPendingTicketManagementEmails(10, parsedRequestId.data);
      } catch (error) {
        console.error('[ticket-management] action email dispatch failed:', error);
      }
    });
  }
  return ticketManagementResultResponse(
    sanitizeTicketManagementResult(result, session.role)
  );
}
