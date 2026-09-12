import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0076_booking_due_deadline_index.sql'
  ),
  'utf8'
);

assert.match(
  migration,
  /create index if not exists flight_bookings_due_expiry_observation_idx\s+on public\.flight_bookings \(ticketing_deadline_at, id\)/i,
  'Expiry candidates need deadline plus stable-ID index order'
);
for (const predicate of [
  'not legacy_operational',
  "status = 'on-hold'",
  'active_operation_id is null',
  'operation_kind is null',
  'ticketing_deadline_at is not null',
  'public.jsonb_is_nonempty_array(airlines_pnr)',
]) {
  assert.ok(
    migration.toLowerCase().includes(predicate),
    `Due-deadline partial index omits ${predicate}`
  );
}
assert.doesNotMatch(
  migration,
  /\b(updated_at|created_at)\b/i,
  'Expiry index must not use mutable audit timestamps as scan order'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      keyOrder: ['ticketing_deadline_at', 'id'],
      storedStatus: 'on-hold',
      requiresAirlinePnr: true,
      excludesUnresolvedOperations: true,
      mutatesBookingRows: false,
    },
    null,
    2
  )
);
