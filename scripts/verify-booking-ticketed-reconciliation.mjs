import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0094_booking_pnr_echoed_transaction_validation.sql'
);
const contracts = read(
  'supabase',
  'migrations',
  '0051_booking_reconciliation_resolution_contracts.sql'
);

for (const required of [
  'resolve_booking_reconciliation_ticketed_v1',
  'booking_reconciliation_resolution_contract_v1',
  "'ticketed'",
  "'capture_existing_hold'",
  "'held', 'reconciliation'",
  "'active', 'reconciliation'",
  "'{validation,authoritativeFor}' = 'ticketed'",
  "'{validation,identityMatches}'",
  "'{evidence,airTicketing,facts,ticketCodeRef}'",
  "'{evidence,airTicketing,facts,ticketNumbers}'",
  "'{evidence,airTicketing,facts,ticketInfoUniqueTransId}'",
  "'{evidence,pnr,facts,supplierEchoedUniqueTransIds}'",
  "'{evidence,airTicketing,facts,supplierBookingId}'",
  "'{validation,ticketedProfile}'",
  "'takeoff_manual_ticket'",
  "'generic'",
  "'SUPPLIER_UNIQUE_TRANS_ID_MISMATCH'",
  "'PNR_SUPPLIER_UNIQUE_TRANS_ID_MISMATCH'",
  "'PNR_SUPPLIER_UNIQUE_TRANS_ID_INVALID'",
  "'SUPPLIER_INTERNAL_BOOKING_ID_REQUIRED'",
  "'MANUAL_TICKET_PROFILE_SUPPLIER_MISMATCH'",
  "p_execution_request_key || ':capture'",
  "'booking_confirm'",
  "set hold_balance = hold_balance - v_reservation.amount",
  "state = 'captured'",
  "status = 'confirmed'",
  "payment_state = 'captured'",
  "state = 'succeeded'",
  "to_lifecycle_status = 'confirmed'",
  "state = 'resolved'",
  "'executionRequestKey', p_execution_request_key",
  "'proposalHash', v_case.proposal_hash",
  "'ledgerEntryId', v_ledger_entry_id",
  "'lifecycleEventId', v_event_id",
  "'supplierIdentifiers', v_supplier_identifiers",
  "'supplierUniqueTransId', v_supplier_unique_trans_id",
  "'supplierInternalBookingId', v_supplier_internal_booking_id",
  'supplier_refs = v_booking.supplier_refs',
  'ticketing_deadline_at = v_booking.ticketing_deadline_at',
]) {
  assert.ok(migration.includes(required), `Ticketed resolution omits ${required}`);
}
assert.match(
  contracts,
  /state = 'resolved'[\s\S]*?resolution->>'executionRequestKey' = p_execution_request_key[\s\S]*?resolution->>'resolutionKind' = p_resolution_kind[\s\S]*?'replay', true/i,
  'Resolution guard must recover exact committed replays before version/freshness checks'
);
assert.doesNotMatch(
  migration.match(
    /resolve_booking_reconciliation_ticketed_v1\([\s\S]*?\)\nreturns jsonb/
  )?.[0] ?? '',
  /ticket_code|ticket_numbers|amount|currency|status/i,
  'Ticketed RPC signature must not accept client-supplied tickets, money, or status'
);
assert.match(
  migration,
  /v_supplier_unique_trans_id\s+is not null[\s\S]*?v_supplier_unique_trans_id\s+<>\s+v_expected_supplier_unique_trans_id[\s\S]*?'SUPPLIER_UNIQUE_TRANS_ID_MISMATCH'/i,
  'Any supplied ticketInfo.uniqueTransID must exactly match the locked booking supplier reference'
);
assert.match(
  migration,
  /v_pnr_supplier_unique_trans_ids := v_evidence\.normalized_facts[\s\S]*?\{evidence,pnr,facts,supplierEchoedUniqueTransIds\}[\s\S]*?jsonb_typeof\(v_pnr_supplier_unique_trans_ids\) <> 'array'[\s\S]*?v_pnr_supplier_unique_trans_id <> v_expected_supplier_unique_trans_id[\s\S]*?'PNR_SUPPLIER_UNIQUE_TRANS_ID_MISMATCH'/i,
  'Any supplier-returned PNR uniqueTransID must be structurally valid and match the locked reference byte-for-byte'
);
assert.match(
  migration,
  /'pnrSupplierEchoedUniqueTransIds', coalesce\([\s\S]*?v_pnr_supplier_unique_trans_ids[\s\S]*?'\[\]'::jsonb/i,
  'PNR supplier echoes must be retained in the resolver audit metadata even when absent'
);
assert.match(
  migration,
  /v_expected_supplier_unique_trans_id := v_booking\.supplier_refs->>'uniqueTransId';[\s\S]*?v_expected_supplier_unique_trans_id <> btrim\(v_expected_supplier_unique_trans_id\)[\s\S]*?v_supplier_unique_trans_id := v_evidence\.normalized_facts[\s\S]*?v_supplier_unique_trans_id <> btrim\(v_supplier_unique_trans_id\)/i,
  'The TakeOff transaction identity comparison must preserve exact casing and whitespace'
);
assert.match(
  migration,
  /if v_is_takeoff_manual_ticket then[\s\S]*?v_booking\.supplier_account is distinct from 'takeoff'[\s\S]*?v_supplier_unique_trans_id is null[\s\S]*?jsonb_typeof\(v_evidence\.normalized_facts[\s\S]*?supplierBookingId\}'\) <> 'number'[\s\S]*?'ISSUED_TIMESTAMP_REQUIRED'/i,
  'The manual profile must be TakeOff-only and require echoed identity, numeric supplier booking ID, and issue time'
);
assert.match(
  migration,
  /elsif v_ticket_code_ref is null then[\s\S]*?'TICKET_EVIDENCE_INCOMPLETE'/i,
  'The generic ticketed path must retain the ticketCodeRef requirement'
);
assert.match(
  migration,
  /pnr = case when v_is_takeoff_manual_ticket then v_booking\.pnr[\s\S]*?supplier_refs = v_booking\.supplier_refs,[\s\S]*?ticketing_deadline_at = v_booking\.ticketing_deadline_at/i,
  'Manual-ticket reconciliation must preserve the locked PNR, supplier refs, and deadline'
);
for (const auditTarget of [
  "insert into public.wallet_ledger_entries",
  'update public.booking_operations',
  'insert into public.booking_status_events',
  'update public.booking_reconciliation_cases',
]) {
  const start = migration.indexOf(auditTarget);
  assert.ok(start >= 0, `Missing audit target: ${auditTarget}`);
  const fragment = migration.slice(start, start + 2400);
  assert.match(
    fragment,
    /supplierIdentifiers[\s\S]*?v_supplier_identifiers/i,
    `${auditTarget} must retain supplier identity metadata`
  );
}
assert.ok(
  migration.indexOf('update public.wallet_accounts') <
    migration.indexOf('update public.flight_bookings') &&
    migration.indexOf('update public.flight_bookings') <
      migration.indexOf('update public.booking_reconciliation_cases'),
  'Locked financial, booking, and case changes must occur in the one RPC transaction'
);
assert.doesNotMatch(
  migration,
  /wallet_capture_reservation\(/i,
  'Reconciliation must not delegate to the generic capture path'
);
assert.doesNotMatch(
  migration,
  /booking_notification_outbox/i,
  'Notification activation remains the explicit P5.15/P7 cutover'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      ticketSource: 'immutable_case_evidence',
      takeoffManualTicketProfile: {
        genericTicketCodeRefRequirementPreserved: true,
        exactEchoedUniqueTransIdRequired: true,
        exactPnrEchoedUniqueTransIdRequiredWhenPresent: true,
        numericSupplierBookingIdRequired: true,
        supplierReferencesAndDeadlinePreserved: true,
        auditMetadataBound: true,
      },
      amountSource: 'locked_wallet_reservation',
      captureAndConfirmAtomic: true,
      operationAndCaseCompleted: true,
      lifecycleEventLinked: true,
      exactReplayRecoverable: true,
      notificationOutboxActivated: false,
    },
    null,
    2
  )
);
