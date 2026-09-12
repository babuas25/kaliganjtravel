import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const migration = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0051_booking_reconciliation_resolution_contracts.sql'
  ),
  'utf8'
);
const ticketedImplementation = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0094_booking_pnr_echoed_transaction_validation.sql'
  ),
  'utf8'
);
const nonissuanceImplementation = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0053_booking_reconciliation_nonissuance_release.sql'
  ),
  'utf8'
);
const cancellationImplementation = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0054_booking_reconciliation_unpaid_cancellation.sql'
  ),
  'utf8'
);
const heldCancellationImplementation = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0055_booking_reconciliation_held_cancellation.sql'
  ),
  'utf8'
);
const capturedCancellationImplementation = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0056_booking_reconciliation_captured_cancellation.sql'
  ),
  'utf8'
);
const terminalCorrectionImplementation = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0057_booking_reconciliation_terminal_corrections.sql'
  ),
  'utf8'
);
const outcomeFunctions = [
  'resolve_booking_reconciliation_ticketed_v1',
  'resolve_booking_reconciliation_nonissuance_v1',
  'resolve_booking_reconciliation_cancelled_v1',
  'resolve_booking_reconciliation_financial_v1',
  'resolve_booking_reconciliation_terminal_correction_v1',
  'resolve_booking_reconciliation_historical_repair_v1',
];

for (const functionName of outcomeFunctions) {
  assert.match(
    migration,
    new RegExp(
      `create or replace function public\\.${functionName}\\([\\s\\S]*?security definer`,
      'i'
    ),
    `${functionName} must be an explicit SECURITY DEFINER contract`
  );
  assert.match(
    migration,
    new RegExp(
      `grant execute on function public\\.${functionName}\\([\\s\\S]*?to service_role;`,
      'i'
    ),
    `${functionName} must be callable only through the service boundary`
  );
}

for (const required of [
  'booking_reconciliation_resolution_contract_v1',
  "v_actor_role not in ('superadmin', 'admin')",
  "'EXECUTION_FORBIDDEN'",
  "'CASE_VERSION_CONFLICT'",
  "'PROPOSAL_CHANGED'",
  "'BOOKING_STATE_CHANGED'",
  "'INDEPENDENT_APPROVAL_REQUIRED'",
  "interval '5 minutes'",
  "'FRESH_CASE_EVIDENCE_REQUIRED'",
  "'OUTCOME_CONTRACT_MISMATCH'",
  "'MANUAL_ADJUSTMENT_REQUIRED'",
  "'RESOLUTION_EXECUTION_NOT_ENABLED'",
  "'ticketed', 'nonissuance', 'cancelled'",
  "'financial', 'terminal_correction', 'historical_repair'",
]) {
  assert.ok(migration.includes(required), `Resolution contract omits ${required}`);
}

