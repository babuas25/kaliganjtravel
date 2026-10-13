import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Run the production validators against synthetic supplier receipts. Every
// transport remains mocked; this verifier must never issue or retrieve a ticket.
const require = createRequire(import.meta.url);
const root = process.cwd();
const compiledModules = new Map();
function compile(file, overrides = {}) {
  const absolute = path.resolve(root, file);
  if (Object.keys(overrides).length === 0 && compiledModules.has(absolute)) {
    return compiledModules.get(absolute);
  }
  const module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  }).outputText;
  new vm.Script(output, { filename: file }).runInNewContext({
    module, exports: module.exports, console, Date, Error,
    fetch: async () => { throw new Error('External transport is forbidden'); },
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      if (name === 'server-only') return {};
      if (name === 'node:crypto' || name === 'crypto') return require('node:crypto');
      const local = name.startsWith('@/')
        ? path.resolve(root, name.slice(2))
        : name.startsWith('.') ? path.resolve(path.dirname(absolute), name) : null;
      assert.ok(local, `Unexpected external import ${name} from ${file}`);
      const resolved = ['.ts', '.tsx', '/index.ts'].map(extension => `${local}${extension}`)
        .find(candidate => fs.existsSync(candidate));
      assert.ok(resolved, `Missing local import ${name} from ${file}`);
      return compile(resolved);
    },
  });
  if (Object.keys(overrides).length === 0) compiledModules.set(absolute, module.exports);
  return module.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
const copy = value => structuredClone(value);
const indigoValidators = compile('lib/triplover/indigo-ticket.ts');
const { verifyIndigoIssueReceipt, verifyIndigoTicketReport } = indigoValidators;

const airlinePnr = 'XY1234';
const people = [
  { firstName: 'ALPHA', lastName: 'ONE' },
  { firstName: 'BRAVO', lastName: 'TWO' },
  { firstName: 'CHARLIE', lastName: 'THREE' },
];
const segment = {
  from: 'DAC', to: 'CCU', fromAirport: 'Dhaka', toAirport: 'Kolkata',
  departure: '2026-10-21 17:35:00', arrival: '2026-10-21 18:10:00',
  airline: 'IndiGo', airlineCode: '6E', flightNumber: '1106',
  bookingClass: 'X', cabinClass: 'Economy',
};
const perPerson = { basePrice: 10000, taxes: 2800, ait: 56.85, totalPrice: 12856.85 };
const aggregate = { basePrice: 30000, taxes: 8400, ait: 170.55, totalPrice: 38570.55 };
const input = {
  supplier: 'triplover', pnr: 'KT1234', bookingRefNumber: 'saved-booking-reference',
  bookingCodeRef: 'saved-booking-code', uniqueTransId: 'saved-transaction',
  itemCodeRef: 'saved-item-code', priceCodeRef: 'saved-price-code',
  expectedPassengerCount: people.length,
  savedBooking: {
    itinerary: { carrierCode: '6E', carrierName: 'IndiGo', refundable: false,
      legs: [{ from: segment.from, to: segment.to, stops: 0, departure: segment.departure,
        arrival: segment.arrival, segments: [segment] }] },
    airlinePnrs: [airlinePnr],
    passengers: { travellers: people.map(nameElement => ({ passengerType: 'ADT', nameElement })) },
    fares: [{ passengerType: 'ADT', count: people.length, ...aggregate, serviceMargin: 0 }],
    supplierTotalPrice: aggregate.totalPrice,
    grossPrice: aggregate.basePrice + aggregate.taxes + aggregate.ait,
  },
};

function issueReceipt() {
  return {
    pnr: input.pnr, status: 'Issued', isPaid: true, ticketCodeRef: 'issued-ticket-code',
    uniqueTransID: input.uniqueTransId, itemCodeRef: input.itemCodeRef,
    priceCodeRef: input.priceCodeRef, bookingCodeRef: input.bookingCodeRef,
    airlinesPNR: [airlinePnr],
    flightInfo: {
      directions: [[{ segments: [copy(segment)] }]],
      passengerCounts: { adt: people.length }, passengerFares: { adt: copy(perPerson) },
      bookingComponents: [copy(aggregate)], ...aggregate,
    },
    ticketInfoes: people.map(nameElement => ({
      passengerInfo: { passengerType: 'ADT', nameElement: copy(nameElement) },
      ticketNumbers: [airlinePnr],
    })),
  };
}

