import 'server-only';

import { isBookingStatus, type BookingStatus } from '@/lib/flights/booking-status';
import { bookingUserVisibilitySchemaAvailable } from '@/lib/db/booking-visibility';
import { supabaseAdmin } from '@/lib/supabase/server';

export type BookingNotificationOutboxClaim = {
  outboxId: string;
  lifecycleEventId: number;
  bookingId: string;
  occurrenceId: string;
  lifecycleStatus: BookingStatus;
  eventSnapshot: Record<string, unknown>;
  recipientsExpanded: boolean;
  claimToken: string;
  attemptCount: number;
};

type OutboxClaimRow = {
  outbox_id: string;
  lifecycle_event_id: number;
  booking_id: string;
  occurrence_id: string;
  lifecycle_status: string;
  event_snapshot: unknown;
  recipients_expanded: boolean;
  claim_token: string;
  attempt_count: number;
};

export type BookingNotificationRecipientKind =
  | 'customer_contact'
  | 'booking_user'
  | 'agency_user'
  | 'system_copy';

export type BookingNotificationDelivery = {
  deliveryId: string;
  outboxId: string;
  recipientKind: BookingNotificationRecipientKind;
  recipientAddress: string;
  recipientAddressHash: string;
  isHiddenCopy: boolean;
  state: string;
};

type DeliveryRow = {
  delivery_id: string;
  outbox_id: string;
  recipient_kind: BookingNotificationRecipientKind;
  recipient_address: string;
  recipient_address_hash: string;
  is_hidden_copy: boolean;
  state: string;
};

export async function claimBookingNotificationOutboxes(
  limit = 25,
  bookingId?: string
): Promise<BookingNotificationOutboxClaim[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc(
    'claim_booking_notification_outbox_v2',
    { p_limit: limit, p_booking_id: bookingId ?? null }
  );
  if (error) {
    console.error('[db] notification outbox claim failed:', error.message);
    return [];
  }
  return ((data as OutboxClaimRow[] | null) ?? []).flatMap((row) =>
    isBookingStatus(row.lifecycle_status)
      ? [{
          outboxId: row.outbox_id,
          lifecycleEventId: row.lifecycle_event_id,
          bookingId: row.booking_id,
          occurrenceId: row.occurrence_id,
          lifecycleStatus: row.lifecycle_status,
          eventSnapshot:
            row.event_snapshot && typeof row.event_snapshot === 'object'
              ? (row.event_snapshot as Record<string, unknown>)
              : {},
          recipientsExpanded: row.recipients_expanded,
          claimToken: row.claim_token,
          attemptCount: row.attempt_count,
        }]
      : []
  );
}

export async function completeBookingNotificationRecipientExpansion(
  outboxId: string,
  claimToken: string
): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  const { data, error } = await supabase.rpc(
    'complete_booking_notification_recipient_expansion_v1',
    { p_outbox_id: outboxId, p_claim_token: claimToken }
  );
  if (error) {
    console.error('[db] notification recipient expansion failed:', error.message);
    return false;
  }
  return data === true;
}

export type ClaimedBookingNotificationDelivery = {
  deliveryId: string;
  recipientKind: BookingNotificationRecipientKind;
  recipientAddress: string;
  recipientAddressHash: string;
  isHiddenCopy: boolean;
  renderedContent: Record<string, unknown> | null;
  claimToken: string;
  attemptCount: number;
};

type ClaimedDeliveryRow = {
  delivery_id: string;
  recipient_kind: BookingNotificationRecipientKind;
  recipient_address: string;
  recipient_address_hash: string;
  is_hidden_copy: boolean;
  rendered_content: unknown;
  delivery_claim_token: string;
  attempt_count: number;
};

