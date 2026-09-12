import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import ts from 'typescript';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  migration,
  expansionMigration,
  retrieval,
  validation,
  pricing,
  db,
  previewRoute,
  authorizationRoute,
  importRoute,
  ui,
  issueRoute,
  cancelRoute,
  refreshRoute,
  fareReconciliation,
  supplierTime,
] = await Promise.all([
  read('supabase/migrations/0109_supplier_reference_api_import.sql'),
  read('supabase/migrations/0142_triplover_supplier_reference_import.sql'),
  read('lib/supplier-reference-import/retrieve.server.ts'),
  read('lib/supplier-reference-import/validation.ts'),
  read('lib/supplier-reference-import/pricing.server.ts'),
  read('lib/db/supplier-reference-import.ts'),
  read('app/api/supplier-reference-import/preview/route.ts'),
  read('app/api/supplier-reference-import/authorize-charge/route.ts'),
  read('app/api/supplier-reference-import/import-booking/route.ts'),
  read('components/dashboard/impexp/SupplierApiImportForm.tsx'),
  read('app/api/flights/booking/issue/route.ts'),
  read('app/api/flights/booking/cancel/route.ts'),
  read('app/api/flights/booking/refresh-details/route.ts'),
  read('lib/supplier-reference-import/fare-reconciliation.ts'),
  read('lib/triplover/time.ts'),
]);

for (const required of [
  "booking_origin = 'supplier_reference_import'",
  'flight_bookings_supplier_account_unique_trans_id_key',
  'protect_supplier_reference_booking_identity_v1',
  "new.supplier_account is distinct from old.supplier_account",
  "new.supplier_refs->>'uniqueTransId'",
  'supplier_reference_charge_authorizations',
  "v_now + interval '5 minutes'",
  'authorization_payload_hash',
  'authorize_supplier_reference_charge_v1',
  'create_supplier_reference_booking_v1',
  "'triplover', 'succeeded'",
  "v_supplier_account, p_actor_user_id, false",
  "null, p_actor_user_id",
  "'supplier_reference_import'",
  "p_data->'supplierRefs'",
  "'supplier-reference-payment:' || v_booking.id::text",
  "'SupplierReferenceImport'",
  'pg_advisory_xact_lock',
  "'SUPPLIER_REFERENCE:' || v_supplier_account",
  "'FRESH_MATCHING_CHARGE_AUTHORIZATION_REQUIRED'",
  'set consumed_at = clock_timestamp()',
]) {
  assert.ok(migration.includes(required), `Migration omits ${required}`);
}