function ticketReport() {
  return {
    ticketInfo: {
      status: 'Issued', statusFor: 'Ticket', isPaid: true, isCompleted: true,
      issueDate: '2026-10-13 14:00:00', uniqueTransID: input.uniqueTransId,
      pnr: input.pnr, itemCodeRef: input.itemCodeRef,
      ticketCodeRef: 'issued-ticket-code', airlinePNRs: [airlinePnr],
      ticketingPrice: aggregate.totalPrice,
    },
    passengerInfo: people.map(person => ({
      first: person.firstName, last: person.lastName, passengerType: 'ADT',
      basePrice: perPerson.basePrice, tax: perPerson.taxes, ait: perPerson.ait,
      totalPrice: perPerson.totalPrice, ticketNumbers: [airlinePnr],
    })),
    segments: [{ origin: segment.from, destination: segment.to,
      operationCarrier: segment.airlineCode, flightNumber: segment.flightNumber,
      bookingCode: segment.bookingClass, departure: segment.departure, arrival: segment.arrival }],
  };
}

let assertions = 0;
function accepted(validator, receipt, expected = Array(people.length).fill(airlinePnr), saved = input) {
  const result = validator(receipt, saved);
  assert.ok(result, `${validator.name}: a complete matching IndiGo issued receipt must verify`);
  assert.deepEqual(plain(result.ticketNumbers), expected, 'Identifiers retain the saved passenger slots');
  assert.deepEqual(plain(result.airlinesPnr), [airlinePnr]);
  assert.deepEqual(plain(result.passengerTickets), expected.map(number => [number]),
    'Corroboration retains a separate identifier vector for each saved passenger');
  assertions += 4;
  return result;
}
function rejected(name, validator, mutateReceipt, mutateInput = () => {}) {
  const receipt = validator === verifyIndigoIssueReceipt ? issueReceipt() : ticketReport();
  const saved = copy(input);
  mutateReceipt(receipt);
  mutateInput(saved);
  assert.equal(validator(receipt, saved), null, name);
  assertions += 1;
}

