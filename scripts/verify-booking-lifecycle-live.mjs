import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadEnvFile(path) {
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rpcRow(data) {
  return Array.isArray(data) ? data[0] : data;
}

function hasAirlinePnr(value) {
  return Array.isArray(value) && value.length > 0;
}

function expectedLifecycle(row, now) {
  if (row.status === 'cancelled') return 'cancelled';
  if (row.status === 'confirmed') return 'confirmed';
  if (row.status === 'in-progress' || row.operation_kind) return 'in-progress';
  if (row.status === 'pending') return 'pending';
  if (row.status === 'on-hold' && !hasAirlinePnr(row.airlines_pnr)) {
    return 'unconfirmed';
  }
  if (
    row.status === 'on-hold' &&
    row.ticketing_deadline_at &&
    Date.parse(row.ticketing_deadline_at) <= now
  ) {
    return 'expired';
  }
  return 'on-hold';
}

function operationSnapshot(row) {
  return JSON.stringify({
    status: row.status,
    payment_state: row.payment_state,
    operation_kind: row.operation_kind,
    operation_reason: row.operation_reason,
    operation_request_id: row.operation_request_id,
    operation_actor_user_id: row.operation_actor_user_id,
    operation_started_at: row.operation_started_at,
    operation_prior_status: row.operation_prior_status,
    updated_at: row.updated_at,
  });
}

loadEnvFile('.env.local');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
assert(url && serviceKey && anonKey, 'Supabase verification credentials are missing');

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, serviceKey, options);
const anonymous = createClient(url, anonKey, options);
const bookingColumns = [
  'id',
  'status',
  'lifecycle_status',
  'legacy_operational',
  'airlines_pnr',
  'ticketing_deadline_at',
  'payment_state',
  'operation_kind',
  'operation_reason',
  'operation_request_id',
  'operation_actor_user_id',
  'operation_started_at',
  'operation_prior_status',
  'updated_at',
].join(',');

const observation = await admin.rpc('record_booking_lifecycle_observations', {
  p_limit: 2000,
});
assert(!observation.error, `Lifecycle observation RPC failed: ${observation.error?.message}`);

const [viewResult, rawResult, eventResult, reportResult] = await Promise.all([
  admin.from('booking_lifecycle_v').select(bookingColumns).order('id'),
  admin
    .from('flight_bookings')
    .select(bookingColumns.replace(',lifecycle_status', ''))
    .eq('legacy_operational', false)
    .order('id'),
  admin
    .from('booking_status_events')
    .select(
      'id,booking_id,from_lifecycle_status,to_lifecycle_status,stored_status_before,stored_status_after,operation_kind,operation_reason,supplier_operation,idempotency_key,created_at'
    )
    .order('created_at')
    .order('id'),
  admin.from('booking_payment_report_v').select('booking_id,booking_status').order('booking_id'),
]);
for (const result of [viewResult, rawResult, eventResult, reportResult]) {
  if (result.error) throw result.error;
}

const viewRows = viewResult.data ?? [];
const rawRows = rawResult.data ?? [];
const events = eventResult.data ?? [];
const reports = reportResult.data ?? [];
assert(viewRows.length === rawRows.length, 'Lifecycle view omitted or duplicated a business booking');
assert(viewRows.length > 0, 'No business bookings are available for live verification');

const now = Date.now();
const rawById = new Map(rawRows.map((row) => [row.id, row]));
const viewById = new Map(viewRows.map((row) => [row.id, row]));
const reportById = new Map(reports.map((row) => [row.booking_id, row]));
const allowedTerminalReasons = new Set([
  'terminal_state_conflict',
  'direct_ticket_payment_reconciliation',
]);

for (const row of viewRows) {
  assert(rawById.has(row.id), `Lifecycle view contains unknown booking ${row.id}`);
  assert(
    row.lifecycle_status === expectedLifecycle(row, now),
    `Lifecycle projection is incorrect for booking ${row.id}`
  );
  assert(
    reportById.get(row.id)?.booking_status === row.lifecycle_status,
    `Payment report disagrees with lifecycle view for booking ${row.id}`
  );

  if (row.status === 'in-progress') {
    assert(row.operation_kind, `In-progress booking ${row.id} has no operation kind`);
    assert(row.operation_reason, `In-progress booking ${row.id} has no operation reason`);
    assert(row.operation_started_at, `In-progress booking ${row.id} has no operation timestamp`);
  } else if (row.operation_kind !== null) {
    assert(
      ['confirmed', 'cancelled'].includes(row.status) &&
        row.operation_kind === 'reconciliation' &&
        allowedTerminalReasons.has(row.operation_reason) &&
        row.operation_started_at,
      `Booking ${row.id} has an invalid terminal reconciliation shape`
    );
  } else {
    assert(
      row.operation_reason === null &&
        row.operation_request_id === null &&
        row.operation_actor_user_id === null &&
        row.operation_started_at === null &&
        row.operation_prior_status === null,
      `Idle booking ${row.id} retains operation metadata`
    );
  }
}

