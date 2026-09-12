import 'server-only';

import { canonicalAppOrigin } from '@/lib/app-url';
import {
  claimTicketManagementNotificationDeliveries,
  claimTicketManagementNotificationOutboxes,
  expandTicketManagementNotificationRecipients,
  failTicketManagementNotificationDelivery,
  failTicketManagementNotificationOutbox,
  finalizeTicketManagementNotificationOutbox,
  markTicketManagementNotificationDeliverySent,
  parseStoredTicketManagementNotification,
  storeTicketManagementNotificationRender,
  type StoredTicketManagementNotification,
  type TicketManagementNotificationClaim,
} from '@/lib/db/ticket-management-notifications';
import { sendEmail } from '@/lib/email/mailer';
import { ticketManagementNotificationEmail } from '@/lib/email/templates';

const EVENT_LABELS: Record<string, string> = {
  requested: 'Requested',
  accepted: 'Accepted',
  'staff-rejected': 'Rejected by staff',
  'quotation-published': 'Quotation ready',
  'customer-approved': 'Approved by customer',
  'customer-rejected': 'Rejected by customer',
  'confirmation-expired': 'Confirmation expired',
  'requote-started': 'Returned for a new quotation',
  assigned: 'Assigned for settlement',
  reassigned: 'Reassigned for settlement',
  'manual-processing-recorded': 'Manual processing recorded',
  completed: 'Approved — settlement recorded',
  'financial-exception': 'Financial exception',
};

const STATUS_LABELS: Record<string, string> = {
  requested: 'Requested',
  'in-progress': 'In Progress',
  'awaiting-confirmation': 'Quotation',
  approved: 'Approved',
  completed: 'Approved',
  rejected: 'Rejected',
  expired: 'Expired',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function dateTime(value: unknown): string {
  const valueText = text(value);
  const valueDate = new Date(valueText);
  return valueText && !Number.isNaN(valueDate.getTime())
    ? new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'Asia/Dhaka',
      }).format(valueDate)
    : '—';
}

function renderClaim(
  claim: TicketManagementNotificationClaim
): StoredTicketManagementNotification {
  const origin = canonicalAppOrigin();
  if (!origin) throw new Error('APP_URL is missing or is not a valid HTTPS URL.');
  const snapshot = claim.snapshot;
  const quote = snapshot.quote && typeof snapshot.quote === 'object'
    ? snapshot.quote as Record<string, unknown>
    : {};
  const action = text(snapshot.action);
  const currency = text(snapshot.currency) || 'BDT';
  const customerAmount = Number(quote.customerAmount);
  const content = ticketManagementNotificationEmail({
    audience: claim.audience,
    actionLabel: action ? `${action[0].toUpperCase()}${action.slice(1)}` : 'Ticket',
    eventLabel: EVENT_LABELS[claim.eventType] ?? 'Updated',
    requestReference: text(snapshot.requestPublicRef) || 'Ticket Management request',
    statusLabel: STATUS_LABELS[text(snapshot.status)] ?? (text(snapshot.status) || 'Updated'),
    effectiveAt: dateTime(snapshot.effectiveAt),
    dashboardUrl: `${origin}/dashboard/bookings`,
    amount: Number.isSafeInteger(customerAmount)
      ? new Intl.NumberFormat('en-BD', {
          style: 'currency', currency, maximumFractionDigits: 2,
        }).format(customerAmount / 100)
      : null,
    confirmationDeadline: quote.confirmationDeadlineAt
      ? dateTime(quote.confirmationDeadlineAt)
      : null,
  });
  return { version: 1, ...content };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Ticket Management email failed.';
}

async function processClaim(claim: TicketManagementNotificationClaim) {
  let deliveriesClaimed = false;
  try {
    if (!claim.recipientsExpanded) {
      await expandTicketManagementNotificationRecipients(claim.outboxId, claim.claimToken);
    }
    const rendered = renderClaim(claim);
    const deliveries = await claimTicketManagementNotificationDeliveries(
      claim.outboxId,
      claim.claimToken,
      25
    );
    deliveriesClaimed = deliveries.length > 0;
    let sent = 0;
    for (const delivery of deliveries) {
      const messageId = `<ticket-management-${claim.outboxId}-${delivery.recipientAddressHash.slice(0, 20)}@kaliganjtravel.com>`;
      try {
        const content = parseStoredTicketManagementNotification(delivery.renderedContent)
          ?? await storeTicketManagementNotificationRender({
            deliveryId: delivery.deliveryId,
            claimToken: delivery.claimToken,
            content: rendered,
          });
        await sendEmail({
          to: delivery.recipientAddress,
          subject: content.subject,
          html: content.html,
          text: content.text,
          messageId,
        });
        if (!await markTicketManagementNotificationDeliverySent({
          deliveryId: delivery.deliveryId,
          claimToken: delivery.claimToken,
          providerMessageId: messageId,
        })) {
          throw new Error('Email was sent but its completion was not stored.');
        }
        sent += 1;
      } catch (error) {
        console.error('[email] Ticket Management recipient delivery failed:', delivery.recipientAddressHash, error);
        await failTicketManagementNotificationDelivery({
          deliveryId: delivery.deliveryId,
          claimToken: delivery.claimToken,
          error: errorMessage(error),
        });
      }
    }
    await finalizeTicketManagementNotificationOutbox(claim.outboxId, claim.claimToken);
    return { attempted: deliveries.length, sent };
  } catch (error) {
    console.error('[email] Ticket Management notification failed:', claim.outboxId, error);
    if (!deliveriesClaimed) {
      await failTicketManagementNotificationOutbox({
        outboxId: claim.outboxId,
        claimToken: claim.claimToken,
        error: errorMessage(error),
      });
    }
    return { attempted: 0, sent: 0 };
  }
}

export async function dispatchPendingTicketManagementEmails(
  limit = 10,
  requestId?: string
): Promise<{ outboxesProcessed: number; attempted: number; sent: number }> {
  const claims = await claimTicketManagementNotificationOutboxes(
    Math.max(1, Math.min(limit, 25)),
    requestId
  );
  let attempted = 0;
  let sent = 0;
  for (const claim of claims) {
    const result = await processClaim(claim);
    attempted += result.attempted;
    sent += result.sent;
  }
  return { outboxesProcessed: claims.length, attempted, sent };
}
