import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

function simulateKeysetDrain(rowCount) {
  const eligible = [];
  for (let id = 1; id <= rowCount; id += 1) {
    const due = id > 1_000 && id % 11 === 0;
    const alreadyObserved = id % 13 === 0;
    if (due && !alreadyObserved) {
      eligible.push({ deadline: id % 10_000, id });
    }
  }
  eligible.sort((left, right) =>
    left.deadline === right.deadline
      ? left.id - right.id
      : left.deadline - right.deadline
  );

  // The retired algorithm repeatedly limited the first 500 broad rows, all of
  // which are intentionally ineligible in this fixture.
  const legacyFirst500Inserted = 0;
  const seen = new Set();
  let cursor = 0;
  let batches = 0;
  while (cursor < eligible.length) {
    const page = eligible.slice(cursor, cursor + 250);
    for (const row of page) seen.add(row.id);
    cursor += page.length;
    batches += 1;
  }
  assert.equal(legacyFirst500Inserted, 0);
  assert.equal(seen.size, eligible.length);
  assert.ok(eligible.length > 500);
  return { rowCount, eligible: eligible.length, batches };
}

const thousands = simulateKeysetDrain(10_000);
const millions = simulateKeysetDrain(1_000_000);

const db = new PGlite();
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create table public.flight_bookings (
    id uuid primary key,
    status text not null,
    legacy_operational boolean not null default false,
    active_operation_id uuid,
    operation_kind text,
    operation_reason text,
    airlines_pnr jsonb,
    ticketing_deadline_at timestamptz,
    import_source text,
    synced_at timestamptz,
    import_metadata jsonb
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
    effective_at timestamptz,
    observed_at timestamptz,
    event_snapshot jsonb not null default '{}'::jsonb
  );
  create unique index booking_status_events_idempotency_idx
    on public.booking_status_events (
      booking_id, idempotency_key, to_lifecycle_status
    ) where idempotency_key is not null;
  create index booking_status_events_booking_id_idx
    on public.booking_status_events (booking_id, id desc);
  create or replace function public.jsonb_is_nonempty_array(p_value jsonb)
  returns boolean language sql immutable as $$
    select case when jsonb_typeof(p_value) = 'array'
      then jsonb_array_length(p_value) > 0 else false end
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
        and p_ticketing_deadline_at <= clock_timestamp()
        then 'expired'
      else 'on-hold'
    end
  $$;
  create or replace function public.touch_updated_at()
  returns trigger language plpgsql as $$
  begin
    new.updated_at := clock_timestamp();
    return new;
  end
  $$;
`);
await db.exec(
  read('supabase', 'migrations', '0076_booking_due_deadline_index.sql')
);
await db.exec(
  read('supabase', 'migrations', '0077_booking_due_expiry_observation.sql')
);
await db.exec(
  read('supabase', 'migrations', '0078_booking_expiry_keyset_pagination.sql')
);
await db.exec(
  read('supabase', 'migrations', '0079_booking_expiry_worker_runs.sql')
);
await db.exec(
  read('supabase', 'migrations', '0080_booking_unconfirmed_observation_paths.sql')
);
await db.exec(
  read('supabase', 'migrations', '0081_booking_derived_lifecycle_metrics.sql')
);
await db.exec(`
  insert into public.flight_bookings (
    id, status, legacy_operational, active_operation_id, operation_kind,
    airlines_pnr, ticketing_deadline_at
  )
  select
    md5(series::text)::uuid,
    case when series > 90000 then 'on-hold' else 'confirmed' end,
    false,
    null,
    null,
    case when series > 90000 then '["PNR"]'::jsonb else '[]'::jsonb end,
    case when series > 90000
      then clock_timestamp() - interval '2 hours'
        + ((series - 90001) * interval '1 millisecond')
      else null
    end
  from generate_series(1, 100000) series;

  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, supplier_operation,
    idempotency_key, effective_at, observed_at
  )
  select
    md5(series::text)::uuid, 'on-hold', 'expired',
    'on-hold', 'on-hold', 'LifecycleSweep',
    'seed-expired:' || series,
    clock_timestamp() - interval '2 hours',
    clock_timestamp() - interval '1 hour'
  from generate_series(90001, 92000) series;
  analyze public.flight_bookings;
  analyze public.booking_status_events;
  set enable_seqscan = off;
`);

const planResult = await db.query(`
  explain (format json)
  select booking.id, booking.ticketing_deadline_at
  from public.flight_bookings booking
  left join lateral (
    select event.to_lifecycle_status
    from public.booking_status_events event
    where event.booking_id = booking.id
    order by event.id desc
    limit 1
  ) latest_event on true
  where not booking.legacy_operational
    and booking.status = 'on-hold'
    and booking.active_operation_id is null
    and booking.operation_kind is null
    and booking.ticketing_deadline_at is not null
    and booking.ticketing_deadline_at <= clock_timestamp()
    and public.jsonb_is_nonempty_array(booking.airlines_pnr)
    and coalesce(latest_event.to_lifecycle_status, 'on-hold') <> 'expired'
  order by booking.ticketing_deadline_at, booking.id
  limit 250
  for update of booking skip locked
`);
const planText = JSON.stringify(planResult.rows);
assert.ok(
  planText.includes('flight_bookings_due_expiry_observation_idx'),
  `Expected partial expiry index in plan: ${planText}`
);
assert.ok(
  planText.includes('booking_status_events_booking_id_idx'),
  `Expected latest-event index in plan: ${planText}`
);

const firstResult = await db.query(
  `select public.record_due_booking_expiry_observation_batch_v1(
    null, null, 250
  ) as batch`
);
const first = firstResult.rows[0].batch;
assert.equal(Number(first.selectedCount), 250);
assert.equal(Number(first.insertedCount), 250);
assert.equal(first.hasMore, true);
assert.ok(first.nextDeadline && first.nextId);

const secondResult = await db.query(
  `select public.record_due_booking_expiry_observation_batch_v1(
    $1::timestamptz, $2::uuid, 250
  ) as batch`,
  [first.nextDeadline, first.nextId]
);
const second = secondResult.rows[0].batch;
assert.equal(Number(second.selectedCount), 250);
assert.equal(Number(second.insertedCount), 250);
assert.notEqual(second.nextId, first.nextId);

const concurrentResults = await Promise.all([
  db.query(`select public.record_due_booking_expiry_observation_batch_v1(
    null, null, 250
  ) as batch`),
  db.query(`select public.record_due_booking_expiry_observation_batch_v1(
    null, null, 250
  ) as batch`),
]);
assert.equal(
  concurrentResults.reduce(
    (sum, result) => sum + Number(result.rows[0].batch.insertedCount),
    0
  ),
  500
);

const insertedResult = await db.query(`
  select
    count(*)::integer as count,
    count(distinct idempotency_key)::integer as distinct_count
  from public.booking_status_events
  where idempotency_key like 'derived-expired:v1:%'
`);
assert.equal(insertedResult.rows[0].count, 1000);
assert.equal(insertedResult.rows[0].distinct_count, 1000);
await db.close();

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      synthetic: { thousands, millions },
      sqlFixtureRows: 100000,
      sqlPreviouslyObservedRows: 2000,
      sqlKeysetRowsInserted: 1000,
      overlappingWorkerCallsInsertedWithoutDuplicates: 500,
      queryPlanUsesDuePartialIndex: true,
      queryPlanUsesLatestEventIndex: true,
      oldest500StarvationReproduced: true,
      keysetStarvation: false,
    },
    null,
    2
  )
);
