import 'server-only';

import type {
  BookingUserVisibilityContext,
  BookingUserVisibilityMutationResult,
  BookingVisibilityAction,
} from '@/lib/booking-visibility';
import { supabaseAdmin } from '@/lib/supabase/server';

let visibilitySchemaObserved = false;

/**
 * Expand/contract guard for an application process that starts before the
 * additive migration. A missing column is safe to treat as legacy because no
 * booking can be hidden until that column exists. Other database errors fail
 * closed through the normal visibility-aware query path.
 */
export async function bookingUserVisibilitySchemaAvailable(): Promise<boolean> {
  if (visibilitySchemaObserved) return true;
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  const { error } = await supabase
    .from('flight_bookings')
    .select('hidden_from_user')
    .limit(1);
  if (!error) {
    visibilitySchemaObserved = true;
    return true;
  }
  if (
    error.code === '42703' ||
    /hidden_from_user.*does not exist/i.test(error.message)
  ) {
    return false;
  }
  console.error('[db] booking visibility schema check failed:', error.message);
  return true;
}

export async function readBookingUserVisibilityContext(input: {
  bookingId: string;
  actorUserId: string;
}): Promise<BookingUserVisibilityContext | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc(
    'booking_user_visibility_context_v1',
    {
      p_booking_id: input.bookingId,
      p_actor_user_id: input.actorUserId,
    }
  );
  if (error) {
    if (error.code !== 'PGRST202') {
      console.error('[db] booking visibility context failed:', error.message);
    }
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data as unknown as BookingUserVisibilityContext;
}

export async function setBookingUserVisibility(input: {
  bookingReference: string;
  action: BookingVisibilityAction;
  reason: string;
  actorUserId: string;
  requestKey: string;
}): Promise<BookingUserVisibilityMutationResult> {
  const supabase = supabaseAdmin();
  if (!supabase) {
    return { ok: false, code: 'VISIBILITY_STORAGE_UNAVAILABLE' };
  }
  const { data, error } = await supabase.rpc('set_booking_user_visibility_v1', {
    p_booking_reference: input.bookingReference,
    p_action: input.action,
    p_reason: input.reason,
    p_actor_user_id: input.actorUserId,
    p_request_key: input.requestKey,
  });
  if (error) {
    console.error('[db] booking visibility change failed:', error.message);
    return { ok: false, code: 'VISIBILITY_STORAGE_ERROR' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'VISIBILITY_INVALID_RESULT' };
  }
  return data as unknown as BookingUserVisibilityMutationResult;
}
