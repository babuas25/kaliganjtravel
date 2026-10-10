import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Complete forward migration chain, disposable PostgreSQL and synthetic funds.
// No environment files, hosted database, supplier requests or notifications.
const db = new PGlite({ extensions: { pgcrypto } });
const directory = 'supabase/fresh-install/supabase/migrations';
const digest = value => createHash('sha256').update(value).digest('hex');
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const value = async (sql, params = []) => (await one(sql, params)).result;
const now = () => new Date().toISOString();
const rpc = 'confirm_shapon_external_ticket_v1(uuid,text,text,uuid,boolean,jsonb,jsonb,timestamptz)';
const changedViews = ['booking_lifecycle_staff_v', 'booking_lifecycle_metrics_v'];
const owner = 'external-ticket-owner';
const admin = 'external-ticket-admin';
let ticketNumber = 1234567890120;

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

async function confirm(subject, { actor = admin, role = 'admin', charge = true,
  requestId = subject.requestId, identity = subject.identity, proof = subject.proof, checkedAt = now() } = {}) {
  return value('select confirm_shapon_external_ticket_v1($1,$2,$3,$4,$5,$6,$7,$8) as result',
    [subject.booking.id, actor, role, requestId, charge,
      identity === null ? null : JSON.stringify(identity), proof === null ? null : JSON.stringify(proof), checkedAt]);
}

async function snapshot() {
  const tables = ['flight_bookings', 'wallets', 'wallet_accounts', 'wallet_reservations',
    'wallet_ledger_entries', 'shapon_external_ticket_confirmations', 'booking_status_events',
    'booking_notification_outbox', 'booking_issued_sms_deliveries', 'booking_operations',
    'booking_reconciliation_cases'];
  const result = {};
  for (const table of tables) result[table] = (await one(`select md5(coalesce(jsonb_agg(to_jsonb(t)
    order by t::text),'[]'::jsonb)::text) as hash from ${table} t`)).hash;
  return result;
}

async function rejectUnchanged(subject, options, code) {
  const before = await snapshot();
  const result = await confirm(subject, options);
  assert.equal(result.code, code, JSON.stringify(result));
  assert.equal(result.ok, false);
  assert.deepEqual(await snapshot(), before, `${code} must leave all booking/financial/audit/outbox rows unchanged`);
}

async function columns(view) {
  return (await db.query(`select attname,atttypid::text as type from pg_attribute
    where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum`, [view])).rows;
}

