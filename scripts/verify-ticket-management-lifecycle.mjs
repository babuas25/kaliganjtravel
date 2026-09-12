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
    captured_amount bigint not null default 0,
    refunded_amount bigint not null default 0,
    payment_state text not null default 'unpaid',
    currency text not null default 'BDT'
  );
  create or replace function public.touch_updated_at()
  returns trigger language plpgsql as $$
  begin new.updated_at := clock_timestamp(); return new; end
  $$;
`);
for (const migration of [
  'supabase/migrations/0119_ticket_management_core.sql',
  'supabase/migrations/0120_ticket_management_lifecycle_assignment.sql',
  'supabase/migrations/0126_ticket_management_notification_outbox.sql',
]) {
  await db.exec(fs.readFileSync(migration, 'utf8'));
}

const bookingId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
await db.query(`insert into public.wallet_accounts(id) values ($1)`, [accountId]);
await db.query(`
  insert into public.app_users(clerk_id, role, agency_code) values
    ('customer-1', 'customer', null),
    ('support-1', 'staff_support', null),
    ('accounts-1', 'staff_account', null),
    ('admin-1', 'admin', null),
    ('media-1', 'staff_media', null)
`);
await db.query(`
  insert into public.flight_bookings (
    id, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    payment_state, currency
  ) values ($1, 'confirmed', 'confirmed', clock_timestamp(), $2,
    'user', 'customer-1', 5000000, 0, 'captured', 'BDT')
