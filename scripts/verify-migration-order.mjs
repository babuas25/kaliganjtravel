import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = path.join(root, 'supabase', 'migrations');
const migrationNames = fs.readdirSync(migrationsDir)
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort((left, right) => left.localeCompare(right));

const parsed = migrationNames.map((name) => {
  const match = /^(\d+)_(.+)\.sql$/.exec(name);
  assert.ok(match, `invalid migration filename: ${name}`);
  return { version: match[1], name };
});

const seenVersions = new Set();
for (const migration of parsed) {
  assert.ok(
    !seenVersions.has(migration.version),
    `duplicate migration version: ${migration.version}`
  );
  seenVersions.add(migration.version);
}

const expectedForwardChain = [
  '0090_booking_attempt_response_watchdog.sql',
  '0091_booking_pnr_deadline_refresh_queue.sql',
  '0092_takeoff_manual_ticket_reconciliation.sql',
  '0093_booking_reconciliation_captured_cancellation_confirmation.sql',
  '0094_booking_pnr_echoed_transaction_validation.sql',
  '0095_booking_reconciliation_stale_approved_proposal_supersession.sql',
  '0096_booking_reconciliation_superseded_terminal_compatibility.sql',
];

for (const migration of expectedForwardChain) {
  assert.ok(migrationNames.includes(migration), `missing forward migration: ${migration}`);
}

const forwardIndexes = expectedForwardChain.map((name) => migrationNames.indexOf(name));
for (let index = 1; index < forwardIndexes.length; index += 1) {
  assert.ok(
    forwardIndexes[index - 1] < forwardIndexes[index],
    'forward migration chain is not deterministic'
  );
}

const latestForwardChain = [
  '0097_booking_dashboard_list_performance.sql',
  '0098_booking_dashboard_status_sort.sql',
  '0099_staff_on_behalf_booking.sql',
  '0100_staff_booking_attempt_hold_recovery.sql',
  '0101_on_hold_cancellation_independence.sql',
  '0102_admin_owner_wallet_ticketing.sql',
  '0103_passenger_profiles.sql',
  '0104_booking_dashboard_on_behalf_agency.sql',
  '0105_manual_booking_supplier_payable.sql',
  '0106_superadmin_booking_decisions.sql',
  '0107_superadmin_issue_resolution.sql',
  '0108_imported_booking_ticketing_resolution.sql',
  '0109_supplier_reference_api_import.sql',
  '0110_staff_imported_issue_now.sql',
  '0111_announcement_slider_management.sql',
  '0112_announcement_slider_speed.sql',
  '0113_flight_search_history.sql',
];
const latestIndexes = latestForwardChain.map((name) => {
  const index = migrationNames.indexOf(name);
  assert.ok(index >= 0, `missing latest forward migration: ${name}`);
  return index;
});
for (let index = 1; index < latestIndexes.length; index += 1) {
  assert.ok(
    latestIndexes[index - 1] < latestIndexes[index],
    'latest forward migration chain is not deterministic'
  );
}

assert.ok(
  !migrationNames.includes('0060_booking_reconciliation_captured_cancellation_confirmation.sql'),
  'the duplicate local 0060 reconciliation migration must not remain'
);

const read = (name) => fs.readFileSync(path.join(migrationsDir, name), 'utf8');
const reissuedCancellation = read(expectedForwardChain[3]);
assert.match(reissuedCancellation, /Forward reissue of the later duplicate 0060 migration/);
assert.match(
  reissuedCancellation,
  /confirm_booking_reconciliation_cancelled_captured_v1/
);
assert.match(reissuedCancellation, /record_booking_reconciliation_keep_open_v1/);
const pnrEchoHardening = read(expectedForwardChain[4]);
assert.match(pnrEchoHardening, /PNR_SUPPLIER_UNIQUE_TRANS_ID_MISMATCH/);
assert.match(pnrEchoHardening, /supplierEchoedUniqueTransIds/);
const staleApprovedProposalSupersession = read(expectedForwardChain[5]);
assert.match(
  staleApprovedProposalSupersession,
  /supersede_stale_approved_booking_reconciliation_v1/
);
assert.match(staleApprovedProposalSupersession, /state = 'superseded'/);
assert.match(staleApprovedProposalSupersession, /supersedes_case_id/);
const supersededTerminalCompatibility = read(expectedForwardChain[6]);
assert.match(
  supersededTerminalCompatibility,
  /booking_reconciliation_resolution_contract_v1/
);
const superAdminFoundation = read('0106_superadmin_booking_decisions.sql');
const superAdminResolution = read('0107_superadmin_issue_resolution.sql');
const importedTicketingResolution = read('0108_imported_booking_ticketing_resolution.sql');
assert.match(superAdminFoundation, /classify_superadmin_booking_accounting_v1/);
for (const prerequisiteFunction of [
  'classify_superadmin_booking_accounting_v1',
  'preview_superadmin_booking_decision_v1',
  'execute_superadmin_booking_decision_v1',
]) {
  assert.ok(
    superAdminResolution.includes(prerequisiteFunction),
    `0107 must retain its 0106 dependency: ${prerequisiteFunction}`
  );
}
assert.match(superAdminResolution, /v_booking\.import_source is not null/);
for (const prerequisiteFunction of [
  'wallet_confirm_impexp_booking',
  'update_manual_booking_status_v1',
]) {
  assert.ok(
    importedTicketingResolution.includes(prerequisiteFunction),
    `0108 must replace the imported-ticketing boundary from earlier migrations: ${prerequisiteFunction}`,
  );
}
assert.match(supersededTerminalCompatibility, /PROPOSAL_SUPERSEDED/);
assert.match(
  supersededTerminalCompatibility,
  /wallet_release_reservation[\s\S]*?wallet_refund_booking[\s\S]*?wallet_confirm_impexp_booking[\s\S]*?update_manual_booking_status_v1/
);

for (const prerequisite of [
  '0051_booking_reconciliation_resolution_contracts.sql',
  '0056_booking_reconciliation_captured_cancellation.sql',
  '0058_wallet_reconciliation_release_guard.sql',
  '0059_wallet_reconciliation_refund_guard.sql',
]) {
  assert.ok(migrationNames.includes(prerequisite), `missing prerequisite: ${prerequisite}`);
  assert.ok(
    migrationNames.indexOf(prerequisite) < forwardIndexes[0],
    `prerequisite must precede the forward chain: ${prerequisite}`
  );
}

console.log('migration ordering verification passed');
