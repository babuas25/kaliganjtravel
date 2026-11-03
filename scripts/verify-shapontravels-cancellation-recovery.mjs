import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Real parsers and synthetic receipts only: no environment or HTTP/DB access.
function compile(file, imports = {}) {
  const module = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new vm.Script(source, { filename: file }).runInNewContext({
    module, exports: module.exports, Date,
    require(name) {
      if (name === 'server-only') return {};
      assert.ok(Object.hasOwn(imports, name), `Unexpected dependency ${name}`);
      return imports[name];
    },
  });
  return module.exports;
}
const status = compile('lib/shapontravels/booking-status.ts');
const { verifyShaponCancellationRecovery: verify } = compile(
  'lib/shapontravels/cancellation-recovery.ts', { './booking-status': status },
);
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = JSON.parse(fs.readFileSync(new URL(
  'fixtures/shapontravels-saved-booking-v1/cancelled.json', import.meta.url,
), 'utf8'));
const supplierCheckedAt = '2026-11-01T02:22:34.748635+00:00';
canonical.currentStatus = {
  reviewRequired: false, source: 'supplier_sync', status: 'cancelled',
  supplierCheckedAt, supplierStatus: 'Cancelled', verified: true,
};
canonical.savedBooking.currentStatus = clone(canonical.currentStatus);
const body = clone(canonical);
delete body.item1;
delete body.item2;
body.savedBooking.bookingStatus = null;
const saved = canonical.savedBooking;
const booking = {
  supplier: 'shapontravels', supplier_account: 'shapontravels', import_source: null,
  direct_ticketing: false, legacy_operational: false, status: 'in-progress',
  operation_kind: 'reconciliation', operation_reason: 'cancellation_reconciliation',
  active_operation_id: '11111111-1111-4111-8111-111111111111',
  payment_state: 'unpaid', payment_amount: null, captured_amount: 0, refunded_amount: 0,
  charged_wallet_account_id: null,
  issued_at: null, ticket_code_ref: null, ticket_numbers: [],
  booking_code_ref: saved.bookingCodeRef, booking_ref_number: saved.pnr, pnr: saved.pnr,
  supplier_refs: { uniqueTransId: saved.uniqueTransID, itemCodeRef: saved.itemCodeRef,
    priceCodeRef: saved.priceCodeRef },
};
const run = (first = canonical, second = null, local = booking) => verify(local,
  { httpStatus: 200, supplierPublicRef: saved.reference, body: first },
  second === null ? null : { httpStatus: 200, body: second }, saved.reference);
assert.ok(run(), 'Complete canonical-v1 cancellation with legacy wrappers needs only the saved booking GET');
assert.ok(run(body), 'Complete wrapperless saved-v1 cancellation also needs only the saved booking GET');
assert.ok(run(canonical, canonical), 'An optional matching ticket GET agrees with the canonical cancellation');
assert.equal(run().cancellationProof.ticketCount, 0);
assert.equal(run().cancellationProof.cancelled, true);
const parsed = status.verifyShapontravelsBookingStatus(
  { httpStatus: 200, supplierPublicRef: saved.reference, body: canonical },
  { ...booking.supplier_refs, bookingCodeRef: booking.booking_code_ref,
    bookingRefNumber: booking.booking_ref_number, pnr: booking.pnr, supplierPublicRef: saved.reference },
);
assert.equal(parsed.currentStatusState, 'available');
assert.equal(parsed.currentStatus.source, 'supplier_sync');
assert.equal(parsed.currentStatus.supplierCheckedAt, supplierCheckedAt,
  'A saved supplier-sync observation retains the supplier timestamp instead of the GET time');

const withTicketRead = ticketRead => verify(booking,
  { httpStatus: 200, supplierPublicRef: saved.reference, body: canonical }, ticketRead, saved.reference);
assert.ok(withTicketRead({ httpStatus: 404, body: { error: 'NOT_FOUND' } }),
  'Documented no-saved-issue response agrees with complete canonical cancellation evidence');
for (const ticketRead of [
  { httpStatus: 404, body: { error: 'FOREIGN_BOOKING' } },
  { httpStatus: 404, body: {} }, { httpStatus: 404, body: null },
  { httpStatus: 202, body: { error: 'NOT_FOUND' } },
  { httpStatus: 500, body: { error: 'NOT_FOUND' } },
]) assert.equal(withTicketRead(ticketRead), null, 'An optional inconclusive ticket read cannot close cancellation');

