import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { artifactPath, forwardMigrationNames } from './helpers/shapon-recovery-database.mjs';

// Complete current migration chain, disposable PostgreSQL and synthetic money.
// No environment files, hosted database, supplier transport or notifications.
const db=new PGlite({extensions:{pgcrypto}});
const one=async(sql,params=[]) => (await db.query(sql,params)).rows[0];
const value=async(sql,params=[]) => (await one(sql,params)).result;
const digest=value => createHash('sha256').update(value).digest('hex');
const now=() => new Date().toISOString();
const owner='external-ticket-owner';
const admin='external-ticket-admin';
const migration='20261103000002_shapon_payment_resolution.sql';
let ticketNumber=1334567890120;
async function makeBooking({ count = 1, agency = null, sellingPrice = 500.25,
  carrier = 'BG', deadline = null, supplier = 'shapontravels' } = {}) {
  const attempt = randomUUID();
  const key = `external-book:${attempt}`;
  const refs = { uniqueTransId: randomUUID(), itemCodeRef: randomUUID(), priceCodeRef: randomUUID() };
  const offer = { currency: 'BDT', pricing: { sellingPrice, grossPrice: 600,
    supplierTotalPrice: 450, serviceMarginAmount: 50.25, audience: agency ? 'agency' : 'b2c', agencyCode: agency },
  passengerCounts: { ADT: count }, travelDate: '2030-01-01', directTicketing: false,
  itinerary: { carrierCode: carrier, legs: [{ segments: [{ airlineCode: carrier }] }] },
  fares: [], passportRequired: false, repricedAt: '2026-09-27T00:00:00Z' };
  const passengers = { travellers: Array.from({ length: count }, (_, index) =>
    ({ passengerType: 'ADT', firstName: `Synthetic${index}`, lastName: 'Traveller' })) };
  await db.query(`insert into booking_attempts(id,access_token_hash,user_id,audience,agency_code,
    supplier,supplier_account,state,search_id,itinerary_id,unique_trans_id,item_code_ref,
    price_code_ref,offer_snapshot,passenger_snapshot,expires_at,submitted_at,
    operation_request_key,operation_request_payload_hash,supplier_call_started_at,
    supplier_response_received_at,supplier_operation)
    values ($1,$2,$3,$4,$5,$6,$6,'submitting',$7,'external-ticket',
      $8,$9,$10,$11,$12,now()+interval '10 minutes',now(),$13,$14,now(),now(),'Book')`,
  [attempt, digest(attempt), agency ? 'external-ticket-b2b' : owner, agency ? 'agency' : 'b2c', agency,
    supplier, randomUUID(), refs.uniqueTransId, refs.itemCodeRef, refs.priceCodeRef,
    JSON.stringify(offer), JSON.stringify(passengers), key, digest(key)]);
  const outcome = { status: 'held', pnr: 'ABC123', airlinesPnr: ['ABC123'],
    bookingRefNumber: 'ABC123', supplierPublicRef: `STR${attempt.replaceAll('-', '').toUpperCase()}`,
    bookingStatus: 'Created', ticketingTimeLimit: deadline, bookingCodeRef: randomUUID(),
    supplierRefs: refs, ticketCodeRef: null, ticketNumbers: [], warnings: [] };
  const finalizer = supplier === 'shapontravels'
    ? 'create_shapontravels_booking_from_attempt_v1' : 'create_booking_from_attempt_v2';
  const booking = await one(`select (${finalizer}($1,$2,$3,$4)).*`,
    [attempt, key, digest(key), JSON.stringify(outcome)]);
  assert.match(booking.public_ref, /^KTT[0-9]{12,16}$/, 'Native booking references retain the active Kaliganj brand');
  const identity = { ...refs, bookingCodeRef: outcome.bookingCodeRef,
    bookingRefNumber: outcome.bookingRefNumber, pnr: outcome.pnr,
    supplierPublicRef: outcome.supplierPublicRef, originalBookingStatus: 'Created' };
  const passengerTickets = Array.from({ length: count }, () =>
    ({ ticketNumbers: [String(++ticketNumber)], ticketNumberSource: null }));
  const proof = { verified: true, issued: true, paid: true, source: 'supplier_ticket_details',
    bookingStatus: 'Confirmed', paymentStatus: 'Paid', pnr: outcome.pnr,
    ticketCodeRef: randomUUID(), ticketNumbers: passengerTickets.flatMap(row => row.ticketNumbers),
    passengerCount: count, passengerTickets, airlinesPnr: ['ABC123'] };
  return { booking, identity, proof, requestId: randomUUID() };
}


