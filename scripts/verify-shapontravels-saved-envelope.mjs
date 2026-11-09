import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise actual parsers against synthetic saved-v1 responses. All transport
// and persistence are absent; an accidental supplier write fails immediately.
const modules = new Map();
const allowed = new Set([
  'lib/shapontravels/booking-status.ts', 'lib/shapontravels/ticket.ts',
  'lib/shapontravels/external-ticket-confirmation.ts', 'lib/triplover/ticket-payload.ts',
]);
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  assert.ok(allowed.has(file), `Unexpected module ${file}`);
  const module = { exports: {} };
  modules.set(file, module);
  const source = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new vm.Script(source, { filename: file }).runInNewContext({
    module, exports: module.exports, Date,
    require(name) {
      if (name === 'server-only') return {};
      if (name === './client') return { shapontravelsIssueRequest: () => assert.fail('Supplier writes are forbidden') };
      const candidate = name.startsWith('@/') ? name.slice(2) : path.join(path.dirname(file), name);
      return load(`${candidate}.ts`);
    },
  });
  return module.exports;
}
const status = load('lib/shapontravels/booking-status.ts');
const ticket = load('lib/shapontravels/ticket.ts');
const external = load('lib/shapontravels/external-ticket-confirmation.ts');
const clone = value => JSON.parse(JSON.stringify(value));
const fixture = name => JSON.parse(fs.readFileSync(
  new URL(`fixtures/shapontravels-saved-booking-v1/${name}.json`, import.meta.url), 'utf8'));

function savedOnly(name) {
  const value = fixture(name);
  delete value.item1;
  delete value.item2;
  value.bookingId = value.savedBooking.bookingId;
  value.savedBooking.bookingStatus = null;
  value.savedBooking.missingFields.push('/bookingStatus');
  value.currentStatus = {
    status: value.savedBooking.status, reviewRequired: false, source: 'admin_decision',
    verified: false, supplierStatus: name === 'issued' ? 'Ticketed' : 'Cancelled', supplierCheckedAt: null,
  };
  value.savedBooking.currentStatus = clone(value.currentStatus);
  if (name === 'issued') {
    value.savedBooking.ticketCodeRef = null;
    value.savedBooking.ticketInfoes.forEach(row => { row.ticketCodeRef = null; row.segmentIds = null; });
    // This timestamp is intentionally offsetless, as in the supplier response.
    value.publicReceipt.issuedAt = '2026-11-02T15:28:25.1833333';
    value.savedBooking.publicReceipt = clone(value.publicReceipt);
  }
  return value;
}
const issued = savedOnly('issued');
const cancelled = savedOnly('cancelled');
for (const name of ['on-hold', 'issued', 'cancelled']) {
  const body = fixture(name);
  const before = clone(body);
  const normalized = status.normalizeShapontravelsSavedBookingEnvelope(body);
  assert.ok(normalized?.savedBooking, 'Canonical saved-v1 remains readable alongside successful legacy wrappers');
  assert.equal(normalized.receipt.bookingCodeRef, body.savedBooking.bookingCodeRef);
  assert.deepEqual(clone(normalized.savedBooking), body.savedBooking);
  assert.equal(status.normalizeShapontravelsReceiptEnvelope(body).savedBooking, null,
    'The original normalizer retains legacy priority for irreversible Issue compatibility');
  assert.deepEqual(body, before, 'Canonical saved reads never rewrite either receipt');
}
const multiSegment = fixture('issued');
const firstSegment = multiSegment.savedBooking.segments[0].segmentId;
const secondSegment = `${firstSegment}-return`;
multiSegment.savedBooking.segments.push({ ...clone(multiSegment.savedBooking.segments[0]),
  segmentId: secondSegment, segmentIndex: 1 });
multiSegment.savedBooking.ticketInfoes = multiSegment.savedBooking.ticketInfoes.flatMap(row => [
  { ...clone(row), segmentIds: [firstSegment] },
  { ...clone(row), segmentIds: [secondSegment] },
]);
assert.equal(multiSegment.item1.ticketInfoes.length, 2);
assert.equal(multiSegment.savedBooking.ticketInfoes.length, 4);
assert.ok(status.normalizeShapontravelsSavedBookingEnvelope(multiSegment),
  'Legacy passenger rows and canonical segment rows may repeat the same actual tickets at different row counts');
