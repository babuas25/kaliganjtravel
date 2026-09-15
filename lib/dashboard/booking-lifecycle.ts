import type { BookingStatus, StoredBookingStatus } from '@/lib/flights/booking-status';
import type { Role } from '@/lib/roles';

export const BOOKING_LIFECYCLE_STAFF_ROLES = [
  'superadmin',
  'admin',
  'staff_support',
  'staff_account',
] as const satisfies readonly Role[];

export type BookingLifecycleStaffRole =
  (typeof BOOKING_LIFECYCLE_STAFF_ROLES)[number];

export type BookingLifecycleAccess = 'admin' | 'support' | 'accounts';

export type BookingReconciliationCapability =
  | 'view'
  | 'investigate_supplier_evidence'
  | 'propose_supplier_truth'
  | 'propose_financial_outcome'
  | 'approve_high_risk_outcome'
  | 'execute_approved_outcome';

const RECONCILIATION_CAPABILITIES: Record<
  BookingLifecycleStaffRole,
  readonly BookingReconciliationCapability[]
> = {
  superadmin: [
    'view',
    'investigate_supplier_evidence',
    'propose_supplier_truth',
    'propose_financial_outcome',
    'approve_high_risk_outcome',
    'execute_approved_outcome',
  ],
  admin: [
    'view',
    'investigate_supplier_evidence',
    'propose_supplier_truth',
    'propose_financial_outcome',
    'approve_high_risk_outcome',
    'execute_approved_outcome',
  ],
  staff_support: [
    'view',
    'investigate_supplier_evidence',
    'propose_supplier_truth',
  ],
  staff_account: ['view', 'propose_financial_outcome'],
};

export function bookingReconciliationCapabilitiesForRole(
  role: Role
): readonly BookingReconciliationCapability[] {
  return (BOOKING_LIFECYCLE_STAFF_ROLES as readonly Role[]).includes(role)
    ? RECONCILIATION_CAPABILITIES[role as BookingLifecycleStaffRole]
    : [];
}

export function canBookingReconciliation(
  role: Role,
  capability: BookingReconciliationCapability
): boolean {
  return bookingReconciliationCapabilitiesForRole(role).includes(capability);
}

export function bookingLifecycleAccessForRole(
  role: Role
): BookingLifecycleAccess | null {
  if (role === 'superadmin' || role === 'admin') return 'admin';
  if (role === 'staff_support') return 'support';
  if (role === 'staff_account') return 'accounts';
  return null;
}

/**
 * A live supplier refresh updates operational booking facts only. Keep this
 * permission with the staff roles that can open the booking detail view, and
 * do not expose it to customer, agency, or media-only roles.
 */
export function canRefreshBookingSupplierDetails(role: Role): boolean {
  return bookingLifecycleAccessForRole(role) !== null;
}

/** Deadline-only reads use the same user/agency scope as the ticket page. */
export function canRefreshBookingTicketingTime(role: Role): boolean {
  return canRefreshBookingSupplierDetails(role) ||
    role === 'customer' || role === 'b2b' || role === 'b2b_sub';
}

/** Supplier evidence contains operational identifiers, so Accounts is view-only. */
export function canAcquireBookingLifecycleEvidence(role: Role): boolean {
  return canBookingReconciliation(role, 'investigate_supplier_evidence');
}

export function canViewBookingReconciliation(role: Role): boolean {
  return canBookingReconciliation(role, 'view');
}

export function canProposeBookingSupplierTruth(role: Role): boolean {
  return canBookingReconciliation(role, 'propose_supplier_truth');
}

export function canProposeBookingFinancialOutcome(role: Role): boolean {
  return canBookingReconciliation(role, 'propose_financial_outcome');
}

export function canApproveBookingReconciliation(role: Role): boolean {
  return canBookingReconciliation(role, 'approve_high_risk_outcome');
}

export function canExecuteApprovedBookingReconciliation(role: Role): boolean {
  return canBookingReconciliation(role, 'execute_approved_outcome');
}

export type BookingReconciliationProposalDomain =
  | 'supplier_truth'
  | 'financial'
  | 'combined_supplier_financial';

export type BookingReconciliationRiskFlag =
  | 'terminal_correction'
  | 'money_movement'
  | 'fee_or_no_refund'
  | 'external_settlement'
  | 'historical_repair';

export type BookingReconciliationProposalAuthority = {
  proposalAllowed: boolean;
  reasonCode:
    | 'authorized'
    | 'supplier_truth_proposal_forbidden'
    | 'financial_proposal_forbidden'
    | 'combined_proposal_forbidden'
    | 'financial_domain_required';
  requiredCapabilities: BookingReconciliationCapability[];
  makerCheckerRequired: boolean;
  approvalCapability: 'approve_high_risk_outcome';
  executionCapability: 'execute_approved_outcome';
  executionAuthorizedNow: false;
};

const FINANCIAL_RISK_FLAGS = new Set<BookingReconciliationRiskFlag>([
  'money_movement',
  'fee_or_no_refund',
  'external_settlement',
]);

