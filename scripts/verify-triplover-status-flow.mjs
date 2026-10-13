import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';

// Execute the actual validators, supplier-read service, RPC adapter and API
// routes. All supplier and storage boundaries are offline doubles; any unknown
// import or external HTTP operation fails this verifier immediately.
const require = createRequire(import.meta.url);
const root = process.cwd();
let assertions = 0;
const plain = value => JSON.parse(JSON.stringify(value));
const copy = value => structuredClone(value);
function check(actual, expected, message) {
  assert.deepEqual(plain(actual), plain(expected), message);
  assertions += 1;
}
function compile(file, overrides = {}) {
  const absolute = path.resolve(root, file);
  const module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  new vm.Script(output, { filename: file }).runInNewContext({
    module, exports: module.exports, Date, Error, Buffer, URL, Object,
    console: { error() {}, warn() {}, log() {} },
    fetch: async () => { throw new Error('External HTTP is forbidden'); },
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name === 'server-only' || name === 'next/server') return {};
      if (name === 'zod') return { z };
      if (name === 'crypto' || name === 'node:crypto') return require('node:crypto');
      const local = name.startsWith('@/') ? path.resolve(root, name.slice(2)) :
        name.startsWith('.') ? path.resolve(path.dirname(absolute), name) : null;
      assert.ok(local, `Unexpected external import ${name} from ${file}`);
      const resolved = ['.ts', '.tsx', '/index.ts'].map(extension => `${local}${extension}`)
        .find(candidate => fs.existsSync(candidate));
      assert.ok(resolved, `Missing local import ${name} from ${file}`);
      return compile(resolved);
    },
  });
  return module.exports;
}

const bookingId = '11111111-1111-4111-8111-111111111111';
const checkId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const bookingReference = 'KTT261013111114';
const snapshotHash = 'a'.repeat(64);
const previewHash = 'b'.repeat(64);
const payloadHash = 'c'.repeat(64);
const admin = { clerkId: 'synthetic-admin', role: 'admin' };
const names = [
  { firstName: 'ALPHA', lastName: 'ONE' },
  { firstName: 'BRAVO', lastName: 'TWO' },
  { firstName: 'CHARLIE', lastName: 'THREE' },
];
const segments = [
  { from: 'CAN', to: 'CCU', airlineCode: '6E', flightNumber: '1704', bookingClass: 'X', cabinClass: '',
    departure: '2026-10-16 01:20:00', arrival: '2026-10-16 03:50:00' },
  { from: 'CCU', to: 'DAC', airlineCode: '6E', flightNumber: '1105', bookingClass: 'X', cabinClass: '',
    departure: '2026-10-16 13:30:00', arrival: '2026-10-16 15:10:00' },
];
const perPerson = { basePrice: 20000, taxes: 4300, ait: 181.88, totalPrice: 24481.88 };
const supplierTotal = 73445.64;
const baseBooking = {
  id: bookingId, public_ref: bookingReference, attempt_id: 'saved-attempt',
  supplier: 'triplover', supplier_account: 'triplover', legacy_operational: false,
  import_source: null, direct_ticketing: false, audience: 'agency', currency: 'BDT',
  status: 'in-progress', lifecycle_status: 'in-progress', payment_state: 'reconciliation',
  operation_kind: 'ticketing', operation_reason: 'ticketing_reconciliation',
  pnr: 'ABC123', booking_ref_number: 'BOOK456', booking_code_ref: 'saved-booking-code',
  supplier_refs: { uniqueTransId: 'TLL-synthetic-saved-transaction', itemCodeRef: 'saved-item', priceCodeRef: 'saved-price' },
  passenger_counts: { ADT: 3 }, airlines_pnr: ['ABC123'],
  passengers: { travellers: names.map(name => ({ ...name, passengerType: 'ADT' })) },
  itinerary: { carrierCode: '6E', carrierName: 'IndiGo', refundable: false,
    legs: [{ from: 'CAN', to: 'DAC', segments: copy(segments) }] },
  // Commercial fare rows do not recreate the raw per-person supplier base.
  fares: [{ passengerType: 'ADT', count: 3, basePrice: 60000, taxes: 12900, ait: 545.64,
    serviceMargin: 900, totalPrice: supplierTotal + 900 }],
  pricing_snapshot: { supplierTotalPrice: supplierTotal, grossPrice: supplierTotal, sellingPrice: supplierTotal + 900 },
  user_payable_amount: 7434564, captured_amount: 0, refunded_amount: 0,
};

