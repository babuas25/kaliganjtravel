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
]) {
  await db.exec(fs.readFileSync(migration, 'utf8'));
}

const bookingId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
await db.query(`insert into public.wallet_accounts(id) values ($1)`, [accountId]);
await db.exec(`
  insert into public.app_users(clerk_id, role) values
    ('customer-1', 'customer'), ('support-1', 'staff_support');
`);
await db.query(`
  insert into public.flight_bookings (
    id, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers, ticket_numbers, fares
  ) values (
    $1, 'confirmed', 'confirmed', clock_timestamp(), $2,
    'user', 'customer-1', 25000, 0, 25000, 'captured', 'BDT',
    '{"travellers":[
      {"passengerType":"ADT","title":"Mr","firstName":"One","lastName":"Adult"},
      {"passengerType":"ADT","title":"Ms","firstName":"Two","lastName":"Adult"},
      {"passengerType":"CHD","title":"Mstr","firstName":"Three","lastName":"Child"}
    ]}'::jsonb,
    '["T-1","T-2","T-3"]'::jsonb,
    '[
      {"passengerType":"ADT","count":2,"totalPrice":200},
      {"passengerType":"CHD","count":1,"totalPrice":50}
    ]'::jsonb
  )
`, [bookingId, accountId]);

const importedBookingId = '99999999-9999-4999-8999-999999999999';
await db.query(`
  insert into public.flight_bookings (
    id, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers, ticket_numbers,
    fares, import_source
  )
  select $1, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers,
    '["I-1","I-2","I-3"]'::jsonb,
    fares, 'MANUAL'
  from public.flight_bookings where id = $2
`, [importedBookingId, bookingId]);
const mismatchedBookingId = '88888888-8888-4888-8888-888888888888';
await db.query(`
  insert into public.flight_bookings (
    id, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers, ticket_numbers, fares
  )
  select $1, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, 25001, refunded_amount,
    user_payable_amount, payment_state, currency, passengers,
    '["M-1","M-2","M-3"]'::jsonb, fares
  from public.flight_bookings where id = $2
`, [mismatchedBookingId, bookingId]);
const raceBookingId = '77777777-7777-4777-8777-777777777777';
await db.query(`
  insert into public.flight_bookings (
    id, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers, ticket_numbers, fares
  )
  select $1, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers,
    '["R-1","R-2","R-3"]'::jsonb, fares
  from public.flight_bookings where id = $2
`, [raceBookingId, bookingId]);

const singlePassengerBookingId = '66666666-6666-4666-8666-666666666666';
await db.query(`
  insert into public.flight_bookings (
    id, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers, ticket_numbers,
    fares, import_source
  ) values (
    $1, 'confirmed', 'confirmed', clock_timestamp(), $2,
    'user', 'customer-1', 3764300, 0, 3764300, 'captured', 'BDT',
    '{"travellers":[
      {"passengerType":"ADT","title":"Mr","firstName":"Flown","lastName":"Passenger"}
    ]}'::jsonb,
    '["SINGLE-260823"]'::jsonb,
    '[{"passengerType":"ADT","count":1,"totalPrice":40619}]'::jsonb,
    'MANUAL'
  )
`, [singlePassengerBookingId, accountId]);

const singlePassengerMismatchId = '55555555-5555-4555-8555-555555555555';
await db.query(`
  insert into public.flight_bookings (
    id, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers, ticket_numbers,
    fares, import_source
  )
  select $1, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    captured_amount + 1, payment_state, currency, passengers,
    '["SINGLE-MISMATCH"]'::jsonb, fares, import_source
  from public.flight_bookings where id = $2
`, [singlePassengerMismatchId, singlePassengerBookingId]);

const manualMissingUserPayableId = '44444444-4444-4444-8444-444444444444';
await db.query(`
  insert into public.flight_bookings (
    id, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers, ticket_numbers,
    fares, import_source
  )
  select $1, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    null, payment_state, currency, passengers,
    '["SINGLE-MISSING-PAYABLE"]'::jsonb, fares, 'MANUAL'
  from public.flight_bookings where id = $2
`, [manualMissingUserPayableId, singlePassengerBookingId]);

const impExpSinglePassengerId = '33333333-3333-4333-8333-333333333334';
await db.query(`
  insert into public.flight_bookings (
    id, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers, ticket_numbers,
    fares, import_source
  )
  select $1, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers,
    '["SINGLE-IMP-EXP"]'::jsonb, fares, 'IMP_EXP'
  from public.flight_bookings where id = $2
`, [impExpSinglePassengerId, singlePassengerBookingId]);

