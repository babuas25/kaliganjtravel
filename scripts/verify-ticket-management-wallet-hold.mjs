import assert from 'node:assert/strict';
import fs from 'node:fs';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table public.app_users (clerk_id text primary key, role text not null, agency_code text);
  create table public.wallets (
    id uuid primary key, owner_type text not null, owner_key text not null,
    status text not null default 'active'
  );
  create table public.wallet_accounts (
    id uuid primary key, wallet_id uuid not null references public.wallets(id),
    currency text not null, available_balance bigint not null default 0 check (available_balance >= 0),
    hold_balance bigint not null default 0 check (hold_balance >= 0),
    updated_at timestamptz not null default clock_timestamp()
  );
  create table public.booking_attempts (id uuid primary key);
  create table public.flight_bookings (
    id uuid primary key, status text not null, lifecycle_status text,
    legacy_operational boolean not null default false, issued_at timestamptz,
    charged_wallet_account_id uuid references public.wallet_accounts(id),
    booking_owner_type text, booking_owner_key text,
    user_payable_amount bigint,
    captured_amount bigint not null default 0,
    refunded_amount bigint not null default 0 check (refunded_amount <= captured_amount),
    payment_state text not null default 'unpaid', currency text not null default 'BDT',
    passengers jsonb, ticket_numbers jsonb, fares jsonb, import_source text
  );
  create table public.wallet_reservations (
    id uuid primary key default gen_random_uuid(),
    wallet_account_id uuid not null references public.wallet_accounts(id),
    booking_id uuid references public.flight_bookings(id),
    booking_attempt_id uuid references public.booking_attempts(id),
    amount bigint not null check (amount > 0), currency text not null,
    state text not null default 'active' check (state in ('active','captured','released','reconciliation')),
    cycle integer not null default 1, requested_by_user_id text not null,
    issued_by_user_id text, supplier_call_started_at timestamptz,
    captured_at timestamptz, released_at timestamptz, reconciliation_at timestamptz,
    reconciliation_reason text, release_reason text,
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    check ((booking_id is not null)::integer + (booking_attempt_id is not null)::integer = 1)
  );
  create unique index wallet_reservations_booking_key on public.wallet_reservations(booking_id)
    where booking_id is not null;
  create unique index wallet_reservations_attempt_key on public.wallet_reservations(booking_attempt_id)
    where booking_attempt_id is not null;
  create table public.wallet_ledger_entries (
    id uuid primary key default gen_random_uuid(),
    wallet_account_id uuid not null references public.wallet_accounts(id),
    transaction_type text not null,
    amount bigint not null check (amount > 0), currency text not null,
    available_before bigint not null check (available_before >= 0),
    available_after bigint not null check (available_after >= 0),
    hold_before bigint not null check (hold_before >= 0),
    hold_after bigint not null check (hold_after >= 0),
    booking_id uuid references public.flight_bookings(id), booking_reference text,
    reservation_id uuid references public.wallet_reservations(id),
    related_entry_id uuid references public.wallet_ledger_entries(id),
    idempotency_key text not null unique, created_by_user_id text not null,
    created_by_role text not null, remarks text, metadata jsonb not null default '{}',
    created_at timestamptz not null default clock_timestamp(),
    constraint wallet_ledger_entries_transaction_type_check check (transaction_type in (
      'deposit','booking_hold','booking_confirm','hold_release','refund','manual_credit',
      'manual_debit','adjustment','reversal','superadmin_resolution_credit',
      'superadmin_resolution_debit','superadmin_resolution_hold_release',
      'superadmin_resolution_hold_capture'
    ))
  );
  create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at := clock_timestamp(); return new; end $$;
  create or replace function public.prevent_wallet_ledger_mutation() returns trigger language plpgsql as $$
  begin raise exception 'wallet ledger entries are immutable'; end $$;
  create trigger wallet_ledger_immutable before update or delete on public.wallet_ledger_entries
    for each row execute function public.prevent_wallet_ledger_mutation();
`);
for (const migration of [
  'supabase/migrations/0119_ticket_management_core.sql',
  'supabase/migrations/0120_ticket_management_lifecycle_assignment.sql',
  'supabase/migrations/0121_ticket_management_entitlements.sql',
  'supabase/migrations/0122_ticket_management_wallet_substrate.sql',
  'supabase/migrations/0123_ticket_management_refund_settlement.sql',
  'supabase/migrations/0124_ticket_management_reissue_settlement.sql',
  'supabase/migrations/0125_ticket_management_void_settlement.sql',
  'supabase/migrations/0126_ticket_management_notification_outbox.sql',
  'supabase/migrations/0128_ticket_management_single_passenger_entitlement.sql',
  'supabase/migrations/0129_ticket_management_manual_single_passenger_entitlement.sql',
  'supabase/migrations/0131_ticket_management_direct_admin_settlement.sql',
]) await db.exec(fs.readFileSync(migration, 'utf8'));

const ids = {
  wallet: '11111111-1111-4111-8111-111111111111',
  account: '22222222-2222-4222-8222-222222222222',
  booking: '33333333-3333-4333-8333-333333333333',
};
await db.query(`insert into public.wallets(id,owner_type,owner_key) values($1,'user','customer-1')`, [ids.wallet]);
await db.query(`insert into public.wallet_accounts(id,wallet_id,currency,available_balance) values($1,$2,'BDT',500)`, [ids.account, ids.wallet]);
await db.exec(`insert into public.app_users(clerk_id,role) values
  ('customer-1','customer'),('support-1','staff_support'),
  ('accounts-1','staff_account'),('admin-1','admin')`);
await db.query(`
  insert into public.flight_bookings(
    id,status,lifecycle_status,issued_at,charged_wallet_account_id,
    booking_owner_type,booking_owner_key,captured_amount,refunded_amount,
    user_payable_amount,payment_state,currency,passengers,ticket_numbers,fares
  ) values($1,'confirmed','confirmed',clock_timestamp(),$2,'user','customer-1',
    10000,0,10000,'captured','BDT',
    '{"travellers":[{"passengerType":"ADT","title":"Mr","firstName":"Hold","lastName":"Test"}]}',
    '["T-HOLD"]','[{"passengerType":"ADT","count":1,"totalPrice":100}]')
