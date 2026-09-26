import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { z } from 'zod';
import { airlinePnrModule } from './helpers/airline-pnr.mjs';
import { currencyModule } from './helpers/currency.mjs';

// Real adapters, eligibility and route orchestration, with no network access.
globalThis.fetch = () => { throw new Error('Network access is forbidden in this test'); };
function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function('exports', 'require', code)(exports, (name) => {
    if (name === 'server-only') return {};
    if (name === 'zod') return { z };
    if (name === 'next/server') return {};
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  });
  return exports;
}
const flow = load('lib/booking-lifecycle/ticketing-flow.ts');
const ticketPayload = load('lib/triplover/ticket-payload.ts');
const refs = { uniqueTransId: 'saved-transaction', priceCodeRef: 'saved-price', itemCodeRef: 'saved-item' };
let supplierReply;
const supplierCalls = [];
class TriploverError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}
const client = {
  TriploverError,
  triploverCall: async (operation, path, payload, options) => {
    assert.ok(['Book', 'NewTicket'].includes(operation), `Forbidden operation: ${operation}`);
    supplierCalls.push({ operation, path, payload, options });
    if (supplierReply instanceof Error) throw supplierReply;
    return { data: supplierReply };
  },
};
const book = load('lib/triplover/book.ts', {
  '@/lib/flights/airline-pnr': airlinePnrModule,
  '@/lib/flights/booking': { BOOKING_CONTACT_DEFAULTS: {} },
  '@/lib/triplover/client': client,
  '@/lib/triplover/ticket-payload': ticketPayload,
});
const ticket = load('lib/triplover/ticket.ts', { '@/lib/triplover/client': client, '@/lib/triplover/ticket-payload': ticketPayload });
supplierReply = { pnr: 'ABC123', airlinesPNR: ['ABC123'], bookingRefNumber: 'BOOK123', bookingCodeRef: 'saved-booking', bookingStatus: 'Created', ticketingTimeLimit: '' };
const { outcome } = await book.bookFlight(refs, [], {}, 'triplover');
assert.equal(outcome.status, 'held');
assert.equal(outcome.ticketingTimeLimit, '');

const base = {
  id: randomUUID(), public_ref: 'KTTABC123ABC123', supplier: 'triplover', supplier_account: 'triplover',
  import_source: null, legacy_operational: false, direct_ticketing: false,
  status: 'on-hold', lifecycle_status: 'on-hold', operation_kind: null, payment_state: 'unpaid',
  pnr: outcome.pnr, booking_ref_number: outcome.bookingRefNumber, booking_code_ref: outcome.bookingCodeRef,
  supplier_refs: refs, ticketing_deadline_at: null, supplier_ticketing_deadline_at: null,
  supplier_ticketing_time_limit: null, local_ticketing_deadline_at: null, active_local_time_limit_request_id: null,
  active_superadmin_deadline_override_id: null, passenger_counts: { ADT: 1 },
  issued_at: null, airlines_pnr: outcome.airlinesPnr,
  booking_owner_type: 'user', booking_owner_key: 'owner', pricing_snapshot: { sellingPrice: 500 }, currency: 'BDT',
  // A held booking outlives Search and login-token caches.
  created_at: new Date(Date.now() - 6 * 60 * 60_000).toISOString(),
};
let booking = { ...base };
let requestedTimeLimit = null;
const localLimits = load('lib/db/booking-local-time-limit.ts', {
  '@/lib/booking-lifecycle/ticketing-flow': flow,
  '@/lib/booking-lifecycle/local-time-limit': load('lib/booking-lifecycle/local-time-limit.ts'),
  '@/lib/supabase/server': { supabaseAdmin: () => ({ from: (table) => {
    const builder = { select: () => builder, eq: () => builder, order: () => builder, limit: () => builder,
      maybeSingle: async () => ({ data: table === 'flight_bookings' ? booking : requestedTimeLimit }) };
    return builder;
  } }) },
});
for (const supplier of ['firsttrip', 'takeoff', 'triplover']) {
  booking = { ...base, supplier_account: supplier };
  assert.equal(flow.usesStoredBookingReferences(booking), true);
  assert.equal((await localLimits.readBookingLocalTimeLimitContext(booking.id)).requestRequired, false);
  booking.supplier_ticketing_deadline_at = new Date(Date.now() + 5 * 60_000).toISOString();
  assert.equal((await localLimits.readBookingLocalTimeLimitContext(booking.id)).requestRequired, false);
  booking.supplier_ticketing_deadline_at = new Date(Date.now() - 5 * 60_000).toISOString();
  assert.equal((await localLimits.readBookingLocalTimeLimitContext(booking.id)).requestRequired, true);
}
for (const change of [{ import_source: 'IMP_EXP' }, { import_source: 'MANUAL' }, { legacy_operational: true }, { supplier_account: null }]) {
  booking = { ...base, ...change };
  assert.equal(flow.usesStoredBookingReferences(booking), false);
}
booking = { ...base, import_source: 'IMP_EXP' };
assert.equal((await localLimits.readBookingLocalTimeLimitContext(booking.id)).requestRequired, true);
booking = { ...base };

