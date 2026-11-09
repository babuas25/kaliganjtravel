import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Actual helper, passenger page, email and PDF renderers; entirely synthetic
// data with no persistence, supplier calls, notification or live HTTP access.
const root = process.cwd();
const require = createRequire(import.meta.url);
const cache = new Map();
const publicCompanyFixtureEnv = {};
const siteModule = { exports: {} };
new vm.Script(ts.transpileModule(fs.readFileSync('lib/site.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext({ module: siteModule, exports: siteModule.exports });
const site = siteModule.exports;
let lastActionsProps = null;
const mocks = {
  'server-only': {},
  '@/lib/site': site,
  '@/components/flights/BookingActions': { __esModule: true, default: props => {
    lastActionsProps = props;
    return React.createElement('aside', null, props.children);
  } },
  '@/components/flights/BookingDeadlineNotice': { BookingDeadlineNotice: () => null },
  '@/components/flights/CheckoutStepper': { __esModule: true, default: () => null },
  '@/components/flights/AirlineLogo': { __esModule: true, default: () => null },
  '@/lib/tickets/verification.server': { bookingPrintVerification: async () => null },
  '@/lib/supabase/server': { supabaseAdmin: () => assert.fail('Database reads are forbidden') },
};
function load(file) {
  const absolute = path.resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  if (absolute.endsWith('.css')) return { __esModule: true,
    default: new Proxy({}, { get: (_target, key) => `displayqa_${String(key)}` }) };
  const module = { exports: {} };
  cache.set(absolute, module);
  const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  function local(candidate) {
    const found = [candidate, `${candidate}.ts`, `${candidate}.tsx`].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    assert.ok(found, `Cannot resolve ${candidate}`);
    return load(found);
  }
  new vm.Script(source, { filename: absolute }).runInNewContext({
    module, exports: module.exports,
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith('@/')) return local(path.join(root, name.slice(2)));
      if (name.startsWith('.')) return local(path.resolve(path.dirname(absolute), name));
      return require(name);
    },
    Intl, Date, Number, Buffer, Promise, URL, URLSearchParams, AbortSignal, console,
    process: { cwd: () => root, env: publicCompanyFixtureEnv },
    // The PDF renderer may request optional public airline artwork. The
    // synthetic response prevents all external transport and exercises text.
    fetch: async () => ({ ok: false }),
  });
  return module.exports;
}
const { bookingTicketDisplay } = load('lib/flights/ticket-display.ts');
const BookingDetails = load('components/flights/BookingDetails.tsx').default;
const { bookingStatusEmail } = load('lib/email/booking-template.ts');
const { confirmedBookingTicketPdf } = load('lib/email/booking-ticket-pdf.ts');
const clone = value => JSON.parse(JSON.stringify(value));
const travellers = Array.from({ length: 3 }, (_, index) => ({ passengerType: 'ADT', title: 'Mr',
  firstName: `Fixture${index}`, lastName: 'Traveller', gender: 'Male', dateOfBirth: '1990-04-03', nationality: 'BD' }));
function booking(carrier = '6E', count = 1, changes = {}) {
  const segment = { from: 'DAC', fromAirport: 'Dhaka Airport', to: 'DEL', toAirport: 'Delhi Airport',
    departure: '2030-01-02 10:30:00', arrival: '2030-01-02 13:30:00',
    airline: carrier === '6E' ? 'IndiGo' : carrier === 'J9' ? 'Jazeera Airways' : 'Synthetic Airline',
    airlineCode: carrier, flightNumber: '123', cabinClass: 'Economy', bookingClass: 'Y',
    duration: '3h', aircraft: 'A320', baggage: '20 KG', handBaggage: '7 KG', seatsLeft: null };
  return {
    bookingId: '11111111-1111-4111-8111-111111111111', publicRef: 'KTT261103111111',
    status: 'confirmed', paymentState: 'captured', statusMessage: null, currency: 'BDT',
    totalPrice: 12000 * count, serviceMargin: 0, passengerCounts: { ADT: count }, travelDate: '2030-01-02',
    directTicketing: false, passportRequired: false,
    itinerary: { carrierCode: carrier, carrierName: segment.airline, refundable: false,
      legs: [{ from: 'DAC', to: 'DEL', stops: 0, duration: '3h', departure: segment.departure,
        arrival: segment.arrival, segments: [segment] }] },
    fares: [{ passengerType: 'ADT', count, basePrice: 10000 * count, taxes: 2000 * count,
      ait: 0, serviceMargin: 0, totalPrice: 12000 * count }],
    repricedAt: '2026-11-03T02:00:00Z', bookedAt: '2026-11-03T02:01:00Z',
    issuedAt: '2026-11-03T02:03:00Z', cancelledAt: null, processingSince: null,
    pnr: 'GDS456', airlinesPnr: ['ALN987'], bookingRefNumber: 'SUPPLIER-BOOKING',
    bookingStatus: 'Confirmed', ticketingTimeLimit: null, ticketingDeadlineAt: null,
    ticketNumbers: [], warnings: [],
    headerContact: { name: 'Synthetic Travel Agency', licenseNo: 'TEST-ONLY', mobile: '+8801700000000',
      email: 'agency@example.invalid', address: 'Synthetic address', logoUrl: null },
    ...changes,
  };
}
const cleanText = value => value.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'")
  .replace(/\s+/g, ' ').trim();
function pageCells(html) {
  return Array.from(html.matchAll(/<td data-label="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g))
    .filter(match => /^(?:Ticket number|Airline PNR)/.test(match[1]))
    .map(match => ({ label: match[1], value: cleanText(match[2]) }));
}
function printFields(html) {
  assert.ok(html.includes('data-print-passenger-index'), 'The same passenger table is retained for target print copies');
  return pageCells(html);
}
function emailTable(html) {
  const table = html.match(/<table[^>]*class="booking-passenger-table"[\s\S]*?<\/table>/)?.[0];
  assert.ok(table, 'The actual email contains its passenger table');
  return table;
}
function emailCells(html) {
  const table = emailTable(html);
  const headers = Array.from(table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)).map(match => cleanText(match[1]));
  return Array.from(table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)).flatMap(row => {
    const cells = Array.from(row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)).map(match => cleanText(match[1]));
    return cells.length === headers.length && /(?:TICKET NUMBER|AIRLINE PNR)/.test(headers.at(-1))
      ? [{ label: headers.at(-1), value: cells.at(-1) }] : [];
  });
}
const bundledTextTool = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftotext');
const textTool = process.env.PDFTOTEXT_BIN || (fs.existsSync(bundledTextTool) ? bundledTextTool : null);
function pdfText(bytes) {
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  if (textTool) return execFileSync(textTool, ['-layout', '-', '-'], { input: bytes, encoding: 'utf8' });
  // Portable fallback for PDFKit's standard Helvetica ASCII content streams.
  // This reads the generated PDF operators, not mocked .text() calls.
  const runs = [];
  // PDFKit writes LF before endstream. A preceding CR can be compressed data.
  for (const match of bytes.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\nendstream/g)) {
    let stream;
    try { stream = inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'); } catch { continue; }
    if (!/\bBT\b/.test(stream)) continue;
    for (const text of stream.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
      runs.push(Array.from(text[1].matchAll(/<([0-9a-f]+)>/gi))
        .map(hex => Buffer.from(hex[1], 'hex').toString('latin1')).join(''));
    }
  }
  assert.ok(runs.length > 20, 'Generated PDF text was decoded from actual content streams');
  return runs.join('\n');
}
function passengerPdfText(text) {
  const compact = text.replace(/\s+/g, ' ');
  const start = compact.toUpperCase().indexOf('PASSENGER & TICKET DETAILS');
  const end = compact.toUpperCase().indexOf('FLIGHT ITINERARY', start);
  assert.ok(start >= 0 && end > start, 'PDF includes its actual passenger and flight sections');
  return compact.slice(start, end);
}
const outputFlag = process.argv.indexOf('--pdf-output-dir');
const outputDirectory = outputFlag >= 0 ? process.argv[outputFlag + 1] : process.env.KTT_TICKET_DISPLAY_PDF_DIR;
if (outputFlag >= 0) assert.ok(outputDirectory, '--pdf-output-dir requires a directory');
if (outputDirectory) fs.mkdirSync(path.resolve(outputDirectory), { recursive: true });
let renderedCases = 0;
async function render(subject, count, artifactName = null) {
  const before = clone(subject);
  const people = travellers.slice(0, count);
  const display = bookingTicketDisplay(subject, count);
  lastActionsProps = null;
  const page = renderToStaticMarkup(React.createElement(BookingDetails, {
    booking: subject, travellers: people, showStepper: false,
  }));
  const printCopies = lastActionsProps?.passengerCopies ?? [];
  const email = bookingStatusEmail({ booking: subject, travellers: people,
    bookingUrl: 'https://booking.example.invalid/synthetic-only' }, subject.status);
  const pdf = await confirmedBookingTicketPdf({ booking: subject, travellers: people });
  const fullPdfText = pdfText(pdf);
  const pdfPassengers = passengerPdfText(fullPdfText);
  if (outputDirectory && artifactName) fs.writeFileSync(path.join(path.resolve(outputDirectory), artifactName), pdf);
  assert.deepEqual(subject, before, 'Display rendering cannot rewrite ticket evidence, payment or supplier data');
  renderedCases++;
  return { display, page, email, fullPdfText, pdfPassengers, printCopies };
}
const shaponPnrDocument = await render(booking('6E', 1, { hideReservationPnr: true }), 1);
assert.doesNotMatch(shaponPnrDocument.page, /Reservation PNR|GDS456/);
assert.doesNotMatch(shaponPnrDocument.fullPdfText, /Reservation PNR|GDS456/);
assert.match(shaponPnrDocument.fullPdfText, /ALN987/);

