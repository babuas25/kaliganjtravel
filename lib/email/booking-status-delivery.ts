import 'server-only';

import { canonicalAppOrigin } from '@/lib/app-url';
import { bookingLifecycleRolloutEnabled } from '@/lib/booking-lifecycle/rollout';
import {
  claimBookingNotificationDeliveries,
  claimBookingNotificationOutboxes,
  completeBookingNotificationRecipientExpansion,
  failBookingNotificationDelivery,
  failBookingNotificationOutbox,
  finalizeBookingNotificationOutbox,
  markBookingNotificationDeliverySent,
  parseStoredBookingNotificationContent,
  registerBookingNotificationRecipient,
  storeBookingNotificationRender,
  suppressClaimedBookingNotificationForHiddenUser,
  type BookingNotificationOutboxClaim,
  type StoredBookingNotificationContent,
} from '@/lib/db/booking-notifications';
import {
  bookingNotificationRecipients,
  readBookingById,
  type BookingRow,
} from '@/lib/db/flight-bookings';
import { bookingStatusEmailFromEventSnapshot } from '@/lib/email/booking-event-snapshot';
import { sendBookingStatusEventDelivery } from '@/lib/email/notifications';
import type { BookingStatus } from '@/lib/flights/booking-status';
import { dispatchBookingIssuedSms } from '@/lib/sms/booking-issued-delivery';

type DeliveryCounts = { attempted: number; sent: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Notification delivery failed.';
}

async function expandVisibleRecipients(
  claim: BookingNotificationOutboxClaim
): Promise<boolean> {
  if (claim.recipientsExpanded) return true;
  const row = await readBookingById(claim.bookingId);
  if (!row) throw new Error('Notification booking is unavailable.');
  if (row.audience === 'agency' && row.hidden_from_user) {
    if (!await suppressClaimedBookingNotificationForHiddenUser({
      outboxId: claim.outboxId,
      claimToken: claim.claimToken,
    })) {
      throw new Error('Hidden booking notification could not be suppressed.');
    }
    return false;
  }
  const recipients = await bookingNotificationRecipients(row);
  if (recipients.length === 0) {
    throw new Error('Booking has no visible customer or booking-user recipient.');
  }
  for (const recipient of recipients) {
    const registered = await registerBookingNotificationRecipient({
      outboxId: claim.outboxId,
      claimToken: claim.claimToken,
      recipientKind: recipient.kind,
      recipientAddress: recipient.address,
    });
    if (!registered) throw new Error('A notification recipient could not be registered.');
  }
  if (!await completeBookingNotificationRecipientExpansion(
    claim.outboxId,
    claim.claimToken
  )) {
    throw new Error('Notification recipient expansion could not be completed.');
  }
  return true;
}

function renderOccurrence(
  claim: BookingNotificationOutboxClaim
): StoredBookingNotificationContent {
  const origin = canonicalAppOrigin();
  if (!origin) throw new Error('APP_URL is missing or is not a valid HTTPS URL.');
  const rendered = bookingStatusEmailFromEventSnapshot({
    eventSnapshot: claim.eventSnapshot,
    status: claim.lifecycleStatus,
    bookingUrl: `${origin}/dashboard/bookings/${encodeURIComponent(
      String(claim.eventSnapshot.bookingReference ?? '')
    )}`,
  });
  return {
    version: 1,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  };
}

async function processOutboxClaim(
  claim: BookingNotificationOutboxClaim,
  deliveryLimit = 25
): Promise<DeliveryCounts> {
  let deliveriesClaimed = false;
  try {
    if (await suppressClaimedBookingNotificationForHiddenUser({
      outboxId: claim.outboxId,
      claimToken: claim.claimToken,
    })) {
      return { attempted: 0, sent: 0 };
    }
    if (!await expandVisibleRecipients(claim)) {
      return { attempted: 0, sent: 0 };
    }
    // Validate and render before claiming recipient rows. A malformed/old event
    // snapshot therefore retries the outbox without stranding delivery claims.
    const occurrenceContent = renderOccurrence(claim);
    const deliveries = await claimBookingNotificationDeliveries(
      claim.outboxId,
      claim.claimToken,
      Math.max(1, Math.min(deliveryLimit, 25))
    );
    if (deliveries.length === 0 &&
        await suppressClaimedBookingNotificationForHiddenUser({
          outboxId: claim.outboxId,
          claimToken: claim.claimToken,
        })) {
      return { attempted: 0, sent: 0 };
    }
    deliveriesClaimed = deliveries.length > 0;
    let sent = 0;
    for (const delivery of deliveries) {
      try {
        const content = parseStoredBookingNotificationContent(
          delivery.renderedContent
        ) ?? await storeBookingNotificationRender({
          deliveryId: delivery.deliveryId,
          claimToken: delivery.claimToken,
          content: occurrenceContent,
        });
        await sendBookingStatusEventDelivery({
          to: delivery.recipientAddress,
          status: claim.lifecycleStatus,
          occurrenceId: claim.occurrenceId,
          recipientAddressHash: delivery.recipientAddressHash,
          eventSnapshot: claim.eventSnapshot,
          content,
        });
        if (!await markBookingNotificationDeliverySent({
          deliveryId: delivery.deliveryId,
          claimToken: delivery.claimToken,
        })) {
          throw new Error('Notification send succeeded but completion was not recorded.');
        }
        sent += 1;
      } catch (error) {
        console.error(
          '[email] booking occurrence recipient failed:',
          claim.occurrenceId,
          delivery.recipientAddressHash,
          error
        );
        try {
          await failBookingNotificationDelivery({
            deliveryId: delivery.deliveryId,
            claimToken: delivery.claimToken,
            error: errorMessage(error),
          });
        } catch (recordError) {
          // A send may have committed its completion while the database response
          // was lost. Finalization/recovery re-reads durable state; do not turn
          // this into a second immediate send attempt.
          console.error(
            '[email] recipient failure outcome could not be recorded:',
            claim.occurrenceId,
            delivery.recipientAddressHash,
            recordError
          );
        }
      }
    }
    await finalizeBookingNotificationOutbox(claim.outboxId, claim.claimToken);
    return { attempted: deliveries.length, sent };
  } catch (error) {
    console.error('[email] booking occurrence failed:', claim.occurrenceId, error);
    // Hide may have won while recipient expansion was in progress. In that
    // case the outbox is already terminally suppressed and must not be turned
    // back into a retry by the generic failure path.
    let suppressed = false;
    try {
      suppressed = await suppressClaimedBookingNotificationForHiddenUser({
        outboxId: claim.outboxId,
        claimToken: claim.claimToken,
      });
    } catch (suppressionError) {
      console.error(
        '[email] hidden booking suppression state could not be rechecked:',
        claim.occurrenceId,
        suppressionError
      );
    }
    if (suppressed) {
      return { attempted: 0, sent: 0 };
    }
    // Recipient-level failures are recorded above before finalization. This path
    // is only for expansion/render/claim failures with no stranded claim rows.
    if (!deliveriesClaimed) {
      await failBookingNotificationOutbox({
        outboxId: claim.outboxId,
        claimToken: claim.claimToken,
        error: errorMessage(error),
      });
    }
    return { attempted: 0, sent: 0 };
  }
}

