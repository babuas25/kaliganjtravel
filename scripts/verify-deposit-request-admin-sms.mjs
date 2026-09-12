import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read('supabase', 'migrations', '0153_deposit_request_admin_sms.sql');
const route = read('app', 'api', 'wallet', 'deposits', 'route.ts');
const scheduler = read('app', 'api', 'cron', 'booking-status-emails', 'route.ts');
const delivery = read('lib', 'sms', 'deposit-request-admin-delivery.ts');

for (const required of [
  'deposit_request_admin_sms_deliveries',
  'wallet_deposit_requests_enqueue_admin_sms',
  "v_owner_type is distinct from 'agency'",
  "array['8801921232941', '8801989715039']",
  'agency_name',
  'gross_amount',
  'wallet_company_bank_accounts',
  'wallet_payment_branches',
  'wallet_company_mfs_accounts',
  'claim_deposit_request_admin_sms_v1',
  'for update skip locked',
  'mark_deposit_request_admin_sms_sent_v1',
  'fail_deposit_request_admin_sms_v1',
  'recover_stale_deposit_request_admin_sms_claims_v1',
]) {
  assert.ok(migration.includes(required), `Admin deposit request SMS migration omits ${required}`);
}
assert.ok(route.includes('dispatchDepositRequestAdminSms(created.id)'));
assert.ok(scheduler.includes('dispatchPendingDepositRequestAdminSms(10)'));
assert.ok(scheduler.includes('recoverStaleDepositRequestAdminSmsClaims(100)'));
assert.ok(delivery.includes('depositRequestAdminSmsMessage'));

const messageSource = read('lib', 'sms', 'deposit-request-admin-message.ts');
const compiled = ts.transpileModule(messageSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function('exports', 'module', 'require', compiled)(module.exports, module, () => ({}));
const { depositRequestAdminSmsMessage } = module.exports;

assert.equal(depositRequestAdminSmsMessage({
  version: 1,
  agencyName: 'Sample Test Agency',
  paymentMethod: 'Bank Deposit - Dutch-Bangla Bank',
  currency: 'BDT',
  amountMinor: 2700000,
}), [
  'Deposit Request Received',
  'Dear Admin,',
  'A new deposit request has been submitted.',
  'Agency Name: Sample Test Agency',
  'Payment Method: Bank Deposit - Dutch-Bangla Bank',
  'Deposit Amount: 27,000 BDT',
  'Please log in to your OTA portal to review and approve the transaction.',
].join('\n'));

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
  create table public.agencies (
    agency_code text primary key,
    owner_user_id text
  );
  create table public.user_profiles (
    clerk_id text primary key,
    agency_name text
  );
  create table public.wallet_company_bank_accounts (
    id uuid primary key,
    bank_name text not null
  );
  create table public.wallet_payment_branches (
    id uuid primary key,
    name text not null
  );
  create table public.wallet_company_mfs_accounts (
    id uuid primary key,
    mfs_name text not null
  );
  create table public.wallet_deposit_requests (
    id uuid primary key,
    public_ref text not null,
    wallet_account_id uuid not null references public.wallet_accounts(id),
    amount bigint not null,
    gross_amount bigint,
    currency text not null,
    method text not null,
    company_bank_account_id uuid,
    branch_id uuid,
    mfs_account_id uuid,
    mfs_provider text,
    cheque_issued_bank text
  );
`);
await db.exec(migration);

const agencyWalletId = '15300000-0000-4000-8000-000000000001';
const agencyAccountId = '15300000-0000-4000-8000-000000000002';
const agencyDepositId = '15300000-0000-4000-8000-000000000003';
const bankAccountId = '15300000-0000-4000-8000-000000000004';
await db.exec(`
  insert into public.user_profiles(clerk_id, agency_name)
  values ('agency-owner', 'Sample Test Agency');
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
await db.query(
  "insert into public.wallet_company_bank_accounts(id, bank_name) values ($1, 'Dutch-Bangla Bank')",
  [bankAccountId]
);
await db.query(`
  insert into public.wallet_deposit_requests(
    id, public_ref, wallet_account_id, amount, gross_amount, currency,
    method, company_bank_account_id
  ) values ($1, 'DEP-000001', $2, 2650000, 2700000, 'BDT', 'bank', $3)
`, [agencyDepositId, agencyAccountId, bankAccountId]);

const queued = await db.query(`
  select recipient_number, state, content_snapshot
    from public.deposit_request_admin_sms_deliveries
   where deposit_request_id = $1
   order by recipient_number
`, [agencyDepositId]);
assert.equal(queued.rows.length, 2);
assert.deepEqual(queued.rows.map((row) => row.recipient_number), [
  '8801921232941',
  '8801989715039',
]);
for (const row of queued.rows) {
  assert.equal(row.state, 'pending');
  assert.equal(row.content_snapshot.agencyName, 'Sample Test Agency');
  assert.equal(row.content_snapshot.paymentMethod, 'Bank Deposit - Dutch-Bangla Bank');
  assert.equal(Number(row.content_snapshot.amountMinor), 2700000);
}

const claims = await db.query(
  'select * from public.claim_deposit_request_admin_sms_v1(2, $1)',
  [agencyDepositId]
);
assert.equal(claims.rows.length, 2);
assert.ok(claims.rows.every((row) => row.attempt_count === 1));

const userWalletId = '15300000-0000-4000-8000-000000000005';
const userAccountId = '15300000-0000-4000-8000-000000000006';
const userDepositId = '15300000-0000-4000-8000-000000000007';
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
    id, public_ref, wallet_account_id, amount, gross_amount, currency, method
  ) values ($1, 'DEP-000002', $2, 100000, 100000, 'BDT', 'cash')
`, [userDepositId, userAccountId]);
const personalDeliveries = await db.query(`
  select count(*)::integer as count
    from public.deposit_request_admin_sms_deliveries
   where deposit_request_id = $1
`, [userDepositId]);
assert.equal(personalDeliveries.rows[0].count, 0);

await db.close();

console.log('Deposit request admin SMS verification passed.');
