import 'server-only';

import { claimBookingDeadlineRead, finishBookingDeadlineRead } from '@/lib/db/booking-deadline-read-budget';
import { syncPnrDetails } from '@/lib/db/flight-bookings';
import { supabaseAdmin } from '@/lib/supabase/server';
import { isTriploverSupplier } from '@/lib/triplover/config';
import { pnrLookupLocators, readPnr } from '@/lib/triplover/pnr';

const WORKER_ID = 'system:pnr-deadline-refresh';
const PNR_REFRESH_TIMEOUT_MS = 25_000;

type ClaimedPnrRefreshJob = {
  job_id: string;
  booking_id: string;
  supplier_account: string;
  supplier_refs: unknown;
  pnr: string | null;
  booking_ref_number: string | null;
  booking_code_ref: string | null;
  carrier_code: string | null;
  deadline_not_before: string | null;
};

type PnrRefreshCompletionOutcome =
  | 'deadline_found'
  | 'deadline_missing'
  | 'retryable_error'
  | 'skipped';

export type BookingPnrRefreshWorkerResult = {
  available: boolean;
  claimed: boolean;
  completed: number;
  requeued: number;
  exhausted: number;
  skipped: number;
  errorCode: string | null;
};

function emptyResult(
  available: boolean,
  errorCode: string | null = null
): BookingPnrRefreshWorkerResult {
  return {
    available,
    claimed: false,
    completed: 0,
    requeued: 0,
    exhausted: 0,
    skipped: 0,
    errorCode,
  };
}

function references(value: unknown): {
  uniqueTransId: string;
  itemCodeRef: string;
  priceCodeRef: string;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const uniqueTransId = typeof source.uniqueTransId === 'string'
    ? source.uniqueTransId.trim()
    : '';
  const itemCodeRef = typeof source.itemCodeRef === 'string'
    ? source.itemCodeRef.trim()
    : '';
  const priceCodeRef = typeof source.priceCodeRef === 'string'
    ? source.priceCodeRef.trim()
    : '';
  return uniqueTransId && itemCodeRef && priceCodeRef
    ? { uniqueTransId, itemCodeRef, priceCodeRef }
    : null;
}

function safeErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'PNR_REFRESH_FAILED';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_:-]{1,80}$/i.test(code)
    ? code.toUpperCase()
    : 'PNR_REFRESH_FAILED';
}

async function finishJob(
  jobId: string,
  outcome: PnrRefreshCompletionOutcome,
  errorCode: string | null
): Promise<'completed' | 'pending' | 'exhausted' | 'skipped' | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc(
    'finish_booking_pnr_refresh_job_v1',
    {
      p_job_id: jobId,
      p_worker_id: WORKER_ID,
      p_outcome: outcome,
      p_error_code: errorCode,
    }
  );
  if (error || !data || typeof data !== 'object' || Array.isArray(data)) {
    console.error(
      '[booking-pnr-refresh] job completion failed:',
      error?.message ?? 'invalid database response'
    );
    return null;
  }
  const state = (data as { state?: unknown }).state;
  return state === 'completed' || state === 'pending' || state === 'exhausted' ||
    state === 'skipped'
    ? state
    : null;
}

/**
 * Processes one durable, read-only supplier PNR check. The queue controls
 * timing and retries; this worker never replays Book and only persists a PNR
 * refresh when the supplier actually supplied a deadline.
 */
export async function processBookingPnrRefreshJob(): Promise<BookingPnrRefreshWorkerResult> {
  const supabase = supabaseAdmin();
  if (!supabase) return emptyResult(false, 'STORAGE_UNAVAILABLE');

  const { data, error } = await supabase.rpc(
    'claim_due_booking_pnr_refresh_job_v1',
    { p_worker_id: WORKER_ID }
  );
  if (error) {
    console.error('[booking-pnr-refresh] job claim failed:', error.message);
    return emptyResult(true, 'JOB_CLAIM_FAILED');
  }
  const job = Array.isArray(data) ? data[0] as ClaimedPnrRefreshJob | undefined : undefined;
  if (!job) return emptyResult(true);

  const result = emptyResult(true);
  result.claimed = true;
  const supplier = isTriploverSupplier(job.supplier_account)
    ? job.supplier_account
    : null;
  const refs = references(job.supplier_refs);
  const locators = pnrLookupLocators({
    pnr: job.pnr,
    bookingRefNumber: job.booking_ref_number,
  });
  if (!supplier || !refs || !locators || !job.booking_code_ref?.trim()) {
    const state = await finishJob(job.job_id, 'skipped', 'LOCAL_REFERENCE_INCOMPLETE');
    result.skipped = state === 'skipped' ? 1 : 0;
    result.errorCode = state ? null : 'JOB_COMPLETION_FAILED';
    return result;
  }

  let claimToken: string | undefined;
  try {
    const claim = await claimBookingDeadlineRead(job.booking_id);
    if (!claim.claimed) {
      const state = await finishJob(job.job_id,
        claim.complete ? 'skipped' : 'retryable_error',
        claim.complete ? 'SHARED_BUDGET_COMPLETE' : 'SHARED_READ_IN_PROGRESS');
      result.skipped = state === 'skipped' ? 1 : 0;
      result.requeued = state === 'pending' ? 1 : 0;
      result.exhausted = state === 'exhausted' ? 1 : 0;
      return result;
    }
    claimToken = claim.claimToken;
    const pnr = await readPnr({
      ...refs,
      supplier,
      ...locators,
      bookingCodeRef: job.booking_code_ref.trim(),
      carrierCode: job.carrier_code,
      deadlineNotBefore: job.deadline_not_before,
      timeoutMs: PNR_REFRESH_TIMEOUT_MS,
    });

    if (!pnr.lastTicketTime) {
      const state = await finishJob(job.job_id, 'deadline_missing', null);
      result.requeued = state === 'pending' ? 1 : 0;
      result.exhausted = state === 'exhausted' ? 1 : 0;
      result.errorCode = state ? null : 'JOB_COMPLETION_FAILED';
      return result;
    }

    await syncPnrDetails(
      job.booking_id,
      pnr,
      { clerkId: WORKER_ID, role: 'system' },
      'ordinary_sync'
    );
    const state = await finishJob(job.job_id, 'deadline_found', null);
    result.completed = state === 'completed' ? 1 : 0;
    result.errorCode = state ? null : 'JOB_COMPLETION_FAILED';
    return result;
  } catch (error) {
    const state = await finishJob(job.job_id, 'retryable_error', safeErrorCode(error));
    result.requeued = state === 'pending' ? 1 : 0;
    result.exhausted = state === 'exhausted' ? 1 : 0;
    result.errorCode = state ? null : 'JOB_COMPLETION_FAILED';
    return result;
  } finally {
    if (claimToken) await finishBookingDeadlineRead(job.booking_id, claimToken);
  }
}
