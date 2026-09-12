import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const protection = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0048_booking_supplier_sync_protection.sql'
  ),
  'utf8'
);
const legacy = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '0040_impexp_wallet_and_sync.sql'),
  'utf8'
);
const route = fs.readFileSync(
  path.join(root, 'app', 'api', 'impexp', 'sync-booking', 'route.ts'),
  'utf8'
);
const db = fs.readFileSync(
  path.join(root, 'lib', 'db', 'impexp.ts'),
  'utf8'
);

const protectedStart = protection.indexOf(
  'create or replace function public.sync_impexp_booking_v2'
);
const protectedEnd = protection.indexOf(
  'create or replace function public.sync_impexp_booking(',
  protectedStart
);
assert.ok(protectedStart >= 0 && protectedEnd > protectedStart);
const protectedSync = protection.slice(protectedStart, protectedEnd);

const legacyStart = legacy.indexOf(
  'create or replace function public.sync_impexp_booking('
);
const legacyEnd = legacy.indexOf(
  'create or replace function public.wallet_confirm_impexp_booking',
  legacyStart
);
assert.ok(legacyStart >= 0 && legacyEnd > legacyStart);
const retainedNormalizer = legacy.slice(legacyStart, legacyEnd);

for (const sql of [protectedSync, retainedNormalizer]) {
  assert.doesNotMatch(sql, /update public\.wallet_accounts/i);
  assert.doesNotMatch(sql, /insert into public\.wallet_ledger_entries/i);
  assert.doesNotMatch(sql, /insert into public\.wallet_reservations/i);
  assert.doesNotMatch(sql, /wallet_confirm_impexp_booking/i);
  assert.doesNotMatch(sql, /wallet_capture|wallet_refund|wallet_release/i);
}
for (const required of [
  "v_actor_role not in ('superadmin', 'admin', 'staff_support')",
  "booking.import_source = 'IMP_EXP'",
  "'walletCharged', false",
  "'statusMutation', false",
  "'walletMutation', false",
  'v_booking.active_operation_id',
  'insert into public.booking_reconciliation_observations',
  'on conflict (reconciliation_case_id, observation_key) do nothing',
  'v_supplier_lifecycle is distinct from v_local_lifecycle',
  'public.sync_impexp_booking_pre_0048(',
  "raise exception 'protected import sync changed lifecycle despite exact-match guard'",
]) {
  assert.ok(protection.includes(required), `Protected Sync omits ${required}`);
}
const bookingUpdateStart = retainedNormalizer.indexOf(
  'update public.flight_bookings'
);
const bookingUpdateEnd = retainedNormalizer.indexOf(
  'returning * into v_updated',
  bookingUpdateStart
);
assert.ok(bookingUpdateStart >= 0 && bookingUpdateEnd > bookingUpdateStart);
const bookingAssignments = retainedNormalizer.slice(
  bookingUpdateStart,
  bookingUpdateEnd
);
assert.doesNotMatch(
  bookingAssignments,
  /\bpayment_state\s*=|\bpayment_amount\s*=|\bcaptured_amount\s*=|\brefunded_amount\s*=|\bcharged_wallet_account_id\s*=/i,
  'Retained exact-match normalizer must not rewrite payment state or amounts'
);
for (const required of [
  'canAccessImpExp(session.role)',
  'checkActionLimit("impexpSync"',
  'syncImportedBooking({',
  'walletCharged: false',
]) {
  assert.ok(route.includes(required), `Sync route omits ${required}`);
}
assert.match(db, /supabase\.rpc\("sync_impexp_booking_v2"/);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      staffRoles: ['staff_support', 'admin', 'superadmin'],
      exactMatchEnrichmentOnly: true,
      conflictingOutcomeCreatesObservation: true,
      activeOperationLinked: true,
      walletDebitCalls: 0,
      walletLedgerWrites: 0,
      reservationWrites: 0,
      paymentStateWrites: 0,
    },
    null,
    2
  )
);
