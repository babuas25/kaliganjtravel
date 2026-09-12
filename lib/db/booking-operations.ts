import 'server-only';

import { createHash } from 'crypto';

import type { OperationRequestIdentity } from '@/lib/booking-lifecycle/operation-request';
import type { SupplierWriteFailureClassification } from '@/lib/booking-lifecycle/supplier-uncertainty';
import { supabaseAdmin } from '@/lib/supabase/server';

export type SupplierCallBoundaryResult = {
  ok: boolean;
  started?: boolean;
  replay?: boolean;
  code?: string;
  operationId?: string;
  operationState?: string;
  attemptId?: string;
  supplierCallStartedAt?: string;
};

export type BookingOperationWatchdogResult = {
  ok: boolean;
  available: boolean;
  processed: number;
  casesCreated: number;
  thresholdSeconds: number;
  limit: number;
  automaticSupplierReplay: false;
  code?: string;
};

export type BookingAttemptWatchdogResult = BookingOperationWatchdogResult & {
  caseDueSeconds: number;
  historicalNullIdentityExcluded: true;
};

export type SupplierUncertaintyRecordResult = {
  ok: boolean;
  replay?: boolean;
  code?: string;
  caseId?: string;
  caseType?: string;
  observationId?: string;
  operationState?: 'needs_reconciliation' | null;
  attemptState?: 'unknown' | null;
  walletPositionProtected?: boolean;
  automaticSupplierReplay?: false;
};

/**
 * The only operation states that still own a booking.  A read of this set is
 * safe to use for a client-side action gate: none of these rows may be
 * superseded by another ticketing or cancellation write.
 */
export const ACTIVE_BOOKING_OPERATION_STATES = [
  'claimed',
  'supplier_call_started',
  'awaiting_external_action',
  'needs_reconciliation',
] as const;

export type ActiveBookingOperationState =
  (typeof ACTIVE_BOOKING_OPERATION_STATES)[number];

/**
 * Reads an active operation without changing its lease, reconciliation case,
 * or supplier evidence.  The booking route has already applied the caller's
 * booking scope before it invokes this helper.
 */
export async function readActiveBookingOperationState(
  bookingId: string
): Promise<ActiveBookingOperationState | null> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Booking operation storage is unavailable.');

  const { data, error } = await supabase
    .from('booking_operations')
    .select('state')
    .eq('booking_id', bookingId)
    .in('state', ACTIVE_BOOKING_OPERATION_STATES)
    .order('claimed_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[booking-operation] active state read failed:', error.message);
    throw new Error('Booking operation storage is unavailable.');
  }
  return ACTIVE_BOOKING_OPERATION_STATES.includes(
    data?.state as ActiveBookingOperationState
  )
    ? (data!.state as ActiveBookingOperationState)
    : null;
}

async function boundaryRpc(
  name: string,
  args: Record<string, unknown>
): Promise<SupplierCallBoundaryResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  // These writes are idempotent identity-bound markers. A short network blip
  // after the supplier has answered must not discard an otherwise readable
  // response and turn a known hold into an avoidable reconciliation case.
  // Keep the retries short so a genuinely unavailable authority still fails
  // closed before the supplier response is interpreted.
  const retryDelaysMs = [0, 150, 400] as const;
  let lastCode = 'STORAGE_ERROR';
  let lastMessage = 'Unknown boundary error';
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    const { data, error } = await supabase.rpc(name, args);
    if (!error && data && typeof data === 'object' && !Array.isArray(data)) {
      return data as SupplierCallBoundaryResult;
    }
    lastCode = error ? 'STORAGE_ERROR' : 'INVALID_DATABASE_RESPONSE';
    lastMessage = error?.message ?? 'Invalid database response';
  }
  console.error(`[booking-operation] ${name} failed after retries:`, lastMessage);
  return { ok: false, code: lastCode };
}

export function markBookingOperationSupplierCallStarted(
  operationId: string,
  request: OperationRequestIdentity
): Promise<SupplierCallBoundaryResult> {
  return boundaryRpc('mark_booking_operation_supplier_call_started', {
    p_operation_id: operationId,
    p_request_key: request.requestKey,
    p_request_payload_hash: request.requestPayloadHash,
  });
}

export function markBookingAttemptSupplierCallStarted(
  attemptId: string,
  request: OperationRequestIdentity
): Promise<SupplierCallBoundaryResult> {
  return boundaryRpc('mark_booking_attempt_supplier_call_started', {
    p_attempt_id: attemptId,
    p_request_key: request.requestKey,
    p_request_payload_hash: request.requestPayloadHash,
  });
}

export function markBookingOperationSupplierResponseReceived(
  operationId: string,
  request: OperationRequestIdentity,
  httpStatus: number
): Promise<SupplierCallBoundaryResult> {
  return boundaryRpc('mark_booking_operation_supplier_response_received', {
    p_operation_id: operationId,
    p_request_key: request.requestKey,
    p_request_payload_hash: request.requestPayloadHash,
    p_http_status: httpStatus,
  });
}

export function markBookingAttemptSupplierResponseReceived(
  attemptId: string,
  request: OperationRequestIdentity,
  httpStatus: number
): Promise<SupplierCallBoundaryResult> {
  return boundaryRpc('mark_booking_attempt_supplier_response_received', {
    p_attempt_id: attemptId,
    p_request_key: request.requestKey,
    p_request_payload_hash: request.requestPayloadHash,
    p_http_status: httpStatus,
  });
}

