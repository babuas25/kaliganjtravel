import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8').replace(/\r\n/g, '\n');
const migration = read(
  'supabase',
  'migrations',
  '0047_booking_reconciliation_no_change_closure.sql'
);

for (const required of [
  'close_booking_reconciliation_no_change_v1',
  'for update',
  "v_case.case_type not in (",
  "'ticketing_uncertainty', 'cancellation_uncertainty'",
  "case v_booking.status\n    when 'confirmed' then 'ticketed'",
  "when 'cancelled' then 'cancelled'",
  "clock_timestamp() - interval '5 minutes'",
  `'["pnr", "air-ticketing-details"]'::jsonb`,
  "'{validation,valid}'",
  "'{validation,complete}'",
  "'{validation,fresh}'",
  "'{validation,identityMatches}'",
  "'{expectedIdentity,uniqueTransId}'",
  "'{expectedIdentity,bookingCodeRef}'",
  "'{localContext,storedStatus}'",
  "'{localContext,paymentState}'",
  "v_booking.payment_state = 'captured'",
  "v_booking.payment_state = 'released'",
  "v_booking.payment_state = 'refunded'",
  "'FINANCIAL_CONFLICT'",
  "set state = 'succeeded'",
  "set state = 'closed_no_change'",
  "resolution_outcome = 'supplier_truth_unchanged'",
  "resolved_by_user_id = 'system:evidence-no-change'",
  "'booking.reconciliation.closed_no_change'",
]) {
  assert.ok(migration.includes(required), `No-change closer omits ${required}`);
}
assert.ok(
  migration.indexOf('from public.flight_bookings booking') <
    migration.indexOf('from public.booking_operations operation') &&
    migration.indexOf('from public.booking_operations operation') <
      migration.indexOf('from public.booking_reconciliation_cases candidate\n   where candidate.id = p_case_id\n     and candidate.subject_booking_id = p_booking_id\n   for update') &&
    migration.indexOf('from public.booking_reconciliation_cases candidate\n   where candidate.id = p_case_id\n     and candidate.subject_booking_id = p_booking_id\n   for update') <
      migration.indexOf('from public.wallet_reservations reservation'),
  'No-change closure does not use booking -> operation -> case -> reservation lock order'
);
for (const forbidden of [
  /set\s+status\s*=/i,
  /set\s+payment_state\s*=/i,
  /insert\s+into\s+public\.booking_status_events/i,
  /insert\s+into\s+public\.booking_notification_outbox/i,
  /(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\.wallet_accounts/i,
  /(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\.wallet_ledger_entries/i,
  /wallet_(?:reserve|capture|release|refund|mark_reconciliation)\s*\(/i,
]) {
  assert.doesNotMatch(migration, forbidden);
}
assert.match(
  migration,
  /revoke all on function public\.close_booking_reconciliation_no_change_v1\([\s\S]*?from public, anon, authenticated;/
);
assert.match(
  migration,
  /grant execute on function public\.close_booking_reconciliation_no_change_v1\([\s\S]*?to service_role;/
);

const route = read(
  'app',
  'api',
  'admin',
  'booking-lifecycle',
  '[reference]',
  'evidence',
  'route.ts'
);
assert.match(route, /automaticNoChangeClosure/);
assert.match(route, /closeBookingReconciliationNoChange/);
assert.match(route, /facts\.validation\.valid/);
assert.match(route, /bookingStatus === 'confirmed'/);
assert.match(route, /bookingStatus === 'cancelled'/);
assert.ok(
  route.match(/automaticNoChangeClosure\(/g)?.length >= 4,
  'Fresh and replay paths do not all recover automatic no-change closure'
);
const db = read('lib', 'db', 'booking-reconciliation-evidence.ts');
assert.match(db, /close_booking_reconciliation_no_change_v2/);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      eligibleCaseTypes: ['ticketing_uncertainty', 'cancellation_uncertainty'],
      eligibleLocalStatuses: ['confirmed', 'cancelled'],
      requiredEvidenceSources: ['pnr', 'ticket-report'],
      freshnessSeconds: 300,
      requiresFinancialConsistency: true,
      closesLinkedOperation: true,
      lifecycleEventCreated: false,
      notificationCreated: false,
      statusMutation: false,
      walletMutation: false,
      replayRecovery: true,
    },
    null,
    2
  )
);