const effects = [];
let replay = false;
const boundary = { supplierCallStarted: true, supplierResponseObserved: true, supplierResponseRecorded: true, httpStatus: 200 };
class SupplierWriteBoundaryError extends Error {}
const classifier = load('lib/booking-lifecycle/supplier-uncertainty.ts', {
  '@/lib/booking-lifecycle/supplier-write-hooks': { SupplierWriteBoundaryError },
  '@/lib/triplover/client': client,
  '@/lib/shapontravels/client': { ShapontravelsWriteError: class extends Error {} },
});
const http = {
  walletOk: (data) => Response.json({ success: true, data }),
  walletFail: (status, code, message) => Response.json({ success: false, error: { errorCode: code, errorMessage: message } }, { status }),
  walletOperationResponse: (value) => Response.json(value, { status: 409 }),
};
const session = { clerkId: 'owner', role: 'customer' };
const routeDependencies = {
  '@/lib/booking-lifecycle/ticketing-flow': flow,
  '@/lib/currency': currencyModule,
  '@/lib/dashboard/bookings': { bookingScopeFor: () => ({ kind: 'user', clerkId: 'owner' }) },
  '@/lib/booking-lifecycle/operation-request': { createOperationRequestIdentity: (input) => input },
  '@/lib/booking-lifecycle/supplier-uncertainty': classifier,
  '@/lib/booking-lifecycle/supplier-write-hooks': { bookingOperationSupplierWriteHooks: () => ({ boundarySnapshot: () => boundary }) },
  '@/lib/booking-lifecycle/post-ticketing-reconciliation.server': { reconcilePostTicketingRace: async () => {} },
  '@/lib/dashboard/session': { getDashboardSession: async () => session },
  '@/lib/db/booking-operations': { recordSupplierWriteUncertainty: async () => { effects.push('reconciliation'); return { ok: true }; } },
  '@/lib/db/booking-local-time-limit': localLimits,
  '@/lib/db/flight-bookings': { readBookingByPublicRef: async () => booking, publicBookingWithHeaderContact: async () => ({ publicRef: booking.public_ref }) },
  '@/lib/db/security': { recordSecurityAuditEvent: async () => {} },
  '@/lib/email/booking-status-delivery': { dispatchBookingStatusEmails: async () => {} },
  '@/lib/db/wallet': {
    beginBookingIssue: async () => { effects.push('reserve'); return { ok: true, replay, operationId: 'operation-1' }; },
    finalizeBookingIssue: async () => { effects.push('capture'); return { ok: true }; },
    failBookingIssue: async () => { effects.push('release'); return { ok: true }; },
    markReservationForReconciliation: async () => { effects.push('reconciliation'); },
  },
  '@/lib/rate-limit': { checkActionLimit: async () => ({ ok: true }) },
  '@/lib/triplover/client': client,
  '@/lib/db/supplier-controls': { getSupplierOperationalControls: async () => ({ ticketingEnabled: true }) },
  '@/lib/triplover/issued-ticket-enrichment': { enrichIssuedTicket: async (value) => ({ outcome: value, ticketDetails: null }) },
  '@/lib/triplover/config': { isTriploverSupplier: (value) => ['firsttrip', 'takeoff', 'triplover'].includes(value) },
  '@/lib/triplover/ticket': ticket,
  '@/lib/wallet/http': http,
  '@/lib/wallet/permissions': load('lib/wallet/permissions.ts', { '@/lib/impexp/booking-source': {} }),
};
const route = load('app/api/flights/booking/issue/route.ts', routeDependencies);
const statusRoute = load('app/api/flights/booking/issue/status/route.ts', {
  ...routeDependencies,
  '@/lib/db/booking-operations': { readActiveBookingOperationState: async () => null },
  '@/lib/db/booking-reconciliation-evidence': { readOpenBookingReconciliationCaseForBooking: async () => null },
  '@/lib/db/wallet': { readWalletForOwner: async () => ({ status: 'active', availableBalance: 100000, holdBalance: 0, currency: 'BDT' }) },
});
const canSubmit = async () => (await (await statusRoute.GET({ nextUrl: new URL(`http://localhost/?reference=${base.public_ref}`) })).json()).data.canSubmit;
const requestId = randomUUID();
const issue = () => route.POST({ json: async () => ({ bookingReference: base.public_ref, requestId }) });
supplierReply = { pnr: base.pnr, ticketCodeRef: 'issued-ticket', ticketInfoes: [{ ticketNumbers: ['7790000000001'] }] };
assert.equal(await canSubmit(), true);
assert.equal((await issue()).status, 200);
assert.deepEqual(effects, ['reserve', 'capture']);
assert.deepEqual(supplierCalls.map(c => c.operation), ['Book', 'NewTicket']);
assert.deepEqual(supplierCalls[1].payload, {
  PNR: outcome.pnr, BookingRefNumber: outcome.bookingRefNumber, UniqueTransID: refs.uniqueTransId,
  PriceCodeRef: refs.priceCodeRef, ItemCodeRef: refs.itemCodeRef, BookingCodeRef: outcome.bookingCodeRef,
});
replay = true;
assert.equal((await issue()).status, 200);
assert.equal(supplierCalls.length, 2, 'An operation replay cannot send NewTicket again');
replay = false;

