import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const confirm = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0062_impexp_confirm_manual_ticket_operation.sql'
  ),
  'utf8'
);
const model = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0043_booking_lifecycle_internal_model.sql'
  ),
  'utf8'
);
const observability = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0044_booking_lifecycle_observability.sql'
  ),
  'utf8'
);
const staffBooking = fs.readFileSync(
  path.join(root, 'lib', 'dashboard', 'booking-lifecycle.ts'),
  'utf8'
);
const table = fs.readFileSync(
  path.join(root, 'components', 'dashboard', 'bookings', 'BookingsTable.tsx'),
  'utf8'
);

for (const required of [
  "'imported_manual_ticketing', 'assigned'",
  "'support', v_now, 'high', 30, v_due_at, 0",
  "v_now + interval '2 hours'",
  "v_booking.ticketing_deadline_at - interval '1 hour'",
  'greatest(',
  "'externalActionDueAt', v_due_at",
  "'warnUnassignedAfterMinutes', 30",
  "'adminEscalationAtDue', true",
  "'superAdminAfterOverdueMinutes', 60",
  "'policyVersion', 1",
]) {
  assert.ok(confirm.includes(required), `Manual task omits ${required}`);
}
assert.match(
  model,
  /booking_operations_external_due_idx[\s\S]*?external_action_due_at[\s\S]*?state = 'awaiting_external_action'/i
);
assert.match(
  model,
  /booking_reconciliation_cases_open_queue_idx[\s\S]*?assigned_team, severity, priority, due_at/i
);
assert.match(
  model,
  /booking_reconciliation_cases_due_idx[\s\S]*?due_at, id[\s\S]*?due_at is not null/i
);
for (const required of [
  'primary_case_assigned_team',
  'primary_case_assignee_user_id',
  'primary_case_due_at',
  'primary_case_escalation_level',
  'external_action_due_at',
  'sla_breach_count',
  'where due_at <= now()',
]) {
  assert.ok(
    observability.includes(required),
    `Staff observability omits ${required}`
  );
}
for (const required of [
  'assignedTeam',
  'assigneeUserId',
  'dueAt',
  'escalationLevel',
]) {
  assert.ok(staffBooking.includes(required), `Staff mapping omits ${required}`);
}
for (const required of [
  'bookingReviewResponsibility(indicator.assignedTeam)',
  'indicator.assignedTeam',
  "indicator.slaBreached ? 'Overdue' : 'Due'",
]) {
  assert.ok(table.includes(required), `Staff booking table omits ${required}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      initialTeam: 'support',
      initialCaseState: 'assigned',
      dueRule: 'min(capture+2h, deadline-1h), clamped at capture',
      unassignedWarningMinutes: 30,
      adminEscalation: 'at due time',
      superAdminEscalationMinutesOverdue: 60,
      queueIndexed: true,
      staffVisibility: true,
      activeEscalationExecutionStep: 'P6.9',
    },
    null,
    2
  )
);
