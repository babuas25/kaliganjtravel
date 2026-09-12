import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const sourcePath = path.join(
  process.cwd(),
  'lib',
  'booking-lifecycle',
  'supplier-evidence-validation.ts'
);
const source = fs.readFileSync(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
  reportDiagnostics: true,
});
assert.equal(
  (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  ).length,
  0
);
const module = { exports: {} };
new vm.Script(transpiled.outputText, { filename: sourcePath }).runInNewContext({
  module,
  exports: module.exports,
  require(specifier) {
    if (specifier === 'server-only') return {};
    if (specifier === 'crypto') return crypto;
    throw new Error(`Unexpected runtime import: ${specifier}`);
  },
});

const {
  bookingPassengerIdentityHashes,
  bookingRouteSignature,
  validateSupplierEvidenceSet,
} = module.exports;

const NOW = Date.parse('2026-08-11T10:02:00.000Z');
const passengerHashes = bookingPassengerIdentityHashes({
  travellers: [
    { passengerType: 'ADT', firstName: 'Ashif', lastName: 'Babu' },
    { passengerType: 'CHD', firstName: 'Test', lastName: 'Traveller' },
  ],
});
assert.equal(passengerHashes.length, 2);
assert.deepEqual(
  bookingPassengerIdentityHashes([
    { passengerType: 'chd', firstName: 'Test', lastName: 'Traveller' },
    { passengerType: 'adt', firstName: 'Ashif', lastName: 'Babu' },
  ]),
  passengerHashes
);

const routeSignature = bookingRouteSignature({
  carrierCode: 'BS',
  carrierName: 'US-Bangla',
  refundable: true,
  legs: [
    {
      from: 'DAC',
      to: 'CXB',
      segments: [
        { from: 'DAC', to: 'CGP' },
        { from: 'CGP', to: 'CXB' },
      ],
    },
  ],
});
assert.equal(routeSignature, 'DAC-CGP|CGP-CXB');

const receipt = {
  requestStartedAt: '2026-08-11T10:00:00.000Z',
  responseReceivedAt: '2026-08-11T10:00:10.000Z',
  httpStatus: 200,
  rawPayloadHash: 'a'.repeat(64),
};
const evidenceBase = (source) => ({
  schemaVersion: 1,
  normalizerVersion: 1,
  supplier: 'triplover',
  source,
  observedAt: receipt.responseReceivedAt,
  freshUntil: '2026-08-11T10:05:10.000Z',
  receipt: { ...receipt },
});
const pnrEvidence = (supplierStatus) => ({
  ...evidenceBase('pnr'),
  identity: {
    uniqueTransId: 'unique-123',
    requestedPnr: 'ABC123',
    bookingRefNumber: 'ABC123',
    bookingCodeRef: 'booking-code',
    itemCodeRef: 'item-code',
    priceCodeRef: 'price-code',
  },
  facts: {
    responsePnr: 'ABC123',
    supplierStatus,
    airlinesPnr: ['ABC123'],
    supplierEchoedUniqueTransIds: [],
    rawLastTicketTime: '08/12/2026 16:00:00',
    ticketingDeadlineAt: '2026-08-12T10:00:00.000Z',
  },
});
const airEvidence = (queryStatus, supplierStatus) => ({
  ...evidenceBase('air-ticketing-details'),
  identity: { uniqueTransId: 'unique-123', queryStatus },
  facts: {
    supplierStatus,
    pnr: 'ABC123',
    airlinesPnr: ['ABC123'],
    ticketInfoUniqueTransId: 'unique-123',
    supplierBookingId: 305438,
    ticketCodeRef: 'ticket-code',
    ticketNumbers: ['1234567890123', '1234567890124'],
    passengerCount: 2,
    passengerIdentityHashes: [...passengerHashes],
    routeSignature,
    issuedAt: '2026-08-11T10:00:10.000Z',
    cancelledAt: null,
  },
});
const expected = {
  uniqueTransId: 'unique-123',
  exactUniqueTransId: 'unique-123',
  acceptedPnr: ['ABC123'],
  bookingCodeRef: 'booking-code',
  passengerIdentityHashes: [...passengerHashes],
  routeSignature,
  ticketCodeRef: 'ticket-code',
  ticketNumbers: ['1234567890123', '1234567890124'],
};

function codes(result) {
  return new Set(result.issues.map((issue) => issue.code));
}

