import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const cancellation = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0056_booking_reconciliation_captured_cancellation.sql'
  ),
  'utf8'
);
const confirmation = fs.readFileSync(
  path.join(
    root,
    'supabase',
    'migrations',
    '0057_booking_reconciliation_terminal_corrections.sql'
  ),
  'utf8'
);

for (const required of [
  "@> '[\"terminal_correction\"]'::jsonb",
  "then 'terminal_correction'",
  "v_booking.status <> 'confirmed'",
  "v_case.proposed_outcome <> 'cancelled'",
  "'TerminalCorrectionCapturedCancellation'",
  "'terminalCorrection', v_contract_kind = 'terminal_correction'",
]) {
  assert.ok(
    cancellation.includes(required),
    `Confirmed-to-Cancelled correction omits ${required}`
  );
}
assert.ok(
  cancellation.indexOf("then 'terminal_correction'") <
    cancellation.indexOf("then 'cancelled'"),
  'Server-derived terminal risk must select the terminal contract first'
);

const functionName =
  'resolve_booking_reconciliation_terminal_confirmed_v1';
assert.match(
  confirmation,
  new RegExp(
    `create or replace function public\\.${functionName}\\([\\s\\S]*?security definer`,
    'i'
  )
);
assert.match(
  confirmation,
  new RegExp(
    `grant execute on function public\\.${functionName}\\([\\s\\S]*?to service_role;`,
    'i'
  )
);
for (const required of [
  "p_execution_request_key, 'terminal_correction'",
  "v_case.proposed_outcome <> 'ticketed'",
  "v_case.financial_disposition <> 'none'",
  "v_booking.status <> 'cancelled'",
  "v_booking.payment_state <> 'captured'",
  'v_booking.refunded_amount <> 0',
  "v_reservation.state <> 'captured'",
  "'{validation,authoritativeFor}' = 'ticketed'",
  "set status = 'confirmed'",
  'cancelled_at = null',
  "'TerminalCorrectionConfirmed'",
  "resolution_outcome = 'terminal_corrected_confirmed'",
  "'walletMutation', false",
  "'reservationMutation', false",
  "'ledgerMutation', false",
  "'previousCancelledAt', v_booking.cancelled_at",
  "'previousCancelledBy', v_booking.cancelled_by",
  "'previousCancelReason', v_booking.cancel_reason",
  "'resolutionKind', 'terminal_correction'",
]) {
  assert.ok(
    confirmation.includes(required),
    `Cancelled-to-Confirmed correction omits ${required}`
  );
}
for (const forbidden of [
  /update\s+public\.wallet_accounts/i,
  /update\s+public\.wallet_reservations/i,
  /insert\s+into\s+public\.wallet_ledger_entries/i,
]) {
  assert.doesNotMatch(
    confirmation,
    forbidden,
    'Already-captured confirmation correction must not move wallet money'
  );
}
const signature = confirmation.match(
  new RegExp(`${functionName}\\([\\s\\S]*?\\)\\nreturns jsonb`, 'i')
)?.[0] ?? '';
assert.doesNotMatch(
  signature,
  /status|amount|currency|financial_disposition|ticket_numbers|ticket_code/i,
  'Terminal correction inputs must come from locked state and approved evidence'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      confirmedToCancelled: [
        'full_refund',
        'partial_refund',
        'no_refund_due',
        'externally_settled',
      ],
      cancelledToConfirmed: 'captured_unrefunded_only',
      unsupportedFinancialStates: 'fail_closed',
      genericTerminalStatusMutation: false,
    },
    null,
    2
  )
);
