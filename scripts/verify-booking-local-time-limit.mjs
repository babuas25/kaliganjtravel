import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0083_booking_local_time_limit_requests.sql'
  ),
  'utf8'
);
const expiredRequestCapMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0084_local_time_limit_expired_request_cap.sql'
  ),
  'utf8'
);
const adminOwnerWalletMigration = fs.readFileSync(
  path.join(
    process.cwd(),
    'supabase',
    'migrations',
    '0102_admin_owner_wallet_ticketing.sql'
  ),
  'utf8'
);
const adminOwnerWalletLegacyFunction = adminOwnerWalletMigration.slice(
  adminOwnerWalletMigration.indexOf(
    'create or replace function public.wallet_begin_booking_issue('
  ),
  adminOwnerWalletMigration.indexOf(
    'create or replace function public.wallet_begin_booking_issue_v2('
  )
);
const localTimeLimitDb = fs.readFileSync(
  path.join(process.cwd(), 'lib', 'db', 'booking-local-time-limit.ts'),
  'utf8'
);
const userRoute = fs.readFileSync(
  path.join(
    process.cwd(),
    'app',
    'api',
    'flights',
    'booking',
    'time-limit-request',
    'route.ts'
  ),
  'utf8'
);
const staffRoute = fs.readFileSync(
  path.join(
    process.cwd(),
    'app',
    'api',
    'admin',
    'booking-lifecycle',
    '[reference]',
    'local-time-limit',
    'route.ts'
  ),
  'utf8'
);
const decisionPanel = fs.readFileSync(
  path.join(
    process.cwd(),
    'components',
    'dashboard',
    'bookings',
    'LocalTimeLimitDecisionPanel.tsx'
  ),
  'utf8'
);

