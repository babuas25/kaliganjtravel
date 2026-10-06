import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const sourcePath = 'lib/shapontravels/booking-status.ts';
const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const module = { exports: {} };
new vm.Script(compiled.outputText, { filename: sourcePath }).runInNewContext({
  module, exports: module.exports, Date,
});
const verify = module.exports.verifyShapontravelsBookingStatus;
const parseCurrent = module.exports.parseShapontravelsCurrentStatus;
const expected = {
  uniqueTransId: 'transaction-uuid', itemCodeRef: 'item-uuid',
  priceCodeRef: 'price-uuid', bookingCodeRef: 'booking-uuid',
  bookingRefNumber: 'receipt-uuid', pnr: 'ABC123',
  supplierPublicRef: 'STRABC123ABC123',
};
const receipt = {
  item1: {
    uniqueTransID: expected.uniqueTransId, itemCodeRef: expected.itemCodeRef,
    priceCodeRef: expected.priceCodeRef, bookingCodeRef: expected.bookingCodeRef,
    bookingRefNumber: expected.bookingRefNumber, pnr: expected.pnr,
    bookingStatus: 'Created', ticketingTimeLimit: '27/09/2026 04:47:57',
  },
  item2: { isSuccess: true },
};
const read = { httpStatus: 200, supplierPublicRef: expected.supplierPublicRef, body: receipt };
const verified = verify(read, expected);
assert.equal(verified.result, 'verified');
assert.equal(verified.currentStatusState, 'absent');
assert.equal(verified.currentStatus, null);
assert.equal(verified.originalBookingStatus, 'Created');
assert.equal(verified.supplierStatus, 'Created');
assert.equal(verified.supplierPublicRef, expected.supplierPublicRef);
assert.equal(verified.ticketedEvidencePresent, false);
assert.ok(Number.isFinite(Date.parse(verified.checkedAt)));
assert.equal(verify({ ...read, body: { ...receipt, item1: { ...receipt.item1,
  ticketInfoes: [] } } }, expected).ticketedEvidencePresent, false);
assert.equal(verify({ ...read, body: { ...receipt, item1: { ...receipt.item1,
  ticketInfoes: [{ ticketNo: '1234567890' }] } } }, expected).ticketedEvidencePresent, true);
assert.equal(verify({ ...read, body: { ...receipt, item1: { ...receipt.item1,
  uniqueTransID: 'another-transaction' } } }, expected).result, 'mismatch');
assert.equal(verify({ ...read, supplierPublicRef: 'STRDIFFERENT123' }, expected).result, 'mismatch');
assert.equal(verify({ ...read, supplierPublicRef: null }, expected).result, 'unverified');
assert.equal(verify({ httpStatus: 202, supplierPublicRef: expected.supplierPublicRef,
  body: { bookingId: expected.bookingCodeRef, state: 'pending' } }, expected).result, 'pending');
assert.equal(verify({ httpStatus: 202, supplierPublicRef: expected.supplierPublicRef,
  body: { bookingId: 'different-uuid', state: 'pending' } }, expected).result, 'mismatch');
assert.equal(verify({ httpStatus: 404, supplierPublicRef: null, body: {} }, expected).result, 'not_found');

const legacyExpected = { ...expected, bookingRefNumber: '55555555-5555-4555-8555-555555555555' };
const publicReferenceRead = { ...read, body: { ...receipt, item1: {
  ...receipt.item1, bookingRefNumber: expected.pnr,
} } };
assert.equal(verify(publicReferenceRead, legacyExpected).result, 'verified',
  'a legacy UUID row verifies the current public PNR mirror with every other identity pinned');
