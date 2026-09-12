import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';

export const SUPERADMIN_SUPPLIER_OUTCOMES = [
  'ticket_issued',
  'still_valid',
  'not_issued',
] as const;

export type SuperAdminSupplierOutcome =
  (typeof SUPERADMIN_SUPPLIER_OUTCOMES)[number];

export const SUPERADMIN_REFUND_DISPOSITIONS = [
  'full_refund',
  'partial_refund',
  'no_refund_due',
  'externally_settled',
] as const;

export type SuperAdminRefundDisposition =
  (typeof SUPERADMIN_REFUND_DISPOSITIONS)[number];

export const SUPERADMIN_MANUAL_WALLET_ACTIONS = [
  'none',
  'credit_available',
  'debit_available',
  'release_orphan_hold',
  'capture_orphan_hold',
] as const;

export type SuperAdminManualWalletAction =
  (typeof SUPERADMIN_MANUAL_WALLET_ACTIONS)[number];

export type SuperAdminBookingAccounting = {
  ok: boolean;
  code?: string;
  accountingState?: 'paid' | 'active_hold' | 'unpaid';
  accountingSource?: string;
  expectedAmount?: number | null;
  currency?: string;
  reservationId?: string | null;
  reservationState?: string | null;
  walletAccountId?: string | null;
  capturedAmount?: number;
  refundedAmount?: number;
  outstandingAmount?: number;
  paymentStateObserved?: string;
  paymentStateStale?: boolean;
};

export type SuperAdminResolutionWallet = {
  walletId: string;
  walletStatus: 'active' | 'frozen';
  ownerType: 'user' | 'agency';
  ownerKey: string;
  accountId: string | null;
  currency: string;
  availableBalance: number | null;
  holdBalance: number | null;
};

export type SuperAdminIssueResolutionContext = {
  ok: boolean;
  code?: string;
  bookingId?: string;
  bookingReference?: string;
  bookingStatus?: string;
  lifecycleStatus?: string;
  legacyOperational?: boolean;
  currentDeadlineAt?: string | null;
  supplierDeadlineAt?: string | null;
  accounting?: SuperAdminBookingAccounting;
  wallet?: SuperAdminResolutionWallet | null;
  manualAllowed?: boolean;
};

export type SuperAdminIssueResolutionPreview = {
  ok: boolean;
  code?: string;
  reason?: string;
  mode?: 'automatic_local_accounting';
  bookingId?: string;
  bookingReference?: string;
  fromStatus?: string;
  fromLifecycleStatus?: string;
  toStatus?: string;
  supplierOutcome?: SuperAdminSupplierOutcome;
  walletEffect?:
    | 'none'
    | 'capture_hold'
    | 'release_hold'
    | 'refund'
    | 'no_refund'
    | 'externally_settled';
  walletAmount?: number;
  currency?: string;
  availableBefore?: number;
  availableAfter?: number;
  holdBefore?: number;
  holdAfter?: number;
  newDeadlineAt?: string | null;
  accounting?: SuperAdminBookingAccounting;
  wallet?: SuperAdminResolutionWallet | null;
  manualAllowed?: boolean;
  context?: SuperAdminIssueResolutionContext;
};

export type SuperAdminManualResolutionPreview = {
  ok: boolean;
  code?: string;
  mode?: 'manual_supplier_verified';
  bookingId?: string;
  bookingReference?: string;
  fromStatus?: string;
  fromLifecycleStatus?: string;
  toStatus?: string;
  supplierOutcome?: SuperAdminSupplierOutcome;
  supplierReference?: string | null;
  supplierAmount?: number | null;
  supplierCurrency?: string | null;
  customerWalletAction?: SuperAdminManualWalletAction;
  customerWalletAmount?: number;
  customerWalletCurrency?: string;
  customerAmountBasis?: string | null;
  walletId?: string;
  walletAccountId?: string;
  walletOwnerType?: 'user' | 'agency';
  walletOwnerKey?: string;
  matchingReservationId?: string | null;
  matchingReservationState?: string | null;
  protectedHold?: number;
  resolvableHold?: number;
  availableBefore?: number;
  availableAfter?: number;
  holdBefore?: number;
  holdAfter?: number;
  newDeadlineAt?: string | null;
  accountingConflictCode?: string | null;
  supplierAmountDeterminesCustomerAmount?: false;
  accounting?: SuperAdminBookingAccounting;
};

export type SuperAdminIssueResolutionResult = {
  ok: boolean;
  code?: string;
  replay?: boolean;
  mode?: 'automatic_local_accounting' | 'manual_supplier_verified';
  resolutionId?: string;
  bookingId?: string;
  bookingReference?: string;
  bookingStatus?: string;
  paymentState?: string | null;
  supplierOutcome?: SuperAdminSupplierOutcome;
  walletEffect?: string;
  walletAmount?: number;
  currency?: string;
  customerWalletAction?: SuperAdminManualWalletAction;
  customerWalletAmount?: number;
  customerWalletCurrency?: string;
  availableBefore?: number;
  availableAfter?: number;
  holdBefore?: number;
  holdAfter?: number;
  accountingStateBefore?: string;
  ledgerEntryId?: string | null;
  lifecycleEventId?: number;
  supplierAmountDeterminesCustomerAmount?: false;
};

type AutomaticInput = {
  actorUserId: string;
  bookingId: string;
  supplierOutcome: SuperAdminSupplierOutcome;
  refundDisposition: SuperAdminRefundDisposition | null;
  refundAmount: number | null;
  externalSettlementReference: string | null;
  newDeadlineAt: string | null;
};

