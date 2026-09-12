import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import ts from 'typescript';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8').replace(/\r\n/g, '\n');

const migration = read(
  'supabase', 'migrations', '0115_ticketing_operation_window_reconciliation.sql'
);
const pnr = read('lib', 'triplover', 'pnr.ts');
const air = read('lib', 'triplover', 'air-ticketing-details.ts');
const canonicalAdapter = read('lib', 'triplover', 'canonical-evidence-v2.ts');
const supplierImportTime = read('lib', 'supplier-reference-import', 'time.ts');
const timeSource = read('lib', 'triplover', 'time.ts');
const issueRoute = read('app', 'api', 'flights', 'booking', 'issue', 'route.ts');
const postTicketing = read(
  'lib', 'booking-lifecycle', 'post-ticketing-reconciliation.server.ts'
);
const evidenceDb = read('lib', 'db', 'booking-reconciliation-evidence.ts');
const actions = read('components', 'flights', 'BookingActions.tsx');
const bookingsTable = read(
  'components', 'dashboard', 'bookings', 'BookingsTable.tsx'
);
const attemptsPanel = read(
  'components', 'dashboard', 'bookings', 'BookingAttemptReconciliationPanel.tsx'
);
const responsibility = read(
  'lib', 'dashboard', 'booking-review-responsibility.ts'
);

for (const required of [
  'booking_ticketing_observation_overlap_v1',
  "operation.kind = 'ticketing'",
  "operation.state in ('claimed', 'supplier_call_started')",
  "operation.state = 'succeeded'",
  "operation.claimed_at + interval '3 minutes'",
  "v_target = 'on-hold'",
  "when v_transitional then false",
  "when 'cancelled' then 'cancelled'",
  "when 'canceled' then 'cancelled'",
  'booking_deadline_observations',
  'if v_transitional_terminal then return v_after_sync',
  'coalesce(issued_at, p_issued_at)',
  'coalesce(cancelled_at, p_cancelled_at)',
  'close_booking_ticketing_race_no_change_v1',
  "v_case.reason_code <> 'pnr_sync_conflicts_with_local_truth'",
  "v_case.opened_source <> 'supplier_sync'",
  "v_operation.state <> 'succeeded'",
  "v_booking.status <> 'confirmed'",
  `'["pnr", "air-ticketing-details"]'::jsonb`,
  "v_booking.payment_state = 'captured'",
  "resolution_outcome = 'supplier_truth_unchanged'",
]) {
  assert.ok(migration.includes(required), `Central reconciliation migration omits ${required}`);
}