`, [ids.booking, ids.account]);
await db.query(`insert into public.wallet_reservations(
  wallet_account_id,booking_id,amount,currency,state,requested_by_user_id,captured_at
) values($1,$2,10000,'BDT','captured','customer-1',clock_timestamp())`, [ids.account, ids.booking]);

async function rpc(name, params) {
  const keys = Object.keys(params);
  const args = keys.map((key, index) => `${key} => $${index + 1}`).join(',');
  return (await db.query(`select public.${name}(${args}) result`, keys.map((key) => params[key]))).rows[0].result;
}
const request = await rpc('create_ticket_management_request_v2', {
  p_booking_id: ids.booking, p_action: 'reissue', p_actor_user_id: 'customer-1',
  p_request_key: 'hold:request', p_request_payload_hash: 'a'.repeat(64),
  p_passenger_indexes: [0], p_note: null,
});
const accepted = await rpc('review_ticket_management_request_v1', {
  p_request_id: request.requestId, p_decision: 'accept', p_actor_user_id: 'support-1',
  p_expected_version: request.version, p_request_key: 'hold:review', p_note: null,
});
const predecessorEntitlementId = (await db.query(`
  select entitlement_id from public.ticket_management_request_selections
   where request_id=$1
`, [request.requestId])).rows[0].entitlement_id;
const quote = await rpc('publish_ticket_management_reissue_quote_v1', {
  p_request_id: request.requestId, p_actor_user_id: 'support-1',
  p_expected_version: accepted.version, p_request_key: 'hold:quote',
  p_direction: 'debit', p_currency: 'BDT', p_supplier_gross_amount: 11000,
  p_supplier_payable_amount: 10000,
  p_fare_difference: 500, p_airline_fee: 250,
  p_service_fee: 250, p_customer_amount: 1000,
  p_confirmation_deadline_at: new Date(Date.now() + 60000).toISOString(), p_details: null,
  p_fare_difference_allocations: [{
    entitlementId: predecessorEntitlementId, fareDifferenceAmount: 500,
  }],
});
const insufficient = await rpc('decide_ticket_management_quote_v2', {
  p_request_id: request.requestId, p_quote_id: quote.quoteId, p_decision: 'approved',
  p_actor_user_id: 'customer-1', p_expected_version: quote.version,
  p_request_key: 'hold:decision', p_note: null,
});
assert.equal(insufficient.code, 'INSUFFICIENT_AVAILABLE_BALANCE');
let account = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [ids.account])).rows[0];
assert.deepEqual(account, { available_balance: 500, hold_balance: 0 });
assert.equal((await db.query(`select count(*)::int count from public.wallet_reservations where ticket_management_request_id=$1`, [request.requestId])).rows[0].count, 0);

await db.query(`update public.wallet_accounts set available_balance=1500 where id=$1`, [ids.account]);
const approved = await rpc('decide_ticket_management_quote_v2', {
  p_request_id: request.requestId, p_quote_id: quote.quoteId, p_decision: 'approved',
  p_actor_user_id: 'customer-1', p_expected_version: quote.version,
  p_request_key: 'hold:decision', p_note: null,
});
assert.equal(approved.status, 'approved');
account = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [ids.account])).rows[0];
assert.deepEqual(account, { available_balance: 500, hold_balance: 1000 });
const requestReservation = (await db.query(`select state,amount,booking_id from public.wallet_reservations where id=$1`, [approved.reservationId])).rows[0];
assert.deepEqual(requestReservation, { state: 'active', amount: 1000, booking_id: null });
const originalReservation = (await db.query(`select state,amount from public.wallet_reservations where booking_id=$1`, [ids.booking])).rows[0];
assert.deepEqual(originalReservation, { state: 'captured', amount: 10000 });
const ledger = (await db.query(`select transaction_type,amount,ticket_management_request_id,ticket_management_quote_id from public.wallet_ledger_entries where id=$1`, [approved.ledgerEntryId])).rows[0];
assert.deepEqual(ledger, {
  transaction_type: 'ticket_management_hold', amount: 1000,
  ticket_management_request_id: request.requestId,
  ticket_management_quote_id: quote.quoteId,
});
const replay = await rpc('decide_ticket_management_quote_v2', {
  p_request_id: request.requestId, p_quote_id: quote.quoteId, p_decision: 'approved',
  p_actor_user_id: 'customer-1', p_expected_version: quote.version,
  p_request_key: 'hold:decision', p_note: null,
});
assert.equal(replay.replay, true);
account = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [ids.account])).rows[0];
assert.deepEqual(account, { available_balance: 500, hold_balance: 1000 });

const supportCapture = await rpc('ticket_management_capture_hold_v1', {
  p_request_id: request.requestId, p_actor_user_id: 'support-1',
  p_request_key: 'hold:capture:forbidden',
});
assert.equal(supportCapture.code, 'FINAL_SETTLEMENT_FORBIDDEN');
const assigned = await rpc('assign_ticket_management_settlement_v1', {
  p_request_id: request.requestId, p_assignee_user_id: 'accounts-1',
  p_actor_user_id: 'support-1', p_expected_version: approved.version,
  p_request_key: 'hold:assign', p_reason: null,
});
const forbiddenReissue = await rpc('complete_ticket_management_reissue_v1', {
  p_request_id: request.requestId, p_actor_user_id: 'support-1',
  p_expected_version: assigned.version, p_request_key: 'hold:complete:forbidden',
  p_new_tickets: [{
    predecessorEntitlementId,
    newTicketNumber: 'T-HOLD-NEW',
    fareDifferenceAmount: 500,
  }],
  p_note: null,
});
assert.equal(forbiddenReissue.code, 'FINAL_SETTLEMENT_FORBIDDEN');
const allocationMismatch = await rpc('complete_ticket_management_reissue_v1', {
  p_request_id: request.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: assigned.version, p_request_key: 'hold:complete:mismatch',
  p_new_tickets: [{
    predecessorEntitlementId,
    newTicketNumber: 'T-HOLD-NEW',
    fareDifferenceAmount: 499,
  }],
  p_note: null,
});
assert.equal(allocationMismatch.code, 'APPROVED_REISSUE_QUOTE_INVALID');
account = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [ids.account])).rows[0];
assert.deepEqual(account, { available_balance: 500, hold_balance: 1000 });
const completedReissue = await rpc('complete_ticket_management_reissue_v1', {
  p_request_id: request.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: assigned.version, p_request_key: 'hold:complete',
  p_new_tickets: [{
    predecessorEntitlementId,
    newTicketNumber: 'T-HOLD-NEW',
    fareDifferenceAmount: 500,
  }],
  p_note: 'Manual GDS Reissue completed',
});
assert.equal(completedReissue.status, 'completed');
assert.equal(completedReissue.capturedAmount, 1000);
assert.equal(completedReissue.futureEntitlementIncrease, 500);
account = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [ids.account])).rows[0];
assert.deepEqual(account, { available_balance: 500, hold_balance: 0 });
const capturedReservation = (await db.query(`select state from public.wallet_reservations where id=$1`, [approved.reservationId])).rows[0];
assert.equal(capturedReservation.state, 'captured');
const reissueFacts = (await db.query(`
  select booking.ticket_numbers, booking.captured_amount,
         predecessor.entitlement_amount predecessor_amount,
         predecessor.consumed_amount predecessor_consumed, predecessor.state predecessor_state,
         successor.entitlement_amount successor_amount,
         successor.consumed_amount successor_consumed, successor.state successor_state,
         successor.original_ticket_number, successor.active_ticket_number,
         lineage.fare_difference_amount, completion.airline_fee_amount,
         completion.service_fee_amount, completion.customer_amount_captured
    from public.flight_bookings booking
    join public.ticket_management_reissue_completions completion
      on completion.request_id=$2
    join public.ticket_management_reissue_lineages lineage
      on lineage.completion_id=completion.id
    join public.ticket_management_ticket_entitlements predecessor
      on predecessor.id=lineage.predecessor_entitlement_id
    join public.ticket_management_ticket_entitlements successor
      on successor.id=lineage.successor_entitlement_id
   where booking.id=$1
