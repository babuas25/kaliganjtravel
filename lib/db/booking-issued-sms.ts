import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';

export type BookingIssuedSmsClaim = {
  deliveryId: string;
  bookingId: string;
  occurrenceId: string;
  recipientNumber: string;
  recipientNumberHash: string;
  contentSnapshot: Record<string, unknown>;
  claimToken: string;
  attemptCount: number;
};

type ClaimRow = {
  delivery_id: string;
  booking_id: string;
  occurrence_id: string;
  recipient_number: string;
  recipient_number_hash: string;
  content_snapshot: unknown;
  delivery_claim_token: string;
  attempt_count: number;
};

export async function claimBookingIssuedSmsDeliveries(
  limit = 10,
  bookingId?: string
): Promise<BookingIssuedSmsClaim[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('claim_booking_issued_sms_v1', {
    p_limit: Math.max(1, Math.min(Math.trunc(limit), 50)),
    p_booking_id: bookingId ?? null,
  });
  if (error) {
    console.error('[db] issued SMS claim failed:', error.message);
    return [];
  }
  return ((data as ClaimRow[] | null) ?? []).flatMap((row) =>
    row.content_snapshot && typeof row.content_snapshot === 'object'
      ? [{
          deliveryId: row.delivery_id,
          bookingId: row.booking_id,
          occurrenceId: row.occurrence_id,
          recipientNumber: row.recipient_number,
          recipientNumberHash: row.recipient_number_hash,
          contentSnapshot: row.content_snapshot as Record<string, unknown>,
          claimToken: row.delivery_claim_token,
          attemptCount: row.attempt_count,
        }]
      : []
  );
}
export async function markBookingIssuedSmsSent(input: {
  deliveryId: string;
  claimToken: string;
  providerMessageId?: string | null;
}): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('mark_booking_issued_sms_sent_v1', {
    p_delivery_id: input.deliveryId,
    p_claim_token: input.claimToken,
    p_provider_message_id: input.providerMessageId ?? null,
  });
  if (error) console.error('[db] issued SMS completion failed:', error.message);
  return !error && data === true;
}

export async function failBookingIssuedSms(input: {
  deliveryId: string;
  claimToken: string;
  error: string;
}): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('SMS delivery storage is unavailable.');
  const { error } = await supabase.rpc('fail_booking_issued_sms_v1', {
    p_delivery_id: input.deliveryId,
    p_claim_token: input.claimToken,
    p_error: input.error.slice(0, 1_000),
  });
  if (error) throw new Error('SMS delivery failure could not be recorded.');
}

export async function recoverStaleBookingIssuedSmsClaims(
  limit = 100
): Promise<number> {
  const supabase = supabaseAdmin();
  if (!supabase) return 0;
  const { data, error } = await supabase.rpc(
    'recover_stale_booking_issued_sms_claims_v1',
    { p_limit: Math.max(1, Math.min(Math.trunc(limit), 500)) }
  );
  if (error) {
    console.error('[db] issued SMS recovery failed:', error.message);
    return 0;
  }
  return Number(data) || 0;
}
