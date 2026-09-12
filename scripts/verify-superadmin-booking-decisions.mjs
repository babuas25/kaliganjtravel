import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const foundation = read('supabase', 'migrations', '0106_superadmin_booking_decisions.sql');
const resolution = read('supabase', 'migrations', '0107_superadmin_issue_resolution.sql');
const db = read('lib', 'db', 'superadmin-booking-decisions.ts');
const bookingDb = read('lib', 'db', 'flight-bookings.ts');
const route = read('app', 'api', 'admin', 'bookings', '[reference]', 'decision', 'route.ts');
const panel = read('components', 'dashboard', 'bookings', 'SuperAdminBookingDecisionPanel.tsx');
const bookingPage = read('app', '(dashboard)', 'dashboard', 'bookings', '[reference]', 'page.tsx');
const bookingsView = read('components', 'dashboard', 'bookings', 'BookingsView.tsx');
const roles = read('lib', 'roles.ts');
const safetyRedirect = read('app', '(dashboard)', 'dashboard', 'safety-cases', 'page.tsx');
const plan = read('docs', '19-SUPERADMIN-BOOKING-DECISION-PLAN.md');

for (const [name, sql] of [['0106', foundation], ['0107', resolution]]) {
  assert.equal((sql.match(/\$\$/g) ?? []).length % 2, 0, `${name} dollar quotes must balance`);
}

for (const contract of [
  'superadmin_issue_resolution_context_v2',
  'preview_superadmin_issue_resolution_v2',
  'execute_superadmin_issue_resolution_v2',
  'preview_superadmin_manual_financial_resolution_v2',
  'execute_superadmin_manual_financial_resolution_v2',
]) {
  assert.ok(resolution.includes(contract), `${contract} must be present`);
}

