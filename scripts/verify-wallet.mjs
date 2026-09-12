import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(
  new URL('../supabase/migrations/0019_wallet_core.sql', import.meta.url),
  'utf8'
);
const viewSecurityMigration = await readFile(
  new URL('../supabase/migrations/0020_wallet_report_view_security.sql', import.meta.url),
  'utf8'
);
const boundaryMigration = await readFile(
  new URL('../supabase/migrations/0021_wallet_currency_and_privilege_guards.sql', import.meta.url),
  'utf8'
);
const depositReferenceMigration = await readFile(
  new URL('../supabase/migrations/0022_deposit_public_references.sql', import.meta.url),
  'utf8'
);
const depositChannelsMigration = await readFile(
  new URL('../supabase/migrations/0023_deposit_channels.sql', import.meta.url),
  'utf8'
);
const bankTransferMigration = await readFile(
  new URL('../supabase/migrations/0024_bank_transfer_deposits.sql', import.meta.url),
  'utf8'
);
const lifecycleMigration = await readFile(
  new URL('../supabase/migrations/0031_booking_lifecycle_authority.sql', import.meta.url),
  'utf8'
);
const manualIssueGuardMigration = await readFile(
  new URL('../supabase/migrations/0032_booking_lifecycle_manual_issue_guard.sql', import.meta.url),
  'utf8'
);
const operationClaimsMigration = await readFile(
  new URL('../supabase/migrations/0045_booking_operation_claims.sql', import.meta.url),
  'utf8'
);
const issueRoute = await readFile(
  new URL('../app/api/flights/booking/issue/route.ts', import.meta.url),
  'utf8'
);
const bookingRoute = await readFile(
  new URL('../app/api/flights/booking/route.ts', import.meta.url),
  'utf8'
);
const bookingAttempts = await readFile(
  new URL('../lib/db/booking-attempts.ts', import.meta.url),
  'utf8'
);
const bookingCheckout = await readFile(
  new URL('../components/flights/BookingCheckout.tsx', import.meta.url),
  'utf8'
);
const permissions = await readFile(
  new URL('../lib/wallet/permissions.ts', import.meta.url),
  'utf8'
);
const roles = await readFile(new URL('../lib/roles.ts', import.meta.url), 'utf8');
const authorizationHardening = await readFile(
  new URL(
    '../supabase/migrations/0127_generic_wallet_authorization_hardening.sql',
    import.meta.url
  ),
  'utf8'
);

function includesAll(source, values, label) {
  for (const value of values) {
    assert.ok(source.includes(value), `${label} is missing ${value}`);
  }
}

includesAll(
  migration,
  [
    'create table if not exists public.wallets',
    'create table if not exists public.wallet_accounts',
    'create table if not exists public.wallet_reservations',
    'create table if not exists public.wallet_ledger_entries',
    'create table if not exists public.wallet_deposit_requests',
    'create table if not exists public.wallet_adjustment_requests',
    'available_balance bigint not null default 0 check (available_balance >= 0)',
    'hold_balance      bigint not null default 0 check (hold_balance >= 0)',
    "before update or delete on public.wallet_ledger_entries",
    "raise exception 'wallet ledger entries are immutable'",
    'for update of w',
    "'INSUFFICIENT_FUNDS'",
    "'SELF_APPROVAL_FORBIDDEN'",
    'wallet_begin_booking_issue',
    'wallet_begin_direct_ticket',
    'wallet_capture_reservation',
    'wallet_release_reservation',
    'wallet_mark_reconciliation',
    'wallet_refund_booking',
    "p_idempotency_key || ':refund'",
    'booking_payment_report_v',
  ],
  'wallet migration'
);

