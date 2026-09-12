import { NextResponse } from 'next/server';

import type { WalletOperationResult } from '@/lib/db/wallet';

export function walletOk(data: unknown, status = 200) {
  return NextResponse.json(
    { success: true, data },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export function walletFail(
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

const WALLET_MESSAGES: Record<string, { status: number; message: string }> = {
  INSUFFICIENT_FUNDS: {
    status: 409,
    message: 'The wallet does not have enough available balance.',
  },
  WALLET_FROZEN: { status: 409, message: 'This wallet is frozen.' },
  WALLET_NOT_FOUND: {
    status: 409,
    message: 'The booking owner does not have a wallet.',
  },
  WALLET_ACCOUNT_NOT_FOUND: {
    status: 409,
    message: 'The booking owner has no wallet account for this currency.',
  },
  IMPORTED_CONFIRM_FORBIDDEN: {
    status: 403,
    message: 'You cannot confirm this imported booking.',
  },
  IMPORTED_ISSUE_FORBIDDEN: {
    status: 403,
    message: 'You cannot issue this imported booking.',
  },
  INVALID_IMPORTED_ISSUE_REQUEST: {
    status: 400,
    message: 'Check the imported booking Issue Now request.',
  },
  IMPORTED_ISSUE_IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: 'This Issue Now request identity was already used for another booking.',
  },
  IMPORTED_ACCOUNTING_RECONCILIATION_REQUIRED: {
    status: 409,
    message: 'The imported booking accounting is inconsistent and requires staff review.',
  },
  IMPORTED_BOOKING_NOT_FOUND: {
    status: 404,
    message: 'Imported booking not found.',
  },
  INVALID_BOOKING_AMOUNT: {
    status: 409,
    message: 'The booking does not have a valid User Payable Amount.',
  },
  ISSUE_IN_PROGRESS: {
    status: 409,
    message: 'Ticket issuance has already started. Do not submit it again.',
  },
  OPERATION_IN_PROGRESS: {
    status: 409,
    message: 'This supplier operation has already started. Do not submit it again.',
  },
  RECONCILIATION_REQUIRED: {
    status: 409,
    message: 'This payment is awaiting supplier reconciliation.',
  },
  ALREADY_CAPTURED: {
    status: 409,
    message: 'This booking has already been charged.',
  },
  BOOKING_NOT_ISSUABLE: {
    status: 409,
    message: 'This booking cannot be issued in its current state.',
  },
  BOOKING_EXPIRED: {
    status: 410,
    message: 'The airline ticketing deadline has passed.',
  },
  BOOKING_UNCONFIRMED: {
    status: 409,
    message: 'The airline PNR must be verified before ticketing.',
  },
  BOOKING_DEADLINE_REQUIRED: {
    status: 409,
    message: 'The airline ticketing deadline must be verified before ticketing.',
  },
  LOCAL_TIME_LIMIT_REQUIRED: {
    status: 409,
    message: 'Request a verified local time limit before ticketing or cancellation.',
  },
  TICKET_EVIDENCE_INCOMPLETE: {
    status: 503,
    message: 'The supplier response did not contain complete ticket evidence.',
  },
  BOOKING_OWNER_REQUIRED: {
    status: 409,
    message: 'The booking does not have a chargeable wallet owner.',
  },
  SELF_APPROVAL_FORBIDDEN: {
    status: 409,
    message: 'A different financial operator must approve this request.',
  },
  ALREADY_REVIEWED: {
    status: 409,
    message: 'This request has already been reviewed.',
  },
  REFUND_EXCEEDS_CAPTURE: {
    status: 409,
    message: 'The refund exceeds the remaining captured payment.',
  },
  REFUND_FORBIDDEN: {
    status: 403,
    message: 'Accounts or administrator refund access is required.',
  },
  REFUND_RESERVATION_MISMATCH: {
    status: 409,
    message: 'The captured booking payment requires reconciliation before refund.',
  },
  REFUND_IDEMPOTENCY_CONFLICT: {
    status: 409,
    message: 'This refund request identity was already used for another amount.',
  },
  STORAGE_UNAVAILABLE: {
    status: 503,
    message: 'Wallet storage is unavailable.',
  },
  STORAGE_ERROR: {
    status: 503,
    message: 'The wallet operation could not be completed.',
  },
};

export function walletOperationResponse(result: WalletOperationResult) {
  if (result.ok) return walletOk(result);
  const code = result.code ?? 'WALLET_OPERATION_FAILED';
  const policy = WALLET_MESSAGES[code] ?? {
    status: 409,
    message: 'The wallet operation could not be completed.',
  };
  return walletFail(policy.status, code, policy.message, {
    ...(typeof result.available === 'number'
      ? { available: result.available }
      : {}),
    ...(typeof result.required === 'number'
      ? { required: result.required }
      : {}),
    ...(typeof result.refundable === 'number'
      ? { refundable: result.refundable }
      : {}),
    ...(result.currency ? { currency: result.currency } : {}),
  });
}