for (const [reply, expectedStatus, expectedEffect] of [
  [new TriploverError('network', 'Timeout'), 503, 'reconciliation'],
  [{ pnr: base.pnr, ticketCodeRef: 'incomplete', ticketInfoes: [] }, 503, 'reconciliation'],
  [{ pnr: base.pnr, ticketCodeRef: 'partial', ticketInfoes: [{ ticketNumbers: ['7790000000001'] }, { ticketNumbers: [] }] }, 503, 'reconciliation'],
  [{ pnr: base.pnr, ticketCodeRef: 'empty', ticketInfoes: [{ ticketNumbers: [' '] }] }, 503, 'reconciliation'],
  [{ pnr: base.pnr, ticketCodeRef: 'malformed', ticketInfoes: [null] }, 503, 'reconciliation'],
  [new TriploverError('supplier', 'Ticketing time limit elapsed', 200), 503, 'reconciliation'],
  [new TriploverError('supplier', 'Ticketing rejected', 400), 502, 'release'],
]) {
  effects.length = 0; supplierReply = reply;
  const before = supplierCalls.length;
  assert.equal((await issue()).status, expectedStatus);
  assert.deepEqual(effects, ['reserve', expectedEffect]);
  assert.equal(supplierCalls.length, before + 1, 'Every attempt sends at most one supplier request');
}

booking = { ...base, active_local_time_limit_request_id: randomUUID(), local_ticketing_deadline_at: new Date(Date.now() - 60_000).toISOString() };
effects.length = 0;
assert.equal((await issue()).status, 410);
assert.deepEqual(effects, []);

// A Super Admin override has the same effective deadline authority as a grant.
booking = { ...base, supplier_ticketing_deadline_at: new Date(Date.now() - 60_000).toISOString(),
  active_superadmin_deadline_override_id: randomUUID(),
  local_ticketing_deadline_at: new Date(Date.now() + 5 * 60_000).toISOString() };
assert.equal((await localLimits.readBookingLocalTimeLimitContext(booking.id)).localDeadlineActive, true);
assert.equal((await localLimits.readBookingLocalTimeLimitContext(booking.id)).requestRequired, false);
assert.equal(await canSubmit(), true);
supplierReply = { pnr: base.pnr, ticketCodeRef: 'issued-ticket', ticketInfoes: [{ ticketNumbers: ['7790000000001'] }] };
effects.length = 0;
assert.equal((await issue()).status, 200);
assert.deepEqual(effects, ['reserve', 'capture']);
booking.local_ticketing_deadline_at = new Date(Date.now() - 60_000).toISOString();
assert.equal(await canSubmit(), false);
effects.length = 0;
assert.equal((await issue()).status, 410);
assert.deepEqual(effects, []);