function pnrResponse(booking = baseBooking) {
  return {
    status: 'Active', pnr: booking.pnr, uniqueTransID: booking.supplier_refs.uniqueTransId,
    itemCodeRef: booking.supplier_refs.itemCodeRef, priceCodeRef: booking.supplier_refs.priceCodeRef,
    bookingCodeRef: booking.booking_code_ref,
  };
}
function ticketReport(booking = baseBooking, numeric = false) {
  const carrier = booking.itinerary.carrierCode;
  return {
    ticketInfo: { status: 'Issued', statusFor: 'Ticket', isPaid: true, isCompleted: true,
      issueDate: '2026-10-13T21:05:33', uniqueTransID: booking.supplier_refs.uniqueTransId,
      pnr: booking.pnr, itemCodeRef: booking.supplier_refs.itemCodeRef,
      ticketingPrice: supplierTotal, airlinePNRs: ['ABC123'],
      ...(numeric ? { ticketCodeRef: 'saved-ticket-workflow-code' } : {}) },
    passengerInfo: names.map((person, index) => ({
      first: person.firstName, last: person.lastName, passengerType: 'ADT', passengerCount: 3,
      basePrice: perPerson.basePrice, tax: perPerson.taxes, ait: perPerson.ait,
      totalPrice: perPerson.totalPrice, pnr: booking.pnr,
      uniqueTransID: booking.supplier_refs.uniqueTransId, currencyName: 'BDT',
      ticketNumbers: numeric ? `${1234567890123 + index}` : 'ABC123', ticketNumber: null,
    })),
    segments: segments.map(segment => ({
      origin: segment.from, destination: segment.to, operationCarrier: carrier,
      flightNumber: segment.flightNumber, bookingCode: segment.bookingClass,
      departure: segment.departure, arrival: segment.arrival, cabinClass: 'Economy', airlinePNRs: ['ABC123'],
    })),
  };
}

function serviceHarness(options = {}, booking = copy(baseBooking)) {
  const calls = [];
  const client = {
    async triploverCall(operation, requestPath, payload, requestOptions) {
      calls.push({ operation, path: requestPath, payload: plain(payload), options: plain(requestOptions) });
      assert.ok(['Pnr', 'AirTicketingDetails'].includes(operation), `${operation} must never be dispatched`);
      if (operation === 'Pnr') {
        if (options.pnrFails) throw new Error('Synthetic PNR unavailable');
        return { data: copy(options.pnr ?? pnrResponse(booking)), receipt: { rawPayloadHash: payloadHash } };
      }
      if (options.reportFails) throw new Error('Synthetic report unavailable');
      return { data: copy(options.report ?? ticketReport(booking)), receipt: { rawPayloadHash: payloadHash } };
    },
  };
  const service = compile('lib/triplover/supplier-status.ts', { '@/lib/triplover/client': client });
  return { service, calls, booking };
}
async function serviceRun(options = {}, booking = copy(baseBooking)) {
  const h = serviceHarness(options, booking);
  const before = copy(booking);
  const facts = await h.service.readTriploverSupplierStatus(booking);
  check(booking, before, 'Supplier read must leave the entire local booking and financial snapshot unchanged');
  check(h.calls.map(call => call.operation).sort(), ['AirTicketingDetails', 'Pnr'], 'Status verification only uses safe reads');
  return { ...h, facts };
}

const issued = await serviceRun();
check({ verified: issued.facts.verified, status: issued.facts.verifiedStatus, source: issued.facts.source },
  { verified: true, status: 'issued', source: 'ticket_report' }, 'Active PNR plus complete issued report verifies issuance');
check(issued.facts.tickets, names.map((_, passengerIndex) => ({ passengerIndex, ticketNumbers: ['ABC123'] })),
  'Three individually named ADTs retain three shared PNR slots, even when each report row declares passengerCount:3');
check(issued.facts.supplierPayableMinor, 7344564, 'Named rows are counted once and bound to the saved supplier payable');
check(issued.facts.ticketCodeRef, null, 'Missing supplier workflow code is never invented');
check(issued.facts.issuedAt, '2026-10-13T15:05:33.000Z', 'Naive supplier issue time uses the Bangladesh contract');
check(issued.calls.find(call => call.operation === 'Pnr').payload, {
  PNR: baseBooking.pnr, BookingRefNumber: baseBooking.booking_ref_number,
  UniqueTransID: baseBooking.supplier_refs.uniqueTransId, PriceCodeRef: baseBooking.supplier_refs.priceCodeRef,
  ItemCodeRef: baseBooking.supplier_refs.itemCodeRef, BookingCodeRef: baseBooking.booking_code_ref,
}, 'Safe PNR read uses the six immutable saved supplier references');

