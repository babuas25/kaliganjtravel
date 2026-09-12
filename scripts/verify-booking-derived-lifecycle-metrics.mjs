import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0081_booking_derived_lifecycle_metrics.sql'
);
const db = read('lib', 'db', 'booking-lifecycle-metrics.ts');
const type = read('lib', 'dashboard', 'booking-lifecycle-metrics.ts');
const ui = read(
  'components',
  'dashboard',
  'bookings',
  'BookingLifecycleMetricsPanel.tsx'
);

for (const required of [
  'booking_derived_lifecycle_metrics_v',
  'due_expiry_count',
  'oldest_due_deadline_at',
  'max_expiry_overdue_seconds',
  "interval '30 minutes'",
  'starved_expiry_count',
  'unconfirmed_repair_count',
  'average_detection_latency_seconds',
  'percentile_cont(0.95)',
  'p95_detection_latency_seconds',
  'max_detection_latency_seconds',
  'failed_runs_24h',
  'bounded_runs_24h',
  'stale_running_runs',
  'last_successful_run_at',
]) {
  assert.ok(migration.includes(required), `Derived metrics omit ${required}`);
}
const view = migration.slice(
  migration.indexOf('create or replace view public.booking_derived_lifecycle_metrics_v'),
  migration.indexOf('revoke all on table public.booking_derived_lifecycle_metrics_v')
);
assert.doesNotMatch(
  view,
  /public_ref|booking_reference|recipient|email|phone|passenger/i,
  'Aggregate derived-lifecycle metrics must not expose customer identity'
);
assert.match(
  migration,
  /with \(security_invoker = true\)[\s\S]*?grant select on table public\.booking_derived_lifecycle_metrics_v to service_role/i
);
assert.ok(
  db.includes(".from('booking_derived_lifecycle_metrics_v')") &&
    type.includes('p95DetectionLatencySeconds: number') &&
    ui.includes("label: 'Expiry backlog'") &&
    ui.includes("label: 'Expiry starved'") &&
    ui.includes("label: 'Sweep failures'") &&
    ui.includes("label: 'Unconfirmed repair'"),
  'Staff lifecycle health must surface derived observation health'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      backlogMetrics: true,
      starvationThresholdMinutes: 30,
      detectionLatencyWindowHours: 24,
      workerFailureMetrics: true,
      customerIdentityExposed: false,
      staffUiIntegrated: true,
    },
    null,
    2
  )
);
