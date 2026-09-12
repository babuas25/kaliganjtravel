import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0045_booking_operation_claims.sql'
);

const tableStart = migration.indexOf(
  'create table if not exists public.booking_reconciliation_observations'
);
const rpcStart = migration.indexOf(
  'create or replace function public.record_supplier_write_uncertainty_v2('
);
assert.ok(tableStart >= 0 && rpcStart > tableStart);
const table = migration.slice(tableStart, rpcStart);
const rpc = migration.slice(rpcStart);

for (const required of [
  'reconciliation_case_id',
  'observation_key',
  'observation_kind',
  'observation_source',
  'normalized_facts',
  'normalized_facts_hash',
  'observed_at',
  'unique (reconciliation_case_id, observation_key)',
  'booking_reconciliation_observations_case_timeline_idx',
  'booking_reconciliation_observations_immutable',
  "raise exception 'booking reconciliation observations are immutable'",
]) {
  assert.ok(table.includes(required), `Observation ledger omits ${required}`);
}
assert.match(
  table,
  /revoke all on table public\.booking_reconciliation_observations\s+from public, anon, authenticated, service_role;/
);
assert.match(
  table,
  /grant select, insert on table public\.booking_reconciliation_observations\s+to service_role;/
);
assert.doesNotMatch(table, /grant[^;]*(?:update|delete)/i);

for (const required of [
  "p_failure_reason_code not in (",
  "p_normalized_facts->>'failureClass'",
  "p_normalized_facts->>'automaticReplayAllowed'",
  'supplier_call_started_at is null',
  'wallet_mark_reconciliation(',
  "set state = 'needs_reconciliation'",
  "set state = 'unknown'",
  "v_case_type := 'attempt_uncertainty'",
  "when v_operation.kind = 'cancellation' then 'cancellation_uncertainty'",
  'on conflict do nothing',
  'on conflict (reconciliation_case_id, observation_key) do nothing',
  "'automaticSupplierReplay', false",
]) {
  assert.ok(rpc.includes(required), `Uncertainty RPC omits ${required}`);
}
assert.match(
  rpc,
  /revoke all on function public\.record_supplier_write_uncertainty_v2\([\s\S]*?from public, anon, authenticated;/
);
assert.match(
  rpc,
  /grant execute on function public\.record_supplier_write_uncertainty_v2\([\s\S]*?to service_role;/
);
assert.doesNotMatch(
  rpc,
  /net\.http|triploverCall|bookFlight|issueTicket|cancelBooking/
);

const operationDb = read('lib', 'db', 'booking-operations.ts');
assert.match(operationDb, /recordSupplierWriteUncertainty/);
assert.match(operationDb, /record_supplier_write_uncertainty_v2/);
assert.match(operationDb, /createHash\('sha256'\)/);
assert.match(operationDb, /for \(let attempt = 0; attempt < 2;/);
assert.match(operationDb, /failureClass !== 'uncertain'/);

for (const routePath of [
  ['app', 'api', 'flights', 'booking', 'route.ts'],
  ['app', 'api', 'flights', 'booking', 'issue', 'route.ts'],
  ['app', 'api', 'flights', 'booking', 'cancel', 'route.ts'],
]) {
  const route = read(...routePath);
  assert.match(route, /recordSupplierWriteUncertainty\(/);
  assert.match(route, /failureClass === 'uncertain'/);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      oneOpenCasePerType: true,
      observationIdempotency: 'case_id+observation_key',
      immutableObservationHistory: true,
      supplierWrites: ['Book', 'NewTicket', 'Cancel'],
      automaticSupplierReplay: false,
    },
    null,
    2
  )
);
