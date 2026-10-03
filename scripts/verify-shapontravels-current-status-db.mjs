import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Entire fresh-install chain and synthetic records in memory only. No .env,
// hosted database, API credential, supplier request, email or wallet transport.
const db = new PGlite({ extensions: { pgcrypto } });
const directory = 'supabase/fresh-install/supabase/migrations';
const migration = '20261003000000_shapon_current_status_projection.sql';
const digest = value => createHash('sha256').update(value).digest('hex');
const views = ['booking_lifecycle_v', 'booking_dashboard_list_v',
  'booking_dashboard_list_ordered_v', 'booking_dashboard_creator_v'];
const instant = offset => new Date(Date.now() + offset).toISOString();
let failure = null;

async function columns(view) {
  return (await db.query(`select attname,atttypid::text as type from pg_attribute
    where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum`, [view])).rows;
}

async function businessSnapshot() {
  const result = {};
  for (const { tablename } of (await db.query(`select tablename from pg_tables
    where schemaname='public' and tablename<>'shapon_booking_current_status_observations'
    order by tablename`)).rows) {
    result[tablename] = (await db.query(`select md5(coalesce(jsonb_agg(to_jsonb(t)
      order by t::text),'[]')::text) as digest from public."${tablename}" t`)).rows[0].digest;
  }
  return result;
}

async function createHold(label) {
  const attemptId = randomUUID();
  const transaction = randomUUID();
  const item = randomUUID();
  const price = randomUUID();
  const key = `operation:v1:${digest(attemptId)}`;
  const hash = digest(`payload:${attemptId}`);
  const offer = { currency: 'BDT', pricing: { audience: 'b2c', agencyCode: null,
    supplierTotalPrice: 5084.36, sellingPrice: 5084.36, grossPrice: 5349,
    serviceMarginAmount: 0 }, passengerCounts: { ADT: 1 }, travelDate: '2030-01-01',
    directTicketing: false, itinerary: { carrierCode: 'BG' }, fares: [],
    passportRequired: false, repricedAt: '2026-09-27T00:00:00Z' };
  await db.query(`insert into booking_attempts(id,access_token_hash,user_id,audience,
    supplier,supplier_account,state,search_id,itinerary_id,unique_trans_id,item_code_ref,
    price_code_ref,offer_snapshot,passenger_snapshot,expires_at,submitted_at,
    operation_request_key,operation_request_payload_hash,supplier_call_started_at,
    supplier_response_received_at,supplier_operation)
    values ($1,$2,'shapon-current-owner','b2c','shapontravels','shapontravels','submitting',
      $3,$4,$5,$6,$7,$8,$9,now()+interval '10 minutes',now(),$10,$11,now(),now(),'Book')`,
  [attemptId, digest(attemptId), randomUUID(), `itn-${label}`, transaction, item, price,
    JSON.stringify(offer), JSON.stringify({ travellers: [{ passengerType: 'ADT' }] }), key, hash]);
  const outcome = { status: 'held', pnr: 'ABC123', airlinesPnr: ['ABC123'],
    bookingRefNumber: randomUUID(), supplierPublicRef: `STR${label.toUpperCase()}TEST123`,
    bookingStatus: 'Created', ticketingTimeLimit: '2030-01-01T12:00:00+06:00',
    bookingCodeRef: randomUUID(), supplierRefs: { uniqueTransId: transaction,
      itemCodeRef: item, priceCodeRef: price }, ticketCodeRef: null, ticketNumbers: [], warnings: [] };
  const booking = (await db.query('select (create_shapontravels_booking_from_attempt_v1($1,$2,$3,$4)).*',
    [attemptId, key, hash, JSON.stringify(outcome)])).rows[0];
  const identity = { ...outcome.supplierRefs, bookingCodeRef: outcome.bookingCodeRef,
    bookingRefNumber: outcome.bookingRefNumber, pnr: outcome.pnr,
    supplierPublicRef: outcome.supplierPublicRef, originalBookingStatus: 'Created' };
  return { booking, identity };
}