const reversed = ticketReport(); reversed.passengerInfo.reverse();
check((await serviceRun({ report: reversed })).facts.tickets, issued.facts.tickets, 'Supplier row order does not change passenger slots');
check((await serviceRun({ reportFails: true })).facts.verified, false, 'Active alone never establishes ticket issuance');
check((await serviceRun({ reportFails: true, pnrFails: true })).facts.reason, 'SUPPLIER_UNAVAILABLE', 'Complete supplier failure remains undecided');
check((await serviceRun({ pnr: { ...pnrResponse(), pnr: 'WRONG1' } })).facts.reason, 'SUPPLIER_IDENTITY_MISMATCH', 'A conflicting PNR blocks even a complete ticket report');
check((await serviceRun({ pnr: { ...pnrResponse(), status: 'Cancelled' } })).facts.reason, 'SUPPLIER_STATUS_CONFLICT', 'Cancelled PNR conflicts with an issued report');
for (const flag of ['isCancelled', 'isCanceled', 'isRefunded', 'isVoided']) {
  check((await serviceRun({ pnr: { ...pnrResponse(), [flag]: true } })).facts.verified,
    false, `${flag} on an Active PNR conflicts with independently issued report proof`);
}

for (const [name, mutate] of [
  ['wrong transaction', report => { report.ticketInfo.uniqueTransID = 'wrong-transaction'; }],
  ['wrong passenger', report => { report.passengerInfo[0].last = 'WRONG'; }],
  ['duplicated passenger', report => { report.passengerInfo[1] = copy(report.passengerInfo[0]); }],
  ['missing passenger', report => { report.passengerInfo.pop(); }],
  ['wrong flight', report => { report.segments[0].flightNumber = '9999'; }],
  ['wrong operating carrier', report => { report.segments[0].operationCarrier = 'BG'; }],
  ['wrong locator', report => { report.ticketInfo.airlinePNRs = ['WRONG1']; }],
  ['wrong supplier price', report => { report.ticketInfo.ticketingPrice += 1; }],
  ['wrong immutable tax', report => { report.passengerInfo[0].tax += 1; }],
  ['foreign summary currency', report => { report.ticketInfo.currency = 'USD'; }],
  ['foreign summary currency name', report => { report.ticketInfo.currencyName = 'USD'; }],
  ['foreign root currency', report => { report.currency = 'USD'; }],
  ['foreign root currency name', report => { report.currencyName = 'USD'; }],
  ['unpaid report', report => { report.ticketInfo.isPaid = false; }],
  ['incomplete report', report => { report.ticketInfo.isCompleted = false; }],
  ['missing issue date', report => { delete report.ticketInfo.issueDate; }],
  ['voided passenger', report => { report.passengerInfo[0].isVoided = true; }],
  ['refunded passenger', report => { report.passengerInfo[0].isRefunded = true; }],
  ['cancelled passenger', report => { report.passengerInfo[0].isCanceled = true; }],
  ['voided summary', report => { report.ticketInfo.isVoided = true; }],
  ['refunded summary', report => { report.ticketInfo.isRefunded = true; }],
  ['cancelled segment', report => { report.segments[0].isCancelled = true; }],
  ['alternate cancelled segment flag', report => { report.segments[0].isCanceled = true; }],
  ['voided segment', report => { report.segments[0].isVoided = true; }],
  ['conflicting passenger ticket status', report => { report.passengerInfo[0].ticketStatus = 'Cancelled'; }],
]) {
  const report = ticketReport(); mutate(report);
  const facts = (await serviceRun({ report })).facts;
  check(facts.verified, false, `${name} cannot establish issuance or authorize confirmation`);
  check(facts.tickets, [], `${name} exposes no selectable ticket evidence`);
}
for (const status of ['Booked', 'Created', 'Cancelled']) {
  const facts = (await serviceRun({ reportFails: true, pnr: { ...pnrResponse(), status } })).facts;
  check(facts.verifiedStatus, status === 'Cancelled' ? 'cancelled' : 'held', `${status} is independently identified without being treated as issued`);
  check(facts.tickets, [], 'Non-issued observations carry no ticket confirmation evidence');
}
check((await serviceRun({ reportFails: true, pnr: { status: 'Booked', pnr: baseBooking.pnr } })).facts.verified,
  false, 'A locator without matching transaction echo cannot establish a decided PNR result');

const standardBooking = copy(baseBooking);
standardBooking.itinerary.carrierCode = 'BG';
standardBooking.itinerary.legs[0].segments.forEach(segment => { segment.airlineCode = 'BG'; });
check((await serviceRun({ report: ticketReport(standardBooking, true) }, standardBooking)).facts.verifiedStatus,
  'issued', 'Conventional numeric tickets retain full report verification');