for (const [validator, factory, rows] of [
  [verifyIndigoIssueReceipt, issueReceipt, 'ticketInfoes'],
  [verifyIndigoTicketReport, ticketReport, 'passengerInfo'],
]) {
  accepted(validator, factory());
  const flatSavedPassengers = copy(input);
  flatSavedPassengers.savedBooking.passengers = { travellers: people.map(person => ({
    passengerType: 'ADT', firstName: person.firstName, lastName: person.lastName,
  })) };
  accepted(validator, factory(), Array(people.length).fill(airlinePnr), flatSavedPassengers);
  const supplierSavedPassengers = copy(input);
  supplierSavedPassengers.savedBooking.passengers = people.map(nameElement => ({
    passengerType: 'ADT', nameElement: copy(nameElement),
  }));
  accepted(validator, factory(), Array(people.length).fill(airlinePnr), supplierSavedPassengers);
  const commercial = copy(input);
  commercial.savedBooking.fares[0].totalPrice += 600;
  commercial.savedBooking.fares[0].serviceMargin = 600;
  accepted(validator, factory(), Array(people.length).fill(airlinePnr), commercial);
  const reversed = factory();
  reversed[rows].reverse();
  accepted(validator, reversed);
  const missing = factory();
  missing[rows].forEach(person => { delete person.ticketNumbers; });
  accepted(validator, missing);
  // One numeric ticket and a shared airline PNR must remain attached to the
  // saved passenger identity when the supplier returns a different row order.
  const mixed = factory();
  mixed[rows][0].ticketNumbers = ['1234567890123'];
  mixed[rows].reverse();
  accepted(validator, mixed, ['1234567890123', airlinePnr, airlinePnr]);
  rejected('A different saved carrier cannot receive the IndiGo exception', validator, () => {},
    saved => { saved.savedBooking.itinerary.carrierCode = 'BG'; });
  rejected('A non-IndiGo connection cannot receive the exception', validator, () => {},
    saved => { saved.savedBooking.itinerary.legs[0].segments[0].airlineCode = 'BG'; });
  rejected('Missing saved itinerary fails closed', validator, () => {},
    saved => { saved.savedBooking.itinerary = null; });
  rejected('Missing saved passenger context fails closed', validator, () => {},
    saved => { saved.savedBooking.passengers = null; });
  rejected('A different saved airline locator fails closed', validator, () => {},
    saved => { saved.savedBooking.airlinePnrs = ['ZZ9999']; });
  rejected('Missing saved airline locators fail closed', validator, () => {},
    saved => { saved.savedBooking.airlinePnrs = []; });
  rejected('Saved supplier gross must match the receipt components', validator, () => {},
    saved => { saved.savedBooking.grossPrice += 1; });
  rejected('Missing saved supplier gross fails closed', validator, () => {},
    saved => { delete saved.savedBooking.grossPrice; });
  rejected('A receipt identifier outside the saved airline locators fails closed', validator,
    receipt => { receipt[rows][0].ticketNumbers = ['ZZ9999']; });
  rejected('Duplicate numeric tickets never receive the shared-PNR exception', validator,
    receipt => { receipt[rows][0].ticketNumbers = ['1234567890123']; receipt[rows][1].ticketNumbers = ['1234567890123']; });
  rejected('Duplicate identifiers inside one passenger row are ambiguous', validator,
    receipt => { receipt[rows][0].ticketNumbers = [airlinePnr, airlinePnr]; });
  rejected('Incomplete passenger rows fail closed', validator, receipt => { receipt[rows].pop(); });
  rejected('Declared passenger count must match saved identities', validator, () => {},
    saved => { saved.expectedPassengerCount = 2; });
  rejected('Malformed passenger count fails closed', validator, () => {},
    saved => { saved.expectedPassengerCount = 0; });
}

const issue = verifyIndigoIssueReceipt;
rejected('Active hold status is never proof of Issue', issue, receipt => { receipt.status = 'Active'; });
rejected('Unpaid Issue response is never proof of paid issuance', issue, receipt => { receipt.isPaid = false; });
for (const field of ['uniqueTransID', 'itemCodeRef', 'priceCodeRef', 'bookingCodeRef', 'pnr']) {
  rejected(`Issue must reject a mismatched ${field}`, issue, receipt => { receipt[field] = 'wrong-reference'; });
}
rejected('Issue must match saved passenger identities', issue,
  receipt => { receipt.ticketInfoes[0].passengerInfo.nameElement.lastName = 'OTHER'; });
rejected('Issue rejects a duplicated passenger identity', issue,
  receipt => { receipt.ticketInfoes[1].passengerInfo = copy(receipt.ticketInfoes[0].passengerInfo); });
rejected('Issue must match the saved flight number', issue,
  receipt => { receipt.flightInfo.directions[0][0].segments[0].flightNumber = '9999'; });
rejected('Issue must match the saved route', issue,
  receipt => { receipt.flightInfo.directions[0][0].segments[0].to = 'SIN'; });
rejected('Issue must match saved travel time', issue,
  receipt => { receipt.flightInfo.directions[0][0].segments[0].departure = '2026-10-22 17:35:00'; });
rejected('Issue passenger count must match', issue, receipt => { receipt.flightInfo.passengerCounts.adt = 2; });
rejected('Issue must match the saved per-person fare', issue, receipt => { receipt.flightInfo.passengerFares.adt.totalPrice += 1; });
rejected('Issue aggregate supplier fare must match', issue, receipt => { receipt.flightInfo.bookingComponents[0].totalPrice += 1; });
rejected('Issue rejects a conflicting airline locator field', issue, receipt => { receipt.airlinesPNR = ['ZZ9999']; });
rejected('Marketing carrier 6E cannot conceal a different Issue operating carrier', issue,
  receipt => { receipt.flightInfo.directions[0][0].segments[0].operationCarrier = 'BG'; });
