import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read('supabase', 'migrations', '0148_booking_issued_sms.sql');
const provider = read('lib', 'sms', 'bulksmsbd.ts');
const worker = read('lib', 'sms', 'booking-issued-delivery.ts');
const scheduler = read('app', 'api', 'cron', 'booking-status-emails', 'route.ts');
const immediate = read('lib', 'email', 'booking-status-delivery.ts');

for (const required of [
  'booking_issued_sms_deliveries',
  "when (new.to_lifecycle_status = 'confirmed')",
  'unique',
  'lifecycle_event_id',
  'claim_booking_issued_sms_v1',
  'for update',
  "state = 'processing'",
  'claim_token = gen_random_uuid()',
  'mark_booking_issued_sms_sent_v1',
  'fail_booking_issued_sms_v1',
  'recover_stale_booking_issued_sms_claims_v1',
  'booking_hidden_from_user',
  'b2b_partner_only',
  'missing_or_invalid_b2b_partner_phone',
]) {
  assert.ok(migration.includes(required), `Issued SMS migration omits ${required}`);
}
assert.doesNotMatch(migration, /insert[\s\S]*select[\s\S]*status\s*=\s*'confirmed'/i,
  'Migration must not back-send confirmations for historical tickets');
assert.ok(migration.includes("'grossAmount', v_booking.pricing_snapshot->'grossPrice'"));
assert.ok(!migration.includes("'fare', v_booking.pricing_snapshot->'sellingPrice'"));

for (const required of [
  'BULKSMSBD_API_KEY',
  'BULKSMSBD_SENDER_ID',
  'https://bulksmsbd.net/api/smsapi',
  "method: 'POST'",
  "type: 'text'",
  "code !== '202'",
]) {
  assert.ok(provider.includes(required), `BulkSMSBD adapter omits ${required}`);
}
assert.doesNotMatch(provider, /console\.(?:log|error).*apiKey/i,
  'Provider must not log the API key');
assert.ok(worker.includes('bookingIssuedSmsMessage'));
assert.ok(worker.includes('markBookingIssuedSmsSent'));
assert.ok(worker.includes('failBookingIssuedSms'));
assert.ok(scheduler.includes('dispatchPendingBookingIssuedSms(10)'));
assert.ok(scheduler.includes('recoverStaleBookingIssuedSmsClaims(100)'));
assert.ok(immediate.includes('dispatchBookingIssuedSms(bookingId)'));

const messageSource = read('lib', 'sms', 'booking-issued-message.ts');
const compiled = ts.transpileModule(messageSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
new Function('exports', 'module', 'require', compiled)(
  module.exports,
  module,
  (specifier) => {
    if (specifier !== '@/lib/airlines/catalog') throw new Error(`Unexpected import: ${specifier}`);
    return {
      airlineNameForCode: (code) => ({
        BG: 'Biman Bangladesh Airlines',
        BS: 'US-Bangla Airlines',
      })[code] ?? null,
    };
  }
);
const { bookingIssuedSmsMessage } = module.exports;
const message = bookingIssuedSmsMessage({
  version: 1,
  pnr: 'XXXXXX',
  passengerName: 'Md Ashif Babu',
  airlineCode: 'BG',
  airlineName: 'Biman Bangladesh Airlines',
  itinerary: {
    legs: [
      { from: 'DAC', to: 'CMB', departure: '2026-09-23 13:30:00' },
      { from: 'CMB', to: 'DAC', departure: '2026-09-28 05:35:00' },
    ],
  },
  currency: 'BDT',
  grossAmount: 27000,
});
assert.equal(message, [
  'Dear Client,',
  'Your ticket has been successfully issued.',
  'Biman Bangladesh Airlines',
  'PNR: XXXXXX | Md Ashif Babu',
  '23 Sep 2026 | DAC-CMB | 1:30 PM',
  '28 Sep 2026 | CMB-DAC | 5:35 AM',
  'Fare: BDT 27,000',
].join('\n'));

const normalizedAirline = bookingIssuedSmsMessage({
  version: 1,
  pnr: 'ABC123',
  passengerName: 'Test Passenger',
  airlineCode: 'BS',
  airlineName: 'US-Bangla',
  itinerary: { legs: [] },
  currency: 'BDT',
  grossAmount: 1000,
});
assert.match(normalizedAirline, /\nUS-Bangla Airlines\n/);

assert.match(bookingIssuedSmsMessage({
  version: 1, pnr: 'BG7890', pnrType: 'airline', airlineCode: 'BG',
}), /Airline PNR: BG7890/);
assert.match(bookingIssuedSmsMessage({
  version: 1, pnr: 'Not available', pnrType: 'airline', airlineCode: 'BG',
}), /Airline PNR: Not available/);

assert.match(bookingIssuedSmsMessage({
  version: 1, pnr: 'BG', airlineCode: 'BG',
}), /PNR: Not available/);

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
    public_ref text not null,
    passengers jsonb not null,
    audience text not null,
    agency_code text,
    hidden_from_user boolean not null default false,
    pnr text,
    booking_ref_number text,
    airlines_pnr jsonb,
    itinerary jsonb,
    currency text not null,
    pricing_snapshot jsonb not null
  );
  create table public.agencies (
    agency_code text primary key,
    owner_user_id text not null
  );
  create table public.user_profiles (
    clerk_id text primary key,
    agency_mobile text
  );
  create table public.booking_status_events (
    id bigint generated always as identity primary key,
    booking_id uuid not null references public.flight_bookings(id),
    occurrence_id uuid not null default gen_random_uuid(),
    to_lifecycle_status text not null,
    event_snapshot jsonb not null default '{}',
    supplier_operation text
  );
