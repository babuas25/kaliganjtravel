import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migrationDirectory = 'supabase/migrations';
const platformOnlyMigration = '0042_supabase_booking_status_email_cron.sql';
const files = fs.readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();

assert.equal(
  files.at(-1),
  '0137_ticket_management_action_reference_prefix.sql'
);

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create schema auth;
  create schema storage;
`);

async function insertHistoricalBookingFixture({
  id,
  hash,
  publicReference,
  rawDeadline,
  deadline,
  submittedAt,
  carrier = 'BG',
}) {
  await db.query(`
    insert into public.booking_attempts(
      id,access_token_hash,audience,state,search_id,itinerary_id,
      unique_trans_id,item_code_ref,price_code_ref,offer_snapshot,
      expires_at,submitted_at,resolved_at
    ) values(
      $1,$2,'b2c','succeeded',gen_random_uuid(),$3,
      'fixture-transaction','fixture-item','fixture-price','{}',
      '2026-09-01',$4,$4
    )
  `, [id, hash, `fixture-${publicReference}`, submittedAt]);
  await db.query(`
    insert into public.flight_bookings(
      id,access_token_hash,audience,search_id,itinerary_id,status,currency,
      pricing_snapshot,passenger_counts,travel_date,supplier_refs,repriced_at,
      accepted_at,expires_at,passengers,airlines_pnr,submission_started_at,
      itinerary,public_ref,attempt_id,ticketing_time_limit,
      ticketing_deadline_at,deadline_source,legacy_operational,payment_state
    ) values(
      $1,$2,'b2c',gen_random_uuid(),$3,'on-hold','BDT',
      '{"grossPrice":5749,"supplierTotalPrice":5295.85,"sellingPrice":5294.66}',
      '{}','2026-09-01','{}','2026-08-01','2026-08-01',null,
      '{}','["FIXTURE-PNR"]',$4,$5,$6,$1,$7,$8,'pnr_call',false,'unpaid'
    )
  `, [
    id,
    hash,
    `fixture-${publicReference}`,
    submittedAt,
    JSON.stringify({ carrierCode: carrier }),
    publicReference,
    rawDeadline,
    deadline,
  ]);
}

async function prepareHistoricalMigrationFixtures(file) {
  if (file === '0034_fix_pnr_dd_mm_deadline_and_hold_email.sql') {
    await insertHistoricalBookingFixture({
      id: '34000000-0000-4000-8000-000000000001',
      hash: 'a'.repeat(64),
      publicReference: 'STR260807000001',
      rawDeadline: '2026-08-07 18:32:00',
      deadline: '2026-08-07T12:32:00Z',
      submittedAt: '2026-08-07T10:00:00Z',
    });
    await db.exec(`
      insert into public.booking_status_events(
        booking_id,to_lifecycle_status,stored_status_after,idempotency_key
      ) values(
        '34000000-0000-4000-8000-000000000001','on-hold','on-hold',
        'migration-0034-pnr-dd-mm-STR260807000001'
      )
    `);
  }

  if (file === '0036_correct_ambiguous_pnr_deadline_by_booking_time.sql') {
    await insertHistoricalBookingFixture({
      id: '36000000-0000-4000-8000-000000000004',
      hash: 'b'.repeat(64),
      publicReference: 'STR260807000004',
      rawDeadline: '2026-08-07 09:14:00',
      deadline: '2026-08-07T03:14:00Z',
      submittedAt: '2026-08-07T01:14:16.006Z',
    });
    await db.exec(`
      insert into public.booking_status_events(
        booking_id,to_lifecycle_status,stored_status_after,idempotency_key
      ) values(
        '36000000-0000-4000-8000-000000000004','on-hold','on-hold',
        'migration-0036-ambiguous-pnr-STR260807000004'
      )
    `);
  }

  if (file === '0039_fix_us_bangla_pnr_month_day_deadlines.sql') {
    const references = [
      'STR260808000002', 'STR260808000003', 'STR260809000001',
      'STR260809000003', 'STR260809000004', 'STR260810000004',
      'STR260810000005', 'STR260810000006', 'STR260810000007',
    ];
    for (const [index, publicReference] of references.entries()) {
      await insertHistoricalBookingFixture({
        id: `39000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        hash: String(index + 1).repeat(64).slice(0, 64),
        publicReference,
        rawDeadline: '08/09/2026 18:00:00',
        deadline: '2026-08-09T12:00:00Z',
        submittedAt: '2026-08-08T00:00:00Z',
        carrier: 'BS',
      });
    }
  }
}

let applied = 0;
for (const file of files) {
  await prepareHistoricalMigrationFixtures(file);
  if (file === platformOnlyMigration) {
    const sql = fs.readFileSync(path.join(migrationDirectory, file), 'utf8');
    assert.match(sql, /create extension if not exists pg_cron/);
    assert.match(sql, /create extension if not exists pg_net/);
    assert.match(sql, /vault\.secrets/);
    assert.match(sql, /cron\.schedule/);
    continue;
  }
  await db.exec(fs.readFileSync(path.join(migrationDirectory, file), 'utf8'));
  applied += 1;
}

assert.equal(applied, files.length - 1);
const ticketTables = await db.query(`
  select table_name
    from information_schema.tables
   where table_schema = 'public'
     and table_name like 'ticket_management_%'
`);
assert.equal(ticketTables.rows.length >= 12, true);
const settlementFunctions = await db.query(`
  select proname
    from pg_proc
   where proname in (
     'complete_ticket_management_refund_v1',
     'complete_ticket_management_reissue_v1',
     'complete_ticket_management_void_v1'
   )
`);
assert.equal(settlementFunctions.rows.length, 3);

