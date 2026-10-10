import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';

function compile(file, imports) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new vm.Script(source, { filename: file }).runInNewContext({
    module, exports: module.exports,
    require(name) {
      if (name === 'server-only') return {};
      assert.ok(name in imports, `Unexpected import ${name}`);
      return imports[name];
    }, console: { error() {} },
  });
  return module.exports;
}

const status = compile('lib/shapontravels/booking-status.ts', {});
const projection = compile('lib/shapontravels/current-status-projection.ts', {
  './booking-status': status,
  '@/lib/flights/booking-status': compile('lib/flights/booking-status.ts', {}),
});
const permissions = compile('lib/wallet/permissions.ts', {
  '@/lib/impexp/booking-source': { isExternalBookingSource: () => false },
  '@/lib/shapontravels/current-status-projection': projection,
});
const cancellation = compile('lib/shapontravels/cancel.ts', {
  './client': {}, './booking-status': status,
});
const refs = {
  uniqueTransId: '11111111-1111-4111-8111-111111111111',
  itemCodeRef: '22222222-2222-4222-8222-222222222222',
  priceCodeRef: '33333333-3333-4333-8333-333333333333',
};
const bookingCodeRef = '44444444-4444-4444-8444-444444444444';
const baseBooking = {
  id: '55555555-5555-4555-8555-555555555555', public_ref: 'KTT261008000001',
  supplier: 'shapontravels', supplier_account: 'shapontravels', import_source: null,
  supplier_public_ref: 'STR261008000001',
  booking_owner_type: 'user', booking_owner_key: 'customer-1',
  status: 'on-hold', lifecycle_status: 'on-hold', direct_ticketing: false,
  issued_at: null, ticket_code_ref: null, ticket_numbers: [], captured_amount: 0,
  operation_kind: null, operation_request_id: null, operation_started_at: null,
  payment_state: 'unpaid', pnr: 'ABC123', booking_ref_number: 'ABC123',
  booking_code_ref: bookingCodeRef, supplier_refs: refs,
};
const baseRead = {
  httpStatus: 200, supplierPublicRef: 'STR261008000001',
  body: {
    item1: { uniqueTransID: refs.uniqueTransId, itemCodeRef: refs.itemCodeRef,
      priceCodeRef: refs.priceCodeRef, bookingCodeRef, pnr: 'ABC123',
      bookingRefNumber: 'ABC123', bookingStatus: 'Created' },
    item2: { isSuccess: true },
    currentStatus: { status: 'on-hold', reviewRequired: false },
    publicReceipt: { status: 'on-hold', pendingReview: false,
      actions: { canCancel: true, canIssue: false }, tickets: [] },
  },
};

