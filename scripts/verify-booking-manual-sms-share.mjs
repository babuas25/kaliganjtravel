import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read('supabase', 'migrations', '0149_booking_manual_sms_share.sql');
const editableMigration = read(
  'supabase',
  'migrations',
  '0150_booking_manual_sms_editable_recipient.sql'
);
const pgcryptoMigration = read(
  'supabase',
  'migrations',
  '0151_booking_sms_pgcrypto_search_path.sql'
);
const route = read('app', 'api', 'flights', 'booking', 'share-sms', 'route.ts');
const actions = read('components', 'flights', 'BookingActions.tsx');
const page = read('app', '(dashboard)', 'dashboard', 'bookings', '[reference]', 'page.tsx');
const snapshot = read('lib', 'sms', 'booking-issued-snapshot.ts');

for (const required of [
  'booking_manual_sms_deliveries',
  'claim_booking_manual_sms_send_v1',
  'read_booking_manual_sms_status_v1',
  'mark_booking_manual_sms_sent_v1',
  'fail_booking_manual_sms_send_v1',
  'for update',
  'reserved_count >= 3',
  "state in ('sent', 'processing')",
  'booking_manual_sms_request_unique',
]) {
  assert.ok(migration.toLowerCase().includes(required.toLowerCase()), `Migration omits ${required}`);
}
for (const functionName of [
  'enqueue_booking_issued_sms_v1',
  'claim_booking_manual_sms_send_v1',
  'claim_booking_manual_sms_send_v2',
]) {
  assert.ok(pgcryptoMigration.includes(functionName), `pgcrypto fix omits ${functionName}`);
}
assert.match(pgcryptoMigration, /search_path = public, extensions/g);
for (const required of [
  'message_text',
  'normalize_booking_sms_number_v1',
  'read_booking_manual_sms_status_v2',
  'claim_booking_manual_sms_send_v2',
  'BOOKING_SMS_RECIPIENT_ALREADY_USED',
  "delivery.state in ('sent', 'processing')",
]) {
  assert.ok(editableMigration.includes(required), `Editable SMS migration omits ${required}`);
}