for (const mutate of [
  body => { body.item1.ticketInfoes[0].ticketNumbers = ['9999999999999']; },
  body => { body.item1.ticketInfoes = null; },
  body => { body.item1.ticketInfoes[0].ticketNumbers = []; },
  body => { body.item1.ticketInfoes[0].ticketNumbers = [' ']; },
  body => { delete body.savedBooking.ticketInfoes[0].ticketNumbers; },
  body => { body.paymentState = 'unpaid'; },
  body => { body.customerPaymentState = 'unpaid'; },
]) {
  const body = clone(multiSegment); mutate(body);
  assert.equal(status.normalizeShapontravelsSavedBookingEnvelope(body), null,
    'Conflicting or malformed actual ticket identifiers cannot be hidden by segment grouping');
}
for (const mutate of [
  body => { delete body.item2; },
  body => { body.item2.isSuccess = false; },
  body => { body.item1.pnr = 'OTHER1'; },
  body => { body.item1.uniqueTransID = body.savedBooking.itemCodeRef; },
  body => { body.item1.bookingStatus = 'Ticketed'; },
  body => { body.item1.ticketCodeRef = '11111111-1111-4111-8111-111111111111'; },
  body => { body.item1.ticketInfoes = [{ ticketNumbers: ['1234567890123'] }]; },
  body => { body.item1.isCancel = false; },
  body => { body.item1.issuedAt = '2026-11-02T10:00:00Z'; },
  body => { body.item1.cancelledAt = '2026-11-02T10:00:00Z'; },
]) {
  const body = fixture('cancelled'); mutate(body);
  assert.equal(status.normalizeShapontravelsSavedBookingEnvelope(body), null,
    'Incomplete/failed/conflicting wrappers cannot authorize canonical saved-status recovery');
}
function expected(body) {
  const saved = body.savedBooking;
  return { uniqueTransId: saved.uniqueTransID, itemCodeRef: saved.itemCodeRef, priceCodeRef: saved.priceCodeRef,
    bookingCodeRef: saved.bookingCodeRef, bookingRefNumber: saved.pnr, pnr: saved.pnr,
    supplierPublicRef: saved.reference };
}
function verify(body, pins = expected(body)) {
  return status.verifyShapontravelsBookingStatus({ httpStatus: 200, supplierPublicRef: pins.supplierPublicRef, body }, pins);
}
const unconfirmedWithoutPnr = fixture('on-hold');
delete unconfirmedWithoutPnr.item1;
delete unconfirmedWithoutPnr.item2;
unconfirmedWithoutPnr.status = unconfirmedWithoutPnr.savedBooking.status = unconfirmedWithoutPnr.publicReceipt.status = 'unconfirmed';
unconfirmedWithoutPnr.savedBooking.pnr = unconfirmedWithoutPnr.savedBooking.bookingRefNumber = null;
unconfirmedWithoutPnr.publicReceipt.pnr = null;
unconfirmedWithoutPnr.currentStatus = { status: 'unconfirmed', reviewRequired: true,
  supplierStatus: null, supplierCheckedAt: null, source: null, verified: null };
unconfirmedWithoutPnr.savedBooking.currentStatus = clone(unconfirmedWithoutPnr.currentStatus);
unconfirmedWithoutPnr.publicReceipt.pendingReview = unconfirmedWithoutPnr.savedBooking.reviewRequired = false;
unconfirmedWithoutPnr.publicReceipt.actions.canIssue = false;
unconfirmedWithoutPnr.publicReceipt.actions.canCancel = true;
unconfirmedWithoutPnr.savedBooking.publicReceipt = clone(unconfirmedWithoutPnr.publicReceipt);
const unconfirmedPins = expected(unconfirmedWithoutPnr);
const unconfirmedRead = { httpStatus: 200, body: unconfirmedWithoutPnr, supplierPublicRef: unconfirmedPins.supplierPublicRef };
const verifiedUnconfirmed = status.verifyShapontravelsBookingStatus(unconfirmedRead, unconfirmedPins, unconfirmedPins.bookingCodeRef);
assert.equal(verifiedUnconfirmed.result, 'verified');
assert.equal(verifiedUnconfirmed.currentStatus.status, 'unconfirmed');
assert.equal(verifiedUnconfirmed.currentStatus.reviewRequired, true);
assert.equal(verifiedUnconfirmed.currentStatus.canCancel, true);
assert.equal(verifiedUnconfirmed.currentStatus.canIssue, false);
assert.equal(status.verifyShapontravelsBookingStatus(unconfirmedRead, unconfirmedPins,
  '11111111-1111-4111-8111-111111111111').result, 'mismatch');
