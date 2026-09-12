import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const migration = read(
  'supabase',
  'migrations',
  '0044_booking_lifecycle_observability.sql'
);
assert.doesNotMatch(
  migration,
  /\b(?:update|delete\s+from|truncate)\s+public\.flight_bookings\b/i,
  'Observability migration must not mutate existing booking truth'
);
assert.ok(
  (migration.match(/on conflict do nothing/gi) ?? []).length >= 6,
  'Every anomaly backfill classifier must be replay-safe'
);
for (const view of [
  'booking_lifecycle_staff_v',
  'booking_lifecycle_metrics_v',
]) {
  assert.match(migration, new RegExp(`revoke all on table public\\.${view}`));
  assert.match(
    migration,
    new RegExp(`grant select on table public\\.${view} to service_role`)
  );
}
const staffView = migration.slice(
  migration.indexOf('create or replace view public.booking_lifecycle_staff_v'),
  migration.indexOf('create or replace view public.booking_lifecycle_metrics_v')
);
for (const [label, forbidden] of [
  ['booking.passengers', /\bbooking\.passengers\b/],
  ['booking.contact_email', /\bbooking\.contact_email\b/],
  ['primary_case.evidence', /\bprimary_case\.evidence\b(?!_)/],
  ['primary_case.proposal', /\bprimary_case\.proposal\b/],
  ['primary_case.resolution', /\bprimary_case\.resolution\b/],
  ['recipient_address', /\brecipient_address\b/],
]) {
  assert.doesNotMatch(staffView, forbidden, `Staff view must not expose ${label}`);
}

const dtoPath = path.join(
  process.cwd(),
  'lib',
  'dashboard',
  'booking-lifecycle.ts'
);
const dtoSource = fs.readFileSync(dtoPath, 'utf8');
const transpiled = ts.transpileModule(dtoSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: dtoPath,
  reportDiagnostics: true,
});
const compileErrors = (transpiled.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
);
assert.equal(compileErrors.length, 0, 'Staff lifecycle DTO must transpile');
const dtoModule = { exports: {} };
new vm.Script(transpiled.outputText, { filename: dtoPath }).runInNewContext({
  module: dtoModule,
  exports: dtoModule.exports,
  require,
});
const {
  bookingLifecycleAccessForRole,
  canRefreshBookingSupplierDetails,
  staffBookingLifecycle,
} =
  dtoModule.exports;

assert.equal(bookingLifecycleAccessForRole('superadmin'), 'admin');
assert.equal(bookingLifecycleAccessForRole('admin'), 'admin');
assert.equal(bookingLifecycleAccessForRole('staff_support'), 'support');
assert.equal(bookingLifecycleAccessForRole('staff_account'), 'accounts');
for (const role of ['customer', 'b2b', 'b2b_sub', 'staff_media']) {
  assert.equal(
    bookingLifecycleAccessForRole(role),
    null,
    `${role} must not cross the staff lifecycle boundary`
  );
}

for (const role of ['superadmin', 'admin', 'staff_support', 'staff_account']) {
  assert.equal(
    canRefreshBookingSupplierDetails(role),
    true,
    `${role} must be able to run the manual supplier refresh`
  );
}
for (const role of ['customer', 'b2b', 'b2b_sub', 'staff_media']) {
  assert.equal(
    canRefreshBookingSupplierDetails(role),
    false,
    `${role} must not be able to run the manual supplier refresh`
  );
}

const fixture = new Proxy(
  {
    booking_id: 'booking',
    public_ref: 'STR260811000001',
    supplier: 'triplover',
    import_source: null,
    stored_status: 'in-progress',
    lifecycle_status: 'in-progress',
    booked_at: '2026-08-11T10:00:00Z',
    booking_updated_at: '2026-08-11T10:00:00Z',
    payment_state: 'captured',
    payment_amount: 10000,
    captured_amount: 10000,
    refunded_amount: 0,
    currency: 'BDT',
    operation_id: 'operation',
    operation_kind: 'ticketing',
    operation_state: 'needs_reconciliation',
    operation_reason_code: 'supplier_uncertain',
    operation_reason_detail: 'Operational narrative',
    operation_actor_user_id: 'actor',
    operation_actor_role: 'staff_support',
    primary_case_id: 'case',
    primary_case_type: 'ticketing_uncertainty',
    primary_case_state: 'open',
    primary_case_reason_detail: 'Case narrative',
    financial_disposition: 'none',
    reservation_id: 'reservation',
    reservation_amount: 10000,
    staff_attention_required: true,
  },
  { get: (target, key) => (key in target ? target[key] : null) }
);
const support = staffBookingLifecycle(fixture, 'support');
const accounts = staffBookingLifecycle(fixture, 'accounts');
const admin = staffBookingLifecycle(fixture, 'admin');
assert.equal(support.operation.reasonDetail, 'Operational narrative');
assert.ok(!('capturedAmount' in support.payment));
assert.ok(!('financialDisposition' in support.reconciliation));
assert.ok(!('reasonDetail' in accounts.operation));
assert.ok(!('actorUserId' in accounts.operation));
assert.equal(accounts.payment.capturedAmount, 10000);
assert.equal(accounts.reconciliation.financialDisposition, 'none');
assert.equal(admin.operation.actorUserId, 'actor');
assert.equal(admin.payment.reservation.amount, 10000);
assert.doesNotMatch(
  JSON.stringify({ support, accounts, admin }),
  /passengers|contact|recipient|supplier_evidence|"evidence"|"proposal"/i,
  'Normalized DTO contains a forbidden sensitive field'
);

