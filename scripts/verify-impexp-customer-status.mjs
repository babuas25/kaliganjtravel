import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const actions = fs.readFileSync(
  path.join(root, 'components', 'flights', 'BookingActions.tsx'),
  'utf8'
);
const publicBooking = fs.readFileSync(
  path.join(root, 'lib', 'flights', 'booking.ts'),
  'utf8'
);
const detailPage = fs.readFileSync(
  path.join(
    root,
    'app',
    '(dashboard)',
    'dashboard',
    'bookings',
    '[reference]',
    'page.tsx'
  ),
  'utf8'
);

const exactMessage = 'User Payable is held; ticketing is being completed.';
assert.ok(actions.includes(exactMessage), 'Approved imported status copy is missing');
assert.match(
  actions,
  /importedConfirmEligible[\s\S]*?IMPORTED_MANUAL_TICKETING_MESSAGE[\s\S]*?router\.refresh\(\)/i,
  'Issue Now success must show the approved message before refresh'
);
assert.match(
  actions,
  /importedBooking && status === 'in-progress'[\s\S]*?IMPORTED_MANUAL_TICKETING_MESSAGE/i,
  'A persisted imported In Progress booking must show the approved message'
);
assert.match(detailPage, /const imported = row\.import_source === 'IMP_EXP'/);
assert.match(detailPage, /const manual = row\.import_source === 'MANUAL'/);
assert.match(detailPage, /const externalBooking = imported \|\| manual/);
assert.match(
  detailPage,
  /allowImportedConfirmation=\{externalBooking && canConfirmImportedBooking\(session, row\)\}/
);
assert.match(detailPage, /importedBooking=\{externalBooking\}/);
assert.match(detailPage, /manualBooking=\{manual\}/);
assert.match(
  detailPage,
  /allowImportedSync=\{\s*imported && rollout\.importedActions && canAccessImpExp\(session\.role\)\s*\}/
);
assert.doesNotMatch(
  publicBooking,
  /booking_operations|reconciliation_case|assignedTeam|assigneeUserId/i,
  'Public booking DTO must not expose internal operation/case ownership'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      customerStatus: 'In Progress',
      customerMessage: exactMessage,
      shownAfterHold: true,
      shownAfterReload: true,
      internalCaseDetailsExposed: false,
    },
    null,
    2
  )
);
