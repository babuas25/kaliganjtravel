import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { artifactPath, forwardMigrationNames } from './helpers/shapon-recovery-database.mjs';

// Entire fresh-install chain and synthetic records in memory only. No .env,
// hosted database, API credential, supplier request, email or wallet transport.
let db = new PGlite({ extensions: { pgcrypto } });
const directory = 'supabase/fresh-install/supabase/migrations';
const migration = '20261003000000_shapon_current_status_projection.sql';
const airlineRefreshMigration = '20261103000000_shapon_public_current_status.sql';
const savedSyncMigration = '20261103000003_shapon_saved_supplier_sync_current_status.sql';
const digest = value => createHash('sha256').update(value).digest('hex');
const views = ['booking_lifecycle_v', 'booking_dashboard_list_v',
  'booking_dashboard_list_ordered_v', 'booking_dashboard_creator_v'];
const instant = offset => new Date(Date.now() + offset).toISOString();
let failure = null;
const plain = value => JSON.parse(JSON.stringify(value));
function compile(file, imports = {}, globals = {}) {
  const module = { exports: {} };
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true,
  });
  assert.equal(output.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length ?? 0, 0);
  new vm.Script(output.outputText, { filename: file }).runInNewContext({
    module, exports: module.exports,
    require(name) {
      if (name === 'server-only') return {};
      assert.ok(Object.hasOwn(imports, name), `Unexpected current-status test import ${name}`);
      return imports[name];
    }, ...globals,
  });
  return module.exports;
}
const statusModule = compile('lib/shapontravels/booking-status.ts');
const publicStatus = compile('lib/flights/booking-status.ts');
const projectionModule = compile('lib/shapontravels/current-status-projection.ts', {
  './booking-status': statusModule, '@/lib/flights/booking-status': publicStatus,
});
let lastRpcResponse = null;
let rpcCalls = 0;
const statusStore = compile('lib/shapontravels/current-status-store.ts', {
  '@/lib/supabase/server': { supabaseAdmin: () => ({
    async rpc(name, parameters) {
      rpcCalls++;
      assert.equal(name, 'record_shapon_booking_current_status_v1');
      lastRpcResponse = (await db.query('select record_shapon_booking_current_status_v1($1,$2,$3,$4,$5) as result',
        [parameters.p_booking_id, parameters.p_request_started_at, parameters.p_supplier_public_ref,
          JSON.stringify(parameters.p_receipt_identity), JSON.stringify(parameters.p_current_status)])).rows[0].result;
      return { data: lastRpcResponse, error: null };
    },
  }) },
  './current-status-projection': projectionModule,
}, { console: { error: () => assert.fail('The real local status RPC must stay available') } });

function airlineApiRead(subject, status = 'cancelled', supplierStatus = status) {
  const observedAt = new Date(Date.now() - 60_000 + 6 * 60 * 60 * 1000).toISOString().replace('Z', '+06:00');
  return { httpStatus: 200, supplierPublicRef: subject.identity.supplierPublicRef, body: {
    item1: { uniqueTransID: subject.identity.uniqueTransId, itemCodeRef: subject.identity.itemCodeRef,
      priceCodeRef: subject.identity.priceCodeRef, bookingCodeRef: subject.identity.bookingCodeRef,
      bookingRefNumber: subject.identity.bookingRefNumber, pnr: subject.identity.pnr,
      bookingStatus: status === 'cancelled' ? 'Cancelled' : 'Created' },
    item2: { isSuccess: true },
    // Actual saved-v1 currentStatus omits private bookingState/checkedAt/lastCheck.
    currentStatus: { status, reviewRequired: false, supplierStatus, supplierCheckedAt: observedAt,
      source: 'airline_refresh', verified: true },
    publicReceipt: { status, pendingReview: false, actions: { canIssue: status === 'on-hold' } },
  } };
}
async function recordApi(subject, read, requestStartedAt = instant(5_000)) {
  const checked = statusModule.verifyShapontravelsBookingStatus(read, subject.identity);
  const storage = await statusStore.recordShapontravelsCurrentStatus({ bookingId: subject.booking.id,
    requestStartedAt, expected: subject.identity, status: checked });
  return { checked: plain(checked), storage: plain(storage), response: lastRpcResponse };
}
async function observationSnapshot() {
  return (await db.query(`select md5(coalesce(jsonb_agg(to_jsonb(t) order by t::text),'[]')::text) as digest
    from shapon_booking_current_status_observations t`)).rows[0].digest;
}

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
  const offer = { currency: 'BDT', pricing: { audience: 'agency', agencyCode: 'ST-B2B100001',
    supplierTotalPrice: 5084.36, sellingPrice: 5084.36, grossPrice: 5349,
    serviceMarginAmount: 0 }, passengerCounts: { ADT: 1 }, travelDate: '2030-01-01',
    directTicketing: false, itinerary: { carrierCode: 'BG' }, fares: [],
    passportRequired: false, repricedAt: '2026-09-27T00:00:00Z' };
  await db.query(`insert into booking_attempts(id,access_token_hash,user_id,audience,agency_code,
    supplier,supplier_account,state,search_id,itinerary_id,unique_trans_id,item_code_ref,
    price_code_ref,offer_snapshot,passenger_snapshot,expires_at,submitted_at,
    operation_request_key,operation_request_payload_hash,supplier_call_started_at,
    supplier_response_received_at,supplier_operation)
    values ($1,$2,'shapon-current-owner','agency','ST-B2B100001','shapontravels','shapontravels','submitting',
      $3,$4,$5,$6,$7,$8,$9,now()+interval '10 minutes',now(),$10,$11,now(),now(),'Book')`,
  [attemptId, digest(attemptId), randomUUID(), `itn-${label}`, transaction, item, price,
    JSON.stringify(offer), JSON.stringify({ travellers: [{ passengerType: 'ADT' }] }), key, hash]);
  const outcome = { status: 'held', pnr: 'ABC123', airlinesPnr: ['ABC123'],
    bookingRefNumber: 'ABC123', supplierPublicRef: `STR${label.toUpperCase()}TEST123`,
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
const compactMetadata = (status = 'on-hold', reviewRequired = false) => ({
  status, reviewRequired, source: 'public_receipt', verified: false, bookingState: null,
  supplierStatus: null, checkedAt: null, supplierCheckedAt: null, lastCheck: null });
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
  return (await db.query("select wallet_begin_booking_issue($1,'shapon-current-owner','b2b_sub',$2) as result",
    [subject.booking.id, key])).rows[0].result;
}