const legacy = clone(canonical);
delete legacy.savedBooking;
legacy.item1.ticketInfoes = [];
legacy.item1.ticketCodeRef = null;
assert.equal(run(legacy), null, 'An older receipt without canonical saved evidence still needs independent ticket proof');
assert.ok(run(legacy, legacy), 'The existing dual-200 legacy cancellation remains supported');
assert.equal(verify(booking, { httpStatus: 200, supplierPublicRef: saved.reference, body: legacy },
  { httpStatus: 404, body: { error: 'NOT_FOUND' } }, saved.reference), null,
  'Ticket NOT_FOUND alone never proves cancellation for a legacy receipt');

for (const mutate of [
  value => { value.savedBooking.issuedAt = '2026-11-02T10:00:00Z'; },
  value => { value.publicReceipt.issuedAt = '2026-11-02T10:00:00Z'; },
  value => { value.savedBooking.issuedAt = value.publicReceipt.issuedAt = '2026-11-02T10:00:00Z';
    value.savedBooking.publicReceipt = clone(value.publicReceipt); },
  value => { value.savedBooking.ticketCodeRef = booking.active_operation_id; },
  value => { value.savedBooking.ticketInfoes = [{ ticketNumbers: ['1234567890123'] }]; },
  value => { value.publicReceipt.tickets = [{ ticketNumbers: ['1234567890123'] }];
    value.savedBooking.publicReceipt = clone(value.publicReceipt); },
  value => { value.savedBooking.payment.state = 'captured'; },
  value => { value.customerPaymentState = 'paid'; },
  value => { value.paymentState = 'captured'; },
  value => { value.requiresReconciliation = true; },
  value => { value.savedBooking.reference = 'STRFOREIGN123'; },
  value => { value.savedBooking.bookingCodeRef = booking.active_operation_id; },
  value => { value.savedBooking.pnr = 'OTHER1'; },
  value => { value.publicReceipt.pendingReview = true; },
  value => { value.savedBooking.reviewRequired = true; },
  value => { value.currentStatus.reviewRequired = true;
    value.savedBooking.currentStatus = clone(value.currentStatus); },
  value => { value.currentStatus.status = 'in-progress';
    value.savedBooking.currentStatus = clone(value.currentStatus); },
  value => { value.savedBooking.schemaVersion = 2; },
  value => { value.savedBooking.ticketInfoes = null; },
  value => { value.savedBooking.paymentState = 'paid'; },
  value => { value.savedBooking.publicReceipt.paymentState = 'paid'; },
  value => { value.savedBooking.publicReceipt.status = 'on-hold'; },
  value => { value.item1.ticketInfoes = [{ ticketNumbers: ['1234567890123'] }]; },
  value => { value.item1.ticketCodeRef = booking.active_operation_id; },
  value => { value.item1.issuedAt = '2026-11-02T10:00:00Z'; },
  value => { value.item1.pnr = 'OTHER1'; },
  value => { value.item1.bookingCodeRef = booking.active_operation_id; },
  value => { value.item1.bookingStatus = 'Created'; },
  value => { value.item2.isSuccess = false; },
]) {
  const changed = clone(canonical);
  mutate(changed);
  assert.equal(run(changed), null, 'Contradictory issuance/payment/identity cannot close a cancellation');
  assert.equal(run(canonical, changed), null, 'An optional independent ticket read must also be conclusive');
}
for (const changes of [
  { status: 'on-hold' }, { operation_reason: 'ticketing_reconciliation' },
  { active_operation_id: null }, { payment_state: 'held' },
  { payment_state: 'reconciliation' }, { payment_state: 'captured' },
  { payment_amount: 0 }, { payment_amount: 1 }, { charged_wallet_account_id: booking.active_operation_id },
  { captured_amount: 1 }, { refunded_amount: 1 }, { issued_at: '2026-11-02T10:00:00Z' },
  { ticket_numbers: ['1234567890123'] }, { ticket_numbers: {} },
  { supplier: 'triplover' }, { import_source: 'MANUAL' }, { direct_ticketing: true },
]) assert.equal(run(canonical, null, { ...booking, ...changes }), null);
for (const [httpStatus, receipt] of [
  [404, { error: 'NOT_FOUND' }], [202, canonical], [500, canonical], [200, {}],
]) assert.equal(verify(booking,
  { httpStatus, supplierPublicRef: saved.reference, body: receipt },
  { httpStatus: 404, body: { error: 'NOT_FOUND' } }, saved.reference), null,
'Ticket NOT_FOUND cannot replace complete authenticated booking evidence');
console.log('PASS unpaid cancellation recovery: canonical-v1 supplier_sync with/without wrappers, saved GET-only and optional NOT_FOUND404, legacy dual reads, strict payment/identity/issuance conflicts; no network/database writes.');