for (const route of [
  read('app', 'api', 'admin', 'booking-lifecycle', 'route.ts'),
  read(
    'app',
    'api',
    'admin',
    'booking-lifecycle',
    '[reference]',
    'timeline',
    'route.ts'
  ),
  read(
    'app',
    'api',
    'admin',
    'booking-lifecycle',
    'metrics',
    'route.ts'
  ),
]) {
  assert.match(route, /getDashboardSession\(\)/);
  assert.match(route, /bookingLifecycleAccessForRole\(session\.role\)/);
  assert.match(route, /Cache-Control': 'no-store'/);
}

const supplierRefreshRoute = read(
  'app',
  'api',
  'flights',
  'booking',
  'refresh-details',
  'route.ts'
);
assert.match(
  supplierRefreshRoute,
  /canRefreshBookingSupplierDetails\(session\.role\)/,
  'Supplier refresh API must enforce the shared staff-role permission'
);
assert.match(
  supplierRefreshRoute,
  /bookingScopeFor\(session\)/,
  'Supplier refresh API must read only a booking visible to the caller'
);
assert.doesNotMatch(
  supplierRefreshRoute,
  /session\.role !== 'superadmin'/,
  'Supplier refresh must not remain Super Admin-only'
);

const bookingDetailsPage = read(
  'app',
  '(dashboard)',
  'dashboard',
  'bookings',
  '[reference]',
  'page.tsx'
);
assert.match(
  bookingDetailsPage,
  /allowSupplierRefresh=\{[\s\S]*canRefreshBookingSupplierDetails\(session\.role\)/,
  'Booking view must expose refresh only to authorized staff'
);
const bookingActions = read('components', 'flights', 'BookingActions.tsx');
assert.match(
  bookingActions,
  /allowSupplierRefresh \|\| allowImportedSync/,
  'Quick actions must retain the manual supplier-refresh button gate'
);
assert.match(
  bookingActions,
  /Refresh Ticket Details/,
  'Quick actions must label the manual supplier refresh clearly'
);

const publicBookingSource = read('lib', 'flights', 'booking.ts');
const publicType = publicBookingSource.slice(
  publicBookingSource.indexOf('export type PublicBooking ='),
  publicBookingSource.indexOf('export type PrivateBookingRefs')
);
assert.doesNotMatch(
  publicType,
  /operationKind|operationReason|operationStarted|reconciliationCase|evidence|assignee|activeOperation/i,
  'Customer PublicBooking type exposes lifecycle internals'
);
const serializerSource = read('lib', 'db', 'flight-bookings.ts');
const serializer = serializerSource.slice(
  serializerSource.indexOf('export function publicBooking('),
  serializerSource.indexOf('/** Adds the owning B2B partner')
);
assert.match(
  serializer,
  /export function publicBooking\(row: BookingRow\): PublicBooking/,
  'Customer serializer must retain the checked PublicBooking return contract'
);
assert.match(
  serializer,
  /statusMessage:\s*customerStatusMessage\(/,
  'Customer serializer must translate internal operation inputs into safe copy'
);
assert.doesNotMatch(
  serializer,
  /\.\.\.row/,
  'Customer serializer must not spread internal booking columns into its output'
);

const table = read(
  'components',
  'dashboard',
  'bookings',
  'BookingsTable.tsx'
);
for (const required of [
  'operationKind',
  'operationState',
  'operationElapsedSeconds',
  'dueAt',
  'paymentConflictCode',
]) {
  assert.ok(table.includes(required), `Dashboard indicator omits ${required}`);
}
assert.doesNotMatch(
  table,
  /Unassigned/,
  'Routing-only reconciliation UI must not imply individual assignment exists'
);
for (const metric of [
  'open_case_count',
  'aged_operation_count',
  'aged_attempt_count',
  'sla_breach_count',
  'terminal_conflict_count',
  'wallet_inconsistency_count',
]) {
  assert.ok(migration.includes(metric), `Metrics view omits ${metric}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      replaySafeBackfill: true,
      bookingTruthMutation: false,
      staffRoleMasking: true,
      customerInternalMetadata: false,
      dashboardIndicators: true,
      healthMetrics: 6,
    },
    null,
    2
  )
);
