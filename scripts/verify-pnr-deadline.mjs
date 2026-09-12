import { airlinePnrModule } from './helpers/airline-pnr.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const configSourcePath = path.join(process.cwd(), 'lib', 'triplover', 'config.ts');
const configSource = fs.readFileSync(configSourcePath, 'utf8');
const configTranspiled = ts.transpileModule(configSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: configSourcePath,
  reportDiagnostics: true,
});
const configErrors = (configTranspiled.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
);
assert.equal(configErrors.length, 0, 'Triplover config must transpile');

const configEnv = {
  FIRSTTRIP_BASE_URL: 'https://firsttrip-userapi.example.test',
  FIRSTTRIP_SEARCH_BASE_URL: 'https://firsttrip-searchapi.example.test',
  FIRSTTRIP_EMAIL: 'firsttrip@example.test',
  FIRSTTRIP_PASSWORD: 'firsttrip-password',
  TAKEOFF_BASE_URL: 'https://takeoff-userapi.example.test',
  TAKEOFF_SEARCH_BASE_URL: 'https://takeoff-searchapi.example.test',
  TAKEOFF_EMAIL: 'takeoff@example.test',
  TAKEOFF_PASSWORD: 'takeoff-password',
  TRIPLOVER_BASE_URL: 'https://triplover-userapi.example.test',
  TRIPLOVER_SEARCH_BASE_URL: 'https://triplover-searchapi.example.test',
  TRIPLOVER_EMAIL: 'triplover@example.test',
  TRIPLOVER_PASSWORD: 'triplover-password',
};
const configModule = { exports: {} };
const configContext = vm.createContext({
  module: configModule,
  exports: configModule.exports,
  require(specifier) {
    if (specifier === '@/lib/flights/airline-pnr') return airlinePnrModule;
    if (specifier === 'server-only') return {};
    throw new Error(`Unexpected config runtime import: ${specifier}`);
  },
  process: { env: configEnv },
});
new vm.Script(configTranspiled.outputText, { filename: configSourcePath }).runInContext(
  configContext
);
const { triploverConfig } = configModule.exports;

assert.equal(triploverConfig('firsttrip').email, 'firsttrip@example.test');
assert.equal(
  triploverConfig('firsttrip').searchBaseUrl,
  'https://firsttrip-searchapi.example.test'
);
assert.equal(triploverConfig('takeoff').email, 'takeoff@example.test');
assert.equal(
  triploverConfig('takeoff').baseUrl,
  'https://takeoff-userapi.example.test'
);
assert.equal(triploverConfig('triplover').email, 'triplover@example.test');
assert.equal(
  triploverConfig('triplover').searchBaseUrl,
  'https://triplover-searchapi.example.test'
);

const sourcePath = path.join(process.cwd(), 'lib', 'triplover', 'pnr.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const clientSource = fs.readFileSync(
  path.join(process.cwd(), 'lib', 'triplover', 'client.ts'),
  'utf8'
);
assert.match(
  clientSource,
  /function uniqueTransactionReferences\(values: EnvelopeMeta\[\]\): string\[\][\s\S]*?for \(const value of values\)/,
  'Triplover transport must retain all supplier envelope transaction echoes'
);
assert.match(
  clientSource,
  /const UNIQUE_TRANSACTION_REFERENCE_KEYS = \[[\s\S]*?'uniqueTransID',[\s\S]*?'uniqueTransId',[\s\S]*?'UniqueTransID',[\s\S]*?'UniqueTransId'/,
  'Every documented supplier transaction-ID casing must be considered within one envelope meta'
);
assert.match(
  clientSource,
  /for \(const reference of uniqueTransactionReferencesFromValue\(value\)\)/,
  'Each envelope meta must contribute all of its supplier-returned transaction echoes'
);
assert.match(
  clientSource,
  /const uniqueTransIds = uniqueTransactionReferences\(envelope\.metas\);[\s\S]*?uniqueTransId: uniqueTransIds\[0\] \?\? null,[\s\S]*?uniqueTransIds,/,
  'The legacy first echo and complete echo set must derive from the same supplier envelope metadata'
);
assert.match(source, /call\.uniqueTransIds/);
const echoHelperSource = source.slice(
  source.indexOf('function supplierPnrUniqueTransIdEchoes'),
  source.indexOf('\ntype DeadlineParts')
);
assert.ok(
  !echoHelperSource.includes('input.uniqueTransId'),
  'PNR echoed transaction evidence must never use the request identifier'
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: sourcePath,
  reportDiagnostics: true,
});
const errors = (transpiled.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
);
assert.equal(errors.length, 0, 'PNR parser must transpile');

