import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const source = await fs.readFile(
  path.resolve('lib/ticket-management/entitlements.ts'),
  'utf8'
);
const correctionMigration = await fs.readFile(
  path.resolve(
    'supabase/migrations/0128_ticket_management_single_passenger_entitlement.sql'
  ),
  'utf8'
);
const manualSinglePassengerMigration = await fs.readFile(
  path.resolve(
    'supabase/migrations/0129_ticket_management_manual_single_passenger_entitlement.sql'
  ),
  'utf8'
);
assert.match(
  correctionMigration,
  /authoritative-single-passenger-user-payable/
);
assert.match(correctionMigration, /v_single_user_payable <> v_booking\.captured_amount/);
assert.doesNotMatch(correctionMigration, /update\s+public\.flight_bookings/i);
assert.doesNotMatch(correctionMigration, /insert\s+into\s+public\.wallet_/i);
assert.doesNotMatch(correctionMigration, /update\s+public\.wallet_/i);
assert.match(
  correctionMigration,
  /v_booking\.import_source in \('IMP_EXP', 'MANUAL'\)/
);
assert.match(
  manualSinglePassengerMigration,
  /v_booking\.import_source is distinct from 'MANUAL'/
);
assert.match(
  manualSinglePassengerMigration,
  /v_resolved_entitlement := nullif\(v_booking\.user_payable_amount, 0\)/
);
assert.match(
  manualSinglePassengerMigration,
  /v_resolved_entitlement <> v_booking\.captured_amount/
);
assert.match(
  manualSinglePassengerMigration,
  /jsonb_array_length\(v_booking\.passengers->'travellers'\) <> 1/
);
assert.match(
  manualSinglePassengerMigration,
  /jsonb_array_length\(v_booking\.ticket_numbers\) <> 1/
);
assert.match(manualSinglePassengerMigration, /v_booking\.payment_state <> 'captured'/);
assert.match(
  manualSinglePassengerMigration,
  /v_booking\.charged_wallet_account_id is null/
);
assert.doesNotMatch(
  manualSinglePassengerMigration,
  /update\s+public\.flight_bookings/i
);
assert.doesNotMatch(
  manualSinglePassengerMigration,
  /(insert\s+into|update|delete\s+from)\s+public\.wallet_/i
);
assert.match(
  manualSinglePassengerMigration,
  /revoke all on function\s+public\.ticket_management_ensure_booking_entitlements_pre_0129_v1\(uuid\)/i
);
assert.match(
  manualSinglePassengerMigration,
  /revoke all on function public\.ticket_management_ensure_booking_entitlements_v1\(uuid\)/i
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
const { allocateCapturedTicketEntitlements } = await import(moduleUrl);

const travellers = [
  { passengerType: 'ADT', title: 'Mr', firstName: 'One', lastName: 'Adult' },
  { passengerType: 'ADT', title: 'Ms', firstName: 'Two', lastName: 'Adult' },
  { passengerType: 'CHD', title: 'Mstr', firstName: 'Three', lastName: 'Child' },
];
const fares = [
  { passengerType: 'ADT', count: 2, totalPrice: 200 },
  { passengerType: 'CHD', count: 1, totalPrice: 50 },
];

const result = allocateCapturedTicketEntitlements({
  travellers,
  ticketNumbers: ['t-1', 'T-2', 'T-3'],
  fares,
  capturedAmountMinor: 25_000n,
});
assert.equal(result.ok, true);
assert.deepEqual(
  result.allocations.map((row) => row.entitlementAmountMinor),
  [10_000n, 10_000n, 5_000n]
);
assert.equal(
  result.allocations.reduce((sum, row) => sum + row.entitlementAmountMinor, 0n),
  25_000n
);
assert.deepEqual(
  result.allocations.map((row) => row.ticketNumber),
  ['T-1', 'T-2', 'T-3']
);
assert.deepEqual(
  result.allocations.map((row) => row.allocationSource),
  [
    'authoritative-user-payable',
    'authoritative-user-payable',
    'authoritative-user-payable',
  ]
);

const singlePassenger = [
  { passengerType: 'ADT', title: 'Mr', firstName: 'Flown', lastName: 'Passenger' },
];
const singlePassengerResult = allocateCapturedTicketEntitlements({
  travellers: singlePassenger,
  ticketNumbers: ['single-1'],
  fares: [{ passengerType: 'ADT', count: 1, totalPrice: 40_619 }],
  capturedAmountMinor: 3_764_300n,
  authoritativeUserPayableAmountMinor: 3_764_300n,
});
assert.equal(singlePassengerResult.ok, true);
assert.deepEqual(singlePassengerResult.allocations, [
  {
    passengerIndex: 0,
    passengerName: 'Mr Flown Passenger',
    passengerType: 'ADT',
    ticketNumber: 'SINGLE-1',
    entitlementAmountMinor: 3_764_300n,
    userPayableSourceMinor: 3_764_300n,
    allocationSource: 'authoritative-single-passenger-user-payable',
  },
]);
assert.deepEqual(
  allocateCapturedTicketEntitlements({
    travellers: singlePassenger,
    ticketNumbers: ['SINGLE-2'],
    fares: [{ passengerType: 'ADT', count: 1, totalPrice: 40_619 }],
    capturedAmountMinor: 3_764_300n,
    authoritativeUserPayableAmountMinor: 3_764_301n,
  }),
  { ok: false, code: 'FARE_ALLOCATION_UNAVAILABLE' }
);

assert.deepEqual(
  allocateCapturedTicketEntitlements({
    travellers,
    ticketNumbers: ['T-1'],
    fares,
    capturedAmountMinor: 25_000n,
  }),
  { ok: false, code: 'PASSENGER_TICKET_MISMATCH' }
);
assert.deepEqual(
  allocateCapturedTicketEntitlements({
    travellers,
    ticketNumbers: ['T-1', 'T-1', 'T-3'],
    fares,
    capturedAmountMinor: 25_000n,
  }),
  { ok: false, code: 'DUPLICATE_TICKET_NUMBER' }
);
assert.deepEqual(
  allocateCapturedTicketEntitlements({
    travellers,
    ticketNumbers: ['T-1', 'T-2', 'T-3'],
    fares: fares.slice(0, 1),
    capturedAmountMinor: 25_000n,
  }),
  { ok: false, code: 'FARE_ALLOCATION_UNAVAILABLE' }
);
assert.deepEqual(
  allocateCapturedTicketEntitlements({
    travellers,
    ticketNumbers: ['T-1', 'T-2', 'T-3'],
    fares,
    capturedAmountMinor: 25_001n,
  }),
  { ok: false, code: 'FARE_ALLOCATION_UNAVAILABLE' }
);

console.log('Ticket Management entitlement allocation contracts verified.');