function expectRejected(input, expectedCode) {
  const result = validateSupplierEvidenceSet({ now: NOW, ...input });
  assert.equal(result.valid, false, expectedCode);
  assert.equal(result.authoritativeFor, null, expectedCode);
  assert.ok(codes(result).has(expectedCode), expectedCode);
  return result;
}

const held = validateSupplierEvidenceSet({
  purpose: 'held',
  expected,
  pnr: pnrEvidence('Booked'),
  now: NOW,
});
assert.deepEqual(
  {
    valid: held.valid,
    complete: held.complete,
    fresh: held.fresh,
    identityMatches: held.identityMatches,
    authoritativeFor: held.authoritativeFor,
    issueCount: held.issues.length,
  },
  {
    valid: true,
    complete: true,
    fresh: true,
    identityMatches: true,
    authoritativeFor: 'held',
    issueCount: 0,
  }
);

const ticketedPnr = pnrEvidence('Ticketed');
const ticketedAir = airEvidence('Confirmed', 'Confirmed');
assert.equal(
  validateSupplierEvidenceSet({
    purpose: 'ticketed',
    expected,
    pnr: ticketedPnr,
    airTicketing: ticketedAir,
    now: NOW,
  }).authoritativeFor,
  'ticketed'
);
assert.equal(
  validateSupplierEvidenceSet({
    purpose: 'ticketed',
    expected,
    pnr: ticketedPnr,
    airTicketing: ticketedAir,
    now: NOW,
  }).ticketedProfile,
  'generic',
  'ordinary ticketed evidence remains on the generic ticket-code profile'
);

const exactPnrEcho = structuredClone(ticketedPnr);
exactPnrEcho.facts.supplierEchoedUniqueTransIds = ['unique-123'];
assert.equal(
  validateSupplierEvidenceSet({
    purpose: 'ticketed',
    expected,
    pnr: exactPnrEcho,
    airTicketing: ticketedAir,
    now: NOW,
  }).authoritativeFor,
  'ticketed',
  'A supplier-returned PNR echo with an exact stored-ID match remains authoritative'
);

const wrongPnrEcho = structuredClone(ticketedPnr);
wrongPnrEcho.facts.supplierEchoedUniqueTransIds = ['other-transaction'];
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: wrongPnrEcho,
    airTicketing: ticketedAir,
  },
  'pnr_supplier_unique_transaction_mismatch'
);

const conflictingPnrEchoes = structuredClone(ticketedPnr);
conflictingPnrEchoes.facts.supplierEchoedUniqueTransIds = [
  'unique-123',
  'other-transaction',
];
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: conflictingPnrEchoes,
    airTicketing: ticketedAir,
  },
  'pnr_supplier_unique_transaction_mismatch'
);

const whitespacePnrEcho = structuredClone(ticketedPnr);
whitespacePnrEcho.facts.supplierEchoedUniqueTransIds = [' unique-123 '];
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: whitespacePnrEcho,
    airTicketing: ticketedAir,
  },
  'pnr_supplier_unique_transaction_mismatch'
);

const malformedPnrEcho = structuredClone(ticketedPnr);
malformedPnrEcho.facts.supplierEchoedUniqueTransIds = [''];
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: malformedPnrEcho,
    airTicketing: ticketedAir,
  },
  'pnr_supplier_unique_transaction_invalid'
);

const takeoffManualExpected = {
  ...expected,
  ticketCodeRef: null,
  ticketNumbers: [],
  supplierAccount: 'takeoff',
  ticketedEvidenceProfile: 'takeoff_manual_ticket',
};
const takeoffManualAir = structuredClone(ticketedAir);
takeoffManualAir.facts.ticketCodeRef = null;
assert.equal(
  JSON.stringify((() => {
    const result = validateSupplierEvidenceSet({
      purpose: 'ticketed',
      expected: takeoffManualExpected,
      pnr: ticketedPnr,
      airTicketing: takeoffManualAir,
      now: NOW,
    });
    return {
      valid: result.valid,
      authoritativeFor: result.authoritativeFor,
      ticketedProfile: result.ticketedProfile,
      issueCodes: result.issues.map((issue) => issue.code),
    };
  })()),
  JSON.stringify({
    valid: true,
    authoritativeFor: 'ticketed',
    ticketedProfile: 'takeoff_manual_ticket',
    issueCodes: [],
  }),
  'the TakeOff manual profile may replace a missing ticketCodeRef only with the stronger echoed identities'
);

