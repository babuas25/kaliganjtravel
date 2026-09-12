import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0069_booking_lifecycle_timestamp_contract.sql'
);
const timeline = read('lib', 'db', 'booking-lifecycle-timeline.ts');
const timelineType = read('lib', 'dashboard', 'booking-lifecycle-timeline.ts');
const timelineUi = read(
  'components',
  'dashboard',
  'bookings',
  'BookingLifecycleTimeline.tsx'
);
const customerDb = read('lib', 'db', 'flight-bookings.ts');

for (const timestamp of [
  'submission_started_at',
  'operation_claimed_at',
  'supplier_call_started_at',
  'supplier_response_received_at',
  'case_opened_at',
  'status_effective_at',
  'status_observed_at',
  'issued_at',
  'cancelled_at',
  'ticketing_deadline_at',
  'operation_completed_at',
]) {
  assert.ok(
    migration.includes(timestamp),
    `Timestamp contract omits ${timestamp}`
  );
}

assert.match(
  migration,
  /create or replace function public\.normalize_booking_status_event_time_v1\(\)[\s\S]*?if new\.observed_at is null then[\s\S]*?new\.observed_at := clock_timestamp\(\)/i
);
assert.match(
  migration,
  /before insert on public\.booking_status_events/i,
  'Observation time must be recorded at the event insert boundary'
);
assert.match(
  migration,
  /create or replace view public\.booking_lifecycle_timestamps_v[\s\S]*?with \(security_invoker = true\)/i
);
assert.match(
  migration,
  /order by candidate\.id desc[\s\S]*?limit 1/i,
  'Latest lifecycle occurrence selection must be deterministic'
);
assert.doesNotMatch(
  migration.slice(
    migration.indexOf('create or replace view public.booking_lifecycle_timestamps_v'),
    migration.indexOf('revoke all on table public.booking_lifecycle_timestamps_v')
  ),
  /coalesce\s*\(|created_at\s+as\s+(?:submission|operation|supplier|case|status|issued|cancelled|deadline|completion)|updated_at/i,
  'Exact timestamp view must not substitute creation/update time'
);

assert.ok(
  timeline.includes('occurredAt: row.effective_at') &&
    timeline.includes('observedAt: row.observed_at'),
  'Staff status timeline must keep effective and observed time distinct'
);
assert.doesNotMatch(
  timeline,
  /row\.effective_at\s*\?\?\s*row\.created_at|row\.observed_at\s*\?\?\s*row\.created_at/,
  'Staff timeline must not present persistence time as status time'
);
assert.ok(
  timelineType.includes('occurredAt: string | null') &&
    timelineUi.includes('Effective time unavailable') &&
    /const effectiveTime = item\.occurredAt/.test(timelineUi) &&
    /const observedTime = item\.observedAt/.test(timelineUi) &&
    /Observed\s*\{formatted\(observedTime\)\}/.test(timelineUi),
  'Unknown historical effective time must remain visibly unavailable'
);
assert.doesNotMatch(
  timelineUi,
  /item\.occurredAt\s*\?\?\s*item\.observedAt/,
  'Observation time must not be rendered as an effective event time'
);
assert.match(
  timeline,
  /occurredAt: row\.opened_at[\s\S]*?observedAt: row\.superseded_at \?\? row\.resolved_at \?\? row\.closed_at/,
  'Superseding a case must keep its original effective opening time and record supersession only as observation time'
);
assert.match(
  timeline,
  /fact\('Superseded at', row\.superseded_at\)/,
  'The separate supersession observation time must remain explicitly labelled'
);
assert.ok(
  customerDb.includes("status === 'in-progress' ? row.operation_started_at : null"),
  'Customer Processing Since must remain the exact active-operation start'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      timestampFacts: 11,
      futureStatusObservationRequired: true,
      unknownEffectiveTimePreserved: true,
      createdOrUpdatedFallback: false,
    },
    null,
    2
  )
);
