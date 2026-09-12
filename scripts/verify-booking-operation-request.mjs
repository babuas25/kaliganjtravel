import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const sourcePath = path.join(
  process.cwd(),
  'lib',
  'booking-lifecycle',
  'operation-request.ts'
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
  0,
  'Operation request identity module must transpile'
);
const operationModule = { exports: {} };
new vm.Script(transpiled.outputText, { filename: sourcePath }).runInNewContext({
  module: operationModule,
  exports: operationModule.exports,
  require(specifier) {
    if (specifier === 'server-only') return {};
    return require(specifier);
  },
});
const { createOperationRequestIdentity } = operationModule.exports;

const base = {
  clientRequestNonce: '11111111-1111-4111-8111-111111111111',
  action: 'ticketing',
  subjectType: 'booking',
  subjectId: '22222222-2222-4222-8222-222222222222',
  payload: {
    pnr: 'ABC123',
    refs: { priceCodeRef: 'price', itemCodeRef: 'item' },
  },
};
const first = createOperationRequestIdentity(base);
const reordered = createOperationRequestIdentity({
  ...base,
  payload: {
    refs: { itemCodeRef: 'item', priceCodeRef: 'price' },
    pnr: 'ABC123',
  },
});
const changed = createOperationRequestIdentity({
  ...base,
  payload: { ...base.payload, pnr: 'CHANGED' },
});
const newNonce = createOperationRequestIdentity({
  ...base,
  clientRequestNonce: '33333333-3333-4333-8333-333333333333',
});

assert.match(first.requestKey, /^operation:v1:[a-f0-9]{64}$/);
assert.match(first.requestPayloadHash, /^[a-f0-9]{64}$/);
assert.deepEqual(first, reordered, 'Canonical object order changed request identity');
assert.equal(
  first.requestKey,
  changed.requestKey,
  'The retry nonce, not client payload, must control request identity'
);
assert.notEqual(
  first.requestPayloadHash,
  changed.requestPayloadHash,
  'Changed payload must be detectable under the same request key'
);
assert.notEqual(first.requestKey, newNonce.requestKey);
assert.throws(
  () => createOperationRequestIdentity({ ...base, clientRequestNonce: ' ' }),
  /nonce is required/
);

