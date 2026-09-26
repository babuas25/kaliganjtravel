import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const sourcePath = 'lib/shapontravels/client.ts';
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  reportDiagnostics: true,
});
assert.equal(
  compiled.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error).length ?? 0,
  0
);

function createClient(fetchImpl) {
  const module = { exports: {} };
  const env = {
    SHAPONTRAVELS_SEARCH_BASE_URL: 'https://supplier.example.test/',
    CLIENT_ID: '55555555-5555-4555-8555-555555555555',
    CLIENT_SECRET: 'fixture-secret',
  };
  const context = vm.createContext({
    module,
    exports: module.exports,
    require(name) {
      assert.equal(name, 'server-only');
      return {};
    },
    process: { env },
    fetch: fetchImpl,
    Response,
    URL,
    Buffer,
    AbortSignal,
    Date,
    JSON,
    Number,
    Error,
    Promise,
  });
  new vm.Script(compiled.outputText, { filename: sourcePath }).runInContext(context);
  return { ...module.exports, env };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'fixture-request' },
  });
}

async function tokenIsSharedAndCached() {
  const calls = [];
  const client = createClient(async (url, init) => {
    calls.push({ path: url.pathname, init });
    if (url.pathname === '/auth/token') {
      assert.deepEqual(JSON.parse(init.body), {
        client_id: '55555555-5555-4555-8555-555555555555',
        client_secret: 'fixture-secret',
      });
      return json({ access_token: 'stm_fixture', token_type: 'Bearer', expires_in: 1800 });
    }
    assert.equal(init.headers.authorization, 'Bearer stm_fixture');
    return json({ item1: { ok: true }, item2: { isSuccess: true } });
  });
  await Promise.all([
    client.shapontravelsRead('Search', { routes: [] }),
    client.shapontravelsRead('FareRules', { segmentCodeRefs: [] }),
  ]);
  await client.shapontravelsRead('Reprice', {});
  assert.equal(calls.filter((call) => call.path === '/auth/token').length, 1);
  assert.deepEqual(
    calls.filter((call) => call.path !== '/auth/token').map((call) => call.path).sort(),
    ['/api/FareRules', '/api/Reprice', '/api/Search']
  );
}

async function unauthorizedReadRenewsOnce() {
  let logins = 0;
  let reads = 0;
  const client = createClient(async (url, init) => {
    if (url.pathname === '/auth/token') {
      logins++;
      return json({ access_token: `stm_fixture_${logins}`, token_type: 'Bearer', expires_in: 1800 });
    }
    reads++;
    assert.equal(init.headers.authorization, `Bearer stm_fixture_${reads}`);
    return reads === 1 ? json({ error: 'INVALID_CREDENTIALS' }, 401) : json({ item1: {} });
  });
  await client.shapontravelsRead('Search', {});
  assert.equal(logins, 2);
  assert.equal(reads, 2);
}

async function errorsStayRedacted() {
  const client = createClient(async (url) =>
    url.pathname === '/auth/token'
      ? json({ error: 'INVALID_CREDENTIALS', secret: 'fixture-secret' }, 401)
      : json({})
  );
  await assert.rejects(client.shapontravelsRead('Search', {}), (error) => {
    assert.equal(error.code, 'INVALID_CREDENTIALS');
    assert.equal(error.status, 401);
    assert.equal(error.requestId, 'fixture-request');
    assert.doesNotMatch(String(error), /fixture-secret/);
    return true;
  });
  client.env.SHAPONTRAVELS_SEARCH_BASE_URL = 'http://supplier.example.test/';
  assert.equal(client.isShapontravelsConfigured(), false);
}

async function bookNeverReplaysAnUnknownOutcome() {
  for (const status of [202, 401, 503]) {
    let bookCalls = 0;
    const events = [];
    const client = createClient(async (url, init) => {
      if (url.pathname === '/auth/token') {
        return json({ access_token: 'stm_book', token_type: 'Bearer', expires_in: 1800 });
      }
      bookCalls++;
      assert.equal(url.pathname, '/api/Book');
      assert.equal(init.headers['Idempotency-Key'], 'operation:v1:fixed');
      assert.equal(init.headers.authorization, 'Bearer stm_book');
      assert.equal(JSON.parse(init.body).directIssueIntent, false);
      return json(status === 202 ? { bookingId: '12345678-1234-4234-8234-123456789abc', state: 'pending' } :
        { error: 'SUPPLIER_REJECTED' }, status);
    });
    await assert.rejects(
      client.shapontravelsBookRequest({ directIssueIntent: false }, 'operation:v1:fixed', {
        beforeRequest: async () => { events.push('before'); },
        onResponse: async ({ httpStatus }) => { events.push(httpStatus); },
      }),
      (error) => error.status === status &&
        (status !== 202 || error.pendingBookingId === '12345678-1234-4234-8234-123456789abc') &&
        error.kind === (status === 202 ? 'pending' : status === 401 ? 'auth' : 'supplier')
    );
    assert.equal(bookCalls, 1, 'Book is never automatically repeated');
    assert.deepEqual(events, ['before', status]);
  }
}

async function bookTransportFailureIsUncertain() {
  let calls = 0;
  const client = createClient(async (url) => {
    if (url.pathname === '/auth/token') {
      return json({ access_token: 'stm_book', token_type: 'Bearer', expires_in: 1800 });
    }
    calls++;
    throw new Error('private network detail');
  });
  await assert.rejects(client.shapontravelsBookRequest({}, 'operation:v1:fixed', {
    beforeRequest: async () => {}, onResponse: async () => { throw new Error('unexpected response'); },
  }), (error) => error.kind === 'network' && !String(error).includes('private network detail'));
  assert.equal(calls, 1);
}

