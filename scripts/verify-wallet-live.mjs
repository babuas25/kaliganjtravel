import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createClient } from '@supabase/supabase-js';

function loadEnvFile(path) {
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] ??= value;
  }
}

loadEnvFile('.env.local');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
assert(url && serviceKey && anonKey, 'Supabase live wallet verification credentials are missing');

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, serviceKey, options);
const anonymous = createClient(url, anonKey, options);

const resources = [
  ['wallets', 'id'],
  ['wallet_accounts', 'id'],
  ['wallet_reservations', 'id'],
  ['wallet_ledger_entries', 'id'],
  ['wallet_deposit_requests', 'id'],
  ['wallet_adjustment_requests', 'id'],
  ['wallet_payment_branches', 'id'],
  ['wallet_company_bank_accounts', 'id'],
  ['wallet_company_mfs_accounts', 'id'],
  ['wallet_report_v', 'wallet_id'],
  ['wallet_transaction_report_v', 'id'],
  ['booking_payment_report_v', 'booking_id'],
];

for (const [resource, column] of resources) {
  const adminRead = await admin.from(resource).select(column).limit(1);
  assert(!adminRead.error, `Service role cannot read ${resource}: ${adminRead.error?.message}`);

  const anonymousRead = await anonymous.from(resource).select(column).limit(1);
  assert(anonymousRead.error, `Anonymous role can read protected resource ${resource}`);
}

const bookingColumns = await admin
  .from('flight_bookings')
  .select('booking_owner_type,booking_owner_key,booked_by_user_id,charged_wallet_account_id,payment_state,payment_amount,captured_amount,refunded_amount')
  .limit(1);
assert(!bookingColumns.error, `Wallet booking columns are unavailable: ${bookingColumns.error?.message}`);

const depositReferences = await admin
  .from('wallet_deposit_requests')
  .select('public_ref')
  .limit(1000);
assert(
  !depositReferences.error,
  `Deposit references are unavailable: ${depositReferences.error?.message}`
);
assert(
  (depositReferences.data ?? []).every((row) => /^KTD\d{12}$/.test(row.public_ref)),
  'A deposit request has an invalid public reference'
);

const directCounterRead = await admin
  .from('deposit_ref_counters')
  .select('ref_date')
  .limit(1);
assert(directCounterRead.error, 'Service role can directly read the deposit reference counter');

const directBalanceMutation = await admin
  .from('wallet_accounts')
  .update({ available_balance: 0 })
  .eq('id', randomUUID());
assert(
  directBalanceMutation.error,
  'Service role can bypass the ledger and directly mutate a wallet balance'
);

const statusMutation = await admin
  .from('wallets')
  .update({ status: 'active' })
  .eq('id', randomUUID());
assert(
  !statusMutation.error,
  `Service role cannot perform its permitted wallet status update: ${statusMutation.error?.message}`
);

const anonymousRpc = await anonymous.rpc('wallet_begin_booking_issue', {
  p_booking_id: randomUUID(),
  p_actor_user_id: 'anonymous-verification',
  p_actor_role: 'customer',
  p_idempotency_key: randomUUID(),
});
assert(anonymousRpc.error, 'Anonymous role can execute a wallet mutation function');

console.log(
  'Live wallet verification passed: schema is queryable by the service role and denied to anonymous clients.'
);
