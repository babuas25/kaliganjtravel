import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0075_booking_notification_resilience_metrics.sql'
);
const adapter = read('lib', 'db', 'booking-notifications.ts');
const cron = read('app', 'api', 'cron', 'booking-status-emails', 'route.ts');
const metricsDb = read('lib', 'db', 'booking-lifecycle-metrics.ts');
const metricsType = read('lib', 'dashboard', 'booking-lifecycle-metrics.ts');
const metricsUi = read(
  'components',
  'dashboard',
  'bookings',
  'BookingLifecycleMetricsPanel.tsx'
);

for (const delay of [
  "interval '1 minute'",
  "interval '5 minutes'",
  "interval '15 minutes'",
  "interval '1 hour'",
  "interval '4 hours'",
  "interval '12 hours'",
  "interval '24 hours'",
]) {
  assert.ok(migration.includes(delay), `Retry policy omits ${delay}`);
}
for (const required of [
  'dead_lettered_at timestamptz',
  'escalated_at timestamptz',
  "clock_timestamp() - interval '15 minutes'",
  'for update skip locked',
  'Recovered stale recipient delivery claim.',
  'Recovered stale notification outbox claim.',
  'escalate_booking_notification_dead_letters_v1',
  'booking_notification_metrics_v',
  'pending_outbox_count',
  'retry_delivery_count',
  'suppressed_outbox_count',
  'superseded_outbox_count',
  'dead_letter_outbox_count',
  'un_escalated_dead_letter_count',
]) {
  assert.ok(migration.includes(required), `Resilience metrics omit ${required}`);
}
const view = migration.slice(
  migration.indexOf('create or replace view public.booking_notification_metrics_v'),
  migration.indexOf('revoke all on table public.booking_notification_metrics_v')
);
assert.doesNotMatch(
  view,
  /recipient_address|recipient_address_hash|event_snapshot|rendered_content/i,
  'Aggregate notification metrics must not expose recipient/content data'
);
assert.match(
  migration,
  /with \(security_invoker = true\)[\s\S]*?grant select on table public\.booking_notification_metrics_v to service_role/i
);
for (const required of [
  'recoverStaleBookingNotificationClaims',
  'escalateBookingNotificationDeadLetters',
]) {
  assert.ok(adapter.includes(required), `Notification adapter omits ${required}`);
  assert.ok(cron.includes(required), `Protected scheduler omits ${required}`);
}
assert.ok(
  metricsDb.includes(".from('booking_notification_metrics_v')") &&
    metricsType.includes('retryingRecipients: number') &&
    metricsUi.includes("label: 'Notify dead letters'") &&
    metricsUi.includes("label: 'Notify suppressed'"),
  'Staff lifecycle health must surface notification outcomes'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      retryScheduleMinutes: [1, 5, 15, 60, 240, 720, 1440],
      staleClaimMinutes: 15,
      deadLetterEscalation: true,
      suppressedAndSupersededMetrics: true,
      recipientAddressesExposedByMetrics: false,
      schedulerIntegrated: true,
    },
    null,
    2
  )
);