async function bookCapturesStableReferenceHeader() {
  const client = createClient(async (url) => {
    if (url.pathname === '/auth/token') {
      return json({ access_token: 'stm_book', token_type: 'Bearer', expires_in: 1800 });
    }
    return new Response(JSON.stringify({ item1: { bookingRefNumber: 'body-uuid' }, item2: { isSuccess: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-booking-reference': 'STRABC123ABC123' },
    });
  });
  const response = await client.shapontravelsBookRequest({}, 'operation:v1:fixed', {
    beforeRequest: async () => {}, onResponse: async () => {},
  });
  assert.equal(response.supplierPublicRef, 'STRABC123ABC123');
  assert.equal(response.body.item1.bookingRefNumber, 'body-uuid');
}

async function savedBookingLookupOnlyReads() {
  const requests = [];
  const client = createClient(async (url, init) => {
    if (url.pathname === '/auth/token') {
      return json({ access_token: 'stm_lookup', token_type: 'Bearer', expires_in: 1800 });
    }
    requests.push({ path: url.pathname, method: init.method });
    return new Response(JSON.stringify({ item1: { bookingStatus: 'Created' }, item2: { isSuccess: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'x-booking-reference': 'STRABC123ABC123' },
    });
  });
  const read = await client.shapontravelsReadBooking({
    bookingId: 'fa20f550-80b3-4adb-bd0b-4772eadf2c43',
  });
  assert.equal(read.httpStatus, 200);
  assert.equal(read.supplierPublicRef, 'STRABC123ABC123');
  assert.deepEqual(requests, [{
    path: '/api/bookings/fa20f550-80b3-4adb-bd0b-4772eadf2c43', method: 'GET',
  }]);
  await assert.rejects(client.shapontravelsReadBooking({ bookingId: 'not-a-booking-id' }),
    error => error.code === 'INVALID_BOOKING_LOOKUP');
  assert.equal(requests.length, 1);
}

async function bookMapperRequiresTheAcceptedHold() {
  const bookSource = 'lib/shapontravels/book.ts';
  const transpiled = ts.transpileModule(fs.readFileSync(bookSource, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const refs = {
    uniqueTransId: 'transaction-1', itemCodeRef: 'item-1', priceCodeRef: 'price-1',
  };
  const receipt = {
    item1: {
      uniqueTransID: refs.uniqueTransId, itemCodeRef: refs.itemCodeRef,
      priceCodeRef: refs.priceCodeRef, bookingCodeRef: 'booking-1',
      pnr: 'ABC123', bookingStatus: 'Created', ticketingTimeLimit: '2030-01-01T12:00:00+06:00',
      fareBreakdown: { payable: '5084.36' },
    },
    item2: { isSuccess: true },
  };
  let response = { body: receipt, supplierPublicRef: 'STRABC123ABC123' };
  let sent;
  class WriteError extends Error {
    constructor(kind, code, status) { super(code); this.kind = kind; this.status = status; }
  }
  const module = { exports: {} };
  new vm.Script(transpiled, { filename: bookSource }).runInNewContext({
    module, exports: module.exports,
    require(name) {
      if (name === 'server-only') return {};
      if (name === '@/lib/flights/booking') {
        return { BOOKING_CONTACT_DEFAULTS: { countryCode: 'BD', cityName: 'Kaligonj' } };
      }
      if (name === './client') return {
        ShapontravelsWriteError: WriteError,
        shapontravelsBookRequest: async (payload, key) => {
          sent = { payload, key };
          return response;
        },
      };
      throw new Error(`Unexpected Book import: ${name}`);
    },
  });
  const traveller = { title: 'Mr', firstName: 'Test', lastName: 'User', gender: 'Male',
    passengerType: 'ADT', dateOfBirth: '1990-01-01', nationality: 'BD' };
  const contact = { customerEmail: 'test@example.test', phone: '01712345678', phoneCountryCode: '+880' };
  const run = () => module.exports.bookShapontravelsHold(
    refs, [traveller], contact, 5084.36, 'operation:v1:fixed', {}
  );
  const booked = await run();
  assert.equal(booked.outcome.status, 'held');
  assert.equal(booked.outcome.pnr, 'ABC123');
  assert.equal(booked.outcome.supplierPublicRef, 'STRABC123ABC123');
  assert.deepEqual(Array.from(booked.outcome.airlinesPnr), ['ABC123']);
  assert.equal(sent.key, 'operation:v1:fixed');
  assert.equal(sent.payload.directIssueIntent, false);
  assert.equal(sent.payload.passengerInfoes[0].contactInfo.phone, '1712345678');
  for (const invalid of [
    { ...receipt, item1: { ...receipt.item1, priceCodeRef: 'other-price' } },
    { ...receipt, item1: { ...receipt.item1, fareBreakdown: { payable: '5084.37' } } },
    { ...receipt, item1: { ...receipt.item1, ticketCodeRef: 'issued' } },
    { ...receipt, item2: { isSuccess: false } },
  ]) {
    response = { body: invalid, supplierPublicRef: 'STRABC123ABC123' };
    await assert.rejects(run(), error => error.kind === 'protocol');
  }
  response = { body: receipt, supplierPublicRef: null };
  await assert.rejects(run(), error => error.kind === 'protocol');
}

await tokenIsSharedAndCached();
await unauthorizedReadRenewsOnce();
await errorsStayRedacted();
await bookNeverReplaysAnUnknownOutcome();
await bookTransportFailureIsUncertain();
await bookCapturesStableReferenceHeader();
await savedBookingLookupOnlyReads();
await bookMapperRequiresTheAcceptedHold();
console.log('Shapontravels read and hold client verification passed');
