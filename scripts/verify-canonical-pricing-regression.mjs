import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import ts from 'typescript';

const projectRoot = new URL('../', import.meta.url);
const currentSource = await readFile(new URL('lib/markup.ts', projectRoot), 'utf8');

function loadMarkup(source) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const requireStub = (id) => {
    if (id === '@/lib/agency') {
      return { isAgencyCode: (value) => typeof value === 'string' && value.length > 0 };
    }
    throw new Error(`Unexpected runtime import in canonical pricing fixture: ${id}`);
  };
  Function('require', 'module', 'exports', output)(requireStub, module, module.exports);
  return module.exports;
}

const current = loadMarkup(currentSource);
const now = '2026-08-25T00:00:00.000Z';
const rule = (values) => ({
  id: values.id,
  audience: values.audience,
  agencyCode: values.agencyCode ?? null,
  airlineCode: values.airlineCode ?? null,
  origin: values.origin ?? null,
  destination: values.destination ?? null,
  bidirectional: values.bidirectional ?? false,
  markupType: values.markupType,
  value: values.value,
  lccServiceMargin: false,
  active: true,
  createdAt: now,
  updatedAt: values.updatedAt ?? now,
});

const rules = [
  rule({ id: 'b2c-base', audience: 'b2c', markupType: 'fixed', value: 100 }),
  rule({ id: 'b2c-bs', audience: 'b2c', airlineCode: 'BS', markupType: 'percentage', value: 2 }),
  rule({ id: 'b2b-base', audience: 'b2b', markupType: 'percentage', value: 5 }),
  rule({ id: 'b2b-route', audience: 'b2b', airlineCode: 'BS', origin: 'DAC', destination: 'SIN', markupType: 'fixed', value: 75 }),
  rule({ id: 'agency-base', audience: 'agency', agencyCode: 'AG-ONE', markupType: 'fixed', value: 50 }),
  rule({ id: 'agency-route', audience: 'agency', agencyCode: 'AG-ONE', airlineCode: 'BS', origin: 'DAC', destination: 'SIN', markupType: 'percentage', value: 1.5 }),
];
const routes = [{ origin: 'DAC', destination: 'SIN', departureDate: '2026-10-01' }];
const fareInput = {
  supplierTotalPrice: 36767.22,
  basePrice: 30329,
  taxes: 10290,
  ait: 0,
  fares: [{
    passengerType: 'ADT', count: 1, basePrice: 30329, taxes: 10290,
    ait: 0, serviceCharge: 0, supplierTotalPrice: 36767.22,
  }],
  passengerCount: 1,
  rulesAvailable: true,
};
const scenarios = [
  { name: 'b2c-airline', audience: { kind: 'b2c' }, selectedRuleId: 'b2c-bs', payable: 37502.56, markup: 735.34 },
  { name: 'b2b-fallback-route', audience: { kind: 'agency', agencyCode: 'AG-TWO' }, selectedRuleId: 'b2b-route', payable: 36842.22, markup: 75 },
  { name: 'agency-specific-route', audience: { kind: 'agency', agencyCode: 'AG-ONE' }, selectedRuleId: 'agency-route', payable: 37318.73, markup: 551.51 },
  { name: 'agency-global-over-b2b-route', audience: { kind: 'agency', agencyCode: 'AG-ONE' }, omittedRuleId: 'agency-route', selectedRuleId: 'agency-base', payable: 36817.22, markup: 50 },
  { name: 'superadmin-supplier', audience: { kind: 'superadmin' }, selectedRuleId: null, payable: 36767.22, markup: 0 },
];

// Numeric expectations are independent of HEAD, so this remains useful after
// commit and explicitly rejects a return to base-plus-adjustment composition.
const results = scenarios.map(({ name, audience, omittedRuleId, selectedRuleId, payable, markup }) => {
  const selection = current.selectMarkupRules(rules.filter((candidate) => candidate.id !== omittedRuleId), audience, 'BS', routes);
  assert.equal(selection.rule?.id ?? null, selectedRuleId, `${name}: exclusive rule selection`);
  const priced = current.priceOffer({
    ...fareInput, audience, rules: selection,
  });
  assert.equal(priced.totalPrice, payable, `${name}: User Payable`);
  assert.equal(priced.snapshot.markupAmount, markup, `${name}: one rule's markup`);
  assert.equal(priced.snapshot.ruleId, selectedRuleId);
  assert.equal(priced.snapshot.sellingPrice, payable);
  assert.equal(priced.snapshot.components.length, selectedRuleId === null ? 0 : 1);
  if (selectedRuleId !== null) {
    assert.equal(priced.snapshot.components[0].stage, 'rule');
    assert.equal(priced.snapshot.components[0].ruleId, selectedRuleId);
  }
  return {
    name,
    selectedRuleId,
    payable: priced.totalPrice,
    markup: priced.snapshot.markupAmount,
  };
});

const [searchSource, repriceSource, importSource, prepareSource] = await Promise.all([
  readFile(new URL('lib/triplover/search.ts', projectRoot), 'utf8'),
  readFile(new URL('lib/triplover/reprice.ts', projectRoot), 'utf8'),
  readFile(new URL('lib/supplier-reference-import/pricing.server.ts', projectRoot), 'utf8'),
  readFile(new URL('app/api/flights/booking/prepare/route.ts', projectRoot), 'utf8'),
]);
for (const [name, source] of [['Search', searchSource], ['RePrice', repriceSource], ['Supplier Import', importSource]]) {
  assert.match(source, /activeMarkupRulesFor\(/, `${name} no longer loads canonical rules`);
  assert.match(source, /selectMarkupRules\(/, `${name} no longer selects canonical rules`);
  assert.match(source, /priceOffer\(\{/, `${name} no longer uses canonical fare pricing`);
}
assert.match(prepareSource, /resolveBookingActorContext\(/);
assert.match(prepareSource, /readRepricedSelection\([\s\S]*?principal/);
assert.match(importSource, /pricingAudienceForPrincipal\(actorContext\.principal\)/);
assert.match(importSource, /pricingSnapshot: priced\.snapshot/);

console.log(JSON.stringify({
  checks: 'passed',
  exclusivePriorityAndNumericExpectations: true,
  searchRepriceImportCanonicalCallsIntact: true,
  bookPricingPrincipalGuardIntact: true,
  results,
}, null, 2));