assert.equal(verify(publicReferenceRead, { ...expected, bookingRefNumber: expected.pnr }).result, 'verified');
for (const changes of [
  { bookingRefNumber: 'foreign-ref' },
  { bookingRefNumber: '66666666-6666-4666-8666-666666666666' },
  { pnr: 'OTHER1' },
  { uniqueTransID: 'another-transaction' },
  { itemCodeRef: 'another-item' },
  { priceCodeRef: 'another-price' },
  { bookingCodeRef: 'another-booking' },
]) {
  assert.equal(verify({ ...publicReferenceRead, body: { ...publicReferenceRead.body,
    item1: { ...publicReferenceRead.body.item1, ...changes },
  } }, legacyExpected).result, 'mismatch', 'public PNR compatibility does not relax another identity pin');
}
assert.equal(verify(publicReferenceRead, { ...legacyExpected, pnr: null }).result, 'mismatch',
  'legacy reference compatibility requires a saved PNR');
assert.equal(verify(publicReferenceRead, { ...expected, bookingRefNumber: 'arbitrary-old-ref' }).result, 'mismatch');

const supplierTime = '2026-10-03T14:43:33.123456+06:00';
const laterCheckTime = '2026-10-03T09:01:02Z';
const current = {
  status: 'cancelled', bookingState: 'held', supplierStatus: 'Cancelled',
  supplierCheckedAt: supplierTime, verified: true, source: 'supplier_pnr',
  checkedAt: supplierTime, reviewRequired: true,
  lastCheck: { checkedAt: supplierTime, verified: true, reasonCode: null },
};
assert.deepEqual(JSON.parse(JSON.stringify(parseCurrent(current))), current);
assert.equal(parseCurrent(undefined), null);
assert.equal(parseCurrent(null), null);
const currentRead = (metadata, body = receipt) => ({
  ...read, body: { ...body, currentStatus: metadata },
});
const plain = value => JSON.parse(JSON.stringify(value));
const compactRead = (metadata, publicReceipt = {
  status: metadata.status, pendingReview: false, actions: { canIssue: metadata.status === 'on-hold' },
}) => ({ ...currentRead(metadata), body: { ...receipt, currentStatus: metadata, publicReceipt } });
const publicCurrent = (status = 'on-hold', reviewRequired = false) => ({
  status, bookingState: null, supplierStatus: null, supplierCheckedAt: null,
  verified: false, source: 'public_receipt', checkedAt: null, reviewRequired, lastCheck: null,
});
for (const status of ['pending', 'on-hold', 'confirmed', 'in-progress', 'cancelled', 'expired', 'unconfirmed']) {
  const value = verify(compactRead({ status, reviewRequired: false }), expected);
  assert.equal(value.result, 'verified');
  assert.equal(value.currentStatusState, 'available');
  assert.deepEqual(plain(value.currentStatus), publicCurrent(status));
  assert.deepEqual(plain(parseCurrent(value.currentStatus)), publicCurrent(status),
    'normalized public receipt metadata can be saved and read without private evidence');
  assert.equal(value.originalBookingStatus, 'Created');
  assert.equal(value.supplierStatus, null);
  assert.equal(value.ticketedEvidencePresent, false,
    'a public confirmed status does not manufacture ticket evidence');
}
for (const publicReceipt of [
  { status: 'on-hold', pendingReview: false, actions: { canIssue: false } },
  { status: 'on-hold', pendingReview: true, actions: { canIssue: true } },
]) {
  assert.deepEqual(plain(verify(compactRead({ status: 'on-hold', reviewRequired: false }, publicReceipt), expected).currentStatus),
    publicCurrent('on-hold', true), 'a compact hold must also explicitly allow Issue without public review');
}
assert.deepEqual(plain(verify(compactRead({ status: 'on-hold', reviewRequired: true }), expected).currentStatus),
  publicCurrent('on-hold', true), 'an Issue capability cannot clear the original review flag');
