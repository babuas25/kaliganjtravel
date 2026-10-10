import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
    module, exports: module.exports, Date, Error, console,
    fetch: async () => { throw new Error('External transport is forbidden'); },
    require(name) {
      if (name === 'server-only') return {};
      assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`);
      return imports[name];
    },
  });
  return module.exports;
}

const refs = {
  uniqueTransId: '11111111-1111-4111-8111-111111111111',
  itemCodeRef: '22222222-2222-4222-8222-222222222222',
  priceCodeRef: '33333333-3333-4333-8333-333333333333',
  bookingCodeRef: '44444444-4444-4444-8444-444444444444',
  pnr: 'ABC123', bookingRefNumber: 'ABC123',
};
const bookingId = '55555555-5555-4555-8555-555555555555';
const nonce = '77777777-7777-4777-8777-777777777777';
const itinerary = { carrierCode: '6E', legs: [{ segments: [{ airlineCode: '6E' }] }] };
const receipt = {
  item1: { uniqueTransID: refs.uniqueTransId, itemCodeRef: refs.itemCodeRef,
    priceCodeRef: refs.priceCodeRef, bookingCodeRef: refs.bookingCodeRef, pnr: refs.pnr,
    ticketCodeRef: '66666666-6666-4666-8666-666666666666', airlinesPNR: ['XY1234'],
    ticketInfoes: [0, 1].map(() => ({ ticketNumbers: ['XY1234'], ticketNumberSource: 'airline_pnr' })) },
  item2: { isSuccess: true },
  publicReceipt: { status: 'confirmed', pendingReview: false, pnr: refs.pnr },
};
const operation = compile('lib/booking-lifecycle/operation-request.ts', { 'node:crypto': { createHash } });
const storedReferences = compile('lib/booking-lifecycle/ticketing-flow.ts', {});
const payload = compile('lib/triplover/ticket-payload.ts', {});
const references = fs.existsSync('lib/references.ts') ? compile('lib/references.ts', {}) : {};
class WriteError extends Error {
  constructor(kind, code, status) {
    super(code); this.kind = kind; this.code = code; this.status = status; this.operation = 'NewTicket';
  }
}

async function run(options = {}) {
  const events = [];
  let captured = null;
  const booking = {
    id: bookingId, public_ref: 'KTT261009000001', currency: 'BDT',
    supplier: 'shapontravels', supplier_account: 'shapontravels', import_source: null,
    status: 'on-hold', payment_state: 'unpaid', direct_ticketing: false,
    pnr: refs.pnr, booking_ref_number: refs.bookingRefNumber,
    booking_code_ref: refs.bookingCodeRef, supplier_refs: {
      uniqueTransId: refs.uniqueTransId, itemCodeRef: refs.itemCodeRef, priceCodeRef: refs.priceCodeRef,
    }, passenger_counts: { ADT: 2 }, itinerary: options.itinerary ?? itinerary,
  };
  const expectedOperation = operation.createOperationRequestIdentity({
    clientRequestNonce: nonce, action: 'ticketing', subjectType: 'booking', subjectId: booking.id,
    payload: { ...refs, expectedPassengerCount: 2, supplier: 'shapontravels' },
  });
  const hooks = { boundarySnapshot: () => ({ supplierCallStarted: events.includes('issue') }) };
  const client = {
    ShapontravelsWriteError: WriteError, isShapontravelsConfigured: () => true,
    shapontravelsIssueRequest: async (body, key) => {
      events.push('issue');
      assert.equal(key, expectedOperation.requestKey);
      assert.deepEqual(JSON.parse(JSON.stringify(body)), {
        PNR: refs.pnr, BookingRefNumber: refs.pnr, UniqueTransID: refs.uniqueTransId,
        ItemCodeRef: refs.itemCodeRef, PriceCodeRef: refs.priceCodeRef, BookingCodeRef: refs.bookingCodeRef,
      });
      return options.receipt ?? receipt;
    },
  };
  const ticket = compile('lib/shapontravels/ticket.ts', {
    './client': client, '@/lib/triplover/ticket-payload': payload,
  });
  const forbidden = async () => { throw new Error('Unexpected operation'); };
  const route = compile('app/api/flights/booking/issue/route.ts', {
    '@/lib/references': references,
    zod: { z },
    '@/lib/currency': { isBookingCurrency: value => value === 'BDT' },
    '@/lib/dashboard/bookings': { bookingScopeFor: () => ({}) },
    '@/lib/dashboard/session': { getDashboardSession: async () => ({ clerkId: 'synthetic-owner', role: 'customer' }) },
    '@/lib/booking-lifecycle/operation-request': operation,
    '@/lib/booking-lifecycle/ticketing-flow': storedReferences,
    '@/lib/booking-lifecycle/supplier-uncertainty': {
      classifySupplierWriteFailure: () => ({ failureClass: 'uncertain', reasonCode: 'incomplete_response' }),
    },
    '@/lib/booking-lifecycle/supplier-write-hooks': { bookingOperationSupplierWriteHooks: () => hooks },
    '@/lib/booking-lifecycle/post-ticketing-reconciliation.server': { reconcilePostTicketingRace: forbidden },
    '@/lib/db/booking-operations': {
      recordSupplierWriteUncertainty: async () => { events.push('reconcile'); return { ok: true }; },
    },
    '@/lib/db/booking-local-time-limit': { readBookingLocalTimeLimitContext: forbidden },
    '@/lib/db/flight-bookings': {
      readBookingByPublicRef: async () => booking,
      publicBookingWithHeaderContact: async value => value,
      syncAirTicketingDetails: forbidden,
    },
    '@/lib/db/security': { recordSecurityAuditEvent: async () => {} },
    '@/lib/email/booking-status-delivery': { dispatchBookingStatusEmails: async () => {} },
    '@/lib/db/wallet': {
      beginBookingIssue: async (_id, _session, identity) => {
        events.push('claim');
        assert.deepEqual(JSON.parse(JSON.stringify(identity)), JSON.parse(JSON.stringify(expectedOperation)),
          'Existing durable request identity is unchanged by the added saved itinerary context');
        return { ok: true, operationId: bookingId, replay: options.replay ?? false };
      },
      finalizeBookingIssue: async (_id, _session, _request, _operation, outcome) => {
        events.push('capture'); captured = JSON.parse(JSON.stringify(outcome)); return { ok: true };
      },
      beginLegacyManualIssue: forbidden, ensureWalletForOwner: forbidden,
      failBookingIssue: forbidden, finalizeManualIssue: forbidden,
      markReservationForReconciliation: forbidden,
    },
    '@/lib/rate-limit': { checkActionLimit: async () => ({ ok: true }) },
    '@/lib/db/supplier-controls': { getSupplierOperationalControls: async () => ({ ticketingEnabled: true }) },
    '@/lib/triplover/client': { TriploverError: class extends Error {} },
    '@/lib/triplover/issued-ticket-enrichment': { enrichIssuedTicket: forbidden },
    '@/lib/triplover/config': { isTriploverSupplier: () => false },
    '@/lib/triplover/ticket': { issueTicket: forbidden },
    '@/lib/shapontravels/ticket': ticket,
    '@/lib/shapontravels/client': client,
    '@/lib/wallet/http': {
      walletOk: data => ({ status: 200, data }),
      walletFail: (status, code) => ({ status, code }), walletOperationResponse: forbidden,
    },
    '@/lib/wallet/permissions': { canIssueBooking: () => true },
  });
  const result = await route.POST({ json: async () => ({
    bookingReference: booking.public_ref, requestId: nonce,
    // This untrusted field must not override the saved itinerary in either direction.
    itinerary: options.requestItinerary ?? { carrierCode: 'BG', legs: [] },
  }) });
  return { result, events, captured };
}

const issued = await run();
assert.equal(issued.result.status, 200);
assert.deepEqual(issued.events, ['claim', 'issue', 'capture']);
assert.deepEqual(issued.captured.ticketNumbers, ['XY1234', 'XY1234']);
assert.deepEqual(issued.captured.airlinesPnr, ['XY1234']);
assert.equal(issued.captured.pnr, 'ABC123');
for (const options of [
  { itinerary: { carrierCode: 'BG', legs: [{ segments: [{ airlineCode: 'BG' }] }] }, requestItinerary: itinerary },
  { receipt: { ...receipt, publicReceipt: { ...receipt.publicReceipt, status: 'on-hold' } } },
  { receipt: { ...receipt, publicReceipt: { ...receipt.publicReceipt, pendingReview: true } } },
]) {
  const unverified = await run(options);
  assert.equal(unverified.result.status, 503);
  assert.equal(unverified.result.code, 'ISSUE_OUTCOME_UNKNOWN');
  assert.equal(unverified.captured, null);
  assert.deepEqual(unverified.events, ['claim', 'issue', 'reconcile'],
    'Unverified PNR receipts protect funds without another Issue or capture');
}
const replay = await run({ replay: true });
assert.equal(replay.result.status, 200);
assert.deepEqual(replay.events, ['claim']);
assert.equal(replay.captured, null);

// Saved ticket review must accept the same proof without invoking a wallet or
// supplier mutation. Both client route variants use the saved carrier context.
async function review(savedItinerary) {
  let ticketReads = 0;
  const supplierPublicRef = 'STR261009000001';
  const saved = {
    id: bookingId, supplier: 'shapontravels', supplier_account: 'shapontravels', import_source: null,
    booking_code_ref: refs.bookingCodeRef, pnr: refs.pnr, booking_ref_number: refs.pnr,
    supplier_refs: refs, passenger_counts: { ADT: 2 }, itinerary: savedItinerary,
    status: 'in-progress', operation_reason: 'ticketing', payment_state: 'reconciliation',
  };
  const read = { httpStatus: 200, supplierPublicRef, body: {
    item1: { uniqueTransID: refs.uniqueTransId, itemCodeRef: refs.itemCodeRef,
      priceCodeRef: refs.priceCodeRef, bookingCodeRef: refs.bookingCodeRef,
      pnr: refs.pnr, bookingRefNumber: refs.pnr, bookingStatus: 'Created', ticketingTimeLimit: null },
    item2: { isSuccess: true }, currentStatus: { status: 'in-progress', reviewRequired: true },
    publicReceipt: { status: 'in-progress', pendingReview: true, tickets: [],
      actions: { canIssue: false, canCancel: false } },
  } };
  const forbidden = async () => { throw new Error('Review cannot mutate a supplier or wallet'); };
  const client = {
    shapontravelsReadBooking: async () => read,
    shapontravelsReadTicket: async () => { ticketReads++; return { httpStatus: 200, body: receipt }; },
    shapontravelsReadCancellation: forbidden, shapontravelsIssueRequest: forbidden,
  };
  const adapter = compile('lib/shapontravels/ticket.ts', {
    './client': client, '@/lib/triplover/ticket-payload': payload,
  });
  const status = compile('lib/shapontravels/booking-status.ts', {});
  const externalConfirmation = compile('lib/shapontravels/external-ticket-confirmation.ts', {
    './booking-status': status, './ticket': adapter,
  });
  const query = { select: () => query, eq: () => query,
    single: async () => ({ data: { supplier_public_ref: supplierPublicRef }, error: null }) };
  const route = compile('app/api/flights/booking/shapon-status/route.ts', {
    '@/lib/references': references,
    zod: { z },
    '@/lib/dashboard/session': { getDashboardSession: async () => ({ clerkId: 'synthetic-staff', role: 'staff_account' }) },
    '@/lib/dashboard/booking-lifecycle': { canRefreshBookingSupplierDetails: () => true },
    '@/lib/dashboard/bookings': { bookingScopeFor: () => ({}) },
    '@/lib/db/flight-bookings': { readBookingByPublicRef: async () => saved },
    '@/lib/supabase/server': { supabaseAdmin: () => ({ from: () => query }) },
    '@/lib/shapontravels/client': client,
    '@/lib/shapontravels/booking-status': status,
    '@/lib/shapontravels/external-ticket-confirmation': externalConfirmation,
    '@/lib/shapontravels/current-status-store': { recordShapontravelsCurrentStatus: async () => ({ saved: true }) },
    '@/lib/shapontravels/ticket': adapter,
    '@/lib/shapontravels/cancel': {
      parseShapontravelsCancellationReceipt: forbidden, shapontravelsCancellationIdentityReady: forbidden,
    },
    '@/lib/wallet/http': {
      walletOk: data => ({ status: 200, data }), walletFail: (status, code) => ({ status, code }),
    },
  });
  const result = await route.POST({ json: async () => ({
    bookingReference: 'KTT261009000001', itinerary,
  }) });
  assert.equal(result.status, 200);
  assert.equal(ticketReads, 1);
  return result.data.supplierTicket;
}
assert.deepEqual(JSON.parse(JSON.stringify(await review(itinerary))), {
  result: 'verified', ticketCount: 2, ticketCodeRef: receipt.item1.ticketCodeRef,
});
assert.equal((await review({ carrierCode: 'BG', legs: [] })).result, 'unverified',
  'A client-supplied IndiGo itinerary cannot authorize a non-IndiGo saved ticket');
console.log('Shapon IndiGo Issue route: saved carrier context, unchanged request identity, exact receipt and replay/uncertainty guards passed');
