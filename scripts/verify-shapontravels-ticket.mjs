import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function compile(file, imports, globals = {}) {
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
    },
    ...globals,
  });
  return module.exports;
}

const legacyBookingReference = '55555555-5555-4555-8555-555555555555';
const refs = Object.freeze({
  uniqueTransId: '11111111-1111-4111-8111-111111111111',
  itemCodeRef: '22222222-2222-4222-8222-222222222222',
  priceCodeRef: '33333333-3333-4333-8333-333333333333',
  bookingCodeRef: '44444444-4444-4444-8444-444444444444',
  bookingRefNumber: 'ABC123',
  pnr: 'ABC123', expectedPassengerCount: 1,
});
const ticketCodeRef = '66666666-6666-4666-8666-666666666666';
const ticketInfoes = [{ ticketNumbers: ['1234567890123'] }];
const receipt = {
  item1: {
    pnr: refs.pnr, uniqueTransID: refs.uniqueTransId,
    itemCodeRef: refs.itemCodeRef, priceCodeRef: refs.priceCodeRef,
    bookingCodeRef: refs.bookingCodeRef, ticketCodeRef, ticketInfoes,
  },
  item2: { isSuccess: true },
};

const payloadModule = compile('lib/triplover/ticket-payload.ts', {});
class WriteError extends Error {
  constructor(kind, code) { super(code); this.kind = kind; this.code = code; }
}
let supplierResponse = receipt;
let request;
const ticket = compile('lib/shapontravels/ticket.ts', {
  '@/lib/triplover/ticket-payload': payloadModule,
  './client': {
    ShapontravelsWriteError: WriteError,
    shapontravelsIssueRequest: async (payload, key) => {
      request = { payload, key };
      return supplierResponse;
    },
  },
});
assert.equal(ticket.shapontravelsTicketIdentityReady({
  pnr: refs.pnr, booking_ref_number: refs.bookingRefNumber,
  booking_code_ref: refs.bookingCodeRef,
  supplier_refs: refs, passenger_counts: { ADT: 1 },
}), true);
assert.equal(ticket.shapontravelsTicketIdentityReady({
  pnr: refs.pnr, booking_ref_number: legacyBookingReference,
  booking_code_ref: refs.bookingCodeRef,
  supplier_refs: refs, passenger_counts: { ADT: 1 },
}), true, 'Historical UUID receipts remain supported');
for (const bookingReference of ['OTHER1', '', null]) {
  assert.equal(ticket.shapontravelsTicketIdentityReady({
    pnr: refs.pnr, booking_ref_number: bookingReference,
    booking_code_ref: refs.bookingCodeRef,
    supplier_refs: refs, passenger_counts: { ADT: 1 },
  }), false, 'A non-UUID reference must exactly match the saved PNR');
}
for (const field of ['uniqueTransId', 'itemCodeRef', 'priceCodeRef']) {
  assert.equal(ticket.shapontravelsTicketIdentityReady({
    pnr: refs.pnr, booking_ref_number: refs.pnr,
    booking_code_ref: refs.bookingCodeRef,
    supplier_refs: { ...refs, [field]: refs.pnr }, passenger_counts: { ADT: 1 },
  }), false, `${field} must remain a UUID when the booking reference mirrors PNR`);
}
assert.equal(ticket.shapontravelsTicketIdentityReady({
  pnr: refs.pnr, booking_ref_number: refs.pnr,
  booking_code_ref: refs.pnr,
  supplier_refs: refs, passenger_counts: { ADT: 1 },
}), false, 'The platform booking ID must remain a UUID');
const issue = () => ticket.issueShapontravelsTicket(refs, 'operation:v1:fixed', {});
const issued = await issue();
assert.equal(issued.bookingStatus, 'Confirmed');
assert.equal(issued.ticketCodeRef, ticketCodeRef);
assert.deepEqual(Array.from(issued.ticketNumbers), ['1234567890123']);
assert.equal(request.key, 'operation:v1:fixed');
assert.deepEqual(JSON.parse(JSON.stringify(request.payload)), {
  PNR: refs.pnr, BookingRefNumber: refs.pnr,
  UniqueTransID: refs.uniqueTransId, PriceCodeRef: refs.priceCodeRef,
  ItemCodeRef: refs.itemCodeRef, BookingCodeRef: refs.bookingCodeRef,
});
for (const item1 of [
  { ...receipt.item1, pnr: 'OTHER1' },
  { ...receipt.item1, bookingCodeRef: refs.bookingRefNumber },
  { ...receipt.item1, ticketCodeRef: 'not-a-uuid' },
  { ...receipt.item1, ticketInfoes: [] },
  { ...receipt.item1, ticketInfoes: [{ ticketNumbers: ['invalid'] }] },
  { ...receipt.item1, ticketInfoes: [{ ticketNumbers: ['1234567890123'] }, ...ticketInfoes] },
]) {
  supplierResponse = { ...receipt, item1 };
  await assert.rejects(issue(), error => error.kind === 'protocol');
}
supplierResponse = { ...receipt, item2: { isSuccess: false } };
await assert.rejects(issue(), error => error.kind === 'protocol');

