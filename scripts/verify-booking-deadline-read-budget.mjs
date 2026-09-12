import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
await db.exec(`
create role anon; create role authenticated; create role service_role;
create table flight_bookings (
 id uuid primary key default gen_random_uuid(), ticketing_deadline_at timestamptz,
 supplier text default 'triplover', import_source text, legacy_operational boolean default false,
 status text default 'on-hold', operation_kind text, created_at timestamptz default now() - interval '10 seconds'
);
create table booking_pnr_refresh_jobs (booking_id uuid unique, attempt_count integer);
`);
await db.exec(fs.readFileSync('supabase/migrations/0156_booking_deadline_shared_read_budget.sql', 'utf8'));
const insert = async () => (await db.query('insert into flight_bookings default values returning id')).rows[0].id;
const claim = async (id) => (await db.query('select claim_booking_deadline_read_v1($1) as result', [id])).rows[0].result;
const finish = async (id, token) => (await db.query('select finish_booking_deadline_read_v1($1,$2) as result', [id, token])).rows[0].result;
const id = await insert();
const first = await claim(id); assert.equal(first.claimed, true);
const tabs = await Promise.all([claim(id), claim(id), claim(id)]);
assert.ok(tabs.every(t => !t.claimed && !t.complete), 'Concurrent tabs cannot duplicate an in-flight read');
assert.equal(await finish(id, '00000000-0000-0000-0000-000000000001'), false);
assert.equal(await finish(id, first.claimToken), true);
assert.equal((await claim(id)).claimed, false, 'Cooldown applies after completion too');
for (let n = 2; n <= 3; n++) {
 await db.query(`update booking_deadline_read_budgets set next_attempt_at=now()-interval '1 second' where booking_id=$1`, [id]);
 const next = await claim(id); assert.equal(next.claimed, true);
 await finish(id, next.claimToken);
}
for (let n = 0; n < 10; n++) assert.deepEqual(await claim(id), { claimed: false, complete: true });
assert.equal((await db.query('select attempt_count from booking_deadline_read_budgets where booking_id=$1', [id])).rows[0].attempt_count, 3);
const saved = await insert();
await db.query(`update flight_bookings set ticketing_deadline_at=now()+interval '1 day' where id=$1`, [saved]);
assert.deepEqual(await claim(saved), { claimed: false, complete: true });
const historical = await insert();
await db.query('insert into booking_pnr_refresh_jobs values ($1,3)', [historical]);
assert.deepEqual(await claim(historical), { claimed: false, complete: true }, 'Already exhausted background jobs do not receive a new budget');
const crash = await insert(); const old = await claim(crash);
await db.query(`update booking_deadline_read_budgets set lease_until=now()-interval '1 second',next_attempt_at=now()-interval '1 second' where booking_id=$1`, [crash]);
const resumed = await claim(crash); assert.equal(resumed.claimed, true);
assert.equal(await finish(crash, old.claimToken), false, 'An expired worker cannot release a new worker claim');
assert.equal((await db.query('select attempt_count from booking_deadline_read_budgets where booking_id=$1', [crash])).rows[0].attempt_count, 2, 'Crashed requests still consume their attempt');
await finish(crash, resumed.claimToken);
for (const file of ['app/api/flights/booking/refresh-deadline/route.ts','lib/db/booking-pnr-refresh.ts']) {
 const source = fs.readFileSync(file,'utf8');
 assert.ok(source.indexOf('await claimBookingDeadlineRead(') < source.indexOf('await readPnr('));
 assert.match(source, /finally\s*\{\s*if \(claimToken\) await finishBookingDeadlineRead/);
}
await db.close();
console.log('Persistent three-attempt budget, shared browser/worker gate, cached deadlines, reloads, concurrent tabs and expired claims passed.');
