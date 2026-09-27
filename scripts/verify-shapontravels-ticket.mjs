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

const refs = {
  uniqueTransId: '11111111-1111-4111-8111-111111111111',
  itemCodeRef: '22222222-2222-4222-8222-222222222222',
  priceCodeRef: '33333333-3333-4333-8333-333333333333',
  bookingCodeRef: '44444444-4444-4444-8444-444444444444',
  bookingRefNumber: '55555555-5555-4555-8555-555555555555',
  pnr: 'ABC123', expectedPassengerCount: 1,
};
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
  pnr: refs.pnr, booking_ref_number: refs.pnr,
  booking_code_ref: refs.bookingCodeRef,
  supplier_refs: refs, passenger_counts: { ADT: 1 },
}), false);
const issue = () => ticket.issueShapontravelsTicket(refs, 'operation:v1:fixed', {});
const issued = await issue();
assert.equal(issued.bookingStatus, 'Confirmed');
assert.equal(issued.ticketCodeRef, ticketCodeRef);
assert.deepEqual(Array.from(issued.ticketNumbers), ['1234567890123']);
assert.equal(request.key, 'operation:v1:fixed');
assert.deepEqual(JSON.parse(JSON.stringify(request.payload)), {
  PNR: refs.pnr, BookingRefNumber: refs.bookingRefNumber,
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

async function transport(status) {
  let issueCalls = 0;
  const events = [];
  const client = compile('lib/shapontravels/client.ts', {}, {
    process: { env: {
      SHAPONTRAVELS_SEARCH_BASE_URL: 'https://supplier.example.test/',
      CLIENT_ID: refs.bookingRefNumber, CLIENT_SECRET: 'fixture-secret',
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
  if (status === 200) {
    assert.equal((await client.shapontravelsIssueRequest({}, 'operation:v1:fixed', hooks)).item2.isSuccess, true);
  } else {
    await assert.rejects(
      client.shapontravelsIssueRequest({}, 'operation:v1:fixed', hooks),
      error => error.kind === (status === 202 ? 'pending' : 'protocol') &&
        error.operation === 'NewTicket'
    );
  }
  assert.equal(issueCalls, 1, 'Unknown outcomes never repeat the Issue mutation');
  assert.deepEqual(events, ['before', status]);
}
await transport(200);
await transport(202);
await transport(409);
for (const status of [200, 202, 404]) {
  let reads = 0;
  const client = compile('lib/shapontravels/client.ts', {}, {
    process: { env: {
      SHAPONTRAVELS_SEARCH_BASE_URL: 'https://supplier.example.test/',
      CLIENT_ID: refs.bookingRefNumber, CLIENT_SECRET: 'fixture-secret',
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
console.log('Shapontravels held-ticket payload, evidence and one-shot transport passed');
