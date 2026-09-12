import 'server-only';

import type { DashboardSession } from '@/lib/dashboard/session';
import type { OperationRequestIdentity } from '@/lib/booking-lifecycle/operation-request';
import { coerceDocumentList, type StoredDoc } from '@/lib/documents';
import { supabaseAdmin } from '@/lib/supabase/server';
import {
  walletOwnerForSession,
  type WalletOwner,
} from '@/lib/wallet/permissions';
import type { UserBankAccountSnapshot } from '@/lib/wallet/payment-options';

export type WalletStatus = 'active' | 'frozen';
export type WalletTransactionType =
  | 'deposit'
  | 'booking_hold'
  | 'booking_confirm'
  | 'hold_release'
  | 'refund'
  | 'manual_credit'
  | 'manual_debit'
  | 'adjustment'
  | 'reversal'
  | 'superadmin_resolution_credit'
  | 'superadmin_resolution_debit'
  | 'superadmin_resolution_hold_release'
  | 'superadmin_resolution_hold_capture';

export type WalletAccountSummary = {
  walletId: string;
  accountId: string;
  ownerType: 'user' | 'agency';
  ownerKey: string;
  status: WalletStatus;
  currency: string;
  availableBalance: number;
  holdBalance: number;
  totalBalance: number;
  updatedAt: string;
};

export type WalletLedgerEntry = {
  id: string;
  walletAccountId: string;
  transactionType: WalletTransactionType;
  amount: number;
  currency: string;
  availableBefore: number;
  availableAfter: number;
  holdBefore: number;
  holdAfter: number;
  bookingId: string | null;
  bookingReference: string | null;
  createdByUserId: string;
  createdByRole: string;
  remarks: string | null;
  createdAt: string;
  ownerType?: 'user' | 'agency';
  ownerKey?: string;
};

export type WalletOperationResult = {
  ok: boolean;
  code?: string;
  reservationId?: string;
  accountId?: string;
  available?: number;
  required?: number;
  amount?: number;
  currency?: string;
  availableBalance?: number;
  holdBalance?: number;
  replay?: boolean;
  status?: string;
  refundable?: number;
  refundedAmount?: number;
  operationId?: string;
  operationState?: string;
  operationResult?: Record<string, unknown>;
};

export type DepositRequestRow = {
  id: string;
  public_ref: string;
  wallet_account_id: string;
  amount: number;
  currency: string;
  method: 'cash' | 'bank' | 'bank_transfer' | 'mobile' | 'cheque';
  reference_number: string | null;
  branch_id: string | null;
  received_by_user_id: string | null;
  company_bank_account_id: string | null;
  deposit_date: string | null;
  cheque_issued_date: string | null;
  cheque_issued_bank: string | null;
  payment_date: string | null;
  mfs_provider: string | null;
  mfs_account_id: string | null;
  mfs_payment_type: 'merchant' | 'send_money' | 'cashout' | null;
  source_bank_account_id: string | null;
  user_bank_account: UserBankAccountSnapshot | null;
  gateway_fee_bps: number | null;
  gross_amount: number | null;
  attachment: StoredDoc | null;
  remarks: string | null;
  status: 'pending' | 'approved' | 'rejected';
  requested_by_user_id: string;
  reviewed_by_user_id: string | null;
  review_remarks: string | null;
  ledger_entry_id: string | null;
  requested_at: string;
  reviewed_at: string | null;
  updated_at: string;
};

export type AdjustmentRequestRow = {
  id: string;
  public_ref: string;
  wallet_account_id: string;
  adjustment_type: 'credit' | 'debit';
  amount: number;
  currency: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  requested_by_user_id: string;
  requested_by_role: string;
  reviewed_by_user_id: string | null;
  review_remarks: string | null;
  ledger_entry_id: string | null;
  requested_at: string;
  reviewed_at: string | null;
};

type AccountRow = {
  id: string;
  wallet_id: string;
  currency: string;
  available_balance: number;
  hold_balance: number;
  updated_at: string;
};

export class WalletStorageError extends Error {
  constructor(message = 'Wallet storage is unavailable.') {
    super(message);
    this.name = 'WalletStorageError';
  }
}

function operationData(data: unknown): WalletOperationResult {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
  }
  return data as WalletOperationResult;
}