const holdMetadata = () => ({ status: 'on-hold', bookingState: 'held', supplierStatus: null,
  supplierCheckedAt: null, verified: false, source: 'saved_booking', checkedAt: null,
  reviewRequired: false, lastCheck: null });
const cancelledMetadata = () => ({ status: 'cancelled', bookingState: 'held',
  supplierStatus: 'Cancelled', supplierCheckedAt: instant(-60_000), verified: true,
  source: 'supplier_pnr', checkedAt: instant(-60_000), reviewRequired: true,
  lastCheck: { checkedAt: instant(-60_000), verified: true, reasonCode: null } });
async function record(subject, metadata, startedAt = instant(5_000), identity = subject.identity,
  reference = subject.identity.supplierPublicRef) {
  return (await db.query('select record_shapon_booking_current_status_v1($1,$2,$3,$4,$5) as result',
    [subject.booking.id, startedAt, reference, JSON.stringify(identity), JSON.stringify(metadata)])).rows[0].result;
}
async function detail(subject) {
  return (await db.query('select status,lifecycle_status,shapon_current_status from booking_lifecycle_v where id=$1',
    [subject.booking.id])).rows[0];
}
async function walletClaim(subject, key = `current-status:${randomUUID()}`) {
  return (await db.query("select wallet_begin_booking_issue($1,'shapon-current-owner','customer',$2) as result",
    [subject.booking.id, key])).rows[0].result;
}

