import 'server-only';

import { createHash } from 'crypto';

import type { DashboardSession } from '@/lib/dashboard/session';
import {
  assignTicketManagementSettlement,
  completeTicketManagementRefund,
  completeTicketManagementReissue,
  completeTicketManagementVoid,
  decideTicketManagementQuote,
  publishTicketManagementQuote,
  readTicketManagementRequestDetail,
  releaseAndReopenTicketManagementReissue,
  releaseAndReopenTicketManagementVoid,
  reopenTicketManagementRequest,
  reviewTicketManagementRequest,
  type TicketManagementRpcResult,
} from '@/lib/db/ticket-management';
import {
  canAssignTicketManagementSettlement,
  canFinalizeTicketManagementSettlement,
  canOperateTicketManagementRequest,
  canPublishTicketManagementQuote,
} from '@/lib/ticket-management/permissions';

export type TicketManagementActionInput =
  | {
      action: 'review';
      decision: 'accept' | 'reject';
      expectedVersion: number;
      requestKey: string;
      note?: string | null;
    }
  | {
      action: 'publish-quote';
      expectedVersion: number;
      requestKey: string;
      direction: 'credit' | 'debit' | 'none';
      currency: string;
      userPayableEntitlementAmountMinor: number;
      fareDifferenceMinor: number;
      airlineFeeMinor: number;
      voidFeeMinor: number;
      serviceFeeMinor: number;
      customerAmountMinor: number;
      confirmationDeadlineAt: string;
      details?: string | null;
      reissueFareDifferenceAllocations?: Array<{
        entitlementId: string;
        fareDifferenceAmountMinor: number;
      }>;
    }
  | {
      action: 'customer-decision';
      quoteId: string;
      decision: 'approved' | 'rejected';
      expectedVersion: number;
      requestKey: string;
      note?: string | null;
    }
  | {
      action: 'requote';
      expectedVersion: number;
      requestKey: string;
      reason: string;
    }
  | {
      action: 'assign';
      assigneeUserId: string;
      expectedVersion: number;
      requestKey: string;
      reason?: string | null;
    }
  | {
      action: 'complete-refund';
      expectedVersion: number;
      requestKey: string;
      note?: string | null;
    }
  | {
      action: 'complete-reissue';
      expectedVersion: number;
      requestKey: string;
      newTickets: Array<{
        predecessorEntitlementId: string;
        newTicketNumber: string;
        fareDifferenceAmountMinor: number;
      }>;
      note?: string | null;
    }
  | {
      action: 'release-reissue';
      expectedVersion: number;
      requestKey: string;
      reason: string;
    }
  | {
      action: 'complete-void';
      expectedVersion: number;
      requestKey: string;
      note?: string | null;
    }
  | {
      action: 'release-void';
      expectedVersion: number;
      requestKey: string;
      reason: string;
    };

export type TicketManagementActionAuthorization =
  | { ok: true; privileged: boolean }
  | { ok: false; code: string; message: string };

export function authorizeTicketManagementAction(
  session: DashboardSession,
  action: TicketManagementActionInput['action']
): TicketManagementActionAuthorization {
  if (action === 'customer-decision') {
    return ['customer', 'b2b', 'b2b_sub'].includes(session.role)
      ? { ok: true, privileged: false }
      : {
          ok: false,
          code: 'CUSTOMER_DECISION_FORBIDDEN',
          message: 'Only the booking owner can decide this quotation.',
        };
  }
  if (action === 'review' || action === 'requote') {
    return canOperateTicketManagementRequest(session.role)
      ? { ok: true, privileged: true }
      : {
          ok: false,
          code: 'TICKET_OPERATION_FORBIDDEN',
          message: 'Operational Ticket Management access is required.',
        };
  }
  if (action === 'publish-quote') {
    return canPublishTicketManagementQuote(session.role)
      ? { ok: true, privileged: true }
      : {
          ok: false,
          code: 'QUOTE_FORBIDDEN',
          message: 'Quotation access is required.',
        };
  }
  if (action === 'assign') {
    return canAssignTicketManagementSettlement(session.role)
      ? { ok: true, privileged: true }
      : {
          ok: false,
          code: 'ASSIGNMENT_FORBIDDEN',
          message: 'Settlement assignment access is required.',
        };
  }
  return canFinalizeTicketManagementSettlement(session.role)
    ? { ok: true, privileged: true }
    : {
        ok: false,
        code: 'FINAL_SETTLEMENT_FORBIDDEN',
        message: 'Assigned Accounts or administrator access is required.',
      };
}