type ManualInput = {
  actorUserId: string;
  bookingId: string;
  supplierOutcome: SuperAdminSupplierOutcome;
  issueNowCaseConfirmed: boolean;
  customerWalletAction: SuperAdminManualWalletAction;
  customerWalletAmount: number;
  customerAmountBasis: string | null;
  supplierReference: string | null;
  supplierAmount: number | null;
  supplierCurrency: string | null;
  newDeadlineAt: string | null;
};

function resultObject<T>(value: unknown): T {
  return (value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { ok: false, code: 'INVALID_DATABASE_RESPONSE' }) as T;
}

function unavailable<T>(): T {
  return { ok: false, code: 'STORAGE_UNAVAILABLE' } as T;
}

export async function readSuperAdminIssueResolutionContext(input: {
  actorUserId: string;
  bookingId: string;
}): Promise<SuperAdminIssueResolutionContext> {
  const supabase = supabaseAdmin();
  if (!supabase) return unavailable();
  const { data, error } = await supabase.rpc(
    'superadmin_issue_resolution_context_v2',
    {
      p_booking_id: input.bookingId,
      p_actor_user_id: input.actorUserId,
    }
  );
  if (error) {
    console.error('[db] Super Admin issue-resolution context failed:', error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return resultObject<SuperAdminIssueResolutionContext>(data);
}

export async function previewSuperAdminIssueResolution(
  input: AutomaticInput
): Promise<SuperAdminIssueResolutionPreview> {
  const supabase = supabaseAdmin();
  if (!supabase) return unavailable();
  const { data, error } = await supabase.rpc(
    'preview_superadmin_issue_resolution_v2',
    {
      p_booking_id: input.bookingId,
      p_actor_user_id: input.actorUserId,
      p_supplier_outcome: input.supplierOutcome,
      p_refund_disposition: input.refundDisposition,
      p_refund_amount: input.refundAmount,
      p_external_settlement_reference: input.externalSettlementReference,
      p_new_deadline_at: input.newDeadlineAt,
    }
  );
  if (error) {
    console.error('[db] Super Admin issue-resolution preview failed:', error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return resultObject<SuperAdminIssueResolutionPreview>(data);
}

export async function executeSuperAdminIssueResolution(
  input: AutomaticInput & {
    requestId: string;
    note: string | null;
    moneyMovementConfirmed: boolean;
  }
): Promise<SuperAdminIssueResolutionResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return unavailable();
  const { data, error } = await supabase.rpc(
    'execute_superadmin_issue_resolution_v2',
    {
      p_booking_id: input.bookingId,
      p_actor_user_id: input.actorUserId,
      p_request_key: `superadmin-booking-decision:v1:${input.requestId}`,
      p_supplier_outcome: input.supplierOutcome,
      p_refund_disposition: input.refundDisposition,
      p_refund_amount: input.refundAmount,
      p_external_settlement_reference: input.externalSettlementReference,
      p_new_deadline_at: input.newDeadlineAt,
      p_note: input.note,
      p_money_movement_confirmed: input.moneyMovementConfirmed,
    }
  );
  if (error) {
    console.error('[db] Super Admin issue resolution failed:', error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return resultObject<SuperAdminIssueResolutionResult>(data);
}

export async function previewSuperAdminManualFinancialResolution(
  input: ManualInput
): Promise<SuperAdminManualResolutionPreview> {
  const supabase = supabaseAdmin();
  if (!supabase) return unavailable();
  const { data, error } = await supabase.rpc(
    'preview_superadmin_manual_financial_resolution_v2',
    {
      p_booking_id: input.bookingId,
      p_actor_user_id: input.actorUserId,
      p_supplier_outcome: input.supplierOutcome,
      p_issue_now_case_confirmed: input.issueNowCaseConfirmed,
      p_customer_wallet_action: input.customerWalletAction,
      p_customer_wallet_amount: input.customerWalletAmount,
      p_customer_amount_basis: input.customerAmountBasis,
      p_supplier_reference: input.supplierReference,
      p_supplier_amount: input.supplierAmount,
      p_supplier_currency: input.supplierCurrency,
      p_new_deadline_at: input.newDeadlineAt,
    }
  );
  if (error) {
    console.error('[db] Super Admin manual-resolution preview failed:', error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return resultObject<SuperAdminManualResolutionPreview>(data);
}

export async function executeSuperAdminManualFinancialResolution(
  input: ManualInput & {
    requestId: string;
    note: string | null;
    manualEffectConfirmed: boolean;
  }
): Promise<SuperAdminIssueResolutionResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return unavailable();
  const { data, error } = await supabase.rpc(
    'execute_superadmin_manual_financial_resolution_v2',
    {
      p_booking_id: input.bookingId,
      p_actor_user_id: input.actorUserId,
      p_request_key: `superadmin-manual-resolution:v2:${input.requestId}`,
      p_supplier_outcome: input.supplierOutcome,
      p_issue_now_case_confirmed: input.issueNowCaseConfirmed,
      p_customer_wallet_action: input.customerWalletAction,
      p_customer_wallet_amount: input.customerWalletAmount,
      p_customer_amount_basis: input.customerAmountBasis,
      p_supplier_reference: input.supplierReference,
      p_supplier_amount: input.supplierAmount,
      p_supplier_currency: input.supplierCurrency,
      p_new_deadline_at: input.newDeadlineAt,
      p_note: input.note,
      p_manual_effect_confirmed: input.manualEffectConfirmed,
    }
  );
  if (error) {
    console.error('[db] Super Admin manual financial resolution failed:', error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return resultObject<SuperAdminIssueResolutionResult>(data);
}
