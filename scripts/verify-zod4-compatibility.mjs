import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';

// Evaluate the application's actual schemas without loading transports or sending notifications.
globalThis.fetch = () => { throw new Error('Network access is forbidden in this test'); };
function evaluate(source, dependencies = {}) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function('exports', 'require', compiled)(exports, name => {
    if (name === 'server-only') return {};
    if (name === 'zod') return { z };
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  });
  return exports;
}
function load(file, dependencies = {}) {
  return evaluate(fs.readFileSync(file, 'utf8'), dependencies);
}
function declarations(file, names, dependencies = {}) {
  const source = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true);
  const selected = ast.statements.filter(statement => ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(declaration =>
      ts.isIdentifier(declaration.name) && names.includes(declaration.name.text)));
  assert.equal(selected.length, names.length, `Missing schema declarations in ${file}`);
  return evaluate(`import { z } from 'zod';\n${Object.keys(dependencies).map(name =>
    `const { ${dependencies[name].names.join(', ')} } = require(${JSON.stringify(name)});`).join('\n')}\n` +
    selected.map(statement => statement.getText(ast)).join('\n') + `\nexport { ${names.join(', ')} };`,
  Object.fromEntries(Object.entries(dependencies).map(([name, value]) => [name, value.module])));
}

const cabin = load('lib/flights/cabin.ts');
const { searchSchema } = declarations('app/api/flights/search/route.ts', [
  'MAX_SEATS', 'MAX_ROUTES', 'iata', 'routeSchema', 'searchSchema',
], { '@/lib/flights/cabin': { names: ['CABIN_CLASSES'], module: cabin } });
const search = {
  tripType: 'oneway', routes: [{ origin: ' dac ', destination: 'cxb', departureDate: '2026-11-04' }],
  adults: 1, children: 0, infants: 0, childrenAges: [], cabinClass: 1, preferredCarriers: ['bg'],
};
const parsedSearch = searchSchema.parse(search);
assert.deepEqual(parsedSearch.routes[0], { origin: 'DAC', destination: 'CXB', departureDate: '2026-11-04' });
assert.deepEqual(parsedSearch.preferredCarriers, ['BG']);
assert.equal(Object.hasOwn(parsedSearch, 'fareType'), false);
assert.equal(searchSchema.parse({ ...search, fareType: 'regular' }).fareType, 'regular');
const unsupportedFare = searchSchema.safeParse({ ...search, fareType: 'student' });
assert.equal(unsupportedFare.success, false);
assert.equal(unsupportedFare.error.issues[0].message, 'Only regular fares are currently available.');
for (const adults of [1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(searchSchema.safeParse({ ...search, adults }).success, false);
}
for (const change of [{ children: 1 }, { infants: 2 }, { adults: 9, children: 1, childrenAges: [7] }]) {
  assert.equal(searchSchema.safeParse({ ...search, ...change }).success, false,
    'Passenger cross-field validation must remain active');
}

// A bounded oversized payload must fail on its length without evaluating any element.
// Accessors make the resource bound deterministic instead of relying on timing or large allocations.
function oversized() {
  const values = new Array(1024);
  for (let index = 0; index < values.length; index++) {
    Object.defineProperty(values, index, { get() { assert.fail('Oversized array elements must not be parsed'); } });
  }
  return values;
}
for (const field of ['routes', 'childrenAges', 'preferredCarriers']) {
  const result = searchSchema.safeParse({ ...search, [field]: oversized() });
  assert.equal(result.success, false);
  assert.equal(result.error.issues.length, 1);
  assert.equal(result.error.issues[0].code, 'too_big');
  assert.deepEqual(result.error.issues[0].path, [field]);
}

const promotion = load('lib/promotional-popup.ts');
const defaults = promotion.promotionSchema.parse({ enabled: false, slides: [] });
assert.deepEqual(defaults.display, promotion.DEFAULT_PROMOTION_DISPLAY,
  'Omitted display settings must still expand all nested defaults');
assert.equal(defaults.autoCloseSeconds, 10);
assert.deepEqual(promotion.promotionSchema.parse({ enabled: false, display: {}, slides: [] }), defaults);
assert.equal(promotion.promotionSchema.safeParse({ enabled: true, slides: [] }).success, false);
assert.equal(promotion.promotionSchema.safeParse({ enabled: false, slides: oversized() }).success, false);
const slide = {
  id: '11111111-1111-4111-8111-111111111111', title: 'Offer',
  imageUrl: 'https://res.cloudinary.com/example/image/upload/offer.png', link: '/dashboard', active: true,
};
assert.equal(promotion.promotionSlideSchema.safeParse(slide).success, true);
for (const id of ['not-a-uuid', '11111111-1111-4111-7111-111111111111']) {
  assert.equal(promotion.promotionSlideSchema.safeParse({ ...slide, id }).success, false,
    'Identifiers must be RFC-valid UUIDs');
}
const { schema: prepareSchema } = declarations('app/api/flights/booking/prepare/route.ts', ['schema']);
const selection = { searchId: slide.id, itineraryId: 'itn-0-0', acceptedRepricedAt: null };
assert.equal(prepareSchema.safeParse({ ...selection, itinerary: { legs: [] } }).success, true);
assert.equal(prepareSchema.safeParse(selection).success, false,
  'A selection missing its public itinerary must fail closed before any booking write');

const { itineraryOfferSchema } = load('lib/flights/share-offer.ts');
const offer = {
  price: 10.25, currency: 'BDT', refundable: false, travellers: 1,
  legs: [{ from: 'DAC', to: 'CXB', stops: 0, segments: [{
    from: 'DAC', to: 'CXB', fromAirport: 'Dhaka', toAirport: 'Coxs Bazar',
    departure: '2026-11-04T12:00:00Z', arrival: '2026-11-04T13:00:00Z',
    airline: 'BG', flightNumber: '123', cabinClass: 'Economy', bookingClass: 'Y',
    baggage: null, handBaggage: null, duration: null,
  }] }],
};
assert.equal(itineraryOfferSchema.parse(offer).price, 10.25, 'Money still accepts finite decimal amounts');
for (const price of [Infinity, -Infinity, NaN]) {
  assert.equal(itineraryOfferSchema.safeParse({ ...offer, price }).success, false);
}
assert.equal(itineraryOfferSchema.safeParse({ ...offer, legs: [{ ...offer.legs[0], stops: Number.MAX_SAFE_INTEGER + 1 }] }).success, false);
assert.equal(itineraryOfferSchema.safeParse({ ...offer, extra: true }).success, false);

const status = load('lib/flights/booking-status.ts');
let reconstructed;
const snapshotReader = load('lib/email/booking-event-snapshot.ts', {
  '@/lib/db/flight-bookings': { publicBooking: row => { reconstructed = row; return {}; } },
  '@/lib/email/booking-template': { bookingStatusEmail: () => assert.fail('No email is sent by snapshot validation') },
  '@/lib/flights/customer-status': { customerStatusMessage: () => 'On Hold' },
  '@/lib/flights/booking-status': status,
});
const snapshot = {
  snapshotVersion: 1, bookingId: slide.id, publicRef: 'KTT261104000001',
  lifecycleStatus: 'on-hold', storedStatus: 'on-hold', audience: 'b2c', agencyCode: null,
  supplier: 'shapontravels', importSource: null, paymentState: 'unpaid', currency: 'BDT',
  pricingSnapshot: { sellingPrice: 10.25, calculation: { markup: 1 } }, supplierGrossAmount: 9.25,
  passengerCounts: { ADT: 1, INF: 0 }, travelDate: '2026-11-04',
  directTicketing: false, passportRequired: false, itinerary: null, fares: [],
  repricedAt: '2026-11-03T10:00:00Z', pnr: 'ABC123', airlinesPnr: ['ABC123'],
  bookingRefNumber: 'ABC123', bookingStatus: 'Created', ticketingTimeLimit: null,
  ticketingDeadlineAt: null, ticketNumbers: [], warnings: [], submissionStartedAt: null,
  bookedAt: '2026-11-03T10:00:00Z', processingSince: null, issuedAt: null, cancelledAt: null,
  operationKind: null, operationReason: null,
  headerContact: { name: 'Agency', licenseNo: '', mobile: '', email: '', address: '', logoUrl: null },
  travellers: [],
};
snapshotReader.bookingEmailDocumentFromEventSnapshot({ bookingSnapshot: snapshot }, 'on-hold');
assert.deepEqual(reconstructed.pricing_snapshot, snapshot.pricingSnapshot);
assert.deepEqual(reconstructed.passenger_counts, snapshot.passengerCounts);
assert.equal(reconstructed.itinerary, null);
const { itinerary: _itinerary, ...incompleteSnapshot } = snapshot;
assert.throws(() => snapshotReader.bookingEmailDocumentFromEventSnapshot({ bookingSnapshot: incompleteSnapshot }, 'on-hold'),
  error => error instanceof z.ZodError, 'Snapshots must include itinerary, with null accepted');
for (const field of ['pricingSnapshot', 'passengerCounts']) {
  assert.throws(() => snapshotReader.bookingEmailDocumentFromEventSnapshot({
    bookingSnapshot: { ...snapshot, [field]: [] },
  }, 'on-hold'), error => error instanceof z.ZodError);
}
assert.throws(() => snapshotReader.bookingEmailDocumentFromEventSnapshot({ bookingSnapshot: snapshot }, 'confirmed'),
  /status does not match/);

console.log('Zod 4 search messages, nested defaults, UUID/numeric validation, snapshot records and bounded array rejection passed.');
