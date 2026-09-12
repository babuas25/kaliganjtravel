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

const first = await insertRequest();
const second = await insertRequest();
assert.notEqual(first.rows[0].id, second.rows[0].id);
assert.match(first.rows[0].public_ref, /^TMRR[A-F0-9]{12}$/);
assert.equal(first.rows[0].status, 'requested');
assert.equal(first.rows[0].version, 1);
const reissue = await insertRequest('reissue');
const voidRequest = await insertRequest('void');
assert.match(reissue.rows[0].public_ref, /^TMRE[A-F0-9]{12}$/);
assert.match(voidRequest.rows[0].public_ref, /^TMRV[A-F0-9]{12}$/);

await assert.rejects(
  db.query(`
    update public.ticket_management_requests
       set status = 'completed', completed_at = clock_timestamp(),
           terminal_outcome = 'voided'
     where id = $1
  `, [first.rows[0].id]),
  /ticket_management_requests_action_outcome_check/
);

await db.query(`
  insert into public.ticket_management_request_events (
    request_id, occurrence_number, event_type, to_status,
    request_version, actor_user_id, actor_role, idempotency_key
  ) values ($1, 1, 'requested', 'requested', 1,
    'customer-1', 'customer', 'request:one:created')
`, [first.rows[0].id]);
await assert.rejects(
  db.query(`
    delete from public.ticket_management_request_events where request_id = $1
  `, [first.rows[0].id]),
  /events are immutable/
);
await assert.rejects(
  db.query(`delete from public.ticket_management_requests where id = $1`, [first.rows[0].id]),
  /foreign key constraint/
);

const rls = await db.query(`
  select relname, relrowsecurity
    from pg_class
   where relname in ('ticket_management_requests', 'ticket_management_request_events')
   order by relname
`);
assert.deepEqual(rls.rows.map((row) => row.relrowsecurity), [true, true]);

await db.close();
console.log('Ticket Management core schema verified in disposable PostgreSQL.');
