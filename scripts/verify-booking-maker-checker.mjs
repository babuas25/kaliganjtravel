import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0050_booking_reconciliation_maker_checker.sql'
);
const actions = read('lib', 'db', 'booking-reconciliation-actions.ts');
const proposalRoute = read(
  'app',
  'api',
  'admin',
  'booking-lifecycle',
  '[reference]',
  'reconciliation',
  'proposal',
  'route.ts'
);
const decisionRoute = read(
  'app',
  'api',
  'admin',
  'booking-lifecycle',
  '[reference]',
  'reconciliation',
  'decision',
  'route.ts'
);

for (const required of [
  'propose_booking_reconciliation_v1',
  'approve_booking_reconciliation_v1',
  'reject_booking_reconciliation_v1',
  "'supplier_truth', 'financial', 'combined_supplier_financial'",
  "'terminal_correction'",
  "'money_movement'",
  "'fee_or_no_refund'",
  "'external_settlement'",
  "'historical_repair'",
  "'SELF_APPROVAL_FORBIDDEN'",
  "'CASE_VERSION_CONFLICT'",
  "'EVIDENCE_CASE_MISMATCH'",
  "interval '5 minutes'",
  "'REQUIRED_CONFIRMATION_MISSING'",
  "'statusMutationAuthorized', false",
  "'walletMutationAuthorized', false",
  "sha256(convert_to(v_proposal::text, 'UTF8'))",
]) {
  assert.ok(migration.includes(required), `Maker-checker migration omits ${required}`);
}
assert.match(
  migration,
  /approved_by_user_id\s+<>\s+proposed_by_user_id/
);
assert.match(
  migration,
  /v_actor_role not in \('superadmin', 'admin'\)/
);
assert.match(
  migration,
  /v_case\.proposal->>'requestKey' = p_request_key[\s\S]*?proposal request identity mismatch/
);
assert.ok(
  migration.indexOf('from public.flight_bookings booking') <
    migration.indexOf('from public.booking_reconciliation_cases reconciliation_case'),
  'Proposal/approval lock order must start booking then case'
);
for (const forbidden of [
  /set\s+status\s*=/i,
  /set\s+payment_state\s*=/i,
  /(?:insert|update|delete)\s+(?:into\s+|from\s+)?public\.wallet_/i,
  /insert\s+into\s+public\.wallet_ledger_entries/i,
  /insert\s+into\s+public\.booking_status_events/i,
  /insert\s+into\s+public\.booking_notification_outbox/i,
]) {
  assert.doesNotMatch(migration, forbidden);
}
assert.match(
  migration,
  /revoke all on function public\.propose_booking_reconciliation_v1\([\s\S]*?from public, anon, authenticated;/
);
assert.match(
  migration,
  /grant execute on function public\.approve_booking_reconciliation_v1\([\s\S]*?to service_role;/
);

for (const rpc of [
  'propose_booking_reconciliation_v1',
  'approve_booking_reconciliation_v1',
  'reject_booking_reconciliation_v1',
]) {
  assert.ok(actions.includes(rpc), `Database action wrapper omits ${rpc}`);
}
const makerCheckerActions = actions.slice(
  0,
  actions.indexOf('async function executeExactBookingReconciliation')
);
assert.ok(
  makerCheckerActions.length > 0,
  'Maker-checker wrapper boundary must precede exact execution helpers'
);
assert.ok(
  proposalRoute.includes('bookingReconciliationProposalAuthority'),
  'Proposal route must use granular domain authority'
);
assert.ok(
  /checkActionLimit\(\s*'bookingReconciliationWrite'/.test(proposalRoute),
  'Proposal route must apply reconciliation write rate limiting'
);
assert.match(
  proposalRoute,
  /outcome:\s*'attempted'[\s\S]*?RECONCILIATION_AUDIT_UNAVAILABLE[\s\S]*?proposeBookingReconciliation\(/
);
assert.ok(
  decisionRoute.includes('canApproveBookingReconciliation'),
  'Decision route must require the high-risk approval capability'
);
assert.ok(
  /checkActionLimit\(\s*'bookingReconciliationWrite'/.test(decisionRoute),
  'Decision route must apply reconciliation write rate limiting'
);
for (const source of [makerCheckerActions, proposalRoute, decisionRoute]) {
  for (const forbidden of [
    /(?:set|update)\s+(?:booking\.)?status/i,
    /payment_state\s*=/i,
    /wallet(?:Mutation|Balance|_ledger|_reservations?)\s*\(/i,
    /resolve_booking_reconciliation/i,
  ]) {
    assert.doesNotMatch(
      source,
      forbidden,
      'Maker-checker boundary must not expose execution or generic resolution authority'
    );
  }
}

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      proposalDomains: [
        'supplier_truth',
        'financial',
        'combined_supplier_financial',
      ],
      serverDerivedRisks: [
        'terminal_correction',
        'money_movement',
        'fee_or_no_refund',
        'external_settlement',
        'historical_repair',
      ],
      selfApprovalAllowed: false,
      optimisticVersionRequired: true,
      proposalReplayBound: true,
      freshCaseEvidenceRequired: true,
      statusMutation: false,
      walletMutation: false,
    },
    null,
    2
  )
);
