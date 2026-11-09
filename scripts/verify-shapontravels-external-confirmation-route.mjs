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
  booking_owner_type: 'agency', booking_owner_key: 'BDT000000000001',
  agency_code: 'BDT000000000001', audience: 'agency', user_id: 'synthetic-booking-agent',
  user_payable_amount: 1234500, captured_amount: 0, refunded_amount: 0,
  pricing_snapshot: { sellingPrice: 12345, grossPrice: 11000 },
};
const successfulRpcResult = {
  ok: true, replay: false, bookingId, status: 'confirmed', chargeWallet: true,
  paymentEffect: 'charge_wallet',
  settlement: 'owner_wallet', chargedAmount: baseBooking.user_payable_amount,
  currency: 'BDT', decisionId: 'synthetic-decision',
};
const statusModule = compile('lib/shapontravels/booking-status.ts');
const references = { BOOKING_REFERENCE_PATTERN: /^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/ };
const payload = compile('lib/triplover/ticket-payload.ts');

async function run(options = {}) {
  const events = [];
  const rpcCalls = [];
  const audits = [];
  const statusRecords = [];
  const forbiddenCalls = [];
  let notifications = 0;
  const booking = options.missingBooking ? null : { ...plain(baseBooking), ...options.booking };
  const paymentEffect = options.paymentEffect ?? (options.existingRequest ? 'charge_wallet' : (
    booking?.payment_state === 'captured' ? 'already_paid'
      : ['held', 'reconciliation'].includes(booking?.payment_state) ? 'capture_hold' : 'charge_wallet'
  ));
  const paymentPreview = {
    ok: true, eligible: true, paymentEffect, amount: baseBooking.user_payable_amount,
    existingHoldAmount: paymentEffect === 'capture_hold' ? baseBooking.user_payable_amount : 0,
    currency: 'BDT', ...options.paymentPreview,
  };
  const bookingRead = plain(options.bookingRead ?? baseBookingRead);
  const ticketRead = plain(options.ticketRead ?? baseTicketRead);
  const cancellationRead = plain(options.cancellationRead ?? {
    httpStatus: 404, body: { error: 'NOT_FOUND' },
  });
  const session = Object.hasOwn(options, 'session') ? options.session : admin;
  const forbidden = async () => {
    forbiddenCalls.push('mutation');
    throw new Error('Supplier and legacy wallet mutations are forbidden');
  };
  const client = new Proxy({
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
    shapontravelsReadCancellation: async bookingCode => {
      events.push('read-cancellation');
      assert.equal(bookingCode, refs.bookingCodeRef);
      if (options.cancellationReadThrows) throw new Error('Synthetic saved cancellation unavailable');
      return cancellationRead;
    },
    shapontravelsIssueRequest: forbidden, shapontravelsCancelRequest: forbidden,
  }, { get(target, name) {
    if (Object.hasOwn(target, name)) return target[name];
    return async () => {
      forbiddenCalls.push(String(name));
      throw new Error(`Only saved booking, ticket and cancellation GETs are allowed: ${String(name)}`);
    };
  } });
  const ticket = compile('lib/shapontravels/ticket.ts', {
    './client': client, '@/lib/triplover/ticket-payload': payload,
    './booking-status': statusModule,
  });
  const external = compile('lib/shapontravels/external-ticket-confirmation.ts', {
    './booking-status': statusModule, './ticket': ticket,
    '@/lib/shapontravels/booking-status': statusModule,
    '@/lib/shapontravels/ticket': ticket,
  });
  const cancellation = compile('lib/shapontravels/cancellation-recovery.ts', {
    './booking-status': statusModule,
  });
  const cancellationAdapter = compile('lib/shapontravels/cancel.ts', {
    './booking-status': statusModule, './client': client,
    './current-status-projection': {
      parseShapontravelsCurrentStatusProjection: () => null,
    },
  });
  const ticketingTime = compile('lib/shapontravels/ticketing-time.ts', {
    './booking-status': statusModule,
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
      if (name === 'resolve_shapon_cancelled_refresh_v1') {
        events.push('cancel-recovery-rpc');
        rpcCalls.push(plain(args));
        assert.equal(args.p_booking_id, bookingId);
        assert.equal(args.p_actor_user_id, session.clerkId);
        assert.equal(args.p_actor_role, session.role);
        assert.equal(args.p_cancellation_proof.cancelled, true);
        assert.equal(args.p_cancellation_proof.ticketCount, 0);
        assert.equal(Object.hasOwn(args, 'p_amount'), false);
        return { data: Object.hasOwn(options, 'cancellationResult') ? options.cancellationResult
          : { ok: true, replay: false }, error: null };
      }
      assert.notEqual(options.refresh, true,
        'Refresh cannot dispatch ticket confirmation, capture or any unrelated database mutation');
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
        assert.deepEqual(captured.p_ticket_proof.ticketNumbers,
          options.expectedTicketNumbers ?? ['1234567890123', '1234567890124']);
        assert.equal(captured.p_ticket_proof.passengerCount, 2);
        assert.equal(captured.p_ticket_proof.expectedPaymentEffect, paymentEffect,
          'the verified proof pins the canonical payment effect');
        assert.equal(captured.p_ticket_proof.expectedPayableAmount, baseBooking.user_payable_amount,
          'the verified proof pins the displayed saved payable in minor units');
        if (options.expectedIssuedAt) assert.equal(captured.p_ticket_proof.issuedAt, options.expectedIssuedAt);
        else assert.equal(Object.hasOwn(captured.p_ticket_proof, 'issuedAt'), false,
          'A fresh confirmation observation cannot invent an unknown supplier issuance time');
        assert.deepEqual(captured.p_ticket_proof.passengerTickets, options.expectedPassengerTickets ?? [
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
        paymentEffect: options.chargeWallet === false ? 'external_no_charge' : paymentEffect,
        settlement: options.chargeWallet === false ? 'external_no_charge' : 'wallet_charged',
        chargedAmount: options.chargeWallet === false || paymentEffect === 'already_paid'
          ? 0 : baseBooking.user_payable_amount,
        currency: 'BDT', decisionId: 'synthetic-decision',
      }, error: options.rpcError ? { code: 'SYNTHETIC_RPC_ERROR' } : null };
    },
  };
  const route = compile(options.refresh ? 'app/api/flights/booking/shapon-status/route.ts'
    : 'app/api/flights/booking/confirm-external-ticket/route.ts', {
    '@/lib/references': references,
    'node:crypto': { randomUUID: () => nonce },
    zod: { z },
    '@/lib/dashboard/session': { getDashboardSession: async () => session },
    '@/lib/dashboard/booking-lifecycle': { canRefreshBookingSupplierDetails: role =>
      ['admin', 'superadmin', 'staff_account', 'staff_support'].includes(role) },
    '@/lib/dashboard/bookings': { bookingScopeFor: passed => {
      assert.equal(passed, session); return scope;
    } },
    '@/lib/db/flight-bookings': { readBookingByPublicRef: async (reference, passedScope) => {
      events.push('read-local');
      assert.equal(reference, booking?.public_ref ?? baseBooking.public_ref);
      assert.equal(passedScope, scope, 'The normal scoped booking reader remains in use');
      return booking;
    } },
    '@/lib/db/booking-ticketing-time': {
      saveBookingTicketingTime: forbidden,
      saveShapontravelsTicketingTime: async () => null,
    },
    '@/lib/shapontravels/ticketing-time': ticketingTime,
    '@/lib/db/booking-payment-resolution': {
      BOOKING_PAYMENT_EFFECTS: ['capture_hold', 'already_paid', 'charge_wallet'],
      previewShaponTicketPayment: async subject => {
        assert.deepEqual(plain(subject), {
          bookingId, actorUserId: session.clerkId, actorRole: session.role,
        });
        events.push('preview-payment');
        if (options.previewThrows) throw new Error('Synthetic payment preview unavailable');
        return paymentPreview;
      },
    },
    '@/lib/supabase/server': { supabaseAdmin: () => options.noDatabase ? null : db },
    '@/lib/rate-limit': { checkActionLimit: async action => {
      assert.equal(action, 'bookingReconciliationWrite');
      return options.rateLimit ? { ok: false, retryAfter: 60 } : { ok: true };
    } },
    '@/lib/shapontravels/client': client,
    '@/lib/shapontravels/booking-status': statusModule,
    '@/lib/shapontravels/current-status-store': { recordShapontravelsCurrentStatus: async record => {
      events.push('store-status');
      statusRecords.push(plain(record));
      assert.equal(record.bookingId, bookingId);
      assert.equal(record.expected.supplierPublicRef, supplierPublicRef);
      assert.equal(record.status.result, 'verified');
      return { currentStatusStorage: 'saved', projectionUpdated: options.locatorObservationWins !== false,
        airlinePnrsUpdated: Boolean(record.airlineLocatorRefresh) && options.locatorObservationWins !== false,
        displayStatus: 'unconfirmed', displayReviewRequired: true };
    } },
    '@/lib/shapontravels/ticket': ticket,
    '@/lib/shapontravels/cancel': cancellationAdapter,
    '@/lib/shapontravels/external-ticket-confirmation': external,
    '@/lib/shapontravels/cancellation-recovery': cancellation,
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
  const body = options.refresh ? {
    bookingReference: booking?.public_ref ?? baseBooking.public_ref, ...options.body,
  } : { bookingReference: booking?.public_ref ?? baseBooking.public_ref, requestId: nonce,
    chargeWallet: options.chargeWallet ?? true,
    expectedPaymentEffect: paymentEffect, expectedAmount: baseBooking.user_payable_amount / 100,
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
  assert.deepEqual(forbiddenCalls, [],
    'No test may call supplier sync/verify/reconcile/write endpoints or legacy financial mutations');
  if (options.refresh && result.status === 200) {
    assert.equal(result.data.lookupMode, 'shapon_saved_status');
    assert.equal(result.data.supplierSyncPerformed, false,
      'Every successful Refresh explicitly reports a saved-status read without supplier synchronization');
  }
  return { result, events, rpcCalls, audits, statusRecords, notifications, external };
}

function assertBlocked(outcome, message) {
  assert.ok(outcome.result.status >= 400, `${message}: expected refusal`);
  assert.equal(outcome.rpcCalls.length, 0, `${message}: cannot confirm or debit`);
  assert.equal(outcome.events.includes('confirm-rpc'), false, message);
}

for (const paymentEffect of ['charge_wallet', 'capture_hold', 'already_paid']) {
  const confirmed = await run({ paymentEffect });
  assert.equal(confirmed.result.status, 200);
  assert.deepEqual(confirmed.events, ['read-local', 'preview-payment', 'read-booking', 'read-ticket', 'confirm-rpc']);
  assert.equal(confirmed.rpcCalls.length, 1);
  assert.equal(confirmed.audits.length, 1);
  assert.equal(confirmed.audits[0].metadata.chargeWallet, true);
  assert.equal(confirmed.notifications, 1);
  assert.deepEqual(plain(confirmed.result.data), {
    confirmed: true, charged: paymentEffect !== 'already_paid',
    amount: paymentEffect === 'already_paid' ? 0 : 12345, currency: 'BDT', replay: false,
    paymentEffect,
  }, 'The canonical payment effect determines settlement; Admin cannot bypass payment');
}
const noCharge = await run({ chargeWallet: false });
assertBlocked(noCharge, 'A fresh no-charge choice is forbidden');
assert.equal(noCharge.result.code, 'PAYMENT_PREVIEW_REQUIRED');
assert.deepEqual(noCharge.events, ['read-local'], 'A no-charge bypass cannot read supplier data or dispatch a settlement');
for (const public_ref of ['KTT261010111116', 'KTTABC123', 'STR261010111116']) {
  assert.equal((await run({ booking: { public_ref } })).result.status, 200,
    'Confirmation retains the native KTT and saved legacy STR reference formats');
  assert.equal((await run({ refresh: true, booking: { public_ref } })).result.status, 200,
    'Supplier refresh uses the same booking reference contract');
}
const indigoTicketRead = plain(baseTicketRead);
const indigoPassengerTickets = [0, 1].map(() => ({
  ticketNumbers: ['XY1234'], ticketNumberSource: 'airline_pnr',
}));
indigoTicketRead.body.item1.ticketInfoes = indigoPassengerTickets;
assert.equal((await run({
  booking: { itinerary: { carrierCode: '6E', legs: [{ segments: [{ airlineCode: '6E' }] }] } },
  ticketRead: indigoTicketRead, expectedTicketNumbers: ['XY1234', 'XY1234'],
  expectedPassengerTickets: indigoPassengerTickets,
})).result.status, 200, 'Verified IndiGo receipt retains the supplier locator for every saved passenger');
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
  { body: { bookingReference: 'BDTI2610' } },
  { body: { bookingReference: 'BDTI261010ABCDEF' } },
  { body: { chargeWallet: undefined } },
  { body: { chargeWallet: 'true' } },
  { body: { chargeWallet: null } },
  { body: { expectedPaymentEffect: 'no_charge' } },
  { body: { expectedPaymentEffect: null } },
  { body: { expectedAmount: '12345' } },
  { body: { expectedAmount: 0 } },
  { body: { expectedAmount: Infinity } },
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
for (const body of [
  { expectedPaymentEffect: undefined }, { expectedAmount: undefined },
  { expectedPaymentEffect: undefined, expectedAmount: undefined },
]) {
  const missing = await run({ body });
  assertBlocked(missing, 'A fresh request requires its displayed payment preview');
  assert.equal(missing.result.code, 'PAYMENT_PREVIEW_REQUIRED');
  assert.deepEqual(missing.events, ['read-local']);
}
for (const options of [
  { body: { expectedPaymentEffect: 'capture_hold' } },
  { body: { expectedPaymentEffect: 'already_paid' } },
  { body: { expectedAmount: 12344.99 } },
  { body: { expectedAmount: 12345.001 } },
  { paymentPreview: { ok: false, code: 'STORAGE_UNAVAILABLE' } },
  { paymentPreview: { eligible: false } }, { paymentPreview: { currency: 'USD' } },
  { paymentPreview: { amount: 1234499 } }, { paymentPreview: { amount: 1234500.5 } },
]) {
  const stale = await run(options);
  assertBlocked(stale, 'Changed or unavailable accounting never reaches supplier proof or settlement');
  assert.equal(stale.result.code, 'PAYMENT_PREVIEW_CHANGED');
  assert.deepEqual(stale.events, ['read-local', 'preview-payment']);
}
const previewUnavailable = await run({ previewThrows: true });
assertBlocked(previewUnavailable, 'A thrown preview read cannot dispatch a settlement');
assert.deepEqual(previewUnavailable.events, ['read-local', 'preview-payment']);
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
  { operation_kind: 'ticketing', operation_reason: 'ticketing' },
  { active_operation_id: nonce },
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
for (const changes of [
  { payment_state: 'refunded' }, { refunded_amount: 1 }, { captured_amount: 1 },
  { ticket_code_ref: 'unmatched-local-ticket' }, { ticket_numbers: ['unmatched-ticket'] },
  { ticket_numbers: 'invalid-local-ticket-shape' },
]) {
  const blocked = await run({ booking: changes,
    paymentPreview: { ok: false, eligible: false, code: 'PAYMENT_ACCOUNTING_CONFLICT' } });
  assertBlocked(blocked, 'Canonical accounting rejects conflicting local financial or ticket history');
  assert.equal(blocked.result.code, 'PAYMENT_PREVIEW_CHANGED');
  assert.deepEqual(blocked.events, ['read-local', 'preview-payment']);
}
for (const changes of [
  { payment_state: 'captured', captured_amount: 1234500, ticket_code_ref: ticketCodeRef,
    ticket_numbers: ['1234567890123', '1234567890124'], issued_at: '2026-10-10T05:11:16Z' },
  { status: 'in-progress', lifecycle_status: 'in-progress', payment_state: 'captured',
    captured_amount: 1234500, operation_kind: 'reconciliation', operation_reason: 'ticketing_reconciliation',
    active_operation_id: nonce, operation_request_id: 'original-issue',
    ticket_code_ref: ticketCodeRef, ticket_numbers: ['1234567890123', '1234567890124'] },
]) {
  const paid = await run({ booking: changes, paymentEffect: 'already_paid' });
  assert.equal(paid.result.status, 200, 'A canonically paid nonterminal booking can finish its existing ticket');
  assert.equal(paid.result.data.paymentEffect, 'already_paid');
  assert.equal(paid.result.data.charged, false);
  assert.equal(paid.result.data.amount, 0);
  assert.equal(paid.rpcCalls[0].p_charge_wallet, true, 'The original payment is mandatory and reused');
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
const numericWithoutAirlinePnr = plain(baseTicketRead);
delete numericWithoutAirlinePnr.body.item1.airlinesPNR;
const numericRecovery = await run({ ticketRead: numericWithoutAirlinePnr });
assert.equal(numericRecovery.result.status, 200);
assert.deepEqual(numericRecovery.rpcCalls[0].p_ticket_proof.airlinesPnr, [],
  'Valid numeric recovery must keep the airline locator empty when only a reservation PNR is present');
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
    body: { expectedPaymentEffect: undefined, expectedAmount: undefined },
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
const historicalChargedWithoutEffect = await run({ existingRequest: true,
  body: { expectedPaymentEffect: undefined, expectedAmount: undefined },
  rpcResult: { ...successfulRpcResult, replay: true, paymentEffect: undefined },
  bookingReadThrows: true, ticketReadThrows: true,
});
assert.equal(historicalChargedWithoutEffect.result.status, 200,
  'An older charged commit may replay without manufacturing a new payment preview');
assert.equal(historicalChargedWithoutEffect.result.data.charged, true);
assert.deepEqual(historicalChargedWithoutEffect.events, ['read-local', 'confirm-rpc']);
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
  ['charged amount differs from approved payable', { chargedAmount: 1 }, true],
  ['positive amount differs from pinned preview', { chargedAmount: 1 }, true],
  ['charge choice with no debit', { chargedAmount: 0 }, true],
  ['no charge choice with debit', { chargeWallet: false, chargedAmount: 1 }, false],
  ['payment effect missing', { paymentEffect: undefined }, true],
  ['payment effect malformed', { paymentEffect: 'no_charge' }, true],
  ['payment effect changed', { paymentEffect: 'capture_hold' }, true],
  ['currency mismatch', { currency: 'USD' }, true],
  ['currency missing', { currency: undefined }, true],
]) {
  const historical = chargeWallet === false;
  const unknown = await run({ chargeWallet,
    ...(historical ? { existingRequest: true,
      body: { expectedPaymentEffect: undefined, expectedAmount: undefined } } : {}),
    rpcResult: { ...successfulRpcResult, ...(historical ? { replay: true } : {}), ...changes },
  });
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
    eligible: true, amount: 12345, currency: 'BDT', paymentEffect: 'charge_wallet', existingHoldAmount: 0,
  }, 'A paid supplier ticket exposes the canonical payment preview after an Admin refresh');
  assert.deepEqual(plain(refreshed.result.data.supplierTicket), {
    result: 'verified', ticketCount: 2, ticketCodeRef,
  });
  assert.deepEqual(refreshed.events, ['read-local', 'read-booking', 'store-status', 'read-ticket', 'preview-payment']);
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

const recoveryBooking = {
  status: 'in-progress', lifecycle_status: 'in-progress', payment_state: 'reconciliation',
  operation_kind: 'reconciliation', operation_reason: 'ticketing_reconciliation',
  active_operation_id: nonce, operation_request_id: 'original-issue',
};
for (const paymentEffect of ['capture_hold', 'already_paid']) {
  const recovered = await run({ booking: { ...recoveryBooking,
    ...(paymentEffect === 'already_paid' ? { payment_state: 'captured', captured_amount: 1234500 } : {}),
  }, paymentEffect });
  assert.equal(recovered.result.status, 200);
  assert.equal(recovered.result.data.charged, paymentEffect !== 'already_paid');
  assert.equal(recovered.rpcCalls.length, 1);
  assert.equal(recovered.rpcCalls[0].p_charge_wallet, true);
  assert.equal(recovered.events.includes('preview-payment'), true);
}
const recoveryPreview = await run({ refresh: true, booking: recoveryBooking });
assert.equal(recoveryPreview.result.status, 200);
assert.deepEqual(plain(recoveryPreview.result.data.externalTicketConfirmation), {
  eligible: true, amount: 12345, currency: 'BDT', recovery: true, existingHoldAmount: 12345,
  paymentEffect: 'capture_hold',
});
assert.equal(recoveryPreview.rpcCalls.length, 0, 'Ticket refresh waits for explicit Admin confirmation');
for (const refresh of [false, true]) {
  const blocked = await run({ refresh, booking: recoveryBooking,
    paymentPreview: { ok: false, eligible: false, code: 'PAYMENT_ACCOUNTING_CONFLICT' } });
  assert.equal(blocked.rpcCalls.length, 0, 'A conflicting case or unavailable hold never reaches settlement');
  if (refresh) assert.equal(blocked.result.data.externalTicketConfirmation, null);
  else assert.equal(blocked.result.code, 'PAYMENT_PREVIEW_CHANGED');
}

const cancelledReceipt = {
  ...plain(baseBookingRead.body),
  item1: { ...plain(baseBookingRead.body.item1), bookingStatus: 'Cancelled',
    ticketCodeRef: null, ticketInfoes: [] },
  currentStatus: { status: 'cancelled', reviewRequired: false },
  requiresReconciliation: false,
  publicReceipt: { ...publicReceipt, status: 'cancelled', paymentState: 'unpaid',
    cancelledAt: null },
};
const cancellationBooking = {
  ...recoveryBooking, payment_state: 'unpaid', operation_reason: 'cancellation_reconciliation',
  payment_amount: null, charged_wallet_account_id: null,
};
const cancelledRead = { ...plain(baseBookingRead), body: cancelledReceipt };
const cancelledTicketRead = { httpStatus: 200, body: plain(cancelledReceipt) };
for (const role of ['admin', 'superadmin']) {
  const cancelled = await run({ refresh: true, session: { ...admin, role },
    booking: cancellationBooking, bookingRead: cancelledRead, ticketRead: cancelledTicketRead });
  assert.equal(cancelled.result.status, 200);
  assert.equal(cancelled.result.data.cancellationResolved, true);
  assert.equal(cancelled.result.data.displayStatus, 'cancelled');
  assert.equal(cancelled.result.data.externalTicketConfirmation, null);
  assert.equal(cancelled.result.data.supplierTicket, null);
  assert.equal(cancelled.result.data.supplierCancellation, null,
    'A successful legacy cancellation clears any earlier inconclusive saved cancellation diagnostic');
  assert.equal(cancelled.rpcCalls.length, 1);
  assert.equal(cancelled.notifications, 1);
}
for (const options of [
  { session: { ...admin, role: 'staff_support' } },
  { session: { ...admin, role: 'staff_account' } },
  { booking: { ...cancellationBooking, captured_amount: 1 } },
  { booking: { ...cancellationBooking, payment_state: 'reconciliation' } },
  { ticketRead: { ...cancelledTicketRead, httpStatus: 404 } },
  { ticketRead: { ...cancelledTicketRead, body: { ...plain(cancelledReceipt),
    item1: { ...plain(cancelledReceipt.item1), ticketInfoes: [{ ticketNumbers: ['1234567890123'] }] } } } },
  { ticketRead: { ...cancelledTicketRead, body: { ...plain(cancelledReceipt),
    requiresReconciliation: true } } },
  { ticketRead: { ...cancelledTicketRead, body: { ...plain(cancelledReceipt),
    publicReceipt: { ...plain(cancelledReceipt.publicReceipt), issuedAt: '2026-11-02T10:00:00Z' } } } },
  { ticketRead: { ...cancelledTicketRead, body: { ...plain(cancelledReceipt),
    publicReceipt: { ...plain(cancelledReceipt.publicReceipt), paymentState: 'paid' } } } },
]) {
  const rejected = await run({ refresh: true, booking: cancellationBooking,
    bookingRead: cancelledRead, ticketRead: cancelledTicketRead, ...options });
  assert.equal(rejected.rpcCalls.length, 0, 'Only Admin verified unticketed/unpaid cancellation can close');
  assert.equal(rejected.notifications, 0);
}
const failedCancellation = await run({ refresh: true, booking: cancellationBooking,
  bookingRead: cancelledRead, ticketRead: cancelledTicketRead,
  cancellationResult: { ok: false, code: 'BOOKING_CONFIRMATION_CONFLICT' } });
assert.equal(failedCancellation.result.data.cancellationResolved, undefined);
assert.equal(failedCancellation.notifications, 0);

// Synthetic canonical-v1 fixture mirrors the supplier's saved-status contract:
// wrappers are present, legacy item1 omits tickets, savedBooking is authoritative.
// This fixture has no live booking, passenger or financial data.
const canonicalFixture = JSON.parse(fs.readFileSync(new URL(
  'fixtures/shapontravels-saved-booking-v1/cancelled.json', import.meta.url,
), 'utf8'));
let canonicalText = JSON.stringify(canonicalFixture);
for (const [from, to] of [
  [canonicalFixture.savedBooking.bookingCodeRef, refs.bookingCodeRef],
  [canonicalFixture.savedBooking.uniqueTransID, refs.uniqueTransId],
  [canonicalFixture.savedBooking.itemCodeRef, refs.itemCodeRef],
  [canonicalFixture.savedBooking.priceCodeRef, refs.priceCodeRef],
  [canonicalFixture.savedBooking.reference, supplierPublicRef],
  [canonicalFixture.savedBooking.pnr, refs.pnr],
]) canonicalText = canonicalText.split(from).join(to);
const canonicalCancelled = JSON.parse(canonicalText);
const savedCheckedAt = '2026-11-01T02:22:34.748635+00:00';
canonicalCancelled.currentStatus = {
  reviewRequired: false, source: 'supplier_sync', status: 'cancelled',
  supplierCheckedAt: savedCheckedAt, supplierStatus: 'Cancelled', verified: true,
};
canonicalCancelled.savedBooking.currentStatus = plain(canonicalCancelled.currentStatus);
const canonicalCancelledRead = { httpStatus: 200, supplierPublicRef, body: canonicalCancelled };
const noSavedIssue = { httpStatus: 404, body: { error: 'NOT_FOUND' } };
for (const role of ['admin', 'superadmin']) {
  const cancelled = await run({ refresh: true, session: { ...admin, role },
    booking: cancellationBooking, bookingRead: canonicalCancelledRead, ticketRead: noSavedIssue });
  assert.equal(cancelled.result.status, 200);
  assert.equal(cancelled.result.data.cancellationResolved, true,
    'Valid canonical-v1 saved cancellation closes the original unpaid reconciliation');
  assert.equal(cancelled.result.data.displayStatus, 'cancelled');
  assert.equal(cancelled.result.data.externalTicketConfirmation, null);
  assert.equal(cancelled.result.data.supplierTicket, null);
  assert.deepEqual(cancelled.events, ['read-local', 'read-booking', 'store-status', 'cancel-recovery-rpc'],
    'Saved canonical cancellation needs no ticket lookup, supplier sync, payment preview or charge');
  assert.equal(cancelled.rpcCalls.length, 1);
  assert.equal(cancelled.notifications, 1);
  assert.equal(cancelled.statusRecords[0].status.currentStatusState, 'available');
  assert.equal(cancelled.statusRecords[0].status.currentStatus.source, 'supplier_sync');
  assert.equal(cancelled.statusRecords[0].status.currentStatus.supplierCheckedAt, savedCheckedAt,
    'Refresh preserves the supplier check timestamp from the saved status');
  assert.equal(cancelled.rpcCalls[0].p_cancellation_proof.source, 'supplier_booking_details');
  assert.equal(cancelled.rpcCalls[0].p_cancellation_proof.ticketCount, 0);
}
const wrapperlessCancelled = plain(canonicalCancelledRead);
delete wrapperlessCancelled.body.item1;
delete wrapperlessCancelled.body.item2;
assert.equal((await run({ refresh: true, booking: cancellationBooking,
  bookingRead: wrapperlessCancelled, ticketReadThrows: true })).result.data.cancellationResolved, true,
'A valid wrapperless canonical cancellation also never requires ticket transport');

for (const [description, mutate] of [
  ['saved paid state', body => { body.savedBooking.paymentState = 'paid'; }],
  ['receipt paid state', body => { body.publicReceipt.paymentState = 'paid';
    body.savedBooking.publicReceipt = plain(body.publicReceipt); }],
  ['saved captured payment', body => { body.savedBooking.payment.state = 'captured'; }],
  ['saved issuance', body => { body.savedBooking.issuedAt = '2026-11-02T10:00:00Z'; }],
  ['saved tickets', body => { body.savedBooking.ticketInfoes = [{ ticketNumbers: ['1234567890123'] }]; }],
  ['saved ticket locator', body => { body.savedBooking.ticketCodeRef = ticketCodeRef; }],
  ['unresolved saved operation', body => { body.savedBooking.requiresReconciliation = true; }],
  ['unresolved top operation', body => { body.requiresReconciliation = true; }],
  ['review needed', body => { body.currentStatus.reviewRequired = true;
    body.savedBooking.currentStatus = plain(body.currentStatus); }],
  ['pending receipt review', body => { body.publicReceipt.pendingReview = true;
    body.savedBooking.publicReceipt = plain(body.publicReceipt); }],
  ['saved identity mismatch', body => { body.savedBooking.bookingCodeRef = nonce; }],
  ['saved public ref mismatch', body => { body.savedBooking.reference = 'STRFOREIGN123'; }],
  ['saved PNR mismatch', body => { body.savedBooking.pnr = 'OTHER1'; }],
  ['saved status mismatch', body => { body.savedBooking.status = 'on-hold'; }],
  ['incomplete canonical object', body => { delete body.savedBooking.payment; }],
  ['wrong canonical schema', body => { body.savedBooking.schemaVersion = 2; }],
  ['explicit legacy ticket conflict', body => { body.item1.ticketInfoes = [{ ticketNumbers: ['1234567890123'] }]; }],
  ['explicit legacy issuance conflict', body => { body.item1.issuedAt = '2026-11-02T10:00:00Z'; }],
  ['explicit legacy status conflict', body => { body.item1.bookingStatus = 'Created'; }],
  ['explicit legacy PNR conflict', body => { body.item1.pnr = 'OTHER1'; }],
  ['failed legacy wrapper', body => { body.item2.isSuccess = false; }],
]) {
  const bookingRead = plain(canonicalCancelledRead);
  mutate(bookingRead.body);
  const refused = await run({ refresh: true, booking: cancellationBooking,
    bookingRead, ticketRead: noSavedIssue });
  assert.equal(refused.rpcCalls.length, 0, `${description}: no cancellation or financial commit`);
  assert.equal(refused.notifications, 0, description);
  assert.notEqual(refused.result.data?.cancellationResolved, true,
    `${description}: ticket NOT_FOUND cannot repair contradictory canonical cancellation evidence`);
}
for (const changes of [
  { captured_amount: 1 }, { refunded_amount: 1 }, { payment_amount: 0 }, { payment_amount: 1 },
  { payment_state: 'captured' }, { payment_state: 'reconciliation' },
  { charged_wallet_account_id: nonce }, { active_operation_id: null },
  { operation_reason: 'ticketing_reconciliation' }, { ticket_numbers: ['1234567890123'] },
]) {
  const refused = await run({ refresh: true, booking: { ...cancellationBooking, ...changes },
    bookingRead: canonicalCancelledRead, ticketRead: noSavedIssue });
  assert.equal(refused.rpcCalls.length, 0, 'Conflicting local payment/operation/ticket evidence cannot close cancellation');
  assert.equal(refused.notifications, 0);
}
for (const role of ['staff_support', 'staff_account']) {
  const observed = await run({ refresh: true, session: { ...admin, role },
    booking: cancellationBooking, bookingRead: canonicalCancelledRead, ticketRead: noSavedIssue });
  assert.equal(observed.result.status, 200);
  assert.equal(observed.rpcCalls.length, 0, 'Staff can read saved status but cannot finalize cancellation');
  assert.equal(observed.notifications, 0);
  assert.notEqual(observed.result.data.cancellationResolved, true);
}
for (const session of [null, { ...admin, role: 'customer' }, { ...admin, role: 'b2b' }]) {
  const denied = await run({ refresh: true, session, booking: cancellationBooking,
    bookingRead: canonicalCancelledRead, ticketRead: noSavedIssue });
  assert.equal(denied.result.status, session ? 403 : 401);
  assert.deepEqual(denied.events, [], 'Unauthorized Refresh cannot inspect saved supplier data');
  assert.equal(denied.rpcCalls.length, 0);
}
for (const body of [
  { sync: true }, { verify: true }, { reconcile: true }, { requestId: nonce },
  { chargeWallet: true }, { amount: 1 }, { supplierPublicRef: 'STRFOREIGN123' },
]) {
  const denied = await run({ refresh: true, body, booking: cancellationBooking,
    bookingRead: canonicalCancelledRead, ticketRead: noSavedIssue });
  assert.equal(denied.result.status, 400, 'Refresh accepts only a booking reference, never extra action or identity flags');
  assert.deepEqual(denied.events, []);
  assert.equal(denied.rpcCalls.length, 0);
}
for (const cancellationResult of [
  { ok: false, code: 'BOOKING_CONFIRMATION_CONFLICT' }, { ok: 'true' }, {}, null,
]) {
  const refused = await run({ refresh: true, booking: cancellationBooking,
    bookingRead: canonicalCancelledRead, ticketReadThrows: true, cancellationResult });
  assert.equal(refused.result.data.cancellationResolved, undefined);
  assert.equal(refused.notifications, 0);
  assert.equal(refused.events.includes('read-ticket'), false,
    'A refused canonical cancellation commit cannot trigger supplier verification or further transport');
  assert.equal(refused.rpcCalls.length, 1);
}

// Kaligonj's existing saved cancellation diagnostics remain available for
// protected/legacy operations even when the new canonical close path cannot run.
const cancellationReceipt = {
  item1: { ...receiptIdentity, isCancel: true }, item2: { isSuccess: true },
};
for (const [httpStatus, expected] of [[200, 'verified'], [202, 'pending'], [404, 'not_found']]) {
  const observed = await run({ refresh: true, session: { ...admin, role: 'staff_support' },
    booking: cancellationBooking, bookingRead: cancelledRead, ticketReadThrows: true,
    cancellationRead: { httpStatus, body: cancellationReceipt } });
  assert.equal(observed.result.status, 200);
  assert.equal(observed.result.data.supplierCancellation.result, expected);
  assert.equal(observed.events.includes('read-cancellation'), true);
  assert.equal(observed.events.includes('read-ticket'), false,
    'Cancellation diagnostic staff never enter the ticket confirmation lane');
  assert.equal(observed.rpcCalls.length, 0,
    'A saved cancellation diagnostic cannot bypass Admin finalization authority');
}
for (const options of [
  { cancellationReadThrows: true },
  { cancellationRead: { httpStatus: 200, body: { ...cancellationReceipt,
    item1: { ...receiptIdentity, isCancel: true, pnr: 'OTHER1' } } } },
]) {
  const observed = await run({ refresh: true, session: { ...admin, role: 'staff_account' },
    booking: cancellationBooking, bookingRead: cancelledRead, ...options });
  assert.equal(observed.rpcCalls.length, 0);
  assert.ok(['unverified', 'unavailable'].includes(observed.result.data.supplierCancellation.result));
}

// Successful legacy wrappers cannot conceal conflicting canonical saved data
// in either of the independent authenticated reads used for a financial commit.
const issuedFixture = JSON.parse(fs.readFileSync(new URL(
  'fixtures/shapontravels-saved-booking-v1/issued.json', import.meta.url,
), 'utf8'));
let issuedText = JSON.stringify(issuedFixture);
for (const [from, to] of [
  [issuedFixture.savedBooking.bookingCodeRef, refs.bookingCodeRef],
  [issuedFixture.savedBooking.uniqueTransID, refs.uniqueTransId],
  [issuedFixture.savedBooking.itemCodeRef, refs.itemCodeRef],
  [issuedFixture.savedBooking.priceCodeRef, refs.priceCodeRef],
  [issuedFixture.savedBooking.reference, supplierPublicRef],
  [issuedFixture.savedBooking.pnr, refs.pnr],
  [issuedFixture.savedBooking.ticketCodeRef, ticketCodeRef],
  ['7790000000001', '1234567890123'], ['7790000000002', '1234567890124'],
]) issuedText = issuedText.split(from).join(to);
const canonicalIssued = JSON.parse(issuedText);
canonicalIssued.item1.ticketInfoes.sort((left, right) => left.passengerIndex - right.passengerIndex);
const canonicalIssuedRead = { httpStatus: 200, supplierPublicRef, body: canonicalIssued };
const canonicalIssuedTicket = { httpStatus: 200, body: plain(canonicalIssued) };
const validCanonicalConfirmation = await run({ bookingRead: canonicalIssuedRead,
  ticketRead: canonicalIssuedTicket, expectedIssuedAt: canonicalIssued.publicReceipt.issuedAt });
assert.equal(validCanonicalConfirmation.result.status, 200,
  'Matching complete canonical saved data and legacy wrappers retain valid confirmation support');
assert.equal(validCanonicalConfirmation.rpcCalls.length, 1);
for (const field of ['bookingRead', 'ticketRead']) {
  for (const [description, mutate] of [
    ['null canonical', body => { body.savedBooking = null; }],
    ['incomplete canonical', body => { body.savedBooking = {}; }],
    ['wrong schema', body => { body.savedBooking.schemaVersion = 2; }],
    ['foreign saved public reference', body => { body.savedBooking.reference = 'STRFOREIGN123'; }],
    ['foreign saved booking identity', body => { body.savedBooking.bookingCodeRef = nonce; }],
    ['unresolved saved review', body => { body.savedBooking.reviewRequired = true; }],
    ['contradictory saved payment', body => { body.savedBooking.paymentState = 'unpaid'; }],
    ['contradictory saved tickets', body => { body.savedBooking.ticketInfoes[0].ticketNumbers = ['1234567890125']; }],
    ['contradictory canonical passenger snapshot', body => {
      body.savedBooking.passengerInfoes[0].nameElement.lastName = 'DifferentSnapshot';
    }],
    ['contradictory canonical itinerary snapshot', body => {
      body.savedBooking.segments[0].flightNumber = '999';
    }],
  ]) {
    const changed = plain(field === 'bookingRead' ? canonicalIssuedRead : canonicalIssuedTicket);
    mutate(changed.body);
    const blocked = await run({ bookingRead: canonicalIssuedRead, ticketRead: canonicalIssuedTicket,
      [field]: changed });
    assertBlocked(blocked, `${field}: ${description} cannot be bypassed through a successful legacy wrapper`);
  }
}

const airlineLocatorRead = plain(baseBookingRead);
airlineLocatorRead.body.item1.airlinesPNR = ['AIR001', 'AIR002'];
const legacyLocatorBooking = {
  status: 'confirmed', lifecycle_status: 'confirmed', ticket_code_ref: ticketCodeRef,
  airlines_pnr: [refs.pnr], shapon_unverified_airline_pnr: refs.pnr,
  updated_at: '2026-10-10T05:11:16.123456+00:00',
};
for (const locatorObservationWins of [true, false]) {
  const refreshed = await run({ refresh: true, booking: legacyLocatorBooking,
    bookingRead: airlineLocatorRead, locatorObservationWins });
  assert.equal(refreshed.result.status, 200);
  assert.equal(refreshed.result.data.airlinePnrsUpdated, locatorObservationWins);
  assert.deepEqual(refreshed.statusRecords[0].airlineLocatorRefresh, {
    locators: ['AIR001', 'AIR002'], bookingUpdatedAt: legacyLocatorBooking.updated_at,
  });
}
const knownLocator = await run({ refresh: true, booking: {
  ...legacyLocatorBooking, shapon_unverified_airline_pnr: null,
}, bookingRead: airlineLocatorRead });
assert.equal(knownLocator.statusRecords[0].airlineLocatorRefresh, undefined,
  'An explicitly verified Airline PNR equal to the reservation is preserved');
const conflictingLocatorRead = plain(canonicalIssuedRead);
conflictingLocatorRead.body.savedBooking.airlinesPNR = ['WRONG1'];
conflictingLocatorRead.body.item1.airlinesPNR = ['AIR001'];
conflictingLocatorRead.body.publicReceipt.airlinePnrs = ['AIR001'];
conflictingLocatorRead.body.savedBooking.publicReceipt.airlinePnrs = ['AIR001'];
const conflictingLocator = await run({ refresh: true, booking: legacyLocatorBooking,
  bookingRead: conflictingLocatorRead });
assert.equal(conflictingLocator.result.status, 200);
assert.equal(conflictingLocator.result.data.currentStatusStorage, 'saved');
assert.equal(conflictingLocator.statusRecords[0].airlineLocatorRefresh, undefined,
  'Contradictory Airline PNR fields cannot overwrite a saved locator');

console.log('Shapon confirmation/Refresh: scoped saved GETs only, supplier_sync canonical cancelled recovery without ticket lookup, ordered Airline PNR correction, strict conflicts, mandatory payment and durable explicit confirmation retries passed');