`, [ids.booking, request.requestId])).rows[0];
assert.deepEqual(reissueFacts, {
  ticket_numbers: ['T-HOLD-NEW'],
  captured_amount: 11000,
  predecessor_amount: 10000,
  predecessor_consumed: 10000,
  predecessor_state: 'reissued',
  successor_amount: 10500,
  successor_consumed: 0,
  successor_state: 'active',
  original_ticket_number: 'T-HOLD',
  active_ticket_number: 'T-HOLD-NEW',
  fare_difference_amount: 500,
  airline_fee_amount: 250,
  service_fee_amount: 250,
  customer_amount_captured: 1000,
});
const completionReplay = await rpc('complete_ticket_management_reissue_v1', {
  p_request_id: request.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: assigned.version, p_request_key: 'hold:complete',
  p_new_tickets: [{
    predecessorEntitlementId,
    newTicketNumber: 'T-HOLD-NEW',
    fareDifferenceAmount: 500,
  }],
  p_note: 'Manual GDS Reissue completed',
});
assert.equal(completionReplay.replay, true);
assert.equal(assigned.assigneeRole, 'staff_account');
const successorRequest = await rpc('create_ticket_management_request_v2', {
  p_booking_id: ids.booking, p_action: 'refund', p_actor_user_id: 'customer-1',
  p_request_key: 'successor:request', p_request_payload_hash: 'd'.repeat(64),
  p_passenger_indexes: [0], p_note: null,
});
const successorSelection = (await db.query(`
  select ticket_number_snapshot, entitlement_amount_snapshot
    from public.ticket_management_request_selections where request_id=$1
`, [successorRequest.requestId])).rows[0];
assert.deepEqual(successorSelection, {
  ticket_number_snapshot: 'T-HOLD-NEW', entitlement_amount_snapshot: 10500,
});

const releaseBooking = '44444444-4444-4444-8444-444444444444';
await db.query(`
  insert into public.flight_bookings(
    id,status,lifecycle_status,issued_at,charged_wallet_account_id,
    booking_owner_type,booking_owner_key,captured_amount,refunded_amount,
    payment_state,currency,passengers,ticket_numbers,fares
  ) values($1,'confirmed','confirmed',clock_timestamp(),$2,'user','customer-1',
    8000,0,'captured','BDT',
    '{"travellers":[{"passengerType":"ADT","title":"Ms","firstName":"Release","lastName":"Test"}]}',
    '["T-RELEASE"]','[{"passengerType":"ADT","count":1,"totalPrice":80}]')
`, [releaseBooking, ids.account]);
await db.query(`insert into public.wallet_reservations(
  wallet_account_id,booking_id,amount,currency,state,requested_by_user_id,captured_at
) values($1,$2,8000,'BDT','captured','customer-1',clock_timestamp())`, [ids.account, releaseBooking]);
const releaseRequest = await rpc('create_ticket_management_request_v2', {
  p_booking_id: releaseBooking, p_action: 'reissue', p_actor_user_id: 'customer-1',
  p_request_key: 'release:request', p_request_payload_hash: 'b'.repeat(64),
  p_passenger_indexes: [0], p_note: null,
});
const releaseAccepted = await rpc('review_ticket_management_request_v1', {
  p_request_id: releaseRequest.requestId, p_decision: 'accept', p_actor_user_id: 'support-1',
  p_expected_version: releaseRequest.version, p_request_key: 'release:review', p_note: null,
});
const releaseEntitlementId = (await db.query(`
  select entitlement_id from public.ticket_management_request_selections
   where request_id=$1
`, [releaseRequest.requestId])).rows[0].entitlement_id;
const releaseQuote = await rpc('publish_ticket_management_reissue_quote_v1', {
  p_request_id: releaseRequest.requestId, p_actor_user_id: 'support-1',
  p_expected_version: releaseAccepted.version, p_request_key: 'release:quote',
  p_direction: 'debit', p_currency: 'BDT', p_supplier_gross_amount: 9000,
  p_supplier_payable_amount: 8500,
  p_fare_difference: 200, p_airline_fee: 100,
  p_service_fee: 100, p_customer_amount: 400,
  p_confirmation_deadline_at: new Date(Date.now() + 60000).toISOString(), p_details: null,
  p_fare_difference_allocations: [{
    entitlementId: releaseEntitlementId, fareDifferenceAmount: 200,
  }],
});
const releaseApproved = await rpc('decide_ticket_management_quote_v2', {
  p_request_id: releaseRequest.requestId, p_quote_id: releaseQuote.quoteId,
  p_decision: 'approved', p_actor_user_id: 'customer-1',
  p_expected_version: releaseQuote.version, p_request_key: 'release:decision', p_note: null,
});
const releaseAssigned = await rpc('assign_ticket_management_settlement_v1', {
  p_request_id: releaseRequest.requestId, p_assignee_user_id: 'accounts-1',
  p_actor_user_id: 'support-1', p_expected_version: releaseApproved.version,
  p_request_key: 'release:assign', p_reason: null,
});
const forbiddenRelease = await rpc('release_and_reopen_ticket_management_reissue_v1', {
  p_request_id: releaseRequest.requestId, p_actor_user_id: 'support-1',
  p_expected_version: releaseAssigned.version, p_request_key: 'release:forbidden',
  p_reason: 'Manual Reissue was not performed',
});
assert.equal(forbiddenRelease.code, 'FINAL_SETTLEMENT_FORBIDDEN');
const releasedHold = await rpc('release_and_reopen_ticket_management_reissue_v1', {
  p_request_id: releaseRequest.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: releaseAssigned.version, p_request_key: 'release:wallet',
  p_reason: 'Manual Reissue was not performed',
});
assert.equal(releasedHold.ok, true);
assert.equal(releasedHold.status, 'in-progress');
account = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [ids.account])).rows[0];
assert.deepEqual(account, { available_balance: 500, hold_balance: 0 });
const releasedRequestState = (await db.query(`
  select status,active_quote_id,approved_quote_id,active_assignee_user_id,
         active_wallet_reservation_id from public.ticket_management_requests where id=$1