// Shapon independently verifies IndiGo issuance, then annotates its airline PNR
// receipt. A shared locator must retain each passenger's place in the receipt.
const indigoInput = {
  ...refs,
  itinerary: { carrierCode: '6E', legs: [{ segments: [{ airlineCode: '6E' }] }] },
};
const pnrReceipt = {
  ...receipt,
  publicReceipt: { status: 'confirmed', pendingReview: false, pnr: refs.pnr },
  item1: { ...receipt.item1, airlinesPNR: ['XY1234'],
    ticketInfoes: [{ ticketNumbers: ['XY1234'], ticketNumberSource: 'airline_pnr' }] },
};
supplierResponse = pnrReceipt;
const pnrIssued = await ticket.issueShapontravelsTicket(indigoInput, 'operation:v1:fixed', {});
assert.deepEqual(Array.from(pnrIssued.ticketNumbers), ['XY1234']);
assert.deepEqual(Array.from(pnrIssued.airlinesPnr), ['XY1234']);
assert.equal(pnrIssued.pnr, refs.pnr, 'Keep the booking PNR distinct from the airline locator');
assert.deepEqual(JSON.parse(JSON.stringify(request.payload)), {
  PNR: refs.pnr, BookingRefNumber: refs.pnr,
  UniqueTransID: refs.uniqueTransId, PriceCodeRef: refs.priceCodeRef,
  ItemCodeRef: refs.itemCodeRef, BookingCodeRef: refs.bookingCodeRef,
}, 'The saved itinerary is local validation context, never a supplier Issue field');
const sharedReceipt = { ...pnrReceipt, item1: { ...pnrReceipt.item1,
  ticketInfoes: [pnrReceipt.item1.ticketInfoes[0], pnrReceipt.item1.ticketInfoes[0]] } };
assert.deepEqual(Array.from(ticket.parseShapontravelsTicketReceipt(sharedReceipt,
  { ...indigoInput, expectedPassengerCount: 2 }).ticketNumbers), ['XY1234', 'XY1234']);
const mixedReceipt = { ...sharedReceipt, item1: { ...sharedReceipt.item1,
  ticketInfoes: [pnrReceipt.item1.ticketInfoes[0], ticketInfoes[0]] } };
assert.deepEqual(Array.from(ticket.parseShapontravelsTicketReceipt(mixedReceipt,
  { ...indigoInput, expectedPassengerCount: 2 }).ticketNumbers), ['XY1234', '1234567890123']);