const timeSourcePath = path.join(process.cwd(), 'lib', 'triplover', 'time.ts');
const timeModule = { exports: {} };
const timeTranspiled = ts.transpileModule(
  fs.readFileSync(timeSourcePath, 'utf8'),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: timeSourcePath,
    reportDiagnostics: true,
  }
);
new vm.Script(timeTranspiled.outputText, { filename: timeSourcePath }).runInNewContext({
  module: timeModule,
  exports: timeModule.exports,
});

class TriploverError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const module = { exports: {} };
let pnrCallResult = {
  data: {
    pnr: '0A7XZ4',
    airlinePNRs: ['0A7XZ4'],
    status: 'Ticketed',
    lastTicketTime: '08/18/2026 17:36:50',
    uniqueTransID: 'TOT639226280009339818',
  },
  // These come from all PNR response-envelope metadata objects. The second
  // value deliberately differs so the adapter must preserve every supplier
  // echo rather than silently choosing the first or using request input.
  uniqueTransId: 'TOT639226280009339818',
  uniqueTransIds: [
    'TOT639226280009339818',
    'TOT639226280009339818:SECOND_ECHO',
  ],
  receipt: {
    requestStartedAt: '2026-08-18T13:40:00.000Z',
    responseReceivedAt: '2026-08-18T13:40:01.000Z',
    httpStatus: 200,
    rawPayloadHash: 'a'.repeat(64),
  },
};
const context = vm.createContext({
  module,
  exports: module.exports,
  require(specifier) {
    if (specifier === '@/lib/flights/airline-pnr') return airlinePnrModule;
    if (specifier === 'server-only') return {};
    if (specifier === '@/lib/triplover/client') {
      return { TriploverError, triploverCall: async () => pnrCallResult };
    }
    if (specifier === '@/lib/booking-lifecycle/supplier-evidence') {
      return { normalizedPnrEvidence: (value) => value };
    }
    if (specifier === '@/lib/triplover/canonical-evidence-v2') {
      return { adaptTriploverPnrEvidenceV2: (value) => value };
    }
    if (specifier === '@/lib/triplover/time') return timeModule.exports;
    throw new Error(`Unexpected runtime import: ${specifier}`);
  },
  Date,
});
new vm.Script(transpiled.outputText, { filename: sourcePath }).runInContext(context);

const { normalizePnrLastTicketTime, pnrLookupLocators, readPnr } = module.exports;

const distinctLocators = pnrLookupLocators({
  pnr: 'HTGQCP',
  bookingRefNumber: 'A78ZIM',
});
assert.equal(distinctLocators?.pnr, 'HTGQCP');
assert.equal(distinctLocators?.bookingRefNumber, 'A78ZIM');
assert.equal(
  pnrLookupLocators({ pnr: ' 0A8494 ', bookingRefNumber: null })?.pnr,
  '0A8494'
);

const echoedPnr = await readPnr({
  supplier: 'takeoff',
  pnr: '0A7XZ4',
  bookingRefNumber: '0A7XZ4',
  bookingCodeRef: 'booking-code',
  uniqueTransId: 'REQUEST_VALUE_MUST_NOT_BE_USED',
  priceCodeRef: 'price-code',
  itemCodeRef: 'item-code',
});
assert.deepEqual(
  Array.from(echoedPnr.supplierEchoedUniqueTransIds),
  ['TOT639226280009339818', 'TOT639226280009339818:SECOND_ECHO'],
  'PNR evidence must retain only the exact supplier payload/envelope echoes'
);
assert.deepEqual(
  Array.from(echoedPnr.evidence.facts.supplierEchoedUniqueTransIds),
  ['TOT639226280009339818', 'TOT639226280009339818:SECOND_ECHO']
);

pnrCallResult = {
  ...pnrCallResult,
  data: {
    ...pnrCallResult.data,
    uniqueTransID: null,
  },
  uniqueTransId: null,
  uniqueTransIds: [],
};
const pnrWithoutEcho = await readPnr({
  supplier: 'takeoff',
  pnr: '0A7XZ4',
  bookingRefNumber: '0A7XZ4',
  bookingCodeRef: 'booking-code',
  uniqueTransId: 'REQUEST_VALUE_MUST_NOT_BE_USED',
  priceCodeRef: 'price-code',
  itemCodeRef: 'item-code',
});
assert.deepEqual(
  Array.from(pnrWithoutEcho.supplierEchoedUniqueTransIds),
  [],
  'An absent supplier PNR echo must remain absent rather than being copied from the request'
);

