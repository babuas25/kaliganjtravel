import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';

export type BookingReconciliationActionResult = {
  ok: boolean;
  code?: string;
  replay?: boolean;
  caseId?: string;
  caseVersion?: number;
  proposalHash?: string;
  riskFlags?: string[];
  makerCheckerRequired?: boolean;
  requiredConfirmationCodes?: string[];
  observationId?: string;
  normalizedFactsHash?: string;
  statusMutation?: boolean;
  walletMutation?: boolean;
  paymentState?: string;
  refundAmount?: number;
  releasedAmount?: number;
  currency?: string;
  availableBalance?: number;
  holdBalance?: number;
  ledgerEntryId?: string;
  bookingStatus?: string;
  storedStatus?: string;
  capturedAmount?: number;
  supplierUniqueTransId?: string;
  supplierInternalBookingId?: string | number;
  resolutionKind?: string;
  supersessionId?: string;
  successorCaseId?: string;
  successorCaseVersion?: number;
  requiresFreshEvidence?: boolean;
  bookingMutation?: false;
  reservationMutation?: false;
  ledgerMutation?: false;
  supplierWrite?: false;
};

export type BookingReconciliationActionState = {
  id: string;
  state: string;
  version: number;
  proposedOutcome: string | null;
  proposalHash: string | null;
  financialDisposition: string;
  approvedAt: string | null;
};

export async function readBookingReconciliationActionState(
  bookingId: string,
  caseId: string
): Promise<BookingReconciliationActionState | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('booking_reconciliation_cases')
    .select('id,state,version,proposed_outcome,proposal_hash,financial_disposition,approved_at')
    .eq('id', caseId)
    .eq('subject_booking_id', bookingId)
    .maybeSingle();
  if (error) {
    console.error('[db] reconciliation action state read failed:', error.message);
    return null;
  }
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    id: typeof row.id === 'string' ? row.id : caseId,
    state: typeof row.state === 'string' ? row.state : 'unknown',
    version: typeof row.version === 'number' ? row.version : 0,
    proposedOutcome:
      typeof row.proposed_outcome === 'string' ? row.proposed_outcome : null,
    proposalHash: typeof row.proposal_hash === 'string' ? row.proposal_hash : null,
    financialDisposition:
      typeof row.financial_disposition === 'string'
        ? row.financial_disposition
        : 'none',
    approvedAt: typeof row.approved_at === 'string' ? row.approved_at : null,
  };
}

export async function recordBookingNonissuanceAttestation(input: {
  bookingId: string;
  caseId: string;
  relatedSupplierObservationId: string;
  actorUserId: string;
  requestKey: string;
  basis: 'held_plus_no_ticket_record' | 'supplier_confirmed_unissued';
  portalEvidenceHash: string;
}): Promise<BookingReconciliationActionResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'record_booking_nonissuance_attestation_v1',
    {
      p_booking_id: input.bookingId,
      p_case_id: input.caseId,
      p_related_supplier_observation_id: input.relatedSupplierObservationId,
      p_actor_user_id: input.actorUserId,
      p_request_key: input.requestKey,
      p_basis: input.basis,
      p_portal_evidence_hash: input.portalEvidenceHash,
    }
  );
  if (error) {
    console.error('[db] non-issuance attestation failed:', error.message);
    return {
      ok: false,
      code:
        error.code === '22023'
          ? 'ATTESTATION_REQUEST_IDENTITY_MISMATCH'
          : 'STORAGE_ERROR',
    };
  }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as BookingReconciliationActionResult)
    : { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
}