const duplicatedNumeric = ticketReport(standardBooking, true);
duplicatedNumeric.passengerInfo[1].ticketNumbers = duplicatedNumeric.passengerInfo[0].ticketNumbers;
check((await serviceRun({ report: duplicatedNumeric }, standardBooking)).facts.verified, false, 'Conventional numeric tickets remain unique');
check((await serviceRun({ report: ticketReport(standardBooking, false) }, standardBooking)).facts.verified,
  false, 'A different carrier never inherits the shared PNR exception');

const previewPayload = { action: 'preview', bookingReference, checkId };
const confirmPayload = { action: 'confirm', bookingReference, checkId, previewHash, requestId, confirmed: true };
function apiHarness(options = {}) {
  const events = [];
  const rpcCalls = [];
  const receipts = new Map();
  let booking = options.missingBooking ? null : { ...copy(baseBooking), ...copy(options.booking ?? {}) };
  let financialMutations = 0;
  let supplierReads = 0;
  const session = Object.hasOwn(options, 'session') ? options.session : admin;
  const fakeRpc = {
    async rpc(name, args) {
      events.push(name); rpcCalls.push({ name, args: plain(args) });
      check(args.p_booking_id, bookingId, 'All storage calls remain bound to the scoped booking');
      check(args.p_actor_user_id, session.clerkId, 'Actor identity comes from the session');
      check(args.p_actor_role, session.role, 'Actor role comes from the session');
      if (options.rpcThrows === name) throw new Error('Synthetic storage response unavailable');
      if (name === 'triplover_status_check_context_v1') {
        return { data: options.contextDenied ? { ok: false, code: 'ACTOR_ROLE_MISMATCH' } :
          { ok: true, bookingSnapshotHash: snapshotHash, booking: copy(options.contextBooking ?? booking) }, error: null };
      }
      if (name === 'record_triplover_status_check_v1') {
        check(args.p_booking_snapshot_hash, snapshotHash, 'The pre-read snapshot binds the recorded proof');
        check(args.p_facts, options.facts ?? issued.facts, 'Only the production service facts are recorded');
        return { data: options.changedDuringRead ? { ok: false, code: 'BOOKING_CHANGED' } :
          { ok: true, checkId, checkedAt: '2026-10-13T15:10:00Z', expiresAt: '2026-10-13T15:15:00Z' }, error: null };
      }
      if (name === 'preview_triplover_issued_hold_confirmation_v1') {
        check(args.p_check_id, checkId, 'Preview consumes the explicitly selected saved evidence');
        return { data: { ok: true, eligible: !options.previewIneligible, checkId, previewHash,
          walletEffect: 'capture_hold', amount: baseBooking.user_payable_amount, currency: 'BDT',
          availableBefore: 10000000, availableAfter: 10000000, holdBefore: baseBooking.user_payable_amount,
          holdAfter: 0, reservationId: 'internal-reservation', operationId: 'internal-operation' }, error: null };
      }
      if (name === 'confirm_triplover_issued_hold_v1') {
        check(args.p_check_id, checkId, 'Confirm consumes the preview-bound saved evidence');
        check(args.p_preview_hash, previewHash, 'Confirm uses the exact preview fingerprint');
        check(args.p_money_movement_confirmed, true, 'Wallet capture requires explicit confirmation');
        check(args.p_request_key, `triplover-issued-hold:v1:${requestId}`, 'Same execution retains the durable request key');
        if (options.confirmDenied) return { data: { ok: false, code: 'STATUS_CHECK_EXPIRED' }, error: null };
        if (receipts.has(args.p_request_key)) return { data: { ...receipts.get(args.p_request_key), replay: true }, error: null };
        financialMutations += 1;
        const result = { ok: true, replay: false, bookingReference, bookingStatus: 'confirmed',
          paymentState: 'captured', currency: 'BDT', walletEffect: 'capture_hold', amount: baseBooking.user_payable_amount,
          reservationId: 'internal-reservation', ledgerEntryId: 'internal-ledger' };
        receipts.set(args.p_request_key, result);
        booking.status = 'confirmed'; booking.lifecycle_status = 'confirmed'; booking.payment_state = 'captured';
        return { data: result, error: null };
      }
      throw new Error(`Unapproved database mutation: ${name}`);
    },
  };
  const db = compile('lib/db/triplover-status-confirmation.ts', {
    '@/lib/supabase/server': { supabaseAdmin: () => fakeRpc },
  });
  const supporting = {
    '@/lib/dashboard/session': { getDashboardSession: async () => session },
    '@/lib/dashboard/bookings': { bookingScopeFor: current => ({ actor: current.clerkId, role: current.role }) },
    '@/lib/db/flight-bookings': {
      readBookingByPublicRef: async (reference, scope) => {
        events.push('scoped-booking-read');
        check(reference, bookingReference, 'Browser references only identify a scoped local booking');
        check(scope, { actor: session.clerkId, role: session.role }, 'Booking visibility uses the signed-in actor');
        return booking;
      },
    },
    '@/lib/db/triplover-status-confirmation': db,
    '@/lib/triplover/supplier-status': {
      canCheckTriploverSupplierStatus: issued.service.canCheckTriploverSupplierStatus,
      readTriploverSupplierStatus: async checkedBooking => {
        events.push('supplier-safe-read'); supplierReads += 1;
        check(checkedBooking, options.contextBooking ?? booking, 'Supplier reads use the row bound by the database context, not the earlier scoped read');
        if (options.supplierThrows) throw new Error('Synthetic supplier read unavailable');
        return copy(options.facts ?? issued.facts);
      },
    },
    '@/lib/rate-limit': { checkActionLimit: async () => ({ ok: !options.rateLimited }) },
    '@/lib/wallet/http': {
      walletOk: (data, status = 200) => ({ status, body: { success: true, data } }),
      walletFail: (status, errorCode, errorMessage) => ({ status, body: { success: false, error: { errorCode, errorMessage } } }),
    },
  };
  const refresh = compile('app/api/flights/booking/refresh-status/route.ts', supporting);
  const confirm = compile('app/api/flights/booking/confirm-supplier-ticket/route.ts', supporting);
  return {
    events, rpcCalls,
    refresh: payload => refresh.POST({ json: async () => { if (options.invalidJson) throw new Error('Invalid JSON'); return copy(payload); } }),
    confirm: payload => confirm.POST({ json: async () => { if (options.invalidJson) throw new Error('Invalid JSON'); return copy(payload); } }),
    counts: () => ({ supplierReads, financialMutations }),
  };
}