const manualAmbiguousTicketId = '22222222-2222-4222-8222-222222222223';
await db.query(`
  insert into public.flight_bookings (
    id, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers, ticket_numbers,
    fares, import_source
  )
  select $1, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers,
    '[""]'::jsonb, fares, 'MANUAL'
  from public.flight_bookings where id = $2
`, [manualAmbiguousTicketId, singlePassengerBookingId]);

const manualUncapturedPaymentId = '12121212-1212-4212-8212-121212121212';
await db.query(`
  insert into public.flight_bookings (
    id, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers, ticket_numbers,
    fares, import_source
  )
  select $1, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, 'unpaid', currency, passengers,
    '["SINGLE-UNPAID"]'::jsonb, fares, 'MANUAL'
  from public.flight_bookings where id = $2
`, [manualUncapturedPaymentId, singlePassengerBookingId]);

const manualWalletUnboundId = '13131313-1313-4313-8313-131313131313';
await db.query(`
  insert into public.flight_bookings (
    id, status, lifecycle_status, issued_at, charged_wallet_account_id,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers, ticket_numbers,
    fares, import_source
  )
  select $1, status, lifecycle_status, issued_at, null,
    booking_owner_type, booking_owner_key, captured_amount, refunded_amount,
    user_payable_amount, payment_state, currency, passengers,
    '["SINGLE-NO-WALLET"]'::jsonb, fares, 'MANUAL'
  from public.flight_bookings where id = $2
`, [manualWalletUnboundId, singlePassengerBookingId]);

const before0129 = await db.query(`
  select to_jsonb(booking) as booking
    from public.flight_bookings booking order by booking.id
`);
const walletBefore0129 = await db.query(`
  select to_jsonb(account) as account
    from public.wallet_accounts account order by account.id
`);
const unsafeManualFacts = await db.query(`
  select id, payment_state, charged_wallet_account_id
    from public.flight_bookings
   where id = any($1::uuid[])
   order by id
`, [[manualUncapturedPaymentId, manualWalletUnboundId]]);
assert.deepEqual(unsafeManualFacts.rows, [
  {
    id: manualUncapturedPaymentId,
    payment_state: 'unpaid',
    charged_wallet_account_id: accountId,
  },
  {
    id: manualWalletUnboundId,
    payment_state: 'captured',
    charged_wallet_account_id: null,
  },
]);
const entitlementCountBefore0129 = await db.query(`
  select count(*)::integer as count
    from public.ticket_management_ticket_entitlements
`);
await db.exec(fs.readFileSync(
  'supabase/migrations/0129_ticket_management_manual_single_passenger_entitlement.sql',
  'utf8'
));
const after0129 = await db.query(`
  select to_jsonb(booking) as booking
    from public.flight_bookings booking order by booking.id
`);
const walletAfter0129 = await db.query(`
  select to_jsonb(account) as account
    from public.wallet_accounts account order by account.id
`);
const entitlementCountAfter0129 = await db.query(`
  select count(*)::integer as count
    from public.ticket_management_ticket_entitlements
`);
assert.deepEqual(after0129.rows, before0129.rows);
assert.deepEqual(walletAfter0129.rows, walletBefore0129.rows);
assert.deepEqual(entitlementCountAfter0129.rows, entitlementCountBefore0129.rows);

async function rpc(name, params) {
  const keys = Object.keys(params);
  const placeholders = keys.map((key, index) => `${key} => $${index + 1}`).join(', ');
  const result = await db.query(
    `select public.${name}(${placeholders}) as result`,
    keys.map((key) => params[key])
  );
  return result.rows[0].result;
}

const singlePassengerRequest = await rpc('create_ticket_management_request_v2', {
  p_booking_id: singlePassengerBookingId,
  p_action: 'refund',
  p_actor_user_id: 'customer-1',
  p_request_key: 'entitlement-single-passenger:request',
  p_request_payload_hash: 'f'.repeat(64),
  p_passenger_indexes: [0],
  p_note: null,
});
assert.equal(singlePassengerRequest.ok, true);
const singlePassengerEntitlement = await db.query(`
  select entitlement_amount, user_payable_source_minor, allocation_source
    from public.ticket_management_ticket_entitlements
   where booking_id = $1
`, [singlePassengerBookingId]);
assert.deepEqual(singlePassengerEntitlement.rows, [{
  entitlement_amount: 3764300,
  user_payable_source_minor: 3764300,
  allocation_source: 'authoritative-single-passenger-user-payable',
}]);
const singlePassengerHistorical = await db.query(`
  select user_payable_amount, captured_amount, fares, import_source
    from public.flight_bookings where id = $1
`, [singlePassengerBookingId]);
assert.equal(singlePassengerHistorical.rows[0].user_payable_amount, 3764300);
assert.equal(singlePassengerHistorical.rows[0].captured_amount, 3764300);
assert.equal(singlePassengerHistorical.rows[0].fares[0].totalPrice, 40619);
assert.equal(singlePassengerHistorical.rows[0].import_source, 'MANUAL');

