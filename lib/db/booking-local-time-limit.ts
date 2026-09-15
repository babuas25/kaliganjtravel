import 'server-only';

import type { DashboardSession } from '@/lib/dashboard/session';
import { usesStoredBookingReferences } from '@/lib/booking-lifecycle/ticketing-flow';
import {
  LOCAL_TIME_LIMIT_EXPIRED_REQUEST_WINDOW_MINUTES,
  LOCAL_TIME_LIMIT_THRESHOLD_MINUTES,
  type LocalTimeLimitContext,
  type PendingLocalTimeLimitQueueItem,
  type LocalTimeLimitRequestState,
} from '@/lib/booking-lifecycle/local-time-limit';
import { supabaseAdmin } from '@/lib/supabase/server';

type BookingDeadlineRow = {
  id: string;
  supplier: string;
  supplier_account: string | null;
  import_source: string | null;
  legacy_operational: boolean;
  status: string;
  operation_kind: string | null;
  direct_ticketing: boolean;
  issued_at: string | null;
  airlines_pnr: unknown;
  supplier_ticketing_time_limit: string | null;
  supplier_ticketing_deadline_at: string | null;
  local_ticketing_deadline_at: string | null;
  active_local_time_limit_request_id: string | null;
  active_superadmin_deadline_override_id: string | null;
  ticketing_deadline_at: string | null;
};

type RequestRow = {
  id: string;
  state: LocalTimeLimitRequestState;
  version: number;
  eligibility_reason:
    | 'supplier_deadline_missing'
    | 'supplier_deadline_under_15_minutes'
    | 'supplier_deadline_expired_under_3_hours';
  requested_at: string;
  requested_by_user_id: string;
  requested_by_role: 'b2b' | 'b2b_sub' | 'customer';
  granted_minutes: number | null;
  approved_deadline_at: string | null;
  verification_note: string | null;
  decided_by_user_id: string | null;
  decided_by_role: 'superadmin' | 'admin' | 'staff_support' | null;
  decided_at: string | null;
  rejection_reason: string | null;
};

const EMPTY_CONTEXT: LocalTimeLimitContext = {
  featureAvailable: false,
  requestRequired: false,
  requestEligible: false,
  requestPending: false,
  localGrantActive: false,
  localDeadlineActive: false,
  supplierTimeLimit: null,
  supplierDeadlineAt: null,
  localDeadlineAt: null,
  effectiveDeadlineAt: null,
  request: null,
};

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function requestSummary(row: RequestRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    state: row.state,
    version: row.version,
    eligibilityReason: row.eligibility_reason,
    requestedAt: row.requested_at,
    requestedByUserId: row.requested_by_user_id,
    requestedByRole: row.requested_by_role,
    grantedMinutes: row.granted_minutes,
    approvedDeadlineAt: row.approved_deadline_at,
    verificationNote: row.verification_note,
    decidedByUserId: row.decided_by_user_id,
    decidedByRole: row.decided_by_role,
    decidedAt: row.decided_at,
    rejectionReason: row.rejection_reason,
  } satisfies NonNullable<LocalTimeLimitContext['request']>;
}