for (const body of [issued, cancelled]) {
  const before = clone(body);
  const result = verify(body);
  assert.equal(result.result, 'verified');
  assert.equal(result.originalBookingStatus, null, 'An absent original booking status is never invented');
  assert.equal(result.currentStatusState, 'available');
  assert.equal(result.currentStatus.status, body.status);
  assert.equal(result.currentStatus.source, 'public_receipt');
  assert.equal(result.currentStatus.verified, false, 'An Admin decision is not a verified airline read');
  assert.equal(result.currentStatus.supplierStatus, null);
  assert.equal(result.currentStatus.supplierCheckedAt, null);
  assert.deepEqual(body, before, 'Normalization never rewrites supplier evidence');
}
assert.equal(verify(issued, { ...expected(issued), supplierPublicRef: 'STRFOREIGN123' }).result, 'mismatch');
assert.equal(verify(issued, { ...expected(issued), pnr: 'OTHER1' }).result, 'mismatch');
const pins = expected(issued);
const input = { ...pins, expectedPassengerCount: 2,
  itinerary: { carrierCode: 'BG', legs: [{ segments: [{ airlineCode: 'BG' }] }] } };
const booking = {
  supplier_refs: pins, pnr: pins.pnr, booking_ref_number: pins.bookingRefNumber,
  booking_code_ref: pins.bookingCodeRef, passenger_counts: { ADT: 2 }, itinerary: input.itinerary,
};
const proof = (bookingBody = issued, ticketBody = issued) => external.verifyShaponExternalTicketConfirmation(
  booking, { httpStatus: 200, supplierPublicRef: pins.supplierPublicRef, body: bookingBody },
  { httpStatus: 200, body: ticketBody }, pins.supplierPublicRef,
);
const evidence = ticket.parseShapontravelsTicketEvidence(issued, input);
assert.ok(evidence);
assert.equal(evidence.ticket.ticketCodeRef, null);
assert.equal(evidence.source, 'supplier_saved_ticket_details');
assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.ticket.pnr, 'SAVE01');
assert.deepEqual(clone(evidence.ticket.airlinesPnr), ['AIR001']);
const noAirlinePnr = clone(issued);
delete noAirlinePnr.savedBooking.airlinesPNR;
assert.deepEqual(clone(ticket.parseShapontravelsTicketEvidence(noAirlinePnr, input).ticket.airlinesPnr), []);
assert.deepEqual(clone(proof(noAirlinePnr, noAirlinePnr).ticketProof.airlinesPnr), []);
assert.deepEqual(clone(evidence.ticket.ticketNumbers), ['7790000000001', '7790000000002'],
  'Canonical rows are reordered by their explicit passenger association');
assert.equal(ticket.parseShapontravelsTicketReceipt(issued, input), null,
  'The irreversible NewTicket parser still requires its original complete UUID receipt');
const confirmation = proof();
assert.ok(confirmation);
assert.equal(confirmation.ticketProof.ticketCodeRef, null);
assert.equal(confirmation.ticketProof.source, 'supplier_saved_ticket_details');
assert.equal(confirmation.ticketProof.schemaVersion, 1);
assert.equal(Object.hasOwn(confirmation.ticketProof, 'issuedAt'), false,
  'An offsetless saved issue time must not be interpreted in the server timezone');
assert.equal(confirmation.ticketProof.passengerTickets.length, 2);
for (const carrierCode of ['6E', 'J9']) {
  const platform = fixture('issued');
  const expected = ['AIR001/1', 'AIR001/2'];
  for (const row of platform.savedBooking.ticketInfoes) {
    row.ticketNumbers = [expected[row.passengerIndex]];
    row.ticketNumberSource = 'platform_pnr';
  }
  platform.item1.ticketInfoes = clone(platform.savedBooking.ticketInfoes);
  const platformItinerary = { carrierCode, legs: [{ segments: [{ airlineCode: carrierCode }] }] };
  const platformInput = { ...input, itinerary: platformItinerary };
  const noWrapper = clone(platform);
  delete noWrapper.item1;
  delete noWrapper.item2;
  for (const body of [platform, noWrapper]) {
    const platformEvidence = ticket.parseShapontravelsTicketEvidence(body, platformInput);
    assert.deepEqual(clone(platformEvidence.ticket.ticketNumbers), expected);
    assert.deepEqual(clone(platformEvidence.passengerTickets).map(row => row.ticketNumberSource), ['platform_pnr', 'platform_pnr']);
    const platformConfirmation = external.verifyShaponExternalTicketConfirmation(
      { ...booking, itinerary: platformItinerary },
      { httpStatus: 200, supplierPublicRef: pins.supplierPublicRef, body }, { httpStatus: 200, body },
      pins.supplierPublicRef,
    );
    assert.deepEqual(clone(platformConfirmation.ticketProof.ticketNumbers), expected);
  }
  const contradicted = clone(platform);
  const [first, second] = contradicted.item1.ticketInfoes;
  [first.ticketNumbers, second.ticketNumbers] = [second.ticketNumbers, first.ticketNumbers];
  assert.equal(ticket.parseShapontravelsTicketEvidence(contradicted, platformInput), null);
}
const dated = clone(issued);
dated.publicReceipt.issuedAt = '2026-11-02T15:28:25.1833333+06:00';
dated.savedBooking.publicReceipt = clone(dated.publicReceipt);
assert.equal(proof(dated, dated).ticketProof.issuedAt, dated.publicReceipt.issuedAt);

