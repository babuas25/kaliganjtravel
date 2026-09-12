import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const script = fs.readFileSync(
  path.join(process.cwd(), 'scripts', 'snapshot-booking-remediation.mjs'),
  'utf8'
);
const gitignore = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8');

for (const table of [
  'flight_bookings',
  'booking_attempts',
  'wallet_reservations',
  'wallet_accounts',
  'wallets',
  'wallet_ledger_entries',
  'booking_status_events',
  'booking_status_email_deliveries',
]) {
  assert.ok(script.includes(table), `Remediation snapshot omits ${table}`);
}
for (const required of [
  'kaliganj-travels-booking-remediation-snapshot-v1',
  'tableHashes',
  "mode: 0o600",
  "path.resolve('backups')",
  "sensitiveRowsPrinted: false",
  "productionMutations: false",
]) {
  assert.ok(script.includes(required), `Snapshot safety omits ${required}`);
}
assert.match(gitignore, /^backups\/$/m, 'Sensitive snapshots must be git-ignored');
assert.doesNotMatch(
  script,
  /\.from\s*\([^)]*\)[\s\S]{0,240}\.(?:insert|update|delete|upsert)\s*\(|admin\.rpc\s*\(/,
  'Snapshot script must be read-only'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      tables: 8,
      readOnly: true,
      outputGitIgnored: true,
      outputMode: '0600 where supported',
      consoleContainsSensitiveRows: false,
    },
    null,
    2
  )
);
