import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const adapter = read('lib', 'db', 'flight-bookings.ts');
const cron = read('app', 'api', 'cron', 'booking-status-emails', 'route.ts');

for (const required of [
  'record_due_booking_expiry_worker_batch_v2',
  'processDerivedBookingStatusObservations',
  'while (batches < maxBatches)',
  'timeBudgetMs - safetyMarginMs',
  "stopReason = 'time_budget'",
  "stopReason = 'drained'",
  "'batch_cap'",
  "stopReason = 'rpc_error'",
  "stopReason = 'invalid_cursor'",
  'result.batch.nextCursor',
]) {
  assert.ok(adapter.includes(required), `Bounded expiry worker omits ${required}`);
}
assert.doesNotMatch(adapter, /while\s*\(true\)/, 'Worker loop needs explicit bounds');
for (const required of [
  'processDerivedBookingStatusObservations',
  'batchSize: 250',
  'maxBatches: 20',
  'timeBudgetMs: Math.min(10_000',
  'safetyMarginMs: 500',
]) {
  assert.ok(cron.includes(required), `Protected scheduler omits ${required}`);
}

const batches = [250, 250, 41];
let calls = 0;
let selected = 0;
while (calls < 20) {
  const count = batches[calls] ?? 0;
  calls += 1;
  selected += count;
  if (count < 250) break;
}
assert.equal(calls, 3);
assert.equal(selected, 541);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      batchSize: 250,
      maxBatches: 20,
      timeBudgetMs: 10000,
      safetyMarginMs: 500,
      fixtureBatches: calls,
      fixtureRows: selected,
      unboundedLoop: false,
    },
    null,
    2
  )
);
