import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';

function compile(file, imports, globals = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  new vm.Script(compiled.outputText, { filename: file }).runInNewContext({
    module, exports: module.exports,
    require(name) {
      if (name === 'server-only') return {};
      assert.ok(name in imports, `Unexpected import ${name}; status checks must not import write services`);
      return imports[name];
    },
    Date, console: { error() {} }, ...globals,
  });
  return module.exports;
}

const supplierRefs = {
  uniqueTransId: '11111111-1111-4111-8111-111111111111',
  itemCodeRef: '22222222-2222-4222-8222-222222222222',
  priceCodeRef: '33333333-3333-4333-8333-333333333333',
};
const bookingCodeRef = '44444444-4444-4444-8444-444444444444';
const otherId = '55555555-5555-4555-8555-555555555555';
const ticketCodeRef = '66666666-6666-4666-8666-666666666666';
const supplierPublicRef = 'STR123456789012';
const session = { clerkId: 'staff-fixture', role: 'staff_account' };
const booking = {
  id: '77777777-7777-4777-8777-777777777777', public_ref: 'KTT123456789',
  supplier: 'shapontravels', supplier_account: 'shapontravels', import_source: null,
  supplier_refs: supplierRefs, booking_code_ref: bookingCodeRef,
  pnr: 'ABC123', booking_ref_number: 'ABC123', passenger_counts: { ADT: 1 },
  status: 'in-progress', operation_reason: 'cancellation', payment_state: 'unpaid',
};
const cancellationReceipt = {
  item1: { uniqueTransID: supplierRefs.uniqueTransId, itemCodeRef: supplierRefs.itemCodeRef,
    priceCodeRef: supplierRefs.priceCodeRef, bookingCodeRef, isCancel: true },
  item2: { isSuccess: true },
};
const ticketReceipt = {
  item1: { uniqueTransID: supplierRefs.uniqueTransId, itemCodeRef: supplierRefs.itemCodeRef,
    priceCodeRef: supplierRefs.priceCodeRef, bookingCodeRef, pnr: booking.pnr, ticketCodeRef,
    ticketInfoes: [{ ticketNumbers: ['1234567890123'] }] },
  item2: { isSuccess: true },
};
const bookingRead = {
  httpStatus: 200, supplierPublicRef,
  body: {
    item1: { ...cancellationReceipt.item1, pnr: booking.pnr, bookingRefNumber: booking.pnr,
      bookingStatus: 'Created', ticketingTimeLimit: null },
    item2: { isSuccess: true },
    currentStatus: { status: 'in-progress', reviewRequired: true },
    publicReceipt: { status: 'in-progress', pendingReview: true,
      actions: { canIssue: false, canCancel: false }, tickets: [] },
  },
};
const clone = value => JSON.parse(JSON.stringify(value));
const bookingStatus = compile('lib/shapontravels/booking-status.ts', {});
const ticketPayload = compile('lib/triplover/ticket-payload.ts', {});

function only(module, name) {
  return new Proxy(module, {
    get(target, key) {
      assert.ok(key in target, `Forbidden ${name}.${String(key)}: status must not invoke a write or finalizer`);
      return target[key];
    },
  });
}

async function invoke({ readStatus = 200, receipt = cancellationReceipt, readError = false,
  reason = 'cancellation', bookingOverride = {}, sessionOverride = session,
  bookReadOverride = bookingRead } = {}) {
  const saved = { ...booking, operation_reason: reason, ...bookingOverride };
  const events = [];
  let cancellations = 0, tickets = 0, mutations = 0, evidenceStores = 0;
  const forbiddenWrite = async () => { mutations++; throw new Error('Supplier mutation is forbidden in status refresh'); };
  const client = only({
    ShapontravelsWriteError: class extends Error {},
    shapontravelsCancelRequest: forbiddenWrite,
    shapontravelsIssueRequest: forbiddenWrite,
    async shapontravelsReadBooking(lookup) {
      assert.deepEqual(clone(lookup), { bookingId: bookingCodeRef });
      events.push('booking'); return clone(bookReadOverride);
    },
    async shapontravelsReadCancellation(id) {
      cancellations++;
      assert.equal(id, bookingCodeRef);
      events.push('cancellation');
      if (readError) throw new Error('Synthetic cancellation read outage');
      return { httpStatus: readStatus, body: clone(receipt) };
    },
    async shapontravelsReadTicket(id) {
      tickets++;
      assert.equal(id, bookingCodeRef);
      events.push('ticket');
      return { httpStatus: 200, body: clone(ticketReceipt) };
    },
  }, 'supplier');
  const adapter = compile('lib/shapontravels/cancel.ts', {
    './client': client, './booking-status': bookingStatus,
  });
  const ticketAdapter = compile('lib/shapontravels/ticket.ts', {
    './client': client, '@/lib/triplover/ticket-payload': ticketPayload,
  });
  const externalConfirmation = compile('lib/shapontravels/external-ticket-confirmation.ts', {
    './booking-status': bookingStatus, './ticket': ticketAdapter,
  });
  const route = compile('app/api/flights/booking/shapon-status/route.ts', {
    zod: { z },
    '@/lib/dashboard/session': { getDashboardSession: async () => sessionOverride },
    '@/lib/dashboard/booking-lifecycle': { canRefreshBookingSupplierDetails: role => role === 'staff_account' },
    '@/lib/dashboard/bookings': {
      bookingScopeFor(value) { assert.equal(value, sessionOverride); return { userId: session.clerkId }; },
    },
    '@/lib/db/flight-bookings': only({
      async readBookingByPublicRef(reference, scope) {
        assert.equal(reference, booking.public_ref);
        assert.deepEqual(clone(scope), { userId: session.clerkId });
        return saved;
      },
    }, 'flight-bookings'),
    '@/lib/supabase/server': {
      supabaseAdmin: () => only({
        from(table) {
          assert.equal(table, 'flight_bookings');
          return only({
            select(fields) {
              assert.equal(fields, 'supplier_public_ref');
              return only({
                eq(field, id) {
                  assert.equal(field, 'id'); assert.equal(id, saved.id);
                  return only({ single: async () => ({ data: { supplier_public_ref: supplierPublicRef }, error: null }) }, 'supplier-reference query');
                },
              }, 'supplier-reference filter');
            },
          }, 'supplier-reference selection');
        },
      }, 'database'),
    },
    '@/lib/shapontravels/client': client,
    '@/lib/shapontravels/booking-status': bookingStatus,
    '@/lib/shapontravels/external-ticket-confirmation': externalConfirmation,
    '@/lib/shapontravels/current-status-store': {
      async recordShapontravelsCurrentStatus({ bookingId, requestStartedAt, expected, status }) {
        evidenceStores++; events.push('store');
        assert.equal(bookingId, booking.id);
        assert.equal(expected.supplierPublicRef, supplierPublicRef);
        assert.equal(expected.bookingCodeRef, bookingCodeRef);
        assert.equal(status.result, 'verified');
        assert.ok(Number.isFinite(Date.parse(requestStartedAt)));
        return { saved: true, reason: 'synthetic-display-evidence' };
      },
    },
    '@/lib/shapontravels/ticket': ticketAdapter,
    '@/lib/shapontravels/cancel': adapter,
    '@/lib/wallet/http': {
      walletOk: data => ({ status: 200, data }),
      walletFail: (status, code, message) => ({ status, code, message }),
    },
  });
  const result = await route.POST({ json: async () => ({ bookingReference: booking.public_ref }) });
  assert.equal(mutations, 0, 'Staff status refresh must not dispatch Cancel or Issue');
  return { result, cancellations, tickets, evidenceStores, events };
}