for (const publicReceipt of [
  null, {}, { status: 'cancelled', pendingReview: false, actions: { canIssue: true } },
  { status: 'on-hold', pendingReview: null, actions: { canIssue: true } },
  { status: 'on-hold', pendingReview: false },
  { status: 'on-hold', pendingReview: false, actions: {} },
  { status: 'on-hold', pendingReview: false, actions: { canIssue: 'true' } },
]) {
  const value = verify(compactRead({ status: 'on-hold', reviewRequired: false }, publicReceipt), expected);
  assert.equal(value.currentStatusState, 'invalid');
  assert.equal(value.currentStatus, null, 'missing or conflicting public capability cannot authorize a hold');
}
assert.equal(verify(currentRead({ status: 'on-hold', reviewRequired: false }), expected).currentStatusState, 'invalid');
assert.equal(parseCurrent({ status: 'on-hold', reviewRequired: false }), null,
  'raw compact status requires its receipt capabilities; the saved parser alone cannot infer them');
for (const publicReceipt of [
  { status: 'on-hold', pendingReview: false, actions: { canIssue: true } },
  { status: 'on-hold', pendingReview: false, actions: { canIssue: false } },
  { status: 'on-hold', pendingReview: true, actions: { canIssue: true } },
]) {
  assert.equal(verify(compactRead(publicCurrent(), publicReceipt), expected).currentStatusState, 'invalid',
    'a raw supplier response cannot impersonate the normalized saved public source');
}
for (const metadata of [
  { status: 'on-hold' }, { status: 'on-hold', reviewRequired: null },
  { status: 'on-hold', reviewRequired: 'false' },
  { status: 'on-hold', reviewRequired: false, bookingState: 'held' },
  { status: 'on-hold', reviewRequired: false, source: 'saved_booking' },
  { ...publicCurrent(), verified: true }, { ...publicCurrent(), bookingState: 'held' },
  { ...publicCurrent(), supplierStatus: 'Booked' },
  { ...publicCurrent(), checkedAt: supplierTime },
  { ...publicCurrent(), supplierCheckedAt: supplierTime },
  { ...publicCurrent(), lastCheck: { checkedAt: supplierTime, verified: true, reasonCode: null } },
  { ...publicCurrent(), reviewRequired: null }, { ...publicCurrent(), extra: 'private' },
]) {
  assert.equal(verify(compactRead(metadata), expected).currentStatusState, 'invalid',
    'public receipt compatibility accepts only the explicit compact or normalized conservative contract');
  assert.equal(parseCurrent(metadata), null);
}
const compactMismatch = compactRead({ status: 'on-hold', reviewRequired: false });
assert.equal(verify({ ...compactMismatch, body: { ...compactMismatch.body, item1: {
  ...receipt.item1, bookingCodeRef: 'different-booking',
} } }, expected).result, 'mismatch', 'a public action cannot override receipt identity');
const assertCurrent = (metadata, message) => {
  const value = verify(currentRead(metadata), expected);
  assert.equal(value.result, 'verified', message);
  assert.equal(value.currentStatusState, 'available', message);
  assert.equal(value.originalBookingStatus, 'Created', message);
  assert.deepEqual(plain(value.currentStatus), plain(metadata), message);
  assert.equal(value.supplierStatus, metadata.supplierStatus, message);
  return value;
};

// A successful identity check does not turn the immutable Book receipt into current evidence.
const cancelled = assertCurrent(current, 'held booking with verified supplier cancellation');
assert.equal(cancelled.currentStatus.status, 'cancelled');
assert.equal(cancelled.currentStatus.bookingState, 'held');
assert.equal(cancelled.currentStatus.supplierCheckedAt, supplierTime);
assert.equal(cancelled.currentStatus.checkedAt, supplierTime);
assert.notEqual(cancelled.checkedAt, supplierTime);
assert.equal(cancelled.ticketedEvidencePresent, false);
assert.equal(receipt.item1.bookingStatus, 'Created');
assert.equal(Object.hasOwn(receipt, 'currentStatus'), false);

