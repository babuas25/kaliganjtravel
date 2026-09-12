import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const batch = read(
  'supabase',
  'migrations',
  '0078_booking_expiry_keyset_pagination.sql'
);
const run = read(
  'supabase',
  'migrations',
  '0079_booking_expiry_worker_runs.sql'
);
const outbox = read(
  'supabase',
  'migrations',
  '0060_booking_lifecycle_event_outbox.sql'
);
const policy = read(
  'supabase',
  'migrations',
  '0072_booking_notification_reentry_policy.sql'
);
const cron = read('app', 'api', 'cron', 'booking-status-emails', 'route.ts');

for (const required of [
  'insert into public.booking_status_events',
  "'expired'",
  'candidate.ticketing_deadline_at',
  "'derived-expired:v1:'",
  'on conflict do nothing',
]) {
  assert.ok(batch.includes(required), `Expiry event writer omits ${required}`);
}
assert.match(
  run,
  /record_due_booking_expiry_worker_batch_v2[\s\S]*?record_due_booking_expiry_observation_batch_v1\([\s\S]*?update public\.booking_lifecycle_worker_runs/i,
  'Durable cursor update must wrap the event-producing function transaction'
);
assert.match(
  outbox,
  /create trigger booking_status_events_enqueue_notification\s+after insert on public\.booking_status_events\s+for each row execute function public\.enqueue_booking_lifecycle_event_v1\(\)/i,
  'Every inserted expiry event must invoke its outbox trigger in the same transaction'
);
assert.match(
  policy,
  /insert into public\.booking_notification_outbox[\s\S]*?new\.id[\s\S]*?new\.to_lifecycle_status[\s\S]*?on conflict \(lifecycle_event_id, notification_kind\) do nothing/i,
  'Outbox identity must be rooted in the exact expiry lifecycle event'
);
assert.match(
  policy,
  /return query select 'send'::text, null::text, 0;/i,
  'A material Expired transition must be immediately eligible by default'
);
assert.doesNotMatch(
  cron,
  /insertBookingNotificationOutbox|enqueueBookingNotification|createBookingNotification/i,
  'Application scheduler must not create a separate non-atomic outbox intent'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      expiryEventEffectiveAt: 'ticketing_deadline_at',
      eventAndOutboxAtomic: true,
      oneOutboxPerEventKind: true,
      applicationSideEnqueue: false,
    },
    null,
    2
  )
);
