import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function loadEnvFile(path) {
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] ??= value;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectedDeadline(value, carrierCode, deadlineSource) {
  const supplierMatch =
    /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(
      value.trim()
    );
  const normalizedMatch =
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(
      value.trim()
    );
  const match = supplierMatch ?? normalizedMatch;
  if (!match) return null;
  // Triplover's PNR endpoint is carrier-specific: US-Bangla (BS) returns
  // MM/DD/YYYY, while the other validated carriers return DD/MM/YYYY. The
  // Booking response is a different source and retains its existing order.
  const firstPart = supplierMatch ? Number(match[1]) : 0;
  const secondPart = supplierMatch ? Number(match[2]) : 0;
  const monthFirstPnr =
    deadlineSource === 'pnr_call' &&
    (secondPart > 12 ||
      (firstPart <= 12 &&
        secondPart <= 12 &&
        carrierCode?.trim().toUpperCase() === 'BS'));
  const [year, month, day, hour, minute, second] = supplierMatch
    ? monthFirstPnr
      ? [match[3], match[1], match[2], match[4], match[5], match[6]]
      : [match[3], match[2], match[1], match[4], match[5], match[6]]
    : [match[1], match[2], match[3], match[4], match[5], match[6]];
  return new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ) -
      6 * 3_600_000
  ).toISOString();
}

assert(
  expectedDeadline('08/09/2026 03:00:45', 'BS', 'pnr_call') ===
    '2026-08-08T21:00:45.000Z',
  'US-Bangla PNR verifier fixture must use MM/DD/YYYY'
);
assert(
  expectedDeadline('08/09/2026 03:00:45', 'BG', 'pnr_call') ===
    '2026-09-07T21:00:45.000Z',
  'Non-BS PNR verifier fixture must remain DD/MM/YYYY'
);
assert(
  expectedDeadline('08/09/2026 03:00:45', 'BS', 'supplier') ===
    '2026-09-07T21:00:45.000Z',
  'Booking-response deadline order must not be changed by the BS PNR rule'
);

loadEnvFile(existsSync('.env.local') ? '.env.local' : 'env.local');

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
assert(url && serviceKey, 'Supabase verification credentials are missing');

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const anonymous = anonKey
  ? createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

assert(
  !existsSync('app/api/verify-plan-tmp/route.ts'),
  'Temporary verification route still exists'
);

const { data: bookings, error: bookingsError } = await admin
  .from('flight_bookings')
  .select(
    'id,attempt_id,legacy_operational,status,public_ref,created_at,updated_at,itinerary,ticketing_time_limit,ticketing_deadline_at,deadline_source'
  )
  .order('created_at', { ascending: true });
if (bookingsError) throw bookingsError;

const { data: attempts, error: attemptsError } = await admin
  .from('booking_attempts')
  .select('id,state');
if (attemptsError) throw attemptsError;

const { data: counters, error: countersError } = await admin
  .from('booking_ref_counters')
  .select('ref_date,last_value')
  .order('ref_date');
if (countersError) throw countersError;

const attemptById = new Map(attempts.map((row) => [row.id, row]));
const legacy = bookings.filter((row) => row.legacy_operational);
const business = bookings.filter((row) => !row.legacy_operational);
const refs = new Set();
const maxByDate = new Map();
const prunedLegacyAttemptIds = [];
const now = Date.now();

function isMissingAttemptAllowedByRetention(row) {
  const createdAt = Date.parse(row.created_at);
  const resolvedAt = Date.parse(row.updated_at ?? row.created_at);
  return (
    (row.status === 'draft' && now - createdAt > 7 * 86_400_000) ||
    (row.status === 'failed' && now - resolvedAt > 90 * 86_400_000)
  );
}

for (const row of legacy) {
  assert(
    ['draft', 'submitting', 'held', 'ticketed', 'failed', 'unknown'].includes(
      row.status
    ),
    `Legacy row ${row.id} has a business-only status`
  );
  if (!attemptById.has(row.id)) {
    assert(
      isMissingAttemptAllowedByRetention(row),
      `Legacy row ${row.id} has no copied attempt and is not eligible for retention pruning`
    );
    prunedLegacyAttemptIds.push(row.id);
  }
  assert(row.public_ref === null, `Legacy row ${row.id} consumed a public ref`);
}

