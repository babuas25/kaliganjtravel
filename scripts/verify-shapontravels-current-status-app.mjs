import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function compile(file, imports = {}, globals = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new vm.Script(source, { filename: file }).runInNewContext({
    module, exports: module.exports,
    require(name) {
      if (name === 'server-only') return {};
      assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`);
      return imports[name];
    },
    ...globals,
  });
  return module.exports;
}

const plain = value => JSON.parse(JSON.stringify(value));
const statusModule = compile('lib/shapontravels/booking-status.ts');
const publicStatus = compile('lib/flights/booking-status.ts');
const projection = compile('lib/shapontravels/current-status-projection.ts', {
  './booking-status': statusModule,
  '@/lib/flights/booking-status': publicStatus,
});
const permissions = compile('lib/wallet/permissions.ts', {
  '@/lib/impexp/booking-source': compile('lib/impexp/booking-source.ts'),
  '@/lib/shapontravels/current-status-projection': projection,
});

const requestStartedAt = '2026-10-03T09:30:00.123Z';
const evidenceTime = '2026-10-03T14:43:33.123456+06:00';
const current = {
  status: 'on-hold', bookingState: 'held', supplierStatus: 'Booked',
  supplierCheckedAt: evidenceTime, verified: true, source: 'supplier_pnr',
  checkedAt: evidenceTime, reviewRequired: false,
  lastCheck: { checkedAt: evidenceTime, verified: true, reasonCode: null },
};
const saved = {
  currentStatus: current, originalBookingStatus: 'Created', fetchedAt: requestStartedAt,
  effectiveStatus: 'on-hold', reviewRequired: false,
};
const ownerSession = { role: 'customer', clerkId: 'owner-user', agencyCode: null };
const booking = {
  supplier: 'shapontravels', booking_owner_type: 'user', booking_owner_key: 'owner-user',
  status: 'on-hold', lifecycle_status: 'on-hold', shapon_current_status: saved,
};
const parseSaved = projection.parseShapontravelsCurrentStatusProjection;
const blocksIssue = projection.shapontravelsCurrentStatusBlocksIssue;
const canIssue = permissions.canIssueBooking;
const publicCurrent = {
  status: 'on-hold', bookingState: null, supplierStatus: null, supplierCheckedAt: null,
  verified: false, source: 'public_receipt', checkedAt: null, reviewRequired: false, lastCheck: null,
};
const publicSaved = { ...saved, currentStatus: publicCurrent };
assert.deepEqual(plain(parseSaved(publicSaved)), publicSaved);
assert.equal(canIssue(ownerSession, { ...booking, shapon_current_status: publicSaved }), true,
  'a receipt-bound public hold retains normal local Issue permission without inventing private state');
for (const status of ['pending', 'in-progress', 'confirmed', 'cancelled', 'expired', 'unconfirmed']) {
  assert.equal(canIssue({ role: 'superadmin' }, { ...booking,
    shapon_current_status: { ...publicSaved, currentStatus: { ...publicCurrent, status } },
  }), false, 'public terminal or processing status blocks normal Issue for every role');
}
for (const changes of [
  { reviewRequired: true }, { verified: true }, { bookingState: 'held' },
  { supplierStatus: 'Booked' }, { checkedAt: evidenceTime }, { reviewRequired: null },
]) {
  assert.equal(canIssue(ownerSession, { ...booking,
    shapon_current_status: { ...publicSaved, currentStatus: { ...publicCurrent, ...changes } },
  }), false, 'public review or malformed private evidence cannot authorize Issue');
}

assert.deepEqual(plain(parseSaved(saved)), saved);
assert.equal(blocksIssue(booking), false);
assert.equal(canIssue(ownerSession, booking), true);
assert.equal(canIssue({ ...ownerSession, clerkId: 'someone-else' }, booking), false);
assert.equal(canIssue({ role: 'staff_support' }, booking), false);
for (const role of ['admin', 'superadmin', 'staff_account']) {
  assert.equal(canIssue({ role }, booking), true, `${role} retains existing authority for a clean live hold`);
}
assert.equal(canIssue({ role: 'staff_media' }, booking), false);
const agencyBooking = { ...booking, booking_owner_type: 'agency', booking_owner_key: 'agency-A' };
assert.equal(canIssue({ role: 'b2b', agencyCode: 'agency-A' }, agencyBooking), true);
assert.equal(canIssue({ role: 'b2b_sub', agencyCode: 'agency-A' }, agencyBooking), true);
assert.equal(canIssue({ role: 'b2b', agencyCode: 'agency-B' }, agencyBooking), false);

for (const status of ['pending', 'in-progress', 'confirmed', 'cancelled', 'expired', 'unconfirmed']) {
  const remote = { ...booking, shapon_current_status: { ...saved, currentStatus: { ...current, status } } };
  assert.equal(blocksIssue(remote), true, `${status} cannot be used as a fresh hold`);
  assert.equal(canIssue(ownerSession, remote), false, `${status} blocks the owner`);
  assert.equal(canIssue({ role: 'admin' }, remote), false, `${status} blocks the admin Issue action`);
}
for (const conflict of [
  { ...saved, reviewRequired: true },
  { ...saved, currentStatus: { ...current, reviewRequired: true } },
]) {
  assert.equal(canIssue(ownerSession, { ...booking, shapon_current_status: conflict }), false,
    'local and supplier review flags both prevent Issue');
}
assert.equal(canIssue(ownerSession, {
  ...booking, shapon_current_status: { ...saved, currentStatus: {
    ...current, verified: false, source: 'saved_booking', supplierStatus: null,
    supplierCheckedAt: null, checkedAt: null, lastCheck: null,
  } },
}), true, 'selected machine verification is not receipt identity or an added permission');
assert.equal(canIssue(ownerSession, {
  ...booking, shapon_current_status: { ...saved, currentStatus: {
    ...current, lastCheck: { checkedAt: requestStartedAt, verified: false, reasonCode: 'SUPPLIER_TIMEOUT' },
  } },
}), true, 'a failed later check does not erase the saved on-hold outcome');
for (const local of [
  { status: 'on-hold', lifecycle_status: 'expired' },
  { status: 'on-hold', lifecycle_status: 'unconfirmed' },
  { status: 'in-progress', lifecycle_status: 'in-progress' },
  { status: 'confirmed', lifecycle_status: 'confirmed' },
  { status: 'cancelled', lifecycle_status: 'cancelled' },
]) {
  assert.equal(canIssue({ role: 'admin' }, { ...booking, ...local }), false,
    'supplier on-hold evidence cannot override a local terminal or lifecycle guard');
}
assert.equal(canIssue(ownerSession, { ...booking, shapon_current_status: null }), true,
  'legacy absence preserves the original local hold rules');
assert.equal(canIssue({ role: 'admin' }, {
  ...booking, status: 'pending', lifecycle_status: 'pending', shapon_current_status: null,
}), true, 'legacy controlled pending staff path remains available');
assert.equal(canIssue(ownerSession, {
  ...booking, status: 'pending', lifecycle_status: 'pending', shapon_current_status: null,
}), false, 'legacy pending does not broaden customer authority');
assert.equal(canIssue(ownerSession, {
  ...booking, supplier: 'triplover', shapon_current_status: { broken: true },
}), true, 'Shapon metadata does not change another supplier Issue path');

for (const value of [
  {}, [], 'malformed', { ...saved, currentStatus: { ...current, status: 'Created' } },
  { ...saved, effectiveStatus: 'issuing' }, { ...saved, reviewRequired: 'false' },
  { ...saved, fetchedAt: 'not-a-date' }, { ...saved, originalBookingStatus: 'x'.repeat(101) },
]) {
  assert.equal(parseSaved(value), null);
  assert.equal(canIssue(ownerSession, { ...booking, shapon_current_status: value }), false,
    'present malformed saved metadata cannot authorize Issue');
}

let db = null;
let adminReads = 0;
let rpcReply = { data: { recorded: true, projectionUpdated: true }, error: null };
let rpcFailure = null;
const calls = [];
const logs = [];
const rpcDb = {
  async rpc(name, params) {
    calls.push({ name, params: plain(params) });
    if (rpcFailure) throw rpcFailure;
    return rpcReply;
  },
};
const store = compile('lib/shapontravels/current-status-store.ts', {
  '@/lib/supabase/server': { supabaseAdmin() { adminReads++; return db; } },
  './current-status-projection': projection,
}, { console: { error: (...args) => logs.push(args) } });
const expected = Object.freeze({
  uniqueTransId: '11111111-1111-4111-8111-111111111111',
  itemCodeRef: '22222222-2222-4222-8222-222222222222',
  priceCodeRef: '33333333-3333-4333-8333-333333333333',
  bookingCodeRef: '44444444-4444-4444-8444-444444444444',
  bookingRefNumber: '55555555-5555-4555-8555-555555555555',
  pnr: 'ABC123', supplierPublicRef: 'STR20261003124302',
});
const receipt = {
  item1: {
    uniqueTransID: expected.uniqueTransId, itemCodeRef: expected.itemCodeRef,
    priceCodeRef: expected.priceCodeRef, bookingCodeRef: expected.bookingCodeRef,
    bookingRefNumber: expected.bookingRefNumber, pnr: expected.pnr, bookingStatus: 'Created',
  },
  item2: { isSuccess: true },
};
const read = { httpStatus: 200, supplierPublicRef: expected.supplierPublicRef, body: { ...receipt, currentStatus: current } };
const verified = statusModule.verifyShapontravelsBookingStatus(read, expected);
const input = {
  bookingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', requestStartedAt,
  expected, status: verified,
};
const record = changes => store.recordShapontravelsCurrentStatus({ ...input, ...changes });
const assertStorage = (value, storage, updated = false) => {
  assert.deepEqual(plain(value), { projectionUpdated: updated, currentStatusStorage: storage });
};

const skipStatuses = [
  statusModule.verifyShapontravelsBookingStatus({ ...read, httpStatus: 202,
    body: { bookingId: expected.bookingCodeRef, currentStatus: current } }, expected),
  statusModule.verifyShapontravelsBookingStatus({ ...read, httpStatus: 404 }, expected),
  statusModule.verifyShapontravelsBookingStatus({ ...read, body: receipt }, expected),
  statusModule.verifyShapontravelsBookingStatus({ ...read, body: { ...receipt, currentStatus: null } }, expected),
  statusModule.verifyShapontravelsBookingStatus({ ...read, body: { ...receipt,
    currentStatus: { status: 'on-hold', reviewRequired: false },
  } }, expected),
  statusModule.verifyShapontravelsBookingStatus({ ...read, supplierPublicRef: 'STRDIFFERENT123' }, expected),
  statusModule.verifyShapontravelsBookingStatus({ ...read, body: { ...read.body, item2: { isSuccess: false } } }, expected),
];
for (const status of skipStatuses) assertStorage(await record({ status }), 'not_recorded');
assertStorage(await record({ expected: { ...expected, supplierPublicRef: null } }), 'not_recorded');
assert.equal(adminReads, 0, 'untrusted/pending/legacy/invalid evidence does not access the database');
assert.equal(calls.length, 0);

assertStorage(await record(), 'unavailable');
assert.equal(calls.length, 0, 'missing admin DB still returns the successful read to the app');
db = rpcDb;
assertStorage(await record(), 'saved', true);
assert.equal(calls.length, 1);
assert.deepEqual(calls[0], {
  name: 'record_shapon_booking_current_status_v1',
  params: {
    p_booking_id: input.bookingId, p_request_started_at: requestStartedAt,
    p_supplier_public_ref: expected.supplierPublicRef,
    p_receipt_identity: { ...expected, originalBookingStatus: 'Created' },
    p_current_status: current,
  },
}, 'the request start and immutable original Book identifiers are passed unchanged');
assert.equal(expected.bookingRefNumber, '55555555-5555-4555-8555-555555555555');
assert.equal(receipt.item1.bookingStatus, 'Created');

const compactStatus = statusModule.verifyShapontravelsBookingStatus({ ...read,
  body: { ...receipt, currentStatus: { status: 'on-hold', reviewRequired: false },
    publicReceipt: { status: 'on-hold', pendingReview: false, actions: { canIssue: true } },
  },
}, expected);
assert.deepEqual(plain(compactStatus.currentStatus), publicCurrent);
rpcReply = { data: { recorded: true, projectionUpdated: true, currentStatus: publicSaved }, error: null };
assert.deepEqual(plain(await record({ status: compactStatus })), {
  projectionUpdated: true, currentStatusStorage: 'saved',
  displayStatus: 'on-hold', displayReviewRequired: false,
});
assert.deepEqual(calls.at(-1).params.p_current_status, publicCurrent,
  'public status storage carries explicit provenance without supplier verification or timestamps');
assert.deepEqual(calls.at(-1).params.p_receipt_identity, { ...expected, originalBookingStatus: 'Created' },
  'compact status storage keeps every original identity pin');
rpcReply = { data: { recorded: true, projectionUpdated: true }, error: null };

const adminStatus = statusModule.verifyShapontravelsBookingStatus({ ...read,
  body: { ...read.body, currentStatus: { ...current, status: 'confirmed',
    source: 'admin_decision', verified: false, reviewRequired: true } },
}, expected);
assertStorage(await record({ status: adminStatus }), 'saved', true);
assert.equal(calls.at(-1).params.p_current_status.verified, false,
  'Admin precedence is recorded even though the selected source is not machine verified');

const remoteConfirmed = {
  ...current, status: 'confirmed', bookingState: 'manually_resolved',
  source: 'admin_decision', verified: false,
};
const localHoldConflict = {
  ...saved, currentStatus: remoteConfirmed, effectiveStatus: 'unconfirmed', reviewRequired: true,
};
const remoteConfirmedStatus = statusModule.verifyShapontravelsBookingStatus({ ...read,
  body: { ...read.body, currentStatus: remoteConfirmed },
}, expected);
rpcReply = { data: {
  recorded: true, projectionUpdated: true, currentStatus: localHoldConflict,
}, error: null };
assert.deepEqual(plain(await record({ status: remoteConfirmedStatus })), {
  projectionUpdated: true, currentStatusStorage: 'saved',
  displayStatus: 'unconfirmed', displayReviewRequired: true,
}, 'remote confirmation does not invent local ticket/payment completion; display uses the RPC projection');
assert.equal(remoteConfirmedStatus.currentStatus.status, 'confirmed');
assert.equal(remoteConfirmedStatus.currentStatus.verified, false);
assert.equal(remoteConfirmedStatus.currentStatus.reviewRequired, false,
  'the RPC local review flag is independent of the remote API review flag');

rpcReply = { data: {
  recorded: true, projectionUpdated: false, currentStatus: {
    ...saved, currentStatus: { ...current, status: 'cancelled', supplierStatus: 'Cancelled' },
    effectiveStatus: 'confirmed', reviewRequired: true,
  },
}, error: null };
assert.deepEqual(plain(await record()), {
  projectionUpdated: false, currentStatusStorage: 'saved',
  displayStatus: 'confirmed', displayReviewRequired: true,
}, 'an unchanged RPC projection still exposes local terminal precedence and its review conflict');
for (const currentStatus of [null, { ...localHoldConflict, effectiveStatus: 'issuing' }, {
  ...localHoldConflict, currentStatus: { ...remoteConfirmed, verified: 'false' },
}]) {
  rpcReply = { data: { recorded: true, projectionUpdated: false, currentStatus }, error: null };
  assertStorage(await record(), 'saved');
}
rpcReply = { data: {
  recorded: false, projectionUpdated: true, currentStatus: localHoldConflict,
}, error: null };
assertStorage(await record(), 'not_recorded');

rpcReply = { data: { recorded: true, projectionUpdated: false }, error: null };
assertStorage(await record(), 'saved');
for (const data of [{ recorded: false }, {}, { recorded: 'true', projectionUpdated: true }]) {
  rpcReply = { data, error: null };
  assertStorage(await record(), 'not_recorded');
}
rpcReply = { data: { recorded: true, projectionUpdated: 'true' }, error: null };
assertStorage(await record(), 'saved');
for (const reply of [
  { data: null, error: { code: 'PGRST202', message: 'missing RPC' } },
  { data: null, error: null },
  { data: [], error: null },
  { data: 'invalid', error: null },
]) {
  rpcReply = reply;
  assertStorage(await record(), 'unavailable');
}
assert.ok(logs.length > 0);
assert.equal(logs[0][1].code, 'PGRST202');
assert.equal(Object.hasOwn(logs[0][1], 'message'), false, 'storage log keeps only the safe database code');
rpcFailure = new Error('fixture RPC transport failure');
assertStorage(await record(), 'unavailable');
assert.equal(calls.every(call => call.params.p_request_started_at === requestStartedAt), true,
  'all storage attempts retain the original request start; none substitute the completion time');

console.log('Shapontravels saved current status, Issue gates and optional storage passed');
