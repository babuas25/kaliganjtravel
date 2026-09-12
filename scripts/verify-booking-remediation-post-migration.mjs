import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] ??= value;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function project(row, columns) {
  return Object.fromEntries(columns.map((column) => [column, row[column]]));
}

function sortById(rows) {
  return [...rows].sort((left, right) =>
    String(left.id).localeCompare(String(right.id))
  );
}

function projectExpectedCases(snapshot) {
  const projected = [];
  for (const booking of snapshot.tables.flight_bookings) {
    if (booking.operation_kind === 'reconciliation' && booking.operation_reason) {
      const caseType = {
        legacy_reconciliation: 'legacy_review',
        terminal_state_conflict: 'terminal_conflict',
        direct_ticket_payment_reconciliation: 'direct_ticket_payment_failure',
        cancellation_reconciliation: 'cancellation_uncertainty',
      }[booking.operation_reason] ?? 'ticketing_uncertainty';
      projected.push({
        subjectBookingId: booking.id,
        subjectAttemptId: null,
        caseType,
      });
    }
    if (booking.status === 'cancelled' && !booking.cancelled_at) {
      projected.push({
        subjectBookingId: booking.id,
        subjectAttemptId: null,
        caseType: 'historical_inconsistency',
      });
    }
    if (
      booking.status === 'cancelled' &&
      Number(booking.captured_amount) > Number(booking.refunded_amount)
    ) {
      projected.push({
        subjectBookingId: booking.id,
        subjectAttemptId: null,
        caseType: 'terminal_conflict',
      });
    }
    if (booking.status === 'confirmed' && booking.payment_state === 'unpaid') {
      projected.push({
        subjectBookingId: booking.id,
        subjectAttemptId: null,
        caseType:
          booking.import_source === 'IMP_EXP'
            ? 'imported_payment_conflict'
            : 'direct_ticket_payment_failure',
      });
    }
  }
  for (const attempt of snapshot.tables.booking_attempts) {
    if (!['submitting', 'unknown'].includes(attempt.state)) continue;
    projected.push({
      subjectBookingId: null,
      subjectAttemptId: attempt.id,
      caseType: 'attempt_uncertainty',
    });
  }
  return projected;
}

async function selectByIds(client, table, ids) {
  if (ids.length === 0) return [];
  const { data, error } = await client.from(table).select('*').in('id', ids);
  if (error) throw new Error(`Read failed for ${table}: ${error.message}`);
  return data ?? [];
}

async function countRows(client, table) {
  const { count, error } = await client
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (error) throw new Error(`Count failed for ${table}: ${error.message}`);
  assert.notEqual(count, null, `Count unavailable for ${table}`);
  return count;
}

loadEnvFile('.env.local');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(url && serviceKey, 'Supabase read credentials are missing.');

const snapshotPath = path.resolve(
  process.argv[2] ??
    'backups/booking-remediation-2026-08-11T19-12-22-489Z.json'
);
const snapshotPayload = readFileSync(snapshotPath, 'utf8');
const snapshot = JSON.parse(snapshotPayload);
assert.equal(snapshot.format, 'kaliganj-travels-booking-remediation-snapshot-v1');

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const immutableTables = [
  'flight_bookings',
  'booking_attempts',
  'wallet_reservations',
  'wallet_accounts',
  'wallets',
  'wallet_ledger_entries',
  'booking_status_events',
];
for (const table of immutableTables) {
  const expected = snapshot.tables[table];
  const columns = Object.keys(expected[0] ?? {});
  const current = await selectByIds(
    admin,
    table,
    expected.map((row) => row.id)
  );
  assert.equal(
    current.length,
    expected.length,
    `${table} lost a protected snapshot row`
  );
  assert.deepEqual(
    sortById(current).map((row) => project(row, columns)),
    sortById(expected),
    `${table} changed a protected pre-migration field`
  );
}

const bookingIds = snapshot.tables.flight_bookings.map((row) => row.id);
const legacyDeliveryResult = await admin
  .from('booking_status_email_deliveries')
  .select('*')
  .in('booking_id', bookingIds);