`, [bookingId, accountId]);

async function rpc(name, params) {
  const keys = Object.keys(params);
  const placeholders = keys.map((key, index) => `${key} => $${index + 1}`).join(', ');
  const result = await db.query(
    `select public.${name}(${placeholders}) as result`,
    keys.map((key) => params[key])
  );
  return result.rows[0].result;
}

const created = await rpc('create_ticket_management_request_v1', {
  p_booking_id: bookingId,
  p_action: 'refund',
  p_actor_user_id: 'customer-1',
  p_request_key: 'ticket-request:1',
  p_request_payload_hash: 'a'.repeat(64),
  p_note: 'Please refund this ticket',
});
assert.equal(created.ok, true);
assert.equal(created.status, 'requested');
const replay = await rpc('create_ticket_management_request_v1', {
  p_booking_id: bookingId,
  p_action: 'refund',
  p_actor_user_id: 'customer-1',
  p_request_key: 'ticket-request:1',
  p_request_payload_hash: 'a'.repeat(64),
  p_note: 'Please refund this ticket',
});
assert.equal(replay.replay, true);
const changedReplay = await rpc('create_ticket_management_request_v1', {
  p_booking_id: bookingId,
  p_action: 'refund',
  p_actor_user_id: 'customer-1',
  p_request_key: 'ticket-request:1',
  p_request_payload_hash: 'f'.repeat(64),
  p_note: 'Changed payload after a lost response',
});
assert.equal(changedReplay.code, 'REQUEST_IDEMPOTENCY_CONFLICT');
const second = await rpc('create_ticket_management_request_v1', {
  p_booking_id: bookingId,
  p_action: 'refund',
  p_actor_user_id: 'customer-1',
  p_request_key: 'ticket-request:2',
  p_request_payload_hash: 'b'.repeat(64),
  p_note: null,
});
assert.equal(second.ok, true, 'same booking/action must allow another request identity');

const accepted = await rpc('review_ticket_management_request_v1', {
  p_request_id: created.requestId,
  p_decision: 'accept',
  p_actor_user_id: 'support-1',
  p_expected_version: created.version,
  p_request_key: 'ticket-review:1',
  p_note: null,
});
assert.equal(accepted.status, 'in-progress');
const forbiddenReview = await rpc('review_ticket_management_request_v1', {
  p_request_id: second.requestId,
  p_decision: 'accept',
  p_actor_user_id: 'accounts-1',
  p_expected_version: second.version,
  p_request_key: 'ticket-review:forbidden',
  p_note: null,
});
assert.equal(forbiddenReview.code, 'OPERATION_FORBIDDEN');

const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const quote = await rpc('publish_ticket_management_quote_v1', {
  p_request_id: created.requestId,
  p_actor_user_id: 'support-1',
  p_expected_version: accepted.version,
  p_request_key: 'ticket-quote:1',
  p_direction: 'credit',
  p_currency: 'BDT',
  p_supplier_gross_amount: 5000000,
  p_supplier_payable_amount: 4500000,
  p_user_payable_entitlement_amount: 4250000,
  p_fare_difference: 0,
  p_airline_fee: 500000,
  p_void_fee: 0,
  p_service_fee: 50000,
  p_customer_amount: 3700000,
  p_confirmation_deadline_at: deadline,
  p_details: 'Manual airline refund quotation',
});
assert.equal(quote.status, 'awaiting-confirmation');
assert.match(quote.quoteHash, /^[a-f0-9]{64}$/);

const approved = await rpc('decide_ticket_management_quote_v1', {
  p_request_id: created.requestId,
  p_quote_id: quote.quoteId,
  p_decision: 'approved',
  p_actor_user_id: 'customer-1',
  p_expected_version: quote.version,
  p_request_key: 'ticket-decision:1',
  p_note: null,
});
assert.equal(approved.status, 'approved');
const changedDecisionReplay = await rpc('decide_ticket_management_quote_v1', {
  p_request_id: created.requestId,
  p_quote_id: quote.quoteId,
  p_decision: 'rejected',
  p_actor_user_id: 'customer-1',
  p_expected_version: quote.version,
  p_request_key: 'ticket-decision:1',
  p_note: null,
});
assert.equal(changedDecisionReplay.code, 'DECISION_IDEMPOTENCY_CONFLICT');

const assigned = await rpc('assign_ticket_management_settlement_v1', {
  p_request_id: created.requestId,
  p_assignee_user_id: 'accounts-1',
  p_actor_user_id: 'support-1',
  p_expected_version: approved.version,
  p_request_key: 'ticket-assignment:1',
  p_reason: 'Ready for final settlement',
});
assert.equal(assigned.assigneeRole, 'staff_account');
const invalidAssignee = await rpc('assign_ticket_management_settlement_v1', {
  p_request_id: created.requestId,
  p_assignee_user_id: 'support-1',
  p_actor_user_id: 'admin-1',
  p_expected_version: assigned.version,
  p_request_key: 'ticket-assignment:invalid',
  p_reason: null,
});
assert.equal(invalidAssignee.code, 'ASSIGNEE_ROLE_INVALID');

const reopened = await rpc('reopen_ticket_management_request_v1', {
  p_request_id: created.requestId,
  p_actor_user_id: 'support-1',
  p_expected_version: assigned.version,
  p_request_key: 'ticket-requote:1',
  p_reason: 'Airline changed the refund amount',
});
assert.equal(reopened.status, 'in-progress');
const retainedDecision = await db.query(
  `select count(*)::integer as count
     from public.ticket_management_customer_decisions
    where request_id = $1`,
  [created.requestId]
);
assert.equal(retainedDecision.rows[0].count, 1, 'requote must retain old customer decision');

await assert.rejects(
  db.query(`update public.ticket_management_quotes set customer_amount = 1 where id = $1`, [quote.quoteId]),
  /records are immutable/
);

const reissue = await rpc('create_ticket_management_request_v1', {
  p_booking_id: bookingId,
  p_action: 'reissue',
  p_actor_user_id: 'customer-1',
  p_request_key: 'ticket-request:reissue',
  p_request_payload_hash: 'c'.repeat(64),
  p_note: null,
});
const reissueAccepted = await rpc('review_ticket_management_request_v1', {
  p_request_id: reissue.requestId,
  p_decision: 'accept',
  p_actor_user_id: 'support-1',
  p_expected_version: reissue.version,
  p_request_key: 'ticket-review:reissue',
  p_note: null,
});
const reissueQuote = await rpc('publish_ticket_management_quote_v1', {
  p_request_id: reissue.requestId,
  p_actor_user_id: 'support-1',
  p_expected_version: reissueAccepted.version,
  p_request_key: 'ticket-quote:reissue',
  p_direction: 'debit',
  p_currency: 'BDT',
  p_supplier_gross_amount: 5000000,
  p_supplier_payable_amount: 4500000,
  p_user_payable_entitlement_amount: 0,
  p_fare_difference: 350000,
  p_airline_fee: 200000,
  p_void_fee: 0,
  p_service_fee: 50000,
  p_customer_amount: 600000,
  p_confirmation_deadline_at: deadline,
  p_details: null,
});
const blockedDebitApproval = await rpc('decide_ticket_management_quote_v1', {
  p_request_id: reissue.requestId,
  p_quote_id: reissueQuote.quoteId,
  p_decision: 'approved',
  p_actor_user_id: 'customer-1',
  p_expected_version: reissueQuote.version,
  p_request_key: 'ticket-decision:reissue',
  p_note: null,
});
assert.equal(blockedDebitApproval.code, 'WALLET_HOLD_REQUIRED');
const stillAwaiting = await db.query(
  `select status from public.ticket_management_requests where id = $1`,
  [reissue.requestId]
);
assert.equal(stillAwaiting.rows[0].status, 'awaiting-confirmation');

const expiringAccepted = await rpc('review_ticket_management_request_v1', {
  p_request_id: second.requestId,
  p_decision: 'accept',
  p_actor_user_id: 'support-1',
  p_expected_version: second.version,
  p_request_key: 'ticket-review:expiring',
  p_note: null,
});
const expiringQuote = await rpc('publish_ticket_management_quote_v1', {
  p_request_id: second.requestId,
  p_actor_user_id: 'support-1',
  p_expected_version: expiringAccepted.version,
  p_request_key: 'ticket-quote:expiring',
  p_direction: 'credit',
  p_currency: 'BDT',
  p_supplier_gross_amount: 110000,
  p_supplier_payable_amount: 105000,
  p_user_payable_entitlement_amount: 100000,
  p_fare_difference: 0,
  p_airline_fee: 0,
  p_void_fee: 0,
  p_service_fee: 0,
  p_customer_amount: 100000,
  p_confirmation_deadline_at: new Date(Date.now() + 50).toISOString(),
  p_details: null,
});
assert.equal(expiringQuote.status, 'awaiting-confirmation');
await new Promise((resolve) => setTimeout(resolve, 100));
const expired = await rpc('expire_ticket_management_quotes_v1', { p_limit: 20 });
assert.equal(expired.expiredCount, 1);
const expiredRequest = await db.query(
  `select status, terminal_outcome from public.ticket_management_requests where id = $1`,
  [second.requestId]
);
assert.deepEqual(expiredRequest.rows[0], {
  status: 'expired',
  terminal_outcome: 'confirmation-expired',
});
const expiryIntent = await db.query(`
  select audience, event_type, snapshot
    from public.ticket_management_notification_outbox
   where request_id = $1
     and audience = 'customer'
     and event_type = 'confirmation-expired'