const admin = assertCurrent({
  ...current, status: 'confirmed', bookingState: 'manually_resolved', verified: false,
  source: 'admin_decision', checkedAt: '2026-10-03T08:40:00+00:00',
}, 'admin outcome keeps precedence while newer raw supplier cancellation stays visible');
assert.equal(admin.currentStatus.status, 'confirmed');
assert.equal(admin.currentStatus.verified, false);
assert.equal(admin.currentStatus.supplierStatus, 'Cancelled');
assert.equal(admin.currentStatus.supplierCheckedAt, supplierTime);
assert.equal(admin.currentStatus.reviewRequired, true);
assert.equal(admin.ticketedEvidencePresent, false);

assertCurrent({
  ...current, status: 'in-progress', bookingState: 'issuing', source: 'ticket_operation',
  verified: false, checkedAt: '2026-10-03T08:50:00Z',
}, 'unfinished ticket operation stays in progress despite supplier cancellation');
assertCurrent({
  ...current, status: 'confirmed', bookingState: 'issued', source: 'ticket_operation',
  verified: true, checkedAt: '2026-10-03T08:50:00Z',
}, 'completed ticket operation retains its effective outcome');
assertCurrent({
  ...current, status: 'cancelled', bookingState: 'cancelled', source: 'cancellation_operation',
  checkedAt: '2026-10-03T08:55:00Z',
}, 'completed cancellation operation retains its effective outcome');
assertCurrent({
  ...current, status: 'expired', source: 'staff_manual', verified: false,
  supplierStatus: 'Booked', checkedAt: '2026-10-03T08:55:00Z',
}, 'manual cutoff differs from the supplier status without claiming supplier verification');
for (const [status, source, bookingState] of [
  ['pending', 'saved_booking', 'pending'],
  ['on-hold', 'saved_booking', 'held'],
  ['unconfirmed', 'saved_import', null],
]) {
  assertCurrent({
    ...current, status, source, bookingState, verified: false,
    supplierStatus: null, supplierCheckedAt: null, checkedAt: null,
    reviewRequired: false, lastCheck: null,
  }, `${source} ${status} has no invented supplier check`);
}

for (const reasonCode of [
  'SUPPLIER_TIMEOUT', 'SUPPLIER_READ_FAILED', 'SUPPLIER_RECONCILIATION_FAILED',
  'SUPPLIER_AUTH_FAILED', 'S'.repeat(80),
]) {
  const failed = assertCurrent({
    ...current, lastCheck: { checkedAt: laterCheckTime, verified: false, reasonCode },
  }, `${reasonCode} does not replace the prior verified cancellation`);
  assert.equal(failed.currentStatus.verified, true);
  assert.equal(failed.currentStatus.supplierStatus, 'Cancelled');
  assert.equal(failed.currentStatus.checkedAt, supplierTime);
  assert.equal(failed.currentStatus.lastCheck.checkedAt, laterCheckTime);
  assert.equal(failed.currentStatus.lastCheck.verified, false);
}

const optional = { ...current };
delete optional.reviewRequired;
delete optional.lastCheck;
const optionalResult = verify(currentRead(optional), expected);
assert.equal(optionalResult.currentStatusState, 'available');
assert.equal(optionalResult.currentStatus.reviewRequired, null);
assert.equal(optionalResult.currentStatus.lastCheck, null);
assert.deepEqual(plain(parseCurrent(plain(optionalResult.currentStatus))), plain(optionalResult.currentStatus),
  'parsed optional metadata remains valid when saved and read back');
const withoutReason = verify(currentRead({
  ...current, lastCheck: { checkedAt: laterCheckTime, verified: false },
}), expected);
assert.equal(withoutReason.currentStatus.lastCheck.reasonCode, null);

assertCurrent({ ...current, status: 'unconfirmed', supplierStatus: null },
  'a sparse verified PNR may have a check timestamp without a supplier status');
