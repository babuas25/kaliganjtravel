import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outbox = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0060_booking_lifecycle_event_outbox.sql'
  ),
  'utf8'
);
const capturedCancellation = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0056_booking_reconciliation_captured_cancellation.sql'
  ),
  'utf8'
);
const genericRefund = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0059_wallet_reconciliation_refund_guard.sql'
  ),
  'utf8'
);
const eventMigrations = [
  '0052_booking_reconciliation_ticketed_capture.sql',
  '0092_takeoff_manual_ticket_reconciliation.sql',
  '0094_booking_pnr_echoed_transaction_validation.sql',
  '0053_booking_reconciliation_nonissuance_release.sql',
  '0054_booking_reconciliation_unpaid_cancellation.sql',
  '0055_booking_reconciliation_held_cancellation.sql',
  '0056_booking_reconciliation_captured_cancellation.sql',
  '0057_booking_reconciliation_terminal_corrections.sql',
].map((name) =>
  fs.readFileSync(path.join(root, 'supabase', 'migrations', name), 'utf8')
);

assert.match(
  outbox,
  /create or replace function public\.enqueue_booking_lifecycle_event_v1\(\)[\s\S]*?returns trigger[\s\S]*?security definer/i
);
for (const required of [
  'after insert on public.booking_status_events',
  'insert into public.booking_notification_outbox',
  "'booking_status'",
  "'pending', 1, v_available_at, v_grace_expires_at",
  "new.to_lifecycle_status = 'in-progress'",
  "new.operation_kind in ('ticketing', 'cancellation')",
  "interval '120 seconds'",
  "v_policy := 'grace'",
  "v_policy text := 'send'",
  "'bookingReference', v_booking_ref",
  "'lifecycleStatus', new.to_lifecycle_status",
  "'paymentState', v_payment_state",
  "'occurrenceId', new.occurrence_id",
  'on conflict (lifecycle_event_id, notification_kind) do nothing',
]) {
  assert.ok(outbox.includes(required), `Atomic outbox omits ${required}`);
}
assert.match(
  outbox,
  /revoke all on function public\.enqueue_booking_lifecycle_event_v1\(\)[\s\S]*?service_role;/i
);
assert.doesNotMatch(
  outbox,
  /insert into public\.booking_notification_deliveries|sendMail|resend|recipient_address/i,
  'P5.15 creates intent only; recipient expansion and sending remain Phase 7'
);
for (const migration of eventMigrations) {
  assert.match(
    migration,
    /insert into public\.booking_status_events/i,
    'Every lifecycle-changing exact resolution must create an event'
  );
}
assert.match(
  capturedCancellation,
  /insert into public\.booking_status_events[\s\S]*?ReconciliationCancellationFinancialOutcome/i,
  'Already-Cancelled financial outcomes must create a material occurrence'
);
assert.doesNotMatch(
  capturedCancellation,
  /if v_from_lifecycle <> 'cancelled' then/i,
  'Already-Cancelled financial outcomes cannot be silently excluded'
);
assert.match(
  genericRefund,
  /insert into public\.wallet_ledger_entries[\s\S]*?insert into public\.booking_status_events/i,
  'Ordinary refund ledger and customer occurrence must share one transaction'
);
assert.match(genericRefund, /'financialEvent', 'refund'/i);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      lifecycleEventOutboxAtomic: true,
      oneOutboxPerOccurrence: true,
      ordinaryInProgressGraceSeconds: 120,
      importedManualTicketingImmediate: true,
      terminalAndFinancialImmediate: true,
      alreadyCancelledFinancialOccurrence: true,
      recipientExpansionEnabled: false,
      sendingEnabled: false,
    },
    null,
    2
  )
);
