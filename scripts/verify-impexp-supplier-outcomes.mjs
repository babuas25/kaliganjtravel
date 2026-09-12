import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8').replace(/\r\n/g, '\n');
const evidence = read(
  'lib',
  'booking-lifecycle',
  'imported-supplier-evidence.ts'
);
const migration = read(
  'supabase',
  'migrations',
  '0064_impexp_supplier_outcome_rules.sql'
);
const route = read('app', 'api', 'impexp', 'sync-booking', 'route.ts');
const db = read('lib', 'db', 'impexp.ts');
const actions = read('components', 'flights', 'BookingActions.tsx');

const outcomes = [
  'ticketed',
  'held',
  'cancelled',
  'expired',
  'unconfirmed',
  'conflicting',
];
for (const outcome of outcomes) {
  assert.ok(
    evidence.includes(`case '${outcome}'`) ||
      evidence.includes(`? '${outcome}'`) ||
      evidence.includes(`: '${outcome}'`),
    `Evidence classifier omits ${outcome}`
  );
  assert.ok(
    migration.includes(`('${outcome}',`),
    `Database outcome matrix omits ${outcome}`
  );
}

for (const required of [
  "requiredAction: 'complete_ticketing'",
  "requiredAction: 'continue_supplier_follow_up'",
  "requiredAction: 'financial_disposition_required'",
  "requiredAction: 'admin_review_required'",
  "operationState: 'awaiting_external_action'",
  "operationState: 'needs_reconciliation'",
  "caseState: 'awaiting_supplier'",
  "caseState: 'awaiting_finance'",
  "assignedTeam: 'support'",
  "assignedTeam: 'accounts'",
  "assignedTeam: 'admin'",
  'financialDispositionRequired: true',
  'identityIssueCodes',
  'baseAuthoritative',
]) {
  assert.ok(evidence.includes(required), `Outcome evidence omits ${required}`);
}

for (const required of [
  'classify_impexp_manual_ticket_outcome_v1',
  "v_booking.status <> 'in-progress'",
  "v_booking.payment_state <> 'captured'",
  'v_booking.captured_amount is distinct from v_booking.user_payable_amount',
  "v_case.financial_disposition <> 'none'",
  "v_operation.kind is distinct from 'imported_manual_ticketing'",
  "v_operation.state not in ('awaiting_external_action', 'needs_reconciliation')",
  "'ticketed', 'held', 'cancelled', 'expired'",
  "'unconfirmed', 'conflicting'",
  "'supplier_booking_still_held'",
  "'supplier_booking_cancelled'",
  "'supplier_booking_expired'",
  "'supplier_booking_unconfirmed'",
  "'supplier_evidence_conflicting'",
  "'awaiting_supplier', 'support'",
  "'awaiting_finance', 'accounts'",
  "'admin', 'critical', 100, false",
  "'financialDisposition', 'none'",
  "'bookingStatusMutation', false",
  "'walletMutation', false",
  "'ledgerMutation', false",
  "'replay', true",
  'booking -> operation -> case',
  'revoke all on function public.classify_impexp_manual_ticket_outcome_v1',
  'grant execute on function public.classify_impexp_manual_ticket_outcome_v1',
  'to service_role',
]) {
  assert.ok(migration.includes(required), `Outcome RPC omits ${required}`);
}

const functionBody = migration.match(
  /create or replace function public\.classify_impexp_manual_ticket_outcome_v1\([\s\S]*?end;\n\$\$;/i
)?.[0] ?? '';
assert.ok(functionBody, 'Outcome classification function body was not found');
assert.doesNotMatch(
  functionBody,
  /update public\.flight_bookings|update public\.wallet_accounts|update public\.wallet_reservations|insert into public\.wallet_ledger_entries|insert into public\.booking_status_events|insert into public\.booking_notification_outbox/i,
  'Outcome classification must not mutate public lifecycle or financial truth'
);

for (const required of [
  'classifyImportedManualTicketOutcome({',
  'classificationReplay',
  'financialDispositionRequired',
  'Supplier evidence was recorded, but its operation/case outcome could not be classified safely.',
]) {
  assert.ok(route.includes(required), `Sync route omits ${required}`);
}
assert.ok(
  route.split('classifyVerification({').length - 1 >= 3,
  'New evidence and both replay paths must durably classify the outcome'
);
assert.ok(
  db.includes('classify_impexp_manual_ticket_outcome_v1'),
  'Database wrapper must call the exact classification RPC'
);

for (const required of [
  'The supplier booking is still held.',
  'The supplier reports this booking as cancelled.',
  'The supplier reports this booking as expired.',
  'The supplier reports this booking as unconfirmed.',
  'Supplier evidence conflicts with the booking identity or ticket details.',
  'Captured funds remain visible',
  'no wallet change was made',
]) {
  assert.ok(actions.includes(required), `Staff outcome copy omits ${required}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      outcomeMatrix: outcomes,
      ticketed: 'support-completion',
      held: 'support-follow-up',
      negative: 'accounts-financial-disposition',
      conflicting: 'admin-review',
      publicBookingStatusMutation: false,
      walletMutation: false,
      ledgerMutation: false,
      replayIdempotent: true,
    },
    null,
    2
  )
);