// Strict scope: ordinary Triplover B2B/B2C Issue Now only. Historical rows
// remain eligible through this explicit lane without entering normal workers.
assert.match(resolution, /lower\(coalesce\(v_booking\.supplier, ''\)\) <> 'triplover'/);
assert.match(resolution, /v_booking\.import_source is not null/);
assert.match(resolution, /coalesce\(v_booking\.direct_ticketing, false\)/);
assert.match(resolution, /coalesce\(v_booking\.audience, ''\) not in \('b2c', 'agency'\)/);
assert.doesNotMatch(
  resolution.slice(
    resolution.indexOf('create or replace function public.superadmin_issue_resolution_context_v2(', 100)
  ),
  /where id = p_booking_id and not legacy_operational/,
  'The explicit Super Admin context must be able to read retained historical rows'
);
assert.match(resolution, /'legacyOperational', v_booking\.legacy_operational/);
assert.match(resolution, /resolve_superadmin_issue_lifecycle_v2/);
assert.match(resolution, /legacy_operational and status in \([\s\S]*'held'[\s\S]*'on-hold'/);
assert.match(resolution, /v_booking\.status in \('ticketed', 'failed', 'confirmed', 'cancelled'\)/);
assert.match(bookingDb, /readBookingByPublicRefForSuperAdmin/);
assert.match(bookingDb, /from\('flight_bookings'\)/);
assert.match(bookingDb, /case 'ticketed':[\s\S]*return 'confirmed'/);
assert.match(bookingDb, /case 'held':[\s\S]*return 'on-hold'/);
assert.match(bookingsView, /including retained historical bookings/);

// Actual accounting truth, not stale payment_state, controls the normal lane.
assert.match(foundation, /paymentStateStale/);
assert.match(foundation, /transaction_type = 'booking_confirm'/);
assert.match(foundation, /reservation\.state in \('active', 'reconciliation'\)/);
assert.match(resolution, /if p_supplier_outcome = 'ticket_issued'/);
assert.match(resolution, /if v_state = 'paid'[\s\S]*v_effect := 'none'/);
assert.match(resolution, /elsif v_state = 'active_hold'[\s\S]*v_effect := 'capture_hold'/);
assert.match(resolution, /'NO_LOCAL_CAPTURE_SOURCE'/);
assert.match(resolution, /p_supplier_outcome = 'still_valid'[\s\S]*v_effect := 'release_hold'/);
assert.match(resolution, /v_to_status := 'cancelled'[\s\S]*v_state = 'active_hold'[\s\S]*v_effect := 'release_hold'/);
assert.doesNotMatch(
  resolution.slice(
    resolution.indexOf('create or replace function public.preview_superadmin_issue_resolution_v2'),
    resolution.indexOf('create or replace function public.execute_superadmin_hold_outcome_v2')
  ),
  /direct_charge/,
  'The simplified automatic Issue Now lane must not invent a direct charge when local Hold data is missing'
);

// Restoring On Hold releases a real Issue Now Hold instead of preserving it.
assert.match(resolution, /Normal restore\/cancel[\s\S]*v_effect = 'release_hold'/);
assert.match(resolution, /transaction_type[\s\S]*'hold_release'/);
assert.match(resolution, /state = 'released'/);

// The Super Admin effective deadline outranks later supplier refreshes while
// preserving the supplier columns and immutable snapshot.
assert.match(resolution, /superadmin_booking_deadline_overrides/);
assert.match(resolution, /supplier_deadline_snapshot/);
assert.match(resolution, /supplier_time_limit_snapshot/);
assert.match(resolution, /if new\.active_superadmin_deadline_override_id is not null/);
assert.match(resolution, /new\.ticketing_deadline_at := v_override_deadline/);
assert.match(resolution, /new\.supplier_ticketing_deadline_at := new\.ticketing_deadline_at/);

// Manual supplier verification is a distinct immutable, append-only path.
assert.match(resolution, /superadmin_manual_financial_resolutions/);
assert.match(resolution, /before update or delete/);
for (const type of [
  'superadmin_resolution_credit',
  'superadmin_resolution_debit',
  'superadmin_resolution_hold_release',
  'superadmin_resolution_hold_capture',
]) {
  assert.ok(resolution.includes(type), `${type} ledger vocabulary must be present`);
}
assert.match(resolution, /customer_wallet_amount bigint/);
assert.match(resolution, /supplier_amount bigint/);
assert.match(resolution, /'supplierAmountDeterminesCustomerAmount', false/);
assert.match(resolution, /p_manual_effect_confirmed is not true/);
assert.match(resolution, /ISSUE_NOW_CASE_CONFIRMATION_REQUIRED/);
assert.match(resolution, /issue_now_case_confirmed boolean not null/);
assert.match(resolution, /availableBefore/);
assert.match(resolution, /availableAfter/);
assert.match(resolution, /holdBefore/);
assert.match(resolution, /holdAfter/);
assert.match(resolution, /v_request_hash := encode\(sha256/);
assert.match(resolution, /p_request_key \|\| ':ledger'/);
assert.match(resolution, /Re-preview after every relevant lock/);
assert.match(resolution, /v_protected_hold/);
assert.match(resolution, /v_resolvable_hold/);
assert.match(resolution, /MANUAL_ACTIVE_RESERVATION_ACTION_REQUIRED/);
assert.match(resolution, /MANUAL_RESERVATION_AMOUNT_CONFLICT/);
const manualExecutor = resolution.slice(
  resolution.indexOf('create or replace function public.execute_superadmin_manual_financial_resolution_v2'),
  resolution.indexOf('-- 7. One automatic execution boundary')
);
assert.doesNotMatch(
  manualExecutor,
  /insert into public\.wallet_reservations/,
  'Manual resolution must never fabricate a historical Hold/reservation'
);

// New request IDs cannot apply a second final manual effect, while an exact
// retry replays the immutable result.
assert.match(resolution, /last_superadmin_manual_resolution_id is not null/);
assert.match(resolution, /return v_existing\.result \|\| jsonb_build_object\('ok', true, 'replay', true\)/);
assert.match(resolution, /DECISION_IDEMPOTENCY_CONFLICT/);

// Service and UI boundary.
assert.match(route, /session\.role !== 'superadmin'/);
assert.match(route, /mode: z\.literal\('automatic'\)/);
assert.match(route, /mode: z\.literal\('manual'\)/);
assert.match(route, /previewSuperAdminManualFinancialResolution/);
assert.match(route, /executeSuperAdminManualFinancialResolution/);
assert.match(route, /recordSecurityAuditEvent/);
assert.match(route, /dispatchBookingStatusEmails/);
assert.match(db, /superadmin-manual-resolution:v2:/);
assert.match(panel, /Current customer wallet/);
assert.match(panel, /Available before/);
assert.match(panel, /Available after/);
assert.match(panel, /Hold before/);
assert.match(panel, /Hold after/);
assert.match(panel, /Supplier amount is a separate fact/);
assert.match(panel, /never fills or determines the customer-wallet amount/);
assert.match(panel, /Apply Audited Manual Resolution/);
assert.match(panel, /stuck B2B\/B2C Issue Now case I manually verified/);
assert.match(panel, /No evidence upload or second[\s\S]*approval is required/);
assert.match(bookingPage, /readBookingByPublicRefForSuperAdmin/);
assert.match(bookingPage, /canAcquireBookingLifecycleEvidence\(session\.role\)/);
assert.match(bookingPage, /BookingEvidenceReader/);
assert.doesNotMatch(roles, /segment: 'safety-cases'/);
assert.match(safetyRedirect, /redirect\('\/dashboard\/bookings'\)/);
for (const obsolete of [
  ['components', 'dashboard', 'bookings', 'BookingSafetyCasesWorkspace.tsx'],
  ['lib', 'dashboard', 'booking-safety-cases.ts'],
  ['lib', 'db', 'booking-safety-cases.ts'],
]) {
  assert.equal(
    existsSync(join(root, ...obsolete)),
    false,
    `${obsolete.join('/')} must remain retired`
  );
}

assert.match(plan, /Normal Capture\/Release/);
assert.match(plan, /Manual Supplier-Verified Resolution/);
assert.match(plan, /Supplier amount[\s\S]*must never[\s\S]*customer-wallet amount/i);
assert.match(plan, /Do not deploy/);

console.log('Super Admin Issue Now resolution contracts verified.');
