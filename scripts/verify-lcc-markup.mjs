import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { lccModule } from './helpers/lcc.mjs';

// Real classification, rule selection, calculation, presentation and import
// pricing; only database and identity I/O are replaced with local fixtures.
const require = createRequire(import.meta.url);
function load(path, imports = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  Function('require', 'module', 'exports', compiled)((id) => {
    if (id === 'server-only') return {};
    if (Object.hasOwn(imports, id)) return imports[id];
    throw new Error(`Unexpected isolated LCC verification dependency: ${id}`);
  }, module, module.exports);
  return module.exports;
}
const markup = load('lib/markup.ts', {
  '@/lib/agency': load('lib/agency.ts'),
  '@/lib/airlines/lcc': lccModule,
});
const { selectMarkupRules, priceOffer, ruleUsesLccServiceMargin, NO_MARKUP_RULES } = markup;
const { LCC_AIRLINES, isLccAirline } = lccModule;
const { shapontravelsPricedOffer } = load('lib/shapontravels/pricing.ts', { '@/lib/markup': markup });
const { resultDisplayPrice } = load('lib/flights/display-pricing.ts');
const principalModule = load('lib/flights/pricing-principal.ts', { '@/lib/markup': markup });
const b2c = { kind: 'b2c' };
const agency = { kind: 'agency', agencyCode: 'ST-B2B999999' };
const superadmin = { kind: 'superadmin' };
const route = { origin: 'DAC', destination: 'CCU', departureDate: '2026-10-21' };
const now = '2026-10-11T00:00:00.000Z';
const rule = (id, values = {}) => ({
  id, audience: 'b2c', agencyCode: null, airlineCode: null,
  origin: null, destination: null, bidirectional: false,
  markupType: 'fixed', value: 1000, lccServiceMargin: false, active: true,
  createdAt: now, updatedAt: now, ...values,
});
const b2cRoute = rule('b2c-DAC-CCU', { origin: 'DAC', destination: 'CCU' });
const b2bRoute = rule('b2b-DAC-CCU', { audience: 'b2b', origin: 'DAC', destination: 'CCU', value: 200 });
const fixture = (values = {}) => ({
  rulesAvailable: true, supplierTotalPrice: 12856.85,
  basePrice: 10000, taxes: 2800, ait: 56.85, passengerCount: 1,
  fares: [{ passengerType: 'ADT', count: 1, basePrice: 10000, taxes: 2800, ait: 56.85, serviceCharge: 0, supplierTotalPrice: 12856.85 }],
  ...values,
});
const minor = (amount) => Math.round(amount * 100);
let checkedPrices = 0;
function reconcile(priced) {
  const snapshot = priced.snapshot;
  assert.equal(snapshot.sellingPrice, priced.totalPrice, 'snapshot equals public payable');
  assert.equal(snapshot.serviceMarginAmount, priced.serviceMargin, 'snapshot service margin equals public margin');
  assert.equal(minor(priced.basePrice) + minor(priced.taxes) + minor(priced.ait) + minor(priced.serviceMargin), minor(priced.totalPrice), 'public components reconcile');
  for (const field of ['totalPrice', 'taxes', 'ait', 'serviceMargin']) {
    assert.equal(priced.fares.reduce((sum, fare) => sum + minor(fare[field]), 0), minor(priced[field]), `passenger ${field} reconciles`);
  }
  for (const fare of priced.fares) {
    assert.equal(minor(fare.basePrice) + minor(fare.taxes) + minor(fare.ait) + minor(fare.serviceMargin), minor(fare.totalPrice), 'each fare reconciles');
    assert.ok(fare.basePrice >= 0, 'taxes and AIT remain payable');
  }
  assert.ok(snapshot.components.length <= 1, 'exactly one winning rule at most');
  if (snapshot.components.length === 1) {
    const [component] = snapshot.components;
    assert.equal(component.ruleId, snapshot.ruleId);
    assert.equal(component.markupType, snapshot.markupType);
    assert.equal(component.markupValue, snapshot.markupValue);
    assert.equal(component.requestedAmount, snapshot.requestedMarkupAmount);
    assert.equal(component.sellingAfter, priced.totalPrice);
    assert.equal(component.sellingBefore, snapshot.basis === 'lcc_service'
      ? Math.max(snapshot.grossPrice, snapshot.supplierTotalPrice)
      : snapshot.supplierTotalPrice);
  } else assert.equal(snapshot.ruleId, null);
  checkedPrices += 1;
  return priced;
}
function price(rules, { audience = b2c, airlineCode = '6E', routes = [route], input = {} } = {}) {
  const selection = selectMarkupRules(rules, audience, airlineCode, routes);
  return { selection, priced: reconcile(priceOffer({ ...fixture(input), audience, rules: selection })) };
}