`, [releaseRequest.requestId])).rows[0];
assert.deepEqual(releasedRequestState, {
  status: 'in-progress', active_quote_id: null, approved_quote_id: null,
  active_assignee_user_id: null, active_wallet_reservation_id: null,
});
const releaseReplay = await rpc('release_and_reopen_ticket_management_reissue_v1', {
  p_request_id: releaseRequest.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: releaseAssigned.version, p_request_key: 'release:wallet',
  p_reason: 'Manual Reissue was not performed',
});
assert.equal(releaseReplay.replay, true);

const replacementQuote = await rpc('publish_ticket_management_reissue_quote_v1', {
  p_request_id: releaseRequest.requestId, p_actor_user_id: 'support-1',
  p_expected_version: releasedHold.version, p_request_key: 'release:quote:replacement',
  p_direction: 'debit', p_currency: 'BDT', p_supplier_gross_amount: 9100,
  p_supplier_payable_amount: 8600,
  p_fare_difference: 250, p_airline_fee: 100,
  p_service_fee: 150, p_customer_amount: 500,
  p_confirmation_deadline_at: new Date(Date.now() + 60000).toISOString(), p_details: null,
  p_fare_difference_allocations: [{
    entitlementId: releaseEntitlementId, fareDifferenceAmount: 250,
  }],
});
const replacementApproved = await rpc('decide_ticket_management_quote_v2', {
  p_request_id: releaseRequest.requestId, p_quote_id: replacementQuote.quoteId,
  p_decision: 'approved', p_actor_user_id: 'customer-1',
  p_expected_version: replacementQuote.version,
  p_request_key: 'release:decision:replacement', p_note: null,
});
assert.equal(replacementApproved.status, 'approved');
account = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [ids.account])).rows[0];
assert.deepEqual(account, { available_balance: 0, hold_balance: 500 });
const replacementAssigned = await rpc('assign_ticket_management_settlement_v1', {
  p_request_id: releaseRequest.requestId, p_assignee_user_id: 'accounts-1',
  p_actor_user_id: 'support-1', p_expected_version: replacementApproved.version,
  p_request_key: 'release:assign:replacement', p_reason: null,
});
await rpc('release_and_reopen_ticket_management_reissue_v1', {
  p_request_id: releaseRequest.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: replacementAssigned.version,
  p_request_key: 'release:wallet:replacement',
  p_reason: 'Replacement manual Reissue was not performed',
});
account = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [ids.account])).rows[0];
assert.deepEqual(account, { available_balance: 500, hold_balance: 0 });

const refundBooking = '55555555-5555-4555-8555-555555555555';
await db.query(`
  insert into public.flight_bookings(
    id,status,lifecycle_status,issued_at,charged_wallet_account_id,
    booking_owner_type,booking_owner_key,captured_amount,refunded_amount,
    payment_state,currency,passengers,ticket_numbers,fares
  ) values($1,'confirmed','confirmed',clock_timestamp(),$2,'user','customer-1',
    9500,0,'captured','BDT',
    '{"travellers":[{"passengerType":"ADT","title":"Mr","firstName":"Refund","lastName":"Test"}]}',
    '["T-REFUND"]','[{"passengerType":"ADT","count":1,"totalPrice":95}]')