for (const role of [null, 'customer', 'b2b', 'b2b_sub', 'staff_support', 'staff_account']) {
  for (const action of ['refresh', 'preview', 'confirm']) {
    const h = apiHarness({ session: role ? { clerkId: 'synthetic-other', role } : null });
    const result = await (action === 'refresh' ? h.refresh({ bookingReference }) : h.confirm(action === 'preview' ? previewPayload : confirmPayload));
    check(result.status, role ? 403 : 401, `${role ?? 'signed-out'} cannot ${action}`);
    check(h.events, [], 'Denied permissions precede booking/supplier/storage work');
    check(h.counts(), { supplierReads: 0, financialMutations: 0 }, 'Denied callers cannot trigger supplier reads or capture');
  }
}
for (const role of ['admin', 'superadmin']) {
  const h = apiHarness({ session: { clerkId: 'synthetic-admin', role } });
  const refreshed = await h.refresh({ bookingReference });
  check(refreshed.status, 200, `${role} can refresh status`);
  check(h.events, ['scoped-booking-read', 'triplover_status_check_context_v1', 'supplier-safe-read', 'record_triplover_status_check_v1'],
    'Scope and immutable context are checked before reads, then proof alone is recorded');
  check(h.counts(), { supplierReads: 1, financialMutations: 0 }, 'Refreshing cannot change payment');
  check(refreshed.body.data.check.localStatus, 'in-progress', 'Refresh does not pretend the saved booking was confirmed');
  for (const privateField of ['ticketCodeRef', 'rawPayloadHash', 'supplierPayableMinor']) {
    check(Object.hasOwn(refreshed.body.data.check, privateField), false, `${privateField} remains server-owned`);
  }
}
for (const [name, options, status] of [
  ['out-of-scope booking', { missingBooking: true }, 404],
  ['different supplier', { booking: { supplier: 'shapontravels' } }, 409],
  ['missing account', { booking: { supplier_account: null } }, 409],
  ['imported booking', { booking: { import_source: 'MANUAL' } }, 409],
  ['legacy booking', { booking: { legacy_operational: true } }, 409],
  ['direct issue', { booking: { direct_ticketing: true } }, 409],
  ['missing saved refs', { booking: { booking_code_ref: null } }, 409],
  ['unsupported currency', { booking: { currency: 'USD' } }, 409],
  ['rate limited', { rateLimited: true }, 429],
  ['changed actor/context', { contextDenied: true }, 409],
]) {
  const h = apiHarness(options);
  check((await h.refresh({ bookingReference })).status, status, name);
  check(h.counts(), { supplierReads: 0, financialMutations: 0 }, `${name} fails before any supplier read/capture`);
}
for (const [name, options, status] of [
  ['supplier read failed', { supplierThrows: true }, 503],
  ['booking changed during safe reads', { changedDuringRead: true }, 409],
  ['immutable context unavailable', { rpcThrows: 'triplover_status_check_context_v1' }, 503],
  ['proof persistence unavailable', { rpcThrows: 'record_triplover_status_check_v1' }, 503],
]) {
  const h = apiHarness(options);
  check((await h.refresh({ bookingReference })).status, status, name);
  check(h.counts().financialMutations, 0, `${name} cannot capture or release money`);
}
const unknownFacts = { ...copy(issued.facts), verified: false, verifiedStatus: 'unknown', tickets: [], reason: 'TICKET_EVIDENCE_INCOMPLETE' };
const unknownRefresh = apiHarness({ facts: unknownFacts });
check((await unknownRefresh.refresh({ bookingReference })).body.data.check.verified, false, 'Incomplete proof is shown as undecided');
check(unknownRefresh.counts().financialMutations, 0, 'Recording an incomplete status never settles the hold');