const eventsByBooking = new Map();
for (const event of events) {
  assert(viewById.has(event.booking_id), `Status event ${event.id} references a non-business booking`);
  const bookingEvents = eventsByBooking.get(event.booking_id) ?? [];
  bookingEvents.push(event);
  eventsByBooking.set(event.booking_id, bookingEvents);
}
for (const row of viewRows) {
  const bookingEvents = eventsByBooking.get(row.id) ?? [];
  assert(bookingEvents.length > 0, `Booking ${row.id} has no status event`);
  assert(
    bookingEvents.some(
      (event) =>
        (event.supplier_operation === 'MigrationBaseline' &&
          event.idempotency_key === 'migration-0031-baseline') ||
        (event.supplier_operation === 'Book' &&
          event.idempotency_key === 'booking-created') ||
        (event.supplier_operation === 'ManualBookingImport' &&
          event.idempotency_key?.startsWith('manual-import:v1:'))
    ),
    `Booking ${row.id} has no valid initial status event`
  );
  const latest = bookingEvents.at(-1);
  assert(
    latest?.to_lifecycle_status === row.lifecycle_status,
    `Latest status event disagrees with booking ${row.id}`
  );
}

const probeId = randomUUID();
const issueProbe = rpcRow(
  (await admin.rpc('wallet_begin_booking_issue', {
    p_booking_id: probeId,
    p_actor_user_id: 'system:lifecycle-verification',
    p_actor_role: 'system',
    p_idempotency_key: `verify:${probeId}:issue`,
  })).data
);
const cancelProbe = rpcRow(
  (await admin.rpc('begin_booking_cancellation', {
    p_booking_id: probeId,
    p_actor_user_id: 'system:lifecycle-verification',
    p_idempotency_key: `verify:${probeId}:cancel`,
  })).data
);
assert(issueProbe?.ok === false && issueProbe.code === 'BOOKING_NOT_FOUND', 'Issue guard accepted an unknown booking');
assert(cancelProbe?.ok === false && cancelProbe.code === 'BOOKING_NOT_FOUND', 'Cancel guard accepted an unknown booking');

const manualIssueProbe = await admin.rpc('wallet_finalize_manual_issue', {
  p_booking_id: probeId,
  p_actor_user_id: 'system:lifecycle-verification',
  p_actor_role: 'system',
  p_supplier_outcome: {},
});
assert(
  !manualIssueProbe.error &&
    rpcRow(manualIssueProbe.data)?.ok === false &&
    rpcRow(manualIssueProbe.data)?.code === 'BOOKING_NOT_FOUND',
  'The guarded four-argument manual-issue RPC is unavailable'
);
const removedManualIssueOverload = await admin.rpc('wallet_finalize_manual_issue', {
  p_booking_id: probeId,
  p_actor_user_id: 'system:lifecycle-verification',
  p_supplier_outcome: {},
});
assert(
  Boolean(removedManualIssueOverload.error),
  'The accidental three-argument manual-issue overload is still callable'
);

const verifiedCancellationEvidence = {
  verificationMethod: 'manual_real_world_verification',
  airlineStatus: 'Cancelled',
  supplierStatus: 'Cancelled',
};
const verifiedCancellationProbe = await admin.rpc(
  'resolve_verified_booking_cancellation',
  {
    p_booking_id: probeId,
    p_actor_user_id: 'system:lifecycle-verification',
    p_idempotency_key: `verify:${probeId}:verified-cancellation`,
    p_evidence: verifiedCancellationEvidence,
  }
);
assert(
  !verifiedCancellationProbe.error &&
    rpcRow(verifiedCancellationProbe.data)?.code === 'BOOKING_NOT_FOUND',
  'Verified cancellation reconciliation accepted an unknown booking'
);

