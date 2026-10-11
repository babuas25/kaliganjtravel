import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { currencyModule } from './helpers/currency.mjs';
import { lccModule } from './helpers/lcc.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const paths = {
  agency: 'lib/agency.ts',
  markup: 'lib/markup.ts',
  principal: 'lib/flights/pricing-principal.ts',
  types: 'lib/flights/types.ts',
  cache: 'lib/flights/search-cache.ts',
  upsells: 'lib/flights/upsells.ts',
  pricing: 'lib/shapontravels/pricing.ts',
  search: 'lib/triplover/search.ts',
  reprice: 'lib/triplover/reprice.ts',
};
const compiled = Object.fromEntries(Object.entries(paths).map(([name, path]) => [
  name,
  ts.transpileModule(readFileSync(path, 'utf8'), {
    fileName: path,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText,
]));

function load(name, imports = {}) {
  const module = { exports: {} };
  vm.runInNewContext(compiled[name], {
    module,
    exports: module.exports,
    require(id) {
      if (id === 'server-only') return {};
      if (id === '@/lib/currency') return currencyModule;
      if (Object.hasOwn(imports, id)) return imports[id];
      throw new Error(`Unexpected ${paths[name]} import: ${id}`);
    },
    Buffer,
    console,
    performance,
    setTimeout,
    clearTimeout,
    process: { env: {} },
  }, { filename: paths[name] });
  return module.exports;
}

// Execute production validation, selection, pricing, grouping and snapshot
// canonicalization. Only their database, supplier transport and cache I/O
// boundaries are replaced; no live supplier, database or Redis is contacted.
const markup = load('markup', {
  '@/lib/agency': load('agency'),
  '@/lib/airlines/lcc': lccModule,
});
const principalModule = load('principal', { '@/lib/markup': markup });
const types = load('types');
const upsells = load('upsells');
const quote = load('cache', {
  crypto: require('node:crypto'),
  zlib: require('node:zlib'),
  redis: { createClient() { throw new Error('Live Redis is forbidden in this verifier.'); } },
  '@/lib/flights/pricing-principal': principalModule,
  '@/lib/flights/supplier': {
    isFlightReadSupplier: (value) => ['takeoff', 'firsttrip', 'triplover', 'shapontravels'].includes(value),
  },
});

const plain = (value) => JSON.parse(JSON.stringify(value));
const sum = (fares, key) => Math.round(fares.reduce((total, fare) => total + fare[key], 0) * 100) / 100;
const input = {
  tripType: 'oneway',
  routes: [{ origin: 'DAC', destination: 'CXB', departureDate: '2026-11-10' }],
  adults: 1,
  children: 0,
  infants: 0,
  childrenAges: [],
  cabinClass: 1,
  preferredCarriers: [],
};
const initialBreakdown = {
  currency: 'BDT',
  payable: '5084.36',
  gross: '5349.00',
  taxes: '1021.00',
  ait: '15.00',
  passengers: { adt: { count: 1, payable: '5084.36', taxes: '1021.00', ait: '15.00' } },
};
const directions = [[{
  from: 'DAC',
  to: 'CXB',
  stops: 0,
  segments: [{
    from: 'DAC',
    to: 'CXB',
    departure: '2026-11-10 10:00:00',
    arrival: '2026-11-10 11:00:00',
    airlineCode: 'BG',
    airline: 'Biman Bangladesh Airlines',
    flightNumber: 'BG-433',
    segmentCodeRef: 'segment-ref',
    cabinClass: 'Economy',
    bookingClass: 'Y',
    bookingCount: '9',
  }],
}]];

function rule(id, overrides = {}) {
  return {
    id,
    audience: 'b2c',
    agencyCode: null,
    airlineCode: 'BG',
    origin: 'DAC',
    destination: 'CXB',
    bidirectional: false,
    markupType: 'fixed',
    value: 100,
    lccServiceMargin: false,
    active: true,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...overrides,
  };
}

const rules = [
  rule('wrong-airline', { airlineCode: 'US', value: 200 }),
  rule('wrong-route', { destination: 'JSR', value: 200 }),
  rule('inactive', { active: false, value: 200 }),
  rule('b2c-broad', { airlineCode: null, origin: null, destination: null, value: 150 }),
  rule('b2c-route'),
  rule('b2b-fallback', { audience: 'b2b', value: 75 }),
  rule('agency-override', {
    audience: 'agency',
    agencyCode: 'ST-B2B222222',
    airlineCode: null,
    origin: null,
    destination: null,
    value: 40,
  }),
];

function supplierOffer(breakdown = initialBreakdown, carrierCode = 'BG', searchInput = input) {
  const carrierName = carrierCode === 'BG' ? 'Biman Bangladesh Airlines' : carrierCode === '6E' ? 'IndiGo' : `Airline ${carrierCode}`;
  const offerDirections = plain(directions);
  const route = searchInput.routes[0];
  const leg = offerDirections[0][0];
  leg.from = route.origin;
  leg.to = route.destination;
  Object.assign(leg.segments[0], {
    from: route.origin,
    to: route.destination,
    departure: `${route.departureDate} 10:00:00`,
    arrival: `${route.departureDate} 11:00:00`,
    airlineCode: carrierCode,
    airline: carrierName,
    flightNumber: `${carrierCode}-433`,
  });
  return {
    uniqueTransID: 'supplier-trans',
    itemCodeRef: 'item-ref',
    currency: 'BDT',
    totalPrice: Number(breakdown.payable),
    basePrice: Number(breakdown.payable) - Number(breakdown.taxes) - Number(breakdown.ait),
    taxes: Number(breakdown.taxes),
    platingCarrier: carrierCode,
    platingCarrierName: carrierName,
    bookable: true,
    refundable: true,
    fareBreakdown: plain(breakdown),
    directions: offerDirections,
    passengerCounts: { adt: 1 },
    passengerFares: {
      adt: {
        basePrice: Number(breakdown.payable) - Number(breakdown.taxes) - Number(breakdown.ait),
        taxes: Number(breakdown.taxes),
        ait: Number(breakdown.ait),
        totalPrice: Number(breakdown.payable),
      },
    },
  };
}

function harness({ principal, initialRules = rules, rulesAvailable = true, breakdown = initialBreakdown, carrierCode = 'BG', searchInput = input }) {
  const state = {
    search: null,
    searchResponse: { item1: { currency: 'BDT', airSearchResponses: [supplierOffer(breakdown, carrierCode, searchInput)] }, item2: { isSuccess: true } },
    repriceResponse: { item1: { ...supplierOffer(breakdown, carrierCode, searchInput), priceCodeRef: 'price-ref', isPriceChanged: false }, item2: { isSuccess: true } },
    rulesResult: { ok: rulesAvailable, rules: initialRules },
    selections: new Map(),
    calls: { rules: [], supplier: [], searchWrites: [], selectionReads: [], selectionWrites: [], pricing: [] },
  };
  const trackedMarkup = {
    ...markup,
    priceOffer(value) {
      state.calls.pricing.push(value);
      return markup.priceOffer(value);
    },
  };
  const pricing = load('pricing', { '@/lib/markup': trackedMarkup });
  class ShapontravelsReadError extends Error {
    constructor(code) { super(code); this.code = code; }
  }
  const imports = {
    '@/lib/db/markup-rules': {
      activeMarkupRulesFor: async (audience) => {
        state.calls.rules.push(plain(audience));
        return state.rulesResult;
      },
    },
    '@/lib/flights/search-cache': {
      ...quote,
      storeSearch: async (transaction, refsByItineraryId, supplier) => {
        state.calls.searchWrites.push({ transaction, refsByItineraryId, supplier });
        state.search = { uniqueTransId: transaction, refsByItineraryId, supplierAccount: supplier };
        return { searchId: 'search-ref', timing: { redisPersistenceMs: 0, redisPersistenceOutcome: 'success' } };
      },
      readSearch: async (searchId, options) => {
        assert.equal(searchId, 'search-ref');
        assert.equal(options.consistency, 'durable');
        return state.search;
      },
      readRepricedSelection: async (searchId, itineraryId, identity) => {
        assert.equal(searchId, 'search-ref');
        state.calls.selectionReads.push({ itineraryId, principal: identity });
        return state.selections.get(JSON.stringify([itineraryId, identity])) ?? null;
      },
      storeRepricedSelection: async (searchId, itineraryId, selection, identity, expectedVersion) => {
        assert.equal(searchId, 'search-ref');
        assert.deepEqual(plain(identity), plain(principal), 'RePrice must persist for the verified caller');
        const key = JSON.stringify([itineraryId, identity]);
        const previous = state.selections.get(key);
        assert.equal(expectedVersion, previous?.quoteStoreVersion ?? 0, 'principal-bound CAS revision must be preserved');
        state.calls.selectionWrites.push({ itineraryId, selection, principal: identity, expectedVersion });
        state.selections.set(key, { ...selection, quoteStoreVersion: expectedVersion + 1 });
        return true;
      },
    },
    '@/lib/flights/pricing-principal': principalModule,
    '@/lib/flights/types': types,
    '@/lib/flights/upsells': upsells,
    '@/lib/markup': trackedMarkup,
    '@/lib/shapontravels/pricing': pricing,
    '@/lib/shapontravels/client': {
      ShapontravelsReadError,
      shapontravelsRead: async (operation, payload) => {
        state.calls.supplier.push({ operation, payload });
        assert.ok(operation === 'Search' || operation === 'Reprice');
        return operation === 'Search' ? state.searchResponse : state.repriceResponse;
      },
    },
    '@/lib/triplover/client': {
      TriploverError: class extends Error {},
      triploverCall: async () => { throw new Error('A Shapontravels flow must never call another supplier.'); },
    },
  };
  return { state, input: searchInput, ...load('search', imports), ...load('reprice', imports) };
}

function expectedPrice(breakdown, audience, availableRules, rulesAvailable = true, carrierCode = 'BG', searchInput = input) {
  const payable = Number(breakdown.payable);
  const grossBase = Number(breakdown.gross) - Number(breakdown.taxes) - Number(breakdown.ait);
  return markup.priceOffer({
    audience,
    rulesAvailable,
    rules: markup.selectMarkupRules(availableRules, audience, carrierCode, searchInput.routes),
    supplierTotalPrice: payable,
    basePrice: grossBase,
    taxes: Number(breakdown.taxes),
    ait: Number(breakdown.ait),
    fares: [{ passengerType: 'ADT', count: 1, basePrice: grossBase, taxes: Number(breakdown.taxes), ait: Number(breakdown.ait), serviceCharge: 0, supplierTotalPrice: payable }],
    passengerCount: 1,
  });
}

function assertPublicPrice(actual, expected) {
  for (const field of ['totalPrice', 'basePrice', 'taxes', 'ait', 'serviceMargin']) {
    assert.equal(actual[field], expected[field], `public ${field} must use the canonical markup calculation`);
  }
  assert.deepEqual(plain(actual.fares), plain(expected.fares));
  assert.equal(sum(actual.fares, 'totalPrice'), actual.totalPrice);
  assert.equal(Math.round((actual.basePrice + actual.taxes + actual.ait + actual.serviceMargin) * 100) / 100, actual.totalPrice);
}

async function searchWith(h, principal, expected) {
  const audience = principalModule.pricingAudienceForPrincipal(principal);
  const { result } = await h.searchFlights(h.input, 'shapontravels', audience);
  assert.equal(result.itineraries.length, 1);
  const card = result.itineraries[0];
  assertPublicPrice(card, expected);
  const refs = h.state.search.refsByItineraryId.get(card.id);
  assert.deepEqual(plain(refs.pricing), plain(expected.snapshot), 'Search must store marked pricing privately');
  assert.deepEqual(h.state.calls.rules, [plain(audience)], 'Search must load current rules for Shapontravels');
  assert.deepEqual(h.state.calls.supplier.map((call) => call.operation), ['Search']);
  assert.equal(h.state.calls.searchWrites.length, 1);
  assert.equal(h.state.calls.pricing.length, 1, 'Search must pass through canonical priceOffer once');
  assert.equal(result.minPrice, expected.totalPrice);
  assert.equal(result.maxPrice, expected.totalPrice);
  assert.equal(result.airlines[0].minPrice, expected.totalPrice);
  assert.equal(result.holdOnly, true);
  return card;
}

async function repriceWith(h, principal, card, expected) {
  const result = await h.repriceFlight({ searchId: 'search-ref', itineraryId: card.id, principal });
  assertPublicPrice(result, expected);
  const persisted = h.state.calls.selectionWrites.at(-1);
  assert.deepEqual(plain(persisted.selection.pricing), plain(expected.snapshot), 'RePrice must persist the current marked snapshot');
  assert.deepEqual(plain(persisted.selection.fares), plain(expected.fares));
  assert.deepEqual(plain(persisted.principal), plain(principal));
  assert.deepEqual(plain(h.state.calls.selectionReads.at(-1).principal), plain(principal));
  assert.equal(h.state.calls.supplier.at(-1).operation, 'Reprice');
  assert.equal(h.state.calls.supplier.filter((call) => call.operation === 'Reprice').length, h.state.calls.selectionWrites.length);
  assert.equal(h.state.calls.rules.length, h.state.calls.supplier.length, 'every Search/RePrice must read rules once');
  assert.equal(h.state.calls.pricing.length, h.state.calls.supplier.length);
  return result;
}

const audienceCases = [
  { role: 'user', agencyCode: null, total: 5184.36, ruleId: 'b2c-route' },
  { role: 'b2b', agencyCode: 'ST-B2B333333', total: 5159.36, ruleId: 'b2b-fallback' },
  { role: 'b2b', agencyCode: 'ST-B2B222222', total: 5124.36, ruleId: 'agency-override' },
  { role: 'superadmin', agencyCode: null, total: 5084.36, ruleId: null },
];
for (const scenario of audienceCases) {
  const principal = principalModule.pricingPrincipalForSession({ clerkId: `caller-${scenario.role}-${scenario.agencyCode}`, role: scenario.role, agencyCode: scenario.agencyCode });
  const audience = principalModule.pricingAudienceForPrincipal(principal);
  const expected = expectedPrice(initialBreakdown, audience, rules);
  assert.equal(expected.totalPrice, scenario.total);
  assert.equal(expected.snapshot.ruleId, scenario.ruleId);
  const h = harness({ principal });
  const card = await searchWith(h, principal, expected);
  if (audience.kind === 'agency') assert.equal(card.agencyPricing.agentFare, expected.totalPrice);
  if (audience.kind === 'superadmin') assert.equal(card.auditPricing.netFare, expected.totalPrice);
  const repriced = await repriceWith(h, principal, card, expected);
  assert.equal(repriced.supplierPriceChanged, false);
  assert.equal(repriced.sellingPriceChanged, false);
  assert.equal(repriced.requiresConfirmation, false);
}

const customer = { userId: 'customer', audience: 'b2c', agencyCode: null };
const customerAudience = { kind: 'b2c' };

// RePrice loads newly changed local rules; unchanged supplier payable cannot
// be mislabeled as a supplier price change merely because selling moved.
{
  const h = harness({ principal: customer });
  const card = await searchWith(h, customer, expectedPrice(initialBreakdown, customerAudience, rules));
  const changedRules = [rule('updated-rule', { value: 150 })];
  h.state.rulesResult = { ok: true, rules: changedRules };
  const repriced = await repriceWith(h, customer, card, expectedPrice(initialBreakdown, customerAudience, changedRules));
  assert.equal(repriced.totalPrice, 5234.36);
  assert.equal(repriced.priceDifference, 50);
  assert.equal(repriced.supplierPriceChanged, false, 'a changed local rule is not a supplier price change');
  assert.equal(repriced.sellingPriceChanged, true);
  assert.equal(repriced.requiresConfirmation, true);
  assert.equal(h.state.calls.selectionWrites[0].selection.requiresConfirmation, true);

  // The same verified identity must read and persist its own mutable revision.
  await repriceWith(h, customer, card, expectedPrice(initialBreakdown, customerAudience, changedRules));
  assert.equal(h.state.calls.selectionWrites[1].expectedVersion, 1);
}

// A supplier payable movement still requires confirmation when the local
// markup cap keeps the customer selling price at the same gross amount.
{
  const cappedRules = [rule('capped', { value: 1000 })];
  const h = harness({ principal: customer, initialRules: cappedRules });
  const card = await searchWith(h, customer, expectedPrice(initialBreakdown, customerAudience, cappedRules));
  const moved = { ...plain(initialBreakdown), payable: '5100.00' };
  moved.passengers.adt.payable = moved.payable;
  h.state.repriceResponse.item1 = { ...supplierOffer(moved), priceCodeRef: 'new-price-ref', isPriceChanged: false };
  const repriced = await repriceWith(h, customer, card, expectedPrice(moved, customerAudience, cappedRules));
  assert.equal(repriced.totalPrice, 5349);
  assert.equal(repriced.priceDifference, 0);
  assert.equal(repriced.supplierPriceChanged, true, 'supplier payable must be compared separately from selling');
  assert.equal(repriced.sellingPriceChanged, false);
  assert.equal(repriced.requiresConfirmation, true);
}

// A supplier's explicit change flag is respected even if every amount matches.
{
  const h = harness({ principal: customer });
  const expected = expectedPrice(initialBreakdown, customerAudience, rules);
  const card = await searchWith(h, customer, expected);
  h.state.repriceResponse.item1.isPriceChanged = true;
  const repriced = await repriceWith(h, customer, card, expected);
  assert.equal(repriced.supplierPriceChanged, true);
  assert.equal(repriced.sellingPriceChanged, false);
  assert.equal(repriced.requiresConfirmation, true);
}

// LCC service margin appears both publicly and in the private snapshot.
{
  const lccRules = [rule('lcc-service', { value: 200, lccServiceMargin: true })];
  const h = harness({ principal: customer, initialRules: lccRules });
  const expected = expectedPrice(initialBreakdown, customerAudience, lccRules);
  const card = await searchWith(h, customer, expected);
  const repriced = await repriceWith(h, customer, card, expected);
  assert.equal(repriced.totalPrice, 5549);
  assert.equal(repriced.serviceMargin, 200);
  assert.equal(repriced.fares[0].serviceMargin, 200);
  assert.equal(expected.snapshot.serviceMarginAmount, 200);
}

// IndiGo's actual carrier classification enables LCC mode after the normal
// rule priority, including route rules that target every airline. Search and
// RePrice each read rules and invoke canonical pricing once; no saved flag is
// needed and no broad airline rule can add a second markup layer.
{
  const lccInput = {
    ...plain(input),
    routes: [{ origin: 'DAC', destination: 'CCU', departureDate: '2026-10-21' }],
  };
  const lccBreakdown = {
    currency: 'BDT', payable: '12856.85', gross: '12856.85', taxes: '2800.00', ait: '56.85',
    passengers: { adt: { count: 1, payable: '12856.85', gross: '12856.85', taxes: '2800.00', ait: '56.85' } },
  };
  const automaticRules = [
    rule('b2c-6E-global', { airlineCode: '6E', origin: null, destination: null, value: 9999 }),
    rule('b2b-6E-global', { audience: 'b2b', airlineCode: '6E', origin: null, destination: null, value: 9999 }),
    rule('b2c-all-DAC-CCU', { airlineCode: null, destination: 'CCU', value: 1000 }),
    rule('b2b-all-DAC-CCU', { audience: 'b2b', airlineCode: null, destination: 'CCU', value: 200 }),
  ];
  for (const scenario of [
    { role: 'user', agencyCode: null, value: 1000, total: 13856.85, ruleId: 'b2c-all-DAC-CCU' },
    { role: 'b2b', agencyCode: 'ST-B2B333333', value: 200, total: 13056.85, ruleId: 'b2b-all-DAC-CCU' },
  ]) {
    const principal = principalModule.pricingPrincipalForSession({ clerkId: `automatic-lcc-${scenario.role}`, role: scenario.role, agencyCode: scenario.agencyCode });
    const audience = principalModule.pricingAudienceForPrincipal(principal);
    const expected = expectedPrice(lccBreakdown, audience, automaticRules, true, '6E', lccInput);
    assert.equal(expected.totalPrice, scenario.total);
    assert.equal(expected.serviceMargin, scenario.value);
    assert.equal(expected.snapshot.ruleId, scenario.ruleId);
    assert.equal(expected.snapshot.basis, 'lcc_service');
    assert.equal(expected.snapshot.lccServiceMargin, true);
    assert.equal(expected.snapshot.supplierTotalPrice, 12856.85);
    assert.equal(expected.snapshot.grossPrice, 12856.85);
    assert.equal(expected.snapshot.components.length, 1);
    const h = harness({ principal, initialRules: automaticRules, breakdown: lccBreakdown, carrierCode: '6E', searchInput: lccInput });
    const card = await searchWith(h, principal, expected);
    assert.equal(card.carrierCode, '6E');
    assert.equal(card.legs[0].to, 'CCU');
    assert.equal(card.legs[0].segments[0].airlineCode, '6E');
    assert.equal(card.totalPrice, scenario.total);
    assert.equal(card.serviceMargin, scenario.value);
    assert.equal(card.fares[0].serviceMargin, scenario.value);
    if (audience.kind === 'agency') {
      assert.equal(card.agencyPricing.agentFare, scenario.total);
      assert.equal(card.agencyPricing.grossPrice, 12856.85, 'supplier gross stays separate from marked payable');
    }
    const refs = h.state.search.refsByItineraryId.get(card.id);
    assert.equal(refs.context.carrierCode, '6E');
    assert.equal(refs.pricing.ruleId, scenario.ruleId);
    assert.equal(refs.pricing.supplierTotalPrice, 12856.85);
    assert.equal(refs.pricing.serviceMarginAmount, scenario.value);
    const repriced = await repriceWith(h, principal, card, expected);
    assert.equal(repriced.totalPrice, scenario.total);
    assert.equal(repriced.serviceMargin, scenario.value);
    assert.equal(repriced.fares[0].serviceMargin, scenario.value);
    assert.equal(repriced.supplierPriceChanged, false);
    assert.equal(repriced.sellingPriceChanged, false);
    assert.equal(repriced.requiresConfirmation, false);
    const persisted = h.state.calls.selectionWrites[0].selection.pricing;
    assert.equal(persisted.ruleId, scenario.ruleId);
    assert.equal(persisted.supplierTotalPrice, 12856.85);
    assert.equal(persisted.grossPrice, 12856.85);
    assert.equal(persisted.serviceMarginAmount, scenario.value);
    assert.equal(persisted.lccServiceMargin, true);
    assert.equal(persisted.components.length, 1);
    assert.deepEqual(h.state.calls.supplier.map(({ operation }) => operation), ['Search', 'Reprice']);
    assert.equal(h.state.calls.rules.length, 2);
    assert.equal(h.state.calls.pricing.length, 2);
    for (const invocation of h.state.calls.pricing) {
      assert.equal(invocation.supplierTotalPrice, 12856.85);
      assert.equal(invocation.rules.rule.id, scenario.ruleId);
      assert.equal(invocation.rules.rule.lccServiceMargin, false, 'saved rule flag remains unchanged');
      assert.equal(invocation.rules.lccServiceMargin, true, 'offer classification enables the effective mode');
    }
    assert.ok(automaticRules.every((selectedRule) => selectedRule.lccServiceMargin === false));
  }
}

// Missing/unavailable rules follow canonical customer fallback pricing.
for (const rulesAvailable of [true, false]) {
  const h = harness({ principal: customer, initialRules: [], rulesAvailable });
  const expected = expectedPrice(initialBreakdown, customerAudience, [], rulesAvailable);
  const card = await searchWith(h, customer, expected);
  await repriceWith(h, customer, card, expected);
  assert.equal(expected.totalPrice, 5349);
}

// Malformed money never produces a selectable Search reference or a saved
// RePrice selection. Validation does not trigger another transport request.
for (const invalid of [
  { ...plain(initialBreakdown), payable: '5084.37' },
  { ...plain(initialBreakdown), payable: 'unknown' },
  { ...plain(initialBreakdown), taxes: '5080.00' },
]) {
  const searchHarness = harness({ principal: customer, breakdown: invalid });
  const { result } = await searchHarness.searchFlights(input, 'shapontravels', customerAudience);
  assert.equal(result.itineraries.length, 0);
  assert.equal(result.droppedOfferCount, 1);
  assert.equal(searchHarness.state.search.refsByItineraryId.size, 0, 'an invalid Search fare must never be persisted');
  assert.equal(searchHarness.state.calls.supplier.length, 1);
  assert.equal(searchHarness.state.calls.pricing.length, 0);

  const h = harness({ principal: customer });
  const card = await searchWith(h, customer, expectedPrice(initialBreakdown, customerAudience, rules));
  h.state.repriceResponse.item1.fareBreakdown = invalid;
  await assert.rejects(
    () => h.repriceFlight({ searchId: 'search-ref', itineraryId: card.id, principal: customer }),
    (error) => error.code === 'INVALID_REPRICE_PRICE'
  );
  assert.equal(h.state.calls.selectionWrites.length, 0);
  assert.deepEqual(h.state.calls.supplier.map((call) => call.operation), ['Search', 'Reprice']);
  assert.equal(h.state.calls.pricing.length, 1);
}

console.log('Shapontravels Search/RePrice markup flow verification passed');
