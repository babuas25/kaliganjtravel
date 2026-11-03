import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Actual scoped reader and recovery helpers, synthetic receipts and a read-only
// Supabase boundary. No environment files, HTTP, database RPCs or live writes.
function load(file, mocks = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new vm.Script(code, { filename: file }).runInNewContext({
    module, exports: module.exports, Date, Error, Buffer,
    console: { error() {} },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name === 'server-only' || name.startsWith('@/')) return {};
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return module.exports;
}

const clone = value => JSON.parse(JSON.stringify(value));
const status = load('lib/shapontravels/booking-status.ts');
const errors = load('lib/db/booking-read-error.ts');
const ticket = load('lib/shapontravels/ticket.ts', {
  './booking-status': status,
  './client': {},
  '@/lib/triplover/ticket-payload': load('lib/triplover/ticket-payload.ts'),
});
const eligibility = load('lib/shapontravels/external-ticket-confirmation.ts', {
  './booking-status': status, './ticket': ticket,
});
const cancellation = load('lib/shapontravels/cancellation-recovery.ts', {
  './booking-status': status,
});
const cancelledBody = JSON.parse(fs.readFileSync(new URL(
  'fixtures/shapontravels-saved-booking-v1/cancelled.json', import.meta.url,
), 'utf8'));
delete cancelledBody.item1;
delete cancelledBody.item2;
cancelledBody.currentStatus = clone(cancelledBody.savedBooking.currentStatus);
cancelledBody.savedBooking.bookingStatus = null;
cancelledBody.savedBooking.issuedAt = null;
cancelledBody.publicReceipt.issuedAt = null;
cancelledBody.savedBooking.publicReceipt = clone(cancelledBody.publicReceipt);
const saved = cancelledBody.savedBooking;
const operationId = '11111111-1111-4111-8111-111111111111';
const canonicalRef = 'KTT261031111111';
const historicalRef = 'STR261031111111';
const baseRow = {
  id: '22222222-2222-4222-8222-222222222222',
  attempt_id: '33333333-3333-4333-8333-333333333333',
  public_ref: canonicalRef,
  user_id: 'synthetic-owner', audience: 'agency', agency_code: 'ST-B2B000001',
  hidden_from_user: false,
  supplier: 'shapontravels', supplier_account: 'shapontravels', import_source: null,
  legacy_operational: false, direct_ticketing: false,
  status: 'in-progress', lifecycle_status: 'in-progress',
  operation_kind: 'reconciliation', operation_reason: 'cancellation_reconciliation',
  operation_request_id: 'synthetic-existing-operation',
  payment_state: 'unpaid', captured_amount: 0, refunded_amount: 0,
  payment_amount: null, charged_wallet_account_id: null,
  issued_at: null, ticket_code_ref: null, ticket_numbers: [],
  booking_code_ref: saved.bookingCodeRef, booking_ref_number: saved.pnr, pnr: saved.pnr,
  supplier_refs: { uniqueTransId: saved.uniqueTransID, itemCodeRef: saved.itemCodeRef,
    priceCodeRef: saved.priceCodeRef },
  passenger_counts: { ADT: saved.passengerCount },
  booking_owner_type: 'agency', booking_owner_key: 'ST-B2B000001',
  currency: 'BDT', pricing_snapshot: { sellingPrice: 2230 },
};

function harness(options = {}) {
  const calls = [];
  const viewRow = options.row === null ? null : { ...clone(baseRow), ...options.row };
  let scopedRowReturned = false;
  const db = { from(table) {
    const call = { table, columns: null, filters: [], completed: false };
    calls.push(call);
    const finish = async () => {
      call.completed = true;
      if (table === 'booking_reference_aliases') {
        return { data: call.filters.some(([key, value]) => key === 'alias' && value === historicalRef)
          ? { booking_id: baseRow.id } : null, error: null };
      }
      if (table === 'booking_lifecycle_v') {
        assert.equal(call.columns, '*', 'Keep the existing lifecycle projection');
        if (options.viewError) return { data: null, error: { message: 'Synthetic view failure' } };
        const found = viewRow && call.filters.every(([key, value]) => viewRow[key] === value);
        scopedRowReturned = Boolean(found);
        return { data: found ? clone(viewRow) : null, error: null };
      }
      assert.equal(table, 'flight_bookings', 'This regression must perform only scoped read enrichment');
      if (call.columns === 'public_ref') {
        assert.ok(call.filters.some(([key, value]) => key === 'id' && value === baseRow.id));
        return { data: { public_ref: canonicalRef }, error: null };
      }
      assert.equal(scopedRowReturned, true, 'Raw operation context is read only after a scoped row was returned');
      assert.equal(call.columns, 'active_operation_id', 'Read only the missing operation pointer');
      assert.ok(call.filters.some(([key, value]) => key === 'id' && value === baseRow.id),
        'Pin the raw lookup to the already-authorized booking ID');
      if (options.rawThrows) throw new Error('Synthetic raw transport failure');
      if (options.rawError) return { data: null, error: { message: 'Synthetic raw read failure' } };
      return { data: options.rawMissing ? null : { active_operation_id: operationId }, error: null };
    };
    const q = {
      select(columns) { call.columns = columns; return q; },
      eq(key, value) { call.filters.push([key, value]); return q; },
      limit() { return q; },
      maybeSingle: finish,
      single: finish,
    };
    return q;
  } };
  const reader = load('lib/db/flight-bookings.ts', {
    '@/lib/supabase/server': { supabaseAdmin: () => db },
    '@/lib/db/booking-read-error': errors,
    '@/lib/db/booking-visibility': { bookingUserVisibilitySchemaAvailable: async () => true },
  });
  return {
    calls, reader,
    contextReads: () => calls.filter(call => call.table === 'flight_bookings' && call.columns === 'active_operation_id'),
    lifecycleReads: () => calls.filter(call => call.table === 'booking_lifecycle_v'),
  };
}

const userScope = { kind: 'user', clerkId: baseRow.user_id };
const agencyScope = { kind: 'agency', agencyCode: baseRow.agency_code };
for (const scope of [userScope, agencyScope, { kind: 'all' }]) {
  const test = harness();
  const row = await test.reader.readBookingByPublicRef(canonicalRef, scope, true);
  assert.equal(row.active_operation_id, operationId);
  assert.equal(row.public_ref, canonicalRef);
  assert.equal(test.contextReads().length, 1);
  const scoped = test.lifecycleReads()[0];
  assert.equal(scoped.completed, true);
  if (scope.kind === 'user') assert.ok(scoped.filters.some(([key, value]) => key === 'user_id' && value === scope.clerkId));
  if (scope.kind === 'agency') assert.ok(scoped.filters.some(([key, value]) => key === 'agency_code' && value === scope.agencyCode));
  if (scope.kind !== 'all') assert.ok(scoped.filters.some(([key, value]) => key === 'hidden_from_user' && value === false));
  // Prove the actual cancellation helper can now reach its saved-receipt
  // evidence checks through the actual reader, with no artificial view pointer.
  assert.ok(cancellation.verifyShaponCancellationRecovery(row,
    { httpStatus: 200, supplierPublicRef: saved.reference, body: cancelledBody },
    { httpStatus: 200, body: cancelledBody }, saved.reference),
  'Scoped enrichment restores the real cancellation recovery path');
}

for (const scope of [
  { kind: 'user', clerkId: 'different-owner' },
  { kind: 'agency', agencyCode: 'different-agency' },
]) {
  const test = harness();
  assert.equal(await test.reader.readBookingByPublicRef(canonicalRef, scope, true), null);
  assert.equal(test.contextReads().length, 0, 'An out-of-scope booking cannot trigger a raw lookup');
}
for (const options of [{ row: null }, { row: { hidden_from_user: true } }]) {
  const test = harness(options);
  assert.equal(await test.reader.readBookingByPublicRef(canonicalRef, userScope, true), null);
  assert.equal(test.contextReads().length, 0, 'Missing or owner-hidden rows cannot trigger a raw lookup');
}

const alias = harness();
const aliased = await alias.reader.readBookingByPublicRef(historicalRef, agencyScope, true);
assert.equal(aliased.public_ref, canonicalRef);
assert.equal(aliased.active_operation_id, operationId);
assert.ok(alias.lifecycleReads()[0].filters.some(([key, value]) => key === 'public_ref' && value === canonicalRef));
assert.equal(alias.contextReads().length, 1, 'Alias resolution retains scoped authorization before enrichment');

for (const pointer of [operationId, null]) {
  const test = harness({ row: { active_operation_id: pointer } });
  const row = await test.reader.readBookingByPublicRef(canonicalRef, userScope, true);
  assert.equal(row.active_operation_id, pointer);
  assert.equal(test.contextReads().length, 0, 'A newer view owns an explicit pointer, including null');
}
for (const changes of [
  { supplier: 'triplover' }, { status: 'on-hold' }, { status: 'confirmed' },
  { operation_kind: 'ticketing' }, { operation_kind: null },
  { supplier_account: 'triplover' }, { import_source: 'IMP_EXP' },
  { import_source: 'MANUAL' }, { direct_ticketing: true }, { legacy_operational: true },
]) {
  const test = harness({ row: changes });
  assert.ok(await test.reader.readBookingByPublicRef(canonicalRef, userScope, true));
  assert.equal(test.contextReads().length, 0, 'Unrelated booking reads keep the existing query footprint');
}
const deniedAlias = harness();
assert.equal(await deniedAlias.reader.readBookingByPublicRef(historicalRef,
  { kind: 'agency', agencyCode: 'different-agency' }, true), null);
assert.equal(deniedAlias.contextReads().length, 0,
  'A recognized historical alias cannot bypass agency ownership for recovery context');
for (const strict of [false, true]) {
  const test = harness({ viewError: true });
  if (strict) {
    await assert.rejects(() => test.reader.readBookingByPublicRef(canonicalRef, agencyScope, true),
      errors.BookingReadUnavailableError);
  } else {
    assert.equal(await test.reader.readBookingByPublicRef(canonicalRef, agencyScope), null);
  }
  assert.equal(test.contextReads().length, 0,
    'A failed scope-authorizing view read never falls through to raw data');
}

for (const failure of [{ rawError: true }, { rawMissing: true }, { rawThrows: true }]) {
  const soft = harness(failure);
  assert.equal(await soft.reader.readBookingByPublicRef(canonicalRef, userScope), null,
    'Failed context lookup is not an eligible partial booking');
  const strict = harness(failure);
  await assert.rejects(() => strict.reader.readBookingByPublicRef(canonicalRef, userScope, true),
    errors.BookingReadUnavailableError);
}

const issue = harness({ row: {
  operation_reason: 'ticketing_reconciliation', payment_state: 'reconciliation',
} });
assert.equal(eligibility.isShaponTicketingRecovery({ ...baseRow,
  operation_reason: 'ticketing_reconciliation', payment_state: 'reconciliation' }), false,
'The previously omitted pointer reproduces the actual recovery blocker');
const recoveredIssue = await issue.reader.readBookingByPublicRef(canonicalRef, agencyScope, true);
assert.equal(eligibility.isShaponTicketingRecovery(recoveredIssue), true);
assert.equal(eligibility.canOfferShaponExternalTicketConfirmation(recoveredIssue), true,
  'The actual issued-ticket eligibility helper receives the restored pointer');

console.log('PASS scoped booking recovery context: omitted lifecycle pointer enriched after authorization, real cancellation/issued-ticket recovery helpers, user/agency/hidden boundaries, alias identity, newer view preservation and fail-closed raw read errors; no HTTP/database writes.');
