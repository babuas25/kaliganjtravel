import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read('supabase', 'migrations', '0086_manual_booking_import.sql');
const pricingScaleFix = read('supabase', 'migrations', '0087_manual_booking_pricing_scale_fix.sql');
const supplierPayableMigration = read('supabase', 'migrations', '0105_manual_booking_supplier_payable.sql');
const importedResolutionMigration = read('supabase', 'migrations', '0108_imported_booking_ticketing_resolution.sql');
const source = read('lib', 'impexp', 'booking-source.ts');
const validation = read('lib', 'impexp', 'manual-validation.ts');
const normalizer = read('lib', 'impexp', 'manual-normalize.ts');
const airlineCatalog = read('lib', 'airlines', 'catalog.ts');
const db = read('lib', 'db', 'impexp.ts');
const importRoute = read('app', 'api', 'impexp', 'manual-booking', 'route.ts');
const statusRoute = read('app', 'api', 'impexp', 'manual-booking', '[reference]', 'status', 'route.ts');
const importUi = read('components', 'dashboard', 'impexp', 'ManualBookingImportForm.tsx');
const dateTimePicker = read('components', 'dashboard', 'impexp', 'ManualDateTimeField.tsx');
const importPage = read('components', 'dashboard', 'impexp', 'ImpExpPage.tsx');
const userPicker = read('components', 'dashboard', 'impexp', 'ImpExpUserPicker.tsx');
const impexpTypes = read('lib', 'impexp', 'types.ts');
const statusUi = read('components', 'dashboard', 'bookings', 'ManualBookingStatusPanel.tsx');
const resolutionUi = read('components', 'dashboard', 'bookings', 'ImportedBookingTicketingResolutionPanel.tsx');
const permissions = read('lib', 'wallet', 'permissions.ts');
const bookingPage = read('app', '(dashboard)', 'dashboard', 'bookings', '[reference]', 'page.tsx');
const emailSnapshot = read('lib', 'email', 'booking-event-snapshot.ts');
const issueRoute = read('app', 'api', 'flights', 'booking', 'issue', 'route.ts');
const cancelRoute = read('app', 'api', 'flights', 'booking', 'cancel', 'route.ts');
const refreshRoute = read('app', 'api', 'flights', 'booking', 'refresh-details', 'route.ts');
const packageJson = JSON.parse(read('package.json'));

for (const required of [
  "import_source in ('IMP_EXP', 'MANUAL')",
  'flight_bookings_manual_reference_key',
  'manual_booking_actions',
  "action in ('import', 'status_change')",
  'flight_bookings_manual_pricing_truth_check',
  'flight_bookings_manual_on_hold_unpaid_check',
  'create or replace function public.create_manual_booking_v1(',
  'create or replace function public.update_manual_booking_status_v1(',
  "p_request_key !~ '^manual-import:v1:[0-9a-f-]{36}$'",
  "p_request_key !~ '^manual-status:v1:[0-9a-f-]{36}$'",
  "v_initial_status not in ('on-hold','confirmed')",
  "COMPLETE_CONFIRMED_MANUAL_EVIDENCE_REQUIRED",
  "ON_HOLD_MANUAL_IMPORT_CANNOT_INCLUDE_TICKETS",
  "v_initial_status='confirmed'",
  "'MANUAL'",
  "'ManualBookingImport'",
  "'ManualStatusChange'",
  "'supplierApiCalled',false",
  'insert into public.security_audit_events',
  'insert into public.wallet_ledger_entries',
  "'booking_confirm'",
  "'manual_direct_confirm'",
  "MANUAL_IN_PROGRESS_REQUIRES_TICKET_DETAILS",
  "MANUAL_TICKETING_RECONCILIATION_REQUIRED",
]) {
  assert.ok(migration.includes(required), `Manual migration omits ${required}`);
}
for (const required of [
  'manual_pricing_minor_amount_v1',
  'v_minor <> trunc(v_minor)',
  'flight_bookings_manual_pricing_truth_check',
  'enforce_manual_booking_invariants_v1',
]) {
  assert.ok(pricingScaleFix.includes(required), `Manual pricing-scale fix omits ${required}`);
}
for (const required of [
  'create or replace function public.create_manual_booking_v2(',
  'p_supplier_payable_amount bigint',
  "'supplierTotalPrice', v_supplier_payable_major",
  'manual Gross/Supplier Payable/User Payable invariant failed',
]) {
  assert.ok(supplierPayableMigration.includes(required), `Supplier Payable migration omits ${required}`);
}
for (const required of [
  'wallet_begin_imported_booking_issue_v2',
  'imported_ticketing_resolution_context_v1',
  'resolve_imported_booking_ticketing_v1',
  "accounting_mode in ('active_hold', 'legacy_captured')",
  "v_wallet_effect := 'capture_hold'",
  "v_wallet_effect := 'release_hold'",
  'update_manual_booking_status_legacy_0108',
  'IMPORTED_TICKETING_RESOLUTION_REQUIRED',
]) {
  assert.ok(importedResolutionMigration.includes(required), `0108 imported resolution omits ${required}`);
}

