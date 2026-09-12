import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const ROOT = process.cwd();
const moduleCache = new Map();

function loadTs(relativePath, overrides = {}) {
  const absolutePath = path.join(ROOT, relativePath);
  if (moduleCache.has(absolutePath) && Object.keys(overrides).length === 0) {
    return moduleCache.get(absolutePath);
  }
  const source = fs.readFileSync(absolutePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: absolutePath,
    reportDiagnostics: true,
  });
  assert.equal(
    (transpiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
    ).length,
    0,
    `TypeScript transpilation failed for ${relativePath}`
  );
  const module = { exports: {} };
  if (Object.keys(overrides).length === 0) moduleCache.set(absolutePath, module.exports);
  const localRequire = (specifier) => {
    if (specifier in overrides) return overrides[specifier];
    if (specifier === 'server-only') return {};
    if (specifier === 'node:crypto' || specifier === 'crypto') return crypto;
    if (specifier.startsWith('@/')) {
      return loadTs(`${specifier.slice(2)}.ts`);
    }
    throw new Error(`Unexpected runtime import in ${relativePath}: ${specifier}`);
  };
  new vm.Script(transpiled.outputText, { filename: absolutePath }).runInNewContext({
    module,
    exports: module.exports,
    require: localRequire,
    structuredClone,
    console,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Array,
    Map,
    Set,
    RegExp,
    String,
    Boolean,
    Error,
  });
  if (Object.keys(overrides).length === 0) moduleCache.set(absolutePath, module.exports);
  return module.exports;
}

const canonical = loadTs(
  'lib/booking-lifecycle/canonical-supplier-evidence-v2.ts'
);
const validator = loadTs(
  'lib/booking-lifecycle/canonical-supplier-evidence-validation-v2.ts'
);
const adapter = loadTs('lib/triplover/canonical-evidence-v2.ts');

const NOW = Date.parse('2026-08-27T06:04:00.000Z');
const RECEIPT = {
  requestStartedAt: '2026-08-27T06:02:00.000Z',
  responseReceivedAt: '2026-08-27T06:02:10.000Z',
  httpStatus: 200,
  rawPayloadHash: 'a'.repeat(64),
};

function bookingFor(supplierAccount) {
  return {
    id: `booking-${supplierAccount}`,
    supplier: 'triplover',
    supplier_account: supplierAccount,
    status: 'confirmed',
    payment_state: 'captured',
    currency: 'BDT',
    pricing_snapshot: {
      supplierTotalPrice: 39164.99,
      grossPrice: 39752.46,
    },
    supplier_refs: {
      uniqueTransId:
        supplierAccount === 'firsttrip'
          ? 'FST639234137596811234'
          : 'TOT639234137596811234',
      itemCodeRef: 'ITEM-01',
      priceCodeRef: 'PRICE-01',
    },
    booking_code_ref: 'BOOKING-CODE-01',
    ticket_code_ref: 'OPAQUE-WORKFLOW-REF',
    pnr: 'HWXM9D',
    booking_ref_number: 'BR-807632',
    airlines_pnr: ['FRZVCH'],
    ticket_numbers: ['6182480763274', '6182480763275'],
    passengers: {
      travellers: [
        {
          passengerType: 'ADT',
          title: 'Mr',
          firstName: 'MD NAJMUL ISLAM',
          lastName: 'KHAN',
          dateOfBirth: '1990-02-03',
          passportNumber: 'A01234567',
        },
        {
          passengerType: 'ADT',
          title: 'Mr',
          firstName: 'MD NAJMUL ISLAM',
          lastName: 'KHAN',
          dateOfBirth: '1992-04-05',
          passportNumber: 'B07654321',
        },
      ],
    },
    itinerary: {
      carrierCode: 'SQ',
      carrierName: 'Singapore Airlines',
      refundable: false,
      legs: [
        {
          from: 'DAC',
          to: 'SIN',
          segments: [
            {
              from: 'DAC',
              to: 'BKK',
              airlineCode: 'SQ',
              flightNumber: '447',
              departure: '2026-09-10 23:55:00',
            },
            {
              from: 'BKK',
              to: 'SIN',
              airlineCode: 'SQ',
              flightNumber: '711',
              departure: '2026-09-11 08:30:00',
            },
          ],
        },
      ],
    },
  };
}

