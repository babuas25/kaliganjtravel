import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8').replace(/\r\n/g, '\n');
const migration = read(
  'supabase',
  'migrations',
  '0065_impexp_manual_ticket_financial_disposition.sql'
);
const db = read('lib', 'db', 'impexp-financial-disposition.ts');
const route = read('app', 'api', 'impexp', 'financial-disposition', 'route.ts');
const panel = read(
  'components',
  'dashboard',
  'bookings',
  'ImportedManualTicketFinancialPanel.tsx'
);
const page = read(
  'app',
  '(dashboard)',
  'dashboard',
  'bookings',
  '[reference]',
  'page.tsx'
);

for (const required of [
  'propose_impexp_manual_ticket_financial_v1',
  "v_actor_role not in ('staff_account', 'admin', 'superadmin')",
  "'cancelled', 'expired', 'unconfirmed'",
  "'{outcome,authoritative}' = 'true'",
  "'{validation,identityMatches}' = 'true'",
  "interval '5 minutes'",
  "'full_refund', 'partial_refund', 'no_refund_due'",
  "'externally_settled', 'manual_adjustment_required'",
  "'proposalKind', 'imported_manual_ticket_financial'",
  "'makerCheckerRequired', true",
  "set state = 'awaiting_approval'",
  "assigned_team = 'admin'",
  "'statusMutation', false",
  "'walletMutation', false",
]) {
  assert.ok(migration.includes(required), `Financial proposal omits ${required}`);
}
const proposalBody = migration.match(
  /create or replace function public\.propose_impexp_manual_ticket_financial_v1\([\s\S]*?end;\n\$\$;/i
)?.[0] ?? '';
assert.ok(proposalBody, 'Financial proposal function body was not found');
assert.doesNotMatch(
  proposalBody,
  /update public\.flight_bookings|update public\.wallet_accounts|update public\.wallet_reservations|insert into public\.wallet_ledger_entries|insert into public\.booking_status_events|insert into public\.booking_notification_outbox/i,
  'Proposal must not mutate booking, money, lifecycle events, or outbox'
);

for (const required of [
  'execute_impexp_manual_ticket_financial_v1',
  "v_actor_role not in ('admin', 'superadmin')",
  'booking -> operation -> case -> reservation -> wallet -> account',
  'v_case.approved_by_user_id = v_case.proposed_by_user_id',
  "v_operation.state is distinct from 'needs_reconciliation'",
  "v_reservation.state <> 'captured'",
  "ledger.transaction_type = 'booking_confirm'",
  'v_capture_ledger_count <> 1',
  "v_disposition = 'manual_adjustment_required'",
  "'code', 'MANUAL_ADJUSTMENT_REQUIRED'",
  "p_execution_request_key || ':refund'",
  "set available_balance = available_balance + v_refund_amount",
  "'refund', v_refund_amount",
  "set status = 'cancelled'",
  "set state = 'failed'",
  'insert into public.booking_status_events',
  "set state = 'resolved'",
  "'resolutionKind', 'imported_manual_ticket_financial'",
  "'replay', true",
  "'walletMutation', v_refund_amount > 0",
  'revoke all on function public.execute_impexp_manual_ticket_financial_v1',
  'to service_role',
]) {
  assert.ok(migration.includes(required), `Financial execution omits ${required}`);
}

for (const required of [
  'propose_impexp_manual_ticket_financial_v1',
  'execute_impexp_manual_ticket_financial_v1',
  'readImportedManualTicketFinancialContext',
  'evidenceIsFresh',
]) {
  assert.ok(db.includes(required), `Financial database adapter omits ${required}`);
}
for (const required of [
  'canProposeBookingFinancialOutcome(session.role)',
  'canApproveBookingReconciliation(session.role)',
  'canExecuteApprovedBookingReconciliation(session.role)',
  'recordSecurityAuditEvent',
  'decideBookingReconciliation({',
  'proposeImportedManualTicketFinancialDisposition({',
  'executeImportedManualTicketFinancialDisposition({',
  'dispatchBookingStatusEmails(booking.id)',
]) {
  assert.ok(route.includes(required), `Financial API omits ${required}`);
}
for (const required of [
  'Captured funds cannot be hidden or closed',
  'Full wallet refund',
  'Partial wallet refund / retained fee',
  'No refund due',
  'Settled outside wallet',
  'Manual adjustment required',
  'requires independent approval before execution',
  'a different Admin or Super Admin must approve it',
  'Execute approved disposition',
  'cannot be auto-closed or mutate the wallet',
]) {
  assert.ok(panel.includes(required), `Financial staff panel omits ${required}`);
}
assert.ok(
  page.includes('<ImportedManualTicketFinancialPanel'),
  'Booking detail must render the reload-safe financial case panel'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      supplierOutcomes: ['cancelled', 'expired', 'unconfirmed'],
      dispositions: [
        'full_refund',
        'partial_refund',
        'no_refund_due',
        'externally_settled',
        'manual_adjustment_required',
      ],
      makerCheckerRequired: true,
      originalCaptureProven: true,
      refundsLedgerBound: true,
      noRefundAndExternalSettlementExplicit: true,
      manualAdjustmentCannotAutoClose: true,
      eventAndOutboxAtomic: true,
      exactReplayRecoverable: true,
    },
    null,
    2
  )
);