if (legacyDeliveryResult.error) {
  throw new Error(
    `Read failed for booking_status_email_deliveries: ${legacyDeliveryResult.error.message}`
  );
}
for (const expected of snapshot.tables.booking_status_email_deliveries) {
  const columns = Object.keys(expected);
  assert.ok(
    (legacyDeliveryResult.data ?? []).some((row) =>
      Object.is(JSON.stringify(project(row, columns)), JSON.stringify(expected))
    ),
    'A protected legacy notification-delivery row changed'
  );
}

const projectedCases = projectExpectedCases(snapshot);
const attemptIds = snapshot.tables.booking_attempts.map((row) => row.id);
const [bookingCaseResult, attemptCaseResult] = await Promise.all([
  admin
    .from('booking_reconciliation_cases')
    .select('subject_booking_id,subject_booking_attempt_id,case_type,state')
    .in('subject_booking_id', bookingIds),
  admin
    .from('booking_reconciliation_cases')
    .select('subject_booking_id,subject_booking_attempt_id,case_type,state')
    .in('subject_booking_attempt_id', attemptIds),
]);
if (bookingCaseResult.error) throw bookingCaseResult.error;
if (attemptCaseResult.error) throw attemptCaseResult.error;
const subjectCases = [
  ...(bookingCaseResult.data ?? []),
  ...(attemptCaseResult.data ?? []),
];
for (const expected of projectedCases) {
  const matches = subjectCases.filter(
    (candidate) =>
      candidate.subject_booking_id === expected.subjectBookingId &&
      candidate.subject_booking_attempt_id === expected.subjectAttemptId &&
      candidate.case_type === expected.caseType
  );
  assert.equal(matches.length, 1, 'A projected remediation case is missing or duplicated');
  assert.ok(
    ['open', 'assigned', 'awaiting_supplier', 'awaiting_finance', 'awaiting_approval']
      .includes(matches[0].state),
    'A projected remediation case was unexpectedly resolved'
  );
}

const countedTables = [
  'booking_operations',
  'booking_reconciliation_cases',
  'booking_status_events',
  'booking_notification_outbox',
  'booking_notification_deliveries',
  'booking_lifecycle_worker_runs',
];
const tableCounts = {};
for (const table of countedTables) tableCounts[table] = await countRows(admin, table);

const metricViews = [
  'booking_lifecycle_metrics_v',
  'booking_notification_metrics_v',
  'booking_derived_lifecycle_metrics_v',
];
for (const view of metricViews) {
  const { data, error } = await admin.from(view).select('*').limit(1);
  if (error) throw new Error(`Metrics read failed for ${view}: ${error.message}`);
  assert.equal(data?.length, 1, `${view} must expose one aggregate row`);
}

let anonymousAccessDenied = null;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (anonKey) {
  const anonymous = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await anonymous
    .from('booking_reconciliation_cases')
    .select('id')
    .limit(1);
  anonymousAccessDenied = Boolean(error);
  assert.equal(anonymousAccessDenied, true, 'Anonymous case-table read was not denied');
}

const caseTypeCounts = Object.fromEntries(
  [...new Set(projectedCases.map((item) => item.caseType))]
    .sort()
    .map((caseType) => [
      caseType,
      projectedCases.filter((item) => item.caseType === caseType).length,
    ])
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      snapshotSha256: sha256(snapshotPayload),
      protectedRowsUnchanged: Object.fromEntries(
        Object.entries(snapshot.tables).map(([table, rows]) => [table, rows.length])
      ),
      projectedCasesPresent: projectedCases.length,
      projectedCaseTypes: caseTypeCounts,
      liveAggregateCounts: tableCounts,
      metricViewsReadable: metricViews.length,
      anonymousCaseAccessDenied: anonymousAccessDenied,
      readOnly: true,
      supplierCalls: 0,
      walletMutations: 0,
      caseDecisions: 0,
      emailsSent: 0,
      sensitiveRowsPrinted: false,
    },
    null,
    2
  )
);