for (const invalidInput of [
  refs, { ...indigoInput, itinerary: null },
  { ...indigoInput, itinerary: { ...indigoInput.itinerary, carrierCode: 'BG' } },
  { ...indigoInput, itinerary: { carrierCode: '6E', legs: [] } },
  { ...indigoInput, itinerary: { carrierCode: '6E', legs: [null] } },
  { ...indigoInput, itinerary: { carrierCode: '6E', legs: [{ segments: [] }] } },
  { ...indigoInput, itinerary: { carrierCode: '6E', legs: [{ segments: [null] }] } },
  { ...indigoInput, itinerary: { carrierCode: '6E', legs: [
    { segments: [{ airlineCode: '6E' }, { airlineCode: 'BG' }] }] } },
  { ...indigoInput, expectedPassengerCount: 0 },
  { ...indigoInput, expectedPassengerCount: 2 },
]) {
  assert.equal(ticket.parseShapontravelsTicketReceipt(pnrReceipt, invalidInput), null,
    'PNR receipt requires a complete, saved all-IndiGo itinerary and passenger count');
}
for (const status of ['on-hold', 'active', 'unconfirmed', 'cancelled', 'expired']) {
  assert.equal(ticket.parseShapontravelsTicketReceipt({ ...pnrReceipt,
    publicReceipt: { ...pnrReceipt.publicReceipt, status } }, indigoInput), null,
  `${status} must never authorize a PNR ticket receipt`);
}
for (const publicReceipt of [undefined, null, [], 'confirmed',
  { ...pnrReceipt.publicReceipt, pendingReview: true },
  { ...pnrReceipt.publicReceipt, pendingReview: undefined },
  { ...pnrReceipt.publicReceipt, pnr: 'OTHER1' },
]) {
  assert.equal(ticket.parseShapontravelsTicketReceipt({ ...pnrReceipt, publicReceipt }, indigoInput), null);
}
for (const item1 of [
  { ...pnrReceipt.item1, airlinesPNR: [] },
  { ...pnrReceipt.item1, airlinesPNR: ['XY1234', 'XY1234'] },
  { ...pnrReceipt.item1, airlinesPNR: ['xy1234'] },
  { ...pnrReceipt.item1, pnr: 'OTHER1' },
  ...['uniqueTransID', 'itemCodeRef', 'priceCodeRef', 'bookingCodeRef', 'ticketCodeRef']
    .map(field => ({ ...pnrReceipt.item1, [field]: 'not-the-saved-reference' })),
  ...[
    { ticketNumbers: ['XY1234'] },
    { ticketNumbers: ['XY1234'], ticketNumberSource: 'unknown' },
    { ticketNumbers: ['OTHER1'], ticketNumberSource: 'airline_pnr' },
    { ticketNumbers: ['1234567890123'], ticketNumberSource: 'airline_pnr' },
    { ticketNumbers: ['XY1234', 'XY1234'], ticketNumberSource: 'airline_pnr' },
  ].map(row => ({ ...pnrReceipt.item1, ticketInfoes: [row] })),
]) {
  assert.equal(ticket.parseShapontravelsTicketReceipt({ ...pnrReceipt, item1 }, indigoInput), null,
    'PNR identifiers require explicit source, verified airline locator and exact saved references');
}
assert.equal(ticket.parseShapontravelsTicketReceipt({ ...pnrReceipt,
  item2: { isSuccess: false } }, indigoInput), null);
assert.equal(ticket.parseShapontravelsTicketReceipt({ ...pnrReceipt, item1: {
  ...pnrReceipt.item1, ticketInfoes: [pnrReceipt.item1.ticketInfoes[0], ticketInfoes[0], ticketInfoes[0]],
} }, { ...indigoInput, expectedPassengerCount: 3 }), null,
'Numeric ticket identifiers remain unique even when a passenger has a PNR identifier');

