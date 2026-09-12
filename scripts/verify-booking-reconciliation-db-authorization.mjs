import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const makerChecker = read(
  'supabase',
  'migrations',
  '0050_booking_reconciliation_maker_checker.sql'
);
const resolutionContracts = read(
  'supabase',
  'migrations',
  '0051_booking_reconciliation_resolution_contracts.sql'
);

for (const required of [
  "p_domain = 'supplier_truth'",
  "v_actor_role not in ('superadmin', 'admin', 'staff_support')",
  "p_domain = 'financial'",
  "v_actor_role not in ('superadmin', 'admin', 'staff_account')",
  "p_domain = 'combined_supplier_financial'",
  "v_actor_role not in ('superadmin', 'admin')",
  "'PROPOSAL_FORBIDDEN'",
  "'APPROVAL_FORBIDDEN'",
  "'REJECTION_FORBIDDEN'",
  "'SELF_APPROVAL_FORBIDDEN'",
]) {
  assert.ok(makerChecker.includes(required), `Database authorization omits ${required}`);
}
assert.equal(
  (makerChecker.match(/from public\.app_users app_user/g) ?? []).length,
  3,
  'Proposal, approval, and rejection must each resolve the actor role in the database'
);
assert.doesNotMatch(
  makerChecker,
  /p_actor_role\s+text/i,
  'Maker-checker RPCs must not trust an application-supplied role'
);

for (const required of [
  'from public.app_users app_user',
  "v_actor_role not in ('superadmin', 'admin')",
  "'EXECUTION_FORBIDDEN'",
  'v_case.approved_by_user_id = v_case.proposed_by_user_id',
]) {
  assert.ok(
    resolutionContracts.includes(required),
    `Execution authorization omits ${required}`
  );
}
assert.doesNotMatch(
  resolutionContracts,
  /p_actor_role\s+text/i,
  'Resolution RPCs must not trust an application-supplied role'
);
assert.match(
  resolutionContracts,
  /revoke all on function public\.booking_reconciliation_resolution_contract_v1\([\s\S]*?from public, anon, authenticated, service_role;/i
);

for (const source of [makerChecker, resolutionContracts]) {
  assert.doesNotMatch(
    source,
    /current_setting\s*\(\s*'request\.jwt\.claims'[^)]*\)\s*::jsonb\s*->>\s*'role'/i,
    'Application database role/service_role is not a staff business role'
  );
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      actorRoleSource: 'app_users',
      clientSuppliedRoleTrusted: false,
      proposalDomainEnforcedInDatabase: true,
      approverRoleEnforcedInDatabase: true,
      executorRoleEnforcedInDatabase: true,
      selfApprovalAllowed: false,
      genericContractServiceCallable: false,
    },
    null,
    2
  )
);