try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;`);
  const oldColumns = {};
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.sql')).sort()) {
    if (file === migration) {
      for (const view of views) oldColumns[view] = await columns(view);
    }
    await db.exec(fs.readFileSync(`${directory}/${file}`, 'utf8'));
  }
  for (const view of views) {
    const current = await columns(view);
    assert.deepEqual(current.slice(0, -1), oldColumns[view], `${view} preserves all previous column types/order`);
    assert.equal(current.at(-1).attname, 'shapon_current_status');
    assert.equal((await db.query('select has_table_privilege($1,$2,\'SELECT\') as allowed',
      ['service_role', view])).rows[0].allowed, true);
  }
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_function_privilege($1,
      'record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb)','EXECUTE') as allowed`,
    [role])).rows[0].allowed, false);
    assert.equal((await db.query(`select has_table_privilege($1,
      'shapon_booking_current_status_observations','SELECT') as allowed`, [role])).rows[0].allowed, false);
  }
  assert.equal((await db.query(`select has_table_privilege('service_role',
    'shapon_booking_current_status_observations','INSERT,UPDATE,DELETE') as allowed`)).rows[0].allowed, false);
  await db.exec("insert into app_users(clerk_id,role) values ('shapon-current-owner','customer')");
  const cancelled = await createHold('cancelled');
  const uncertain = await createHold('uncertain');
  const confirmedRemote = await createHold('remoteissued');
  const issuable = await createHold('issuable');
  const localCancelled = await createHold('localcancelled');
  const remoteExpired = await createHold('expired');
  const remotePending = await createHold('pending');
  const unknownReview = await createHold('unknownreview');
  const localReconciliation = await createHold('localreconciliation');
  const snapshot = await businessSnapshot();
  const cancelledRead = await record(cancelled, cancelledMetadata());
  assert.equal(cancelledRead.recorded, true);
  assert.equal(cancelledRead.projectionUpdated, true);
  assert.equal(cancelledRead.effectiveStatus, 'cancelled');
  assert.equal(cancelledRead.currentStatus.originalBookingStatus, 'Created');
  assert.equal(cancelledRead.currentStatus.currentStatus.supplierStatus, 'Cancelled');
  assert.ok(Number.isFinite(Date.parse(cancelledRead.currentStatus.fetchedAt)));
  assert.equal((await detail(cancelled)).status, 'on-hold', 'Original row is not cancelled');
  assert.equal((await detail(cancelled)).lifecycle_status, 'cancelled');
  for (const view of views.slice(1)) {
    const row = (await db.query(`select lifecycle_status,shapon_current_status from ${view} where id=$1`,
      [cancelled.booking.id])).rows[0];
    assert.equal(row.lifecycle_status, 'cancelled');
    assert.deepEqual(row.shapon_current_status, cancelledRead.currentStatus);
  }
  assert.equal((await db.query("select count(*)::int as n from booking_dashboard_creator_v where lifecycle_status='cancelled'")).rows[0].n, 1);
  assert.equal((await db.query('select status_order from booking_dashboard_creator_v where id=$1',
    [cancelled.booking.id])).rows[0].status_order, 6);
  assert.equal((await db.query('select lifecycle_at from booking_dashboard_creator_v where id=$1',
    [cancelled.booking.id])).rows[0].lifecycle_at.toISOString(),
  new Date(cancelledRead.currentStatus.currentStatus.checkedAt).toISOString(),
  'Projected lifecycle date/sorting uses the saved supplier observation instant');
  assert.deepEqual(await businessSnapshot(), snapshot, 'Read observations cannot mutate any original business table/outbox');
  assert.equal((await walletClaim(cancelled)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  assert.deepEqual(await businessSnapshot(), snapshot, 'Atomic cancellation veto cannot reserve or mutate the original booking');

  for (const key of ['uniqueTransId','itemCodeRef','priceCodeRef','bookingCodeRef','bookingRefNumber','pnr','supplierPublicRef']) {
    assert.equal((await record(cancelled, holdMetadata(), instant(6_000),
      { ...cancelled.identity, [key]: 'different' })).recorded, false, `Exact ${key} identity is required`);
  }
  assert.equal((await record(cancelled, holdMetadata(), instant(6_000), cancelled.identity, 'STRDIFFERENT123')).recorded, false);
  for (const metadata of [null, { ...holdMetadata(), status: 'unknown' },
    { ...holdMetadata(), checkedAt: '2026-02-30T12:00:00Z' },
    { ...holdMetadata(), checkedAt: '2026-10-03T24:00:00Z' },
    { ...holdMetadata(), checkedAt: '2026-10-03T10:00:00' },
    { ...holdMetadata(), checkedAt: instant(600_000) },
    { ...holdMetadata(), supplierStatus: 'Cancelled' },
    { ...holdMetadata(), bookingState: ' ' },
    { ...holdMetadata(), supplierStatus: '\u0001' },
    { ...holdMetadata(), checkedAt: undefined }]) {
    assert.equal((await record(cancelled, metadata)).recorded, false, 'Invalid/legacy evidence cannot erase the valid projection');
  }
  assert.equal((await detail(cancelled)).lifecycle_status, 'cancelled');
  const newer = cancelledMetadata();
  newer.lastCheck = { checkedAt: instant(-1_000), verified: false, reasonCode: 'SUPPLIER_CUSTOM_FAILURE' };
  newer.supplierStatus = null; // Sparse verified PNR metadata remains usable.
  const fresh = await record(cancelled, newer, instant(20_000));
  assert.equal(fresh.recorded, true);
  const older = await record(cancelled, holdMetadata(), instant(10_000));
  assert.equal(older.recorded, true, 'Valid out-of-order responses retain immutable history');
  assert.equal(older.projectionUpdated, false, 'Older request starts cannot overwrite a newer projection');
  assert.equal(older.effectiveStatus, 'cancelled');
  assert.equal(older.currentStatus.currentStatus.lastCheck.verified, false);
  assert.equal(older.currentStatus.currentStatus.checkedAt, newer.checkedAt);
  assert.equal(older.currentStatus.currentStatus.supplierStatus, null);
  const tiedStart = instant(22_000);
  await record(cancelled, holdMetadata(), tiedStart);
  const tiedLatest = await record(cancelled, cancelledMetadata(), tiedStart);
  const tieWinner = (await db.query(`select current_status from shapon_booking_current_status_observations
    where booking_id=$1 and request_started_at=$2 order by received_at desc,id desc limit 1`,
  [cancelled.booking.id, tiedStart])).rows[0].current_status;
  assert.equal(tiedLatest.effectiveStatus, tieWinner.status,
    'Equal request starts use received_at and, when its clock resolution ties, id deterministically');
  assert.equal(tiedLatest.projectionUpdated, tieWinner.status === 'cancelled');

  await record(uncertain, { ...holdMetadata(), status: 'unconfirmed', reviewRequired: true });
  assert.equal((await detail(uncertain)).lifecycle_status, 'unconfirmed');
  assert.equal((await walletClaim(uncertain)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  await record(confirmedRemote, { ...holdMetadata(), status: 'confirmed', bookingState: 'issued',
    source: 'ticket_operation', verified: true, checkedAt: instant(-1_000) });
  assert.equal((await detail(confirmedRemote)).lifecycle_status, 'on-hold', 'Remote confirmed does not manufacture local tickets');
  assert.equal((await detail(confirmedRemote)).shapon_current_status.reviewRequired, true);
  assert.equal((await walletClaim(confirmedRemote)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  await record(remoteExpired, { ...holdMetadata(), status: 'expired', source: 'staff_manual', checkedAt: instant(-2_000) });
  assert.equal((await detail(remoteExpired)).lifecycle_status, 'expired');
  assert.equal((await walletClaim(remoteExpired)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  await record(remotePending, { ...holdMetadata(), status: 'pending' });
  assert.equal((await detail(remotePending)).lifecycle_status, 'pending');
  assert.equal((await db.query('select lifecycle_at from booking_dashboard_creator_v where id=$1',
    [remotePending.booking.id])).rows[0].lifecycle_at, null,
  'Unknown source-check/effective time stays NULL despite a known fetchedAt read time');
  assert.ok((await detail(remotePending)).shapon_current_status.fetchedAt);
  await record(unknownReview, { ...holdMetadata(), reviewRequired: null });
  assert.equal((await detail(unknownReview)).shapon_current_status.reviewRequired, true);
  assert.equal((await walletClaim(unknownReview)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  await db.query("update flight_bookings set payment_state='reconciliation' where id=$1", [localReconciliation.booking.id]);
  const reconciliationSnapshot = await businessSnapshot();
  await record(localReconciliation, cancelledMetadata());
  assert.equal((await detail(localReconciliation)).lifecycle_status, 'in-progress', 'Unsettled local payment stays in reconciliation');
  assert.deepEqual(await businessSnapshot(), reconciliationSnapshot);
  assert.equal((await record(issuable, holdMetadata())).effectiveStatus, 'on-hold');
  assert.equal((await detail(issuable)).shapon_current_status.reviewRequired, false);
  const wallet = (await db.query("select (wallet_ensure_account('user','shapon-current-owner','BDT')).*")).rows[0];
  await db.query('update wallet_accounts set available_balance=1000000 where id=$1', [wallet.id]);
  const issueKey = `operation:v1:${digest(issuable.booking.id)}`;
  const issueHash = digest(`ticket:${issuable.booking.id}`);
  const claim = (await db.query("select wallet_begin_booking_issue_v2($1,'shapon-current-owner','customer',$2,$3) as result",
    [issuable.booking.id, issueKey, issueHash])).rows[0].result;
  assert.equal(claim.ok, true, 'A valid no-review saved hold still permits the real synthetic atomic claim');
  const duringIssue = await businessSnapshot();
  await record(issuable, cancelledMetadata(), instant(25_000));
  assert.equal((await detail(issuable)).lifecycle_status, 'in-progress', 'Active local Issue outranks remote cancellation');
  assert.deepEqual(await businessSnapshot(), duringIssue, 'Evidence cannot release an active wallet reservation');
  await db.query('select mark_booking_operation_supplier_call_started($1,$2,$3)', [claim.operationId, issueKey, issueHash]);
  await db.query('select mark_booking_operation_supplier_response_received($1,$2,$3,200)', [claim.operationId, issueKey, issueHash]);
  const ticket = { pnr: 'ABC123', bookingStatus: 'Confirmed', ticketCodeRef: randomUUID(), ticketNumbers: ['1234567890123'] };
  assert.equal((await db.query("select wallet_capture_reservation_v2($1,'shapon-current-owner','customer',$2,$3,$4,$5) as result",
    [issuable.booking.id, issueKey, issueHash, claim.operationId, JSON.stringify(ticket)])).rows[0].result.ok, true);
  const afterIssue = await businessSnapshot();
  await record(issuable, cancelledMetadata(), instant(30_000));
  assert.equal((await detail(issuable)).lifecycle_status, 'confirmed', 'Verified local tickets/capture retain precedence');
  assert.equal((await detail(issuable)).shapon_current_status.reviewRequired, true);
  assert.equal((await walletClaim(issuable)).code, 'ALREADY_CAPTURED', 'Original terminal claim error/replay precedence is retained');
  const localIssuedTime = (await db.query('select issued_at from flight_bookings where id=$1', [issuable.booking.id])).rows[0].issued_at;
  assert.equal((await db.query('select lifecycle_at from booking_dashboard_creator_v where id=$1',
    [issuable.booking.id])).rows[0].lifecycle_at.toISOString(), localIssuedTime.toISOString(),
  'Local issue timestamp retains precedence over conflicting remote evidence');
  assert.deepEqual(await businessSnapshot(), afterIssue, 'A remote conflict cannot refund captured money or change local tickets');
  await db.query("update flight_bookings set status='cancelled',cancelled_at=now() where id=$1", [localCancelled.booking.id]);
  await record(localCancelled, holdMetadata());
  assert.equal((await detail(localCancelled)).lifecycle_status, 'cancelled', 'Local terminal Admin cancellation remains authoritative');
  assert.equal((await detail(localCancelled)).shapon_current_status.reviewRequired, true);
  for (const change of [{ supplier: 'triplover', supplier_account: 'triplover' },
    { import_source: 'MANUAL' }, { legacy_operational: true }, { pnr: 'DIFFERENT' }]) {
    assert.equal((await db.query(`select shapon_booking_status_identity_matches_v1(
      jsonb_populate_record(b,$2::jsonb),$3::jsonb) as matches from flight_bookings b where id=$1`,
    [cancelled.booking.id, JSON.stringify(change), JSON.stringify(cancelled.identity)])).rows[0].matches, false,
    'Non-native/changed identities are excluded even from saved projections');
  }
  const finalSnapshot = await businessSnapshot();
  await db.exec('set role service_role');
  await assert.rejects(db.query('insert into shapon_booking_current_status_observations(booking_id,request_started_at,receipt_identity,original_booking_status,current_status) values ($1,now(),\'{}\',\'Created\',\'{}\')',
    [cancelled.booking.id]), /permission denied/);
  assert.equal((await record(cancelled, cancelledMetadata(), instant(40_000))).recorded, true,
    'The granted service-role RPC works without direct INSERT privileges');
  await db.exec('reset role');
  assert.deepEqual(await businessSnapshot(), finalSnapshot);
  const plan = (await db.query(`explain (format json) select lifecycle_status,shapon_current_status
    from booking_dashboard_creator_v order by status_order limit 25`)).rows[0]['QUERY PLAN'][0].Plan;
  assert.ok(Number.isFinite(plan['Total Cost']) && plan['Total Cost'] < 100000,
    'The bounded shared projection must not create a JIT-scale plan');
  console.log(`Shapon current-status DB projection passed: identity/order, list/detail/filter/sort, local ticket/Admin precedence, atomic issue veto and unchanged business/wallet/outbox; plan cost ${plan['Total Cost']}.`);
} catch (error) {
  console.error(error.message);
  if (error.detail) console.error(error.detail);
  if (!error.code) console.error(error.stack);
  failure = error;
} finally {
  await db.close();
}
if (failure) throw new Error(`Shapon current-status DB regression failed: ${failure.message}`);
