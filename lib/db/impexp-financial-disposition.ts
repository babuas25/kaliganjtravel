import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';

export type ImportedManualTicketFinancialContext = {
  caseId: string;
  state: string;
  version: number;
  reasonCode: string;
  reasonDetail: string | null;
  assignedTeam: string | null;
  severity: string;
  dueAt: string | null;
  evidenceLatestAt: string | null;
  evidenceIsFresh: boolean;
  proposedByUserId: string | null;
  proposedAt: string | null;
  proposalHash: string | null;
  supplierOutcome: 'cancelled' | 'expired' | 'unconfirmed' | null;
  financialDisposition:
    | 'none'
    | 'full_refund'
    | 'partial_refund'
    | 'no_refund_due'
    | 'externally_settled'
    | 'manual_adjustment_required';
  financialAmount: number | null;
  financialCurrency: string | null;
  externalSettlementReference: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  resolutionOutcome: string | null;
  resolvedAt: string | null;
};

export type ImportedManualTicketFinancialResult = {
  ok: boolean;
  code?: string;
  replay?: boolean;
  caseId?: string;
  caseVersion?: number;
  proposalHash?: string;
  supplierOutcome?: string;
  financialDisposition?: string;
  makerCheckerRequired?: boolean;
  bookingStatus?: string;
  paymentState?: string;
  refundAmount?: number;
  refundedAmount?: number;
  retainedAmount?: number;
  capturedAmount?: number;
  currency?: string;
  walletMutation?: boolean;
  ledgerEntryId?: string | null;
  lifecycleEventId?: number;
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function negativeOutcome(
  value: unknown
): ImportedManualTicketFinancialContext['supplierOutcome'] {
  return value === 'cancelled' || value === 'expired' || value === 'unconfirmed'
    ? value
    : null;
}

export async function readImportedManualTicketFinancialContext(
  bookingId: string
): Promise<ImportedManualTicketFinancialContext | null> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Imported financial storage is unavailable.');
  const { data, error } = await supabase
    .from('booking_reconciliation_cases')
    .select(
      'id,state,version,reason_code,reason_detail,assigned_team,severity,due_at,evidence_latest_at,proposed_by_user_id,proposed_at,proposal_hash,proposal,financial_disposition,financial_amount,financial_currency,external_settlement_reference,approved_by_user_id,approved_at,rejected_at,rejection_reason,resolution_outcome,resolved_at'
    )
    .eq('subject_booking_id', bookingId)
    .eq('case_type', 'imported_manual_ticketing')
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('[db] imported financial case lookup failed:', error.message);
    throw new Error('Imported manual-ticket financial case could not be loaded.');
  }
  if (!data) return null;
  const proposal = object(data.proposal);
  const evidenceLatestAt =
    typeof data.evidence_latest_at === 'string' ? data.evidence_latest_at : null;
  const observedAt = evidenceLatestAt ? Date.parse(evidenceLatestAt) : Number.NaN;
  return {
    caseId: String(data.id),
    state: String(data.state),
    version: Number(data.version),
    reasonCode: String(data.reason_code),
    reasonDetail:
      typeof data.reason_detail === 'string' ? data.reason_detail : null,
    assignedTeam:
      typeof data.assigned_team === 'string' ? data.assigned_team : null,
    severity: String(data.severity),
    dueAt: typeof data.due_at === 'string' ? data.due_at : null,
    evidenceLatestAt,
    evidenceIsFresh:
      Number.isFinite(observedAt) && Date.now() - observedAt <= 5 * 60_000,
    proposedByUserId:
      typeof data.proposed_by_user_id === 'string'
        ? data.proposed_by_user_id
        : null,
    proposedAt: typeof data.proposed_at === 'string' ? data.proposed_at : null,
    proposalHash:
      typeof data.proposal_hash === 'string' ? data.proposal_hash : null,
    supplierOutcome:
      negativeOutcome(proposal.supplierOutcome) ??
      (data.reason_code === 'supplier_booking_cancelled'
        ? 'cancelled'
        : data.reason_code === 'supplier_booking_expired'
          ? 'expired'
          : data.reason_code === 'supplier_booking_unconfirmed'
            ? 'unconfirmed'
            : null),
    financialDisposition: String(
      data.financial_disposition ?? 'none'
    ) as ImportedManualTicketFinancialContext['financialDisposition'],
    financialAmount:
      data.financial_amount === null ? null : Number(data.financial_amount),
    financialCurrency:
      typeof data.financial_currency === 'string'
        ? data.financial_currency
        : null,
    externalSettlementReference:
      typeof data.external_settlement_reference === 'string'
        ? data.external_settlement_reference
        : null,
    approvedByUserId:
      typeof data.approved_by_user_id === 'string'
        ? data.approved_by_user_id
        : null,
    approvedAt: typeof data.approved_at === 'string' ? data.approved_at : null,
    rejectedAt: typeof data.rejected_at === 'string' ? data.rejected_at : null,
    rejectionReason:
      typeof data.rejection_reason === 'string' ? data.rejection_reason : null,
    resolutionOutcome:
      typeof data.resolution_outcome === 'string'
        ? data.resolution_outcome
        : null,
    resolvedAt: typeof data.resolved_at === 'string' ? data.resolved_at : null,
  };
}

export async function proposeImportedManualTicketFinancialDisposition(input: {
  actorUserId: string;
  bookingId: string;
  caseId: string;
  expectedCaseVersion: number;
  requestId: string;
  financialDisposition:
    | 'full_refund'
    | 'partial_refund'
    | 'no_refund_due'
    | 'externally_settled'
    | 'manual_adjustment_required';
  financialAmount: number | null;
  financialCurrency: string | null;
  externalSettlementReference: string | null;
  reason: string;
}): Promise<ImportedManualTicketFinancialResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'propose_impexp_manual_ticket_financial_v1',
    {
      p_booking_id: input.bookingId,
      p_case_id: input.caseId,
      p_expected_case_version: input.expectedCaseVersion,
      p_actor_user_id: input.actorUserId,
      p_request_key: `impexp-financial-proposal:v1:${input.requestId}`,
      p_financial_disposition: input.financialDisposition,
      p_financial_amount: input.financialAmount,
      p_financial_currency: input.financialCurrency,
      p_external_settlement_reference: input.externalSettlementReference,
      p_reason: input.reason,
    }
  );
  if (error) {
    console.error('[db] imported financial proposal failed:', error.message);
    return {
      ok: false,
      code:
        error.code === '22023'
          ? 'FINANCIAL_PROPOSAL_IDENTITY_MISMATCH'
          : 'STORAGE_ERROR',
    };
  }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as ImportedManualTicketFinancialResult)
    : { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
}

export async function executeImportedManualTicketFinancialDisposition(input: {
  actorUserId: string;
  bookingId: string;
  caseId: string;
  expectedCaseVersion: number;
  proposalHash: string;
  requestId: string;
}): Promise<ImportedManualTicketFinancialResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'execute_impexp_manual_ticket_financial_v1',
    {
      p_booking_id: input.bookingId,
      p_case_id: input.caseId,
      p_expected_case_version: input.expectedCaseVersion,
      p_proposal_hash: input.proposalHash,
      p_actor_user_id: input.actorUserId,
      p_execution_request_key: `impexp-financial-execute:v1:${input.requestId}`,
    }
  );
  if (error) {
    console.error('[db] imported financial execution failed:', error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return data && typeof data === 'object' && !Array.isArray(data)
    ? (data as ImportedManualTicketFinancialResult)
    : { ok: false, code: 'INVALID_DATABASE_RESPONSE' };
}
