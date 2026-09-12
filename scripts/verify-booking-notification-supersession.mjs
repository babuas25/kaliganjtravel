import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0070_booking_notification_grace_supersession.sql'
  ),
  'utf8'
);

const insertAt = migration.indexOf(
  'insert into public.booking_notification_outbox'
);
const supersedeAt = migration.indexOf(
  'update public.booking_notification_outbox intermediate'
);
assert.ok(
  insertAt >= 0 && supersedeAt > insertAt,
  'Final outbox intent must exist before it is used as a supersession target'
);

for (const required of [
  "new.to_lifecycle_status in ('confirmed', 'cancelled')",
  "intermediate.lifecycle_status = 'in-progress'",
  "intermediate.delivery_policy = 'grace'",
  "intermediate.state = 'pending'",
  'intermediate.grace_expires_at > v_now',
  "state = 'superseded'",
  "suppression_reason = 'terminal_during_in_progress_grace'",
  'superseded_by_outbox_id = v_outbox_id',
  'completed_at = v_now',
]) {
  assert.ok(migration.includes(required), `Supersession omits ${required}`);
}

assert.match(
  migration,
  /returning id into v_outbox_id[\s\S]*?if v_outbox_id is null then[\s\S]*?notification_kind = 'booking_status'/i,
  'Supersession target identity must be recoverable without duplicate insert'
);
assert.doesNotMatch(
  migration,
  /delete\s+from|update\s+public\.booking_status_events/i,
  'Supersession must retain immutable event history'
);
assert.doesNotMatch(
  migration,
  /insert into public\.booking_notification_deliveries|sendMail|resend/i,
  'Supersession must happen before recipient expansion or sending'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      finalStatuses: ['confirmed', 'cancelled'],
      pendingGraceOnly: true,
      finalIntentImmediate: true,
      intermediateEventRetained: true,
      intermediateIntentRetained: true,
    },
    null,
    2
  )
);