`, [refundBooking, ids.account]);
await db.query(`insert into public.wallet_reservations(
  wallet_account_id,booking_id,amount,currency,state,requested_by_user_id,captured_at
) values($1,$2,9500,'BDT','captured','customer-1',clock_timestamp())`, [ids.account, refundBooking]);
const refundRequest = await rpc('create_ticket_management_request_v2', {
  p_booking_id: refundBooking, p_action: 'refund', p_actor_user_id: 'customer-1',
  p_request_key: 'refund:request', p_request_payload_hash: 'c'.repeat(64),
  p_passenger_indexes: [0], p_note: null,
});
const refundAccepted = await rpc('review_ticket_management_request_v1', {
  p_request_id: refundRequest.requestId, p_decision: 'accept', p_actor_user_id: 'support-1',
  p_expected_version: refundRequest.version, p_request_key: 'refund:review', p_note: null,
});
const refundQuote = await rpc('publish_ticket_management_quote_v1', {
  p_request_id: refundRequest.requestId, p_actor_user_id: 'support-1',
  p_expected_version: refundAccepted.version, p_request_key: 'refund:quote',
  p_direction: 'credit', p_currency: 'BDT', p_supplier_gross_amount: 10000,
  p_supplier_payable_amount: 9000, p_user_payable_entitlement_amount: 9500,
  p_fare_difference: 0, p_airline_fee: 2000,
  p_void_fee: 0, p_service_fee: 500, p_customer_amount: 7000,
  p_confirmation_deadline_at: new Date(Date.now() + 60000).toISOString(), p_details: null,
});
const refundApproved = await rpc('decide_ticket_management_quote_v2', {
  p_request_id: refundRequest.requestId, p_quote_id: refundQuote.quoteId,
  p_decision: 'approved', p_actor_user_id: 'customer-1',
  p_expected_version: refundQuote.version, p_request_key: 'refund:decision', p_note: null,
});
const refundAssigned = await rpc('assign_ticket_management_settlement_v1', {
  p_request_id: refundRequest.requestId, p_assignee_user_id: 'accounts-1',
  p_actor_user_id: 'support-1', p_expected_version: refundApproved.version,
  p_request_key: 'refund:assign', p_reason: null,
});
await db.exec(`update public.app_users set role='staff_support' where clerk_id='accounts-1'`);
const revokedRoleRefund = await rpc('complete_ticket_management_refund_v1', {
  p_request_id: refundRequest.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: refundAssigned.version, p_request_key: 'refund:revoked-role', p_note: null,
});
assert.equal(revokedRoleRefund.code, 'FINAL_SETTLEMENT_FORBIDDEN');
await db.exec(`update public.app_users set role='staff_account' where clerk_id='accounts-1'`);
const refundAssignedToAdmin = await rpc('assign_ticket_management_settlement_v1', {
  p_request_id: refundRequest.requestId, p_assignee_user_id: 'admin-1',
  p_actor_user_id: 'support-1', p_expected_version: refundAssigned.version,
  p_request_key: 'refund:reassign:admin', p_reason: 'Assignment race regression',
});
const staleAssigneeRefund = await rpc('complete_ticket_management_refund_v1', {
  p_request_id: refundRequest.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: refundAssignedToAdmin.version,
  p_request_key: 'refund:stale-assignee', p_note: null,
});
assert.equal(staleAssigneeRefund.code, 'REFUND_SETTLEMENT_NOT_AUTHORIZED');
const refundReassigned = await rpc('assign_ticket_management_settlement_v1', {
  p_request_id: refundRequest.requestId, p_assignee_user_id: 'accounts-1',
  p_actor_user_id: 'support-1', p_expected_version: refundAssignedToAdmin.version,
  p_request_key: 'refund:reassign:accounts', p_reason: null,
});
const forbiddenRefund = await rpc('complete_ticket_management_refund_v1', {
  p_request_id: refundRequest.requestId, p_actor_user_id: 'support-1',
  p_expected_version: refundReassigned.version, p_request_key: 'refund:forbidden', p_note: null,
});
assert.equal(forbiddenRefund.code, 'FINAL_SETTLEMENT_FORBIDDEN');
await db.exec(`
  create or replace function public.fail_ticket_management_refund_ledger_fixture()
  returns trigger language plpgsql as $$
  begin
    if new.idempotency_key = 'refund:atomic:refund' then
      raise exception 'injected ledger failure';
    end if;
    return new;
  end $$;
  create trigger ticket_management_refund_ledger_failure_fixture
    before insert on public.wallet_ledger_entries
    for each row execute function public.fail_ticket_management_refund_ledger_fixture();
`);
await assert.rejects(
  rpc('complete_ticket_management_refund_v1', {
    p_request_id: refundRequest.requestId, p_actor_user_id: 'accounts-1',
    p_expected_version: refundReassigned.version,
    p_request_key: 'refund:atomic', p_note: null,
  }),
  /injected ledger failure/
);
account = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [ids.account])).rows[0];
assert.deepEqual(account, { available_balance: 500, hold_balance: 0 });
const rolledBackRefund = (await db.query(`
  select request.status,entitlement.state,entitlement.consumed_amount
    from public.ticket_management_requests request
    join public.ticket_management_request_selections selection on selection.request_id=request.id
    join public.ticket_management_ticket_entitlements entitlement on entitlement.id=selection.entitlement_id
   where request.id=$1
`, [refundRequest.requestId])).rows[0];
assert.deepEqual(rolledBackRefund, {
  status: 'approved', state: 'active', consumed_amount: 0,
});
await db.exec(`drop trigger ticket_management_refund_ledger_failure_fixture on public.wallet_ledger_entries`);
const completedRefund = await rpc('complete_ticket_management_refund_v1', {
  p_request_id: refundRequest.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: refundReassigned.version, p_request_key: 'refund:atomic', p_note: null,
});
assert.equal(completedRefund.status, 'completed');
assert.equal(completedRefund.creditedAmount, 7000);
account = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [ids.account])).rows[0];
assert.deepEqual(account, { available_balance: 7500, hold_balance: 0 });
const refundFacts = (await db.query(`
  select booking.refunded_amount, booking.payment_state,
         entitlement.entitlement_amount, entitlement.consumed_amount, entitlement.state
    from public.flight_bookings booking
    join public.ticket_management_ticket_entitlements entitlement
      on entitlement.booking_id = booking.id
   where booking.id = $1
`, [refundBooking])).rows[0];
assert.deepEqual(refundFacts, {
  refunded_amount: 7000, payment_state: 'partially-refunded',
  entitlement_amount: 9500, consumed_amount: 9500, state: 'refunded',
});
const refundAudit = (await db.query(`
  select quote.supplier_gross_amount, quote.supplier_payable_amount,
         quote.user_payable_entitlement_amount, quote.airline_fee,
         quote.service_fee, quote.customer_amount, ledger.metadata
    from public.ticket_management_quotes quote
    join public.wallet_ledger_entries ledger
      on ledger.ticket_management_quote_id = quote.id
     and ledger.transaction_type = 'refund'
   where quote.id = $1
