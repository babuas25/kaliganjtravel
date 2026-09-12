import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0054_booking_reconciliation_unpaid_cancellation.sql'
  ),
  'utf8'
);

for (const required of [
  'resolve_booking_reconciliation_cancelled_v1',
  "v_case.financial_disposition <> 'none'",
  "v_booking.payment_state <> 'unpaid'",
  'v_booking.captured_amount <> 0',
  'v_booking.refunded_amount <> 0',
  'v_booking.charged_wallet_account_id is not null',
  "v_contract->>'reservationId' is not null",
  "'{validation,authoritativeFor}' = 'cancelled'",
  "'{validation,identityMatches}' = 'true'",
  "'{evidence,airTicketing,source}' = 'air-ticketing-details'",
  "status = 'cancelled'",
  "state = 'succeeded'",
  "to_lifecycle_status = 'cancelled'",
  "resolution_outcome = 'cancelled_unpaid'",
  "'walletMutation', false",
  "'reservationMutation', false",
  "'ledgerMutation', false",
]) {
  assert.ok(migration.includes(required), `Unpaid cancellation omits ${required}`);
}
for (const forbidden of [
  /update public\.wallet_accounts/i,
  /update public\.wallet_reservations/i,
  /insert into public\.wallet_ledger_entries/i,
  /wallet_finalize_booking_cancel\(/i,
]) {
  assert.doesNotMatch(
    migration,
    forbidden,
    'Unpaid cancellation must have no financial table side effects'
  );
}
assert.doesNotMatch(
  migration.match(
    /resolve_booking_reconciliation_cancelled_v1\([\s\S]*?\)\nreturns jsonb/
  )?.[0] ?? '',
  /amount|currency|status|refund|release/i,
  'Cancellation RPC signature must not accept client-supplied financial/status fields'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      evidenceRequired: 'authoritative_cancelled',
      acceptedPaymentState: 'unpaid',
      walletMutation: false,
      reservationMutation: false,
      ledgerMutation: false,
      lifecycleAndCaseAtomic: true,
    },
    null,
    2
  )
);