`, [second.requestId]);
assert.equal(expiryIntent.rows.length, 1, 'expiry must atomically enqueue one customer intent');
assert.doesNotMatch(
  JSON.stringify(expiryIntent.rows[0].snapshot),
  /walletAccount|ledgerEntry|reservationId/i
);

// Approval and expiry serialize on the same request row. Either legal winner is
// acceptable, but the request must never contain both a decision and expiry.
const raceRequest = await rpc('create_ticket_management_request_v1', {
  p_booking_id: bookingId,
  p_action: 'void',
  p_actor_user_id: 'customer-1',
  p_request_key: 'ticket-request:approval-expiry-race',
  p_request_payload_hash: '9'.repeat(64),
  p_note: null,
});
const raceAccepted = await rpc('review_ticket_management_request_v1', {
  p_request_id: raceRequest.requestId,
  p_decision: 'accept',
  p_actor_user_id: 'support-1',
  p_expected_version: raceRequest.version,
  p_request_key: 'ticket-review:approval-expiry-race',
  p_note: null,
});
const raceQuote = await rpc('publish_ticket_management_quote_v1', {
  p_request_id: raceRequest.requestId,
  p_actor_user_id: 'support-1',
  p_expected_version: raceAccepted.version,
  p_request_key: 'ticket-quote:approval-expiry-race',
  p_direction: 'credit',
  p_currency: 'BDT',
  p_supplier_gross_amount: 100,
  p_supplier_payable_amount: 90,
  p_user_payable_entitlement_amount: 80,
  p_fare_difference: 0,
  p_airline_fee: 0,
  p_void_fee: 10,
  p_service_fee: 0,
  p_customer_amount: 70,
  p_confirmation_deadline_at: new Date(Date.now() + 10).toISOString(),
  p_details: null,
});
const [raceDecision, raceExpiry] = await Promise.all([
  rpc('decide_ticket_management_quote_v1', {
    p_request_id: raceRequest.requestId,
    p_quote_id: raceQuote.quoteId,
    p_decision: 'approved',
    p_actor_user_id: 'customer-1',
    p_expected_version: raceQuote.version,
    p_request_key: 'ticket-decision:approval-expiry-race',
    p_note: null,
  }),
  rpc('expire_ticket_management_quotes_v1', { p_limit: 20 }),
]);
const raceState = (await db.query(`
  select request.status,request.terminal_outcome,
         count(decision.id)::integer decision_count
    from public.ticket_management_requests request
    left join public.ticket_management_customer_decisions decision
      on decision.request_id=request.id
   where request.id=$1
   group by request.id
`, [raceRequest.requestId])).rows[0];
assert.equal(['approved', 'expired'].includes(raceState.status), true);
assert.equal(
  raceState.status === 'approved',
  raceState.decision_count === 1,
  `race result was ${JSON.stringify({ raceDecision, raceExpiry, raceState })}`
);
assert.equal(
  raceState.status === 'expired',
  raceState.terminal_outcome === 'confirmation-expired'
);

await db.close();
console.log('Ticket Management lifecycle, quotation, deadline, and assignment verified.');
