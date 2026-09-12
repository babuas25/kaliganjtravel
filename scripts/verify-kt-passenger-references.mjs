import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const directory = 'supabase/fresh-install/supabase/migrations';
const migration = '20260912030000_kt_passenger_references.sql';
const sql = fs.readFileSync(`${directory}/${migration}`, 'utf8');
const db = new PGlite({ extensions: { pgcrypto } });
try {
  await db.exec('create role anon; create role authenticated; create role service_role; create schema auth; create schema storage;');
  for (const file of fs.readdirSync(directory).filter((file) => file.endsWith('.sql') && file < migration).sort()) {
    await db.exec(fs.readFileSync(`${directory}/${file}`, 'utf8'));
  }
  await db.exec(`insert into app_users(clerk_id,role) values ('passenger-prefix-test','b2b');`);
  const insert = `insert into passenger_profiles(public_ref,owner_user_id,passenger_type,title,given_name,surname,gender,nationality)
    values (allocate_passenger_profile_ref_for('2026-09-11'),'passenger-prefix-test','ADT','Mr','Test','Passenger','Male','BD') returning *`;
  const before = (await db.query(insert)).rows[0];
  assert.equal(before.public_ref, 'STP260911000001');
  const counters = (await db.query('select * from passenger_profile_ref_counters')).rows;
  await db.exec(sql);
  const after = (await db.query('select * from passenger_profiles where id=$1', [before.id])).rows[0];
  assert.deepEqual(after, { ...before, public_ref: 'KTP260911000001' });
  assert.deepEqual((await db.query('select * from passenger_profile_ref_counters')).rows, counters);
  assert.equal((await db.query(insert)).rows[0].public_ref, 'KTP260911000002');
  await assert.rejects(db.query("update passenger_profiles set public_ref='KTP260911999999' where id=$1", [before.id]), /immutable/);
  await db.exec(sql);
  assert.equal((await db.query('select count(*)::int as count from passenger_profiles')).rows[0].count, 2);
  const automatic = (await db.query(`insert into passenger_profiles(owner_user_id,passenger_type,title,given_name,surname,gender,nationality)
    values ('passenger-prefix-test','ADT','Mr','Another','Passenger','Male','BD') returning public_ref`)).rows[0];
  assert.match(automatic.public_ref, /^KTP[0-9]{12}$/);
  assert.equal((await db.query("select has_table_privilege('anon','passenger_profiles','SELECT') as allowed")).rows[0].allowed, false);
  console.log('Passenger prefix migration passed: existing details and counters preserved, new/default references use KTP, immutable guard and permissions retained, repeat safe.');
} finally {
  await db.close();
}
