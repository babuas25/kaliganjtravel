import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const hardening = fs.readFileSync(
  'supabase/migrations/0127_generic_wallet_authorization_hardening.sql',
  'utf8'
);
const refundGuard = fs.readFileSync(
  'supabase/migrations/0059_wallet_reconciliation_refund_guard.sql',
  'utf8'
);
const permissions = fs.readFileSync('lib/wallet/permissions.ts', 'utf8');

for (const required of [
  'WALLET_READ_ROLES',
  'WALLET_MUTATION_ROLES',
  "'staff_support'",
  "'staff_account'",
  'canReadWallet',
  'canManageWallet',
]) assert.ok(permissions.includes(required), `permissions omit ${required}`);
assert.match(
  permissions,
  /const WALLET_MUTATION_ROLES[\s\S]*?'staff_account'[\s\S]*?\]\);/
);
const mutationRoles = permissions.slice(
  permissions.indexOf('const WALLET_MUTATION_ROLES'),
  permissions.indexOf('export function canReadWallet')
);
assert.doesNotMatch(mutationRoles, /staff_support/);

for (const required of [
  'from public.app_users app_user',
  "v_actor_role not in ('superadmin', 'admin', 'staff_account')",
  'WALLET_ADJUSTMENT_CREATE_FORBIDDEN',
  'WALLET_ADJUSTMENT_REVIEW_FORBIDDEN',
  'WALLET_ACTOR_ROLE_MISMATCH',
  'SELF_APPROVAL_FORBIDDEN',
]) assert.ok(hardening.includes(required), `hardening omits ${required}`);
assert.match(refundGuard, /from public\.app_users app_user/);
assert.match(
  refundGuard,
  /v_actor_role not in \('superadmin', 'admin', 'staff_account'\)/
);

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.app_users (clerk_id text primary key, role text not null);
  create table public.wallets (
    id uuid primary key default gen_random_uuid(), status text not null default 'active'
  );
  create table public.wallet_accounts (
    id uuid primary key default gen_random_uuid(),
    wallet_id uuid not null references public.wallets(id), currency text not null,
    available_balance bigint not null default 0, hold_balance bigint not null default 0
  );
  create table public.wallet_ledger_entries (
    id uuid primary key default gen_random_uuid(),
    wallet_account_id uuid not null references public.wallet_accounts(id),
    transaction_type text not null, amount bigint not null, currency text not null,
    available_before bigint not null, available_after bigint not null,
    hold_before bigint not null, hold_after bigint not null,
    idempotency_key text not null unique, created_by_user_id text not null,
    created_by_role text not null, remarks text, metadata jsonb not null default '{}'
  );
  create table public.wallet_adjustment_requests (
    id uuid primary key default gen_random_uuid(),
    wallet_account_id uuid not null references public.wallet_accounts(id),
    adjustment_type text not null, amount bigint not null, currency text not null,
    reason text not null, status text not null default 'pending',
    requested_by_user_id text not null, requested_by_role text not null,
    reviewed_by_user_id text, review_remarks text,
    ledger_entry_id uuid references public.wallet_ledger_entries(id),
    requested_at timestamptz not null default now(), reviewed_at timestamptz,
    updated_at timestamptz not null default now()
  );
  create or replace function public.wallet_refund_booking(
    p_booking_id uuid, p_amount bigint, p_actor_user_id text,
    p_actor_role text, p_idempotency_key text, p_remarks text default null
  ) returns jsonb language sql as $$ select '{"ok":false}'::jsonb $$;
`);
await db.exec(hardening);

const walletId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
await db.query(`insert into public.wallets(id) values($1)`, [walletId]);
await db.query(
  `insert into public.wallet_accounts(id,wallet_id,currency,available_balance)
   values($1,$2,'BDT',1000)`,
  [accountId, walletId]
);
await db.exec(`insert into public.app_users(clerk_id,role) values
  ('support-1','staff_support'), ('accounts-1','staff_account'),
  ('accounts-2','staff_account'), ('admin-1','admin')`);

async function insertAdjustment(actorId, claimedRole) {
  return db.query(
    `insert into public.wallet_adjustment_requests(
       wallet_account_id,adjustment_type,amount,currency,reason,
       requested_by_user_id,requested_by_role
     ) values($1,'credit',250,'BDT','Regression fixture',$2,$3)
     returning id`,
    [accountId, actorId, claimedRole]
  );
}
await assert.rejects(() => insertAdjustment('support-1', 'staff_support'), /CREATE_FORBIDDEN/);
await assert.rejects(() => insertAdjustment('accounts-1', 'admin'), /ROLE_MISMATCH/);
const requestId = (await insertAdjustment('accounts-1', 'staff_account')).rows[0].id;

async function review(actorId, claimedRole, decision = 'approved') {
  return (await db.query(
    `select public.wallet_review_adjustment($1,$2,$3,$4,null) result`,
    [requestId, decision, actorId, claimedRole]
  )).rows[0].result;
}
assert.equal((await review('support-1', 'staff_support')).code, 'WALLET_ADJUSTMENT_REVIEW_FORBIDDEN');
assert.equal((await review('accounts-1', 'staff_account')).code, 'SELF_APPROVAL_FORBIDDEN');
assert.equal((await review('admin-1', 'staff_account')).code, 'WALLET_ACTOR_ROLE_MISMATCH');
assert.equal((await review('admin-1', 'admin')).ok, true);

const account = (await db.query(
  `select available_balance from public.wallet_accounts where id=$1`, [accountId]
)).rows[0];
assert.equal(Number(account.available_balance), 1250);
const ledger = (await db.query(
  `select created_by_user_id,created_by_role from public.wallet_ledger_entries`
)).rows[0];
assert.deepEqual(ledger, { created_by_user_id: 'admin-1', created_by_role: 'admin' });
await assert.rejects(
  () => db.query(
    `update public.wallet_adjustment_requests
        set requested_by_user_id='accounts-2' where id=$1`, [requestId]
  ),
  /requester identity is immutable/
);

await db.close();
console.log('Generic wallet read/mutation separation and canonical adjustment/refund authorization verified.');
