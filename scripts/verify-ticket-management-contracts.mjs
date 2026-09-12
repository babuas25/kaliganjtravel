import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = process.cwd();

function loadTypescriptModule(...parts) {
  const sourcePath = path.join(root, ...parts);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  assert.equal(
    (transpiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
    ).length,
    0,
    `${parts.join('/')} must transpile`
  );
  const module = { exports: {} };
  new vm.Script(transpiled.outputText, { filename: sourcePath }).runInNewContext({
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier.startsWith('@/')) return {};
      return require(specifier);
    },
    Set,
  });
  return module.exports;
}

const lifecycle = loadTypescriptModule(
  'lib',
  'ticket-management',
  'lifecycle.ts'
);
const permissions = loadTypescriptModule(
  'lib',
  'ticket-management',
  'permissions.ts'
);
const reissue = loadTypescriptModule(
  'lib',
  'ticket-management',
  'reissue.ts'
);
const voidSettlement = loadTypescriptModule(
  'lib',
  'ticket-management',
  'void.ts'
);

const allowedTransitions = [
  ['requested', 'in-progress'],
  ['requested', 'rejected'],
  ['in-progress', 'awaiting-confirmation'],
  ['in-progress', 'rejected'],
  ['awaiting-confirmation', 'approved'],
  ['awaiting-confirmation', 'rejected'],
  ['awaiting-confirmation', 'expired'],
  ['approved', 'in-progress'],
];
for (const [from, to] of allowedTransitions) {
  assert.equal(lifecycle.canTransitionTicketManagementStatus(from, to), true);
}
for (const [from, to] of [
  ['requested', 'approved'],
  ['in-progress', 'completed'],
  ['awaiting-confirmation', 'completed'],
  ['approved', 'completed'],
  ['rejected', 'completed'],
  ['expired', 'approved'],
  ['completed', 'in-progress'],
]) {
  assert.equal(
    lifecycle.canTransitionTicketManagementStatus(from, to),
    false,
    `${from} -> ${to} must remain forbidden`
  );
}

assert.equal(lifecycle.terminalOutcomeMatchesStatus('approved', 'refunded'), true);
assert.equal(lifecycle.terminalOutcomeMatchesStatus('rejected', 'customer-rejected'), true);
assert.equal(lifecycle.terminalOutcomeMatchesStatus('expired', 'confirmation-expired'), true);
assert.equal(lifecycle.terminalOutcomeMatchesStatus('approved', null), true);
assert.equal(lifecycle.terminalOutcomeMatchesStatus('approved', 'reissued'), true);
assert.equal(lifecycle.terminalOutcomeMatchesStatus('completed', 'customer-rejected'), false);

for (const role of ['customer', 'b2b', 'b2b_sub']) {
  assert.equal(permissions.canCreateOwnTicketManagementRequest(role), true);
}
for (const role of ['staff_support', 'admin', 'superadmin']) {
  assert.equal(permissions.canOperateTicketManagementRequest(role), true);
  assert.equal(permissions.canPublishTicketManagementQuote(role), true);
  assert.equal(permissions.canAssignTicketManagementSettlement(role), true);
}
for (const role of ['staff_account', 'admin', 'superadmin']) {
  assert.equal(permissions.canFinalizeTicketManagementSettlement(role), true);
}
for (const role of ['admin', 'superadmin']) {
  assert.equal(
    permissions.canDirectlyFinalizeTicketManagementSettlement(role),
    true
  );
}
for (const role of ['staff_support', 'staff_account', 'customer', 'b2b', 'b2b_sub', 'staff_media']) {
  assert.equal(
    permissions.canDirectlyFinalizeTicketManagementSettlement(role),
    false
  );
}
for (const role of ['staff_support', 'customer', 'b2b', 'b2b_sub', 'staff_media']) {
  assert.equal(
    permissions.canFinalizeTicketManagementSettlement(role),
    false,
    `${role} must not finalize Ticket Management money`
  );
}

const normalizedReissue = reissue.normalizeReissueCompletion([
  {
    predecessorEntitlementId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
    newTicketNumber: ' new-2 ',
    fareDifferenceAmountMinor: 300,
  },
  {
    predecessorEntitlementId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    newTicketNumber: 'new-1',
    fareDifferenceAmountMinor: 200,
  },
]);
assert.equal(normalizedReissue.totalFareDifferenceAmountMinor, 500);
assert.equal(
  normalizedReissue.tickets[0].predecessorEntitlementId,
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
);
assert.equal(normalizedReissue.tickets[1].newTicketNumber, 'NEW-2');
assert.throws(() => reissue.normalizeReissueCompletion([
  {
    predecessorEntitlementId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    newTicketNumber: 'same-ticket',
    fareDifferenceAmountMinor: 200,
  },
  {
    predecessorEntitlementId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    newTicketNumber: 'SAME-TICKET',
    fareDifferenceAmountMinor: 300,
  },
]));

assert.equal(voidSettlement.calculateVoidCustomerSettlement({
  userPayableEntitlementAmountMinor: BigInt(9500),
  airlineVoidFeeAmountMinor: BigInt(2000),
  serviceFeeAmountMinor: BigInt(500),
}).direction, 'credit');
assert.equal(voidSettlement.calculateVoidCustomerSettlement({
  userPayableEntitlementAmountMinor: BigInt(9500),
  airlineVoidFeeAmountMinor: BigInt(2000),
  serviceFeeAmountMinor: BigInt(500),
}).customerAmountMinor, BigInt(7000));
assert.equal(voidSettlement.calculateVoidCustomerSettlement({
  userPayableEntitlementAmountMinor: BigInt(5000),
  airlineVoidFeeAmountMinor: BigInt(5200),
  serviceFeeAmountMinor: BigInt(300),
}).customerAmountMinor, BigInt(500));
assert.equal(voidSettlement.calculateVoidCustomerSettlement({
  userPayableEntitlementAmountMinor: BigInt(5000),
  airlineVoidFeeAmountMinor: BigInt(4700),
  serviceFeeAmountMinor: BigInt(300),
}).direction, 'none');

const plan = fs.readFileSync(
  path.join(root, 'docs', '20-TICKET-MANAGEMENT-IMPLEMENTATION-PLAN.md'),
  'utf8'
);
assert.match(plan, /No mandatory evidence upload\/verification workflow/);
assert.match(plan, /finalizer must also be the request's active financial/);
assert.match(plan, /original `charged_wallet_account_id`/);
assert.match(plan, /Implementation authorized/);
assert.match(plan, /remain unauthorized/);

console.log('Ticket Management lifecycle and role contracts verified.');
