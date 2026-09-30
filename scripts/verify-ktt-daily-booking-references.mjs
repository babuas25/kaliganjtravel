import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Full installed schema and forward migrations, with disposable local fixtures.
// No environment credentials, hosted database, supplier calls, email, or SMS.
const directory = 'supabase/fresh-install/supabase/migrations';
const filename = '20260930000000_ktt_daily_booking_references.sql';
const sql = fs.readFileSync(`${directory}/${filename}`, 'utf8');
assert.equal(sql, fs.readFileSync('supabase/migrations/0164_ktt_daily_booking_references.sql', 'utf8'));
const db = new PGlite({ extensions: { pgcrypto } });
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const digest = value => createHash('sha256').update(value).digest('hex');

async function makeBooking({ createdAt, publicRef, pnr = 'ZETBHQ', airlines = ['ZETBHQ'], legacy = false }) {
  const id = randomUUID();
  await db.query(`insert into booking_attempts(id,access_token_hash,user_id,audience,state,search_id,itinerary_id,
    unique_trans_id,item_code_ref,price_code_ref,offer_snapshot,expires_at,submitted_at,resolved_at,supplier_account)
    values ($1::uuid,$2,'daily-ref-owner','b2c','succeeded',$3,'daily-ref-test',$1::text,'test-item','test-price',
      '{}','2035-01-01',now(),now(),'triplover')`, [id, digest(id), randomUUID()]);
  const ref = publicRef === undefined
    ? (await one("select allocate_booking_ref_for(($1::timestamptz at time zone 'Asia/Dhaka')::date) as ref", [createdAt])).ref
    : publicRef;
  return one(`insert into flight_bookings(id,access_token_hash,user_id,audience,search_id,itinerary_id,status,currency,
    pricing_snapshot,passenger_counts,travel_date,supplier_refs,repriced_at,accepted_at,passengers,airlines_pnr,
    submission_started_at,itinerary,public_ref,attempt_id,legacy_operational,payment_state,pnr,created_at,updated_at)
    values ($1::uuid,$2,'daily-ref-owner','b2c',$3,'daily-ref-test','on-hold','BDT','{"sellingPrice":500}',
      '{"ADT":1}','2030-01-01',jsonb_build_object('uniqueTransId',$1::text,'itemCodeRef','test-item','priceCodeRef','test-price'),
      now(),now(),'[]',$4,now(),'{"carrierCode":"BG"}',$5,$1,$6,'unpaid',$7,$8,'2026-09-01T00:00:00Z') returning *`,
  [id, digest(`booking:${id}`), randomUUID(), JSON.stringify(airlines), ref, legacy, pnr, createdAt]);
}

