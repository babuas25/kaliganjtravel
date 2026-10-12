import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import * as icons from 'lucide-react';
import * as dates from 'date-fns';

// Render the actual card and inspect the actual results tree. Network actions,
// authentication and unrelated child components stay inert in these fixtures.
function compile(file, imports = {}) {
  const module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  new vm.Script(output, { filename: file }).runInNewContext({
    module, exports: module.exports, console,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}`);
      return imports[name];
    },
  });
  return module.exports;
}

const types = compile('lib/flights/types.ts');
const display = compile('lib/flights/display-pricing.ts');
const upsells = compile('lib/flights/upsells.ts');
const emptyChild = () => null;
let state = [];
let stateIndex = 0;
let memoValues = [];
let memoIndex = 0;
function remembered(factory, dependencies) {
  const index = memoIndex++;
  const previous = memoValues[index];
  if (previous && dependencies && previous.dependencies &&
      dependencies.length === previous.dependencies.length &&
      dependencies.every((value, position) => Object.is(value, previous.dependencies[position]))) {
    return previous.value;
  }
  const value = factory();
  memoValues[index] = { dependencies, value };
  return value;
}
const hooks = {
  ...React,
  useState(initial) {
    const index = stateIndex++;
    if (!(index in state)) state[index] = initial;
    return [state[index], value => {
      state[index] = typeof value === 'function' ? value(state[index]) : value;
    }];
  },
  useRef: current => ({ current }),
  useEffect() {},
  useCallback: (callback, dependencies) => remembered(() => callback, dependencies),
  useMemo: remembered,
  useId: () => 'fixture-filters',
};
const sharedImports = {
  react: hooks,
  'react/jsx-runtime': jsxRuntime,
  'lucide-react': icons,
  'next/navigation': { useRouter: () => ({ push() {} }) },
  '@/lib/flights/types': types,
  '@/lib/flights/display-pricing': display,
};
const Card = compile('components/flights/ItineraryCard.tsx', {
  ...sharedImports,
  '@clerk/nextjs': { useAuth: () => ({ isLoaded: true, isSignedIn: true }) },
  '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
  '@/lib/flights/booking-snapshot.client': { saveBookingSnapshot: () => true },
  '@/components/flights/ItineraryCardDetails': Object.fromEntries(
    ['AirlinePolicyDetails', 'BaggageDetails', 'FareDetails', 'ItineraryDetails']
      .map(name => [name, emptyChild])
  ),
  '@/components/flights/AirlineLogo': { default: emptyChild },
  '@/components/flights/SendItineraryMenu': { default: emptyChild },
  '@/lib/flights/share-offer': { itineraryShareOffer: () => ({}) },
  '@/lib/flights/share-text': { itineraryShareText: () => '' },
}).default;

const gross = 12856.85;
function option(carrierCode = '6E', margin = 200, values = {}) {
  return {
    id: `fare-${carrierCode}-${margin}`,
    auditPricing: null,
    agencyPricing: { grossPrice: gross, agentFare: gross + margin },
    totalPrice: gross + margin,
    basePrice: 10000, taxes: 2800, ait: 56.85, serviceMargin: margin,
    carrierCode, carrierName: `Airline ${carrierCode}`,
    refundable: true, bookable: false, ambiguousSelection: false,
    legs: [{
      from: 'DAC', to: 'CCU', stops: 0, duration: '1h 5m',
      departure: '2026-10-21 17:35:00', arrival: '2026-10-21 18:10:00',
      segments: [{
        from: 'DAC', to: 'CCU', fromAirport: 'Dhaka', toAirport: 'Kolkata',
        departure: '2026-10-21 17:35:00', arrival: '2026-10-21 18:10:00',
        airline: `Airline ${carrierCode}`, airlineCode: carrierCode,
        flightNumber: '1106', cabinClass: 'Economy', bookingClass: 'X',
        duration: '1h 5m', aircraft: '320', baggage: '30 Kg', handBaggage: '7 Kg',
        seatsLeft: 67,
      }],
    }],
    fares: [], upsellOptions: [],
    ...values,
  };
}
function nodes(tree, found = []) {
  if (Array.isArray(tree)) tree.forEach(child => nodes(child, found));
  else if (tree && typeof tree === 'object') {
    found.push(tree);
    nodes(tree.props?.children, found);
  }
  return found;
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  return tree && typeof tree === 'object' ? text(tree.props?.children) : '';
}
function cardTree(itinerary, flags = {}) {
  stateIndex = 0;
  memoIndex = 0;
  return Card({
    itinerary, currency: 'BDT', searchId: 'fixture',
    bookingAvailable: true, holdOnly: false, showSendItinerary: false,
    airportCities: {}, showAuditFares: false, showAgencyFares: true,
    ...flags,
  });
}

// Presentation must follow service-margin pricing for every carrier, including
// an explicit override on an airline absent from the automatic LCC catalogue.
for (const carrier of ['6E', 'G9', 'FZ', 'AK', 'ZZ']) {
  const fare = option(carrier);
  assert.equal(display.resultDisplayPrice(fare, false, true), 13056.85);
  state = [];
  const tree = cardTree(fare);
  const html = renderToStaticMarkup(tree);
  assert.ok(html.includes('BDT 13,056.85'), `${carrier} shows gross plus margin`);
  assert.ok(!html.includes('BDT 12,856.85'), `${carrier} hides the old supplier gross`);
  assert.ok(!html.includes('BDT 200'), 'the margin alone is never the advertised fare');
  assert.ok(!nodes(tree).some(node => node.props?.['aria-label'] === 'Show additional fare'),
    'above-gross LCC pricing does not offer a misleading lower-gross toggle');
}

// The lowest option and expanded fare alternatives retain their own payable.
const grouped = upsells.groupUpsellOptions([option('6E', 400), option('6E', 200)]);
assert.equal(grouped.length, 1);
assert.equal(grouped[0].totalPrice, 13056.85);
state = [];
nodes(cardTree(grouped[0])).find(node => node.type === 'button' && text(node) === 'Select')
  .props.onClick();
const expandedHtml = renderToStaticMarkup(cardTree(grouped[0]));
assert.ok(expandedHtml.includes('BDT 13,056.85'));
assert.ok(expandedHtml.includes('BDT 13,256.85'));
assert.ok(!expandedHtml.includes('BDT 12,856.85'));

// Normal B2B gross/net toggling and the Super Admin audit remain available.
const normal = option('BG', 0, {
  serviceMargin: 0, totalPrice: 12350.36,
  agencyPricing: { grossPrice: 12799, agentFare: 12350.36 },
});
state = [];
let tree = cardTree(normal);
assert.ok(renderToStaticMarkup(tree).includes('BDT 12,799'));
nodes(tree).find(node => node.props?.['aria-label'] === 'Show additional fare').props.onClick();
assert.ok(renderToStaticMarkup(cardTree(normal)).includes('BDT 12,350.36'));
const audit = option('6E', 200, { auditPricing: { grossPrice: gross, netFare: 12000 } });
state = [];
tree = cardTree(audit, { showAuditFares: true });
assert.equal(display.resultDisplayPrice(audit, true, true), gross);
assert.ok(renderToStaticMarkup(tree).includes('BDT 12,856.85'));
assert.ok(!renderToStaticMarkup(tree).includes('BDT 13,056.85'));
nodes(tree).find(node => node.props?.['aria-label'] === 'Show additional fare').props.onClick();
assert.ok(renderToStaticMarkup(cardTree(audit, { showAuditFares: true })).includes('BDT 12,000'));
state = [];
assert.ok(renderToStaticMarkup(cardTree(option(), { showAgencyFares: false })).includes('BDT 13,056.85'),
  'B2C primary is the complete payable too');

const FilterBar = emptyChild;
const Filters = () => null;
const SortBar = () => null;
const ResultCard = () => null;
let fixtureRole = 'b2b';
const Results = compile('components/flights/FlightResults.tsx', {
  ...sharedImports,
  'date-fns': dates,
  '@clerk/nextjs': { useUser: () => ({
    isLoaded: true, isSignedIn: true, user: { publicMetadata: { role: fixtureRole } },
  }) },
  '@/lib/roles': { resolveRole: value => value },
  '@/lib/flights/search-params': { encodeSearchParams: () => '' },
  '@/lib/flights/cabin': { CABIN_CLASSES: [] },
  '@/components/flights/AirlineFilterBar': { default: FilterBar },
  '@/components/flights/FlightFilters': { default: Filters },
  '@/components/flights/ItineraryCard': { default: ResultCard },
  '@/components/flights/ResultsDateNavigator': { default: emptyChild },
  '@/components/flights/ResultsSortBar': { default: SortBar },
}).default;
const input = { tripType: 'oneway', routes: [{
  origin: 'DAC', destination: 'CCU', departureDate: '2026-10-21',
}], adults: 1, children: 0, infants: 0, childrenAges: [], cabinClass: 1, preferredCarriers: [] };
const results = { searchId: 'fixture', currency: 'BDT', bookingAvailable: true,
  itineraries: [option('6E', 400), option('G9', 200)] };
const airportCities = { DAC: 'Dhaka', CCU: 'Kolkata' };
function resultTree() {
  stateIndex = 0;
  memoIndex = 0;
  return Results({ input, airportCities });
}
function resultCards(tree) {
  return nodes(tree).filter(node => node.type === ResultCard || node.type?.type === ResultCard);
}
state = [results, null, false];
memoValues = [];
tree = resultTree();
const resultNodes = nodes(tree);
const airlineTabs = resultNodes.find(node => node.type === FilterBar).props.airlines;
assert.equal(airlineTabs.find(airline => airline.airlineCode === '6E').minPrice, 13256.85);
assert.equal(airlineTabs.find(airline => airline.airlineCode === 'G9').minPrice, 13056.85);
assert.ok(text(tree).includes('from BDT 13,056.85'), 'results minimum includes the margin');
const filterNode = resultNodes.find(node => node.type === Filters);
assert.equal(filterNode.props.options.priceBounds.min, 13056);
assert.equal(filterNode.props.options.priceBounds.max, 13257);
// Opening filters must reuse derived data and the unchanged props of every
// memoized card. Booking and role changes must still propagate below.
const originalCards = resultCards(tree);
assert.equal(resultNodes.find(node => node.type === SortBar).props.value, 'none', 'KTT starts in supplier order');
assert.deepEqual(originalCards.map(node => node.props.itinerary.id), results.itineraries.map(itinerary => itinerary.id));
assert.ok(originalCards.every(node => node.type.type === ResultCard), 'cards use React memo');
filterNode.props.onMobileOpenChange(true);
let updatedTree = resultTree();
let updatedFilters = nodes(updatedTree).find(node => node.type === Filters);
assert.equal(updatedFilters.props.options, filterNode.props.options);
assert.equal(updatedFilters.props.value, filterNode.props.value);
assert.equal(nodes(updatedTree).find(node => node.type === FilterBar).props.airlines, airlineTabs);
resultCards(updatedTree).forEach((node, index) => {
  for (const key of Object.keys(node.props)) {
    assert.equal(node.props[key], originalCards[index].props[key], `unchanged ${key} stays stable for card memoization`);
  }
});
resultNodes.find(node => node.type === SortBar).props.onChange('price-high-low');
assert.equal(resultCards(resultTree())[0].props.itinerary.carrierCode, '6E');
resultNodes.find(node => node.type === SortBar).props.onChange('price-low-high');
assert.equal(resultCards(resultTree())[0].props.itinerary.carrierCode, 'G9');
filterNode.props.onChange({ ...filterNode.props.value, price: { min: 13200, max: 13300 } });
assert.equal(resultCards(resultTree()).length, 1);
assert.equal(resultCards(resultTree())[0].props.itinerary.carrierCode, '6E',
  'the price filter uses the full payable');

// A fresh result and a changed pricing role must invalidate cached bounds,
// airline prices, ordering and card flags instead of retaining the old search.
const replacement = {
  ...results, searchId: 'replacement', bookingAvailable: false, holdOnly: true,
  itineraries: [
    option('BG', 0, { id: 'replacement-bg', totalPrice: 5000,
      agencyPricing: { grossPrice: 6000, agentFare: 5000 },
      auditPricing: { grossPrice: 9000, netFare: 4000 } }),
    option('6E', 200, { id: 'replacement-6e', auditPricing: { grossPrice: 3500, netFare: 3000 } }),
  ],
};
state[0] = replacement;
state[5] = null;
updatedTree = resultTree();
updatedFilters = nodes(updatedTree).find(node => node.type === Filters);
assert.equal(updatedFilters.props.options.priceBounds.min, 5000);
assert.equal(updatedFilters.props.options.priceBounds.max, 13057);
assert.ok(text(updatedTree).includes('from BDT 5,000'), 'KTT result minimum retains total-price semantics');
assert.equal(resultCards(updatedTree)[0].props.itinerary.id, 'replacement-bg');
assert.ok(resultCards(updatedTree).every(node =>
  node.props.searchId === 'replacement' && node.props.bookingAvailable === false && node.props.holdOnly === true));
fixtureRole = 'superadmin';
state[7] = { id: 'assignee-new', name: 'Updated assignee', email: 'test@example.test' };
updatedTree = resultTree();
assert.ok(text(updatedTree).includes('from BDT 5,000'), 'changing role does not change KTT total-price sorting or minimum');
assert.equal(resultCards(updatedTree)[0].props.itinerary.id, 'replacement-bg');
assert.equal(nodes(updatedTree).find(node => node.type === FilterBar).props.airlines
  .find(airline => airline.airlineCode === 'BG').minPrice, 9000);
assert.ok(resultCards(updatedTree).every(node =>
  node.props.showAuditFares === true && node.props.showAgencyFares === false &&
  node.props.requiresBookingAssignee === true && node.props.bookingAssigneeId === 'assignee-new'));
fixtureRole = 'customer';
updatedTree = resultTree();
assert.ok(text(updatedTree).includes('from BDT 5,000'));
assert.equal(resultCards(updatedTree)[0].props.itinerary.id, 'replacement-bg');
assert.ok(resultCards(updatedTree).every(node =>
  node.props.showAuditFares === false && node.props.showAgencyFares === false && node.props.requiresBookingAssignee === false));

fixtureRole = 'b2b';
state[0] = { ...results, itineraries: Array.from({ length: 138 }, (_, index) =>
  option('6E', index + 200, { id: `large-result-${index}` })) };
state[5] = null;
updatedTree = resultTree();
assert.equal(resultCards(updatedTree).length, 138, 'memoization keeps every matching flight mounted');
assert.equal(nodes(updatedTree).find(node => node.type === Filters).props.resultCount, 138);
assert.equal(nodes(updatedTree).find(node => node.type === FilterBar).props.airlines[0].totalFlights, 138);

// The existing branded loader still renders all four truthful stages with its
// route animation, backdrop, and automatic-result message.
for (const [stage, label] of [
  ['accepted', 'Preparing your live search'],
  ['searching', 'Contacting airline systems'],
  ['processing', 'Comparing available flights'],
  ['finalizing', 'Getting your results ready'],
]) {
  state = [null, null, true, stage];
  const html = renderToStaticMarkup(resultTree());
  assert.ok(html.includes('Kaliganj Tours &amp; Travel'));
  assert.ok(html.includes('flight-search-route-traveller'));
  assert.ok(html.includes('backdrop-blur-[3px]'));
  assert.ok(html.includes('Your results will appear here automatically'));
  assert.ok(html.includes(label));
  assert.ok(html.includes('DAC') && html.includes('CCU'));
  assert.equal((html.match(/aria-current="step"/g) ?? []).length, 1);
}

console.log(JSON.stringify({ checks: 'passed', payablePrimary: true, oldGrossHidden: true,
  allCarrierPresentation: true, fareOptions: true, airlineTabs: true,
  resultMinimumFiltersAndSorting: true, superAdminAuditPreserved: true,
  stableDerivedDataAndCardProps: true, roleAndResultUpdates: true, allMatchingFlightsPreserved: true,
  supplierOrderAndTotalPricePreserved: true, brandedAnimatedLoaderPreserved: true }, null, 2));
