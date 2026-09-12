import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const migration = read(
  'supabase',
  'migrations',
  '0045_booking_operation_claims.sql'
);
const queueStart = migration.indexOf(
  'create or replace view public.booking_attempt_reconciliation_queue_v'
);
const queueEnd = migration.indexOf(
  'comment on view public.booking_attempt_reconciliation_queue_v',
  queueStart
);
assert.ok(queueStart >= 0 && queueEnd > queueStart, 'Attempt queue view is missing');
const queueView = migration.slice(queueStart, queueEnd);

for (const required of [
  'attempt.unique_trans_id',
  'pnr_lookup_eligible',
  'air_ticketing_details_eligible',
  'pnr_then_air_ticketing_details',
  'air_ticketing_details_then_manual_portal',
  'manual_supplier_portal_only',
  'false as destructive_replay_allowed',
  'false as automatic_resolution_allowed',
  'true as manual_portal_required_if_inconclusive',
]) {
  assert.ok(queueView.includes(required), `Attempt queue omits ${required}`);
}
for (const forbidden of [
  /passenger_snapshot/i,
  /access_token_hash/i,
  /\battempt\.user_id\b/i,
  /\breconciliation\.evidence\b(?!_)/i,
  /\breconciliation\.proposal\b/i,
  /\breconciliation\.resolution\b/i,
]) {
  assert.doesNotMatch(queueView, forbidden);
}
assert.match(
  migration,
  /revoke all on table public\.booking_attempt_reconciliation_queue_v\s+from public, anon, authenticated;/
);
assert.match(
  migration,
  /grant select on table public\.booking_attempt_reconciliation_queue_v\s+to service_role;/
);
assert.match(migration, /booking_reconciliation_cases_attempt_queue_idx/);

const dtoPath = path.join(
  process.cwd(),
  'lib',
  'dashboard',
  'booking-attempt-reconciliation.ts'
);
const dtoSource = fs.readFileSync(dtoPath, 'utf8');
const transpiled = ts.transpileModule(dtoSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: dtoPath,
  reportDiagnostics: true,
});
assert.equal(
  (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  ).length,
  0,
  'Attempt reconciliation DTO must transpile'
);
const dtoModule = { exports: {} };
new vm.Script(transpiled.outputText, { filename: dtoPath }).runInNewContext({
  module: dtoModule,
  exports: dtoModule.exports,
  require,
});
const { staffAttemptReconciliation } = dtoModule.exports;

const fixture = {
  reconciliation_case_id: 'case-id',
  reconciliation_state: 'open',
  reason_code: 'book_supplier_call_watchdog_timeout',
  reason_detail: 'Operational narrative',
  assigned_team: 'support',
  assignee_user_id: 'support-user',
  severity: 'high',
  priority: 10,
  opened_at: '2026-08-11T10:05:00Z',
  due_at: '2026-08-11T10:20:00Z',
  escalation_level: 0,
  evidence_latest_at: '2026-08-11T10:05:00Z',
  reconciliation_version: 1,
  booking_attempt_id: 'attempt-id',
  supplier: 'triplover',
  attempt_state: 'unknown',
  attempt_created_at: '2026-08-11T10:00:00Z',
  submitted_at: '2026-08-11T10:01:00Z',
  resolved_at: '2026-08-11T10:05:00Z',
  supplier_call_started_at: '2026-08-11T10:01:01Z',
  supplier_response_received_at: null,
  supplier_response_http_status: null,
  operation_identity_present: true,
  unique_trans_id: 'supplier-unique-identity',
  pnr: null,
  booking_code_ref: null,
  air_ticketing_details_eligible: true,
  pnr_lookup_eligible: false,
  supplier_read_strategy: 'air_ticketing_details_then_manual_portal',
  supplier_identity_kind: 'unique_transaction_id',
  destructive_replay_allowed: false,
  automatic_resolution_allowed: false,
  manual_portal_required_if_inconclusive: true,
  direct_ticketing: true,
  reservation_id: 'reservation-id',
  reservation_state: 'reconciliation',
  reservation_amount: 10000,
  reservation_currency: 'BDT',
  recovered_booking_id: null,
  recovered_booking_public_ref: null,
};
const support = staffAttemptReconciliation(
  fixture,
  'support',
  Date.parse('2026-08-11T10:21:00Z')
);
const accounts = staffAttemptReconciliation(fixture, 'accounts');
const admin = staffAttemptReconciliation(fixture, 'admin');

assert.equal(support.readPlan.supplierIdentity.uniqueTransId, fixture.unique_trans_id);
assert.ok(!('amount' in support.wallet));
assert.ok(!('supplierIdentity' in accounts.readPlan));
assert.ok(!('reasonDetail' in accounts.reconciliation));
assert.equal(accounts.wallet.amount, 10000);
assert.equal(admin.wallet.currency, 'BDT');
for (const result of [support, accounts, admin]) {
  assert.equal(result.readPlan.destructiveReplayAllowed, false);
  assert.equal(result.readPlan.automaticResolutionAllowed, false);
  assert.equal(result.readPlan.manualPortalRequiredIfInconclusive, true);
}
assert.equal(support.flags.slaBreached, true);
assert.doesNotMatch(
  JSON.stringify({ support, accounts, admin }),
  /passenger|contact|access_token|operation_request_key|"evidence"|"proposal"/i
);

const route = read(
  'app',
  'api',
  'admin',
  'booking-lifecycle',
  'attempts',
  'route.ts'
);
assert.match(route, /getDashboardSession\(\)/);
assert.match(route, /bookingLifecycleAccessForRole\(session\.role\)/);
assert.match(route, /Cache-Control': 'no-store'/);
assert.doesNotMatch(route, /bookFlight|issueTicket|cancelBooking/);

const queueDb = read('lib', 'db', 'booking-attempt-reconciliation.ts');
assert.match(queueDb, /booking_attempt_reconciliation_queue_v/);
assert.doesNotMatch(queueDb, /passenger_snapshot|access_token_hash/);
assert.doesNotMatch(queueDb, /bookFlight|issueTicket|cancelBooking/);

const ticketRead = read('lib', 'triplover', 'air-ticketing-details.ts');
const pnrRead = read('lib', 'triplover', 'pnr.ts');
assert.match(ticketRead, /method: 'GET', topLevelPayload: true/);
assert.match(ticketRead, /encodeURIComponent\(uniqueTransId\)/);
assert.match(pnrRead, /export async function readPnr/);

const panel = read(
  'components',
  'dashboard',
  'bookings',
  'BookingAttemptReconciliationPanel.tsx'
);
assert.match(panel, /Never submit Book again/);
assert.match(panel, /Internal review · no public status/);
assert.doesNotMatch(panel, /Unassigned/);
assert.match(panel, /empty ticketing report is inconclusive/);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      staffQueue: true,
      supplierIdentity: 'unique_transaction_id',
      readStrategies: 3,
      destructiveReplayAllowed: false,
      automaticResolutionAllowed: false,
      roleMasking: true,
      publicStatusCreated: false,
    },
    null,
    2
  )
);