for (const flag of ['isCancelled', 'isRefunded', 'isCodeShared', 'isCodeshare']) {
  rejected(`Issue rejects a ${flag} flight segment`, issue,
    receipt => { receipt.flightInfo.directions[0][0].segments[0][flag] = true; });
}

const report = verifyIndigoTicketReport;
const repeatedTypeCountReport = ticketReport();
repeatedTypeCountReport.passengerInfo.forEach(person => { person.passengerCount = 3; });
accepted(report, repeatedTypeCountReport);
rejected('An individually named 3ADT row cannot declare a different type count', report,
  receipt => { receipt.passengerInfo.forEach(person => { person.passengerCount = 2; }); });
for (const [validator, factory] of [[issue, issueReceipt], [report, ticketReport]]) {
  const saved = copy(input);
  saved.savedBooking.itinerary.legs[0].segments[0].cabinClass = '';
  const receipt = factory();
  const suppliedSegment = validator === issue ? receipt.flightInfo.directions[0][0].segments[0] : receipt.segments[0];
  suppliedSegment.cabinClass = 'Economy';
  accepted(validator, receipt, Array(people.length).fill(airlinePnr), saved);
  rejected('A reported cabin cannot contradict a known saved cabin', validator,
    candidate => {
      const leg = validator === issue ? candidate.flightInfo.directions[0][0].segments[0] : candidate.segments[0];
      leg.cabinClass = 'Business';
    });
}
{
  const saved = copy(input);
  const child = { basePrice: 6000, taxes: 1900, ait: 33, totalPrice: 7933 };
  const adultParty = Object.fromEntries(Object.entries(perPerson).map(([key, amount]) => [key, amount * 2]));
  saved.savedBooking.passengers.travellers[2].passengerType = 'CHD';
  saved.savedBooking.fares = [
    { passengerType: 'ADT', count: 2, ...adultParty, serviceMargin: 0 },
    { passengerType: 'CHD', count: 1, ...child, serviceMargin: 0 },
  ];
  saved.savedBooking.supplierTotalPrice = adultParty.totalPrice + child.totalPrice;
  saved.savedBooking.grossPrice = saved.savedBooking.supplierTotalPrice;
  const receipt = ticketReport();
  receipt.ticketInfo.ticketingPrice = saved.savedBooking.supplierTotalPrice;
  receipt.passengerInfo.forEach((person, index) => {
    person.passengerCount = index < 2 ? 2 : 1;
    if (index === 2) Object.assign(person, { passengerType: 'CHD', basePrice: child.basePrice,
      tax: child.taxes, ait: child.ait, totalPrice: child.totalPrice });
  });
  accepted(report, receipt, Array(people.length).fill(airlinePnr), saved);
  for (const [passengerIndex, wrongCount] of [[0, 3], [2, 2]]) {
    const wrong = copy(receipt);
    wrong.passengerInfo[passengerIndex].passengerCount = wrongCount;
    assert.equal(report(wrong, saved), null,
      'A mixed-party row must use one or its own saved passenger-type count, never another type or party count');
    assertions += 1;
  }
  const inflated = copy(receipt);
  inflated.passengerInfo[0].totalPrice *= 2;
  assert.equal(report(inflated, saved), null,
    'Per-person report money is never multiplied by the repeated passenger-type count');
  assertions += 1;
}
const reportWithoutWorkflowCode = ticketReport();
delete reportWithoutWorkflowCode.ticketInfo.ticketCodeRef;
assert.equal(accepted(report, reportWithoutWorkflowCode).ticketCodeRef, null,
  'A verified report does not invent a missing opaque workflow code');
