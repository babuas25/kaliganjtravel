import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create table public.flight_bookings (
    id uuid primary key,
    status text,
    lifecycle_status text
  );
  create table public.wallet_accounts (id uuid primary key);
  create or replace function public.touch_updated_at()
  returns trigger language plpgsql as $$
  begin new.updated_at := clock_timestamp(); return new; end
  $$;
`);
await db.exec(
  fs.readFileSync('supabase/migrations/0119_ticket_management_core.sql', 'utf8')
);
await db.exec(
  fs.readFileSync(
    'supabase/migrations/0137_ticket_management_action_reference_prefix.sql',
    'utf8',
  )
);

const bookingId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
await db.query('insert into public.flight_bookings(id) values ($1)', [bookingId]);
await db.query('insert into public.wallet_accounts(id) values ($1)', [accountId]);

let requestNumber = 0;
const insertRequest = async (action = 'refund') => {
  requestNumber += 1;
  return db.query(`
  insert into public.ticket_management_requests (
    booking_id, action, request_key, request_payload_hash,
    requested_by_user_id, requested_by_role,
    booking_owner_type, booking_owner_key, charged_wallet_account_id,
    currency, captured_amount_snapshot, refunded_amount_snapshot
  ) values ($1, $4, $3, repeat('a', 64),
    'customer-1', 'customer', 'user', 'customer-1',
    $2, 'BDT', 5000000, 0)
  returning id, public_ref, status, version
`, [bookingId, accountId, `request:${requestNumber}`, action]);
};

// Existing rows must retain identity, state and the complete reference suffix.
const legacy = [];
for (const action of ['refund', 'reissue', 'void']) legacy.push((await insertRequest(action)).rows[0]);
await db.exec(`create table public.wallet_deposit_requests (
  id uuid primary key default gen_random_uuid(), requested_at timestamptz default now(),
  amount bigint not null default 10000, status text not null default 'pending'
);`);
await db.exec(fs.readFileSync('supabase/migrations/0022_deposit_public_references.sql', 'utf8'));
const oldDeposit = (await db.query(`insert into wallet_deposit_requests(public_ref)
 values (public.allocate_deposit_ref_for('2026-09-12')) returning *`)).rows[0];
const migration = fs.readFileSync('supabase/fresh-install/supabase/migrations/20260912010000_kt_request_references.sql', 'utf8');
await db.exec(migration);
const deposit = (await db.query('select * from wallet_deposit_requests where id=$1', [oldDeposit.id])).rows[0];
assert.deepEqual(deposit, {...oldDeposit, public_ref: 'KTD260912000001'});
assert.equal((await db.query("select allocate_deposit_ref_for('2026-09-12') as ref")).rows[0].ref, 'KTD260912000002');
const next = (await db.query('insert into wallet_deposit_requests default values returning public_ref')).rows[0];
assert.match(next.public_ref, /^KTD[0-9]{12}$/);
await assert.rejects(db.query("update wallet_deposit_requests set public_ref='KTD260912999999' where id=$1", [oldDeposit.id]), /immutable/);
for (const row of legacy) {
 const current = (await db.query('select id, public_ref, status, version from ticket_management_requests where id=$1', [row.id])).rows[0];
 assert.deepEqual(current, {...row, public_ref: 'KT' + row.public_ref.slice(2)});
}
for (const [action, prefix] of [['refund','KTRR'], ['reissue','KTRE'], ['void','KTRV']]) {
 const row = (await insertRequest(action)).rows[0];
 assert.match(row.public_ref, new RegExp('^' + prefix + '[A-F0-9]{12}$'));
}
await db.exec(migration);
assert.deepEqual((await db.query('select * from wallet_deposit_requests where id=$1', [oldDeposit.id])).rows[0], deposit);
assert.equal((await db.query("select tgenabled as enabled from pg_trigger where tgname='wallet_deposit_public_ref_immutable'" )).rows[0].enabled, 'O');
console.log('KT references passed: existing deposit and all ticket actions migrated; new generators, sequence continuity, repeat migration, and deposit immutability verified.');
await db.close();
