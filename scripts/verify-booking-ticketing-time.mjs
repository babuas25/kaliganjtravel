import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Real route, PNR adapter and persistence helper against the complete local
// schema. Only authentication and the supplier transport are simulated.
globalThis.fetch = () => { throw new Error('Network access is forbidden'); };
const require = createRequire(import.meta.url);
const db = new PGlite({ extensions: { pgcrypto } });
const hash = value => createHash('sha256').update(value).digest('hex');
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const readRow = async id => (await one('select to_jsonb(b) as row from flight_bookings b where id=$1', [id])).row;
let bookingId, session, hidden, permitted, supplierReply, envelopeEchoes, onSupplierRead;
let supplierCalls = [], patches = [], savedReads = [], savedReply;
let deadlineRefreshes = [], deadlineReply, deadlineSaves = [];
let enforceSharedLiveRate = false;
const cache = new Map();
class TriploverError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}
const forbidden = () => { throw new Error('Unexpected supplier mutation, ticket or wallet call'); };
const mocks = {
  '@/lib/db/booking-payment-resolution': { BOOKING_PAYMENT_EFFECTS: ['charge_wallet','capture_hold','already_paid'], previewShaponTicketPayment: forbidden },
  '@/lib/shapontravels/cancellation-recovery': { verifyShaponCancellationRecovery: forbidden },
  '@/lib/shapontravels/client': { shapontravelsReadBooking: async lookup => {
    const booking = await readRow(bookingId);
    assert.deepEqual(lookup, { bookingId: booking.booking_code_ref });
    savedReads.push(lookup);
    if (onSupplierRead) await onSupplierRead();
    if (savedReply instanceof Error) throw savedReply;
    return savedReply;
  }, shapontravelsRefreshTicketingDeadline: async supplierBookingId => {
    assert.equal(supplierBookingId, (await readRow(bookingId)).booking_code_ref);
    deadlineRefreshes.push(supplierBookingId);
    if (onSupplierRead) await onSupplierRead();
    return deadlineReply;
  }, shapontravelsReadTicket: forbidden, shapontravelsReadCancellation: forbidden },
  '@/lib/shapontravels/current-status-store': { recordShapontravelsCurrentStatus: async () =>
    ({ projectionUpdated: false, currentStatusStorage: 'not_recorded' }) },
  '@/lib/shapontravels/ticket': { parseShapontravelsTicketEvidence: forbidden, shapontravelsTicketIdentityReady: forbidden },
  '@/lib/shapontravels/cancel': { parseShapontravelsCancellationReceipt: forbidden, shapontravelsCancellationReferencesReady: forbidden },
  '@/lib/shapontravels/external-ticket-confirmation': {
    canConfirmShaponExternalTicket: role => role === 'admin' || role === 'superadmin',
    canOfferShaponExternalTicketConfirmation: forbidden, isShaponTicketingRecovery: forbidden,
    verifyShaponExternalTicketConfirmation: forbidden,
  },
  '@/lib/dashboard/session': { getDashboardSession: async () => session },
  '@/lib/db/ticket-management': {},
  '@/lib/db/booking-lifecycle': {},
  '@/lib/db/flight-bookings': { readBookingByPublicRef: async (reference, scope) => {
    assert.deepEqual(scope, load('lib/dashboard/bookings.ts').bookingScopeFor(session));
    const booking = await readRow(bookingId);
    assert.equal(reference, booking.public_ref);
    return hidden ||
      (scope.kind === 'user' && scope.clerkId !== booking.user_id) ||
      (scope.kind === 'agency' && scope.agencyCode !== booking.agency_code)
      ? null : booking;
  } },
  '@/lib/rate-limit': { checkActionLimit: async (name, key) => {
    assert.ok(['refreshTicketingTime', 'shaponLiveDeadlineRefresh'].includes(name));
    assert.equal(key, bookingId);
    if (enforceSharedLiveRate) {
      assert.equal(name, 'shaponLiveDeadlineRefresh');
      return load('lib/rate-limit.ts').checkActionLimit(name, key);
    }
    return permitted ? { ok: true } : { ok: false, retryAfterSeconds: 10 };
  } },
  '@/lib/triplover/client': {
    TriploverError,
    triploverCall: async (operation, endpoint, payload, options) => {
      assert.equal(operation, 'Pnr'); assert.equal(endpoint, '/api/pnr');
      assert.equal(options.timeoutMs, 30000);
      const booking = await readRow(bookingId);
      assert.deepEqual(payload, {
        PNR: booking.pnr, BookingRefNumber: booking.booking_ref_number,
        UniqueTransID: booking.supplier_refs.uniqueTransId,
        PriceCodeRef: booking.supplier_refs.priceCodeRef,
        ItemCodeRef: booking.supplier_refs.itemCodeRef, BookingCodeRef: booking.booking_code_ref,
      });
      assert.equal(options.supplier, booking.supplier_account);
      supplierCalls.push({ operation, payload });
      if (onSupplierRead) await onSupplierRead();
      if (supplierReply instanceof Error) throw supplierReply;
      return { data: supplierReply, uniqueTransIds: envelopeEchoes,
        receipt: { requestStartedAt: new Date().toISOString(), responseReceivedAt: new Date().toISOString(), httpStatus: 200, rawPayloadHash: hash('pnr-fixture') } };
    },
  },
  '@/lib/supabase/server': { supabaseAdmin: () => ({ rpc: async (name, args) => {
    if (name === 'consume_security_rate_limit') {
      const { rows } = await db.query('select * from public.consume_security_rate_limit($1,$2,$3)',
        [args.p_key, args.p_limit, args.p_window_ms]);
      return { data: rows, error: null };
    }
    assert.equal(name, 'apply_shapon_booking_deadline');
    assert.equal(args.p_booking_id, bookingId);
    assert.equal(args.p_event_id, null);
    deadlineSaves.push(args);
    const { data } = await one('select public.apply_shapon_booking_deadline($1,$2,$3,$4,$5,$6,$7) as data', [
      args.p_booking_id, args.p_supplier_booking_id, args.p_supplier_public_ref,
      args.p_expected_updated_at, args.p_revision, args.p_deadline_at, args.p_event_id,
    ]);
    return { data, error: null };
  }, from: table => {
    assert.equal(table, 'flight_bookings');
    let patch, columns, filters = [];
    const builder = {
      update: value => { patch = value; patches.push(value); return builder; },
      eq: (key, value) => { filters.push([key, value]); return builder; },
      select: value => { columns = value; return builder; },
      single: async () => {
        assert.equal(patch, undefined);
        assert.equal(columns, 'supplier_public_ref');
        assert.deepEqual(filters, [['id', bookingId]]);
        return { data: { supplier_public_ref: (await readRow(bookingId)).supplier_public_ref }, error: null };
      },
      maybeSingle: async () => {
        const entries = Object.entries(patch);
        for (const key of [...entries.map(([k]) => k), ...filters.map(([k]) => k), ...columns.split(',')]) {
          assert.match(key, /^[a-z_]+$/);
        }
        const set = entries.map(([k], i) => `${k}=$${i + 1}`).join(',');
        const where = filters.map(([k], i) => `${k}=$${entries.length + i + 1}`).join(' and ');
        const result = await db.query(`update flight_bookings set ${set} where ${where} returning ${columns}`,
          [...entries.map(([, v]) => v), ...filters.map(([, v]) => v)]);
        const row = result.rows[0];
        return { data: row ? JSON.parse(JSON.stringify(row)) : null, error: null };
      },
    };
    return builder;
  } }) },
};
function load(file) {
  const full = path.resolve(file);
  if (cache.has(full)) return cache.get(full).exports;
  const module = { exports: {} }; cache.set(full, module);
  const code = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('require', 'module', 'exports', code)(name => {
    if (name === 'server-only') return {};
    if (mocks[name]) return mocks[name];
    if (name.startsWith('@/')) return load(`${name.slice(2)}.ts`);
    if (name.startsWith('.')) return load(path.resolve(path.dirname(full), `${name}.ts`));
    return require(name);
  }, module, module.exports);
  return module.exports;
}
const route = load('app/api/flights/booking/refresh-ticketing-time/route.ts');
const statusRoute = load('app/api/flights/booking/shapon-status/route.ts');
async function makeShaponBooking() {
  const id = randomUUID(), key = `book:${id}`;
  const refs = { uniqueTransId: randomUUID(), itemCodeRef: randomUUID(), priceCodeRef: randomUUID() };
  const offer = { currency: 'BDT', pricing: { sellingPrice: 500 }, passengerCounts: { ADT: 1 },
    travelDate: '2030-10-02', directTicketing: false, itinerary: { carrierCode: 'OD', legs: [] },
    fares: [], passportRequired: false, repricedAt: '2026-09-15T00:00:00Z' };
  await db.query(`insert into booking_attempts(id,access_token_hash,user_id,audience,state,search_id,itinerary_id,
    unique_trans_id,item_code_ref,price_code_ref,offer_snapshot,passenger_snapshot,expires_at,submitted_at,supplier,supplier_account,
    operation_request_key,operation_request_payload_hash,supplier_call_started_at,supplier_response_received_at,supplier_operation)
    values ($1,$2,'deadline-owner','b2c','submitting',$3,'fixture',$4,$5,$6,$7,'[]',
    now()+interval '5 minutes',now()-interval '1 minute','shapontravels','shapontravels',$8,$9,now()-interval '1 minute',now(),'Book')`,
    [id,hash(id),randomUUID(),refs.uniqueTransId,refs.itemCodeRef,refs.priceCodeRef,JSON.stringify(offer),key,hash(key)]);
  const result = await one('select (create_shapontravels_booking_from_attempt_v1($1,$2,$3,$4)).id as id',
    [id,key,hash(key),JSON.stringify({ status: 'held', pnr: 'PNR123', airlinesPnr: ['AIR123'],
      bookingRefNumber: 'PNR123', bookingCodeRef: randomUUID(), supplierPublicRef: `STR${id.replaceAll('-', '').slice(0, 20).toUpperCase()}`,
      supplierRefs: refs, bookingStatus: 'Created', ticketingTimeLimit: null,
      ticketCodeRef: null, ticketNumbers: [], warnings: ['Keep this warning'] })]);
  bookingId = result.id;
}
async function resetShapon(iso = '2030-10-18T19:59:00+06:00') {
  await reset(); savedReads = [];
  const b = await readRow(bookingId);
  savedReply = { httpStatus: 200, supplierPublicRef: b.supplier_public_ref, body: {
    item1: { uniqueTransID: b.supplier_refs.uniqueTransId, itemCodeRef: b.supplier_refs.itemCodeRef,
      priceCodeRef: b.supplier_refs.priceCodeRef, bookingCodeRef: b.booking_code_ref,
      bookingRefNumber: b.pnr, pnr: b.pnr, bookingStatus: 'Booked', ticketingTimeLimit: iso },
    item2: { isSuccess: true },
    currentStatus: { status: 'on-hold', reviewRequired: false, source: 'supplier_sync', verified: true,
      supplierStatus: 'Booked', supplierCheckedAt: '2030-10-18T10:50:21Z' },
    publicReceipt: { status: 'on-hold', pendingReview: false, actions: { canIssue: true },
      deadline: { iso, raw: iso ? '18 Oct 2030, 7:59 PM' : null, timeZone: iso ? 'Asia/Dhaka' : null } },
  } };
}

