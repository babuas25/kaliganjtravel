import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

class SupplierWriteBoundaryError extends Error {
  constructor(phase, code = 'BOUNDARY_FAILED') {
    super(code);
    this.phase = phase;
    this.code = code;
  }
}

class TriploverError extends Error {
  constructor(kind, message, status = null) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}
class ShapontravelsWriteError extends Error {
  constructor(kind, code, status = null) {
    super(code); this.kind = kind; this.status = status;
  }
}

const sourcePath = path.join(
  process.cwd(),
  'lib',
  'booking-lifecycle',
  'supplier-uncertainty.ts'
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
    if (specifier.endsWith('/supplier-write-hooks')) {
      return { SupplierWriteBoundaryError };
    }
    if (specifier.endsWith('/triplover/client')) return { TriploverError };
    if (specifier.endsWith('/shapontravels/client')) return { ShapontravelsWriteError };
    return require(specifier);
  },
});
const { classifySupplierWriteFailure } = module.exports;

const before = {
  supplierCallStarted: false,
  supplierResponseObserved: false,
  supplierResponseRecorded: false,
  httpStatus: null,
};
const started = { ...before, supplierCallStarted: true };
const response200 = {
  ...started,
  supplierResponseObserved: true,
  supplierResponseRecorded: true,
  httpStatus: 200,
};

const cases = [
  [new SupplierWriteBoundaryError('before-request'), before, 'not-sent', 'local_start_boundary_failed'],
  [new SupplierWriteBoundaryError('response-received'), { ...response200, supplierResponseRecorded: false }, 'uncertain', 'local_response_boundary_failed'],
  [new TriploverError('unconfigured', 'missing config'), before, 'not-sent', 'prewrite_configuration_failure'],
  [new TriploverError('auth', 'login failed'), before, 'not-sent', 'prewrite_authentication_failure'],
  [new TriploverError('network', 'login unreachable'), before, 'not-sent', 'prewrite_network_failure'],
  [new TriploverError('network', 'write timed out'), started, 'uncertain', 'network_after_write'],
  [new TriploverError('protocol', 'returned an incomplete ticket response'), response200, 'uncertain', 'incomplete_response'],
  [new TriploverError('protocol', 'returned non-JSON'), response200, 'uncertain', 'protocol_response'],
  [new TriploverError('supplier', 'upstream failed', 503), { ...response200, httpStatus: 503 }, 'uncertain', 'supplier_upstream_failure'],
  [new TriploverError('supplier', 'business error', 200), response200, 'uncertain', 'supplier_http_200_failure'],
  [new TriploverError('supplier', 'Unable to Satisfy, Need Confirmed Flight Status.', 200), response200, 'uncertain', 'supplier_http_200_failure'],
  [new TriploverError('supplier', 'Duplicate booking for Passenger: Mr TEST USER', 200), response200, 'definitive-failure', 'supplier_duplicate_booking'],
  [new TriploverError('supplier', 'declined', 400), { ...response200, httpStatus: 400 }, 'definitive-failure', 'supplier_rejected'],
  [new TriploverError('supplier', 'isCancel false'), response200, 'definitive-failure', 'supplier_rejected'],
  [new ShapontravelsWriteError('pending', 'BOOKING_OUTCOME_UNKNOWN', 202),
    { ...response200, httpStatus: 202 }, 'uncertain', 'incomplete_response'],
  [new ShapontravelsWriteError('network', 'BOOK_NETWORK'), started,
    'uncertain', 'network_after_write'],
  [new ShapontravelsWriteError('supplier', 'INVALID_FARE', 422),
    { ...response200, httpStatus: 422 }, 'definitive-failure', 'supplier_rejected'],
  [new TriploverError('auth', 'expired token', 401), { ...response200, httpStatus: 401 }, 'definitive-failure', 'supplier_auth_rejected'],
  [new Error('unexpected mapper failure'), response200, 'uncertain', 'unexpected_after_write'],
];

for (const [error, boundary, failureClass, reasonCode] of cases) {
  const classified = classifySupplierWriteFailure(error, boundary);
  assert.equal(classified.failureClass, failureClass);
  assert.equal(classified.reasonCode, reasonCode);
  assert.equal(
    classified.fundsMustRemainProtected,
    failureClass === 'uncertain'
  );
  assert.equal(classified.automaticReplayAllowed, false);
}

const bookingRoute = fs.readFileSync(
  path.join(process.cwd(), 'app', 'api', 'flights', 'booking', 'route.ts'),
  'utf8'
);
const bookingStatusRoute = fs.readFileSync(
  path.join(process.cwd(), 'app', 'api', 'flights', 'booking', 'status', 'route.ts'),
  'utf8'
);
for (const route of [bookingRoute, bookingStatusRoute]) {
  assert.match(route, /SUPPLIER_DUPLICATE_BOOKING/);
  assert.match(
    route,
    /The airline rejected this booking because the same passenger already has a booking for this flight\./
  );
}

for (const routePath of [
  ['app', 'api', 'flights', 'booking', 'route.ts'],
  ['app', 'api', 'flights', 'booking', 'issue', 'route.ts'],
  ['app', 'api', 'flights', 'booking', 'cancel', 'route.ts'],
]) {
  const route = fs.readFileSync(path.join(process.cwd(), ...routePath), 'utf8');
  assert.match(route, /classifySupplierWriteFailure\(/);
  assert.match(route, /supplierLifecycle\.boundarySnapshot\(\)/);
  assert.doesNotMatch(route, /function outcomeIsUnknown\(/);
  assert.doesNotMatch(
    route,
    /error\.kind === '(?:network|protocol)'|error\.status >= 500/
  );
}

const hooks = fs.readFileSync(
  path.join(
    process.cwd(),
    'lib',
    'booking-lifecycle',
    'supplier-write-hooks.ts'
  ),
  'utf8'
);
assert.match(hooks, /supplierCallStarted = true/);
assert.match(hooks, /supplierResponseObserved = true/);
assert.match(hooks, /supplierResponseRecorded = true/);
assert.ok(
  hooks.indexOf('supplierResponseObserved = true') <
    hooks.indexOf('markBookingOperationSupplierResponseReceived('),
  'A locally lost response-boundary write must still know the supplier response arrived'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      classifications: cases.length,
      supplierWrites: ['Book', 'NewTicket', 'Cancel'],
      http200SupplierFailure: 'uncertain_except_validated_duplicate',
      duplicateBookingRejection: 'definitive-failure',
      incompleteResponse: 'uncertain',
      prewriteFailure: 'not-sent',
      automaticReplayAllowed: false,
    },
    null,
    2
  )
);