const latestContextBooking = { ...copy(baseBooking), pnr: 'NEW123', status: 'on-hold', lifecycle_status: 'on-hold', payment_state: 'held' };
const latestContext = apiHarness({ contextBooking: latestContextBooking, facts: { ...copy(issued.facts), pnr: 'NEW123' } });
const latestResult = await latestContext.refresh({ bookingReference });
check(latestResult.status, 200, 'A newer locked database context supersedes the initial scoped read');
check(latestResult.body.data.check.pnr, 'NEW123', 'Visible proof belongs to the exact context row used for reads');
check(latestResult.body.data.check.localStatus, 'on-hold', 'Visible local state comes from the locked context');
check(latestResult.body.data.check.paymentState, 'held', 'Visible payment state comes from the locked context');
for (const contextBooking of [
  { ...copy(baseBooking), id: '44444444-4444-4444-8444-444444444444' },
  { ...copy(baseBooking), direct_ticketing: true },
]) {
  const h = apiHarness({ contextBooking });
  check((await h.refresh({ bookingReference })).status, 409, 'Different or unsupported context rows cannot bind a proof');
  check(h.counts(), { supplierReads: 0, financialMutations: 0 }, 'Bad context is rejected before safe supplier reads');
}

for (const payload of [
  { ...previewPayload, amount: 1 }, { ...confirmPayload, amount: 1 },
  { ...confirmPayload, chargeWallet: false }, { ...confirmPayload, confirmed: false },
  { ...confirmPayload, previewHash: 'not-a-preview' }, { ...confirmPayload, checkId: 'invalid' },
  { ...confirmPayload, requestId: 'invalid' }, { ...confirmPayload, action: 'NewTicket' },
]) {
  const h = apiHarness();
  check((await h.confirm(payload)).status, 400, 'Browser monetary overrides and malformed confirmation intents are rejected');
  check(h.events, [], 'Invalid confirmation cannot read or mutate a booking');
}
const unexpectedRefreshInput = apiHarness();
check((await unexpectedRefreshInput.refresh({ bookingReference, verified: true })).status, 400, 'Browser cannot provide verified supplier facts');
check(unexpectedRefreshInput.events, [], 'Injected facts cannot reach supplier or database');

const previewOnly = apiHarness();
const previewResult = await previewOnly.confirm(previewPayload);
check(previewResult.status, 200, 'Explicit preview is available');
check(previewOnly.counts(), { supplierReads: 0, financialMutations: 0 }, 'Preview only reads locked cached evidence and money');
check(previewOnly.rpcCalls.map(call => call.name), ['preview_triplover_issued_hold_confirmation_v1'], 'Preview performs exactly one dedicated RPC');
check(Object.hasOwn(previewResult.body.data.preview, 'reservationId'), false, 'Internal reservation stays server-side');
check(Object.hasOwn(previewResult.body.data.preview, 'operationId'), false, 'Internal operation stays server-side');
const ineligible = apiHarness({ previewIneligible: true });
check((await ineligible.confirm(previewPayload)).body.data.preview.eligible, false, 'An ineligible cached preview cannot imply a capture');
check(ineligible.counts().financialMutations, 0, 'Preview denial moves no money');

const confirmed = apiHarness();
const first = await confirmed.confirm(confirmPayload);
const replay = await confirmed.confirm(confirmPayload);
check(first.body.data.result.replay, false, 'First execution records one explicit confirmation');
check(replay.body.data.result.replay, true, 'Same execution retrieves the cached result after local status becomes terminal');
check(confirmed.counts(), { supplierReads: 0, financialMutations: 1 }, 'Confirmation and replay never send NewTicket or debit twice');
check(confirmed.rpcCalls.map(call => call.name), ['confirm_triplover_issued_hold_v1', 'confirm_triplover_issued_hold_v1'],
  'Replay goes directly to the idempotent database authority');
