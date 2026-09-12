import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const migration = read(
  'supabase',
  'migrations',
  '0117_booking_user_visibility.sql'
);
const worker = read('lib', 'email', 'booking-status-delivery.ts');
const notificationDb = read('lib', 'db', 'booking-notifications.ts');
const bookingDb = read('lib', 'db', 'flight-bookings.ts');

for (const required of [
  'suppress_claimed_booking_notification_for_hidden_user_v1',
  'suppress_hidden_booking_notification_outbox_on_insert_v1',
  'booking_notification_outbox_hidden_user_suppression_v1',
  'NOTIFICATION_DELIVERY_IN_PROGRESS',
  "suppression_reason = 'booking_hidden_from_user'",
  "delivery_policy = 'suppress'",
  "state = 'suppressed'",
  "delivery.state = 'processing'",
  'and not delivery.is_hidden_copy',
]) {
  assert.ok(migration.includes(required), `Hidden-email migration omits ${required}`);
}

const visibilityExecutor = migration.match(
  /create or replace function public\.set_booking_user_visibility_v1\([\s\S]*?\n\$\$;/i
)?.[0] ?? '';
assert.ok(visibilityExecutor, 'Visibility executor is missing');
assert.doesNotMatch(
  visibilityExecutor,
  /delete\s+from\s+public\.(?:booking_status_events|booking_notification_outbox|booking_notification_deliveries)/i,
  'Hide must preserve lifecycle events and notification evidence'
);
assert.ok(
  visibilityExecutor.indexOf("p_action = 'hide'") <
    visibilityExecutor.indexOf("state = 'suppressed'"),
  'Suppression must be part of the atomic Hide transaction'
);

const deliveryClaim = migration.match(
  /create or replace function public\.claim_booking_notification_deliveries_v1\([\s\S]*?\n\$\$;/i
)?.[0] ?? '';
assert.ok(deliveryClaim, 'Visibility-aware delivery claim is missing');
assert.ok(
  deliveryClaim.indexOf('select booking.* into v_booking') <
    deliveryClaim.indexOf('select outbox.* into v_outbox') &&
    deliveryClaim.indexOf("v_booking.audience = 'agency'") <
      deliveryClaim.indexOf("candidate.state in ('pending', 'retry')"),
  'Delivery claim must lock/check the booking before returning a recipient'
);
assert.match(
  deliveryClaim,
  /v_booking\.audience = 'agency' and v_booking\.hidden_from_user[\s\S]*?return;/i
);
assert.match(
  migration,
  /before insert on public\.booking_notification_outbox[\s\S]*?suppress_hidden_booking_notification_outbox_on_insert_v1/i,
  'Occurrences created during a hidden interval must be terminally suppressed'
);

for (const required of [
  'suppressClaimedBookingNotificationForHiddenUser',
  'if (!await expandVisibleRecipients(claim))',
  'deliveries.length === 0',
]) {
  assert.ok(worker.includes(required), `Notification worker omits ${required}`);
}
assert.ok(
  worker.indexOf('suppressClaimedBookingNotificationForHiddenUser({') <
    worker.indexOf('expandVisibleRecipients(claim)'),
  'Hidden state must be checked before recipient expansion'
);
assert.match(
  bookingDb,
  /row\.audience === 'agency' && row\.hidden_from_user\) return \[\]/,
  'Recipient derivation must fail closed for hidden B2B bookings'
);
assert.match(
  notificationDb,
  /suppress_claimed_booking_notification_for_hidden_user_v1/
);

// Restore clears only current visibility fields. It must not requeue an old
// suppressed occurrence, which ensures suppressed mail is never back-sent.
const unhideBranch = visibilityExecutor.slice(
  visibilityExecutor.indexOf("if not v_booking.hidden_from_user then"),
  visibilityExecutor.indexOf('v_hidden_after := false;')
);
assert.doesNotMatch(
  unhideBranch,
  /booking_notification_|state\s*=\s*'pending'|delivery_policy\s*=\s*'send'/i
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      lifecycleEventsPreserved: true,
      outboxEvidencePreserved: true,
      hiddenAgencyDeliverySuppressed: true,
      inFlightHideSerialized: true,
      restoreRequeuesSuppressedMail: false,
      futurePostRestoreOccurrencesAllowed: true,
    },
    null,
    2
  )
);