function rawPnr(booking, status = 'Issued') {
  return {
    pnr: 'FRZVCH',
    airlinePNRs: ['FRZVCH'],
    status,
    lastTicketTime: '08/27/2026 18:00:00',
  };
}

function rawReport(booking, overrides = {}) {
  const report = {
    ticketInfo: {
      status: 'Issued',
      pnr: booking.pnr,
      airlinePNRs: ['FRZVCH'],
      uniqueTransID: booking.supplier_refs.uniqueTransId,
      bookingId: 807632,
      ticketCodeRef: null,
      ticketingPrice: 39164.99,
      currency: 'BDT',
      bookingDate: '2026-08-27 11:09:00',
      issueDate: '2026-08-27T12:02:16.1234567',
      referenceLog: JSON.stringify({
        UniqueTransID: booking.supplier_refs.uniqueTransId,
        ItemCodeRef: booking.supplier_refs.itemCodeRef,
        PriceCodeRef: booking.supplier_refs.priceCodeRef,
        BookingCodeRef: booking.booking_code_ref,
        PNR: booking.pnr,
        BookingRefNumber: booking.booking_ref_number,
      }),
    },
    passengerInfo: [
      {
        title: 'MR',
        first: ' md   najmul islam ',
        last: ' khan ',
        passengerType: 'adt',
        passengerCount: 1,
        dateOfBirth: '1990-02-03T00:00:00',
        documentNumber: 'A01234567',
        ticketNumbers: ['618-2480763274'],
      },
      {
        title: 'MR',
        first: 'MD NAJMUL ISLAM',
        last: 'KHAN',
        passengerType: 'ADT',
        passengerCount: 1,
        dateOfBirth: '1992-04-05',
        documentNumber: 'B07654321',
        ticketNumbers: ['6182480763275'],
      },
    ],
    segments: [
      {
        origin: 'DAC',
        destination: 'BKK',
        operationCarrier: 'SQ',
        flightNumber: '447',
        departure: '2026-09-10 23:55:00',
        arrival: '2026-09-11 05:50:00',
        isCodeShared: false,
      },
      {
        origin: 'BKK',
        destination: 'SIN',
        operationCarrier: 'SQ',
        flightNumber: '711',
        departure: '2026-09-11 08:30:00',
        arrival: '2026-09-11 11:55:00',
        isCodeShared: false,
      },
    ],
  };
  return Object.assign(report, overrides);
}

function evidenceSet(supplierAccount) {
  const booking = bookingFor(supplierAccount);
  const expected = canonical.canonicalExpectedBookingV2(booking);
  const pnr = adapter.adaptTriploverPnrEvidenceV2({
    supplier: supplierAccount,
    receipt: RECEIPT,
    request: {
      ...booking.supplier_refs,
      pnr: booking.pnr,
      bookingRefNumber: booking.booking_ref_number,
      bookingCodeRef: booking.booking_code_ref,
    },
    raw: rawPnr(booking),
    envelopeUniqueTransIds: [booking.supplier_refs.uniqueTransId],
    ticketingDeadlineAt: '2026-08-27T12:00:00.000Z',
  });
  const ticketReport = adapter.adaptTriploverTicketReportEvidenceV2({
    supplier: supplierAccount,
    receipt: RECEIPT,
    requestedUniqueTransId: booking.supplier_refs.uniqueTransId,
    requestedStatus: 'Confirmed',
    raw: rawReport(booking),
  });
  return { booking, expected, pnr, ticketReport };
}

