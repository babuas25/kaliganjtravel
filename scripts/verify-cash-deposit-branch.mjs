import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Use the frozen installed baseline, without external connections or messages.
const migration = (name) => fs.readFileSync(new URL(`../supabase/fresh-install/supabase/migrations/${name}`, import.meta.url), 'utf8');
const db = new PGlite({ extensions: { pgcrypto } });
try {
  await db.exec('create role anon; create role authenticated; create role service_role; create schema auth; create schema storage;');
  await db.exec(migration('20260911000000_kaliganj_baseline.sql'));
  assert.equal((await db.query('select count(*)::int as n from wallet_payment_branches')).rows[0].n, 0);
  const sql = migration('20260912000000_kaliganj_head_branch.sql');
  await db.exec(sql);
  const branches = (await db.query('select id, name, address, active from wallet_payment_branches')).rows;
  assert.equal(branches.length, 1);
  const branch = branches[0].id;
  assert.deepEqual(branches[0], { id: branch, name: 'Head Branch', active: true,
    address: '1st Floor, Janata Super Market, Kaligonj, Jhenaidah, Bangladesh' });
  await db.exec(sql);
  assert.deepEqual((await db.query('select id, name, address, active from wallet_payment_branches')).rows, branches);
  await db.exec(`
    create schema if not exists extensions;
    create extension if not exists pgcrypto with schema extensions;
    insert into app_users(clerk_id, role) values ('branch-test-owner', 'b2c');
  `);
  const wallet = (await db.query("insert into wallets(owner_type,owner_key) values ('user','branch-test-owner') returning id")).rows[0].id;
  const account = (await db.query("insert into wallet_accounts(wallet_id,currency) values ($1,'BDT') returning id", [wallet])).rows[0].id;
  const deposit = (await db.query(`insert into wallet_deposit_requests
    (wallet_account_id,amount,currency,method,requested_by_user_id,branch_id,received_by_user_id)
    values ($1,10000,'BDT','cash','branch-test-owner',$2,'branch-test-owner') returning branch_id`, [account, branch])).rows[0];
  assert.equal(deposit.branch_id, branch);
  assert.equal((await db.query('select available_balance::int as balance from wallet_accounts where id=$1', [account])).rows[0].balance, 0);
  console.log('Cash deposit branch passed: configured, active, idempotent, valid deposit reference; wallet remains uncredited.');
} finally {
  await db.close();
}