for (const role of ['superadmin', 'admin', 'staff_support', 'b2b', 'b2b_sub']) {
  assert.ok(route.includes(`session.role === '${role}'`), `Route must allow ${role}`);
  assert.ok(page.includes(`session.role === '${role}'`), `Page must show SMS for ${role}`);
}
assert.match(route, /bookingScopeFor\(session\)/);
assert.match(route, /booking\.agency_code !== session\.agencyCode/);
assert.match(route, /sendBulkSmsBdText\(/);
assert.match(route, /message: claim\.messageText/);
assert.match(route, /recipientNumber: parsed\.data\.recipientNumber/);
assert.match(route, /messageText: parsed\.data\.message/);
assert.match(route, /securitySubjectHash\(claim\.recipientNumber\)/);
assert.doesNotMatch(route, /metadata:\s*\{[^}]*recipientNumber/);
assert.match(actions, /Preview SMS/);
assert.match(actions, /Send SMS/);
assert.match(actions, /SMS Limit Reached/);
assert.match(actions, /setSmsMessage\(body\.data\.message\)/);
assert.match(actions, /setSmsMessage/);
assert.match(actions, /setSmsRecipientNumber/);
assert.match(actions, /Use a different number for each send/);
assert.match(snapshot, /grossAmount: booking\.pricing_snapshot\.grossPrice/);
assert.doesNotMatch(snapshot, /sellingPrice/);

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(`
  create role anon;
  create role authenticated;
  create role service_role;
  create extension if not exists pgcrypto;
  create function public.touch_updated_at() returns trigger language plpgsql as $$
  begin new.updated_at = now(); return new; end;
  $$;
  create table public.flight_bookings (
    id uuid primary key,
    audience text not null,
    agency_code text,
    hidden_from_user boolean not null default false,
    status text not null
  );
  create table public.agencies (
    agency_code text primary key,
    owner_user_id text not null
  );
  create table public.user_profiles (
    clerk_id text primary key,
    agency_mobile text
  );
`);
await db.exec(migration);
await db.exec(editableMigration);

const bookingId = '14900000-0000-4000-8000-000000000001';
await db.query(`insert into public.user_profiles values ('owner-1', '+880 1730-596121')`);
await db.query(`insert into public.agencies values ('AGENCY-1', 'owner-1')`);
await db.query(
  `insert into public.flight_bookings values ($1, 'agency', 'AGENCY-1', false, 'confirmed')`,
  [bookingId]
);

const initial = await db.query(
  `select * from public.read_booking_manual_sms_status_v2($1)`,
  [bookingId]
);
assert.deepEqual(initial.rows, [{
  recipient_number: '8801730596121',
  sent_count: 0,
  reserved_count: 0,
  remaining_sends: 3,
}]);

const claim = async (requestId, recipient, message = 'Editable test message') => db.query(
  `select * from public.claim_booking_manual_sms_send_v2($1, 'actor-1', $2, $3, $4)`,
  [bookingId, requestId, recipient, message]
).then((result) => result.rows[0]);

const first = await claim(
  '14900000-0000-4000-8000-000000000011',
  '01730-596121',
  'First edited message'
);
assert.equal(first.claim_state, 'claimed');
assert.equal(first.remaining_sends, 2);
assert.equal(first.recipient_number, '8801730596121');
assert.equal(first.message_text, 'First edited message');
assert.equal(await db.query(
  `select public.mark_booking_manual_sms_sent_v1($1, $2, 'provider-1') as count`,
  [first.delivery_id, first.claim_token]
).then((result) => result.rows[0].count), 1);

const replay = await claim(
  '14900000-0000-4000-8000-000000000011',
  '01730596121',
  'First edited message'
);
assert.equal(replay.claim_state, 'sent');
assert.equal(replay.sent_count, 1);

await assert.rejects(
  claim('14900000-0000-4000-8000-000000000016', '+8801730596121'),
  /BOOKING_SMS_RECIPIENT_ALREADY_USED/
);

const second = await claim('14900000-0000-4000-8000-000000000012', '01800000000');
const third = await claim('14900000-0000-4000-8000-000000000013', '01900000000');
assert.equal(third.remaining_sends, 0);
await assert.rejects(
  claim('14900000-0000-4000-8000-000000000014', '01600000000'),
  /BOOKING_SMS_LIMIT_REACHED/
);

assert.equal(await db.query(
  `select public.fail_booking_manual_sms_send_v1($1, $2, 'provider rejected') as failed`,
  [second.delivery_id, second.claim_token]
).then((result) => result.rows[0].failed), true);
const replacement = await claim(
  '14900000-0000-4000-8000-000000000014',
  '01800000000'
);
assert.equal(replacement.claim_state, 'claimed');

for (const row of [third, replacement]) {
  await db.query(
    `select public.mark_booking_manual_sms_sent_v1($1, $2, null)`,
    [row.delivery_id, row.claim_token]
  );
}
const full = await db.query(
  `select * from public.read_booking_manual_sms_status_v2($1)`,
  [bookingId]
);
assert.equal(full.rows[0].sent_count, 3);
assert.equal(full.rows[0].remaining_sends, 0);
await assert.rejects(
  claim('14900000-0000-4000-8000-000000000015', '01500000000'),
  /BOOKING_SMS_LIMIT_REACHED/
);

console.log(JSON.stringify({
  checks: 'passed',
  bookingsRestrictedToB2bAgencies: true,
  allowedRoles: ['superadmin', 'admin', 'staff_support', 'b2b', 'b2b_sub'],
  previewBeforeSend: true,
  editableMessage: true,
  editableRecipient: true,
  distinctRecipientsRequired: true,
  grossAmountUsed: true,
  maximumSuccessfulSendsPerBooking: 3,
  concurrentReservationsCountTowardLimit: true,
  failedAttemptReleasesSlot: true,
  requestReplaySafe: true,
}, null, 2));