async function assertConfirmation(subject, charge, accountId = null) {
  const row = await one(`select status,payment_state,charged_wallet_account_id,captured_amount,
    payment_amount,issued_by_user_id,issued_at,ticket_code_ref,ticket_numbers,airlines_pnr
    from flight_bookings where id=$1`, [subject.booking.id]);
  assert.equal(row.status, 'confirmed');
  assert.equal(row.payment_state, charge ? 'captured' : 'unpaid');
  assert.equal(row.charged_wallet_account_id, charge ? accountId : null);
  assert.equal(Number(row.captured_amount), charge ? 50025 : 0);
  assert.equal(row.payment_amount === null ? null : Number(row.payment_amount), charge ? 50025 : null);
  assert.equal(row.issued_by_user_id, admin);
  assert.equal(row.issued_at, null, 'Supplier issue time is never invented from Admin confirmation time');
  assert.equal(row.ticket_code_ref, subject.proof.ticketCodeRef);
  assert.deepEqual(row.ticket_numbers, subject.proof.ticketNumbers);
  assert.deepEqual(row.airlines_pnr, subject.proof.airlinesPnr);
  const decision = await one('select * from shapon_external_ticket_confirmations where booking_id=$1', [subject.booking.id]);
  assert.equal(decision.request_id, subject.requestId);
  assert.equal(decision.charge_wallet, charge);
  assert.equal(decision.settlement, charge ? 'owner_wallet' : 'external_supplier_paid_no_wallet_charge');
  assert.equal(decision.actor_user_id, admin);
  assert.deepEqual(decision.ticket_proof, subject.proof);
  assert.equal((await one(`select count(*)::int as n from booking_status_events
    where booking_id=$1 and supplier_operation='ExternalTicketConfirmation'
    and to_lifecycle_status='confirmed'`, [subject.booking.id])).n, 1);
  const outbox = await one(`select o.* from booking_notification_outbox o
    join booking_status_events e on e.id=o.lifecycle_event_id where e.booking_id=$1
    and e.supplier_operation='ExternalTicketConfirmation'`, [subject.booking.id]);
  assert.equal(outbox.lifecycle_status, 'confirmed');
  assert.equal(outbox.event_snapshot.settlement, decision.settlement);
  assert.equal(outbox.event_snapshot.paymentState, charge ? 'captured' : 'unpaid');
  assert.equal((await one(`select count(*)::int as n from booking_issued_sms_deliveries s
    join booking_status_events e on e.id=s.lifecycle_event_id where e.booking_id=$1
    and e.supplier_operation='ExternalTicketConfirmation'`, [subject.booking.id])).n, 1);
  assert.equal((await one("select lifecycle_status from booking_lifecycle_v where id=$1", [subject.booking.id])).lifecycle_status, 'confirmed');
  assert.equal((await one("select lifecycle_status from booking_dashboard_creator_v where id=$1", [subject.booking.id])).lifecycle_status, 'confirmed');
  const staff = await one('select lifecycle_status,payment_conflict_code,staff_attention_required from booking_lifecycle_staff_v where booking_id=$1', [subject.booking.id]);
  assert.equal(staff.lifecycle_status, 'confirmed');
  assert.equal(staff.payment_conflict_code, null, 'An audited paid no-charge settlement is not an unpaid financial conflict');
  assert.ok(staff.staff_attention_required === false || staff.staff_attention_required === null);
  const ledger = (await db.query("select * from wallet_ledger_entries where booking_id=$1 and transaction_type='booking_confirm'", [subject.booking.id])).rows;
  assert.equal(ledger.length, charge ? 1 : 0);
  if (charge) {
    assert.equal(ledger[0].wallet_account_id, accountId);
    assert.equal(ledger[0].created_by_user_id, admin);
    assert.equal(ledger[0].created_by_role, 'admin');
    assert.equal(Number(ledger[0].available_before) - Number(ledger[0].available_after), 50025);
    assert.equal(ledger[0].hold_before, ledger[0].hold_after);
    assert.equal(decision.ledger_entry_id, ledger[0].id);
    assert.equal((await one('select state from wallet_reservations where id=$1', [decision.reservation_id])).state, 'captured');
  } else {
    assert.equal(decision.wallet_account_id, null);
    assert.equal(decision.reservation_id, null);
    assert.equal(decision.ledger_entry_id, null);
    assert.equal((await one('select count(*)::int as n from wallet_reservations where booking_id=$1', [subject.booking.id])).n, 0);
  }
}

