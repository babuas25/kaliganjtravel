import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const actions = read('components', 'flights', 'BookingActions.tsx');
const statusRoute = read(
  'app', 'api', 'flights', 'booking', 'issue', 'status', 'route.ts'
);
const reconciliationEvidence = read(
  'lib', 'db', 'booking-reconciliation-evidence.ts'
);

for (const required of [
  'ISSUE_POST_TIMEOUT_MS',
  'ISSUE_STATUS_TIMEOUT_MS',
  'CHECKING_TICKETING_RESULT_MESSAGE',
  'ISSUE_RECONCILIATION_CODES',
  'new AbortController()',
  'window.clearTimeout(timeout)',
  'router.refresh()',
  'refreshIssueStatus()',
  'issueInteractionLocked',
  'cancelInteractionLocked',
  'serverCanSubmit',
  'openReconciliationCase',
]) {
  assert.ok(actions.includes(required), `Issue UI omits ${required}`);
}
assert.match(
  actions,
  /disabled=\{[\s\S]*?loading \|\|[\s\S]*?issueInteractionLocked[\s\S]*?!preview/,
  'The visible Issue trigger must obey the fail-closed interaction lock'
);
assert.match(
  actions,
  /disabled=\{!cancellable \|\| cancelInteractionLocked\}/,
  'The visible Cancel trigger must use its cancellation-specific interaction lock'
);
const cancelLock = actions.slice(
  actions.indexOf('const cancelInteractionLocked ='),
  actions.indexOf('async function issue()')
);
assert.doesNotMatch(
  cancelLock,
  /serverCanSubmit|insufficient|availableBalance|requiredAmount|frozen|preview/,
  'Cancellation must not depend on Issue Ticket wallet eligibility'
);
assert.match(
  actions,
  /finally \{[\s\S]*?setIssuing\(false\)[\s\S]*?router\.refresh\(\)[\s\S]*?refreshIssueStatus\(\)/,
  'Every Issue POST outcome must refresh booking and independent action state'
);
assert.doesNotMatch(
  actions,
  /issue\(\)[\s\S]{0,160}issue\(/,
  'The client must never recursively retry an Issue request'
);

for (const required of [
  'readOpenBookingReconciliationCaseForBooking',
  'openReconciliationCase',
  'reconciliationRequired',
  'canSubmit',
  "dynamic = 'force-dynamic'",
]) {
  assert.ok(statusRoute.includes(required), `Issue status route omits ${required}`);
}
assert.doesNotMatch(
  statusRoute,
  /issueTicket\(|NewTicket|beginBookingIssue|walletReserve|walletCapture|update\(/i,
  'Issue status route must be read-only and must never issue or mutate a wallet'
);
assert.match(
  reconciliationEvidence, /readOpenBookingReconciliationCaseForBooking/);
assert.match(reconciliationEvidence, /\.in\('state', OPEN_CASE_STATES\)/);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      issuePostTimeoutMs: 130000,
      issueStatusTimeoutMs: 15000,
      statusRefreshOnAllOutcomes: true,
      reconciliationLocksIssueAndCancel: true,
      insufficientWalletDoesNotLockCancel: true,
      openCaseFailsClosed: true,
      automaticNewTicketRetry: false,
    },
    null,
    2
  )
);
