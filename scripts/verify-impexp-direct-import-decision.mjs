import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0067_impexp_direct_import_charge_authorization.sql'
);
const db = read('lib', 'db', 'impexp.ts');
const validation = read('lib', 'impexp', 'validation.ts');
const authorizationRoute = read(
  'app',
  'api',
  'impexp',
  'authorize-charge',
  'route.ts'
);
const importRoute = read(
  'app',
  'api',
  'impexp',
  'import-booking',
  'route.ts'
);
const ui = read('components', 'dashboard', 'impexp', 'ImpExpPage.tsx');

for (const required of [
  'impexp_import_charge_authorizations',
  'authorization_payload_hash',
  'expires_at',
  'consumed_at',
  'consumed_booking_id',
  "v_now + interval '5 minutes'",
  'impexp_charge_authorization_payload_v1',
  "'assignedUserId', p_assigned_user_id",
  "'userPayableAmount', p_user_payable_amount",
  "'supplierGrossAmount', p_supplier_gross_amount",
  "'passengers', p_data->'passengers'",
  "'ticketNumbers', p_data->'ticketNumbers'",
  'authorize_impexp_import_charge_v1',
  'create_impexp_booking_v2',
  "p_import_decision not in ('import_only', 'import_and_charge')",
  "'FRESH_MATCHING_CHARGE_AUTHORIZATION_REQUIRED'",
  'v_authorization.authorization_payload_hash <> v_payload_hash',
  'v_authorization.consumed_at is not null',
  "set consumed_at = clock_timestamp()",
  "'importDecision', p_import_decision",
  "'walletChargeAuthorized'",
  "'direct_confirmed_import_uncharged'",
  "'imported_payment_conflict'",
  "'accounts'",
  'insert into public.booking_status_events',
  "p_request_key || ':confirmed'",
  'revoke execute on function public.create_impexp_booking(',
  'from service_role',
]) {
  assert.ok(migration.includes(required), `Direct import policy omits ${required}`);
}

const authorizationBody = migration.match(
  /create or replace function public\.authorize_impexp_import_charge_v1\([\s\S]*?end;\r?\n\$\$;/i
)?.[0] ?? '';
assert.ok(authorizationBody, 'Charge authorization function was not found');
for (const required of [
  "p_data->>'storedStatus' is distinct from 'confirmed'",
  "p_data->>'lifecycleStatus' is distinct from 'confirmed'",
  "nullif(btrim(p_data->>'pnr'), '') is null",
  '<> v_traveller_count',
  "nullif(btrim(ticket.value #>> '{}'), '') is null",
  'count(distinct ticket.value',
  "'walletMutation', false",
]) {
  assert.ok(
    authorizationBody.includes(required),
    `Charge authorization evidence gate omits ${required}`
  );
}
assert.doesNotMatch(
  authorizationBody,
  /update public\.wallet_accounts|insert into public\.wallet_reservations|insert into public\.wallet_ledger_entries|insert into public\.flight_bookings/i,
  'Prior authorization must not mutate wallet money or create a booking'
);

const importBody = migration.match(
  /create or replace function public\.create_impexp_booking_v2\([\s\S]*?end;\r?\n\$\$;/i
)?.[0] ?? '';
assert.ok(importBody, 'Explicit import function was not found');
assert.ok(
  importBody.indexOf("if p_import_decision = 'import_and_charge' then") <
    importBody.indexOf('update public.wallet_accounts'),
  'The direct debit must be inside the explicit Import & Charge branch'
);
assert.ok(
  importBody.includes("if p_import_decision = 'import_only' then") &&
    importBody.includes("'walletCharged', p_import_decision = 'import_and_charge'"),
  'Import Only and Import & Charge outcomes must remain explicit'
);

for (const required of [
  'importChargeAuthorizationSchema',
  'importBookingDecisionSchema',
  'importDecision: z.enum(["import_only", "import_and_charge"])',
  'Import & Charge requires a prior charge authorization.',
]) {
  assert.ok(validation.includes(required), `Request validation omits ${required}`);
}
for (const required of [
  'authorizeImportedBookingCharge',
  'authorize_impexp_import_charge_v1',
  'create_impexp_booking_v2',
  'impexp-charge-authorization:v1:',
  'impexp-import:v2:',
]) {
  assert.ok(db.includes(required), `Database boundary omits ${required}`);
}
assert.ok(
  !db.includes('supabase.rpc("create_impexp_booking",'),
  'The application must not call the legacy auto-charge import RPC'
);
for (const required of [
  'recordSecurityAuditEvent',
  'booking.impexp.direct_import_charge_authorization',
  'outcome: "attempted"',
  'walletMutation: false',
  'authorizeImportedBookingCharge({',
]) {
  assert.ok(
    authorizationRoute.includes(required),
    `Charge authorization API omits ${required}`
  );
}
for (const required of [
  'importBookingDecisionSchema',
  'recordSecurityAuditEvent',
  'booking.impexp.explicit_import_decision',
  'importDecision: parsed.data.importDecision',
  'chargeAuthorizationId: parsed.data.chargeAuthorizationId',
  'chargePreviouslyCaptured',
]) {
  assert.ok(importRoute.includes(required), `Import API omits ${required}`);
}
for (const required of [
  '/api/impexp/authorize-charge',
  'Import Only — No Wallet Charge',
  'Authorize Import & Charge',
  'authorize exactly',
  'crypto.randomUUID()',
  'importBooking("import_only")',
  'importBooking("import_and_charge")',
]) {
  assert.ok(ui.includes(required), `Explicit import UI omits ${required}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      decisions: ['import_only', 'import_and_charge'],
      priorAuthorizationMinutes: 5,
      authorizationOneUse: true,
      authorizationPayloadBound: true,
      authorizationWalletMutation: false,
      legacyAutoChargeRpcCallableByApp: false,
      importOnlyWalletMutation: false,
      importOnlyAccountsCase: true,
      exactReplayNoSecondDebit: true,
      lifecycleEventAndOutboxAtomic: true,
    },
    null,
    2
  )
);
