import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const migration = read(
  'supabase',
  'migrations',
  '0093_booking_reconciliation_captured_cancellation_confirmation.sql'
);
const confirmationStart = migration.indexOf(
  'create or replace function public.confirm_booking_reconciliation_cancelled_captured_v1'
);
const confirmationEnd = migration.indexOf(
  'revoke all on function public.confirm_booking_reconciliation_cancelled_captured_v1'
);
assert.ok(confirmationStart >= 0 && confirmationEnd > confirmationStart);
const confirmation = migration.slice(confirmationStart, confirmationEnd);

for (const required of [
  'booking_reconciliation_resolution_contract_v1',
  "v_case.financial_disposition <> 'none'",
  "v_reservation.state <> 'captured'",
  "state = 'awaiting_finance'",
  "'captured_cancellation_confirmed'",
  "'ReconciliationCapturedCancellationConfirmed'",
  "'financialReviewRequired', true",
  "'walletMutation', false",
  "'reservationMutation', false",
  "'ledgerMutation', false",
]) {
  assert.ok(confirmation.includes(required), `captured confirmation omits ${required}`);
}

for (const forbidden of [
  /update\s+public\.wallet_accounts/i,
  /insert\s+into\s+public\.wallet_ledger_entries/i,
  /update\s+public\.wallet_reservations/i,
  /delete\s+from\s+public\.booking_reconciliation_cases/i,
]) {
  assert.doesNotMatch(confirmation, forbidden);
}

assert.match(
  migration,
  /record_booking_reconciliation_keep_open_v1[\s\S]*?insert into public\.booking_reconciliation_observations/i
);
assert.doesNotMatch(
  migration,
  /delete\s+from\s+public\.booking_reconciliation_cases/i
);

const actions = read('lib', 'db', 'booking-reconciliation-actions.ts');
assert.match(actions, /confirm_booking_reconciliation_cancelled_captured_v1/);
assert.match(actions, /resolve_booking_reconciliation_cancelled_full_refund_v1/);
assert.match(actions, /resolve_booking_reconciliation_cancelled_partial_refund_v1/);
assert.match(actions, /record_booking_reconciliation_keep_open_v1/);

const confirmCancelled = read(
  'app', 'api', 'admin', 'booking-lifecycle', '[reference]',
  'reconciliation', 'confirm-cancelled', 'route.ts'
);
assert.match(confirmCancelled, /confirmBookingReconciliationCancelledCaptured/);
assert.match(confirmCancelled, /resolveBookingReconciliationCancelledUnpaid/);
assert.match(confirmCancelled, /supplierWrite: false/);
assert.doesNotMatch(confirmCancelled, /acquireSupplierEvidence|supplierCancel|cancelBooking/i);

const confirmRefund = read(
  'app', 'api', 'admin', 'booking-lifecycle', '[reference]',
  'reconciliation', 'confirm-refund', 'route.ts'
);
assert.match(confirmRefund, /resolveBookingReconciliationRefund/);
assert.doesNotMatch(confirmRefund, /\/api\/wallet\/refunds/i);

const confirmTicketed = read(
  'app', 'api', 'admin', 'booking-lifecycle', '[reference]',
  'reconciliation', 'confirm-ticketed', 'route.ts'
);
assert.match(confirmTicketed, /resolveBookingReconciliationTicketed/);
assert.match(confirmTicketed, /capture_existing_hold/);
assert.match(confirmTicketed, /recordSecurityAuditEvent/);
const executableTicketedRoute = confirmTicketed.replace(
  /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
  ''
);
assert.doesNotMatch(
  executableTicketedRoute,
  /issueTicket\s*\(|acquireSupplierEvidence\s*\(|walletCapture(?:Reservation)?\s*\(/i
);

console.log('Historical booking reconciliation action contracts verified.');
