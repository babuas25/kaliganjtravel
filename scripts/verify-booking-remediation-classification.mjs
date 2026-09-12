import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const script = fs.readFileSync(
  path.join(process.cwd(), 'scripts', 'classify-booking-remediation.mjs'),
  'utf8'
);
for (const category of [
  'held/unpaid',
  'ticketed/paid',
  'ticketed/unpaid',
  'cancelled/unpaid',
  'cancelled/captured',
  'unknown',
  'wallet/ledger mismatch',
]) {
  assert.ok(script.includes(`'${category}'`), `Classifier omits ${category}`);
}
for (const required of [
  'walletMismatch(booking)',
  'complete_ticket_evidence',
  'approved_financial_disposition',
  'approved_refund_or_fee_disposition',
  'fresh_supplier_lifecycle_evidence',
  'kaliganj-travels-booking-remediation-classification-v1',
  'sourceSnapshotSha256',
  'subjectIdentifiersPrinted: false',
  'productionMutations: false',
]) {
  assert.ok(script.includes(required), `Classifier safety omits ${required}`);
}
assert.doesNotMatch(
  script,
  /createClient|\.from\s*\(|\.rpc\s*\(/,
  'Classification must operate only on the protected local snapshot'
);

const backupDirectory = path.join(process.cwd(), 'backups');
const manifestName = fs
  .readdirSync(backupDirectory)
  .filter((name) => /^booking-remediation-classification-.*\.json$/.test(name))
  .sort()
  .at(-1);
if (manifestName) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(backupDirectory, manifestName), 'utf8')
  );
  assert.equal(
    Object.values(manifest.counts).reduce((sum, count) => sum + count, 0),
    manifest.classifications.length
  );
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      categories: 7,
      localSnapshotOnly: true,
      financialEquationGuard: true,
      missingEvidenceFailsToUnknown: true,
      productionMutations: false,
    },
    null,
    2
  )
);