async function resetDeadlineRefresh(overrides = {}) {
  await resetShapon();
  process.env.SHAPONTRAVELS_DEADLINE_REFRESH_ENABLED = 'true';
  const b = await readRow(bookingId);
  deadlineReply = { httpStatus: 200, retryAfter: null, body: {
    bookingId: b.booking_code_ref, reference: b.supplier_public_ref, revision: 2,
    deadlineAt: '2030-10-18T19:59:00.123456789+06:00', available: true, outcome: 'verified',
    ...overrides,
  } };
}

async function makeBooking(supplier = 'triplover') {
  const id = randomUUID(), key = `book:${id}`;
  const offer = { currency: 'BDT', pricing: { sellingPrice: 500 }, passengerCounts: { ADT: 1 },
    travelDate: '2030-10-02', directTicketing: false, itinerary: { carrierCode: 'SQ', legs: [] },
    fares: [], passportRequired: false, repricedAt: '2026-09-15T00:00:00Z' };
  await db.query(`insert into booking_attempts(id,access_token_hash,user_id,audience,state,search_id,itinerary_id,
    unique_trans_id,item_code_ref,price_code_ref,offer_snapshot,passenger_snapshot,expires_at,submitted_at,supplier_account,
    operation_request_key,operation_request_payload_hash,supplier_call_started_at,supplier_response_received_at,supplier_operation)
    values ($1,$2,'deadline-owner','b2c','submitting',$3,'fixture',$4,'item-token','price-token',$5,'[]',
    now()+interval '5 minutes',now()-interval '1 minute',$6,$7,$8,now()-interval '1 minute',now(),'Book')`,
  [id, hash(id), randomUUID(), `txn:${id}`, JSON.stringify(offer), supplier, key, hash(key)]);
  const result = await one('select (create_booking_from_attempt_v2($1,$2,$3,$4)).id as id', [id, key, hash(key), JSON.stringify({
    status: 'held', pnr: 'PNR123', airlinesPnr: ['AIR123'], bookingRefNumber: 'BOOK456', bookingCodeRef: 'book-token',
    bookingStatus: 'Created', ticketingTimeLimit: null, ticketCodeRef: null, ticketNumbers: [], warnings: ['Keep this warning'],
  })]);
  bookingId = result.id;
  return readRow(bookingId);
}
async function reset() {
  session = { clerkId: 'deadline-admin', role: 'admin' }; hidden = false; permitted = true;
  supplierCalls = []; patches = []; onSupplierRead = null;
  deadlineRefreshes = []; deadlineSaves = [];
  delete process.env.VERCEL_ENV;
  delete process.env.SHAPONTRAVELS_DEADLINE_REFRESH_ENABLED;
  const booking = await readRow(bookingId);
  // Deliberately conflicting business facts must never overwrite local data.
  supplierReply = { pnr: booking.pnr, uniqueTransID: booking.supplier_refs.uniqueTransId,
    status: 'Cancelled', airlinePNRs: ['OTHER9'], lastTicketTime: '02/10/2030 20:45:00',
    ticketNumbers: ['9990000000001'], passengerInfoes: [], totalPrice: 1 };
  envelopeEchoes = [booking.supplier_refs.uniqueTransId];
}
async function request(body, selectedRoute = route) {
  const b = await readRow(bookingId);
  return selectedRoute.POST(new Request('http://localhost/api/flights/booking/refresh-ticketing-time', {
    method: 'POST', body: JSON.stringify(body ?? { bookingReference: b.public_ref }),
  }));
}
const deadlineColumns = new Set(['supplier_ticketing_time_limit', 'supplier_ticketing_deadline_at', 'supplier_deadline_source',
  'ticketing_time_limit', 'ticketing_deadline_at', 'deadline_source', 'updated_at']);