await assert.rejects(
  rpc('create_ticket_management_request_v2', {
    p_booking_id: singlePassengerMismatchId,
    p_action: 'refund',
    p_actor_user_id: 'customer-1',
    p_request_key: 'entitlement-single-passenger:mismatch',
    p_request_payload_hash: '0'.repeat(64),
    p_passenger_indexes: [0],
    p_note: null,
  }),
  /AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE/
);

assert.deepEqual(
  await rpc('ticket_management_ensure_booking_entitlements_v1', {
    p_booking_id: manualUncapturedPaymentId,
  }),
  {
    ok: false,
    code: 'AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE',
  }
);

for (const [bookingIdUnderTest, requestKey, expectedError] of [
  [
    manualMissingUserPayableId,
    'entitlement-manual-single:missing-user-payable',
    /AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE/,
  ],
  [
    impExpSinglePassengerId,
    'entitlement-imp-exp-single:still-blocked',
    /AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE/,
  ],
  [
    manualAmbiguousTicketId,
    'entitlement-manual-single:ambiguous-ticket',
    /ENTITLEMENT_TICKETS_UNPROVEN/,
  ],
  [
    manualUncapturedPaymentId,
    'entitlement-manual-single:uncaptured-payment-state',
    /AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE/,
  ],
  [
    manualWalletUnboundId,
    'entitlement-manual-single:wallet-unbound',
    /AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE/,
  ],
]) {
  try {
    const failClosedResult = await rpc('create_ticket_management_request_v2', {
      p_booking_id: bookingIdUnderTest,
      p_action: 'refund',
      p_actor_user_id: 'customer-1',
      p_request_key: requestKey,
      p_request_payload_hash: '9'.repeat(64),
      p_passenger_indexes: [0],
      p_note: null,
    });
    assert.equal(failClosedResult.ok, false, requestKey);
  } catch (error) {
    assert.match(String(error), expectedError, requestKey);
  }
}

const unsafeImportedBookingIds = [
  importedBookingId,
  singlePassengerMismatchId,
  manualMissingUserPayableId,
  impExpSinglePassengerId,
  manualAmbiguousTicketId,
  manualUncapturedPaymentId,
  manualWalletUnboundId,
];
const unsafeImportedArtifacts = await db.query(`
  select
    (select count(*)::integer
       from public.ticket_management_ticket_entitlements
      where booking_id = any($1::uuid[])) as entitlement_count,
    (select count(*)::integer
       from public.ticket_management_requests
      where booking_id = any($1::uuid[])) as request_count
`, [unsafeImportedBookingIds]);
assert.deepEqual(unsafeImportedArtifacts.rows, [{
  entitlement_count: 0,
  request_count: 0,
}]);

const entitlementRace = await Promise.allSettled([
  rpc('create_ticket_management_request_v2', {
    p_booking_id: raceBookingId,
    p_action: 'refund',
    p_actor_user_id: 'customer-1',
    p_request_key: 'entitlement-race:refund',
    p_request_payload_hash: '1'.repeat(64),
    p_passenger_indexes: [0],
    p_note: null,
  }),
  rpc('create_ticket_management_request_v2', {
    p_booking_id: raceBookingId,
    p_action: 'void',
    p_actor_user_id: 'customer-1',
    p_request_key: 'entitlement-race:void',
    p_request_payload_hash: '2'.repeat(64),
    p_passenger_indexes: [0],
    p_note: null,
  }),
]);
assert.equal(
  entitlementRace.filter((result) => result.status === 'fulfilled').length,
  1,
  'concurrent Refund/VOID coupon claims must have exactly one winner'
);
assert.equal(
  entitlementRace.filter((result) => result.status === 'rejected').length,
  1
);
assert.match(
  String(entitlementRace.find((result) => result.status === 'rejected').reason),
  /already claimed/
);

await assert.rejects(
  rpc('create_ticket_management_request_v2', {
    p_booking_id: importedBookingId,
    p_action: 'refund',
    p_actor_user_id: 'customer-1',
    p_request_key: 'entitlement-request:imported-unproven',
    p_request_payload_hash: 'd'.repeat(64),
    p_passenger_indexes: [0],
    p_note: null,
  }),
  /AUTHORITATIVE_USER_PAYABLE_ALLOCATION_UNAVAILABLE/
);
await assert.rejects(
  rpc('create_ticket_management_request_v2', {
    p_booking_id: mismatchedBookingId,
    p_action: 'refund',
    p_actor_user_id: 'customer-1',
    p_request_key: 'entitlement-request:non-authoritative-total',
    p_request_payload_hash: 'e'.repeat(64),
    p_passenger_indexes: [0],
    p_note: null,
  }),
  /authoritative passenger User Payable does not equal captured amount/
);

