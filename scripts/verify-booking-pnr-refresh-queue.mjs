import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const migration = read(
  'supabase',
  'migrations',
  '0091_booking_pnr_deadline_refresh_queue.sql'
);
const worker = read('lib', 'db', 'booking-pnr-refresh.ts');
const scheduler = read('app', 'api', 'cron', 'booking-status-emails', 'route.ts');
const refreshRoute = read(
  'app', 'api', 'flights', 'booking', 'refresh-details', 'route.ts'
);
const cancelRoute = read(
  'app', 'api', 'flights', 'booking', 'cancel', 'route.ts'
);
const evidenceRead = read('lib', 'booking-lifecycle', 'supplier-evidence-read.ts');

for (const required of [
  'create table public.booking_pnr_refresh_jobs',
  "carrier_group in ('bs_immediate', 'non_bs_delayed')",
  "state in ('pending', 'running', 'completed', 'exhausted', 'skipped')",
  'create trigger flight_bookings_enqueue_pnr_refresh_job_v1',
  'after insert on public.flight_bookings',
  'create or replace function public.claim_due_booking_pnr_refresh_job_v1',
  'for update of job skip locked',
  'create or replace function public.finish_booking_pnr_refresh_job_v1',
  "p_outcome not in ('deadline_found', 'deadline_missing', 'retryable_error', 'skipped')",
  'no backfill',
]) {
  assert.ok(migration.includes(required), `PNR refresh queue misses: ${required}`);
}

// BS is immediately eligible then retries at +1 and +3 minutes. Every other
// carrier starts at +2 and receives retries at +4 and +6 minutes.
for (const required of [
  "when 'bs_immediate' then p_booked_at",
  "p_booked_at + interval '2 minutes'",
  "p_booked_at + interval '1 minute'",
  "p_booked_at + interval '3 minutes'",
  "p_booked_at + interval '4 minutes'",
  "p_booked_at + interval '6 minutes'",
  "clock_timestamp() + interval '2 minutes'",
]) {
  assert.ok(migration.includes(required), `PNR retry timing misses: ${required}`);
}

assert.doesNotMatch(
  migration,
  /update\s+public\.flight_bookings/i,
  'Queue migration must not reconcile or rewrite existing flight bookings'
);
assert.doesNotMatch(worker, /readPnr|syncPnrDetails|bookFlight\(/,
  'Retired automatic workers must not call the supplier');
assert.match(worker, /finishJob\(job\.job_id, 'skipped', 'STORED_REFERENCE_TICKETING'\)/);
const currentMigration = read('supabase', 'migrations', '0163_booking_without_pnr_ticketing.sql');
assert.match(currentMigration, /completion_reason = 'stored_reference_ticketing'/);
assert.match(currentMigration, /create or replace function public\.enqueue_booking_pnr_refresh_job_v1\(\)[\s\S]*?begin\s+return new;/);
assert.match(scheduler, /rollout\.pnrDeadlineRefresh[\s\S]*?processBookingPnrRefreshJob\(\)/);

for (const source of [refreshRoute, cancelRoute, evidenceRead]) {
  assert.match(source, /pnrLookupLocators\(/);
  assert.doesNotMatch(
    source,
    /pnr:\s*supplierPnr[\s\S]{0,120}bookingRefNumber:\s*supplierPnr/
  );
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      legacyBsScheduleMinutes: [0, 1, 3],
      legacyNonBsScheduleMinutes: [2, 4, 6],
      maxSupplierPnrReadsPerBooking: 0,
      earlyNonBsNullFinal: false,
      bookReplay: false,
      existingBookingBackfill: false,
    },
    null,
    2
  )
);