async function ensureAccount(
  owner: WalletOwner,
  currency = 'BDT'
): Promise<AccountRow | null> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new WalletStorageError();
  const { data, error } = await supabase.rpc('wallet_ensure_account', {
    p_owner_type: owner.ownerType,
    p_owner_key: owner.ownerKey,
    p_currency: currency,
  });
  if (error) {
    console.error('[wallet] ensure account failed:', error.message);
    throw new WalletStorageError();
  }
  return (data as AccountRow | null) ?? null;
}

export async function ensureWalletForOwner(
  owner: WalletOwner,
  currency = 'BDT'
): Promise<WalletAccountSummary | null> {
  const account = await ensureAccount(owner, currency);
  const supabase = supabaseAdmin();
  if (!account || !supabase) throw new WalletStorageError();
  const { data, error } = await supabase
    .from('wallet_report_v')
    .select('*')
    .eq('wallet_account_id', account.id)
    .maybeSingle();
  if (error || !data) {
    if (error) console.error('[wallet] summary failed:', error.message);
    throw new WalletStorageError();
  }
  return mapWalletSummary(data as Record<string, unknown>);
}

export async function ensureSessionWallet(
  session: DashboardSession,
  currency = 'BDT'
): Promise<WalletAccountSummary | null> {
  const owner = walletOwnerForSession(session);
  return owner ? ensureWalletForOwner(owner, currency) : null;
}

function mapWalletSummary(row: Record<string, unknown>): WalletAccountSummary {
  return {
    walletId: String(row.wallet_id),
    accountId: String(row.wallet_account_id),
    ownerType: row.owner_type as 'user' | 'agency',
    ownerKey: String(row.owner_key),
    status: row.status as WalletStatus,
    currency: String(row.currency),
    availableBalance: Number(row.available_balance) || 0,
    holdBalance: Number(row.hold_balance) || 0,
    totalBalance: Number(row.total_balance) || 0,
    updatedAt: String(row.updated_at),
  };
}

function mapLedger(row: Record<string, unknown>): WalletLedgerEntry {
  return {
    id: String(row.id),
    walletAccountId: String(row.wallet_account_id),
    transactionType: row.transaction_type as WalletTransactionType,
    amount: Number(row.amount) || 0,
    currency: String(row.currency),
    availableBefore: Number(row.available_before) || 0,
    availableAfter: Number(row.available_after) || 0,
    holdBefore: Number(row.hold_before) || 0,
    holdAfter: Number(row.hold_after) || 0,
    bookingId: typeof row.booking_id === 'string' ? row.booking_id : null,
    bookingReference:
      typeof row.booking_reference === 'string' ? row.booking_reference : null,
    createdByUserId: String(row.created_by_user_id),
    createdByRole: String(row.created_by_role),
    remarks: typeof row.remarks === 'string' ? row.remarks : null,
    createdAt: String(row.created_at),
    ...(typeof row.owner_type === 'string'
      ? { ownerType: row.owner_type as 'user' | 'agency' }
      : {}),
    ...(typeof row.owner_key === 'string' ? { ownerKey: row.owner_key } : {}),
  };
}

export async function listAccountLedger(
  accountId: string,
  limit = 200
): Promise<WalletLedgerEntry[]> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new WalletStorageError();
  const { data, error } = await supabase
    .from('wallet_ledger_entries')
    .select('*')
    .eq('wallet_account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 500));
  if (error) {
    console.error('[wallet] ledger failed:', error.message);
    throw new WalletStorageError();
  }
  return (data ?? []).map((row) => mapLedger(row as Record<string, unknown>));
}

export async function listWallets(limit: number | null = 500): Promise<WalletAccountSummary[]> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new WalletStorageError();
  const pageSize = 1000;
  const requested = limit === null ? Number.POSITIVE_INFINITY : Math.max(limit, 1);
  const rows: Record<string, unknown>[] = [];
  while (rows.length < requested) {
    const size = Math.min(pageSize, requested - rows.length);
    const { data, error } = await supabase
      .from('wallet_report_v')
      .select('*')
      .order('updated_at', { ascending: false })
      .range(rows.length, rows.length + size - 1);
    if (error) {
      console.error('[wallet] list wallets failed:', error.message);
      throw new WalletStorageError();
    }
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < size) break;
  }
  return rows.map(mapWalletSummary);
}

