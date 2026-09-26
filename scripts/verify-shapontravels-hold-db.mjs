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
  assert.equal((await db.query('select booking_uses_saved_references(b) as allowed from flight_bookings b where id=$1', [booking.id])).rows[0].allowed, false,
    'the Triplover ticketing path cannot issue a Shapontravels hold');
  assert.equal((await db.query('select count(*)::int as n from flight_bookings where attempt_id=$1', [attemptId])).rows[0].n, 1);

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
