import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const historicalMigration = read(
  'supabase',
  'migrations',
  '0046_booking_reconciliation_evidence_reads.sql'
);
assert.match(historicalMigration, /record_booking_reconciliation_evidence_read_v1/);
assert.match(historicalMigration, /evidence-read:v1/);

const migration = read(
  'supabase',
  'migrations',
  '0116_canonical_supplier_evidence_v2.sql'
);
for (const required of [
  'record_booking_reconciliation_evidence_read_v2',
  "p_actor_role not in ('staff_support', 'admin', 'superadmin', 'system')",
  "p_observation_key !~ '^evidence-read:v2:[a-f0-9]{64}$'",
  "p_normalized_facts->>'evidenceContract' <> 'canonical_supplier_evidence_v2'",
  "'staff_evidence'",
  "'supplier_read'",
  'on conflict (reconciliation_case_id, observation_key) do nothing',
  "raise exception 'canonical V2 evidence request payload mismatch'",
  'evidence_latest_at = case',
  'version = version + 1',
  "'statusMutation', false",
  "'walletMutation', false",
  "'destructiveSupplierCall', false",
]) {
  assert.ok(migration.includes(required), `V2 evidence migration omits ${required}`);
}
assert.match(
  migration,
  /revoke all on function public\.record_booking_reconciliation_evidence_read_v2\([\s\S]*?from public, anon, authenticated;/
);
assert.match(
  migration,
  /grant execute on function public\.record_booking_reconciliation_evidence_read_v2\([\s\S]*?to service_role;/
);

const recorder = migration.match(
  /create or replace function public\.record_booking_reconciliation_evidence_read_v2\([\s\S]*?\n\$\$;/i
)?.[0] ?? '';
assert.ok(recorder, 'V2 evidence recorder is missing');
for (const forbiddenMutation of [
  /update\s+public\.flight_bookings/i,
  /insert\s+into\s+public\.booking_status_events/i,
  /insert\s+into\s+public\.booking_notification_outbox/i,
  /(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\.wallet_/i,
  /wallet_(?:reserve|capture|release|refund|mark_reconciliation)\s*\(/i,
]) {
  assert.doesNotMatch(recorder, forbiddenMutation);
}

const route = read(
  'app',
  'api',
  'admin',
  'booking-lifecycle',
  '[reference]',
  'evidence',
  'route.ts'
);
for (const required of [
  'canAcquireBookingLifecycleEvidence',
  "'bookingEvidenceRead'",
  'readBookingReconciliationCase',
  'isOpenBookingReconciliationCaseState',
  'supplierEvidenceReadIdentity',
  'readStoredEvidenceReadObservation',
  'acquireSecurityLock',
  'recordSecurityAuditEvent',
  'acquireSupplierEvidence',
  'recordBookingReconciliationEvidenceRead',
]) {
  assert.ok(route.includes(required), `Evidence route omits ${required}`);
}
for (const forbidden of [
  'syncPnrDetails',
  'syncAirTicketingDetails',
  'dispatchBookingStatusEmails',
  'issueTicket',
  'cancelBooking',
  'walletCapture',
  'walletRelease',
  'walletRefund',
]) {
  assert.ok(!route.includes(forbidden), `Evidence route imports/calls ${forbidden}`);
}

const db = read('lib', 'db', 'booking-reconciliation-evidence.ts');
assert.match(db, /record_booking_reconciliation_evidence_read_v2/);
assert.match(db, /booking_reconciliation_observations/);
assert.match(db, /booking_reconciliation_cases/);
assert.doesNotMatch(db, /booking_status_events|notification_outbox|wallet_/);

const acquisition = read('lib', 'booking-lifecycle', 'supplier-evidence-read.ts');
assert.match(acquisition, /readPnr\(/);
assert.match(acquisition, /readAirTicketingDetails\(/);
assert.match(acquisition, /validateCanonicalSupplierEvidenceV2\(/);
assert.match(acquisition, /Promise\.all\(\[pnrRead, airRead\]\)/);
assert.match(acquisition, /version: 2/);
assert.match(acquisition, /evidenceContract: 'canonical_supplier_evidence_v2'/);
assert.match(acquisition, /ticketReport/);
assert.doesNotMatch(
  acquisition,
  /syncPnrDetails|syncAirTicketingDetails|dispatchBookingStatusEmails|wallet_/
);

const access = read('lib', 'dashboard', 'booking-lifecycle.ts');
assert.match(access, /'investigate_supplier_evidence'/);
assert.match(
  access,
  /staff_support:\s*\[[\s\S]*?'investigate_supplier_evidence'[\s\S]*?\]/
);
assert.match(access, /staff_account:\s*\['view', 'propose_financial_outcome'\]/);

const page = read(
  'app',
  '(dashboard)',
  'dashboard',
  'bookings',
  '[reference]',
  'page.tsx'
);
assert.match(page, /BookingEvidenceReader/);
assert.match(page, /canRefreshBookingSupplierDetails/);
assert.match(
  page,
  /allowSupplierRefresh=\{[\s\S]*?row\.supplier === 'triplover'[\s\S]*?canRefreshBookingSupplierDetails\(session\.role\)[\s\S]*?\}/,
  'Any ordinary supplier refresh shown on the booking page must remain staff-authorized'
);
const component = read(
  'components',
  'dashboard',
  'bookings',
  'BookingEvidenceReader.tsx'
);
assert.match(component, /cannot change booking status or\s+wallet money/);
assert.match(component, /Keep the same request identity/);

const sourcePath = path.join(
  process.cwd(),
  'lib',
  'booking-lifecycle',
  'supplier-evidence-read.ts'
);
const transpiled = ts.transpileModule(acquisition, {
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
  require(specifier) {
    if (specifier === 'server-only') return {};
    if (specifier === 'node:crypto') return crypto;
    if (specifier.endsWith('/canonical-supplier-evidence-v2')) {
      return { canonicalExpectedBookingV2: () => ({}) };
    }
    if (specifier.endsWith('/canonical-supplier-evidence-validation-v2')) {
      return { validateCanonicalSupplierEvidenceV2: () => ({}) };
    }
    if (specifier.endsWith('/reconciliation-decisions')) {
      return {
        classifyTicketingReconciliation: () => ({
          outcome: 'unresolved_conflicting',
          candidateOutcome: null,
          reasonCode: 'supplier_evidence_incomplete_or_stale',
          supplierTruthAuthoritative: false,
          explicitStaffConfirmationRequired: true,
          financialReviewRequired: false,
          automaticResolutionAllowed: false,
        }),
        classifyCancellationReconciliation: () => null,
        classifyLegacyReconciliation: () => null,
      };
    }
    if (specifier.endsWith('/reconciliation-confirmation-boundary')) {
      return {
        assessReconciliationConfirmationBoundary: () => ({
          explicitStaffConfirmationRequired: true,
          makerCheckerRequired: true,
          resolutionBlocked: true,
          nextStep: 'fresh_or_independent_evidence_required',
          requirements: ['confirm_incomplete_evidence_exception'],
          genericResolveAllowed: false,
          evidenceReadMayResolve: false,
          statusMutationAllowed: false,
          walletMutationAllowed: false,
        }),
      };
    }
    if (specifier.endsWith('/air-ticketing-details')) {
      return { readAirTicketingDetails: async () => null };
    }
    if (specifier.endsWith('/triplover/client')) {
      return { TriploverError: class TriploverError extends Error {} };
    }
    if (specifier.endsWith('/triplover/config')) {
      return { isTriploverSupplier: (value) => value === 'takeoff' || value === 'firsttrip' };
    }
    if (specifier.endsWith('/triplover/pnr')) {
      return { pnrLookupLocators: () => null, readPnr: async () => null };
    }
    throw new Error(`Unexpected runtime import: ${specifier}`);
  },
});

const {
  staffSupplierEvidenceReadResult,
  supplierEvidenceFactsHash,
  supplierEvidenceReadIdentity,
} = module.exports;
const identityInput = {
  clientRequestNonce: '4fc723b8-e9f8-4c8d-a46d-393cfafc20cf',
  bookingId: '81e08456-4568-4c63-a5aa-52ff27967c7c',
  caseId: '3ee084b5-891c-4074-b595-30d9eafebfe0',
  purpose: 'ticketed',
  airTicketingStatus: 'Confirmed',
};
const firstIdentity = supplierEvidenceReadIdentity(identityInput);
assert.deepEqual(firstIdentity, supplierEvidenceReadIdentity(identityInput));
assert.match(firstIdentity.observationKey, /^evidence-read:v2:[a-f0-9]{64}$/);
assert.match(firstIdentity.lockName, /^booking-evidence-v2:[a-f0-9]{64}$/);
assert.notEqual(
  firstIdentity.observationKey,
  supplierEvidenceReadIdentity({ ...identityInput, purpose: 'held' }).observationKey
);

const facts = {
  version: 2,
  evidenceContract: 'canonical_supplier_evidence_v2',
  action: 'supplier_evidence_read',
  bookingId: identityInput.bookingId,
  caseId: identityInput.caseId,
  caseType: 'ticketing_uncertainty',
  requestedPurpose: 'ticketed',
  requestedAirTicketingStatus: 'Confirmed',
  acquiredAt: '2026-08-11T10:00:00.000Z',
  evidenceObservedAt: null,
  recordedSources: [],
  sourceResults: [],
  localContext: {
    storedStatus: 'in-progress',
    paymentState: 'reconciliation',
    hasLocalTicketEvidence: false,
  },
  expectedIdentity: {},
  evidence: { pnr: null, ticketReport: null },
  validation: {
    contractVersion: 2,
    valid: false,
    complete: false,
    fresh: true,
    identityMatches: true,
    authoritativeFor: null,
    issues: [{ code: 'pnr_evidence_missing' }],
  },
  statusMutation: false,
  walletMutation: false,
  destructiveSupplierCall: false,
};
assert.equal(supplierEvidenceFactsHash(facts).length, 64);
assert.equal(
  supplierEvidenceFactsHash(facts),
  supplierEvidenceFactsHash({ walletMutation: false, ...facts })
);
const staffResult = staffSupplierEvidenceReadResult(facts);
assert.equal(staffResult.statusMutation, false);
assert.equal(staffResult.walletMutation, false);
assert.deepEqual(staffResult.validation.issueCodes, ['pnr_evidence_missing']);
assert.equal(staffResult.confirmationBoundary.resolutionBlocked, true);
assert.ok(!('evidence' in staffResult));
assert.ok(!('expectedIdentity' in staffResult));

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      activeEvidenceContract: 'canonical_supplier_evidence_v2',
      permittedRoles: ['superadmin', 'admin', 'staff_support'],
      idempotency: 'payload-bound V2 observation key plus cross-instance lease',
      supplierWrites: false,
      statusMutation: false,
      walletMutation: false,
      immutableV1Observation: true,
      automaticPageRefreshRemoved: true,
    },
    null,
    2
  )
);