try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;`);
  const originalViewColumns = {};
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
    if (file === '20261010000000_shapon_external_ticket_confirmation.sql') {
      for (const view of changedViews) originalViewColumns[view] = await columns(view);
    }
    await db.exec(fs.readFileSync(`${directory}/${file}`, 'utf8'));
  }
  for (const view of changedViews) {
    assert.deepEqual(await columns(view), originalViewColumns[view], `${view} preserves every existing column type and ordinal`);
    assert.equal((await one('select has_table_privilege(\'service_role\',$1,\'SELECT\') as allowed', [view])).allowed, true);
    assert.equal((await one('select has_table_privilege(\'authenticated\',$1,\'SELECT\') as allowed', [view])).allowed, false);
  }
  await db.exec(`insert into app_users(clerk_id,role) values
    ('${owner}','customer'),('${admin}','admin'),('external-ticket-superadmin','superadmin'),
    ('external-ticket-support','staff_support'),('external-ticket-accounts','staff_account'),
    ('external-ticket-b2b','b2b');
    insert into agencies(agency_code,owner_user_id) values ('ST-B2B000001','external-ticket-b2b');
    update app_users set agency_code='ST-B2B000001' where clerk_id='external-ticket-b2b';`);
  const account = await one("select (wallet_ensure_account('user',$1,'BDT')).*", [owner]);
  const adminAccount = await one("select (wallet_ensure_account('user',$1,'BDT')).*", [admin]);
  await db.query('update wallet_accounts set available_balance=10000000 where id in ($1,$2)', [account.id, adminAccount.id]);
  const adminWalletBefore = await one('select * from wallet_accounts where id=$1', [adminAccount.id]);

  for (const role of ['anon', 'authenticated']) {
    assert.equal((await one('select has_function_privilege($1,$2,\'EXECUTE\') as allowed', [role, rpc])).allowed, false);
    assert.equal((await one('select has_table_privilege($1,\'shapon_external_ticket_confirmations\',\'SELECT\') as allowed', [role])).allowed, false);
  }
  assert.equal((await one('select has_function_privilege(\'service_role\',$1,\'EXECUTE\') as allowed', [rpc])).allowed, true);
  assert.equal((await one('select has_table_privilege(\'service_role\',\'shapon_external_ticket_confirmations\',\'SELECT\') as allowed')).allowed, true);
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    assert.equal((await one('select has_table_privilege(\'service_role\',\'shapon_external_ticket_confirmations\',$1) as allowed', [operation])).allowed, false);
  }

  const charged = await makeBooking();
  const beforeCharge = await one('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]);
  await db.exec('set role service_role');
  const chargeResult = await confirm(charged);
  assert.equal(chargeResult.ok, true, JSON.stringify(chargeResult));
  assert.equal(chargeResult.charged, true);
  await db.exec('reset role');
  await assertConfirmation(charged, true, account.id);
  const afterCharge = await one('select available_balance,hold_balance from wallet_accounts where id=$1', [account.id]);
  assert.equal(Number(beforeCharge.available_balance) - Number(afterCharge.available_balance), 50025);
  assert.equal(beforeCharge.hold_balance, afterCharge.hold_balance);
  assert.deepEqual(await one('select * from wallet_accounts where id=$1', [adminAccount.id]), adminWalletBefore,
    'Staff actor identity must never select the actor wallet as payment owner');

  const replaySnapshot = await snapshot();
  assert.equal((await confirm(charged)).replay, true);
  assert.equal((await confirm(charged, { identity: null, proof: null, checkedAt: null })).replay, true);
  assert.equal((await confirm(charged, { proof: { ...charged.proof, issuedAt: '2030-01-01T00:00:00Z' },
    checkedAt: '2000-01-01T00:00:00Z' })).replay, true, 'Observation times are excluded from committed command identity');
  assert.deepEqual(await snapshot(), replaySnapshot, 'All exact replays are read-only');
  await rejectUnchanged(charged, { charge: false }, 'CONFIRMATION_REQUEST_CONFLICT');
  await rejectUnchanged(charged, { actor: 'external-ticket-superadmin', role: 'superadmin' }, 'CONFIRMATION_REQUEST_CONFLICT');
  await rejectUnchanged(charged, { proof: { ...charged.proof, paid: false } }, 'CONFIRMATION_REQUEST_CONFLICT');
  await rejectUnchanged(charged, { identity: { ...charged.identity, pnr: 'OTHER1' } }, 'CONFIRMATION_REQUEST_CONFLICT');
  await rejectUnchanged(charged, { proof: 42 }, 'CONFIRMATION_REQUEST_CONFLICT');
  await rejectUnchanged(charged, { requestId: randomUUID() }, 'BOOKING_ALREADY_CONFIRMED');
  const reusedRequest = await makeBooking();
  await rejectUnchanged(reusedRequest, { requestId: charged.requestId }, 'CONFIRMATION_REQUEST_CONFLICT');

  const noCharge = await makeBooking();
  const metricsBeforeNoCharge = await one('select terminal_conflict_count,wallet_inconsistency_count from booking_lifecycle_metrics_v');
  const walletsBeforeNoCharge = await one('select md5(jsonb_agg(to_jsonb(w) order by id)::text) as hash from wallet_accounts w');
  assert.equal((await confirm(noCharge, { charge: false })).ok, true);
  await assertConfirmation(noCharge, false);
  assert.deepEqual(await one('select terminal_conflict_count,wallet_inconsistency_count from booking_lifecycle_metrics_v'), metricsBeforeNoCharge,
    'Audited external paid settlement cannot increase lifecycle financial conflict metrics');
  assert.deepEqual(await one('select md5(jsonb_agg(to_jsonb(w) order by id)::text) as hash from wallet_accounts w'), walletsBeforeNoCharge);
  await db.query('update flight_bookings set ticket_code_ref=$2 where id=$1', [noCharge.booking.id, randomUUID()]);
  assert.equal((await one('select payment_conflict_code from booking_lifecycle_staff_v where booking_id=$1', [noCharge.booking.id])).payment_conflict_code,
    'confirmed_unpaid', 'The settlement exception cannot hide subsequently mismatched ticket evidence');
  await db.query('update flight_bookings set ticket_code_ref=$2 where id=$1', [noCharge.booking.id, noCharge.proof.ticketCodeRef]);
  await rejectUnchanged(noCharge, { charge: true }, 'CONFIRMATION_REQUEST_CONFLICT');
  await rejectUnchanged(noCharge, { charge: true, requestId: randomUUID() }, 'BOOKING_ALREADY_CONFIRMED');

  const agencyAccount = await one("select (wallet_ensure_account('agency','ST-B2B000001','BDT')).*");
  await db.query('update wallet_accounts set available_balance=1000000 where id=$1', [agencyAccount.id]);
  const agencyBooking = await makeBooking({ agency: 'ST-B2B000001' });
  const beforeAgencyUser = await one('select available_balance from wallet_accounts where id=$1', [account.id]);
  const agencyResult = await confirm(agencyBooking);
  assert.equal(agencyResult.ok, true, JSON.stringify(agencyResult));
  await assertConfirmation(agencyBooking, true, agencyAccount.id);
  assert.equal(Number((await one('select available_balance from wallet_accounts where id=$1', [agencyAccount.id])).available_balance), 949975);
  assert.deepEqual(await one('select available_balance from wallet_accounts where id=$1', [account.id]), beforeAgencyUser);

  // PGlite serializes submitted transactions. Both intents execute the actual
  // advisory/booking locks; only the winning booking decision may debit.
  const contested = await makeBooking();
  const competing = await Promise.all([confirm(contested),
    confirm(contested, { charge: false, requestId: randomUUID() })]);
  assert.equal(competing.filter(result => result.ok).length, 1);
  assert.equal(competing.filter(result => result.code === 'BOOKING_ALREADY_CONFIRMED').length, 1);
  assert.equal((await one('select count(*)::int as n from shapon_external_ticket_confirmations where booking_id=$1', [contested.booking.id])).n, 1);
  assert.ok((await one("select count(*)::int as n from wallet_ledger_entries where booking_id=$1 and transaction_type='booking_confirm'", [contested.booking.id])).n <= 1);

  const insufficient = await makeBooking();
  await db.query('update wallet_accounts set available_balance=1 where id=$1', [account.id]);
  await rejectUnchanged(insufficient, {}, 'INSUFFICIENT_FUNDS');
  assert.equal((await confirm(insufficient, { charge: false })).ok, true,
    'A refused charge must not commit a decision or force a wallet charge on the no-charge retry');
  const frozen = await makeBooking();
  await db.query("update wallets set status='frozen' where id=$1", [account.wallet_id]);
  await rejectUnchanged(frozen, {}, 'WALLET_FROZEN');
  assert.equal((await confirm(frozen, { charge: false })).ok, true, 'External confirmation without debit works with a frozen owner wallet');
  await db.query("update wallets set status='active' where id=$1", [account.wallet_id]);
  await db.query('update wallet_accounts set available_balance=10000000 where id=$1', [account.id]);

  const malformed = await makeBooking({ count: 2 });
  for (const change of [
    { verified: false }, { issued: false }, { paid: false }, { paid: 'true' },
    { paymentStatus: 'Unpaid' }, { bookingStatus: 'Created' }, { source: 'public_receipt' },
    { pnr: 'OTHER1' }, { ticketCodeRef: 'not-a-uuid' }, { passengerCount: 1 },
    { passengerTickets: malformed.proof.passengerTickets.slice(0, 1) },
    { passengerTickets: [{ ticketNumbers: ['1234567890123'] }, { ticketNumbers: ['1234567890123'] }],
      ticketNumbers: ['1234567890123', '1234567890123'] },
    { passengerTickets: [{ ticketNumbers: ['ABC123'], ticketNumberSource: 'airline_pnr' }, malformed.proof.passengerTickets[1]],
      ticketNumbers: ['ABC123', ...malformed.proof.passengerTickets[1].ticketNumbers] },
    { ticketNumbers: ['1234567890000'] }, { airlinesPnr: ['ABC123', 'ABC123'] },
    { airlinesPnr: [] }, { issuedAt: '2026-02-30T00:00:00Z' }, { issuedAt: '2099-01-01T00:00:00Z' },
  ]) await rejectUnchanged(malformed, { proof: { ...malformed.proof, ...change } }, 'TICKET_EVIDENCE_UNVERIFIED');
  await rejectUnchanged(malformed, { checkedAt: '2000-01-01T00:00:00Z' }, 'TICKET_EVIDENCE_UNVERIFIED');
  await rejectUnchanged(malformed, { identity: null, proof: null, checkedAt: null }, 'SUPPLIER_IDENTITY_UNVERIFIED');
  for (const key of ['uniqueTransId', 'itemCodeRef', 'priceCodeRef', 'bookingCodeRef', 'bookingRefNumber', 'pnr', 'supplierPublicRef']) {
    await rejectUnchanged(malformed, { identity: { ...malformed.identity, [key]: 'different' } }, 'SUPPLIER_IDENTITY_UNVERIFIED');
  }
  for (const [actor, role] of [[owner, 'admin'], ['external-ticket-support', 'admin'],
    ['external-ticket-accounts', 'staff_account'], ['nonexistent-actor', 'superadmin']]) {
    await rejectUnchanged(malformed, { actor, role }, 'CONFIRMATION_FORBIDDEN');
  }
  await rejectUnchanged(malformed, { role: 'superadmin' }, 'ACTOR_ROLE_MISMATCH');

  const multiTicket = await makeBooking({ count: 2 });
  multiTicket.proof.passengerTickets[0].ticketNumbers.push(String(++ticketNumber));
  multiTicket.proof.ticketNumbers = multiTicket.proof.passengerTickets.flatMap(row => row.ticketNumbers);
  assert.equal((await confirm(multiTicket, { charge: false })).ok, true,
    'Complete multi-ticket passengers use passenger row counts, not flattened ticket count');
  const indigo = await makeBooking({ count: 2, carrier: '6E' });
  indigo.proof.passengerTickets = [{ ticketNumbers: ['ABC123'], ticketNumberSource: 'airline_pnr' },
    { ticketNumbers: ['ABC123'], ticketNumberSource: 'airline_pnr' }];
  indigo.proof.ticketNumbers = ['ABC123', 'ABC123'];
  assert.equal((await confirm(indigo, { charge: false })).ok, true,
    'Complete 6E passenger proof accepts a shared verified airline locator');
  const mixedIndigo = await makeBooking({ carrier: '6E' });
  await db.query("update flight_bookings set itinerary=jsonb_set(itinerary,'{legs,0,segments,0,airlineCode}','\"BG\"') where id=$1", [mixedIndigo.booking.id]);
  const locatorProof = { ...mixedIndigo.proof,
    passengerTickets: [{ ticketNumbers: ['ABC123'], ticketNumberSource: 'airline_pnr' }], ticketNumbers: ['ABC123'] };
  await rejectUnchanged(mixedIndigo, { proof: locatorProof }, 'TICKET_EVIDENCE_UNVERIFIED');
  const duplicateReceipt = await makeBooking();
  await rejectUnchanged(duplicateReceipt, { proof: { ...duplicateReceipt.proof,
    ticketCodeRef: charged.proof.ticketCodeRef } }, 'TICKET_ALREADY_ASSIGNED');
  await rejectUnchanged(duplicateReceipt, { proof: { ...duplicateReceipt.proof,
    passengerTickets: charged.proof.passengerTickets, ticketNumbers: charged.proof.ticketNumbers } }, 'TICKET_ALREADY_ASSIGNED');
  const competingTickets = await Promise.all([makeBooking(), makeBooking()]);
  competingTickets[1].proof.passengerTickets = competingTickets[0].proof.passengerTickets;
  competingTickets[1].proof.ticketNumbers = competingTickets[0].proof.ticketNumbers;
  const competingTicketResults = await Promise.all(competingTickets.map(subject => confirm(subject, { charge: false })));
  assert.equal(competingTicketResults.filter(result => result.ok).length, 1);
  assert.equal(competingTicketResults.filter(result => result.code === 'TICKET_ALREADY_ASSIGNED').length, 1,
    'Different ticketCodeRef values cannot assign the same numeric ticket twice');

  const knownIssueTime = await makeBooking();
  knownIssueTime.proof.issuedAt = now();
  assert.equal((await confirm(knownIssueTime, { charge: false, actor: 'external-ticket-superadmin', role: 'superadmin' })).ok, true);
  assert.equal((await one('select issued_at from flight_bookings where id=$1', [knownIssueTime.booking.id])).issued_at.toISOString(), knownIssueTime.proof.issuedAt);
  assert.equal((await one("select effective_at from booking_status_events where booking_id=$1 and supplier_operation='ExternalTicketConfirmation'", [knownIssueTime.booking.id])).effective_at.toISOString(), knownIssueTime.proof.issuedAt);

  const unsupported = await makeBooking({ supplier: 'triplover' });
  await rejectUnchanged(unsupported, {}, 'SUPPLIER_BOOKING_UNSUPPORTED');
  for (const change of [{ status: 'cancelled' }, { payment_state: 'reconciliation' },
    { ticket_code_ref: randomUUID() }, { ticket_numbers: ['1234567890123'] }, { captured_amount: 1 }]) {
    const subject = await makeBooking();
    await db.query(`update flight_bookings set ${Object.keys(change).map((key, index) => `${key}=$${index + 2}`).join(',')}
      where id=$1`, [subject.booking.id, ...Object.values(change).map(item => Array.isArray(item) ? JSON.stringify(item) : item)]);
    await rejectUnchanged(subject, {}, 'BOOKING_CONFIRMATION_CONFLICT');
  }
  const activeIssue = await makeBooking({ deadline: '2030-01-01T12:00:00+06:00' });
  const issueKey = `external-issue:${randomUUID()}`;
  const issueClaim = await value('select wallet_begin_booking_issue_v2($1,$2,$3,$4,$5) as result',
    [activeIssue.booking.id, owner, 'customer', issueKey, digest(issueKey)]);
  assert.equal(issueClaim.ok, true, JSON.stringify(issueClaim));
  await rejectUnchanged(activeIssue, { charge: false }, 'BOOKING_CONFIRMATION_CONFLICT');
  const reconciliation = await makeBooking();
  await db.query(`insert into booking_reconciliation_cases(subject_booking_id,case_type,
    reason_code,opened_source,opened_by_user_id,opened_by_role)
    values ($1,'legacy_review','external_review','staff',$2,'admin')`, [reconciliation.booking.id, admin]);
  await rejectUnchanged(reconciliation, { charge: false }, 'BOOKING_CONFIRMATION_CONFLICT');
  const expired = await makeBooking({ deadline: '2000-01-01T00:00:00+06:00' });
  assert.equal((await confirm(expired, { charge: false })).ok, true,
    'An elapsed local Issue cutoff cannot block already verified external issuance');
  const unaudited = await makeBooking();
  await db.query("update flight_bookings set status='confirmed' where id=$1", [unaudited.booking.id]);
  assert.equal((await one('select payment_conflict_code from booking_lifecycle_staff_v where booking_id=$1', [unaudited.booking.id])).payment_conflict_code,
    'confirmed_unpaid', 'Ordinary unaudited confirmed/unpaid bookings retain their existing conflict');

  // Force a late lifecycle insert failure after debit, ticket write and audit.
  // The RPC transaction must roll all three back, including the outbox.
  const atomic = await makeBooking();
  await db.exec(`create function reject_external_confirmation_test() returns trigger language plpgsql as $$
    begin if new.supplier_operation='ExternalTicketConfirmation' then raise exception 'test outbox failure'; end if; return new; end; $$;
    create trigger reject_external_confirmation_test before insert on booking_status_events
    for each row execute function reject_external_confirmation_test();`);
  const atomicBefore = await snapshot();
  await assert.rejects(confirm(atomic), /test outbox failure/);
  assert.deepEqual(await snapshot(), atomicBefore, 'Late event/outbox failure must rollback the full owner debit and confirmation');
  await db.exec('drop trigger reject_external_confirmation_test on booking_status_events; drop function reject_external_confirmation_test();');
  assert.equal((await confirm(atomic)).ok, true, 'Retry after transaction rollback may commit its original request once');
  await assert.rejects(db.query("update shapon_external_ticket_confirmations set charge_wallet=false where booking_id=$1", [atomic.booking.id]), /immutable/);
  await assert.rejects(db.query('delete from shapon_external_ticket_confirmations where booking_id=$1', [atomic.booking.id]), /immutable/);
  await db.exec('set role service_role');
  await assert.rejects(db.query('insert into shapon_external_ticket_confirmations(booking_id) values ($1)', [atomic.booking.id]), /permission denied/);
  await db.exec('reset role');
  console.log('Shapon external-confirmation DB passed: charge/no-charge owner settlement, B2C/B2B accounts, immutable exact replay, competing choices, frozen/insufficient guards, complete supplier identity/passenger/6E proof, lifecycle/outbox and atomic rollback.');
} finally {
  await db.close();
}
