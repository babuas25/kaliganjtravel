import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Rehearse the installed schema plus every forward migration locally. No
// .env files, hosted database, supplier API or notification transport is used.
const directory = 'supabase/fresh-install/supabase/migrations';
const migration = fs.readFileSync('supabase/migrations/0163_booking_without_pnr_ticketing.sql', 'utf8');
assert.equal(migration, fs.readFileSync(`${directory}/20260915000000_booking_without_pnr_ticketing.sql`, 'utf8'));
const db = new PGlite({ extensions: { pgcrypto } });
const hash = value => createHash('sha256').update(value).digest('hex');
const queryOne = async (sql, params = []) => (await db.query(sql, params)).rows[0];
try {
  await db.exec('create role anon; create role authenticated; create role service_role; create schema auth; create schema storage;');
  // Match Supabase's pgcrypto schema so real notification outbox triggers run.
  await db.exec('create schema extensions; create extension pgcrypto with schema extensions;');
  for (const file of fs.readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(`${directory}/${file}`, 'utf8'));
  }
  await db.exec("insert into app_users(clerk_id, role) values ('pnr-free-owner','customer'),('pnr-free-admin','admin'),('pnr-free-support','staff_support');");
  const account = (await queryOne("select (wallet_ensure_account('user','pnr-free-owner','BDT')).*"));
  // Seed disposable test funds only; the application still executes its real
  // reservation logic and ledger constraints below.
  await db.query('update wallet_accounts set available_balance=10000000 where id=$1', [account.id]);

  async function makeBooking({ deadline = null, supplier = 'triplover', airlines = ['ABC123'], returnedRefs, bookingRefNumber = 'BOOK123' } = {}) {
    const attemptId = randomUUID();
    const requestKey = `book:${attemptId}`;
    const payloadHash = hash(requestKey);
    const offer = { currency: 'BDT', pricing: { sellingPrice: 500 }, passengerCounts: { ADT: 1 }, travelDate: '2030-01-01', directTicketing: false,
      itinerary: { carrierCode: 'BG' }, fares: [], passportRequired: false, repricedAt: '2026-09-01T00:00:00Z' };
    await db.query(`insert into booking_attempts(id,access_token_hash,user_id,audience,state,search_id,itinerary_id,
      unique_trans_id,item_code_ref,price_code_ref,offer_snapshot,passenger_snapshot,expires_at,submitted_at,supplier_account,
      operation_request_key,operation_request_payload_hash,supplier_call_started_at,supplier_response_received_at,supplier_operation)
      values ($1,$2,'pnr-free-owner','b2c','submitting',$3,'test-itinerary',$4,'stored-item','stored-price',$5,'[]',
      now()-interval '5 hours',now()-interval '6 hours',$6,$7,$8,now()-interval '6 hours',now()-interval '6 hours','Book')`,
    [attemptId, hash(attemptId), randomUUID(), `txn:${attemptId}`, JSON.stringify(offer), supplier, requestKey, payloadHash]);
    const outcome = { status: 'held', pnr: 'ABC123', airlinesPnr: airlines, bookingRefNumber, bookingCodeRef: 'stored-booking',
      bookingStatus: 'Created', ticketingTimeLimit: deadline, ticketCodeRef: null, ticketNumbers: [], warnings: [] };
    if (returnedRefs !== undefined) outcome.supplierRefs = { uniqueTransId: `txn:${attemptId}`, ...returnedRefs };
    const booking = await queryOne('select (create_booking_from_attempt_v2($1,$2,$3,$4)).*', [attemptId, requestKey, payloadHash, JSON.stringify(outcome)]);
    assert.equal(booking.supplier_account, supplier);
    assert.equal(booking.booking_owner_key, 'pnr-free-owner');
    assert.equal(booking.supplier_refs.uniqueTransId, `txn:${attemptId}`);
    assert.equal(booking.supplier_refs.itemCodeRef, returnedRefs?.itemCodeRef ?? 'stored-item');
    assert.equal(booking.supplier_refs.priceCodeRef, returnedRefs?.priceCodeRef ?? 'stored-price');
    assert.equal(booking.pnr, 'ABC123');
    assert.equal(booking.booking_ref_number, bookingRefNumber);
    // Successful Book finalization is still idempotent.
    const replay = await queryOne('select (create_booking_from_attempt_v2($1,$2,$3,$4)).*', [attemptId, requestKey, payloadHash, JSON.stringify(outcome)]);
    assert.equal(replay.id, booking.id);
    return booking;
  }
  const beginIssue = async (booking, key = `issue:${randomUUID()}`, role = 'customer') =>
    (await queryOne('select wallet_begin_booking_issue_v2($1,$2,$3,$4,$5) as result',
      [booking.id, role === 'customer' ? 'pnr-free-owner' : `pnr-free-${role === 'staff_support' ? 'support' : 'admin'}`, role, key, hash(key)])).result;

  for (const supplier of ['firsttrip', 'takeoff', 'triplover']) {
    const booking = await makeBooking({ supplier });
    assert.equal(booking.ticketing_deadline_at, null);
    assert.equal((await queryOne('select count(*)::int as n from booking_pnr_refresh_jobs where booking_id=$1', [booking.id])).n, 0);
    assert.deepEqual((await queryOne('select claim_booking_deadline_read_v1($1) as result', [booking.id])).result, { claimed: false, complete: true });
    const key = `issue:${randomUUID()}`;
    const issued = await beginIssue(booking, key);
    assert.equal(issued.ok, true, JSON.stringify(issued));
    const before = await queryOne('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]);
    const repeated = await beginIssue(booking, key);
    assert.equal(repeated.replay, true);
    assert.equal(repeated.operationId, issued.operationId);
    assert.deepEqual(await queryOne('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]), before);
    assert.equal((await beginIssue(booking)).ok, false, 'A second request cannot own an active ticket operation');

    // Execute the real call boundary and atomic wallet/booking finalization.
    const identity = [issued.operationId, key, hash(key)];
    assert.equal((await queryOne('select mark_booking_operation_supplier_call_started($1,$2,$3) as result', identity)).result.started, true);
    assert.equal((await queryOne('select mark_booking_operation_supplier_response_received($1,$2,$3,200) as result', identity)).result.ok, true);
    const ticket = { pnr: booking.pnr, bookingStatus: 'Confirmed', ticketCodeRef: 'issued-ticket', ticketNumbers: ['7790000000001'] };
    const capture = () => queryOne('select wallet_capture_reservation_v2($1,$2,$3,$4,$5,$6,$7) as result',
      [booking.id, 'pnr-free-owner', 'customer', key, hash(key), issued.operationId, JSON.stringify(ticket)]);
    assert.equal((await capture()).result.ok, true);
    const confirmed = await queryOne('select status,payment_state,active_operation_id,booking_ref_number,ticket_numbers from flight_bookings where id=$1', [booking.id]);
    assert.deepEqual(confirmed, { status: 'confirmed', payment_state: 'captured', active_operation_id: null, booking_ref_number: 'BOOK123', ticket_numbers: ticket.ticketNumbers });
    const afterCapture = await queryOne('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]);
    assert.equal(Number(afterCapture.available_balance), Number(before.available_balance));
    assert.equal(Number(afterCapture.hold_balance), Number(before.hold_balance) - 50000);
    assert.equal((await capture()).result.replay, true);
    assert.equal((await beginIssue(booking, key)).replay, true);
    assert.deepEqual(await queryOne('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]), afterCapture);
    assert.equal((await queryOne("select count(*)::int as n from wallet_ledger_entries where booking_id=$1 and transaction_type='booking_confirm'", [booking.id])).n, 1);
    assert.equal((await queryOne("select count(*)::int as n from booking_status_events where booking_id=$1 and to_lifecycle_status='confirmed'", [booking.id])).n, 1);
  }
  const echoed = await makeBooking({ returnedRefs: { priceCodeRef: 'book-price', itemCodeRef: 'book-item' } });
  assert.equal((await beginIssue(echoed)).ok, true);
  for (const returnedRefs of [{ priceCodeRef: ' ' }, { itemCodeRef: 12 }, { uniqueTransId: 'another-transaction' }]) {
    await assert.rejects(makeBooking({ returnedRefs }), /invalid or conflicting references/);
  }
  const blankLocator = await makeBooking({ bookingRefNumber: ' ' });
  assert.equal((await beginIssue(blankLocator)).ok, true, 'PNR remains usable when the optional mirror is blank');
  for (const raw of ['not-a-date', '31/02/2030 12:00:00']) {
    const booking = await makeBooking({ deadline: raw });
    assert.equal(booking.ticketing_time_limit, raw, 'Keep raw supplier evidence');
    assert.equal(booking.ticketing_deadline_at, null, 'Do not manufacture a deadline or discard Book');
    assert.equal((await beginIssue(booking)).ok, true);
  }
  const future = await makeBooking({ deadline: '2030-01-01 12:00:00' });
  assert.equal(new Date(future.ticketing_deadline_at).toISOString(), '2030-01-01T06:00:00.000Z');
  assert.equal((await beginIssue(future, undefined, 'admin')).ok, true);
  const expired = await makeBooking({ deadline: '2020-01-01 12:00:00' });
  assert.equal((await beginIssue(expired)).code, 'BOOKING_EXPIRED');
  const overridden = await makeBooking({ deadline: '2020-01-01 12:00:00' });
  const override = await queryOne(`insert into superadmin_booking_deadline_overrides(booking_id,request_key,effective_deadline_at,actor_user_id,actor_role)
    values ($1,$2,now()+interval '15 minutes','pnr-free-superadmin','superadmin') returning id,effective_deadline_at`, [overridden.id, `override:${randomUUID()}`]);
  await db.query('update flight_bookings set active_superadmin_deadline_override_id=$2 where id=$1', [overridden.id, override.id]);
  const effective = await queryOne('select ticketing_deadline_at,local_ticketing_deadline_at from flight_bookings where id=$1', [overridden.id]);
  assert.equal(new Date(effective.ticketing_deadline_at).getTime(), new Date(override.effective_deadline_at).getTime());
  assert.equal((await beginIssue(overridden)).ok, true, 'Active Super Admin override controls the effective issue deadline');
  const unconfirmed = await makeBooking({ airlines: [] });
  assert.equal((await beginIssue(unconfirmed)).code, 'BOOKING_UNCONFIRMED');
  const missingReference = await makeBooking();
  await db.query("update flight_bookings set supplier_refs=supplier_refs-'priceCodeRef' where id=$1", [missingReference.id]);
  assert.equal((await beginIssue(missingReference)).code, 'SUPPLIER_REFERENCES_MISSING');
  const supportBooking = await makeBooking();
  assert.equal((await beginIssue(supportBooking, undefined, 'staff_support')).code, 'ISSUE_FORBIDDEN');
  const unsupportedAccount = await makeBooking();
  await db.query('update flight_bookings set supplier_account=null where id=$1', [unsupportedAccount.id]);
  assert.equal((await beginIssue(unsupportedAccount)).code, 'BOOKING_DEADLINE_REQUIRED');

  const unfunded = await makeBooking();
  const funds = await queryOne('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]);
  await db.query('update wallet_accounts set available_balance=0 where id=$1', [account.id]);
  assert.equal((await beginIssue(unfunded)).code, 'INSUFFICIENT_FUNDS');
  assert.equal((await queryOne('select count(*)::int as n from wallet_reservations where booking_id=$1', [unfunded.id])).n, 0);
  assert.equal((await queryOne('select status from flight_bookings where id=$1', [unfunded.id])).status, 'on-hold');
  assert.equal((await queryOne('select hold_balance from wallet_accounts where id=$1', [account.id])).hold_balance, funds.hold_balance);
  await db.query('update wallet_accounts set available_balance=$2 where id=$1', [account.id, funds.available_balance]);

  // Upgrade safety: previously queued jobs are retired without changing the
  // booking, payment or status-event history, including running jobs.
  const legacyQueued = await makeBooking();
  await db.query("insert into booking_pnr_refresh_jobs(booking_id,carrier_group,next_attempt_at) values ($1,'bs_immediate',now())", [legacyQueued.id]);
  const walletBefore = await queryOne('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]);
  const eventsBefore = (await queryOne('select count(*)::int as n from booking_status_events')).n;
  await db.exec(migration);
  assert.equal((await queryOne('select state from booking_pnr_refresh_jobs where booking_id=$1', [legacyQueued.id])).state, 'skipped');
  assert.equal((await queryOne('select count(*)::int as n from booking_status_events')).n, eventsBefore);
  assert.deepEqual(await queryOne('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]), walletBefore);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await queryOne("select has_function_privilege($1,'wallet_begin_booking_issue(uuid,text,text,text)','EXECUTE') as allowed", [role])).allowed, false);
  }
  console.log('Full-schema migration rehearsal, Book reference persistence, delayed issue, deadline overrides, atomic capture/replay, wallet balance protection and retired PNR queue passed.');
} finally {
  await db.close();
}