assertions += 1;
rejected('Active report status is not issued', report, receipt => { receipt.ticketInfo.status = 'Active'; });
rejected('A booking report is not an issued ticket report', report, receipt => { receipt.ticketInfo.statusFor = 'Booking'; });
rejected('Unpaid report fails closed', report, receipt => { receipt.ticketInfo.isPaid = false; });
rejected('Incomplete report fails closed', report, receipt => { receipt.ticketInfo.isCompleted = false; });
rejected('Missing Issue date fails closed', report, receipt => { delete receipt.ticketInfo.issueDate; });
rejected('Malformed Issue date fails closed', report, receipt => { receipt.ticketInfo.issueDate = 'not-a-date'; });
for (const invalidDate of ['2026-02-30 14:00:00', '2025-02-29 14:00:00']) {
  rejected('An impossible February Issue date cannot be normalized into valid issuance proof', report,
    receipt => { receipt.ticketInfo.issueDate = invalidDate; });
}
for (const validDate of ['2026-02-28 14:00:00', '2024-02-29 14:00:00']) {
  const valid = ticketReport();
  valid.ticketInfo.issueDate = validDate;
  accepted(report, valid);
}
for (const field of ['uniqueTransID', 'itemCodeRef', 'pnr']) {
  rejected(`Report must reject a mismatched ${field}`, report, receipt => { receipt.ticketInfo[field] = 'wrong-reference'; });
}
rejected('Report must match saved passenger identities', report, receipt => { receipt.passengerInfo[0].last = 'OTHER'; });
rejected('Report rejects duplicated passenger identity', report, receipt => { receipt.passengerInfo[1] = copy(receipt.passengerInfo[0]); });
rejected('Report must match saved flight number', report, receipt => { receipt.segments[0].flightNumber = '9999'; });
rejected('Report must match saved route', report, receipt => { receipt.segments[0].destination = 'SIN'; });
rejected('Report must match saved carrier', report, receipt => { receipt.segments[0].operationCarrier = 'BG'; });
rejected('Report must match saved travel date', report, receipt => { receipt.segments[0].departure = '2026-10-22 17:35:00'; });
rejected('Report must match saved passenger money', report, receipt => { receipt.passengerInfo[0].tax += 1; });
rejected('Report must match saved total supplier price', report, receipt => { receipt.ticketInfo.ticketingPrice += 1; });
rejected('Report rejects a conflicting airline locator field', report,
  receipt => { receipt.ticketInfo.airlinePNRs = ['ZZ9999']; });
rejected('Report rejects a conflicting segment airline locator', report,
  receipt => { receipt.segments[0].airlinePNRs = ['ZZ9999']; });
rejected('Marketing carrier 6E cannot conceal a different report operating carrier', report,
  receipt => { receipt.segments[0].airlineCode = '6E'; receipt.segments[0].operationCarrier = 'BG'; });
for (const flag of ['isCancelled', 'isRefunded', 'isCodeShared', 'isCodeshare']) {
  rejected(`An Issued report cannot prove a ${flag} flight segment`, report,
    receipt => { receipt.segments[0][flag] = true; });
}

