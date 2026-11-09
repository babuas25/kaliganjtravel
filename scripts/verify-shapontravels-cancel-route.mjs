import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

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
class ShapontravelsReadError extends Error {}
class ShapontravelsWriteError extends Error {
  constructor(kind, code, status, _request, _id, _reference, operation) {
    super(code);
    Object.assign(this, { kind, code, status, operation });
  }
}
const cancellation = compile('lib/shapontravels/cancel.ts', {
  './client': { ShapontravelsReadError, ShapontravelsWriteError }, './current-status-projection': projection,
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
const recovery = compile('lib/shapontravels/cancellation-recovery.ts', { './booking-status': status });
const savedRead = (booking, status, canCancel = false) => {
  const currentStatus = { status, reviewRequired: false };
  const publicReceipt = { status, pnr: booking.pnr, paymentState: 'unpaid', issuedAt: null,
    pendingReview: false, actions: { canCancel, canIssue: false }, tickets: [] };
  return { httpStatus: 200, supplierPublicRef: booking.supplier_public_ref, body: {
    currentStatus, publicReceipt, savedBooking: { schemaVersion: 1, reference: booking.supplier_public_ref,
      bookingId: bookingCodeRef, bookingCodeRef, uniqueTransID: refs.uniqueTransId,
      itemCodeRef: refs.itemCodeRef, priceCodeRef: refs.priceCodeRef, pnr: booking.pnr,
      bookingRefNumber: booking.booking_ref_number, bookingStatus: 'Created',
      status, reviewRequired: false, requiresReconciliation: false, paymentState: 'unpaid',
      payment: { state: 'released', required: false, operationId: null },
      issuedAt: null, currentStatus, publicReceipt, passengerInfoes: [{}], passengerCount: 1,
      segments: [], ticketInfoes: [], missingFields: [],
    },
  } };
};
const baseRead = savedRead(baseBooking, 'on-hold', true);

async function run(options = {}) {
  const events = [];
  const booking = { ...baseBooking, ...options.booking };
  const session = options.signedOut ? null : { clerkId: 'customer-1', role: 'customer', ...options.session };
  const read = options.read ?? savedRead(booking, booking.lifecycle_status, true);
  let started = false;
  let httpStatus = null;
  let readCount = 0;
  const hooks = {
    beforeRequest: async () => { events.push('before-request'); started = true; },
    onResponse: async result => { events.push('response'); httpStatus = result.httpStatus; },
    boundarySnapshot: () => ({ supplierCallStarted: started, supplierResponseRecorded: httpStatus !== null, httpStatus }),
  };
  const route = compile('app/api/flights/booking/cancel/route.ts', {
    zod: { z }, 'node:crypto': { randomUUID },
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
    '@/lib/db/shapontravels-cancellation': {
      advanceShaponCancellationRetry: async (...args) => {
        events.push(args[5] == null ? 'retry-claim' : 'retry-response'); return true;
      },
      readShaponCancellationPublicRef: async () => booking.supplier_public_ref,
      readBookingCancellationReplay: async () => options.replay ?? null,
      finalizeShaponPlatformCancellation: async (_id, _actor, _request, _operation, closure) => {
        assert.equal(closure.savedBookingId, bookingCodeRef);
        assert.equal(closure.supplierPublicRef, booking.supplier_public_ref);
        assert.equal(closure.walletMutation, false);
        events.push('finalize'); return options.finalize ?? { ok: true };
      },
      restoreShapontravelsCancellationNotSent: async () => { events.push('restore'); return { ok: true }; },
    },
    '@/lib/shapontravels/cancellation-recovery': recovery,
    '@/lib/shapontravels/current-status-projection': projection,
    '@/lib/shapontravels/current-status-store': { recordShapontravelsCurrentStatus: async record => {
      events.push(`save-${record.status.currentStatus.status}`);
      return { projectionUpdated: true };
    } },
    '@/lib/db/security': { recordSecurityAuditEvent: async () => {
      events.push('audit'); if (options.auditFailure) throw new Error('fixture audit unavailable');
    } },
    '@/lib/db/triplover-status-confirmation': { hasVerifiedTriploverIssuedStatus: async () => false },
    '@/lib/email/booking-status-delivery': { dispatchBookingStatusEmails: async () => {
      events.push('email'); if (options.emailFailure) throw new Error('fixture delivery unavailable');
    } },
    '@/lib/db/wallet': {
      finalizeBookingCancellation: async () => {
        events.push('wallet-finalize'); return options.finalize ?? { ok: true };
      },
      markReservationForReconciliation: async () => { events.push('reconcile'); },
    },
    '@/lib/rate-limit': { checkActionLimit: async () => ({ ok: true }) },
    '@/lib/shapontravels/cancel': {
      ...cancellation,
      cancelShapontravelsBooking: async (input, key, tracker) => {
        assert.equal(key, 'durable-key'); assert.equal(input.pnr, booking.pnr ?? '');
        assert.equal(input.bookingCodeRef, bookingCodeRef);
        if (!options.notSent) await tracker.beforeRequest();
        events.push(options.notSent ? 'unsent' : 'shapon-cancel');
        if (options.failure) throw new Error('fixture cancellation failure');
        if (options.refusal) {
          await tracker.onResponse({ httpStatus: 409 });
          throw new ShapontravelsWriteError('protocol', 'TICKET_ISSUE_ALREADY_RESERVED', 409, null, null, null, 'Cancel');
        }
        await tracker.onResponse({ httpStatus: 200 });
        return { isCancel: true, uniqueTransId: refs.uniqueTransId, netRefund: null, refundPenalty: null };
      },
    },
    '@/lib/shapontravels/client': {
      ShapontravelsReadError, ShapontravelsWriteError,
      isShapontravelsConfigured: () => !options.unconfigured,
      shapontravelsReadBooking: async () => {
        events.push('read'); if (options.readFailure) throw new Error('fixture read unavailable');
        if (++readCount > 1) return options.savedNotClosed ? read : savedRead(booking, 'cancelled');
        return read;
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
  const response = await route[options.method ?? 'POST']({ json: async () => ({
    bookingReference: baseBooking.public_ref, requestId: '66666666-6666-4666-8666-666666666666',
    ...(options.retryOriginal ? { retryOriginal: true } : {}),
  }) });
  return { response, events };
}

for (const lifecycle_status of ['on-hold', 'unconfirmed', 'expired']) {
  const { response, events } = await run({ booking: {
    status: lifecycle_status === 'pending' ? 'pending' : 'on-hold', lifecycle_status,
  } });
  assert.equal(response.httpStatus, 200, lifecycle_status);
  assert.equal(events.filter(event => event === 'shapon-cancel').length, 1);
  assert.ok(events.indexOf('read') < events.indexOf('claim'));
  assert.ok(events.indexOf('claim') < events.indexOf('before-request'));
  assert.ok(events.indexOf('response') < events.lastIndexOf('read'));
  assert.ok(events.lastIndexOf('read') < events.indexOf('finalize'));
  assert.ok(!events.includes('wallet-finalize'));
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
    savedBooking: { ...baseRead.body.savedBooking, bookingId: '77777777-7777-4777-8777-777777777777' } } } },
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
assert.equal(notSent.response.code, 'BOOKING_CANCEL_NOT_SENT');
assert.ok(notSent.events.includes('restore') && !notSent.events.includes('finalize'));
const walletFailure = await run({ finalize: { ok: false } });
assert.equal(walletFailure.response.code, 'CANCEL_OUTCOME_UNKNOWN');
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
const noLocator = await run({ booking: { pnr: null, booking_ref_number: null, lifecycle_status: 'unconfirmed' } });
assert.equal(noLocator.response.httpStatus, 200);
const unverifiedClosure = await run({ savedNotClosed: true });
assert.equal(unverifiedClosure.response.code, 'CANCEL_OUTCOME_UNKNOWN');
assert.ok(!unverifiedClosure.events.includes('finalize'));
const refusal = await run({ refusal: true });
assert.equal(refusal.response.code, 'SHAPON_CANCEL_REFUSED');
assert.ok(refusal.events.includes('restore') && !refusal.events.includes('uncertainty'));
const pendingReplay = { operationId: 'operation-1', state: 'needs_reconciliation', retryAvailable: true };
const resultCheck = await run({ method: 'PATCH', replay: pendingReplay });
assert.equal(resultCheck.response.data.status, 'retry-available');
assert.ok(!resultCheck.events.includes('shapon-cancel'));
const requestNeverReachedApp = await run({ method: 'PATCH' });
assert.equal(requestNeverReachedApp.response.data.status, 'retry-available');
assert.ok(!requestNeverReachedApp.events.includes('shapon-cancel'));
const closedExternally = await run({ read: savedRead(baseBooking, 'cancelled') });
assert.equal(closedExternally.response.code, 'SUPPLIER_CANCELLATION_UNAVAILABLE');
assert.ok(closedExternally.events.includes('save-cancelled') && !closedExternally.events.includes('claim'));
const explicitlyDisabled = await run({ read: savedRead(baseBooking, 'on-hold', false) });
assert.equal(explicitlyDisabled.response.code, 'SUPPLIER_CANCELLATION_UNAVAILABLE');
assert.ok(explicitlyDisabled.events.includes('save-on-hold') && !explicitlyDisabled.events.includes('claim'));
const retryRefusal = await run({ replay: pendingReplay, retryOriginal: true, refusal: true });
assert.equal(retryRefusal.response.code, 'CANCEL_OUTCOME_UNKNOWN');
assert.ok(retryRefusal.events.includes('retry-claim') && retryRefusal.events.includes('retry-response'));
assert.ok(!retryRefusal.events.includes('restore'));
const retry = await run({ replay: pendingReplay, retryOriginal: true });
assert.equal(retry.response.httpStatus, 200);
assert.ok(retry.events.includes('finalize') && !retry.events.includes('wallet-finalize'));
console.log('Shapon cancellation route: exact saved status, no wallet finalization, locatorless cancellation, recorded refusal, explicit same-key retry and Triplover isolation passed.');
