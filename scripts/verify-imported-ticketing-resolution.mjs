import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (file) => fs.readFileSync(file, 'utf8');
const migration = read('supabase/migrations/0108_imported_booking_ticketing_resolution.sql');
const staffIssue = read('supabase/migrations/0110_staff_imported_issue_now.sql');
const superAdminResolution = read('supabase/migrations/0107_superadmin_issue_resolution.sql');
const route = read('app/api/impexp/bookings/[reference]/ticketing-resolution/route.ts');
const db = read('lib/db/impexp.ts');
const validation = read('lib/impexp/ticketing-resolution.ts');
const panel = read('components/dashboard/bookings/ImportedBookingTicketingResolutionPanel.tsx');
const page = read('app/(dashboard)/dashboard/bookings/[reference]/page.tsx');
const actions = read('components/flights/BookingActions.tsx');
const permissions = read('lib/wallet/permissions.ts');
const confirmRoute = read('app/api/impexp/confirm-booking/route.ts');
const importRoute = read('app/api/impexp/import-booking/route.ts');
const manualStatusRoute = read('app/api/impexp/manual-booking/[reference]/status/route.ts');

for (const required of [
  'create table if not exists public.imported_ticketing_resolutions',
  'prevent_imported_ticketing_resolution_mutation_v1',
  'before update or delete',
  'grant select on table public.imported_ticketing_resolutions',
  'wallet_begin_imported_booking_issue_v2',
  'imported_ticketing_resolution_context_v1',
  'resolve_imported_booking_ticketing_v1',
  "v_role is null or v_role not in ('staff_support', 'admin', 'superadmin')",
  "accounting_mode in ('active_hold', 'legacy_captured')",
  "decision in ('confirm_ticketed', 'cancel')",
  'IMPORTED_TICKET_EVIDENCE_REQUIRED',
  'IMPORTED_CANCELLATION_DETAILS_REQUIRED',
  'IMPORTED_EFFECT_CONFIRMATION_REQUIRED',
  "v_wallet_effect := 'capture_hold'",
  "v_wallet_effect := 'release_hold'",
  "v_wallet_effect := 'refund'",
  "v_wallet_effect text := 'none'",
  "p_request_key || ':ledger'",
  "p_request_key || ':status'",
  'IMPORTED_RESOLUTION_IDEMPOTENCY_CONFLICT',
  'insert into public.security_audit_events',
  'update_manual_booking_status_legacy_0108',
  'IMPORTED_TICKETING_RESOLUTION_REQUIRED',
]) {
  assert.ok(migration.includes(required), `0108 omits ${required}`);
}
assert.doesNotMatch(
  migration,
  /drop\s+(table|column)|truncate\s|delete\s+from\s+public\./i,
  '0108 must not delete or destructively replace production data',
);
assert.doesNotMatch(
  migration.slice(
    migration.indexOf('create or replace function public.wallet_begin_imported_booking_issue_v2'),
    migration.indexOf('create or replace function public.imported_ticketing_resolution_context_v1'),
  ),
  /booking_confirm|payment_state\s*=\s*'captured'/i,
  'Imported Issue Now must not capture',
);
assert.match(superAdminResolution, /v_booking\.import_source is not null/);
for (const required of [
  "'superadmin', 'admin', 'staff_support'",
  "v_actor_role in ('superadmin', 'admin', 'staff_support')",
  "wallet.owner_type = v_booking.booking_owner_type",
  "wallet.owner_key = v_booking.booking_owner_key",
  "case when v_on_behalf then 'staff' else 'customer' end",
  "'initiatedOnBehalf', v_on_behalf",
  "'INSUFFICIENT_FUNDS'",
  "p_request_key || ':hold'",
  "payment_state = 'held'",
  "status = 'in-progress'",
]) {
  assert.ok(staffIssue.includes(required), `0110 omits ${required}`);
}
assert.ok(!staffIssue.includes("'staff_account'"));
assert.doesNotMatch(
  staffIssue,
  /booking_confirm|payment_state\s*=\s*'captured'/i,
  'Staff Issue Now must Hold rather than capture',
);

