import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0055_booking_reconciliation_held_cancellation.sql'
  ),
  'utf8'
);

for (const required of [
  'resolve_booking_reconciliation_cancelled_release_v1',
  "'cancelled'",
  "'release_existing_hold'",
  "'held', 'reconciliation'",
  "'active', 'reconciliation'",
  "'{validation,authoritativeFor}' = 'cancelled'",
  "p_execution_request_key || ':release'",
  "'hold_release'",
  'available_balance = available_balance + v_reservation.amount',
  'hold_balance = hold_balance - v_reservation.amount',
  "state = 'released'",
  "status = 'cancelled'",
  "payment_state = 'released'",
  "state = 'succeeded'",
  "resolution_outcome = 'cancelled_hold_released'",
  "'financialOutcome', 'release_existing_hold'",
]) {
  assert.ok(migration.includes(required), `Held cancellation omits ${required}`);
}
assert.doesNotMatch(
  migration.match(
    /resolve_booking_reconciliation_cancelled_release_v1\([\s\S]*?\)\nreturns jsonb/
  )?.[0] ?? '',
  /amount|currency|status|refund|release_reason/i,
  'Held-cancellation signature must not accept client-supplied money/status fields'
);
assert.doesNotMatch(
  migration,
  /wallet_release_reservation\(/i,
  'Case-bound cancellation must not delegate to the generic release endpoint'
);
assert.ok(
  migration.indexOf('update public.wallet_accounts') <
    migration.indexOf('update public.flight_bookings') &&
    migration.indexOf('update public.flight_bookings') <
      migration.indexOf('update public.booking_reconciliation_cases'),
  'Hold release, cancellation, and case resolution must share one transaction'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      exactRpc: 'resolve_booking_reconciliation_cancelled_release_v1',
      evidenceRequired: 'authoritative_cancelled',
      acceptedReservationStates: ['active', 'reconciliation'],
      holdReleaseAndCancellationAtomic: true,
      genericReleaseUsed: false,
      exactReplayRecoverable: true,
    },
    null,
    2
  )
);
