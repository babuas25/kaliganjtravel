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
assert.equal(verified.supplierStatus, 'Created');
assert.equal(verified.supplierPublicRef, expected.supplierPublicRef);
assert.equal(verified.ticketedEvidencePresent, false);
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
console.log('Shapontravels read-only status verification passed');
