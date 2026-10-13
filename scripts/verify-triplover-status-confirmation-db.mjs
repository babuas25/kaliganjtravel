import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Full installed schema plus forward migrations; synthetic data only. No env,
// network, hosted database, supplier requests, or actual notification delivery.
const db = new PGlite({ extensions: { pgcrypto } });
const directory = 'supabase/fresh-install/supabase/migrations';
const migration = '20261013000000_triplover_supplier_status_confirmation.sql';
const hash = value => createHash('sha256').update(value).digest('hex');
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rpc = async (sql, params = []) => (await one(sql, params)).result;
const admin = 'triplover-confirm-admin';
const superadmin = 'triplover-confirm-superadmin';
const owner = 'triplover-confirm-owner';
const clone = value => JSON.parse(JSON.stringify(value));
let account;
let serial = 1234567890100;

async function makeBooking({ count = 2, carrier = '6E', originalHold = true } = {}) {
  const id = randomUUID(), operationId = randomUUID(), caseId = randomUUID();
  const transaction = randomUUID(), bookingCode = randomUUID();
  const refs = { uniqueTransId: transaction, itemCodeRef: randomUUID(), priceCodeRef: randomUUID() };
  const requestKey = `test-issue:${id}`;
  const attemptId = randomUUID();
  await db.query(`insert into booking_attempts(id,access_token_hash,user_id,audience,supplier,supplier_account,state,
    search_id,itinerary_id,unique_trans_id,item_code_ref,price_code_ref,offer_snapshot,expires_at)
    values($1,$2,$3,'b2c','triplover','triplover','succeeded',$4,'synthetic-itinerary',$5,$6,$7,'{}',now()+interval '1 day')`,
  [attemptId, hash(attemptId), owner, randomUUID(), transaction, refs.itemCodeRef, refs.priceCodeRef]);
  await db.query(`insert into flight_bookings(id,access_token_hash,user_id,audience,search_id,itinerary_id,
    status,currency,pricing_snapshot,passenger_counts,travel_date,direct_ticketing,supplier_refs,
    repriced_at,accepted_at,expires_at,passengers,pnr,airlines_pnr,booking_ref_number,
    booking_status,booking_code_ref,ticket_numbers,supplier,supplier_account,itinerary,
    created_at,user_payable_amount,legacy_operational,attempt_id)
    values($1,$2,$3,'b2c',$4,'synthetic-itinerary','on-hold','BDT',$5,$6,'2030-01-01',false,$7,
      now(),now(),now()+interval '1 day',$8,'ABC123','["ABC123"]','ABC123','Booked',$9,'[]',
      'triplover','triplover',$10,now()-interval '10 minutes',50025,false,$11)`,
  [id, hash(id), owner, randomUUID(), JSON.stringify({ sellingPrice: 500.25, supplierTotalPrice: 450.25 }),
    JSON.stringify({ ADT: count }), JSON.stringify(refs), JSON.stringify({ travellers: Array.from({ length: count },
      (_, index) => ({ firstName: `Synthetic${index}`, lastName: 'Traveller', passengerType: 'ADT' })) }), bookingCode,
    JSON.stringify({ carrierCode: carrier, legs: [{ segments: [{ airlineCode: carrier }] }] }), attemptId]);
  let reservationId = null;
  if (originalHold) {
    const reservation = await rpc(`select wallet_reserve_amount($1,null,'user',$2,50025,'BDT',$2,'customer',$3,null) as result`,
      [id, owner, `test-hold:${id}`]);
    assert.equal(reservation.ok, true, JSON.stringify(reservation));
    reservationId = (await one('select id from wallet_reservations where booking_id=$1', [id])).id;
    await db.query(`update wallet_reservations set state='reconciliation',supplier_call_started_at=now()-interval '100 seconds',reconciliation_at=now(),
      reconciliation_reason='Incomplete supplier response' where id=$1`, [reservationId]);
  }
  await db.query(`insert into booking_operations(id,booking_id,kind,state,reason_code,request_key,request_payload_hash,
    actor_user_id,actor_role,source,supplier,supplier_operation,supplier_unique_trans_id,
    supplier_booking_code_ref,supplier_pnr,supplier_evidence,error_code,error_message,
    claimed_at,supplier_call_started_at,supplier_response_received_at,reconciliation_required_at)
    values($1,$2,'ticketing','needs_reconciliation','issue',$3,$4,$5,'customer','customer',
      'triplover','NewTicket',$6,$7,'ABC123','{"httpStatus":200,"responseObserved":true}',
      'INCOMPLETE_RESPONSE','Synthetic incomplete response',now()-interval '2 minutes',
      now()-interval '90 seconds',now()-interval '60 seconds',now()-interval '30 seconds')`,
  [operationId, id, requestKey, hash(requestKey), owner, transaction, bookingCode]);
  await db.query(`update flight_bookings set status='in-progress',payment_state=$1,payment_amount=$2,
    charged_wallet_account_id=$3,active_operation_id=$4,operation_kind='reconciliation',
    operation_reason='ticketing_reconciliation',operation_started_at=now()-interval '2 minutes',
    operation_prior_status='on-hold' where id=$5`,
  [originalHold ? 'reconciliation' : 'unpaid', originalHold ? 50025 : null,
    originalHold ? account.id : null, operationId, id]);
  await db.query(`insert into booking_reconciliation_cases(id,subject_booking_id,operation_id,case_type,state,
    reason_code,opened_source,opened_by_user_id,opened_by_role)
    values($1,$2,$3,'ticketing_uncertainty','open','incomplete_response','operation','system:test','system')`,
  [caseId, id, operationId]);
  const facts = { verified: true, verifiedStatus: 'issued', supplierStatus: 'Issued', pnr: 'ABC123', airlinePnrs: ['ABC123'],
    tickets: Array.from({ length: count }, (_, passengerIndex) => ({ passengerIndex,
      ticketNumbers: [carrier === '6E' ? 'ABC123' : String(++serial)] })),
    ticketCodeRef: null, issuedAt: new Date(Date.now() - 15_000).toISOString(), supplierPayableMinor: 45025,
    currency: 'BDT', reason: null, source: 'ticket_report', rawPayloadHash: hash(`supplier-read:${id}`) };
  return { id, operationId, caseId, reservationId, facts, requestKey: `triplover-issued-hold:v1:${randomUUID()}` };
}