assert.match(userRoute, /\.strict\(\)/);
assert.doesNotMatch(userRoute, /grantedMinutes\s*:/);
assert.match(userRoute, /Minutes cannot be requested by the user/);
assert.match(staffRoute, /\.int\('Minutes must be a whole number\.'\)/);
assert.match(staffRoute, /LOCAL_TIME_LIMIT_MIN_GRANT_MINUTES/);
assert.match(staffRoute, /LOCAL_TIME_LIMIT_MAX_GRANT_MINUTES/);
assert.match(decisionPanel, /type="number"/);
assert.match(decisionPanel, /step=\{1\}/);
assert.match(migration, /interval '15 minutes'/);
assert.match(migration, /p_granted_minutes <> trunc\(p_granted_minutes\)/);
assert.match(migration, /p_granted_minutes < 1/);
assert.match(migration, /p_granted_minutes > 30/);
assert.match(
  migration,
  /v_deadline := v_approved_at \+ make_interval\(mins => v_granted_minutes\)/
);
assert.match(migration, /supplier_ticketing_deadline_at/);
assert.match(migration, /local_ticketing_deadline_at/);
assert.match(
  migration,
  /update public\.flight_bookings[\s\S]*?where lower\(coalesce\(supplier, ''\)\) = 'triplover'/
);
assert.match(migration, /prevent_booking_deadline_audit_mutation/);
assert.doesNotMatch(migration, /\bdigest\(/);
assert.match(migration, /encode\(sha256\(convert_to\(/);
assert.match(
  localTimeLimitDb,
  /supplierDeadline >[\s\S]*?now - LOCAL_TIME_LIMIT_EXPIRED_REQUEST_WINDOW_MINUTES \* 60_000/
);
assert.match(
  expiredRequestCapMigration,
  /v_booking\.supplier_ticketing_deadline_at <=[\s\S]*?v_now - interval '3 hours'/
);
assert.match(
  expiredRequestCapMigration,
  /v_supplier_deadline <= v_now - interval '3 hours'/
);
assert.match(expiredRequestCapMigration, /expiredRequestWindowMinutes', 180/);
assert.match(
  userRoute,
  /code === 'LOCAL_TIME_LIMIT_REQUEST_WINDOW_EXPIRED' \? 410 : 409/
);
assert.match(adminOwnerWalletMigration, /p_actor_role = 'staff_support'/);
assert.match(
  adminOwnerWalletMigration,
  /v_booking\.booking_owner_type, v_booking\.booking_owner_key/
);

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create extension if not exists pgcrypto;

  create table public.app_users (
    clerk_id text primary key,
    role text not null,
    agency_code text
  );
  create table public.flight_bookings (
    id uuid primary key default gen_random_uuid(),
    public_ref text not null unique,
    user_id text,
    agency_code text,
    supplier text not null default 'triplover',
    status text not null default 'on-hold',
    legacy_operational boolean not null default false,
    direct_ticketing boolean not null default false,
    booking_status text,
    airlines_pnr jsonb not null default '[]'::jsonb,
    ticket_numbers jsonb not null default '[]'::jsonb,
    ticketing_time_limit text,
    ticketing_deadline_at timestamptz,
    deadline_source text
      constraint flight_bookings_deadline_source_check
      check (deadline_source in ('supplier', 'pnr_call', 'assumed')),
    issued_at timestamptz,
    cancelled_at timestamptz,
    synced_at timestamptz,
    operation_kind text,
    operation_reason text,
    operation_request_id text,
    operation_actor_user_id text,
    operation_started_at timestamptz,
    operation_prior_status text,
    active_operation_id uuid,
    payment_state text not null default 'none',
    booking_owner_type text,
    booking_owner_key text,
    import_source text,
    import_pricing_valid boolean not null default true,
    pricing_snapshot jsonb not null default '{"sellingPrice":22800}'::jsonb,
    currency text not null default 'BDT',
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp()
  );
  create table public.booking_reconciliation_cases (
    id uuid primary key default gen_random_uuid(),
    subject_booking_id uuid references public.flight_bookings(id),
    state text not null
  );
  create table public.booking_status_events (
    id bigint generated always as identity primary key,
    booking_id uuid not null references public.flight_bookings(id),
    from_lifecycle_status text,
    to_lifecycle_status text not null,
    stored_status_before text,
    stored_status_after text,
    operation_kind text,
    operation_reason text,
    actor_user_id text,
    supplier_operation text,
    supplier_evidence jsonb not null default '{}'::jsonb,
    idempotency_key text,
    created_at timestamptz not null default clock_timestamp()
  );
  create unique index booking_status_events_idempotency_idx
    on public.booking_status_events (
      booking_id, idempotency_key, to_lifecycle_status
    ) where idempotency_key is not null;

  create table public.wallet_balances (
    owner_type text not null,
    owner_key text not null,
    currency text not null,
    available_balance bigint not null,
    hold_balance bigint not null default 0,
    primary key (owner_type, owner_key, currency)
  );
  create table public.wallet_reserve_calls (
    id bigint generated always as identity primary key,
    booking_id uuid,
    owner_type text not null,
    owner_key text not null,
    amount bigint not null,
    actor_user_id text not null,
    actor_role text not null,
    idempotency_key text not null unique
  );

  create or replace function public.touch_updated_at()
  returns trigger language plpgsql as $$
  begin
    new.updated_at := clock_timestamp();
    return new;
  end
  $$;
  create or replace function public.jsonb_is_nonempty_array(p_value jsonb)
  returns boolean language sql immutable as $$
    select jsonb_typeof(p_value) = 'array' and jsonb_array_length(p_value) > 0
  $$;
  create or replace function public.resolve_booking_lifecycle(
    p_status text,
    p_airlines_pnr jsonb,
    p_ticketing_deadline_at timestamptz,
    p_operation_kind text
  ) returns text language sql stable as $$
    select case
      when p_status = 'cancelled' then 'cancelled'
      when p_status = 'confirmed' then 'confirmed'
      when p_status = 'in-progress' or p_operation_kind is not null
        then 'in-progress'
      when p_status = 'pending' then 'pending'
      when p_status = 'on-hold'
        and not public.jsonb_is_nonempty_array(p_airlines_pnr)
        then 'unconfirmed'
      when p_status = 'on-hold'
        and p_ticketing_deadline_at is not null
        and p_ticketing_deadline_at <= clock_timestamp()
        then 'expired'
      else 'on-hold'
    end
  $$;
  create or replace function public.wallet_reserve_amount(
    p_booking_id uuid,
    p_attempt_id uuid,
    p_owner_type text,
    p_owner_key text,
    p_amount bigint,
    p_currency text,
    p_actor_user_id text,
    p_actor_role text,
    p_idempotency_key text,
    p_reference text
  ) returns jsonb language plpgsql as $$
  declare v_balance public.wallet_balances;
  begin
    select * into v_balance
      from public.wallet_balances
     where owner_type = p_owner_type
       and owner_key = p_owner_key
       and currency = p_currency
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND');
    end if;
    if v_balance.available_balance < p_amount then
      return jsonb_build_object(
        'ok', false, 'code', 'INSUFFICIENT_FUNDS',
        'available', v_balance.available_balance, 'required', p_amount
      );
    end if;
    update public.wallet_balances
       set available_balance = available_balance - p_amount,
           hold_balance = hold_balance + p_amount
     where owner_type = p_owner_type
       and owner_key = p_owner_key
       and currency = p_currency;
    insert into public.wallet_reserve_calls (
      booking_id, owner_type, owner_key, amount,
      actor_user_id, actor_role, idempotency_key
    ) values (
      p_booking_id, p_owner_type, p_owner_key, p_amount,
      p_actor_user_id, p_actor_role, p_idempotency_key
    );
    return jsonb_build_object(
      'ok', true, 'heldAmount', p_amount, 'currency', p_currency
    );
  end
  $$;
  create or replace function public.record_booking_pnr_refresh_v2(
    p_booking_id uuid,
    p_actor_user_id text,
    p_actor_role text,
    p_sync_source text,
    p_supplier_status text,
    p_airlines_pnr jsonb,
    p_ticketing_time_limit text,
    p_ticketing_deadline_at timestamptz,
    p_normalized_evidence jsonb
  ) returns public.flight_bookings language plpgsql as $$
  declare v_booking public.flight_bookings;
  begin
    update public.flight_bookings set
      synced_at = clock_timestamp(),
      booking_status = p_supplier_status,
      airlines_pnr = case
        when public.jsonb_is_nonempty_array(p_airlines_pnr) then p_airlines_pnr
        else airlines_pnr
      end,
      ticketing_time_limit = case
        when p_ticketing_deadline_at is not null then p_ticketing_time_limit
        else ticketing_time_limit
      end,
      ticketing_deadline_at = coalesce(
        p_ticketing_deadline_at, ticketing_deadline_at
      )
    where id = p_booking_id returning * into v_booking;
    return v_booking;
  end
  $$;
  create or replace function public.record_booking_supplier_refresh_v2(
    p_booking_id uuid,
    p_actor_user_id text,
    p_actor_role text,
    p_sync_source text,
    p_supplier_status text,
    p_airlines_pnr jsonb,
    p_ticket_numbers jsonb,
    p_issued_at timestamptz,
    p_cancelled_at timestamptz,
    p_normalized_evidence jsonb
  ) returns public.flight_bookings language plpgsql as $$
  declare v_booking public.flight_bookings;
  begin
    update public.flight_bookings set
      synced_at = clock_timestamp(),
      booking_status = p_supplier_status
    where id = p_booking_id returning * into v_booking;
    return v_booking;
  end
  $$;

  insert into public.flight_bookings (
    id, public_ref, supplier, status, import_source, import_pricing_valid
  ) values (
    '00000000-0000-0000-0000-000000000099', 'STR000000000099',
    'US_BANGLA', 'confirmed', 'IMP_EXP', false
  );
  alter table public.flight_bookings
    add constraint fixture_import_pricing_truth_check
    check (import_source is distinct from 'IMP_EXP' or import_pricing_valid)
    not valid;
`);

await db.exec(migration);
await db.exec(expiredRequestCapMigration);
await db.exec(adminOwnerWalletLegacyFunction);

await db.exec(`
  insert into public.app_users (clerk_id, role, agency_code) values
    ('customer-1', 'customer', null),
    ('customer-low', 'customer', null),
    ('agent-1', 'b2b', 'ST-B2B000001'),
    ('support-1', 'staff_support', null),
    ('admin-1', 'admin', null),
    ('superadmin-1', 'superadmin', null);

  insert into public.wallet_balances (
    owner_type, owner_key, currency, available_balance
  ) values
    ('user', 'customer-1', 'BDT', 10000000),
    ('user', 'customer-low', 'BDT', 100),
    ('agency', 'ST-B2B000001', 'BDT', 10000000);

  insert into public.flight_bookings (
    id, public_ref, supplier, status, airlines_pnr,
    ticketing_time_limit, ticketing_deadline_at, deadline_source,
    booking_owner_type, booking_owner_key
  ) values
    ('00000000-0000-0000-0000-000000000001', 'STR000000000001',
      'triplover', 'on-hold', '["PNR-NULL"]', null, null, 'pnr_call',
      'user', 'customer-1'),
    ('00000000-0000-0000-0000-000000000002', 'STR000000000002',
      'triplover', 'on-hold', '["PNR-SHORT"]', 'short',
      clock_timestamp() + interval '3 minutes', 'pnr_call',
      'agency', 'ST-B2B000001'),
    ('00000000-0000-0000-0000-000000000003', 'STR000000000003',
      'triplover', 'on-hold', '["PNR-NORMAL"]', 'normal',
      clock_timestamp() + interval '30 minutes', 'pnr_call',
      'user', 'customer-1'),
    ('00000000-0000-0000-0000-000000000004', 'STR000000000004',
      'triplover', 'on-hold', '["PNR-CANCEL"]', null, null, 'pnr_call',
      'user', 'customer-1'),
    ('00000000-0000-0000-0000-000000000005', 'STR000000000005',
      'triplover', 'on-hold', '["PNR-OLD-EXPIRED"]', 'old-expired',
      clock_timestamp() - interval '4 hours', 'pnr_call',
      'user', 'customer-1'),
    ('00000000-0000-0000-0000-000000000006', 'STR000000000006',
      'triplover', 'on-hold', '["PNR-RECENT-EXPIRED"]', 'recent-expired',
      clock_timestamp() - interval '2 hours', 'pnr_call',
      'user', 'customer-1'),
    ('00000000-0000-0000-0000-000000000007', 'STR000000000007',
      'triplover', 'on-hold', '["PNR-BOUNDARY"]', 'boundary',
      clock_timestamp() - interval '3 hours', 'pnr_call',
      'user', 'customer-1'),
    ('00000000-0000-0000-0000-000000000008', 'STR000000000008',
      'triplover', 'on-hold', '["PNR-ADMIN-AGENCY"]', 'admin-agency',
      clock_timestamp() + interval '30 minutes', 'pnr_call',
      'agency', 'ST-B2B000001'),
    ('00000000-0000-0000-0000-000000000009', 'STR000000000009',
      'triplover', 'on-hold', '["PNR-SUPPORT"]', 'support',
      clock_timestamp() + interval '30 minutes', 'pnr_call',
      'user', 'customer-1'),
    ('00000000-0000-0000-0000-000000000010', 'STR000000000010',
      'triplover', 'on-hold', '["PNR-LOW"]', 'low',
      clock_timestamp() + interval '30 minutes', 'pnr_call',
      'user', 'customer-low');
`);

const agencyBalanceBefore = Number((await db.query(`
  select available_balance from public.wallet_balances
   where owner_type = 'agency' and owner_key = 'ST-B2B000001' and currency = 'BDT'
`)).rows[0].available_balance);
const adminIssued = (await db.query(`
  select public.wallet_begin_booking_issue(
    '00000000-0000-0000-0000-000000000008',
    'admin-1', 'admin', 'admin-owner-wallet-issue'
  ) as result
`)).rows[0].result;
assert.equal(adminIssued.ok, true);
assert.equal(adminIssued.staffIssuedForOwner, true);
assert.equal(adminIssued.walletOwnerType, 'agency');
assert.equal(adminIssued.walletOwnerKey, 'ST-B2B000001');
const agencyWalletAfter = (await db.query(`
  select available_balance, hold_balance from public.wallet_balances
   where owner_type = 'agency' and owner_key = 'ST-B2B000001' and currency = 'BDT'
`)).rows[0];
assert.equal(Number(agencyWalletAfter.available_balance), agencyBalanceBefore - 2_280_000);
assert.equal(Number(agencyWalletAfter.hold_balance), 2_280_000);
const adminReserveAudit = (await db.query(`
  select owner_type, owner_key, actor_user_id, actor_role
    from public.wallet_reserve_calls
   where idempotency_key = 'admin-owner-wallet-issue'
`)).rows[0];
assert.deepEqual(adminReserveAudit, {
  owner_type: 'agency',
  owner_key: 'ST-B2B000001',
  actor_user_id: 'admin-1',
  actor_role: 'admin',
});

const userBalanceBeforeSupport = Number((await db.query(`
  select available_balance from public.wallet_balances
   where owner_type = 'user' and owner_key = 'customer-1' and currency = 'BDT'
`)).rows[0].available_balance);
const supportDenied = (await db.query(`
  select public.wallet_begin_booking_issue(
    '00000000-0000-0000-0000-000000000009',
    'support-1', 'staff_support', 'support-owner-wallet-issue'
  ) as result
`)).rows[0].result;
assert.equal(supportDenied.code, 'ISSUE_FORBIDDEN');
const userBalanceAfterSupport = Number((await db.query(`
  select available_balance from public.wallet_balances
   where owner_type = 'user' and owner_key = 'customer-1' and currency = 'BDT'
`)).rows[0].available_balance);
assert.equal(userBalanceAfterSupport, userBalanceBeforeSupport);

const insufficient = (await db.query(`
  select public.wallet_begin_booking_issue(
    '00000000-0000-0000-0000-000000000010',
    'superadmin-1', 'superadmin', 'superadmin-low-wallet-issue'
  ) as result
`)).rows[0].result;
assert.equal(insufficient.code, 'INSUFFICIENT_FUNDS');
const insufficientState = (await db.query(`
  select booking.status, balance.available_balance, balance.hold_balance
    from public.flight_bookings booking
    join public.wallet_balances balance
      on balance.owner_type = booking.booking_owner_type
     and balance.owner_key = booking.booking_owner_key
     and balance.currency = booking.currency
   where booking.id = '00000000-0000-0000-0000-000000000010'
`)).rows[0];
assert.deepEqual(insufficientState, {
  status: 'on-hold', available_balance: 100, hold_balance: 0,
});

const requestNull = (
  await db.query(`
    select public.request_booking_local_time_limit_v1(
      '00000000-0000-0000-0000-000000000001',
      'customer-1', 'customer', 'request-null'
    ) as result
  `)
).rows[0].result;
assert.equal(requestNull.ok, true);
assert.equal(requestNull.state, 'pending');

const requestReplay = (
  await db.query(`
    select public.request_booking_local_time_limit_v1(
      '00000000-0000-0000-0000-000000000001',
      'customer-1', 'customer', 'request-null'
    ) as result
  `)
).rows[0].result;
assert.equal(requestReplay.replay, true);
assert.equal(requestReplay.requestId, requestNull.requestId);

const requestShort = (
  await db.query(`
    select public.request_booking_local_time_limit_v1(
      '00000000-0000-0000-0000-000000000002',
      'agent-1', 'b2b', 'request-short'
    ) as result
  `)
).rows[0].result;
assert.equal(requestShort.ok, true);

const requestNormal = (
  await db.query(`
    select public.request_booking_local_time_limit_v1(
      '00000000-0000-0000-0000-000000000003',
      'customer-1', 'customer', 'request-normal'
    ) as result
  `)
).rows[0].result;
assert.equal(requestNormal.ok, false);
assert.equal(requestNormal.code, 'SUPPLIER_DEADLINE_SUFFICIENT');

const requestRecentlyExpired = (
  await db.query(`
    select public.request_booking_local_time_limit_v1(
      '00000000-0000-0000-0000-000000000006',
      'customer-1', 'customer', 'request-recently-expired'
    ) as result
  `)
).rows[0].result;
assert.equal(requestRecentlyExpired.ok, true);
const recentlyExpiredAudit = (
  await db.query(
    `select request.eligibility_reason,
            event.evidence->>'expiredRequestWindowMinutes' as window_minutes
       from public.booking_local_time_limit_requests request
       join public.booking_local_time_limit_events event
         on event.request_id = request.id and event.event_type = 'requested'
      where request.id = $1::uuid`,
    [requestRecentlyExpired.requestId]
  )
).rows[0];
assert.equal(
  recentlyExpiredAudit.eligibility_reason,
  'supplier_deadline_expired_under_3_hours'
);
assert.equal(recentlyExpiredAudit.window_minutes, '180');

for (const [bookingId, requestKey] of [
  ['00000000-0000-0000-0000-000000000005', 'request-old-expired'],
  ['00000000-0000-0000-0000-000000000007', 'request-expiry-boundary'],
]) {
  const expiredRequest = (
    await db.query(
      `select public.request_booking_local_time_limit_v1(
         $1::uuid, 'customer-1', 'customer', $2
       ) as result`,
      [bookingId, requestKey]
    )
  ).rows[0].result;
  assert.equal(expiredRequest.ok, false);
  assert.equal(expiredRequest.code, 'LOCAL_TIME_LIMIT_REQUEST_WINDOW_EXPIRED');
}

await assert.rejects(
  db.query(`
    insert into public.booking_local_time_limit_requests (
      booking_id, eligibility_reason, requested_by_user_id,
      requested_by_role, request_key
    ) values (
      '00000000-0000-0000-0000-000000000005',
      'supplier_deadline_expired_under_3_hours',
      'customer-1', 'customer', 'direct-insert-old-expired'
    )
  `),
  /expired at least 3 hours ago/
);

const unauthorized = (
  await db.query(`
    select public.request_booking_local_time_limit_v1(
      '00000000-0000-0000-0000-000000000002',
      'customer-1', 'customer', 'request-wrong-owner'
    ) as result
  `)
).rows[0].result;
assert.equal(unauthorized.code, 'REQUEST_FORBIDDEN');

for (const invalidMinutes of [0, -1, 7.5, 31]) {
  const invalidDecision = (
    await db.query(
      `select public.decide_booking_local_time_limit_v1(
         '00000000-0000-0000-0000-000000000001', $1::uuid, 1,
         'support-1', 'approve', $2::numeric,
         'Invalid minute value must be rejected in the database.'
       ) as result`,
      [requestNull.requestId, invalidMinutes]
    )
  ).rows[0].result;
  assert.equal(invalidDecision.ok, false);
  assert.equal(invalidDecision.code, 'INVALID_GRANT_MINUTES');
}

const approved = (
  await db.query(
    `select public.decide_booking_local_time_limit_v1(
       '00000000-0000-0000-0000-000000000001', $1::uuid, 1,
       'support-1', 'approve', 7, 'Verified live and unticketed in supplier portal.'
     ) as result`,
    [requestNull.requestId]
  )
).rows[0].result;
assert.equal(approved.ok, true);
assert.equal(approved.grantedMinutes, 7);

const approvalInterval = Number(
  (
    await db.query(
      `select extract(epoch from (approved_deadline_at - decided_at))::integer
                as seconds
         from public.booking_local_time_limit_requests
        where id = $1::uuid`,
      [requestNull.requestId]
    )
  ).rows[0].seconds
);
assert.equal(approvalInterval, 7 * 60);

const approvedBooking = (
  await db.query(`
    select supplier_ticketing_deadline_at, local_ticketing_deadline_at,
           ticketing_deadline_at, deadline_source,
           active_local_time_limit_request_id
      from public.flight_bookings
     where id = '00000000-0000-0000-0000-000000000001'
  `)
).rows[0];
assert.equal(approvedBooking.supplier_ticketing_deadline_at, null);
assert.ok(approvedBooking.local_ticketing_deadline_at);
assert.equal(
  approvedBooking.ticketing_deadline_at.toISOString(),
  approvedBooking.local_ticketing_deadline_at.toISOString()
);
assert.equal(approvedBooking.deadline_source, 'local_approved');
assert.equal(
  approvedBooking.active_local_time_limit_request_id,
  requestNull.requestId
);

const issued = (
  await db.query(`
    select public.wallet_begin_booking_issue(
      '00000000-0000-0000-0000-000000000001',
      'customer-1', 'customer', 'issue-after-local-grant'
    ) as result
  `)
).rows[0].result;
assert.equal(issued.ok, true);
assert.equal(issued.heldAmount, 2_280_000);

const requestCancel = (
  await db.query(`
    select public.request_booking_local_time_limit_v1(
      '00000000-0000-0000-0000-000000000004',
      'customer-1', 'customer', 'request-cancel'
    ) as result
  `)
).rows[0].result;
const approvedCancel = (
  await db.query(
    `select public.decide_booking_local_time_limit_v1(
       '00000000-0000-0000-0000-000000000004', $1::uuid, 1,
       'support-1', 'approve', 1, 'Verified live for cancellation.'
     ) as result`,
    [requestCancel.requestId]
  )
).rows[0].result;
assert.equal(approvedCancel.ok, true);
const cancelled = (
  await db.query(`
    select public.begin_booking_cancellation(
      '00000000-0000-0000-0000-000000000004',
      'customer-1', 'cancel-after-local-grant'
    ) as result
  `)
).rows[0].result;
assert.equal(cancelled.ok, true);

await db.exec(`
  update public.flight_bookings set
    status = 'on-hold', operation_kind = null, operation_reason = null,
    operation_request_id = null, operation_actor_user_id = null,
    operation_started_at = null, operation_prior_status = null,
    local_ticketing_deadline_at = clock_timestamp() - interval '1 second'
  where id = '00000000-0000-0000-0000-000000000004';
`);
const expiredIssue = (
  await db.query(`
    select public.wallet_begin_booking_issue(
      '00000000-0000-0000-0000-000000000004',
      'customer-1', 'customer', 'issue-after-local-expiry'
    ) as result
  `)
).rows[0].result;
assert.equal(expiredIssue.code, 'BOOKING_EXPIRED');

const observationsBefore = Number(
  (
    await db.query(`
      select count(*)::integer as count
      from public.booking_deadline_observations
      where booking_id = '00000000-0000-0000-0000-000000000002'
    `)
  ).rows[0].count
);
await db.query(`
  select public.record_booking_pnr_refresh_v3(
    '00000000-0000-0000-0000-000000000002',
    'support-1', 'staff_support', 'ordinary_sync', 'booked',
    '["PNR-SHORT"]'::jsonb, null, null,
    '{"fixture":"explicit-null"}'::jsonb
  )
`);
await db.query(`
  select public.record_booking_pnr_refresh_v3(
    '00000000-0000-0000-0000-000000000002',
    'support-1', 'staff_support', 'ordinary_sync', 'booked',
    '["PNR-SHORT"]'::jsonb, null, null,
    '{"fixture":"explicit-null"}'::jsonb
  )
`);
const observationsAfter = Number(
  (
    await db.query(`
      select count(*)::integer as count
      from public.booking_deadline_observations
      where booking_id = '00000000-0000-0000-0000-000000000002'
    `)
  ).rows[0].count
);
assert.equal(observationsAfter, observationsBefore + 1);

const approvedShort = (
  await db.query(
    `select public.decide_booking_local_time_limit_v1(
       '00000000-0000-0000-0000-000000000002', $1::uuid, 1,
       'support-1', 'approve', 30, 'Verified live after explicit-null refresh.'
     ) as result`,
    [requestShort.requestId]
  )
).rows[0].result;
assert.equal(approvedShort.ok, true);
await db.query(`
  select public.record_booking_pnr_refresh_v3(
    '00000000-0000-0000-0000-000000000002',
    'support-1', 'staff_support', 'ordinary_sync', 'booked',
    '["PNR-SHORT"]'::jsonb, 'normal-after-refresh',
    clock_timestamp() + interval '30 minutes',
    '{"fixture":"supplier-now-sufficient"}'::jsonb
  )
`);
const superseded = (
  await db.query(
    `select request.state, booking.active_local_time_limit_request_id,
            booking.ticketing_deadline_at,
            booking.supplier_ticketing_deadline_at,
            booking.local_ticketing_deadline_at
       from public.booking_local_time_limit_requests request
       join public.flight_bookings booking on booking.id = request.booking_id
      where request.id = $1::uuid`,
    [requestShort.requestId]
  )
).rows[0];
assert.equal(superseded.state, 'superseded');
assert.equal(superseded.active_local_time_limit_request_id, null);
assert.equal(
  superseded.ticketing_deadline_at.toISOString(),
  superseded.supplier_ticketing_deadline_at.toISOString()
);
assert.ok(superseded.local_ticketing_deadline_at);

await db.close();
console.log(
  'Local time-limit verification passed: NULL/<15 eligibility, less-than-3-hours-expired eligibility, exact/older 3-hour database rejection, duration-free user requests, custom integer 1-30 staff grants, database-time deadlines, issue/cancel use, wallet preservation, and idempotent supplier evidence.'
);