const auditWallet = await db.query(`
  insert into public.wallets(owner_type, owner_key)
  values ('user', 'commercial-basis-fixture')
  returning id
`);
const auditAccount = await db.query(`
  insert into public.wallet_accounts(wallet_id, currency)
  values ($1, 'BDT')
  returning id
`, [auditWallet.rows[0].id]);
const auditRequest = await db.query(`
  insert into public.ticket_management_requests(
    booking_id, action, request_key, request_payload_hash,
    requested_by_user_id, requested_by_role,
    booking_owner_type, booking_owner_key, charged_wallet_account_id,
    currency, captured_amount_snapshot, refunded_amount_snapshot
  ) values (
    '34000000-0000-4000-8000-000000000001', 'refund',
    'migration-rehearsal:commercial-basis', repeat('b', 64),
    'commercial-basis-fixture', 'customer', 'user',
    'commercial-basis-fixture', $1, 'BDT', 529466, 0
  ) returning id
`, [auditAccount.rows[0].id]);
const commercialBasis = await db.query(`
  select public.ticket_management_booking_commercial_basis_v1($1) as result
`, [auditRequest.rows[0].id]);
assert.deepEqual(commercialBasis.rows[0].result, {
  ok: true,
  currency: 'BDT',
  supplierGrossAmount: 574900,
  supplierPayableAmount: 529585,
});

const quotePrivileges = await db.query(`
  select
    has_function_privilege(
      'service_role',
      'public.publish_ticket_management_quote_v1(uuid,text,integer,text,text,text,bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,timestamptz,text)',
      'EXECUTE'
    ) as legacy_quote,
    has_function_privilege(
      'service_role',
      'public.publish_ticket_management_quote_v2(uuid,text,integer,text,text,text,bigint,bigint,bigint,bigint,bigint,bigint,timestamptz,text)',
      'EXECUTE'
    ) as booking_derived_quote,
    has_function_privilege(
      'service_role',
      'public.ticket_management_booking_commercial_basis_v1(uuid)',
      'EXECUTE'
    ) as commercial_basis
`);
assert.equal(quotePrivileges.rows[0].legacy_quote, false);
assert.equal(quotePrivileges.rows[0].booking_derived_quote, true);
assert.equal(quotePrivileges.rows[0].commercial_basis, false);

const settlementPrivileges = await db.query(`
  select
    has_function_privilege(
      'service_role',
      'public.complete_ticket_management_refund_v1(uuid,text,integer,text,text)',
      'EXECUTE'
    ) as legacy_refund,
    has_function_privilege(
      'service_role',
      'public.complete_ticket_management_refund_v2(uuid,text,integer,text,text)',
      'EXECUTE'
    ) as direct_refund,
    has_function_privilege(
      'service_role',
      'public.ticket_management_prepare_direct_settlement_v1(uuid,text,integer,text)',
      'EXECUTE'
    ) as settlement_helper
`);
assert.equal(settlementPrivileges.rows[0].legacy_refund, false);
assert.equal(settlementPrivileges.rows[0].direct_refund, true);
assert.equal(settlementPrivileges.rows[0].settlement_helper, false);

await db.exec(`
  insert into public.app_users(clerk_id, email, role)
  values
    ('commercial-basis-fixture', 'customer@example.test', 'customer'),
    ('ticket-ops-fixture', 'ops@example.test', 'staff_support');
  insert into public.ticket_management_request_events(
    request_id, occurrence_number, event_type, from_status, to_status,
    request_version, actor_user_id, actor_role, idempotency_key
  ) values (
    '${auditRequest.rows[0].id}', 1, 'requested', null, 'requested',
    1, 'commercial-basis-fixture', 'customer', 'migration-rehearsal:email'
  );
`);
const notificationClaims = await db.query(`
  select * from public.claim_ticket_management_notification_outbox_v1(10, $1)
`, [auditRequest.rows[0].id]);
assert.equal(notificationClaims.rows.length, 2);
assert.deepEqual(
  notificationClaims.rows.map((row) => row.audience).sort(),
  ['customer', 'internal']
);
for (const claim of notificationClaims.rows) {
  const expansion = await db.query(
    `select public.expand_ticket_management_notification_recipients_v1($1, $2) as count`,
    [claim.outbox_id, claim.claim_token]
  );
  assert.equal(expansion.rows[0].count, 1);
  const deliveries = await db.query(`
    select * from public.claim_ticket_management_notification_deliveries_v1($1, $2, 10)
  `, [claim.outbox_id, claim.claim_token]);
  assert.equal(deliveries.rows.length, 1);
  const delivery = deliveries.rows[0];
  const content = await db.query(`
    select public.store_ticket_management_notification_render_v1($1, $2, $3::jsonb) as content
  `, [
    delivery.delivery_id,
    delivery.delivery_claim_token,
    JSON.stringify({ version: 1, subject: 'Fixture', html: '<p>Fixture</p>', text: 'Fixture' }),
  ]);
  assert.equal(content.rows[0].content.subject, 'Fixture');
  const sent = await db.query(`
    select public.mark_ticket_management_notification_delivery_sent_v1($1, $2, $3) as sent
  `, [delivery.delivery_id, delivery.delivery_claim_token, '<fixture@example.test>']);
  assert.equal(sent.rows[0].sent, true);
  const finalized = await db.query(`
    select public.finalize_ticket_management_notification_outbox_v1($1, $2) as state
  `, [claim.outbox_id, claim.claim_token]);
  assert.equal(finalized.rows[0].state, 'processed');
}

await db.close();
console.log(
  `Executed ${applied}/${files.length} migrations in disposable PostgreSQL; ` +
  `${platformOnlyMigration} was statically verified because it requires Supabase pg_cron/pg_net/Vault.`
);
