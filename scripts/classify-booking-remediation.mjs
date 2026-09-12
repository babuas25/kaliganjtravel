import { createHash } from 'node:crypto';
import {
  chmodSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const CATEGORIES = [
  'held/unpaid',
  'ticketed/paid',
  'ticketed/unpaid',
  'cancelled/unpaid',
  'cancelled/captured',
  'unknown',
  'wallet/ledger mismatch',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hasNonemptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

const backupDirectory = path.resolve('backups');
const snapshotName = readdirSync(backupDirectory)
  .filter((name) => /^booking-remediation-\d{4}-.*\.json$/.test(name))
  .sort()
  .at(-1);
assert(snapshotName, 'A protected remediation snapshot is required.');
const snapshotPath = path.join(backupDirectory, snapshotName);
const snapshotPayload = readFileSync(snapshotPath, 'utf8');
const snapshot = JSON.parse(snapshotPayload);
assert(
  snapshot.format === 'kaliganj-travels-booking-remediation-snapshot-v1',
  'Unsupported remediation snapshot.'
);

const reservationsByBooking = new Map();
for (const reservation of snapshot.tables.wallet_reservations) {
  if (reservation.booking_id) reservationsByBooking.set(reservation.booking_id, reservation);
}
const ledgerByBooking = new Map();
for (const entry of snapshot.tables.wallet_ledger_entries) {
  if (!entry.booking_id) continue;
  const entries = ledgerByBooking.get(entry.booking_id) ?? [];
  entries.push(entry);
  ledgerByBooking.set(entry.booking_id, entries);
}

function walletMismatch(booking) {
  const reservation = reservationsByBooking.get(booking.id);
  const ledger = ledgerByBooking.get(booking.id) ?? [];
  const captures = ledger.filter((entry) => entry.transaction_type === 'booking_confirm');
  if (booking.payment_state === 'captured') {
    if (!reservation || reservation.state !== 'captured') return true;
    if (
      Number(reservation.amount) !== Number(booking.captured_amount) ||
      reservation.currency !== booking.currency
    ) {
      return true;
    }
    if (
      captures.length !== 1 ||
      Number(captures[0].amount) !== Number(booking.captured_amount) ||
      captures[0].currency !== booking.currency
    ) {
      return true;
    }
  }
  return Number(booking.refunded_amount) > Number(booking.captured_amount);
}

function classifyBooking(booking) {
  const evidenceGaps = [];
  if (booking.status === 'cancelled' && !booking.cancelled_at) {
    evidenceGaps.push('authoritative_cancellation_time');
  }
  if (walletMismatch(booking)) {
    return {
      classification: 'wallet/ledger mismatch',
      evidenceGaps: [...evidenceGaps, 'wallet_ledger_equation'],
      requiredNextAction: 'admin_accounts_reconciliation',
    };
  }
  if (booking.status === 'confirmed') {
    if (!hasNonemptyArray(booking.ticket_numbers) && !booking.ticket_code_ref) {
      return {
        classification: 'unknown',
        evidenceGaps: [...evidenceGaps, 'complete_ticket_evidence'],
        requiredNextAction: 'fresh_supplier_ticket_evidence',
      };
    }
    return booking.payment_state === 'captured'
      ? {
          classification: 'ticketed/paid',
          evidenceGaps,
          requiredNextAction: 'verify_no_change_or_close',
        }
      : {
          classification: 'ticketed/unpaid',
          evidenceGaps: [...evidenceGaps, 'approved_financial_disposition'],
          requiredNextAction: 'external_settlement_or_approved_charge',
        };
  }
  if (booking.status === 'cancelled') {
    return Number(booking.captured_amount) > Number(booking.refunded_amount)
      ? {
          classification: 'cancelled/captured',
          evidenceGaps: [...evidenceGaps, 'approved_refund_or_fee_disposition'],
          requiredNextAction: 'fresh_cancellation_and_financial_evidence',
        }
      : {
          classification: 'cancelled/unpaid',
          evidenceGaps,
          requiredNextAction: evidenceGaps.length
            ? 'fresh_authoritative_cancellation_evidence'
            : 'verify_no_change_or_close',
        };
  }
  if (
    booking.status === 'on-hold' &&
    booking.payment_state === 'unpaid' &&
    hasNonemptyArray(booking.airlines_pnr)
  ) {
    return {
      classification: 'held/unpaid',
      evidenceGaps,
      requiredNextAction: 'verify_hold_or_expiry',
    };
  }
  return {
    classification: 'unknown',
    evidenceGaps: [...evidenceGaps, 'fresh_supplier_lifecycle_evidence'],
    requiredNextAction: 'controlled_supplier_evidence_read',
  };
}

const classifications = snapshot.tables.flight_bookings.map((booking) => ({
  subjectType: 'booking',
  subjectId: booking.id,
  publicReference: booking.public_ref,
  ...classifyBooking(booking),
}));
const bookingAttemptIds = new Set(
  snapshot.tables.flight_bookings.map((booking) => booking.attempt_id).filter(Boolean)
);
for (const attempt of snapshot.tables.booking_attempts) {
  if (bookingAttemptIds.has(attempt.id)) continue;
  classifications.push({
    subjectType: 'booking_attempt',
    subjectId: attempt.id,
    publicReference: null,
    classification: 'unknown',
    evidenceGaps: ['authoritative_supplier_outcome'],
    requiredNextAction: 'attempt_reconciliation_evidence_plan',
  });
}

for (const item of classifications) {
  assert(CATEGORIES.includes(item.classification), 'Unsupported classification.');
}
const counts = Object.fromEntries(
  CATEGORIES.map((category) => [
    category,
    classifications.filter((item) => item.classification === category).length,
  ])
);
const manifest = {
  format: 'kaliganj-travels-booking-remediation-classification-v1',
  createdAt: new Date().toISOString(),
  sourceSnapshot: {
    filename: snapshotName,
    sha256: sha256(snapshotPayload),
  },
  categories: CATEGORIES,
  counts,
  classifications,
};
const payload = JSON.stringify(manifest, null, 2);
const target = path.join(
  backupDirectory,
  `booking-remediation-classification-${manifest.createdAt.replace(/[:.]/g, '-')}.json`
);
writeFileSync(target, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
try {
  chmodSync(target, 0o600);
} catch {
  // Windows ACLs remain authoritative; backups/ is git-ignored.
}

console.log(
  JSON.stringify(
    {
      format: manifest.format,
      createdAt: manifest.createdAt,
      target,
      sha256: sha256(payload),
      sourceSnapshotSha256: manifest.sourceSnapshot.sha256,
      classifiedSubjects: classifications.length,
      counts,
      subjectIdentifiersPrinted: false,
      productionMutations: false,
    },
    null,
    2
  )
);