for (const required of [
  'canAccessImpExp',
  'bookingScopeFor',
  'readImportedTicketingResolutionContext',
  'resolveImportedTicketing',
  'importedTicketingResolutionSchema',
  'recordSecurityAuditEvent',
  'dispatchBookingStatusEmails',
]) {
  assert.ok(route.includes(required), `Resolution route omits ${required}`);
}
for (const required of [
  'imported_ticketing_resolution_context_v1',
  'resolve_imported_booking_ticketing_v1',
  'majorToMinor',
]) {
  assert.ok(db.includes(required), `Resolution database boundary omits ${required}`);
}
for (const required of [
  'moneyEffectConfirmed: z.literal(true)',
  'ticketNumbers',
  'issuedAt',
  'cancellationAt',
  'reason: z.string()',
  'refundDisposition',
]) {
  assert.ok(validation.includes(required), `Resolution validation omits ${required}`);
}
for (const required of [
  'Available now',
  'Hold now',
  'User Payable',
  'Available before',
  'Available after',
  'Hold before',
  'Hold after',
  'Ticket number',
  'Issued Date & Time',
  'Cancellation Date & Time',
  'I confirm the verified supplier outcome and the exact Available/Hold effect',
]) {
  assert.ok(panel.includes(required), `Resolution panel omits ${required}`);
}
assert.ok(page.includes('ImportedBookingTicketingResolutionPanel'));
assert.match(page, /session\.role === 'superadmin' && !externalBooking/);
assert.match(page, /row\.status !== 'in-progress' && importedFinancialContext/);
assert.ok(actions.includes("'Issue Now'"));
assert.ok(actions.includes('Wallet hold'));
assert.ok(actions.includes('paymentState === \'captured\''));
for (const role of ["'superadmin'", "'admin'", "'staff_support'"]) {
  assert.ok(permissions.includes(role), `Imported Issue Now omits ${role}`);
}
assert.ok(permissions.includes('IMPORTED_ISSUE_STAFF_ROLES'));
assert.match(
  permissions,
  /canConfirmImportedBooking[\s\S]*?canAccessImportedBookingIssue/,
);
assert.ok(confirmRoute.includes('walletOwnerForBooking(booking)'));
assert.match(
  page,
  /session\.role === 'staff_support' && externalBooking/,
);
assert.ok(importRoute.includes('CONFIRMED_IMPORT_REQUIRES_CHARGE'));
assert.ok(manualStatusRoute.includes('IMPORTED_TICKETING_RESOLUTION_REQUIRED'));

// Compile the complete forward migration chain and exercise 0108 with the
// real wallet/lifecycle constraints and triggers. Three historical migrations
// contain assertions for named production rows, so only those terminal data
// correction blocks are omitted in this empty disposable database. The
// pg_cron/pg_net scheduler migration is extension-only and unavailable in
// PGlite; it has no imported-ticketing schema dependency.
const database = new PGlite({ extensions: { pgcrypto } });
await database.exec('create role anon; create role authenticated; create role service_role;');
const migrationDir = path.join(process.cwd(), 'supabase', 'migrations');
const migrationNames = fs.readdirSync(migrationDir)
  .filter((name) => /^\d{4}.*\.sql$/.test(name))
  .sort();
for (const name of migrationNames) {
  if (name.startsWith('0042_')) continue;
  if (name.startsWith('0108_')) continue;
  if (name.startsWith('0110_')) continue;
  let sql = read(path.join(migrationDir, name));
  if (['0034_', '0036_', '0039_'].some((prefix) => name.startsWith(prefix))) {
    sql = sql.slice(0, sql.lastIndexOf(`do $$`));
  }
  await database.exec(sql);
}

