import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const db = new PGlite({ extensions: { pgcrypto } });
const digest = value => createHash('sha256').update(value).digest('hex');
try {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;`);
  const migrations = 'supabase/fresh-install/supabase/migrations';
  for (const file of fs.readdirSync(migrations).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(`${migrations}/${file}`, 'utf8'));
  }
  await db.exec("insert into app_users(clerk_id, role) values ('shapon-hold-owner','customer')");

  const attemptId = randomUUID();
  const requestKey = `operation:v1:${digest(attemptId)}`;
  const payloadHash = digest(`payload:${attemptId}`);
  const transaction = randomUUID();
  const item = randomUUID();
  const price = randomUUID();
  const offer = {
    currency: 'BDT',
    pricing: { audience: 'b2c', agencyCode: null, supplierTotalPrice: 5084.36,
      sellingPrice: 5084.36, grossPrice: 5349, serviceMarginAmount: 0 },
    passengerCounts: { ADT: 1 }, travelDate: '2030-01-01', directTicketing: false,
    itinerary: { carrierCode: 'BG' }, fares: [], passportRequired: false,
    repricedAt: '2026-09-27T00:00:00Z',
  };
  await db.query(`insert into booking_attempts(id,access_token_hash,user_id,audience,
      supplier,supplier_account,state,search_id,itinerary_id,unique_trans_id,
      item_code_ref,price_code_ref,offer_snapshot,passenger_snapshot,expires_at,
      submitted_at,operation_request_key,operation_request_payload_hash,
      supplier_call_started_at,supplier_response_received_at,supplier_operation)
    values ($1,$2,'shapon-hold-owner','b2c','shapontravels','shapontravels',
      'submitting',$3,'itn-0-0',$4,$5,$6,$7,$8,now()+interval '10 minutes',
      now(),$9,$10,now(),now(),'Book')`,
  [attemptId, digest(attemptId), randomUUID(), transaction, item, price,
    JSON.stringify(offer), JSON.stringify({ travellers: [{ passengerType: 'ADT' }] }),
    requestKey, payloadHash]);
  const supplierBookingUuid = randomUUID();
  const outcome = { status: 'held', pnr: 'ABC123', airlinesPnr: ['ABC123'],
    bookingRefNumber: supplierBookingUuid, supplierPublicRef: 'STRTESTHOLD',
    bookingStatus: 'Created',
    ticketingTimeLimit: '2030-01-01T12:00:00+06:00', bookingCodeRef: randomUUID(),
    supplierRefs: { uniqueTransId: transaction, itemCodeRef: item, priceCodeRef: price },
    ticketCodeRef: null, ticketNumbers: [], warnings: [] };
  const finalize = async () => (await db.query(
    'select (create_shapontravels_booking_from_attempt_v1($1,$2,$3,$4)).*',
    [attemptId, requestKey, payloadHash, JSON.stringify(outcome)]
  )).rows[0];
  const booking = await finalize();
  assert.equal(booking.supplier, 'shapontravels');
  assert.equal(booking.supplier_account, 'shapontravels');
  assert.equal(booking.booking_ref_number, supplierBookingUuid);
  assert.equal(booking.supplier_public_ref, 'STRTESTHOLD');
  assert.equal((await db.query('select supplier_reference from booking_dashboard_list_v where id=$1', [booking.id])).rows[0].supplier_reference, 'STRTESTHOLD');
  assert.equal(booking.status, 'on-hold');
  assert.equal((await db.query('select lifecycle_status from booking_lifecycle_v where id=$1', [booking.id])).rows[0].lifecycle_status, 'on-hold');
  assert.equal(booking.direct_ticketing, false);
  assert.equal(booking.ticketing_deadline_at.toISOString(), '2030-01-01T06:00:00.000Z');
  assert.equal(booking.supplier_refs.priceCodeRef, price);
  assert.equal((await finalize()).id, booking.id, 'finalizer replay does not create another booking');
  const savedReferencesAllowed = async () => (await db.query(
    'select booking_uses_saved_references(b) as allowed from flight_bookings b where id=$1',
    [booking.id]
  )).rows[0].allowed;
  assert.equal(await savedReferencesAllowed(), true,
    'Verified Shapontravels API holds can use saved references');
  await db.query('update flight_bookings set supplier_public_ref=null where id=$1', [booking.id]);
  assert.equal(await savedReferencesAllowed(), false, 'Missing verified STR cannot bypass a deadline');
  await db.query('update flight_bookings set supplier_public_ref=$2 where id=$1', [booking.id, 'STRTESTHOLD']);
  await db.query("update flight_bookings set supplier_refs=supplier_refs || '{\"itemCodeRef\":null}'::jsonb where id=$1", [booking.id]);
  assert.equal(await savedReferencesAllowed(), false, 'Incomplete Book references cannot bypass a deadline');
  await db.query('update flight_bookings set supplier_refs=$2 where id=$1',
    [booking.id, JSON.stringify(outcome.supplierRefs)]);
  assert.equal(await savedReferencesAllowed(), true);
  await db.query("update flight_bookings set supplier_ticketing_deadline_at=now()-interval '1 minute' where id=$1", [booking.id]);
  assert.equal((await db.query(
    "select wallet_begin_booking_issue($1,'shapon-hold-owner','customer','expired-claim') as result",
    [booking.id]
  )).rows[0].result.code, 'BOOKING_EXPIRED', 'A known expired deadline still blocks the wallet claim');
  await db.query('update flight_bookings set supplier_ticketing_deadline_at=null where id=$1', [booking.id]);
  assert.equal((await db.query('select ticketing_deadline_at from flight_bookings where id=$1',
    [booking.id])).rows[0].ticketing_deadline_at, null,
  'An unverified supplier deadline remains unknown');
  assert.equal((await db.query('select count(*)::int as n from flight_bookings where attempt_id=$1', [attemptId])).rows[0].n, 1);

  // Run the real wallet claim and finalizer against a synthetic supplier
  // receipt. No supplier Issue call or live wallet is involved.
  const wallet = (await db.query("select (wallet_ensure_account('user','shapon-hold-owner','BDT')).*" )).rows[0];
  await db.query('update wallet_accounts set available_balance=1000000 where id=$1', [wallet.id]);
  const issueKey = `operation:v1:${digest(`issue:${booking.id}`)}`;
  const issueHash = digest(`issue-payload:${booking.id}`);
  const claim = (await db.query('select wallet_begin_booking_issue_v2($1,$2,$3,$4,$5) as result',
    [booking.id, 'shapon-hold-owner', 'customer', issueKey, issueHash])).rows[0].result;
  assert.equal(claim.ok, true, `A verified hold with no deadline must reserve once: ${JSON.stringify(claim)}`);
  assert.equal((await db.query('select count(*)::int as n from wallet_reservations where booking_id=$1',
    [booking.id])).rows[0].n, 1);
  assert.equal((await db.query('select wallet_begin_booking_issue_v2($1,$2,$3,$4,$5) as result',
    [booking.id, 'shapon-hold-owner', 'customer', issueKey, issueHash])).rows[0].result.replay, true);
  assert.equal((await db.query('select mark_booking_operation_supplier_call_started($1,$2,$3) as result',
    [claim.operationId, issueKey, issueHash])).rows[0].result.started, true);
  assert.equal((await db.query('select mark_booking_operation_supplier_response_received($1,$2,$3,200) as result',
    [claim.operationId, issueKey, issueHash])).rows[0].result.ok, true);
  const ticket = { pnr: booking.pnr, bookingStatus: 'Confirmed',
    ticketCodeRef: randomUUID(), ticketNumbers: ['1234567890123'] };
  const capture = () => db.query('select wallet_capture_reservation_v2($1,$2,$3,$4,$5,$6,$7) as result',
    [booking.id, 'shapon-hold-owner', 'customer', issueKey, issueHash,
      claim.operationId, JSON.stringify(ticket)]);
  assert.equal((await capture()).rows[0].result.ok, true);
  assert.equal((await capture()).rows[0].result.replay, true);
  const issued = (await db.query(`select status,payment_state,supplier_public_ref,
      booking_ref_number,ticket_code_ref,ticket_numbers from flight_bookings where id=$1`,
    [booking.id])).rows[0];
  assert.equal(issued.status, 'confirmed');
  assert.equal(issued.payment_state, 'captured');
  assert.equal(issued.supplier_public_ref, 'STRTESTHOLD');
  assert.equal(issued.booking_ref_number, supplierBookingUuid);
  assert.equal(issued.ticket_code_ref, ticket.ticketCodeRef);
  assert.deepEqual(issued.ticket_numbers, ticket.ticketNumbers);
  assert.equal((await db.query("select count(*)::int as n from wallet_ledger_entries where booking_id=$1 and transaction_type='booking_confirm'", [booking.id])).rows[0].n, 1);

  await assert.rejects(db.query(`insert into booking_attempts(id,access_token_hash,audience,
      supplier,supplier_account,state,search_id,itinerary_id,unique_trans_id,
      item_code_ref,price_code_ref,offer_snapshot,expires_at)
    values ($1,$2,'b2c','shapontravels','triplover','draft',$3,'itn-0-1',
      $4,$5,$6,'{}',now()+interval '10 minutes')`,
  [randomUUID(), digest('wrong-binding'), randomUUID(), randomUUID(), randomUUID(), randomUUID()]),
  /booking_attempts_shapontravels_binding_check/);
  console.log('Shapontravels hold database verification passed');
} finally {
  await db.close();
}
