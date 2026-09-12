import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const migration = read(
  'supabase',
  'migrations',
  '0095_booking_reconciliation_stale_approved_proposal_supersession.sql'
);
const actions = read('lib', 'db', 'booking-reconciliation-actions.ts');
const route = read(
  'app',
  'api',
  'admin',
  'booking-lifecycle',
  '[reference]',
  'reconciliation',
  'supersede-stale-approved-proposal',
  'route.ts'
);

for (const required of [
  "'superseded'",
  'superseded_at',
  'superseded_by_user_id',
  'superseded_by_role',
  'supersede_reason',
  'superseded_by_case_id',
  'supersedes_case_id',
  'booking_reconciliation_proposal_supersessions',
  'booking_reconciliation_proposal_supersessions_deny_mutation_v1',
  "raise exception 'booking reconciliation proposal supersessions are immutable'",
  'supersede_stale_approved_booking_reconciliation_v1',
  "coalesce(v_actor_role, '') <> 'superadmin'",
  "v_case.state <> 'awaiting_approval'",
  "v_case.proposed_outcome is distinct from 'ticketed'",
  "v_case.financial_disposition is distinct from 'capture_existing_hold'",
  "interval '5 minutes'",
  "'PROPOSAL_EVIDENCE_NOT_EXPIRED'",
  "'awaiting_supplier'",
  "'stale_approved_proposal_superseded'",
  "'booking.reconciliation.proposal_superseded'",
  "'requiresFreshEvidence', true",
  "'bookingMutation', false",
  "'walletMutation', false",
  "'reservationMutation', false",
  "'ledgerMutation', false",
  "'supplierWrite', false",
]) {
  assert.ok(migration.includes(required), `supersession migration omits ${required}`);
}

assert.match(
  migration,
  /select booking\.\* into v_booking[\s\S]*?for update;[\s\S]*?select operation\.\* into v_operation[\s\S]*?for update;[\s\S]*?select reconciliation_case\.\* into v_case[\s\S]*?for update;/i,
  'Supersession must lock booking, operation, then case'
);
assert.match(
  migration,
  /state = 'superseded'[\s\S]*?insert into public\.booking_reconciliation_cases[\s\S]*?state,[\s\S]*?'awaiting_supplier'/i,
  'The source must become terminal before its successor opens, preserving the one-open-case invariant'
);
assert.match(
  migration,
  /insert into public\.booking_reconciliation_proposal_supersessions[\s\S]*?v_case\.proposal_hash,[\s\S]*?v_case\.proposal,[\s\S]*?v_case\.proposed_by_user_id,[\s\S]*?v_case\.approved_by_user_id,[\s\S]*?v_case\.proposal->'evidenceObservationIds'/i,
  'The immutable snapshot must preserve the old hash, body/reason, maker, checker, and evidence IDs'
);
assert.match(
  migration,
  /evidence\.id !~\* '\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$'/i,
  'Supersession must accept only canonical 8-4-4-4-12 UUID evidence identifiers'
);

const sourceUpdateStart = migration.indexOf(
  'update public.booking_reconciliation_cases\n     set state = \'superseded\''
);
const successorInsertStart = migration.indexOf(
  'insert into public.booking_reconciliation_cases (',
  sourceUpdateStart
);
assert.ok(sourceUpdateStart >= 0 && successorInsertStart > sourceUpdateStart);
const sourceUpdate = migration.slice(sourceUpdateStart, successorInsertStart);
for (const forbidden of [
  /proposal\s*=/i,
  /proposal_hash\s*=/i,
  /proposed_by_user_id\s*=/i,
  /proposed_at\s*=/i,
  /approved_by_user_id\s*=/i,
  /approved_at\s*=/i,
  /evidence\s*=/i,
  /financial_disposition\s*=/i,
  /resolved_at\s*=/i,
]) {
  assert.doesNotMatch(
    sourceUpdate,
    forbidden,
    'Supersession must not rewrite the source proposal, approval, evidence, or financial fields'
  );
}

for (const forbidden of [
  /update\s+public\.flight_bookings/i,
  /update\s+public\.booking_operations/i,
  /update\s+public\.wallet_/i,
  /insert\s+into\s+public\.wallet_/i,
  /delete\s+from\s+public\.wallet_/i,
  /insert\s+into\s+public\.booking_status_events/i,
  /NewTicket/i,
  /issueTicket\s*\(/i,
  /acquireSupplierEvidence\s*\(/i,
]) {
  assert.doesNotMatch(
    migration,
    forbidden,
    'Supersession migration must have no booking, supplier, or financial mutation path'
  );
}

assert.match(actions, /supersedeStaleApprovedBookingReconciliation/);
assert.match(actions, /supersede_stale_approved_booking_reconciliation_v1/);
assert.doesNotMatch(
  actions.slice(actions.indexOf('supersedeStaleApprovedBookingReconciliation')),
  /walletCapture|walletRelease|issueTicket|acquireSupplierEvidence/i,
  'The app wrapper must only call the exact supersession RPC'
);

for (const required of [
  "session.role !== 'superadmin'",
  'bookingLifecycleRolloutEnabled(\'reconciliationActions\')',
  'INVALID_PROPOSAL_SUPERSESSION',
  "checkActionLimit(\n    'bookingReconciliationWrite'",
  'recordSecurityAuditEvent({ ...audit, outcome: \'attempted\' })',
  'supersedeStaleApprovedBookingReconciliation',
  "supplierWrite: false",
  "walletMutation: false",
  "reservationMutation: false",
  "ledgerMutation: false",
]) {
  assert.ok(route.includes(required), `Supersession route omits ${required}`);
}
assert.ok(
  route.indexOf("outcome: 'attempted'") <
    route.lastIndexOf('supersedeStaleApprovedBookingReconciliation'),
  'The route must write the attempted audit before the DB supersession call'
);
assert.doesNotMatch(
  route,
  /resolveBookingReconciliation|walletCapture|walletRelease|NewTicket|issueTicket|acquireSupplierEvidence/i,
  'The route must not expose financial execution or supplier activity'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      sourceProposalMutated: false,
      sourceApprovalMutated: false,
      sourceEvidenceMutated: false,
      successorRequiresFreshEvidence: true,
      superAdminOnly: true,
      makerCheckerStillRequiredForSuccessor: true,
      bookingWalletSupplierMutation: false,
      retainedAsHistoricalApiContract: true,
    },
    null,
    2
  )
);
