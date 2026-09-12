import type { BookingLifecycleAccess } from '@/lib/dashboard/booking-lifecycle';

export type AttemptReconciliationQueueRow = {
  reconciliation_case_id: string;
  reconciliation_state: string;
  reason_code: string;
  reason_detail: string | null;
  assigned_team: string | null;
  assignee_user_id: string | null;
  severity: string;
  priority: number;
  opened_at: string;
  due_at: string | null;
  escalation_level: number;
  evidence_latest_at: string | null;
  reconciliation_version: number;
  booking_attempt_id: string;
  supplier: string;
  attempt_state: string;
  attempt_created_at: string;
  submitted_at: string | null;
  resolved_at: string | null;
  supplier_call_started_at: string | null;
  supplier_response_received_at: string | null;
  supplier_response_http_status: number | null;
  operation_identity_present: boolean;
  unique_trans_id: string;
  pnr: string | null;
  booking_code_ref: string | null;
  air_ticketing_details_eligible: boolean;
  pnr_lookup_eligible: boolean;
  supplier_read_strategy:
    | 'pnr_then_air_ticketing_details'
    | 'air_ticketing_details_then_manual_portal'
    | 'manual_supplier_portal_only';
  supplier_identity_kind: 'unique_transaction_id';
  destructive_replay_allowed: boolean;
  automatic_resolution_allowed: boolean;
  manual_portal_required_if_inconclusive: boolean;
  direct_ticketing: boolean;
  reservation_id: string | null;
  reservation_state: string | null;
  reservation_amount: number | null;
  reservation_currency: string | null;
  recovered_booking_id: string | null;
  recovered_booking_public_ref: string | null;
};

export type StaffAttemptReconciliation = {
  caseId: string;
  attemptId: string;
  supplier: string;
  attemptState: string;
  directTicketing: boolean;
  timestamps: {
    createdAt: string;
    submittedAt: string | null;
    supplierCallStartedAt: string | null;
    supplierResponseReceivedAt: string | null;
    resolvedAt: string | null;
  };
  reconciliation: {
    state: string;
    reasonCode: string;
    reasonDetail?: string | null;
    assignedTeam: string | null;
    assigneeUserId: string | null;
    severity: string;
    priority: number;
    openedAt: string;
    dueAt: string | null;
    escalationLevel: number;
    evidenceLatestAt: string | null;
    version: number;
  };
  readPlan: {
    strategy: AttemptReconciliationQueueRow['supplier_read_strategy'];
    pnrEligible: boolean;
    airTicketingDetailsEligible: boolean;
    manualPortalRequiredIfInconclusive: true;
    destructiveReplayAllowed: false;
    automaticResolutionAllowed: false;
    supplierIdentity?: {
      kind: 'unique_transaction_id';
      uniqueTransId: string;
      pnr: string | null;
      bookingCodeRef: string | null;
    };
  };
  wallet: null | {
    state: string | null;
    protected: boolean;
    amount?: number | null;
    currency?: string | null;
  };
  recoveredBooking: null | {
    bookingId: string;
    publicRef: string | null;
  };
  flags: {
    operationIdentityPresent: boolean;
    supplierResponseRecorded: boolean;
    slaBreached: boolean;
  };
};

/**
 * Explicitly masks supplier identity from Accounts and wallet amounts from
 * Support. No passenger/contact snapshot, raw evidence, or operation request
 * key exists in either the input view contract exposed here or this DTO.
 */
export function staffAttemptReconciliation(
  row: AttemptReconciliationQueueRow,
  access: BookingLifecycleAccess,
  now = Date.now()
): StaffAttemptReconciliation {
  const canSeeOperationalDetail = access !== 'accounts';
  const canSeeFinancialDetail = access === 'accounts' || access === 'admin';
  const dueAt = row.due_at ? Date.parse(row.due_at) : Number.NaN;

  return {
    caseId: row.reconciliation_case_id,
    attemptId: row.booking_attempt_id,
    supplier: row.supplier,
    attemptState: row.attempt_state,
    directTicketing: row.direct_ticketing,
    timestamps: {
      createdAt: row.attempt_created_at,
      submittedAt: row.submitted_at,
      supplierCallStartedAt: row.supplier_call_started_at,
      supplierResponseReceivedAt: row.supplier_response_received_at,
      resolvedAt: row.resolved_at,
    },
    reconciliation: {
      state: row.reconciliation_state,
      reasonCode: row.reason_code,
      ...(canSeeOperationalDetail ? { reasonDetail: row.reason_detail } : {}),
      assignedTeam: row.assigned_team,
      assigneeUserId: row.assignee_user_id,
      severity: row.severity,
      priority: row.priority,
      openedAt: row.opened_at,
      dueAt: row.due_at,
      escalationLevel: row.escalation_level,
      evidenceLatestAt: row.evidence_latest_at,
      version: row.reconciliation_version,
    },
    readPlan: {
      strategy: row.supplier_read_strategy,
      pnrEligible: row.pnr_lookup_eligible,
      airTicketingDetailsEligible: row.air_ticketing_details_eligible,
      manualPortalRequiredIfInconclusive: true,
      destructiveReplayAllowed: false,
      automaticResolutionAllowed: false,
      ...(canSeeOperationalDetail
        ? {
            supplierIdentity: {
              kind: 'unique_transaction_id' as const,
              uniqueTransId: row.unique_trans_id,
              pnr: row.pnr,
              bookingCodeRef: row.booking_code_ref,
            },
          }
        : {}),
    },
    wallet: row.reservation_id
      ? {
          state: row.reservation_state,
          protected:
            row.reservation_state === 'active' ||
            row.reservation_state === 'reconciliation',
          ...(canSeeFinancialDetail
            ? {
                amount: row.reservation_amount,
                currency: row.reservation_currency,
              }
            : {}),
        }
      : null,
    recoveredBooking: row.recovered_booking_id
      ? {
          bookingId: row.recovered_booking_id,
          publicRef: row.recovered_booking_public_ref,
        }
      : null,
    flags: {
      operationIdentityPresent: row.operation_identity_present,
      supplierResponseRecorded:
        row.supplier_response_received_at !== null,
      slaBreached: Number.isFinite(dueAt) && dueAt <= now,
    },
  };
}