// Missing one entire passenger must also stay uncertain, even if another has tickets.
booking = { ...base, passenger_counts: { ADT: 1, INF: 1 } };
effects.length = 0;
assert.equal((await issue()).status, 503);
assert.deepEqual(effects, ['reserve', 'reconciliation']);
supplierReply.ticketInfoes.push({ ticketNumbers: ['7790000000002'] });
effects.length = 0;
assert.equal((await issue()).status, 200);
assert.deepEqual(effects, ['reserve', 'capture']);

// Blank reference tokens are rejected before a reservation or supplier write.
booking = { ...base, supplier_refs: { ...refs, priceCodeRef: '  ' } };
assert.equal(await canSubmit(), false);
effects.length = 0;
const beforeInvalid = supplierCalls.length;
assert.equal((await issue()).status, 409);
assert.deepEqual(effects, []);
assert.equal(supplierCalls.length, beforeInvalid);
assert.equal(flow.storedTicketReferences({ ...base, booking_ref_number: ' ' }).bookingRefNumber, base.pnr);
assert.equal(flow.storedTicketReferences({ ...base, pnr: null }).pnr, base.booking_ref_number);

// Book's latest echoed price/item tokens survive, with older responses supported.
supplierReply = { pnr: 'ABC123', bookingRefNumber: 'BOOK123', bookingStatus: 'Created', bookingCodeRef: 'book-token',
  uniqueTransID: refs.uniqueTransId, priceCodeRef: 'book-price', itemCodeRef: 'book-item' };
const echoed = await book.bookFlight(refs, [], {}, 'triplover');
assert.deepEqual(echoed.outcome.supplierRefs, { ...refs, priceCodeRef: 'book-price', itemCodeRef: 'book-item' });
assert.deepEqual(outcome.supplierRefs, refs, 'Missing echoes retain submitted references');
booking = { ...base, supplier_refs: echoed.outcome.supplierRefs };
supplierReply = { pnr: base.pnr, ticketCodeRef: 'issued-ticket', ticketInfoes: [{ ticketNumbers: ['7790000000001'] }] };
assert.equal((await issue()).status, 200);
assert.equal(supplierCalls.at(-1).payload.PriceCodeRef, 'book-price');
assert.equal(supplierCalls.at(-1).payload.ItemCodeRef, 'book-item');
supplierReply = { pnr: 'ABC123', bookingStatus: 'Created', bookingCodeRef: 'book-token', uniqueTransID: 'another-transaction' };
await assert.rejects(book.bookFlight(refs, [], {}, 'triplover'), error => error.kind === 'protocol');

supplierReply = { pnr: 'DIRECT1', bookingCodeRef: 'direct-booking', ticketCodeRef: 'direct-ticket', ticketInfoes: [{ ticketNumbers: ['7790000000002'] }] };
assert.equal((await book.bookFlight(refs, [], {}, 'triplover')).outcome.status, 'ticketed');
for (const tickets of [[], [null], [{ ticketNumbers: [' '] }], [{ ticketNumbers: ['7790000000001'] }, { ticketNumbers: [] }]]) {
  supplierReply.ticketInfoes = tickets;
  await assert.rejects(book.bookFlight(refs, [], {}, 'triplover'), error => error.kind === 'protocol');
}
supplierReply = { pnr: 'DIRECT1', bookingCodeRef: 'direct-booking', ticketCodeRef: 'direct-ticket' };
await assert.rejects(book.bookFlight(refs, [], {}, 'triplover'), error => error.kind === 'protocol');
assert.equal(ticketPayload.completeTicketNumbers([{ ticketNumbers: ['T1'] }], 2), null);
assert.equal(ticketPayload.completeTicketNumbers([{ ticketNumbers: ['T1'] }, { ticketNumbers: ['T1'] }], 2), null);
assert.equal(ticketPayload.completeTicketNumbers([{ ticketNumbers: ['T1', ''] }], 1), null);
console.log('Saved-reference delayed issue, separate locators, Book echoes, complete passenger tickets, deadline grants, no PNR call, replay and uncertain-result protection passed.');