assertCurrent({
  ...current, supplierStatus: '  CaNcElEd  ',
  supplierCheckedAt: '2020-02-29T23:59:59.987654321-05:30',
  checkedAt: '2020-02-29T23:59:59.987654321-05:30',
}, 'raw supplier text and old evidence offsets stay intact without a freshness cutoff');
const additive = verify(currentRead({
  ...current, futureField: { safeToIgnore: true },
  lastCheck: { ...current.lastCheck, futureCheckField: 'optional' },
}), expected);
assert.equal(additive.currentStatusState, 'available');
assert.deepEqual(plain(additive.currentStatus), current);

const missingField = name => {
  const metadata = { ...current };
  delete metadata[name];
  return metadata;
};
const malformed = [
  ['null', null], ['array', []], ['string', 'Cancelled'],
  ['unknown normalized status', { ...current, status: 'Created' }],
  ['unknown source', { ...current, source: 'live' }],
  ['string verification', { ...current, verified: 'true' }],
  ['null verification', { ...current, verified: null }],
  ...['status', 'source', 'verified', 'bookingState', 'supplierStatus', 'supplierCheckedAt', 'checkedAt']
    .map(name => [`missing ${name}`, missingField(name)]),
  ['unbounded booking state', { ...current, bookingState: 'x'.repeat(101) }],
  ['unbounded supplier text', { ...current, supplierStatus: 'x'.repeat(101) }],
  ['blank supplier text', { ...current, supplierStatus: '  ' }],
  ['control character supplier text', { ...current, supplierStatus: 'Cancelled\n' }],
  ['numeric supplier text', { ...current, supplierStatus: 42 }],
  ['supplier status without evidence timestamp', { ...current, supplierCheckedAt: null }],
  ...[
    '2026-10-03T14:43:33', '03/10/2026 14:43:33', '2025-02-29T14:43:33Z',
    '2026-02-31T14:43:33Z', '2026-13-03T14:43:33Z', '2026-10-03T24:43:33Z',
    '2026-10-03T14:43:33+00:60',
  ].map(checkedAt => [`invalid timestamp ${checkedAt}`, { ...current, checkedAt }]),
  ['invalid supplier timestamp', { ...current, supplierCheckedAt: 'yesterday' }],
  ['numeric review flag', { ...current, reviewRequired: 0 }],
  ['string review flag', { ...current, reviewRequired: 'false' }],
  ['array last check', { ...current, lastCheck: [] }],
  ['string last check', { ...current, lastCheck: 'timeout' }],
  ['last check missing timestamp', { ...current, lastCheck: { verified: false } }],
  ['last check null timestamp', { ...current, lastCheck: { checkedAt: null, verified: false } }],
  ['last check missing zone', { ...current, lastCheck: { checkedAt: '2026-10-03T09:01:02', verified: false } }],
  ['last check string verification', { ...current, lastCheck: { checkedAt: laterCheckTime, verified: 'false' } }],
  ['last check missing verification', { ...current, lastCheck: { checkedAt: laterCheckTime } }],
  ['last check unsafe reason detail', { ...current, lastCheck: { checkedAt: laterCheckTime, verified: false, reasonCode: 'supplier timeout: credential detail' } }],
  ['last check reason starts with digit', { ...current, lastCheck: { checkedAt: laterCheckTime, verified: false, reasonCode: '1_TIMEOUT' } }],
  ['last check unbounded reason', { ...current, lastCheck: { checkedAt: laterCheckTime, verified: false, reasonCode: 'x'.repeat(81) } }],
];
for (const [message, metadata] of malformed) {
  const value = verify(currentRead(metadata), expected);
  assert.equal(value.result, 'verified', message);
  assert.equal(value.currentStatusState, 'invalid', message);
  assert.equal(value.currentStatus, null, message);
  assert.equal(value.originalBookingStatus, 'Created', message);
  assert.equal(value.supplierStatus, null, `${message}: never fall back to historical Created`);
  assert.equal(parseCurrent(metadata), null, message);
}