`, [refundQuote.quoteId])).rows[0];
assert.deepEqual(refundAudit, {
  supplier_gross_amount: 10000,
  supplier_payable_amount: 9000,
  user_payable_entitlement_amount: 9500,
  airline_fee: 2000,
  service_fee: 500,
  customer_amount: 7000,
  metadata: {
    quoteHash: refundQuote.quoteHash,
    supplierGrossAmount: 10000,
    supplierPayableAmount: 9000,
    userPayableEntitlementConsumed: 9500,
    netCustomerCredit: 7000,
  },
});
const refundReplay = await rpc('complete_ticket_management_refund_v1', {
  p_request_id: refundRequest.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: refundReassigned.version, p_request_key: 'refund:atomic', p_note: null,
});
assert.equal(refundReplay.replay, true);
account = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [ids.account])).rows[0];
assert.deepEqual(account, { available_balance: 7500, hold_balance: 0 });

const successorAccepted = await rpc('review_ticket_management_request_v1', {
  p_request_id: successorRequest.requestId, p_decision: 'accept',
  p_actor_user_id: 'support-1', p_expected_version: successorRequest.version,
  p_request_key: 'successor:review', p_note: null,
});
const successorQuote = await rpc('publish_ticket_management_quote_v1', {
  p_request_id: successorRequest.requestId, p_actor_user_id: 'support-1',
  p_expected_version: successorAccepted.version, p_request_key: 'successor:quote',
  p_direction: 'credit', p_currency: 'BDT', p_supplier_gross_amount: 11500,
  p_supplier_payable_amount: 10800, p_user_payable_entitlement_amount: 10500,
  p_fare_difference: 0, p_airline_fee: 500,
  p_void_fee: 0, p_service_fee: 0, p_customer_amount: 10000,
  p_confirmation_deadline_at: new Date(Date.now() + 60000).toISOString(), p_details: null,
});
const successorApproved = await rpc('decide_ticket_management_quote_v2', {
  p_request_id: successorRequest.requestId, p_quote_id: successorQuote.quoteId,
  p_decision: 'approved', p_actor_user_id: 'customer-1',
  p_expected_version: successorQuote.version,
  p_request_key: 'successor:decision', p_note: null,
});
const successorAssigned = await rpc('assign_ticket_management_settlement_v1', {
  p_request_id: successorRequest.requestId, p_assignee_user_id: 'accounts-1',
  p_actor_user_id: 'support-1', p_expected_version: successorApproved.version,
  p_request_key: 'successor:assign', p_reason: null,
});
const successorRefund = await rpc('complete_ticket_management_refund_v1', {
  p_request_id: successorRequest.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: successorAssigned.version,
  p_request_key: 'successor:complete', p_note: null,
});
assert.equal(successorRefund.creditedAmount, 10000);
const successorBookingFacts = (await db.query(`
  select captured_amount,refunded_amount,payment_state
    from public.flight_bookings where id=$1
`, [ids.booking])).rows[0];
assert.deepEqual(successorBookingFacts, {
  captured_amount: 11000, refunded_amount: 10000,
  payment_state: 'partially-refunded',
});

const voidWallet = '66666666-6666-4666-8666-666666666666';
const voidAccount = '77777777-7777-4777-8777-777777777777';
const voidCreditBooking = '88888888-8888-4888-8888-888888888888';
await db.exec(`insert into public.app_users(clerk_id,role) values ('customer-void','customer')`);
await db.query(`insert into public.wallets(id,owner_type,owner_key) values($1,'user','customer-void')`, [voidWallet]);
await db.query(`insert into public.wallet_accounts(id,wallet_id,currency,available_balance) values($1,$2,'BDT',1000)`, [voidAccount, voidWallet]);
await db.query(`
  insert into public.flight_bookings(
    id,status,lifecycle_status,issued_at,charged_wallet_account_id,
    booking_owner_type,booking_owner_key,captured_amount,refunded_amount,
    payment_state,currency,passengers,ticket_numbers,fares
  ) values($1,'confirmed','confirmed',clock_timestamp(),$2,'user','customer-void',
    10000,0,'captured','BDT',
    '{"travellers":[{"passengerType":"ADT","title":"Ms","firstName":"Void","lastName":"Credit"}]}',
    '["T-VOID-CREDIT"]','[{"passengerType":"ADT","count":1,"totalPrice":100}]')
`, [voidCreditBooking, voidAccount]);
await db.query(`insert into public.wallet_reservations(
  wallet_account_id,booking_id,amount,currency,state,requested_by_user_id,captured_at
) values($1,$2,10000,'BDT','captured','customer-void',clock_timestamp())`, [voidAccount, voidCreditBooking]);
const voidCreditRequest = await rpc('create_ticket_management_request_v2', {
  p_booking_id: voidCreditBooking, p_action: 'void', p_actor_user_id: 'customer-void',
  p_request_key: 'void-credit:request', p_request_payload_hash: 'e'.repeat(64),
  p_passenger_indexes: [0], p_note: null,
});
const voidCreditAccepted = await rpc('review_ticket_management_request_v1', {
  p_request_id: voidCreditRequest.requestId, p_decision: 'accept',
  p_actor_user_id: 'support-1', p_expected_version: voidCreditRequest.version,
  p_request_key: 'void-credit:review', p_note: null,
});
const voidCreditQuote = await rpc('publish_ticket_management_quote_v1', {
  p_request_id: voidCreditRequest.requestId, p_actor_user_id: 'support-1',
  p_expected_version: voidCreditAccepted.version, p_request_key: 'void-credit:quote',
  p_direction: 'credit', p_currency: 'BDT', p_supplier_gross_amount: 11000,
  p_supplier_payable_amount: 9500, p_user_payable_entitlement_amount: 10000,
  p_fare_difference: 0, p_airline_fee: 0,
  p_void_fee: 2000, p_service_fee: 500, p_customer_amount: 7500,
  p_confirmation_deadline_at: new Date(Date.now() + 60000).toISOString(), p_details: null,
});
const voidCreditApproved = await rpc('decide_ticket_management_quote_v2', {
  p_request_id: voidCreditRequest.requestId, p_quote_id: voidCreditQuote.quoteId,
  p_decision: 'approved', p_actor_user_id: 'customer-void',
  p_expected_version: voidCreditQuote.version,
  p_request_key: 'void-credit:decision', p_note: null,
});
let voidBalance = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [voidAccount])).rows[0];
assert.deepEqual(voidBalance, { available_balance: 1000, hold_balance: 0 });
const forbiddenVoidCredit = await rpc('complete_ticket_management_void_v2', {
  p_request_id: voidCreditRequest.requestId, p_actor_user_id: 'support-1',
  p_expected_version: voidCreditApproved.version,
  p_request_key: 'void-credit:forbidden', p_note: null,
});
assert.equal(forbiddenVoidCredit.code, 'FINAL_SETTLEMENT_FORBIDDEN');
const completedVoidCredit = await rpc('complete_ticket_management_void_v2', {
  p_request_id: voidCreditRequest.requestId, p_actor_user_id: 'admin-1',
  p_expected_version: voidCreditApproved.version,
  p_request_key: 'void-credit:complete', p_note: 'Manual airline VOID completed',
});
assert.equal(completedVoidCredit.direction, 'credit');
assert.equal(completedVoidCredit.customerAmount, 7500);
voidBalance = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [voidAccount])).rows[0];
assert.deepEqual(voidBalance, { available_balance: 8500, hold_balance: 0 });
const voidCreditFacts = (await db.query(`
  select booking.captured_amount,booking.refunded_amount,booking.payment_state,
         entitlement.state,entitlement.entitlement_amount,entitlement.consumed_amount,
         completion.direction,completion.user_payable_entitlement_amount,
         completion.airline_void_fee_amount,completion.service_fee_amount,
         completion.customer_amount,ledger.transaction_type,ledger.wallet_account_id
    from public.flight_bookings booking
    join public.ticket_management_ticket_entitlements entitlement
      on entitlement.booking_id=booking.id
    join public.ticket_management_void_completions completion
      on completion.request_id=$2
    join public.wallet_ledger_entries ledger
      on ledger.id=completion.credit_ledger_entry_id
   where booking.id=$1
