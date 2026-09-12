import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const actions = read('components', 'flights', 'BookingActions.tsx');
const route = read('app', 'api', 'flights', 'booking', 'cancel', 'route.ts');
const permissions = read('lib', 'wallet', 'permissions.ts');
const migration = read(
  'supabase',
  'migrations',
  '0101_on_hold_cancellation_independence.sql'
);

const cancelLock = actions.slice(
  actions.indexOf('const cancelInteractionLocked ='),
  actions.indexOf('async function issue()')
);
assert.ok(cancelLock.length > 0, 'Cancellation-specific UI lock is missing');
assert.doesNotMatch(
  cancelLock,
  /serverCanSubmit|insufficient|availableBalance|requiredAmount|frozen|preview/,
  'Cancel remains coupled to wallet or Issue Ticket eligibility'
);
assert.match(actions, /No wallet balance is required to cancel an On Hold booking/);
assert.match(
  actions,
  /\{requestOnly \? \([\s\S]*?\{cancellationAction\}[\s\S]*?<\/div>/,
  'A held booking must still expose Cancel when Issue Ticket needs a local time-limit request'
);
assert.doesNotMatch(
  route,
  /readBookingLocalTimeLimitContext|LOCAL_TIME_LIMIT_REQUIRED|readWalletForOwner|INSUFFICIENT_FUNDS/,
  'Cancellation route contains an Issue Ticket time-limit or wallet gate'
);
for (const expected of [
  'canCancelBooking(session, booking)',
  'beginBookingCancellation(',
  'finalizeBookingCancellation(',
]) {
  assert.ok(route.includes(expected), `Cancellation route omits ${expected}`);
}
for (const expected of [
  "booking.status !== 'on-hold'",
  "booking.lifecycle_status !== 'on-hold'",
  'booking.booking_owner_type',
  'booking.booking_owner_key',
  'walletOwnerForSession(session)',
]) {
  assert.ok(permissions.includes(expected), `Owner permission omits ${expected}`);
}
assert.match(migration, /v_booking\.ticketing_deadline_at is not null/);
assert.doesNotMatch(
  migration,
  /available_balance|hold_balance|INSUFFICIENT_FUNDS|LOCAL_TIME_LIMIT_REQUIRED|update public\.wallet_|insert into public\.wallet_/i,
  'On Hold cancellation claim must remain non-financial'
);
assert.match(migration, /'walletMutation', false/);

console.log(JSON.stringify({
  checks: 'passed',
  ownerScoped: true,
  onHoldOnly: true,
  insufficientWalletAllowed: true,
  localIssueGrantNotRequired: true,
  walletMutation: false,
}, null, 2));