await database.exec(`
  insert into public.app_users (clerk_id, role, email)
  values
    ('fixture-support', 'staff_support', 'support@example.test'),
    ('fixture-customer', 'customer', 'customer@example.test'),
    ('fixture-superadmin', 'superadmin', 'superadmin@example.test'),
    ('fixture-admin', 'admin', 'admin@example.test'),
    ('fixture-account', 'staff_account', 'account@example.test'),
    ('fixture-b2b', 'b2b', 'b2b@example.test'),
    ('fixture-b2b-sub', 'b2b_sub', 'b2b-sub@example.test');
  insert into public.agencies (agency_code, owner_user_id)
  values ('ST-B2B999999', 'fixture-b2b');
  update public.app_users
     set agency_code = 'ST-B2B999999'
   where clerk_id in ('fixture-b2b', 'fixture-b2b-sub');
  insert into public.wallets (id, owner_type, owner_key, status)
  values
    (
      '10000000-0000-0000-0000-000000000001',
      'user', 'fixture-customer', 'active'
    ),
    (
      '10000000-0000-0000-0000-000000000002',
      'agency', 'ST-B2B999999', 'active'
    );
  insert into public.wallet_accounts (
    id, wallet_id, currency, available_balance, hold_balance
  ) values
    (
      '20000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      'BDT', 400000, 0
    ),
    (
      '20000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000002',
      'BDT', 100000, 0
    );
`);

const base = {
  provider: 'MANUAL',
  supplierReference: 'FULL-SCHEMA-0108-1',
  initialStatus: 'on-hold',
  currency: 'BDT',
  supplierPayableAmount: 850,
  travelDate: '2026-10-01',
  pnr: 'PNR0108',
  airlinesPnr: ['PNR0108'],
  ticketNumbers: [],
  passengerCounts: { ADT: 1 },
  itinerary: {
    carrierCode: 'BG', carrierName: 'Biman', refundable: false, legs: [],
  },
  fares: [{
    passengerType: 'ADT', count: 1, basePrice: 900, taxes: 50,
    ait: 0, serviceMargin: 0, totalPrice: 950,
  }],
  passengers: {
    travellers: [{
      passengerType: 'ADT', title: 'Mr', firstName: 'Full',
      lastName: 'Schema', gender: 'Male', dateOfBirth: '1990-01-01',
      nationality: 'BD',
    }],
    contact: {
      phone: '01700000000', phoneCountryCode: '+880',
      customerEmail: 'customer@example.test', email: 'customer@example.test',
      countryCode: 'BD', cityName: 'Dhaka',
    },
  },
  passportRequired: false,
  ticketingDeadlineAt: null,
  issuedAt: null,
  supplierMessage: null,
};

async function importOnHold(
  data,
  requestId,
  assignedUserId = 'fixture-customer',
) {
  const call = await database.query(
    `select public.create_manual_booking_v2(
      'fixture-support',$3,95000,90000,85000,
      $1::jsonb,$2
    ) as result`,
    [JSON.stringify(data), `manual-import:v1:${requestId}`, assignedUserId],
  );
  assert.equal(call.rows[0].result.ok, true);
  assert.equal(call.rows[0].result.walletCharged, false);
  return call.rows[0].result.booking.id;
}

// Construct a genuine pre-0108 captured-before-ticketing row with the former
// command, then apply 0108 and prove that a full-refund cancellation remains
// valid under the accumulated production triggers.
const legacyBookingId = await importOnHold(
  { ...base, supplierReference: 'FULL-SCHEMA-LEGACY' },
  '77777777-7777-4777-8777-777777777777',
);
const legacyCapture = await database.query(
  `select public.wallet_confirm_impexp_booking(
    $1::uuid,'fixture-customer','88888888-8888-4888-8888-888888888888'
  ) as result`,
  [legacyBookingId],
);
assert.equal(legacyCapture.rows[0].result.ok, true);
const legacyCapturedState = await database.query(
  'select payment_state from public.flight_bookings where id=$1::uuid',
  [legacyBookingId],
);
assert.equal(legacyCapturedState.rows[0].payment_state, 'captured');
await database.exec(migration);
await database.exec(staffIssue);
const legacyRefund = await database.query(
  `select public.resolve_imported_booking_ticketing_v1(
    $1::uuid,'fixture-support','cancel',$2::jsonb,
    'imported-resolution:v1:99999999-9999-4999-8999-999999999999',true
  ) as result`,
  [legacyBookingId, JSON.stringify({
    cancellationAt: '2026-08-20T09:00:00.000Z',
    cancellationReason: 'Legacy supplier ticket was not issued',
    refundDisposition: 'full_refund',
  })],
);
assert.equal(legacyRefund.rows[0].result.accountingMode, 'legacy_captured');
assert.equal(legacyRefund.rows[0].result.walletEffect, 'refund');

