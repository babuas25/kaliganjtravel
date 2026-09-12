import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0048_booking_supplier_sync_protection.sql'
);

for (const required of [
  'record_booking_sync_case_v1',
  'record_booking_supplier_refresh_v2',
  'record_booking_pnr_refresh_v2',
  'sync_impexp_booking_v2',
  'sync_impexp_booking_pre_0048',
  "'supplier_sync'",
  "'supplier_read', 'supplier_read'",
  "'terminal_conflict'",
  "'ticketing_uncertainty'",
  "'cancellation_uncertainty'",
  "'imported_manual_ticketing'",
  "'imported_payment_conflict'",
  "'statusMutation', false",
  "'walletMutation', false",
  "'protectedFromSyncMutation', true",
  "v_supplier_lifecycle is distinct from v_local_lifecycle",
]) {
  assert.ok(migration.includes(required), `Sync protection omits ${required}`);
}

const airConflict = migration.match(
  /if v_conflict then([\s\S]*?)else\r?\n    -- Matching terminal truth/
)?.[1];
assert.ok(airConflict, 'AirTicketingDetails conflict branch is unavailable');
assert.doesNotMatch(airConflict, /set\s+status\s*=/i);
assert.doesNotMatch(airConflict, /ticket_numbers\s*=/i);
assert.doesNotMatch(airConflict, /issued_at\s*=/i);
assert.doesNotMatch(airConflict, /cancelled_at\s*=/i);

const pnrFunction = migration.slice(
  migration.indexOf('create or replace function public.record_booking_pnr_refresh_v2'),
  migration.indexOf('-- Keep the established RPC signatures safe')
);
const pnrConflict = pnrFunction.match(
  /if v_conflict then([\s\S]*?)else\r?\n    update public\.flight_bookings/
)?.[1];
assert.ok(pnrConflict, 'PNR conflict branch is unavailable');
assert.doesNotMatch(pnrConflict, /set\s+status\s*=/i);
assert.doesNotMatch(pnrConflict, /airlines_pnr\s*=/i);
assert.doesNotMatch(pnrConflict, /ticketing_deadline_at\s*=/i);

const importedConflict = migration.match(
  /if v_supplier_lifecycle is distinct from v_local_lifecycle then([\s\S]*?)\r?\n  end if;\r?\n\r?\n  if v_booking\.status in/
)?.[1];
assert.ok(importedConflict, 'Imported conflict branch is unavailable');
assert.doesNotMatch(importedConflict, /set\s+status\s*=/i);
assert.doesNotMatch(importedConflict, /ticket_numbers\s*=/i);
assert.doesNotMatch(importedConflict, /passengers\s*=/i);
const importedConflictUpdate = importedConflict.match(
  /update public\.flight_bookings([\s\S]*?)returning \* into v_updated;/
)?.[1];
assert.ok(importedConflictUpdate, 'Imported protected update is unavailable');
assert.doesNotMatch(importedConflictUpdate, /payment_state\s*=/i);

for (const walletWriter of [
  /update\s+public\.wallet_accounts/i,
  /insert\s+into\s+public\.wallet_ledger_entries/i,
  /update\s+public\.wallet_reservations/i,
  /wallet_(?:capture|release|refund|reserve)\s*\(/i,
]) {
  assert.doesNotMatch(migration, walletWriter);
}
assert.match(
  migration,
  /revoke all on function public\.sync_impexp_booking_pre_0048\([\s\S]*?service_role;/
);
assert.match(
  migration,
  /create or replace function public\.sync_impexp_booking\([\s\S]*?select public\.sync_impexp_booking_v2\(/
);
assert.match(
  migration,
  /create or replace function public\.record_booking_supplier_refresh\([\s\S]*?record_booking_supplier_refresh_v2\(/
);
assert.match(
  migration,
  /create or replace function public\.record_booking_pnr_refresh\([\s\S]*?record_booking_pnr_refresh_v2\(/
);

const flightDb = read('lib', 'db', 'flight-bookings.ts');
assert.match(flightDb, /record_booking_supplier_refresh_v3/);
assert.match(flightDb, /record_booking_pnr_refresh_v3/);
const localTimeLimitMigration = read(
  'supabase',
  'migrations',
  '0083_booking_local_time_limit_requests.sql'
);
assert.match(
  localTimeLimitMigration,
  /record_booking_supplier_refresh_v3[\s\S]*?record_booking_supplier_refresh_v2\(/
);
assert.match(
  localTimeLimitMigration,
  /record_booking_pnr_refresh_v3[\s\S]*?record_booking_pnr_refresh_v2\(/
);
assert.match(flightDb, /p_normalized_evidence: details\.evidence/);
assert.match(flightDb, /p_actor_user_id: session\.clerkId/);
assert.match(flightDb, /p_actor_role: session\.role/);

const refreshRoute = read(
  'app', 'api', 'flights', 'booking', 'refresh-details', 'route.ts'
);
assert.ok(
  (refreshRoute.match(/'ordinary_sync'/g) ?? []).length >= 4,
  'Every ordinary Triplover refresh path must identify itself'
);
const cancellationRoute = read(
  'app', 'api', 'flights', 'booking', 'cancel', 'route.ts'
);
assert.ok(
  (cancellationRoute.match(/'cancellation_verification'/g) ?? []).length >= 2,
  'Cancellation verification reads must remain distinguishable from Sync'
);

const importDb = read('lib', 'db', 'impexp.ts');
assert.match(importDb, /sync_impexp_booking_v2/);
const importRoute = read('app', 'api', 'impexp', 'sync-booking', 'route.ts');
assert.match(importRoute, /reconciliationRequired/);
assert.match(importRoute, /reconciliationCaseId/);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      protectedSyncs: ['air-ticketing-details', 'pnr', 'imported-supplier'],
      conflictingTerminalMutation: false,
      conflictingTicketEvidenceOverwrite: false,
      reconciliationCaseRequired: true,
      immutableObservationRequired: true,
      compatibilityRpcsProtected: true,
      walletMutation: false,
    },
    null,
    2
  )
);
