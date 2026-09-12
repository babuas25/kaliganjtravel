import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0077_booking_due_expiry_observation.sql'
  ),
  'utf8'
);

const candidatesStart = migration.indexOf('with due_unobserved as (');
const insertedStart = migration.indexOf('), inserted as (', candidatesStart);
assert.ok(candidatesStart >= 0 && insertedStart > candidatesStart);
const candidates = migration.slice(candidatesStart, insertedStart);

for (const required of [
  'booking.ticketing_deadline_at <= v_observed_at',
  "coalesce(latest_event.to_lifecycle_status, 'on-hold') <> 'expired'",
  'booking.active_operation_id is null',
  'booking.operation_kind is null',
  'order by booking.ticketing_deadline_at, booking.id',
]) {
  assert.ok(candidates.includes(required), `Due candidate query omits ${required}`);
}
const filterPosition = candidates.indexOf(
  "coalesce(latest_event.to_lifecycle_status, 'on-hold') <> 'expired'"
);
const limitPosition = candidates.indexOf(
  'limit greatest(1, least(coalesce(p_limit, 500), 2000))'
);
assert.ok(
  filterPosition >= 0 && limitPosition > filterPosition,
  'Due and not-yet-observed filtering must happen before the batch limit'
);
assert.doesNotMatch(
  candidates,
  /resolve_booking_lifecycle|order by booking\.updated_at/i,
  'Candidate selection must not resolve or sort the broad On Hold population'
);
for (const required of [
  "'derived-expired:v1:'",
  'candidate.ticketing_deadline_at',
  'v_observed_at',
  'on conflict do nothing',
]) {
  assert.ok(migration.includes(required), `Expiry occurrence omits ${required}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      dueFilterBeforeLimit: true,
      currentExpiryObservationExcludedBeforeLimit: true,
      stableOrder: ['ticketing_deadline_at', 'id'],
      broadOnHoldResolution: false,
    },
    null,
    2
  )
);