const cancelBookingId = await importOnHold(
  base,
  '11111111-1111-4111-8111-111111111111',
);
const issue = await database.query(
  `select public.wallet_confirm_impexp_booking(
    $1::uuid,'fixture-customer','22222222-2222-4222-8222-222222222222'
  ) as result`,
  [cancelBookingId],
);
assert.equal(issue.rows[0].result.paymentState, 'held');
const cancel = await database.query(
  `select public.resolve_imported_booking_ticketing_v1(
    $1::uuid,'fixture-support','cancel',$2::jsonb,
    'imported-resolution:v1:33333333-3333-4333-8333-333333333333',true
  ) as result`,
  [cancelBookingId, JSON.stringify({
    cancellationAt: '2026-08-20T10:00:00.000Z',
    cancellationReason: 'Supplier ticket was not issued',
  })],
);
assert.equal(cancel.rows[0].result.walletEffect, 'release_hold');

const confirmBookingId = await importOnHold(
  { ...base, supplierReference: 'FULL-SCHEMA-0108-2' },
  '44444444-4444-4444-8444-444444444444',
);
await database.query(
  `select public.wallet_confirm_impexp_booking(
    $1::uuid,'fixture-customer','55555555-5555-4555-8555-555555555555'
  ) as result`,
  [confirmBookingId],
);
const confirm = await database.query(
  `select public.resolve_imported_booking_ticketing_v1(
    $1::uuid,'fixture-support','confirm_ticketed',$2::jsonb,
    'imported-resolution:v1:66666666-6666-4666-8666-666666666666',true
  ) as result`,
  [confirmBookingId, JSON.stringify({
    ticketNumbers: ['123-4567890123'],
    issuedAt: '2026-08-20T11:00:00.000Z',
  })],
);
assert.equal(confirm.rows[0].result.walletEffect, 'capture_hold');
const finalAccount = await database.query(
  `select available_balance, hold_balance
     from public.wallet_accounts
    where id='20000000-0000-0000-0000-000000000001'`,
);
assert.deepEqual(finalAccount.rows[0], {
  available_balance: 305000,
  hold_balance: 0,
});

