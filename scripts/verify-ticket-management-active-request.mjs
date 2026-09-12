import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create table public.app_users (
    clerk_id text primary key,
    role text not null,
    agency_code text
  );
  create table public.wallet_accounts (id uuid primary key);
  create table public.flight_bookings (
    id uuid primary key,
    status text not null,
    lifecycle_status text,
    legacy_operational boolean not null default false,
    issued_at timestamptz,
    charged_wallet_account_id uuid references public.wallet_accounts(id),
    booking_owner_type text,
    booking_owner_key text,
    user_payable_amount bigint,
    captured_amount bigint not null default 0,
    refunded_amount bigint not null default 0,
    payment_state text not null default 'unpaid',
    currency text not null default 'BDT',
    passengers jsonb,
    ticket_numbers jsonb,
    fares jsonb,
    itinerary jsonb,
    import_source text
  );
  create or replace function public.touch_updated_at()
  returns trigger language plpgsql as $$
  begin new.updated_at := clock_timestamp(); return new; end
  $$;
`);

for (const migration of [
  'supabase/migrations/0119_ticket_management_core.sql',
  'supabase/migrations/0120_ticket_management_lifecycle_assignment.sql',
  'supabase/migrations/0121_ticket_management_entitlements.sql',
  'supabase/migrations/0128_ticket_management_single_passenger_entitlement.sql',
  'supabase/migrations/0134_ticket_management_request_type.sql',
  'supabase/migrations/0143_ticket_management_single_active_action_request.sql',
  'supabase/migrations/0144_ticket_management_staff_rejection_until_approval.sql',
  'supabase/migrations/0145_ticket_management_route_selection.sql',
]) {
  await db.exec(fs.readFileSync(migration, 'utf8'));
}

const accountId = '22222222-2222-4222-8222-222222222222';
await db.query('insert into public.wallet_accounts(id) values ($1)', [accountId]);
await db.exec(`
  insert into public.app_users(clerk_id, role) values
    ('customer-1', 'customer'), ('admin-1', 'admin');
