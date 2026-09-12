import { NextResponse } from 'next/server';

import type { TicketManagementRpcResult } from '@/lib/db/ticket-management';

const MESSAGES: Record<string, string> = {
  REQUEST_NOT_FOUND: 'Ticket Management request not found.',
  BOOKING_NOT_FOUND: 'Booking not found.',
  REQUEST_VERSION_CONFLICT: 'This request changed. Refresh it before trying again.',
  REQUEST_NOT_REJECTABLE:
    'This request can no longer be rejected because the customer has already approved it.',
  QUOTE_EXPIRED: 'The quotation confirmation deadline has passed.',
  INSUFFICIENT_AVAILABLE_BALANCE: 'The booking owner wallet has insufficient available balance.',
  OWNER_WALLET_UNAVAILABLE: 'The booking owner wallet is unavailable.',
  FINAL_SETTLEMENT_FORBIDDEN: 'Assigned Accounts or administrator access is required.',
  FINAL_SETTLEMENT_NOT_AUTHORIZED: 'Only the active assigned financial staff member can settle this request.',
  REFUND_SETTLEMENT_NOT_AUTHORIZED: 'This Refund cannot be settled by the current actor.',
  REISSUE_SETTLEMENT_NOT_AUTHORIZED: 'This Reissue cannot be settled by the current actor.',
  VOID_SETTLEMENT_NOT_AUTHORIZED: 'This VOID cannot be settled by the current actor.',
  VOID_REQUEST_WINDOW_CLOSED:
    'VOID requests are available only on the ticket issue date until 23:30 Bangladesh time.',
  TICKET_MANAGEMENT_ACTION_UNAVAILABLE:
    'This action is not available for the booking status or ticket source.',
  WALLET_RELEASE_REQUIRED: 'The approved Hold must be released before requotation.',
  ACTIVE_REQUEST_EXISTS:
    'This booking already has an active request for this action. Wait until it is fully approved, rejected, or expired before submitting another.',
  ENTITLEMENT_UNAVAILABLE: 'The selected ticket is no longer available for this request.',
  ROUTE_SELECTION_REQUIRED: 'Select at least one route for this request.',
  DUPLICATE_ROUTE_SELECTION: 'Each route can be selected only once.',
  INVALID_ROUTE_SELECTION: 'The selected route is no longer available for this request.',
  ROUTES_UNAVAILABLE: 'Route information is unavailable for this booking.',
  AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE:
    'Authoritative passenger-level User Payable allocation is unavailable.',
  SUPPLIER_COMMERCIAL_BASIS_UNAVAILABLE:
    'The booking supplier commercial values are unavailable.',
  STORAGE_UNAVAILABLE: 'Ticket Management storage is unavailable.',
  STORAGE_ERROR: 'The Ticket Management operation could not be stored.',
};

function statusFor(code: string): number {
  if (code === 'REQUEST_NOT_FOUND' || code === 'BOOKING_NOT_FOUND') return 404;
  if (code === 'QUOTE_EXPIRED' || code === 'VOID_REQUEST_WINDOW_CLOSED') return 410;
  if (code.includes('FORBIDDEN') || code.includes('NOT_AUTHORIZED')) return 403;
  if (code.startsWith('INVALID_') || code.endsWith('_INVALID')) return 400;
  if (code.includes('STORAGE') || code === 'INVALID_DATABASE_RESPONSE') return 503;
  return 409;
}

export function ticketManagementOk(data: unknown, status = 200) {
  return NextResponse.json(
    { success: true, data },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export function ticketManagementFail(
  status: number,
  errorCode: string,
  errorMessage: string,
  details?: Record<string, unknown>
) {
  return NextResponse.json(
    {
      success: false,
      error: { errorCode, errorMessage, ...(details ? { details } : {}) },
    },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export function ticketManagementResultResponse(
  result: TicketManagementRpcResult
) {
  if (result.ok) return ticketManagementOk(result);
  const code = result.code ?? 'TICKET_MANAGEMENT_OPERATION_FAILED';
  return ticketManagementFail(
    statusFor(code),
    code,
    MESSAGES[code] ?? 'The Ticket Management operation was not accepted.',
    typeof result.version === 'number' ? { version: result.version } : undefined
  );
}