`);
await db.exec(migration);

const bookingId = '14800000-0000-4000-8000-000000000001';
await db.query(`
  insert into public.flight_bookings(
    id, public_ref, passengers, audience, pnr, airlines_pnr,
    itinerary, currency, pricing_snapshot
  ) values ($1, 'STR260904000001', $2, 'b2c', 'FALLBACK', '["XXXXXX"]',
    $3, 'BDT', '{"sellingPrice":25000,"grossPrice":27000}')
`, [
  bookingId,
  JSON.stringify({
    contact: { phoneCountryCode: '+880', phone: '01700000000' },
    travellers: [{ firstName: 'Md Ashif', lastName: 'Babu' }],
  }),
  JSON.stringify({
    carrierCode: 'BG', carrierName: 'Biman Bangladesh Airlines',
    legs: [{ from: 'DAC', to: 'CMB', departure: '2026-09-23 13:30:00' }],
  }),
]);
await db.query(`
  insert into public.booking_status_events(booking_id, to_lifecycle_status)
  values ($1, 'confirmed')
`, [bookingId]);
const pending = await db.query(`
  select state, recipient_number, suppression_reason
    from public.booking_issued_sms_deliveries
   where booking_id = $1
`, [bookingId]);
assert.deepEqual(pending.rows, [{
  state: 'suppressed',
  recipient_number: null,
  suppression_reason: 'b2b_partner_only',
}]);

const agencyId = '14800000-0000-4000-8000-000000000003';
await db.query(`
  insert into public.user_profiles(clerk_id, agency_mobile)
  values ('agency-owner', '+880 1700-000000')
`);
await db.query(`
  insert into public.agencies(agency_code, owner_user_id)
  values ('AGENCY-1', 'agency-owner')
`);
await db.query(`
  insert into public.flight_bookings(
    id, public_ref, passengers, audience, agency_code, pnr, airlines_pnr,
    itinerary, currency, pricing_snapshot
  ) values ($1, 'STR260904000003', $2, 'agency', 'AGENCY-1', 'FALLBACK',
    '["XXXXXX"]', $3, 'BDT', '{"sellingPrice":25000,"grossPrice":27000}')
`, [
  agencyId,
  JSON.stringify({
    contact: { phoneCountryCode: '+880', phone: '01999999999' },
    travellers: [{ firstName: 'Md Ashif', lastName: 'Babu' }],
  }),
  JSON.stringify({
    carrierCode: 'BG', carrierName: 'Biman Bangladesh Airlines',
    legs: [{ from: 'DAC', to: 'CMB', departure: '2026-09-23 13:30:00' }],
  }),
]);
await db.query(`
  insert into public.booking_status_events(booking_id, to_lifecycle_status)
  values ($1, 'confirmed')
`, [agencyId]);
const agencyPending = await db.query(`
  select state, recipient_number, content_snapshot->>'pnr' as pnr,
         content_snapshot->>'grossAmount' as gross_amount
    from public.booking_issued_sms_deliveries where booking_id = $1
`, [agencyId]);
assert.deepEqual(agencyPending.rows, [{
  state: 'pending', recipient_number: '8801700000000', pnr: 'XXXXXX',
  gross_amount: '27000',
}]);
const claimed = await db.query(
  `select * from public.claim_booking_issued_sms_v1(1, $1)`,
  [agencyId]
);
assert.equal(claimed.rows.length, 1);
assert.equal(claimed.rows[0].attempt_count, 1);
assert.equal(
  await db.query(
    `select public.mark_booking_issued_sms_sent_v1($1, $2, 'provider-1') as sent`,
    [claimed.rows[0].delivery_id, claimed.rows[0].delivery_claim_token]
  ).then((result) => result.rows[0].sent),
  true
);
assert.equal(
  await db.query(`select * from public.claim_booking_issued_sms_v1(1, $1)`, [agencyId])
    .then((result) => result.rows.length),
  0,
  'A sent occurrence must not be claimed again'
);

const hiddenId = '14800000-0000-4000-8000-000000000002';
await db.query(`
  insert into public.flight_bookings(
    id, public_ref, passengers, audience, agency_code, pnr, airlines_pnr,
    itinerary, currency, pricing_snapshot
  ) values ($1, 'STR260904000002', $2, 'agency', 'AGENCY-1', 'HIDDEN', '[]',
    '{"carrierCode":"BG","legs":[]}', 'BDT',
    '{"sellingPrice":900,"grossPrice":1000}')
`, [
  hiddenId,
  JSON.stringify({
    contact: { phoneCountryCode: '+880', phone: '01800000000' },
    travellers: [{ firstName: 'Hidden', lastName: 'Customer' }],
  }),
]);
await db.query(`
  insert into public.booking_status_events(booking_id, to_lifecycle_status)
  values ($1, 'confirmed')
`, [hiddenId]);
await db.query(`
  update public.flight_bookings set hidden_from_user = true where id = $1
`, [hiddenId]);
const hidden = await db.query(`
  select state, recipient_number, suppression_reason
    from public.booking_issued_sms_deliveries where booking_id = $1
`, [hiddenId]);
assert.deepEqual(hidden.rows, [{
  state: 'suppressed', recipient_number: null,
  suppression_reason: 'booking_hidden_from_user',
}]);

console.log(JSON.stringify({
  checks: 'passed',
  historicalBackfill: false,
  b2cSuppressed: true,
  agencyMobileUsed: true,
  grossAmountUsed: true,
  durableClaimReplaySafe: true,
  hiddenBookingSuppressed: true,
  message,
}, null, 2));
