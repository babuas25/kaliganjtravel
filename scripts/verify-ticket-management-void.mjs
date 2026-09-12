import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration = fs.readFileSync(
  'supabase/migrations/0125_ticket_management_void_settlement.sql',
  'utf8'
);

assert.match(migration, /complete_ticket_management_void_v1/);
assert.match(migration, /release_and_reopen_ticket_management_void_v1/);
assert.match(migration, /ticket_management_void_credit/);
assert.match(migration, /v_request\.charged_wallet_account_id/);
assert.match(migration, /state = 'voided'/);
assert.match(migration, /userPayableEntitlementConsumed/);
assert.match(migration, /v_quote\.void_fee/);
assert.match(migration, /v_quote\.service_fee/);
assert.match(migration, /'staff_account', 'admin', 'superadmin'/);
assert.doesNotMatch(migration, /wallet_refund_booking/);
assert.doesNotMatch(migration, /wallet_release_reservation/);
assert.doesNotMatch(migration, /resolve_booking_reconciliation_cancelled_release_v1/);

console.log('Ticket Management VOID isolation and settlement contracts verified.');
