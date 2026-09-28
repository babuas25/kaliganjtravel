import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the actual pricing engine with in-memory fixtures only. No database,
// credentials, supplier calls, or generated files are needed.
const source = await readFile(new URL('../lib/markup.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
Function('require', 'module', 'exports', output)((id) => {
  if (id === '@/lib/agency') return { isAgencyCode: (value) => typeof value === 'string' && value.length > 0 };
  throw new Error(`Unexpected pricing dependency: ${id}`);
}, module, module.exports);
const { selectMarkupRules, priceOffer, NO_MARKUP_RULES } = module.exports;

const b2c = { kind: 'b2c' };
const agency = { kind: 'agency', agencyCode: 'AG-ONE' };
const now = '2026-09-28T00:00:00.000Z';
const route = (origin = 'JSR', destination = 'DAC') => ({ origin, destination, departureDate: '2026-10-01' });
const rule = (id, values = {}) => ({
  id, audience: 'b2c', agencyCode: null, airlineCode: null,
  origin: null, destination: null, bidirectional: false,
  markupType: 'fixed', value: 100, lccServiceMargin: false, active: true,
  createdAt: now, updatedAt: now, ...values,
});
const routeScope = { origin: 'JSR', destination: 'DAC' };
const agencyScope = { audience: 'agency', agencyCode: 'AG-ONE' };
const hierarchy = [
  rule('agency-airline-route', { ...agencyScope, ...routeScope, airlineCode: 'BS', value: 10 }),
  rule('agency-all-airlines-route', { ...agencyScope, ...routeScope, value: 20 }),
  rule('agency-airline-all-routes', { ...agencyScope, airlineCode: 'BS', value: 30 }),
  rule('agency-all-airlines-all-routes', { ...agencyScope, value: 40 }),
  rule('b2b-airline-route', { audience: 'b2b', ...routeScope, airlineCode: 'BS', value: 50 }),
  rule('b2b-all-airlines-route', { audience: 'b2b', ...routeScope, value: 60 }),
  rule('b2b-airline-all-routes', { audience: 'b2b', airlineCode: 'BS', value: 70 }),
  rule('b2b-all-airlines-all-routes', { audience: 'b2b', value: 80 }),
];

const fixture = (values = {}) => ({
  supplierTotalPrice: 10000, basePrice: 9000, taxes: 2800, ait: 200,
  passengerCount: 1, rulesAvailable: true,
  fares: [{ passengerType: 'ADT', count: 1, basePrice: 9000, taxes: 2800, ait: 200, serviceCharge: 0, supplierTotalPrice: 10000 }],
  ...values,
});
const minor = (amount) => Math.round(amount * 100);
let verifiedPrices = 0;

function assertPriceIntegrity(priced) {
  const snapshot = priced.snapshot;
  assert.equal(snapshot.sellingPrice, priced.totalPrice, 'snapshot and public payable agree');
  assert.equal(
    minor(priced.basePrice) + minor(priced.taxes) + minor(priced.ait) + minor(priced.serviceMargin),
    minor(priced.totalPrice), 'public total reconciles',
  );
  assert.equal(priced.fares.reduce((sum, fare) => sum + minor(fare.totalPrice), 0), minor(priced.totalPrice), 'fare rows reconcile');
  for (const fare of priced.fares) {
    assert.equal(minor(fare.basePrice) + minor(fare.taxes) + minor(fare.ait) + minor(fare.serviceMargin), minor(fare.totalPrice), 'each fare reconciles');
    assert.ok(fare.basePrice >= 0, 'discounts cannot remove payable taxes or AIT');
  }
  assert.ok(snapshot.components.length <= 1, 'at most one pricing rule can apply');
  if (snapshot.components.length === 1) {
    const [component] = snapshot.components;
    assert.equal(component.stage, 'rule');
    assert.equal(component.ruleId, snapshot.ruleId);
    assert.equal(component.markupType, snapshot.markupType);
    assert.equal(component.markupValue, snapshot.markupValue);
    assert.equal(component.requestedAmount, snapshot.requestedMarkupAmount);
    assert.equal(component.sellingAfter, priced.totalPrice);
    assert.equal(component.sellingBefore, snapshot.basis === 'lcc_service'
      ? Math.max(snapshot.grossPrice, snapshot.supplierTotalPrice)
      : snapshot.supplierTotalPrice);
  } else {
    assert.equal(snapshot.ruleId, null);
  }
  verifiedPrices += 1;
}

function price(rules, { audience = b2c, airlineCode = 'BS', routes = [route()], input = {} } = {}) {
  const selected = selectMarkupRules(rules, audience, airlineCode, routes);
  const priced = priceOffer({ ...fixture(input), audience, rules: selected });
  assertPriceIntegrity(priced);
  return { selected, priced };
}

// Every suffix has a different winning row, including agency-global taking
// precedence over even an airline-and-route-specific general B2B rule.
for (let index = 0; index < hierarchy.length; index += 1) {
  const candidates = hierarchy.slice(index).reverse();
  candidates.push(rule('unrelated-b2c', { ...routeScope, airlineCode: 'BS', value: 999 }));
  const { selected, priced } = price(candidates, { audience: agency });
  assert.equal(selected.rule.id, hierarchy[index].id, `priority row ${index + 1}`);
  assert.equal(priced.snapshot.markupAmount, hierarchy[index].value);
}
for (let index = 0; index < 4; index += 1) {
  const candidates = hierarchy.slice(index, 4).map((candidate) => ({ ...candidate, audience: 'b2c', agencyCode: null }));
  const { selected, priced } = price(candidates.reverse());
  assert.equal(selected.rule.id, hierarchy[index].id, `B2C specificity row ${index + 1}`);
  assert.equal(priced.snapshot.markupAmount, hierarchy[index].value);
}

const globalRule = rule('b2c-global');
const scopedRule = rule('b2c-route', { ...routeScope, bidirectional: true });
const b2bRule = rule('b2b-global', { audience: 'b2b', value: 200 });
const reported = price([globalRule, scopedRule, b2bRule]);
assert.equal(reported.selected.rule.id, 'b2c-route');
assert.equal(reported.priced.totalPrice, 10100, 'B2C 100 + route 100 applies only route 100');
assert.equal(reported.priced.snapshot.markupAmount, 100);
assert.equal(price([globalRule, scopedRule], { routes: [route('DAC', 'JSR')] }).selected.rule.id, 'b2c-route', 'bidirectional route matches reverse');
assert.equal(price([globalRule, scopedRule], { routes: [route('DAC', 'CXB')] }).selected.rule.id, 'b2c-global', 'unmatched route uses fallback');
assert.equal(price([globalRule, { ...scopedRule, bidirectional: false }], { routes: [route('DAC', 'JSR')] }).selected.rule.id, 'b2c-global', 'one-way route does not match reverse');
assert.equal(price([globalRule, { ...scopedRule, active: false }]).selected.rule.id, 'b2c-global', 'inactive rule cannot win');
assert.equal(price([globalRule, { ...scopedRule, airlineCode: 'BG' }]).selected.rule.id, 'b2c-global', 'different airline cannot win');
assert.equal(price([hierarchy[0], b2bRule], { audience: { kind: 'agency', agencyCode: 'AG-TWO' } }).selected.rule.id, 'b2b-global', 'another agency cannot inherit private rules');
assert.equal(price([b2bRule, hierarchy[0]]).selected.rule, null, 'B2C cannot inherit B2B rules');
assert.equal(price([globalRule], { audience: agency }).selected.rule, null, 'B2B cannot inherit B2C rules');

const secondLeg = rule('second-leg', { origin: 'DAC', destination: 'SIN', updatedAt: '2026-09-29T00:00:00.000Z' });
const multicity = price([secondLeg, scopedRule], { routes: [route(), route('DAC', 'SIN')] });
assert.equal(multicity.selected.rule.id, 'b2c-route', 'earlier requested leg wins equally specific routes');
assert.equal(multicity.priced.snapshot.markupAmount, 100, 'multicity matching rules are not stacked');
assert.equal(price([secondLeg, scopedRule], { routes: [route('DAC', 'SIN'), route()] }).selected.rule.id, 'second-leg');
assert.equal(price([{ ...secondLeg, airlineCode: 'BS' }, scopedRule], { routes: [route(), route('DAC', 'SIN')] }).selected.rule.id, 'second-leg', 'airline specificity takes precedence over leg ordering');
const newerRule = { ...scopedRule, id: 'newer-route', updatedAt: '2026-09-29T00:00:00.000Z' };
for (const candidates of [[scopedRule, newerRule], [newerRule, scopedRule]]) {
  assert.equal(price(candidates).selected.rule.id, 'newer-route', 'updatedAt breaks equal-scope ties');
}

const calculations = [
  { name: 'fixed', values: { value: 150 }, payable: 10150, requested: 150, basis: 0 },
  { name: 'supplier-percentage', values: { markupType: 'percentage', value: 2 }, payable: 10200, requested: 200, basis: 10000 },
  { name: 'percentage-discount', values: { markupType: 'percentage', value: -10 }, payable: 9000, requested: -1000, basis: 10000 },
  { name: 'margin-share', values: { markupType: 'margin_share', value: 25 }, payable: 10500, requested: 500, basis: 2000 },
  { name: 'zero-margin-share', values: { markupType: 'margin_share', value: 0 }, payable: 10000, requested: 0, basis: 2000 },
  { name: 'gross-cap', values: { value: 5000 }, payable: 12000, requested: 5000, basis: 0, cap: true },
  { name: 'tax-and-AIT-floor', values: { value: -20000 }, payable: 3000, requested: -20000, basis: 0, floor: true },
  { name: 'LCC-fixed', values: { value: 150, lccServiceMargin: true }, payable: 12150, requested: 150, basis: 0, lcc: true },
  { name: 'LCC-base-percentage', values: { markupType: 'percentage', value: 2, lccServiceMargin: true }, payable: 12180, requested: 180, basis: 9000, lcc: true },
];
for (const scenario of calculations) {
  const chosen = rule(scenario.name, { airlineCode: 'BS', ...scenario.values });
  const { priced } = price([globalRule, chosen]);
  assert.equal(priced.totalPrice, scenario.payable, scenario.name);
  assert.equal(priced.snapshot.requestedMarkupAmount, scenario.requested, `${scenario.name} request`);
  assert.equal(priced.snapshot.components[0].basisAmount, scenario.basis, `${scenario.name} basis`);
  assert.equal(priced.snapshot.grossCapApplied, scenario.cap ?? false);
  assert.equal(priced.snapshot.discountFloorApplied, scenario.floor ?? false);
  assert.equal(priced.snapshot.lccServiceMargin, scenario.lcc ?? false);
  assert.equal(priced.snapshot.markupAmount, scenario.lcc ? scenario.requested : scenario.payable - 10000);
  assert.equal(priced.serviceMargin, scenario.lcc ? scenario.requested : 0);
}

const groupedFares = [
  { passengerType: 'ADT', count: 2, basePrice: 5400, taxes: 1600, ait: 100, serviceCharge: 0, supplierTotalPrice: 6000 },
  { passengerType: 'CHD', count: 1, basePrice: 2800, taxes: 900, ait: 70, serviceCharge: 0, supplierTotalPrice: 3200 },
  { passengerType: 'INF', count: 1, basePrice: 800, taxes: 300, ait: 30, serviceCharge: 0, supplierTotalPrice: 800 },
];
for (const value of [100, -100]) {
  const { priced } = price([globalRule, { ...scopedRule, value }], { input: { passengerCount: 4, fares: groupedFares } });
  assert.equal(priced.snapshot.markupAmount, value * 4, 'fixed amount counts all passengers once');
}
const rounded = price([rule('rounded-percentage', { markupType: 'percentage', value: 7.25 })], {
  input: {
    supplierTotalPrice: 10000.17, passengerCount: 4,
    fares: groupedFares.map((fare, index) => ({ ...fare, supplierTotalPrice: fare.supplierTotalPrice + (index === 0 ? 0.17 : 0) })),
  },
}).priced;
assert.equal(rounded.snapshot.requestedMarkupAmount, 725.01, 'percentage rounds to integer minor units');
assert.equal(rounded.totalPrice, 10725.18, 'rounded aggregate remains exactly allocated');
price([rule('grouped-floor', { value: -20000 })], { input: { passengerCount: 4, fares: groupedFares } });

const noMargin = price([globalRule], { input: { supplierTotalPrice: 12500, fares: [{ ...fixture().fares[0], supplierTotalPrice: 12500 }] } }).priced;
assert.equal(noMargin.totalPrice, 12500, 'safe gross never drops below supplier payable');
assert.equal(noMargin.snapshot.markupAmount, 0);
assert.equal(noMargin.snapshot.grossCapApplied, true);
assert.deepEqual(NO_MARKUP_RULES, { rule: null });
for (const [audience, rulesAvailable, payable, basis] of [
  [b2c, true, 12000, 'gross'],
  [agency, true, 10000, 'supplier'],
  [b2c, false, 12000, 'gross'],
  [agency, false, 12000, 'gross'],
  [{ kind: 'superadmin' }, true, 10000, 'supplier'],
  [{ kind: 'superadmin' }, false, 10000, 'supplier'],
]) {
  const { priced } = price([], { audience, input: { rulesAvailable } });
  assert.equal(priced.totalPrice, payable, `${audience.kind} fallback`);
  assert.equal(priced.snapshot.basis, basis);
  assert.equal(priced.snapshot.components.length, 0);
}
for (const chosen of [globalRule, rule('forced-LCC', { airlineCode: 'BS', lccServiceMargin: true })]) {
  const priced = priceOffer({ ...fixture(), audience: { kind: 'superadmin' }, rules: { rule: chosen } });
  assertPriceIntegrity(priced);
  assert.equal(priced.totalPrice, 10000, 'superadmin ignores even directly supplied rules');
  assert.equal(priced.snapshot.components.length, 0);
}

console.log(`Markup priority: PASS (${verifiedPrices} priced fixtures; exclusive hierarchy, matching, arithmetic, snapshots and safeguards).`);