function validate(set, purpose = 'ticketed') {
  return validator.validateCanonicalSupplierEvidenceV2({
    purpose,
    expected: set.expected,
    pnr: set.pnr,
    ticketReport: purpose === 'held' ? undefined : set.ticketReport,
    now: NOW,
  });
}

function codes(result) {
  return new Set(result.issues.map((issue) => issue.code));
}

function rejectMutation(base, mutate, expectedCode) {
  const set = structuredClone(base);
  mutate(set);
  const result = validate(set);
  assert.equal(result.valid, false, expectedCode);
  assert.equal(result.authoritativeFor, null, expectedCode);
  assert.ok(codes(result).has(expectedCode), `${expectedCode}: ${JSON.stringify(result.issues)}`);
}

for (const supplierAccount of ['firsttrip', 'takeoff', 'triplover']) {
  const set = evidenceSet(supplierAccount);
  const ticketed = validate(set);
  assert.equal(ticketed.valid, true, `${supplierAccount} ticketed fixture`);
  assert.equal(ticketed.authoritativeFor, 'ticketed');
  assert.equal(ticketed.contractVersion, 2);
  assert.equal(set.ticketReport.schemaVersion, 2);
  assert.equal(set.ticketReport.supplierAccount, supplierAccount);
  assert.equal(set.ticketReport.passengers.length, 2, 'passenger multiplicity is preserved');
  assert.equal(set.ticketReport.itinerary.length, 2, 'ordered root segments are preserved');
  assert.deepEqual(
    Array.from(set.ticketReport.tickets, (ticket) => ticket.fullNumber),
    ['6182480763274', '6182480763275']
  );
  assert.equal(set.ticketReport.supplierWorkflowReference, null);
  assert.equal(set.ticketReport.financial.supplierPayableMinor, 3916499);
  assert.equal(set.ticketReport.financial.currency, 'BDT');
  assert.equal(set.ticketReport.lifecycle.bookedAt, '2026-08-27T05:09:00.000Z');
  assert.equal(set.ticketReport.lifecycle.issuedAt, '2026-08-27T06:02:16.123Z');
  assert.equal(set.ticketReport.lifecycle.rawIssuedAt, '2026-08-27T12:02:16.1234567');
  assert.equal(set.ticketReport.itinerary[0].departureAt, '2026-09-10T17:55:00.000Z');

  for (const heldStatus of ['Booked', 'Held', 'On Hold']) {
    const held = evidenceSet(supplierAccount);
    held.pnr.lifecycle.state = canonical.canonicalLifecycleState(heldStatus);
    held.pnr.lifecycle.rawStatus = heldStatus;
    assert.equal(validate(held, 'held').authoritativeFor, 'held');
  }

  rejectMutation(set, (value) => {
    value.ticketReport.passengers[0].identityHash = 'b'.repeat(64);
  }, 'passenger_identity_mismatch');
  rejectMutation(set, (value) => {
    value.ticketReport.passengers.pop();
  }, 'passenger_identity_mismatch');
  rejectMutation(set, (value) => {
    value.ticketReport.itinerary.reverse();
    value.ticketReport.itinerary.forEach((segment, index) => { segment.sequence = index; });
  }, 'itinerary_identity_mismatch');
  rejectMutation(set, (value) => {
    value.ticketReport.itinerary[0].flightNumber = '999';
  }, 'itinerary_identity_mismatch');
  rejectMutation(set, (value) => {
    value.ticketReport.itinerary[0].travelDate = '2026-09-12';
  }, 'itinerary_identity_mismatch');
  rejectMutation(set, (value) => {
    value.ticketReport.itinerary[0].operatingCarrier = 'TG';
  }, 'itinerary_identity_mismatch');
  rejectMutation(set, (value) => {
    value.ticketReport.itinerary[0].codeshare = true;
    value.ticketReport.itinerary[0].codeshareAmbiguous = true;
  }, 'codeshare_identity_ambiguous');
  rejectMutation(set, (value) => {
    value.ticketReport.tickets[0].fullNumber = '6182480763999';
  }, 'ticket_document_identity_mismatch');
  rejectMutation(set, (value) => {
    value.ticketReport.tickets = [];
    value.ticketReport.completeness.tickets = false;
  }, 'authoritative_ticket_documents_missing');
  rejectMutation(set, (value) => {
    value.ticketReport.bookingIdentity.transactionId = 'OTHER';
  }, 'ticket_report_transaction_mismatch');
  rejectMutation(set, (value) => {
    value.ticketReport.bookingIdentity.supplierPnr = 'OTHERPNR';
  }, 'supplier_pnr_mismatch');
  rejectMutation(set, (value) => {
    value.ticketReport.bookingIdentity.bookingReference = 'OTHERREF';
  }, 'booking_reference_mismatch');
  rejectMutation(set, (value) => {
    value.pnr.requestIdentity.operationalReferences.itemCodeRef = 'OTHER';
  }, 'itemCodeRef_mismatch');
  rejectMutation(set, (value) => {
    value.pnr.bookingIdentity.responseLocators = [
      { value: 'UNKNOWN', kind: 'unclassified' },
    ];
  }, 'pnr_typed_locator_mismatch');
  rejectMutation(set, (value) => {
    value.ticketReport.financial.supplierPayableMinor += 1;
  }, 'supplier_payable_mismatch');
  rejectMutation(set, (value) => {
    value.ticketReport.financial.currency = 'USD';
  }, 'supplier_currency_mismatch');
  rejectMutation(set, (value) => {
    value.pnr.lifecycle.state = 'held';
  }, 'pnr_status_conflict');
  rejectMutation(set, (value) => {
    value.ticketReport.lifecycle.state = 'cancelled';
  }, 'ticket_report_status_conflict');
  rejectMutation(set, (value) => {
    value.ticketReport.bookingIdentity.identityConflicts = ['transaction_id_conflict'];
  }, 'ticket_report_internal_identity_conflict');
  rejectMutation(set, (value) => {
    value.pnr.bookingIdentity.identityConflicts = ['transaction_id_conflict'];
  }, 'pnr_internal_identity_conflict');
  rejectMutation(set, (value) => {
    value.ticketReport.freshUntil = '2026-08-27T06:02:11.000Z';
  }, 'invalid_evidence_timestamps');
  rejectMutation(set, (value) => {
    value.ticketReport.schemaVersion = 1;
  }, 'ticket_report_evidence_malformed');

  const workflowReferenceOnly = structuredClone(set);
  workflowReferenceOnly.ticketReport.supplierWorkflowReference = 'UNRELATED-OPAQUE-VALUE';
  assert.equal(
    validate(workflowReferenceOnly).valid,
    true,
    'ticketCodeRef/workflow reference is not ticket identity'
  );

  const reportConflict = rawReport(set.booking);
  reportConflict.ticketInfo.referenceLog = JSON.stringify({
    ...JSON.parse(reportConflict.ticketInfo.referenceLog),
    UniqueTransID: 'CONTRADICTORY',
  });
  const conflictedEvidence = adapter.adaptTriploverTicketReportEvidenceV2({
    supplier: supplierAccount,
    receipt: RECEIPT,
    requestedUniqueTransId: set.booking.supplier_refs.uniqueTransId,
    requestedStatus: 'Confirmed',
    raw: reportConflict,
  });
  assert.deepEqual(
    Array.from(conflictedEvidence.bookingIdentity.identityConflicts),
    ['transaction_id_conflict']
  );
}

