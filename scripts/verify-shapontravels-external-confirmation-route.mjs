import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';

// Compile the actual server modules with an offline dependency boundary. A test
// cannot accidentally issue, cancel, charge a live wallet or call external HTTP.
function compile(file, imports = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new vm.Script(source, { filename: file }).runInNewContext({
    module, exports: module.exports, Date, Error,
    console: { error() {}, warn() {}, log() {} },
    fetch: async () => { throw new Error('External transport is forbidden'); },
    require(name) {
      if (name === 'server-only') return {};
      assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`);
      return imports[name];
    },
  });
  return module.exports;
}

const plain = value => JSON.parse(JSON.stringify(value));
const refs = {
  uniqueTransId: '11111111-1111-4111-8111-111111111111',
  itemCodeRef: '22222222-2222-4222-8222-222222222222',
  priceCodeRef: '33333333-3333-4333-8333-333333333333',
  bookingCodeRef: '44444444-4444-4444-8444-444444444444',
  pnr: 'ABC123', bookingRefNumber: 'ABC123',
};
const bookingId = '55555555-5555-4555-8555-555555555555';
const ticketCodeRef = '66666666-6666-4666-8666-666666666666';
const nonce = '77777777-7777-4777-8777-777777777777';
const supplierPublicRef = 'STR261010111116';
const itinerary = { carrierCode: 'BG', legs: [{ segments: [{ airlineCode: 'BG' }] }] };
const admin = { clerkId: 'synthetic-admin', role: 'admin' };
const scope = { syntheticScope: 'privileged-booking-read' };
const publicReceipt = {
  status: 'confirmed', pendingReview: false, pnr: refs.pnr,
  paymentState: 'paid', actions: { canIssue: false, canCancel: false },
};
const currentStatus = { status: 'confirmed', reviewRequired: false };
const receiptIdentity = {
  uniqueTransID: refs.uniqueTransId, itemCodeRef: refs.itemCodeRef,
  priceCodeRef: refs.priceCodeRef, bookingCodeRef: refs.bookingCodeRef,
  bookingRefNumber: refs.bookingRefNumber, pnr: refs.pnr,
};
const baseBookingRead = {
  httpStatus: 200, supplierPublicRef,
  body: {
    item1: { ...receiptIdentity, bookingStatus: 'Created', ticketingTimeLimit: null },
    item2: { isSuccess: true }, currentStatus, publicReceipt,
  },
};
const baseTicketRead = {
  httpStatus: 200,
  body: {
    item1: { ...receiptIdentity, ticketCodeRef, airlinesPNR: ['XY1234'],
      ticketInfoes: ['1234567890123', '1234567890124'].map(number => ({ ticketNumbers: [number] })) },
    item2: { isSuccess: true }, currentStatus, publicReceipt,
  },
};
const baseBooking = {
  id: bookingId, public_ref: 'KTT261010111116', currency: 'BDT',
  supplier: 'shapontravels', supplier_account: 'shapontravels', import_source: null,
  status: 'on-hold', lifecycle_status: 'on-hold', payment_state: 'unpaid',
  direct_ticketing: false, operation_kind: null, operation_reason: null,
  operation_request_id: null, ticket_code_ref: null, ticket_numbers: [], issued_at: null,
  pnr: refs.pnr, booking_ref_number: refs.bookingRefNumber,
  booking_code_ref: refs.bookingCodeRef, supplier_refs: {
    uniqueTransId: refs.uniqueTransId, itemCodeRef: refs.itemCodeRef, priceCodeRef: refs.priceCodeRef,
  }, passenger_counts: { ADT: 2 }, itinerary,
  booking_owner_type: 'user', booking_owner_key: 'synthetic-owner', user_id: 'synthetic-owner',
  user_payable_amount: 1234500, captured_amount: 0, refunded_amount: 0,
  pricing_snapshot: { sellingPrice: 12345, grossPrice: 11000 },
};
const successfulRpcResult = {
  ok: true, replay: false, bookingId, status: 'confirmed', chargeWallet: true,
  settlement: 'owner_wallet', chargedAmount: baseBooking.user_payable_amount,
  currency: 'BDT', decisionId: 'synthetic-decision',
};
const statusModule = compile('lib/shapontravels/booking-status.ts');
const payload = compile('lib/triplover/ticket-payload.ts');

async function run(options = {}) {
  const events = [];
  const rpcCalls = [];
  const audits = [];
  let notifications = 0;
  const booking = options.missingBooking ? null : { ...plain(baseBooking), ...options.booking };
  const bookingRead = plain(options.bookingRead ?? baseBookingRead);
  const ticketRead = plain(options.ticketRead ?? baseTicketRead);
  const session = Object.hasOwn(options, 'session') ? options.session : admin;
  const forbidden = async () => { throw new Error('Supplier and legacy wallet mutations are forbidden'); };
  const client = {
    shapontravelsReadBooking: async lookup => {
      events.push('read-booking');
      assert.deepEqual(plain(lookup), { bookingId: refs.bookingCodeRef },
        'Supplier lookup always uses the saved booking UUID');
      if (options.bookingReadThrows) throw new Error('Synthetic supplier booking unavailable');
      return bookingRead;
    },
    shapontravelsReadTicket: async bookingCode => {
      events.push('read-ticket');
      assert.equal(bookingCode, refs.bookingCodeRef);
      if (options.ticketReadThrows) throw new Error('Synthetic supplier ticket unavailable');
      return ticketRead;
    },
    shapontravelsIssueRequest: forbidden, shapontravelsCancelRequest: forbidden,
    shapontravelsReadCancellation: forbidden,
  };
  const ticket = compile('lib/shapontravels/ticket.ts', {
    './client': client, '@/lib/triplover/ticket-payload': payload,
  });
  const external = compile('lib/shapontravels/external-ticket-confirmation.ts', {
    './booking-status': statusModule, './ticket': ticket,
    '@/lib/shapontravels/booking-status': statusModule,
    '@/lib/shapontravels/ticket': ticket,
  });
  const db = {
    from(table) {
      assert.ok(['flight_bookings', 'shapon_external_ticket_confirmations'].includes(table),
        `Unexpected table ${table}`);
      const query = {
        select: () => query, eq: () => query,
        single: async () => ({ data: { supplier_public_ref: Object.hasOwn(options, 'supplierPublicRef')
          ? options.supplierPublicRef : supplierPublicRef },
          error: options.identityStorageError ? { code: 'SYNTHETIC_STORAGE_ERROR' } : null }),
        maybeSingle: async () => ({
          data: options.existingRequest ? { request_id: nonce } : null,
          error: options.replayStorageError ? { code: 'SYNTHETIC_STORAGE_ERROR' } : null,
        }),
      };
      return query;
    },
    rpc: async (name, args) => {
      events.push('confirm-rpc');
      assert.equal(name, 'confirm_shapon_external_ticket_v1');
      const captured = plain(args);
      rpcCalls.push(captured);
      assert.equal(captured.p_booking_id, bookingId);
      assert.equal(captured.p_actor_user_id, session.clerkId);
      assert.equal(captured.p_actor_role, session.role);
      assert.equal(captured.p_request_id, nonce);
      assert.equal(captured.p_charge_wallet, options.chargeWallet ?? true);
      assert.equal(Object.hasOwn(captured, 'p_amount'), false,
        'The database derives the selling amount from the saved booking');
      if (options.existingRequest) {
        assert.equal(captured.p_receipt_identity, null);
        assert.equal(captured.p_ticket_proof, null);
        assert.equal(captured.p_checked_at, null);
      } else {
        assert.equal(captured.p_ticket_proof.verified, true);
        assert.equal(captured.p_ticket_proof.issued, true);
        assert.equal(captured.p_ticket_proof.paid, true);
        assert.equal(captured.p_ticket_proof.pnr, refs.pnr);
        assert.equal(captured.p_ticket_proof.ticketCodeRef, ticketCodeRef);
        assert.deepEqual(captured.p_ticket_proof.ticketNumbers, ['1234567890123', '1234567890124']);
        assert.equal(captured.p_ticket_proof.passengerCount, 2);
        assert.equal(Object.hasOwn(captured.p_ticket_proof, 'issuedAt'), false,
          'A fresh confirmation observation cannot invent an unknown supplier issuance time');
        assert.deepEqual(captured.p_ticket_proof.passengerTickets, [
          { ticketNumbers: ['1234567890123'], ticketNumberSource: null },
          { ticketNumbers: ['1234567890124'], ticketNumberSource: null },
        ]);
        assert.deepEqual(captured.p_receipt_identity, { ...refs, supplierPublicRef });
        assert.ok(Number.isFinite(Date.parse(captured.p_checked_at)));
      }
      if (options.rpcThrows) throw new Error('Synthetic RPC response lost after dispatch');
      return { data: Object.hasOwn(options, 'rpcResult') ? options.rpcResult : {
        ok: true, replay: Boolean(options.existingRequest), bookingId, status: 'confirmed',
        chargeWallet: options.chargeWallet ?? true,
        settlement: options.chargeWallet === false ? 'external_no_charge' : 'wallet_charged',
        chargedAmount: options.chargeWallet === false ? 0 : baseBooking.user_payable_amount,
        currency: 'BDT', decisionId: 'synthetic-decision',
      }, error: options.rpcError ? { code: 'SYNTHETIC_RPC_ERROR' } : null };
    },
  };
  const route = compile(options.refresh ? 'app/api/flights/booking/shapon-status/route.ts'
    : 'app/api/flights/booking/confirm-external-ticket/route.ts', {
    zod: { z },
    '@/lib/dashboard/session': { getDashboardSession: async () => session },
    '@/lib/dashboard/booking-lifecycle': { canRefreshBookingSupplierDetails: role =>
      ['admin', 'superadmin', 'staff_account', 'staff_support'].includes(role) },
    '@/lib/dashboard/bookings': { bookingScopeFor: passed => {
      assert.equal(passed, session); return scope;
    } },
    '@/lib/db/flight-bookings': { readBookingByPublicRef: async (reference, passedScope) => {
      events.push('read-local');
      assert.equal(reference, baseBooking.public_ref);
      assert.equal(passedScope, scope, 'The normal scoped booking reader remains in use');
      return booking;
    } },
    '@/lib/supabase/server': { supabaseAdmin: () => options.noDatabase ? null : db },
    '@/lib/rate-limit': { checkActionLimit: async action => {
      assert.equal(action, 'bookingReconciliationWrite');
      return options.rateLimit ? { ok: false, retryAfter: 60 } : { ok: true };
    } },
    '@/lib/shapontravels/client': client,
    '@/lib/shapontravels/booking-status': statusModule,
    '@/lib/shapontravels/current-status-store': { recordShapontravelsCurrentStatus: async record => {
      events.push('store-status');
      assert.equal(record.bookingId, bookingId);
      assert.equal(record.expected.supplierPublicRef, supplierPublicRef);
      assert.equal(record.status.result, 'verified');
      return { currentStatusStorage: 'saved', projectionUpdated: true,
        displayStatus: 'unconfirmed', displayReviewRequired: true };
    } },
    '@/lib/shapontravels/ticket': ticket,
    '@/lib/shapontravels/cancel': {
      parseShapontravelsCancellationReceipt: forbidden,
      shapontravelsCancellationIdentityReady: forbidden,
    },
    '@/lib/shapontravels/external-ticket-confirmation': external,
    '@/lib/db/security': { recordSecurityAuditEvent: async event => {
      audits.push(plain(event));
      if (options.auditThrows) throw new Error('Synthetic audit transport unavailable');
    } },
    '@/lib/email/booking-status-delivery': { dispatchBookingStatusEmails: async id => {
      notifications++;
      assert.equal(id, bookingId);
      if (options.emailThrows) throw new Error('Synthetic email transport unavailable');
    } },
    '@/lib/wallet/http': {
      walletOk: data => ({ status: 200, data }),
      walletFail: (status, code, message) => ({ status, code, message }),
    },
  });
  const body = { bookingReference: baseBooking.public_ref, requestId: nonce,
    chargeWallet: options.chargeWallet ?? true,
    // Client overrides cannot change the supplier identity, owner or debit amount.
    amount: 1, userPayableAmount: 1, ownerKey: 'someone-else',
    pnr: 'OTHER1', supplierRefs: { uniqueTransId: 'someone-elses-transaction' },
    itinerary: { carrierCode: '6E', legs: [] },
    ...options.body,
  };
  const result = await route.POST({ json: async () => {
    if (options.invalidJson) throw new Error('Malformed JSON');
    return body;
  } });
  return { result, events, rpcCalls, audits, notifications, external };
}

function assertBlocked(outcome, message) {
  assert.ok(outcome.result.status >= 400, `${message}: expected refusal`);
  assert.equal(outcome.rpcCalls.length, 0, `${message}: cannot confirm or debit`);
  assert.equal(outcome.events.includes('confirm-rpc'), false, message);
}

for (const chargeWallet of [true, false]) {
  const confirmed = await run({ chargeWallet });
  assert.equal(confirmed.result.status, 200);
  assert.deepEqual(confirmed.events, ['read-local', 'read-booking', 'read-ticket', 'confirm-rpc']);
  assert.equal(confirmed.rpcCalls.length, 1);
  assert.equal(confirmed.audits.length, 1);
  assert.equal(confirmed.audits[0].metadata.chargeWallet, chargeWallet);
  assert.equal(confirmed.notifications, 1);
  assert.deepEqual(plain(confirmed.result.data), {
    confirmed: true, charged: chargeWallet,
    amount: chargeWallet ? 12345 : 0, currency: 'BDT', replay: false,
  }, 'Both Admin decisions confirm the booking, preserving their distinct wallet behavior');
}
for (const changes of [
  { status: 'pending', lifecycle_status: 'pending' },
  { lifecycle_status: 'unconfirmed' }, { lifecycle_status: 'expired' },
  { payment_state: 'released' },
]) {
  assert.equal((await run({ booking: changes })).result.status, 200,
    'Ordinary unticketed local booking states allow the verified supplier ticket decision');
}

for (const role of ['customer', 'b2b', 'b2b_sub', 'staff_support', 'staff_account', 'staff_media']) {
  const denied = await run({ session: { ...admin, role } });
  assert.equal(denied.result.status, 403, `${role} cannot authorize an external ticket settlement`);
  assertBlocked(denied, role);
  assert.deepEqual(denied.events, [], 'Unauthorized callers cannot read a supplier booking');
}
const signedOut = await run({ session: null });
assert.equal(signedOut.result.status, 401);
assertBlocked(signedOut, 'signed out');
assert.deepEqual(signedOut.events, []);
assert.equal((await run({ session: { ...admin, role: 'superadmin' } })).result.status, 200);

for (const options of [
  { invalidJson: true },
  { body: { requestId: 'not-a-uuid' } },
  { body: { requestId: undefined } },
  { body: { bookingReference: 'INVALID' } },
  { body: { chargeWallet: undefined } },
  { body: { chargeWallet: 'true' } },
  { body: { chargeWallet: null } },
]) {
  const invalid = await run(options);
  assert.equal(invalid.result.status, 400);
  assertBlocked(invalid, 'invalid request');
  assert.deepEqual(invalid.events, []);
}
const limited = await run({ rateLimit: true });
assert.equal(limited.result.status, 429);
assertBlocked(limited, 'rate limit');
assert.deepEqual(limited.events, []);
for (const options of [
  { missingBooking: true }, { noDatabase: true },
  { identityStorageError: true }, { replayStorageError: true },
  { supplierPublicRef: null },
]) {
  const unavailable = await run(options);
  assertBlocked(unavailable, 'storage or booking identity unavailable');
  assert.equal(unavailable.events.includes('read-booking'), false);
  assert.equal(unavailable.events.includes('read-ticket'), false);
}

for (const changes of [
  { status: 'confirmed', lifecycle_status: 'confirmed' },
  { status: 'cancelled', lifecycle_status: 'cancelled' },
  { status: 'in-progress', lifecycle_status: 'in-progress' },
  { payment_state: 'captured', captured_amount: 1234500 },
  { payment_state: 'held' }, { payment_state: 'reconciliation' },
  { payment_state: 'refunded' }, { refunded_amount: 1 }, { captured_amount: 1 },
  { operation_kind: 'ticketing', operation_reason: 'ticketing' },
  { active_operation_id: nonce },
  { ticket_code_ref: ticketCodeRef }, { ticket_numbers: ['1234567890123'] },
  { ticket_numbers: '1234567890123' }, { ticket_numbers: { ticket: '1234567890123' } },
  { issued_at: '2026-10-10T05:11:16Z' },
  { import_source: 'IMP_EXP' }, { import_source: 'MANUAL' },
  { supplier: 'triplover' }, { supplier_account: 'takeoff' },
  { direct_ticketing: true }, { legacy_operational: true },
  { booking_owner_key: null }, { booking_owner_type: null }, { currency: 'USD' },
  { pricing_snapshot: { sellingPrice: 0 } }, { pricing_snapshot: { sellingPrice: 'not-a-price' } },
  { pricing_snapshot: { sellingPrice: '12345' } },
  { pnr: null }, { booking_code_ref: null }, { supplier_refs: null },
  { passenger_counts: { ADT: 0 } }, { passenger_counts: { ADT: 1.5 } },
]) {
  const blocked = await run({ booking: changes });
  assertBlocked(blocked, JSON.stringify(changes));
  assert.equal(blocked.events.includes('read-booking'), false,
    'Ineligible local state does not consult a supplier or mutate funds');
}

for (const [description, mutate] of [
  ['old confirmed projection with latest hold', read => {
    read.body.currentStatus.status = 'on-hold'; read.body.publicReceipt.status = 'on-hold';
  }],
  ['current booking review required', read => { read.body.currentStatus.reviewRequired = true; }],
  ['current receipt pending review', read => { read.body.publicReceipt.pendingReview = true; }],
  ['current reconciliation required', read => { read.body.requiresReconciliation = true; }],
  ['supplier booking unpaid', read => { read.body.publicReceipt.paymentState = 'unpaid'; }],
  ['supplier booking payment absent', read => { delete read.body.publicReceipt.paymentState; }],
  ['supplier booking paid wrong type', read => { read.body.publicReceipt.paymentState = true; }],
  ['supplier booking public PNR mismatch', read => { read.body.publicReceipt.pnr = 'OTHER1'; }],
  ['current status absent', read => { delete read.body.currentStatus; }],
  ['current status malformed', read => { read.body.currentStatus.reviewRequired = 'false'; }],
  ['booking receipt false success', read => { read.body.item2.isSuccess = false; }],
  ['supplier booking pending', read => { read.httpStatus = 202; }],
  ['supplier booking not found', read => { read.httpStatus = 404; }],
  ['supplier booking bad HTTP', read => { read.httpStatus = 500; }],
  ['supplier public reference mismatch', read => { read.supplierPublicRef = 'STR261010000000'; }],
  ['supplier public reference absent', read => { read.supplierPublicRef = null; }],
]) {
  const bookingRead = plain(baseBookingRead);
  mutate(bookingRead);
  const blocked = await run({ bookingRead, booking: {
    shapon_current_status: { currentStatus: { status: 'confirmed', reviewRequired: false },
      effectiveStatus: 'confirmed', fetchedAt: '2026-10-09T05:11:16Z' },
  } });
  assertBlocked(blocked, description);
}
for (const name of ['uniqueTransID', 'itemCodeRef', 'priceCodeRef', 'bookingCodeRef', 'bookingRefNumber', 'pnr']) {
  const bookingRead = plain(baseBookingRead);
  bookingRead.body.item1[name] = 'foreign-reference';
  assertBlocked(await run({ bookingRead }), `Booking receipt cannot bypass ${name}`);
}

for (const [description, mutate] of [
  ['ticket pending', read => { read.httpStatus = 202; }],
  ['ticket missing', read => { read.httpStatus = 404; }],
  ['ticket bad HTTP', read => { read.httpStatus = 500; }],
  ['ticket false success', read => { read.body.item2.isSuccess = false; }],
  ['ticket unpaid', read => { read.body.publicReceipt.paymentState = 'unpaid'; }],
  ['ticket paid absent', read => { delete read.body.publicReceipt.paymentState; }],
  ['ticket review required', read => { read.body.publicReceipt.pendingReview = true; }],
  ['ticket reconciliation required', read => { read.body.requiresReconciliation = true; }],
  ['ticket public status still held', read => { read.body.publicReceipt.status = 'on-hold'; }],
  ['ticket public PNR mismatch', read => { read.body.publicReceipt.pnr = 'OTHER1'; }],
  ['ticket current status cancelled', read => { read.body.currentStatus.status = 'cancelled'; }],
  ['ticket current status still held', read => { read.body.currentStatus.status = 'on-hold'; }],
  ['ticket current status requires review', read => { read.body.currentStatus.reviewRequired = true; }],
  ['ticket current status review malformed', read => { read.body.currentStatus.reviewRequired = 'false'; }],
  ['ticket current status malformed', read => { read.body.currentStatus = null; }],
  ['ticket current status array', read => { read.body.currentStatus = []; }],
  ['ticket current status string', read => { read.body.currentStatus = 'confirmed'; }],
  ['ticket current status incomplete', read => { read.body.currentStatus = { status: 'confirmed' }; }],
  ['one passenger ticket missing', read => { read.body.item1.ticketInfoes.pop(); }],
  ['extra passenger ticket', read => { read.body.item1.ticketInfoes.push({ ticketNumbers: ['1234567890125'] }); }],
  ['duplicate ticket numbers', read => { read.body.item1.ticketInfoes[1].ticketNumbers = ['1234567890123']; }],
  ['empty ticket numbers', read => { read.body.item1.ticketInfoes[1].ticketNumbers = []; }],
  ['non-numeric ticket without airline proof', read => { read.body.item1.ticketInfoes[0].ticketNumbers = ['XY1234']; }],
  ['airline PNR proof for wrong carrier', read => {
    read.body.item1.ticketInfoes = [0, 1].map(() => ({ ticketNumbers: ['XY1234'], ticketNumberSource: 'airline_pnr' }));
  }],
  ['invalid ticket locator', read => { read.body.item1.ticketCodeRef = 'fake-ticket'; }],
]) {
  const ticketRead = plain(baseTicketRead);
  mutate(ticketRead);
  assertBlocked(await run({ ticketRead }), description);
}
for (const name of ['uniqueTransID', 'itemCodeRef', 'priceCodeRef', 'bookingCodeRef', 'pnr']) {
  const ticketRead = plain(baseTicketRead);
  ticketRead.body.item1[name] = 'foreign-reference';
  assertBlocked(await run({ ticketRead }), `Saved ticket cannot bypass ${name}`);
}
for (const field of ['bookingRead', 'ticketRead']) {
  for (const value of [true, 'true', 'false', null, 0, 1, {}, []]) {
    const read = plain(field === 'bookingRead' ? baseBookingRead : baseTicketRead);
    read.body.requiresReconciliation = value;
    assertBlocked(await run({ [field]: read }), `${field}: malformed or required reconciliation flag`);
  }
  const clean = plain(field === 'bookingRead' ? baseBookingRead : baseTicketRead);
  clean.body.requiresReconciliation = false;
  assert.equal((await run({ [field]: clean })).result.status, 200,
    'An explicit false reconciliation flag agrees with the verified paid proof');
}
const ticketWithoutCurrentStatus = plain(baseTicketRead);
delete ticketWithoutCurrentStatus.body.currentStatus;
assert.equal((await run({ ticketRead: ticketWithoutCurrentStatus })).result.status, 200,
  'A saved numeric ticket receipt may omit optional current metadata');
const ticketWithFullCurrentStatus = plain(baseTicketRead);
ticketWithFullCurrentStatus.body.currentStatus = {
  status: 'confirmed', reviewRequired: false, bookingState: 'issued', supplierStatus: 'Confirmed',
  supplierCheckedAt: '2026-10-10T05:11:16Z', verified: true,
  source: 'ticket_operation', checkedAt: '2026-10-10T05:11:16Z',
};
assert.equal((await run({ ticketRead: ticketWithFullCurrentStatus })).result.status, 200,
  'Complete confirmed current metadata agrees with the paid ticket receipt');
ticketWithFullCurrentStatus.body.currentStatus.status = 'cancelled';
assertBlocked(await run({ ticketRead: ticketWithFullCurrentStatus }),
  'Complete current metadata cannot contradict the ticket receipt');
for (const options of [{ bookingReadThrows: true }, { ticketReadThrows: true }]) {
  const unavailable = await run(options);
  assertBlocked(unavailable, 'supplier read unavailable');
}

for (const chargeWallet of [true, false]) {
  const replay = await run({ existingRequest: true, chargeWallet,
    booking: { status: 'confirmed', lifecycle_status: 'confirmed', ticket_code_ref: ticketCodeRef,
      ticket_numbers: ['1234567890123', '1234567890124'],
      payment_state: chargeWallet ? 'captured' : 'unpaid',
      captured_amount: chargeWallet ? baseBooking.user_payable_amount : 0 },
    bookingReadThrows: true, ticketReadThrows: true,
  });
  assert.equal(replay.result.status, 200);
  assert.equal(replay.result.data.replay, true);
  assert.equal(replay.result.data.charged, chargeWallet);
  assert.equal(replay.audits.length, 0);
  assert.equal(replay.notifications, 0);
  assert.deepEqual(replay.events, ['read-local', 'confirm-rpc'],
    'Persisted exact retry remains successful after confirmation and supplier unavailability');
}
const conflictingReplay = await run({ existingRequest: true, chargeWallet: false,
  booking: { status: 'confirmed', lifecycle_status: 'confirmed' },
  rpcResult: { ok: false, code: 'CONFIRMATION_REQUEST_CONFLICT' },
});
assert.ok(conflictingReplay.result.status >= 400);
assert.deepEqual(conflictingReplay.events, ['read-local', 'confirm-rpc'],
  'Changed wallet choice is resolved by the durable database replay binding');
for (const options of [
  { rpcError: true }, { rpcResult: { ok: false, code: 'INSUFFICIENT_FUNDS' } },
  { rpcResult: { ok: false, code: 'BOOKING_CONFIRMATION_CONFLICT' } },
  { rpcResult: null }, { rpcResult: [] }, { rpcResult: {} },
  { rpcResult: { ok: 'true' } },
]) {
  const failed = await run(options);
  assert.ok(failed.result.status >= 400, 'Atomic database refusal must not report confirmed');
  assert.equal(failed.rpcCalls.length, 1);
  assert.equal(failed.audits.length, 0);
  assert.equal(failed.notifications, 0);
}
for (const [code, expectedStatus] of [
  ['CONFIRMATION_FORBIDDEN', 403], ['ACTOR_ROLE_MISMATCH', 403],
  ['BOOKING_NOT_FOUND', 404], ['BOOKING_ALREADY_CONFIRMED', 409],
  ['TICKET_EVIDENCE_UNVERIFIED', 409], ['TICKET_ALREADY_ASSIGNED', 409],
]) {
  const refused = await run({ rpcResult: { ok: false, code } });
  assert.equal(refused.result.status, expectedStatus, 'Canonical DB refusal preserves its intended HTTP status');
  assert.equal(refused.result.code, code);
  assert.equal(refused.audits.length, 0);
  assert.equal(refused.notifications, 0);
}
for (const [description, changes, chargeWallet] of [
  ['charge choice missing', { chargeWallet: undefined }, true],
  ['charge choice wrong type', { chargeWallet: 'true' }, true],
  ['charge choice contradicted', { chargeWallet: false }, true],
  ['charged amount missing', { chargedAmount: undefined }, true],
  ['charged amount string', { chargedAmount: '1234500' }, true],
  ['charged amount null', { chargedAmount: null }, true],
  ['charged amount fractional', { chargedAmount: 1234500.5 }, true],
  ['charged amount negative', { chargedAmount: -1 }, true],
  ['charged amount nonfinite', { chargedAmount: Infinity }, true],
  ['charged amount unsafe', { chargedAmount: Number.MAX_SAFE_INTEGER + 1 }, true],
  ['charge choice with no debit', { chargedAmount: 0 }, true],
  ['no charge choice with debit', { chargeWallet: false, chargedAmount: 1 }, false],
  ['currency mismatch', { currency: 'USD' }, true],
  ['currency missing', { currency: undefined }, true],
]) {
  const unknown = await run({ chargeWallet, rpcResult: { ...successfulRpcResult, ...changes } });
  assert.equal(unknown.result.status, 503, description);
  assert.equal(unknown.result.code, 'CONFIRMATION_OUTCOME_UNKNOWN', description);
  assert.equal(unknown.rpcCalls.length, 1);
  assert.equal(unknown.audits.length, 0);
  assert.equal(unknown.notifications, 0);
}
const rpcException = await run({ rpcThrows: true });
assert.equal(rpcException.result.status, 503);
assert.equal(rpcException.result.code, 'CONFIRMATION_OUTCOME_UNKNOWN',
  'A dispatched RPC exception preserves the same durable confirmation retry choice');
assert.equal(rpcException.rpcCalls.length, 1);
assert.equal(rpcException.audits.length, 0);
assert.equal(rpcException.notifications, 0);
for (const options of [{ auditThrows: true }, { emailThrows: true }]) {
  const committed = await run(options);
  assert.equal(committed.result.status, 200,
    'Delivery failure after the atomic commit cannot ask Admin to make another financial decision');
  assert.equal(committed.result.data.confirmed, true);
  assert.equal(committed.rpcCalls.length, 1);
}

for (const role of ['admin', 'superadmin']) {
  const refreshed = await run({ refresh: true, session: { ...admin, role } });
  assert.equal(refreshed.result.status, 200);
  assert.deepEqual(plain(refreshed.result.data.externalTicketConfirmation), {
    eligible: true, amount: 12345, currency: 'BDT',
  }, 'A paid supplier ticket exposes the decision after an Admin refresh of an unpaid local hold');
  assert.deepEqual(plain(refreshed.result.data.supplierTicket), {
    result: 'verified', ticketCount: 2, ticketCodeRef,
  });
  assert.deepEqual(refreshed.events, ['read-local', 'read-booking', 'store-status', 'read-ticket']);
  assert.equal(refreshed.rpcCalls.length, 0, 'Refresh cannot confirm or debit the booking');
  assert.equal(refreshed.audits.length, 0);
  assert.equal(refreshed.notifications, 0);
}
for (const role of ['staff_support', 'staff_account']) {
  const refreshed = await run({ refresh: true, session: { ...admin, role } });
  assert.equal(refreshed.result.status, 200);
  assert.equal(refreshed.result.data.externalTicketConfirmation, null,
    'Staff may inspect supplier ticket evidence without receiving an Admin settlement decision');
  assert.equal(refreshed.result.data.supplierTicket.result, 'verified');
  assert.equal(refreshed.rpcCalls.length, 0);
}
for (const options of [
  { booking: { status: 'confirmed', lifecycle_status: 'confirmed', ticket_code_ref: ticketCodeRef } },
  { booking: { payment_state: 'captured', captured_amount: baseBooking.user_payable_amount } },
  { ticketReadThrows: true },
  { ticketRead: { ...baseTicketRead, httpStatus: 202 } },
  { ticketRead: { ...baseTicketRead, httpStatus: 404 } },
  { ticketRead: { ...baseTicketRead, body: { ...plain(baseTicketRead.body),
    publicReceipt: { ...publicReceipt, paymentState: 'unpaid' } } } },
  { ticketRead: { ...baseTicketRead, body: { ...plain(baseTicketRead.body),
    item1: { ...plain(baseTicketRead.body.item1), pnr: 'OTHER1' } } } },
  { bookingRead: { ...baseBookingRead, body: { ...plain(baseBookingRead.body),
    publicReceipt: { ...publicReceipt, pendingReview: true } } } },
]) {
  const refreshed = await run({ refresh: true, ...options });
  assert.equal(refreshed.result.status, 200);
  assert.equal(refreshed.result.data.externalTicketConfirmation, null,
    'Every fresh refusal clears the confirmation candidate without financial writes');
  assert.equal(refreshed.rpcCalls.length, 0);
}

console.log('Shapon external ticket confirmation route: Admin scope, fresh paid ticket proof, both settlement decisions and persisted retry guards passed');