export async function listAllLedger(limit = 500): Promise<WalletLedgerEntry[]> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new WalletStorageError();
  const { data, error } = await supabase
    .from('wallet_transaction_report_v')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 1000));
  if (error) {
    console.error('[wallet] transaction report failed:', error.message);
    throw new WalletStorageError();
  }
  return (data ?? []).map((row) => mapLedger(row as Record<string, unknown>));
}

export async function setWalletStatus(
  walletId: string,
  status: WalletStatus,
  actorUserId: string,
  reason?: string
): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  const frozen = status === 'frozen';
  const { data, error } = await supabase
    .from('wallets')
    .update({
      status,
      frozen_at: frozen ? new Date().toISOString() : null,
      frozen_by: frozen ? actorUserId : null,
      freeze_reason: frozen ? reason?.trim().slice(0, 1000) || null : null,
    })
    .eq('id', walletId)
    .select('id')
    .maybeSingle();
  if (error) console.error('[wallet] status update failed:', error.message);
  return !error && Boolean(data);
}

async function walletRpc(
  name: string,
  args: Record<string, unknown>
): Promise<WalletOperationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    console.error(`[wallet] ${name} failed:`, error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return operationData(data);
}

/**
 * Versioned finalizers are safe to replay because their operation identity is
 * payload-bound and their database transaction stores the terminal result.
 * Retry once when the database HTTP response is lost so a committed result is
 * recovered without applying a separate compatibility mutation.
 */
async function walletFinalizationRpc(
  name: string,
  args: Record<string, unknown>
): Promise<WalletOperationResult> {
  const first = await walletRpc(name, args);
  return first.code === 'STORAGE_ERROR' ? walletRpc(name, args) : first;
}

export function beginBookingIssue(
  bookingId: string,
  session: DashboardSession,
  operationRequest: OperationRequestIdentity
): Promise<WalletOperationResult> {
  return walletRpc('wallet_begin_booking_issue_v2', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_request_key: operationRequest.requestKey,
    p_request_payload_hash: operationRequest.requestPayloadHash,
  });
}

export function beginDirectTicket(
  attemptId: string,
  session: DashboardSession,
  requestId: string
): Promise<WalletOperationResult> {
  return walletRpc('wallet_begin_direct_ticket', {
    p_attempt_id: attemptId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_idempotency_key: requestId,
  });
}

export function captureBookingReservation(
  bookingId: string,
  session: DashboardSession,
  requestId: string,
  supplierOutcome: Record<string, unknown>
): Promise<WalletOperationResult> {
  return walletRpc('wallet_capture_reservation', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_idempotency_key: requestId,
    p_supplier_outcome: supplierOutcome,
  });
}

export function finalizeBookingIssue(
  bookingId: string,
  session: DashboardSession,
  operationRequest: OperationRequestIdentity,
  operationId: string,
  supplierOutcome: Record<string, unknown>
): Promise<WalletOperationResult> {
  return walletFinalizationRpc('wallet_capture_reservation_v2', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_request_key: operationRequest.requestKey,
    p_request_payload_hash: operationRequest.requestPayloadHash,
    p_operation_id: operationId,
    p_supplier_outcome: supplierOutcome,
  });
}

/** Reads an existing account without creating a wallet or currency account. */
export async function readWalletForOwner(
  owner: WalletOwner,
  currency = 'BDT'
): Promise<WalletAccountSummary | null> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new WalletStorageError();
  const { data, error } = await supabase
    .from('wallet_report_v')
    .select('*')
    .eq('owner_type', owner.ownerType)
    .eq('owner_key', owner.ownerKey)
    .eq('currency', currency.trim().toUpperCase())
    .maybeSingle();
  if (error) {
    console.error('[wallet] existing summary failed:', error.message);
    throw new WalletStorageError();
  }
  return data ? mapWalletSummary(data as Record<string, unknown>) : null;
}

export function beginImportedBookingIssue(
  bookingId: string,
  session: DashboardSession,
  requestId: string,
): Promise<WalletOperationResult> {
  return walletRpc('wallet_confirm_impexp_booking', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_idempotency_key: requestId,
  });
}

export function beginLegacyManualIssue(
  bookingId: string,
  session: DashboardSession,
  operationRequest: OperationRequestIdentity
): Promise<WalletOperationResult> {
  return walletRpc('wallet_begin_legacy_manual_issue_v2', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_request_key: operationRequest.requestKey,
    p_request_payload_hash: operationRequest.requestPayloadHash,
  });
}

