import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Disposable PostgreSQL rehearsal: no environment files, hosted database,
// supplier writes, notification transports or real wallet balances are used.
const db = new PGlite({ extensions: { pgcrypto } });
const directory = 'supabase/fresh-install/supabase/migrations';
const hash = value => createHash('sha256').update(value).digest('hex');
const one = async (sql, parameters = []) => (await db.query(sql, parameters)).rows[0];
const result = async (sql, parameters = []) => (await one(sql, parameters)).result;

try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;`);
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(`${directory}/${file}`, 'utf8'));
  }
  await db.exec(`insert into app_users(clerk_id,role) values
    ('shapon-cancel-owner','customer'),('shapon-cancel-stranger','customer'),
    ('shapon-cancel-admin','admin'),('shapon-cancel-support','staff_support');`);
  const account = await one("select (wallet_ensure_account('user','shapon-cancel-owner','BDT')).*");

  async function makeBooking({ deadline = null, airlines = ['ABC123'], supplier = 'shapontravels' } = {}) {
    const id = randomUUID();
    const key = `book:${id}`;
    const refs = { uniqueTransId: randomUUID(), itemCodeRef: randomUUID(), priceCodeRef: randomUUID() };
    const offer = { currency: 'BDT', pricing: { sellingPrice: 500 }, passengerCounts: { ADT: 1 },
      travelDate: '2030-01-01', directTicketing: false, itinerary: { carrierCode: 'BG' },
      fares: [], passportRequired: false, repricedAt: '2026-09-27T00:00:00Z' };
    await db.query(`insert into booking_attempts(id,access_token_hash,user_id,audience,
      supplier,supplier_account,state,search_id,itinerary_id,unique_trans_id,
      item_code_ref,price_code_ref,offer_snapshot,passenger_snapshot,expires_at,
      submitted_at,operation_request_key,operation_request_payload_hash,
      supplier_call_started_at,supplier_response_received_at,supplier_operation)
      values ($1,$2,'shapon-cancel-owner','b2c',$3,$3,'submitting',$4,'test-cancel',
        $5,$6,$7,$8,'[]',now()+interval '10 minutes',now(),$9,$10,now(),now(),'Book')`,
    [id, hash(id), supplier, randomUUID(), refs.uniqueTransId, refs.itemCodeRef,
      refs.priceCodeRef, JSON.stringify(offer), key, hash(key)]);
    const outcome = { status: 'held', pnr: 'ABC123', airlinesPnr: airlines,
      bookingRefNumber: 'ABC123', supplierPublicRef: `STR${id.replaceAll('-', '').toUpperCase()}`,
      bookingStatus: 'Created', ticketingTimeLimit: deadline, bookingCodeRef: randomUUID(),
      supplierRefs: refs, ticketCodeRef: null, ticketNumbers: [], warnings: [] };
    const finalizer = supplier === 'shapontravels'
      ? 'create_shapontravels_booking_from_attempt_v1' : 'create_booking_from_attempt_v2';
    return one(`select (${finalizer}($1,$2,$3,$4)).*`, [id, key, hash(key), JSON.stringify(outcome)]);
  }
  const cancel = (booking, key = `cancel:${randomUUID()}`, actor = 'shapon-cancel-owner', role = 'customer') =>
    result('select begin_booking_cancellation_v2($1,$2,$3,$4,$5) as result',
      [booking.id, actor, role, key, hash(key)]);
  const issue = (booking, key = `issue:${randomUUID()}`) =>
    result('select wallet_begin_booking_issue_v2($1,$2,$3,$4,$5) as result',
      [booking.id, 'shapon-cancel-owner', 'customer', key, hash(key)]);
  const start = (claim, key) => result(
    'select mark_booking_operation_supplier_call_started($1,$2,$3) as result',
    [claim.operationId, key, hash(key)]);
  const receive = (claim, key) => result(
    'select mark_booking_operation_supplier_response_received($1,$2,$3,200) as result',
    [claim.operationId, key, hash(key)]);
  const finalize = (booking, claim, key) => result(
    'select wallet_finalize_booking_cancel_v2($1,$2,$3,$4,$5,$6,$7,$8) as result',
    [booking.id, 'shapon-cancel-owner', 'customer', key, hash(key), claim.operationId,
      'Booking cancelled with Shapontravels', JSON.stringify({ supplierStatus: 'Cancelled', pnr: booking.pnr })]);
  const restoreNotSent = (booking, claim, key, actor = 'shapon-cancel-owner') => result(
    'select restore_shapon_cancellation_not_sent_v1($1,$2,$3,$4,$5) as result',
    [booking.id, actor, key, hash(key), claim.operationId]);
  const lifecycleSnapshot = booking => one(`select status,
    resolve_booking_lifecycle(status,airlines_pnr,ticketing_deadline_at,operation_kind) as lifecycle_status,
    payment_state,ticketing_deadline_at,supplier_ticketing_deadline_at,local_ticketing_deadline_at
    from flight_bookings where id=$1`, [booking.id]);

  // An unfunded owner with no local Issue Ticket deadline grant may cancel.
  const booking = await makeBooking();
  assert.equal(booking.ticketing_deadline_at, null);
  assert.equal(booking.active_local_time_limit_request_id, null);
  const walletBefore = await one('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]);
  assert.equal(Number(walletBefore.available_balance), 0);
  const key = `cancel:${randomUUID()}`;
  const claim = await cancel(booking, key);
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.equal(claim.walletMutation, false);
  assert.deepEqual(await one('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]), walletBefore);
  assert.equal((await one('select count(*)::int as n from wallet_reservations where booking_id=$1', [booking.id])).n, 0);
  const claimedBooking = await one('select status,operation_kind,active_operation_id from flight_bookings where id=$1', [booking.id]);
  assert.deepEqual(claimedBooking, { status: 'in-progress', operation_kind: 'cancellation', active_operation_id: claim.operationId });
  assert.equal((await cancel(booking, key)).code, 'OPERATION_IN_PROGRESS');
  assert.equal((await issue(booking)).code, 'OPERATION_ALREADY_ACTIVE');
  assert.equal((await finalize(booking, claim, key)).code, 'SUPPLIER_CALL_NOT_STARTED');
  assert.equal((await start(claim, key)).started, true);
  assert.equal((await start(claim, key)).code, 'SUPPLIER_CALL_ALREADY_STARTED', 'The supplier dispatch boundary cannot be claimed twice');
  assert.equal((await finalize(booking, claim, key)).code, 'SUPPLIER_RESPONSE_NOT_RECORDED');
  assert.equal((await receive(claim, key)).ok, true);
  assert.equal((await finalize(booking, claim, key)).ok, true);
  assert.equal((await finalize(booking, claim, key)).replay, true);
  assert.equal((await cancel(booking, key)).replay, true);
  assert.deepEqual(await one('select status,operation_kind,active_operation_id,payment_state from flight_bookings where id=$1', [booking.id]),
    { status: 'cancelled', operation_kind: null, active_operation_id: null, payment_state: 'unpaid' });
  assert.equal((await one("select state from booking_operations where id=$1", [claim.operationId])).state, 'succeeded');
  assert.equal((await one("select count(*)::int as n from booking_status_events where booking_id=$1 and to_lifecycle_status='cancelled'", [booking.id])).n, 1);
  assert.equal((await restoreNotSent(booking, claim, key)).code, 'CANCELLATION_DISPATCH_NOT_CLEAR',
    'A successful cancellation cannot be reopened as not sent');
  await assert.rejects(db.query('select begin_booking_cancellation_v2($1,$2,$3,$4,$5)',
    [booking.id, 'shapon-cancel-owner', 'customer', key, hash('different-intent')]), /reused with different intent/);

  // Queries submitted together compete for the same booking operation. PGlite
  // serializes transactions; the real row/advisory locks and active-operation
  // predicate still execute, allowing exactly one claim and one wallet hold.
  await db.query('update wallet_accounts set available_balance=1000000 where id=$1', [account.id]);
  const contested = await makeBooking();
  const contestedKeys = [`issue:${randomUUID()}`, `cancel:${randomUUID()}`];
  const competing = await Promise.all([issue(contested, contestedKeys[0]), cancel(contested, contestedKeys[1])]);
  assert.equal(competing.filter(value => value.ok).length, 1);
  assert.equal(competing.filter(value => value.code === 'OPERATION_ALREADY_ACTIVE').length, 1);
  assert.equal((await one(`select count(*)::int as n from booking_operations where booking_id=$1
    and state in ('claimed','supplier_call_started','awaiting_external_action','needs_reconciliation')`, [contested.id])).n, 1);
  assert.equal((await one('select count(*)::int as n from wallet_reservations where booking_id=$1', [contested.id])).n, 1);

  async function rejectsBooking(overrides, code = 'BOOKING_NOT_CANCELLABLE') {
    const candidate = await makeBooking();
    const entries = Object.entries(overrides);
    for (const [field] of entries) {
      assert.match(field, /^[a-z_]+$/);
    }
    await db.query(`update flight_bookings set ${entries.map(([field], index) => `${field}=$${index + 2}`).join(',')} where id=$1`,
      [candidate.id, ...entries.map(([, value]) => value !== null && typeof value === 'object' ? JSON.stringify(value) : value)]);
    const before = await one('select status,operation_kind,active_operation_id,payment_state from flight_bookings where id=$1', [candidate.id]);
    assert.equal((await cancel(candidate)).code, code, JSON.stringify(overrides));
    assert.deepEqual(await one('select status,operation_kind,active_operation_id,payment_state from flight_bookings where id=$1', [candidate.id]), before);
    return candidate;
  }
  for (const status of ['confirmed', 'cancelled']) {
    await rejectsBooking({ status });
  }
  await rejectsBooking({ status: 'in-progress', operation_kind: 'reconciliation',
    operation_reason: 'ticketing_reconciliation', operation_started_at: new Date().toISOString() });
  await rejectsBooking({ issued_at: new Date().toISOString() });
  await rejectsBooking({ direct_ticketing: true });
  await rejectsBooking({ ticket_code_ref: randomUUID() });
  await rejectsBooking({ ticket_numbers: ['1234567890123'] });
  await rejectsBooking({ ticket_numbers: { malformed: true } });
  await rejectsBooking({ captured_amount: 50000 });
  for (const payment_state of ['held', 'captured', 'reconciliation']) {
    await rejectsBooking({ payment_state });
  }
  await rejectsBooking({ supplier_public_ref: null }, 'SUPPLIER_REFERENCES_MISSING');
  await rejectsBooking({ supplier_refs: { uniqueTransId: randomUUID() } }, 'SUPPLIER_REFERENCES_MISSING');
  await rejectsBooking({ booking_ref_number: 'OTHER1' }, 'SUPPLIER_REFERENCES_MISSING');
  await rejectsBooking({ import_source: 'MANUAL', user_payable_amount: 50000,
    supplier_gross_amount: 50000,
    pricing_snapshot: { sellingPrice: 500, grossPrice: 500, supplierTotalPrice: 500 } }, 'SUPPLIER_REFERENCES_MISSING');
  await rejectsBooking({ legacy_operational: true }, 'BOOKING_NOT_FOUND');

  // Shapon cancellation covers all four unticketed lifecycle states. An issue
  // cutoff or absent airline confirmation does not override fresh canCancel.
  for (const overrides of [{ status: 'pending' }, { airlines_pnr: [] },
    { supplier_ticketing_deadline_at: new Date(Date.now() - 60000).toISOString() }]) {
    const candidate = await makeBooking();
    for (const [field, value] of Object.entries(overrides)) {
      await db.query(`update flight_bookings set ${field}=$2 where id=$1`, [candidate.id,
        Array.isArray(value) ? JSON.stringify(value) : value]);
    }
    const prior = await one('select status,lifecycle_status from booking_lifecycle_v where id=$1', [candidate.id]);
    assert.ok(['pending', 'unconfirmed', 'expired'].includes(prior.lifecycle_status));
    const candidateKey = `cancel:${randomUUID()}`;
    const candidateClaim = await cancel(candidate, candidateKey);
    assert.equal(candidateClaim.ok, true, `${prior.lifecycle_status}: ${JSON.stringify(candidateClaim)}`);
    assert.deepEqual(await one(`select from_lifecycle_status,stored_status_before from booking_status_events
      where booking_id=$1 and idempotency_key=$2`, [candidate.id, `${candidateKey}:cancellation-start`]),
    { from_lifecycle_status: prior.lifecycle_status, stored_status_before: prior.status });
    await start(candidateClaim, candidateKey);
    await receive(candidateClaim, candidateKey);
    assert.equal((await finalize(candidate, candidateClaim, candidateKey)).ok, true);
    assert.equal((await one('select status from flight_bookings where id=$1', [candidate.id])).status, 'cancelled');
  }
  const expiredLocal = await makeBooking();
  const override = await one(`insert into superadmin_booking_deadline_overrides
    (booking_id,request_key,effective_deadline_at,actor_user_id,actor_role) values
    ($1,$2,now()-interval '1 minute','shapon-cancel-superadmin','superadmin') returning id`,
  [expiredLocal.id, `deadline:${randomUUID()}`]);
  await db.query('update flight_bookings set active_superadmin_deadline_override_id=$2 where id=$1', [expiredLocal.id, override.id]);
  assert.equal((await cancel(expiredLocal)).ok, true, 'An elapsed local issue deadline does not prevent Shapon supplier hold release');

  async function saveCurrentStatus(candidate, status) {
    const now = new Date().toISOString();
    const receipt = { ...candidate.supplier_refs, bookingCodeRef: candidate.booking_code_ref,
      bookingRefNumber: candidate.booking_ref_number, pnr: candidate.pnr,
      supplierPublicRef: candidate.supplier_public_ref, originalBookingStatus: 'Created' };
    const current = { status, bookingState: status === 'on-hold' ? 'held' : status,
      supplierStatus: null, checkedAt: now, supplierCheckedAt: null, verified: false,
      source: 'saved_booking', reviewRequired: true, lastCheck: null };
    const saved = await result('select record_shapon_booking_current_status_v1($1,$2,$3,$4,$5) as result',
      [candidate.id, now, candidate.supplier_public_ref, JSON.stringify(receipt), JSON.stringify(current)]);
    assert.equal(saved.recorded, true, JSON.stringify(saved));
  }
  for (const status of ['confirmed', 'cancelled', 'in-progress']) {
    const candidate = await makeBooking();
    await saveCurrentStatus(candidate, status);
    assert.equal((await cancel(candidate)).code, 'BOOKING_NOT_CANCELLABLE');
  }
  for (const status of ['on-hold', 'pending', 'unconfirmed', 'expired']) {
    const candidate = await makeBooking();
    await saveCurrentStatus(candidate, status);
    assert.equal((await cancel(candidate)).ok, true,
      'A saved review flag from issue eligibility is not cancellation authorization');
  }

  const unauthorized = await makeBooking();
  assert.equal((await cancel(unauthorized, undefined, 'shapon-cancel-stranger')).code, 'CANCEL_FORBIDDEN');
  assert.equal((await cancel(unauthorized, undefined, 'shapon-cancel-support', 'staff_support')).code, 'CANCEL_FORBIDDEN');
  assert.equal((await cancel(unauthorized, undefined, 'missing-actor', 'customer')).code, 'CANCEL_FORBIDDEN');
  assert.equal((await cancel(unauthorized, undefined, 'shapon-cancel-admin', 'admin')).ok, true);
  for (const role of ['anon', 'authenticated']) {
    for (const signature of ['begin_booking_cancellation(uuid,text,text)',
      'begin_booking_cancellation_v2(uuid,text,text,text,text)',
      'wallet_finalize_booking_cancel_v2(uuid,text,text,text,text,uuid,text,jsonb)']) {
      assert.equal((await one('select has_function_privilege($1,$2,\'EXECUTE\') as allowed', [role, signature])).allowed, false);
    }
  }
  assert.equal((await one("select has_function_privilege('service_role','begin_booking_cancellation(uuid,text,text)','EXECUTE') as allowed")).allowed, true);
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await one("select has_function_privilege($1,'restore_shapon_cancellation_not_sent_v1(uuid,text,text,text,uuid)','EXECUTE') as allowed", [role])).allowed, false);
  }
  assert.equal((await one("select has_function_privilege('service_role','restore_shapon_cancellation_not_sent_v1(uuid,text,text,text,uuid)','EXECUTE') as allowed")).allowed, true);
  await assert.rejects(db.query('update flight_bookings set supplier_account=\'triplover\' where id=$1', [unauthorized.id]),
    /flight_bookings_shapontravels_binding_check/);

  // Existing definitive-success financial finalizer releases an ordinary hold
  // exactly once. Seed this synthetic compatibility state after a valid claim;
  // the cancellation entry point continues to reject held payment bookings.
  const releaseBooking = await makeBooking();
  const releaseKey = `cancel:${randomUUID()}`;
  const releaseClaim = await cancel(releaseBooking, releaseKey);
  const reservation = await one(`insert into wallet_reservations(wallet_account_id,
    booking_id,amount,currency,requested_by_user_id) values ($1,$2,50000,'BDT',
      'shapon-cancel-owner') returning id`, [account.id, releaseBooking.id]);
  await db.query('update wallet_accounts set available_balance=available_balance-50000,hold_balance=hold_balance+50000 where id=$1', [account.id]);
  await db.query("update flight_bookings set payment_state='held' where id=$1", [releaseBooking.id]);
  const heldWallet = await one('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]);
  await start(releaseClaim, releaseKey);
  await receive(releaseClaim, releaseKey);
  assert.equal((await finalize(releaseBooking, releaseClaim, releaseKey)).ok, true);
  const releasedWallet = await one('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]);
  assert.equal(Number(releasedWallet.available_balance), Number(heldWallet.available_balance) + 50000);
  assert.equal(Number(releasedWallet.hold_balance), Number(heldWallet.hold_balance) - 50000);
  assert.equal((await one('select state from wallet_reservations where id=$1', [reservation.id])).state, 'released');
  assert.equal((await finalize(releaseBooking, releaseClaim, releaseKey)).replay, true);
  assert.deepEqual(await one('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]), releasedWallet);
  assert.equal((await one("select count(*)::int as n from wallet_ledger_entries where booking_id=$1 and transaction_type='hold_release'", [releaseBooking.id])).n, 1);
  assert.equal((await one('select payment_state from flight_bookings where id=$1', [releaseBooking.id])).payment_state, 'released');

  // Before the durable dispatch boundary, authentication/configuration failure
  // restores all four permitted states without future-deadline or airline-PNR
  // requirements. The claim's own identity and actor authorize only its undo.
  for (const overrides of [{}, { status: 'pending' }, { airlines_pnr: [] },
    { supplier_ticketing_deadline_at: new Date(Date.now() - 60000).toISOString() }]) {
    const candidate = await makeBooking();
    for (const [field, value] of Object.entries(overrides)) {
      await db.query(`update flight_bookings set ${field}=$2 where id=$1`, [candidate.id,
        Array.isArray(value) ? JSON.stringify(value) : value]);
    }
    const prior = await lifecycleSnapshot(candidate);
    const candidateKey = `cancel:${randomUUID()}`;
    const candidateClaim = await cancel(candidate, candidateKey);
    assert.equal(candidateClaim.ok, true);
    const fundsBeforeRestore = await one('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]);
    await assert.rejects(db.query('select restore_shapon_cancellation_not_sent_v1($1,$2,$3,$4,$5)',
      [candidate.id, 'shapon-cancel-owner', candidateKey, hash('wrong-restore-intent'), candidateClaim.operationId]), /restore identity mismatch/);
    await assert.rejects(restoreNotSent(candidate, candidateClaim, candidateKey, 'shapon-cancel-stranger'), /restore identity mismatch/);
    const restored = await restoreNotSent(candidate, candidateClaim, candidateKey);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.walletMutation, false);
    assert.equal(restored.status, prior.status);
    assert.equal(restored.lifecycleStatus, prior.lifecycle_status);
    assert.deepEqual(await lifecycleSnapshot(candidate), prior);
    assert.deepEqual(await one('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]), fundsBeforeRestore);
    assert.deepEqual(await one('select operation_kind,operation_request_id,operation_started_at,active_operation_id from flight_bookings where id=$1', [candidate.id]),
      { operation_kind: null, operation_request_id: null, operation_started_at: null, active_operation_id: null });
    assert.equal((await restoreNotSent(candidate, candidateClaim, candidateKey)).replay, true);
    assert.equal((await one("select count(*)::int as n from booking_status_events where booking_id=$1 and idempotency_key=$2", [candidate.id, `${candidateKey}:cancel-not-sent`])).n, 1);
    assert.equal((await one('select state,error_code from booking_operations where id=$1', [candidateClaim.operationId])).error_code, 'CANCELLATION_NOT_SENT');
    assert.equal((await cancel(candidate, candidateKey)).code, 'CANCELLATION_NOT_SENT', 'The original client request remains terminal');
    const nextKey = `cancel:${randomUUID()}`;
    const nextClaim = await cancel(candidate, nextKey);
    assert.equal(nextClaim.ok, true, 'A restored booking accepts a new deliberate cancellation request');
    await start(nextClaim, nextKey);
    assert.equal((await restoreNotSent(candidate, nextClaim, nextKey)).code, 'CANCELLATION_DISPATCH_NOT_CLEAR');
    await receive(nextClaim, nextKey);
    assert.equal((await restoreNotSent(candidate, nextClaim, nextKey)).code, 'CANCELLATION_DISPATCH_NOT_CLEAR');
    assert.equal((await one('select status,active_operation_id from flight_bookings where id=$1', [candidate.id])).active_operation_id, nextClaim.operationId);
  }

  // Triplover compatibility cancellation keeps its existing no-funds policy.
  const triplover = await makeBooking({ supplier: 'triplover' });
  assert.equal((await cancel(triplover)).ok, true);
  const triploverExpired = await makeBooking({ supplier: 'triplover', deadline: '2020-01-01T12:00:00+06:00' });
  assert.equal((await cancel(triploverExpired)).code, 'BOOKING_EXPIRED');
  const triploverUnconfirmed = await makeBooking({ supplier: 'triplover', airlines: [] });
  assert.equal((await cancel(triploverUnconfirmed)).code, 'BOOKING_UNCONFIRMED');
  const triploverPending = await makeBooking({ supplier: 'triplover' });
  await db.query("update flight_bookings set status='pending' where id=$1", [triploverPending.id]);
  assert.equal((await cancel(triploverPending)).code, 'BOOKING_NOT_CANCELLABLE');
  console.log('Shapontravels cancellation database: four unticketed states, owner authorization, replay, competing issue claim, dispatch/finalization boundaries, safe pre-dispatch restore, saved supplier status and atomic hold release passed; Triplover scope preserved.');
} finally {
  await db.close();
}
