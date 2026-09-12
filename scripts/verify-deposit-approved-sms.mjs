import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read('supabase', 'migrations', '0152_deposit_approved_sms.sql');
const route = read('app', 'api', 'wallet', 'deposits', '[id]', 'route.ts');
const scheduler = read('app', 'api', 'cron', 'booking-status-emails', 'route.ts');
const delivery = read('lib', 'sms', 'deposit-approved-delivery.ts');

for (const required of [
  'deposit_approved_sms_deliveries',
  'wallet_deposit_requests_enqueue_approved_sms',
  "new.status = 'approved'",
  "v_owner_type = 'agency'",
  'agency_mobile',
  'b2b_partner_only',
  'missing_or_invalid_b2b_partner_phone',
  'claim_deposit_approved_sms_v1',
  'for update skip locked',
  'mark_deposit_approved_sms_sent_v1',
  'fail_deposit_approved_sms_v1',
  'recover_stale_deposit_approved_sms_claims_v1',
]) {
  assert.ok(migration.includes(required), `Deposit approval SMS migration omits ${required}`);
}
assert.ok(route.includes('dispatchDepositApprovedSms(deposit.id)'));
assert.ok(route.includes("parsed.data.decision === 'approved'"));
assert.ok(scheduler.includes('dispatchPendingDepositApprovedSms(10)'));
assert.ok(scheduler.includes('recoverStaleDepositApprovedSmsClaims(100)'));
assert.ok(delivery.includes('depositApprovedSmsMessage'));
assert.ok(delivery.includes('markDepositApprovedSmsSent'));
assert.ok(delivery.includes('failDepositApprovedSms'));

const messageSource = read('lib', 'sms', 'deposit-approved-message.ts');
const compiled = ts.transpileModule(messageSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function('exports', 'module', 'require', compiled)(module.exports, module, () => ({}));
const { depositApprovedSmsMessage } = module.exports;

assert.equal(depositApprovedSmsMessage({
  version: 1,
  currency: 'BDT',
  amountMinor: 2700000,
}), [
  'Dear Client,',
  'your payment request for BDT- 27,000 has been Approved. Your account on our platform has been credited with the funds.',
  '',
  'Thank you for being with us.',
  'Enjoy Booking!',
].join('\n'));

assert.match(depositApprovedSmsMessage({
  version: 1,
  currency: 'BDT',
  amountMinor: 376161,
}), /BDT- 3,761\.61/);

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create extension if not exists pgcrypto;
  create function public.touch_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end;
  $$;
  create table public.wallets (
    id uuid primary key,
    owner_type text not null,
    owner_key text not null
  );
  create table public.wallet_accounts (
    id uuid primary key,
    wallet_id uuid not null references public.wallets(id)
  );
  create table public.wallet_deposit_requests (
    id uuid primary key,
    public_ref text not null,
    wallet_account_id uuid not null references public.wallet_accounts(id),
    amount bigint not null,
    currency text not null,
    status text not null default 'pending'
  );
  create table public.agencies (
    agency_code text primary key,
    owner_user_id text
  );
  create table public.user_profiles (
    clerk_id text primary key,
    agency_mobile text
  );
`);
await db.exec(migration);

const agencyWalletId = '15200000-0000-4000-8000-000000000001';
const agencyAccountId = '15200000-0000-4000-8000-000000000002';
const agencyDepositId = '15200000-0000-4000-8000-000000000003';
await db.exec(`
  insert into public.user_profiles(clerk_id, agency_mobile)
  values ('agency-owner', '+880 1712-345678');
  insert into public.agencies(agency_code, owner_user_id)
  values ('ST-B2B000001', 'agency-owner');
`);
await db.query(
  "insert into public.wallets(id, owner_type, owner_key) values ($1, 'agency', 'ST-B2B000001')",
  [agencyWalletId]
);
await db.query(
  'insert into public.wallet_accounts(id, wallet_id) values ($1, $2)',
  [agencyAccountId, agencyWalletId]
);
await db.query(`
  insert into public.wallet_deposit_requests(
    id, public_ref, wallet_account_id, amount, currency
  ) values ($1, 'DEP-000001', $2, 2700000, 'BDT')
`, [agencyDepositId, agencyAccountId]);
await db.query(
  "update public.wallet_deposit_requests set status = 'approved' where id = $1",
  [agencyDepositId]
);

const queued = await db.query(`
  select recipient_number, state, content_snapshot
    from public.deposit_approved_sms_deliveries
   where deposit_request_id = $1
`, [agencyDepositId]);
assert.equal(queued.rows.length, 1);
assert.equal(queued.rows[0].recipient_number, '8801712345678');
assert.equal(queued.rows[0].state, 'pending');
assert.equal(Number(queued.rows[0].content_snapshot.amountMinor), 2700000);

const claim = await db.query(
  'select * from public.claim_deposit_approved_sms_v1(1, $1)',
  [agencyDepositId]
);
assert.equal(claim.rows.length, 1);
assert.equal(claim.rows[0].attempt_count, 1);
const marked = await db.query(
  'select public.mark_deposit_approved_sms_sent_v1($1, $2, $3) as result',
  [claim.rows[0].delivery_id, claim.rows[0].delivery_claim_token, 'provider-1']
);
assert.equal(marked.rows[0].result, true);

const userWalletId = '15200000-0000-4000-8000-000000000004';
const userAccountId = '15200000-0000-4000-8000-000000000005';
const userDepositId = '15200000-0000-4000-8000-000000000006';
await db.query(
  "insert into public.wallets(id, owner_type, owner_key) values ($1, 'user', 'customer-user')",
  [userWalletId]
);
await db.query(
  'insert into public.wallet_accounts(id, wallet_id) values ($1, $2)',
  [userAccountId, userWalletId]
);
await db.query(`
  insert into public.wallet_deposit_requests(
    id, public_ref, wallet_account_id, amount, currency
  ) values ($1, 'DEP-000002', $2, 100000, 'BDT')
`, [userDepositId, userAccountId]);
await db.query(
  "update public.wallet_deposit_requests set status = 'approved' where id = $1",
  [userDepositId]
);
const suppressed = await db.query(`
  select state, recipient_number, suppression_reason
    from public.deposit_approved_sms_deliveries
   where deposit_request_id = $1
`, [userDepositId]);
assert.deepEqual(suppressed.rows, [{
  state: 'suppressed',
  recipient_number: null,
  suppression_reason: 'b2b_partner_only',
}]);

await db.close();

console.log('Deposit approved SMS verification passed.');