class TriploverError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
function adapter({ response = issueReceipt(), corroboration = ticketReport(), readFailure = false } = {}) {
  const calls = [];
  const lifecycleHooks = { synthetic: true };
  const { issueTicket } = compile('lib/triplover/ticket.ts', {
    '@/lib/triplover/client': {
      TriploverError,
      async triploverCall(operation, pathname, payload, options) {
        calls.push({ operation, pathname, payload: plain(payload), options });
        if (operation === 'NewTicket') return { data: copy(response) };
        assert.equal(operation, 'AirTicketingDetails', 'The sole fallback is a read-only ticket report');
        assert.equal(options.method, 'GET');
        assert.equal(options.timeoutMs, 5000);
        assert.equal(payload, null);
        assertions += 4;
        if (readFailure) throw new Error('Synthetic report unavailable');
        return { data: copy(corroboration) };
      },
    },
    '@/lib/triplover/ticket-payload': compile('lib/triplover/ticket-payload.ts'),
    '@/lib/triplover/indigo-ticket': indigoValidators,
  });
  return { calls, run: (saved = input) => issueTicket(copy(saved), lifecycleHooks), lifecycleHooks };
}
function oneWrite(harness, expectedReads) {
  assert.equal(harness.calls.filter(call => call.operation === 'NewTicket').length, 1,
    'NewTicket is never replayed when receipt proof is incomplete');
  assert.equal(harness.calls.filter(call => call.operation === 'AirTicketingDetails').length, expectedReads);
  const sent = harness.calls[0];
  assert.equal(sent.pathname, '/api/ticket/NewTicket');
  assert.deepEqual(sent.payload, {
    PNR: input.pnr, BookingRefNumber: input.bookingRefNumber, UniqueTransID: input.uniqueTransId,
    PriceCodeRef: input.priceCodeRef, ItemCodeRef: input.itemCodeRef, BookingCodeRef: input.bookingCodeRef,
  }, 'Saved verification context does not enter the supplier write payload');
  assert.equal(sent.options.supplier, input.supplier);
  assert.equal(sent.options.lifecycleHooks, harness.lifecycleHooks);
  assertions += 6;
}
{
  const harness = adapter();
  const outcome = await harness.run();
  assert.deepEqual(plain(outcome.ticketNumbers), Array(people.length).fill(airlinePnr));
  assert.deepEqual(plain(outcome.airlinesPnr), [airlinePnr]);
  assert.equal(outcome.ticketCodeRef, 'issued-ticket-code');
  assert.equal(outcome.ticketNumberSource, 'airline_pnr', 'Verified locator provenance survives downstream enrichment');
  assertions += 4;
  oneWrite(harness, 0);
}
{
  const conventional = { pnr: input.pnr, ticketCodeRef: 'numeric-ticket-code',
    ticketInfoes: ['1234567890123', '1234567890124', '1234567890125'].map(number => ({ ticketNumbers: [number] })) };
  const saved = copy(input);
  delete saved.savedBooking;
  const harness = adapter({ response: conventional });
  const outcome = await harness.run(saved);
  assert.deepEqual(plain(outcome.ticketNumbers), conventional.ticketInfoes.map(person => person.ticketNumbers[0]),
    'Existing complete distinct numeric tickets retain their ordinary adapter path');
  assert.equal(outcome.ticketCodeRef, conventional.ticketCodeRef);
  assert.equal(outcome.ticketNumberSource, undefined, 'Conventional numeric tickets are not relabelled as locators');
  assertions += 3;
  oneWrite(harness, 0);
}
function incompleteIssue() {
  const response = issueReceipt();
  delete response.flightInfo;
  return response;
}
{
  const corroboration = ticketReport();
  delete corroboration.ticketInfo.ticketCodeRef;
  corroboration.passengerInfo.forEach(person => { person.passengerCount = 3; });
  corroboration.passengerInfo.reverse();
  const harness = adapter({ response: incompleteIssue(), corroboration });
  const outcome = await harness.run();
  assert.deepEqual(plain(outcome.ticketNumbers), Array(people.length).fill(airlinePnr));
  assert.deepEqual(plain(outcome.airlinesPnr), [airlinePnr]);
  assert.equal(outcome.ticketCodeRef, 'issued-ticket-code',
    'Verified read evidence retains the Issue receipt workflow code without inventing one');
  assert.equal(outcome.ticketNumberSource, 'airline_pnr');
  assertions += 4;
  oneWrite(harness, 1);
}
{
  const response = incompleteIssue();
  response.ticketInfoes[0].ticketNumbers = ['1234567890123'];
  const corroboration = ticketReport();
  corroboration.passengerInfo[0].ticketNumbers = ['1234567890123'];
  corroboration.passengerInfo.reverse();
  const harness = adapter({ response, corroboration });
  const outcome = await harness.run();
  assert.deepEqual(plain(outcome.ticketNumbers), ['1234567890123', airlinePnr, airlinePnr],
    'Report recovery preserves an observed numeric ticket on its saved passenger after row reversal');
  assertions += 1;
  oneWrite(harness, 1);
}
for (const conflict of ['unknown-locator', 'raw-locator-field', 'numeric-passenger-swap', 'numeric-replacement']) {
  const response = incompleteIssue();
  const corroboration = ticketReport();
  if (conflict === 'unknown-locator') response.ticketInfoes[0].ticketNumbers = ['WRONG1'];
  if (conflict === 'raw-locator-field') response.airlinesPNR = ['ZZ9999'];
  if (conflict === 'numeric-passenger-swap') {
    response.ticketInfoes[0].ticketNumbers = ['1234567890123'];
    response.ticketInfoes[1].ticketNumbers = ['1234567890124'];
    corroboration.passengerInfo[0].ticketNumbers = ['1234567890124'];
    corroboration.passengerInfo[1].ticketNumbers = ['1234567890123'];
    corroboration.passengerInfo.reverse();
  }
  if (conflict === 'numeric-replacement') {
    response.ticketInfoes[0].ticketNumbers = ['1234567890123'];
    corroboration.passengerInfo[0].ticketNumbers = ['1234567890124'];
    corroboration.passengerInfo[1].ticketNumbers = ['1234567890123'];
  }
  const harness = adapter({ response, corroboration });
  await assert.rejects(harness.run(), error => error instanceof TriploverError && error.kind === 'protocol',
    `Valid report evidence cannot conceal the original Issue ${conflict}`);
  assertions += 1;
  oneWrite(harness, 1);
}

