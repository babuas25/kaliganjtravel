import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { createClient } from '@supabase/supabase-js';

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function tableHash(rows) {
  return sha256(JSON.stringify(rows));
}

loadEnvFile('.env.local');
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(url && serviceKey, 'Supabase read credentials are missing.');

const admin = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function readAll(table, orderColumn = 'id') {
  const rows = [];
  for (let offset = 0; ; offset += 1_000) {
    const { data, error } = await admin
      .from(table)
      .select('*')
      .order(orderColumn, { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`Could not read ${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1_000) return rows;
  }
}

const bookingInventoryResult = await admin
  .from('flight_bookings')
  .select(
    'id,public_ref,attempt_id,status,payment_state,captured_amount,refunded_amount,import_source,cancelled_at,operation_kind,legacy_operational'
  )
  .eq('legacy_operational', false)
  .order('id');
if (bookingInventoryResult.error) throw bookingInventoryResult.error;

const reasonCounts = new Map();
const affectedBookingIds = new Set();
for (const booking of bookingInventoryResult.data ?? []) {
  const reasons = [];
  if (booking.status === 'in-progress') reasons.push('in_progress_reconciliation');
  if (booking.public_ref === 'STR260805000006') reasons.push('named_captured_cancel');
  if (booking.status === 'cancelled' && !booking.cancelled_at) {
    reasons.push('cancelled_timestamp_missing');
  }
  if (
    booking.status === 'confirmed' &&
    booking.payment_state === 'unpaid' &&
    booking.import_source === 'IMP_EXP'
  ) {
    reasons.push('imported_confirmed_unpaid');
  }
  if (booking.status === 'pending') reasons.push('historical_pending');
  if (
    (booking.status === 'confirmed' && booking.payment_state !== 'captured') ||
    (booking.status === 'cancelled' &&
      ['captured', 'reconciliation'].includes(booking.payment_state))
  ) {
    reasons.push('terminal_financial_disagreement');
  }
  if (reasons.length === 0) continue;
  affectedBookingIds.add(booking.id);
  for (const reason of new Set(reasons)) {
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
}

const attemptInventoryResult = await admin
  .from('booking_attempts')
  .select('id,state,created_at,submitted_at')
  .order('id');
if (attemptInventoryResult.error) throw attemptInventoryResult.error;
const staleBefore = Date.now() - 15 * 60 * 1_000;
const affectedAttemptIds = new Set(
  (attemptInventoryResult.data ?? [])
    .filter((attempt) => {
      if (!['submitting', 'unknown'].includes(attempt.state)) return false;
      const startedAt = attempt.submitted_at ?? attempt.created_at;
      return typeof startedAt === 'string' && Date.parse(startedAt) <= staleBefore;
    })
    .map((attempt) => attempt.id)
);

for (const booking of bookingInventoryResult.data ?? []) {
  if (affectedBookingIds.has(booking.id) && booking.attempt_id) {
    affectedAttemptIds.add(booking.attempt_id);
  }
}

const [allBookings, allAttempts, allReservations, allLedger, allEvents, allDeliveries] =
  await Promise.all([
    readAll('flight_bookings'),
    readAll('booking_attempts'),
    readAll('wallet_reservations'),
    readAll('wallet_ledger_entries'),
    readAll('booking_status_events'),
    readAll('booking_status_email_deliveries', 'booking_id'),
  ]);

const bookings = allBookings.filter((row) => affectedBookingIds.has(row.id));
const attempts = allAttempts.filter((row) => affectedAttemptIds.has(row.id));
const reservations = allReservations.filter(
  (row) =>
    affectedBookingIds.has(row.booking_id) ||
    affectedAttemptIds.has(row.booking_attempt_id)
);
const reservationIds = new Set(reservations.map((row) => row.id));
const ledgerEntries = allLedger.filter(
  (row) =>
    affectedBookingIds.has(row.booking_id) || reservationIds.has(row.reservation_id)
);
const events = allEvents.filter((row) => affectedBookingIds.has(row.booking_id));
const emailDeliveries = allDeliveries.filter((row) =>
  affectedBookingIds.has(row.booking_id)
);
const walletAccountIds = new Set([
  ...bookings.map((row) => row.charged_wallet_account_id).filter(Boolean),
  ...reservations.map((row) => row.wallet_account_id).filter(Boolean),
  ...ledgerEntries.map((row) => row.wallet_account_id).filter(Boolean),
]);
const allAccounts = await readAll('wallet_accounts');
const walletAccounts = allAccounts.filter((row) => walletAccountIds.has(row.id));
const walletIds = new Set(walletAccounts.map((row) => row.wallet_id));
const wallets = (await readAll('wallets')).filter((row) => walletIds.has(row.id));

const tables = {
  flight_bookings: bookings,
  booking_attempts: attempts,
  wallet_reservations: reservations,
  wallet_accounts: walletAccounts,
  wallets,
  wallet_ledger_entries: ledgerEntries,
  booking_status_events: events,
  booking_status_email_deliveries: emailDeliveries,
};
const snapshot = {
  format: 'kaliganj-travels-booking-remediation-snapshot-v1',
  createdAt: new Date().toISOString(),
  schemaAuthority:
    'linked production through migration 0042; local lifecycle migrations 0043-0081 unapplied',
  selectionPolicy: {
    bookingReasons: Object.fromEntries([...reasonCounts].sort()),
    staleAttemptStates: ['submitting', 'unknown'],
    staleAttemptThresholdMinutes: 15,
  },
  tableHashes: Object.fromEntries(
    Object.entries(tables).map(([table, rows]) => [table, tableHash(rows)])
  ),
  tables,
};
const payload = JSON.stringify(snapshot, null, 2);
const stamp = snapshot.createdAt.replace(/[:.]/g, '-');
const backupDirectory = path.resolve('backups');
const target = path.join(
  backupDirectory,
  `booking-remediation-${stamp}.json`
);
mkdirSync(backupDirectory, { recursive: true });
writeFileSync(target, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
try {
  chmodSync(target, 0o600);
} catch {
  // Windows ACLs remain authoritative; the directory is git-ignored either way.
}

console.log(
  JSON.stringify(
    {
      snapshotFormat: snapshot.format,
      createdAt: snapshot.createdAt,
      target,
      sha256: sha256(payload),
      affectedBookings: affectedBookingIds.size,
      affectedAttempts: affectedAttemptIds.size,
      reasons: snapshot.selectionPolicy.bookingReasons,
      rows: Object.fromEntries(
        Object.entries(tables).map(([table, rows]) => [table, rows.length])
      ),
      sensitiveRowsPrinted: false,
      productionMutations: false,
    },
    null,
    2
  )
);
