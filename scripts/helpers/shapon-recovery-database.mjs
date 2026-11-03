import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { artifactPath, expectedProjectRef, hash, root } from './fresh-database.mjs';

// Kaliganj's installed workdir and history. No Best Deal Trip baseline, project
// identity, reference migration, customer data or environment access is reused.
export { artifactPath, expectedProjectRef, hash, root };
export const workdir = path.join(root, 'supabase/fresh-install');
export const migrationDirectory = path.dirname(artifactPath);
export const publicStatusMigration = '20261103000000_shapon_public_current_status.sql';
export const ticketingRecoveryMigration = '20261103000001_shapon_ticketing_recovery.sql';
export const paymentResolutionMigration = '20261103000002_shapon_payment_resolution.sql';
export const savedSyncMigration = '20261103000003_shapon_saved_supplier_sync_current_status.sql';
export const forwardMigrationNames = [
  '20260911010000_kaliganj_company_contact.sql',
  '20260911020000_kaliganj_payment_methods.sql',
  '20260911030000_ktt_booking_references.sql',
  '20260912000000_kaliganj_head_branch.sql',
  '20260912010000_kt_request_references.sql',
  '20260912020000_kaliganj_support_email.sql',
  '20260912030000_kt_passenger_references.sql',
  '20260915000000_booking_without_pnr_ticketing.sql',
  '20260926000000_shapontravels_read_supplier.sql',
  '20260927000000_shapontravels_hold_booking.sql',
  '20260927010000_shapontravels_supplier_reference.sql',
  '20260927020000_shapon_wallet_refusal_recovery.sql',
  '20260927030000_shapon_saved_reference_ticketing.sql',
  '20260930000000_ktt_daily_booking_references.sql',
  '20260930010000_kaliganj_company_name.sql',
  '20261002000000_agency_wallet_provisioning.sql',
  '20261003000000_shapon_current_status_projection.sql',
  '20261006000000_shapon_public_booking_reference.sql',
  '20261006000100_shapon_compact_current_status.sql',
  '20261008000000_shapontravels_booking_cancellation.sql',
  '20261008010000_bangla_qr_deposits.sql',
  '20261010000000_shapon_external_ticket_confirmation.sql',
  '20261013000000_triplover_supplier_status_confirmation.sql',
  publicStatusMigration,
  ticketingRecoveryMigration,
  paymentResolutionMigration,
  savedSyncMigration,
];
export const migrationNames = [path.basename(artifactPath), ...forwardMigrationNames];
export function verifyMigrationRegistration() {
  assert.deepEqual(fs.readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort(),
    migrationNames, 'Review and register every Kaliganj fresh-install forward migration explicitly');
  assert.equal(new Set(migrationNames.map(name => name.split('_')[0])).size, migrationNames.length,
    'Each installed/forward migration version must be unique');
  const receipt = JSON.parse(fs.readFileSync(path.join(workdir, 'installation.json'), 'utf8'));
  assert.equal(hash(fs.readFileSync(artifactPath, 'utf8')), receipt.baselineSha256,
    'Kaliganj installed baseline is immutable');
}
