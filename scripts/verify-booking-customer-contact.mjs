import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const calls = [];
const source = fs.readFileSync('lib/triplover/book.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)((name) => {
  if (name === 'server-only') return {};
  if (name === '@/lib/flights/airline-pnr') return { airlinePnrs: () => [] };
  if (name === '@/lib/flights/booking') return {
    BOOKING_CONTACT_DEFAULTS: { email: 'agency@example.com', countryCode: 'BD', cityName: 'Kaligonj' },
  };
  if (name === '@/lib/triplover/client') return {
    TriploverError: Error,
    triploverCall: async (...args) => {
      calls.push(args);
      return { data: { pnr: 'TEST01', bookingCodeRef: 'test-booking' } };
    },
  };
  throw new Error(`Unexpected import: ${name}`);
}, module, module.exports);

const refs = { uniqueTransId: 'test', itemCodeRef: 'item', priceCodeRef: 'price' };
const travellers = [{ firstName: 'Test', lastName: 'One' }, { firstName: 'Test', lastName: 'Two' }];
for (const [contact, expectedPhone] of [
  [{ customerEmail: 'customer@example.com', phoneCountryCode: '+880', phone: '01712345678' }, '1712345678'],
  [{ customerEmail: 'another@example.com', phoneCountryCode: '+880', phone: '1812345678' }, '1812345678'],
  [{ customerEmail: 'international@example.com', phoneCountryCode: '+39', phone: '0612345678' }, '0612345678'],
]) {
  const result = await module.exports.bookFlight(refs, travellers, contact, 'triplover');
  const payload = calls.at(-1)[2];
  assert.equal(payload.passengerInfoes.length, 2);
  for (const passenger of payload.passengerInfoes) {
    assert.equal(passenger.contactInfo.email, contact.customerEmail);
    assert.equal(passenger.contactInfo.phone, expectedPhone);
    assert.equal(passenger.contactInfo.phoneCountryCode, contact.phoneCountryCode);
  }
  assert.deepEqual(result.submittedPassengers, payload.passengerInfoes);
  assert.ok(!JSON.stringify(payload).includes('agency@example.com'));
  assert.ok(!JSON.stringify(payload).includes('1795271171'));
}
const route = fs.readFileSync('app/api/flights/booking/route.ts', 'utf8');
assert.match(route, /bookFlight\([\s\S]*?parsed\.data\.travellers,\s*parsed\.data\.contact,\s*supplierAccount/);
console.log('Customer contact booking payload checks passed (mock supplier; no live bookings).');
