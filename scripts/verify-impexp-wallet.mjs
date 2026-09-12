import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function source(path) {
  return readFileSync(path, 'utf8');
}

function includesAll(text, values, label) {
  for (const value of values) {
    assert.ok(text.includes(value), `${label} is missing: ${value}`);
  }
}

const migration = source('supabase/migrations/0040_impexp_wallet_and_sync.sql');
const importedResolution = source('supabase/migrations/0108_imported_booking_ticketing_resolution.sql');
const staffImportedIssue = source('supabase/migrations/0110_staff_imported_issue_now.sql');
const importRoute = source('app/api/impexp/import-booking/route.ts');
const previewRoute = source('app/api/impexp/preview-booking/route.ts');
const confirmRoute = source('app/api/impexp/confirm-booking/route.ts');
const syncRoute = source('app/api/impexp/sync-booking/route.ts');
const issueRoute = source('app/api/flights/booking/issue/route.ts');
const permissions = source('lib/wallet/permissions.ts');
const walletDb = source('lib/db/wallet.ts');
const importUi = source('components/dashboard/impexp/ImpExpPage.tsx');
const bookingActions = source('components/flights/BookingActions.tsx');
const bookingPage = source('app/(dashboard)/dashboard/bookings/[reference]/page.tsx');
const bookingDb = source('lib/db/flight-bookings.ts');
const chromeRuntime = source('lib/impexp/chrome.server.ts');
const ttinteractive = source('lib/impexp/ttinteractive-manage-booking.server.ts');
const novoair = source('lib/impexp/novoair-manage-booking.server.ts');
const nextConfig = source('next.config.js');
const packageJson = JSON.parse(source('package.json'));

const syncStart = migration.indexOf(
  'create or replace function public.sync_impexp_booking'
);
const confirmStart = migration.indexOf(
  'create or replace function public.wallet_confirm_impexp_booking'
);
const createStart = migration.indexOf(
  'create or replace function public.create_impexp_booking'
);
assert.ok(syncStart >= 0 && confirmStart > syncStart && createStart > confirmStart);
const syncFunction = migration.slice(syncStart, confirmStart);
const confirmFunction = migration.slice(confirmStart, createStart);
const createFunction = migration.slice(createStart);
const importedIssueStart = importedResolution.indexOf(
  'create or replace function public.wallet_begin_imported_booking_issue_v2'
);
const importedContextStart = importedResolution.indexOf(
  'create or replace function public.imported_ticketing_resolution_context_v1'
);
const importedIssueFunction = importedResolution.slice(
  importedIssueStart,
  importedContextStart,
);

