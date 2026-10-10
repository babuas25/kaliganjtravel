import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function compile(file, imports, globals = {}) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  new vm.Script(compiled.outputText, { filename: file }).runInNewContext({
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

const legacyReference = '55555555-5555-4555-8555-555555555555';
const input = Object.freeze({
  pnr: 'ABC123', bookingRefNumber: 'ABC123',
  uniqueTransId: '11111111-1111-4111-8111-111111111111',
  itemCodeRef: '22222222-2222-4222-8222-222222222222',
  priceCodeRef: '33333333-3333-4333-8333-333333333333',
  bookingCodeRef: '44444444-4444-4444-8444-444444444444',
  supplierPublicRef: 'STR123456789012',
});
const expectedPayload = {
  PNR: input.pnr, BookingRefNumber: input.pnr,
  UniqueTransID: input.uniqueTransId, ItemCodeRef: input.itemCodeRef,
  PriceCodeRef: input.priceCodeRef, BookingCodeRef: input.bookingCodeRef,
};
const receipt = {
  item1: {
    uniqueTransID: input.uniqueTransId, itemCodeRef: input.itemCodeRef,
    priceCodeRef: input.priceCodeRef, bookingCodeRef: input.bookingCodeRef,
    isCancel: true,
  },
  item2: { isSuccess: true },
};
const bookingStatus = compile('lib/shapontravels/booking-status.ts', {});
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'x-request-id': 'fixture-request', ...headers },
});
const token = () => json({ access_token: 'stm_cancellation', token_type: 'Bearer', expires_in: 1800 });
const clone = value => JSON.parse(JSON.stringify(value));

class BoundaryError extends Error {
  constructor(phase) { super(`Boundary failed: ${phase}`); this.phase = phase; }
}
class TriploverError extends Error {}

function transport(fetchImpl, envOverride = {}) {
  const env = {
    SHAPONTRAVELS_SEARCH_BASE_URL: 'https://supplier.example.test/',
    CLIENT_ID: legacyReference, CLIENT_SECRET: 'fixture-secret',
    ...envOverride,
  };
  const client = compile('lib/shapontravels/client.ts', {}, {
    process: { env }, fetch: fetchImpl,
    Response, URL, Buffer, AbortSignal, Date, JSON, Number, Error, Promise,
  });
  const adapter = compile('lib/shapontravels/cancel.ts', {
    './client': client, './booking-status': bookingStatus,
  });
  const classifier = compile('lib/booking-lifecycle/supplier-uncertainty.ts', {
    '@/lib/booking-lifecycle/supplier-write-hooks': { SupplierWriteBoundaryError: BoundaryError },
    '@/lib/triplover/client': { TriploverError },
    '@/lib/shapontravels/client': client,
  });
  return { client, adapter, classifier };
}

const parsed = transport(async () => { throw new Error('Receipt checks must not use transport'); });
const savedBooking = {
  pnr: input.pnr, booking_ref_number: input.bookingRefNumber,
  booking_code_ref: input.bookingCodeRef, supplier_refs: input,
};
assert.equal(parsed.adapter.shapontravelsCancellationIdentityReady(savedBooking), true);
assert.equal(parsed.adapter.shapontravelsCancellationIdentityReady({
  ...savedBooking, booking_ref_number: legacyReference,
}), true, 'Historical saved UUID booking references remain supported');
for (const field of ['pnr', 'booking_ref_number', 'booking_code_ref', 'supplier_refs']) {
  assert.equal(parsed.adapter.shapontravelsCancellationIdentityReady({ ...savedBooking, [field]: null }), false);
}
for (const field of ['uniqueTransId', 'itemCodeRef', 'priceCodeRef']) {
  assert.equal(parsed.adapter.shapontravelsCancellationIdentityReady({
    ...savedBooking, supplier_refs: { ...input, [field]: input.pnr },
  }), false, `${field} requires a saved platform UUID`);
}
for (const booking_ref_number of ['', 'OTHER1', ' ABC123 ']) {
  assert.equal(parsed.adapter.shapontravelsCancellationIdentityReady({ ...savedBooking, booking_ref_number }), false);
}
assert.equal(parsed.adapter.shapontravelsCancellationIdentityReady({ ...savedBooking, pnr: ' ABC123 ' }), false);