// Every production-classified carrier receives the same applicable global
// fixed rule. Classification must be deterministic and normalize user input.
assert.ok(LCC_AIRLINES.length > 0);
assert.equal(new Set(LCC_AIRLINES.map(({ code }) => code)).size, LCC_AIRLINES.length, 'carrier codes are unique');
for (const { code, name } of LCC_AIRLINES) {
  assert.match(code, /^[A-Z0-9]{2}$/);
  assert.ok(typeof name === 'string' && name.trim().length > 0);
  assert.equal(isLccAirline(code), true);
  assert.equal(isLccAirline(` ${code.toLowerCase()} `), true, 'classification normalizes case and spaces');
  for (const [audience, selectedRule, expected] of [[b2c, b2cRoute, 13856.85], [agency, b2bRoute, 13056.85]]) {
    const { selection, priced } = price([selectedRule], { audience, airlineCode: code });
    assert.strictEqual(selection.rule, selectedRule, 'selection preserves the persisted rule object');
    assert.equal(selectedRule.lccServiceMargin, false, 'automatic mode never mutates the saved flag');
    assert.equal(selection.lccServiceMargin, true);
    assert.equal(priced.totalPrice, expected, `${name} ${audience.kind} payable`);
    assert.equal(priced.snapshot.basis, 'lcc_service');
    assert.equal(priced.snapshot.lccServiceMargin, true);
    assert.equal(priced.snapshot.grossCapApplied, false);
    assert.equal(priced.serviceMargin, selectedRule.value);
  }
}
for (const code of ['BG', 'BS', 'TG', 'EK', 'QR', 'ZZ', '', null, undefined]) {
  assert.equal(isLccAirline(code), false, `${code} is not automatically classified as LCC`);
}

// DAC-CCU all-airline route rules outrank airline-wide rules, including an
// explicitly enabled broad rule, while automatic mode follows that winner.
for (const [audience, routeRule] of [[b2c, b2cRoute], [agency, b2bRoute]]) {
  const carrierRule = rule(`6E-${audience.kind}-global`, {
    audience: audience.kind === 'agency' ? 'b2b' : 'b2c',
    airlineCode: '6E', value: 9999, lccServiceMargin: true,
  });
  const { selection, priced } = price([carrierRule, routeRule], { audience });
  assert.strictEqual(selection.rule, routeRule);
  assert.equal(priced.snapshot.ruleId, routeRule.id);
  assert.equal(priced.snapshot.markupValue, routeRule.value);
  assert.equal(priced.totalPrice, 12856.85 + routeRule.value);
}
const privateRule = rule('agency-override', { audience: 'agency', agencyCode: agency.agencyCode, value: 350 });
const scopedB2b = rule('b2b-6E-route', { audience: 'b2b', airlineCode: '6E', origin: 'DAC', destination: 'CCU', value: 500 });
const privatePrice = price([scopedB2b, b2bRoute, privateRule], { audience: agency });
assert.strictEqual(privatePrice.selection.rule, privateRule, 'agency-wide override retains precedence');
assert.equal(privatePrice.priced.totalPrice, 13206.85);
assert.equal(price([scopedB2b, privateRule], { audience: { kind: 'agency', agencyCode: 'ST-B2B888888' } }).priced.totalPrice, 13356.85, 'other agency uses B2B fallback');
const bidirectional = { ...b2cRoute, bidirectional: true };
assert.strictEqual(price([bidirectional], { routes: [{ ...route, origin: 'CCU', destination: 'DAC' }] }).selection.rule, bidirectional);
assert.equal(price([{ ...b2cRoute, active: false }]).selection.rule, null, 'inactive LCC rule cannot apply');