const firstTrip = evidenceSet('firsttrip');
const takeOff = evidenceSet('takeoff');
const crossSupplier = validator.validateCanonicalSupplierEvidenceV2({
  purpose: 'ticketed',
  expected: firstTrip.expected,
  pnr: takeOff.pnr,
  ticketReport: takeOff.ticketReport,
  now: NOW,
});
assert.equal(crossSupplier.valid, false);
assert.ok(codes(crossSupplier).has('supplier_account_mismatch'));

const stale = structuredClone(firstTrip);
stale.pnr.observedAt = '2026-08-27T05:00:00.000Z';
stale.pnr.receipt.requestStartedAt = '2026-08-27T04:59:59.000Z';
stale.pnr.receipt.responseReceivedAt = stale.pnr.observedAt;
stale.pnr.freshUntil = '2026-08-27T05:05:00.000Z';
assert.ok(codes(validate(stale)).has('evidence_stale'));

const explicitOffset = adapter.adaptTriploverTicketReportEvidenceV2({
  supplier: 'takeoff',
  receipt: RECEIPT,
  requestedUniqueTransId: takeOff.booking.supplier_refs.uniqueTransId,
  requestedStatus: 'Confirmed',
  raw: (() => {
    const value = rawReport(takeOff.booking);
    value.ticketInfo.issueDate = '2026-08-27T06:02:16Z';
    return value;
  })(),
});
assert.equal(explicitOffset.lifecycle.issuedAt, '2026-08-27T06:02:16.000Z');

