import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { expectedCurrentSchema as expected, hash, migrationDirectory, migrationNames, publicStatusMigration,
  verifyMigrationRegistration, workdir } from './helpers/shapon-recovery-database.mjs';

// Full Kaliganj chain, disposable PostgreSQL and synthetic records only. This
// verifier reads no environment, connects to no hosted database and sends no
// supplier, email or SMS request. Installed migrations remain unchanged.
verifyMigrationRegistration();
const db = new PGlite({ extensions: { pgcrypto } });
const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
const rpc = async (sql, params = []) => (await one(sql, params)).result;
async function snapshot() {
  const result = {};
  for (const { tablename } of (await db.query(`select tablename from pg_tables
    where schemaname='public' order by tablename`)).rows) {
    const row = tablename === 'flight_bookings'
      ? "to_jsonb(t) - array['shapon_unverified_airline_pnr','shapon_passenger_ticket_refs']" : 'to_jsonb(t)';
    result[tablename] = (await one(`select md5(coalesce(jsonb_agg(${row}
      order by t::text),'[]'::jsonb)::text) as hash from public."${tablename}" t`)).hash;
  }
  return result;
}
async function triploverSchema() {
  return {
    functions: (await db.query(`select p.oid::regprocedure::text as signature,
      pg_get_functiondef(p.oid) as definition,p.proowner::text,p.proacl::text
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' and p.proname like '%triplover%'
      order by 1`)).rows,
    tables: (await db.query(`select c.relname,c.relowner::text,c.relacl::text,c.relrowsecurity,
      array_agg(a.attnum::text||':'||a.attname||':'||a.atttypid::text||':'||a.atttypmod::text order by a.attnum) as columns
      from pg_class c join pg_attribute a on a.attrelid=c.oid where c.oid in
        ('triplover_booking_status_checks'::regclass,'triplover_issued_hold_confirmations'::regclass)
      and a.attnum>0 and not a.attisdropped group by c.oid order by c.relname`)).rows,
    triggers: (await db.query(`select tgname,pg_get_triggerdef(oid) as definition
      from pg_trigger where not tgisinternal and (tgname like '%triplover%'
        or tgrelid in ('triplover_booking_status_checks'::regclass,'triplover_issued_hold_confirmations'::regclass))
      order by tgname`)).rows,
  };
}
async function viewColumns() {
  return (await db.query(`select c.relname,c.relowner::text,c.relacl::text,c.reloptions,
    array_agg(a.attnum::text||':'||a.attname||':'||a.atttypid::text||':'||a.atttypmod::text order by a.attnum) as columns
    from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
    where n.nspname='public' and c.relkind='v' and a.attnum>0 and not a.attisdropped
    group by c.oid order by c.relname`)).rows;
}
async function makeProtectedHold(kind = 'ticketing') {
  const actor = `fullchain-synthetic-${kind}-owner`;
  await db.query("insert into app_users(clerk_id,role) values($1,'customer')", [actor]);
  const account = await one("select(wallet_ensure_account('user',$1,'BDT')).*", [actor]);
  await db.query('update wallet_accounts set available_balance=1000000 where id=$1', [account.id]);
  const attempt = randomUUID(), key = `fullchain-book:${attempt}`;
  const refs = { uniqueTransId: randomUUID(), itemCodeRef: randomUUID(), priceCodeRef: randomUUID() };
  const offer = { currency: 'BDT', pricing: { sellingPrice: 500.25, grossPrice: 600,
    supplierTotalPrice: 450, serviceMarginAmount: 50.25, audience: 'b2c', agencyCode: null },
  passengerCounts: { ADT: 1 }, travelDate: '2030-01-01', directTicketing: false,
  itinerary: { carrierCode: 'BG', legs: [{ segments: [{ airlineCode: 'BG' }] }] },
  fares: [], passportRequired: false, repricedAt: '2026-09-27T00:00:00Z' };
  await db.query(`insert into booking_attempts(id,access_token_hash,user_id,audience,supplier,supplier_account,
    state,search_id,itinerary_id,unique_trans_id,item_code_ref,price_code_ref,offer_snapshot,passenger_snapshot,
    expires_at,submitted_at,operation_request_key,operation_request_payload_hash,supplier_call_started_at,
    supplier_response_received_at,supplier_operation)
    values($1,$2,$3,'b2c','shapontravels','shapontravels','submitting',$4,'fullchain-synthetic',
      $5,$6,$7,$8,'{"travellers":[{"passengerType":"ADT","firstName":"Synthetic","lastName":"Traveller"}]}',
      now()+interval '10 minutes',now(),$9,$10,now(),now(),'Book')`,
  [attempt, hash(attempt), actor, randomUUID(), refs.uniqueTransId, refs.itemCodeRef, refs.priceCodeRef,
    JSON.stringify(offer), key, hash(key)]);
  const outcome = { status: 'held', pnr: 'ABC123', airlinesPnr: ['ABC123'], bookingRefNumber: 'ABC123',
    supplierPublicRef: `STR${attempt.replaceAll('-', '').toUpperCase()}`, bookingStatus: 'Created',
    ticketingTimeLimit: null, bookingCodeRef: randomUUID(), supplierRefs: refs,
    ticketCodeRef: null, ticketNumbers: [], warnings: [] };
  const booking = await one('select(create_shapontravels_booking_from_attempt_v1($1,$2,$3,$4)).*',
    [attempt, key, hash(key), JSON.stringify(outcome)]);
  assert.match(booking.public_ref, /^KTT[0-9]{12,16}$/, 'Target booking reference remains KTT');
  const identity = { ...refs, bookingCodeRef: outcome.bookingCodeRef, bookingRefNumber: outcome.bookingRefNumber,
    pnr: outcome.pnr, supplierPublicRef: outcome.supplierPublicRef };
  if (kind === 'locator') return { booking, identity };
  const issueKey = `fullchain-${kind}:${randomUUID()}`;
  const claimFunction = kind === 'ticketing' ? 'wallet_begin_booking_issue_v2' : 'begin_booking_cancellation_v2';
  const claim = await rpc(`select ${claimFunction}($1,$2,$3,$4,$5) as result`,
    [booking.id, actor, 'customer', issueKey, hash(issueKey)]);
  assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.equal((await rpc('select mark_booking_operation_supplier_call_started($1,$2,$3) as result',
    [claim.operationId, issueKey, hash(issueKey)])).started, true);
  const facts = { failureClass: 'uncertain', automaticReplayAllowed: false };
  const uncertain = await rpc('select record_supplier_write_uncertainty_v2($1,null,$2,$3,$4,$5,$6,$7,$8,true,true,$9,$10,$11) as result',
    [booking.id, claim.operationId, actor, 'customer', issueKey, hash(issueKey), 'incomplete_response',
      kind === 'ticketing' ? 202 : 409, JSON.stringify(facts), hash(JSON.stringify(facts)), 'Synthetic incomplete supplier response']);
  assert.equal(uncertain.ok, true, JSON.stringify(uncertain));
  return { booking, account, operationId: claim.operationId, caseId: uncertain.caseId,
    identity };
}