async function context(subject, actor = admin, role = 'admin') {
  return rpc('select triplover_status_check_context_v1($1,$2,$3) as result', [subject.id, actor, role]);
}
async function record(subject, facts = subject.facts, actor = admin, role = 'admin', snapshotHash) {
  const contextHash = snapshotHash ?? (await context(subject, actor, role)).bookingSnapshotHash;
  return rpc('select record_triplover_status_check_v1($1,$2,$3,$4,$5) as result',
    [subject.id, actor, role, contextHash, JSON.stringify(facts)]);
}
async function preview(subject, check = subject.check, actor = admin, role = 'admin') {
  return rpc('select preview_triplover_issued_hold_confirmation_v1($1,$2,$3,$4) as result',
    [subject.id, actor, role, check.checkId]);
}
async function prepare(subject, actor = admin, role = 'admin') {
  subject.check = await record(subject, subject.facts, actor, role);
  assert.equal(subject.check.ok, true, JSON.stringify(subject.check));
  subject.preview = await preview(subject, subject.check, actor, role);
  assert.equal(subject.preview.eligible, true, JSON.stringify(subject.preview));
  return subject;
}
async function confirm(subject, { actor = admin, role = 'admin', checkId = subject.check.checkId,
  previewHash = subject.preview.previewHash, requestKey = subject.requestKey, confirmation = true } = {}) {
  return rpc('select confirm_triplover_issued_hold_v1($1,$2,$3,$4,$5,$6,$7) as result',
    [subject.id, actor, role, checkId, previewHash, requestKey, confirmation]);
}
async function snapshot() {
  const result = {};
  for (const table of ['flight_bookings','wallets','wallet_accounts','wallet_reservations','wallet_ledger_entries',
    'booking_operations','booking_reconciliation_cases','booking_status_events','booking_notification_outbox',
    'booking_issued_sms_deliveries','triplover_booking_status_checks','triplover_issued_hold_confirmations']) {
    result[table] = (await one(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by t::text),'[]'::jsonb)::text) as hash from ${table} t`)).hash;
  }
  return result;
}
async function rejected(subject, options, code) {
  const before = await snapshot();
  const result = await confirm(subject, options);
  assert.equal(result.ok, false, JSON.stringify(result));
  if (code) assert.equal(result.code, code, JSON.stringify(result));
  assert.deepEqual(await snapshot(), before, `${result.code}: zero financial/booking/audit/outbox writes`);
}
async function temporary(sql, params, task) {
  await db.exec('begin');
  try { await db.query(sql, params); await task(); } finally { await db.exec('rollback'); }
}

try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;create schema extensions;create extension pgcrypto with schema extensions;`);
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.sql')).sort();
  assert.ok(files.includes(migration));
  for (const file of files) await db.exec(fs.readFileSync(`${directory}/${file}`, 'utf8'));
  await db.query(`insert into app_users(clerk_id,role) values($1,'customer'),($2,'admin'),($3,'superadmin'),
    ('triplover-confirm-support','staff_support'),('triplover-confirm-accounts','staff_account')`, [owner, admin, superadmin]);
  account = await one("select (wallet_ensure_account('user',$1,'BDT')).*", [owner]);
  await db.query('update wallet_accounts set available_balance=10000000 where id=$1', [account.id]);
  for (const table of ['triplover_booking_status_checks','triplover_issued_hold_confirmations']) {
    assert.equal((await one('select relrowsecurity as enabled from pg_class where oid=$1::regclass', [table])).enabled, true);
    for (const role of ['anon','authenticated','service_role']) {
      for (const operation of ['INSERT','UPDATE','DELETE']) assert.equal((await one('select has_table_privilege($1,$2,$3) as allowed',
        [role, table, operation])).allowed, false);
      assert.equal((await one("select has_table_privilege($1,$2,'SELECT') as allowed", [role, table])).allowed, role === 'service_role');
    }
  }
  for (const signature of ['triplover_status_check_context_v1(uuid,text,text)',
    'record_triplover_status_check_v1(uuid,text,text,text,jsonb)',
    'preview_triplover_issued_hold_confirmation_v1(uuid,text,text,uuid)',
    'confirm_triplover_issued_hold_v1(uuid,text,text,uuid,text,text,boolean)']) {
    for (const role of ['anon','authenticated','service_role']) assert.equal((await one("select has_function_privilege($1,$2,'EXECUTE') as allowed",
      [role, signature])).allowed, role === 'service_role');
  }
  for (const signature of ['triplover_status_snapshot_v1(uuid)','triplover_status_records_immutable_v1()']) {
    assert.equal((await one("select has_function_privilege('service_role',$1,'EXECUTE') as allowed", [signature])).allowed, false);
  }

  const subject = await prepare(await makeBooking());
  const savedContext = await context(subject);
  assert.equal(savedContext.booking.id, subject.id, 'locked context returns the exact saved identity for the supplier read');
  assert.equal(savedContext.booking.lifecycle_status, 'in-progress', 'context preserves the canonical local lifecycle while supplier status is checked separately');
  assert.equal(savedContext.booking.supplier_refs.uniqueTransId,
    (await one('select supplier_refs from flight_bookings where id=$1', [subject.id])).supplier_refs.uniqueTransId);
  const sibling = await makeBooking({ carrier: 'BG', count: 1 });
  subject.preview = await preview(subject);
  assert.equal(subject.preview.eligible, true, JSON.stringify(subject.preview));
  assert.equal(subject.preview.protectedHold, 50025);
  for (const [actor, role] of [['missing-actor','admin'],[null,'admin'],['triplover-confirm-support','staff_support'],
    ['triplover-confirm-accounts','staff_account'],[owner,'customer']]) {
    assert.equal((await context(subject, actor, role)).ok, false);
    await rejected(subject, { actor, role }, 'CONFIRMATION_FORBIDDEN');
  }
  await rejected(subject, { role: 'superadmin' }, 'ACTOR_ROLE_MISMATCH');
  await rejected(subject, { role: null }, 'ACTOR_ROLE_MISMATCH');
  await rejected(subject, { confirmation: false }, 'MONEY_MOVEMENT_CONFIRMATION_REQUIRED');
  await rejected(subject, { confirmation: null }, 'MONEY_MOVEMENT_CONFIRMATION_REQUIRED');
  await rejected(subject, { previewHash: hash('changed-preview') }, 'PREVIEW_CHANGED');
  await rejected(subject, { checkId: randomUUID() }, 'STATUS_CHECK_NOT_FOUND');

  const stale = await one(`insert into triplover_booking_status_checks(booking_id,actor_user_id,actor_role,
    booking_snapshot_hash,facts,checked_at,expires_at) values($1,$2,'admin',$3,$4,now()-interval '10 minutes',now()-interval '5 minutes') returning id`,
  [subject.id, admin, (await context(subject)).bookingSnapshotHash, JSON.stringify(subject.facts)]);
  assert.equal((await preview(subject, { checkId: stale.id })).code, 'STATUS_CHECK_SUPERSEDED');
  await temporary('update flight_bookings set pnr=$1 where id=$2', ['OTHER1', subject.id],
    () => rejected(subject, {}, 'BOOKING_STATE_CHANGED'));
  await temporary('update wallet_accounts set available_balance=available_balance+1 where id=$1', [account.id],
    () => rejected(subject, {}, 'PREVIEW_CHANGED'));
  await temporary('update wallet_accounts set hold_balance=hold_balance-1 where id=$1', [account.id],
    () => rejected(subject, {}, 'PROTECTED_HOLD_ACCOUNTING_CONFLICT'));
  await temporary('update wallet_reservations set amount=amount+1 where id=$1', [subject.reservationId],
    () => rejected(subject, {}, 'BOOKING_STATE_CHANGED'));
  await temporary("update booking_operations set state='supplier_call_started' where id=$1", [subject.operationId],
    () => rejected(subject, {}, 'BOOKING_STATE_CHANGED'));

  const beforeRecord = await snapshot();
  assert.equal((await record(subject, subject.facts, admin, 'admin', hash('outdated-booking'))).code, 'BOOKING_STATE_CHANGED');
  assert.deepEqual(await snapshot(), beforeRecord);
  const next = await record(subject);
  assert.equal((await preview(subject)).code, 'STATUS_CHECK_SUPERSEDED');
  subject.check = next; subject.preview = await preview(subject);
  assert.equal(subject.preview.eligible, true, JSON.stringify(subject.preview));

  for (const mutate of [facts => { facts.verified = false; }, facts => { facts.verifiedStatus = 'held'; },
    facts => { facts.pnr = 'OTHER1'; }, facts => { facts.supplierPayableMinor += 1; },
    facts => { facts.issuedAt = '2000-01-01T00:00:00Z'; }, facts => { facts.source = 'unavailable'; },
    facts => { facts.tickets[1].passengerIndex = 0; }, facts => { facts.tickets.pop(); },
    facts => { facts.tickets[0].ticketNumbers = ['WRONG1']; },
    facts => { facts.tickets.forEach(ticket => { ticket.ticketNumbers = ['1234567890123']; }); }]) {
    const facts = clone(subject.facts); mutate(facts);
    const check = await record(subject, facts);
    assert.equal(check.ok, true, JSON.stringify(check));
    assert.equal((await preview(subject, check)).eligible, false, JSON.stringify(facts));
  }
  subject.check = await record(subject); subject.preview = await preview(subject);
  assert.equal(subject.preview.eligible, true, JSON.stringify(subject.preview));
  await assert.rejects(() => db.query('update triplover_booking_status_checks set facts=$1 where id=$2',
    [JSON.stringify({ ...subject.facts, verified: false }), subject.check.checkId]), /immutable/);
  await assert.rejects(() => db.query('delete from triplover_booking_status_checks where id=$1', [subject.check.checkId]), /immutable/);

  // A downstream failure after account/reservation/ledger mutations must roll
  // back the entire capture, lifecycle event, outbox and immutable decision.
  await db.exec(`create function test_triplover_fail_event() returns trigger language plpgsql as $$begin
    if new.supplier_operation='TriploverIssuedHoldConfirmation' then raise exception 'synthetic event failure';end if;
    return new;end;$$;create trigger test_triplover_fail_event before insert on booking_status_events
    for each row execute function test_triplover_fail_event();`);
  const beforeFailure = await snapshot();
  await assert.rejects(() => confirm(subject), /synthetic event failure/);
  assert.deepEqual(await snapshot(), beforeFailure, 'finalizer rolls back all writes after a downstream failure');
  await db.exec('drop trigger test_triplover_fail_event on booking_status_events;drop function test_triplover_fail_event()');
  const balances = await one('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]);
  const siblingBefore = await one('select * from wallet_reservations where id=$1', [sibling.reservationId]);
  await db.exec('set role service_role');
  const result = await confirm(subject);
  await db.exec('reset role');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.amount, 50025); assert.equal(result.currency, 'BDT');
  assert.equal(result.bookingReference, (await one('select public_ref from flight_bookings where id=$1', [subject.id])).public_ref);
  const after = await one('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]);
  assert.equal(after.available_balance, balances.available_balance, 'capture never debits Available');
  assert.equal(Number(balances.hold_balance) - Number(after.hold_balance), 50025);
  assert.deepEqual(await one('select * from wallet_reservations where id=$1', [sibling.reservationId]), siblingBefore);
  const booking = await one('select * from flight_bookings where id=$1', [subject.id]);
  assert.equal(booking.status, 'confirmed'); assert.equal(booking.payment_state, 'captured');
  assert.deepEqual(booking.ticket_numbers, ['ABC123','ABC123']);
  assert.equal(booking.ticket_code_ref, null, 'no synthetic supplier ticket token');
  assert.equal(new Date(booking.issued_at).toISOString(), subject.facts.issuedAt);
  assert.equal(booking.active_operation_id, null); assert.equal(booking.operation_kind, null);
  assert.equal((await one('select state from booking_operations where id=$1', [subject.operationId])).state, 'succeeded');
  assert.equal((await one('select state from booking_reconciliation_cases where id=$1', [subject.caseId])).state, 'resolved');
  const ledger = (await db.query("select * from wallet_ledger_entries where booking_id=$1 order by created_at", [subject.id])).rows;
  assert.deepEqual(ledger.map(row => row.transaction_type), ['booking_hold','booking_confirm']);
  assert.equal(ledger[1].reservation_id, subject.reservationId);
  assert.equal(ledger[1].available_before, ledger[1].available_after);
  assert.equal((await one(`select count(*)::int as count from booking_notification_outbox o
    join booking_status_events e on e.id=o.lifecycle_event_id where e.id=$1 and o.lifecycle_status='confirmed'`, [result.lifecycleEventId])).count, 1);
  const replayState = await snapshot();
  // Latest proof changes and expires independently; a committed exact intent
  // still replays without supplier reads or any financial writes.
  assert.equal((await confirm(subject)).replay, true);
  assert.deepEqual(await snapshot(), replayState);
  await rejected(subject, { actor: superadmin, role: 'superadmin' }, 'CONFIRMATION_REQUEST_CONFLICT');
  await rejected(subject, { previewHash: hash('different-intent') }, 'CONFIRMATION_REQUEST_CONFLICT');
  await rejected(subject, { checkId: next.checkId }, 'CONFIRMATION_REQUEST_CONFLICT');
  await assert.rejects(() => db.query('delete from triplover_issued_hold_confirmations where booking_id=$1', [subject.id]), /immutable/);
  await assert.rejects(() => db.query('update triplover_issued_hold_confirmations set result=$1 where booking_id=$2', ['{}', subject.id]), /immutable/);

  const missingHold = await makeBooking({ originalHold: false });
  missingHold.check = await record(missingHold);
  assert.equal((await preview(missingHold)).eligible, false, 'no new debit when no original hold exists');
  const expired = await makeBooking();
  const expiredHash = (await context(expired)).bookingSnapshotHash;
  const expiredCheck = await one(`insert into triplover_booking_status_checks(booking_id,actor_user_id,actor_role,
    booking_snapshot_hash,facts,checked_at,expires_at) values($1,$2,'admin',$3,$4,now()-interval '10 minutes',
    now()-interval '5 minutes') returning id`, [expired.id, admin, expiredHash, JSON.stringify(expired.facts)]);
  assert.equal((await preview(expired, { checkId: expiredCheck.id })).code, 'STATUS_CHECK_EXPIRED');
  for (const [sql, params, expectedCode] of [
    ["update booking_operations set supplier_evidence='{}' where id=$1", [expired.operationId], 'ORIGINAL_TICKETING_OPERATION_REQUIRED'],
    ["update booking_operations set supplier_evidence='{\"httpStatus\":409,\"responseObserved\":true}' where id=$1", [expired.operationId], 'ORIGINAL_TICKETING_OPERATION_REQUIRED'],
    ["update booking_operations set state='claimed' where id=$1", [expired.operationId], 'ORIGINAL_TICKETING_OPERATION_REQUIRED'],
    ["update booking_operations set supplier_pnr='OTHER1' where id=$1", [expired.operationId], 'ORIGINAL_TICKETING_OPERATION_REQUIRED'],
    ["update booking_reconciliation_cases set proposal_hash=$1,proposed_by_user_id=$2,proposed_at=now(),proposal='{\"version\":1,\"requestKey\":\"test-proposal\",\"domain\":\"combined_supplier_financial\",\"riskFlags\":[],\"confirmationCodes\":[],\"evidenceObservationIds\":[]}' where id=$3", [hash('existing-proposal'), admin, expired.caseId], 'RECONCILIATION_REVIEW_REQUIRED'],
    ["update wallets set owner_key='wrong-owner' where id=$1", [account.wallet_id], 'ORIGINAL_HOLD_IDENTITY_MISMATCH'],
    ["update wallet_reservations set state='released' where id=$1", [expired.reservationId], 'EXISTING_HOLD_ACCOUNTING_REQUIRED'],
    ["update wallet_reservations set supplier_call_started_at=now() where id=$1", [expired.reservationId], 'ORIGINAL_HOLD_IDENTITY_MISMATCH'],
  ]) await temporary(sql, params, async () => {
    expired.check = await record(expired);
    const rejectedPreview = await preview(expired);
    assert.equal(rejectedPreview.code, expectedCode, JSON.stringify(rejectedPreview));
    expired.preview = { previewHash: hash('never-eligible') };
    await rejected(expired, {}, expectedCode);
  });
  const confirmedCheck = await record(subject, { ...subject.facts, verified: false, verifiedStatus: 'unknown' });
  assert.equal(confirmedCheck.ok, true, 'settled bookings can still record status reads');
  const latestReplaySnapshot = await snapshot();
  assert.equal((await confirm(subject)).replay, true, 'cached intent does not depend on a later supplier check');
  assert.deepEqual(await snapshot(), latestReplaySnapshot);
  const normal = await prepare(await makeBooking({ carrier: 'BG', count: 1 }), superadmin, 'superadmin');
  assert.equal((await confirm(normal, { actor: superadmin, role: 'superadmin' })).ok, true);
  // A supplier-issued held booking without an eligible existing issue hold must
  // remain fenced from fresh NewTicket/Cancel claims, even when no current
  // reconciliation operation would otherwise stop the old claim functions.
  const externallyIssued = await makeBooking({ originalHold: false });
  await db.query("update booking_operations set state='failed',completed_at=now() where id=$1", [externallyIssued.operationId]);
  await db.query("update booking_reconciliation_cases set state='closed_no_change',resolved_at=now() where id=$1", [externallyIssued.caseId]);
  await db.query(`update flight_bookings set status='on-hold',payment_state='unpaid',active_operation_id=null,
    operation_kind=null,operation_reason=null,operation_started_at=null,operation_prior_status=null where id=$1`, [externallyIssued.id]);
  externallyIssued.check = await record(externallyIssued);
  assert.equal(externallyIssued.check.ok, true);
  for (const fn of ['wallet_begin_booking_issue_v2','begin_booking_cancellation_v2']) {
    const key = `fenced-operation:${randomUUID()}`;
    const beforeFence = await snapshot();
    await assert.rejects(() => rpc(`select ${fn}($1,$2,'admin',$3,$4) as result`,
      [externallyIssued.id, admin, key, hash(key)]), /TRIPLOVER_SUPPLIER_ISSUED_REVIEW_REQUIRED/);
    assert.deepEqual(await snapshot(), beforeFence, `${fn}: issued fence prevents any new hold/operation`);
  }
  const historicalReplayState = await snapshot();
  const historicalReplay = await rpc("select wallet_begin_booking_issue_v2($1,$2,'customer',$3,$4) as result",
    [externallyIssued.id, owner, `test-issue:${externallyIssued.id}`, hash(`test-issue:${externallyIssued.id}`)]);
  assert.equal(historicalReplay.replay, true, 'the issued fence does not block an existing original operation replay');
  assert.deepEqual(await snapshot(), historicalReplayState);
  const unknownFacts = { ...externallyIssued.facts, verified: false, verifiedStatus: 'unknown',
    supplierStatus: null, source: 'unavailable', reason: 'supplier_unavailable', rawPayloadHash: null };
  assert.equal((await record(externallyIssued, unknownFacts)).ok, true);
  const expiredFence = await makeBooking({ originalHold: false });
  await db.query("update booking_operations set state='failed',completed_at=now() where id=$1", [expiredFence.operationId]);
  await db.query("update booking_reconciliation_cases set state='closed_no_change',resolved_at=now() where id=$1", [expiredFence.caseId]);
  await db.query(`update flight_bookings set status='on-hold',payment_state='unpaid',active_operation_id=null,
    operation_kind=null,operation_reason=null,operation_started_at=null,operation_prior_status=null where id=$1`, [expiredFence.id]);
  const fencedHash = (await context(expiredFence)).bookingSnapshotHash;
  await db.query(`insert into triplover_booking_status_checks(booking_id,actor_user_id,actor_role,
    booking_snapshot_hash,facts,checked_at,expires_at) values($1,$2,'admin',$3,$4,
    now()-interval '10 minutes',now()-interval '5 minutes')`,
  [expiredFence.id, admin, fencedHash, JSON.stringify(expiredFence.facts)]);
  assert.equal((await record(expiredFence, unknownFacts)).ok, true);
  for (const fn of ['wallet_begin_booking_issue_v2','begin_booking_cancellation_v2']) {
    const key = `persistently-fenced:${randomUUID()}`;
    const beforeFence = await snapshot();
    await assert.rejects(() => rpc(`select ${fn}($1,$2,'admin',$3,$4) as result`,
      [expiredFence.id, admin, key, hash(key)]), /TRIPLOVER_SUPPLIER_ISSUED_REVIEW_REQUIRED/);
    assert.deepEqual(await snapshot(), beforeFence, 'expired/unknown later reads never erase issued stop signal');
  }
  console.log(JSON.stringify({ checks: 'passed', fullMigrationChain: files.length, adminAndSuperadmin: true,
    sharedIndigoPnr: true, originalHoldOnly: true, availableUnchanged: true, protectedSiblingHold: true,
    immutableEvidence: true, exactReplay: true, downstreamFailureAtomic: true, lifecycleOutbox: true,
    persistentIssuedOperationFence: true }));
} finally { await db.close(); }