async function dispatchOutboxClaims(
  limit: number,
  bookingId?: string
): Promise<DeliveryCounts> {
  const claims = await claimBookingNotificationOutboxes(
    Math.max(1, Math.min(limit, 25)),
    bookingId
  );
  let attempted = 0;
  let sent = 0;
  // Claim order is event order. Keep it sequential so one booking's later
  // occurrence cannot overtake its earlier eligible occurrence.
  for (const claim of claims) {
    const result = await processOutboxClaim(claim);
    attempted += result.attempted;
    sent += result.sent;
  }
  return { attempted, sent };
}

/** Compatibility entry now dispatches the event occurrence, not booking/status. */
export async function sendBookingStatusEmailOnce(
  row: BookingRow,
  _status?: BookingStatus
): Promise<boolean> {
  if (!bookingLifecycleRolloutEnabled('notificationOutbox')) return false;
  const result = await dispatchOutboxClaims(20, row.id);
  return result.sent > 0;
}

/** Delivers eligible event occurrences for one booking in event order. */
export async function dispatchBookingStatusEmails(
  bookingId: string
): Promise<DeliveryCounts> {
  const emailDelivery = bookingLifecycleRolloutEnabled('notificationOutbox')
    ? dispatchOutboxClaims(20, bookingId)
    : Promise.resolve({ attempted: 0, sent: 0 });
  const [email, sms] = await Promise.all([
    emailDelivery,
    dispatchBookingIssuedSms(bookingId),
  ]);
  return {
    attempted: email.attempted + sms.attempted,
    sent: email.sent + sms.sent,
  };
}

/** Bounded worker entry point used by the protected scheduled route. */
export async function dispatchPendingBookingStatusEmails(
  limit = 25,
  options?: { timeBudgetMs?: number; safetyMarginMs?: number }
): Promise<
  DeliveryCounts & {
    outboxesProcessed: number;
    durationMs: number;
    stopReason: 'drained' | 'limit' | 'time_budget';
  }
> {
  if (!bookingLifecycleRolloutEnabled('notificationOutbox')) {
    return {
      attempted: 0,
      sent: 0,
      outboxesProcessed: 0,
      durationMs: 0,
      stopReason: 'drained',
    };
  }
  const normalizedLimit = Math.max(1, Math.min(Math.trunc(limit), 25));
  const timeBudgetMs = Math.max(
    1_000,
    Math.min(options?.timeBudgetMs ?? 30_000, 45_000)
  );
  const safetyMarginMs = Math.max(
    500,
    Math.min(options?.safetyMarginMs ?? 22_000, timeBudgetMs - 500)
  );
  const startedAt = performance.now();
  let outboxesProcessed = 0;
  let attempted = 0;
  let sent = 0;
  let stopReason: 'drained' | 'limit' | 'time_budget' = 'limit';

  while (outboxesProcessed < normalizedLimit) {
    if (performance.now() - startedAt >= timeBudgetMs - safetyMarginMs) {
      stopReason = 'time_budget';
      break;
    }
    // Claim one outbox and one visible recipient at a time. The worker never
    // strands a preclaimed batch when its scheduler budget is nearly spent.
    const claims = await claimBookingNotificationOutboxes(1);
    if (claims.length === 0) {
      stopReason = 'drained';
      break;
    }
    const result = await processOutboxClaim(claims[0], 1);
    outboxesProcessed += 1;
    attempted += result.attempted;
    sent += result.sent;
  }

  return {
    attempted,
    sent,
    outboxesProcessed,
    durationMs: Math.round(performance.now() - startedAt),
    stopReason,
  };
}
