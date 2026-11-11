import { deadlineWebhookKeys, verifyDeadlineWebhook } from '@/lib/shapontravels/deadline-webhook';
import { supabaseAdmin } from '@/lib/supabase/server';

export const runtime = 'nodejs';

const ACKNOWLEDGED = new Set(['updated', 'unchanged', 'stale', 'duplicate', 'ignored']);
const CONFLICTS = new Set(['SHAPON_DEADLINE_EVENT_CONFLICT', 'SHAPON_DEADLINE_REVISION_CONFLICT']);

function reply(status: number): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  const keys = deadlineWebhookKeys(process.env);
  if (!keys) return reply(503);

  const verified = await verifyDeadlineWebhook(request, keys);
  if ('status' in verified) return reply(verified.status);

  const event = verified.event;
  try {
    const db = supabaseAdmin();
    if (!db) return reply(503);
    const { data, error } = await db.rpc('apply_shapon_booking_deadline', {
      p_booking_id: null,
      p_supplier_booking_id: event.bookingId,
      p_supplier_public_ref: event.reference,
      p_expected_updated_at: null,
      p_revision: event.revision,
      p_deadline_at: event.deadline,
      p_event_id: event.id,
    });
    if (error?.code === '22023') return reply(CONFLICTS.has(error.message) ? 409 : 400);
    if (!error && data && ACKNOWLEDGED.has(data.result)) return reply(204);
    // An event can arrive before its local booking is saved, or while another
    // booking operation is active. Leave it unacknowledged so the sender can retry.
    return reply(503);
  } catch {
    return reply(503);
  }
}
