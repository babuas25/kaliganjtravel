import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const guard = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0059_wallet_reconciliation_refund_guard.sql'
  ),
  'utf8'
);
const exactCancellation = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0056_booking_reconciliation_captured_cancellation.sql'
  ),
  'utf8'
);
const permissions = fs.readFileSync(
  path.join(root, 'lib', 'wallet', 'permissions.ts'),
  'utf8'
);
const route = fs.readFileSync(
  path.join(root, 'app', 'api', 'wallet', 'refunds', 'route.ts'),
  'utf8'
);
const page = fs.readFileSync(
  path.join(root, 'app', '(dashboard)', 'dashboard', 'deposits', 'page.tsx'),
  'utf8'
);
const manager = fs.readFileSync(
  path.join(
    root,
    'components',
    'dashboard',
    'wallet',
    'FinancialWalletManager.tsx'
  ),
  'utf8'
);

assert.match(
  guard,
  /create or replace function public\.wallet_refund_booking\([\s\S]*?security definer/i
);
for (const required of [
  'from public.app_users app_user',
  "v_actor_role not in ('superadmin', 'admin', 'staff_account')",
  "'REFUND_FORBIDDEN'",
  "v_booking.status <> 'confirmed'",
  "v_booking.payment_state = 'reconciliation'",
  "v_operation.state = 'needs_reconciliation'",
  "state not in ('resolved', 'closed_no_change')",
  "v_reservation.state <> 'captured'",
  "'REFUND_RESERVATION_MISMATCH'",
  "'RECONCILIATION_REQUIRED'",
  "'REFUND_IDEMPOTENCY_CONFLICT'",
  "p_idempotency_key || ':refund'",
  'p_actor_user_id, v_actor_role, p_remarks',
  "'WalletRefund'",
  "p_idempotency_key || ':refund-status'",
  "'financialEvent', 'refund'",
]) {
  assert.ok(guard.includes(required), `Refund guard omits ${required}`);
}
const bookingLock = guard.indexOf('from public.flight_bookings booking');
const operationLock = guard.indexOf('from public.booking_operations operation');
const caseLock = guard.indexOf(
  'from public.booking_reconciliation_cases reconciliation_case'
);
const reservationLock = guard.indexOf('from public.wallet_reservations reservation');
const walletLock = guard.indexOf('from public.wallets wallet');
const accountLock = guard.indexOf('from public.wallet_accounts account', walletLock);
assert.ok(
  bookingLock >= 0 &&
    bookingLock < operationLock &&
    operationLock < caseLock &&
    caseLock < reservationLock &&
    reservationLock < walletLock &&
    walletLock < accountLock,
  'Generic refund must lock booking -> operation -> case -> reservation -> wallet -> account'
);
assert.match(
  guard,
  /revoke all on function public\.wallet_refund_booking\([\s\S]*?from public, anon, authenticated;/i
);
assert.match(
  exactCancellation,
  /booking_reconciliation_resolution_contract_v1\([\s\S]*?insert into public\.wallet_ledger_entries/i,
  'Reconciliation refund must execute inside an exact case-bound contract'
);
assert.doesNotMatch(
  exactCancellation,
  /wallet_refund_booking\s*\(/i,
  'Exact reconciliation refunds must not delegate to the generic endpoint'
);
assert.match(
  permissions,
  /function canRefundBooking[\s\S]*?canManageWallet\(role\)/i
);
assert.match(route, /canRefundBooking\(session\.role\)/);
assert.doesNotMatch(route, /hasFinancialAccess\(session\.role\)/);
assert.match(page, /canRefundBookings=\{canRefundBooking\(session\.role\)\}/);
assert.match(manager, /canRefundBookings[\s\S]*?value: 'refunds'/);
assert.match(manager, /\{canRefundBookings \? \([\s\S]*?<TabsContent value="refunds"/);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      genericReconciliationRefundAllowed: false,
      genericCancelledRefundAllowed: false,
      genericRefundRoles: ['staff_account', 'admin', 'superadmin'],
      actorRoleSource: 'app_users',
      exactCaseBoundCancellationRefunds: [
        'full_refund',
        'partial_refund',
      ],
      supportRefundUiVisible: false,
    },
    null,
    2
  )
);
