import { readFileSync } from 'node:fs';

function source(path) {
  return readFileSync(path, 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const migration = source('supabase/migrations/0031_booking_lifecycle_authority.sql');
const reconciliationMigration = source(
  'supabase/migrations/0033_verified_booking_cancellation_reconciliation.sql'
);
const deadlineMigration = source(
  'supabase/migrations/0034_fix_pnr_dd_mm_deadline_and_hold_email.sql'
);
const chronologyMigration = source(
  'supabase/migrations/0036_correct_ambiguous_pnr_deadline_by_booking_time.sql'
);
const usBanglaDeadlineMigration = source(
  'supabase/migrations/0039_fix_us_bangla_pnr_month_day_deadlines.sql'
);
const issueRoute = source('app/api/flights/booking/issue/route.ts');
const cancelRoute = source('app/api/flights/booking/cancel/route.ts');
const bookingDb = source('lib/db/flight-bookings.ts');
const pnr = source('lib/triplover/pnr.ts');
const dashboard = source('lib/dashboard/data.ts');
const statusModule = source('lib/flights/booking-status.ts');

for (const required of [
  'booking_lifecycle_v',
  'booking_status_events',
  'wallet_begin_booking_issue',
  "status = 'in-progress'",
  "operation_reason = 'ticketing'",
  'begin_booking_cancellation',
  "operation_reason = 'cancellation'",
  'wallet_fail_booking_issue',
  'wallet_begin_legacy_manual_issue',
  'record_booking_supplier_refresh',
  'record_booking_pnr_refresh',
  'record_booking_lifecycle_observations',
]) {
  assert(migration.includes(required), `Lifecycle migration is missing ${required}`);
}

for (const required of [
  'resolve_verified_booking_cancellation',
  'for update',
  "operation_kind = 'reconciliation'",
  "operation_reason = 'legacy_reconciliation'",
  "payment_state <> 'unpaid'",
  'WALLET_STATE_REQUIRES_SEPARATE_RECONCILIATION',
  'VerifiedManualReconciliation',
  'booking.verified_cancellation_reconciled',
  "'supplierApiCalled', false",
  "'walletMutation', false",
  "'cancelledAtPreserved', true",
  'to service_role',
]) {
  assert(
    reconciliationMigration.includes(required),
    `Reconciliation migration is missing ${required}`
  );
}
assert(
  !reconciliationMigration.includes('update public.wallet_') &&
    !reconciliationMigration.includes('insert into public.wallet_ledger_entries'),
  'Verified cancellation reconciliation mutates wallet state'
);

for (const required of [
  'claim_on_hold_booking_email',
  'for update',
  "supplierDateOrder', 'DD/MM/YYYY'",
  'VerifiedDeadlineCorrection',
  'migration-0034-pnr-dd-mm-STR260807000001',
  "'supplierApiCalled', false",
  "'walletMutation', false",
  'to service_role',
]) {
  assert(deadlineMigration.includes(required), `Deadline migration is missing ${required}`);
}
assert(
  !deadlineMigration.includes('update public.wallet_') &&
    !deadlineMigration.includes('insert into public.wallet_ledger_entries'),
  'Deadline correction mutates wallet state'
);
assert(
  pnr.includes('const dayFirst =') &&
    pnr.includes('const monthFirst =') &&
    pnr.includes("carrierCode?.trim().toUpperCase() === 'BS'") &&
    pnr.includes('if (!preferredPlausible && alternatePlausible)') &&
    pnr.includes('const preferMonthFirst ='),
  'PNR parser is not using carrier-aware chronology-safe resolution'
);
for (const required of [
  'for update',
  'booking_submission_time_invariant',
  'VerifiedDeadlineChronologyCorrection',
  'migration-0036-ambiguous-pnr-STR260807000004',
  "'bookingStatusChanged', false",
  "'supplierApiCalledByMigration', false",
  "'walletMutation', false",
]) {
  assert(chronologyMigration.includes(required), `Chronology migration is missing ${required}`);
}
assert(
  !chronologyMigration.includes('update public.wallet_') &&
    !chronologyMigration.includes('insert into public.wallet_ledger_entries'),
  'Chronology correction mutates wallet state'
);
for (const required of [
  "itinerary->>'carrierCode' <> 'BS'",
  "deadline_source <> 'pnr_call'",
  "'supplierDateOrder', 'MM/DD/YYYY'",
  'carrier_specific_pnr_date_order',
  'migration-0039-bs-pnr-month-day-',
  "'supplierApiCalledByMigration', false",
  "'walletMutation', false",
]) {
  assert(
    usBanglaDeadlineMigration.includes(required),
    `US-Bangla deadline migration is missing ${required}`
  );
}
assert(
  !usBanglaDeadlineMigration.includes('update public.wallet_') &&
    !usBanglaDeadlineMigration.includes('insert into public.wallet_ledger_entries'),
  'US-Bangla deadline correction mutates wallet state'
);

assert(
  migration.indexOf("operation_reason = 'ticketing'") <
    migration.indexOf("supplier_operation, idempotency_key"),
  'Ticketing claim does not precede its supplier-operation event'
);
assert(
  issueRoute.includes('beginBookingIssue') &&
    issueRoute.includes('beginLegacyManualIssue') &&
    issueRoute.includes('failBookingIssue'),
  'Issue route is not wired to guarded start/failure operations'
);
assert(
  !issueRoute.includes('queueBookingForManualIssue'),
  'Issue route still creates the obsolete Pending supplier-balance state'
);
assert(
  cancelRoute.includes('beginBookingCancellation') &&
    cancelRoute.includes('readPnr') &&
    cancelRoute.includes('restoreBookingCancellation'),
  'Cancellation does not claim and authoritatively verify refusal recovery'
);
assert(
  pnr.includes('airlinePNRs') && pnr.includes('airlinesPnr:'),
  'PNR parser does not retain airline PNRs'
);
assert(
  bookingDb.includes("const LIFECYCLE_VIEW = 'booking_lifecycle_v'") &&
    dashboard.includes(".from('booking_lifecycle_v')"),
  'Booking consumers are not using the lifecycle view'
);
assert(
  !statusModule.includes("'Un-Confirmed'"),
  'Legacy Un-Confirmed label remains in the canonical status module'
);

function lifecycle({ stored, airlinePnr, deadline, operation, now = 100 }) {
  if (stored === 'cancelled') return 'cancelled';
  if (stored === 'confirmed') return 'confirmed';
  if (stored === 'in-progress' || operation) return 'in-progress';
  if (stored === 'pending') return 'pending';
  if (stored === 'on-hold' && !airlinePnr) return 'unconfirmed';
  if (stored === 'on-hold' && deadline !== null && deadline <= now) return 'expired';
  return 'on-hold';
}

const cases = [
  [{ stored: 'cancelled', airlinePnr: false, deadline: 1, operation: true }, 'cancelled'],
  [{ stored: 'confirmed', airlinePnr: false, deadline: 1, operation: true }, 'confirmed'],
  [{ stored: 'in-progress', airlinePnr: true, deadline: 1, operation: true }, 'in-progress'],
  [{ stored: 'pending', airlinePnr: false, deadline: 1, operation: false }, 'pending'],
  [{ stored: 'on-hold', airlinePnr: false, deadline: 1, operation: false }, 'unconfirmed'],
  [{ stored: 'on-hold', airlinePnr: true, deadline: 99, operation: false }, 'expired'],
  [{ stored: 'on-hold', airlinePnr: true, deadline: 101, operation: false }, 'on-hold'],
];

for (const [input, expected] of cases) {
  assert(lifecycle(input) === expected, `Lifecycle precedence failed for ${expected}`);
}

console.log(JSON.stringify({ checks: 'passed', lifecycleCases: cases.length }, null, 2));
