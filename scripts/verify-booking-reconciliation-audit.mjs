import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (...parts) =>
  fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');
const migration = read(
  'supabase',
  'migrations',
  '0049_booking_reconciliation_security_audit.sql'
);

for (const required of [
  'security_audit_events_deny_update_delete_v1',
  'booking_reconciliation_observation_audit_v1',
  'booking_reconciliation_case_transition_audit_v1',
  "'booking.reconciliation.evidence_recorded'",
  "'booking.reconciliation.proposed'",
  "'booking.reconciliation.rejected'",
  "'booking.reconciliation.approved'",
  "'booking.reconciliation.resolved'",
  "'rawEvidenceStored', false",
  "'proposalBodyStored', false",
  "'resolutionBodyStored', false",
  "'makerCheckerSeparated'",
]) {
  assert.ok(migration.includes(required), `Audit migration omits ${required}`);
}
assert.match(
  migration,
  /before update or delete on public\.security_audit_events/
);
assert.match(
  migration,
  /after insert on public\.booking_reconciliation_observations/
);
assert.match(
  migration,
  /after update on public\.booking_reconciliation_cases/
);
for (const forbidden of [
  /new\.normalized_facts[^_]/i,
  /new\.proposal[^_a-z]/i,
  /new\.resolution[^_a-z]/i,
]) {
  assert.doesNotMatch(migration, forbidden);
}

const noChangeMigration = read(
  'supabase',
  'migrations',
  '0047_booking_reconciliation_no_change_closure.sql'
);
assert.match(
  noChangeMigration,
  /'booking\.reconciliation\.closed_no_change'/
);

const staleSupersessionMigration = read(
  'supabase',
  'migrations',
  '0095_booking_reconciliation_stale_approved_proposal_supersession.sql'
);
for (const required of [
  'booking_reconciliation_proposal_supersessions',
  'booking_reconciliation_proposal_supersessions_deny_mutation_v1',
  "'booking.reconciliation.proposal_superseded'",
  "'proposalBodyStored', false",
  "'priorReasonRecorded'",
  "'supersedeReasonHash'",
  "'walletMutation', false",
  "'supplierWrite', false",
]) {
  assert.ok(
    staleSupersessionMigration.includes(required),
    `Stale-proposal supersession audit omits ${required}`
  );
}
assert.match(
  staleSupersessionMigration,
  /before update or delete on public\.booking_reconciliation_proposal_supersessions/i
);

const route = read(
  'app',
  'api',
  'admin',
  'booking-lifecycle',
  '[reference]',
  'evidence',
  'route.ts'
);
assert.ok(
  (route.match(/booking\.reconciliation\.evidence_read_replay/g) ?? []).length >= 2,
  'Both replay paths must be audited'
);
assert.ok(
  (route.match(/if \(!replayAudited\)/g) ?? []).length >= 2,
  'Replay must fail closed when its audit cannot be stored'
);
const firstReplayAudit = route.indexOf('const replayAudited');
const firstReplayClosure = route.indexOf('const noChangeClosure', firstReplayAudit);
assert.ok(
  firstReplayAudit >= 0 && firstReplayAudit < firstReplayClosure,
  'Replay audit must precede automatic no-change closure'
);

console.log(
  JSON.stringify(
    {
      checks: 'passed',
      databaseAuditedEvents: [
        'evidence_recorded',
        'proposed',
        'rejected',
        'approved',
        'resolved',
      'closed_no_change',
      'proposal_superseded',
      ],
      lockedReplayAudited: true,
      auditMutationAllowed: false,
      rawEvidenceCopiedToAudit: false,
      proposalBodyCopiedToAudit: false,
      resolutionBodyCopiedToAudit: false,
    },
    null,
    2
  )
);