// Super Admin, Admin, and Support may initiate the same Hold on behalf of a
// B2C owner. Accounts Staff remains forbidden, every operation retains the
// staff actor, and replay never creates a second Hold.
const staffCases = [
  {
    actor: 'fixture-superadmin',
    reference: 'STAFF-ISSUE-SUPERADMIN',
    importRequest: 'a1000000-0000-4000-8000-000000000001',
    issueRequest: 'a2000000-0000-4000-8000-000000000001',
    resolutionRequest: 'a3000000-0000-4000-8000-000000000001',
    confirm: true,
  },
  {
    actor: 'fixture-admin',
    reference: 'STAFF-ISSUE-ADMIN',
    importRequest: 'a1000000-0000-4000-8000-000000000002',
    issueRequest: 'a2000000-0000-4000-8000-000000000002',
    resolutionRequest: 'a3000000-0000-4000-8000-000000000002',
    confirm: false,
  },
  {
    actor: 'fixture-support',
    reference: 'STAFF-ISSUE-SUPPORT',
    importRequest: 'a1000000-0000-4000-8000-000000000003',
    issueRequest: 'a2000000-0000-4000-8000-000000000003',
    resolutionRequest: 'a3000000-0000-4000-8000-000000000003',
    confirm: false,
  },
];
for (const [index, staffCase] of staffCases.entries()) {
  const bookingId = await importOnHold(
    { ...base, supplierReference: staffCase.reference },
    staffCase.importRequest,
  );
  if (index === 0) {
    const beforeForbidden = await database.query(
      `select available_balance, hold_balance
         from public.wallet_accounts
        where id='20000000-0000-0000-0000-000000000001'`,
    );
    const forbidden = await database.query(
      `select public.wallet_confirm_impexp_booking(
        $1::uuid,'fixture-account','a4000000-0000-4000-8000-000000000001'
      ) as result`,
      [bookingId],
    );
    assert.equal(forbidden.rows[0].result.code, 'IMPORTED_ISSUE_FORBIDDEN');
    const afterForbidden = await database.query(
      `select available_balance, hold_balance
         from public.wallet_accounts
        where id='20000000-0000-0000-0000-000000000001'`,
    );
    assert.deepEqual(afterForbidden.rows[0], beforeForbidden.rows[0]);
  }

  const staffIssueResult = await database.query(
    `select public.wallet_confirm_impexp_booking(
      $1::uuid,$2,$3
    ) as result`,
    [bookingId, staffCase.actor, staffCase.issueRequest],
  );
  assert.equal(staffIssueResult.rows[0].result.ok, true);
  assert.equal(staffIssueResult.rows[0].result.paymentState, 'held');
  assert.equal(
    staffIssueResult.rows[0].result.accountId,
    '20000000-0000-0000-0000-000000000001',
  );

  const staffReplay = await database.query(
    `select public.wallet_confirm_impexp_booking(
      $1::uuid,$2,$3
    ) as result`,
    [bookingId, staffCase.actor, staffCase.issueRequest],
  );
  assert.equal(staffReplay.rows[0].result.ok, true);
  assert.equal(staffReplay.rows[0].result.replay, true);

  const operationAudit = await database.query(
    `select actor_user_id, actor_role, source
       from public.booking_operations
      where booking_id=$1::uuid`,
    [bookingId],
  );
  assert.deepEqual(operationAudit.rows[0], {
    actor_user_id: staffCase.actor,
    actor_role:
      staffCase.actor === 'fixture-superadmin'
        ? 'superadmin'
        : staffCase.actor === 'fixture-admin'
          ? 'admin'
          : 'staff_support',
    source: 'staff',
  });
  const holdCount = await database.query(
    `select count(*)::integer as count
       from public.wallet_ledger_entries
      where booking_id=$1::uuid and transaction_type='booking_hold'`,
    [bookingId],
  );
  assert.equal(holdCount.rows[0].count, 1);

  const staffResolution = await database.query(
    `select public.resolve_imported_booking_ticketing_v1(
      $1::uuid,$2,$3,$4::jsonb,$5,true
    ) as result`,
    [
      bookingId,
      staffCase.actor,
      staffCase.confirm ? 'confirm_ticketed' : 'cancel',
      JSON.stringify(
        staffCase.confirm
          ? {
              ticketNumbers: ['123-4567890199'],
              issuedAt: '2026-08-20T12:00:00.000Z',
            }
          : {
              cancellationAt: '2026-08-20T12:00:00.000Z',
              cancellationReason: 'Staff fixture release',
            },
      ),
      `imported-resolution:v1:${staffCase.resolutionRequest}`,
    ],
  );
  assert.equal(
    staffResolution.rows[0].result.walletEffect,
    staffCase.confirm ? 'capture_hold' : 'release_hold',
  );
}