export async function claimBookingNotificationDeliveries(
  outboxId: string,
  outboxClaimToken: string,
  limit = 25
): Promise<ClaimedBookingNotificationDelivery[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc(
    'claim_booking_notification_deliveries_v1',
    {
      p_outbox_id: outboxId,
      p_outbox_claim_token: outboxClaimToken,
      p_limit: limit,
    }
  );
  if (error) {
    console.error('[db] notification delivery claim failed:', error.message);
    throw new Error('Notification recipients could not be claimed.');
  }
  return ((data as ClaimedDeliveryRow[] | null) ?? []).map((row) => ({
    deliveryId: row.delivery_id,
    recipientKind: row.recipient_kind,
    recipientAddress: row.recipient_address,
    recipientAddressHash: row.recipient_address_hash,
    isHiddenCopy: row.is_hidden_copy,
    renderedContent:
      row.rendered_content && typeof row.rendered_content === 'object'
        ? (row.rendered_content as Record<string, unknown>)
        : null,
    claimToken: row.delivery_claim_token,
    attemptCount: row.attempt_count,
  }));
}

/**
 * Completes an occurrence as suppressed when its B2B booking is currently
 * hidden. The lifecycle event and outbox remain intact and are never requeued
 * by Restore.
 */
export async function suppressClaimedBookingNotificationForHiddenUser(input: {
  outboxId: string;
  claimToken: string;
}): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  const { data, error } = await supabase.rpc(
    'suppress_claimed_booking_notification_for_hidden_user_v1',
    {
      p_outbox_id: input.outboxId,
      p_claim_token: input.claimToken,
    }
  );
  if (error) {
    // Expand/contract compatibility: before migration 0117 there is no hidden
    // state to enforce and this RPC intentionally does not exist yet.
    if (
      error.code === 'PGRST202' &&
      !await bookingUserVisibilitySchemaAvailable()
    ) {
      return false;
    }
    console.error('[db] hidden booking notification suppression failed:', error.message);
    throw new Error('Hidden booking notification safety check is unavailable.');
  }
  return data === true;
}

export type StoredBookingNotificationContent = {
  version: 1;
  subject: string;
  html: string;
  text: string;
};

function storedContent(value: unknown): StoredBookingNotificationContent | null {
  if (!value || typeof value !== 'object') return null;
  const content = value as Record<string, unknown>;
  return content.version === 1 &&
    typeof content.subject === 'string' && content.subject.length > 0 &&
    typeof content.html === 'string' && content.html.length > 0 &&
    typeof content.text === 'string' && content.text.length > 0
    ? {
        version: 1,
        subject: content.subject,
        html: content.html,
        text: content.text,
      }
    : null;
}

export function parseStoredBookingNotificationContent(
  value: unknown
): StoredBookingNotificationContent | null {
  return storedContent(value);
}

export async function storeBookingNotificationRender(input: {
  deliveryId: string;
  claimToken: string;
  content: StoredBookingNotificationContent;
}): Promise<StoredBookingNotificationContent> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Notification storage is unavailable.');
  const { data, error } = await supabase.rpc(
    'store_booking_notification_render_v1',
    {
      p_delivery_id: input.deliveryId,
      p_delivery_claim_token: input.claimToken,
      p_rendered_content: input.content,
    }
  );
  const stored = storedContent(data);
  if (error || !stored) {
    console.error('[db] notification render storage failed:', error?.message);
    throw new Error('Notification render could not be stored.');
  }
  return stored;
}

export async function markBookingNotificationDeliverySent(input: {
  deliveryId: string;
  claimToken: string;
  providerMessageId?: string | null;
}): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  const { data, error } = await supabase.rpc(
    'mark_booking_notification_delivery_sent_v1',
    {
      p_delivery_id: input.deliveryId,
      p_delivery_claim_token: input.claimToken,
      p_provider_message_id: input.providerMessageId ?? null,
    }
  );
  if (error) {
    console.error('[db] notification delivery completion failed:', error.message);
    return false;
  }
  return data === true;
}

