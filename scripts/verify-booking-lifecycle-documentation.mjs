import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function read(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

const lifecycle = read('docs/08-BOOKING-LIFECYCLE.md');
const wallet = read('docs/10-WALLET-SYSTEM.md');
const database = read('docs/12-DATABASE.md');
const api = read('docs/13-API-ROUTES.md');
const imports = read('docs/17-IMP-EXP-IMPORTS.md');
const runbook = read('docs/18-BOOKING-RECONCILIATION-RUNBOOK.md');
const index = read('docs/00-README.md');
const permissions = read('docs/04-ROLES-AND-PERMISSIONS.md');
const booking = read('docs/07-BOOKING-SYSTEM.md');
const deployment = read('docs/15-DEPLOYMENT.md');

for (const required of [
  'Internal Operations and Reconciliation Cases',
  'Terminal Correction',
  'Import Only',
  'Import & Charge',
  'occurrence_id',
]) {
  assert.ok(lifecycle.includes(required), `Lifecycle documentation omits ${required}`);
}
for (const required of [
  'Case-Bound Financial Dispositions',
  'capture_existing_hold',
  'manual_adjustment_required',
  'Never infer refund completion from Cancelled',
]) {
  assert.ok(wallet.includes(required), `Wallet documentation omits ${required}`);
}
for (const required of [
  'booking_operations',
  'booking_reconciliation_cases',
  'booking_reconciliation_observations',
  'booking_notification_outbox',
  'booking_notification_deliveries',
  'booking_lifecycle_worker_runs',
  'flight_bookings_due_expiry_observation_idx',
]) {
  assert.ok(database.includes(required), `Database documentation omits ${required}`);
}
for (const required of [
  'Staff Booking Lifecycle Endpoints',
  '/api/admin/booking-lifecycle/[reference]/evidence',
  '/api/impexp/authorize-charge',
  '/api/impexp/complete-booking',
  '/api/impexp/financial-disposition',
  'no generic `Set Status`',
]) {
  assert.ok(api.includes(required), `API documentation omits ${required}`);
}
for (const required of [
  'Manual Ticket Ownership and SLA',
  'Support completion ready',
  'five-minute matching observation',
  'different Admin/Super Admin',
]) {
  assert.ok(imports.includes(required), `IMP/EXP documentation omits ${required}`);
}

const caseTypes = [
  'ticketing_uncertainty',
  'cancellation_uncertainty',
  'legacy_review',
  'terminal_conflict',
  'direct_ticket_payment_failure',
  'imported_manual_ticketing',
  'imported_payment_conflict',
  'attempt_uncertainty',
  'historical_inconsistency',
];
for (const caseType of caseTypes) {
  assert.ok(
    runbook.includes(`### \`${caseType}\``),
    `Staff runbook omits ${caseType}`
  );
}
for (const required of [
  'Roles and Separation of Duties',
  'Evidence Standard',
  'SLA and Escalation',
  'Maker-Checker Sequence',
  'Emergency Stop and Containment',
  'Batch Verification After Any Resolution',
]) {
  assert.ok(runbook.includes(required), `Staff runbook omits ${required}`);
}
for (const required of [
  'BOOKING_LIFECYCLE_OPERATION_WORKERS_ENABLED=false',
  'BOOKING_LIFECYCLE_IMPORTED_WORKERS_ENABLED=false',
  'BOOKING_RECONCILIATION_ACTIONS_ENABLED=false',
  'BOOKING_IMPORTED_MANUAL_ACTIONS_ENABLED=false',
  'BOOKING_NOTIFICATION_OUTBOX_ENABLED=false',
  'BOOKING_LIFECYCLE_SCALABLE_SWEEP_ENABLED=false',
  'verify:booking-rollout-controls',
]) {
  assert.ok(
    deployment.includes(required),
    `Deployment documentation omits ${required}`
  );
}
assert.doesNotMatch(
  runbook,
  /\b(?:update|insert\s+into|delete\s+from)\s+(?:public\.)?(?:flight_bookings|wallet_|booking_)/i,
  'Runbook must not contain direct production mutation instructions'
);
assert.ok(index.includes('BOOKING-RECONCILIATION-RUNBOOK'));

const authoritative = [lifecycle, wallet, api, imports, permissions, booking].join('\n');
for (const obsolete of [
  /Pending bookings \(supplier (?:failures?|wallet failure)\)/i,
  /Queued supplier-wallet failures require/i,
  /Ticketed\/Confirmed \| Confirmed\/Captured \| User Payable debited atomically during import/i,
  /Sync after authoritative ticket confirmation \| Confirmed/i,
  /Direct confirmed import charges once in the same transaction/i,
]) {
  assert.doesNotMatch(authoritative, obsolete, `Outdated lifecycle claim: ${obsolete}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      permanentDocuments: 10,
      caseRunbooks: caseTypes.length,
      directDatabaseMutationInstructions: 0,
      pendingSupplierShortageClaims: 0,
      cancelledImpliesRefundCompleteClaims: 0,
    },
    null,
    2
  )
);