assert.deepEqual(clone(parsed.adapter.parseShapontravelsCancellationReceipt(receipt, input)), {
  isCancel: true, uniqueTransId: input.uniqueTransId, netRefund: null, refundPenalty: null,
});
for (const item1 of [
  ...['uniqueTransID', 'itemCodeRef', 'priceCodeRef', 'bookingCodeRef'].map(field => ({ ...receipt.item1, [field]: legacyReference })),
  { ...receipt.item1, isCancel: false }, { ...receipt.item1, isCancel: 'true' },
  { ...receipt.item1, pnr: 'OTHER1' },
  { ...receipt.item1, ticketCodeRef: legacyReference },
  { ...receipt.item1, ticketInfoes: [{ ticketNumbers: ['1234567890123'] }] },
  { ...receipt.item1, ticketNumbers: ['1234567890123'] },
  { ...receipt.item1, netRefund: 1 }, { ...receipt.item1, refundPenalty: -1 },
  { ...receipt.item1, amountPaid: '0' }, { ...receipt.item1, amountHeld: {} },
]) {
  assert.equal(parsed.adapter.parseShapontravelsCancellationReceipt({ ...receipt, item1 }, input), null,
    'Conflicting identity, ticket or monetary evidence cannot finalize cancellation');
}
for (const body of [null, [], {}, { item1: receipt.item1 },
  { ...receipt, item2: { isSuccess: false } }, { ...receipt, item2: { isSuccess: 'true' } }]) {
  assert.equal(parsed.adapter.parseShapontravelsCancellationReceipt(body, input), null);
}
assert.equal(parsed.adapter.parseShapontravelsCancellationReceipt({
  ...receipt, item1: { ...receipt.item1, netRefund: 0, refundPenalty: null },
}, input).isCancel, true);

const heldRead = {
  httpStatus: 200, supplierPublicRef: input.supplierPublicRef,
  body: {
    item1: { ...receipt.item1, pnr: input.pnr, bookingRefNumber: input.pnr, bookingStatus: 'Created' },
    item2: { isSuccess: true },
    currentStatus: { status: 'on-hold', reviewRequired: false },
    publicReceipt: {
      status: 'on-hold', pendingReview: false, tickets: [],
      actions: { canIssue: false, canCancel: true },
    },
  },
};
assert.equal(bookingStatus.verifyShapontravelsBookingStatus(heldRead, input).currentStatus.reviewRequired, true,
  'The Issue parser conservatively treats canIssue=false as review');
assert.equal(parsed.adapter.verifyShapontravelsCancellationEligibility(heldRead, input), true,
  'An explicit Cancel grant remains usable when Issue is blocked by a cutoff');
assert.equal(parsed.adapter.verifyShapontravelsCancellationEligibility(heldRead, {
  ...input, bookingRefNumber: legacyReference,
}), true);
for (const status of ['pending', 'on-hold', 'unconfirmed', 'expired']) {
  const read = clone(heldRead);
  read.body.currentStatus.status = status;
  read.body.publicReceipt.status = status;
  assert.equal(parsed.adapter.verifyShapontravelsCancellationEligibility(read, input), true, status);
}
const eligibilityFailures = [
  read => { read.httpStatus = 202; },
  read => { read.supplierPublicRef = 'STROTHER123'; },
  read => { read.body.item1.uniqueTransID = legacyReference; },
  read => { read.body.item1.pnr = 'OTHER1'; },
  read => { read.body.item1.ticketCodeRef = legacyReference; },
  read => { read.body.item1.ticketInfoes = [{ ticketNumbers: ['1234567890123'] }]; },
  read => { read.body.currentStatus.reviewRequired = true; },
  read => { delete read.body.currentStatus.reviewRequired; },
  read => { read.body.publicReceipt.pendingReview = true; },
  read => { delete read.body.publicReceipt.actions.canCancel; },
  read => { read.body.publicReceipt.actions.canCancel = false; },
  read => { read.body.publicReceipt.actions.canCancel = 'true'; },
  read => { read.body.publicReceipt.tickets = ['1234567890123']; },
  read => { read.body.publicReceipt.status = 'expired'; },
];
for (const mutate of eligibilityFailures) {
  const read = clone(heldRead); mutate(read);
  assert.equal(parsed.adapter.verifyShapontravelsCancellationEligibility(read, input), false);
}
for (const status of ['confirmed', 'in-progress', 'cancelled']) {
  const read = clone(heldRead);
  read.body.currentStatus.status = status; read.body.publicReceipt.status = status;
  assert.equal(parsed.adapter.verifyShapontravelsCancellationEligibility(read, input), false);
}

