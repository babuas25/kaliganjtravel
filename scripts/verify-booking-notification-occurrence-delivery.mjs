import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const foundation = read(
  'supabase',
  'migrations',
  '0043_booking_lifecycle_internal_model.sql'
);
const migration = read(
  'supabase',
  'migrations',
  '0071_booking_notification_occurrence_delivery.sql'
);
const adapter = read('lib', 'db', 'booking-notifications.ts');

for (const required of [
  'lifecycle_event_id bigint',
  'occurrence_id uuid',
  'for update skip locked',
  "candidate.state = 'pending'",
  'candidate.available_at <= clock_timestamp()',
  "set state = 'processing'",
  'claim_token = gen_random_uuid()',
  'attempt_count = target.attempt_count + 1',
]) {
  assert.ok(migration.includes(required), `Occurrence claim omits ${required}`);
}

assert.match(
  foundation,
  /unique \(lifecycle_event_id, notification_kind\)/i,
  'Outbox identity must be the lifecycle occurrence'
);
assert.match(
  foundation,
  /unique \(outbox_id, channel, recipient_address_hash\)/i,
  'Recipient idempotency must be scoped to the outbox occurrence'
);
assert.match(
  migration,
  /lower\(btrim\(coalesce\(p_recipient_address, ''\)\)\)[\s\S]*?digest\(v_address, 'sha256'\)/i,
  'Recipient identity must use a normalized address hash'
);
assert.match(
  migration,
  /on conflict \(outbox_id, channel, recipient_address_hash\) do nothing[\s\S]*?return query/i,
  'Exact registration replay must return the existing row'
);
assert.doesNotMatch(
  migration,
  /(?:from|join|insert into|update)\s+public\.booking_status_email_deliveries|claim_booking_status_email\s*\(|mark_booking_status_email_sent\s*\(/i,
  'New occurrence delivery must not consult the legacy once/status ledger'
);
for (const required of [
  'claimBookingNotificationOutboxes',
  'registerBookingNotificationRecipient',
  'occurrenceId: row.occurrence_id',
  'recipientAddressHash: row.recipient_address_hash',
]) {
  assert.ok(adapter.includes(required), `Server adapter omits ${required}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      outboxIdentity: 'lifecycle_event_id',
      occurrenceIdentityReturned: true,
      recipientIdentity: 'outbox_id+channel+normalized_address_hash',
      concurrentClaim: 'skip_locked',
      legacyStatusLedgerUsed: false,
    },
    null,
    2
  )
);