async function run(options = {}) {
  const events = [];
  const booking = { ...baseBooking, ...options.booking };
  const session = options.signedOut ? null : { clerkId: 'customer-1', role: 'customer', ...options.session };
  const read = options.read ?? baseRead;
  let started = false;
  const hooks = {
    beforeRequest: async () => { events.push('before-request'); started = true; },
    onResponse: async () => events.push('response'),
    boundarySnapshot: () => ({ supplierCallStarted: started }),
  };
  const route = compile('app/api/flights/booking/cancel/route.ts', {
    zod: { z },
    '@/lib/dashboard/bookings': { bookingScopeFor: () => ({}) },
    '@/lib/dashboard/session': { getDashboardSession: async () => session },
    '@/lib/booking-lifecycle/operation-request': {
      createOperationRequestIdentity: () => ({ requestKey: 'durable-key', requestPayloadHash: 'bound-hash' }),
    },
    '@/lib/booking-lifecycle/supplier-uncertainty': {
      classifySupplierWriteFailure: () => ({ failureClass: options.notSent ? 'not-sent' : 'uncertain',
        reasonCode: options.notSent ? 'prewrite_authentication_failure' : 'network_after_write',
        supplierCallStarted: started }),
    },
    '@/lib/booking-lifecycle/supplier-write-hooks': { bookingOperationSupplierWriteHooks: () => hooks },
    '@/lib/db/booking-operations': {
      recordSupplierWriteUncertainty: async () => { events.push('uncertainty'); return { ok: true }; },
    },
    '@/lib/db/flight-bookings': {
      readBookingByPublicRef: async () => booking,
      beginBookingCancellation: async () => {
        events.push('claim'); return options.claim ?? { ok: true, operationId: 'operation-1' };
      },
      restoreBookingCancellation: async () => { events.push('restore'); return { ok: true }; },
      restoreUnsentShaponCancellation: async () => { events.push('restore'); return { ok: true }; },
      syncAirTicketingDetails: async () => { events.push('triplover-sync'); },
      syncPnrDetails: async () => { events.push('triplover-sync'); },
    },
    '@/lib/db/security': { recordSecurityAuditEvent: async () => {
      events.push('audit'); if (options.auditFailure) throw new Error('fixture audit unavailable');
    } },
    '@/lib/email/booking-status-delivery': { dispatchBookingStatusEmails: async () => {
      events.push('email'); if (options.emailFailure) throw new Error('fixture delivery unavailable');
    } },
    '@/lib/db/wallet': {
      finalizeBookingCancellation: async () => {
        events.push('finalize'); return options.finalize ?? { ok: true };
      },
      markReservationForReconciliation: async () => { events.push('reconcile'); },
    },
    '@/lib/rate-limit': { checkActionLimit: async () => ({ ok: true }) },
    '@/lib/shapontravels/cancel': {
      ...cancellation,
      cancelShapontravelsBooking: async (input, key, tracker) => {
        assert.equal(key, 'durable-key'); assert.equal(input.pnr, booking.pnr);
        assert.equal(input.bookingCodeRef, bookingCodeRef);
        if (!options.notSent) await tracker.beforeRequest();
        events.push(options.notSent ? 'unsent' : 'shapon-cancel');
        if (options.failure) throw new Error('fixture cancellation failure');
        await tracker.onResponse({ httpStatus: 200 });
        return { isCancel: true, uniqueTransId: refs.uniqueTransId, netRefund: null, refundPenalty: null };
      },
    },
    '@/lib/shapontravels/client': {
      isShapontravelsConfigured: () => !options.unconfigured,
      shapontravelsReadBooking: async () => {
        events.push('read'); if (options.readFailure) throw new Error('fixture read unavailable'); return read;
      },
    },
    '@/lib/triplover/cancel': { cancelBooking: async () => {
      events.push('triplover-cancel'); return { isCancel: true };
    } },
    '@/lib/triplover/air-ticketing-details': { readAirTicketingDetails: async () => {
      events.push('triplover-read'); throw new Error('Wrong supplier read');
    } },
    '@/lib/triplover/config': { isTriploverSupplier: value => value === 'triplover' },
    '@/lib/triplover/pnr': {
      pnrLookupLocators: input => input.pnr ? { pnr: input.pnr, bookingRefNumber: input.bookingRefNumber } : null,
      readPnr: async () => { events.push('triplover-read'); throw new Error('Wrong supplier read'); },
    },
    '@/lib/wallet/http': {
      walletFail: (httpStatus, code) => ({ httpStatus, code }),
      walletOk: data => ({ httpStatus: 200, data }),
    },
    '@/lib/wallet/permissions': permissions,
  });
  const response = await route.POST({ json: async () => ({
    bookingReference: baseBooking.public_ref, requestId: '66666666-6666-4666-8666-666666666666',
  }) });
  return { response, events };
}

