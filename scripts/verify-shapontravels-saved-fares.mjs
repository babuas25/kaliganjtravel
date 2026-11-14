import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const module = { exports: {} };
const file = 'lib/shapontravels/saved-fares.ts';
const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
Function('module', 'exports', source)(module, module.exports);
const { readShapontravelsSavedPayable } = module.exports;

const amounts = {
  baseFare: '1000.00', taxes: '200.00', ait: '10.00', serviceCharge: '5.00',
  charge: '5.00', discount: '100.00', gross: '1200.00', payable: '1115.00',
};
const fixture = () => ({
  schemaVersion: 1, status: 'confirmed', paymentState: 'paid',
  reviewRequired: false, requiresReconciliation: false, passengerCount: 2,
  passengerInfoes: ['ADT', 'CHD'].map((passengerType, passengerIndex) => ({
    passengerIndex, passengerId: `synthetic:passenger:${passengerIndex}`, passengerType,
  })),
  fareBreakdown: {
    currency: 'BDT', passengerCount: 2, baseFare: '2000.00', taxes: '400.00', ait: '20.00',
    serviceCharge: '10.00', charge: '10.00', discount: '200.00', gross: '2400.00',
    payable: '2214.99', specialDiscount: '-15.01',
    passengers: ['ADT', 'CHD'].map((passengerType, passengerIndex) => ({
      passengerIndex, passengerId: `synthetic:passenger:${passengerIndex}`, passengerType,
      currency: 'BDT', ...amounts,
    })),
  },
});
const read = (saved = fixture(), envelope = {}) => readShapontravelsSavedPayable(saved, envelope);
const expected = { supplierPayableMinor: '221499', specialDiscountMinor: '-1501' };
const saved = fixture();
assert.deepEqual(read(saved), expected);
assert.deepEqual(saved, fixture(), 'Saved fare evidence remains unchanged');
saved.passengerInfoes.reverse();
saved.fareBreakdown.passengers.reverse();
assert.deepEqual(read(saved), expected);

const unequal = fixture();
Object.assign(unequal.fareBreakdown.passengers[0], { baseFare: '900.00', gross: '1100.00', payable: '1015.00' });
Object.assign(unequal.fareBreakdown.passengers[1], { baseFare: '1100.00', gross: '1300.00', payable: '1215.00' });
assert.deepEqual(read(unequal), expected, 'Unequal passenger fares still sum to the source fare');

const alias = { currency: 'BDT', gross: '2400.00', payable: '2214.99', specialDiscount: '-15.01' };
assert.deepEqual(read(fixture(), {
  item1: { fareBreakdown: alias, flightInfo: { fareBreakdown: alias } },
}), expected);
assert.equal(read(fixture(), { item1: { fareBreakdown: { ...alias, payable: '2230.00' } } }), null);
assert.equal(read(fixture(), { item1: { flightInfo: { fareBreakdown: { specialDiscount: '0.00' } } } }), null);
assert.equal(read(fixture(), { item1: { fareBreakdown: 'unsupported' } }), null);

for (const value of [undefined, '0.00', null, 0, -15.01, '-0.00', '15.01', '+0.00',
  '-15.1', '-15.010', '-015.01', ' -15.01', '-1e2', '-90071992547409.92']) {
  const bad = fixture();
  bad.fareBreakdown.specialDiscount = value;
  assert.equal(read(bad), null, `No observation for invalid or absent adjustment ${String(value)}`);
}
for (const mutate of [
  booking => { booking.status = 'on-hold'; },
  booking => { booking.paymentState = 'unpaid'; },
  booking => { booking.reviewRequired = true; },
  booking => { booking.requiresReconciliation = true; },
  booking => { booking.fareBreakdown.currency = 'USD'; },
  booking => { booking.fareBreakdown.payable = '2214.98'; },
  booking => { booking.fareBreakdown.baseFare = '1999.99'; },
  booking => { booking.fareBreakdown.charge = '10.01'; },
  booking => { booking.fareBreakdown.passengers[0].specialDiscount = '-15.01'; },
  booking => { booking.fareBreakdown.passengers[0].payable = '1114.99'; },
  booking => { booking.fareBreakdown.passengers[0].passengerType = 'CHD'; },
  booking => { booking.fareBreakdown.passengers[0].passengerId = 'different'; },
  booking => { booking.fareBreakdown.passengers[0].passengerIndex = 1; },
  booking => { booking.fareBreakdown.passengers.pop(); },
  booking => { booking.fareBreakdown.payable = '0.00'; booking.fareBreakdown.specialDiscount = '-2230.00'; },
]) {
  const bad = fixture();
  mutate(bad);
  assert.equal(read(bad), null);
}
assert.equal(readShapontravelsSavedPayable(null, { item1: { fareBreakdown: alias } }), null);
console.log('Shapon saved payable: exact signed cents, complete passenger fare reconciliation, consistent aliases and confirmed paid evidence passed.');