`, [voidCreditBooking, voidCreditRequest.requestId])).rows[0];
assert.deepEqual(voidCreditFacts, {
  captured_amount: 10000, refunded_amount: 7500,
  payment_state: 'partially-refunded', state: 'voided',
  entitlement_amount: 10000, consumed_amount: 10000,
  direction: 'credit', user_payable_entitlement_amount: 10000,
  airline_void_fee_amount: 2000, service_fee_amount: 500,
  customer_amount: 7500, transaction_type: 'ticket_management_void_credit',
  wallet_account_id: voidAccount,
});
const directAdminAssignment = (await db.query(`
  select active_assignee_user_id, active_assignee_role
    from public.ticket_management_requests where id=$1
`, [voidCreditRequest.requestId])).rows[0];
assert.deepEqual(directAdminAssignment, {
  active_assignee_user_id: 'admin-1', active_assignee_role: 'admin',
});
const voidCreditReplay = await rpc('complete_ticket_management_void_v2', {
  p_request_id: voidCreditRequest.requestId, p_actor_user_id: 'admin-1',
  p_expected_version: voidCreditApproved.version,
  p_request_key: 'void-credit:complete', p_note: 'Manual airline VOID completed',
});
assert.equal(voidCreditReplay.replay, true);
await assert.rejects(
  rpc('create_ticket_management_request_v2', {
    p_booking_id: voidCreditBooking, p_action: 'refund',
    p_actor_user_id: 'customer-void', p_request_key: 'void-credit:duplicate-refund',
    p_request_payload_hash: 'f'.repeat(64), p_passenger_indexes: [0], p_note: null,
  }),
  /selected passenger entitlement is unavailable/
);

const voidDebitBooking = '99999999-9999-4999-8999-999999999999';
await db.query(`
  insert into public.flight_bookings(
    id,status,lifecycle_status,issued_at,charged_wallet_account_id,
    booking_owner_type,booking_owner_key,captured_amount,refunded_amount,
    payment_state,currency,passengers,ticket_numbers,fares
  ) values($1,'confirmed','confirmed',clock_timestamp(),$2,'user','customer-void',
    5000,0,'captured','BDT',
    '{"travellers":[{"passengerType":"ADT","title":"Mr","firstName":"Void","lastName":"Debit"}]}',
    '["T-VOID-DEBIT"]','[{"passengerType":"ADT","count":1,"totalPrice":50}]')
