import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { prepareFreshDatabase, artifactPath, hash } from './helpers/fresh-database.mjs';

const sql = fs.readFileSync(artifactPath, 'utf8');
const receiptPath = new URL('../supabase/fresh-install/installation.json', import.meta.url);
if (fs.existsSync(receiptPath)) {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(hash(sql), receipt.baselineSha256, 'Installed baseline must match its immutable receipt');
} else {
  assert.equal(sql, prepareFreshDatabase().sql, 'Regenerate the uninstalled fresh-install artifact');
}
const db = new PGlite({ extensions: { pgcrypto } });
try {
  await db.exec('create role anon; create role authenticated; create role service_role; create schema auth; create schema storage;');
  // No historical booking/user fixtures, .env reads, or external connections.
  await db.exec(sql);
  const tables = (await db.query(`select tablename from pg_tables where schemaname = 'public' order by tablename`)).rows;
  const nonempty = {};
  for (const { tablename } of tables) {
    const { rows } = await db.query(`select count(*)::int as n from public."${tablename.replaceAll('"', '""')}"`);
    if (rows[0].n) nonempty[tablename] = rows[0].n;
  }
  console.log('Nonempty tables after fresh install:', JSON.stringify(nonempty));
  assert.deepEqual(nonempty, {
    announcement_slider_settings: 1,
    company_settings: 1,
    flight_search_supplier_limits: 3,
    homepage_offer_settings: 1,
    homepage_travel_offers: 3,
    promotional_popup_settings: 1,
    supplier_operational_settings: 1,
  }, 'Only explicit new-installation settings/editor slots may contain rows');
  assert.equal((await db.query('select count(*)::int as n from homepage_travel_offers where is_active or image_url is not null')).rows[0].n, 0);
  assert.deepEqual((await db.query('select display_name, license_number, phone, email, address from company_settings')).rows, [{ display_name: 'Kaliganj Travels', license_number: null, phone: null, email: null, address: null }]);
  assert.deepEqual((await db.query('select active_supplier, booking_enabled, ticketing_enabled from supplier_operational_settings')).rows, [{ active_supplier: 'triplover', booking_enabled: false, ticketing_enabled: false }]);
  const unsafe = (await db.query(`select tablename from pg_tables where schemaname = 'public' and not rowsecurity`)).rows;
  assert.deepEqual(unsafe, [], 'All application tables must retain RLS');
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`select has_table_privilege($1, 'company_settings', 'SELECT') as allowed`, [role])).rows[0].allowed, false);
    assert.equal((await db.query(`select has_table_privilege($1, 'company_admin_sms_recipients', 'SELECT') as allowed`, [role])).rows[0].allowed, false);
  }
  // Refuse accidental reruns instead of dropping/replacing an existing project.
  await assert.rejects(db.exec(sql), /FRESH_INSTALL_REQUIRES_EMPTY_PUBLIC_SCHEMA/);
  await db.exec('rollback;');
  assert.equal((await db.query('select count(*)::int as n from company_settings')).rows[0].n, 1);
  // New synthetic test records below exist only in this disposable database.
  // Nothing from these tests is included in the generated installation SQL.
  await db.exec(`
    create schema if not exists extensions;
    create extension if not exists pgcrypto with schema extensions;
    insert into app_users(clerk_id, role) values ('fresh-test-owner', 'b2b');
    insert into user_profiles(clerk_id, agency_name) values ('fresh-test-owner', 'Fresh Test Agency');
    insert into agencies(agency_code, owner_user_id) values ('ST-B2B999999', 'fresh-test-owner');
  `);
  const wallet = (await db.query("insert into wallets(owner_type,owner_key) values ('agency','ST-B2B999999') returning id")).rows[0].id;
  const account = (await db.query("insert into wallet_accounts(wallet_id,currency) values ($1,'BDT') returning id", [wallet])).rows[0].id;
  const branch = (await db.query("insert into wallet_payment_branches(name) values ('Fresh Test Branch') returning id")).rows[0].id;
  const deposit = async () => (await db.query(`insert into wallet_deposit_requests
    (wallet_account_id,amount,currency,method,requested_by_user_id,branch_id,received_by_user_id)
    values ($1,10000,'BDT','cash','fresh-test-owner',$2,'fresh-test-owner') returning id`, [account, branch])).rows[0].id;
  await deposit();
  assert.equal((await db.query('select count(*)::int as n from deposit_request_admin_sms_deliveries')).rows[0].n, 0, 'No recipients means no queued admin SMS');
  await db.exec("insert into company_admin_sms_recipients(phone,enabled) values ('12025550101',true),('12025550102',false);");
  const configuredDeposit = await deposit();
  assert.deepEqual((await db.query('select recipient_number from deposit_request_admin_sms_deliveries where deposit_request_id=$1', [configuredDeposit])).rows, [{ recipient_number: '12025550101' }]);
  const claims = (await db.query('select * from claim_deposit_request_admin_sms_v1(10,$1)', [configuredDeposit])).rows;
  assert.equal(claims.length, 1, 'New configured recipient can be claimed without sending any SMS');
  assert.equal((await db.query('select available_balance::int as available, hold_balance::int as held from wallet_accounts where id=$1', [account])).rows[0].available, 0, 'Deposit request must not credit a wallet');
  await db.exec(`
    insert into booking_attempts(id,access_token_hash,audience,state,search_id,itinerary_id,
      unique_trans_id,item_code_ref,price_code_ref,offer_snapshot,expires_at,submitted_at,resolved_at,supplier_account)
    values ('10000000-0000-4000-8000-000000000001',repeat('a',64),'b2c','succeeded',gen_random_uuid(),
      'fresh-test','test-transaction','test-item','test-price','{}','2030-01-01',now(),now(),'triplover');
    insert into flight_bookings(id,access_token_hash,audience,search_id,itinerary_id,status,currency,
      pricing_snapshot,passenger_counts,travel_date,supplier_refs,repriced_at,accepted_at,expires_at,
      passengers,airlines_pnr,submission_started_at,itinerary,public_ref,attempt_id,
      ticketing_time_limit,ticketing_deadline_at,deadline_source,legacy_operational,payment_state)
    values ('10000000-0000-4000-8000-000000000001',repeat('a',64),'b2c',gen_random_uuid(),'fresh-test',
      'on-hold','BDT','{}','{}','2030-01-01','{}',now(),now(),null,'{}','[]',now(),
      '{"carrierCode":"BG"}',allocate_booking_ref(),'10000000-0000-4000-8000-000000000001',
      '2030-01-01 00:00:00','2030-01-01','pnr_call',false,'unpaid');
    insert into booking_status_events(booking_id,to_lifecycle_status,stored_status_after,idempotency_key)
    values ('10000000-0000-4000-8000-000000000001','on-hold','on-hold','fresh-test-event-1');
  `);
  const header = (await db.query(`select event_snapshot->'bookingSnapshot'->'headerContact' as contact
    from booking_notification_outbox where booking_id='10000000-0000-4000-8000-000000000001'`)).rows[0].contact;
  assert.deepEqual(header, { name: 'Kaliganj Travels', licenseNo: '--', mobile: '--', email: '--', address: '--', logoUrl: null });
  await db.exec("update company_settings set display_name='Fresh Test Company', email='test@example.invalid';");
  const oldHeader = (await db.query(`select event_snapshot->'bookingSnapshot'->'headerContact' as contact
    from booking_notification_outbox where booking_id='10000000-0000-4000-8000-000000000001'`)).rows[0].contact;
  assert.deepEqual(oldHeader, header, 'Previously captured notification identity must remain immutable');
  await db.exec(`insert into booking_status_events(booking_id,to_lifecycle_status,stored_status_after,idempotency_key)
    values ('10000000-0000-4000-8000-000000000001','on-hold','on-hold','fresh-test-event-2');`);
  const newHeader = (await db.query(`select outbox.event_snapshot->'bookingSnapshot'->'headerContact' as contact
    from booking_notification_outbox outbox join booking_status_events event on event.id=outbox.lifecycle_event_id
    where event.idempotency_key='fresh-test-event-2'`)).rows[0].contact;
  assert.equal(newHeader.name, 'Fresh Test Company');
  assert.equal(newHeader.email, 'test@example.invalid');
  // Exercise the exact forward contact migration and its notification snapshot.
  await db.exec("update company_settings set display_name='Kaliganj Travels', email=null;");
  await db.exec(fs.readFileSync('supabase/fresh-install/supabase/migrations/20260911010000_kaliganj_company_contact.sql', 'utf8'));
  assert.deepEqual((await db.query('select display_name, license_number, phone, email, address from company_settings')).rows, [{
    display_name: 'Kaliganj Travels', license_number: null,
    phone: '+880 1795-271171', email: 'support@kaliganjtravel.com',
    address: '1st Floor, Janata Super Market, Kaligonj, Jhenaidah, Bangladesh',
  }]);
  await db.exec(`insert into booking_status_events(booking_id,to_lifecycle_status,stored_status_after,idempotency_key)
    values ('10000000-0000-4000-8000-000000000001','on-hold','on-hold','fresh-test-branded-event');`);
  const brandedHeader = (await db.query(`select outbox.event_snapshot->'bookingSnapshot'->'headerContact' as contact
    from booking_notification_outbox outbox join booking_status_events event on event.id=outbox.lifecycle_event_id
    where event.idempotency_key='fresh-test-branded-event'`)).rows[0].contact;
  assert.deepEqual(brandedHeader, {
    name: 'Kaliganj Travels', licenseNo: '--', mobile: '+880 1795-271171',
    email: 'support@kaliganjtravel.com',
    address: '1st Floor, Janata Super Market, Kaligonj, Jhenaidah, Bangladesh', logoUrl: null,
  });
  assert.deepEqual((await db.query('select active_supplier, booking_enabled, ticketing_enabled from supplier_operational_settings')).rows, [{ active_supplier: 'triplover', booking_enabled: false, ticketing_enabled: false }]);
  assert.deepEqual((await db.query(`select outbox.event_snapshot->'bookingSnapshot'->'headerContact' as contact
    from booking_notification_outbox outbox join booking_status_events event on event.id=outbox.lifecycle_event_id
    where event.idempotency_key='fresh-test-event-1'`)).rows[0].contact, header);
  console.log('Forward company contact migration and new immutable snapshots passed.');
  console.log(`Fresh install passed: ${tables.length} tables; no business data; RLS retained; existing schema rejected.`);
} finally {
  await db.close();
}