const authorizationBody = migration.match(
  /create or replace function public\.authorize_supplier_reference_charge_v1\([\s\S]*?end;\r?\n\$\$;/i,
)?.[0] ?? '';
assert.ok(authorizationBody, 'Supplier-reference authorization function missing');
assert.doesNotMatch(
  authorizationBody,
  /update public\.wallet_accounts|insert into public\.wallet_reservations|insert into public\.wallet_ledger_entries|insert into public\.flight_bookings/i,
  'Authorization must not mutate wallet money or create a booking',
);

const importBody = migration.match(
  /create or replace function public\.create_supplier_reference_booking_v1\([\s\S]*?end;\r?\n\$\$;/i,
)?.[0] ?? '';
assert.ok(importBody, 'Supplier-reference import function missing');
assert.match(importBody, /p_import_decision = 'import_and_charge'/);
assert.match(importBody, /update public\.wallet_accounts/);
assert.match(importBody, /insert into public\.wallet_reservations/);
assert.match(importBody, /insert into public\.wallet_ledger_entries/);
assert.match(importBody, /import_source, imported_by_user_id,[\s\S]*?null, p_actor_user_id/);

for (const required of [
  "'AirTicketingDetails'",
  'ticket.referenceLog',
  'referenceLog.ItemCodeRef',
  'referenceLog.PriceCodeRef',
  'referenceLog.BookingCodeRef',
  'readPnr({',
  'supplierEchoedUniqueTransIds.some',
  'reportLifecycle !== pnrLifecycle',
  'Supplier booking has no airline PNR required for normal API operations.',
  'ambiguous marketing/operating carrier',
]) {
  assert.ok(retrieval.includes(required), `Retrieval boundary omits ${required}`);
}
assert.doesNotMatch(retrieval, /serviceCharge \?\? fare\.agentAdditionalPrice/);
assert.match(retrieval, /reconcileSupplierFares\(/);
assert.match(fareReconciliation, /agentAdditionalPrice/);
assert.match(
  fareReconciliation,
  /Supplier passenger\/type fares do not reconcile/,
);
assert.doesNotMatch(
  fareReconciliation,
  /serviceCharge\s*\?\?\s*(?:row\.)?agentAdditionalPrice/,
);

function takeoffTimestampsUnder(tz) {
  const output = ts.transpileModule(supplierTime, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const runner = `
    const module = { exports: {} };
    Function('module', 'exports', ${JSON.stringify(output)})(module, module.exports);
    const parse = module.exports.supplierLifecycleInstant;
    process.stdout.write(JSON.stringify({
      bookingDate: parse('takeoff', '2026-08-25T11:26:20.29'),
      issueDate: parse('takeoff', '2026-08-25T15:12:02.9333333'),
      cancellationDate: parse('takeoff', '2026-08-25 17:45:06'),
      explicitOffset: parse('takeoff', '2026-08-25T15:12:02.933+06:00'),
      invalidLocal: parse('takeoff', '08/25/2026 15:12:02'),
    }));
  `;
  const child = spawnSync(process.execPath, ['-e', runner], {
    encoding: 'utf8',
    env: { ...process.env, TZ: tz },
  });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

const takeoffUtcRuntime = takeoffTimestampsUnder('UTC');
const takeoffDhakaRuntime = takeoffTimestampsUnder('Asia/Dhaka');
assert.deepEqual(takeoffUtcRuntime, takeoffDhakaRuntime);
assert.deepEqual(takeoffUtcRuntime, {
  bookingDate: '2026-08-25T05:26:20.290Z',
  issueDate: '2026-08-25T09:12:02.933Z',
  cancellationDate: '2026-08-25T11:45:06.000Z',
  explicitOffset: '2026-08-25T09:12:02.933Z',
  invalidLocal: null,
});
assert.match(retrieval, /supplierReferenceInstant\(\s*input\.supplierAccount,\s*ticket\.bookingDate/);
assert.match(retrieval, /supplierReferenceInstant\(input\.supplierAccount, ticket\.issueDate\)/);
assert.match(
  retrieval,
  /ticket\.cancelDate \?\? ticket\.cancellationDate \?\? ticket\.adjustmentDate/,
);

function loadFareReconciliation(source) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  Function('module', 'exports', output)(module, module.exports);
  return module.exports;
}

const { reconcileSupplierFares, SupplierFareReconciliationError } =
  loadFareReconciliation(fareReconciliation);
const fareRow = (overrides = {}) => ({
  passengerType: 'ADT',
  passengerCount: 1,
  basePrice: 900,
  tax: 100,
  ait: 0,
  serviceCharge: 0,
  discount: 0,
  totalPrice: 1000,
  agentAdditionalPrice: 0,
  additionalCollection: 0,
  reissueCharge: 0,
  extraBaggageCharge: 0,
  ...overrides,
});
const passengerFareRow = (overrides = {}) => {
  const row = fareRow(overrides);
  delete row.serviceCharge;
  delete row.additionalCollection;
  delete row.reissueCharge;
  delete row.extraBaggageCharge;
  return row;
};

const missingZero = reconcileSupplierFares({
  fareBreakdown: [fareRow()],
  passengers: [passengerFareRow()],
  payable: 1000,
});
assert.equal(missingZero.supplierFares[0].serviceCharge, 0);
assert.equal(missingZero.supplierGross, 1000);

const missingNonZero = reconcileSupplierFares({
  fareBreakdown: [fareRow({ serviceCharge: 50, totalPrice: 1050 })],
  passengers: [passengerFareRow({ totalPrice: 1050 })],
  payable: 1050,
});
assert.equal(missingNonZero.supplierFares[0].serviceCharge, 50);
assert.equal(missingNonZero.supplierGross, 1050);

assert.throws(
  () => reconcileSupplierFares({
    fareBreakdown: [fareRow({ serviceCharge: 50, totalPrice: 1050 })],
    passengers: [passengerFareRow({ totalPrice: 1049 })],
    payable: 1050,
  }),
  (error) => error instanceof SupplierFareReconciliationError &&
    /supplierTotalPrice/.test(error.message),
  'mismatched passenger and authoritative fare totals must fail closed',
);

const partialPassengerOne = fareRow({ passengerCount: 1 });
const partialPassengerTwo = passengerFareRow({ passengerCount: 1 });
assert.throws(
  () => reconcileSupplierFares({
    fareBreakdown: [fareRow({ passengerCount: 2, basePrice: 1800, tax: 200, totalPrice: 2000 })],
    passengers: [partialPassengerOne, partialPassengerTwo],
    payable: 2000,
  }),
  (error) => error instanceof SupplierFareReconciliationError &&
    /only partially present/.test(error.message),
  'partial passenger service-charge presence must fail closed',
);

const missingBothBreakdown = fareRow();
delete missingBothBreakdown.serviceCharge;
assert.throws(
  () => reconcileSupplierFares({
    fareBreakdown: [missingBothBreakdown],
    passengers: [passengerFareRow()],
    payable: 1000,
  }),
  (error) => error instanceof SupplierFareReconciliationError &&
    /Fare breakdown 1 service charge/.test(error.message),
  'missing authoritative service charge must fail closed',
);

assert.throws(
  () => reconcileSupplierFares({
    fareBreakdown: [fareRow({ agentAdditionalPrice: 25 })],
    passengers: [passengerFareRow()],
    payable: 1000,
  }),
  (error) => error instanceof SupplierFareReconciliationError &&
    /unsupported additional price/.test(error.message),
  'agentAdditionalPrice must never substitute for service charge',
);

assert.throws(
  () => reconcileSupplierFares({
    fareBreakdown: [fareRow()],
    passengers: [passengerFareRow()],
    payable: 999,
  }),
  (error) => error instanceof SupplierFareReconciliationError &&
    /authoritative ticketing payable/.test(error.message),
  'fare breakdown must reconcile to ticketInfo.ticketingPrice',
);
for (const required of [
  'resolveBookingActorContext(',
  'pricingAudienceForPrincipal(',
  'activeMarkupRulesFor(',
  'selectMarkupRules(',
  'priceOffer({',
  "pricingMode: PRICING_MODE",
  'assertSupplierPricingConfirmation',
]) {
  assert.ok(pricing.includes(required), `Canonical import pricing omits ${required}`);
}
assert.doesNotMatch(validation, /userPayableAmount/);
assert.match(ui, /User Payable · Read only/);
assert.doesNotMatch(ui, /setUserPayableAmount|inputMode="decimal"/);

assert.match(validation, /\^\(\?:FST\|TOT\|TLL\)\\d\{18\}\$/);
assert.match(
  validation,
  /supplierAccount: z\.enum\(TRIPLOVER_REFERENCE_IMPORT_SUPPLIERS\)/,
  'reference import must stay limited to the documented supplier accounts'
);
assert.match(db, /authorize_supplier_reference_charge_v1/);
assert.match(db, /create_supplier_reference_booking_v1/);
assert.match(expansionMigration, /'firsttrip', 'takeoff', 'triplover'/);
assert.match(expansionMigration, /\^\(FST\|TOT\|TLL\)\[0-9\]\{18\}\$/);
assert.match(expansionMigration, /\^TLL\[0-9\]\{18\}\$/);

assert.match(previewRoute, /retrieveSupplierReferenceBooking/);
for (const required of [
  'recordSecurityAuditEvent',
  'booking.supplier_reference.charge_authorization',
  "outcome: 'attempted'",
  'walletMutation: false',
]) {
  assert.ok(authorizationRoute.includes(required), `Authorization route omits ${required}`);
}
for (const required of [
  'recordSecurityAuditEvent',
  'booking.supplier_reference.import_decision',
  'createSupplierReferenceBooking',
  'dispatchBookingStatusEmails',
]) {
  assert.ok(importRoute.includes(required), `Import route omits ${required}`);
}
for (const required of [
  'FirstTrip',
  'TakeOff',
  'Triplover',
  '/api/supplier-reference-import/preview',
  '/api/supplier-reference-import/authorize-charge',
  '/api/supplier-reference-import/import-booking',
  'Import On Hold — No Wallet Charge',
  'Import Historical — No Wallet Movement',
  'Authorize Import &amp; Charge',
]) {
  assert.ok(ui.includes(required), `Supplier API Import UI omits ${required}`);
}

for (const route of [issueRoute, cancelRoute, refreshRoute]) {
  assert.match(route, /booking\.supplier !== 'triplover'/);
  assert.doesNotMatch(
    route,
    /booking_origin.*supplier_reference_import/,
    'Ordinary API operations must not reject supplier-reference origin bookings',
  );
}

// Compile and exercise the migration in an isolated Postgres-compatible
// database. The fixture intentionally contains only the canonical tables and
// trigger contract used by this import path.
const database = new PGlite({ extensions: { pgcrypto } });
await database.exec(`
  create role anon; create role authenticated; create role service_role;
  create extension if not exists pgcrypto;
  create sequence public.supplier_reference_booking_ref_seq;
  create or replace function public.allocate_booking_ref() returns text language sql as $$
    select 'STR260824' || lpad(nextval('public.supplier_reference_booking_ref_seq')::text, 6, '0')
  $$;
  create or replace function public.sha256(value bytea) returns bytea language sql immutable as $$
    select digest(value, 'sha256')
  $$;
  create or replace function public.resolve_booking_lifecycle(
    status text, airlines_pnr jsonb, deadline timestamptz, operation_kind text
  ) returns text language sql stable as $$
    select case
      when status='cancelled' then 'cancelled'
      when status='confirmed' then 'confirmed'
      when status='in-progress' or operation_kind is not null then 'in-progress'
      when status='pending' then 'pending'
      when status='on-hold' and (airlines_pnr is null or jsonb_array_length(airlines_pnr)=0) then 'unconfirmed'
      when status='on-hold' and deadline is not null and deadline <= clock_timestamp() then 'expired'
      else 'on-hold'
    end
  $$;
  create table public.app_users (
    clerk_id text primary key, role text not null, agency_code text
  );
  create table public.booking_attempts (
    id uuid primary key, access_token_hash text not null unique, user_id text,
    audience text, agency_code text, supplier text, state text, search_id uuid,
    itinerary_id text, unique_trans_id text, item_code_ref text,
    price_code_ref text, booking_code_ref text, pnr text,
    offer_snapshot jsonb, passenger_snapshot jsonb, expires_at timestamptz,
    submitted_at timestamptz, resolved_at timestamptz, created_at timestamptz,
    updated_at timestamptz default clock_timestamp(), supplier_account text,
    created_by_user_id text, staff_on_behalf boolean not null default false
  );
  create table public.wallets (
    id uuid primary key default gen_random_uuid(), owner_type text,
    owner_key text, status text
  );
  create table public.wallet_accounts (
    id uuid primary key default gen_random_uuid(), wallet_id uuid,
    currency text, available_balance bigint, hold_balance bigint
  );
  create table public.flight_bookings (
    id uuid primary key, public_ref text unique, attempt_id uuid unique,
    access_token_hash text, supplier text, supplier_account text, user_id text,
    audience text, agency_code text, search_id uuid, itinerary_id text,
    status text, operation_kind text, currency text, pricing_snapshot jsonb,
    passenger_counts jsonb, travel_date date, direct_ticketing boolean,
    itinerary jsonb, fares jsonb, passport_required boolean, supplier_refs jsonb,
    repriced_at timestamptz, accepted_at timestamptz, expires_at timestamptz,
    passengers jsonb, pnr text, airlines_pnr jsonb, booking_ref_number text,
    booking_status text, ticketing_time_limit text,
    ticketing_deadline_at timestamptz, deadline_source text,
    supplier_ticketing_time_limit text, supplier_ticketing_deadline_at timestamptz,
    supplier_deadline_source text, booking_code_ref text, ticket_code_ref text,
    ticket_numbers jsonb, warnings jsonb, supplier_message text,
    issued_at timestamptz, cancelled_at timestamptz,
    submission_started_at timestamptz, legacy_operational boolean,
    booked_by_user_id text, issued_by_user_id text, booking_owner_type text,
    booking_owner_key text, charged_wallet_account_id uuid, payment_state text,
    payment_amount bigint, captured_amount bigint default 0,
    refunded_amount bigint default 0, supplier_gross_amount bigint,
    user_payable_amount bigint, import_source text, imported_by_user_id text,
    import_metadata jsonb, synced_at timestamptz, created_at timestamptz,
    updated_at timestamptz default clock_timestamp()
  );
  create or replace function public.copy_booking_supplier_account_from_attempt()
  returns trigger language plpgsql as $$
  begin
    if new.supplier_account is null and new.attempt_id is not null then
      select supplier_account into new.supplier_account
        from public.booking_attempts where id=new.attempt_id;
    end if;
    if new.supplier='triplover' and not new.legacy_operational
       and new.supplier_account is null then
      raise exception 'booking attempt is missing supplier account';
    end if;
    return new;
  end
  $$;
  create trigger flight_bookings_copy_supplier_account
    before insert on public.flight_bookings for each row execute function
    public.copy_booking_supplier_account_from_attempt();
  create table public.wallet_reservations (
    id uuid primary key default gen_random_uuid(), wallet_account_id uuid,
    booking_id uuid unique, amount bigint, currency text, state text,
    requested_by_user_id text, issued_by_user_id text, captured_at timestamptz,
    released_at timestamptz, release_reason text, reconciliation_at timestamptz,
    reconciliation_reason text, updated_at timestamptz default clock_timestamp()
  );
  create table public.wallet_ledger_entries (
    id uuid primary key default gen_random_uuid(), wallet_account_id uuid,
    transaction_type text, amount bigint, currency text, available_before bigint,
    available_after bigint, hold_before bigint, hold_after bigint,
    booking_id uuid, booking_reference text, reservation_id uuid,
    idempotency_key text unique, created_by_user_id text, created_by_role text,
    remarks text, metadata jsonb, created_at timestamptz default clock_timestamp()
  );
  create table public.booking_status_events (
    id bigint generated always as identity primary key, booking_id uuid,
    from_lifecycle_status text, to_lifecycle_status text,
    stored_status_before text, stored_status_after text, operation_kind text,
    operation_reason text, actor_user_id text, supplier_operation text,
    supplier_evidence jsonb, idempotency_key text, operation_id uuid,
    reconciliation_case_id uuid, occurrence_number integer,
    effective_at timestamptz, observed_at timestamptz, event_snapshot jsonb,
    event_version integer, created_at timestamptz default clock_timestamp()
  );
  create unique index booking_status_events_fixture_identity
    on public.booking_status_events(booking_id,idempotency_key,to_lifecycle_status);
`);
await database.exec(migration);
await database.exec(expansionMigration);
await database.exec(`
  insert into public.app_users(clerk_id,role) values
    ('support','staff_support'),('customer','customer');
  insert into public.wallets(id,owner_type,owner_key,status) values
    ('10000000-0000-0000-0000-000000000001','user','customer','active');
  insert into public.wallet_accounts(
    id,wallet_id,currency,available_balance,hold_balance
  ) values (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001','BDT',500000,0
  );
`);

function pricingSnapshot(sellingPrice) {
  return {
    audience: 'b2c', agencyCode: null, basis: 'lcc_service',
    supplierTotalPrice: 1000, grossPrice: 1000, availableMargin: 0,
    requestedMarkupAmount: sellingPrice - 1000,
    markupAmount: sellingPrice - 1000,
    serviceMarginAmount: sellingPrice - 1000,
    sellingPrice, grossCapApplied: false, discountFloorApplied: false,
    lccServiceMargin: true, ruleId: 'fixture-rule', markupType: 'fixed',
    markupValue: sellingPrice - 1000,
    components: [{
      stage: 'adjustment', ruleId: 'fixture-rule', markupType: 'fixed',
      markupValue: sellingPrice - 1000, basisAmount: 0,
      requestedAmount: sellingPrice - 1000, sellingBefore: 1000, sellingAfter: sellingPrice,
    }],
  };
}

const baseBooking = {
  supplierAccount: 'firsttrip',
  supplierReference: 'FST639231603524937944',
  supplierStatus: 'Booked',
  lifecycleStatus: 'on-hold',
  storedStatus: 'on-hold',
  currency: 'BDT',
  supplierPayable: 1000,
  supplierGross: 1000,
  supplierDiscount: 0,
  passengerCounts: { ADT: 1 },
  travelDate: '2026-10-01',
  itinerary: { carrierCode: 'BG', carrierName: 'Biman', refundable: false, legs: [] },
  fares: [{ passengerType: 'ADT', count: 1, basePrice: 900, taxes: 100, ait: 0, serviceMargin: 0, totalPrice: 1000 }],
  supplierFares: [{ passengerType: 'ADT', count: 1, basePrice: 900, taxes: 100, ait: 0, serviceCharge: 0, supplierTotalPrice: 1000 }],
  pricingSnapshot: pricingSnapshot(1100),
  pricingMode: 'import_time_current_markup',
  pricingCalculatedAt: '2026-08-24T06:05:01.000Z',
  supplierEvidenceTimestamp: '2026-08-24T06:05:00.000Z',
  pricingCarrierCode: 'BG',
  pricingRoutes: [{ origin: 'DAC', destination: 'CXB', departureDate: '2026-10-01' }],
  passengers: {
    travellers: [{ passengerType: 'ADT', title: 'Mr', firstName: 'Test', lastName: 'Traveller', gender: 'Male', dateOfBirth: '1990-01-01', nationality: 'BD' }],
    contact: { phone: '', phoneCountryCode: '', customerEmail: '', email: 'booking@example.com', countryCode: 'BD', cityName: 'Dhaka' },
  },
  passportRequired: false,
  supplierRefs: {
    uniqueTransId: 'FST639231603524937944',
    itemCodeRef: 'ITEM-FST-1',
    priceCodeRef: 'PRICE-FST-1',
  },
  bookingCodeRef: 'BOOK-FST-1',
  ticketCodeRef: null,
  pnr: 'PNRFST',
  bookingRefNumber: 'BR-FST-1',
  airlinesPnr: ['AIRFST'],
  ticketNumbers: [],
  ticketingTimeLimit: '2026-09-30 12:00:00',
  ticketingDeadlineAt: '2026-09-30T06:00:00.000Z',
  bookedAt: '2026-08-24T06:00:00.000Z',
  issuedAt: null,
  cancelledAt: null,
  directTicketing: false,
  supplierBookingId: 101,
  supplierMessage: null,
  retrievedAt: '2026-08-24T06:05:00.000Z',
};

const holdRequestKey = 'supplier-reference-import:v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const injectedPayable = await database.query(
  `select public.create_supplier_reference_booking_v1(
    'support','customer',109999,100000,$1::jsonb,'import_only',null,
    'supplier-reference-import:v1:99999999-9999-4999-8999-999999999999'
  ) as result`,
  [JSON.stringify(baseBooking)],
);
assert.equal(injectedPayable.rows[0].result.ok, false);
assert.equal(injectedPayable.rows[0].result.code, 'INVALID_SUPPLIER_REFERENCE_IDENTITY');
const holdCall = await database.query(
  `select public.create_supplier_reference_booking_v1(
    'support','customer',110000,100000,$1::jsonb,'import_only',null,$2
  ) as result`,
  [JSON.stringify(baseBooking), holdRequestKey],
);
const held = holdCall.rows[0].result;
assert.equal(held.ok, true);
assert.equal(held.walletCharged, false);
assert.equal(held.booking.status, 'on-hold');
assert.equal(held.booking.supplier, 'triplover');
assert.equal(held.booking.supplier_account, 'firsttrip');
assert.equal(held.booking.import_source, null);
assert.equal(held.booking.booking_origin, 'supplier_reference_import');
const afterHold = await database.query(
  `select available_balance,hold_balance from public.wallet_accounts
    where id='20000000-0000-0000-0000-000000000001'`,
);
assert.deepEqual(afterHold.rows[0], { available_balance: 500000, hold_balance: 0 });
const holdReplay = await database.query(
  `select public.create_supplier_reference_booking_v1(
    'support','customer',110000,100000,$1::jsonb,'import_only',null,$2
  ) as result`,
  [JSON.stringify(baseBooking), holdRequestKey],
);
assert.equal(holdReplay.rows[0].result.replay, true);
const holdDuplicate = await database.query(
  `select public.create_supplier_reference_booking_v1(
    'support','customer',110000,100000,$1::jsonb,'import_only',null,
    'supplier-reference-import:v1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  ) as result`,
  [JSON.stringify(baseBooking)],
);
assert.equal(holdDuplicate.rows[0].result.code, 'SUPPLIER_REFERENCE_ALREADY_EXISTS');
await assert.rejects(
  database.exec(`update public.flight_bookings set supplier_account='takeoff'
    where id='${held.booking.id}'`),
  /supplier-reference booking identity is immutable/,
);

const confirmedBooking = {
  ...baseBooking,
  supplierAccount: 'takeoff',
  supplierReference: 'TOT639231626280915380',
  supplierStatus: 'Ticketed',
  lifecycleStatus: 'confirmed',
  storedStatus: 'confirmed',
  supplierRefs: {
    uniqueTransId: 'TOT639231626280915380',
    itemCodeRef: 'ITEM-TOT-1',
    priceCodeRef: 'PRICE-TOT-1',
  },
  bookingCodeRef: 'BOOK-TOT-1',
  bookingRefNumber: 'BR-TOT-1',
  pnr: 'PNRTOT',
  airlinesPnr: ['AIRTOT'],
  ticketNumbers: ['123-4567890123'],
  ticketingTimeLimit: null,
  ticketingDeadlineAt: null,
  issuedAt: '2026-08-24T07:00:00.000Z',
  directTicketing: true,
  supplierBookingId: 102,
  pricingSnapshot: pricingSnapshot(1200),
};
const authorizationKey = 'supplier-reference-charge:v1:cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const injectedAuthorization = await database.query(
  `select public.authorize_supplier_reference_charge_v1(
    'support','customer',119999,100000,$1::jsonb,
    'supplier-reference-charge:v1:99999999-9999-4999-8999-999999999998'
  ) as result`,
  [JSON.stringify(confirmedBooking)],
);
assert.equal(injectedAuthorization.rows[0].result.ok, false);
assert.equal(injectedAuthorization.rows[0].result.code, 'CHARGE_NOT_APPLICABLE');
const authorizationCall = await database.query(
  `select public.authorize_supplier_reference_charge_v1(
    'support','customer',120000,100000,$1::jsonb,$2
  ) as result`,
  [JSON.stringify(confirmedBooking), authorizationKey],
);
const authorization = authorizationCall.rows[0].result;
assert.equal(authorization.ok, true);
assert.equal(authorization.walletMutation, false);
const afterAuthorization = await database.query(
  `select available_balance,hold_balance from public.wallet_accounts
    where id='20000000-0000-0000-0000-000000000001'`,
);
assert.deepEqual(afterAuthorization.rows[0], { available_balance: 500000, hold_balance: 0 });
const chargeRequestKey = 'supplier-reference-import:v1:dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const chargeCall = await database.query(
  `select public.create_supplier_reference_booking_v1(
    'support','customer',120000,100000,$1::jsonb,'import_and_charge',$2::uuid,$3
  ) as result`,
  [
    JSON.stringify({
      ...confirmedBooking,
      retrievedAt: '2026-08-24T06:06:00.000Z',
      supplierEvidenceTimestamp: '2026-08-24T06:06:00.000Z',
    }),
    authorization.authorizationId,
    chargeRequestKey,
  ],
);
const charged = chargeCall.rows[0].result;
assert.equal(charged.ok, true);
assert.equal(charged.walletCharged, true);
assert.equal(charged.booking.payment_state, 'captured');
const chargedState = await database.query(`
  select account.available_balance, account.hold_balance,
    (select count(*)::int from public.wallet_reservations where booking_id=$1) reservation_count,
    (select count(*)::int from public.wallet_ledger_entries where booking_id=$1) ledger_count,
    (select count(*)::int from public.supplier_reference_charge_authorizations
      where id=$2 and consumed_booking_id=$1) consumed_count
  from public.wallet_accounts account
  where account.id='20000000-0000-0000-0000-000000000001'
`, [charged.booking.id, authorization.authorizationId]);
assert.deepEqual(chargedState.rows[0], {
  available_balance: 380000,
  hold_balance: 0,
  reservation_count: 1,
  ledger_count: 1,
  consumed_count: 1,
});
const chargeReplay = await database.query(
  `select public.create_supplier_reference_booking_v1(
    'support','customer',120000,100000,$1::jsonb,'import_and_charge',$2::uuid,$3
  ) as result`,
  [JSON.stringify(confirmedBooking), authorization.authorizationId, chargeRequestKey],
);
assert.equal(chargeReplay.rows[0].result.replay, true);
const afterChargeReplay = await database.query(
  `select available_balance from public.wallet_accounts
    where id='20000000-0000-0000-0000-000000000001'`,
);
assert.equal(afterChargeReplay.rows[0].available_balance, 380000);

const cancelledBooking = {
  ...baseBooking,
  supplierAccount: 'takeoff',
  supplierReference: 'TOT000000000000000002',
  supplierStatus: 'Cancelled',
  lifecycleStatus: 'cancelled',
  storedStatus: 'cancelled',
  supplierRefs: {
    uniqueTransId: 'TOT000000000000000002',
    itemCodeRef: 'ITEM-TOT-2',
    priceCodeRef: 'PRICE-TOT-2',
  },
  bookingCodeRef: 'BOOK-TOT-2',
  bookingRefNumber: 'BR-TOT-2',
  pnr: 'PNRT02',
  airlinesPnr: ['AIRT02'],
  ticketNumbers: ['123-4567890124'],
  ticketingTimeLimit: null,
  ticketingDeadlineAt: null,
  cancelledAt: '2026-08-24T08:00:00.000Z',
  supplierBookingId: 103,
  pricingSnapshot: pricingSnapshot(1150),
};
const cancelledCall = await database.query(
  `select public.create_supplier_reference_booking_v1(
    'support','customer',115000,100000,$1::jsonb,'import_only',null,
    'supplier-reference-import:v1:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) as result`,
  [JSON.stringify(cancelledBooking)],
);
assert.equal(cancelledCall.rows[0].result.ok, true);
assert.equal(cancelledCall.rows[0].result.booking.status, 'cancelled');
assert.equal(cancelledCall.rows[0].result.booking.payment_state, 'unpaid');
const afterCancelled = await database.query(`
  select account.available_balance,
    (select count(*)::int from public.wallet_reservations where booking_id=$1) reservation_count,
    (select count(*)::int from public.wallet_ledger_entries where booking_id=$1) ledger_count
  from public.wallet_accounts account
  where account.id='20000000-0000-0000-0000-000000000001'
`, [cancelledCall.rows[0].result.booking.id]);
assert.deepEqual(afterCancelled.rows[0], {
  available_balance: 380000,
  reservation_count: 0,
  ledger_count: 0,
});

const triploverBooking = {
  ...confirmedBooking,
  supplierAccount: 'triplover',
  supplierReference: 'TLL000000000000000003',
  supplierRefs: {
    uniqueTransId: 'TLL000000000000000003',
    itemCodeRef: 'ITEM-TLL-3',
    priceCodeRef: 'PRICE-TLL-3',
  },
  bookingCodeRef: 'BOOK-TLL-3',
  bookingRefNumber: 'BR-TLL-3',
  pnr: 'PNRTLL',
  airlinesPnr: ['AIRTLL'],
  ticketNumbers: ['123-4567890125'],
  supplierBookingId: 104,
  pricingSnapshot: pricingSnapshot(1175),
};
const triploverAuthorization = await database.query(
  `select public.authorize_supplier_reference_charge_v1(
    'support','customer',117500,100000,$1::jsonb,
    'supplier-reference-charge:v1:ffffffff-ffff-4fff-8fff-ffffffffffff'
  ) as result`,
  [JSON.stringify(triploverBooking)],
);
assert.equal(triploverAuthorization.rows[0].result.ok, true);
assert.equal(triploverAuthorization.rows[0].result.walletMutation, false);
const triploverImport = await database.query(
  `select public.create_supplier_reference_booking_v1(
    'support','customer',117500,100000,$1::jsonb,'import_only',null,
    'supplier-reference-import:v1:12345678-1234-4234-8234-123456789abc'
  ) as result`,
  [JSON.stringify(triploverBooking)],
);
assert.equal(triploverImport.rows[0].result.ok, true);
assert.equal(triploverImport.rows[0].result.booking.supplier_account, 'triplover');
assert.equal(
  triploverImport.rows[0].result.booking.supplier_refs.uniqueTransId,
  'TLL000000000000000003',
);
await database.close();

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      supplierAccounts: ['firsttrip', 'takeoff', 'triplover'],
      initialLookup: 'AirTicketingDetails',
      liveVerification: 'PNR',
      operationalReferencesReal: true,
      supplierAccountImmutable: true,
      importSource: null,
      bookingOrigin: 'supplier_reference_import',
      duplicateIdentity: ['supplier_account', 'uniqueTransID'],
      authorizationMinutes: 5,
      authorizationWalletMutation: false,
      heldWalletMutation: false,
      terminalHistoryWalletMutation: false,
      confirmedChargeAtomic: true,
      browserPayableInjectionRejected: true,
      ordinaryIssueCancelRefreshReused: true,
      databaseFixture: 'hold, explicit charge, terminal history, replay, duplicate, immutable supplier binding',
    },
    null,
    2,
  ),
);
