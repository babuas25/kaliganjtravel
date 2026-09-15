import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';

const base = {
  id: 'booking-1', public_ref: 'STR260906000006', supplier: 'triplover',
  supplier_account: 'triplover', import_source: 'IMP_EXP', status: 'on-hold', operation_kind: null,
  pnr: 'GDS123', booking_ref_number: 'BOOKREF', booking_code_ref: 'private-booking-code',
  supplier_refs: { uniqueTransId: 'private-tx', itemCodeRef: 'private-item', priceCodeRef: 'private-price' },
  ticketing_deadline_at: null, itinerary: { carrierCode: 'BG' }, created_at: '2026-09-06T10:15:30Z',
};
const flowCode = ts.transpileModule(fs.readFileSync('lib/booking-lifecycle/ticketing-flow.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flow = { exports: {} };
new Function('exports', flowCode)(flow.exports);
let session, booking, allowed, details, calls;
const reset = () => {
  session = { clerkId: 'owner', role: 'b2b', agencyCode: 'AG1' };
  booking = structuredClone(base); allowed = true;
  details = { status: 'Booked', ticketingDeadlineAt: '2026-09-07T08:15:00Z', rawLastTicketTime: '07/09/2026 14:15:00', evidence: { private: true } };
  calls = { reads: 0, syncs: 0, limits: 0 };
};
const imports = {
  '@/lib/booking-lifecycle/ticketing-flow': flow.exports,
  zod: { z },
  '@/lib/dashboard/session': { getDashboardSession: async () => session },
  '@/lib/dashboard/bookings': { bookingScopeFor: (s) => s.role === 'b2b' ? { kind: 'agency', agencyCode: s.agencyCode } : { kind: 'user', clerkId: s.clerkId } },
  '@/lib/db/flight-bookings': {
    readBookingByPublicRef: async (ref, scope) => { assert.equal(ref, base.public_ref); assert.deepEqual(scope, imports['@/lib/dashboard/bookings'].bookingScopeFor(session)); return booking; },
    syncPnrDetails: async (id, data, actor, source) => {
      calls.syncs++; assert.equal(id, base.id); assert.equal(data, details); assert.equal(actor, session); assert.equal(source, 'ordinary_sync');
      return { ...booking, ticketing_deadline_at: details.ticketingDeadlineAt };
    },
  },
  '@/lib/db/booking-deadline-read-budget': {
    claimBookingDeadlineRead: async (id) => { calls.limits++; assert.equal(id, base.id); return { claimed: allowed, complete: !allowed, claimToken: allowed ? 'token-1' : undefined }; },
    finishBookingDeadlineRead: async (id, token) => { assert.equal(id, base.id); assert.equal(token, 'token-1'); },
  },
  '@/lib/triplover/config': { isTriploverSupplier: (s) => s === 'triplover' },
  '@/lib/triplover/pnr': {
    pnrLookupLocators: (b) => ({ pnr: b.pnr, bookingRefNumber: b.bookingRefNumber }),
    readPnr: async (input) => {
      calls.reads++; assert.equal(input.pnr, base.pnr); assert.equal(input.bookingRefNumber, base.booking_ref_number);
      assert.equal(input.supplier, base.supplier_account); assert.equal(input.carrierCode, 'BG'); assert.equal(input.timeoutMs, 15000);
      if (details instanceof Error) throw details;
      return details;
    },
  },
  '@/lib/wallet/http': {
    walletOk: (data) => Response.json({ success: true, data }),
    walletFail: (status, errorCode, errorMessage) => Response.json({ success: false, error: { errorCode, errorMessage } }, { status }),
  },
};
const code = ts.transpileModule(fs.readFileSync('app/api/flights/booking/refresh-deadline/route.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function('exports', 'require', code)(module.exports, (name) => {
  assert.ok(imports[name], `Unexpected dependency ${name}`); return imports[name];
});
const request = () => module.exports.POST(new Request('http://localhost/api/flights/booking/refresh-deadline', {
  method: 'POST', body: JSON.stringify({ bookingReference: base.public_ref }),
}));
// Normal bookings never contact PNR, including reopened browser tabs and a
// missing deadline. Older imported flows retain their scoped read behaviour.
for (const supplier of ['firsttrip', 'takeoff', 'triplover']) {
  for (const deadline of [null, '2030-01-01T00:00:00Z']) {
    reset(); booking.import_source = null; booking.supplier_account = supplier;
    booking.ticketing_deadline_at = deadline;
    assert.deepEqual((await (await request()).json()).data, { ticketingDeadlineAt: deadline, complete: true });
    assert.deepEqual(calls, { reads: 0, syncs: 0, limits: 0 });
  }
}
for (const role of ['b2b', 'b2b_sub', 'customer', 'admin']) {
  reset(); session.role = role;
  const response = await request(); assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data, { ticketingDeadlineAt: details.ticketingDeadlineAt, complete: true });
  assert.equal(calls.reads, 1); assert.equal(calls.syncs, 1);
  assert.doesNotMatch(JSON.stringify(body), /private|GDS123|BOOKREF|evidence/);
}
reset(); session = null; assert.equal((await request()).status, 401); assert.equal(calls.reads, 0);
reset(); session.role = 'staff_media'; assert.equal((await request()).status, 403);
reset(); booking = null; assert.equal((await request()).status, 404); assert.equal(calls.limits, 0);
reset(); allowed = false; assert.deepEqual((await (await request()).json()).data, { ticketingDeadlineAt: null, complete: true }); assert.equal(calls.reads, 0);
reset(); booking.ticketing_deadline_at = details.ticketingDeadlineAt;
assert.equal((await request()).status, 200); assert.equal(calls.reads, 0); assert.equal(calls.limits, 0);
for (const change of [{ status: 'confirmed' }, { status: 'cancelled' }, { operation_kind: 'ticketing' }, { import_source: 'MANUAL' }, { supplier: 'external' }]) {
  reset(); Object.assign(booking, change);
  assert.equal((await (await request()).json()).data.complete, true); assert.equal(calls.reads, 0);
}
reset(); details.ticketingDeadlineAt = null;
assert.deepEqual((await (await request()).json()).data, { ticketingDeadlineAt: null, complete: false }); assert.equal(calls.syncs, 0);
reset(); details = new Error('private supplier failure');
const failed = await request(); assert.equal(failed.status, 502); assert.doesNotMatch(await failed.text(), /private/);
console.log('Scoped customer/B2B deadline acquisition, reference separation, response minimization, throttling and terminal protection passed.');

// Run the real browser effect with a deterministic clock. This is a reopened
// booking owned by a B2B user, without the staff refresh permission or URL flag.
const actions = fs.readFileSync('components/flights/BookingActions.tsx', 'utf8');
const effectStart = actions.indexOf('  useEffect(() => {\n    if (\n      !autoRefreshDeadline');
assert.ok(effectStart >= 0);
const effectSource = actions.slice(effectStart, actions.indexOf('  async function requestTimeLimit', effectStart));
const effectCode = ts.transpileModule(effectSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let effect, time = 0, refreshCount = 0, cleanup;
const readTimes = [];
const scope = {
  useEffect: (fn) => { effect = fn; }, autoRefreshDeadline: true,
  bookingReference: base.public_ref, completedDeadlineRefresh: { current: null },
  manualBooking: false, allowImportedSync: false, status: 'on-hold', ticketingDeadlineAt: null,
  DEADLINE_AUTO_REFRESH_DELAYS_MS: [5000, 10000, 15000, 30000, 45000, 120000, 240000, 360000],
  Date: { now: () => time },
  window: { setTimeout: (fn, delay) => { time += delay; fn(); return 1; }, clearTimeout: () => {} },
  refreshSupplierDetails: async (automatic) => { assert.equal(automatic, true); readTimes.push(time); return readTimes.length === 3; },
  clearCreatedBookingMarker: () => {}, router: { refresh: () => refreshCount++ },
};
new Function(...Object.keys(scope), effectCode)(...Object.values(scope));
// The page disables this controller for normal saved-reference bookings.
scope.autoRefreshDeadline = false;
new Function(...Object.keys(scope), effectCode)(...Object.values(scope));
effect();
for (let i = 0; i < 5; i++) await Promise.resolve();
assert.deepEqual(readTimes, []);
scope.autoRefreshDeadline = true;
new Function(...Object.keys(scope), effectCode)(...Object.values(scope));
cleanup = effect();
for (let i = 0; i < 30; i++) await Promise.resolve();
assert.deepEqual(readTimes, [5000, 10000, 15000]);
assert.equal(refreshCount, 1, 'Reload only once after the supplier provides a deadline');
cleanup();
console.log('Reopened B2B booking checks at 5/10/15 seconds and stops after deadline discovery.');

// A server refresh can rerun the effect with the same missing deadline props.
// Completion (including exhausted budget) must not create a five-second loop.
effect();
for (let i = 0; i < 30; i++) await Promise.resolve();
assert.equal(readTimes.length, 3, 'Completed sequence must not restart on a server refresh');
assert.equal(refreshCount, 1);
console.log('Completed automatic refresh does not restart when the page refreshes.');
