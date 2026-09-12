import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/server';

export type TicketManagementNotificationClaim = {
  outboxId: string;
  requestId: string;
  audience: 'customer' | 'internal';
  eventType: string;
  snapshot: Record<string, unknown>;
  recipientsExpanded: boolean;
  claimToken: string;
};

type ClaimRow = {
  outbox_id: string;
  request_id: string;
  audience: string;
  event_type: string;
  snapshot: unknown;
  recipients_expanded: boolean;
  claim_token: string;
};

export type TicketManagementNotificationDelivery = {
  deliveryId: string;
  recipientAddress: string;
  recipientAddressHash: string;
  renderedContent: Record<string, unknown> | null;
  claimToken: string;
};

type DeliveryRow = {
  delivery_id: string;
  recipient_address: string;
  recipient_address_hash: string;
  rendered_content: unknown;
  delivery_claim_token: string;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function claimTicketManagementNotificationOutboxes(
  limit = 25,
  requestId?: string
): Promise<TicketManagementNotificationClaim[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc(
    'claim_ticket_management_notification_outbox_v1',
    { p_limit: limit, p_request_id: requestId ?? null }
  );
  if (error) throw new Error(`Ticket Management notification claim failed: ${error.message}`);
  return ((data as ClaimRow[] | null) ?? []).flatMap((row) =>
    row.audience === 'customer' || row.audience === 'internal'
      ? [{
          outboxId: row.outbox_id,
          requestId: row.request_id,
          audience: row.audience,
          eventType: row.event_type,
          snapshot: objectValue(row.snapshot),
          recipientsExpanded: row.recipients_expanded,
          claimToken: row.claim_token,
        }]
      : []
  );
}

export async function expandTicketManagementNotificationRecipients(
  outboxId: string,
  claimToken: string
): Promise<number> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Ticket Management notification storage is unavailable.');
  const { data, error } = await supabase.rpc(
    'expand_ticket_management_notification_recipients_v1',
    { p_outbox_id: outboxId, p_claim_token: claimToken }
  );
  if (error) throw new Error(`Ticket Management recipient expansion failed: ${error.message}`);
  return Number(data) || 0;
}

export async function claimTicketManagementNotificationDeliveries(
  outboxId: string,
  claimToken: string,
  limit = 25
): Promise<TicketManagementNotificationDelivery[]> {
  const supabase = supabaseAdmin();
  if (!supabase) return [];
  const { data, error } = await supabase.rpc(
    'claim_ticket_management_notification_deliveries_v1',
    { p_outbox_id: outboxId, p_outbox_claim_token: claimToken, p_limit: limit }
  );
  if (error) throw new Error(`Ticket Management delivery claim failed: ${error.message}`);
  return ((data as DeliveryRow[] | null) ?? []).map((row) => ({
    deliveryId: row.delivery_id,
    recipientAddress: row.recipient_address,
    recipientAddressHash: row.recipient_address_hash,
    renderedContent: Object.keys(objectValue(row.rendered_content)).length
      ? objectValue(row.rendered_content)
      : null,
    claimToken: row.delivery_claim_token,
  }));
}

export type StoredTicketManagementNotification = {
  version: 1;
  subject: string;
  html: string;
  text: string;
};

export function parseStoredTicketManagementNotification(
  value: unknown
): StoredTicketManagementNotification | null {
  const content = objectValue(value);
  return content.version === 1 &&
    typeof content.subject === 'string' && content.subject &&
    typeof content.html === 'string' && content.html &&
    typeof content.text === 'string' && content.text
    ? {
        version: 1,
        subject: content.subject,
        html: content.html,
        text: content.text,
      }
    : null;
}

export async function storeTicketManagementNotificationRender(input: {
  deliveryId: string;
  claimToken: string;
  content: StoredTicketManagementNotification;
}): Promise<StoredTicketManagementNotification> {
  const supabase = supabaseAdmin();
  if (!supabase) throw new Error('Ticket Management notification storage is unavailable.');
  const { data, error } = await supabase.rpc(
    'store_ticket_management_notification_render_v1',
    {
      p_delivery_id: input.deliveryId,
      p_delivery_claim_token: input.claimToken,
      p_rendered_content: input.content,
    }
  );
  const content = parseStoredTicketManagementNotification(data);
  if (error || !content) throw new Error(`Ticket Management render storage failed: ${error?.message ?? 'invalid result'}`);
  return content;
}

export async function markTicketManagementNotificationDeliverySent(input: {
  deliveryId: string;
  claimToken: string;
  providerMessageId: string;
}): Promise<boolean> {
  const supabase = supabaseAdmin();
  if (!supabase) return false;
  const { data, error } = await supabase.rpc(
    'mark_ticket_management_notification_delivery_sent_v1',
    {
      p_delivery_id: input.deliveryId,
      p_delivery_claim_token: input.claimToken,
      p_provider_message_id: input.providerMessageId,
    }
  );
  if (error) throw new Error(`Ticket Management delivery completion failed: ${error.message}`);
  return data === true;
}

export async function failTicketManagementNotificationDelivery(input: {
  deliveryId: string;
  claimToken: string;
  error: string;
}): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc(
    'fail_ticket_management_notification_delivery_v1',
    {
      p_delivery_id: input.deliveryId,
      p_delivery_claim_token: input.claimToken,
      p_error: input.error.slice(0, 1000),
    }
  );
  if (error) console.error('[db] Ticket Management delivery failure could not be recorded:', error.message);
}

export async function finalizeTicketManagementNotificationOutbox(
  outboxId: string,
  claimToken: string
): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc(
    'finalize_ticket_management_notification_outbox_v1',
    { p_outbox_id: outboxId, p_claim_token: claimToken }
  );
  if (error) throw new Error(`Ticket Management outbox finalization failed: ${error.message}`);
}

export async function failTicketManagementNotificationOutbox(input: {
  outboxId: string;
  claimToken: string;
  error: string;
}): Promise<void> {
  const supabase = supabaseAdmin();
  if (!supabase) return;
  const { error } = await supabase.rpc(
    'fail_ticket_management_notification_outbox_v1',
    {
      p_outbox_id: input.outboxId,
      p_claim_token: input.claimToken,
      p_error: input.error.slice(0, 1000),
    }
  );
  if (error) console.error('[db] Ticket Management outbox failure could not be recorded:', error.message);
}

export async function recoverStaleTicketManagementNotificationClaims(
  limit = 100
): Promise<{ recoveredDeliveries: number; recoveredOutboxes: number }> {
  const supabase = supabaseAdmin();
  if (!supabase) return { recoveredDeliveries: 0, recoveredOutboxes: 0 };
  const { data, error } = await supabase.rpc(
    'recover_stale_ticket_management_notification_claims_v1',
    { p_limit: limit }
  );
  if (error) throw new Error(`Ticket Management notification recovery failed: ${error.message}`);
  const result = objectValue(data);
  return {
    recoveredDeliveries: Number(result.recoveredDeliveries) || 0,
    recoveredOutboxes: Number(result.recoveredOutboxes) || 0,
  };
}
