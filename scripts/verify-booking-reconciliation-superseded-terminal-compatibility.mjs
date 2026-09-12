import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const compatibility = read(
  'supabase',
  'migrations',
  '0096_booking_reconciliation_superseded_terminal_compatibility.sql'
);
const supersession = read(
  'supabase',
  'migrations',
  '0095_booking_reconciliation_stale_approved_proposal_supersession.sql'
);
const supersedeRoute = read(
  'app',
  'api',
  'admin',
  'booking-lifecycle',
  '[reference]',
  'reconciliation',
  'supersede-stale-approved-proposal',
  'route.ts'
);
const timelineDb = read('lib', 'db', 'booking-lifecycle-timeline.ts');
const timelineUi = read(
  'components',
  'dashboard',
  'bookings',
  'BookingLifecycleTimeline.tsx'
);

for (const functionName of [
  'booking_reconciliation_resolution_contract_v1',
  'approve_booking_reconciliation_v1',
  'wallet_release_reservation',
  'wallet_refund_booking',
  'wallet_confirm_impexp_booking',
  'update_manual_booking_status_v1',
]) {
  assert.match(
    compatibility,
    new RegExp(`pg_get_functiondef\\([\\s\\S]*?${functionName}`, 'i'),
    `0096 must forward-harden ${functionName}`
  );
}

for (const required of [
  'unexpected booking reconciliation resolution contract',
  'unexpected reconciliation approval contract',
  'unexpected wallet release guard',
  'unexpected wallet refund guard',
  'unexpected imported/manual confirmation guard',
  'unexpected manual status guard',
  "'PROPOSAL_SUPERSEDED'",
  "'successorCaseId', v_case.superseded_by_case_id",
  "'open', 'assigned', 'awaiting_supplier', 'awaiting_finance', 'awaiting_approval'",
  "'MANUAL_TICKETING_RECONCILIATION_REQUIRED'",
]) {
  assert.ok(
    compatibility.includes(required),
    `0096 omits ${required}`
  );
}

assert.doesNotMatch(
  compatibility,
  /update\s+public\.(?:flight_bookings|booking_operations|wallet_accounts|wallet_reservations)/i,
  '0096 may only redefine guard functions; applying it must not mutate booking, operation, wallet, or reservation data'
);
assert.doesNotMatch(
  compatibility,
  /insert\s+into\s+public\.(?:wallet_|booking_status_events|booking_reconciliation_cases)/i,
  '0096 may not create financial, lifecycle, or reconciliation records at apply time'
);

const replayLookup = supersession.indexOf(
  'from public.booking_reconciliation_proposal_supersessions supersession'
);
const bookingMutationPrecondition = supersession.indexOf(
  "'BOOKING_NOT_STALE_CAPTURE_RECONCILIATION'"
);
assert.ok(
  replayLookup >= 0 &&
    bookingMutationPrecondition > replayLookup,
  'Supersession replay must be evaluated before mutable booking/operation preconditions'
);
assert.doesNotMatch(
  supersedeRoute,
  /readBookingReconciliationActionState/,
  'The route must let the locked RPC provide idempotent replay after a source version changes'
);

assert.match(
  timelineDb,
  /case 'superseded'[\s\S]*?proposal superseded/i,
  'Staff timeline must identify the terminal superseded source'
);
assert.match(
  timelineDb,
  /!\['resolved', 'closed_no_change', 'superseded'\]\.includes\(\s*row\.state\s*\)/,
  'A superseded source must not be presented as an open review'
);
assert.match(
  timelineDb,
  /fact\('Superseded at', row\.superseded_at\)/,
  'Supersession observation time must remain separately labelled'
);
assert.match(timelineUi, /superseded: 'Superseded'/);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      supersededIsTerminal: true,
      legacyOpenCasePredicatesHardened: 4,
      sourceResolutionAndApprovalFailClosed: true,
      idempotentSupersedeReplay: true,
      sourceTimelineArchived: true,
      migrationApplyDataMutation: false,
    },
    null,
    2
  )
);