export async function recordSupplierWriteUncertainty(input: {
  subject:
    | { bookingId: string; operationId: string }
    | { attemptId: string };
  actorUserId: string;
  actorRole: string;
  request: OperationRequestIdentity;
  classification: SupplierWriteFailureClassification;
  errorMessage: string;
}): Promise<SupplierUncertaintyRecordResult> {
  if (input.classification.failureClass !== 'uncertain') {
    return { ok: false, code: 'OUTCOME_IS_NOT_UNCERTAIN' };
  }
  const normalizedFacts = {
    failureClass: input.classification.failureClass,
    reasonCode: input.classification.reasonCode,
    supplierCallStarted: input.classification.supplierCallStarted,
    supplierResponseObserved:
      input.classification.supplierResponseObserved,
    supplierResponseRecorded:
      input.classification.supplierResponseRecorded,
    httpStatus: input.classification.httpStatus,
    fundsMustRemainProtected:
      input.classification.fundsMustRemainProtected,
    automaticReplayAllowed: false,
  };
  const normalizedFactsHash = createHash('sha256')
    .update(JSON.stringify(normalizedFacts), 'utf8')
    .digest('hex');
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const bookingSubject =
    'bookingId' in input.subject ? input.subject : null;
  const attemptSubject =
    'attemptId' in input.subject ? input.subject : null;
  const args = {
    p_booking_id: bookingSubject?.bookingId ?? null,
    p_booking_attempt_id: attemptSubject?.attemptId ?? null,
    p_operation_id: bookingSubject?.operationId ?? null,
    p_actor_user_id: input.actorUserId,
    p_actor_role: input.actorRole,
    p_request_key: input.request.requestKey,
    p_request_payload_hash: input.request.requestPayloadHash,
    p_failure_reason_code: input.classification.reasonCode,
    p_http_status: input.classification.httpStatus,
    p_response_observed: input.classification.supplierResponseObserved,
    p_response_recorded: input.classification.supplierResponseRecorded,
    p_normalized_facts: normalizedFacts,
    p_normalized_facts_hash: normalizedFactsHash,
    p_error_message: input.errorMessage.slice(0, 1000),
  };
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await supabase.rpc(
      'record_supplier_write_uncertainty_v2',
      args
    );
    if (!error && data && typeof data === 'object' && !Array.isArray(data)) {
      return data as SupplierUncertaintyRecordResult;
    }
    lastError = error?.message ?? 'Invalid database response';
  }
  console.error(
    '[booking-operation] record supplier uncertainty failed:',
    lastError
  );
  return { ok: false, code: 'STORAGE_ERROR' };
}

export async function processBookingOperationWatchdog(
  limit = 100
): Promise<BookingOperationWatchdogResult> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    return {
      ok: false,
      available: false,
      processed: 0,
      casesCreated: 0,
      thresholdSeconds: 180,
      limit,
      automaticSupplierReplay: false,
      code: 'STORAGE_UNAVAILABLE',
    };
  }
  const { data, error } = await supabase.rpc(
    'process_booking_operation_watchdog',
    { p_limit: limit }
  );
  if (error) {
    console.error('[booking-operation] watchdog failed:', error.message);
    return {
      ok: false,
      available: false,
      processed: 0,
      casesCreated: 0,
      thresholdSeconds: 180,
      limit,
      automaticSupplierReplay: false,
      code: 'WATCHDOG_UNAVAILABLE',
    };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      ok: false,
      available: true,
      processed: 0,
      casesCreated: 0,
      thresholdSeconds: 180,
      limit,
      automaticSupplierReplay: false,
      code: 'INVALID_DATABASE_RESPONSE',
    };
  }
  const result = data as Partial<BookingOperationWatchdogResult>;
  return {
    ok: result.ok === true,
    available: true,
    processed: Number(result.processed) || 0,
    casesCreated: Number(result.casesCreated) || 0,
    thresholdSeconds: Number(result.thresholdSeconds) || 180,
    limit: Number(result.limit) || limit,
    automaticSupplierReplay: false,
    ...(typeof result.code === 'string' ? { code: result.code } : {}),
  };
}

export async function processBookingAttemptWatchdog(
  limit = 100
): Promise<BookingAttemptWatchdogResult> {
  const unavailable = (
    code: string,
    available: boolean
  ): BookingAttemptWatchdogResult => ({
    ok: false,
    available,
    processed: 0,
    casesCreated: 0,
    thresholdSeconds: 180,
    caseDueSeconds: 900,
    limit,
    historicalNullIdentityExcluded: true,
    automaticSupplierReplay: false,
    code,
  });
  const supabase = supabaseAdmin();
  if (!supabase) return unavailable('STORAGE_UNAVAILABLE', false);
  const { data, error } = await supabase.rpc(
    'process_booking_attempt_watchdog',
    { p_limit: limit }
  );
  if (error) {
    console.error('[booking-operation] attempt watchdog failed:', error.message);
    return unavailable('WATCHDOG_UNAVAILABLE', false);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return unavailable('INVALID_DATABASE_RESPONSE', true);
  }
  const result = data as Partial<BookingAttemptWatchdogResult>;
  return {
    ok: result.ok === true,
    available: true,
    processed: Number(result.processed) || 0,
    casesCreated: Number(result.casesCreated) || 0,
    thresholdSeconds: Number(result.thresholdSeconds) || 180,
    caseDueSeconds: Number(result.caseDueSeconds) || 900,
    limit: Number(result.limit) || limit,
    historicalNullIdentityExcluded: true,
    automaticSupplierReplay: false,
    ...(typeof result.code === 'string' ? { code: result.code } : {}),
  };
}