const otherData = row => Object.fromEntries(Object.entries(row).filter(([key]) => !deadlineColumns.has(key)));
async function relatedData() {
  const data = {};
  for (const table of ['wallet_accounts', 'wallet_reservations', 'wallet_ledger_entries', 'booking_operations',
    'booking_status_events', 'booking_reconciliation_cases', 'booking_deadline_observations', 'booking_pnr_refresh_jobs']) {
    data[table] = (await db.query(`select to_jsonb(t) as row from ${table} t order by id`)).rows;
  }
  return data;
}
try {
  await db.exec('create role anon; create role authenticated; create role service_role; create schema auth; create schema storage; create schema extensions; create extension pgcrypto with schema extensions;');
  const directory = 'supabase/fresh-install/supabase/migrations';
  for (const file of fs.readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec(fs.readFileSync(`${directory}/${file}`, 'utf8'));
  }
  await db.exec("insert into app_users(clerk_id,role) values ('deadline-owner','customer'),('deadline-admin','admin');");

  for (const supplier of ['firsttrip', 'triplover', 'takeoff']) {
    await makeBooking(supplier); await reset();
    const before = await readRow(bookingId), relatedBefore = await relatedData();
    const response = await request(), body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(body.data.updated, true);
    const after = await readRow(bookingId);
    assert.equal(after.supplier_ticketing_time_limit, supplierReply.lastTicketTime);
    assert.equal(new Date(after.ticketing_deadline_at).toISOString(), supplier === 'takeoff' ? '2030-02-10T14:45:00.000Z' : '2030-10-02T14:45:00.000Z');
    assert.deepEqual(otherData(after), otherData(before), 'Only deadline columns and updated_at may change');
    assert.deepEqual(await relatedData(), relatedBefore, 'No wallet, status event, reconciliation or PNR job side effects');
    assert.equal(supplierCalls.length, 1);
    assert.doesNotMatch(JSON.stringify(body), /token|OTHER9|Cancelled|9990000000001|evidence|passenger/);
  }

  for (const status of ['confirmed', 'cancelled']) {
    await makeBooking();
    await db.query('update flight_bookings set status=$2,ticket_numbers=$3 where id=$1', [bookingId, status, JSON.stringify(['6180000000001'])]);
    await reset(); const before = await readRow(bookingId);
    assert.equal((await request()).status, 200);
    assert.deepEqual(otherData(await readRow(bookingId)), otherData(before));
  }
  await makeBooking();
  const override = await one(`insert into superadmin_booking_deadline_overrides(booking_id,request_key,effective_deadline_at,actor_user_id,actor_role)
    values($1,$2,'2030-11-01T12:00:00Z','deadline-superadmin','superadmin') returning id`, [bookingId, randomUUID()]);
  await db.query('update flight_bookings set active_superadmin_deadline_override_id=$2 where id=$1', [bookingId, override.id]);
  await reset(); const overrideBefore = await readRow(bookingId);
  assert.equal((await request()).status, 200);
  const overrideAfter = await readRow(bookingId);
  assert.equal(overrideAfter.ticketing_deadline_at, overrideBefore.ticketing_deadline_at);
  assert.deepEqual(otherData(overrideAfter), otherData(overrideBefore), 'Keep local deadline approvals/overrides');

  for (const configure of [
    () => { supplierReply.lastTicketTime = null; },
    () => { supplierReply.lastTicketTime = ''; },
  ]) {
    await reset(); configure(); const before = await readRow(bookingId);
    assert.equal((await (await request()).json()).data.updated, false);
    assert.deepEqual(await readRow(bookingId), before, 'Missing time must not erase an existing deadline');
    assert.equal(patches.length, 0);
  }
  for (const configure of [
    () => { supplierReply.lastTicketTime = 'not a date'; },
    () => { supplierReply.lastTicketTime = '31/02/2030 12:00:00'; },
    () => { supplierReply = new TriploverError('network', 'private diagnostic'); },
    () => { supplierReply.pnr = 'WRONG9'; },
    () => { envelopeEchoes = ['wrong-transaction']; },
    () => { delete supplierReply.uniqueTransID; envelopeEchoes = []; },
  ]) {
    await reset(); configure(); const before = await readRow(bookingId);
    const response = await request(); assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /private diagnostic|wrong-transaction|WRONG9/);
    assert.deepEqual(await readRow(bookingId), before); assert.equal(patches.length, 0);
  }
  await reset(); let racedRow;
  onSupplierRead = async () => {
    await db.query("update flight_bookings set supplier_message='A concurrent update' where id=$1", [bookingId]);
    racedRow = await readRow(bookingId);
  };
  assert.equal((await request()).status, 409);
  assert.deepEqual(await readRow(bookingId), racedRow, 'A stale supplier read must not overwrite a concurrent change');

  for (const [configure, expected] of [
    [() => { session = null; }, 401],
    [() => { session.role = 'staff_media'; }, 403],
    [() => { session = { clerkId: 'someone-else', role: 'customer' }; }, 404],
    [() => { session = { clerkId: 'deadline-owner', role: 'b2b', agencyCode: 'another-agency' }; }, 404],
    [() => { hidden = true; }, 404], [() => { permitted = false; }, 429],
  ]) {
    await reset(); configure(); assert.equal((await request()).status, expected); assert.equal(supplierCalls.length, 0);
  }
  for (const role of ['customer', 'b2b', 'b2b_sub']) {
    await reset(); session = { clerkId: 'deadline-owner', role, agencyCode: null };
    assert.equal((await request()).status, 200, 'Owners can refresh their own deadline');
    assert.equal(supplierCalls.length, 1);
  }
  await reset(); assert.equal((await request({ bookingReference: 'invalid' })).status, 400); assert.equal(supplierCalls.length, 0);
  await reset(); assert.equal((await request({ bookingReference: (await readRow(bookingId)).public_ref, status: 'confirmed' })).status, 400);
  assert.equal(supplierCalls.length, 0);
  // All upstream accounts share one canonical public contract. Their raw local
  // date formats are irrelevant to this API client; no live PNR is dispatched.
  for (const upstream of ['triplover', 'firsttrip', 'takeoff']) {
    await makeShaponBooking(); await resetShapon();
    savedReply.body.publicReceipt.deadline.raw = upstream === 'triplover' ? '18 Oct 2030, 7:59 PM'
      : upstream === 'firsttrip' ? '18/10/2030 19:59:00' : '10/18/2030 19:59:00';
    const before = await readRow(bookingId), related = await relatedData();
    const response = await request(), result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.data.updated, true);
    assert.equal(new Date(result.data.ticketingDeadlineAt).toISOString(), '2030-10-18T13:59:00.000Z');
    const after = await readRow(bookingId);
    assert.equal(after.supplier_deadline_source, 'supplier', 'A saved API GET is not a live PNR observation');
    assert.deepEqual(otherData(after), otherData(before));
    assert.deepEqual(await relatedData(), related);
    assert.equal(savedReads.length, 1); assert.equal(supplierCalls.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /PNR123|bookingCodeRef|supplier_public_ref|uniqueTransID/);
    await resetShapon();
    assert.equal((await (await request()).json()).data.updated, false, 'Identical reads do not write again');
    assert.equal(patches.length, 0);
  }
  // Status refresh must persist the deadline even when status metadata is
  // unchanged or uses a newer source that the legacy status recorder skips.
  await makeShaponBooking(); await resetShapon();
  const beforeStatus = await readRow(bookingId), relatedStatus = await relatedData();
  const statusResult = await (await request(undefined, statusRoute)).json();
  assert.equal(statusResult.data.ticketingTimeUpdated, true);
  assert.equal(statusResult.data.projectionUpdated, false);
  assert.equal(new Date(statusResult.data.ticketingDeadlineAt).toISOString(), '2030-10-18T13:59:00.000Z');
  assert.deepEqual(otherData(await readRow(bookingId)), otherData(beforeStatus));
  assert.deepEqual(await relatedData(), relatedStatus);
  assert.equal(savedReads.length, 1); assert.equal(supplierCalls.length, 0);

  for (const configure of [
    () => { savedReply.httpStatus = 202; }, () => { savedReply.httpStatus = 404; },
    () => { savedReply.supplierPublicRef = 'STRFOREIGN123456'; },
    ...['uniqueTransID','itemCodeRef','priceCodeRef','bookingCodeRef','pnr','bookingRefNumber'].map(key =>
      () => { savedReply.body.item1[key] = 'foreign'; }),
    () => { delete savedReply.body.publicReceipt.deadline; },
    () => { delete savedReply.body.publicReceipt.deadline.iso; },
    ...['bad','2030-02-30T19:59:00+06:00','18/10/2030 19:59:00','2030-10-18T19:59:00'].map(value =>
      () => { savedReply.body.publicReceipt.deadline.iso = value; }),
    () => { savedReply.body.publicReceipt.deadline.timeZone = 'UTC'; },
    () => { savedReply.body.item1.ticketingTimeLimit = '2030-10-18T20:59:00+06:00'; },
    () => { savedReply = new Error('Private transport detail'); },
  ]) {
    await resetShapon(); configure(); const before = await readRow(bookingId);
    const response = await request(); assert.equal(response.status, 502);
    assert.equal(patches.length, 0); assert.deepEqual(await readRow(bookingId), before);
    assert.doesNotMatch(await response.text(), /Private transport detail|foreign/);
  }
  await resetShapon(null);
  const beforeUnknown = await readRow(bookingId);
  const clear = await (await request()).json();
  assert.equal(clear.data.updated, false);
  assert.equal(clear.data.ticketingDeadlineAt, beforeUnknown.ticketing_deadline_at);
  assert.deepEqual(await readRow(bookingId), beforeUnknown, 'Unversioned null is missing evidence, not a clear');

  const shaponOverride = await one(`insert into superadmin_booking_deadline_overrides(booking_id,request_key,effective_deadline_at,actor_user_id,actor_role)
    values($1,$2,'2030-11-01T12:00:00Z','deadline-superadmin','superadmin') returning id`, [bookingId, randomUUID()]);
  await db.query('update flight_bookings set active_superadmin_deadline_override_id=$2 where id=$1', [bookingId, shaponOverride.id]);
  await resetShapon(); const beforeOverride = await readRow(bookingId);
  const resultOverride = await (await request()).json();
  assert.equal(new Date(resultOverride.data.ticketingDeadlineAt).toISOString(), '2030-11-01T12:00:00.000Z');
  assert.deepEqual(otherData(await readRow(bookingId)), otherData(beforeOverride));
  await resetShapon(null);
  assert.equal(new Date((await (await request()).json()).data.ticketingDeadlineAt).toISOString(), '2030-11-01T12:00:00.000Z');
  await resetShapon();
  let racedShapon;
  onSupplierRead = async () => { await db.query("update flight_bookings set supplier_message='Concurrent change' where id=$1", [bookingId]); racedShapon = await readRow(bookingId); };
  assert.equal((await request()).status, 409);
  assert.deepEqual(await readRow(bookingId), racedShapon);
  for (const [configure, status] of [
    [() => { session = null; }, 401], [() => { session.role = 'staff_media'; }, 403],
    [() => { session = { clerkId: 'someone-else', role: 'customer' }; }, 404],
    [() => { session = { clerkId: 'deadline-owner', role: 'b2b', agencyCode: 'foreign' }; }, 404],
    [() => { hidden = true; }, 404], [() => { permitted = false; }, 429],
  ]) {
    await resetShapon(); configure(); assert.equal((await request()).status, status);
    assert.equal(savedReads.length, 0); assert.equal(patches.length, 0);
  }
  for (const role of ['customer','b2b','b2b_sub','admin','superadmin']) {
    await resetShapon(); session = { clerkId: 'deadline-owner', role, agencyCode: null };
    assert.equal((await request()).status, 200); assert.equal(savedReads.length, 1);
  }

  await makeShaponBooking(); await resetDeadlineRefresh();
  process.env.VERCEL_ENV = 'production';
  delete process.env.SHAPONTRAVELS_DEADLINE_REFRESH_ENABLED;
  const beforeRefresh = await readRow(bookingId), relatedRefresh = await relatedData();
  const refresh = await request(), refreshBody = await refresh.json();
  assert.equal(refresh.status, 200, JSON.stringify(refreshBody));
  assert.equal(refreshBody.data.updated, true);
  assert.equal(deadlineSaves[0].p_revision, 2);
  assert.equal(deadlineSaves[0].p_deadline_at, deadlineReply.body.deadlineAt);
  assert.equal((await readRow(bookingId)).supplier_ticketing_time_limit, deadlineReply.body.deadlineAt);
  assert.deepEqual(otherData(await readRow(bookingId)), otherData(beforeRefresh));
  assert.deepEqual(await relatedData(), relatedRefresh);
  assert.equal(deadlineRefreshes.length, 1); assert.equal(savedReads.length, 0); assert.equal(supplierCalls.length, 0);

  for (const [environment, flag, live] of [
    ['production', 'true', true], ['production', 'false', false],
    ['preview', undefined, false], ['preview', 'true', true],
    [undefined, undefined, false], [undefined, 'true', true],
  ]) {
    await resetDeadlineRefresh();
    if (environment !== undefined) process.env.VERCEL_ENV = environment;
    if (flag === undefined) delete process.env.SHAPONTRAVELS_DEADLINE_REFRESH_ENABLED;
    else process.env.SHAPONTRAVELS_DEADLINE_REFRESH_ENABLED = flag;
    assert.equal((await request()).status, 200);
    assert.equal(savedReads.length, live ? 0 : 1);
    assert.equal(deadlineRefreshes.length, live ? 1 : 0);
  }

  // A nonverified read can still carry a newer already-saved stream revision.
  await resetDeadlineRefresh({ outcome: 'superseded', revision: 3, deadlineAt: '2030-10-18T20:10:00+06:00' });
  const newer = await (await request()).json();
  assert.equal(newer.data.updated, true);
  assert.equal(deadlineSaves[0].p_revision, 3);
  assert.match(newer.data.message, /newer check/);
  const savedNewer = await readRow(bookingId);

  await resetDeadlineRefresh({ outcome: 'no_verified_update', revision: null, deadlineAt: null, available: false });
  const noResult = await (await request()).json();
  assert.equal(noResult.data.updated, false);
  assert.equal(noResult.data.ticketingDeadlineAt, savedNewer.ticketing_deadline_at);
  assert.equal(deadlineSaves.length, 0); assert.equal(deadlineRefreshes.length, 1);
  assert.deepEqual(await readRow(bookingId), savedNewer);

  await resetShapon('2030-10-18T21:10:00+06:00');
  assert.equal((await (await request()).json()).data.updated, false);
  assert.equal(savedReads.length, 1); assert.equal(deadlineRefreshes.length, 0);
  assert.deepEqual(await readRow(bookingId), savedNewer, 'A legacy GET cannot replace a versioned deadline');
  await resetShapon(null);
  assert.equal((await (await request(undefined, statusRoute)).json()).data.ticketingTimeUpdated, false);
  assert.deepEqual(await readRow(bookingId), savedNewer, 'A legacy status read cannot clear a versioned deadline');

  for (const [overrides, status] of [
    [{ bookingId: randomUUID() }, 502], [{ reference: 'STRFOREIGN123456' }, 502],
    [{ revision: -1 }, 502], [{ deadlineAt: '2030-02-30T19:59:00+06:00' }, 502],
    [{ deadlineAt: '2030-10-18T19:59:00Z' }, 502], [{ available: false }, 502],
  ]) {
    await resetDeadlineRefresh(overrides);
    assert.equal((await request()).status, status);
    assert.equal(deadlineRefreshes.length, 1); assert.equal(deadlineSaves.length, 0);
    assert.deepEqual(await readRow(bookingId), savedNewer);
  }
  await resetDeadlineRefresh();
  deadlineReply = { httpStatus: 429, retryAfter: '60', body: null };
  const cooldown = await request();
  assert.equal(cooldown.status, 429); assert.equal(cooldown.headers.get('Retry-After'), '60');
  assert.equal(deadlineRefreshes.length, 1); assert.equal(deadlineSaves.length, 0);
  await resetDeadlineRefresh(); permitted = false;
  const localCooldown = await request();
  assert.equal(localCooldown.status, 429); assert.equal(localCooldown.headers.get('Retry-After'), '10');
  assert.equal(deadlineRefreshes.length, 0); assert.equal(deadlineSaves.length, 0);
  await resetDeadlineRefresh(); session = { clerkId: 'another-owner', role: 'customer' };
  assert.equal((await request()).status, 404); assert.equal(deadlineRefreshes.length, 0);

  await resetDeadlineRefresh({ revision: 4, deadlineAt: '2030-10-18T20:10:60.123456789+06:00' });
  const leapSecond = await request();
  assert.equal(leapSecond.status, 200, await leapSecond.text());
  assert.equal(deadlineSaves[0].p_deadline_at, deadlineReply.body.deadlineAt);

  const denyRefresh = async () => {
    await resetDeadlineRefresh();
    delete process.env.SHAPONTRAVELS_DEADLINE_REFRESH_ENABLED;
    process.env.VERCEL_ENV = 'production';
    session = { clerkId: 'deadline-owner', role: 'customer' };
    deadlineReply = { httpStatus: 403, retryAfter: null, authorityDenied: true, body: null };
  };

  await denyRefresh();
  const beforeDenial = await readRow(bookingId), relatedBeforeDenial = await relatedData();
  const denied = await request();
  assert.equal(denied.status, 200);
  assert.deepEqual((await denied.json()).data, {
    updated: false, liveRefreshUnavailable: true, ticketingDeadlineAt: beforeDenial.ticketing_deadline_at,
    lastTicketingTime: beforeDenial.supplier_ticketing_time_limit,
    message: 'Live refresh is unavailable. Showing the saved time limit.',
  });
  assert.equal(deadlineRefreshes.length, 1);
  assert.equal(savedReads.length, 0);
  assert.equal(deadlineSaves.length, 0);
  assert.deepEqual(await readRow(bookingId), beforeDenial);
  assert.deepEqual(await relatedData(), relatedBeforeDenial);

  for (const [upstream, expected] of [[401, 502], [403, 403], [404, 404], [409, 409], [502, 502], [503, 503], [504, 504]]) {
    await denyRefresh();
    deadlineReply = { ...deadlineReply, httpStatus: upstream, authorityDenied: false };
    assert.equal((await request()).status, expected);
    assert.equal(deadlineRefreshes.length, 1);
    assert.equal(savedReads.length, 0);
    assert.equal(deadlineSaves.length, 0);
  }

  await denyRefresh();
  onSupplierRead = () => { hidden = true; };
  assert.equal((await request()).status, 404);
  assert.equal(deadlineRefreshes.length, 1);
  assert.equal(deadlineSaves.length, 0);

  await denyRefresh();
  onSupplierRead = async () => {
    const applied = await one('select public.apply_shapon_booking_deadline(null,$1,$2,null,5,null,$3) as data',
      [beforeDenial.booking_code_ref, beforeDenial.supplier_public_ref, randomUUID()]);
    assert.equal(applied.data.result, 'updated');
  };
  const cleared = await request();
  assert.equal(cleared.status, 200);
  assert.deepEqual((await cleared.json()).data, {
    updated: false, liveRefreshUnavailable: true, ticketingDeadlineAt: null, lastTicketingTime: null,
    message: 'Live refresh is unavailable. No ticketing time is saved for this booking.',
  });
  assert.equal(deadlineRefreshes.length, 1);
  assert.equal(savedReads.length, 0);
  assert.equal(deadlineSaves.length, 0);
  assert.equal((await readRow(bookingId)).ticketing_deadline_at, null);

  // Exercise the existing production RPC with only its clock replaced in PGlite.
  const { definition: rateLimitSql } = await one(
    "select pg_get_functiondef('public.consume_security_rate_limit(text,integer,bigint)'::regprocedure) as definition");
  assert.match(rateLimitSql, /clock_timestamp\(\)/);
  await db.exec(rateLimitSql.replace('clock_timestamp()', "current_setting('test.deadline_rate_now')::timestamptz"));
  const setRateTime = ms => one("select set_config('test.deadline_rate_now',$1,false)",
    [new Date(Date.parse('2030-10-18T10:00:00Z') + ms).toISOString()]);
  await denyRefresh();
  enforceSharedLiveRate = true;
  await setRateTime(0);
  assert.equal((await request()).status, 200);
  const tooSoon = await request();
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.headers.get('Retry-After'), '3');
  assert.equal(deadlineRefreshes.length, 1);

  session = { clerkId: 'deadline-admin', role: 'admin' };
  await setRateTime(2_999);
  const sharedCooldown = await request();
  assert.equal(sharedCooldown.status, 429, 'Other authorized viewers share the booking budget');
  assert.equal(sharedCooldown.headers.get('Retry-After'), '1');
  assert.equal(deadlineRefreshes.length, 1);

  for (let start = 1; start < 20; start += 1) {
    await setRateTime(start * 3_000);
    assert.equal((await request()).status, 200, 'Exactly three seconds between starts is allowed');
  }
  assert.equal(deadlineRefreshes.length, 20);
  await setRateTime(59_999);
  const rollingCeiling = await request();
  assert.equal(rollingCeiling.status, 429);
  assert.equal(rollingCeiling.headers.get('Retry-After'), '1');
  assert.equal(deadlineRefreshes.length, 20, 'A rolling minute permits at most 20 supplier dispatches');
  await setRateTime(60_000);
  assert.equal((await request()).status, 200);
  assert.equal(deadlineRefreshes.length, 21, 'The first start has aged out at exactly 60 seconds');
  assert.equal(deadlineSaves.length, 0);
  enforceSharedLiveRate = false;

  console.log('Saved API deadlines passed for every upstream supplier: scoped route, status refresh, canonical/null evidence, local authority, stale-write and financial isolation.');
  console.log('Shapon deadline refresh passed: flags, scoped saved deadline on denial, revision ordering, shared three-second and rolling-minute boundaries, Retry-After.');
  console.log('Manual PNR deadline refresh passed: full-row preservation, wallet/event isolation, local overrides, identity/date guards, stale-write rejection, scope, limits and all three suppliers.');
} finally {
  await db.close();
}
