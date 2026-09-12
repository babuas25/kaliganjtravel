import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';

type DeadlineReadClaim = { claimed: boolean; complete: boolean; claimToken?: string };

export async function claimBookingDeadlineRead(bookingId: string): Promise<DeadlineReadClaim> {
  const db = supabaseAdmin();
  if (!db) throw new Error('Deadline read budget storage is unavailable.');
  const { data, error } = await db.rpc('claim_booking_deadline_read_v1', { p_booking_id: bookingId });
  if (error || !data || typeof data.claimed !== 'boolean' || typeof data.complete !== 'boolean' ||
      (data.claimed && typeof data.claimToken !== 'string')) {
    throw new Error('Deadline read budget could not be claimed.');
  }
  return data as DeadlineReadClaim;
}

export async function finishBookingDeadlineRead(bookingId: string, claimToken: string): Promise<void> {
  const db = supabaseAdmin();
  if (!db) return;
  const { error } = await db.rpc('finish_booking_deadline_read_v1', {
    p_booking_id: bookingId, p_claim_token: claimToken,
  });
  if (error) console.error('[deadline-refresh] budget completion failed:', error.code);
}