for (const routePath of [
  ['app', 'api', 'flights', 'booking', 'issue', 'route.ts'],
  ['app', 'api', 'flights', 'booking', 'cancel', 'route.ts'],
  ['app', 'api', 'flights', 'booking', 'route.ts'],
]) {
  const route = fs.readFileSync(path.join(process.cwd(), ...routePath), 'utf8');
  assert.match(route, /createOperationRequestIdentity\(/);
}
for (const routePath of [
  ['app', 'api', 'flights', 'booking', 'issue', 'route.ts'],
  ['app', 'api', 'flights', 'booking', 'cancel', 'route.ts'],
]) {
  const route = fs.readFileSync(path.join(process.cwd(), ...routePath), 'utf8');
  assert.doesNotMatch(
    route,
    /(?:beginBookingIssue|beginLegacyManualIssue|beginBookingCancellation|captureBookingReservation|failBookingIssue|finalizeBookingCancellation)\([^;]*parsed\.data\.requestId/s,
    'A destructive workflow still passes the raw client nonce to the database'
  );
}

const clientPath = path.join(process.cwd(), 'lib', 'triplover', 'client.ts');
const client = fs.readFileSync(clientPath, 'utf8');
const tokenAcquiredAt = client.indexOf('let token = await acquireToken()');
const firstAttemptAt = client.indexOf('let response = await timedAttempt(token)');
const beforeRequestAt = client.indexOf(
  'await options.lifecycleHooks?.beforeRequest()'
);
const destructiveRequestAt = client.search(
  /const result = await attempt\(token(?:, attemptNumber)?\)/
);
const responseReceivedAt = client.indexOf(
  'await options.lifecycleHooks?.onResponse('
);
const responseInterpretationAt = client.indexOf('let envelope = readEnvelope(response.body)');

assert.ok(tokenAcquiredAt >= 0, 'Triplover call must acquire auth before its attempt');
assert.ok(firstAttemptAt >= 0, 'Triplover call must make its initial supplier attempt');
assert.ok(
  tokenAcquiredAt < firstAttemptAt,
  'Triplover call must acquire auth before its initial supplier attempt'
);
assert.ok(beforeRequestAt >= 0, 'Supplier start hook is missing');
assert.ok(destructiveRequestAt >= 0, 'Supplier HTTP attempt is missing');
assert.ok(responseReceivedAt >= 0, 'Supplier response hook is missing');
assert.ok(responseInterpretationAt >= 0, 'Supplier response interpretation is missing');
assert.ok(
  beforeRequestAt < destructiveRequestAt,
  'Supplier start must be persisted immediately before the destructive HTTP call'
);
assert.ok(
  destructiveRequestAt < responseReceivedAt,
  'Supplier response cannot be persisted before the HTTP call'
);
assert.ok(
  responseReceivedAt < responseInterpretationAt,
  'Complete supplier response receipt must be persisted before interpretation'
);

for (const adapterPath of [
  ['lib', 'triplover', 'book.ts'],
  ['lib', 'triplover', 'ticket.ts'],
  ['lib', 'triplover', 'cancel.ts'],
]) {
  const adapter = fs.readFileSync(path.join(process.cwd(), ...adapterPath), 'utf8');
  assert.match(adapter, /SupplierWriteLifecycleHooks/);
  assert.match(adapter, /lifecycleHooks/);
}

for (const [routePath, hookFactory] of [
  [
    ['app', 'api', 'flights', 'booking', 'route.ts'],
    'bookingAttemptSupplierWriteHooks',
  ],
  [
    ['app', 'api', 'flights', 'booking', 'issue', 'route.ts'],
    'bookingOperationSupplierWriteHooks',
  ],
  [
    ['app', 'api', 'flights', 'booking', 'cancel', 'route.ts'],
    'bookingOperationSupplierWriteHooks',
  ],
]) {
  const route = fs.readFileSync(path.join(process.cwd(), ...routePath), 'utf8');
  assert.match(route, new RegExp(`${hookFactory}\\(`));
  assert.match(route, /supplierLifecycle/);
}

const walletDb = fs.readFileSync(
  path.join(process.cwd(), 'lib', 'db', 'wallet.ts'),
  'utf8'
);
for (const rpc of [
  'wallet_capture_reservation_v2',
  'wallet_finalize_manual_issue_v2',
  'wallet_fail_booking_issue_v2',
  'wallet_finalize_booking_cancel_v2',
]) {
  assert.match(
    walletDb,
    new RegExp(`wallet(?:Finalization)?Rpc\\('${rpc}'`)
  );
}
assert.match(walletDb, /first\.code === 'STORAGE_ERROR'/);
const bookingDb = fs.readFileSync(
  path.join(process.cwd(), 'lib', 'db', 'flight-bookings.ts'),
  'utf8'
);
assert.match(bookingDb, /create_booking_from_attempt_v2/);
assert.match(bookingDb, /resolve_booking_cancellation_refusal_v2/);

const operationMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0045_booking_operation_claims.sql'
  ),
  'utf8'
);
for (const finalizer of [
  'wallet_capture_reservation_v2',
  'wallet_finalize_manual_issue_v2',
  'wallet_fail_booking_issue_v2',
  'wallet_finalize_booking_cancel_v2',
  'resolve_booking_cancellation_refusal_v2',
  'create_booking_from_attempt_v2',
]) {
  assert.match(
    operationMigration,
    new RegExp(`create or replace function public\\.${finalizer}\\(`)
  );
}
assert.match(
  operationMigration,
  /if v_operation\.supplier_response_received_at is null then[\s\S]*?'SUPPLIER_RESPONSE_NOT_RECORDED'/
);
assert.match(
  operationMigration,
  /create or replace function public\.mark_booking_operation_finalization_reconciliation\(/
);
assert.match(operationMigration, /now\(\) \+ interval '30 minutes'/);
assert.match(
  operationMigration,
  /create or replace function public\.process_booking_operation_watchdog\(/
);
assert.match(operationMigration, /now\(\) - interval '3 minutes'/);
assert.match(operationMigration, /for update skip locked/);
assert.match(operationMigration, /automaticSupplierReplay', false/);
assert.match(operationMigration, /booking_operations_claim_watchdog_idx/);
const watchdogStart = operationMigration.indexOf(
  'create or replace function public.process_booking_operation_watchdog('
);
const watchdogEnd = operationMigration.indexOf(
  'revoke all on function public.process_booking_operation_watchdog',
  watchdogStart
);
const watchdogFunction = operationMigration.slice(watchdogStart, watchdogEnd);
assert.doesNotMatch(watchdogFunction, /net\.http|triploverCall|issueTicket|cancelBooking|bookFlight/);

const watchdogDb = fs.readFileSync(
  path.join(process.cwd(), 'lib', 'db', 'booking-operations.ts'),
  'utf8'
);
assert.match(watchdogDb, /processBookingOperationWatchdog/);
assert.match(watchdogDb, /process_booking_operation_watchdog/);
const schedulerRoute = fs.readFileSync(
  path.join(
    process.cwd(),
    'app',
    'api',
    'cron',
    'booking-status-emails',
    'route.ts'
  ),
  'utf8'
);
assert.match(
  schedulerRoute,
  /const operationWatchdog = rollout\.operationWorkers[\s\S]*?\? await runStep\(5_000,[\s\S]*?processBookingOperationWatchdog\(100\)[\s\S]*?: rolloutDisabled\(\)/
);
assert.match(
  schedulerRoute,
  /const attemptWatchdog = rollout\.operationWorkers[\s\S]*?\? await runStep\(5_000,[\s\S]*?processBookingAttemptWatchdog\(100\)[\s\S]*?: rolloutDisabled\(\)/
);

const attemptDb = fs.readFileSync(
  path.join(process.cwd(), 'lib', 'db', 'booking-attempts.ts'),
  'utf8'
);
assert.match(
  attemptDb,
  /state: 'submitting',[\s\S]*operation_request_key: operationRequest\.requestKey,[\s\S]*operation_request_payload_hash: operationRequest\.requestPayloadHash/
);
const bookRoute = fs.readFileSync(
  path.join(process.cwd(), 'app', 'api', 'flights', 'booking', 'route.ts'),
  'utf8'
);
assert.ok(
  bookRoute.indexOf('const bookingOperationRequest =') <
    bookRoute.indexOf('const claim = await claimBookingAttempt('),
  'Book operation identity must be derived before the atomic attempt claim'
);
assert.match(
  operationMigration,
  /create or replace function public\.process_booking_attempt_watchdog\(/
);
assert.match(operationMigration, /historicalNullIdentityExcluded', true/);
assert.match(operationMigration, /now\(\) \+ interval '15 minutes'/);
assert.match(operationMigration, /booking_attempts_reconciliation_watchdog_idx/);
const attemptWatchdogStart = operationMigration.indexOf(
  'create or replace function public.process_booking_attempt_watchdog('
);
const attemptWatchdogEnd = operationMigration.indexOf(
  'revoke all on function public.process_booking_attempt_watchdog',
  attemptWatchdogStart
);
const attemptWatchdogFunction = operationMigration.slice(
  attemptWatchdogStart,
  attemptWatchdogEnd
);
assert.match(attemptWatchdogFunction, /operation_request_key is not null/);
assert.match(attemptWatchdogFunction, /for update skip locked/);
assert.doesNotMatch(
  attemptWatchdogFunction,
  /net\.http|triploverCall|issueTicket|cancelBooking|bookFlight/
);

const bookingStatusSource = fs.readFileSync(
  path.join(process.cwd(), 'lib', 'flights', 'booking-status.ts'),
  'utf8'
);
const publicStatusList = bookingStatusSource.match(
  /export const BOOKING_STATUSES = \[([\s\S]*?)\] as const;/
);
assert.ok(publicStatusList, 'The public booking-status allowlist is missing');
assert.deepEqual(
  [...publicStatusList[1].matchAll(/'([^']+)'/g)].map((match) => match[1]),
  [
    'on-hold',
    'pending',
    'in-progress',
    'confirmed',
    'expired',
    'unconfirmed',
    'cancelled',
  ],
  'The public booking-status model must remain the approved seven values'
);

const publicBookingTypes = fs.readFileSync(
  path.join(process.cwd(), 'lib', 'flights', 'booking.ts'),
  'utf8'
);
const publicAttemptTypeStart = publicBookingTypes.indexOf(
  'export type PublicBookingAttempt ='
);
const publicAttemptTypeEnd = publicBookingTypes.indexOf(
  'export type PublicBooking =',
  publicAttemptTypeStart
);
assert.ok(publicAttemptTypeStart >= 0 && publicAttemptTypeEnd > publicAttemptTypeStart);
const publicAttemptType = publicBookingTypes.slice(
  publicAttemptTypeStart,
  publicAttemptTypeEnd
);
assert.doesNotMatch(
  publicAttemptType,
  /\b(?:state|status)\s*:/,
  'PublicBookingAttempt must not expose an internal attempt state or public booking status'
);

const publicAttemptSerializerStart = attemptDb.indexOf(
  'export async function publicBookingAttempt('
);
const publicAttemptSerializerEnd = attemptDb.indexOf(
  'export async function createBookingAttempt(',
  publicAttemptSerializerStart
);
assert.ok(
  publicAttemptSerializerStart >= 0 &&
    publicAttemptSerializerEnd > publicAttemptSerializerStart
);
const publicAttemptSerializer = attemptDb.slice(
  publicAttemptSerializerStart,
  publicAttemptSerializerEnd
);
assert.doesNotMatch(
  publicAttemptSerializer,
  /\b(?:state|status)\s*:/,
  'The public attempt serializer must not expose internal lifecycle state'
);

const bookingStatusRoute = fs.readFileSync(
  path.join(
    process.cwd(),
    'app',
    'api',
    'flights',
    'booking',
    'status',
    'route.ts'
  ),
  'utf8'
);
for (const phase of ['booking-created', 'processing', 'ready']) {
  assert.match(bookingStatusRoute, new RegExp(`phase: '${phase}'`));
}
assert.doesNotMatch(
  bookingStatusRoute,
  /\bsuccess:\s*true,\s*state\s*:/,
  'Attempt polling must use a neutral phase rather than expose attempt state'
);
assert.doesNotMatch(
  attemptWatchdogFunction,
  /insert\s+into\s+public\.(?:flight_bookings|booking_lifecycle_events)/i,
  'Attempt reconciliation must not manufacture a public booking or status event'
);
assert.doesNotMatch(
  schedulerRoute,
  /attemptWatchdog\.(?:rows|attempts|items)/,
  'The scheduler response must expose only aggregate attempt-watchdog health'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      serverDerivedKey: true,
      canonicalPayload: true,
      changedPayloadSameKey: true,
      changedPayloadDifferentHash: true,
      supplierWriteRoutes: ['Book', 'NewTicket', 'Cancel'],
      supplierStartAfterAuthentication: true,
      supplierResponseBeforeInterpretation: true,
      responseRequiredBeforeFinalization: true,
      atomicOperationFinalizers: true,
      ownedLocalFinalizationFailure: true,
      threeMinuteOperationWatchdog: true,
      boundedSkipLockedWatchdog: true,
      watchdogSupplierReplay: false,
      attemptIdentityClaimedAtomically: true,
      attemptWatchdogHistoricalIsolation: true,
      attemptWatchdogSupplierReplay: false,
      publicBookingStatuses: 7,
      attemptStatesPublic: false,
      attemptPollingUsesNeutralPhase: true,
      attemptWatchdogCreatesPublicStatus: false,
    },
    null,
    2
  )
);