const reserveFunction = migration.slice(
  migration.indexOf('create or replace function public.wallet_reserve_amount'),
  migration.indexOf('create or replace function public.wallet_begin_booking_issue')
);
const captureFunction = migration.slice(
  migration.indexOf('create or replace function public.wallet_capture_reservation'),
  migration.indexOf('create or replace function public.wallet_release_reservation')
);
assert.ok(
  reserveFunction.indexOf('available_balance = available_balance - p_amount') <
    reserveFunction.indexOf("'booking_hold'"),
  'booking hold must update the account and append its ledger row in one function'
);
assert.ok(
  captureFunction.indexOf("state = 'captured'") <
    captureFunction.indexOf("'booking_confirm'"),
  'capture state and confirm ledger must share the capture function'
);
assert.ok(
  !/available_balance\s*=\s*-/.test(migration),
  'wallet code must not assign an explicitly negative available balance'
);
assert.ok(
  !migration.includes('select wa, w into'),
  'PostgreSQL composite records must be selected into separate targets'
);

const reservePosition = issueRoute.indexOf('beginBookingIssue(');
const supplierPosition = issueRoute.indexOf('issueTicket(');
const capturePosition = issueRoute.indexOf('finalizeBookingIssue(');
assert.ok(reservePosition >= 0 && reservePosition < supplierPosition);
assert.ok(supplierPosition < capturePosition);
includesAll(
  issueRoute,
  [
    'markReservationForReconciliation',
    'failBookingIssue',
    'beginLegacyManualIssue',
    'ISSUE_OUTCOME_UNKNOWN',
    'WALLET_RESERVATION_UNKNOWN',
    'getSupplierOperationalControls',
  ],
  'ticket issue route'
);

includesAll(
  lifecycleMigration,
  [
    'create or replace function public.wallet_begin_booking_issue',
    "status = 'in-progress'",
    "operation_reason = 'ticketing'",
    'create or replace function public.wallet_fail_booking_issue',
    'create or replace function public.wallet_capture_reservation',
    'TICKET_EVIDENCE_INCOMPLETE',
    'revoke execute on function public.wallet_queue_manual_issue',
  ],
  'booking lifecycle wallet migration'
);

includesAll(
  operationClaimsMigration,
  [
    'create or replace function public.wallet_begin_booking_issue_v2',
    'create or replace function public.wallet_capture_reservation_v2',
    'create or replace function public.wallet_fail_booking_issue_v2',
    'public.booking_operation_finalization_guard(',
    "'SUPPLIER_RESPONSE_NOT_RECORDED'",
    'public.mark_booking_operation_finalization_reconciliation(',
    "state = 'needs_reconciliation'",
    'v_result := public.wallet_capture_reservation(',
  ],
  'versioned booking operation wallet migration'
);

includesAll(
  manualIssueGuardMigration,
  [
    'drop function if exists public.wallet_finalize_manual_issue(uuid,text,jsonb)',
    'public.wallet_finalize_manual_issue(uuid,text,text,jsonb)',
    "v_booking.status <> 'in-progress'",
    "v_booking.operation_kind <> 'ticketing'",
    "v_booking.operation_reason <> 'legacy_reconciliation'",
    "'TICKET_EVIDENCE_INCOMPLETE'",
    "'actorRole', p_actor_role",
  ],
  'manual issue guard migration'
);

includesAll(
  bookingRoute,
  [
    'beginDirectTicket',
    'captureBookingReservation',
    'restoreClaimedBookingAttempt',
    'markReservationForReconciliation',
    'WALLET_RESERVATION_UNKNOWN',
  ],
  'direct-ticket route'
);

const directGatePosition = bookingRoute.indexOf(
  'offer.directTicketing && !supplierControls.ticketingEnabled'
);
const directReservationPosition = bookingRoute.indexOf('beginDirectTicket(');
const directSupplierPosition = bookingRoute.indexOf('bookFlight(');
assert.ok(
  directGatePosition >= 0 &&
    directGatePosition < directReservationPosition &&
    directReservationPosition < directSupplierPosition,
  'direct ticketing must be gated before wallet reservation and supplier submission'
);
includesAll(
  bookingAttempts,
  ['ticketingEnabled: controls.ticketingEnabled'],
  'booking attempt capability'
);
includesAll(
  bookingCheckout,
  [
    'attempt.directTicketing && !attempt.ticketingEnabled',
    'reserve the full amount',
    'There is no hold or online cancellation step.',
  ],
  'direct-ticket checkout'
);