// Base percentages, fixed per-passenger amounts and minor-unit allocation
// retain their existing LCC semantics without stacking any fallback rule.
const percentageRule = rule('6E-percent', { markupType: 'percentage', value: 2.5 });
const percentage = price([percentageRule]).priced;
assert.equal(percentage.totalPrice, 13106.85);
assert.equal(percentage.snapshot.components[0].basisAmount, 10000, 'LCC percentage uses supplier base fare');
assert.equal(percentage.serviceMargin, 250);
const ordinaryPercentage = price([percentageRule], { airlineCode: 'BG', input: { basePrice: 12000,
  fares: [{ ...fixture().fares[0], basePrice: 12000 }] } }).priced;
assert.equal(ordinaryPercentage.totalPrice, 13178.27);
assert.equal(ordinaryPercentage.snapshot.components[0].basisAmount, 12856.85, 'full-service percentage retains supplier-payable basis');
assert.equal(ordinaryPercentage.serviceMargin, 0);
const safeGross = price([b2bRoute], { audience: agency, input: { supplierTotalPrice: 13000,
  fares: [{ ...fixture().fares[0], supplierTotalPrice: 13000 }] } }).priced;
assert.equal(safeGross.totalPrice, 13200, 'LCC baseline never falls below actual supplier payable');
assert.equal(safeGross.snapshot.grossPrice, 12856.85);
const serviceCharge = price([percentageRule], { input: { supplierTotalPrice: 12956.85,
  fares: [{ ...fixture().fares[0], serviceCharge: 100, supplierTotalPrice: 12956.85 }] } }).priced;
assert.equal(serviceCharge.totalPrice, 13206.85);
assert.equal(serviceCharge.serviceMargin, 250, 'LCC percentage excludes supplier service charges');
const groupedFares = [
  { passengerType: 'ADT', count: 2, basePrice: 10000, taxes: 3600, ait: 100, serviceCharge: 0, supplierTotalPrice: 13700 },
  { passengerType: 'CHD', count: 1, basePrice: 5000, taxes: 2000, ait: 50, serviceCharge: 0, supplierTotalPrice: 7050 },
  { passengerType: 'INF', count: 1, basePrice: 1000, taxes: 400, ait: 10, serviceCharge: 0, supplierTotalPrice: 1410 },
];
const groupedInput = { supplierTotalPrice: 22160, basePrice: 16000, taxes: 6000, ait: 160, passengerCount: 4, fares: groupedFares };
const party = price([b2bRoute], { audience: agency, input: groupedInput }).priced;
assert.equal(party.totalPrice, 22960);
assert.equal(party.serviceMargin, 800, 'fixed margin counts adults, children and infants once');
assert.deepEqual(party.fares.map(({ serviceMargin }) => serviceMargin), [400, 200, 200]);
const rounded = price([rule('fractional-percent', { markupType: 'percentage', value: 7.25 })], {
  input: { ...groupedInput, basePrice: 16000.17, supplierTotalPrice: 22160.17,
    fares: groupedFares.map((fare, index) => ({ ...fare, basePrice: fare.basePrice + (index === 0 ? 0.17 : 0), supplierTotalPrice: fare.supplierTotalPrice + (index === 0 ? 0.17 : 0) })) },
}).priced;
assert.equal(rounded.serviceMargin, 1160.01, 'base percentage rounds once to integer minor units');
assert.equal(rounded.totalPrice, 23320.18);

