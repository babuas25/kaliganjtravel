import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';

// Actual route, synthetic accounting and no external financial transport.
const code = ts.transpileModule(fs.readFileSync('app/api/admin/bookings/[reference]/payment-return/route.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const booking = { id: '11111111-1111-4111-8111-111111111111', currency: 'BDT' };
const nonce = '22222222-2222-4222-8222-222222222222';
const capture = '33333333-3333-4333-8333-333333333333';
const intent = {
  requestId: nonce, captureLedgerEntryId: capture,
  expectedCapturedAmount: 1200.50, expectedRefundedAmount: 200.25,
  expectedRefundableAmount: 1000.25, expectedAvailableBalance: 1234.56,
  expectedHoldBalance: 77.50, reason: 'Incorrect booking charge verified', confirmation: true,
};
const context = { canReturn: true, capturedAmount: 1200.50, refundedAmount: 200.25,
  refundableAmount: 1000.25, currency: 'BDT', availableBefore: 1234.56,
  availableAfter: 2234.81, captureLedgerEntryId: capture, holdBalance: 77.50 };
const success = { ok: true, replay: false, returnedAmount: 100025, capturedAmount: 120050,
  refundedAmount: 120050, currency: 'BDT', captureLedgerEntryId: capture };

async function run(options = {}) {
  const calls = [];
  const reads = [];
  const session = Object.hasOwn(options, 'session') ? options.session : { clerkId: 'synthetic-admin', role: 'admin' };
  const imports = {
    zod: { z },
    '@/lib/dashboard/session': { getDashboardSession: async () => session },
    '@/lib/dashboard/bookings': { bookingScopeFor: value => ({ kind: 'all', actor: value.clerkId }) },
    '@/lib/db/flight-bookings': { readBookingByPublicRef: async (reference, scope) => {
      reads.push({ reference, scope }); return options.missingBooking ? null : booking;
    } },
    '@/lib/db/booking-payment-resolution': { readBookingPaymentReturnContext: async input => {
      reads.push(input); return Object.hasOwn(options, 'context') ? options.context : context;
    } },
    '@/lib/supabase/server': { supabaseAdmin: () => options.noDb ? null : {
      rpc: async (name, input) => {
        assert.equal(name, 'return_booking_payment_v1'); calls.push(input);
        if (options.rpcThrows) throw new Error('Response lost after dispatch');
        return { data: Object.hasOwn(options, 'rpcData') ? options.rpcData : success,
          error: options.rpcError ? { code: 'SYNTHETIC_STORAGE_ERROR' } : null };
      },
    } },
    '@/lib/rate-limit': { checkActionLimit: async () => ({ ok: !options.rateLimited }) },
    '@/lib/wallet/http': { walletOk: data => ({ status: 200, data }),
      walletFail: (status, code, message) => ({ status, code, message }) },
  };
  const module = { exports: {} };
  new vm.Script(code).runInNewContext({ module, exports: module.exports, console,
    require(name) { assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`); return imports[name]; } });
  const method = options.method ?? 'POST';
  const request = { json: async () => ({ ...intent, ...options.body }) };
  const result = await module.exports[method](request, { params: Promise.resolve({ reference: options.reference ?? 'KTT261102111113' }) });
  return { result, calls, reads };
}

for (const role of ['admin', 'superadmin']) {
  const actual = await run({ session: { clerkId: 'synthetic-admin', role } });
  assert.equal(actual.result.status, 200);
  assert.equal(actual.result.data.returned, true);
  assert.equal(actual.result.data.amount, 1000.25);
  assert.equal(actual.result.data.refundedAmount, 1200.50);
  assert.deepEqual(JSON.parse(JSON.stringify(actual.calls[0])), {
    p_booking_id: booking.id, p_actor_user_id: 'synthetic-admin', p_actor_role: role,
    p_request_id: nonce, p_expected_capture_ledger_entry_id: capture,
    p_expected_refunded_amount: 20025, p_expected_refundable_amount: 100025,
    p_expected_available_balance: 123456, p_expected_hold_balance: 7750,
    p_reason: intent.reason, p_confirmation: true,
  });
  assert.equal(Object.hasOwn(actual.calls[0], 'p_wallet_account_id'), false);
  assert.equal(Object.hasOwn(actual.calls[0], 'p_amount'), false);
}
const preview = await run({ method: 'GET' });
assert.equal(preview.result.status, 200);
assert.equal(preview.calls.length, 0, 'Preview must not submit any return');
assert.deepEqual(JSON.parse(JSON.stringify(preview.result.data)), context);
for (const reference of ['KTT261102111113', 'KTTABC123', 'STR261102111113']) {
  assert.equal((await run({ method: 'GET', reference })).result.status, 200,
    'Payment previews retain native KTT and saved STR reference formats');
  assert.equal((await run({ reference })).result.status, 200);
}
for (const session of [null, { clerkId: 'user', role: 'b2b' }, { clerkId: 'staff', role: 'staff_account' }]) {
  const denied = await run({ session });
  assert.ok([401, 403].includes(denied.result.status));
  assert.equal(denied.calls.length, 0); assert.equal(denied.reads.length, 0);
}
for (const body of [
  { expectedCapturedAmount: 1200.501 }, { expectedRefundableAmount: 0 },
  { expectedRefundableAmount: 1000.24 }, { expectedAvailableBalance: -1 },
  { captureLedgerEntryId: 'wrong' }, { reason: 'x' }, { confirmation: false },
  { reason: 'wrong\ncharge' },
  { walletAccountId: 'foreign-wallet' }, { amount: 999999 },
]) {
  const rejected = await run({ body }); assert.equal(rejected.result.status, 400); assert.equal(rejected.calls.length, 0);
}
for (const options of [
  ...['wrong', 'KTT', 'STR123', 'BDTI261102111113'].map(reference => ({ reference })),
  { missingBooking: true }, { rateLimited: true },
]) {
  const rejected = await run(options); assert.ok(rejected.result.status >= 400); assert.equal(rejected.calls.length, 0);
}
const changed = await run({ rpcData: { ok: false, code: 'PAYMENT_RETURN_STATE_CHANGED' } });
assert.equal(changed.result.status, 409);
assert.equal(changed.result.code, 'PAYMENT_RETURN_STATE_CHANGED');
for (const options of [{ rpcThrows: true }, { rpcError: true }, { rpcData: null },
  { rpcData: { ...success, returnedAmount: 100026 } }, { rpcData: { ...success, currency: 'USD' } }]) {
  const uncertain = await run(options);
  assert.equal(uncertain.result.status, 503);
  assert.equal(uncertain.result.code, 'PAYMENT_RETURN_OUTCOME_UNKNOWN');
  assert.equal(uncertain.calls[0].p_request_id, nonce);
}
const replay = await run({ rpcData: { ...success, replay: true } });
assert.equal(replay.result.status, 200); assert.equal(replay.result.data.replay, true);
assert.equal(replay.calls.length, 1);
assert.equal((await run({ method: 'GET', context: null })).result.code, 'PAYMENT_RETURN_REVIEW_REQUIRED');
console.log('PASS booking payment return API: authorized scoped preview, exact minor-unit fingerprint, full remaining return, immutable request replay and uncertain-result guards; no live writes.');