/**
 * Proposal authority never implies approval or execution authority. A mixed
 * supplier/financial outcome requires both proposal capabilities, which only
 * Admin and Super Admin currently hold. High-risk flags add maker-checker; they
 * never broaden the maker role.
 */
export function bookingReconciliationProposalAuthority(input: {
  role: Role;
  domain: BookingReconciliationProposalDomain;
  riskFlags: readonly BookingReconciliationRiskFlag[];
}): BookingReconciliationProposalAuthority {
  const hasFinancialRisk = input.riskFlags.some((flag) =>
    FINANCIAL_RISK_FLAGS.has(flag)
  );
  const requiredCapabilities: BookingReconciliationCapability[] =
    input.domain === 'supplier_truth'
      ? ['propose_supplier_truth']
      : input.domain === 'financial'
        ? ['propose_financial_outcome']
        : ['propose_supplier_truth', 'propose_financial_outcome'];

  let reasonCode: BookingReconciliationProposalAuthority['reasonCode'] =
    'authorized';
  if (hasFinancialRisk && input.domain === 'supplier_truth') {
    reasonCode = 'financial_domain_required';
  } else if (
    input.domain === 'supplier_truth' &&
    !canProposeBookingSupplierTruth(input.role)
  ) {
    reasonCode = 'supplier_truth_proposal_forbidden';
  } else if (
    input.domain === 'financial' &&
    !canProposeBookingFinancialOutcome(input.role)
  ) {
    reasonCode = 'financial_proposal_forbidden';
  } else if (
    input.domain === 'combined_supplier_financial' &&
    (!canProposeBookingSupplierTruth(input.role) ||
      !canProposeBookingFinancialOutcome(input.role))
  ) {
    reasonCode = 'combined_proposal_forbidden';
  }

  return {
    proposalAllowed: reasonCode === 'authorized',
    reasonCode,
    requiredCapabilities,
    makerCheckerRequired: input.riskFlags.length > 0,
    approvalCapability: 'approve_high_risk_outcome',
    executionCapability: 'execute_approved_outcome',
    executionAuthorizedNow: false,
  };
}

export type BookingLifecycleStaffViewRow = {
  booking_id: string;
  public_ref: string;
  supplier: string;
  import_source: 'IMP_EXP' | 'MANUAL' | null;
  stored_status: StoredBookingStatus;
  lifecycle_status: BookingStatus;
  booked_at: string;
  booking_updated_at: string;
  ticketing_deadline_at: string | null;
  issued_at: string | null;
  cancelled_at: string | null;
  payment_state: string;
  payment_amount: number | null;
  captured_amount: number;
  refunded_amount: number;
  currency: string;
  operation_id: string | null;
  operation_kind: string | null;
  operation_state: string | null;
  operation_reason_code: string | null;
  operation_reason_detail: string | null;
  operation_source: string | null;
  operation_actor_user_id: string | null;
  operation_actor_role: string | null;
  operation_claimed_at: string | null;
  supplier_call_started_at: string | null;
  supplier_response_received_at: string | null;
  external_action_due_at: string | null;
  reconciliation_required_at: string | null;
  operation_completed_at: string | null;
  operation_elapsed_seconds: number | null;
  operation_pointer_mismatch: boolean;
  reservation_id: string | null;
  reservation_state: string | null;
  reservation_amount: number | null;
  reservation_currency: string | null;
  reservation_supplier_call_started_at: string | null;
  reservation_reconciliation_at: string | null;
  reservation_reconciliation_reason: string | null;
  primary_case_id: string | null;
  primary_case_type: string | null;
  primary_case_state: string | null;
  primary_case_reason_code: string | null;
  primary_case_reason_detail: string | null;
  primary_case_assigned_team: string | null;
  primary_case_assignee_user_id: string | null;
  primary_case_severity: string | null;
  primary_case_priority: number | null;
  primary_case_due_at: string | null;
  primary_case_escalation_level: number | null;
  primary_case_evidence_latest_at: string | null;
  primary_case_evidence_is_fresh: boolean;
  financial_disposition: string | null;
  primary_case_version: number | null;
  open_case_count: number;
  case_sla_breached: boolean;
  payment_conflict_code: string | null;
  terminal_conflict_visible: boolean;
  staff_attention_required: boolean;
};