// Automatic mode does not repurpose discounts or margin-share rules.
for (const values of [
  { value: -200 },
  { markupType: 'percentage', value: -5 },
  { markupType: 'margin_share', value: 25 },
  { markupType: 'margin_share', value: 0 },
]) {
  const selectedRule = rule('LCC-non-service', values);
  const { selection, priced } = price([selectedRule]);
  assert.equal(selection.lccServiceMargin, undefined);
  assert.equal(priced.serviceMargin, 0);
  assert.equal(priced.snapshot.lccServiceMargin, false);
  assert.equal(priced.snapshot.basis, 'supplier');
  assert.equal(ruleUsesLccServiceMargin(selectedRule, '6E'), false);
}
assert.equal(price([rule('discount-floor', { value: -20000 })]).priced.totalPrice, 2856.85, 'tax/AIT floor survives LCC classification');
const marginShare = price([rule('share', { markupType: 'margin_share', value: 25 })], { input: { basePrice: 10143.15, fares: [{ ...fixture().fares[0], basePrice: 10143.15 }] } }).priced;
assert.equal(marginShare.totalPrice, 12892.64, 'margin share remains a share of available supplier margin');
for (const selectedRule of [rule('forced-negative', { value: -200, lccServiceMargin: true }), rule('forced-share', { markupType: 'margin_share', value: 25, lccServiceMargin: true })]) {
  const priced = reconcile(priceOffer({ ...fixture(), audience: b2c, rules: { rule: selectedRule, lccServiceMargin: true } }));
  assert.equal(priced.serviceMargin, 0, 'even a forged effective selection cannot enable an ineligible rule');
}

// Full-service and unknown carriers remain gross-capped. Explicit per-airline
// service margins are still readable for carriers outside the current catalog.
for (const airlineCode of ['BG', 'BS', 'TG', 'EK', 'QR', 'ZZ']) {
  const { selection, priced } = price([b2cRoute], { airlineCode });
  assert.strictEqual(selection.rule, b2cRoute);
  assert.equal(selection.lccServiceMargin, undefined);
  assert.equal(priced.totalPrice, 12856.85);
  assert.equal(priced.serviceMargin, 0);
  assert.equal(priced.snapshot.grossCapApplied, true);
}
const explicitUnknown = price([rule('explicit-unknown', { airlineCode: 'ZZ', value: 200, lccServiceMargin: true })], { airlineCode: 'ZZ' }).priced;
assert.equal(explicitUnknown.totalPrice, 13056.85);
assert.equal(explicitUnknown.snapshot.lccServiceMargin, true);
const directCarrierRule = rule('direct-6E', { airlineCode: '6E', value: 200 });
assert.equal(reconcile(priceOffer({ ...fixture(), audience: b2c, rules: { rule: directCarrierRule } })).totalPrice, 13056.85, 'direct canonical call recognizes named LCC rule');

// A carrier classification alone creates no new markup amount. No rule and
// unavailable storage keep established audience fallback prices.
const separatedGross = { basePrice: 10143.15, fares: [{ ...fixture().fares[0], basePrice: 10143.15 }] };
assert.equal(price([], { input: separatedGross }).priced.totalPrice, 13000, 'B2C with no rule remains gross');
assert.equal(price([], { audience: agency, input: separatedGross }).priced.totalPrice, 12856.85, 'B2B with no rule remains supplier payable');
for (const audience of [b2c, agency]) {
  assert.equal(price([], { audience, input: { ...separatedGross, rulesAvailable: false } }).priced.totalPrice, 13000, 'unavailable rules use safe gross');
}
assert.deepEqual(selectMarkupRules([b2cRoute, b2bRoute], superadmin, '6E', [route]), NO_MARKUP_RULES);
for (const selectedRule of [b2cRoute, directCarrierRule, { ...directCarrierRule, lccServiceMargin: true }]) {
  const priced = reconcile(priceOffer({ ...fixture(separatedGross), audience: superadmin, rules: { rule: selectedRule, lccServiceMargin: true } }));
  assert.equal(priced.totalPrice, 12856.85);
  assert.equal(priced.serviceMargin, 0);
  assert.equal(priced.snapshot.ruleId, null);
}

// Existing card/tab helpers show the payable above gross to B2B partners.
const agencyOffer = party;
const publicOption = { totalPrice: agencyOffer.totalPrice, serviceMargin: agencyOffer.serviceMargin,
  agencyPricing: { agentFare: agencyOffer.totalPrice, grossPrice: agencyOffer.snapshot.grossPrice },
  auditPricing: { grossPrice: agencyOffer.snapshot.grossPrice } };