const created = await rpc('create_ticket_management_request_v2', {
  p_booking_id: bookingId,
  p_action: 'refund',
  p_actor_user_id: 'customer-1',
  p_request_key: 'entitlement-request:1',
  p_request_payload_hash: 'a'.repeat(64),
  p_passenger_indexes: [0],
  p_note: null,
});
assert.equal(created.ok, true);
assert.equal(created.selectedPassengerCount, 1);

const allocations = await db.query(`
  select passenger_index, entitlement_amount
    from public.ticket_management_ticket_entitlements
   where booking_id = $1 order by passenger_index
`, [bookingId]);
assert.deepEqual(
  allocations.rows.map((row) => [row.passenger_index, row.entitlement_amount]),
  [[0, 10000], [1, 10000], [2, 5000]]
);
assert.equal(
  allocations.rows.reduce((sum, row) => sum + row.entitlement_amount, 0),
  25000
);

await assert.rejects(
  rpc('create_ticket_management_request_v2', {
    p_booking_id: bookingId,
    p_action: 'void',
    p_actor_user_id: 'customer-1',
    p_request_key: 'entitlement-request:conflict',
    p_request_payload_hash: 'b'.repeat(64),
    p_passenger_indexes: [0],
    p_note: null,
  }),
  /already claimed/
);

const accepted = await rpc('review_ticket_management_request_v1', {
  p_request_id: created.requestId,
  p_decision: 'accept',
  p_actor_user_id: 'support-1',
  p_expected_version: created.version,
  p_request_key: 'entitlement-review:1',
  p_note: null,
});
await assert.rejects(
  rpc('publish_ticket_management_quote_v1', {
    p_request_id: created.requestId,
    p_actor_user_id: 'support-1',
    p_expected_version: accepted.version,
    p_request_key: 'entitlement-quote:too-high',
    p_direction: 'credit',
    p_currency: 'BDT',
    p_supplier_gross_amount: 12000,
    p_supplier_payable_amount: 11000,
    p_user_payable_entitlement_amount: 10001,
    p_fare_difference: 0,
    p_airline_fee: 0,
    p_void_fee: 0,
    p_service_fee: 0,
    p_customer_amount: 10001,
    p_confirmation_deadline_at: new Date(Date.now() + 60_000).toISOString(),
    p_details: null,
  }),
  /User Payable must equal selected remaining entitlement/
);

const validQuote = await rpc('publish_ticket_management_quote_v1', {
  p_request_id: created.requestId,
  p_actor_user_id: 'support-1',
  p_expected_version: accepted.version,
  p_request_key: 'entitlement-quote:valid',
  p_direction: 'credit',
  p_currency: 'BDT',
  p_supplier_gross_amount: 12000,
  p_supplier_payable_amount: 11000,
  p_user_payable_entitlement_amount: 10000,
  p_fare_difference: 0,
  p_airline_fee: 1,
  p_void_fee: 0,
  p_service_fee: 0,
  p_customer_amount: 9999,
  p_confirmation_deadline_at: new Date(Date.now() + 60_000).toISOString(),
  p_details: null,
});
const rejected = await rpc('decide_ticket_management_quote_v1', {
  p_request_id: created.requestId,
  p_quote_id: validQuote.quoteId,
  p_decision: 'rejected',
  p_actor_user_id: 'customer-1',
  p_expected_version: validQuote.version,
  p_request_key: 'entitlement-decision:reject',
  p_note: null,
});
assert.equal(rejected.status, 'rejected');
const released = await db.query(`
  select state, release_reason
    from public.ticket_management_entitlement_claims
   where request_id = $1
`, [created.requestId]);
assert.deepEqual(released.rows[0], {
  state: 'released',
  release_reason: 'customer-rejected',
});

const afterRelease = await rpc('create_ticket_management_request_v2', {
  p_booking_id: bookingId,
  p_action: 'void',
  p_actor_user_id: 'customer-1',
  p_request_key: 'entitlement-request:after-release',
  p_request_payload_hash: 'c'.repeat(64),
  p_passenger_indexes: [0],
  p_note: null,
});
assert.equal(afterRelease.ok, true);

await assert.rejects(
  db.query(
    `update public.ticket_management_request_selections
        set ticket_number_snapshot = 'CHANGED' where request_id = $1`,
    [afterRelease.requestId]
  ),
  /selections are immutable/
);

console.log('Ticket Management database entitlement protections verified.');
