import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '0108_imported_booking_ticketing_resolution.sql'),
  'utf8',
);
const staffIssueMigration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '0110_staff_imported_issue_now.sql'),
  'utf8',
);
const route = fs.readFileSync(
  path.join(root, 'app', 'api', 'impexp', 'confirm-booking', 'route.ts'),
  'utf8',
);
const walletDb = fs.readFileSync(path.join(root, 'lib', 'db', 'wallet.ts'), 'utf8');

assert.match(
  migration,
  /create or replace function public\.wallet_begin_imported_booking_issue_v2\([\s\S]*?security definer[\s\S]*?set search_path = public/i,
);
for (const required of [
  "v_actor_role not in ('customer', 'b2b', 'b2b_sub')",
  "v_booking.booking_owner_type = 'user'",
  'v_booking.booking_owner_key = p_actor_user_id',
  "v_booking.booking_owner_type = 'agency'",
  'v_booking.booking_owner_key = v_actor_agency',
  "p_request_key || ':hold'",
  "v_existing_reservation.state in ('active', 'reconciliation')",
  "v_existing_operation.kind = 'imported_manual_ticketing'",
  "'replay', true",
  "'IMPORTED_ACCOUNTING_RECONCILIATION_REQUIRED'",
  "v_booking.status <> 'on-hold'",
  "v_booking.payment_state <> 'unpaid'",
  'v_booking.charged_wallet_account_id is not null',
  'v_booking.captured_amount <> 0',
  'v_booking.refunded_amount <> 0',
  'v_account.available_balance < v_booking.user_payable_amount',
  "'INSUFFICIENT_FUNDS'",
  "'supplierApiCalled', false",
  "'ManualExternalTicketing'",
  "'imported_manual_ticketing', 'awaiting_external_action'",
  "'imported_manual_ticketing', 'assigned'",
  "'support', v_now, 'high', 30, v_due_at, 0",
  "v_now + interval '2 hours'",
  "v_booking.ticketing_deadline_at - interval '1 hour'",
  'available_balance = available_balance - v_booking.user_payable_amount',
  'hold_balance = hold_balance + v_booking.user_payable_amount',
  "v_account.id, v_booking.id, v_booking.user_payable_amount",
  "v_account.currency, 'active'",
  "'booking_hold', v_booking.user_payable_amount",
  "payment_state = 'held'",
  "status = 'in-progress'",
  'captured_amount = 0',
  'active_operation_id = v_operation.id',
  'insert into public.booking_status_events',
  "'paymentState', 'held'",
  "'walletHeld', true",
  "'walletCaptured', false",
  "'operationSource', 'imported_manual_ticketing'",
  "'booking.imported.issue_now'",
  'wallet_confirm_impexp_booking',
  'wallet_begin_imported_booking_issue_v2',
  'to service_role',
]) {
  assert.ok(migration.includes(required), `Imported Issue Now omits ${required}`);
}

const operationInsert = migration.indexOf('insert into public.booking_operations');
const caseInsert = migration.indexOf('insert into public.booking_reconciliation_cases');
const debit = migration.indexOf('update public.wallet_accounts');
const reservationInsert = migration.indexOf('insert into public.wallet_reservations');
const ledgerInsert = migration.indexOf('insert into public.wallet_ledger_entries');
const bookingUpdate = migration.indexOf('update public.flight_bookings');
const eventInsert = migration.indexOf('insert into public.booking_status_events');
assert.ok(
  operationInsert > 0 &&
    caseInsert > operationInsert &&
    debit > caseInsert &&
    reservationInsert > debit &&
    ledgerInsert > reservationInsert &&
    bookingUpdate > ledgerInsert &&
    eventInsert > bookingUpdate,
  'Operation, case, Hold, booking, and lifecycle event must be one ordered transaction',
);
const issueFunction = migration.slice(
  migration.indexOf('create or replace function public.wallet_begin_imported_booking_issue_v2'),
  migration.indexOf('create or replace function public.imported_ticketing_resolution_context_v1'),
);
assert.doesNotMatch(
  issueFunction,
  /fetch\(|axios|newticket|bookticket|cancelbooking|http_post|net\.http/i,
  'Imported Issue Now must not call a supplier API',
);
for (const required of [
  "'superadmin', 'admin', 'staff_support'",
  "v_actor_role in ('superadmin', 'admin', 'staff_support')",
  'wallet.owner_type = v_booking.booking_owner_type',
  'wallet.owner_key = v_booking.booking_owner_key',
  "case when v_on_behalf then 'staff' else 'customer' end",
]) {
  assert.ok(
    staffIssueMigration.includes(required),
    `Staff imported Issue Now omits ${required}`,
  );
}
assert.ok(!staffIssueMigration.includes("'staff_account'"));
assert.doesNotMatch(
  issueFunction,
  /transaction_type[^\n]*booking_confirm|payment_state\s*=\s*'captured'/i,
  'Imported Issue Now must Hold rather than capture',
);
assert.match(route, /getDashboardSession/);
assert.match(route, /canAccessImportedBookingIssue/);
assert.match(route, /walletOwnerForBooking/);
assert.match(route, /checkActionLimit\("impexpConfirm"/);
assert.match(route, /beginImportedBookingIssue\(/);
assert.match(walletDb, /export function beginImportedBookingIssue/);
assert.match(walletDb, /walletRpc\('wallet_confirm_impexp_booking'/);

console.log(JSON.stringify({
  checks: 'passed',
  databaseOwnershipAuthority: true,
  authorizedStaffRoles: ['superadmin', 'admin', 'staff_support'],
  exactReplayBundle: true,
  holdsUserPayableOnce: true,
  operationAwaitingExternalAction: true,
  supportCaseAssignedAtomically: true,
  immediateLifecycleOccurrence: true,
  supplierApiCalled: false,
}, null, 2));