export async function proposeBookingReconciliation(input: {
  bookingId: string;
  caseId: string;
  expectedCaseVersion: number;
  requestKey: string;
  actorUserId: string;
  domain: string;
  proposedOutcome: string;
  financialDisposition: string;
  financialAmount: number | null;
  financialCurrency: string | null;
  externalSettlementReference: string | null;
  evidenceObservationIds: string[];
  confirmationCodes: string[];
  reason: string;
}): Promise<BookingReconciliationActionResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'propose_booking_reconciliation_v1',
    {
      p_booking_id: input.bookingId,
      p_case_id: input.caseId,
      p_expected_case_version: input.expectedCaseVersion,
      p_request_key: input.requestKey,
      p_actor_user_id: input.actorUserId,
      p_domain: input.domain,
      p_proposed_outcome: input.proposedOutcome,
      p_financial_disposition: input.financialDisposition,
      p_financial_amount: input.financialAmount,
      p_financial_currency: input.financialCurrency,
      p_external_settlement_reference: input.externalSettlementReference,
      p_evidence_observation_ids: input.evidenceObservationIds,
      p_confirmation_codes: input.confirmationCodes,
      p_reason: input.reason,
    }
  );
  if (error) {
    console.error('[db] reconciliation proposal failed:', error.message);
    return {
      ok: false,
      code:
        error.code === '22023'
          ? 'PROPOSAL_REQUEST_IDENTITY_MISMATCH'
          : 'STORAGE_ERROR',
    };
  }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as BookingReconciliationActionResult)
    : { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
}

