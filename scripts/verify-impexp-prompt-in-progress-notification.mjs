import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const confirm = read(
  'supabase',
  'migrations',
  '0108_imported_booking_ticketing_resolution.sql'
);
const outbox = read(
  'supabase',
  'migrations',
  '0070_booking_notification_grace_supersession.sql'
);
const copy = read('lib', 'flights', 'customer-status.ts');

const holdAt = confirm.indexOf('insert into public.wallet_ledger_entries');
const eventAt = confirm.indexOf('insert into public.booking_status_events');
assert.ok(
  holdAt >= 0 && eventAt > holdAt,
  'Held imported In Progress event must share the Hold transaction'
);
for (const required of [
  "payment_state = 'held'",
  "status = 'in-progress'",
  "'walletHeld', true",
  "'walletCaptured', false",
  "'paymentState', 'held'",
  "'operationKind', 'imported_manual_ticketing'",
  "'operationSource', 'imported_manual_ticketing'",
  "'userPayableAmount', v_booking.user_payable_amount",
]) {
  assert.ok(confirm.includes(required), `Imported occurrence omits ${required}`);
}

assert.match(
  outbox,
  /coalesce\([\s\S]*?new\.event_snapshot->>'operationSource'[\s\S]*?\) <> 'imported_manual_ticketing' then[\s\S]*?v_policy := 'grace'[\s\S]*?else[\s\S]*?v_available_at := v_now/i,
  'Imported manual ticketing must bypass ordinary grace'
);
assert.ok(
  copy.includes('User Payable is held; ticketing is being completed.'),
  'Prompt imported notification must explain the lasting held state'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      paymentHoldAtomicWithOccurrence: true,
      operationSource: 'imported_manual_ticketing',
      deliveryPolicy: 'send',
      availableImmediately: true,
      customerMessage: 'User Payable is held; ticketing is being completed.',
    },
    null,
    2
  )
);