const guardedTarget = viewRows.find((row) => ['confirmed', 'cancelled'].includes(row.status));
let terminalGuard = 'not-run-no-terminal-booking';
if (guardedTarget) {
  const before = operationSnapshot(guardedTarget);
  const guardedIssueResponse = await admin.rpc('wallet_begin_booking_issue', {
    p_booking_id: guardedTarget.id,
    p_actor_user_id: 'system:lifecycle-verification',
    p_actor_role: 'system',
    p_idempotency_key: `verify:${randomUUID()}:terminal-issue`,
  });
  const guardedCancelResponse = await admin.rpc('begin_booking_cancellation', {
    p_booking_id: guardedTarget.id,
    p_actor_user_id: 'system:lifecycle-verification',
    p_idempotency_key: `verify:${randomUUID()}:terminal-cancel`,
  });
  assert(!guardedIssueResponse.error && !guardedCancelResponse.error, 'Terminal guard RPC failed');
  assert(rpcRow(guardedIssueResponse.data)?.ok === false, 'Issue guard accepted a terminal booking');
  assert(rpcRow(guardedCancelResponse.data)?.code === 'BOOKING_NOT_CANCELLABLE', 'Cancel guard accepted a terminal booking');
  const afterResult = await admin
    .from('booking_lifecycle_v')
    .select(bookingColumns)
    .eq('id', guardedTarget.id)
    .single();
  if (afterResult.error) throw afterResult.error;
  assert(operationSnapshot(afterResult.data) === before, 'Guard probes mutated the terminal booking');
  terminalGuard = 'passed-without-mutation';
}

const derivedTarget = viewRows.find((row) => ['expired', 'unconfirmed'].includes(row.lifecycle_status));
let derivedGuard = 'not-run-no-derived-terminal-booking';
if (derivedTarget) {
  const before = operationSnapshot(derivedTarget);
  const response = await admin.rpc('wallet_begin_booking_issue', {
    p_booking_id: derivedTarget.id,
    p_actor_user_id: 'system:lifecycle-verification',
    p_actor_role: 'system',
    p_idempotency_key: `verify:${randomUUID()}:derived-issue`,
  });
  assert(!response.error, `Derived issue guard RPC failed: ${response.error?.message}`);
  const expectedCode = derivedTarget.lifecycle_status === 'expired'
    ? 'BOOKING_EXPIRED'
    : 'BOOKING_UNCONFIRMED';
  assert(rpcRow(response.data)?.code === expectedCode, 'Issue guard disagrees with derived lifecycle');
  const afterResult = await admin
    .from('booking_lifecycle_v')
    .select(bookingColumns)
    .eq('id', derivedTarget.id)
    .single();
  if (afterResult.error) throw afterResult.error;
  assert(operationSnapshot(afterResult.data) === before, 'Derived guard probe mutated the booking');
  derivedGuard = 'passed-without-mutation';
}

const anonView = await anonymous.from('booking_lifecycle_v').select('id').limit(1);
assert(Boolean(anonView.error), 'Anonymous role can read the lifecycle view');
const anonEvents = await anonymous.from('booking_status_events').select('id').limit(1);
assert(Boolean(anonEvents.error), 'Anonymous role can read status events');
const anonIssue = await anonymous.rpc('wallet_begin_booking_issue', {
  p_booking_id: randomUUID(),
  p_actor_user_id: 'anonymous-verification',
  p_actor_role: 'anonymous',
  p_idempotency_key: `verify:${randomUUID()}:anon-issue`,
});
assert(Boolean(anonIssue.error), 'Anonymous role can execute the issue guard');
const anonVerifiedCancellation = await anonymous.rpc(
  'resolve_verified_booking_cancellation',
  {
    p_booking_id: randomUUID(),
    p_actor_user_id: 'anonymous-verification',
    p_idempotency_key: `verify:${randomUUID()}:anon-reconciliation`,
    p_evidence: verifiedCancellationEvidence,
  }
);
assert(
  Boolean(anonVerifiedCancellation.error),
  'Anonymous role can execute verified cancellation reconciliation'
);
const obsoleteQueue = await admin.rpc('wallet_queue_manual_issue', {
  p_booking_id: randomUUID(),
  p_actor_user_id: 'system:lifecycle-verification',
  p_actor_role: 'system',
  p_idempotency_key: `verify:${randomUUID()}:obsolete`,
  p_reason: 'verification only',
});
assert(Boolean(obsoleteQueue.error), 'Service role can execute the obsolete pending queue');

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      businessBookings: viewRows.length,
      lifecycleCounts: Object.fromEntries(
        [...new Set(viewRows.map((row) => row.lifecycle_status))].map((status) => [
          status,
          viewRows.filter((row) => row.lifecycle_status === status).length,
        ])
      ),
      operationStates: Object.fromEntries(
        [...new Set(viewRows.map((row) => row.operation_kind ?? 'idle'))].map((kind) => [
          kind,
          viewRows.filter((row) => (row.operation_kind ?? 'idle') === kind).length,
        ])
      ),
      statusEvents: events.length,
      lifecycleObservationsInserted: rpcRow(observation.data),
      unknownBookingGuards: 'passed',
      manualIssueSignature: 'guarded-four-argument-only',
      verifiedCancellationRpc: 'service-role-only',
      terminalGuard,
      derivedGuard,
      anonymousAccess: 'denied',
      obsoletePendingQueue: 'denied',
    },
    null,
    2
  )
);