async function verifyDeadlineRevisions(held, inProgress, cancelled) {
  const read = () => one(`select to_jsonb(b) - array['ticketing_time_limit','ticketing_deadline_at',
    'deadline_source','supplier_ticketing_time_limit','supplier_ticketing_deadline_at',
    'supplier_deadline_source','updated_at'] as protected_fields,
    b.ticketing_deadline_at,b.supplier_ticketing_deadline_at,b.updated_at::text as expected
    from flight_bookings b where id=$1`, [held.booking.id]);
  async function apply(record, { revision = null, deadline = null, eventId = null,
    expected = null, supplierBooking = record.identity.bookingCodeRef,
    supplierRef = record.identity.supplierPublicRef } = {}) {
    await db.exec('set role service_role');
    try {
      return await rpc('select apply_shapon_booking_deadline($1,$2,$3,$4,$5,$6,$7) as result',
        [eventId === null ? record.booking.id : null, supplierBooking, supplierRef,
          expected, revision, deadline, eventId]);
    } finally {
      await db.exec('reset role');
    }
  }
  const saved = '2029-06-01T08:10:11Z';
  assert.equal((await apply(held, { expected: (await read()).expected, deadline: saved })).result, 'updated');
  assert.equal((await apply(held, { expected: (await read()).expected })).lastTicketingTime, saved,
    'An unversioned null cannot clear a verified saved deadline');
  assert.equal((await apply(held, { expected: '2000-01-01T00:00:00Z', deadline: saved })).result, 'changed');

  const local = await one(`insert into superadmin_booking_deadline_overrides
    (booking_id,request_key,effective_deadline_at,actor_user_id,actor_role)
    values($1,$2,'2030-01-01T05:00:00Z','synthetic-deadline-admin','superadmin')
    returning id,effective_deadline_at`, [held.booking.id, 'synthetic-deadline-override']);
  await db.query('update flight_bookings set active_superadmin_deadline_override_id=$2 where id=$1',
    [held.booking.id, local.id]);
  const protectedFields = (await read()).protected_fields;
  const before = await snapshot();

  const newer = { revision: 3, deadline: '2029-06-30T23:59:60+06:00', eventId: randomUUID() };
  const applied = await apply(held, newer);
  assert.equal(applied.result, 'updated');
  assert.equal(applied.revision, 3);
  assert.equal(applied.lastTicketingTime, newer.deadline);
  assert.equal((await read()).supplier_ticketing_deadline_at.toISOString(), '2029-06-30T18:00:00.000Z');
  assert.equal(new Date(applied.ticketingDeadlineAt).toISOString(), local.effective_deadline_at.toISOString());
  assert.equal((await apply(held, newer)).result, 'duplicate');
  assert.equal((await apply(held, { ...newer, eventId: randomUUID(), revision: 2 })).result, 'stale');
  assert.equal((await apply(held, { expected: (await read()).expected, deadline: saved })).result, 'stale');
  assert.equal((await apply(held, { expected: (await read()).expected })).result, 'stale');
  assert.equal((await apply(held, { ...newer, eventId: randomUUID(), supplierRef: 'STRNOTMAPPED' })).result, 'missing');
  await assert.rejects(apply(held, { ...newer, eventId: randomUUID(), supplierBooking: randomUUID() }),
    error => error.code === '22023' && error.message === 'SHAPON_DEADLINE_IDENTITY_MISMATCH');
  await assert.rejects(apply(held, { ...newer, deadline: '2029-07-01T01:00:00+06:00' }),
    error => error.code === '22023' && error.message === 'SHAPON_DEADLINE_EVENT_CONFLICT');
  await assert.rejects(apply(held, { ...newer, supplierRef: 'STRNOTMAPPED' }),
    error => error.code === '22023' && error.message === 'SHAPON_DEADLINE_EVENT_CONFLICT');
  await assert.rejects(apply(held, { ...newer, eventId: randomUUID(), deadline: '2029-07-01T01:00:00+06:00' }),
    error => error.code === '22023' && error.message === 'SHAPON_DEADLINE_REVISION_CONFLICT');
  await assert.rejects(apply(held, { ...newer, eventId: randomUUID(), revision: 4, deadline: '2029-02-29T01:00:00+06:00' }),
    error => error.code === '22023' && error.message === 'SHAPON_DEADLINE_INPUT_INVALID');

  const deferred = { ...newer, eventId: randomUUID() };
  assert.equal((await apply(inProgress, deferred)).result, 'deferred');
  assert.equal((await one('select count(*)::int as n from shapon_booking_deadline_event_receipts where event_id=$1',
    [deferred.eventId])).n, 0, 'An in-flight booking can receive the event later');
  const terminal = { ...newer, eventId: randomUUID() };
  assert.equal((await apply(cancelled, terminal)).result, 'ignored');
  assert.equal((await apply(cancelled, terminal)).result, 'duplicate');

  const clear = await apply(held, { expected: (await read()).expected, revision: 4 });
  assert.equal(clear.result, 'updated');
  assert.equal(clear.lastTicketingTime, null);
  assert.equal(clear.revision, 4);
  const final = await read();
  assert.equal(final.supplier_ticketing_deadline_at, null);
  assert.equal(final.ticketing_deadline_at.toISOString(), local.effective_deadline_at.toISOString());
  assert.deepEqual(final.protected_fields, protectedFields);
  const after = await snapshot();
  for (const table of Object.keys(before)) {
    if (['flight_bookings', 'shapon_booking_deadline_versions', 'shapon_booking_deadline_event_receipts'].includes(table)) continue;
    assert.equal(after[table], before[table], `Deadline RPC preserves all ${table} rows`);
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const table of ['shapon_booking_deadline_versions', 'shapon_booking_deadline_event_receipts']) {
      assert.equal((await one("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as allowed",
        [role, table])).allowed, false, `${role} receives no direct access to ${table}`);
    }
  }
  await assert.rejects(db.query('delete from shapon_booking_deadline_event_receipts where event_id=$1', [newer.eventId]),
    error => error.code === '55000');
  await assert.rejects(db.exec('truncate table shapon_booking_deadline_event_receipts'), error => error.code === '55000');
}