for (const lifecycle_status of ['on-hold', 'pending', 'unconfirmed', 'expired']) {
  const { response, events } = await run({ booking: {
    status: lifecycle_status === 'pending' ? 'pending' : 'on-hold', lifecycle_status,
  } });
  assert.equal(response.httpStatus, 200, lifecycle_status);
  assert.equal(events.filter(event => event === 'shapon-cancel').length, 1);
  assert.ok(events.indexOf('read') < events.indexOf('claim'));
  assert.ok(events.indexOf('claim') < events.indexOf('before-request'));
  assert.ok(events.indexOf('response') < events.indexOf('finalize'));
  assert.ok(!events.some(event => event.startsWith('triplover')));
}
for (const booking of [
  { status: 'confirmed', lifecycle_status: 'confirmed' },
  { status: 'cancelled', lifecycle_status: 'cancelled' },
  { status: 'in-progress', lifecycle_status: 'in-progress' },
  { issued_at: '2026-10-08T00:00:00Z' }, { direct_ticketing: true },
  { ticket_numbers: ['1234567890123'] }, { operation_kind: 'ticketing' },
  { captured_amount: 500 }, { payment_state: 'reconciliation' },
  { booking_owner_key: 'customer-2' }, { booking_code_ref: null },
  { supplier_account: 'triplover' }, { import_source: 'IMP_EXP' },
]) {
  const { response, events } = await run({ booking });
  assert.notEqual(response.httpStatus, 200, JSON.stringify(booking));
  assert.ok(!events.includes('claim') && !events.includes('shapon-cancel'));
}
for (const options of [
  { signedOut: true }, { unconfigured: true }, { readFailure: true },
  { read: { ...baseRead, httpStatus: 202 } },
  { read: { ...baseRead, body: { ...baseRead.body,
    publicReceipt: { ...baseRead.body.publicReceipt, actions: { canCancel: false, canIssue: true } } } } },
  { read: { ...baseRead, body: { ...baseRead.body,
    item1: { ...baseRead.body.item1, bookingCodeRef: '77777777-7777-4777-8777-777777777777' } } } },
]) {
  const { response, events } = await run(options);
  assert.notEqual(response.httpStatus, 200);
  assert.ok(!events.includes('claim') && !events.includes('shapon-cancel'));
}
const replay = await run({ claim: { ok: true, replay: true, operationId: 'operation-1' } });
assert.equal(replay.response.httpStatus, 200);
assert.ok(!replay.events.includes('shapon-cancel') && !replay.events.includes('finalize'));
const racingIssue = await run({ claim: { ok: false, code: 'BOOKING_NOT_CANCELLABLE' } });
assert.equal(racingIssue.response.httpStatus, 409);
assert.ok(!racingIssue.events.includes('shapon-cancel'));
const unknown = await run({ failure: true });
assert.equal(unknown.response.code, 'CANCEL_OUTCOME_UNKNOWN');
assert.ok(unknown.events.includes('uncertainty'));
assert.ok(!unknown.events.includes('finalize') && !unknown.events.includes('restore'));
assert.equal(unknown.events.filter(event => event === 'shapon-cancel').length, 1);
const notSent = await run({ failure: true, notSent: true });
assert.equal(notSent.response.code, 'BOOKING_CANCEL_FAILED');
assert.ok(notSent.events.includes('restore') && !notSent.events.includes('finalize'));
const walletFailure = await run({ finalize: { ok: false } });
assert.equal(walletFailure.response.code, 'CANCEL_RECONCILIATION_REQUIRED');
assert.equal(walletFailure.events.filter(event => event === 'shapon-cancel').length, 1);
assert.ok(!walletFailure.events.includes('restore'));
for (const options of [{ auditFailure: true }, { emailFailure: true }]) {
  const settled = await run(options);
  assert.equal(settled.response.httpStatus, 200, 'Ancillary failure cannot reopen a settled cancellation');
  assert.ok(!settled.events.includes('uncertainty') && !settled.events.includes('reconcile'));
}
const mismatchedReference = await run({ read: { ...baseRead, supplierPublicRef: 'STR261008000002' } });
assert.equal(mismatchedReference.response.code, 'SUPPLIER_CANCELLATION_UNAVAILABLE');
assert.ok(!mismatchedReference.events.includes('claim'));
const triplover = await run({ booking: { supplier: 'triplover', supplier_account: 'triplover' } });
assert.equal(triplover.response.httpStatus, 200);
assert.ok(triplover.events.includes('triplover-cancel') && !triplover.events.includes('read'));
console.log('Shapon cancellation route: four statuses, fresh supplier capability, atomic claim, no replay on uncertainty, ownership, and Triplover isolation verified.');