const terminalLabels = text => text.replace(/\s+/g, ' ').match(/\bTerminal \S+/g) ?? [];
for (const [terminals, expected] of [
  [{ departureTerminal: '2', arrivalTerminal: null }, ['Terminal 2', 'Terminal n/a']],
  [{ departureTerminal: 0, arrivalTerminal: 'Terminal 2' }, ['Terminal 0', 'Terminal 2']],
  [{ arrivalTerminal: '   ' }, ['Terminal n/a', 'Terminal n/a']],
]) {
  const subject = booking();
  Object.assign(subject.itinerary.legs[0].segments[0], terminals);
  const { page, fullPdfText } = await render(subject, 1);
  const screenTerminals = Array.from(
    page.matchAll(/<div class="displayqa_terminus\b[^>]*>([\s\S]*?)<\/div>/g),
    ([, endpoint]) => terminalLabels(cleanText(endpoint)),
  );
  assert.deepEqual(screenTerminals, expected.map(label => [label]), 'Screen shows one terminal label per endpoint');

  const printTable = page.match(/<table class="displayqa_printSegment"[^>]*>([\s\S]*?)<\/table>/)?.[1];
  assert.ok(printTable, 'The ticket includes its dedicated print itinerary table');
  const printEndpoints = Array.from(printTable.matchAll(/<td>([\s\S]*?)<\/td>/g), ([, cell]) => cleanText(cell))
    .filter(cell => /^(Departs|Arrival):/.test(cell));
  assert.match(printEndpoints[0], /^Departs: DAC\b/);
  assert.match(printEndpoints[1], /^Arrival: DEL\b/);
  assert.deepEqual(printEndpoints.map(terminalLabels), expected.map(label => [label]),
    'Print shows the same terminal labels beside the matching airport codes');
  assert.deepEqual(terminalLabels(fullPdfText), expected, 'The PDF contains the same terminal labels');
}

function labelledAirlinePnr(result, values, count) {
  assert.equal(result.display.columnLabel, 'Airline PNR');
  assert.deepEqual(Array.from(result.display.passengers, row => row?.label), Array(count).fill('Airline PNR'));
  assert.deepEqual(Array.from(result.display.passengers, row => row?.value), Array(count).fill(values));
  assert.deepEqual(pageCells(result.page), Array.from({ length: count }, () => ({ label: 'Airline PNR', value: values })));
  assert.deepEqual(printFields(result.page), Array.from({ length: count }, () => ({ label: 'Airline PNR', value: values })),
    'The printed passenger table retains the airline-PNR label');
  assert.ok(result.printCopies.every(copy => copy.fileName === values), 'The print filename uses only the actual airline locator');
  assert.deepEqual(emailCells(result.email.html), Array.from({ length: count }, () => ({ label: 'AIRLINE PNR', value: values })));
  assert.ok(/Airline PNR/i.test(result.pdfPassengers));
  assert.doesNotMatch(result.pdfPassengers, /Ticket number/i, 'A locator is not labelled as a numeric ticket in the PDF');
  assert.ok(result.pdfPassengers.includes(values));
  for (const line of result.email.text.split('\n').filter(line => line.startsWith('- ') && line.includes('Fixture'))) {
    assert.match(line, /Airline PNR/i);
    assert.ok(line.includes(values));
    assert.ok(!line.includes('GDS456'));
  }
  assert.ok(!result.pdfPassengers.includes('GDS456'), 'The passenger PDF identifier never falls back to the GDS locator');
}

for (const [carrier, artifact] of [['6E', 'indigo-pnr.pdf'], ['J9', 'jazeera-pnr.pdf']]) {
  labelledAirlinePnr(await render(booking(carrier), 1, artifact), 'ALN987', 1);
}
labelledAirlinePnr(await render(booking('6E', 3), 3, 'shared-pnr.pdf'), 'ALN987', 3);
for (const carrier of ['6E', 'J9']) {
  labelledAirlinePnr(await render(booking(carrier, 2, { ticketNumbers: ['ALN987', 'ALN987'] }), 2), 'ALN987', 2);
  const numbers = ['ALN987/1', 'ALN987/2'];
  const result = await render(booking(carrier, 2, { ticketNumbers: numbers,
    ticketPassengerNumbers: numbers.map(number => [number]) }), 2);
  assert.equal(result.display.columnLabel, 'Ticket number');
  assert.deepEqual(pageCells(result.page).map(row => row.value), numbers);
  assert.deepEqual(printFields(result.page).map(row => row.value), numbers);
  assert.deepEqual(emailCells(result.email.html).map(row => row.value), numbers);
  assert.ok(numbers.every(number => result.pdfPassengers.includes(number)));
  assert.deepEqual(result.printCopies.map(copy => copy.fileName), ['ALN987-1', 'ALN987-2']);
}
const multiLocatorNumbers = [['ALN987/1', 'AIR002/1'], ['ALN987/2', 'AIR002/2']];
const multiLocatorBooking = booking('J9', 2, {
  airlinesPnr: ['ALN987', 'AIR002'], ticketNumbers: multiLocatorNumbers.flat(),
});
multiLocatorBooking.itinerary.carrierCode = 'BG';
const multiLocator = await render({ ...multiLocatorBooking, ticketPassengerNumbers: multiLocatorNumbers }, 2);
const expectedMultiLocatorCells = multiLocatorNumbers.map(row => row.join(', '));
assert.deepEqual(Array.from(multiLocator.display.unassignedTicketNumbers), []);
assert.deepEqual(pageCells(multiLocator.page).map(row => row.value), expectedMultiLocatorCells);
assert.deepEqual(printFields(multiLocator.page).map(row => row.value), expectedMultiLocatorCells);
assert.deepEqual(emailCells(multiLocator.email.html).map(row => row.value), expectedMultiLocatorCells);
assert.ok(multiLocatorNumbers.flat().every(number => multiLocator.pdfPassengers.includes(number)));
assert.deepEqual(Array.from(bookingTicketDisplay(multiLocatorBooking, 2).unassignedTicketNumbers),
  multiLocatorNumbers.flat(), 'Do not infer historical passenger assignments without verified data');
const legacyDifferentValidatingCarrier = booking('J9', 2, { ticketNumbers: ['ALN987', 'ALN987'] });
legacyDifferentValidatingCarrier.itinerary.carrierCode = 'BG';
labelledAirlinePnr(await render(legacyDifferentValidatingCarrier, 2), 'ALN987', 2);
const numeric = await render(booking('6E', 2, { ticketNumbers: ['1234567890123', '1234567890124'] }), 2, 'numeric-ticket.pdf');
assert.equal(numeric.display.columnLabel, 'Ticket number');
assert.deepEqual(pageCells(numeric.page).map(row => row.value), ['1234567890123', '1234567890124']);
assert.deepEqual(emailCells(numeric.email.html).map(row => row.value), ['1234567890123', '1234567890124']);
for (const number of ['1234567890123', '1234567890124']) assert.ok(numeric.pdfPassengers.includes(number));
assert.match(numeric.pdfPassengers, /Ticket number/i);
const numericLocator = booking('6E', 1, { ticketNumbers: ['123456789012'], airlinesPnr: ['123456789012'] });
assert.equal(bookingTicketDisplay(numericLocator, 1).passengers[0].label, 'Ticket number',
  'A real numeric ticket remains a ticket even when it also resembles a stored locator');
const mixedIdentifiers = await render(booking('J9', 2, { ticketNumbers: ['1234567890123', 'ALN987'] }), 2);
assert.equal(mixedIdentifiers.display.columnLabel, 'Ticket number / Airline PNR');
assert.equal(mixedIdentifiers.display.passengers[0].label, 'Ticket number');
assert.equal(mixedIdentifiers.display.passengers[1].label, 'Airline PNR');
assert.ok(pageCells(mixedIdentifiers.page)[1].value.includes('Airline PNR: ALN987'));
assert.ok(emailCells(mixedIdentifiers.email.html)[1].value.includes('Airline PNR: ALN987'));
assert.ok(mixedIdentifiers.pdfPassengers.includes('Airline PNR: ALN987'));

for (const subject of [
  booking('6E', 1, { status: 'on-hold', paymentState: 'unpaid' }),
  booking('6E', 1, { status: 'unconfirmed' }), booking('6E', 1, { status: 'in-progress' }),
  booking('6E', 1, { paymentState: 'unpaid' }), booking('J9', 1, { paymentState: 'held' }),
  booking('J9', 1, { paymentState: 'refunded' }), booking('BG'),
  booking('6E', 1, { itinerary: null }),
  (() => { const value = booking('6E'); value.itinerary.legs[0].segments.push({ ...value.itinerary.legs[0].segments[0], airlineCode: 'J9' }); return value; })(),
]) {
  const result = await render(subject, 1);
  assert.equal(result.display.hasPassengerValues, false);
  assert.equal(result.display.sharedAirlinePnr, null);
  assert.deepEqual(Array.from(result.display.passengers), [null]);
  assert.equal(pageCells(result.page).length, 0, 'An ineligible passenger table must not invent fallback identifiers');
  assert.ok(!result.pdfPassengers.includes('ALN987'), 'Ineligible passenger PDF does not invent a locator ticket');
  assert.ok(emailCells(result.email.html).every(row => !row.value.includes('ALN987')));
}
for (const airlinesPnr of [[], ['6E'], ['bad locator'], [''], ['J9']]) {
  const result = await render(booking('6E', 1, { airlinesPnr }), 1);
  assert.equal(result.display.hasPassengerValues, false);
  assert.deepEqual(Array.from(result.display.passengers), [null]);
  assert.equal(result.display.sharedAirlinePnr, null);
  assert.equal(result.display.columnLabel, 'Airline PNR');
  assert.equal(result.display.showPassengerColumn, true);
  assert.deepEqual(pageCells(result.page), [{ label: 'Airline PNR', value: 'Not available' }]);
  assert.deepEqual(printFields(result.page), [{ label: 'Airline PNR', value: 'Not available' }]);
  assert.ok(result.printCopies.every(copy => copy.fileName === 'Booking Confirmation'),
    'A missing airline PNR never becomes a dummy identifier or GDS-based print filename');
  assert.deepEqual(emailCells(result.email.html), [{ label: 'AIRLINE PNR', value: 'Not available' }]);
  assert.ok(/Airline PNR/i.test(result.pdfPassengers) && result.pdfPassengers.includes('Not available'));
  assert.ok(!result.pdfPassengers.includes('GDS456'));
}
for (const ticketNumbers of [['1234567890123'], ['', '1234567890123']]) {
  const result = await render(booking('6E', 2, { ticketNumbers }), 2);
  assert.deepEqual(Array.from(result.display.unassignedTicketNumbers), ['1234567890123']);
  assert.deepEqual(Array.from(result.display.passengers, row => row?.value), ['ALN987', 'ALN987']);
  assert.ok(result.page.includes('passenger assignment unavailable') && result.page.includes('Booking ticket numbers:'));
  assert.ok(result.page.includes('Ticket numbers could not be matched to individual passengers.'));
  assert.ok(result.pdfPassengers.includes('passenger assignment unavailable'));
  assert.ok(result.pdfPassengers.includes('Booking ticket numbers: 1234567890123'));
  assert.ok(result.pdfPassengers.includes('Ticket numbers could not be matched to individual passengers.'));
  assert.ok(result.email.html.includes('1234567890123') && result.email.text.includes('1234567890123'));
  assert.ok(result.email.html.includes('Ticket numbers could not be matched') && result.email.text.includes('Ticket numbers could not be matched'));
}
console.log(`PASS airline-PNR and terminal display across screen/print HTML and ${renderedCases} actual PDF texts, plus airline-PNR display in HTML/text email; no live actions.`);
if (outputDirectory) console.log(`Synthetic PDF fixtures: ${path.resolve(outputDirectory)}`);