export async function readBookingLocalTimeLimitContext(
  bookingId: string
): Promise<LocalTimeLimitContext> {
  const supabase = supabaseAdmin();
  if (!supabase) return EMPTY_CONTEXT;
  const [bookingResult, requestResult] = await Promise.all([
    supabase
      .from('flight_bookings')
      .select(
        'id,supplier,supplier_account,import_source,legacy_operational,status,operation_kind,direct_ticketing,issued_at,airlines_pnr,supplier_ticketing_time_limit,supplier_ticketing_deadline_at,local_ticketing_deadline_at,active_local_time_limit_request_id,active_superadmin_deadline_override_id,ticketing_deadline_at'
      )
      .eq('id', bookingId)
      .maybeSingle(),
    supabase
      .from('booking_local_time_limit_requests')
      .select(
        'id,state,version,eligibility_reason,requested_at,requested_by_user_id,requested_by_role,granted_minutes,approved_deadline_at,verification_note,decided_by_user_id,decided_by_role,decided_at,rejection_reason'
      )
      .eq('booking_id', bookingId)
      .order('requested_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (bookingResult.error || requestResult.error) {
    console.error(
      '[db] local time limit context unavailable:',
      bookingResult.error?.message ?? requestResult.error?.message
    );
    return EMPTY_CONTEXT;
  }
  const booking = bookingResult.data as BookingDeadlineRow | null;
  if (!booking || booking.supplier !== 'triplover') return EMPTY_CONTEXT;
  const request = requestSummary((requestResult.data as RequestRow | null) ?? null);
  const now = Date.now();
  const supplierDeadline = booking.supplier_ticketing_deadline_at
    ? Date.parse(booking.supplier_ticketing_deadline_at)
    : Number.NaN;
  const localDeadline = booking.local_ticketing_deadline_at
    ? Date.parse(booking.local_ticketing_deadline_at)
    : Number.NaN;
  const localGrantActive = Boolean(
    booking.active_local_time_limit_request_id ||
    booking.active_superadmin_deadline_override_id
  );
  const localDeadlineActive =
    localGrantActive && Number.isFinite(localDeadline) && localDeadline > now;
  const supplierNeedsLocalApproval =
    !Number.isFinite(supplierDeadline) ||
    (supplierDeadline <
      now + LOCAL_TIME_LIMIT_THRESHOLD_MINUTES * 60_000 &&
      supplierDeadline >
        now - LOCAL_TIME_LIMIT_EXPIRED_REQUEST_WINDOW_MINUTES * 60_000);
  const requestPending = request?.state === 'pending';
  const structurallyEligible =
    booking.status === 'on-hold' &&
    booking.operation_kind === null &&
    !booking.direct_ticketing &&
    !booking.issued_at &&
    nonEmptyArray(booking.airlines_pnr);
  // Saved-reference ticketing needs no approval for a missing or still-live
  // supplier deadline. Retain the existing recovery request for known expiry.
  const savedReferencesCanIssue = usesStoredBookingReferences(booking) &&
    (!Number.isFinite(supplierDeadline) || supplierDeadline > now);
  const requestRequired =
    structurallyEligible && !localGrantActive && supplierNeedsLocalApproval &&
    !savedReferencesCanIssue;
  return {
    featureAvailable: true,
    requestRequired,
    requestEligible: requestRequired && structurallyEligible && !requestPending,
    requestPending,
    localGrantActive,
    localDeadlineActive,
    supplierTimeLimit: booking.supplier_ticketing_time_limit,
    supplierDeadlineAt: booking.supplier_ticketing_deadline_at,
    localDeadlineAt: booking.local_ticketing_deadline_at,
    effectiveDeadlineAt: booking.ticketing_deadline_at,
    request,
  };
}

export type LocalTimeLimitMutationResult = {
  ok: boolean;
  code?: string;
  replay?: boolean;
  requestId?: string;
  state?: LocalTimeLimitRequestState;
  requestedAt?: string;
  grantedMinutes?: number;
  approvedDeadlineAt?: string;
  lifecycleStatus?: string;
  version?: number;
};

export async function listPendingLocalTimeLimitRequests(
  limit = 50
): Promise<PendingLocalTimeLimitQueueItem[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];
  const { data: requests, error } = await supabase
    .from('booking_local_time_limit_requests')
    .select(
      'id,booking_id,eligibility_reason,supplier_deadline_snapshot,requested_at,requested_by_role'
    )
    .eq('state', 'pending')
    .order('requested_at', { ascending: true })
    .limit(Math.max(1, Math.min(limit, 100)));
  if (error) {
    console.error('[db] local time limit queue unavailable:', error.message);
    return [];
  }
  const rows = (requests ?? []) as Array<{
    id: string;
    booking_id: string;
    eligibility_reason: string;
    supplier_deadline_snapshot: string | null;
    requested_at: string;
    requested_by_role: string;
  }>;
  if (rows.length === 0) return [];
  const { data: bookings, error: bookingError } = await supabase
    .from('flight_bookings')
    .select('id,public_ref')
    .in('id', rows.map((row) => row.booking_id));
  if (bookingError) {
    console.error('[db] local time limit booking references unavailable:', bookingError.message);
    return [];
  }
  const references = new Map(
    ((bookings ?? []) as Array<{ id: string; public_ref: string }>).map((booking) => [
      booking.id,
      booking.public_ref,
    ])
  );
  return rows.flatMap((row) => {
    const bookingReference = references.get(row.booking_id);
    return bookingReference
      ? [{
          requestId: row.id,
          bookingReference,
          eligibilityReason: row.eligibility_reason,
          supplierDeadlineAt: row.supplier_deadline_snapshot,
          requestedAt: row.requested_at,
          requesterRole: row.requested_by_role,
        }]
      : [];
  });
}

export async function requestBookingLocalTimeLimit(input: {
  bookingId: string;
  session: DashboardSession;
  requestKey: string;
}): Promise<LocalTimeLimitMutationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc('request_booking_local_time_limit_v1', {
    p_booking_id: input.bookingId,
    p_actor_user_id: input.session.clerkId,
    p_actor_role: input.session.role,
    p_request_key: input.requestKey,
  });
  if (error) {
    const databaseError = [error.message, error.details, error.hint]
      .filter(Boolean)
      .join(' ');
    if (
      error.code === '23514' &&
      /expired at least 3 hours ago|booking_local_ttl_expired_request_window_check/i.test(
        databaseError
      )
    ) {
      return { ok: false, code: 'LOCAL_TIME_LIMIT_REQUEST_WINDOW_EXPIRED' };
    }
    if (
      error.code === '23514' &&
      /at least 15 minutes remaining|booking_local_ttl_under_15_minutes_check/i.test(
        databaseError
      )
    ) {
      return { ok: false, code: 'SUPPLIER_DEADLINE_SUFFICIENT' };
    }
    console.error('[db] local time limit request failed:', error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return data as LocalTimeLimitMutationResult;
}

export async function decideBookingLocalTimeLimit(input: {
  bookingId: string;
  requestId: string;
  expectedVersion: number;
  actorUserId: string;
  action: 'approve' | 'reject';
  grantedMinutes?: number;
  reason: string;
}): Promise<LocalTimeLimitMutationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc('decide_booking_local_time_limit_v1', {
    p_booking_id: input.bookingId,
    p_request_id: input.requestId,
    p_expected_version: input.expectedVersion,
    p_actor_user_id: input.actorUserId,
    p_action: input.action,
    p_granted_minutes: input.grantedMinutes ?? null,
    p_reason: input.reason,
  });
  if (error) {
    console.error('[db] local time limit decision failed:', error.message);
    return { ok: false, code: 'STORAGE_ERROR' };
  }
  return data as LocalTimeLimitMutationResult;
}