const assertUntrusted = (reading, result, message) => {
  const value = verify(reading, expected);
  assert.equal(value.result, result, message);
  assert.equal(value.currentStatusState, 'absent', message);
  assert.equal(value.currentStatus, null, message);
  assert.equal(value.originalBookingStatus, null, message);
  assert.equal(value.supplierStatus, null, message);
  assert.equal(value.ticketedEvidencePresent, false, message);
};
for (const name of ['uniqueTransID', 'itemCodeRef', 'priceCodeRef', 'bookingCodeRef', 'bookingRefNumber', 'pnr']) {
  assertUntrusted(currentRead(current, {
    ...receipt, item1: { ...receipt.item1, [name]: 'different', ticketCodeRef: 'ticket-id' },
  }), 'mismatch', `current metadata cannot bypass ${name} identity`);
}
assertUntrusted({ ...currentRead(current), supplierPublicRef: 'STRDIFFERENT123' }, 'mismatch', 'wrong public reference');
assertUntrusted({ ...currentRead(current), supplierPublicRef: null }, 'unverified', 'missing public reference');
assertUntrusted(currentRead(current, { ...receipt, item2: { isSuccess: false } }), 'unverified', 'failed saved receipt');
assertUntrusted({ httpStatus: 404, supplierPublicRef: null, body: { currentStatus: current } }, 'not_found', '404 has no trusted current metadata');

// Legacy 202 protocol remains pending even when the independently verified current outcome is cancelled.
const pendingRead = {
  httpStatus: 202, supplierPublicRef: expected.supplierPublicRef,
  body: { bookingId: expected.bookingCodeRef, state: 'held', currentStatus: current },
};
const pending = verify(pendingRead, expected);
assert.equal(pending.result, 'pending');
assert.equal(pending.currentStatusState, 'available');
assert.equal(pending.currentStatus.status, 'cancelled');
assert.equal(pending.supplierStatus, 'Cancelled');
assert.equal(pending.originalBookingStatus, null);
assert.equal(pending.ticketedEvidencePresent, false);
assertUntrusted({ ...pendingRead, body: { ...pendingRead.body, bookingId: 'wrong-booking' } }, 'mismatch', '202 wrong booking ID');
assertUntrusted({ ...pendingRead, supplierPublicRef: 'STRDIFFERENT123' }, 'mismatch', '202 wrong public reference');
for (const reading of [
  { ...pendingRead, body: { state: 'held', currentStatus: current } },
  { ...pendingRead, supplierPublicRef: null },
]) {
  const value = verify(reading, expected);
  assert.equal(value.result, 'pending');
  assert.equal(value.currentStatusState, 'invalid');
  assert.equal(value.currentStatus, null);
}
assert.equal(verify({ ...pendingRead, body: { bookingId: expected.bookingCodeRef } }, expected).currentStatusState, 'absent');
const byPublicRef = verify({ ...pendingRead, body: { currentStatus: current } }, { ...expected, bookingCodeRef: null });
assert.equal(byPublicRef.result, 'pending');
assert.equal(byPublicRef.currentStatusState, 'available');
assert.equal(verify(pendingRead, { ...expected, bookingCodeRef: null, supplierPublicRef: null }).currentStatusState, 'invalid');

const confirmed = { ...current, status: 'confirmed', source: 'ticket_operation' };
assert.equal(verify(currentRead(confirmed), expected).ticketedEvidencePresent, false,
  'a normalized confirmed status alone is not actual ticket evidence');
assert.equal(verify(currentRead(confirmed, {
  ...receipt, item1: { ...receipt.item1, ticketCodeRef: 'ticket-id' },
}), expected).ticketedEvidencePresent, true);
assert.equal(verify(currentRead(current, {
  ...receipt, item1: { ...receipt.item1, ticketInfoes: [{ ticketNo: '1234567890' }] },
}), expected).ticketedEvidencePresent, true,
  'original actual ticket fields remain evidence independently of current cancellation');
console.log('Shapontravels read-only status verification passed');