class MockTriploverError extends Error {}
const evidenceRead = loadTs('lib/booking-lifecycle/supplier-evidence-read.ts', {
  '@/lib/booking-lifecycle/canonical-supplier-evidence-v2': canonical,
  '@/lib/booking-lifecycle/canonical-supplier-evidence-validation-v2': validator,
  '@/lib/booking-lifecycle/reconciliation-decisions': {
    classifyTicketingReconciliation: () => ({}),
    classifyCancellationReconciliation: () => ({}),
    classifyLegacyReconciliation: () => ({}),
  },
  '@/lib/booking-lifecycle/reconciliation-confirmation-boundary': {
    assessReconciliationConfirmationBoundary: () => ({}),
  },
  '@/lib/triplover/air-ticketing-details': { readAirTicketingDetails: async () => ({}) },
  '@/lib/triplover/client': { TriploverError: MockTriploverError },
  '@/lib/triplover/config': {
    isTriploverSupplier: (value) =>
      value === 'firsttrip' || value === 'takeoff' || value === 'triplover',
  },
  '@/lib/triplover/pnr': {
    pnrLookupLocators: () => null,
    readPnr: async () => ({}),
  },
});
const identityInput = {
  clientRequestNonce: 'request-1',
  bookingId: 'booking-1',
  caseId: 'case-1',
  purpose: 'ticketed',
  airTicketingStatus: 'Confirmed',
};
const identityA = evidenceRead.supplierEvidenceReadIdentity(identityInput);
const identityB = evidenceRead.supplierEvidenceReadIdentity({ ...identityInput });
const identityC = evidenceRead.supplierEvidenceReadIdentity({
  ...identityInput,
  clientRequestNonce: 'request-2',
});
assert.deepEqual(identityA, identityB, 'exact retries reuse the same V2 identity');
assert.notEqual(identityA.observationKey, identityC.observationKey);
assert.match(identityA.observationKey, /^evidence-read:v2:[a-f0-9]{64}$/);
assert.match(identityA.lockName, /^booking-evidence-v2:[a-f0-9]{64}$/);

console.log(JSON.stringify({
  checks: 'passed',
  suppliers: ['firsttrip', 'takeoff', 'triplover'],
  canonicalContract: 2,
  scenarios: {
    passengerIdentityAndMultiplicity: true,
    orderedMultiSegmentIdentity: true,
    marketingOperatingCarrierAndCodeshareFailClosed: true,
    authoritativeTicketDocuments: true,
    typedPnrAndReferenceIdentity: true,
    supplierFinancialEvidence: true,
    rawAndNormalizedTimestamps: true,
    contradictionsAndMalformedEvidenceRejected: true,
    genuineMismatchesRejected: true,
    replayIdentityDeterministic: true,
  },
}, null, 2));