async function snapshot() {
  const result={};
  for(const table of ['flight_bookings','wallets','wallet_accounts','wallet_reservations','wallet_ledger_entries',
    'shapon_external_ticket_confirmations','booking_payment_returns','booking_operations','booking_reconciliation_cases',
    'booking_status_events','booking_notification_outbox']) {
    result[table]=(await one(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by t::text),'[]'::jsonb)::text) as hash from ${table} t`)).hash;
  }
  return result;
}
async function preview(subject,actor=admin,role='admin') {
  return value('select preview_shapon_ticket_payment_v1($1,$2,$3) as result',[subject.booking.id,actor,role]);
}
async function confirm(subject,options={}) {
  const current=options.preview??await preview(subject);
  const proof=options.proof??{...subject.proof,expectedPaymentEffect:current.paymentEffect,expectedPayableAmount:current.amount};
  return value('select confirm_shapon_external_ticket_v1($1,$2,$3,$4,$5,$6,$7,$8) as result',[
    subject.booking.id,options.actor??admin,options.role??'admin',options.requestId??subject.requestId,
    options.charge??true,options.nullProof?null:JSON.stringify(options.identity??subject.identity),
    options.nullProof?null:JSON.stringify(proof),options.checkedAt??now()]);
}
async function claim(subject) {
  const requestKey=`policy-issue:${randomUUID()}`;
  const actor=subject.booking.audience==='agency'?'external-ticket-b2b':owner;
  const role=subject.booking.audience==='agency'?'b2b':'customer';
  const result=await value('select wallet_begin_booking_issue_v2($1,$2,$3,$4,$5) as result',[
    subject.booking.id,actor,role,requestKey,digest(requestKey)]);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal((await value('select mark_booking_operation_supplier_call_started($1,$2,$3) as result',[
    result.operationId,requestKey,digest(requestKey)])).started,true);
  return {...subject,operationId:result.operationId,requestKey,actor,role};
}
async function uncertain(subject) {
  const item=await claim(subject);
  const facts={failureClass:'uncertain',automaticReplayAllowed:false};
  const result=await value('select record_supplier_write_uncertainty_v2($1,null,$2,$3,$4,$5,$6,$7,202,true,true,$8,$9,$10) as result',[
    item.booking.id,item.operationId,item.actor,item.role,item.requestKey,digest(item.requestKey),
    'incomplete_response',JSON.stringify(facts),digest(JSON.stringify(facts)),'Synthetic incomplete issue']);
  assert.equal(result.ok,true,JSON.stringify(result));
  return {...item,caseId:result.caseId};
}
async function paid(subject,status='on-hold',stale=false) {
  const item=await claim(subject);
  assert.equal((await value('select mark_booking_operation_supplier_response_received($1,$2,$3,200) as result',[
    item.operationId,item.requestKey,digest(item.requestKey)])).ok,true);
  const result=await value('select wallet_capture_reservation_v2($1,$2,$3,$4,$5,$6,$7) as result',[
    item.booking.id,item.actor,item.role,item.requestKey,digest(item.requestKey),item.operationId,
    JSON.stringify({pnr:item.booking.pnr,bookingStatus:'Confirmed',ticketCodeRef:item.proof.ticketCodeRef,
      ticketNumbers:item.proof.ticketNumbers,airlinesPnr:item.proof.airlinesPnr})]);
  assert.equal(result.ok,true,JSON.stringify(result));
  const capture=await one("select * from wallet_ledger_entries where booking_id=$1 and transaction_type='booking_confirm'",[item.booking.id]);
  await db.query('update flight_bookings set status=$2 where id=$1',[item.booking.id,status]);
  if(stale) await db.query("update flight_bookings set payment_state='unpaid',captured_amount=0,payment_amount=null,charged_wallet_account_id=null where id=$1",[item.booking.id]);
  return {...item,capture};
}
async function reconcilingPaid(subject) {
  const item=await paid(subject);
  await db.query("update booking_operations set state='needs_reconciliation',completed_at=null,reconciliation_required_at=now() where id=$1",[item.operationId]);
  await db.query(`update flight_bookings set status='in-progress',operation_kind='reconciliation',
    operation_reason='ticketing_reconciliation',active_operation_id=$2,operation_request_id=$3,
    operation_actor_user_id=$4,operation_started_at=now(),operation_prior_status='on-hold' where id=$1`,[
    item.booking.id,item.operationId,item.requestKey,item.actor]);
  const caseRow=await one(`insert into booking_reconciliation_cases(subject_booking_id,operation_id,case_type,
    reason_code,opened_source,opened_by_user_id,opened_by_role) values($1,$2,'ticketing_uncertainty',
    'post_capture_status_missing','operation',$3,$4) returning id`,[item.booking.id,item.operationId,item.actor,item.role]);
  return {...item,caseId:caseRow.id};
}
async function returnPreview(subject,actor=admin,role='admin') {
  return value('select preview_booking_payment_return_v1($1,$2,$3) as result',[subject.booking.id,actor,role]);
}
async function paymentReturn(subject,context,options={}) {
  return value('select return_booking_payment_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result',[
    subject.booking.id,options.actor??admin,options.role??'admin',options.requestId??subject.returnRequestId??subject.requestId,
    options.captureId??context.captureLedgerEntryId,options.refunded??context.refundedAmount,
    options.refundable??context.refundableAmount,options.available??context.availableBalance,
    options.hold??context.holdBalance,options.confirmation??true,options.reason??'Return mistaken wallet charge']);
}
async function expectUnchanged(action,code) {
  const before=await snapshot();const result=await action();
  assert.equal(result.ok,false,JSON.stringify(result));
  if(code)assert.equal(result.code,code,JSON.stringify(result));
  assert.deepEqual(await snapshot(),before,'Rejected action must change no business, ledger, audit or notification rows');
  return result;
}

try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;create schema extensions;create extension pgcrypto with schema extensions;`);
  const files=[path.basename(artifactPath),...forwardMigrationNames];
  assert.ok(files.includes(migration),'Register the new forward migration in the active chain');
  const index=files.indexOf(migration);
  for(const file of files.slice(0,index))await db.exec(fs.readFileSync(path.join(path.dirname(artifactPath),file),'utf8'));
  await db.exec(`insert into app_users(clerk_id,role) values('${owner}','customer'),('${admin}','admin'),
    ('policy-superadmin','superadmin'),('policy-support','staff_support'),('policy-account','staff_account'),
    ('external-ticket-b2b','b2b'),('different-owner','customer');
    insert into agencies(agency_code,owner_user_id) values('ST-B2B000001','external-ticket-b2b');
    update app_users set agency_code='ST-B2B000001' where clerk_id='external-ticket-b2b';`);
  const account=await one("select(wallet_ensure_account('user',$1,'BDT')).*",[owner]);
  const agencyAccount=await one("select(wallet_ensure_account('agency','ST-B2B000001','BDT')).*");
  const otherAccount=await one("select(wallet_ensure_account('user','different-owner','BDT')).*");
  await db.query('update wallet_accounts set available_balance=100000000 where id in($1,$2,$3)',[account.id,agencyAccount.id,otherAccount.id]);
  // Historical decisions are committed under the previous installed policy.
  const historical=[];
  for(const charge of [true,false]) {
    const subject=await makeBooking();
    const result=await value('select confirm_shapon_external_ticket_v1($1,$2,$3,$4,$5,$6,$7,$8) as result',[
      subject.booking.id,admin,'admin',subject.requestId,charge,JSON.stringify(subject.identity),JSON.stringify(subject.proof),now()]);
    assert.equal(result.ok,true,JSON.stringify(result));historical.push({subject,charge});
  }
  for(const file of files.slice(index))await db.exec(fs.readFileSync(path.join(path.dirname(artifactPath),file),'utf8'));
  const catalog=await one(`select(select count(*)::int from pg_tables where schemaname='public')as tables,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.prokind='f')as functions`);
  for(const {subject,charge}of historical) {
    const before=await snapshot();
    const replay=await confirm(subject,{charge,nullProof:true});
    assert.equal(replay.replay,true);assert.equal(replay.chargeWallet,charge);
    assert.equal(replay.paymentState,charge?'captured':'unpaid');assert.equal(replay.chargedAmount,charge?50025:0);
    assert.deepEqual(await snapshot(),before,'Historical charge/no-charge decisions retain exact read-only replay');
  }
  for(const agency of [null,'ST-B2B000001']) {
    const ownerAccount=agency?agencyAccount:account;
    // New unpaid/no-hold confirmations require payment. No-free-confirm is
    // enforced by SQL even if an obsolete UI sends the previous boolean.
    const ordinary=await makeBooking({agency});
    await expectUnchanged(()=>confirm(ordinary,{charge:false}),'PAYMENT_REQUIRED');
    await expectUnchanged(()=>confirm(ordinary,{proof:ordinary.proof}),'PAYMENT_PREVIEW_REQUIRED');
    const expected=await preview(ordinary);
    assert.equal(expected.paymentEffect,'charge_wallet');assert.equal(expected.amount,50025);
    const before=await one('select available_balance,hold_balance from wallet_accounts where id=$1',[ownerAccount.id]);
    assert.equal((await confirm(ordinary,{preview:expected})).ok,true);
    const after=await one('select available_balance,hold_balance from wallet_accounts where id=$1',[ownerAccount.id]);
    assert.equal(Number(after.available_balance),Number(before.available_balance)-50025);assert.equal(after.hold_balance,before.hold_balance);
    // Supplier-issued recovery must capture its original hold, never release it.
    const held=await uncertain(await makeBooking({agency}));
    const heldPreview=await preview(held);
    assert.equal(heldPreview.paymentEffect,'capture_hold');assert.equal(heldPreview.existingHoldAmount,50025);
    await expectUnchanged(()=>confirm(held,{charge:false}),'PAYMENT_REQUIRED');
    const heldBefore=await one('select available_balance,hold_balance from wallet_accounts where id=$1',[ownerAccount.id]);
    const settled=await confirm(held,{preview:heldPreview});assert.equal(settled.ok,true,JSON.stringify(settled));
    assert.equal(settled.paymentEffect,'capture_hold');assert.equal(settled.chargedAmount,50025);
    const heldAfter=await one('select available_balance,hold_balance from wallet_accounts where id=$1',[ownerAccount.id]);
    assert.equal(heldAfter.available_balance,heldBefore.available_balance);
    assert.equal(Number(heldAfter.hold_balance),Number(heldBefore.hold_balance)-50025);
    assert.equal((await one('select state from wallet_reservations where booking_id=$1',[held.booking.id])).state,'captured');
    assert.equal((await one("select count(*)::int as n from wallet_ledger_entries where booking_id=$1 and transaction_type='hold_release'",[held.booking.id])).n,0);
    assert.equal((await one('select state from booking_reconciliation_cases where id=$1',[held.caseId])).state,'resolved');
    // Genuine original captures can repair stale status/flags without a debit.
    for(const inProgress of [false,true]) {
      const already=inProgress?await reconcilingPaid(await makeBooking({agency})):await paid(await makeBooking({agency}),'on-hold',true);
      const paidPreview=await preview(already);assert.equal(paidPreview.paymentEffect,'already_paid',JSON.stringify(paidPreview));
      const moneyBefore=await one('select available_balance,hold_balance from wallet_accounts where id=$1',[ownerAccount.id]);
      const captureBefore=await one("select count(*)::int as n from wallet_ledger_entries where booking_id=$1 and transaction_type='booking_confirm'",[already.booking.id]);
      const result=await confirm(already,{preview:paidPreview});assert.equal(result.ok,true,JSON.stringify(result));
      assert.equal(result.charged,false);assert.equal(result.chargedAmount,0);assert.equal(result.paymentState,'captured');
      assert.equal(result.originalCaptureLedgerEntryId,already.capture.id);
      assert.deepEqual(await one('select available_balance,hold_balance from wallet_accounts where id=$1',[ownerAccount.id]),moneyBefore);
      assert.deepEqual(await one("select count(*)::int as n from wallet_ledger_entries where booking_id=$1 and transaction_type='booking_confirm'",[already.booking.id]),captureBefore);
      assert.equal((await one('select status,payment_state,captured_amount from flight_bookings where id=$1',[already.booking.id])).status,'confirmed');
      if(inProgress)assert.equal((await one('select state from booking_reconciliation_cases where id=$1',[already.caseId])).state,'resolved');
      const committed=await snapshot();assert.equal((await confirm(already,{nullProof:true})).replay,true);assert.deepEqual(await snapshot(),committed);
    }
  }
  const retainedUuid=await paid(await makeBooking());
  const knownIssueTime=(await one('select issued_at from flight_bookings where id=$1',[retainedUuid.booking.id])).issued_at;
  const retainedProof={...retainedUuid.proof,source:'supplier_saved_ticket_details',schemaVersion:1,ticketCodeRef:null};
  const retainedPreview=await preview(retainedUuid);
  assert.equal((await confirm(retainedUuid,{proof:{...retainedProof,expectedPaymentEffect:retainedPreview.paymentEffect,expectedPayableAmount:retainedPreview.amount}})).ok,true);
  const retainedRow=await one('select ticket_code_ref,issued_at from flight_bookings where id=$1',[retainedUuid.booking.id]);
  assert.equal(retainedRow.ticket_code_ref,retainedUuid.proof.ticketCodeRef,'A matching full numeric ticket snapshot preserves a previously known supplier UUID');
  assert.equal(retainedRow.issued_at.toISOString(),knownIssueTime.toISOString(),'Missing fresh supplier issue time never erases known history');
  for(const kind of ['changed-number','wrong-uuid']) {
    const subject=await paid(await makeBooking());const context=await preview(subject);
    const proof={...subject.proof,expectedPaymentEffect:context.paymentEffect,expectedPayableAmount:context.amount};
    if(kind==='wrong-uuid')proof.ticketCodeRef=randomUUID();
    else {proof.source='supplier_saved_ticket_details';proof.schemaVersion=1;proof.ticketCodeRef=null;
      proof.ticketNumbers=['1888888888888'];proof.passengerTickets=[{ticketNumbers:proof.ticketNumbers,ticketNumberSource:null}];}
    await expectUnchanged(()=>confirm(subject,{proof}),'BOOKING_TICKET_CONFLICT');
  }
  const race=await makeBooking();
  const oldPreview=await preview(race);assert.equal(oldPreview.paymentEffect,'charge_wallet');
  const changed=await uncertain(race);
  await expectUnchanged(()=>confirm(changed,{preview:oldPreview}),'PAYMENT_PREVIEW_CHANGED');
  const ticketConflict=await paid(await makeBooking());
  await db.query('update flight_bookings set ticket_numbers=$2 where id=$1',[ticketConflict.booking.id,JSON.stringify(['1999999999999'])]);
  await expectUnchanged(()=>confirm(ticketConflict),'BOOKING_TICKET_CONFLICT');
  const proofSubject=await makeBooking();
  for(const proof of [
    {...proofSubject.proof,expectedPaymentEffect:'charge_wallet'},
    {...proofSubject.proof,expectedPaymentEffect:'charge_wallet',expectedPayableAmount:'50025'},
    {...proofSubject.proof,expectedPaymentEffect:'capture_hold',expectedPayableAmount:50025},
  ])await expectUnchanged(()=>confirm(proofSubject,{proof}),proof.expectedPayableAmount===50025?'PAYMENT_PREVIEW_CHANGED':'PAYMENT_PREVIEW_REQUIRED');

  // Return follows actual capture, not current booking status or a later price.
  for(const agency of [null,'ST-B2B000001'])for(const state of ['on-hold','pending','in-progress','confirmed','cancelled','unconfirmed','expired']) {
    const subject=state==='in-progress'?await reconcilingPaid(await makeBooking({agency})):
      await paid(await makeBooking({agency}),['unconfirmed','expired'].includes(state)?'on-hold':state,true);
    if(state==='unconfirmed')await db.query("update flight_bookings set airlines_pnr='[]'::jsonb where id=$1",[subject.booking.id]);
    if(state==='expired')await db.query("update flight_bookings set ticketing_deadline_at='2000-01-01T00:00:00Z' where id=$1",[subject.booking.id]);
    const localBefore=await one('select status,operation_kind,operation_reason,active_operation_id from flight_bookings where id=$1',[subject.booking.id]);
    const operationBefore=await one('select md5(coalesce(jsonb_agg(to_jsonb(o) order by id),\'[]\')::text) as hash from booking_operations o where booking_id=$1',[subject.booking.id]);
    const caseBefore=await one('select md5(coalesce(jsonb_agg(to_jsonb(c) order by id),\'[]\')::text) as hash from booking_reconciliation_cases c where subject_booking_id=$1',[subject.booking.id]);
    const before=await snapshot();const context=await returnPreview(subject);
    assert.equal(context.eligible,true,`${state}: ${JSON.stringify(context)}`);
    assert.equal(context.capturedAmount,50025);assert.equal(context.refundedAmount,0);assert.equal(context.refundableAmount,50025);
    assert.deepEqual(await snapshot(),before,'Payment Return preview cannot move money or alter state');
    const result=await paymentReturn(subject,context);assert.equal(result.ok,true,JSON.stringify(result));
    assert.equal(result.returnedAmount,50025);assert.equal(result.paymentState,'refunded');
    assert.equal(result.availableBalance,context.availableBalance+50025);assert.equal(result.holdBalance,context.holdBalance);
    assert.deepEqual(await one('select status,operation_kind,operation_reason,active_operation_id from flight_bookings where id=$1',[subject.booking.id]),localBefore);
    assert.deepEqual(await one('select md5(coalesce(jsonb_agg(to_jsonb(o) order by id),\'[]\')::text) as hash from booking_operations o where booking_id=$1',[subject.booking.id]),operationBefore);
    assert.deepEqual(await one('select md5(coalesce(jsonb_agg(to_jsonb(c) order by id),\'[]\')::text) as hash from booking_reconciliation_cases c where subject_booking_id=$1',[subject.booking.id]),caseBefore);
    const returned=await one('select captured_amount,refunded_amount,payment_state,payment_amount from flight_bookings where id=$1',[subject.booking.id]);
    assert.deepEqual(returned,{captured_amount:50025,refunded_amount:50025,payment_state:'refunded',payment_amount:50025});
    const ledger=await one('select * from wallet_ledger_entries where id=$1',[result.ledgerEntryId]);
    assert.equal(ledger.related_entry_id,subject.capture.id);assert.equal(ledger.transaction_type,'refund');
    assert.equal(ledger.amount,50025);assert.equal(ledger.hold_before,ledger.hold_after);
    const committed=await snapshot();assert.equal((await paymentReturn(subject,context)).replay,true);assert.deepEqual(await snapshot(),committed);
    await expectUnchanged(()=>paymentReturn(subject,context,{requestId:randomUUID()}),'ALREADY_REFUNDED');
    await expectUnchanged(()=>paymentReturn(subject,context,{reason:'Different refund reason'}),'PAYMENT_RETURN_REQUEST_CONFLICT');
  }
  // A genuine direct wallet debit may have no reservation. Reusing or
  // returning it must retain that fact instead of fabricating a protected hold.
  const directPaid=await makeBooking();
  const directBefore=await one('select available_balance,hold_balance from wallet_accounts where id=$1',[account.id]);
  await db.query('update wallet_accounts set available_balance=available_balance-50025 where id=$1',[account.id]);
  const directCapture=await one(`insert into wallet_ledger_entries(wallet_account_id,transaction_type,amount,currency,
    available_before,available_after,hold_before,hold_after,booking_id,booking_reference,idempotency_key,created_by_user_id,created_by_role)
    values($1,'booking_confirm',50025,'BDT',$2,$3,$4,$4,$5,$6,$7,$8,'admin') returning id`,[
    account.id,directBefore.available_balance,Number(directBefore.available_balance)-50025,directBefore.hold_balance,
    directPaid.booking.id,directPaid.booking.public_ref,`direct-original:${randomUUID()}`,admin]);
  const directPreview=await preview(directPaid);assert.equal(directPreview.paymentEffect,'already_paid');
  assert.equal((await confirm(directPaid,{preview:directPreview})).originalCaptureLedgerEntryId,directCapture.id);
  assert.equal((await one('select count(*)::int as n from wallet_reservations where booking_id=$1',[directPaid.booking.id])).n,0);
  const directReturnPreview=await returnPreview(directPaid);
  assert.equal((await paymentReturn(directPaid,directReturnPreview)).returnedAmount,50025);
  assert.equal((await one('select count(*)::int as n from wallet_reservations where booking_id=$1',[directPaid.booking.id])).n,0,
    'A return cannot fabricate a reservation for a legitimate capture-only history');
  const wrongPrice=await paid(await makeBooking());
  await db.query("update flight_bookings set pricing_snapshot=jsonb_set(pricing_snapshot,'{sellingPrice}','999.00') where id=$1",[wrongPrice.booking.id]);
  assert.equal((await preview(wrongPrice)).eligible,false,'A capture for the wrong payable cannot silently confirm');
  const actualContext=await returnPreview(wrongPrice);assert.equal(actualContext.refundableAmount,50025);
  assert.equal((await paymentReturn(wrongPrice,actualContext)).returnedAmount,50025,'Return uses the real original capture even after pricing changed');

  // Return is booking-owned accounting, including the existing Triplover flow.
  // It must not change that supplier's ticket/status/operation history or outbox.
  const triploverPaid=await paid(await makeBooking({supplier:'triplover'}),'confirmed');
  const triploverBefore=await one(`select status,supplier,supplier_account,booking_status,
    ticket_code_ref,ticket_numbers,issued_at,operation_kind,active_operation_id from flight_bookings where id=$1`,[triploverPaid.booking.id]);
  const triploverOperations=await one('select md5(coalesce(jsonb_agg(to_jsonb(o) order by id),\'[]\')::text) as hash from booking_operations o where booking_id=$1',[triploverPaid.booking.id]);
  const triploverEvents=await one('select md5(coalesce(jsonb_agg(to_jsonb(o) order by id),\'[]\')::text) as hash from booking_status_events o where booking_id=$1',[triploverPaid.booking.id]);
  const triploverOutbox=await one('select md5(coalesce(jsonb_agg(to_jsonb(o) order by id),\'[]\')::text) as hash from booking_notification_outbox o where booking_id=$1',[triploverPaid.booking.id]);
  const triploverReturn=await returnPreview(triploverPaid,'policy-superadmin','superadmin');
  assert.equal(triploverReturn.eligible,true,JSON.stringify(triploverReturn));
  assert.equal((await paymentReturn(triploverPaid,triploverReturn,{actor:'policy-superadmin',role:'superadmin'})).returnedAmount,50025);
  assert.deepEqual(await one(`select status,supplier,supplier_account,booking_status,
    ticket_code_ref,ticket_numbers,issued_at,operation_kind,active_operation_id from flight_bookings where id=$1`,[triploverPaid.booking.id]),triploverBefore);
  assert.deepEqual(await one('select md5(coalesce(jsonb_agg(to_jsonb(o) order by id),\'[]\')::text) as hash from booking_operations o where booking_id=$1',[triploverPaid.booking.id]),triploverOperations);
  assert.deepEqual(await one('select md5(coalesce(jsonb_agg(to_jsonb(o) order by id),\'[]\')::text) as hash from booking_status_events o where booking_id=$1',[triploverPaid.booking.id]),triploverEvents);
  assert.deepEqual(await one('select md5(coalesce(jsonb_agg(to_jsonb(o) order by id),\'[]\')::text) as hash from booking_notification_outbox o where booking_id=$1',[triploverPaid.booking.id]),triploverOutbox);

  const partial=await paid(await makeBooking(),'confirmed');
  const partialResult=await value('select wallet_refund_booking($1,$2,$3,$4,$5,$6) as result',[
    partial.booking.id,10000,admin,'admin',`previous-refund:${randomUUID()}`,'Synthetic previous partial refund']);
  assert.equal(partialResult.ok,true,JSON.stringify(partialResult));
  await db.query("update flight_bookings set status='on-hold',payment_state='unpaid',captured_amount=0,refunded_amount=0 where id=$1",[partial.booking.id]);
  const remaining=await returnPreview(partial);assert.equal(remaining.capturedAmount,50025);assert.equal(remaining.refundedAmount,10000);assert.equal(remaining.refundableAmount,40025);
  assert.equal((await paymentReturn(partial,remaining)).returnedAmount,40025,'Earlier real refunds reduce this return exactly');
  assert.equal((await returnPreview(partial)).eligible,false);

  const frozen=await paid(await makeBooking());
  await db.query("update wallets set status='frozen' where id=$1",[account.wallet_id]);
  const frozenContext=await returnPreview(frozen);assert.equal(frozenContext.eligible,true);
  assert.equal((await paymentReturn(frozen,frozenContext)).ok,true,'Frozen owner wallets may receive their own returned funds');
  await db.query("update wallets set status='active' where id=$1",[account.wallet_id]);

  const guarded=await paid(await makeBooking());const guardedContext=await returnPreview(guarded);
  for(const options of [
    {confirmation:false},{reason:''},{reason:'x'},{reason:'bad\nreason'},
    {actor:owner,role:'customer'},{actor:'policy-support',role:'staff_support'},
    {role:'superadmin'},{refundable:50026},{refunded:1},{available:guardedContext.availableBalance+1},
    {hold:guardedContext.holdBalance+1},{captureId:randomUUID()},
  ])await expectUnchanged(()=>paymentReturn(guarded,guardedContext,options));
  for(const role of ['customer','staff_support','staff_account']) {
    const actor=role==='customer'?owner:role==='staff_support'?'policy-support':'policy-account';
    assert.equal((await returnPreview(guarded,actor,role)).ok,false);
    assert.equal((await preview(guarded,actor,role)).ok,false);
  }
  const stale=await paid(await makeBooking());const stalePreview=await returnPreview(stale);
  await db.query('update wallet_accounts set available_balance=available_balance+1 where id=$1',[account.id]);
  await expectUnchanged(()=>paymentReturn(stale,stalePreview),'PAYMENT_RETURN_PREVIEW_CHANGED');

  // Ambiguous ledger history or owner links must remain review-only.
  for(const corrupt of ['duplicate-capture','wrong-owner','wrong-currency','bad-capture','bad-refund']) {
    const subject=await paid(await makeBooking());
    if(corrupt==='duplicate-capture')await db.query(`insert into wallet_ledger_entries(wallet_account_id,transaction_type,amount,currency,
      available_before,available_after,hold_before,hold_after,booking_id,reservation_id,idempotency_key,created_by_user_id,created_by_role)
      select wallet_account_id,transaction_type,amount,currency,available_before,available_after,hold_before,hold_after,booking_id,reservation_id,$2,$3,'admin'
      from wallet_ledger_entries where id=$1`,[subject.capture.id,`duplicate:${randomUUID()}`,admin]);
    if(corrupt==='wrong-owner')await db.query("update flight_bookings set user_id='different-owner',booking_owner_key='different-owner' where id=$1",[subject.booking.id]);
    if(corrupt==='wrong-currency')await db.query("update flight_bookings set currency='USD' where id=$1",[subject.booking.id]);
    if(corrupt==='bad-capture')await db.query('update wallet_reservations set amount=amount+1 where booking_id=$1',[subject.booking.id]);
    if(corrupt==='bad-refund')await db.query(`insert into wallet_ledger_entries(wallet_account_id,transaction_type,amount,currency,
      available_before,available_after,hold_before,hold_after,booking_id,reservation_id,related_entry_id,idempotency_key,created_by_user_id,created_by_role)
      values($1,'refund',1,'BDT',10,10,0,0,$2,$3,$4,$5,$6,'admin')`,[
      subject.capture.wallet_account_id,subject.booking.id,subject.capture.reservation_id,subject.capture.id,`bad-refund:${randomUUID()}`,admin]);
    const before=await snapshot();const context=await returnPreview(subject);assert.equal(context.eligible,false,`${corrupt}:${JSON.stringify(context)}`);
    assert.deepEqual(await snapshot(),before);
  }
  const concurrent=await paid(await makeBooking());const concurrentPreview=await returnPreview(concurrent);
  const competing=await Promise.all([paymentReturn(concurrent,concurrentPreview,{requestId:randomUUID()}),paymentReturn(concurrent,concurrentPreview,{requestId:randomUUID()})]);
  assert.equal(competing.filter(result=>result.ok).length,1);assert.equal(competing.filter(result=>result.code==='ALREADY_REFUNDED').length,1);
  const replayRace=await paid(await makeBooking());const replayPreview=await returnPreview(replayRace);
  const sameRequest=await Promise.all([paymentReturn(replayRace,replayPreview),paymentReturn(replayRace,replayPreview)]);
  assert.equal(sameRequest.filter(result=>result.ok).length,2);assert.equal(sameRequest.filter(result=>result.replay).length,1);

  for(const effect of ['charge_wallet','capture_hold','already_paid']) {
    const subject=effect==='charge_wallet'?await makeBooking():effect==='capture_hold'?await uncertain(await makeBooking()):await paid(await makeBooking());
    await db.exec(`create function reject_policy_confirmation_test() returns trigger language plpgsql as $$
      begin if new.supplier_operation='ExternalTicketConfirmation' then raise exception 'policy confirmation rollback'; end if;return new;end;$$;
      create trigger reject_policy_confirmation_test before insert on booking_status_events for each row execute function reject_policy_confirmation_test();`);
    const before=await snapshot();await assert.rejects(confirm(subject),/policy confirmation rollback/);
    assert.deepEqual(await snapshot(),before,'Every payment effect rolls back financial, status, operation, decision and outbox together');
    await db.exec('drop trigger reject_policy_confirmation_test on booking_status_events;drop function reject_policy_confirmation_test();');
    assert.equal((await confirm(subject)).ok,true);
  }
  const rollback=await reconcilingPaid(await makeBooking());const rollbackContext=await returnPreview(rollback);
  await db.exec(`create function reject_payment_return_test() returns trigger language plpgsql as $$
    begin raise exception 'payment return rollback';end;$$;
    create trigger reject_payment_return_test before insert on booking_payment_returns for each row execute function reject_payment_return_test();`);
  const beforeRollback=await snapshot();await assert.rejects(paymentReturn(rollback,rollbackContext),/payment return rollback/);
  assert.deepEqual(await snapshot(),beforeRollback,'A late immutable audit failure rolls back credit, refund ledger and payment fields');
  await db.exec('drop trigger reject_payment_return_test on booking_payment_returns;drop function reject_payment_return_test();');
  assert.equal((await paymentReturn(rollback,rollbackContext)).ok,true);
  await assert.rejects(db.query('update booking_payment_returns set reason=$2 where booking_id=$1',[rollback.booking.id,'tampered']),/immutable/);
  await assert.rejects(db.query('delete from booking_payment_returns where booking_id=$1',[rollback.booking.id]),/immutable/);
  const returnRpc='return_booking_payment_v1(uuid,text,text,uuid,uuid,bigint,bigint,bigint,bigint,boolean,text)';
  for(const role of ['anon','authenticated']) {
    assert.equal((await one('select has_table_privilege($1,\'booking_payment_returns\',\'SELECT\') as yes',[role])).yes,false);
    for(const signature of [returnRpc,'preview_booking_payment_return_v1(uuid,text,text)','preview_shapon_ticket_payment_v1(uuid,text,text)'])
      assert.equal((await one('select has_function_privilege($1,$2,\'EXECUTE\') as yes',[role,signature])).yes,false);
  }
  assert.equal((await one('select has_function_privilege(\'service_role\',$1,\'EXECUTE\') as yes',[returnRpc])).yes,true);
  assert.equal((await one('select has_function_privilege(\'service_role\',\'booking_payment_return_accounting_v1(uuid)\',\'EXECUTE\') as yes')).yes,false);
  await db.exec('set role service_role');
  await assert.rejects(db.query('insert into booking_payment_returns(booking_id) values($1)',[rollback.booking.id]),/permission denied/);
  await db.exec('reset role');
  console.log(`PASS full Shapon payment policy and booking Return DB (${catalog.tables} tables/${catalog.functions} functions): mandatory protected-hold capture, existing-paid reuse, normal charge, historical replay, exact previews, B2C/B2B refunds across statuses, wrong-size capture return, linked partial refunds, frozen credit, conflicts, races, immutable audit, roles/RLS and atomic rollback.`);
} finally {await db.close();}