check(Object.hasOwn(first.body.data.result, 'ledgerEntryId'), false, 'Internal ledger identity remains server-side');
for (const [options, status] of [
  [{ missingBooking: true }, 404], [{ confirmDenied: true }, 409],
  [{ rpcThrows: 'confirm_triplover_issued_hold_v1' }, 503],
]) {
  const h = apiHarness(options);
  check((await h.confirm(confirmPayload)).status, status, 'Missing/stale/unknown confirmation cannot be reported as success');
  check(h.counts(), { supplierReads: 0, financialMutations: 0 }, 'Failed confirmation never retries a supplier operation');
}

// A confirmed issued observation remains a stop signal even when an Admin's
// capture preview expired or a later supplier check was inconclusive. Exercise
// the real database lookup and real Issue/Cancel handlers before any claim.
function issuedStopAdapter(options = {}) {
  const queries = [];
  const rows = [
    { checked_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-01T00:05:00Z',
      facts: { verified: true, verifiedStatus: 'issued' } },
    { checked_at: '2026-10-13T23:00:00Z', expires_at: '2026-10-13T23:05:00Z',
      facts: { verified: false, verifiedStatus: 'unknown' } },
  ];
  const database = {
    from(table) {
      check(table, 'triplover_booking_status_checks', 'Write guards only query immutable supplier proof');
      const filters = [];
      const query = {
        select(columns) { check(columns, 'facts', 'Only proof facts are needed for the stop signal'); return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        limit(value) { check(value, 1, 'One matching historical issued fact is sufficient'); return query; },
        async maybeSingle() {
          queries.push(copy(filters));
          check(filters, [['booking_id', bookingId], ['facts->>verified', 'true'], ['facts->>verifiedStatus', 'issued']],
            'Historical verified issuance is queried directly without expiration or latest-only restrictions');
          if (options.unavailable) return { data: null, error: { code: 'SYNTHETIC_STORAGE_UNAVAILABLE' } };
          return { data: options.noIssued ? null : rows.find(row => row.facts.verified && row.facts.verifiedStatus === 'issued'), error: null };
        },
      };
      return query;
    },
  };
  const adapter = compile('lib/db/triplover-status-confirmation.ts', { '@/lib/supabase/server': { supabaseAdmin: () => database } });
  return { adapter, queries };
}
check(await issuedStopAdapter().adapter.hasVerifiedTriploverIssuedStatus(bookingId), true,
  'An expired issued observation cannot be erased by a later unknown result');

async function guardedWrite(file, method, unavailable = false) {
  const effects = [];
  const stop = issuedStopAdapter({ unavailable });
  const unused = new Proxy({}, { get(_target, name) {
    return () => { effects.push(String(name)); throw new Error(`Unexpected side effect: ${String(name)}`); };
  } });
  const overrides = {};
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const imported = statement.moduleSpecifier.text;
      if (!['zod', 'next/server', 'server-only'].includes(imported)) overrides[imported] = unused;
    }
  }
  Object.assign(overrides, {
    '@/lib/dashboard/session': { getDashboardSession: async () => admin },
    '@/lib/dashboard/bookings': { bookingScopeFor: () => ({ scoped: true }) },
    '@/lib/currency': { isBookingCurrency: currency => currency === 'BDT' },
    '@/lib/db/flight-bookings': { readBookingByPublicRef: async () => copy(baseBooking) },
    '@/lib/db/booking-local-time-limit': { readBookingLocalTimeLimitContext: async () => null },
    '@/lib/db/supplier-controls': { getSupplierOperationalControls: async () => ({ ticketingEnabled: true }) },
    '@/lib/db/triplover-status-confirmation': stop.adapter,
    '@/lib/triplover/config': { isTriploverSupplier: value => ['triplover', 'firsttrip', 'takeoff'].includes(value) },
    '@/lib/rate-limit': { checkActionLimit: async () => ({ ok: true }) },
    '@/lib/wallet/permissions': { canIssueBooking: () => true, canCancelBooking: () => true },
    '@/lib/wallet/http': {
      walletOk: (data, status = 200) => ({ status, body: { success: true, data } }),
      walletFail: (status, errorCode, errorMessage) => ({ status, body: { success: false, error: { errorCode, errorMessage } } }),
    },
  });
  const route = compile(file, overrides);
  const result = await route[method]({ nextUrl: new URL(`https://offline.invalid/?reference=${bookingReference}`),
    json: async () => ({ bookingReference, requestId }) });
  check(result.status, unavailable ? 503 : 409, `${method} ${file} stops before any claim when issued proof exists or its storage fails`);
  check(result.body.error.errorCode, unavailable ? 'STORAGE_ERROR' : 'SUPPLIER_ALREADY_ISSUED', 'Write guards explain the required supplier review');
  check(effects, [], 'Verified-issued guards precede supplier calls, operation claims, wallet changes and notifications');
  check(stop.queries.length, 1, 'Each write entry point consults historical immutable issued proof');
}
for (const unavailable of [false, true]) {
  await guardedWrite('app/api/flights/booking/issue/route.ts', 'GET', unavailable);
  await guardedWrite('app/api/flights/booking/issue/route.ts', 'POST', unavailable);
  await guardedWrite('app/api/flights/booking/cancel/route.ts', 'POST', unavailable);
}

