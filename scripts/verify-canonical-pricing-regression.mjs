import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import ts from 'typescript';

const projectRoot = new URL('../', import.meta.url);
const currentSource = await readFile(new URL('lib/markup.ts', projectRoot), 'utf8');
const baselineSource = execFileSync('git', ['show', 'HEAD:lib/markup.ts'], {
  cwd: projectRoot,
  encoding: 'utf8',
});

// Supplier Import must remain a consumer of this module, never an editor of it.
assert.equal(
  currentSource,
  baselineSource,
  'Canonical markup implementation changed while adding Supplier API Import',
);

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

const baseline = loadMarkup(baselineSource);
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
  { name: 'b2c-airline', audience: { kind: 'b2c' } },
  { name: 'b2b-fallback-route', audience: { kind: 'agency', agencyCode: 'AG-TWO' } },
  { name: 'agency-specific-route', audience: { kind: 'agency', agencyCode: 'AG-ONE' } },
  { name: 'superadmin-supplier', audience: { kind: 'superadmin' } },
];

const results = scenarios.map(({ name, audience }) => {
  const beforeSelection = baseline.selectMarkupRules(rules, audience, 'BS', routes);
  const afterSelection = current.selectMarkupRules(rules, audience, 'BS', routes);
  assert.deepEqual(afterSelection, beforeSelection, `${name}: markup selection changed`);
  const beforePrice = baseline.priceOffer({
    ...fareInput, audience, rules: beforeSelection,
  });
  const afterPrice = current.priceOffer({
    ...fareInput, audience, rules: afterSelection,
  });
  assert.deepEqual(afterPrice, beforePrice, `${name}: fare/User Payable changed`);
  return {
    name,
    selectedRuleIds: [afterSelection.base?.id, afterSelection.adjustment?.id].filter(Boolean),
    payable: afterPrice.totalPrice,
    fares: afterPrice.fares,
    snapshot: afterPrice.snapshot,
  };
});

const [searchSource, repriceSource, prepareSource] = await Promise.all([
  readFile(new URL('lib/triplover/search.ts', projectRoot), 'utf8'),
  readFile(new URL('lib/triplover/reprice.ts', projectRoot), 'utf8'),
  readFile(new URL('app/api/flights/booking/prepare/route.ts', projectRoot), 'utf8'),
]);
for (const [name, source] of [['Search', searchSource], ['RePrice', repriceSource]]) {
  assert.match(source, /activeMarkupRulesFor\(/, `${name} no longer loads canonical rules`);
  assert.match(source, /selectMarkupRules\(/, `${name} no longer selects canonical rules`);
  assert.match(source, /priceOffer\(\{/, `${name} no longer uses canonical fare pricing`);
}
assert.match(prepareSource, /resolveBookingActorContext\(/);
assert.match(prepareSource, /readRepricedSelection\([\s\S]*?principal/);

console.log(JSON.stringify({
  checks: 'passed',
  canonicalSourceIdenticalToGitBaseline: true,
  searchRepriceCanonicalCallsIntact: true,
  bookPricingPrincipalGuardIntact: true,
  representativeBeforeAfterExactMatch: true,
  results,
}, null, 2));