const checks = [
  () => includesAll(migration, ['drop view if exists public.booking_lifecycle_v', 'create view public.booking_lifecycle_v'], 'lifecycle view rebuild'),
  () => assert.ok(createFunction.includes("case when v_status = 'confirmed' then 'captured' else 'unpaid' end"), 'Held import must remain unpaid'),
  () => assert.ok(createFunction.indexOf("if v_status = 'confirmed' then") < createFunction.indexOf('update public.wallet_accounts'), 'Direct debit must be confirmed-only'),
  () => assert.ok(createFunction.includes("v_owner_type := 'agency'"), 'B2B imports must use agency ownership'),
  () => assert.ok(createFunction.includes("v_target_role in ('b2b', 'b2b_sub')"), 'B2B sub-users must share agency handling'),
  () => includesAll(migration, ['supplier_gross_amount bigint', 'user_payable_amount bigint'], 'separate imported prices'),
  () => assert.ok(createFunction.includes("'sellingPrice', p_user_payable_amount::numeric / 100"), 'Selling price must be User Payable'),
  () => assert.ok(createFunction.includes("'supplierTotalPrice', p_supplier_gross_amount::numeric / 100"), 'Supplier gross must remain reference pricing'),
  () => assert.ok(importedIssueFunction.includes("status = 'in-progress'"), 'Imported Issue Now must move to In Progress'),
  () => assert.ok(importedIssueFunction.includes("payment_state = 'held'"), 'Imported Issue Now must preserve money in Hold'),
  () => assert.ok(importedIssueFunction.includes("'booking_hold'"), 'Imported Issue Now must create the shared Hold ledger transaction'),
  () => assert.ok(importedIssueFunction.includes('hold_balance = hold_balance + v_booking.user_payable_amount'), 'Imported Issue Now must move User Payable to Hold'),
  () => assert.ok(importedIssueFunction.indexOf("'INSUFFICIENT_FUNDS'") < importedIssueFunction.indexOf('update public.wallet_accounts'), 'Insufficient funds must fail before Hold'),
  () => assert.ok(importedIssueFunction.indexOf("'WALLET_FROZEN'") < importedIssueFunction.indexOf('update public.wallet_accounts'), 'Frozen wallets must fail before Hold'),
  () => includesAll(importedIssueFunction, ["'WALLET_NOT_FOUND'", "'WALLET_ACCOUNT_NOT_FOUND'"], 'missing-wallet handling'),
  () => assert.ok(importedIssueFunction.includes("v_actor_role not in ('customer', 'b2b', 'b2b_sub')"), '0108 owner Issue Now boundary must remain owner-only'),
  () => assert.ok(staffImportedIssue.includes("'superadmin', 'admin', 'staff_support'"), 'Only authorized operations staff may be added to imported Issue Now'),
  () => assert.ok(!staffImportedIssue.includes("'staff_account'"), 'Accounts Staff must remain forbidden from imported Issue Now'),
  () => assert.ok(staffImportedIssue.includes("wallet.owner_type = v_booking.booking_owner_type") && staffImportedIssue.includes("wallet.owner_key = v_booking.booking_owner_key"), 'Staff Issue Now must resolve only the assigned booking owner wallet'),
  () => assert.ok(staffImportedIssue.includes("case when v_on_behalf then 'staff' else 'customer' end"), 'Staff Issue Now must retain staff audit identity'),
  () => assert.ok(importedIssueFunction.includes('v_booking.booking_owner_key = v_actor_agency'), 'Agency authorization must match booking owner'),
  () => assert.ok(importedIssueFunction.includes('v_booking.booking_owner_key = p_actor_user_id'), 'B2C authorization must match booking owner'),
  () => assert.ok(importedIssueFunction.includes("p_request_key || ':hold'"), 'Imported Hold must use the request identity idempotently'),
  () => assert.ok(createFunction.includes('pg_advisory_xact_lock'), 'Concurrent imports must serialize on supplier identity'),
  () => assert.ok(createFunction.includes("v_existing.payment_state <> 'captured'"), 'Unpaid re-import confirmation must not capture'),
  () => assert.ok(createFunction.includes("'IMPORT_PAYABLE_MISMATCH'"), 'Re-import must protect User Payable'),
  () => assert.ok(createFunction.includes("'walletCharged', false"), 'Paid re-import must report zero additional debit'),
  () => assert.ok(!syncFunction.includes('update public.wallet_accounts') && !syncFunction.includes('insert into public.wallet_ledger_entries'), 'Sync must contain no wallet mutation'),
  () => assert.ok(syncFunction.includes("v_booking.status = 'in-progress' and v_supplier_lifecycle = 'confirmed'"), 'Paid In Progress Sync must require supplier confirmation'),
  () => assert.ok(syncFunction.includes("v_new_status := 'in-progress'"), 'Held supplier Sync must preserve In Progress'),
  () => assert.ok(syncFunction.includes("'sellingPrice', v_booking.user_payable_amount::numeric / 100"), 'Sync must preserve User Payable'),
  () => assert.ok(syncFunction.includes("'supplierTotalPrice', v_supplier_gross_major"), 'Sync must update supplier gross separately'),
  () => assert.ok(issueRoute.includes("booking.supplier !== 'triplover'"), 'Normal supplier Issue Ticket must remain blocked for imports'),
  () => includesAll(confirmRoute, ['canAccessImportedBookingIssue', 'walletOwnerForBooking', 'beginImportedBookingIssue'], 'server-side owner or Super Admin Issue Now authorization'),
  () => includesAll(syncRoute, ['canAccessImpExp', 'syncImportedBooking', 'walletCharged: false'], 'operations-only non-financial Sync API'),
  () => assert.ok(!importRoute.includes('ensureSessionWallet') && importRoute.includes('assignedToUserId'), 'Import must never fall back to operator wallet'),
  () => includesAll(importUi, ['Owner (required)', 'Supplier Gross Amount', 'User Payable Amount (required)'], 'required import UI'),
  () => includesAll(bookingActions, ['/api/impexp/confirm-booking', '/api/impexp/sync-booking', 'Issue Now'], 'imported booking actions'),
  () => includesAll(chromeRuntime, ['@sparticuz/chromium-min', 'CHROMIUM_PACK_URL', 'SERVERLESS_CHROMIUM_VERSION = "143.0.4"', 'pack.${architecture}.tar'], 'Hobby-compatible remote Chromium runtime'),
  () => assert.equal(packageJson.dependencies['@sparticuz/chromium-min'], '143.0.4', 'Chromium-min and remote pack versions must remain pinned together'),
  () => assert.ok(!packageJson.dependencies['@sparticuz/chromium'], 'The full Chromium binary package must not be bundled'),
  () => includesAll(nextConfig, ["'@sparticuz/chromium-min'", "'playwright-core'", "'./node_modules/playwright-core/browsers.json'", "'/api/impexp/preview-booking'", "'/api/impexp/import-booking'", "'/api/impexp/sync-booking'"], 'serverless browser runtime tracing'),
  () => assert.ok(!ttinteractive.includes('@sparticuz/chromium') && !novoair.includes('@sparticuz/chromium'), 'Supplier scrapers must use the centralized Chromium resolver'),
];

for (const check of checks) check();

includesAll(previewRoute, ['supplierGross', 'normalizeSupplierBooking'], 'supplier preview');
includesAll(
  permissions,
  ['isExternalBookingSource(booking.import_source)', 'walletOwnerForSession(session)'],
  'ownership permission'
);
includesAll(walletDb, ['wallet_confirm_impexp_booking', 'readWalletForOwner'], 'wallet wrappers');
includesAll(bookingPage, ['canConfirmImportedBooking', 'canAccessImpExp'], 'booking page role gates');
assert.ok(
  bookingDb.includes("const showsImportedSupplierGross =") &&
    bookingDb.includes("Number(row.supplier_gross_amount)") &&
    bookingDb.includes("totalPrice: showsImportedSupplierGross") &&
    bookingDb.includes("User Payable remains the wallet/payment amount") &&
    !bookingDb.includes("agencyGrossFares(storedFares, storedGross, sellingPrice)"),
  'Imported e-tickets must show Supplier Gross without changing User Payable'
);

console.log(
  JSON.stringify(
    {
      checks: checks.length + 5,
      result: 'IMP/EXP wallet, lifecycle, authorization, Sync, and idempotency verification passed',
    },
    null,
    2
  )
);