for (const reason of ['cancellation', 'cancellation_reconciliation']) {
  const run = await invoke({ reason });
  assert.equal(run.result.status, 200);
  assert.deepEqual(clone(run.result.data.supplierCancellation), { result: 'verified' });
  assert.equal(run.result.data.supplierTicket, null);
  assert.equal(run.cancellations, 1); assert.equal(run.tickets, 0); assert.equal(run.evidenceStores, 1);
  assert.deepEqual(run.events, ['booking', 'store', 'cancellation']);
}
for (const [readStatus, expected] of [[202, 'pending'], [404, 'not_found']]) {
  const run = await invoke({ readStatus, receipt: { bookingId: bookingCodeRef, state: 'outcome_unknown' } });
  assert.equal(run.result.status, 200);
  assert.equal(run.result.data.supplierCancellation.result, expected);
  assert.equal(run.cancellations, 1); assert.equal(run.tickets, 0);
}
for (const receipt of [
  ...['uniqueTransID', 'itemCodeRef', 'priceCodeRef', 'bookingCodeRef'].map(field => ({
    ...cancellationReceipt, item1: { ...cancellationReceipt.item1, [field]: otherId },
  })),
  { ...cancellationReceipt, item1: { ...cancellationReceipt.item1, isCancel: false } },
  { ...cancellationReceipt, item2: { isSuccess: false } },
]) {
  const run = await invoke({ receipt });
  assert.equal(run.result.status, 200);
  assert.equal(run.result.data.supplierCancellation.result, 'unverified');
  assert.equal(run.cancellations, 1); assert.equal(run.tickets, 0);
}
const unavailable = await invoke({ readError: true });
assert.equal(unavailable.result.status, 200);
assert.equal(unavailable.result.data.supplierCancellation.result, 'unavailable');
assert.equal(unavailable.tickets, 0, 'Cancellation read outages must not fall back to ticket status');

const identityAbsent = await invoke({ bookingOverride: { booking_ref_number: null } });
assert.equal(identityAbsent.result.data.supplierCancellation.result, 'unverified');
assert.equal(identityAbsent.cancellations, 0); assert.equal(identityAbsent.tickets, 0);

const ticketRun = await invoke({ reason: 'ticketing' });
assert.equal(ticketRun.result.status, 200);
assert.equal(ticketRun.result.data.supplierCancellation, null);
assert.deepEqual(clone(ticketRun.result.data.supplierTicket), { result: 'verified', ticketCount: 1, ticketCodeRef });
assert.equal(ticketRun.cancellations, 0); assert.equal(ticketRun.tickets, 1);
assert.deepEqual(ticketRun.events, ['booking', 'store', 'ticket']);

for (const [sessionOverride, expectedStatus] of [[null, 401], [{ role: 'b2b', clerkId: 'agency-user' }, 403]]) {
  const run = await invoke({ sessionOverride });
  assert.equal(run.result.status, expectedStatus);
  assert.deepEqual(run.events, []);
}
const mismatchRead = clone(bookingRead);
mismatchRead.body.item1.uniqueTransID = otherId;
const mismatch = await invoke({ bookReadOverride: mismatchRead });
assert.equal(mismatch.result.status, 409);
assert.equal(mismatch.result.code, 'SUPPLIER_IDENTITY_UNVERIFIED');
assert.equal(mismatch.evidenceStores, 0); assert.equal(mismatch.cancellations, 0); assert.equal(mismatch.tickets, 0);

console.log('Shapontravels staff cancellation status uses only saved reads, verifies exact receipts, and preserves ticket operation routing');