const malformed = [
  body => { body.savedBooking.schemaVersion = 2; },
  body => { body.savedBooking.bookingId = pins.uniqueTransId; },
  body => { body.bookingId = pins.uniqueTransId; },
  body => { body.savedBooking.reference = 'not-a-reference'; },
  body => { body.savedBooking.currentStatus.reviewRequired = true; },
  body => { body.savedBooking.publicReceipt.pnr = 'OTHER1'; },
  body => { body.savedBooking.paymentState = 'unpaid'; },
  body => { body.savedBooking.payment.extra = 'undocumented'; },
  body => { body.savedBooking.passengerCount = 1; },
  body => { body.savedBooking.missingFields = ['bookingStatus']; },
  body => { body.item1 = { pnr: pins.pnr }; },
  body => { body.item2 = { isSuccess: false }; },
];
for (const mutate of malformed) {
  const body = clone(issued); mutate(body);
  assert.equal(status.normalizeShapontravelsReceiptEnvelope(body), null);
  assert.equal(verify(body).result, 'unverified');
  assert.equal(ticket.parseShapontravelsTicketEvidence(body, input), null);
  assert.equal(proof(body, body), null);
}
for (const mutate of [
  body => { body.savedBooking.ticketInfoes[0].passengerId = 'foreign-passenger'; },
  body => { body.savedBooking.ticketInfoes[0].passengerIndex = 10; },
  body => { body.savedBooking.ticketInfoes[0].passengerInfo.nameElement.lastName = 'Foreign'; },
  body => { delete body.savedBooking.passengerInfoes[0].gender;
    delete body.savedBooking.ticketInfoes[1].passengerInfo.gender; },
  body => { body.savedBooking.passengerInfoes[0].nameElement.title = 'Unknown'; },
  body => { body.savedBooking.ticketInfoes[0].segmentIds = ['foreign-segment']; },
  body => { body.savedBooking.ticketInfoes[0].ticketNumberSource = 'unknown'; },
  body => { body.savedBooking.ticketInfoes[0].ticketNumbers = ['ABC123']; },
  body => { body.savedBooking.ticketInfoes[0].ticketNumbers = body.savedBooking.ticketInfoes[1].ticketNumbers; },
  body => { body.savedBooking.ticketInfoes.pop(); },
]) {
  const body = clone(issued); mutate(body);
  assert.equal(ticket.parseShapontravelsTicketEvidence(body, input), null);
  assert.equal(proof(body, body), null);
}
const foreignReference = clone(issued);
foreignReference.savedBooking.reference = 'STRFOREIGN123';
assert.equal(proof(issued, foreignReference), null, 'The ticket STR reference is pinned independently');
const changedPassenger = clone(issued);
changedPassenger.savedBooking.passengerInfoes[0].nameElement.lastName = 'Different';
changedPassenger.savedBooking.ticketInfoes[1].passengerInfo.nameElement.lastName = 'Different';
assert.equal(proof(issued, changedPassenger), null, 'Two saved reads must agree on passenger/flight/ticket snapshots');
assert.equal(ticket.parseShapontravelsTicketEvidence(cancelled, input), null);
assert.equal(proof(issued, cancelled), null);

const legacy = fixture('issued');
const legacyPins = expected(legacy);
assert.equal(verify(legacy).result, 'verified');
assert.ok(ticket.parseShapontravelsTicketReceipt(legacy, { ...input, ...legacyPins }));
assert.equal(ticket.parseShapontravelsTicketEvidence(legacy, { ...input, ...legacyPins }).source, 'supplier_ticket_details');
console.log('PASS saved-v1 no-wrapper confirmed/cancelled reads, Admin summaries, nullable ticket UUID evidence, passenger associations, STR pins, malformed/conflicting snapshots, offset-safe timestamps and retained legacy Issue parser; no network/database writes.');