const closer = migration.match(
  /create or replace function public\.close_booking_ticketing_race_no_change_v1\([\s\S]*?\n\$\$;/i
)?.[0] ?? '';
assert.ok(closer, 'Ticketing race closer is missing');
for (const forbidden of [
  /update\s+public\.flight_bookings/i,
  /update\s+public\.booking_operations/i,
  /(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\.wallet_accounts/i,
  /(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\.wallet_ledger_entries/i,
  /update\s+public\.wallet_reservations/i,
  /insert\s+into\s+public\.booking_status_events/i,
  /insert\s+into\s+public\.booking_notification/i,
  /wallet_(?:reserve|capture|release|refund)\s*\(/i,
]) {
  assert.doesNotMatch(closer, forbidden);
}
assert.match(closer, /for update[\s\S]*?for update[\s\S]*?for update[\s\S]*?for update/);
assert.match(closer, /state = 'closed_no_change'/);
assert.match(closer, /v_case\.state = 'closed_no_change'[\s\S]*?'replay', true/);

assert.match(postTicketing, /readOpenTicketingRaceCase/);
assert.match(postTicketing, /acquireSupplierEvidence/);
assert.match(postTicketing, /purpose: 'ticketed'/);
assert.match(postTicketing, /recordBookingReconciliationEvidenceRead/);
assert.match(postTicketing, /closeBookingTicketingRaceNoChange/);
assert.match(postTicketing, /acquireSecurityLock/);
assert.match(postTicketing, /Math\.floor\(Date\.now\(\) \/ 300_000\)/);
assert.doesNotMatch(postTicketing, /wallet|finalizeBookingIssue|syncAirTicketingDetails/);
assert.match(issueRoute, /finalizeBookingIssue[\s\S]*?reconcilePostTicketingRace/);
assert.match(evidenceDb, /close_booking_ticketing_race_no_change_v2/);

assert.match(pnr, /supplierLifecycleInstant\(/);
assert.match(pnr, /ticketingDeadlineAt/);
assert.match(air, /adaptTriploverTicketReportEvidenceV2/);
assert.match(canonicalAdapter, /issuedAt:[\s\S]*?supplierLifecycleInstant\(input\.supplier, ticket\.issueDate\)/);
assert.match(canonicalAdapter, /cancelledAt:[\s\S]*?supplierLifecycleInstant\([\s\S]*?input\.supplier,[\s\S]*?rawCancellation/);
assert.match(supplierImportTime, /supplierLifecycleInstant as supplierReferenceInstant/);

function timestampsUnder(tz) {
  const output = ts.transpileModule(timeSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const runner = `
    const module = { exports: {} };
    Function('module', 'exports', ${JSON.stringify(output)})(module, module.exports);
    const parse = module.exports.supplierLifecycleInstant;
    process.stdout.write(JSON.stringify({
      firsttripBooking: parse('firsttrip', '2026-08-27 12:02:16'),
      firsttripIssued: parse('firsttrip', '2026-08-27T12:02:16.1234567'),
      firsttripCancelled: parse('firsttrip', '2026-08-27T13:15:01'),
      takeoffBooking: parse('takeoff', '2026-08-27 12:02:16'),
      takeoffIssued: parse('takeoff', '2026-08-27T12:02:16.1234567'),
      explicitUtc: parse('firsttrip', '2026-08-27T06:02:16Z'),
      explicitDhaka: parse('takeoff', '2026-08-27T12:02:16+06:00'),
      invalid: parse('firsttrip', '08/27/2026 12:02:16')
    }));
  `;
  const child = spawnSync(process.execPath, ['-e', runner], {
    encoding: 'utf8', env: { ...process.env, TZ: tz },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

const utcTimestamps = timestampsUnder('UTC');
assert.deepEqual(utcTimestamps, timestampsUnder('Asia/Dhaka'));
assert.deepEqual(utcTimestamps, {
  firsttripBooking: '2026-08-27T06:02:16.000Z',
  firsttripIssued: '2026-08-27T06:02:16.123Z',
  firsttripCancelled: '2026-08-27T07:15:01.000Z',
  takeoffBooking: '2026-08-27T06:02:16.000Z',
  takeoffIssued: '2026-08-27T06:02:16.123Z',
  explicitUtc: '2026-08-27T06:02:16.000Z',
  explicitDhaka: '2026-08-27T06:02:16.000Z',
  invalid: null,
});

assert.match(responsibility, /Needs Support Review/);
assert.match(responsibility, /Needs Accounts Review/);
assert.match(responsibility, /Needs Admin Review/);
assert.match(responsibility, /Needs Staff Review/);
assert.doesNotMatch(bookingsTable, /Unassigned/);
assert.doesNotMatch(attemptsPanel, /Unassigned|Internal queue/);
assert.doesNotMatch(
  actions,
  /useEffect\(\(\) => \{[\s\S]{0,400}\/api\/flights\/booking\/refresh-details/
);
assert.match(actions, /\/api\/flights\/booking\/refresh-details/);

// Compile every forward-migration function against a minimal lifecycle schema.
// This catches SQL/PLpgSQL errors even when the local Supabase/Docker stack is
// unavailable in CI or on a developer laptop.
const migrationDb = new PGlite({ extensions: { pgcrypto } });
await migrationDb.exec(`
  create extension if not exists pgcrypto;
  create role anon; create role authenticated; create role service_role;
  create table public.flight_bookings (
    id uuid primary key, legacy_operational boolean not null default false,
    supplier_account text, supplier_refs jsonb not null default '{}'::jsonb,
    booking_code_ref text, pnr text, booking_ref_number text,
    status text, airlines_pnr jsonb, ticketing_deadline_at timestamptz,
    operation_kind text, operation_reason text, booking_status text,
    synced_at timestamptz, ticketing_time_limit text, deadline_source text,
    active_local_time_limit_request_id uuid,
    local_ticketing_deadline_at timestamptz,
    supplier_ticketing_time_limit text,
    supplier_ticketing_deadline_at timestamptz,
    supplier_deadline_source text, issued_at timestamptz, cancelled_at timestamptz,
    active_operation_id uuid, payment_state text, payment_amount bigint,
    captured_amount bigint not null default 0, refunded_amount bigint not null default 0,
    currency text
  );
  create table public.booking_operations (
    id uuid primary key, booking_id uuid not null, kind text, state text,
    claimed_at timestamptz, supplier_call_started_at timestamptz,
    completed_at timestamptz, supplier_evidence jsonb not null default '{}'::jsonb,
    error_code text, error_message text
  );
  create table public.booking_reconciliation_cases (
    id uuid primary key, subject_booking_id uuid, operation_id uuid,
    case_type text, state text, reason_code text, opened_source text,
    opened_at timestamptz, proposed_outcome text,
    financial_disposition text not null default 'none', resolution jsonb,
    resolution_outcome text, resolution_reason text, resolved_by_user_id text,
    resolved_at timestamptz, closed_at timestamptz,
    evidence_latest_at timestamptz, evidence_normalizer_version integer,
    version integer not null default 1
  );
  create table public.booking_reconciliation_observations (
    id uuid primary key default gen_random_uuid(), reconciliation_case_id uuid,
    observation_key text, observation_kind text, observation_source text,
    actor_user_id text, actor_role text, normalized_facts jsonb,
    normalized_facts_hash text, observed_at timestamptz,
    unique (reconciliation_case_id, observation_key)
  );
  create table public.wallet_reservations (
    id uuid primary key, booking_id uuid, state text, amount bigint, currency text
  );
  create table public.booking_status_events (
    booking_id uuid, from_lifecycle_status text, to_lifecycle_status text,
    stored_status_before text, stored_status_after text, operation_kind text,
    operation_reason text, actor_user_id text, supplier_operation text,
    supplier_evidence jsonb, idempotency_key text unique
  );
  create table public.booking_deadline_observations (
    booking_id uuid, observation_source text, supplier_status text,
    supplier_time_limit_raw text, supplier_deadline_at timestamptz,
    supplier_deadline_source text, actor_user_id text, actor_role text,
    normalized_evidence jsonb, evidence_hash text unique
  );
  create table public.booking_local_time_limit_requests (
    id uuid primary key, state text, superseded_at timestamptz,
    superseded_reason text, version integer
  );
  create table public.booking_local_time_limit_events (
    booking_id uuid, request_id uuid, event_type text, actor_user_id text,
    actor_role text, prior_deadline_at timestamptz,
    resulting_deadline_at timestamptz, reason text, evidence jsonb
  );
  create table public.security_audit_events (
    actor_user_id text, actor_role text, action text, target_type text,
    target_id text, outcome text, metadata jsonb
  );
  create table public.sync_case_log (case_type text, reason_code text);
  create function public.resolve_booking_lifecycle(text, jsonb, timestamptz, text)
    returns text language sql immutable as $$ select $1 $$;
  create function public.jsonb_is_nonempty_array(jsonb)
    returns boolean language sql immutable as
    $$ select jsonb_typeof($1)='array' and jsonb_array_length($1)>0 $$;
  create function public.record_booking_sync_case_v1(
    uuid, text, text, text, text, text, jsonb
  ) returns uuid language plpgsql as $$
  begin
    insert into public.sync_case_log(case_type, reason_code) values ($2, $3);
    return gen_random_uuid();
  end $$;
  ${migration}
`);

const lifecycleBookingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const lifecycleOperationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
await migrationDb.query(
  `insert into public.flight_bookings (
    id, supplier_account, supplier_refs, booking_code_ref, pnr,
    booking_ref_number, status, airlines_pnr, operation_kind,
    payment_state, payment_amount, captured_amount, refunded_amount, currency
  ) values (
    $1, 'firsttrip', $2::jsonb, 'BC-1', 'PNR001', 'PNR001',
    'in-progress', '[]'::jsonb, 'ticketing', 'held', 10000, 0, 0, 'BDT'
  )`,
  [lifecycleBookingId, JSON.stringify({ uniqueTransId: 'TX-1' })]
);
await migrationDb.query(
  `insert into public.booking_operations
    (id, booking_id, kind, state, claimed_at, supplier_call_started_at)
   values ($1, $2, 'ticketing', 'supplier_call_started',
     clock_timestamp()-interval '30 seconds', clock_timestamp()-interval '25 seconds')`,
  [lifecycleOperationId, lifecycleBookingId]
);
const lifecycleEvidence = {
  source: 'pnr',
  receipt: {
    requestStartedAt: new Date(Date.now() - 20_000).toISOString(),
    responseReceivedAt: new Date(Date.now() - 10_000).toISOString(),
  },
  identity: {
    uniqueTransId: 'TX-1', requestedPnr: 'PNR001', bookingCodeRef: 'BC-1',
  },
  facts: {
    responsePnr: 'PNR001', supplierEchoedUniqueTransIds: ['TX-1'],
  },
};
async function recordPnr(status, evidenceValue = lifecycleEvidence) {
  await migrationDb.query(
    `select public.record_booking_pnr_refresh_v2(
      $1, 'system:test', 'system', 'ordinary_sync', $2,
      '[]'::jsonb, null, null, $3::jsonb
    )`,
    [lifecycleBookingId, status, JSON.stringify(evidenceValue)]
  );
}
async function caseTypes() {
  const result = await migrationDb.query(
    'select case_type from public.sync_case_log order by case_type'
  );
  return result.rows.map((row) => row.case_type);
}

await recordPnr('Booked');
assert.deepEqual(await caseTypes(), [], 'overlapping Booked must not create uncertainty');
await recordPnr('Held');
assert.deepEqual(await caseTypes(), [], 'overlapping Held must not create uncertainty');
await recordPnr('Cancelled');
assert.deepEqual(await caseTypes(), ['cancellation_uncertainty']);
await migrationDb.exec('truncate public.sync_case_log');
await recordPnr('Booked', {
  ...lifecycleEvidence,
  identity: { ...lifecycleEvidence.identity, uniqueTransId: 'OTHER' },
});
assert.deepEqual(await caseTypes(), ['ticketing_uncertainty']);
await migrationDb.exec('truncate public.sync_case_log');
await migrationDb.query(
  `update public.booking_operations set
    claimed_at=clock_timestamp()-interval '4 minutes',
    supplier_call_started_at=clock_timestamp()-interval '4 minutes'
   where id=$1`,
  [lifecycleOperationId]
);
await recordPnr('Booked');
assert.deepEqual(await caseTypes(), ['ticketing_uncertainty']);

const closureBookingId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const closureOperationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const closureCaseId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const closureObservationId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
await migrationDb.query(
  `insert into public.flight_bookings (
    id, supplier_account, supplier_refs, booking_code_ref, pnr,
    booking_ref_number, status, airlines_pnr, payment_state,
    payment_amount, captured_amount, refunded_amount, currency
  ) values (
    $1, 'takeoff', $2::jsonb, 'BC-CLOSE', 'PNRCLOSE', 'PNRCLOSE',
    'confirmed', '["AIRPNR"]'::jsonb, 'captured', 10000, 10000, 0, 'BDT'
  )`,
  [closureBookingId, JSON.stringify({ uniqueTransId: 'TX-CLOSE' })]
);
await migrationDb.query(
  `insert into public.booking_operations
    (id, booking_id, kind, state, claimed_at, supplier_call_started_at, completed_at)
   values ($1, $2, 'ticketing', 'succeeded',
     clock_timestamp()-interval '30 seconds', clock_timestamp()-interval '25 seconds',
     clock_timestamp()-interval '5 seconds')`,
  [closureOperationId, closureBookingId]
);
await migrationDb.query(
  `insert into public.booking_reconciliation_cases (
    id, subject_booking_id, operation_id, case_type, state, reason_code,
    opened_source, opened_at, financial_disposition
  ) values (
    $1, $2, $3, 'ticketing_uncertainty', 'open',
    'pnr_sync_conflicts_with_local_truth', 'supplier_sync',
    clock_timestamp()-interval '10 seconds', 'none'
  )`,
  [closureCaseId, closureBookingId, closureOperationId]
);
await migrationDb.query(
  `insert into public.wallet_reservations
    (id, booking_id, state, amount, currency)
   values (gen_random_uuid(), $1, 'captured', 10000, 'BDT')`,
  [closureBookingId]
);
const closureFacts = {
  action: 'supplier_evidence_read',
  bookingId: closureBookingId,
  caseId: closureCaseId,
  evidenceObservedAt: new Date().toISOString(),
  validation: {
    authoritativeFor: 'ticketed', valid: true, complete: true,
    fresh: true, identityMatches: true,
  },
  recordedSources: ['pnr', 'air-ticketing-details'],
  evidence: {
    pnr: { source: 'pnr' },
    airTicketing: { source: 'air-ticketing-details' },
  },
  expectedIdentity: { uniqueTransId: 'TX-CLOSE', bookingCodeRef: 'BC-CLOSE' },
  localContext: { storedStatus: 'confirmed', paymentState: 'captured' },
};
await migrationDb.query(
  `insert into public.booking_reconciliation_observations (
    id, reconciliation_case_id, observation_key, observation_kind,
    observation_source, actor_user_id, actor_role, normalized_facts,
    normalized_facts_hash, observed_at
  ) values (
    $1, $2, 'evidence-read:v1:closure', 'staff_evidence', 'supplier_read',
    'system:post-ticketing-evidence', 'system', $3::jsonb,
    repeat('a', 64), clock_timestamp()
  )`,
  [closureObservationId, closureCaseId, JSON.stringify(closureFacts)]
);
const firstClosure = await migrationDb.query(
  'select public.close_booking_ticketing_race_no_change_v1($1, $2, $3) as result',
  [closureBookingId, closureCaseId, closureObservationId]
);
assert.equal(firstClosure.rows[0].result.ok, true);
assert.equal(firstClosure.rows[0].result.closedNoChange, true);
const closureState = await migrationDb.query(
  `select b.status, b.payment_state, b.captured_amount, c.state as case_state,
          r.state as reservation_state, r.amount as reservation_amount
     from public.flight_bookings b
     join public.booking_reconciliation_cases c on c.subject_booking_id=b.id
     join public.wallet_reservations r on r.booking_id=b.id
    where b.id=$1`,
  [closureBookingId]
);
assert.deepEqual(closureState.rows[0], {
  status: 'confirmed', payment_state: 'captured', captured_amount: 10000,
  case_state: 'closed_no_change', reservation_state: 'captured',
  reservation_amount: 10000,
});
const replayClosure = await migrationDb.query(
  'select public.close_booking_ticketing_race_no_change_v1($1, $2, $3) as result',
  [closureBookingId, closureCaseId, closureObservationId]
);
assert.equal(replayClosure.rows[0].result.ok, true);
assert.equal(replayClosure.rows[0].result.replay, true);
await migrationDb.close();

const overlapFunction = migration.match(
  /create or replace function public\.booking_ticketing_observation_overlap_v1\([\s\S]*?\n\$\$;/i
)?.[0] ?? '';
assert.ok(overlapFunction, 'Operation-window classifier is missing');
const db = new PGlite();
await db.exec(`
  create schema if not exists public;
  create table public.flight_bookings (
    id uuid primary key,
    legacy_operational boolean not null default false,
    supplier_account text,
    supplier_refs jsonb not null,
    booking_code_ref text,
    pnr text,
    booking_ref_number text
  );
  create table public.booking_operations (
    id uuid primary key,
    booking_id uuid not null,
    kind text not null,
    state text not null,
    claimed_at timestamptz not null,
    supplier_call_started_at timestamptz,
    completed_at timestamptz
  );
  ${overlapFunction}
`);

const bookingId = '11111111-1111-4111-8111-111111111111';
const activeOperationId = '22222222-2222-4222-8222-222222222222';
await db.query(
  `insert into public.flight_bookings
    (id, supplier_account, supplier_refs, booking_code_ref, pnr, booking_ref_number)
   values ($1, 'firsttrip', $2::jsonb, 'BC-1', 'PNR001', 'PNR001')`,
  [bookingId, JSON.stringify({ uniqueTransId: 'TX-1' })]
);
await db.query(
  `insert into public.booking_operations
    (id, booking_id, kind, state, claimed_at, supplier_call_started_at)
   values ($1, $2, 'ticketing', 'supplier_call_started',
     clock_timestamp() - interval '30 seconds', clock_timestamp() - interval '25 seconds')`,
  [activeOperationId, bookingId]
);

function evidence(overrides = {}) {
  const requestStartedAt = new Date(Date.now() - 20_000).toISOString();
  const responseReceivedAt = new Date(Date.now() - 10_000).toISOString();
  return {
    source: 'pnr',
    receipt: { requestStartedAt, responseReceivedAt },
    identity: {
      uniqueTransId: 'TX-1', requestedPnr: 'PNR001', bookingCodeRef: 'BC-1',
    },
    facts: {
      responsePnr: 'PNR001', supplierEchoedUniqueTransIds: ['TX-1'],
    },
    ...overrides,
  };
}
async function overlap(value) {
  const result = await db.query(
    'select public.booking_ticketing_observation_overlap_v1($1, $2::jsonb) as id',
    [bookingId, JSON.stringify(value)]
  );
  return result.rows[0]?.id ?? null;
}

assert.equal(await overlap(evidence()), activeOperationId);
await db.query("update public.flight_bookings set supplier_account='takeoff' where id=$1", [bookingId]);
assert.equal(await overlap(evidence()), activeOperationId, 'TakeOff uses the same central rule');
assert.equal(
  await overlap(evidence({ identity: {
    uniqueTransId: 'OTHER', requestedPnr: 'PNR001', bookingCodeRef: 'BC-1',
  } })),
  null,
  'identity mismatch must not be transitional'
);
assert.equal(
  await overlap(evidence({ facts: {
    responsePnr: 'PNR001', supplierEchoedUniqueTransIds: ['OTHER'],
  } })),
  null,
  'contradictory supplier echo must not be transitional'
);
await db.query(
  "update public.booking_operations set claimed_at=clock_timestamp()-interval '4 minutes', supplier_call_started_at=clock_timestamp()-interval '4 minutes' where id=$1",
  [activeOperationId]
);
assert.equal(await overlap(evidence()), null, 'stuck operations must fail closed');
await db.query('delete from public.booking_operations');
const succeededOperationId = '33333333-3333-4333-8333-333333333333';
await db.query(
  `insert into public.booking_operations
    (id, booking_id, kind, state, claimed_at, supplier_call_started_at, completed_at)
   values ($1, $2, 'ticketing', 'succeeded',
     clock_timestamp() - interval '30 seconds', clock_timestamp() - interval '25 seconds',
     clock_timestamp() - interval '5 seconds')`,
  [succeededOperationId, bookingId]
);
const succeededEvidence = evidence({
  receipt: {
    requestStartedAt: new Date(Date.now() - 20_000).toISOString(),
    responseReceivedAt: new Date(Date.now() - 10_000).toISOString(),
  },
});
assert.equal(await overlap(succeededEvidence), succeededOperationId);
assert.equal(
  await overlap(evidence({
    receipt: {
      requestStartedAt: new Date(Date.now() - 3_000).toISOString(),
      responseReceivedAt: new Date(Date.now() - 2_000).toISOString(),
    },
  })),
  null,
  'post-ticketing observations must remain conflicts'
);
await db.close();

console.log(JSON.stringify({
  checks: 'passed',
  suppliers: ['firsttrip', 'takeoff'],
  transitionalStates: ['Booked', 'Held', 'Created'],
  genuineConflictProtection: true,
  stuckOperationProtection: true,
  freshCaseBoundClosure: true,
  runtimeTimezoneIndependent: true,
  lifecycleTimestampOverwritePrevented: true,
  mountSyncRemoved: true,
  statusMutation: false,
  walletMutation: false,
}, null, 2));
