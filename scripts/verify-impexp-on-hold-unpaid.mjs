import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const invariant = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0061_impexp_on_hold_unpaid_invariant.sql'
  ),
  'utf8'
);
const workflow = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0040_impexp_wallet_and_sync.sql'
  ),
  'utf8'
);
const confirmRoute = fs.readFileSync(
  path.join(root, 'app', 'api', 'impexp', 'confirm-booking', 'route.ts'),
  'utf8'
);
const resolution = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '0108_imported_booking_ticketing_resolution.sql'),
  'utf8',
);

for (const required of [
  'flight_bookings_impexp_on_hold_unpaid_check',
  "import_source is distinct from 'IMP_EXP'",
  "status <> 'on-hold'",
  "payment_state = 'unpaid'",
  'charged_wallet_account_id is null',
  'captured_amount = 0',
  'refunded_amount = 0',
  ') not valid;',
]) {
  assert.ok(invariant.includes(required), `Import hold invariant omits ${required}`);
}
const createStart = workflow.indexOf(
  'create or replace function public.create_impexp_booking'
);
const createFunction = workflow.slice(createStart);
assert.ok(createStart >= 0);
assert.match(
  createFunction,
  /case when v_status = 'confirmed' then 'captured' else 'unpaid' end/i
);
assert.match(
  createFunction,
  /case when v_status = 'confirmed' then v_account\.id end/i
);
assert.match(
  createFunction,
  /if v_status = 'confirmed' then[\s\S]*?update public\.wallet_accounts/i
);
assert.match(
  resolution,
  /create or replace function public\.wallet_begin_imported_booking_issue_v2[\s\S]*?v_booking\.status <> 'on-hold'[\s\S]*?v_booking\.payment_state <> 'unpaid'[\s\S]*?available_balance = available_balance - v_booking\.user_payable_amount[\s\S]*?hold_balance = hold_balance \+ v_booking\.user_payable_amount[\s\S]*?payment_state = 'held'[\s\S]*?status = 'in-progress'/i,
);
assert.match(confirmRoute, /canAccessImportedBookingIssue/);
assert.match(confirmRoute, /walletOwnerForBooking/);
assert.match(confirmRoute, /beginImportedBookingIssue/);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      importedHeldStatus: 'on-hold',
      importedHeldPayment: 'unpaid',
      chargedAccountBeforeIssueNow: false,
      walletMutationDuringHeldImport: false,
      ownerOrAuthorizedStaffIssueNowRequired: true,
      ownerIssueWalletEffect: 'Available to Hold',
      historicalRowsRewritten: false,
    },
    null,
    2
  )
);