const createStart = migration.indexOf('create or replace function public.create_manual_booking_v1(');
const updateStart = migration.indexOf('create or replace function public.update_manual_booking_status_v1(');
const createBody = migration.slice(createStart, updateStart);
const updateBody = migration.slice(updateStart);
assert.ok(createStart >= 0 && updateStart > createStart, 'Manual RPC bodies were not found');
assert.ok(
  createBody.indexOf("if v_initial_status='confirmed' then") < createBody.indexOf('update public.wallet_accounts'),
  'Confirmed manual import must check the branch before mutating wallet money'
);
assert.ok(
  createBody.indexOf("v_wallet.status <> 'active'") < createBody.indexOf('update public.wallet_accounts'),
  'Manual import must check a frozen wallet before debit'
);
assert.ok(
  createBody.indexOf("v_account.available_balance < p_user_payable_amount") < createBody.indexOf('update public.wallet_accounts'),
  'Manual import must check funds before debit'
);
const inProgressCompletion = updateBody.match(/if v_before='in-progress' then([\s\S]*?)elsif v_before='on-hold' then/)?.[1];
assert.ok(inProgressCompletion, 'In Progress manual completion branch is unavailable');
assert.doesNotMatch(inProgressCompletion, /update\s+public\.wallet_accounts/i, 'In Progress to Confirmed must not debit again');
assert.doesNotMatch(inProgressCompletion, /insert\s+into\s+public\.wallet_ledger_entries/i, 'In Progress to Confirmed must not add a ledger debit');
assert.match(updateBody, /elsif v_before='on-hold' then[\s\S]*?update public\.wallet_accounts/, 'On Hold to Confirmed must capture wallet money atomically');

