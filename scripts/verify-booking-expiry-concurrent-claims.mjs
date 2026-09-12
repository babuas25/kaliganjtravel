import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0078_booking_expiry_keyset_pagination.sql'
  ),
  'utf8'
);

const candidatesStart = migration.indexOf('with due_unobserved as materialized (');
const insertStart = migration.indexOf('), inserted as (', candidatesStart);
assert.ok(candidatesStart >= 0 && insertStart > candidatesStart);
const candidates = migration.slice(candidatesStart, insertStart);

assert.match(
  candidates,
  /order by booking\.ticketing_deadline_at, booking\.id\s+limit v_limit\s+for update of booking skip locked/i,
  'Expiry claims must lock the ordered booking roots and skip concurrent claims'
);
assert.match(
  migration,
  /insert into public\.booking_status_events[\s\S]*?on conflict do nothing/i,
  'Concurrent expiry insertion needs a replay-safe uniqueness fallback'
);
assert.match(
  migration,
  /'derived-expired:v1:'[\s\S]*?candidate\.ticketing_deadline_at/i,
  'Concurrent workers need the same deterministic occurrence key for one deadline'
);
assert.doesNotMatch(
  migration,
  /update public\.flight_bookings/i,
  'Claiming/observing derived expiry must not update booking rows'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      lockTarget: 'flight_bookings candidate row',
      concurrentPolicy: 'FOR UPDATE SKIP LOCKED',
      duplicateFallback: 'event occurrence unique key',
      bookingRowMutation: false,
    },
    null,
    2
  )
);