function singlePassengerCase() {
  const saved = copy(input);
  saved.expectedPassengerCount = 1;
  saved.savedBooking.passengers.travellers = saved.savedBooking.passengers.travellers.slice(0, 1);
  saved.savedBooking.fares = [{ passengerType: 'ADT', count: 1, ...perPerson, serviceMargin: 0 }];
  saved.savedBooking.supplierTotalPrice = perPerson.totalPrice;
  saved.savedBooking.grossPrice = perPerson.basePrice + perPerson.taxes + perPerson.ait;
  const response = issueReceipt();
  response.ticketInfoes = response.ticketInfoes.slice(0, 1);
  response.flightInfo = { ...response.flightInfo, ...perPerson, passengerCounts: { adt: 1 },
    bookingComponents: [copy(perPerson)] };
  const corroboration = ticketReport();
  corroboration.passengerInfo = corroboration.passengerInfo.slice(0, 1);
  corroboration.ticketInfo.ticketingPrice = perPerson.totalPrice;
  return { saved, response, corroboration };
}
{
  const { saved, response, corroboration } = singlePassengerCase();
  accepted(issue, response, [airlinePnr], saved);
  accepted(report, corroboration, [airlinePnr], saved);
  const harness = adapter({ response, corroboration });
  assert.deepEqual(plain((await harness.run(saved)).ticketNumbers), [airlinePnr],
    'A complete one-passenger PNR receipt follows the same full issuer proof');
  assertions += 1;
  oneWrite(harness, 0);
}
for (const scenario of ['missing-context', 'incomplete-receipt-and-report', 'wrong-receipt-reference', 'wrong-receipt-locator']) {
  const { saved, response, corroboration } = singlePassengerCase();
  if (scenario === 'missing-context') delete saved.savedBooking;
  if (scenario === 'incomplete-receipt-and-report') {
    delete response.flightInfo;
    corroboration.ticketInfo.isPaid = false;
  }
  if (scenario === 'wrong-receipt-reference') response.uniqueTransID = 'wrong-reference';
  if (scenario === 'wrong-receipt-locator') response.ticketInfoes[0].ticketNumbers = ['WRONG1'];
  const harness = adapter({ response, corroboration });
  await assert.rejects(harness.run(saved), error => error instanceof TriploverError && error.kind === 'protocol',
    `A unique one-passenger locator must still reject ${scenario}`);
  assertions += 1;
  oneWrite(harness, scenario === 'incomplete-receipt-and-report' || scenario === 'wrong-receipt-locator' ? 1 : 0);
}
for (const scenario of ['complete', 'missing-context', 'wrong-receipt-reference', 'incomplete-proof']) {
  const saved = copy(input);
  const uniquePnrs = ['XY1234', 'XY1235', 'XY1236'];
  saved.savedBooking.airlinePnrs = uniquePnrs;
  const response = issueReceipt();
  response.airlinesPNR = uniquePnrs;
  response.ticketInfoes.forEach((row, index) => { row.ticketNumbers = [uniquePnrs[index]]; });
  const corroboration = ticketReport();
  corroboration.ticketInfo.airlinePNRs = uniquePnrs;
  corroboration.passengerInfo.forEach((row, index) => { row.ticketNumbers = [uniquePnrs[index]]; });
  if (scenario === 'missing-context') delete saved.savedBooking;
  if (scenario === 'wrong-receipt-reference') response.priceCodeRef = 'wrong-reference';
  if (scenario === 'incomplete-proof') {
    delete response.flightInfo;
    corroboration.ticketInfo.isCompleted = false;
  }
  const harness = adapter({ response, corroboration });
  if (scenario === 'complete') {
    const outcome = await harness.run(saved);
    assert.deepEqual(plain(outcome.ticketNumbers), uniquePnrs);
    assert.deepEqual(plain(outcome.airlinesPnr), uniquePnrs);
    assertions += 2;
  } else {
    await assert.rejects(harness.run(saved), error => error instanceof TriploverError && error.kind === 'protocol',
      `Distinct PNR identifiers cannot bypass issuer validation for ${scenario}`);
    assertions += 1;
  }
  oneWrite(harness, scenario === 'incomplete-proof' ? 1 : 0);
}
for (const field of ['uniqueTransID', 'itemCodeRef', 'priceCodeRef', 'bookingCodeRef', 'pnr']) {
  const response = incompleteIssue();
  response[field] = 'wrong-reference';
  const harness = adapter({ response });
  await assert.rejects(harness.run(), error => error instanceof TriploverError && error.kind === 'protocol',
    'A report must never conceal an Issue response for another booking');
  assertions += 1;
  oneWrite(harness, 0);
}
{
  const response = incompleteIssue();
  delete response.ticketCodeRef;
  const harness = adapter({ response });
  await assert.rejects(harness.run(), TriploverError,
    'An opaque workflow code is still mandatory before reading a corroborating report');
  assertions += 1;
  oneWrite(harness, 0);
}
for (const scenario of ['unavailable', 'unpaid', 'active', 'incomplete', 'wrong-ticket-code', 'wrong-passenger']) {
  const corroboration = ticketReport();
  if (scenario === 'unpaid') corroboration.ticketInfo.isPaid = false;
  if (scenario === 'active') corroboration.ticketInfo.status = 'Active';
  if (scenario === 'incomplete') corroboration.ticketInfo.isCompleted = false;
  if (scenario === 'wrong-ticket-code') corroboration.ticketInfo.ticketCodeRef = 'different-ticket-code';
  if (scenario === 'wrong-passenger') corroboration.passengerInfo[0].last = 'OTHER';
  const harness = adapter({ response: incompleteIssue(), corroboration, readFailure: scenario === 'unavailable' });
  await assert.rejects(harness.run(), error => error instanceof TriploverError && error.kind === 'protocol',
    `The ${scenario} report must leave an incomplete Issue receipt on the reconciliation path`);
  assertions += 1;
  oneWrite(harness, 1);
}

console.log(JSON.stringify({ checks: 'passed', assertions, syntheticPassengers: people.length,
  sharedPnrPassengerSlots: true, reversedPassengerOrder: true, missingKnownPnrIdentifiers: true,
  mixedNumericIdentifiers: true, identityAndFareChecks: true, singleIssueWrite: true,
  corroboratingReadOnlyFallback: true, observedPassengerIdentifiersPreserved: true,
  cancelledAndRefundedLegsRejected: true, uniquePnrIssuerProofRequired: true,
  repeatedTypeCountReportRows: true, omittedSavedCabinAccepted: true, strictCalendarIssueDate: true,
  unchangedSupplierPayload: true, externalTransportForbidden: true }, null, 2));