assert.equal(
  normalizePnrLastTicketTime('07/08/2026 18:32:00', null, null, 'firsttrip'),
  '2026-08-07 18:32:00',
  'Triplover PNR deadlines must use DD/MM/YYYY'
);
assert.equal(
  normalizePnrLastTicketTime(
    '08/10/2026 17:56:00',
    '2026-08-10T09:55:59.727Z',
    'BS',
    'firsttrip'
  ),
  '2026-08-10 17:56:00',
  'US-Bangla PNR slash dates must use MM/DD/YYYY'
);
assert.equal(
  normalizePnrLastTicketTime(
    '11/08/2026 10:12:00',
    '2026-08-10T10:12:48.449Z',
    'BG',
    'firsttrip'
  ),
  '2026-08-11 10:12:00',
  'non-BS PNR slash dates must remain DD/MM/YYYY'
);
assert.equal(
  normalizePnrLastTicketTime(
    '08/07/2026 09:14:00',
    '2026-08-07T01:14:16.006Z',
    null,
    'firsttrip'
  ),
  '2026-08-07 09:14:00',
  'ambiguous PNR deadline must not predate the booking when the alternate order is valid'
);
assert.equal(
  normalizePnrLastTicketTime(
    '07/08/2026 18:32:00',
    '2026-08-06T18:32:00.316Z',
    null,
    'firsttrip'
  ),
  '2026-08-07 18:32:00',
  'DD/MM remains preferred when it is chronologically valid'
);
assert.equal(
  normalizePnrLastTicketTime('25/08/2026 09:05:07', null, null, 'firsttrip'),
  '2026-08-25 09:05:07',
  'unambiguous DD/MM/YYYY date failed'
);
assert.equal(normalizePnrLastTicketTime(null, null, null, 'firsttrip'), null);
assert.throws(
  () => normalizePnrLastTicketTime('31/02/2026 18:32:00', null, null, 'firsttrip'),
  /invalid lastTicketTime date/
);

// The same ambiguous non-BS value must be decided by the persisted supplier,
// not by numeric guessing: both 08 and 11 are valid as a day or a month.
assert.equal(
  normalizePnrLastTicketTime(
    '08/11/2026 10:12:00',
    '2026-08-07T10:12:48.449Z',
    'BG',
    'firsttrip'
  ),
  '2026-11-08 10:12:00',
  'FirstTrip non-BS PNR dates must remain DD/MM/YYYY'
);
assert.equal(
  normalizePnrLastTicketTime(
    '08/11/2026 10:12:00',
    '2026-08-07T10:12:48.449Z',
    'BG',
    'triplover'
  ),
  '2026-11-08 10:12:00',
  'Direct Triplover non-BS PNR dates must use the default DD/MM/YYYY contract'
);
assert.equal(
  normalizePnrLastTicketTime(
    '08/11/2026 10:12:00',
    '2026-08-07T10:12:48.449Z',
    'BG',
    'takeoff'
  ),
  '2026-08-11 10:12:00',
  'TakeOff non-BS PNR dates must use MM/DD/YYYY'
);
assert.equal(
  normalizePnrLastTicketTime(
    '08/10/2026 17:56:00',
    '2026-08-09T09:55:59.727Z',
    'BS',
    'takeoff'
  ),
  '2026-08-10 17:56:00',
  'TakeOff US-Bangla PNR dates must remain MM/DD/YYYY'
);
assert.equal(
  normalizePnrLastTicketTime(
    '08/16/2026 08:56:00',
    '2026-08-15T04:56:54.343Z',
    'BG',
    'takeoff'
  ),
  '2026-08-16 08:56:00',
  'TakeOff Biman deadline must normalize as MM/DD/YYYY'
);

const bookSource = fs.readFileSync(
  path.join(process.cwd(), 'lib', 'triplover', 'book.ts'),
  'utf8'
);
assert.doesNotMatch(
  bookSource,
  /readPnr\(/,
  'A post-write PNR read must not delay atomic booking finalization'
);
assert.match(
  bookSource,
  /ticketingTimeLimit:\s*raw\.ticketingTimeLimit \?\? null/,
  'The Book response deadline must be stored until a later PNR refresh replaces it'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      firsttrip: { default: 'DD/MM/YYYY', BS: 'MM/DD/YYYY' },
      takeoff: { default: 'MM/DD/YYYY', BS: 'MM/DD/YYYY' },
      triplover: { default: 'DD/MM/YYYY', BS: 'MM/DD/YYYY' },
      ambiguousFixture: '08/11/2026 10:12:00',
      distinctPnrAndBookingReferencePreserved: true,
      pnrEchoesAreSupplierOriginOnly: true,
      pnrEchoesPreserveExactValues: true,
      postWritePnrInCriticalPath: false,
    },
    null,
    2
  )
);
