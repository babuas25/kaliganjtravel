import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8').replace(/\r\n/g, '\n');
const migration = read(
  'supabase',
  'migrations',
  '0066_impexp_manual_ticket_escalation.sql'
);
const db = read('lib', 'db', 'impexp.ts');
const cron = read('app', 'api', 'cron', 'booking-status-emails', 'route.ts');
const manualTask = read('scripts', 'verify-impexp-manual-task.mjs');

for (const required of [
  'booking_reconciliation_cases_impexp_escalation_idx',
  'process_impexp_manual_ticket_escalations_v1',
  'p_limit < 1 or p_limit > 500',
  "case_type = 'imported_manual_ticketing'",
  "operation.kind = 'imported_manual_ticketing'",
  "booking.status = 'in-progress'",
  "interval '30 minutes'",
  "interval '60 minutes'",
  'for update of booking skip locked',
  'booking -> operation -> case order',
  "v_action := 'warning'",
  "v_action := 'admin'",
  "v_action := 'superadmin'",
  "'manual_ticket_unassigned_warning'",
  "'manual_ticket_admin_escalation'",
  "'manual_ticket_superadmin_escalation'",
  "set state = 'needs_reconciliation'",
  "when state in ('awaiting_finance', 'awaiting_approval')",
  "assigned_team = 'admin'",
  "severity = 'critical'",
  "'supplierTruthInferred', false",
  "'publicStatusMutation', false",
  "'walletMutation', false",
  "'remainingEligible', v_remaining",
  'revoke all on function public.process_impexp_manual_ticket_escalations_v1',
  'to service_role',
]) {
  assert.ok(migration.includes(required), `Manual-ticket escalation omits ${required}`);
}

const functionBody = migration.match(
  /create or replace function public\.process_impexp_manual_ticket_escalations_v1\([\s\S]*?end;\n\$\$;/i
)?.[0] ?? '';
assert.ok(functionBody, 'Manual-ticket escalation function body was not found');
assert.doesNotMatch(
  functionBody,
  /update public\.flight_bookings|update public\.wallet_accounts|update public\.wallet_reservations|insert into public\.wallet_ledger_entries|insert into public\.booking_status_events|insert into public\.booking_notification_outbox/i,
  'Escalation must not infer public lifecycle or mutate financial/event truth'
);

for (const required of [
  'processImportedManualTicketEscalations(',
  'process_impexp_manual_ticket_escalations_v1',
  'unassignedWarnings',
  'adminEscalations',
  'superadminEscalations',
  'remainingEligible',
]) {
  assert.ok(db.includes(required), `Escalation database adapter omits ${required}`);
}
for (const required of [
  'processImportedManualTicketEscalations(100)',
  'importedManualTicketEscalations',
  'CRON_SECRET',
]) {
  assert.ok(cron.includes(required), `Protected scheduler omits ${required}`);
}
assert.ok(
  manualTask.includes('superAdminAfterOverdueMinutes'),
  'The executable worker must remain tied to the original SLA policy evidence'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      unassignedWarningMinutes: 30,
      adminEscalation: 'at-due',
      superadminEscalationMinutesOverdue: 60,
      boundedBatchLimit: 500,
      concurrentClaims: 'booking-root-skip-locked',
      overdueOperationState: 'needs_reconciliation',
      financialWorkflowStatePreserved: true,
      publicStatusMutation: false,
      walletMutation: false,
      supplierTruthInferred: false,
      protectedSchedulerEnabled: true,
    },
    null,
    2
  )
);
