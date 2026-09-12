import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0072_booking_notification_reentry_policy.sql'
  ),
  'utf8'
);

for (const status of [
  'on-hold',
  'pending',
  'in-progress',
  'expired',
  'unconfirmed',
]) {
  assert.ok(migration.includes(`'${status}'`), `Re-entry policy omits ${status}`);
}
assert.match(
  migration,
  /p_to_lifecycle_status in \([\s\S]*?'on-hold'[\s\S]*?'unconfirmed'[\s\S]*?\)[\s\S]*?p_from_lifecycle_status = p_to_lifecycle_status[\s\S]*?'non_material_same_status'/i,
  'Only same-status non-terminal occurrences should be auto-suppressed'
);
assert.match(
  migration,
  /return query select 'send'::text, null::text, 0/i,
  'Cross-status re-entry must default to a new send occurrence'
);
for (const reason of [
  'historical_baseline',
  'backfill_observation',
  'timestamp_repair',
  'case_only_repair',
]) {
  assert.ok(migration.includes(`'${reason}'`), `Approved suppression omits ${reason}`);
}
assert.match(
  migration,
  /v_disposition = 'audit_only'[\s\S]*?unapproved notification suppression reason/i,
  'Exceptional audit-only suppression must require an approved reason'
);
assert.match(
  migration,
  /v_policy = 'suppress'[\s\S]*?v_state := 'suppressed'[\s\S]*?v_completed_at := v_now/i,
  'Suppressed occurrences must remain completed outbox evidence'
);
assert.match(
  migration,
  /v_policy <> 'suppress'[\s\S]*?new\.to_lifecycle_status in \('confirmed', 'cancelled'\)/i,
  'An audit-only final event cannot supersede a customer-visible grace intent'
);
assert.doesNotMatch(
  migration,
  /delete\s+from\s+public\.booking_(?:status_events|notification_outbox)/i,
  'Re-entry policy cannot delete event or outbox history'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      materialCrossStatusReentry: [
        'on-hold',
        'pending',
        'in-progress',
        'expired',
        'unconfirmed',
      ],
      sameStatusNonTerminal: 'suppressed_with_evidence',
      approvedAuditOnlyReasons: 4,
      terminalFinancialSameStatusStillMaterial: true,
    },
    null,
    2
  )
);