for (const required of [
  'EXTERNAL_BOOKING_SOURCES',
  '"IMP_EXP", "MANUAL"',
  'isManualBookingSource',
]) assert.ok(source.includes(required), `Booking source helper omits ${required}`);
for (const required of [
  'manualBookingImportSchema',
  'manualBookingStatusSchema',
  'Confirmed bookings require one ticket number',
  'Ticket numbers must be unique',
  'replaceAll(",", "")',
  'flightDuration',
  'baggageAllowance',
  'const terminal = z.string().trim().max(80)',
  'refundable: z.boolean()',
  'supplierPayableAmount: money',
  'Use a duration such as 4h 5m or 04:05.',
]) assert.ok(validation.includes(required), `Manual validation omits ${required}`);
for (const required of [
  'duration: segment.duration',
  'aircraft: segment.aircraft',
  'handBaggage: segment.handBaggage',
  'departureTerminal: segment.from.terminal || null',
  'arrivalTerminal: segment.to.terminal || null',
  'refundable: input.refundable',
  'supplierPayableAmount: Number(input.supplierPayableAmount)',
]) assert.ok(normalizer.includes(required), `Manual normalization omits ${required}`);
for (const required of [
  "{ code: 'BG', name: 'Biman Bangladesh Airlines' }",
  "{ code: 'SQ', name: 'Singapore Airlines' }",
  'airlineNameForCode',
]) assert.ok(airlineCatalog.includes(required), `Airline catalog omits ${required}`);
for (const required of [
  'create_manual_booking_v2',
  'update_manual_booking_status_v1',
  'manual-import:v1:',
  'manual-status:v1:',
]) assert.ok(db.includes(required), `Manual database boundary omits ${required}`);
for (const required of [
  'canAccessImpExp',
  'manualBookingImportSchema',
  'saveManualBooking',
  'dispatchBookingStatusEmails',
]) assert.ok(importRoute.includes(required), `Manual import route omits ${required}`);
for (const required of [
  'canAccessImpExp',
  'manualBookingStatusSchema',
  'updateManualBookingStatus',
  "booking.import_source !== \"MANUAL\"",
]) assert.ok(statusRoute.includes(required), `Manual status route omits ${required}`);
for (const required of [
  'Import On Hold — No Wallet Charge',
  'Import & Charge Confirmed Booking',
  'Flight itinerary',
  'Passengers and fare breakdown',
  'findAirportByIata',
  'Origin',
  'Destination',
  'Enter airport code first',
  'formatMoneyInput',
  'Amounts are grouped automatically',
  'Supplier payable',
  'Flight duration',
  'Cabin baggage',
  'Aircraft model',
  '4h 5m or 04:05',
  'updateCarrierCode',
  'Carrier name',
  'Departure terminal (optional)',
  'Arrival terminal (optional)',
  'Refundability',
  'Non-refundable',
  'refundable: form.refundable',
]) assert.ok(importUi.includes(required), `Manual import UI omits ${required}`);
for (const required of [
  'ManualDateTimeField',
  'value={segment.departureAt}',
  'value={segment.arrivalAt}',
]) assert.ok(importUi.includes(required), `Manual itinerary UI omits ${required}`);
assert.doesNotMatch(
  importUi,
  /type="datetime-local" value=\{segment\.(?:departureAt|arrivalAt)\}/,
  'Manual itinerary must not depend on the device-native date-time picker',
);
for (const required of [
  '<Calendar',
  'Time (24-hour)',
  'max-h-[calc(100vh-1rem)]',
  'sticky bottom-0',
  'commit(draftDate, hour, draftMinute)',
  'commit(draftDate, draftHour, minute)',
]) assert.ok(dateTimePicker.includes(required), `Manual date-time picker omits ${required}`);
for (const ui of [importUi, importPage]) {
  assert.ok(
    ui.includes('ImpExpUserPicker'),
    'Every Impexp owner flow must use the searchable user picker',
  );
}
for (const required of [
  'Search person, agency name or agency ID',
  'Agency ID:',
  'user.agencyName',
  'user.agencyId',
  'user.email',
]) assert.ok(userPicker.includes(required), `Impexp user picker omits ${required}`);
assert.ok(
  userPicker.includes('user.agencyName?.trim() || user.name'),
  'Impexp user picker must fall back to the B2B account name',
);
assert.ok(
  !userPicker.includes('Agency name unavailable'),
  'Impexp user picker must not show an unavailable agency-name label',
);
for (const required of ['agencyId: string | null', 'agencyName: string | null']) {
  assert.ok(impexpTypes.includes(required), `Impexp user type omits ${required}`);
}
for (const required of [
  'agency_code',
  '.from("agencies")',
  '.from("user_profiles")',
  'agencyOwnerByCode',
  'agencyNameByOwner',
]) assert.ok(db.includes(required), `Impexp agency lookup omits ${required}`);
assert.doesNotMatch(
  db,
  /for \(const row of data[^]*?await supabase/,
  'Impexp agency metadata lookup must not issue per-user database requests',
);
for (const required of [
  'Manual booking status',
  'Supplier API and Sync actions are never used',
]) assert.ok(statusUi.includes(required), `Manual status UI omits ${required}`);
assert.doesNotMatch(
  statusUi,
  /const STAFF_TARGETS[^\n]*'confirmed'/,
  'Legacy Manual status UI must not offer direct confirmation',
);
for (const required of [
  'Imported Booking Ticketing Resolution',
  'Ticket number',
  'Issued Date & Time',
  'Cancellation Date & Time',
  'Available before',
  'Hold before',
]) assert.ok(resolutionUi.includes(required), `Imported resolution UI omits ${required}`);
assert.ok(permissions.includes('isExternalBookingSource(booking.import_source)'), 'Customer Confirm & Pay must include manual source ownership');
assert.ok(bookingPage.includes('ManualBookingStatusPanel') && bookingPage.includes('manualBooking={manual}'), 'Manual booking details must expose only the manual staff panel');
assert.ok(emailSnapshot.includes("z.enum(['IMP_EXP', 'MANUAL']).nullable()"), 'Manual events must render through existing email snapshots');
for (const [name, route] of Object.entries({ issueRoute, cancelRoute, refreshRoute })) {
  assert.ok(route.includes("booking.import_source === 'MANUAL'"), `${name} must block manual source supplier actions`);
}
assert.equal(packageJson.scripts['verify:manual-booking-import'], 'node scripts/verify-manual-booking-import.mjs');

// Compile and exercise the manual commands in an isolated Postgres-compatible
// database. The fixture has only the shared canonical tables the migration
// touches; no supplier adapter, sync, or historical rows are involved.
const database = new PGlite({ extensions: { pgcrypto } });
await database.exec(`
  create role anon; create role authenticated; create role service_role;
  create extension if not exists pgcrypto;
  create sequence public.manual_booking_ref_seq;
  create or replace function public.allocate_booking_ref() returns text language sql as $$
    select 'STR260816' || lpad(nextval('public.manual_booking_ref_seq')::text, 6, '0')
  $$;
  create or replace function public.sha256(value bytea) returns bytea language sql immutable as $$
    select decode(repeat('00', 32), 'hex')
  $$;
  create table public.app_users (clerk_id text primary key, role text not null, agency_code text);
  create table public.booking_attempts (
    id uuid primary key, access_token_hash text, user_id text, audience text, agency_code text, supplier text, state text,
    search_id uuid, itinerary_id text, unique_trans_id text, item_code_ref text, price_code_ref text, booking_code_ref text,
    pnr text, offer_snapshot jsonb, passenger_snapshot jsonb, expires_at timestamptz, submitted_at timestamptz,
    resolved_at timestamptz, created_at timestamptz, updated_at timestamptz default clock_timestamp()
  );
  create table public.wallets (id uuid primary key default gen_random_uuid(), owner_type text, owner_key text, status text);
  create table public.wallet_accounts (
    id uuid primary key default gen_random_uuid(), wallet_id uuid, currency text, available_balance bigint, hold_balance bigint
  );
  create table public.flight_bookings (
    id uuid primary key, public_ref text, attempt_id uuid, access_token_hash text, supplier text, user_id text, audience text,
    agency_code text, search_id uuid, itinerary_id text, status text, operation_kind text, operation_reason text,
    operation_request_id text, operation_actor_user_id text, operation_started_at timestamptz, operation_prior_status text,
    active_operation_id uuid, currency text, pricing_snapshot jsonb, passenger_counts jsonb, travel_date date,
    direct_ticketing boolean, itinerary jsonb, fares jsonb, passport_required boolean, supplier_refs jsonb,
    repriced_at timestamptz, accepted_at timestamptz, expires_at timestamptz, passengers jsonb, pnr text,
    airlines_pnr jsonb, booking_ref_number text, booking_status text, ticketing_time_limit text,
    ticketing_deadline_at timestamptz, deadline_source text, booking_code_ref text, ticket_numbers jsonb, warnings jsonb,
    supplier_message text, issued_at timestamptz, cancelled_at timestamptz, cancelled_by text, cancel_reason text,
    submission_started_at timestamptz, legacy_operational boolean, booked_by_user_id text, issued_by_user_id text,
    booking_owner_type text, booking_owner_key text, charged_wallet_account_id uuid, payment_state text,
    payment_amount bigint, captured_amount bigint default 0, refunded_amount bigint default 0,
    supplier_gross_amount bigint, user_payable_amount bigint, import_source text, imported_by_user_id text,
    import_metadata jsonb, created_at timestamptz, updated_at timestamptz default clock_timestamp()
  );
  create table public.wallet_reservations (
    id uuid primary key default gen_random_uuid(), wallet_account_id uuid, booking_id uuid, amount bigint, currency text,
    state text, requested_by_user_id text, issued_by_user_id text, captured_at timestamptz, released_at timestamptz,
    release_reason text, reconciliation_at timestamptz, reconciliation_reason text,
    updated_at timestamptz default clock_timestamp()
  );
  create unique index wallet_reservation_booking_fixture on public.wallet_reservations(booking_id);
  create table public.wallet_ledger_entries (
    id uuid primary key default gen_random_uuid(), wallet_account_id uuid, transaction_type text, amount bigint, currency text,
    available_before bigint, available_after bigint, hold_before bigint, hold_after bigint, booking_id uuid,
    booking_reference text, reservation_id uuid, idempotency_key text unique, created_by_user_id text, created_by_role text,
    remarks text, metadata jsonb, created_at timestamptz default clock_timestamp()
  );
  create table public.booking_operations (
    id uuid primary key default gen_random_uuid(), booking_id uuid, kind text, state text, reason_code text, reason_detail text,
    request_key text, request_payload_hash text, actor_user_id text, actor_role text, source text, prior_stored_status text,
    prior_lifecycle_status text, supplier text, supplier_operation text, supplier_unique_trans_id text,
    supplier_booking_code_ref text, supplier_pnr text, supplier_evidence jsonb, policy_version integer,
    claimed_at timestamptz, external_action_due_at timestamptz, completed_at timestamptz
  );
  create table public.booking_reconciliation_cases (
    id uuid primary key default gen_random_uuid(), subject_booking_id uuid, operation_id uuid, case_type text, state text,
    reason_code text, reason_detail text, opened_source text, opened_by_user_id text, opened_by_role text, opened_at timestamptz,
    assigned_team text, assigned_at timestamptz, severity text, priority integer, due_at timestamptz, escalation_level integer,
    evidence jsonb, financial_disposition text, policy_version integer, resolution_outcome text, resolution jsonb,
    resolution_reason text, financial_amount bigint, financial_currency text, external_settlement_reference text,
    resolved_by_user_id text, resolved_at timestamptz, closed_at timestamptz, version integer default 1
  );
  create table public.booking_status_events (
    id bigint generated always as identity primary key, booking_id uuid, from_lifecycle_status text, to_lifecycle_status text,
    stored_status_before text, stored_status_after text, operation_kind text, operation_reason text, actor_user_id text,
    supplier_operation text, supplier_evidence jsonb, idempotency_key text, operation_id uuid, reconciliation_case_id uuid,
    occurrence_number integer, effective_at timestamptz, observed_at timestamptz, event_snapshot jsonb, event_version integer,
    created_at timestamptz default clock_timestamp()
  );
  create unique index booking_status_event_fixture on public.booking_status_events(booking_id, idempotency_key, to_lifecycle_status);
  create table public.security_audit_events (
    id uuid primary key default gen_random_uuid(), actor_user_id text, actor_role text, action text, target_type text,
    target_id text, outcome text, metadata jsonb, created_at timestamptz default clock_timestamp()
  );
  create or replace function public.impexp_pricing_minor_amount_v1(p_pricing jsonb, p_key text)
  returns bigint language sql immutable as $$ select round((p_pricing->>p_key)::numeric * 100)::bigint $$;
  create or replace function public.jsonb_is_nonempty_array(value jsonb) returns boolean language sql immutable as $$
    select jsonb_typeof(value) = 'array' and jsonb_array_length(value) > 0
  $$;
  create or replace function public.resolve_booking_lifecycle(status text, airlines_pnr jsonb, deadline timestamptz, operation_kind text)
  returns text language sql stable as $$
    select case when status='cancelled' then 'cancelled' when status='confirmed' then 'confirmed'
      when status='in-progress' or operation_kind is not null then 'in-progress' when status='pending' then 'pending'
      when status='on-hold' and not public.jsonb_is_nonempty_array(airlines_pnr) then 'unconfirmed'
      when status='on-hold' and deadline is not null and deadline <= clock_timestamp() then 'expired' else 'on-hold' end
  $$;
`);
await database.exec(migration);
await database.exec(pricingScaleFix);
await database.exec(supplierPayableMigration);
const manualPricingScale = await database.query(`
  select
    public.manual_pricing_minor_amount_v1(
      jsonb_build_object('sellingPrice', 4238800::numeric / 100),
      'sellingPrice'
    ) as accepted_minor,
    public.manual_pricing_minor_amount_v1(
      jsonb_build_object('sellingPrice', 42388.001::numeric),
      'sellingPrice'
    ) as rejected_minor
`);
assert.equal(manualPricingScale.rows[0]?.accepted_minor, 4238800, 'Manual pricing must accept exact cents despite PostgreSQL numeric scale');
assert.equal(manualPricingScale.rows[0]?.rejected_minor, null, 'Manual pricing must reject fractions of a cent');
await database.exec(`
  insert into public.app_users (clerk_id, role) values ('support', 'staff_support'), ('customer', 'customer');
  insert into public.wallets (id, owner_type, owner_key, status) values ('10000000-0000-0000-0000-000000000001', 'user', 'customer', 'active');
  insert into public.wallet_accounts (id, wallet_id, currency, available_balance, hold_balance)
  values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'BDT', 100000, 0);
`);

const base = {
  provider: 'MANUAL', supplierReference: 'MANUAL-001', initialStatus: 'on-hold', currency: 'BDT',
  supplierPayableAmount: 850,
  travelDate: '2026-10-01', pnr: 'PNR001', airlinesPnr: ['PNR001'], ticketNumbers: [],
  passengerCounts: { ADT: 1 }, itinerary: { carrierCode: 'BG', carrierName: 'Biman', refundable: false, legs: [] },
  fares: [{ passengerType: 'ADT', count: 1, basePrice: 900, taxes: 50, ait: 0, serviceMargin: 0, totalPrice: 950 }],
  passengers: { travellers: [{ passengerType: 'ADT', title: 'Mr', firstName: 'Test', lastName: 'Traveller', gender: 'Male', dateOfBirth: '1990-01-01', nationality: 'BD' }], contact: { phone: '01700000000', phoneCountryCode: '+880', customerEmail: 'test@example.com', email: 'test@example.com', countryCode: 'BD', cityName: 'Dhaka' } },
  passportRequired: false, ticketingDeadlineAt: null, issuedAt: null, supplierMessage: null,
};
const importCall = await database.query(
  `select public.create_manual_booking_v2('support','customer',95000,90000,85000,$1::jsonb,'manual-import:v1:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') as result`,
  [JSON.stringify(base)],
);
const imported = importCall.rows[0].result;
assert.equal(imported.ok, true);
assert.equal(imported.walletCharged, false);
assert.equal(imported.status, 'on-hold');
const bookingId = imported.booking.id;
const commercialValues = await database.query(
  'select supplier_gross_amount, pricing_snapshot->>\'supplierTotalPrice\' as supplier_payable from public.flight_bookings where id=$1',
  [bookingId],
);
assert.equal(commercialValues.rows[0].supplier_gross_amount, 90000);
assert.equal(Number(commercialValues.rows[0].supplier_payable), 850);
const noDebit = await database.query('select available_balance from public.wallet_accounts where id=$1', ['20000000-0000-0000-0000-000000000001']);
assert.equal(Number(noDebit.rows[0].available_balance), 100000);

const ownerConfirm = await database.query(
  `select public.wallet_confirm_impexp_booking($1::uuid,'customer','cccccccc-cccc-4ccc-8ccc-cccccccccccc') as result`, [bookingId],
);
assert.equal(ownerConfirm.rows[0].result.ok, true);
assert.equal(ownerConfirm.rows[0].result.status, 'in-progress');
const afterOwnerConfirm = await database.query('select status,payment_state,captured_amount from public.flight_bookings where id=$1', [bookingId]);
assert.deepEqual(afterOwnerConfirm.rows[0], { status: 'in-progress', payment_state: 'captured', captured_amount: 95000 });

// Apply the new forward migration only after constructing one legacy
// pre-ticketing capture. This proves backward compatibility as well as the new
// Hold-based flow in the same isolated database.
await database.exec(importedResolutionMigration);
const legacyContext = await database.query(
  `select public.imported_ticketing_resolution_context_v1($1::uuid,'support') as result`,
  [bookingId],
);
assert.equal(legacyContext.rows[0].result.ok, true);
assert.equal(legacyContext.rows[0].result.accountingMode, 'legacy_captured');
assert.equal(legacyContext.rows[0].result.confirmEffect, 'none');
const customerContext = await database.query(
  `select public.imported_ticketing_resolution_context_v1($1::uuid,'customer') as result`,
  [bookingId],
);
assert.equal(customerContext.rows[0].result.code, 'IMPORTED_RESOLUTION_FORBIDDEN');
const legacyConfirm = await database.query(
  `select public.resolve_imported_booking_ticketing_v1(
    $1::uuid,'support','confirm_ticketed',$2::jsonb,
    'imported-resolution:v1:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true
  ) as result`,
  [bookingId, JSON.stringify({ ticketNumbers: ['123-4567890123'], issuedAt: '2026-08-16T10:00:00.000Z' })],
);
assert.equal(legacyConfirm.rows[0].result.ok, true);
assert.equal(legacyConfirm.rows[0].result.walletEffect, 'none');
const oneDebit = await database.query('select available_balance from public.wallet_accounts where id=$1', ['20000000-0000-0000-0000-000000000001']);
assert.equal(Number(oneDebit.rows[0].available_balance), 5000);
const ledgerCount = await database.query('select count(*)::int as count from public.wallet_ledger_entries where booking_id=$1', [bookingId]);
assert.equal(Number(ledgerCount.rows[0].count), 1);

// New imported Issue Now must Hold, never capture. The former manual status
// confirmation path is blocked, and cancellation releases that exact Hold.
await database.exec(`update public.wallet_accounts set available_balance=300000 where id='20000000-0000-0000-0000-000000000001'`);
const directHoldData = { ...base, supplierReference: 'MANUAL-002' };
const directHoldImport = await database.query(
  `select public.create_manual_booking_v2('support','customer',95000,90000,85000,$1::jsonb,'manual-import:v1:dddddddd-dddd-4ddd-8ddd-dddddddddddd') as result`,
  [JSON.stringify(directHoldData)],
);
const directHoldId = directHoldImport.rows[0].result.booking.id;
const newIssue = await database.query(
  `select public.wallet_confirm_impexp_booking($1::uuid,'customer','dddddddd-dddd-4ddd-8ddd-dddddddddddd') as result`,
  [directHoldId],
);
assert.equal(newIssue.rows[0].result.ok, true);
assert.equal(newIssue.rows[0].result.paymentState, 'held');
const newIssueReplay = await database.query(
  `select public.wallet_confirm_impexp_booking($1::uuid,'customer','dddddddd-dddd-4ddd-8ddd-dddddddddddd') as result`,
  [directHoldId],
);
assert.equal(newIssueReplay.rows[0].result.replay, true);
const heldState = await database.query(
  'select status,payment_state,captured_amount from public.flight_bookings where id=$1',
  [directHoldId],
);
assert.deepEqual(heldState.rows[0], { status: 'in-progress', payment_state: 'held', captured_amount: 0 });
const afterHold = await database.query(
  'select available_balance,hold_balance from public.wallet_accounts where id=$1',
  ['20000000-0000-0000-0000-000000000001'],
);
assert.deepEqual(afterHold.rows[0], { available_balance: 205000, hold_balance: 95000 });
const blockedLegacyConfirm = await database.query(
  `select public.update_manual_booking_status_v1($1::uuid,'support','confirmed',$2::jsonb,'manual-status:v1:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee') as result`,
  [directHoldId, JSON.stringify({ ticketNumbers: ['123-4567890124'], issuedAt: '2026-08-16T11:00:00.000Z' })],
);
assert.equal(blockedLegacyConfirm.rows[0].result.code, 'IMPORTED_TICKETING_RESOLUTION_REQUIRED');
const holdCancel = await database.query(
  `select public.resolve_imported_booking_ticketing_v1(
    $1::uuid,'support','cancel',$2::jsonb,
    'imported-resolution:v1:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',true
  ) as result`,
  [directHoldId, JSON.stringify({ cancellationAt: '2026-08-16T11:30:00.000Z', cancellationReason: 'Ticket was not issued' })],
);
assert.equal(holdCancel.rows[0].result.walletEffect, 'release_hold');
const afterRelease = await database.query(
  'select available_balance,hold_balance from public.wallet_accounts where id=$1',
  ['20000000-0000-0000-0000-000000000001'],
);
assert.deepEqual(afterRelease.rows[0], { available_balance: 300000, hold_balance: 0 });
const directLedgerCount = await database.query('select count(*)::int as count from public.wallet_ledger_entries where booking_id=$1', [directHoldId]);
assert.equal(Number(directLedgerCount.rows[0].count), 2);

const captureHoldData = { ...base, supplierReference: 'MANUAL-004' };
const captureHoldImport = await database.query(
  `select public.create_manual_booking_v2('support','customer',95000,90000,85000,$1::jsonb,'manual-import:v1:11111111-1111-4111-8111-111111111111') as result`,
  [JSON.stringify(captureHoldData)],
);
const captureHoldId = captureHoldImport.rows[0].result.booking.id;
await database.query(
  `select public.wallet_confirm_impexp_booking($1::uuid,'customer','22222222-2222-4222-8222-222222222222') as result`,
  [captureHoldId],
);
const holdConfirm = await database.query(
  `select public.resolve_imported_booking_ticketing_v1(
    $1::uuid,'support','confirm_ticketed',$2::jsonb,
    'imported-resolution:v1:33333333-3333-4333-8333-333333333333',true
  ) as result`,
  [captureHoldId, JSON.stringify({ ticketNumbers: ['123-4567890126'], issuedAt: '2026-08-16T12:00:00.000Z' })],
);
assert.equal(holdConfirm.rows[0].result.walletEffect, 'capture_hold');
const holdConfirmReplay = await database.query(
  `select public.resolve_imported_booking_ticketing_v1(
    $1::uuid,'support','confirm_ticketed',$2::jsonb,
    'imported-resolution:v1:33333333-3333-4333-8333-333333333333',true
  ) as result`,
  [captureHoldId, JSON.stringify({ ticketNumbers: ['123-4567890126'], issuedAt: '2026-08-16T12:00:00.000Z' })],
);
assert.equal(holdConfirmReplay.rows[0].result.replay, true);
const afterCapture = await database.query(
  'select available_balance,hold_balance from public.wallet_accounts where id=$1',
  ['20000000-0000-0000-0000-000000000001'],
);
assert.deepEqual(afterCapture.rows[0], { available_balance: 205000, hold_balance: 0 });
const captureLedgerCount = await database.query(
  'select count(*)::int as count from public.wallet_ledger_entries where booking_id=$1',
  [captureHoldId],
);
assert.equal(Number(captureLedgerCount.rows[0].count), 2);

const ticketedImportData = {
  ...base,
  supplierReference: 'MANUAL-003',
  initialStatus: 'confirmed',
  ticketNumbers: ['123-4567890125'],
  issuedAt: '2026-08-16T12:00:00.000Z',
};
const ticketedImport = await database.query(
  `select public.create_manual_booking_v2('support','customer',95000,90000,85000,$1::jsonb,'manual-import:v1:ffffffff-ffff-4fff-8fff-ffffffffffff') as result`,
  [JSON.stringify(ticketedImportData)],
);
assert.equal(ticketedImport.rows[0].result.ok, true);
assert.equal(ticketedImport.rows[0].result.status, 'confirmed');
assert.equal(ticketedImport.rows[0].result.walletCharged, true);
const ticketedId = ticketedImport.rows[0].result.booking.id;
const ticketedState = await database.query('select status,payment_state,captured_amount,ticket_numbers from public.flight_bookings where id=$1', [ticketedId]);
assert.equal(ticketedState.rows[0].status, 'confirmed');
assert.equal(ticketedState.rows[0].payment_state, 'captured');
assert.equal(Number(ticketedState.rows[0].captured_amount), 95000);
const ticketedLedgerCount = await database.query('select count(*)::int as count from public.wallet_ledger_entries where booking_id=$1', [ticketedId]);
assert.equal(Number(ticketedLedgerCount.rows[0].count), 1);
await database.close();

console.log(JSON.stringify({
  checks: 'passed',
  source: 'MANUAL',
  flows: ['on-hold-import-only', 'legacy-captured-confirm-no-debit', 'owner-issue-now-hold', 'held-confirm-capture', 'held-cancellation-release', 'direct-confirmed-import-and-charge'],
  supplierApiActions: false,
  walletTransitionsAtomic: true,
  idempotency: true,
  databaseFixture: 'legacy capture compatibility, active Hold/Release, direct confirmed charge',
}, null, 2));
