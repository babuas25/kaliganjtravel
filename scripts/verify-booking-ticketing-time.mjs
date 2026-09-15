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
let supplierCalls = [], patches = [];
const cache = new Map();
class TriploverError extends Error {
  constructor(kind, message, status) { super(message); this.kind = kind; this.status = status; }
}
const mocks = {
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
    assert.equal(name, 'refreshTicketingTime'); assert.equal(key, bookingId);
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
  '@/lib/supabase/server': { supabaseAdmin: () => ({ from: table => {
    assert.equal(table, 'flight_bookings');
    let patch, columns, filters = [];
    const builder = {
      update: value => { patch = value; patches.push(value); return builder; },
      eq: (key, value) => { filters.push([key, value]); return builder; },
      select: value => { columns = value; return builder; },
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
    return require(name);
  }, module, module.exports);
  return module.exports;
}
const route = load('app/api/flights/booking/refresh-ticketing-time/route.ts');
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
  const booking = await readRow(bookingId);
  // Deliberately conflicting business facts must never overwrite local data.
  supplierReply = { pnr: booking.pnr, uniqueTransID: booking.supplier_refs.uniqueTransId,
    status: 'Cancelled', airlinePNRs: ['OTHER9'], lastTicketTime: '02/10/2030 20:45:00',
    ticketNumbers: ['9990000000001'], passengerInfoes: [], totalPrice: 1 };
  envelopeEchoes = [booking.supplier_refs.uniqueTransId];
}
async function request(body) {
  const b = await readRow(bookingId);
  return route.POST(new Request('http://localhost/api/flights/booking/refresh-ticketing-time', {
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
  console.log('Manual PNR deadline refresh passed: full-row preservation, wallet/event isolation, local overrides, identity/date guards, stale-write rejection, scope, limits and all three suppliers.');
} finally {
  await db.close();
}
