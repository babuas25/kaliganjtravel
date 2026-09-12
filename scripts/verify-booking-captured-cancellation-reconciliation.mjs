import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0056_booking_reconciliation_captured_cancellation.sql'
  ),
  'utf8'
);
const publicFunctions = [
  'resolve_booking_reconciliation_cancelled_full_refund_v1',
  'resolve_booking_reconciliation_cancelled_partial_refund_v1',
  'resolve_booking_reconciliation_cancelled_no_refund_v1',
  'resolve_booking_reconciliation_cancelled_external_settlement_v1',
];
for (const functionName of publicFunctions) {
  assert.match(
    migration,
    new RegExp(
      `create or replace function public\\.${functionName}\\([\\s\\S]*?security definer`,
      'i'
    )
  );
  assert.match(
    migration,
    new RegExp(
      `grant execute on function public\\.${functionName}\\([\\s\\S]*?to service_role;`,
      'i'
    )
  );
}
for (const required of [
  'execute_booking_captured_cancellation_v1',
  "'full_refund', 'partial_refund'",
  "'no_refund_due', 'externally_settled'",
  "reconciliation_case.proposed_outcome = 'financial_only'",
  "then 'financial'",
  "v_reservation.state <> 'captured'",
  "'{validation,authoritativeFor}' = 'cancelled'",
  'v_outstanding := v_booking.captured_amount - v_booking.refunded_amount',
  'v_refund_amount := v_outstanding',
  'v_case.financial_amount >= v_outstanding',
  'v_case.financial_currency <> v_booking.currency',
  'confirm_fee_or_no_refund',
  'confirm_external_settlement',
  "p_execution_request_key || ':refund'",
  "'refund'",
  "when v_refunded_after = v_booking.captured_amount then 'refunded'",
  "when v_refunded_after > 0 then 'partially-refunded'",
  "else 'captured'",
  'ReconciliationCancellationFinancialOutcome',
  "when v_from_lifecycle = 'cancelled'",
  "resolution_outcome = v_resolution_outcome",
  "'retainedAmount', v_retained_amount",
  "'externalSettlementReference'",
]) {
  assert.ok(migration.includes(required), `Captured cancellation omits ${required}`);
}
assert.match(
  migration,
  /if v_refund_amount > 0 then[\s\S]*?update public\.wallet_accounts[\s\S]*?insert into public\.wallet_ledger_entries[\s\S]*?end if;/i,
  'Only full/partial refund branches may credit the wallet and append a refund ledger row'
);
assert.match(
  migration,
  /revoke all on function public\.execute_booking_captured_cancellation_v1\([\s\S]*?from public, anon, authenticated, service_role;/i,
  'The internal disposition engine must not be service-callable'
);
for (const functionName of publicFunctions) {
  const signature = migration.match(
    new RegExp(`${functionName}\\([\\s\\S]*?\\)\\nreturns jsonb`, 'i')
  )?.[0] ?? '';
  assert.doesNotMatch(
    signature,
    /amount|currency|status|financial_disposition|external_settlement_reference/i,
    `${functionName} must derive financial details from the approved case`
  );
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      exactRpcs: publicFunctions,
      fullRefundSource: 'captured_minus_refunded',
      partialRefundSource: 'approved_case_amount',
      noRefundWalletMutation: false,
      externalSettlementWalletMutation: false,
      alreadyCancelledFinancialEvent: true,
      genericFinancialEngineCallable: false,
    },
    null,
    2
  )
);