assert.equal(resultDisplayPrice(publicOption, false, true), 22960);
assert.equal(resultDisplayPrice(publicOption, false, false), 22960);
assert.equal(resultDisplayPrice(publicOption, true, false), 22160, 'Super Admin retains gross audit display');

// Supplier adapters and imports reuse the same effective selection without
// setting the database flag or exposing a second commercial pricing path.
const shaponBreakdown = { currency: 'BDT', gross: '12856.85', payable: '12856.85', taxes: '2800.00', ait: '56.85', serviceCharge: '0.00',
  passengers: { adt: { count: 1, gross: '12856.85', payable: '12856.85', taxes: '2800.00', ait: '56.85', serviceCharge: '0.00' } } };
for (const [audience, selectedRule, expected] of [[b2c, b2cRoute, 13856.85], [agency, b2bRoute, 13056.85]]) {
  const selection = selectMarkupRules([selectedRule], audience, '6E', [route]);
  const priced = shapontravelsPricedOffer(shaponBreakdown, audience, { rulesAvailable: true, rules: selection });
  assert.ok(priced);
  reconcile(priced);
  assert.equal(priced.totalPrice, expected, 'Shapontravels canonical LCC payable');
  assert.equal(priced.snapshot.ruleId, selectedRule.id);
}
let importAudience = b2c;
let importRulesAvailable = true;
const importPricing = load('lib/supplier-reference-import/pricing.server.ts', {
  'node:crypto': require('node:crypto'),
  '@/lib/markup': markup,
  '@/lib/flights/pricing-principal': principalModule,
  '@/lib/db/markup-rules': { async activeMarkupRulesFor() { return { ok: importRulesAvailable, rules: importRulesAvailable ? [b2cRoute, b2bRoute] : [] }; } },
  '@/lib/flights/staff-booking.server': { async resolveBookingActorContext(_session, assignedUserId) {
    return { ownerUserId: assignedUserId, principal: { userId: assignedUserId, audience: importAudience.kind,
      agencyCode: importAudience.kind === 'agency' ? importAudience.agencyCode : null } };
  } },
});
const importEvidence = { supplierAccount: 'triplover', supplierReference: 'FIXTURE-LCC', currency: 'BDT', supplierPayable: 12856.85,
  supplierGross: 12856.85, supplierDiscount: 0, retrievedAt: now, supplierFares: fixture().fares,
  itinerary: { carrierCode: '6E', legs: [{ from: 'DAC', to: 'CCU', departure: '2026-10-21T17:35:00+06:00' }] } };
for (const [audience, expected, selectedRule] of [[b2c, 13856.85, b2cRoute], [agency, 13056.85, b2bRoute]]) {
  importAudience = audience;
  const { booking, fingerprint } = await importPricing.priceSupplierReferenceBooking({ session: {}, assignedUserId: 'fixture-user', evidence: importEvidence });
  assert.equal(booking.pricingSnapshot.sellingPrice, expected, 'reference import uses canonical LCC price');
  assert.equal(booking.pricingSnapshot.serviceMarginAmount, selectedRule.value);
  assert.equal(booking.pricingSnapshot.ruleId, selectedRule.id);
  assert.equal(booking.pricingSnapshot.lccServiceMargin, true);
  assert.equal(booking.fares.reduce((sum, fare) => sum + minor(fare.totalPrice), 0), minor(expected));
  assert.equal(booking.pricingMode, 'import_time_current_markup');
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
}
importRulesAvailable = false;
await assert.rejects(importPricing.priceSupplierReferenceBooking({ session: {}, assignedUserId: 'fixture-user', evidence: importEvidence }),
  (error) => error.code === 'PRICING_RULES_UNAVAILABLE', 'import refuses to estimate if rules cannot be read');

console.log(`LCC markup verified: ${LCC_AIRLINES.length} carrier classifications, ${checkedPrices} reconciled prices, B2C/B2B priority, discounts, audit, display, supplier adapter and import compatibility.`);