const missingEchoedUniqueTransId = structuredClone(takeoffManualAir);
missingEchoedUniqueTransId.facts.ticketInfoUniqueTransId = null;
expectRejected(
  {
    purpose: 'ticketed',
    expected: takeoffManualExpected,
    pnr: ticketedPnr,
    airTicketing: missingEchoedUniqueTransId,
  },
  'ticket_info_unique_transaction_missing'
);

const wrongEchoedUniqueTransId = structuredClone(takeoffManualAir);
wrongEchoedUniqueTransId.facts.ticketInfoUniqueTransId = 'UNIQUE-123';
expectRejected(
  {
    purpose: 'ticketed',
    expected: takeoffManualExpected,
    pnr: ticketedPnr,
    airTicketing: wrongEchoedUniqueTransId,
  },
  'ticket_info_unique_transaction_mismatch'
);

const whitespaceEchoedUniqueTransId = structuredClone(takeoffManualAir);
whitespaceEchoedUniqueTransId.facts.ticketInfoUniqueTransId =
  ' unique-123 ';
expectRejected(
  {
    purpose: 'ticketed',
    expected: takeoffManualExpected,
    pnr: ticketedPnr,
    airTicketing: whitespaceEchoedUniqueTransId,
  },
  'ticket_info_unique_transaction_mismatch'
);

const missingSupplierBookingId = structuredClone(takeoffManualAir);
missingSupplierBookingId.facts.supplierBookingId = null;
expectRejected(
  {
    purpose: 'ticketed',
    expected: takeoffManualExpected,
    pnr: ticketedPnr,
    airTicketing: missingSupplierBookingId,
  },
  'supplier_booking_id_missing_or_invalid'
);

const invalidSupplierBookingId = structuredClone(takeoffManualAir);
invalidSupplierBookingId.facts.supplierBookingId = 0;
expectRejected(
  {
    purpose: 'ticketed',
    expected: takeoffManualExpected,
    pnr: ticketedPnr,
    airTicketing: invalidSupplierBookingId,
  },
  'supplier_booking_id_missing_or_invalid'
);

const missingIssueDate = structuredClone(takeoffManualAir);
missingIssueDate.facts.issuedAt = null;
expectRejected(
  {
    purpose: 'ticketed',
    expected: takeoffManualExpected,
    pnr: ticketedPnr,
    airTicketing: missingIssueDate,
  },
  'issued_at_missing_or_invalid'
);

const wrongProfileSupplier = expectRejected(
  {
    purpose: 'ticketed',
    expected: { ...takeoffManualExpected, supplierAccount: 'firsttrip' },
    pnr: ticketedPnr,
    airTicketing: takeoffManualAir,
  },
  'takeoff_manual_ticket_profile_forbidden'
);
assert.equal(wrongProfileSupplier.ticketedProfile, null);

const genericMissingTicketCode = structuredClone(ticketedAir);
genericMissingTicketCode.facts.ticketCodeRef = null;
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: ticketedPnr,
    airTicketing: genericMissingTicketCode,
  },
  'ticket_code_missing'
);

const cancelledPnr = pnrEvidence('Cancelled');
const cancelledAir = airEvidence('Cancelled', 'Cancelled');
cancelledAir.facts.issuedAt = null;
cancelledAir.facts.cancelledAt = '2026-08-11T10:00:10.000Z';
assert.equal(
  validateSupplierEvidenceSet({
    purpose: 'cancelled',
    expected,
    pnr: cancelledPnr,
    airTicketing: cancelledAir,
    now: NOW,
  }).authoritativeFor,
  'cancelled'
);

const wrongUnique = structuredClone(ticketedPnr);
wrongUnique.identity.uniqueTransId = 'another-transaction';
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: wrongUnique,
    airTicketing: ticketedAir,
  },
  'unique_transaction_mismatch'
);

const wrongPnr = structuredClone(ticketedPnr);
wrongPnr.facts.responsePnr = 'WRONG1';
expectRejected(
  { purpose: 'ticketed', expected, pnr: wrongPnr, airTicketing: ticketedAir },
  'response_pnr_mismatch'
);

const wrongBookingCode = structuredClone(ticketedPnr);
wrongBookingCode.identity.bookingCodeRef = 'wrong-booking-code';
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: wrongBookingCode,
    airTicketing: ticketedAir,
  },
  'booking_code_mismatch'
);