async function verifySavedSupplierSync() {
  // Keep the historical projection rehearsal above intact, then verify the
  // current installed company chain and its new forward compatibility patch.
  await db.close();
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;`);
  const files = [path.basename(artifactPath), ...forwardMigrationNames];
  const index = files.indexOf(savedSyncMigration);
  assert.ok(index > 0, 'Register the saved-status compatibility migration in the active chain');
  for (const file of files.slice(0, index)) {
    await db.exec(fs.readFileSync(path.join(path.dirname(artifactPath), file), 'utf8'));
  }
  await db.exec(`insert into app_users(clerk_id,role) values
    ('shapon-current-partner','b2b'),('shapon-current-owner','b2b_sub');
    insert into agencies(agency_code,owner_user_id) values('ST-B2B100001','shapon-current-partner');
    update app_users set agency_code='ST-B2B100001'
      where clerk_id in ('shapon-current-partner','shapon-current-owner');`);
  const savedCancelled = await createHold('savedcancelled');
  const savedHold = await createHold('savedhold');
  const savedUnverified = await createHold('savedunverified');
  const savedUnverifiedDated = await createHold('savedunverifieddated');
  const savedUndatedCancelled = await createHold('savedundatedcancelled');
  const savedReview = await createHold('savedreview');
  const savedActive = await createHold('savedactive');
  const observedAt = new Date(Date.now() - 2 * 86400_000).toISOString().replace('Z', '635+00:00');
  const metadata = {
    status: 'cancelled', source: 'supplier_sync', verified: true, reviewRequired: false,
    supplierStatus: 'Cancelled', supplierCheckedAt: observedAt,
    bookingState: null, checkedAt: null, lastCheck: null,
  };
  const old = await record(savedCancelled, compactMetadata(), instant(1_000));
  assert.equal(old.recorded, true);
  const observationBefore = await observationSnapshot();
  const businessBefore = await businessSnapshot();
  const rejectedBefore = await record(savedCancelled, metadata);
  assert.equal(rejectedBefore.code, 'INVALID_CURRENT_STATUS',
    'The installed prior recorder reproduces rejection of the valid saved supplier_sync source');
  assert.equal(await observationSnapshot(), observationBefore);
  assert.deepEqual(await businessSnapshot(), businessBefore);
  const functions = async () => (await db.query(`select p.oid::regprocedure::text as signature,
    p.proowner::text,p.proacl::text,p.prosecdef,p.provolatile,p.proconfig
    from pg_proc p where p.oid in (
      'record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb)'::regprocedure,
      'project_shapon_booking_current_status_v1(flight_bookings,jsonb,text,timestamptz)'::regprocedure)
    order by 1`)).rows;
  const viewMetadata = async () => (await db.query(`select c.relname,c.relowner::text,
    c.relacl::text,c.reloptions, array_agg(a.attnum::text||':'||a.attname||':'||a.atttypid::text||':'||a.atttypmod::text
      order by a.attnum) as columns from pg_class c join pg_attribute a on a.attrelid=c.oid
    where c.oid=any($1::regclass[]) and a.attnum>0 and not a.attisdropped
    group by c.oid order by c.relname`, [views])).rows;
  const catalog = async () => (await db.query(`select
    (select count(*)::int from pg_tables where schemaname='public') as tables,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f') as functions`)).rows[0];
  const functionsBefore = await functions();
  const viewsBefore = await viewMetadata();
  const catalogBefore = await catalog();
  const forward = fs.readFileSync(path.join(path.dirname(artifactPath), savedSyncMigration), 'utf8');
  await db.exec(forward);
  await db.exec(forward);
  assert.deepEqual(await functions(), functionsBefore, 'Function ownership, ACLs and security/stability settings remain unchanged');
  assert.deepEqual(await viewMetadata(), viewsBefore, 'All shared view columns, options, owners and grants remain unchanged');
  assert.deepEqual(await catalog(), catalogBefore, 'Saved-source compatibility creates no new table or function');
  assert.deepEqual(await businessSnapshot(), businessBefore, 'Migration and replay change no original booking/payment/audit/outbox row');
  assert.equal(await observationSnapshot(), observationBefore, 'Existing observations are never rewritten');
  for (const file of files.slice(index + 1)) {
    await db.exec(fs.readFileSync(path.join(path.dirname(artifactPath), file), 'utf8'));
  }

  const businessAfterMigrations = await businessSnapshot();
  const recorded = await record(savedCancelled, metadata, instant(5_000),
    { ...savedCancelled.identity, originalBookingStatus: null });
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.projectionUpdated, true);
  assert.equal(recorded.currentStatus.originalBookingStatus, null,
    'Saved-v1 nullable historical status stays null under the previously installed guard');
  assert.deepEqual(recorded.currentStatus.currentStatus, metadata,
    'The original saved source, false/true flags, offset/fractional timestamp and absent private evidence are retained exactly');
  assert.notEqual(recorded.currentStatus.fetchedAt, observedAt);
  const row = await detail(savedCancelled);
  assert.equal(row.status, 'on-hold');
  assert.equal(row.lifecycle_status, 'cancelled');
  const ordered = (await db.query('select lifecycle_at from booking_dashboard_creator_v where id=$1',
    [savedCancelled.booking.id])).rows[0];
  assert.equal(ordered.lifecycle_at.toISOString(), new Date(observedAt).toISOString(),
    'Dashboard lifecycle date uses the original saved supplier instant, not a fresh GET time');
  assert.equal((await walletClaim(savedCancelled)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');

  const savedApiRead = airlineApiRead(savedCancelled);
  savedApiRead.body.currentStatus = {
    status: 'cancelled', source: 'supplier_sync', verified: true, reviewRequired: false,
    supplierStatus: 'Cancelled', supplierCheckedAt: observedAt,
  };
  const savedThroughApp = await recordApi(savedCancelled, savedApiRead, instant(7_000));
  assert.equal(savedThroughApp.checked.currentStatusState, 'available');
  assert.equal(savedThroughApp.storage.currentStatusStorage, 'saved',
    'The actual parser/store and real SQL recorder accept the saved six-field source together');
  assert.deepEqual(savedThroughApp.response.currentStatus.currentStatus, { ...metadata, canIssue: false });

  const hold = await record(savedHold, { ...metadata, status: 'on-hold', supplierStatus: 'Created' });
  assert.equal(hold.recorded, true);
  assert.equal(hold.currentStatus.reviewRequired, false,
    'A saved verified no-review hold does not require fabricated private held state');
  const unverified = { ...metadata, status: 'on-hold', verified: false,
    supplierStatus: null, supplierCheckedAt: null };
  const unverifiedRead = await record(savedUnverified, unverified);
  assert.equal(unverifiedRead.recorded, true);
  assert.equal(unverifiedRead.currentStatus.reviewRequired, false);
  assert.deepEqual(unverifiedRead.currentStatus.currentStatus, unverified,
    'An explicit unverified saved summary remains unverified with no invented observation instant');
  const unverifiedApi = airlineApiRead(savedUnverified, 'on-hold', null);
  unverifiedApi.body.currentStatus = {
    status: 'on-hold', source: 'supplier_sync', verified: false, reviewRequired: false,
    supplierStatus: null, supplierCheckedAt: null,
  };
  const unverifiedThroughApp = await recordApi(savedUnverified, unverifiedApi, instant(7_000));
  assert.equal(unverifiedThroughApp.storage.currentStatusStorage, 'saved');
  assert.deepEqual(unverifiedThroughApp.response.currentStatus.currentStatus, { ...unverified, canIssue: true },
    'Actual parser/store preserves unverified saved provenance and null timestamps at the RPC boundary');
  const unverifiedDated = await record(savedUnverifiedDated, { ...metadata, verified: false });
  assert.equal(unverifiedDated.recorded, true);
  assert.equal(unverifiedDated.currentStatus.currentStatus.supplierCheckedAt, observedAt);
  assert.equal((await db.query('select lifecycle_at from booking_dashboard_creator_v where id=$1',
    [savedUnverifiedDated.booking.id])).rows[0].lifecycle_at, null,
  'Unverified saved timestamp is not promoted to the verified supplier date fallback');
  const undatedCancelled = await record(savedUndatedCancelled,
    { ...unverified, status: 'cancelled' });
  assert.equal(undatedCancelled.recorded, true);
  assert.equal(undatedCancelled.currentStatus.currentStatus.verified, false);
  assert.equal((await db.query('select lifecycle_at from booking_dashboard_creator_v where id=$1',
    [savedUndatedCancelled.booking.id])).rows[0].lifecycle_at, null,
  'The GET time is not substituted for missing saved supplier time');
  const review = await record(savedReview, { ...metadata, status: 'on-hold', reviewRequired: true });
  assert.equal(review.recorded, true);
  assert.equal(review.currentStatus.reviewRequired, true);
  assert.equal((await walletClaim(savedReview)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  assert.deepEqual(await businessSnapshot(), businessAfterMigrations,
    'Saved status reads do not settle money, close operations, change raw booking status or create notifications');

  const validObservations = await observationSnapshot();
  const invalid = [
    { verified: 'true' }, { verified: null }, { verified: false, supplierCheckedAt: null },
    { supplierCheckedAt: null }, { supplierCheckedAt: '2026-02-30T10:00:00+06:00' },
    { supplierCheckedAt: '2026-10-14T10:00:00' }, { supplierCheckedAt: instant(600_000) },
    { reviewRequired: null }, { reviewRequired: 'false' }, { supplierStatus: ' ' },
    { supplierStatus: '\u0001' }, { source: 'made_up' }, { status: 'unknown' },
    { checkedAt: instant(-1_000) }, { bookingState: 'held' },
    { lastCheck: { checkedAt: instant(-1_000), verified: true, reasonCode: null } },
    { fresh: true }, { source: 'airline_refresh', verified: false },
    { source: 'airline_refresh', verified: false, supplierStatus: null, supplierCheckedAt: null },
  ].map(change => ({ ...metadata, ...change }));
  for (const key of Object.keys(metadata)) {
    const missing = { ...metadata };
    delete missing[key];
    invalid.push(missing);
  }
  for (const bad of invalid) {
    const result = await record(savedCancelled, bad);
    assert.equal(result.recorded, false, `Reject malformed saved summary: ${JSON.stringify(bad)}`);
    assert.equal(result.code, 'INVALID_CURRENT_STATUS');
    assert.equal(await observationSnapshot(), validObservations);
  }
  for (const key of ['uniqueTransId','itemCodeRef','priceCodeRef','bookingCodeRef','bookingRefNumber','pnr','supplierPublicRef']) {
    assert.equal((await record(savedCancelled, metadata, instant(6_000),
      { ...savedCancelled.identity, [key]: 'different' })).code, 'SUPPLIER_IDENTITY_UNVERIFIED');
    assert.equal(await observationSnapshot(), validObservations);
  }
  for (const original of [undefined, {}, 12, false, ' ', 'x'.repeat(101)]) {
    const identity = { ...savedCancelled.identity, originalBookingStatus: original };
    assert.equal((await record(savedCancelled, metadata, instant(6_000), identity)).code,
      'SUPPLIER_IDENTITY_UNVERIFIED', 'Nullable original status still requires a present valid null/string field');
  }
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_function_privilege($1,
      'record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb)','EXECUTE') as allowed`,
    [role])).rows[0].allowed, false);
    assert.equal((await db.query(`select has_table_privilege($1,
      'shapon_booking_current_status_observations','SELECT') as allowed`, [role])).rows[0].allowed, false);
  }
  await db.exec('set role service_role');
  await assert.rejects(db.query(`insert into shapon_booking_current_status_observations
    (booking_id,request_started_at,receipt_identity,original_booking_status,current_status)
    values($1,now(),'{}',null,'{}')`, [savedCancelled.booking.id]), /permission denied/);
  assert.equal((await record(savedHold, { ...metadata, status: 'on-hold', supplierStatus: null }, instant(10_000))).recorded, true);
  await db.exec('reset role');
  assert.deepEqual(await businessSnapshot(), businessAfterMigrations);

  // A saved read also cannot touch an existing protected wallet Hold/Issue.
  const wallet = (await db.query("select(wallet_ensure_account('agency','ST-B2B100001','BDT')).*")).rows[0];
  await db.query('update wallet_accounts set available_balance=2000000 where id=$1', [wallet.id]);
  const key = `saved-sync:${randomUUID()}`;
  const hash = digest(key);
  const claim = (await db.query("select wallet_begin_booking_issue_v2($1,'shapon-current-owner','b2b_sub',$2,$3) as result",
    [savedActive.booking.id, key, hash])).rows[0].result;
  assert.equal(claim.ok, true, JSON.stringify(claim));
  const activeBefore = await businessSnapshot();
  assert.equal((await record(savedActive, metadata)).recorded, true);
  assert.equal((await detail(savedActive)).lifecycle_status, 'in-progress');
  const latest = await record(savedActive, compactMetadata('confirmed'), instant(9_000),
    { ...savedActive.identity, canCancel: false });
  assert.equal(latest.recorded, true);
  assert.equal(latest.currentStatus.currentStatus.canCancel, false);
  assert.equal(latest.currentStatus.effectiveStatus, 'in-progress');
  const displayed = (await db.query(`select lifecycle_status,status_order
    from booking_dashboard_creator_v where id=$1 and lifecycle_status='confirmed'`,
  [savedActive.booking.id])).rows[0];
  assert.deepEqual(displayed, { lifecycle_status: 'confirmed', status_order: 3 },
    'My Bookings displays, filters and sorts by the Shapon platform status while local Issue remains guarded');
  const older = await record(savedActive, compactMetadata('on-hold'), instant(8_000),
    { ...savedActive.identity, canCancel: true });
  assert.equal(older.projectionUpdated, false);
  assert.equal(older.currentStatus.currentStatus.status, 'confirmed');
  assert.equal(older.currentStatus.currentStatus.canCancel, false);
  assert.deepEqual(await businessSnapshot(), activeBefore,
    'Saved cancelled evidence cannot release/capture an active Hold or complete its Issue/case');
  const issueRace = await createHold('issuerace');
  const issueIdentity = { ...issueRace.identity, issueResponse: true, canCancel: false };
  const raceBefore = await businessSnapshot();
  await record(issueRace, compactMetadata('on-hold'), instant(3_000));
  const pendingIssue = await record(issueRace, compactMetadata('in-progress', true), instant(4_000), issueIdentity);
  assert.equal(pendingIssue.projectionUpdated, true);
  assert.equal((await detail(issueRace)).shapon_current_status.currentStatus.status, 'in-progress');
  const readStartedDuringIssue = instant(5_000);
  const issueReplyAt = instant(6_000);
  await record(issueRace, compactMetadata('on-hold'), readStartedDuringIssue);
  const confirmedIssue = await record(issueRace, compactMetadata('confirmed'), issueReplyAt, issueIdentity);
  assert.equal(confirmedIssue.projectionUpdated, true,
    'A successful Issue outranks a GET started while the Issue was still running');
  for (const readStartedAt of [readStartedDuringIssue, issueReplyAt]) {
    const staleHold = await record(issueRace, compactMetadata('on-hold'), readStartedAt);
    assert.equal(staleHold.recorded, true);
    assert.equal(staleHold.projectionUpdated, false);
    assert.equal(staleHold.currentStatus.currentStatus.status, 'confirmed');
  }
  const delayedIssue = await record(issueRace, compactMetadata('in-progress', true), instant(7_000), issueIdentity);
  assert.equal(delayedIssue.code, 'STALE_ISSUE_STATUS');
  assert.equal((await detail(issueRace)).shapon_current_status.currentStatus.status, 'confirmed');
  const newerCancellation = await record(issueRace, compactMetadata('cancelled'), instant(8_000));
  assert.equal(newerCancellation.projectionUpdated, true);
  const delayedConfirmation = await record(issueRace, compactMetadata('confirmed'), instant(9_000), issueIdentity);
  assert.equal(delayedConfirmation.code, 'STALE_ISSUE_STATUS');
  assert.equal((await detail(issueRace)).shapon_current_status.currentStatus.status, 'cancelled');
  assert.deepEqual(await businessSnapshot(), raceBefore,
    'Provider display observations never mutate local bookings, payment or outbox');

  const missingLocator = await createHold('nolocator');
  const expiredLocator = await createHold('expiredlocator');
  await db.query("update flight_bookings set airlines_pnr='[]'::jsonb where id in ($1,$2)",
    [missingLocator.booking.id, expiredLocator.booking.id]);
  await db.query("update flight_bookings set supplier_ticketing_deadline_at=now()-interval '1 hour' where id=$1",
    [expiredLocator.booking.id]);
  const allowed = { ...missingLocator.identity, canIssue: true };
  const blockedBefore = await businessSnapshot();
  assert.equal((await walletClaim(missingLocator)).code, 'BOOKING_UNCONFIRMED',
    'A missing airline locator still requires verified explicit Shapon permission');
  assert.equal((await record(missingLocator, compactMetadata(), instant(2_000),
    { ...allowed, bookingCodeRef: randomUUID() })).code, 'SUPPLIER_IDENTITY_UNVERIFIED');
  assert.equal((await record(missingLocator, compactMetadata(), instant(2_000),
    { ...allowed, canIssue: 'true' })).code, 'INVALID_CURRENT_STATUS');
  assert.equal((await walletClaim(missingLocator)).code, 'BOOKING_UNCONFIRMED');
  await record(missingLocator, compactMetadata('unconfirmed'), instant(3_000), allowed);
  assert.equal((await walletClaim(missingLocator)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  await record(missingLocator, compactMetadata(), instant(4_000), { ...allowed, canIssue: false });
  assert.equal((await walletClaim(missingLocator)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  await record(expiredLocator, compactMetadata(), instant(4_000), { ...expiredLocator.identity, canIssue: true });
  assert.notEqual((await detail(expiredLocator)).lifecycle_status, 'on-hold');
  assert.equal((await walletClaim(expiredLocator)).ok, false, 'An elapsed local deadline still blocks Issue');
  assert.deepEqual(await businessSnapshot(), blockedBefore, 'Denied Issue claims leave wallet and booking rows untouched');

  await record(missingLocator, compactMetadata(), instant(6_000), allowed);
  const heldWithoutLocator = await detail(missingLocator);
  assert.equal(heldWithoutLocator.lifecycle_status, 'on-hold');
  assert.equal(heldWithoutLocator.shapon_current_status.currentStatus.canIssue, true);
  const noDisplayedLocator = (await db.query('select airline_pnr from booking_dashboard_creator_v where id=$1',
    [missingLocator.booking.id])).rows[0];
  assert.equal(noDisplayedLocator.airline_pnr, '', 'Reservation PNR remains absent from display');
  const issueKey = `shapon-no-airline-locator:${randomUUID()}`;
  const issueClaim = (await db.query("select wallet_begin_booking_issue_v2($1,'shapon-current-owner','b2b_sub',$2,$3) as result",
    [missingLocator.booking.id, issueKey, digest(issueKey)])).rows[0].result;
  assert.equal(issueClaim.ok, true, 'The ordinary atomic wallet Issue claim accepts a bound native Shapon hold');
  assert.equal((await detail(missingLocator)).status, 'in-progress');
  console.log(`Saved supplier_sync DB compatibility passed: full active chain ${catalogBefore.tables}/${catalogBefore.functions}, source/original time/null evidence, verified/unverified guards, ACL/owner/view preservation and unchanged money/business/outbox.`);
}

try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create extension pgcrypto with schema extensions;`);
  const oldColumns = {};
  for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.sql') && file < airlineRefreshMigration).sort()) {
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
  await db.exec("insert into app_users(clerk_id,role) values ('shapon-current-partner','b2b'),('shapon-current-owner','b2b_sub'); insert into agencies(agency_code,owner_user_id) values ('ST-B2B100001','shapon-current-partner'); update app_users set agency_code='ST-B2B100001' where clerk_id in ('shapon-current-partner','shapon-current-owner');");
  const cancelled = await createHold('cancelled');
  const uncertain = await createHold('uncertain');
  const confirmedRemote = await createHold('remoteissued');
  const issuable = await createHold('issuable');
  const localCancelled = await createHold('localcancelled');
  const remoteExpired = await createHold('expired');
  const remotePending = await createHold('pending');
  const unknownReview = await createHold('unknownreview');
  const localReconciliation = await createHold('localreconciliation');
  const compactHold = await createHold('compacthold');
  const compactReview = await createHold('compactreview');
  const richMissingState = await createHold('richmissingstate');
  const compactConflicts = new Map();
  for (const status of ['cancelled', 'expired', 'unconfirmed', 'pending', 'in-progress', 'confirmed']) {
    compactConflicts.set(status, await createHold(`compact${status.replace('-', '')}`));
  }
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

  const compactRead = await record(compactHold, compactMetadata());
  assert.equal(compactRead.recorded, true, 'The compact public status can be saved with exact receipt identity');
  assert.equal(compactRead.currentStatus.reviewRequired, false,
    'An explicit no-review public On Hold remains eligible despite private state being absent');
  assert.deepEqual(compactRead.currentStatus.currentStatus, compactMetadata(),
    'Public metadata retains false verification and null private states/timestamps');
  assert.equal((await detail(compactHold)).lifecycle_status, 'on-hold');
  assert.equal((await record(compactReview, compactMetadata('on-hold', true))).recorded, true);
  assert.equal((await walletClaim(compactReview)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  for (const [status, subject] of compactConflicts) {
    const read = await record(subject, compactMetadata(status));
    assert.equal(read.recorded, true);
    assert.equal(read.effectiveStatus, status === 'confirmed' ? 'on-hold' : status,
      'A public Confirmed cannot manufacture local tickets; other remote conflicts retain their display status');
    assert.equal(read.currentStatus.reviewRequired, true,
      'Every compact remote conflict forces review even when its supplier review flag is false');
    assert.equal((await walletClaim(subject)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  }
  assert.equal((await record(richMissingState, { ...holdMetadata(), bookingState: null })).recorded, true);
  assert.equal((await detail(richMissingState)).shapon_current_status.reviewRequired, true,
    'Rich evidence without held bookingState retains the prior fail-closed behavior');
  assert.equal((await walletClaim(richMissingState)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  for (const metadata of [
    { ...compactMetadata(), reviewRequired: null },
    { ...compactMetadata(), reviewRequired: undefined },
    { ...compactMetadata(), reviewRequired: 'false' },
    { ...compactMetadata(), verified: true },
    { ...compactMetadata(), bookingState: 'held' },
    { ...compactMetadata(), supplierStatus: 'Booked' },
    { ...compactMetadata(), checkedAt: instant(-1_000) },
    { ...compactMetadata(), supplierCheckedAt: instant(-1_000) },
    { ...compactMetadata(), lastCheck: { verified: false, checkedAt: instant(-1_000) } },
    { ...compactMetadata(), extraEvidence: 'unverified' },
  ]) {
    assert.equal((await record(compactHold, metadata)).recorded, false,
      'Compact provenance cannot invent verification, evidence, timestamps or an unknown review flag');
  }
  for (const key of ['uniqueTransId','itemCodeRef','priceCodeRef','bookingCodeRef','bookingRefNumber','pnr','supplierPublicRef']) {
    assert.equal((await record(compactHold, compactMetadata(), instant(6_000),
      { ...compactHold.identity, [key]: 'different' })).recorded, false,
    `Compact metadata also requires exact ${key} receipt identity`);
  }
  assert.deepEqual(await businessSnapshot(), snapshot,
    'Compact status records, invalid metadata and all conflict vetoes leave business/wallet/outbox unchanged');

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
  const wallet = (await db.query("select (wallet_ensure_account('agency','ST-B2B100001','BDT')).*")).rows[0];
  await db.query('update wallet_accounts set available_balance=2000000 where id=$1', [wallet.id]);
  const compactKey = `operation:v1:${digest(compactHold.booking.id)}`;
  const compactHash = digest(`ticket:${compactHold.booking.id}`);
  const compactClaim = (await db.query("select wallet_begin_booking_issue_v2($1,'shapon-current-owner','b2b_sub',$2,$3) as result",
    [compactHold.booking.id, compactKey, compactHash])).rows[0].result;
  assert.equal(compactClaim.ok, true,
    'A valid compact public no-review hold permits the real synthetic atomic wallet claim');
  assert.equal((await db.query('select count(*)::int as n from wallet_reservations where booking_id=$1',
    [compactHold.booking.id])).rows[0].n, 1);
  const issueKey = `operation:v1:${digest(issuable.booking.id)}`;
  const issueHash = digest(`ticket:${issuable.booking.id}`);
  const claim = (await db.query("select wallet_begin_booking_issue_v2($1,'shapon-current-owner','b2b_sub',$2,$3) as result",
    [issuable.booking.id, issueKey, issueHash])).rows[0].result;
  assert.equal(claim.ok, true, 'A valid no-review saved hold still permits the real synthetic atomic claim');
  const duringIssue = await businessSnapshot();
  await record(issuable, cancelledMetadata(), instant(25_000));
  assert.equal((await detail(issuable)).lifecycle_status, 'in-progress', 'Active local Issue outranks remote cancellation');
  assert.deepEqual(await businessSnapshot(), duringIssue, 'Evidence cannot release an active wallet reservation');
  await db.query('select mark_booking_operation_supplier_call_started($1,$2,$3)', [claim.operationId, issueKey, issueHash]);
  await db.query('select mark_booking_operation_supplier_response_received($1,$2,$3,200)', [claim.operationId, issueKey, issueHash]);
  const ticket = { pnr: 'ABC123', bookingStatus: 'Confirmed', ticketCodeRef: randomUUID(), ticketNumbers: ['1234567890123'] };
  assert.equal((await db.query("select wallet_capture_reservation_v2($1,'shapon-current-owner','b2b_sub',$2,$3,$4,$5) as result",
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

  // Reproduce the production mismatch first: the six documented API fields
  // validate in the application, but the prior recorder rejects their source.
  const refreshedCancelled = await createHold('airlinecancelled');
  const refreshedHold = await createHold('airlineheld');
  const nullableSupplierHold = await createHold('airlinenullstatus');
  const cancelledApi = airlineApiRead(refreshedCancelled);
  const previousHold = await record(refreshedCancelled, compactMetadata(), instant(1_000));
  assert.equal(previousHold.recorded, true);
  assert.equal(previousHold.effectiveStatus, 'on-hold');
  assert.equal(previousHold.currentStatus.reviewRequired, false);
  const observationBefore = await observationSnapshot();
  const businessBefore = await businessSnapshot();
  const previous = await recordApi(refreshedCancelled, cancelledApi);
  assert.equal(previous.checked.currentStatusState, 'available');
  assert.equal(previous.checked.currentStatus.source, 'airline_refresh');
  assert.equal(previous.storage.currentStatusStorage, 'not_recorded');
  assert.equal(previous.response.code, 'INVALID_CURRENT_STATUS');
  assert.equal((await detail(refreshedCancelled)).lifecycle_status, 'on-hold');
  assert.deepEqual((await detail(refreshedCancelled)).shapon_current_status, previousHold.currentStatus,
    'Before the fix, the rejected cancelled read leaves the actual saved On Hold observation intact');
  assert.equal(await observationSnapshot(), observationBefore);
  assert.deepEqual(await businessSnapshot(), businessBefore);

  assert.ok(forwardMigrationNames.includes(airlineRefreshMigration), 'The reviewed production chain registers the forward fix');
  const forward = fs.readFileSync(path.join(path.dirname(artifactPath), airlineRefreshMigration), 'utf8');
  const columnsBefore = Object.fromEntries(await Promise.all(views.map(async view => [view, await columns(view)])));
  const recorderAcl = async () => (await db.query(`select role,
    has_function_privilege(role,'record_shapon_booking_current_status_v1(uuid,timestamptz,text,jsonb,jsonb)','EXECUTE') recorder,
    has_table_privilege(role,'shapon_booking_current_status_observations','SELECT') observation_read,
    has_table_privilege(role,'shapon_booking_current_status_observations','INSERT') observation_write
    from unnest(array['anon','authenticated','service_role']) role`)).rows;
  const aclBefore = await recorderAcl();
  await db.exec(forward);
  await db.exec(forward);
  assert.deepEqual(await businessSnapshot(), businessBefore, 'Applying/reapplying the fix cannot change any business or wallet row');
  assert.equal(await observationSnapshot(), observationBefore, 'The forward fix does not rewrite observations');
  assert.deepEqual(await recorderAcl(), aclBefore, 'Recorder and private observation privileges stay unchanged');
  for (const view of views) assert.deepEqual(await columns(view), columnsBefore[view], `${view} column order/types stay unchanged`);

  const refreshed = await recordApi(refreshedCancelled, cancelledApi);
  assert.equal(refreshed.response.recorded, true);
  assert.equal(refreshed.response.projectionUpdated, true);
  assert.deepEqual(refreshed.storage, { projectionUpdated: true, currentStatusStorage: 'saved',
    displayStatus: 'cancelled', displayReviewRequired: true });
  assert.equal(refreshed.response.currentStatus.currentStatus.supplierCheckedAt, cancelledApi.body.currentStatus.supplierCheckedAt);
  assert.equal(refreshed.response.currentStatus.currentStatus.checkedAt, null);
  const savedCancelled = await detail(refreshedCancelled);
  assert.equal(savedCancelled.status, 'on-hold', 'Only the read projection changes; raw booking status remains held');
  assert.equal(savedCancelled.lifecycle_status, 'cancelled');
  assert.notDeepEqual(savedCancelled.shapon_current_status, previousHold.currentStatus,
    'A newer valid cancelled observation replaces the previously saved hold projection');
  assert.equal(savedCancelled.shapon_current_status.reviewRequired, true, 'Remote cancellation retains the local conflict review rule');
  const orderedCancelled = (await db.query('select lifecycle_at,status_order from booking_dashboard_creator_v where id=$1',
    [refreshedCancelled.booking.id])).rows[0];
  assert.equal(orderedCancelled.status_order, 6);
  assert.equal(orderedCancelled.lifecycle_at.toISOString(), new Date(cancelledApi.body.currentStatus.supplierCheckedAt).toISOString(),
    'Cancelled date/filter/sorting uses the saved supplier instant, never the GET received time');
  const observedEpoch = Date.parse(cancelledApi.body.currentStatus.supplierCheckedAt);
  const sourceDateRange = (await db.query(`select count(*)::int as n from booking_dashboard_creator_v
    where id=$1 and lifecycle_status='cancelled' and lifecycle_at>=$2::timestamptz and lifecycle_at<$3::timestamptz`,
  [refreshedCancelled.booking.id, new Date(observedEpoch - 1_000).toISOString(),
    new Date(observedEpoch + 1_000).toISOString()])).rows[0].n;
  assert.equal(sourceDateRange, 1, 'A date-range dashboard filter includes the saved source cancellation time');
  assert.equal((await walletClaim(refreshedCancelled)).code, 'SUPPLIER_CURRENT_STATUS_BLOCKS_ISSUE');
  for (const [subject, supplierStatus] of [[refreshedHold, 'on-hold'], [nullableSupplierHold, null]]) {
    const api = airlineApiRead(subject, 'on-hold', supplierStatus);
    const held = await recordApi(subject, api);
    assert.deepEqual(held.storage, { projectionUpdated: true, currentStatusStorage: 'saved',
      displayStatus: 'on-hold', displayReviewRequired: false });
    assert.equal((await detail(subject)).shapon_current_status.reviewRequired, false,
      'A verified matching hold does not need private held state or a made-up supplier status');
    assert.equal(held.response.currentStatus.currentStatus.bookingState, null);
    assert.equal(held.response.currentStatus.currentStatus.checkedAt, null);
    assert.equal(held.response.currentStatus.currentStatus.lastCheck, null);
    assert.equal(held.response.currentStatus.currentStatus.supplierStatus, supplierStatus);
  }
  const validObservationSnapshot = await observationSnapshot();
  for (const change of [
    { source: 'made_up' }, { verified: false }, { verified: 'true' },
    { supplierCheckedAt: null }, { supplierCheckedAt: '2026-02-30T10:00:00+06:00' },
    { supplierCheckedAt: '2026-10-14T10:00:00' }, { supplierCheckedAt: instant(600_000) },
  ]) {
    const bad = plain(cancelledApi);
    Object.assign(bad.body.currentStatus, change);
    const rejected = await recordApi(refreshedCancelled, bad);
    assert.equal(rejected.storage.currentStatusStorage, 'not_recorded', JSON.stringify(change));
    assert.equal(await observationSnapshot(), validObservationSnapshot, 'Malformed API metadata cannot erase a valid cancelled observation');
  }
  const invalidSqlMetadata = [
    { reviewRequired: null }, { reviewRequired: 'false' },
    { verified: false }, { verified: 'true' }, { verified: null },
    { source: 'made_up' }, { status: ' ' }, { status: 'cancelled\u0001' },
    { supplierStatus: ' ' }, { supplierStatus: '\u0001' }, { supplierStatus: { status: 'cancelled' } },
    { supplierStatus: null, supplierCheckedAt: null },
    { supplierCheckedAt: '2026-02-30T10:00:00+06:00' },
    { supplierCheckedAt: '2026-10-14T10:00:00' }, { supplierCheckedAt: instant(600_000) },
    { checkedAt: instant(-1_000) }, { bookingState: 'held' },
    { lastCheck: { checkedAt: instant(-1_000), verified: true, reasonCode: null } },
  ].map(change => ({ ...plain(refreshed.checked.currentStatus), ...change }));
  for (const key of ['reviewRequired','verified','bookingState','supplierStatus','checkedAt','supplierCheckedAt','lastCheck']) {
    const missing = plain(refreshed.checked.currentStatus);
    delete missing[key];
    invalidSqlMetadata.push(missing);
  }
  for (const metadata of invalidSqlMetadata) {
    const rejected = await record(refreshedCancelled, metadata);
    assert.equal(rejected.recorded, false, `SQL rejects malformed airline-refresh metadata: ${JSON.stringify(metadata)}`);
    assert.equal(rejected.code, 'INVALID_CURRENT_STATUS');
    assert.equal(await observationSnapshot(), validObservationSnapshot);
  }
  for (const key of ['uniqueTransId','itemCodeRef','priceCodeRef','bookingCodeRef','bookingRefNumber','pnr','supplierPublicRef']) {
    const rejected = await record(refreshedCancelled, refreshed.checked.currentStatus, instant(6_000),
      { ...refreshedCancelled.identity, [key]: 'different' });
    assert.equal(rejected.recorded, false, `New provenance retains exact ${key} identity pins`);
    assert.equal(await observationSnapshot(), validObservationSnapshot);
  }
  const mismatchedApi = plain(cancelledApi);
  mismatchedApi.body.item1.bookingCodeRef = randomUUID();
  const beforeMismatchCalls = rpcCalls;
  assert.equal((await recordApi(refreshedCancelled, mismatchedApi)).checked.result, 'mismatch');
  assert.equal(rpcCalls, beforeMismatchCalls, 'A failed receipt identity never reaches the database recorder');
  assert.deepEqual(await businessSnapshot(), businessBefore, 'Valid and rejected source observations leave raw bookings/payment/wallet/outbox unchanged');
  assert.equal((await detail(refreshedCancelled)).lifecycle_status, 'cancelled');
  const plan = (await db.query(`explain (format json) select lifecycle_status,shapon_current_status
    from booking_dashboard_creator_v order by status_order limit 25`)).rows[0]['QUERY PLAN'][0].Plan;
  assert.ok(Number.isFinite(plan['Total Cost']) && plan['Total Cost'] < 100000,
    'The bounded shared projection must not create a JIT-scale plan');
  console.log(`Shapon current-status DB projection passed: identity/order, list/detail/filter/sort, local ticket/Admin precedence, atomic issue veto, six-field airline refresh validator/RPC/projection and unchanged business/wallet/outbox; plan cost ${plan['Total Cost']}.`);
  await verifySavedSupplierSync();
} catch (error) {
  console.error(error.message);
  if (error.detail) console.error(error.detail);
  if (!error.code) console.error(error.stack);
  failure = error;
} finally {
  await db.close();
}
if (failure) throw new Error(`Shapon current-status DB regression failed: ${failure.message}`);