export function ticketManagementPayloadHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

export async function performTicketManagementAction(
  requestId: string,
  session: DashboardSession,
  input: TicketManagementActionInput
): Promise<TicketManagementRpcResult> {
  const actorUserId = session.clerkId;
  switch (input.action) {
    case 'review':
      return reviewTicketManagementRequest({
        requestId,
        actorUserId,
        decision: input.decision,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        note: input.note,
      });
    case 'publish-quote': {
      const detail = await readTicketManagementRequestDetail(requestId, {
        clerkId: session.clerkId,
        role: session.role,
        agencyCode: session.agencyCode,
      });
      if (!detail) return { ok: false, code: 'REQUEST_NOT_FOUND' };
      const action = detail.action;
      if (action !== 'refund' && action !== 'reissue' && action !== 'void') {
        return { ok: false, code: 'REQUEST_ACTION_INVALID' };
      }
      return publishTicketManagementQuote({
        requestId,
        actorUserId,
        action,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        direction: input.direction,
        currency: input.currency,
        userPayableEntitlementAmount:
          input.userPayableEntitlementAmountMinor,
        fareDifference: input.fareDifferenceMinor,
        airlineFee: input.airlineFeeMinor,
        voidFee: input.voidFeeMinor,
        serviceFee: input.serviceFeeMinor,
        customerAmount: input.customerAmountMinor,
        confirmationDeadlineAt: input.confirmationDeadlineAt,
        details: input.details,
        reissueFareDifferenceAllocations:
          input.reissueFareDifferenceAllocations?.map((allocation) => ({
            entitlementId: allocation.entitlementId,
            fareDifferenceAmount: allocation.fareDifferenceAmountMinor,
          })),
      });
    }
    case 'customer-decision':
      return decideTicketManagementQuote({
        requestId,
        quoteId: input.quoteId,
        decision: input.decision,
        actorUserId,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        note: input.note,
      });
    case 'requote':
      return reopenTicketManagementRequest({
        requestId,
        actorUserId,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        reason: input.reason,
      });
    case 'assign':
      return assignTicketManagementSettlement({
        requestId,
        assigneeUserId: input.assigneeUserId,
        actorUserId,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        reason: input.reason,
      });
    case 'complete-refund':
      return completeTicketManagementRefund({
        requestId,
        actorUserId,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        note: input.note,
      });
    case 'complete-reissue':
      return completeTicketManagementReissue({
        requestId,
        actorUserId,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        newTickets: input.newTickets.map((ticket) => ({
          predecessorEntitlementId: ticket.predecessorEntitlementId,
          newTicketNumber: ticket.newTicketNumber,
          fareDifferenceAmount: ticket.fareDifferenceAmountMinor,
        })),
        note: input.note,
      });
    case 'release-reissue':
      return releaseAndReopenTicketManagementReissue({
        requestId,
        actorUserId,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        reason: input.reason,
      });
    case 'complete-void':
      return completeTicketManagementVoid({
        requestId,
        actorUserId,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        note: input.note,
      });
    case 'release-void':
      return releaseAndReopenTicketManagementVoid({
        requestId,
        actorUserId,
        expectedVersion: input.expectedVersion,
        requestKey: input.requestKey,
        reason: input.reason,
      });
  }
}

export function sanitizeTicketManagementResult(
  result: TicketManagementRpcResult,
  role: DashboardSession['role']
): TicketManagementRpcResult {
  if (!['customer', 'b2b', 'b2b_sub'].includes(role)) return result;
  const safe: TicketManagementRpcResult = { ok: result.ok };
  for (const key of [
    'code',
    'replay',
    'requestId',
    'publicRef',
    'status',
    'outcome',
    'version',
    'quoteId',
    'quoteVersion',
    'quoteHash',
    'decisionId',
    'selectedPassengerCount',
    'selectionHash',
    'selectedRouteCount',
    'routeSelectionHash',
    'customerAmount',
    'creditedAmount',
    'capturedAmount',
    'releasedAmount',
    'direction',
  ]) {
    if (result[key] !== undefined) safe[key] = result[key];
  }
  if (result.reservationId || result.ledgerEntryId) {
    // An approved quote holds a payment until settlement. A terminal outcome
    // keeps the public stage as Approved, so it is the reliable settlement
    // signal rather than the stage name.
    safe.walletEffect = result.outcome ? 'settled' : 'held';
  }
  return safe;
}