async function verifyWrite({ status = 200, body = receipt, network = false, invalidJson = false, tooLarge = false,
  failBefore = false, failResponse = false, authFailure = false, envOverride = {}, key = 'operation:v1:fixed',
  saved = input } = {}) {
  let mutations = 0, authentications = 0;
  const events = [];
  const boundary = {
    supplierCallStarted: false, supplierResponseObserved: false,
    supplierResponseRecorded: false, httpStatus: null,
  };
  const { adapter, classifier } = transport(async (url, init) => {
    if (url.pathname === '/auth/token') {
      authentications++;
      if (authFailure) return json({ error: 'INVALID_CREDENTIALS' }, 401);
      return token();
    }
    mutations++;
    assert.equal(url.pathname, '/api/Cancel');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, 'Bearer stm_cancellation');
    assert.equal(init.headers['Idempotency-Key'], key);
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.deepEqual(JSON.parse(init.body), expectedPayload);
    assert.equal(boundary.supplierCallStarted, true, 'Durable start must precede physical mutation');
    events.push('request');
    if (network) throw new Error('Simulated lost cancellation reply');
    if (invalidJson) return new Response('invalid JSON', { status });
    return json(body, status, tooLarge ? { 'content-length': String(8 * 1024 * 1024 + 1) } : {});
  }, envOverride);
  const hooks = {
    async beforeRequest() {
      events.push('before');
      if (failBefore) throw new BoundaryError('before-request');
      boundary.supplierCallStarted = true;
    },
    async onResponse({ httpStatus }) {
      events.push(httpStatus);
      boundary.supplierResponseObserved = true; boundary.httpStatus = httpStatus;
      if (failResponse) throw new BoundaryError('response-received');
      boundary.supplierResponseRecorded = true;
    },
  };
  let failure;
  try {
    const outcome = await adapter.cancelShapontravelsBooking(saved, key, hooks);
    assert.deepEqual(clone(outcome), { isCancel: true, uniqueTransId: input.uniqueTransId, netRefund: null, refundPenalty: null });
  } catch (error) { failure = error; }
  const expectedFailure = status !== 200 || body !== receipt || network || invalidJson || tooLarge ||
    failBefore || failResponse || authFailure || !envOverride.CLIENT_SECRET && Object.hasOwn(envOverride, 'CLIENT_SECRET') ||
    !/^[!-~]{1,128}$/.test(key) || saved !== input && saved.bookingRefNumber !== legacyReference;
  assert.equal(Boolean(failure), Boolean(expectedFailure));
  if (failure) {
    const classification = classifier.classifySupplierWriteFailure(failure, boundary);
    assert.equal(classification.automaticReplayAllowed, false);
    assert.equal(classification.failureClass, mutations ? 'uncertain' : 'not-sent');
    assert.equal(classification.fundsMustRemainProtected, mutations > 0);
    if (mutations) assert.equal(failure.operation === 'Cancel' || failure instanceof BoundaryError, true);
  }
  assert.equal(mutations, boundary.supplierCallStarted ? 1 : 0,
    'A mutation is never repeated after 401, pending, malformed or uncertain replies');
  assert.equal(authentications <= 1, true, 'Destructive 401 replies do not refresh auth and replay');
  if (mutations && !network && !invalidJson && !tooLarge) assert.deepEqual(events, ['before', 'request', status]);
  return { failure, mutations, events };
}

await verifyWrite();
await verifyWrite({ saved: { ...input, bookingRefNumber: legacyReference } });
for (const status of [202, 400, 401, 403, 409, 429, 503]) {
  await verifyWrite({ status, body: status === 202
    ? { bookingId: input.bookingCodeRef, cancellationId: legacyReference, state: 'outcome_unknown', requiresReconciliation: true }
    : { error: status === 403 ? 'CANCELLATION_EXECUTION_DISABLED' : 'SUPPLIER_ERROR' } });
}
await verifyWrite({ body: { ...receipt, item1: { ...receipt.item1, bookingCodeRef: legacyReference } } });
await verifyWrite({ network: true });
await verifyWrite({ invalidJson: true });
await verifyWrite({ tooLarge: true });
await verifyWrite({ failBefore: true });
await verifyWrite({ failResponse: true });
await verifyWrite({ authFailure: true });
await verifyWrite({ envOverride: { CLIENT_SECRET: '' } });
await verifyWrite({ key: 'invalid key' });
await verifyWrite({ saved: { ...input, bookingRefNumber: 'OTHER1' } });

for (const status of [200, 202, 404]) {
  let reads = 0;
  const { client } = transport(async (url, init) => {
    if (url.pathname === '/auth/token') return token();
    reads++;
    assert.equal(url.pathname, `/api/bookings/${input.bookingCodeRef}/cancellation`);
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    return json(status === 200 ? receipt : {}, status);
  });
  assert.equal((await client.shapontravelsReadCancellation(input.bookingCodeRef)).httpStatus, status);
  assert.equal(reads, 1);
  await assert.rejects(client.shapontravelsReadCancellation('not-a-uuid'), error => error.code === 'INVALID_BOOKING_LOOKUP');
  assert.equal(reads, 1);
}

console.log('Shapontravels cancellation identity, explicit eligibility, protected unknown outcomes and one-shot transport passed');