async function transport(status) {
  let issueCalls = 0;
  const events = [];
  const client = compile('lib/shapontravels/client.ts', {}, {
    process: { env: {
      SHAPONTRAVELS_SEARCH_BASE_URL: 'https://supplier.example.test/',
      CLIENT_ID: legacyBookingReference, CLIENT_SECRET: 'fixture-secret',
    } },
    fetch: async (url, init) => {
      if (url.pathname === '/auth/token') {
        return new Response(JSON.stringify({
          access_token: 'stm_ticket', token_type: 'Bearer', expires_in: 1800,
        }));
      }
      issueCalls++;
      assert.equal(url.pathname, '/api/ticket/NewTicket');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Idempotency-Key'], 'operation:v1:fixed');
      assert.equal(init.headers.authorization, 'Bearer stm_ticket');
      const payload = JSON.parse(init.body);
      assert.equal(payload.BookingRefNumber, payload.PNR,
        'Shapon NewTicket requires BookingRefNumber to mirror PNR');
      assert.deepEqual(payload, {
        PNR: refs.pnr, BookingRefNumber: refs.pnr,
        UniqueTransID: refs.uniqueTransId, PriceCodeRef: refs.priceCodeRef,
        ItemCodeRef: refs.itemCodeRef, BookingCodeRef: refs.bookingCodeRef,
      });
      return new Response(JSON.stringify(status === 200 ? receipt :
        status === 202 ? { issueId: refs.bookingCodeRef, state: 'pending' } :
          { error: 'SUPPLIER_REPORTED_FAILURE' }), { status });
    },
    Response, URL, Buffer, AbortSignal, Date, JSON, Number, Error, Promise,
  });
  const hooks = {
    beforeRequest: async () => events.push('before'),
    onResponse: async value => events.push(value.httpStatus),
  };
  const adapter = compile('lib/shapontravels/ticket.ts', {
    '@/lib/triplover/ticket-payload': payloadModule,
    './client': client,
  });
  const issue = () => adapter.issueShapontravelsTicket(refs, 'operation:v1:fixed', hooks);
  if (status === 200) {
    assert.equal((await issue()).bookingStatus, 'Confirmed');
  } else {
    await assert.rejects(
      issue(),
      error => error.kind === (status === 202 ? 'pending' : 'protocol') &&
        error.operation === 'NewTicket'
    );
  }
  assert.equal(issueCalls, 1, 'Unknown outcomes never repeat the Issue mutation');
  assert.deepEqual(events, ['before', status]);
  assert.equal(refs.bookingRefNumber, refs.pnr,
    'Ticketing preserves the public Book receipt reference');
}
await transport(200);
await transport(202);
await transport(409);
for (const status of [200, 202, 404]) {
  let reads = 0;
  const client = compile('lib/shapontravels/client.ts', {}, {
    process: { env: {
      SHAPONTRAVELS_SEARCH_BASE_URL: 'https://supplier.example.test/',
      CLIENT_ID: legacyBookingReference, CLIENT_SECRET: 'fixture-secret',
    } },
    fetch: async (url, init) => {
      if (url.pathname === '/auth/token') {
        return new Response(JSON.stringify({
          access_token: 'stm_ticket_read', token_type: 'Bearer', expires_in: 1800,
        }));
      }
      reads++;
      assert.equal(url.pathname, `/api/bookings/${refs.bookingCodeRef}/ticket`);
      assert.equal(init.method, 'GET');
      return new Response(JSON.stringify(status === 200 ? receipt : {}), { status });
    },
    Response, URL, Buffer, AbortSignal, Date, JSON, Number, Error, Promise,
  });
  assert.equal((await client.shapontravelsReadTicket(refs.bookingCodeRef)).httpStatus, status);
  assert.equal(reads, 1);
  await assert.rejects(client.shapontravelsReadTicket('invalid'),
    error => error.code === 'INVALID_BOOKING_LOOKUP');
  assert.equal(reads, 1);
}
console.log('Shapontravels numeric/verified IndiGo PNR receipts, passenger order and one-shot transport passed');