`, [voidDebitBooking, voidAccount]);
await db.query(`insert into public.wallet_reservations(
  wallet_account_id,booking_id,amount,currency,state,requested_by_user_id,captured_at
) values($1,$2,5000,'BDT','captured','customer-void',clock_timestamp())`, [voidAccount, voidDebitBooking]);
const voidDebitRequest = await rpc('create_ticket_management_request_v2', {
  p_booking_id: voidDebitBooking, p_action: 'void', p_actor_user_id: 'customer-void',
  p_request_key: 'void-debit:request', p_request_payload_hash: '1'.repeat(64),
  p_passenger_indexes: [0], p_note: null,
});
const voidDebitAccepted = await rpc('review_ticket_management_request_v1', {
  p_request_id: voidDebitRequest.requestId, p_decision: 'accept',
  p_actor_user_id: 'support-1', p_expected_version: voidDebitRequest.version,
  p_request_key: 'void-debit:review', p_note: null,
});
const publishVoidDebitQuote = (expectedVersion, key) => rpc('publish_ticket_management_quote_v1', {
  p_request_id: voidDebitRequest.requestId, p_actor_user_id: 'support-1',
  p_expected_version: expectedVersion, p_request_key: key,
  p_direction: 'debit', p_currency: 'BDT', p_supplier_gross_amount: 6000,
  p_supplier_payable_amount: 5500, p_user_payable_entitlement_amount: 5000,
  p_fare_difference: 0, p_airline_fee: 0,
  p_void_fee: 5200, p_service_fee: 300, p_customer_amount: 500,
  p_confirmation_deadline_at: new Date(Date.now() + 60000).toISOString(), p_details: null,
});
const voidDebitQuote = await publishVoidDebitQuote(voidDebitAccepted.version, 'void-debit:quote');
const voidDebitApproved = await rpc('decide_ticket_management_quote_v2', {
  p_request_id: voidDebitRequest.requestId, p_quote_id: voidDebitQuote.quoteId,
  p_decision: 'approved', p_actor_user_id: 'customer-void',
  p_expected_version: voidDebitQuote.version,
  p_request_key: 'void-debit:decision', p_note: null,
});
voidBalance = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [voidAccount])).rows[0];
assert.deepEqual(voidBalance, { available_balance: 8000, hold_balance: 500 });
const voidDebitAssigned = await rpc('assign_ticket_management_settlement_v1', {
  p_request_id: voidDebitRequest.requestId, p_assignee_user_id: 'accounts-1',
  p_actor_user_id: 'support-1', p_expected_version: voidDebitApproved.version,
  p_request_key: 'void-debit:assign', p_reason: null,
});
const forbiddenVoidRelease = await rpc('release_and_reopen_ticket_management_void_v1', {
  p_request_id: voidDebitRequest.requestId, p_actor_user_id: 'support-1',
  p_expected_version: voidDebitAssigned.version,
  p_request_key: 'void-debit:release:forbidden',
  p_reason: 'Manual VOID was not performed',
});
assert.equal(forbiddenVoidRelease.code, 'FINAL_SETTLEMENT_FORBIDDEN');
const voidDebitReleased = await rpc('release_and_reopen_ticket_management_void_v1', {
  p_request_id: voidDebitRequest.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: voidDebitAssigned.version,
  p_request_key: 'void-debit:release', p_reason: 'Manual VOID was not performed',
});
assert.equal(voidDebitReleased.status, 'in-progress');
const voidDebitReleaseReplay = await rpc('release_and_reopen_ticket_management_void_v1', {
  p_request_id: voidDebitRequest.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: voidDebitAssigned.version,
  p_request_key: 'void-debit:release', p_reason: 'Manual VOID was not performed',
});
assert.equal(voidDebitReleaseReplay.replay, true);
voidBalance = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [voidAccount])).rows[0];
assert.deepEqual(voidBalance, { available_balance: 8500, hold_balance: 0 });
const replacementVoidDebitQuote = await publishVoidDebitQuote(
  voidDebitReleased.version, 'void-debit:quote:replacement'
);
const replacementVoidDebitApproved = await rpc('decide_ticket_management_quote_v2', {
  p_request_id: voidDebitRequest.requestId, p_quote_id: replacementVoidDebitQuote.quoteId,
  p_decision: 'approved', p_actor_user_id: 'customer-void',
  p_expected_version: replacementVoidDebitQuote.version,
  p_request_key: 'void-debit:decision:replacement', p_note: null,
});
const replacementVoidDebitAssigned = await rpc('assign_ticket_management_settlement_v1', {
  p_request_id: voidDebitRequest.requestId, p_assignee_user_id: 'accounts-1',
  p_actor_user_id: 'support-1', p_expected_version: replacementVoidDebitApproved.version,
  p_request_key: 'void-debit:assign:replacement', p_reason: null,
});
const [captureRace, releaseRace] = await Promise.all([
  rpc('complete_ticket_management_void_v1', {
    p_request_id: voidDebitRequest.requestId, p_actor_user_id: 'accounts-1',
    p_expected_version: replacementVoidDebitAssigned.version,
    p_request_key: 'void-debit:capture-release-race:capture', p_note: null,
  }),
  rpc('release_and_reopen_ticket_management_void_v1', {
    p_request_id: voidDebitRequest.requestId, p_actor_user_id: 'accounts-1',
    p_expected_version: replacementVoidDebitAssigned.version,
    p_request_key: 'void-debit:capture-release-race:release',
    p_reason: 'Capture/release race regression',
  }),
]);
assert.notEqual(
  Boolean(captureRace.ok),
  Boolean(releaseRace.ok),
  'exactly one Capture/Release contender must win'
);
let completedVoidDebit = captureRace;
let completedVoidExpectedVersion = replacementVoidDebitAssigned.version;
let completedVoidRequestKey = 'void-debit:capture-release-race:capture';
if (!captureRace.ok) {
  assert.equal(releaseRace.status, 'in-progress');
  const raceReplacementQuote = await publishVoidDebitQuote(
    releaseRace.version,
    'void-debit:quote:after-race-release'
  );
  const raceReplacementApproved = await rpc('decide_ticket_management_quote_v2', {
    p_request_id: voidDebitRequest.requestId,
    p_quote_id: raceReplacementQuote.quoteId,
    p_decision: 'approved', p_actor_user_id: 'customer-void',
    p_expected_version: raceReplacementQuote.version,
    p_request_key: 'void-debit:decision:after-race-release', p_note: null,
  });
  const raceReplacementAssigned = await rpc('assign_ticket_management_settlement_v1', {
    p_request_id: voidDebitRequest.requestId, p_assignee_user_id: 'accounts-1',
    p_actor_user_id: 'support-1', p_expected_version: raceReplacementApproved.version,
    p_request_key: 'void-debit:assign:after-race-release', p_reason: null,
  });
  completedVoidExpectedVersion = raceReplacementAssigned.version;
  completedVoidRequestKey = 'void-debit:complete:after-race-release';
  completedVoidDebit = await rpc('complete_ticket_management_void_v1', {
    p_request_id: voidDebitRequest.requestId, p_actor_user_id: 'accounts-1',
    p_expected_version: completedVoidExpectedVersion,
    p_request_key: completedVoidRequestKey, p_note: null,
  });
}
assert.equal(completedVoidDebit.direction, 'debit');
assert.equal(completedVoidDebit.customerAmount, 500);
voidBalance = (await db.query(`select available_balance,hold_balance from public.wallet_accounts where id=$1`, [voidAccount])).rows[0];
assert.deepEqual(voidBalance, { available_balance: 8000, hold_balance: 0 });
const voidDebitFacts = (await db.query(`
  select booking.captured_amount,booking.refunded_amount,
         entitlement.state,entitlement.consumed_amount,
         completion.direction,completion.customer_amount,
         reservation.state reservation_state,ledger.transaction_type
    from public.flight_bookings booking
    join public.ticket_management_ticket_entitlements entitlement
      on entitlement.booking_id=booking.id
    join public.ticket_management_void_completions completion
      on completion.request_id=$2
    join public.wallet_ledger_entries ledger
      on ledger.id=completion.capture_ledger_entry_id
    join public.wallet_reservations reservation
      on reservation.id=ledger.reservation_id
   where booking.id=$1
`, [voidDebitBooking, voidDebitRequest.requestId])).rows[0];
assert.deepEqual(voidDebitFacts, {
  captured_amount: 5500, refunded_amount: 0,
  state: 'voided', consumed_amount: 5000,
  direction: 'debit', customer_amount: 500,
  reservation_state: 'captured', transaction_type: 'ticket_management_capture',
});
const voidDebitReplay = await rpc('complete_ticket_management_void_v1', {
  p_request_id: voidDebitRequest.requestId, p_actor_user_id: 'accounts-1',
  p_expected_version: completedVoidExpectedVersion,
  p_request_key: completedVoidRequestKey, p_note: null,
});
assert.equal(voidDebitReplay.replay, true);
const notificationIntents = await db.query(`
  select audience,event_type,snapshot
    from public.ticket_management_notification_outbox
   order by created_at,id
`);
assert.equal(
  notificationIntents.rows.some((row) =>
    row.audience === 'customer' && row.event_type === 'quotation-published'
  ),
  true
);
assert.equal(
  notificationIntents.rows.some((row) =>
    row.audience === 'internal' && row.event_type === 'customer-approved'
  ),
  true
);
for (const intent of notificationIntents.rows.filter((row) => row.audience === 'customer')) {
  const snapshot = JSON.stringify(intent.snapshot);
  assert.doesNotMatch(snapshot, /walletAccount|ledgerEntry|reservationId/i);
}

console.log('Ticket Management Refund, Reissue, and VOID settlement verified.');
