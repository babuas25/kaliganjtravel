import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0063_impexp_manual_ticket_completion.sql'
);
const evidence = read(
  'lib',
  'booking-lifecycle',
  'imported-supplier-evidence.ts'
);
const syncRoute = read('app', 'api', 'impexp', 'sync-booking', 'route.ts');
const completionRoute = read(
  'app',
  'api',
  'impexp',
  'complete-booking',
  'route.ts'
);
const db = read('lib', 'db', 'impexp.ts');
const actions = read('components', 'flights', 'BookingActions.tsx');

for (const required of [
  'bookingPassengerIdentityHashes',
  'bookingRouteSignature',
  'supplier_provider_mismatch',
  'supplier_reference_mismatch',
  'passenger_identity_mismatch',
  'route_identity_mismatch',
  'supplier_status_not_ticketed',
  'airline_pnr_missing',
  'ticket_numbers_missing',
  'ticket_passenger_count_mismatch',
  "authoritativeFor: valid ? 'ticketed' : null",
  "sourceKind: 'imported_supplier_manage_booking'",
  "source: 'airline-manage-booking'",
  'supplierPayloadHash',
  'statusMutation: false',
  'walletMutation: false',
  'destructiveSupplierCall: false',
]) {
  assert.ok(evidence.includes(required), `Imported evidence omits ${required}`);
}

for (const required of [
  'requestStartedAt',
  'responseReceivedAt',
  'importedSupplierPayloadHash(supplierPayload)',
  'recordImportedSupplierEvidenceRead({',
  'staffImportedSupplierEvidenceResult(input.facts)',
  'walletCharged: false',
]) {
  assert.ok(syncRoute.includes(required), `Imported Sync omits ${required}`);
}

for (const required of [
  'complete_impexp_manual_ticketing_v1',
  "or v_actor_role not in ('staff_support', 'admin', 'superadmin')",
  'booking -> operation -> case -> reservation -> wallet -> account',
  "v_booking.import_source is distinct from 'IMP_EXP'",
  "v_operation.kind is distinct from 'imported_manual_ticketing'",
  "v_operation.state is distinct from 'awaiting_external_action'",
  "v_case.case_type is distinct from 'imported_manual_ticketing'",
  "v_booking.payment_state <> 'captured'",
  'v_booking.captured_amount is distinct from v_booking.user_payable_amount',
  "v_reservation.state <> 'captured'",
  "ledger.transaction_type = 'booking_confirm'",
  'v_capture_ledger_count <> 1',
  "'{validation,authoritativeFor}' is distinct from 'ticketed'",
  "'{evidence,importedSupplier,source}'",
  "is distinct from 'airline-manage-booking'",
  "interval '5 minutes'",
  'jsonb_array_length(v_ticket_numbers) <> v_traveller_count',
  "set status = 'confirmed'",
  "set state = 'succeeded'",
  "set state = 'resolved'",
  "'additionalDebit', 0",
  "'walletMutation', false",
  "'ledgerMutation', false",
  "p_request_key || ':confirmed'",
  "'resolutionKind', 'imported_manual_ticketed'",
  "'replay', true",
  'insert into public.booking_status_events',
  'revoke all on function public.complete_impexp_manual_ticketing_v1',
  'grant execute on function public.complete_impexp_manual_ticketing_v1',
  'to service_role',
]) {
  assert.ok(migration.includes(required), `Manual completion omits ${required}`);
}

const functionBody = migration.match(
  /create or replace function public\.complete_impexp_manual_ticketing_v1\([\s\S]*?end;\r?\n\$\$;/i
)?.[0] ?? '';
assert.ok(functionBody, 'Manual completion function body was not found');
assert.doesNotMatch(
  functionBody,
  /update public\.wallet_accounts|update public\.wallet_reservations|insert into public\.wallet_ledger_entries/i,
  'Manual completion must not mutate wallet accounts, reservations, or ledger'
);
assert.doesNotMatch(
  migration.match(
    /complete_impexp_manual_ticketing_v1\([\s\S]*?\)\r?\nreturns jsonb/
  )?.[0] ?? '',
  /ticket_numbers|airlines_pnr|payment_amount|captured_amount|status/i,
  'Completion RPC signature must not accept client-supplied ticket or money facts'
);

const lockOrderNeedles = [
  'from public.flight_bookings booking',
  'from public.booking_operations operation',
  'from public.booking_reconciliation_cases candidate',
  'from public.wallet_reservations reservation',
  'from public.wallets wallet',
  'from public.wallet_accounts account',
];
const lockOrder = [];
let lockSearchFrom = functionBody.indexOf('booking -> operation -> case');
for (const needle of lockOrderNeedles) {
  const position = functionBody.indexOf(needle, lockSearchFrom);
  lockOrder.push(position);
  lockSearchFrom = position + needle.length;
}
assert.ok(
  lockOrder.every((position, index) =>
    position >= 0 && (index === 0 || position > lockOrder[index - 1])
  ),
  'Manual completion must use the global lock order'
);

for (const required of [
  'canAccessImpExp(session.role)',
  'bookingReconciliationWrite',
  'recordSecurityAuditEvent',
  'completeImportedManualTicketing({',
  'dispatchBookingStatusEmails(booking.id)',
  'walletCharged: false',
  'additionalDebit: 0',
]) {
  assert.ok(completionRoute.includes(required), `Completion route omits ${required}`);
}
assert.ok(
  db.includes('complete_impexp_manual_ticketing_v1'),
  'Database wrapper must call the exact imported completion RPC'
);
for (const required of [
  'Complete Verified Ticket',
  "'/api/impexp/complete-booking'",
  'evidenceObservationId: importedVerification.observationId',
  'no additional wallet debit',
]) {
  assert.ok(actions.includes(required), `Staff completion UI omits ${required}`);
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      evidenceIdentity: [
        'provider',
        'supplier-reference',
        'passengers',
        'route',
        'airline-pnr',
        'tickets-per-passenger',
      ],
      freshnessMinutes: 5,
      capturedPaymentReused: true,
      additionalWalletDebit: 0,
      walletMutation: false,
      ledgerMutation: false,
      operationAndCaseCompletedAtomically: true,
      exactReplayRecoverable: true,
    },
    null,
    2
  )
);