export function failBookingIssue(
  bookingId: string,
  session: DashboardSession,
  operationRequest: OperationRequestIdentity,
  operationId: string,
  reason: string
): Promise<WalletOperationResult> {
  return walletFinalizationRpc('wallet_fail_booking_issue_v2', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_request_key: operationRequest.requestKey,
    p_request_payload_hash: operationRequest.requestPayloadHash,
    p_operation_id: operationId,
    p_reason: reason,
  });
}

export function finalizeManualIssue(
  bookingId: string,
  session: DashboardSession,
  operationRequest: OperationRequestIdentity,
  operationId: string,
  supplierOutcome: Record<string, unknown>
): Promise<WalletOperationResult> {
  return walletFinalizationRpc('wallet_finalize_manual_issue_v2', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_request_key: operationRequest.requestKey,
    p_request_payload_hash: operationRequest.requestPayloadHash,
    p_operation_id: operationId,
    p_supplier_outcome: supplierOutcome,
  });
}

export function releaseReservation(
  subject: { bookingId?: string; attemptId?: string },
  session: DashboardSession,
  requestId: string,
  reason: string
): Promise<WalletOperationResult> {
  return walletRpc('wallet_release_reservation', {
    p_booking_id: subject.bookingId ?? null,
    p_booking_attempt_id: subject.attemptId ?? null,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_idempotency_key: requestId,
    p_reason: reason,
  });
}

export function finalizeBookingCancellation(
  bookingId: string,
  session: DashboardSession,
  operationRequest: OperationRequestIdentity,
  operationId: string,
  reason: string,
  supplierOutcome: Record<string, unknown>
): Promise<WalletOperationResult> {
  return walletFinalizationRpc('wallet_finalize_booking_cancel_v2', {
    p_booking_id: bookingId,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_request_key: operationRequest.requestKey,
    p_request_payload_hash: operationRequest.requestPayloadHash,
    p_operation_id: operationId,
    p_reason: reason,
    p_supplier_outcome: supplierOutcome,
  });
}

export function markReservationForReconciliation(
  subject: { bookingId?: string; attemptId?: string },
  reason: string
): Promise<WalletOperationResult> {
  return walletRpc('wallet_mark_reconciliation', {
    p_booking_id: subject.bookingId ?? null,
    p_booking_attempt_id: subject.attemptId ?? null,
    p_reason: reason,
  });
}

export async function createDepositRequest(input: {
  id: string;
  accountId: string;
  amount: number;
  currency: string;
  method: DepositRequestRow['method'];
  referenceNumber?: string;
  branchId?: string;
  receivedByUserId?: string;
  companyBankAccountId?: string;
  depositDate?: string;
  chequeIssuedDate?: string;
  chequeIssuedBank?: string;
  paymentDate?: string;
  mfsProvider?: string;
  mfsAccountId?: string;
  mfsPaymentType?: 'merchant' | 'send_money' | 'cashout';
  sourceBankAccountId?: string;
  userBankAccount?: UserBankAccountSnapshot;
  gatewayFeeBps?: number;
  grossAmount?: number;
  attachment?: StoredDoc;
  remarks?: string;
  requestedBy: string;
}): Promise<DepositRequestRow | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('wallet_deposit_requests')
    .insert({
      id: input.id,
      wallet_account_id: input.accountId,
      amount: input.amount,
      currency: input.currency,
      method: input.method,
      reference_number: input.referenceNumber?.trim() || null,
      branch_id: input.branchId ?? null,
      received_by_user_id: input.receivedByUserId ?? null,
      company_bank_account_id: input.companyBankAccountId ?? null,
      deposit_date: input.depositDate ?? null,
      cheque_issued_date: input.chequeIssuedDate ?? null,
      cheque_issued_bank: input.chequeIssuedBank?.trim() || null,
      payment_date: input.paymentDate ?? null,
      mfs_provider: input.mfsProvider ?? null,
      mfs_account_id: input.mfsAccountId ?? null,
      mfs_payment_type: input.mfsPaymentType ?? null,
      source_bank_account_id: input.sourceBankAccountId ?? null,
      user_bank_account: input.userBankAccount ?? null,
      gateway_fee_bps: input.gatewayFeeBps ?? null,
      gross_amount: input.grossAmount ?? input.amount,
      attachment: input.attachment ?? null,
      remarks: input.remarks?.trim() || null,
      requested_by_user_id: input.requestedBy,
    })
    .select('*')
    .single();
  if (error) {
    console.error('[wallet] deposit request failed:', error.message);
    return null;
  }
  return data as DepositRequestRow;
}

