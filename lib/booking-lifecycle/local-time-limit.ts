import type { Role } from '@/lib/roles';

export const LOCAL_TIME_LIMIT_THRESHOLD_MINUTES = 15;
export const LOCAL_TIME_LIMIT_EXPIRED_REQUEST_WINDOW_MINUTES = 3 * 60;
export const LOCAL_TIME_LIMIT_MIN_GRANT_MINUTES = 1;
export const LOCAL_TIME_LIMIT_MAX_GRANT_MINUTES = 30;

export type LocalTimeLimitRequestState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'superseded';

export type LocalTimeLimitRequestSummary = {
  id: string;
  state: LocalTimeLimitRequestState;
  version: number;
  eligibilityReason:
    | 'supplier_deadline_missing'
    | 'supplier_deadline_under_15_minutes'
    | 'supplier_deadline_expired_under_3_hours';
  requestedAt: string;
  requestedByUserId: string;
  requestedByRole: 'b2b' | 'b2b_sub' | 'customer';
  grantedMinutes: number | null;
  approvedDeadlineAt: string | null;
  verificationNote: string | null;
  decidedByUserId: string | null;
  decidedByRole: 'superadmin' | 'admin' | 'staff_support' | null;
  decidedAt: string | null;
  rejectionReason: string | null;
};

export type LocalTimeLimitContext = {
  featureAvailable: boolean;
  requestRequired: boolean;
  requestEligible: boolean;
  requestPending: boolean;
  localGrantActive: boolean;
  localDeadlineActive: boolean;
  supplierTimeLimit: string | null;
  supplierDeadlineAt: string | null;
  localDeadlineAt: string | null;
  effectiveDeadlineAt: string | null;
  request: LocalTimeLimitRequestSummary | null;
};

export type PendingLocalTimeLimitQueueItem = {
  requestId: string;
  bookingReference: string;
  eligibilityReason: string;
  supplierDeadlineAt: string | null;
  requestedAt: string;
  requesterRole: string;
};

export function canRequestLocalTimeLimit(role: Role): boolean {
  return role === 'b2b' || role === 'b2b_sub' || role === 'customer';
}

export function canDecideLocalTimeLimit(role: Role): boolean {
  return role === 'superadmin' || role === 'admin' || role === 'staff_support';
}

export function isLocalTimeLimitGrantMinutes(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= LOCAL_TIME_LIMIT_MIN_GRANT_MINUTES &&
    value <= LOCAL_TIME_LIMIT_MAX_GRANT_MINUTES
  );
}