const wrongPassenger = structuredClone(ticketedAir);
wrongPassenger.facts.passengerIdentityHashes = ['b'.repeat(64)];
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: ticketedPnr,
    airTicketing: wrongPassenger,
  },
  'passenger_identity_mismatch'
);

const wrongRoute = structuredClone(ticketedAir);
wrongRoute.facts.routeSignature = 'DAC-ZYL';
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: ticketedPnr,
    airTicketing: wrongRoute,
  },
  'route_identity_mismatch'
);

const wrongTicketCode = structuredClone(ticketedAir);
wrongTicketCode.facts.ticketCodeRef = 'other-ticket-code';
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: ticketedPnr,
    airTicketing: wrongTicketCode,
  },
  'ticket_code_mismatch'
);

const wrongTicketNumbers = structuredClone(ticketedAir);
wrongTicketNumbers.facts.ticketNumbers = ['9999999999999'];
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: ticketedPnr,
    airTicketing: wrongTicketNumbers,
  },
  'ticket_numbers_mismatch'
);

const conflictingStatus = structuredClone(ticketedAir);
conflictingStatus.facts.supplierStatus = 'Booked';
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: ticketedPnr,
    airTicketing: conflictingStatus,
  },
  'ticketing_status_conflict'
);

const wrongQuery = structuredClone(ticketedAir);
wrongQuery.identity.queryStatus = 'Cancelled';
expectRejected(
  {
    purpose: 'ticketed',
    expected,
    pnr: ticketedPnr,
    airTicketing: wrongQuery,
  },
  'ticketing_query_status_mismatch'
);

const stale = expectRejected(
  {
    purpose: 'held',
    expected,
    pnr: pnrEvidence('Booked'),
    now: Date.parse('2026-08-11T10:06:00.000Z'),
  },
  'evidence_stale'
);
assert.equal(stale.fresh, false);

const wrongSource = structuredClone(ticketedPnr);
wrongSource.source = 'air-ticketing-details';
assert.equal(
  expectRejected(
    { purpose: 'held', expected, pnr: wrongSource },
    'evidence_source_mismatch'
  ).identityMatches,
  false
);

const missingAir = expectRejected(
  { purpose: 'ticketed', expected, pnr: ticketedPnr },
  'air_ticketing_evidence_missing'
);
assert.equal(missingAir.complete, false);

const malformed = expectRejected(
  { purpose: 'held', expected, pnr: {} },
  'pnr_evidence_malformed'
);
assert.equal(malformed.complete, false);

const invalidReceipt = structuredClone(ticketedPnr);
invalidReceipt.receipt.rawPayloadHash = 'not-a-hash';
expectRejected(
  { purpose: 'held', expected, pnr: invalidReceipt },
  'invalid_supplier_receipt'
);

const missingExpectedIdentity = expectRejected(
  {
    purpose: 'ticketed',
    expected: {
      ...expected,
      passengerIdentityHashes: [],
      routeSignature: '',
    },
    pnr: ticketedPnr,
    airTicketing: ticketedAir,
  },
  'expected_passenger_identity_missing'
);
assert.equal(missingExpectedIdentity.complete, false);
assert.equal(missingExpectedIdentity.identityMatches, false);
assert.ok(codes(missingExpectedIdentity).has('expected_route_identity_missing'));

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      validOutcomes: ['held', 'ticketed', 'cancelled'],
      rejectedDimensions: [
        'uniqueTransId',
        'pnrSupplierEchoedUniqueTransId',
        'pnr',
        'bookingCodeRef',
        'passengerIdentity',
        'routeIdentity',
        'ticketCodeRef',
        'takeoffManualTicketEchoedUniqueTransId',
        'takeoffManualTicketSupplierBookingId',
        'takeoffManualTicketIssueTimestamp',
        'ticketNumbers',
        'supplierStatus',
        'queryStatus',
        'freshness',
        'evidenceSource',
        'completeness',
        'receiptIntegrity',
      ],
      partialEvidenceAuthoritative: false,
      takeoffManualTicketProfile: {
        providerScoped: true,
        exactEchoedTransactionMatch: true,
        exactPnrEchoedTransactionMatchWhenPresent: true,
        numericBookingIdRequired: true,
        issueTimestampRequired: true,
        genericTicketCodeRequirementPreserved: true,
      },
    },
    null,
    2
  )
);
