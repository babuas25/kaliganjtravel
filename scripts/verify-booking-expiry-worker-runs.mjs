import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0079_booking_expiry_worker_runs.sql'
);
const adapter = read('lib', 'db', 'flight-bookings.ts');

for (const required of [
  'create table if not exists public.booking_lifecycle_worker_runs',
  "worker_kind = 'due_expiry_observation'",
  'cursor_deadline timestamptz',
  'cursor_booking_id uuid',
  'batch_count integer',
  'selected_count bigint',
  'inserted_count bigint',
  'last_observed_at timestamptz',
  'stop_reason text',
  'start_due_booking_expiry_worker_run_v1',
  'record_due_booking_expiry_worker_batch_v2',
  'complete_due_booking_expiry_worker_run_v1',
  'for update',
  'record_due_booking_expiry_observation_batch_v1(',
  'cursor_deadline = coalesce(v_next_deadline, cursor_deadline)',
  'batch_count = batch_count + 1',
  "when p_stop_reason = 'drained' then 'succeeded'",
]) {
  assert.ok(migration.includes(required), `Durable worker run omits ${required}`);
}
assert.match(
  migration,
  /record_due_booking_expiry_observation_batch_v1\([\s\S]*?update public\.booking_lifecycle_worker_runs[\s\S]*?return v_batch/i,
  'Event/outbox insertion and run cursor metrics must share one RPC transaction'
);
assert.match(
  migration,
  /revoke all on table public\.booking_lifecycle_worker_runs[\s\S]*?grant select on table public\.booking_lifecycle_worker_runs to service_role/i
);
for (const required of [
  'start_due_booking_expiry_worker_run_v1',
  'record_due_booking_expiry_worker_batch_v2',
  'complete_due_booking_expiry_worker_run_v1',
  'runId: started.runId',
]) {
  assert.ok(adapter.includes(required), `Worker adapter omits ${required}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      durableRunIdentity: true,
      durableCursor: ['cursor_deadline', 'cursor_booking_id'],
      durableMetrics: ['batches', 'selected', 'inserted', 'stop_reason'],
      batchAndCursorAtomic: true,
      crossRunGlobalWatermark: false,
    },
    null,
    2
  )
);
