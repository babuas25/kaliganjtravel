import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';

const WORKER_ID = 'system:pnr-deadline-refresh';

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
 * Drains legacy post-Book refresh jobs without calling the supplier. Migration
 * 0163 stops enqueueing; this also protects application-first deployments.
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
  const state = await finishJob(job.job_id, 'skipped', 'STORED_REFERENCE_TICKETING');
  result.skipped = state === 'skipped' ? 1 : 0;
  result.errorCode = state ? null : 'JOB_COMPLETION_FAILED';
  return result;
}
