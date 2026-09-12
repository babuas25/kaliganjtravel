import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [prepare, submit, statusRoute, permissions, issueRoute, originalMigration, adminIssueMigration, recoveryMigration, onBehalfAgencyMigration, attempts, dashboard, bookingTable, operations, bookingPage, bookingDetails, bookingActions] =
  await Promise.all([
    read('app/api/flights/booking/prepare/route.ts'),
    read('app/api/flights/booking/route.ts'),
    read('app/api/flights/booking/status/route.ts'),
    read('lib/wallet/permissions.ts'),
    read('app/api/flights/booking/issue/route.ts'),
    read('supabase/migrations/0099_staff_on_behalf_booking.sql'),
    read('supabase/migrations/0102_admin_owner_wallet_ticketing.sql'),
    read('supabase/migrations/0100_staff_booking_attempt_hold_recovery.sql'),
    read('supabase/migrations/0104_booking_dashboard_on_behalf_agency.sql'),
    read('lib/db/booking-attempts.ts'),
    read('lib/dashboard/bookings.ts'),
    read('components/dashboard/bookings/BookingsTable.tsx'),
    read('lib/db/booking-operations.ts'),
    read('app/(dashboard)/dashboard/bookings/[reference]/page.tsx'),
    read('components/flights/BookingDetails.tsx'),
    read('components/flights/BookingActions.tsx'),
  ]);

assert.match(prepare, /actorContext\.staffOnBehalf && !reprice\.bookable/);
assert.match(prepare, /actorContext\.staffOnBehalf \? false : !reprice\.bookable/);
assert.match(prepare, /createdByUserId: actorContext\.createdByUserId/);
assert.match(prepare, /userId: actorContext\.ownerUserId/);

assert.match(submit, /current\.staff_on_behalf && offer\.directTicketing/);
assert.ok(
  submit.indexOf('current.staff_on_behalf && offer.directTicketing') <
    submit.indexOf('beginDirectTicket('),
  'staff direct-ticket denial must run before any wallet reservation'
);
assert.match(submit, /walletMutation: false/);
assert.match(
  statusRoute,
  /attempt\.user_id !== session\.clerkId &&[\s\S]*?attempt\.created_by_user_id !== session\.clerkId/
);
assert.match(
  statusRoute,
  /readBookingByAttemptId\([\s\S]*?bookingScopeFor\(session\)/,
  'Booking status recovery must apply the same hidden/scoped reader as My Bookings'
);

assert.match(permissions, /if \(session\.role === 'staff_support'\) return false/);
assert.match(
  permissions,
  /session\.role === 'superadmin' \|\| session\.role === 'admin'\) return true/,
  'SuperAdmin/Admin must be allowed after booking owner and lifecycle checks'
);
assert.ok(
  issueRoute.match(/canIssueBooking\(session, booking\)/g)?.length === 2,
  'issue GET and POST must both enforce the shared permission'
);

assert.match(attempts, /created_by_user_id: input\.createdByUserId/);
assert.match(attempts, /staff_on_behalf: input\.staffOnBehalf/);
assert.match(originalMigration, /new\.status <> 'on-hold'/);
assert.match(originalMigration, /new\.payment_state <> 'unpaid'/);
assert.match(originalMigration, /new\.charged_wallet_account_id is not null/);
assert.match(originalMigration, /coalesce\(new\.captured_amount, 0\) <> 0/);
assert.ok(
  adminIssueMigration.match(/p_actor_role = 'staff_support'/g)
    ?.length >= 2,
  'legacy and v2 wallet issue RPCs must both reject Support'
);
assert.doesNotMatch(
  adminIssueMigration,
  /p_actor_role in \('superadmin', 'admin', 'staff_support'\)/,
  'The current wallet RPC must not retain the obsolete Admin issue denial'
);
assert.match(
  adminIssueMigration,
  /v_booking\.booking_owner_type, v_booking\.booking_owner_key,[\s\S]*?v_amount, v_booking\.currency/,
  'Admin ticketing must reserve the assigned booking owner wallet'
);
assert.match(adminIssueMigration, /'staffIssuedForOwner', p_actor_role in \('superadmin', 'admin'\)/);
assert.match(originalMigration, /booking\.booked_by_user_id/);
assert.match(recoveryMigration, /recover_staff_booking_attempt_hold_v1/);
assert.match(recoveryMigration, /v_actor_role <> 'superadmin'/);
assert.match(recoveryMigration, /v_attempt\.staff_on_behalf/);
assert.match(
  recoveryMigration,
  /p_expected_unique_trans_id is distinct from v_attempt\.unique_trans_id/
);
assert.match(
  recoveryMigration,
  /from public\.wallet_reservations[\s\S]*?booking_attempt_id = p_attempt_id/
);
assert.match(recoveryMigration, /p_outcome->>'status' <> 'held'/);
assert.match(recoveryMigration, /financial_disposition = 'none'/);
assert.match(
  recoveryMigration,
  /grant execute on function public\.recover_staff_booking_attempt_hold_v1[\s\S]*?to service_role/
);
assert.match(dashboard, /Support Team/);
assert.match(dashboard, /B2C User/);
assert.match(dashboard, /creator_agency_name/);
assert.match(dashboard, /booking_agency_name/);
assert.match(dashboard, /For: \$\{bookingAgency\}/);
assert.match(onBehalfAgencyMigration, /booking\.agency_code as booking_agency_code/);
assert.match(onBehalfAgencyMigration, /booking_agency_profile\.agency_name/);
assert.match(bookingTable, /Created By \/ Agency/);
assert.match(bookingTable, /Name, email, or agency/);
assert.match(operations, /const retryDelaysMs = \[0, 150, 400\] as const/);
assert.match(operations, /failed after retries/);
assert.match(bookingPage, /issuingForAssignedOwner=\{/);
assert.match(bookingDetails, /issuingForAssignedOwner=\{issuingForAssignedOwner\}/);
assert.match(bookingActions, /assigned user's wallet/);
assert.match(bookingActions, /!issuingForAssignedOwner &&/);
assert.match(bookingActions, /Choose fare display/);
assert.match(bookingActions, /← Change fare display/);
assert.match(bookingActions, /All Passengers Copy/);
assert.match(bookingActions, /Individual Passenger Copy/);
assert.match(bookingDetails, /: 'Booking Confirmation'/);

console.log('Admin owner-wallet ticketing permission, Support denial, wallet, lifecycle, and audit invariants verified.');
