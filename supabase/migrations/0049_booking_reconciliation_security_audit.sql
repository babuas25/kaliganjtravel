-- Reconciliation audit is a database invariant, not only an API convention.
-- Store transition metadata and immutable identifiers, never raw evidence,
-- passenger data, proposal bodies, or resolution bodies.

create or replace function public.deny_security_audit_event_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'security audit events are immutable' using errcode = '55000';
end;
$$;

drop trigger if exists security_audit_events_deny_update_delete_v1
  on public.security_audit_events;
create trigger security_audit_events_deny_update_delete_v1
  before update or delete on public.security_audit_events
  for each row execute function public.deny_security_audit_event_mutation_v1();

create or replace function public.audit_reconciliation_observation_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_id uuid;
  v_attempt_id uuid;
begin
  select reconciliation_case.subject_booking_id,
         reconciliation_case.subject_booking_attempt_id
    into v_booking_id, v_attempt_id
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.id = new.reconciliation_case_id;

  insert into public.security_audit_events (
    actor_user_id, actor_role, action,
    target_type, target_id, outcome, metadata
  ) values (
    new.actor_user_id,
    new.actor_role,
    'booking.reconciliation.evidence_recorded',
    case when v_booking_id is not null
      then 'flight_booking' else 'booking_attempt' end,
    coalesce(v_booking_id::text, v_attempt_id::text),
    'succeeded',
    jsonb_build_object(
      'caseId', new.reconciliation_case_id,
      'observationId', new.id,
      'observationKind', new.observation_kind,
      'observationSource', new.observation_source,
      'factsHash', new.normalized_facts_hash,
      'rawEvidenceStored', false
    )
  );
  return new;
end;
$$;

drop trigger if exists booking_reconciliation_observation_audit_v1
  on public.booking_reconciliation_observations;
create trigger booking_reconciliation_observation_audit_v1
  after insert on public.booking_reconciliation_observations
  for each row execute function public.audit_reconciliation_observation_v1();

create or replace function public.reconciliation_audit_actor_role_v1(
  p_actor_user_id text
)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select app_user.role
       from public.app_users app_user
      where app_user.clerk_id = p_actor_user_id),
    case when p_actor_user_id like 'system:%' then 'system' else 'unknown' end
  );
$$;

create or replace function public.audit_reconciliation_case_transition_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target_type text := case when new.subject_booking_id is not null
    then 'flight_booking' else 'booking_attempt' end;
  v_target_id text := coalesce(
    new.subject_booking_id::text,
    new.subject_booking_attempt_id::text
  );
begin
  if new.proposal_hash is not null
     and new.proposed_by_user_id is not null
     and (
       old.proposal_hash is distinct from new.proposal_hash
       or old.proposed_at is distinct from new.proposed_at
     ) then
    insert into public.security_audit_events (
      actor_user_id, actor_role, action,
      target_type, target_id, outcome, metadata
    ) values (
      new.proposed_by_user_id,
      public.reconciliation_audit_actor_role_v1(new.proposed_by_user_id),
      'booking.reconciliation.proposed',
      v_target_type, v_target_id, 'succeeded',
      jsonb_build_object(
        'caseId', new.id,
        'caseVersion', new.version,
        'proposalHash', new.proposal_hash,
        'proposedOutcome', new.proposed_outcome,
        'financialDisposition', new.financial_disposition,
        'proposalBodyStored', false
      )
    );
  end if;

  if new.rejected_at is not null
     and new.rejected_by_user_id is not null
     and old.rejected_at is distinct from new.rejected_at then
    insert into public.security_audit_events (
      actor_user_id, actor_role, action,
      target_type, target_id, outcome, metadata
    ) values (
      new.rejected_by_user_id,
      public.reconciliation_audit_actor_role_v1(new.rejected_by_user_id),
      'booking.reconciliation.rejected',
      v_target_type, v_target_id, 'succeeded',
      jsonb_build_object(
        'caseId', new.id,
        'caseVersion', new.version,
        'proposalHash', new.proposal_hash,
        'rejectionReasonRecorded', new.rejection_reason is not null
      )
    );
  end if;

  if new.approved_at is not null
     and new.approved_by_user_id is not null
     and old.approved_at is distinct from new.approved_at then
    insert into public.security_audit_events (
      actor_user_id, actor_role, action,
      target_type, target_id, outcome, metadata
    ) values (
      new.approved_by_user_id,
      public.reconciliation_audit_actor_role_v1(new.approved_by_user_id),
      'booking.reconciliation.approved',
      v_target_type, v_target_id, 'succeeded',
      jsonb_build_object(
        'caseId', new.id,
        'caseVersion', new.version,
        'proposalHash', new.proposal_hash,
        'makerCheckerSeparated',
          new.approved_by_user_id is distinct from new.proposed_by_user_id
      )
    );
  end if;

  if new.resolved_at is not null
     and new.resolved_by_user_id is not null
     and old.resolved_at is distinct from new.resolved_at
     and not (
       new.state = 'closed_no_change'
       and new.resolution_outcome = 'supplier_truth_unchanged'
       and new.resolved_by_user_id = 'system:evidence-no-change'
     ) then
    insert into public.security_audit_events (
      actor_user_id, actor_role, action,
      target_type, target_id, outcome, metadata
    ) values (
      new.resolved_by_user_id,
      public.reconciliation_audit_actor_role_v1(new.resolved_by_user_id),
      'booking.reconciliation.resolved',
      v_target_type, v_target_id, 'succeeded',
      jsonb_build_object(
        'caseId', new.id,
        'caseVersion', new.version,
        'proposalHash', new.proposal_hash,
        'resolutionOutcome', new.resolution_outcome,
        'financialDisposition', new.financial_disposition,
        'resolutionBodyStored', false
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists booking_reconciliation_case_transition_audit_v1
  on public.booking_reconciliation_cases;
create trigger booking_reconciliation_case_transition_audit_v1
  after update on public.booking_reconciliation_cases
  for each row execute function public.audit_reconciliation_case_transition_v1();

revoke all on function public.deny_security_audit_event_mutation_v1()
  from public, anon, authenticated, service_role;
revoke all on function public.audit_reconciliation_observation_v1()
  from public, anon, authenticated, service_role;
revoke all on function public.reconciliation_audit_actor_role_v1(text)
  from public, anon, authenticated, service_role;
revoke all on function public.audit_reconciliation_case_transition_v1()
  from public, anon, authenticated, service_role;

comment on trigger booking_reconciliation_observation_audit_v1
  on public.booking_reconciliation_observations is
  'Atomically records a PII-minimized immutable security event for every newly stored reconciliation evidence observation.';
comment on trigger booking_reconciliation_case_transition_audit_v1
  on public.booking_reconciliation_cases is
  'Atomically audits proposal, rejection, approval, and resolution field transitions without copying proposal/resolution bodies.';