export type StaffBookingLifecycle = {
  bookingId: string;
  publicRef: string;
  supplier: string;
  importSource: 'IMP_EXP' | 'MANUAL' | null;
  storedStatus: StoredBookingStatus;
  publicStatus: BookingStatus;
  bookedAt: string;
  bookingUpdatedAt: string;
  ticketingDeadlineAt: string | null;
  issuedAt: string | null;
  cancelledAt: string | null;
  operation: null | {
    id: string;
    kind: string;
    state: string;
    reasonCode: string | null;
    reasonDetail?: string | null;
    source: string | null;
    actorUserId?: string | null;
    actorRole?: string | null;
    claimedAt: string | null;
    supplierCallStartedAt: string | null;
    supplierResponseReceivedAt: string | null;
    externalActionDueAt: string | null;
    reconciliationRequiredAt: string | null;
    completedAt: string | null;
    elapsedSeconds: number | null;
  };
  reconciliation: null | {
    id: string;
    type: string;
    state: string;
    reasonCode: string | null;
    reasonDetail?: string | null;
    assignedTeam: string | null;
    assigneeUserId: string | null;
    severity: string | null;
    priority: number | null;
    dueAt: string | null;
    escalationLevel: number;
    evidenceLatestAt: string | null;
    evidenceIsFresh: boolean;
    financialDisposition?: string | null;
    version: number | null;
    openCaseCount: number;
    slaBreached: boolean;
  };
  payment: {
    state: string;
    conflictCode: string | null;
    currency?: string;
    paymentAmount?: number | null;
    capturedAmount?: number;
    refundedAmount?: number;
    reservation?: null | {
      id: string;
      state: string | null;
      amount: number | null;
      currency: string | null;
      supplierCallStartedAt: string | null;
      reconciliationAt: string | null;
      reconciliationReason: string | null;
    };
  };
  flags: {
    operationPointerMismatch: boolean;
    terminalConflict: boolean;
    staffAttentionRequired: boolean;
  };
};

/**
 * Builds the only lifecycle DTO that may leave the staff read boundary.
 * Raw evidence, proposal bodies, passenger/contact data, and recipient data
 * are absent from both this input contract and its explicit output mapping.
 */
export function staffBookingLifecycle(
  row: BookingLifecycleStaffViewRow,
  access: BookingLifecycleAccess
): StaffBookingLifecycle {
  const canSeeOperationalDetail = access !== 'accounts';
  const canSeeFinancialDetail = access === 'accounts' || access === 'admin';

  return {
    bookingId: row.booking_id,
    publicRef: row.public_ref,
    supplier: row.supplier,
    importSource: row.import_source,
    storedStatus: row.stored_status,
    publicStatus: row.lifecycle_status,
    bookedAt: row.booked_at,
    bookingUpdatedAt: row.booking_updated_at,
    ticketingDeadlineAt: row.ticketing_deadline_at,
    issuedAt: row.issued_at,
    cancelledAt: row.cancelled_at,
    operation:
      row.operation_id && row.operation_kind && row.operation_state
        ? {
            id: row.operation_id,
            kind: row.operation_kind,
            state: row.operation_state,
            reasonCode: row.operation_reason_code,
            ...(canSeeOperationalDetail
              ? {
                  reasonDetail: row.operation_reason_detail,
                  actorUserId: row.operation_actor_user_id,
                  actorRole: row.operation_actor_role,
                }
              : {}),
            source: row.operation_source,
            claimedAt: row.operation_claimed_at,
            supplierCallStartedAt: row.supplier_call_started_at,
            supplierResponseReceivedAt: row.supplier_response_received_at,
            externalActionDueAt: row.external_action_due_at,
            reconciliationRequiredAt: row.reconciliation_required_at,
            completedAt: row.operation_completed_at,
            elapsedSeconds: row.operation_elapsed_seconds,
          }
        : null,
    reconciliation:
      row.primary_case_id && row.primary_case_type && row.primary_case_state
        ? {
            id: row.primary_case_id,
            type: row.primary_case_type,
            state: row.primary_case_state,
            reasonCode: row.primary_case_reason_code,
            ...(canSeeOperationalDetail
              ? { reasonDetail: row.primary_case_reason_detail }
              : {}),
            assignedTeam: row.primary_case_assigned_team,
            assigneeUserId: row.primary_case_assignee_user_id,
            severity: row.primary_case_severity,
            priority: row.primary_case_priority,
            dueAt: row.primary_case_due_at,
            escalationLevel: row.primary_case_escalation_level ?? 0,
            evidenceLatestAt: row.primary_case_evidence_latest_at,
            evidenceIsFresh: row.primary_case_evidence_is_fresh,
            ...(canSeeFinancialDetail
              ? { financialDisposition: row.financial_disposition }
              : {}),
            version: row.primary_case_version,
            openCaseCount: row.open_case_count,
            slaBreached: row.case_sla_breached,
          }
        : null,
    payment: {
      state: row.payment_state,
      conflictCode: row.payment_conflict_code,
      ...(canSeeFinancialDetail
        ? {
            currency: row.currency,
            paymentAmount: row.payment_amount,
            capturedAmount: row.captured_amount,
            refundedAmount: row.refunded_amount,
            reservation: row.reservation_id
              ? {
                  id: row.reservation_id,
                  state: row.reservation_state,
                  amount: row.reservation_amount,
                  currency: row.reservation_currency,
                  supplierCallStartedAt:
                    row.reservation_supplier_call_started_at,
                  reconciliationAt: row.reservation_reconciliation_at,
                  reconciliationReason: row.reservation_reconciliation_reason,
                }
              : null,
          }
        : {}),
    },
    flags: {
      operationPointerMismatch: row.operation_pointer_mismatch,
      terminalConflict: row.terminal_conflict_visible,
      staffAttentionRequired: row.staff_attention_required,
    },
  };
}
