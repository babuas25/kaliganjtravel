import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { currencyModule } from './helpers/currency.mjs';

const require = createRequire(import.meta.url);
const { BOOKING_CURRENCY, currencyForBdtContract, isBookingCurrency, UnsupportedCurrencyError } = currencyModule;

// Only supplier responses may omit currency under the existing BDT contract.
assert.equal(currencyForBdtContract(undefined, null, '', '  '), 'BDT');
assert.equal(currencyForBdtContract(' bdt ', 'BDT'), 'BDT');
for (const value of ['USD', 'EUR', 'JPY', 'BHD', 'B D T', 840, {}, false]) {
  assert.throws(() => currencyForBdtContract('BDT', value), UnsupportedCurrencyError);
  assert.equal(isBookingCurrency(value), false);
}
for (const value of [null, undefined, '']) assert.equal(isBookingCurrency(value), false);

// Load real entry points; fail if they touch any infrastructure beyond the
// explicitly allowed identity/reference reads. No network or real writes.
function load(path, modules = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const dependencies = {
    'server-only': {},
    zod: require('zod'),
    'next/server': { NextResponse: Response },
    '@/lib/currency': currencyModule,
    ...modules,
  };
  const forbiddenCalls = [];
  const localRequire = (id) => dependencies[id] ?? new Proxy({}, {
    get: (_target, key) => (..._args) => {
      forbiddenCalls.push(`${id}.${String(key)}`);
      throw new Error(`Unexpected infrastructure call: ${forbiddenCalls.at(-1)}`);
    },
  });
  new Function('require', 'module', 'exports', compiled)(localRequire, module, module.exports);
  return { ...module.exports, forbiddenCalls };
}

const manual = load('lib/impexp/manual-validation.ts');
const currencySchema = manual.manualBookingImportSchema.innerType().shape.currency;
assert.equal(currencySchema.parse(' bdt '), BOOKING_CURRENCY);
for (const value of ['USD', 'EUR', 'JPY', '', null, undefined]) {
  assert.equal(currencySchema.safeParse(value).success, false, 'manual imports require explicit BDT');
}

const requestId = '00000000-0000-4000-8000-000000000001';
const session = { clerkId: 'currency-test', role: 'user' };
const common = {
  '@/lib/dashboard/session': { getDashboardSession: async () => session },
  '@/lib/db/supplier-controls': { getSupplierOperationalControls: async () => ({ bookingEnabled: true, ticketingEnabled: true }) },
  '@/lib/rate-limit': { checkActionLimit: async () => ({ ok: true }) },
  '@/lib/http/actor-key': { requestActorKey: () => 'currency-test' },
  '@/lib/dashboard/bookings': { bookingScopeFor: () => ({ userId: session.clerkId }) },
  '@/lib/triplover/config': { isTriploverSupplier: () => true },
  '@/lib/wallet/http': { walletFail: (status, errorCode, errorMessage) => Response.json({ success: false, error: { errorCode, errorMessage } }, { status }) },
};

const repriceRoute = load('app/api/flights/reprice/route.ts', {
  ...common,
  '@/lib/flights/staff-booking.server': { resolveBookingActorContext: async () => ({ principal: { userId: session.clerkId, audience: 'b2c', agencyCode: null } }) },
  '@/lib/triplover/reprice': { repriceFlight: async () => { throw new UnsupportedCurrencyError(); } },
});
const repriceFailure = await repriceRoute.POST({ json: async () => ({ searchId: requestId, itineraryId: 'itn-0-0' }) });
assert.equal(repriceFailure.status, 502);
assert.equal((await repriceFailure.json()).error.errorCode, 'UNSUPPORTED_CURRENCY');
assert.deepEqual(repriceRoute.forbiddenCalls, []);

for (const currency of ['USD', 'EUR', '', null, undefined]) {
  const booking = load('app/api/flights/booking/route.ts', {
    ...common,
    '@/lib/db/booking-attempts': { readBookingAttempt: async () => ({
      user_id: session.clerkId, state: 'draft', expires_at: new Date(Date.now() + 60_000).toISOString(),
      supplier_account: 'triplover', unique_trans_id: 'UTID-test', item_code_ref: 'item-test', price_code_ref: 'price-test',
      offer_snapshot: { currency },
    }) },
  });
  const result = await booking.POST({ json: async () => ({
    bookingId: requestId, accessToken: 'a'.repeat(32),
    travellers: [{ passengerType: 'ADT', title: 'Mr', firstName: 'Test', lastName: 'Traveller', gender: 'Male', dateOfBirth: '1990-01-01', nationality: 'BD' }],
    contact: { phone: '1700000000', phoneCountryCode: '+880', customerEmail: 'test@example.com' },
  }) });
  assert.equal(result.status, 409);
  assert.equal((await result.json()).error.errorCode, 'UNSUPPORTED_CURRENCY');
  assert.deepEqual(booking.forbiddenCalls, [], 'invalid currency must not claim a draft, touch wallet funds or submit to supplier');

  for (const [path, methods] of [
    ['app/api/flights/booking/issue/route.ts', ['GET', 'POST']],
    ['app/api/flights/booking/issue/status/route.ts', ['GET']],
  ]) {
    const route = load(path, {
      ...common,
      '@/lib/db/flight-bookings': { readBookingByPublicRef: async () => ({ currency }) },
    });
    for (const method of methods) {
      const result = await route[method]({
        nextUrl: new URL('https://example.test/?reference=KTTCURRENCYTEST'),
        json: async () => ({ bookingReference: 'KTTCURRENCYTEST', requestId }),
      });
      assert.equal(result.status, 409);
      assert.equal((await result.json()).error.errorCode, 'UNSUPPORTED_CURRENCY');
      assert.deepEqual(route.forbiddenCalls, [], `${path} must reject currency before wallet or ticket operations`);
    }
  }
}

const walletCalls = [];
const wallet = load('lib/db/wallet.ts', {
  '@/lib/supabase/server': { supabaseAdmin: () => ({
    rpc: async (name, args) => { walletCalls.push({ name, args }); return { data: { id: 'account-test' } }; },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { currency: 'BDT', available_balance: 12345 } }) }) }) }),
  }) },
});
const owner = { ownerType: 'user', ownerKey: 'currency-test' };
await assert.rejects(() => wallet.ensureWalletForOwner(owner, 'USD'), UnsupportedCurrencyError);
assert.equal(walletCalls.length, 0, 'unsupported currency must not create a wallet account');
const summary = await wallet.ensureWalletForOwner(owner, ' bdt ');
assert.equal(walletCalls[0].args.p_currency, 'BDT');
assert.equal(summary.currency, 'BDT');
assert.equal(summary.availableBalance, 12345, 'wallet minor-unit balances remain unchanged');
assert.deepEqual(wallet.forbiddenCalls, []);

console.log('BDT currency contract, manual validation, booking/ticket guards and wallet account checks passed.');