async function snapshot({ exclude = [], stripReference = false } = {}) {
  const tables = (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
  const data = {};
  for (const { tablename } of tables) {
    if (exclude.includes(tablename)) continue;
    const value = stripReference && tablename === 'flight_bookings' ? "to_jsonb(t) - 'public_ref'" : 'to_jsonb(t)';
    data[tablename] = (await one(`select coalesce(jsonb_agg(${value} order by t::text), '[]') as data from public."${tablename}" t`)).data;
  }
  return data;
}

try {
  await db.exec('create role anon; create role authenticated; create role service_role; create schema auth; create schema storage;');
  await db.exec('create schema extensions; create extension pgcrypto with schema extensions;');
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.sql') && file < filename).sort()) {
    await db.exec(fs.readFileSync(`${directory}/${file}`, 'utf8'));
  }
  await db.exec("insert into app_users(clerk_id,role,email) values ('daily-ref-owner','customer','daily-ref@example.test');");
  const first = await makeBooking({ createdAt: '2026-09-30T16:26:00Z', publicRef: 'STR260930000001' });
  const second = await makeBooking({ createdAt: '2026-09-30T16:26:00Z', publicRef: 'STR260930000002' });
  const midnight = await makeBooking({ createdAt: '2026-09-30T18:00:00Z', publicRef: 'STR261001000001', pnr: null, airlines: [] });
  const legacy = await makeBooking({ createdAt: '2026-09-29T00:00:00Z', publicRef: null, legacy: true });
  assert.equal(first.public_ref, 'KTTZETBHQZETBHQ');
  await db.exec("insert into booking_ref_counters(ref_date,last_value) values ('2026-09-30',2),('2026-10-01',1);");
  const before = await snapshot({ exclude: ['booking_reference_aliases', 'booking_ref_counters'], stripReference: true });
  const oldAliases = (await db.query('select * from booking_reference_aliases order by alias')).rows;
  await db.exec(sql);
  assert.deepEqual(await snapshot({ exclude: ['booking_reference_aliases', 'booking_ref_counters'], stripReference: true }), before,
    'Backfill must preserve all other booking fields, wallet records, lifecycle events, and notification payloads');
  for (const [booking, expected] of [[first, 'KTT260930111111'], [second, 'KTT260930111112'], [midnight, 'KTT261001111111']]) {
    assert.equal((await one('select public_ref from flight_bookings where id=$1', [booking.id])).public_ref, expected);
    assert.equal(expected.length, 15);
    assert.equal((await one('select booking_id from booking_reference_aliases where alias=$1', [booking.public_ref])).booking_id, booking.id);
  }
  for (const alias of oldAliases) {
    assert.deepEqual(await one('select * from booking_reference_aliases where alias=$1', [alias.alias]), alias);
  }
  assert.equal((await one('select public_ref from flight_bookings where id=$1', [legacy.id])).public_ref, null);
  assert.equal((await one("select last_value from booking_ref_counters where ref_date='2026-09-30'")).last_value, 111112);
  const migrated = await snapshot();
  await db.exec(sql);
  assert.deepEqual(await snapshot(), migrated, 'Migration reapplication must preserve records, aliases, and counters');

  // The RPC allocator and insert trigger must consume one serial per booking.
  const sameSecond = [];
  for (let index = 0; index < 10; index += 1) {
    const booking = await makeBooking({ createdAt: '2026-10-02T16:26:00Z' });
    sameSecond.push(booking.public_ref);
    assert.equal(booking.public_ref, `KTT261002${111111 + index}`);
  }
  assert.equal(new Set(sameSecond).size, 10);
  assert.equal((await one("select last_value from booking_ref_counters where ref_date='2026-10-02'")).last_value, 111120);
  const defaultRef = await makeBooking({ createdAt: '2026-10-02T16:26:00Z', publicRef: null, pnr: null, airlines: [] });
  assert.equal(defaultRef.public_ref, 'KTT261002111121');
  const beforeMidnight = await makeBooking({ createdAt: '2026-10-03T17:59:59Z' });
  const afterMidnight = await makeBooking({ createdAt: '2026-10-03T18:00:00Z' });
  assert.equal(beforeMidnight.public_ref, 'KTT261003111111');
  assert.equal(afterMidnight.public_ref, 'KTT261004111111');

  // Reserve an old numeric link: allocating its text again would misroute it.
  await db.query('insert into booking_reference_aliases(alias,booking_id) values ($1,$2)', ['KTT261005111111', first.id]);
  assert.equal((await makeBooking({ createdAt: '2026-10-05T00:00:00Z' })).public_ref, 'KTT261005111112');
  const preserved = defaultRef.public_ref;
  await db.query("update flight_bookings set pnr='NEW123',airlines_pnr='[\"NEW123\"]' where id=$1", [defaultRef.id]);
  await db.query("update flight_bookings set public_ref='KTTCHANGED' where id=$1", [defaultRef.id]);
  assert.equal((await one('select public_ref from flight_bookings where id=$1', [defaultRef.id])).public_ref, preserved);

  // Never truncate the serial or fail booking creation when it grows a digit.
  await db.exec("insert into booking_ref_counters(ref_date,last_value) values ('2026-10-06',999998);");
  assert.equal((await makeBooking({ createdAt: '2026-10-06T00:00:00Z' })).public_ref, 'KTT261006999999');
  assert.equal((await makeBooking({ createdAt: '2026-10-06T00:00:00Z' })).public_ref, 'KTT2610061000000');
  assert.equal((await one("select has_function_privilege('anon','allocate_booking_ref_for(date)','EXECUTE') as allowed")).allowed, false);
  assert.equal((await one("select has_function_privilege('service_role','allocate_booking_ref_for(date)','EXECUTE') as allowed")).allowed, true);
  assert.equal((await one("select has_table_privilege('authenticated','booking_reference_aliases','SELECT') as allowed")).allowed, false);
  assert.equal((await one("select tgenabled from pg_trigger where tgname='flight_bookings_touch_updated_at'")).tgenabled, 'O');
  const finalState = await snapshot();
  await db.exec(sql);
  assert.deepEqual(await snapshot(), finalState);
  console.log('KTT daily references passed: 15 characters, two-digit year, daily serials, midnight rollover, aliases, same-second uniqueness, stable refresh, counter/serial growth, full-schema backfill preservation, repeat safety, and permissions.');
} catch (error) {
  console.error(error.message);
  if (error.detail) console.error(error.detail);
  if (error.query) console.error(error.query);
  process.exitCode = 1;
} finally {
  await db.close();
}
