import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const modulePath = path.join(
  process.cwd(),
  'lib',
  'dashboard',
  'booking-lifecycle.ts'
);
const source = fs.readFileSync(modulePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: modulePath,
  reportDiagnostics: true,
});
assert.equal(
  (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
  ).length,
  0
);
const loaded = { exports: {} };
new vm.Script(transpiled.outputText, { filename: modulePath }).runInNewContext({
  module: loaded,
  exports: loaded.exports,
});
const {
  bookingReconciliationCapabilitiesForRole,
  bookingReconciliationProposalAuthority,
  canAcquireBookingLifecycleEvidence,
  canApproveBookingReconciliation,
  canExecuteApprovedBookingReconciliation,
  canProposeBookingFinancialOutcome,
  canProposeBookingSupplierTruth,
  canViewBookingReconciliation,
} = loaded.exports;

const expected = {
  superadmin: [true, true, true, true, true, true],
  admin: [true, true, true, true, true, true],
  staff_support: [true, true, true, false, false, false],
  staff_account: [true, false, false, true, false, false],
  staff_media: [false, false, false, false, false, false],
  b2b: [false, false, false, false, false, false],
  b2b_sub: [false, false, false, false, false, false],
  customer: [false, false, false, false, false, false],
};
for (const [role, permissions] of Object.entries(expected)) {
  const actual = [
    canViewBookingReconciliation(role),
    canAcquireBookingLifecycleEvidence(role),
    canProposeBookingSupplierTruth(role),
    canProposeBookingFinancialOutcome(role),
    canApproveBookingReconciliation(role),
    canExecuteApprovedBookingReconciliation(role),
  ];
  assert.deepEqual(actual, permissions, `${role} permission matrix differs`);
  assert.equal(
    bookingReconciliationCapabilitiesForRole(role).length,
    permissions.filter(Boolean).length,
    `${role} capability list differs`
  );
}

const authority = (role, domain, riskFlags = []) =>
  bookingReconciliationProposalAuthority({ role, domain, riskFlags });
assert.equal(authority('staff_support', 'supplier_truth').proposalAllowed, true);
assert.equal(authority('staff_support', 'financial').proposalAllowed, false);
assert.equal(authority('staff_account', 'financial').proposalAllowed, true);
assert.equal(authority('staff_account', 'supplier_truth').proposalAllowed, false);
assert.equal(
  authority('staff_support', 'combined_supplier_financial').proposalAllowed,
  false
);
assert.equal(
  authority('staff_account', 'combined_supplier_financial').proposalAllowed,
  false
);
const combinedHighRisk = authority(
  'admin',
  'combined_supplier_financial',
  ['terminal_correction', 'money_movement']
);
assert.equal(combinedHighRisk.proposalAllowed, true);
assert.equal(combinedHighRisk.makerCheckerRequired, true);
assert.equal(combinedHighRisk.executionAuthorizedNow, false);
const underScopedMoney = authority('admin', 'supplier_truth', [
  'money_movement',
]);
assert.equal(underScopedMoney.proposalAllowed, false);
assert.equal(underScopedMoney.reasonCode, 'financial_domain_required');

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      capabilities: [
        'view',
        'investigate_supplier_evidence',
        'propose_supplier_truth',
        'propose_financial_outcome',
        'approve_high_risk_outcome',
        'execute_approved_outcome',
      ],
      supportFinancialProposal: false,
      accountsSupplierInvestigation: false,
      accountsSupplierProposal: false,
      staffApproval: false,
      customerInternalAccess: false,
      combinedProposalStaffAccess: false,
      highRiskProposalExecutionAuthority: false,
    },
    null,
    2
  )
);
