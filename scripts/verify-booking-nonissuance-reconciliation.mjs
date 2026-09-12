import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8').replace(/\r\n/g, '\n');
const migration = read(
  'supabase',
  'migrations',
  '0053_booking_reconciliation_nonissuance_release.sql'
);
const proposal = read(
  'supabase',
  'migrations',
  '0050_booking_reconciliation_maker_checker.sql'
);
const actions = read('lib', 'db', 'booking-reconciliation-actions.ts');
const route = read(
  'app',
  'api',
  'admin',
  'booking-lifecycle',
  '[reference]',
  'reconciliation',
  'nonissuance-attestation',
  'route.ts'
);

for (const required of [
  'record_booking_nonissuance_attestation_v1',
  "'held_plus_no_ticket_record'",
  "'supplier_confirmed_unissued'",
  "'supplier_portal_nonissuance_attestation'",
  "'portalEvidenceHash'",
  "sha256(convert_to(v_facts::text, 'UTF8'))",
  "'automaticResolution', false",
  "'statusMutation', false",
  "'walletMutation', false",
  'resolve_booking_reconciliation_nonissuance_v1',
  "'release_existing_hold'",
  'confirm_held_nonissuance_basis',
  'confirm_manual_resolution_basis',
  "'PORTAL_NONISSUANCE_ATTESTATION_REQUIRED'",
  "'ATTESTATION_EVIDENCE_MISMATCH'",
  "p_execution_request_key || ':release'",
  "'hold_release'",
  'available_balance = available_balance + v_reservation.amount',
  'hold_balance = hold_balance - v_reservation.amount',
  "state = 'released'",
  "set status = 'on-hold'",
  "payment_state = 'released'",
  "state = 'failed'",
  "resolution_outcome = 'held_not_ticketed'",
]) {
  assert.ok(migration.includes(required), `Non-issuance workflow omits ${required}`);
}
assert.match(
  proposal,
  /p_proposed_outcome = 'held_not_ticketed'[\s\S]*?confirm_held_nonissuance_basis[\s\S]*?confirm_manual_resolution_basis/i,
  'Held non-issuance proposals must bind both the outcome and manual portal basis'
);
assert.match(
  migration,
  /v_to_lifecycle := public\.resolve_booking_lifecycle\(\s*'on-hold',[\s\S]*?v_booking\.ticketing_deadline_at, null\s*\)/i,
  'Released non-issuance must store On Hold and derive On Hold/Expired/Unconfirmed'
);
const attestationBody = migration.match(
  /create or replace function public\.record_booking_nonissuance_attestation_v1\([\s\S]*?end;\n\$\$;/i
)?.[0] ?? '';
assert.ok(attestationBody, 'Attestation function body was not found');
for (const forbidden of [
  /update public\.flight_bookings/i,
  /update public\.wallet_/i,
  /insert into public\.wallet_ledger_entries/i,
  /update public\.booking_reconciliation_cases/i,
]) {
  assert.doesNotMatch(
    attestationBody,
    forbidden,
    'Attestation must append evidence only and cannot execute its own outcome'
  );
}
assert.doesNotMatch(
  migration.match(
    /resolve_booking_reconciliation_nonissuance_v1\([\s\S]*?\)\nreturns jsonb/
  )?.[0] ?? '',
  /amount|currency|status|release_reason/i,
  'Non-issuance RPC signature must not accept client-supplied money or status'
);
assert.ok(
  actions.includes('record_booking_nonissuance_attestation_v1'),
  'Server wrapper must call only the controlled attestation RPC'
);
for (const required of [
  'canAcquireBookingLifecycleEvidence',
  "'bookingReconciliationWrite'",
  "outcome: 'attempted'",
  'RECONCILIATION_AUDIT_UNAVAILABLE',
  'recordBookingNonissuanceAttestation',
  'rawPortalEvidenceStored: false',
]) {
  assert.ok(route.includes(required), `Attestation route omits ${required}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      heldPnrAloneReleasesFunds: false,
      portalAttestationRequired: true,
      portalEvidenceStoredRaw: false,
      attestationMutatesLifecycleOrWallet: false,
      releaseAndProjectionAtomic: true,
      possiblePublicProjections: ['on-hold', 'expired', 'unconfirmed'],
    },
    null,
    2
  )
);