try {
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;create schema extensions;create extension pgcrypto with schema extensions;`);
  const index = migrationNames.indexOf(publicStatusMigration);
  for (const file of migrationNames.slice(0, index)) {
    await db.exec(fs.readFileSync(path.join(migrationDirectory, file), 'utf8'));
  }
  const target = await makeProtectedHold();
  const legacyLocator = await makeProtectedHold('locator');
  const locatorId = legacyLocator.booking.id;
  const legacyTimestamp = (await one(`update flight_bookings set airlines_pnr='[" abc123 "]'
    where id=$1 returning updated_at`, [locatorId])).updated_at;
  const triploverBefore = await triploverSchema();
  assert.ok(triploverBefore.functions.length >= 7, 'Include the complete installed Triplover feature and earlier supplier helpers');
  const expectedViews = await viewColumns();
  const appendedViewColumns = new Map([
    ['20261109000000_shapon_platform_ticket_numbers.sql', ['shapon_passenger_ticket_refs', '3802', '-1']],
    ['20261109030000_shapon_airline_pnr_display_provenance.sql', ['shapon_unverified_airline_pnr', '25', '-1']],
  ]);
  const allocatorBefore = await one("select pg_get_functiondef('allocate_booking_ref_for(date)'::regprocedure) as definition");
  for (const file of migrationNames.slice(index)) {
    const before = await snapshot();
    await db.exec(fs.readFileSync(path.join(migrationDirectory, file), 'utf8'));
    const after = await snapshot();
    for (const [table, digest] of Object.entries(before)) {
      assert.equal(after[table], digest, `${file} preserves every existing ${table} row, including protected money/operations/events`);
    }
    assert.deepEqual(await triploverSchema(), triploverBefore, `${file} preserves Triplover functions, tables, guards and grants exactly`);
    const appended = appendedViewColumns.get(file);
    if (appended) {
      const lifecycle = expectedViews.find(view => view.relname === 'booking_lifecycle_v');
      lifecycle.columns.push([lifecycle.columns.length + 1, ...appended].join(':'));
    }
    assert.deepEqual(await viewColumns(), expectedViews, `${file} preserves existing view columns/options/ACLs`);
  }
  const catalog = await one(`select(select count(*)::int from pg_tables where schemaname='public') as tables,
    (select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f') as functions`);
  assert.deepEqual(catalog, expected);
  assert.deepEqual((await db.query("select tablename from pg_tables where schemaname='public' and not rowsecurity")).rows, []);
  assert.deepEqual(await one("select pg_get_functiondef('allocate_booking_ref_for(date)'::regprocedure) as definition"),
    allocatorBefore, 'KTT reference allocator is unchanged');
  const current = await one('select status,payment_state,captured_amount,refunded_amount from flight_bookings where id=$1', [target.booking.id]);
  assert.deepEqual(current, { status: 'in-progress', payment_state: 'reconciliation', captured_amount: 0, refunded_amount: 0 });
  const reservation = await one('select state,amount from wallet_reservations where booking_id=$1', [target.booking.id]);
  assert.deepEqual(reservation, { state: 'reconciliation', amount: 50025 });
  assert.equal((await one('select count(*)::int as n from booking_payment_returns')).n, 0);
  const locatorState = () => one(`select b.pnr,b.airlines_pnr,b.shapon_unverified_airline_pnr,b.updated_at,
    dashboard.airline_pnr from booking_lifecycle_v b join booking_dashboard_creator_v dashboard using(id)
    where b.id=$1`, [locatorId]);
  assert.deepEqual(await locatorState(), { pnr: 'ABC123', airlines_pnr: [' abc123 '],
    shapon_unverified_airline_pnr: ' abc123 ', updated_at: legacyTimestamp, airline_pnr: '' });
  const legacySmsEvent = await one(`insert into booking_status_events
    (booking_id, from_lifecycle_status, to_lifecycle_status, stored_status_before, stored_status_after, idempotency_key)
    values($1,'on-hold','confirmed','on-hold','confirmed','legacy-shapon-airline-locator-sms')
    returning id`, [locatorId]);
  assert.equal((await one(`select content_snapshot->>'pnr' as pnr from booking_issued_sms_deliveries
    where lifecycle_event_id=$1`, [legacySmsEvent.id])).pnr, 'Not available');
  const locatorTimestamp = (await one(`select to_char(updated_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as value from flight_bookings where id=$1`, [locatorId])).value;
  const observe = (offset, status, locator) => rpc(
    'select record_shapon_booking_current_status_v1($1,$2,$3,$4,$5) as result',
    [locatorId, new Date(Date.now() + offset).toISOString(), legacyLocator.identity.supplierPublicRef,
      JSON.stringify({ ...legacyLocator.identity, originalBookingStatus: 'Created',
        ...(locator ? { airlineLocatorRefresh: locator } : {}) }),
      JSON.stringify({ status, reviewRequired: false, source: 'public_receipt', verified: false,
        bookingState: null, supplierStatus: null, supplierCheckedAt: null, checkedAt: null, lastCheck: null })]);
  assert.equal((await observe(10_000, 'cancelled')).projectionUpdated, true);
  assert.equal((await observe(5_000, 'on-hold',
    { bookingUpdatedAt: locatorTimestamp, locators: ['STALE1'] })).airlinePnrsUpdated, false);
  assert.equal((await locatorState()).airline_pnr, '');
  assert.equal((await observe(15_000, 'on-hold',
    { bookingUpdatedAt: locatorTimestamp, locators: ['ABC123'] })).airlinePnrsUpdated, true);
  assert.equal((await locatorState()).shapon_unverified_airline_pnr, null);
  assert.equal((await locatorState()).airline_pnr, 'ABC123', 'A matching explicit airline locator may equal the reservation');
  const serviceRpcs = [
    'apply_shapon_booking_deadline(uuid,text,text,timestamptz,bigint,text,uuid)',
    'resolve_shapon_cancelled_refresh_v1(uuid,text,text,uuid,jsonb,jsonb,timestamptz)',
    'preview_shapon_ticket_payment_v1(uuid,text,text)',
    'preview_booking_payment_return_v1(uuid,text,text)',
    'return_booking_payment_v1(uuid,text,text,uuid,uuid,bigint,bigint,bigint,bigint,boolean,text)',
  ];
  for (const signature of serviceRpcs) {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal((await one("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).allowed,
        role === 'service_role', `${signature} remains RPC-only for the server`);
    }
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal((await one("select has_function_privilege($1,'booking_payment_return_accounting_v1(uuid)','EXECUTE') as allowed", [role])).allowed, false);
    for (const permission of ['INSERT', 'UPDATE', 'DELETE']) {
      assert.equal((await one('select has_table_privilege($1,$2,$3) as allowed',
        [role, 'booking_payment_returns', permission])).allowed, false);
    }
    assert.equal((await one("select has_table_privilege($1,'booking_payment_returns','SELECT') as allowed", [role])).allowed,
      role === 'service_role');
  }
  // Execute cancelled recovery against the FINAL chain too. The previously
  // recorded uncertain Cancel must finish once, without a new supplier claim,
  // money mutation or modification of the unrelated protected Issue.
  const cancelled = await makeProtectedHold('cancellation');
  const actor = 'fullchain-synthetic-admin';
  await db.query("insert into app_users(clerk_id,role) values($1,'admin')", [actor]);
  const request = randomUUID();
  const proof = { verified: true, cancelled: true, source: 'supplier_booking_details',
    status: 'cancelled', pendingReview: false, requiresReconciliation: false,
    pnr: cancelled.booking.pnr, ticketCount: 0,
    savedStatus: { source: 'supplier_sync', verified: true,
      supplierCheckedAt: new Date(Date.now() - 2 * 86400_000).toISOString().replace('Z', '+00:00') },
    ticketRead: { httpStatus: 404, error: 'NOT_FOUND' } };
  const beforeCancel = await snapshot();
  const cancel = async () => rpc('select resolve_shapon_cancelled_refresh_v1($1,$2,$3,$4,$5,$6,$7) as result',
    [cancelled.booking.id, actor, 'admin', request, JSON.stringify(cancelled.identity), JSON.stringify(proof), new Date().toISOString()]);
  const result = await cancel();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.walletMutation, false);
  assert.deepEqual(await one('select status,payment_state,captured_amount,refunded_amount,active_operation_id from flight_bookings where id=$1',
    [cancelled.booking.id]), { status: 'cancelled', payment_state: 'unpaid', captured_amount: 0, refunded_amount: 0, active_operation_id: null });
  assert.equal((await one('select state from booking_operations where id=$1', [cancelled.operationId])).state, 'succeeded');
  assert.equal((await one('select resolution_outcome from booking_reconciliation_cases where id=$1', [cancelled.caseId])).resolution_outcome, 'cancelled_unpaid');
  const afterCancel = await snapshot();
  for (const table of ['wallets','wallet_accounts','wallet_reservations','wallet_ledger_entries','booking_payment_returns']) {
    assert.equal(afterCancel[table], beforeCancel[table], `Final-chain cancelled recovery never changes ${table}`);
  }
  const event = await one("select * from booking_status_events where booking_id=$1 and supplier_operation='ShaponCancelledRefresh'", [cancelled.booking.id]);
  assert.equal(event.operation_id, cancelled.operationId);
  assert.equal(event.reconciliation_case_id, cancelled.caseId);
  assert.deepEqual(event.supplier_evidence.cancellationProof, proof, 'Actual no-ticket 404 and original saved time remain truthful immutable provenance');
  assert.equal((await one('select count(*)::int as n from booking_notification_outbox where lifecycle_event_id=$1', [event.id])).n, 1);
  assert.equal((await cancel()).replay, true);
  assert.deepEqual(await snapshot(), afterCancel, 'Exact cancelled recovery replay changes no state or money');
  await verifyDeadlineRevisions(legacyLocator, target, cancelled);
  // Execute the exact new read-only hosted catalog query against this same
  // synthetic schema so rollout verification cannot silently diverge.
  await db.exec('create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key);');
  for (const name of migrationNames) await db.query('insert into supabase_migrations.schema_migrations(version) values($1)', [name.split('_')[0]]);
  const verification = (await one(fs.readFileSync(path.join(workdir, 'verify-shapon-recovery.sql'), 'utf8'))).verification;
  assert.equal(verification.table_count, expected.tables);
  assert.equal(verification.public_function_count, expected.functions);
  assert.deepEqual(verification.migration_versions, migrationNames.map(name => name.split('_')[0]));
  assert.deepEqual(verification.tables_without_rls, []);
  for (const [key, result] of Object.entries(verification)) {
    if (!['table_count','public_function_count','migration_versions','tables_without_rls'].includes(key)) {
      assert.equal(result, true, `Actual read-only hosted catalog check ${key} must pass offline`);
    }
  }
  console.log(`PASS Kaliganj full Shapon recovery chain: ${migrationNames.length} migrations, ${catalog.tables} tables/${catalog.functions} functions; immutable baseline, KTT references, exact Triplover/view/ACL preservation, no existing business or protected wallet/operation/outbox changes.`);
} catch (error) {
  console.error(error.message);
  if (error.detail) console.error(error.detail);
  process.exitCode = 1;
} finally {
  await db.close();
}
