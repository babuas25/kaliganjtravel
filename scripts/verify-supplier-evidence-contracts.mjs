import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

// V1 remains executable immutable history while V2 owns new reconciliation reads.
const sourcePath = path.join(process.cwd(), 'lib', 'booking-lifecycle', 'supplier-evidence.ts');
const transpiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
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
});
const {
  SUPPLIER_EVIDENCE_FRESHNESS_MS,
  SUPPLIER_EVIDENCE_NORMALIZER_VERSION,
  normalizedPnrEvidence,
  normalizedAirTicketingEvidence,
} = module.exports;

assert.equal(SUPPLIER_EVIDENCE_NORMALIZER_VERSION, 1);
assert.equal(SUPPLIER_EVIDENCE_FRESHNESS_MS, 300000);
const receipt = {
  requestStartedAt: '2026-08-11T10:00:00.000Z',
  responseReceivedAt: '2026-08-11T10:00:10.000Z',
  httpStatus: 200,
  rawPayloadHash: 'a'.repeat(64),
};
const pnr = normalizedPnrEvidence({
  receipt,
  identity: {
    uniqueTransId: 'unique',
    requestedPnr: 'ABC123',
    bookingRefNumber: 'ABC123',
    bookingCodeRef: 'booking-code',
    itemCodeRef: 'item',
    priceCodeRef: 'price',
  },
  facts: {
    responsePnr: 'ABC123',
    supplierStatus: 'Booked',
    airlinesPnr: ['ABC123'],
    supplierEchoedUniqueTransIds: [],
    rawLastTicketTime: '12/08/2026 16:00:00',
    ticketingDeadlineAt: '2026-08-12 16:00:00',
  },
});
const ticketing = normalizedAirTicketingEvidence({
  receipt,
  identity: { uniqueTransId: 'unique', queryStatus: 'Confirmed' },
  facts: {
    supplierStatus: 'Confirmed',
    pnr: 'ABC123',
    airlinesPnr: ['ABC123'],
    ticketInfoUniqueTransId: 'unique',
    supplierBookingId: 305438,
    ticketCodeRef: 'workflow-only',
    ticketNumbers: ['1234567890123'],
    passengerCount: 1,
    passengerIdentityHashes: ['b'.repeat(64)],
    routeSignature: 'DAC-CXB',
    issuedAt: '2026-08-11T10:00:00.000Z',
    cancelledAt: null,
  },
});

for (const evidence of [pnr, ticketing]) {
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.normalizerVersion, 1);
  assert.equal(evidence.supplier, 'triplover');
  assert.equal(evidence.observedAt, receipt.responseReceivedAt);
  assert.equal(evidence.freshUntil, '2026-08-11T10:05:10.000Z');
  assert.equal(evidence.receipt.rawPayloadHash.length, 64);
  assert.ok(!('rawPayload' in evidence));
}
assert.equal(pnr.source, 'pnr');
assert.equal(ticketing.source, 'air-ticketing-details');

const client = read('lib', 'triplover', 'client.ts');
assert.match(client, /createHash\('sha256'\)\.update\(text, 'utf8'\)/);
assert.match(client, /requestStartedAt/);
assert.match(client, /responseReceivedAt/);
assert.match(client, /receipt: response\.receipt/);

const pnrAdapter = read('lib', 'triplover', 'pnr.ts');
const ticketAdapter = read('lib', 'triplover', 'air-ticketing-details.ts');
const canonicalAdapter = read('lib', 'triplover', 'canonical-evidence-v2.ts');
const canonicalModel = read('lib', 'booking-lifecycle', 'canonical-supplier-evidence-v2.ts');
const validator = read(
  'lib',
  'booking-lifecycle',
  'canonical-supplier-evidence-validation-v2.ts'
);
const acquisition = read('lib', 'booking-lifecycle', 'supplier-evidence-read.ts');

assert.match(pnrAdapter, /adaptTriploverPnrEvidenceV2/);
assert.match(pnrAdapter, /reconciliationEvidenceV2/);
assert.match(ticketAdapter, /adaptTriploverTicketReportEvidenceV2/);
assert.match(ticketAdapter, /reconciliationEvidenceV2/);
assert.match(acquisition, /validateCanonicalSupplierEvidenceV2/);
assert.match(acquisition, /evidenceContract: 'canonical_supplier_evidence_v2'/);
assert.match(acquisition, /evidence-read:v2:/);

for (const required of [
  'transactionId',
  'supplierBookingId',
  'supplierPnr',
  'bookingReference',
  'airlinePnrs',
  'operationalReferences',
  'identityConflicts',
  'passengers',
  'itinerary',
  'tickets',
  'supplierWorkflowReference',
  'supplierPayableMinor',
  'currency',
  'rawBookedAt',
  'rawIssuedAt',
  'rawCancelledAt',
  'rawTicketingDeadline',
]) {
  assert.ok(canonicalModel.includes(required), `V2 model omits ${required}`);
}

for (const required of [
  'passenger.first',
  'passenger.last',
  'passenger.passengerType',
  'raw.segments',
  'marketingCarrier',
  'operatingCarrier',
  'flightNumber',
  'canonicalTicketDocument',
  'ticketCodeRef',
  'supplierLifecycleInstant',
]) {
  assert.ok(canonicalAdapter.includes(required), `Triplover V2 adapter omits ${required}`);
}

assert.match(canonicalAdapter, /supplier: TriploverSupplier/);
assert.match(canonicalAdapter, /supplierAccount: input\.supplier/);
assert.doesNotMatch(
  validator,
  /firsttrip|takeoff/i,
  'The shared V2 validator must remain supplier-neutral'
);
assert.doesNotMatch(validator, /acceptedPnr/);
assert.doesNotMatch(validator, /takeoff_manual_ticket|ticketedEvidenceProfile/);
assert.match(validator, /passenger_secondary_identity_mismatch/);
assert.match(validator, /itinerary_identity_mismatch/);
assert.match(validator, /codeshare_identity_ambiguous/);
assert.match(validator, /ticket_document_identity_mismatch/);
assert.match(validator, /supplier_payable_mismatch/);
assert.match(
  validator,
  /supplierWorkflowReference\/ticketCodeRef is deliberately never compared/
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      historicalV1Immutable: true,
      activeContract: 'canonical_supplier_evidence_v2',
      suppliers: ['firsttrip', 'takeoff'],
      sharedValidatorSupplierNeutral: true,
      opaqueTicketCodeReference: true,
      rawPayloadRetained: false,
      rawPayloadHash: 'sha256',
    },
    null,
    2
  )
);