for (const row of business) {
  assert(
    ['on-hold', 'pending', 'in-progress', 'confirmed', 'cancelled'].includes(
      row.status
    ),
    `Business row ${row.id} has an invalid stored status`
  );
  assert(row.attempt_id, `Business row ${row.id} has no attempt_id`);
  assert(
    attemptById.get(row.attempt_id)?.state === 'succeeded',
    `Business row ${row.id} does not have a succeeded attempt`
  );
  assert(
    /^STR\d{12}$/.test(row.public_ref ?? ''),
    `Business row ${row.id} has an invalid public_ref`
  );
  assert(!refs.has(row.public_ref), `Duplicate public_ref ${row.public_ref}`);
  refs.add(row.public_ref);

  const date = `20${row.public_ref.slice(3, 5)}-${row.public_ref.slice(5, 7)}-${row.public_ref.slice(7, 9)}`;
  const sequence = Number(row.public_ref.slice(9));
  maxByDate.set(date, Math.max(maxByDate.get(date) ?? 0, sequence));

  const ttl = row.ticketing_time_limit?.trim() ?? '';
  if (
    ['local_approved', 'superadmin_override', 'assumed'].includes(
      row.deadline_source
    )
  ) {
    assert(
      row.ticketing_deadline_at !== null,
      `Business row ${row.id} has local deadline authority without an effective deadline`
    );
    continue;
  }
  if (!ttl) {
    assert(
      row.ticketing_deadline_at === null && row.deadline_source === null,
      `Business row ${row.id} invented a supplier deadline`
    );
  } else {
    const carrierCode =
      row.itinerary && typeof row.itinerary === 'object'
        ? row.itinerary.carrierCode
        : null;
    const expected = expectedDeadline(
      ttl,
      typeof carrierCode === 'string' ? carrierCode : null,
      row.deadline_source
    );
    assert(expected, `Verifier does not understand deadline ${ttl}`);
    assert(
      new Date(row.ticketing_deadline_at).toISOString() === expected,
      `Business row ${row.id} has an incorrectly parsed deadline`
    );
    assert(
      ['supplier', 'pnr_call'].includes(row.deadline_source),
      `Business row ${row.id} has an unsupported deadline source`
    );
  }
}

for (const counter of counters) {
  assert(
    maxByDate.get(counter.ref_date) === counter.last_value,
    `Counter ${counter.ref_date} does not match allocated references`
  );
}
assert(
  counters.length === maxByDate.size,
  'Reference counters and allocated reference dates differ'
);

assert(business.length > 0, 'No business booking is available for replay test');
const replayTarget = business[0];
const countersBeforeReplay = JSON.stringify(counters);
const { data: replayed, error: replayError } = await admin.rpc(
  'create_booking_from_attempt',
  { p_attempt_id: replayTarget.attempt_id, p_outcome: {} }
);
if (replayError) throw replayError;
const replayedRow = Array.isArray(replayed) ? replayed[0] : replayed;
assert(replayedRow?.id === replayTarget.id, 'Replay returned a different booking');
assert(
  replayedRow?.public_ref === replayTarget.public_ref,
  'Replay allocated a different public reference'
);

const { data: countersAfter, error: countersAfterError } = await admin
  .from('booking_ref_counters')
  .select('ref_date,last_value')
  .order('ref_date');
if (countersAfterError) throw countersAfterError;
assert(
  JSON.stringify(countersAfter) === countersBeforeReplay,
  'Idempotent replay changed a reference counter'
);

let anonymousExecuteDenied = 'not-run-no-anon-key';
if (anonymous) {
  const { error: anonymousRpcError } = await anonymous.rpc(
    'create_booking_from_attempt',
    { p_attempt_id: randomUUID(), p_outcome: {} }
  );
  assert(
    anonymousRpcError,
    'Anonymous role can execute create_booking_from_attempt'
  );
  anonymousExecuteDenied = true;
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      legacyRowsRetained: legacy.length,
      legacyAttemptsPrunedByPolicy: prunedLegacyAttemptIds.length,
      prunedLegacyAttemptIds,
      businessBookings: business.length,
      attempts: attempts.length,
      publicReferences: refs.size,
      deadlineRows: business.filter((row) => row.ticketing_deadline_at).length,
      idempotentReplay: true,
      anonymousExecuteDenied,
    },
    null,
    2
  )
);