// A B2B sub-user booking must use the shared agency wallet. A second Issue Now
// is rejected for insufficient agency funds before any booking or wallet write.
const agencyBookingId = await importOnHold(
  { ...base, supplierReference: 'STAFF-ISSUE-AGENCY' },
  'b1000000-0000-4000-8000-000000000001',
  'fixture-b2b-sub',
);
const agencyIssue = await database.query(
  `select public.wallet_confirm_impexp_booking(
    $1::uuid,'fixture-support','b2000000-0000-4000-8000-000000000001'
  ) as result`,
  [agencyBookingId],
);
assert.equal(agencyIssue.rows[0].result.ok, true);
assert.equal(
  agencyIssue.rows[0].result.accountId,
  '20000000-0000-0000-0000-000000000002',
);
const insufficientBookingId = await importOnHold(
  { ...base, supplierReference: 'STAFF-ISSUE-AGENCY-INSUFFICIENT' },
  'b1000000-0000-4000-8000-000000000002',
  'fixture-b2b',
);
const insufficient = await database.query(
  `select public.wallet_confirm_impexp_booking(
    $1::uuid,'fixture-admin','b2000000-0000-4000-8000-000000000002'
  ) as result`,
  [insufficientBookingId],
);
assert.equal(insufficient.rows[0].result.code, 'INSUFFICIENT_FUNDS');
const insufficientState = await database.query(
  `select status, payment_state, charged_wallet_account_id
     from public.flight_bookings
    where id=$1::uuid`,
  [insufficientBookingId],
);
assert.deepEqual(insufficientState.rows[0], {
  status: 'on-hold',
  payment_state: 'unpaid',
  charged_wallet_account_id: null,
});
const agencyAccountHeld = await database.query(
  `select available_balance, hold_balance
     from public.wallet_accounts
    where id='20000000-0000-0000-0000-000000000002'`,
);
assert.deepEqual(agencyAccountHeld.rows[0], {
  available_balance: 5000,
  hold_balance: 95000,
});
const agencyRelease = await database.query(
  `select public.resolve_imported_booking_ticketing_v1(
    $1::uuid,'fixture-superadmin','cancel',$2::jsonb,
    'imported-resolution:v1:b3000000-0000-4000-8000-000000000001',true
  ) as result`,
  [agencyBookingId, JSON.stringify({
    cancellationAt: '2026-08-20T13:00:00.000Z',
    cancellationReason: 'Agency fixture release',
  })],
);
assert.equal(agencyRelease.rows[0].result.walletEffect, 'release_hold');

const legacyLedgers = await database.query(
  `select transaction_type, count(*)::integer as count
     from public.wallet_ledger_entries
    where booking_id=$1::uuid
    group by transaction_type`,
  [legacyBookingId],
);
assert.deepEqual(
  Object.fromEntries(legacyLedgers.rows.map((row) => [row.transaction_type, row.count])),
  { booking_confirm: 1, refund: 1 },
);
const ledgers = await database.query(
  `select transaction_type, count(*)::integer as count
     from public.wallet_ledger_entries
    where booking_id in ($1::uuid, $2::uuid)
    group by transaction_type`,
  [cancelBookingId, confirmBookingId],
);
assert.deepEqual(
  Object.fromEntries(ledgers.rows.map((row) => [row.transaction_type, row.count])),
  { booking_confirm: 1, booking_hold: 2, hold_release: 1 },
);
await database.close();

console.log(JSON.stringify({
  checks: 'passed',
  ordinarySuperAdminResolutionExcludesImports: true,
  importedIssueNow: 'Available to Hold',
  authorizedStaffIssueNow: ['superadmin', 'admin', 'staff_support'],
  accountsStaffIssueNow: 'forbidden',
  assignedB2CWalletUsed: true,
  assignedAgencyWalletUsed: true,
  insufficientFundsFailClosed: true,
  activeHoldConfirm: 'Capture exactly once',
  activeHoldCancel: 'Release exactly once',
  legacyCapturedCompatible: true,
  immutableResolutionHistory: true,
  destructiveMigrationOperations: false,
  fullSchemaTriggerExecution: true,
}, null, 2));