export async function decideBookingReconciliation(input: {
  action: 'approve' | 'reject';
  bookingId: string;
  caseId: string;
  expectedCaseVersion: number;
  proposalHash: string;
  actorUserId: string;
  rejectionReason?: string;
}): Promise<BookingReconciliationActionResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    input.action === 'approve'
      ? 'approve_booking_reconciliation_v1'
      : 'reject_booking_reconciliation_v1',
    input.action === 'approve'
      ? {
          p_booking_id: input.bookingId,
          p_case_id: input.caseId,
          p_expected_case_version: input.expectedCaseVersion,
          p_proposal_hash: input.proposalHash,
          p_actor_user_id: input.actorUserId,
        }
      : {
          p_booking_id: input.bookingId,
          p_case_id: input.caseId,
          p_expected_case_version: input.expectedCaseVersion,
          p_proposal_hash: input.proposalHash,
          p_actor_user_id: input.actorUserId,
          p_rejection_reason: input.rejectionReason,
        }
  );
  if (error) {
    console.error('[db] reconciliation decision failed:', error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as BookingReconciliationActionResult)
    : { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
}

async function executeExactBookingReconciliation(
  rpc: string,
  input: {
    bookingId: string;
    caseId: string;
    expectedCaseVersion: number;
    proposalHash: string;
    actorUserId: string;
    requestKey: string;
  }
): Promise<BookingReconciliationActionResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(rpc, {
    p_booking_id: input.bookingId,
    p_case_id: input.caseId,
    p_expected_case_version: input.expectedCaseVersion,
    p_proposal_hash: input.proposalHash,
    p_actor_user_id: input.actorUserId,
    p_execution_request_key: input.requestKey,
  });
  if (error) {
    console.error(`[db] ${rpc} failed:`, error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as BookingReconciliationActionResult)
    : { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
}

/** Exact no-money cancellation branch for an unpaid reconciliation case. */
export function resolveBookingReconciliationCancelledUnpaid(input: {
  bookingId: string;
  caseId: string;
  expectedCaseVersion: number;
  proposalHash: string;
  actorUserId: string;
  requestKey: string;
}) {
  return executeExactBookingReconciliation(
    'resolve_booking_reconciliation_cancelled_v1',
    input
  );
}

/**
 * Confirms a fresh supplier cancellation for a captured booking without
 * touching its reservation, ledger, wallet, or refund total. A separate,
 * approved financial proposal is required before the existing refund RPCs run.
 */
export function confirmBookingReconciliationCancelledCaptured(input: {
  bookingId: string;
  caseId: string;
  expectedCaseVersion: number;
  proposalHash: string;
  actorUserId: string;
  requestKey: string;
}) {
  return executeExactBookingReconciliation(
    'confirm_booking_reconciliation_cancelled_captured_v1',
    input
  );
}

/** Calls only one existing exact, case-bound refund wrapper. */
export function resolveBookingReconciliationRefund(input: {
  bookingId: string;
  caseId: string;
  expectedCaseVersion: number;
  proposalHash: string;
  actorUserId: string;
  requestKey: string;
  disposition: 'full_refund' | 'partial_refund';
}) {
  return executeExactBookingReconciliation(
    input.disposition === 'full_refund'
      ? 'resolve_booking_reconciliation_cancelled_full_refund_v1'
      : 'resolve_booking_reconciliation_cancelled_partial_refund_v1',
    input
  );
}

/**
 * Executes only the database-owned, approved non-issuance resolver. The RPC
 * derives the held reservation, money movement, and target lifecycle itself;
 * callers cannot supply a status, amount, currency, or reservation id.
 */
export function resolveBookingReconciliationNonissuance(input: {
  bookingId: string;
  caseId: string;
  expectedCaseVersion: number;
  proposalHash: string;
  actorUserId: string;
  requestKey: string;
}) {
  return executeExactBookingReconciliation(
    'resolve_booking_reconciliation_nonissuance_v1',
    input
  );
}

/**
 * Calls only the database-owned, approved ticketed reconciliation resolver.
 * The resolver derives ticket evidence, reservation, amount, and status from
 * locked server state; callers cannot provide any financial or supplier data.
 */
export function resolveBookingReconciliationTicketed(input: {
  bookingId: string;
  caseId: string;
  expectedCaseVersion: number;
  proposalHash: string;
  actorUserId: string;
  requestKey: string;
}) {
  return executeExactBookingReconciliation(
    'resolve_booking_reconciliation_ticketed_v2',
    input
  );
}

/**
 * Supersedes one approved, stale ticketed-capture proposal without changing a
 * booking, supplier, reservation, wallet, or ledger. The database function
 * preserves the source case and opens an empty-evidence successor case.
 */
export async function supersedeStaleApprovedBookingReconciliation(input: {
  bookingId: string;
  caseId: string;
  expectedCaseVersion: number;
  proposalHash: string;
  actorUserId: string;
  requestKey: string;
  reason: string;
}): Promise<BookingReconciliationActionResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'supersede_stale_approved_booking_reconciliation_v1',
    {
      p_booking_id: input.bookingId,
      p_case_id: input.caseId,
      p_expected_case_version: input.expectedCaseVersion,
      p_proposal_hash: input.proposalHash,
      p_actor_user_id: input.actorUserId,
      p_request_key: input.requestKey,
      p_reason: input.reason,
    }
  );
  if (error) {
    console.error('[db] stale approved reconciliation supersession failed:', error.message);
    return {
      ok: false,
      code:
        error.code === '22023'
          ? 'PROPOSAL_SUPERSESSION_REQUEST_IDENTITY_MISMATCH'
          : 'STORAGE_ERROR',
    };
  }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as BookingReconciliationActionResult)
    : { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
}

/** Appends an immutable, evidence-linked note without mutating the case. */
export async function recordBookingReconciliationKeepOpen(input: {
  bookingId: string;
  caseId: string;
  evidenceObservationId: string;
  actorUserId: string;
  requestKey: string;
  reason: string;
}): Promise<BookingReconciliationActionResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'record_booking_reconciliation_keep_open_v1',
    {
      p_booking_id: input.bookingId,
      p_case_id: input.caseId,
      p_evidence_observation_id: input.evidenceObservationId,
      p_actor_user_id: input.actorUserId,
      p_request_key: input.requestKey,
      p_reason: input.reason,
    }
  );
  if (error) {
    console.error('[db] reconciliation keep-open note failed:', error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as BookingReconciliationActionResult)
    : { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
}