assert.match(
  permissions,
  /role === 'customer'[\s\S]*ownerType: 'user'/,
  'customers must resolve to user wallets'
);
assert.match(
  permissions,
  /role === 'b2b'[\s\S]*role === 'b2b_sub'[\s\S]*ownerType: 'agency'/,
  'B2B owners and sub-users must resolve to the agency wallet'
);
assert.ok(
  !permissions.match(/staff_(support|media)'[\s\S]{0,80}FINANCIAL/),
  'non-Accounts staff must not receive financial access'
);
assert.match(permissions, /function canReadWallet/);
assert.match(permissions, /function canManageWallet/);
assert.doesNotMatch(
  permissions.slice(
    permissions.indexOf('const WALLET_MUTATION_ROLES'),
    permissions.indexOf('export function canReadWallet')
  ),
  /staff_support/,
  'Support must not receive wallet mutation authority'
);
includesAll(
  authorizationHardening,
  [
    'enforce_wallet_adjustment_request_actor_v1',
    'WALLET_ADJUSTMENT_CREATE_FORBIDDEN',
    'WALLET_ADJUSTMENT_REVIEW_FORBIDDEN',
    'WALLET_ACTOR_ROLE_MISMATCH',
    "v_actor_role not in ('superadmin', 'admin', 'staff_account')",
    'SELF_APPROVAL_FORBIDDEN',
    'wallet_refund_booking',
    'to service_role',
  ],
  'generic wallet authorization hardening'
);
assert.match(
  roles,
  /segment: 'deposits'[\s\S]{0,160}staff_account/,
  'Accounts staff must have the Accounts navigation entry'
);

includesAll(
  viewSecurityMigration,
  [
    'alter view public.wallet_report_v set (security_invoker = true)',
    'alter view public.wallet_transaction_report_v set (security_invoker = true)',
    'alter view public.booking_payment_report_v set (security_invoker = true)',
    'from public, anon, authenticated',
    'to service_role',
  ],
  'wallet report view security migration'
);

includesAll(
  boundaryMigration,
  [
    'create or replace function public.enforce_wallet_account_currency()',
    'wallet_ledger_currency_guard',
    'wallet_deposits_currency_guard',
    'wallet_adjustments_currency_guard',
    'revoke all on table public.wallets',
    'from service_role',
    'grant update (status, frozen_at, frozen_by, freeze_reason)',
  ],
  'wallet database boundary migration'
);

includesAll(
  depositReferenceMigration,
  [
    "return 'STD' || to_char(p_date, 'YYMMDD') || lpad(v_next::text, 6, '0')",
    "check (public_ref ~ '^STD[0-9]{12}$')",
    'wallet_deposit_requests_public_ref_key',
    'deposit request reference is immutable',
  ],
  'deposit request reference migration'
);

includesAll(
  depositChannelsMigration,
  [
    'create table if not exists public.wallet_payment_branches',
    'create table if not exists public.wallet_company_bank_accounts',
    "check (method in ('cash', 'bank', 'mobile', 'cheque'))",
    'received_by_user_id text',
    'gateway_fee_bps integer',
    'gross_amount bigint',
    'attachment jsonb',
    'wallet_deposit_method_fields_check',
    'from public, anon, authenticated',
    'to service_role',
  ],
  'deposit channel migration'
);

includesAll(
  bankTransferMigration,
  [
    'user_bank_account jsonb',
    "check (method in ('cash', 'bank', 'bank_transfer', 'mobile', 'cheque'))",
    "method = 'bank_transfer'",
    'wallet_deposit_method_fields_check',
  ],
  'bank transfer deposit migration'
);

const walletReportRoute = await readFile(
  new URL('../app/api/wallet/reports/route.ts', import.meta.url),
  'utf8'
);
const depositRoute = await readFile(
  new URL('../app/api/wallet/deposits/route.ts', import.meta.url),
  'utf8'
);
includesAll(
  walletReportRoute,
  ['listWallets(null)', 'totalsByCurrency', 'bookingResult.error'],
  'complete currency-aware wallet reporting'
);
includesAll(
  depositRoute,
  ['Date.UTC(year, month - 1, day)', 'Choose a valid calendar date.'],
  'deposit calendar-date validation'
);

console.log('Wallet verification passed: schema, ownership, issue ordering and role gates are present.');
