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

for (const required of [
  'p_after_deadline timestamptz default null',
  'p_after_id uuid default null',
  "raise exception 'expiry cursor requires both deadline and booking ID'",
  '(booking.ticketing_deadline_at, booking.id)',
  '> (p_after_deadline, p_after_id)',
  'order by booking.ticketing_deadline_at, booking.id',
  "'nextDeadline'",
  "'nextId'",
  "'hasMore'",
]) {
  assert.ok(migration.includes(required), `Keyset contract omits ${required}`);
}
assert.doesNotMatch(
  migration,
  /\boffset\b|order by booking\.updated_at/i,
  'Expiry pagination must not use offsets or mutable timestamp ordering'
);
assert.match(
  migration,
  /record_booking_lifecycle_observations[\s\S]*?record_due_booking_expiry_observation_batch_v1\(\s*null,\s*null,\s*p_limit/i,
  'Legacy RPC must delegate to one cursor-batch call during cutover'
);
assert.match(
  migration,
  /revoke all on function public\.record_due_booking_expiry_observation_batch_v1\([\s\S]*?grant execute[\s\S]*?to service_role/i,
  'Keyset worker RPC must remain service-only'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      cursor: ['ticketing_deadline_at', 'booking_id'],
      offsetPagination: false,
      mutableAuditOrder: false,
      compatibilityWrapper: true,
    },
    null,
    2
  )
);
