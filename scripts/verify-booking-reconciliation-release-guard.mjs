import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const guard = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0058_wallet_reconciliation_release_guard.sql'
  ),
  'utf8'
);
const nonissuance = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0053_booking_reconciliation_nonissuance_release.sql'
  ),
  'utf8'
);
const heldCancellation = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0055_booking_reconciliation_held_cancellation.sql'
  ),
  'utf8'
);

assert.match(
  guard,
  /create or replace function public\.wallet_release_reservation\([\s\S]*?security definer/i
);
for (const required of [
  "v_booking.payment_state = 'reconciliation'",
  "v_booking.operation_kind = 'reconciliation'",
  "v_operation.state = 'needs_reconciliation'",
  "v_attempt.state = 'unknown'",
  "state not in ('resolved', 'closed_no_change')",
  "v_reservation.state = 'reconciliation'",
  "'RECONCILIATION_REQUIRED'",
  'for update of wallet',
  "p_idempotency_key || ':release'",
]) {
  assert.ok(guard.includes(required), `Release guard omits ${required}`);
}
const bookingLock = guard.indexOf('from public.flight_bookings booking');
const caseLock = guard.indexOf(
  'from public.booking_reconciliation_cases reconciliation_case'
);
const reservationLock = guard.indexOf('from public.wallet_reservations reservation');
const walletLock = guard.indexOf('from public.wallets wallet');
const accountLock = guard.indexOf('from public.wallet_accounts account', walletLock);
assert.ok(
  bookingLock >= 0 &&
    bookingLock < caseLock &&
    caseLock < reservationLock &&
    reservationLock < walletLock &&
    walletLock < accountLock,
  'Generic booking release must follow booking -> case -> reservation -> wallet -> account'
);
assert.match(
  guard,
  /revoke all on function public\.wallet_release_reservation\([\s\S]*?from public, anon, authenticated;/i
);
assert.match(
  guard,
  /grant execute on function public\.wallet_release_reservation\([\s\S]*?to service_role;/i
);
for (const exactRelease of [nonissuance, heldCancellation]) {
  assert.doesNotMatch(
    exactRelease,
    /wallet_release_reservation\s*\(/i,
    'Approved reconciliation releases must not delegate to the generic RPC'
  );
  assert.match(exactRelease, /update public\.wallet_accounts/i);
  assert.match(exactRelease, /update public\.wallet_reservations/i);
  assert.match(exactRelease, /insert into public\.wallet_ledger_entries/i);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      ordinaryDefinitiveReleaseRetained: true,
      reconciliationReleaseViaGenericRpc: false,
      guardedSubjects: [
        'booking_reconciliation_state',
        'needs_reconciliation_operation',
        'open_case',
        'unknown_attempt',
        'reconciliation_reservation',
      ],
      exactApprovedReleaseRpcs: [
        'resolve_booking_reconciliation_nonissuance_v1',
        'resolve_booking_reconciliation_cancelled_release_v1',
      ],
    },
    null,
    2
  )
);
