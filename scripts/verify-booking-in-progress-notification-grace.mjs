import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const ordinary = read(
  'supabase',
  'migrations',
  '0031_booking_lifecycle_authority.sql'
);
const outbox = read(
  'supabase',
  'migrations',
  '0060_booking_lifecycle_event_outbox.sql'
);
const timestampContract = read(
  'supabase',
  'migrations',
  '0069_booking_lifecycle_timestamp_contract.sql'
);

for (const writer of [
  ["'ticketing', 'ticketing'", "p_idempotency_key || ':ticketing-start'"],
  ["'cancellation', 'cancellation'", "p_idempotency_key || ':cancellation-start'"],
]) {
  assert.ok(
    ordinary.includes("'on-hold', 'in-progress'") &&
      ordinary.includes(writer[0]) &&
      ordinary.includes(writer[1]),
    `Ordinary ${writer[0]} must persist an In Progress occurrence`
  );
}

for (const required of [
  "new.to_lifecycle_status = 'in-progress'",
  "new.operation_kind in ('ticketing', 'cancellation')",
  "v_policy := 'grace'",
  "v_grace_expires_at := v_now + interval '120 seconds'",
  'v_available_at := v_grace_expires_at',
  "'pending', 1, v_available_at, v_grace_expires_at",
  'after insert on public.booking_status_events',
]) {
  assert.ok(outbox.includes(required), `Grace policy omits ${required}`);
}

assert.match(
  outbox,
  /insert into public\.booking_notification_outbox[\s\S]*?on conflict \(lifecycle_event_id, notification_kind\) do nothing/i,
  'Every event must retain one retry-safe notification intent'
);
assert.doesNotMatch(
  outbox,
  /delete\s+from\s+public\.booking_status_events|update\s+public\.booking_status_events\s+set\s+to_lifecycle_status/i,
  'Grace/suppression may not erase or rewrite event history'
);
assert.match(
  timestampContract,
  /before insert on public\.booking_status_events/i,
  'Grace events must retain exact observed time'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      ordinaryKinds: ['ticketing', 'cancellation'],
      graceSeconds: 120,
      eventRetained: true,
      outboxIntentRetained: true,
      deliveryBeforeGrace: false,
    },
    null,
    2
  )
);
