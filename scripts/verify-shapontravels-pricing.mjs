import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

// Test the adapter and actual canonical engine without credentials, database,
// supplier requests or wallet actions.
function loadModule(path, dependencies) {
  const code = ts.transpileModule(fs.readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('require', 'module', 'exports', code)((id) => {
    if (Object.hasOwn(dependencies, id)) return dependencies[id];
    throw new Error(`Unexpected Shapontravels pricing dependency: ${id}`);
  }, module, module.exports);
  return module.exports;
}
const markup = loadModule('../lib/markup.ts', {
  '@/lib/agency': { isAgencyCode: (value) => typeof value === 'string' && value.length > 0 },
});
const { shapontravelsPricedOffer } = loadModule('../lib/shapontravels/pricing.ts', { '@/lib/markup': markup });
const b2c = { kind: 'b2c' };
const agency = { kind: 'agency', agencyCode: 'AG-ONE' };
const superadmin = { kind: 'superadmin' };
const now = '2026-10-04T00:00:00.000Z';
const routes = [{ origin: 'DAC', destination: 'CXB', departureDate: '2030-01-01' }];
const rule = (id, values = {}) => ({
  id, audience: 'b2c', agencyCode: null, airlineCode: null,
  origin: null, destination: null, bidirectional: false,
  markupType: 'fixed', value: 100, lccServiceMargin: false, active: true,
  createdAt: now, updatedAt: now, ...values,
});
const breakdown = {
  currency: 'BDT', gross: '5349.00', payable: '5084.36', taxes: '1021.00', ait: '15.00',
  passengers: { adt: { count: 1, payable: '5084.36', taxes: '1021.00', ait: '15.00' } },
};
const minor = (amount) => Math.round(amount * 100);
let verifiedPrices = 0;
function assertIntegrity(priced, input) {
  assert.ok(priced, 'valid supplier breakdown is priced');
  const snapshot = priced.snapshot;
  assert.equal(snapshot.supplierTotalPrice, Number(input.payable), 'supplier payable stays separate from sale');
  assert.equal(snapshot.grossPrice, Number(input.gross), 'supplier gross stays the cap');
  assert.equal(snapshot.sellingPrice, priced.totalPrice, 'public and stored selling prices agree');
  assert.equal(minor(priced.basePrice) + minor(priced.taxes) + minor(priced.ait) + minor(priced.serviceMargin), minor(priced.totalPrice));
  for (const field of ['totalPrice', 'taxes', 'ait', 'serviceMargin']) {
    assert.equal(priced.fares.reduce((sum, fare) => sum + minor(fare[field]), 0), minor(priced[field]), `aggregate fare ${field} reconciles`);
  }
  for (const fare of priced.fares) {
    assert.equal(minor(fare.basePrice) + minor(fare.taxes) + minor(fare.ait) + minor(fare.serviceMargin), minor(fare.totalPrice), 'each passenger type reconciles');
    assert.ok(fare.basePrice >= 0, 'taxes and AIT survive discounts');
  }
  assert.ok(snapshot.components.length <= 1, 'only one selected markup rule applies');
  if (snapshot.components.length > 0) {
    const component = snapshot.components[0];
    assert.equal(component.stage, 'rule');
    assert.equal(component.ruleId, snapshot.ruleId);
    assert.equal(component.requestedAmount, snapshot.requestedMarkupAmount);
    assert.equal(component.sellingAfter, priced.totalPrice);
    assert.equal(component.sellingBefore, snapshot.basis === 'lcc_service'
      ? Math.max(Number(input.gross), Number(input.payable)) : Number(input.payable));
  } else assert.equal(snapshot.ruleId, null);
  verifiedPrices += 1;
}
function price(rules = [], { audience = b2c, input = breakdown, rulesAvailable = true, searchRoutes = routes } = {}) {
  const selected = markup.selectMarkupRules(rules, audience, 'BG', searchRoutes);
  const priced = shapontravelsPricedOffer(input, audience, { rulesAvailable, rules: selected });
  assertIntegrity(priced, input);
  return priced;
}

const routeScope = { origin: 'DAC', destination: 'CXB' };
const hierarchy = [
  rule('b2c-global'),
  rule('b2c-airline', { airlineCode: 'BG', value: 110 }),
  rule('b2c-route', { ...routeScope, value: 120 }),
  rule('b2c-airline-route', { ...routeScope, airlineCode: 'BG', value: 130 }),
  rule('b2b-global', { audience: 'b2b', value: 140 }),
  rule('b2b-route', { audience: 'b2b', ...routeScope, airlineCode: 'BG', value: 150 }),
  rule('agency-global', { audience: 'agency', agencyCode: 'AG-ONE', value: 160 }),
  rule('agency-route', { audience: 'agency', agencyCode: 'AG-ONE', ...routeScope, airlineCode: 'BG', value: 170 }),
];
assert.equal(price(hierarchy).snapshot.ruleId, 'b2c-airline-route');
assert.equal(price(hierarchy).totalPrice, 5214.36, 'broader rules do not stack');
assert.equal(price(hierarchy.filter((row) => row.id !== 'b2c-airline-route')).snapshot.ruleId, 'b2c-route', 'route beats airline-wide');
assert.equal(price(hierarchy, { audience: agency }).snapshot.ruleId, 'agency-route');
assert.equal(price(hierarchy.filter((row) => row.id !== 'agency-route'), { audience: agency }).snapshot.ruleId, 'agency-global', 'agency-global beats specific all-B2B route');
assert.equal(price(hierarchy, { audience: { kind: 'agency', agencyCode: 'AG-TWO' } }).snapshot.ruleId, 'b2b-route', 'other agencies use the B2B fallback');
assert.equal(price(hierarchy, { searchRoutes: [{ ...routes[0], destination: 'JSR' }] }).snapshot.ruleId, 'b2c-airline');
assert.equal(price([rule('inactive', { active: false }), rule('wrong-airline', { airlineCode: 'BS' }), rule('fallback')]).snapshot.ruleId, 'fallback');

const calculations = [
  { name: 'fixed', values: { value: 100 }, payable: 5184.36, requested: 100, basis: 0 },
  { name: 'supplier-percentage', values: { markupType: 'percentage', value: 2 }, payable: 5186.05, requested: 101.69, basis: 5084.36 },
  { name: 'margin-share', values: { markupType: 'margin_share', value: 50 }, payable: 5216.68, requested: 132.32, basis: 264.64 },
  { name: 'gross-cap', values: { value: 500 }, payable: 5349, requested: 500, basis: 0, cap: true },
  { name: 'fixed-discount', values: { value: -100 }, payable: 4984.36, requested: -100, basis: 0 },
  { name: 'percentage-discount', values: { markupType: 'percentage', value: -2 }, payable: 4982.67, requested: -101.69, basis: 5084.36 },
  { name: 'tax-and-AIT-floor', values: { value: -10000 }, payable: 1036, requested: -10000, basis: 0, floor: true },
  { name: 'LCC-fixed', values: { value: 100, lccServiceMargin: true }, payable: 5449, requested: 100, basis: 0, lcc: true },
  { name: 'LCC-base-percentage', values: { markupType: 'percentage', value: 2, lccServiceMargin: true }, payable: 5435.26, requested: 86.26, basis: 4313, lcc: true },
];
for (const scenario of calculations) {
  const priced = price([rule(scenario.name, { airlineCode: 'BG', ...scenario.values })]);
  assert.equal(priced.totalPrice, scenario.payable, scenario.name);
  assert.equal(priced.snapshot.requestedMarkupAmount, scenario.requested, `${scenario.name}: request`);
  assert.equal(priced.snapshot.components[0].basisAmount, scenario.basis, `${scenario.name}: basis`);
  assert.equal(priced.snapshot.grossCapApplied, scenario.cap ?? false);
  assert.equal(priced.snapshot.discountFloorApplied, scenario.floor ?? false);
  assert.equal(priced.snapshot.lccServiceMargin, scenario.lcc ?? false);
  assert.equal(priced.snapshot.markupAmount, scenario.lcc ? scenario.requested : (minor(scenario.payable) - minor(5084.36)) / 100);
  assert.equal(priced.serviceMargin, scenario.lcc ? scenario.requested : 0);
}

// Shapon passenger rows are totals for that type. Only fixed markup multiplies
// by head count; payable and tax totals must never be multiplied again.
const party = {
  currency: 'BDT', gross: '12000.00', payable: '10000.00', taxes: '2000.00', ait: '20.00',
  passengers: {
    adt: { count: 2, payable: '8000.00', taxes: '1600.00', ait: '16.00' },
    chd: { count: 1, payable: '2000.00', taxes: '400.00', ait: '4.00' },
    inf: { count: 0 },
  },
};
const partyFixed = price([rule('party-fixed')], { input: party });
assert.equal(partyFixed.totalPrice, 10300, 'fixed markup counts all three passengers once');
assert.equal(partyFixed.snapshot.requestedMarkupAmount, 300);
assert.equal(partyFixed.fares.find((fare) => fare.passengerType === 'ADT').count, 2);
assert.equal(partyFixed.fares.length, 2, 'zero-count rows add no markup');
assert.equal(price([rule('party-percent', { markupType: 'percentage', value: 1 })], { input: party }).totalPrice, 10100);
assert.equal(price([rule('party-discount', { value: -100 })], { input: party }).totalPrice, 9700);
assert.equal(price([rule('party-floor', { value: -10000 })], { input: party }).totalPrice, 2020);
const partyLcc = price([rule('party-LCC', { airlineCode: 'BG', lccServiceMargin: true })], { input: party });
assert.equal(partyLcc.totalPrice, 12300);
assert.equal(partyLcc.fares.find((fare) => fare.passengerType === 'ADT').serviceMargin, 200);
assert.equal(partyLcc.fares.find((fare) => fare.passengerType === 'CHD').serviceMargin, 100);
assert.equal(price([rule('party-LCC-percent', { airlineCode: 'BG', lccServiceMargin: true, markupType: 'percentage', value: 1 })], { input: party }).totalPrice, 12099.8);

const withServiceCharge = {
  ...party, baseFare: '9780.00', serviceCharge: '200.00',
  passengers: {
    adt: { ...party.passengers.adt, gross: '9600.00', baseFare: '7824.00', serviceCharge: '160.00' },
    chd: { ...party.passengers.chd, gross: '2400.00', baseFare: '1956.00', serviceCharge: '40.00' },
  },
};
assert.equal(price([rule('service-fixed')], { input: withServiceCharge }).totalPrice, 10300);
const serviceLcc = price([rule('service-LCC-percent', { airlineCode: 'BG', lccServiceMargin: true, markupType: 'percentage', value: 1 })], { input: withServiceCharge });
assert.equal(serviceLcc.totalPrice, 12097.8, 'LCC percentage excludes supplier service charges');
assert.equal(serviceLcc.snapshot.components[0].basisAmount, 9780);

for (const [audience, rulesAvailable, payable, basis] of [
  [b2c, true, 5349, 'gross'], [agency, true, 5084.36, 'supplier'],
  [b2c, false, 5349, 'gross'], [agency, false, 5349, 'gross'],
  [superadmin, true, 5084.36, 'supplier'], [superadmin, false, 5084.36, 'supplier'],
]) {
  const priced = price([], { audience, rulesAvailable });
  assert.equal(priced.totalPrice, payable, `${audience.kind}: fallback`);
  assert.equal(priced.snapshot.basis, basis);
  assert.equal(priced.snapshot.components.length, 0);
}
for (const selected of [rule('forced-markup'), rule('forced-LCC', { airlineCode: 'BG', lccServiceMargin: true })]) {
  const priced = shapontravelsPricedOffer(breakdown, superadmin, { rulesAvailable: true, rules: { rule: selected } });
  assertIntegrity(priced, breakdown);
  assert.equal(priced.totalPrice, 5084.36, 'Super Admin bypasses even directly supplied rules');
  assert.equal(priced.serviceMargin, 0);
  assert.equal(priced.snapshot.components.length, 0);
}
const lowerGross = price([rule('no-margin')], { input: { ...breakdown, gross: '5000.00' } });
assert.equal(lowerGross.totalPrice, 5084.36, 'safe gross never falls below supplier payable');
assert.equal(lowerGross.snapshot.availableMargin, 0);
assert.equal(lowerGross.snapshot.grossCapApplied, true);

const invalid = [
  undefined, { ...breakdown, currency: 'USD' },
  ...['5084.37', 'unknown', '5084.360', 5084.36, '0.00', '90071992547410.00'].map((payable) => ({ ...breakdown, payable })),
  ...['unknown', '1000.00'].map((gross) => ({ ...breakdown, gross })),
  { ...breakdown, taxes: '5080.00' }, { ...breakdown, ait: '-1.00' },
  { ...breakdown, passengers: undefined }, { ...breakdown, passengers: {} },
  ...[1.5, -1, '1'].map((count) => ({ ...breakdown, passengers: { adt: { ...breakdown.passengers.adt, count } } })),
  { ...breakdown, passengers: { other: breakdown.passengers.adt } },
  ...[{ payable: '5084.35' }, { taxes: '1020.99' }, { ait: '14.99' }, { taxes: '5080.00' }]
    .map((values) => ({ ...breakdown, passengers: { adt: { ...breakdown.passengers.adt, ...values } } })),
  { ...withServiceCharge, serviceCharge: '201.00' },
  { ...withServiceCharge, serviceCharge: 'unknown' },
  { ...withServiceCharge, passengers: { ...withServiceCharge.passengers, adt: { ...withServiceCharge.passengers.adt, gross: '9600.01' } } },
  { ...withServiceCharge, passengers: { ...withServiceCharge.passengers, adt: { ...withServiceCharge.passengers.adt, serviceCharge: '159.99' } } },
];
for (const [index, input] of invalid.entries()) {
  assert.equal(shapontravelsPricedOffer(input, b2c, { rulesAvailable: true, rules: markup.NO_MARKUP_RULES }), null, `invalid breakdown ${index + 1} is rejected`);
}
console.log(`Shapontravels pricing: PASS (${verifiedPrices} priced fixtures; canonical markup, passenger aggregates, supplier/sale separation and ${invalid.length} invalid breakdowns).`);
