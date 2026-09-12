import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0068_impexp_pricing_invariants.sql'
);
const originalWallet = read(
  'supabase',
  'migrations',
  '0040_impexp_wallet_and_sync.sql'
);
const protectedSync = read(
  'supabase',
  'migrations',
  '0048_booking_supplier_sync_protection.sql'
);
const ownerConfirm = read(
  'supabase',
  'migrations',
  '0062_impexp_confirm_manual_ticket_operation.sql'
);
const directImport = read(
  'supabase',
  'migrations',
  '0067_impexp_direct_import_charge_authorization.sql'
);
const bookingDb = read('lib', 'db', 'flight-bookings.ts');
const impexpDb = read('lib', 'db', 'impexp.ts');
const ui = read('components', 'dashboard', 'impexp', 'ImpExpPage.tsx');

for (const required of [
  'impexp_pricing_minor_amount_v1',
  'flight_bookings_impexp_pricing_truth_check',
  "pricing_snapshot, 'sellingPrice'",
  "pricing_snapshot, 'supplierTotalPrice'",
  "pricing_snapshot, 'grossPrice'",
  'payment_amount = user_payable_amount',
  'captured_amount in (0, user_payable_amount)',
  'refunded_amount between 0 and captured_amount',
  ') not valid;',
  'flight_bookings_enforce_impexp_pricing',
  'imported User Payable is immutable',
  'imported User Payable currency is immutable',
  'new.supplier_gross_amount',
  'wallet_reservations_enforce_impexp_amount',
  'new.amount is distinct from v_booking.user_payable_amount',
  'wallet_ledger_enforce_impexp_capture_amount',
  "new.transaction_type <> 'booking_confirm'",
  "new.metadata->>'userPayableAmount'",
  "new.metadata->>'supplierGrossAmount'",
]) {
  assert.ok(migration.includes(required), `Imported pricing guard omits ${required}`);
}

const bookingTrigger = migration.match(
  /create or replace function public\.enforce_impexp_booking_pricing_v1\(\)[\s\S]*?end;\r?\n\$\$;/i
)?.[0] ?? '';
assert.ok(bookingTrigger, 'Imported booking pricing trigger was not found');
assert.ok(
  bookingTrigger.includes(
    'new.user_payable_amount is distinct from old.user_payable_amount'
  ),
  'User Payable changes must fail after import'
);
assert.ok(
  !bookingTrigger.includes(
    'new.supplier_gross_amount is distinct from old.supplier_gross_amount'
  ),
  'Supplier Gross must remain refreshable from supplier evidence'
);

for (const source of [originalWallet, ownerConfirm, directImport]) {
  assert.ok(
    source.includes("'booking_confirm'") &&
      source.includes("'userPayableAmount'") &&
      source.includes("'supplierGrossAmount'"),
    'Every imported capture writer must record both price truths'
  );
}
assert.ok(
  originalWallet.includes(
    "'sellingPrice', v_booking.user_payable_amount::numeric / 100"
  ),
  'Supplier Sync must preserve the protected selling price'
);
assert.ok(
  originalWallet.includes('supplier_gross_amount = p_supplier_gross_amount'),
  'Exact supplier Sync must refresh Supplier Gross independently'
);
assert.ok(
  protectedSync.includes('sync_impexp_booking_pre_0048('),
  'Only lifecycle-matching protected Sync may reach the gross refresh writer'
);

for (const required of [
  'row.supplier_gross_amount !== null',
  'importedGrossMinor >= 0',
  'User Payable remains the wallet/payment amount',
]) {
  assert.ok(bookingDb.includes(required), `Public booking read omits ${required}`);
}
for (const required of [
  'row.supplier_gross_amount === null',
  'Number(row.supplier_gross_amount) / 100',
  'row.user_payable_amount === null',
  'Number(row.user_payable_amount) / 100',
]) {
  assert.ok(impexpDb.includes(required), `Import history read omits ${required}`);
}
for (const required of [
  'The supplier amount comes from the airline.',
  'protected sale amount',
  'Import Only — No Wallet Charge',
  'Authorize Import & Charge',
]) {
  assert.ok(ui.includes(required), `Imported pricing UI omits ${required}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      supplierGrossMutableOnlyAsSupplierReference: true,
      userPayableImmutable: true,
      userPayableCurrencyImmutable: true,
      pricingSnapshotBound: true,
      reservationUsesUserPayable: true,
      captureLedgerUsesUserPayable: true,
      captureMetadataRetainsBothAmounts: true,
      historicalRowsRewritten: false,
    },
    null,
    2
  )
);