`);

async function rpc(name, params) {
  const keys = Object.keys(params);
  const placeholders = keys.map((key, index) => `${key} => $${index + 1}`).join(', ');
  const result = await db.query(
    `select public.${name}(${placeholders}) as result`,
    keys.map((key) => params[key]),
  );
  return result.rows[0].result;
}

async function create({ bookingId, action, key, hash, routeIndexes = [0] }) {
  return rpc('create_ticket_management_request_v4', {
    p_booking_id: bookingId,
    p_action: action,
    p_actor_user_id: 'customer-1',
    p_request_key: key,
    p_request_payload_hash: hash.repeat(64),
    p_passenger_indexes: [0],
    p_route_indexes: routeIndexes,
    p_request_type: 'voluntary',
    p_note: null,
  });
}

for (const [offset, action] of ['refund', 'reissue', 'void'].entries()) {
  const suffix = String(offset + 1).padStart(12, '0');
  const bookingId = `11111111-1111-4111-8111-${suffix}`;
  await db.query(`
    insert into public.flight_bookings (
      id, status, lifecycle_status, issued_at, charged_wallet_account_id,
      booking_owner_type, booking_owner_key, user_payable_amount,
      captured_amount, refunded_amount, payment_state, currency, passengers,
      ticket_numbers, fares, itinerary
    ) values (
      $1, 'confirmed', 'confirmed', clock_timestamp(), $2,
      'user', 'customer-1', 25000, 25000, 0, 'captured', 'BDT',
      '{"travellers":[{"passengerType":"ADT","title":"Mr","firstName":"Test","lastName":"User"}]}'::jsonb,
      '["TICKET-1"]'::jsonb,
      '[{"passengerType":"ADT","count":1,"totalPrice":250}]'::jsonb,
      '{"legs":[{"from":"DAC","to":"CGP","departure":"2026-09-30T12:00:00+06:00"},{"from":"CGP","to":"DAC","departure":"2026-10-05T16:00:00+06:00"}]}'::jsonb
    )
  `, [bookingId, accountId]);

  const first = await create({
    bookingId,
    action,
    key: `${action}:first`,
    hash: 'a',
    routeIndexes: [0, 1],
  });
  assert.equal(first.ok, true, `${action}: first request must be created`);
  assert.equal(first.selectedRouteCount, 2, `${action}: both selected routes must be saved`);
  const selectedRoutes = (await db.query(
    'select route_index, origin_code, destination_code from public.ticket_management_request_routes where request_id = $1 order by route_index',
    [first.requestId],
  )).rows;
  assert.deepEqual(selectedRoutes.map((route) => route.route_index), [0, 1]);

  const replay = await create({
    bookingId,
    action,
    key: `${action}:first`,
    hash: 'a',
    routeIndexes: [0, 1],
  });
  assert.equal(replay.ok, true, `${action}: exact retry must remain successful`);
  assert.equal(replay.replay, true, `${action}: exact retry must be a replay`);

  const blocked = await create({
    bookingId,
    action,
    key: `${action}:second`,
    hash: 'b',
  });
  assert.equal(blocked.ok, false, `${action}: a second open request must be blocked`);
  assert.equal(blocked.code, 'ACTIVE_REQUEST_EXISTS');
  assert.equal(blocked.requestId, first.requestId);

  await db.query(`
    update public.ticket_management_requests
       set status = 'rejected', terminal_outcome = 'staff-rejected',
           rejected_at = clock_timestamp(), status_changed_at = clock_timestamp()
     where id = $1
  `, [first.requestId]);

  const afterRejection = await create({
    bookingId,
    action,
    key: `${action}:second`,
    hash: 'b',
  });
  assert.equal(afterRejection.ok, true, `${action}: rejection must unlock a new request`);

  await db.query(`
    update public.ticket_management_requests
       set status = 'expired', terminal_outcome = 'confirmation-expired',
           expired_at = clock_timestamp(), status_changed_at = clock_timestamp()
     where id = $1
  `, [afterRejection.requestId]);

  const afterExpiry = await create({
    bookingId,
    action,
    key: `${action}:third`,
    hash: 'c',
  });
  assert.equal(afterExpiry.ok, true, `${action}: expiry must unlock a new request`);

  const accepted = await rpc('review_ticket_management_request_v1', {
    p_request_id: afterExpiry.requestId,
    p_decision: 'accept',
    p_actor_user_id: 'admin-1',
    p_expected_version: afterExpiry.version,
    p_request_key: `${action}:accept`,
    p_note: null,
  });
  assert.equal(accepted.status, 'in-progress');
  const rejectedInProgress = await rpc('review_ticket_management_request_v1', {
    p_request_id: afterExpiry.requestId,
    p_decision: 'reject',
    p_actor_user_id: 'admin-1',
    p_expected_version: accepted.version,
    p_request_key: `${action}:reject-in-progress`,
    p_note: 'Supplier cannot process this request',
  });
  assert.equal(rejectedInProgress.status, 'rejected');

  const awaiting = await create({
    bookingId,
    action,
    key: `${action}:awaiting`,
    hash: 'd',
  });
  assert.equal(awaiting.ok, true);
  await db.query(`
    update public.ticket_management_requests
       set status = 'awaiting-confirmation', version = version + 1
     where id = $1
  `, [awaiting.requestId]);
  const awaitingRow = (await db.query(
    'select version from public.ticket_management_requests where id = $1',
    [awaiting.requestId],
  )).rows[0];
  const rejectedAwaiting = await rpc('review_ticket_management_request_v1', {
    p_request_id: awaiting.requestId,
    p_decision: 'reject',
    p_actor_user_id: 'admin-1',
    p_expected_version: awaitingRow.version,
    p_request_key: `${action}:reject-awaiting`,
    p_note: null,
  });
  assert.equal(rejectedAwaiting.status, 'rejected');

  const approved = await create({
    bookingId,
    action,
    key: `${action}:approved`,
    hash: 'e',
  });
  assert.equal(approved.ok, true);
  await db.query(`
    update public.ticket_management_requests
       set status = 'approved', approved_at = clock_timestamp(), version = version + 1
     where id = $1
  `, [approved.requestId]);
  const approvedRow = (await db.query(
    'select version from public.ticket_management_requests where id = $1',
    [approved.requestId],
  )).rows[0];
  const rejectedAfterApproval = await rpc('review_ticket_management_request_v1', {
    p_request_id: approved.requestId,
    p_decision: 'reject',
    p_actor_user_id: 'admin-1',
    p_expected_version: approvedRow.version,
    p_request_key: `${action}:reject-approved`,
    p_note: null,
  });
  assert.equal(rejectedAfterApproval.ok, false);
  assert.equal(rejectedAfterApproval.code, 'REQUEST_NOT_REJECTABLE');
}

console.log('Ticket Management active-request and pre-approval staff-rejection rules verified for Refund, Reissue, and VOID.');