export async function listDepositRequests(
  accountId?: string,
  limit = 500
): Promise<DepositRequestRow[]> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new WalletStorageError();
  let query = supabase
    .from('wallet_deposit_requests')
    .select('*')
    .order('requested_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 1000));
  if (accountId) query = query.eq('wallet_account_id', accountId);
  const { data, error } = await query;
  if (error) {
    console.error('[wallet] deposits list failed:', error.message);
    throw new WalletStorageError();
  }
  return (data ?? []).map((row) => {
    const record = row as unknown as Omit<DepositRequestRow, 'attachment'> & {
      attachment?: unknown;
    };
    return {
      ...record,
      attachment: coerceDocumentList(
        record.attachment ? [record.attachment] : []
      )[0] ?? null,
    };
  });
}

/** Loads one request after a successful review so its immutable details can be notified. */
export async function findDepositRequest(
  requestId: string
): Promise<DepositRequestRow | null> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new WalletStorageError();
  const { data, error } = await supabase
    .from('wallet_deposit_requests')
    .select('*')
    .eq('id', requestId)
    .maybeSingle();
  if (error) {
    console.error('[wallet] deposit request lookup failed:', error.message);
    throw new WalletStorageError();
  }
  if (!data) return null;
  const record = data as unknown as Omit<DepositRequestRow, 'attachment'> & {
    attachment?: unknown;
  };
  return {
    ...record,
    attachment: coerceDocumentList(record.attachment ? [record.attachment] : [])[0] ?? null,
  };
}

export function reviewDeposit(
  requestId: string,
  decision: 'approved' | 'rejected',
  session: DashboardSession,
  remarks?: string
): Promise<WalletOperationResult> {
  return walletRpc('wallet_review_deposit', {
    p_request_id: requestId,
    p_decision: decision,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_review_remarks: remarks ?? null,
  });
}

export async function createAdjustmentRequest(input: {
  accountId: string;
  adjustmentType: 'credit' | 'debit';
  amount: number;
  reason: string;
  session: DashboardSession;
}): Promise<AdjustmentRequestRow | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;
  const { data: account, error: accountError } = await supabase
    .from('wallet_accounts')
    .select('currency')
    .eq('id', input.accountId)
    .maybeSingle();
  if (accountError || !account) {
    if (accountError) {
      console.error('[wallet] adjustment account lookup failed:', accountError.message);
    }
    return null;
  }
  const { data, error } = await supabase
    .from('wallet_adjustment_requests')
    .insert({
      wallet_account_id: input.accountId,
      adjustment_type: input.adjustmentType,
      amount: input.amount,
      currency: account.currency,
      reason: input.reason.trim(),
      requested_by_user_id: input.session.clerkId,
      requested_by_role: input.session.role,
    })
    .select('*')
    .single();
  if (error) {
    console.error('[wallet] adjustment request failed:', error.message);
    return null;
  }
  return data as AdjustmentRequestRow;
}

export async function listAdjustmentRequests(): Promise<AdjustmentRequestRow[]> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new WalletStorageError();
  const { data, error } = await supabase
    .from('wallet_adjustment_requests')
    .select('*')
    .order('requested_at', { ascending: false })
    .limit(500);
  if (error) {
    console.error('[wallet] adjustments list failed:', error.message);
    throw new WalletStorageError();
  }
  return (data ?? []) as AdjustmentRequestRow[];
}

export function reviewAdjustment(
  requestId: string,
  decision: 'approved' | 'rejected',
  session: DashboardSession,
  remarks?: string
): Promise<WalletOperationResult> {
  return walletRpc('wallet_review_adjustment', {
    p_request_id: requestId,
    p_decision: decision,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_review_remarks: remarks ?? null,
  });
}

export function refundBooking(
  bookingId: string,
  amount: number,
  session: DashboardSession,
  requestId: string,
  remarks?: string
): Promise<WalletOperationResult> {
  return walletRpc('wallet_refund_booking', {
    p_booking_id: bookingId,
    p_amount: amount,
    p_actor_user_id: session.clerkId,
    p_actor_role: session.role,
    p_idempotency_key: requestId,
    p_remarks: remarks ?? null,
  });
}
