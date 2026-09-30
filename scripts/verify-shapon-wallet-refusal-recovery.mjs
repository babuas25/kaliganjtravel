import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const db = new PGlite({ extensions: { pgcrypto } });
const hash = value => createHash('sha256').update(value).digest('hex');
const bookingId = '402933e6-3806-4c0e-9483-a71a9302646b';
const operationId = 'b91a63e1-bb75-4e7d-8871-32a4a3972caa';
const caseId = '1f0edcda-d5c5-4c37-b4ee-1ebc8609e81a';
const reservationId = '58e5490e-e71f-4c30-b0d0-65a29e676570';
const actor = 'test-superadmin';
const requestKey = 'shapon-wallet-refusal:KTT0AEN460AEN46:v1';
const dailyReferenceMigration = '20260930000000_ktt_daily_booking_references.sql';

async function recoverySnapshot() {
  const result = {};
  const tables = (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
  for (const { tablename } of tables) {
    if (['booking_reference_aliases', 'booking_ref_counters'].includes(tablename)) continue;
    const row = tablename === 'flight_bookings' ? "to_jsonb(t) - 'public_ref'" : 'to_jsonb(t)';
    result[tablename] = (await db.query(`select coalesce(jsonb_agg(${row} order by t::text), '[]') as data
      from public."${tablename}" t`)).rows[0].data;
  }
  return result;
}

try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;`);
  const dir = 'supabase/fresh-install/supabase/migrations';
  const migrations = fs.readdirSync(dir).filter(file => file.endsWith('.sql')).sort();
  assert.ok(migrations.includes(dailyReferenceMigration));
  // This named, already-completed repair ran while the booking had its old KTT
  // reference. Exercise that historical state before applying the later rename.
  for (const file of migrations.filter(file => file < dailyReferenceMigration)) {
    await db.exec(fs.readFileSync(`${dir}/${file}`, 'utf8'));
  }
  await db.query(`insert into app_users(clerk_id,role) values ($1,'superadmin')`, [actor]);
  const account = (await db.query(
    `select (wallet_ensure_account('agency','RECOVERY-TEST','BDT')).*`
  )).rows[0];
  await db.query(`update wallet_accounts set available_balance=100000,
      hold_balance=508315 where id=$1`, [account.id]);
  await db.query(`insert into flight_bookings (
      id,public_ref,access_token_hash,audience,agency_code,search_id,itinerary_id,
      status,currency,pricing_snapshot,passenger_counts,travel_date,direct_ticketing,
      supplier_refs,repriced_at,accepted_at,expires_at,pnr,airlines_pnr,
      booking_ref_number,booking_status,ticketing_time_limit,
      ticketing_deadline_at,booking_code_ref,ticket_numbers,supplier,supplier_account,
      payment_state,payment_amount,charged_wallet_account_id,operation_kind,
      captured_amount,refunded_amount)
    values ($1,'KTT0AEN460AEN46',$2,'agency','RECOVERY-TEST',$3,'itn-0-0',
      'in-progress','BDT',$4,$5,'2026-10-01',false,$6,now(),now(),
      now()+interval '1 day','0AEN46','["0AEN46"]',
      '0AEN46','Created','27/09/2026 18:45:00',
      '2026-09-27 12:45:00+00',$7,'[]','shapontravels','shapontravels',
      'reconciliation',508315,$8,'reconciliation',0,0)`, [
    bookingId, hash('recovery-booking'), randomUUID(),
    JSON.stringify({ sellingPrice: 5083.15 }), JSON.stringify({ ADT: 1 }),
    JSON.stringify({ uniqueTransId: randomUUID(), itemCodeRef: randomUUID(),
      priceCodeRef: randomUUID() }),
    '1845ce8b-0268-40ca-a825-c93364a2b63e', account.id,
  ]);
  await db.query(`insert into booking_operations (
      id,booking_id,kind,state,reason_code,request_key,request_payload_hash,
      actor_user_id,actor_role,source,supplier,supplier_operation,
      supplier_evidence,error_code,error_message,claimed_at,supplier_call_started_at,
      supplier_response_received_at)
    values ($1,$2,'ticketing','needs_reconciliation','issue','test-request',$3,
      $4,'superadmin','staff','shapontravels','NewTicket',$5,
      'INCOMPLETE_RESPONSE','Shapontravels NewTicket INSUFFICIENT_FUNDS',
      now()-interval '2 minutes',now()-interval '1 minute',
      now()-interval '30 seconds')`, [
    operationId, bookingId, hash('issue-request'), actor,
    JSON.stringify({ httpStatus: 409, responseObserved: true }),
  ]);
  await db.query(`update flight_bookings set active_operation_id=$1 where id=$2`,
    [operationId, bookingId]);
  await db.query(`insert into booking_reconciliation_cases (
      id,subject_booking_id,operation_id,case_type,state,reason_code,
      opened_source,opened_by_user_id,opened_by_role)
    values ($1,$2,$3,'ticketing_uncertainty','open','incomplete_response',
      'operation','system:lifecycle','system')`, [caseId, bookingId, operationId]);
  await db.query(`insert into wallet_reservations (
      id,wallet_account_id,booking_id,amount,currency,state,requested_by_user_id)
    values ($1,$2,$3,508315,'BDT','reconciliation',$4)`,
  [reservationId, account.id, bookingId, actor]);

  const run = async () => (await db.query(
    `select resolve_ktt0aen460aen46_wallet_refusal_v1($1,$2) as result`,
    [actor, requestKey]
  )).rows[0].result;
  await db.exec('begin');
  await db.query(`update booking_operations set error_message='different' where id=$1`, [operationId]);
  assert.equal((await run()).code, 'RECOVERY_FACTS_CHANGED');
  await db.exec('rollback');

  const result = await run();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.releasedAmount, 508315);
  assert.equal(result.bookingStatus, 'on-hold');
  const state = (await db.query(`select status,payment_state,ticketing_deadline_at,
      active_operation_id from flight_bookings where id=$1`, [bookingId])).rows[0];
  assert.equal(state.status, 'on-hold');
  assert.equal(state.payment_state, 'released');
  assert.equal(state.ticketing_deadline_at, null);
  assert.equal(state.active_operation_id, null);
  const balance = (await db.query(`select available_balance,hold_balance
      from wallet_accounts where id=$1`, [account.id])).rows[0];
  assert.equal(Number(balance.available_balance), 608315);
  assert.equal(Number(balance.hold_balance), 0);
  assert.equal((await db.query(`select state from wallet_reservations where id=$1`,
    [reservationId])).rows[0].state, 'released');
  assert.equal((await db.query(`select state from booking_operations where id=$1`,
    [operationId])).rows[0].state, 'failed');
  assert.equal((await db.query(`select state from booking_reconciliation_cases where id=$1`,
    [caseId])).rows[0].state, 'resolved');
  assert.equal((await run()).replay, true);
  assert.equal((await db.query(`select count(*)::int as n from wallet_ledger_entries
      where reservation_id=$1 and transaction_type='hold_release'`,
  [reservationId])).rows[0].n, 1);
  const recovered = await recoverySnapshot();
  await db.exec(fs.readFileSync(`${dir}/${dailyReferenceMigration}`, 'utf8'));
  assert.deepEqual(await recoverySnapshot(), recovered,
    'The later reference rename must preserve the completed recovery, wallet, and audit records');
  assert.equal((await db.query(`select booking_id from booking_reference_aliases
    where alias='KTT0AEN460AEN46'`)).rows[0].booking_id, bookingId);
  assert.match((await db.query('select public_ref from flight_bookings where id=$1',
    [bookingId])).rows[0].public_ref, /^KTT\d{12}$/);
  console.log('Shapon wallet refusal recovery and preservation after the daily-reference migration verified');
} finally {
  await db.close();
}