async function issueStatusPreview(options = {}) {
  const effects = [];
  const file = 'app/api/flights/booking/issue/status/route.ts';
  const stop = issuedStopAdapter(options);
  const unused = new Proxy({}, { get(_target, name) {
    return () => { effects.push(String(name)); throw new Error(`Unexpected side effect: ${String(name)}`); };
  } });
  const overrides = {};
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const imported = statement.moduleSpecifier.text;
      if (!['zod', 'next/server', 'server-only'].includes(imported)) overrides[imported] = unused;
    }
  }
  const heldBooking = { ...copy(baseBooking), status: 'on-hold', lifecycle_status: 'on-hold', payment_state: 'unpaid',
    operation_kind: null, operation_reason: null, booking_owner_type: 'user', booking_owner_key: 'synthetic-owner' };
  Object.assign(overrides, {
    '@/lib/dashboard/session': { getDashboardSession: async () => admin },
    '@/lib/dashboard/bookings': { bookingScopeFor: () => ({ scoped: true }) },
    '@/lib/currency': { isBookingCurrency: currency => currency === 'BDT' },
    '@/lib/booking-lifecycle/ticketing-flow': compile('lib/booking-lifecycle/ticketing-flow.ts'),
    '@/lib/db/flight-bookings': { readBookingByPublicRef: async () => heldBooking },
    '@/lib/db/booking-operations': { readActiveBookingOperationState: async () => null },
    '@/lib/db/booking-reconciliation-evidence': { readOpenBookingReconciliationCaseForBooking: async () => null },
    '@/lib/db/booking-local-time-limit': { readBookingLocalTimeLimitContext: async () => null },
    '@/lib/db/triplover-status-confirmation': stop.adapter,
    '@/lib/db/supplier-controls': { getSupplierOperationalControls: async () => ({ ticketingEnabled: true }) },
    '@/lib/db/wallet': { readWalletForOwner: async () => ({ status: 'active', currency: 'BDT', availableBalance: 100000000, holdBalance: 0 }) },
    '@/lib/triplover/config': { isTriploverSupplier: value => ['triplover', 'firsttrip', 'takeoff'].includes(value) },
    '@/lib/wallet/permissions': { canIssueBooking: () => true },
    '@/lib/wallet/http': {
      walletOk: (data, status = 200) => ({ status, body: { success: true, data } }),
      walletFail: (status, errorCode, errorMessage) => ({ status, body: { success: false, error: { errorCode, errorMessage } } }),
    },
  });
  const result = await compile(file, overrides).GET({ nextUrl: new URL(`https://offline.invalid/?reference=${bookingReference}`) });
  check(effects, [], 'Issue status preview never calls a supplier, claims an operation or moves money');
  check(result.status, options.unavailable ? 503 : 200, 'Issue status preview fails closed when proof storage is unavailable');
  if (!options.unavailable) {
    check(result.body.data.supplierAlreadyIssued, !options.noIssued, 'Issue preview carries the verified-issued stop signal');
    check(result.body.data.canSubmit, Boolean(options.noIssued), 'Otherwise eligible issue preview is blocked exclusively by verified issued proof');
    check(result.body.data.reconciliationRequired, !options.noIssued, 'Verified supplier issuance requires financial review');
  }
}
await issueStatusPreview();
await issueStatusPreview({ noIssued: true });
await issueStatusPreview({ unavailable: true });

console.log(JSON.stringify({ checks: 'passed', assertions, serviceAndApiProductionModules: true,
  namedThreeAdultSharedPnr: true, safeReadsOnly: true, immutableSnapshotBinding: true,
  explicitPreviewAndConfirmation: true, offlineDatabaseReplay: true, externalTransportForbidden: true }, null, 2));