export async function failBookingNotificationDelivery(input: {
  deliveryId: string;
  claimToken: string;
  error: string;
}): Promise<'retry' | 'dead_letter'> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Notification storage is unavailable.');
  const { data, error } = await supabase.rpc(
    'fail_booking_notification_delivery_v1',
    {
      p_delivery_id: input.deliveryId,
      p_delivery_claim_token: input.claimToken,
      p_error: input.error.slice(0, 1000),
    }
  );
  if (error || (data !== 'retry' && data !== 'dead_letter')) {
    console.error('[db] notification delivery failure record failed:', error?.message);
    throw new Error('Notification delivery failure could not be recorded.');
  }
  return data;
}

export async function finalizeBookingNotificationOutbox(
  outboxId: string,
  claimToken: string
): Promise<Record<string, unknown>> {
  const supabase = supabaseAdmin();
  if (!supabase) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
  const { data, error } = await supabase.rpc(
    'finalize_booking_notification_outbox_v1',
    { p_outbox_id: outboxId, p_claim_token: claimToken }
  );
  if (error) {
    console.error('[db] notification outbox finalization failed:', error.message);
    throw new Error('Notification occurrence could not be finalized.');
  }
  return data && typeof data === 'object'
    ? (data as Record<string, unknown>)
    : { ok: false, code: 'INVALID_RESULT' };
}

export async function failBookingNotificationOutbox(input: {
  outboxId: string;
  claimToken: string;
  error: string;
}): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc('fail_booking_notification_outbox_v1', {
    p_outbox_id: input.outboxId,
    p_claim_token: input.claimToken,
    p_error: input.error.slice(0, 1000),
  });
  if (error) {
    console.error('[db] notification outbox failure record failed:', error.message);
  }
}

export async function recoverStaleBookingNotificationClaims(
  limit = 100
): Promise<{ recoveredDeliveries: number; recoveredOutboxes: number }> {
  const supabase = supabaseAdmin();
  if (!supabase) return { recoveredDeliveries: 0, recoveredOutboxes: 0 };
  const { data, error } = await supabase.rpc(
    'recover_stale_booking_notification_claims_v1',
    { p_limit: limit }
  );
  if (error) {
    console.error('[db] stale notification recovery failed:', error.message);
    return { recoveredDeliveries: 0, recoveredOutboxes: 0 };
  }
  const result = data && typeof data === 'object'
    ? data as Record<string, unknown>
    : {};
  return {
    recoveredDeliveries: Number(result.recoveredDeliveries) || 0,
    recoveredOutboxes: Number(result.recoveredOutboxes) || 0,
  };
}

export async function escalateBookingNotificationDeadLetters(
  limit = 100
): Promise<number> {
  const supabase = supabaseAdmin();
  if (!supabase) return 0;
  const { data, error } = await supabase.rpc(
    'escalate_booking_notification_dead_letters_v1',
    { p_limit: limit }
  );
  if (error) {
    console.error('[db] notification dead-letter escalation failed:', error.message);
    return 0;
  }
  return Number(data) || 0;
}

export async function registerBookingNotificationRecipient(input: {
  outboxId: string;
  claimToken: string;
  recipientKind: BookingNotificationRecipientKind;
  recipientAddress: string;
}): Promise<BookingNotificationDelivery | null> {
  const supabase = supabaseAdmin();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc(
    'register_booking_notification_delivery_v1',
    {
      p_outbox_id: input.outboxId,
      p_claim_token: input.claimToken,
      p_recipient_kind: input.recipientKind,
      p_recipient_address: input.recipientAddress,
    }
  );
  if (error) {
    console.error('[db] notification recipient registration failed:', error.message);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as DeliveryRow | undefined;
  return row
    ? {
        deliveryId: row.delivery_id,
        outboxId: row.outbox_id,
        recipientKind: row.recipient_kind,
        recipientAddress: row.recipient_address,
        recipientAddressHash: row.recipient_address_hash,
        isHiddenCopy: row.is_hidden_copy,
        state: row.state,
      }
    : null;
}
