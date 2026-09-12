import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const source = read('lib', 'flights', 'customer-status.ts');
const bookingType = read('lib', 'flights', 'booking.ts');
const bookingDb = read('lib', 'db', 'flight-bookings.ts');
const dashboard = read('lib', 'dashboard', 'bookings.ts');
const details = read('components', 'flights', 'BookingDetails.tsx');
const actions = read('components', 'flights', 'BookingActions.tsx');
const table = read('components', 'dashboard', 'bookings', 'BookingsTable.tsx');
const email = read('lib', 'email', 'booking-template.ts');

const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, { module, exports: module.exports });
const { customerInProgressKind, customerStatusMessage } = module.exports;
assert.equal(typeof customerInProgressKind, 'function');
assert.equal(typeof customerStatusMessage, 'function');

const base = {
  status: 'in-progress',
  importSource: null,
  paymentState: 'unpaid',
  operationKind: null,
  operationReason: null,
};
const cases = [
  {
    name: 'ticketing',
    input: { ...base, operationKind: 'ticketing' },
    kind: 'ticketing',
    message: 'Ticketing is in progress with the airline.',
  },
  {
    name: 'cancellation',
    input: { ...base, operationKind: 'cancellation' },
    kind: 'cancellation',
    message: 'Your cancellation request is being processed with the airline.',
  },
  {
    name: 'imported manual ticketing',
    input: {
      ...base,
      importSource: 'IMP_EXP',
      paymentState: 'held',
      operationKind: 'ticketing',
      operationReason: 'imported_manual_ticketing',
    },
    kind: 'imported_manual_ticketing',
    message: 'User Payable is held; ticketing is being completed.',
  },
  {
    name: 'supplier verification',
    input: {
      ...base,
      operationKind: 'reconciliation',
      operationReason: 'ticketing_reconciliation',
    },
    kind: 'supplier_verification',
    message: 'We are verifying the latest booking details with the airline.',
  },
];
for (const testCase of cases) {
  assert.equal(customerInProgressKind(testCase.input), testCase.kind, testCase.name);
  assert.equal(customerStatusMessage(testCase.input), testCase.message, testCase.name);
  assert.doesNotMatch(
    testCase.message,
    /reconciliation|operation state|case|awaiting_external|needs_reconciliation/i,
    `${testCase.name} leaks an internal workflow label`
  );
}
assert.equal(
  customerStatusMessage({ ...base, status: 'confirmed' }),
  null,
  'Only In Progress has a subtype explanation'
);

for (const required of [
  'statusMessage?: string | null',
  'never an internal operation code',
]) {
  assert.ok(bookingType.includes(required), `Public DTO omits ${required}`);
}
for (const sourceText of [bookingDb, dashboard]) {
  assert.ok(
    sourceText.includes('customerStatusMessage({'),
    'Server booking mapping omits the safe customer explanation'
  );
}
for (const sourceText of [details, actions, table]) {
  assert.ok(
    sourceText.includes('statusMessage'),
    'Customer booking rendering omits the safe explanation'
  );
}
assert.ok(
  email.includes('input.booking.statusMessage ??'),
  'In Progress email copy must use the same safe subtype explanation'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      inProgressKinds: cases.map((testCase) => testCase.kind),
      publicLabel: 'In Progress',
      internalWorkflowLabelsExposed: false,
      bookingDetailEnabled: true,
      bookingListEnabled: true,
      emailEnabled: true,
    },
    null,
    2
  )
);