assert.ok(
  migration.indexOf('from public.flight_bookings booking') <
    migration.indexOf('from public.booking_reconciliation_cases reconciliation_case'),
  'Resolution contract lock order must start booking then case'
);
assert.match(
  migration,
  /revoke all on function public\.booking_reconciliation_resolution_contract_v1\([\s\S]*?from public, anon, authenticated, service_role;/i,
  'The generic internal contract helper must not be service-callable'
);

for (const forbidden of [
  /update\s+public\.flight_bookings/i,
  /update\s+public\.booking_operations/i,
  /update\s+public\.booking_reconciliation_cases/i,
  /update\s+public\.wallet_/i,
  /insert\s+into\s+public\.wallet_ledger_entries/i,
  /insert\s+into\s+public\.booking_status_events/i,
  /insert\s+into\s+public\.booking_notification_outbox/i,
]) {
  assert.doesNotMatch(
    migration,
    forbidden,
    'Contract-only migration must not execute lifecycle or financial changes'
  );
}

const apiRoot = path.join(
  root,
  'app',
  'api',
  'admin',
  'booking-lifecycle'
);
const apiFiles = [];
const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(absolute);
    else if (entry.name === 'route.ts') apiFiles.push(absolute);
  }
};
visit(apiRoot);
const exactSafetyActionNames = new Set([
  path.join('reconciliation', 'confirm-cancelled', 'route.ts'),
  path.join('reconciliation', 'confirm-refund', 'route.ts'),
  path.join('reconciliation', 'confirm-ticketed', 'route.ts'),
  path.join('reconciliation', 'keep-open', 'route.ts'),
]);
const apiSource = apiFiles
  .filter(
    (file) =>
      !exactSafetyActionNames.has(path.relative(path.join(apiRoot, '[reference]'), file))
  )
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');
assert.doesNotMatch(apiSource, /setBookingStatus|genericResolve|resolveBookingReconciliation/i);
const confirmCancelledRoute = fs.readFileSync(
  path.join(
    apiRoot,
    '[reference]',
    'reconciliation',
    'confirm-cancelled',
    'route.ts'
  ),
  'utf8'
);
const confirmRefundRoute = fs.readFileSync(
  path.join(
    apiRoot,
    '[reference]',
    'reconciliation',
    'confirm-refund',
    'route.ts'
  ),
  'utf8'
);
const confirmTicketedRoute = fs.readFileSync(
  path.join(
    apiRoot,
    '[reference]',
    'reconciliation',
    'confirm-ticketed',
    'route.ts'
  ),
  'utf8'
);
assert.match(confirmCancelledRoute, /confirmBookingReconciliationCancelledCaptured/);
assert.match(confirmCancelledRoute, /resolveBookingReconciliationCancelledUnpaid/);
assert.doesNotMatch(confirmCancelledRoute, /acquireSupplierEvidence|supplierCancel|cancelBooking/i);
assert.match(confirmRefundRoute, /resolveBookingReconciliationRefund/);
assert.doesNotMatch(confirmRefundRoute, /\/api\/wallet\/refunds/i);
assert.match(confirmTicketedRoute, /resolveBookingReconciliationTicketed/);
assert.match(confirmTicketedRoute, /recordSecurityAuditEvent/);
assert.match(confirmTicketedRoute, /newTicketRequest:\s*false/);
assert.match(confirmTicketedRoute, /genericWalletCapture:\s*false/);
const confirmTicketedExecutable = confirmTicketedRoute.replace(
  /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
  ''
);
assert.doesNotMatch(
  confirmTicketedExecutable,
  /\bNewTicket\s*\(|\bissueTicket\s*\(|\bacquireSupplierEvidence\s*\(|\bsupplierCancel\s*\(|\bwalletCaptureReservation\s*\(/,
  'Ticketed capture must not reissue, call a supplier, or use a generic wallet capture path'
);
assert.match(
  ticketedImplementation,
  /create or replace function public\.resolve_booking_reconciliation_ticketed_v1\([\s\S]*?update public\.wallet_accounts[\s\S]*?update public\.flight_bookings/i,
  'Ticketed is the first outcome contract replaced by an atomic implementation'
);
assert.match(
  nonissuanceImplementation,
  /create or replace function public\.resolve_booking_reconciliation_nonissuance_v1\([\s\S]*?update public\.wallet_accounts[\s\S]*?update public\.flight_bookings/i,
  'Non-issuance is implemented only through its exact atomic outcome contract'
);
assert.match(
  cancellationImplementation,
  /create or replace function public\.resolve_booking_reconciliation_cancelled_v1\([\s\S]*?update public\.flight_bookings[\s\S]*?update public\.booking_reconciliation_cases/i,
  'Cancellation is implemented only through its exact outcome contract'
);
assert.match(
  heldCancellationImplementation,
  /create or replace function public\.resolve_booking_reconciliation_cancelled_release_v1\([\s\S]*?update public\.wallet_accounts[\s\S]*?update public\.flight_bookings/i,
  'Held cancellation has a separate exact financial-consequence RPC'
);
assert.match(
  capturedCancellationImplementation,
  /revoke all on function public\.execute_booking_captured_cancellation_v1\([\s\S]*?service_role;/i,
  'Captured cancellation exposes only exact public disposition wrappers'
);
assert.match(
  capturedCancellationImplementation,
  /riskFlags'[\s\S]*?terminal_correction[\s\S]*?then 'terminal_correction'/i,
  'Captured terminal cancellation must select the exact terminal contract'
);
assert.match(
  terminalCorrectionImplementation,
  /create or replace function public\.resolve_booking_reconciliation_terminal_confirmed_v1\([\s\S]*?'terminal_correction'[\s\S]*?update public\.flight_bookings/i,
  'Cancelled-to-Confirmed has an exact terminal-correction implementation'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      publicOutcomeContracts: outcomeFunctions,
      genericExecutionContractCallable: false,
      enabledOutcomeImplementations: ['ticketed', 'nonissuance', 'cancelled'],
      enabledFinancialVariants: [
        'cancelled_release_existing_hold',
        'cancelled_full_refund',
        'cancelled_partial_refund',
        'cancelled_no_refund_due',
        'cancelled_externally_settled',
      ],
      enabledTerminalCorrections: [
        'confirmed_to_cancelled_with_explicit_disposition',
        'cancelled_to_confirmed_already_captured',
      ],
      contractOnlyOutcomes: ['financial', 'historical_repair'],
      contractMigrationBookingMutation: false,
      contractMigrationWalletMutation: false,
      currentStateBinding: true,
      freshEvidenceBinding: true,
    },
    null,
    2
  )
);
