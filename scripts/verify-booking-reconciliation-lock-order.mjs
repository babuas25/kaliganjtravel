import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0051_booking_reconciliation_resolution_contracts.sql'
  ),
  'utf8'
);

assert.match(
  migration,
  /from public\.flight_bookings booking[\s\S]*?for update;[\s\S]*?from public\.booking_reconciliation_cases reconciliation_case[\s\S]*?subject_booking_id = p_booking_id;[\s\S]*?from public\.booking_operations operation[\s\S]*?for update;[\s\S]*?from public\.booking_reconciliation_cases reconciliation_case[\s\S]*?for update;[\s\S]*?from public\.wallet_reservations reservation[\s\S]*?for update;[\s\S]*?from public\.wallets wallet[\s\S]*?for update of wallet;[\s\S]*?from public\.wallet_accounts account[\s\S]*?for update;/i,
  'Resolution lock sequence must be booking -> operation -> case -> reservation -> wallet -> account'
);
for (const required of [
  "'CASE_OPERATION_MISMATCH'",
  "'CASE_OPERATION_CHANGED'",
  "'WALLET_OWNER_NOT_FOUND'",
  "'WALLET_ACCOUNT_NOT_FOUND'",
  'reservation.booking_attempt_id = v_booking.attempt_id',
]) {
  assert.ok(migration.includes(required), `Lock guard omits ${required}`);
}

assert.doesNotMatch(
  migration,
  /for update[\s\S]{0,100}public\.wallet_ledger_entries/i,
  'Immutable ledger entries are appended, never row-locked for mutation'
);

const walletCore = fs.readFileSync(
  path.join(process.cwd(), 'supabase', 'migrations', '0019_wallet_core.sql'),
  'utf8'
);
assert.match(
  walletCore,
  /wallet_begin_booking_issue\([\s\S]*?from public\.flight_bookings[\s\S]*?for update;[\s\S]*?wallet_reserve_amount\(/i,
  'Ordinary booking issue must serialize on booking before wallet reservation locks'
);
assert.match(
  walletCore,
  /from public\.wallets w[\s\S]*?for update of w;[\s\S]*?from public\.wallet_accounts[\s\S]*?for update;/i,
  'Wallet mutations must lock wallet owner before currency account'
);
assert.match(
  walletCore,
  /revoke execute on function public\.wallet_reserve_amount\([\s\S]*?from service_role;/i,
  'The reservation helper with a narrower lock prefix must remain private'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      lockOrder: [
        'flight_booking',
        'booking_operation',
        'reconciliation_case',
        'wallet_reservation',
        'wallet',
        'wallet_account',
      ],
      ledgerMutationLock: false,
      directReservationHelperCallable: false,
    },
    null,
    2
  )
);
