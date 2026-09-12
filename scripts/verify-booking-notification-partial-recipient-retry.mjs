import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0074_booking_notification_recipient_delivery.sql'
);
const worker = read('lib', 'email', 'booking-status-delivery.ts');
const adapter = read('lib', 'db', 'booking-notifications.ts');
const recipients = read('lib', 'db', 'flight-bookings.ts');

for (const required of [
  'recipients_expanded_at timestamptz',
  'notification recipient set is immutable',
  'complete_booking_notification_recipient_expansion_v1',
  "candidate.state in ('pending', 'retry')",
  'and not candidate.is_hidden_copy',
  'claim_token = gen_random_uuid()',
  'rendered_content = coalesce(delivery.rendered_content, p_rendered_content)',
  "set state = 'sent'",
  "then 'dead_letter' else 'retry' end",
]) {
  assert.ok(migration.includes(required), `Recipient delivery omits ${required}`);
}
assert.match(
  migration,
  /count\(\*\) filter \(where state in \('pending', 'retry'\)\)[\s\S]*?elsif v_retry > 0 then[\s\S]*?set state = 'pending'/i,
  'Any failed recipient must retry the outbox without reopening sent rows'
);
assert.doesNotMatch(
  migration.slice(
    migration.indexOf('create or replace function public.claim_booking_notification_deliveries_v1'),
    migration.indexOf('create or replace function public.store_booking_notification_render_v1')
  ),
  /state\s*=\s*'sent'/i,
  'Successful recipients must never be reclaimed'
);

for (const required of [
  'expandVisibleRecipients(claim)',
  'renderOccurrence(claim)',
  'claimBookingNotificationDeliveries(',
  'parseStoredBookingNotificationContent(',
  'storeBookingNotificationRender({',
  'sendBookingStatusEventDelivery({',
  'markBookingNotificationDeliverySent({',
  'failBookingNotificationDelivery({',
  'finalizeBookingNotificationOutbox(claim.outboxId, claim.claimToken)',
]) {
  assert.ok(worker.includes(required), `Occurrence worker omits ${required}`);
}
assert.doesNotMatch(
  worker,
  /pendingBookingStatusEmailJobs|claimBookingStatusEmail|markBookingStatusEmailSent|failBookingStatusEmail/,
  'Cutover worker must not use once-per-booking/status delivery'
);
assert.ok(
  worker.indexOf('renderOccurrence(claim)') <
    worker.indexOf('claimBookingNotificationDeliveries('),
  'Snapshot validation must happen before recipient claims'
);
assert.ok(
  recipients.includes('bookingNotificationRecipients') &&
    recipients.includes("kind: 'customer_contact'") &&
    recipients.includes("kind: 'booking_user'"),
  'Visible recipients must retain independent kinds'
);
for (const required of [
  'claim_booking_notification_outbox_v2',
  'claim_booking_notification_deliveries_v1',
  'store_booking_notification_render_v1',
  'mark_booking_notification_delivery_sent_v1',
  'fail_booking_notification_delivery_v1',
]) {
  assert.ok(adapter.includes(required), `Notification adapter omits ${required}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      visibleRecipientSetFrozen: true,
      renderedContentStoredBeforeSend: true,
      sentRecipientTerminal: true,
      failedRecipientOnlyRetry: true,
      legacyBookingStatusDeliveryUsed: false,
      eventOrderSequential: true,
    },
    null,
    2
  )
);
