-- Forward-only recovery for an approved reconciliation proposal whose
-- proposal-bound evidence expired before execution.
--
-- This deliberately does not amend an approved proposal. The source case keeps
-- its proposal, maker/checker approval, evidence IDs, and reason unchanged;
-- it is marked terminally superseded and a separate successor case starts an
-- entirely new evidence/proposal/approval cycle.

alter table public.booking_reconciliation_cases
  drop constraint if exists booking_reconciliation_cases_state_check;

alter table public.booking_reconciliation_cases
  add constraint booking_reconciliation_cases_state_check
  check (state in (
    'open',
    'assigned',
    'awaiting_supplier',
    'awaiting_finance',
    'awaiting_approval',
    'resolved',
    'closed_no_change',
    'superseded'
  ));

alter table public.booking_reconciliation_cases
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_by_user_id text,
  add column if not exists superseded_by_role text,
  add column if not exists supersede_reason text,
  add column if not exists superseded_by_case_id uuid,
  add column if not exists supersedes_case_id uuid;

alter table public.booking_reconciliation_cases
  add constraint booking_reconciliation_cases_superseded_by_case_fk
  foreign key (superseded_by_case_id)
  references public.booking_reconciliation_cases (id)
  on delete restrict
  not valid,
  add constraint booking_reconciliation_cases_supersedes_case_fk
  foreign key (supersedes_case_id)
  references public.booking_reconciliation_cases (id)
  on delete restrict
  not valid,
  add constraint booking_reconciliation_cases_superseded_shape_v1_check
  check (
    (
      state = 'superseded'
      and superseded_at is not null
      and nullif(btrim(superseded_by_user_id), '') is not null
      and nullif(btrim(superseded_by_role), '') is not null
      and nullif(btrim(supersede_reason), '') is not null
      and resolved_at is null
    )
    or (
      state <> 'superseded'
      and superseded_at is null
      and superseded_by_user_id is null
      and superseded_by_role is null
      and supersede_reason is null
      and superseded_by_case_id is null
    )
  ) not valid;

create unique index if not exists
  booking_reconciliation_cases_superseded_by_case_unique_idx
  on public.booking_reconciliation_cases (superseded_by_case_id)
  where superseded_by_case_id is not null;

create unique index if not exists
  booking_reconciliation_cases_supersedes_case_unique_idx
  on public.booking_reconciliation_cases (supersedes_case_id)
  where supersedes_case_id is not null;

create table if not exists public.booking_reconciliation_proposal_supersessions (
  id uuid primary key default gen_random_uuid(),
  source_case_id uuid not null references public.booking_reconciliation_cases (id)
    on delete restrict,
  successor_case_id uuid not null references public.booking_reconciliation_cases (id)
    on delete restrict,
  superseded_proposal_hash text not null check (superseded_proposal_hash ~ '^[a-f0-9]{64}$'),
  superseded_proposal jsonb not null check (jsonb_typeof(superseded_proposal) = 'object'),
  superseded_proposed_by_user_id text not null,
  superseded_proposed_at timestamptz not null,
  superseded_approved_by_user_id text not null,
  superseded_approved_at timestamptz not null,
  superseded_evidence_observation_ids jsonb not null
    check (jsonb_typeof(superseded_evidence_observation_ids) = 'array'),
  superseded_by_user_id text not null,
  superseded_by_role text not null,
  superseded_at timestamptz not null default clock_timestamp(),
  supersede_request_key text not null,
  supersede_reason text not null,
  constraint booking_reconciliation_proposal_supersessions_distinct_cases_check
    check (source_case_id <> successor_case_id),
  constraint booking_reconciliation_proposal_supersessions_maker_checker_check
    check (superseded_proposed_by_user_id <> superseded_approved_by_user_id),
  constraint booking_reconciliation_proposal_supersessions_reason_check
    check (nullif(btrim(supersede_reason), '') is not null),
  constraint booking_reconciliation_proposal_supersessions_request_key_check
    check (nullif(btrim(supersede_request_key), '') is not null
      and char_length(supersede_request_key) <= 220),
  unique (source_case_id, superseded_proposal_hash),
  unique (source_case_id, supersede_request_key)
);

create or replace function public.deny_booking_reconciliation_proposal_supersession_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'booking reconciliation proposal supersessions are immutable'
    using errcode = '55000';
end;
$$;

drop trigger if exists booking_reconciliation_proposal_supersessions_deny_mutation_v1
  on public.booking_reconciliation_proposal_supersessions;
create trigger booking_reconciliation_proposal_supersessions_deny_mutation_v1
  before update or delete on public.booking_reconciliation_proposal_supersessions
  for each row execute function public.deny_booking_reconciliation_proposal_supersession_mutation_v1();

create or replace function public.supersede_stale_approved_booking_reconciliation_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_expected_case_version integer,
  p_proposal_hash text,
  p_actor_user_id text,
  p_request_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_case_operation_id uuid;
  v_existing public.booking_reconciliation_proposal_supersessions;
  v_successor_case_id uuid;
  v_supersession_id uuid;
  v_successor_case_version integer;
  v_source_case_version integer;
  v_evidence_ids uuid[];
  v_evidence_input_count integer;
  v_evidence_found_count integer;
  v_stale_evidence_count integer;
  v_cutoff timestamptz := clock_timestamp() - interval '5 minutes';
begin
  if p_booking_id is null
     or p_case_id is null
     or p_expected_case_version is null
     or p_expected_case_version < 1
     or p_proposal_hash is null
     or p_proposal_hash !~ '^[a-f0-9]{64}$'
     or nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_request_key), '') is null
     or char_length(p_request_key) > 220
     or nullif(btrim(p_reason), '') is null
     or char_length(p_reason) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PROPOSAL_SUPERSESSION');
  end if;

  select app_user.role into v_actor_role
    from public.app_users app_user
   where app_user.clerk_id = p_actor_user_id;
  if coalesce(v_actor_role, '') <> 'superadmin' then
    return jsonb_build_object('ok', false, 'code', 'SUPERSESSION_FORBIDDEN');
  end if;

  -- Preserve the global reconciliation lock order: booking -> operation -> case.
  select reconciliation_case.operation_id into v_case_operation_id
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.id = p_case_id
     and reconciliation_case.subject_booking_id = p_booking_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND');
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  if v_case_operation_id is not null then
    select operation.* into v_operation
      from public.booking_operations operation
     where operation.id = v_case_operation_id
       and operation.booking_id = p_booking_id
     for update;
  end if;

  select reconciliation_case.* into v_case
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.id = p_case_id
     and reconciliation_case.subject_booking_id = p_booking_id
   for update;
  if not found or v_case.operation_id is distinct from v_case_operation_id then
    return jsonb_build_object('ok', false, 'code', 'CASE_OPERATION_CHANGED');
  end if;

  select supersession.* into v_existing
    from public.booking_reconciliation_proposal_supersessions supersession
   where supersession.source_case_id = p_case_id
     and supersession.supersede_request_key = p_request_key;
  if found then
    if v_existing.superseded_proposal_hash = p_proposal_hash
       and v_existing.superseded_by_user_id = p_actor_user_id
       and v_existing.supersede_reason = p_reason then
      return jsonb_build_object(
        'ok', true,
        'replay', true,
        'caseId', p_case_id,
        'caseVersion', v_case.version,
        'proposalHash', p_proposal_hash,
        'supersessionId', v_existing.id,
        'successorCaseId', v_existing.successor_case_id,
        'requiresFreshEvidence', true,
        'bookingMutation', false,
        'walletMutation', false,
        'reservationMutation', false,
        'ledgerMutation', false,
        'supplierWrite', false
      );
    end if;
    raise exception 'proposal supersession request identity mismatch' using errcode = '22023';
  end if;

  -- Replay is intentionally checked before mutable booking/operation state so
  -- a safely completed request can be returned idempotently even after the
  -- successor review later completes the original operation.
  if v_booking.status <> 'in-progress'
     or v_booking.payment_state <> 'reconciliation'
     or v_booking.captured_amount <> 0
     or v_booking.refunded_amount <> 0
     or v_booking.active_operation_id is distinct from v_case_operation_id then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_STALE_CAPTURE_RECONCILIATION');
  end if;
  if v_case_operation_id is null
     or v_operation.id is null
     or v_operation.state <> 'needs_reconciliation' then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_RECONCILING');
  end if;
  if v_case.state = 'superseded' then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_ALREADY_SUPERSEDED');
  end if;
  if v_case.state <> 'awaiting_approval'
     or v_case.resolved_at is not null
     or v_case.rejected_at is not null
     or v_case.proposal_hash is null
     or v_case.proposal_hash <> p_proposal_hash
     or v_case.approved_by_user_id is null
     or v_case.approved_at is null
     or v_case.proposed_by_user_id is null
     or v_case.proposed_at is null then
    return jsonb_build_object('ok', false, 'code', 'APPROVED_PROPOSAL_REQUIRED');
  end if;
  if v_case.version <> p_expected_case_version then
    return jsonb_build_object(
      'ok', false,
      'code', 'CASE_VERSION_CONFLICT',
      'caseVersion', v_case.version
    );
  end if;
  if v_case.proposed_outcome is distinct from 'ticketed'
     or v_case.financial_disposition is distinct from 'capture_existing_hold'
     or coalesce((v_case.proposal->>'makerCheckerRequired')::boolean, false) is not true
     or v_case.approved_by_user_id = v_case.proposed_by_user_id then
    return jsonb_build_object('ok', false, 'code', 'STALE_TICKETED_CAPTURE_PROPOSAL_REQUIRED');
  end if;
  if jsonb_typeof(v_case.proposal->'evidenceObservationIds') <> 'array'
     or jsonb_array_length(v_case.proposal->'evidenceObservationIds') = 0 then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_EVIDENCE_REQUIRED');
  end if;

  select count(*) into v_evidence_input_count
    from jsonb_array_elements_text(v_case.proposal->'evidenceObservationIds') evidence(id);
  if exists (
    select 1
      from jsonb_array_elements_text(v_case.proposal->'evidenceObservationIds') evidence(id)
     where evidence.id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_EVIDENCE_INVALID');
  end if;
  select array_agg(evidence.id::uuid order by evidence.id)
    into v_evidence_ids
    from jsonb_array_elements_text(v_case.proposal->'evidenceObservationIds') evidence(id);
  if coalesce(cardinality(v_evidence_ids), 0) <> v_evidence_input_count
     or (select count(distinct evidence.id)
           from unnest(v_evidence_ids) as evidence(id))
        <> v_evidence_input_count then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_EVIDENCE_INVALID');
  end if;
  select count(*), count(*) filter (where observation.observed_at < v_cutoff)
    into v_evidence_found_count, v_stale_evidence_count
    from public.booking_reconciliation_observations observation
   where observation.reconciliation_case_id = p_case_id
     and observation.id = any(v_evidence_ids);
  if v_evidence_found_count <> v_evidence_input_count then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_CASE_MISMATCH');
  end if;
  -- Require every proposal-bound observation to have expired. This is stricter
  -- than merely noticing a stale latest observation and mirrors the resolver's
  -- all-bound-evidence freshness requirement.
  if v_stale_evidence_count <> v_evidence_input_count then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_EVIDENCE_NOT_EXPIRED');
  end if;

  -- Mark the source terminal before inserting its successor so the existing
  -- one-open-case-per-booking/type index remains true throughout this
  -- transaction. The successor pointer is attached immediately afterward;
  -- neither intermediate state is externally observable before commit.
  update public.booking_reconciliation_cases
     set state = 'superseded',
         superseded_at = clock_timestamp(),
         superseded_by_user_id = p_actor_user_id,
         superseded_by_role = v_actor_role,
         supersede_reason = p_reason,
         version = version + 1
   where id = v_case.id
   returning version into v_source_case_version;

  insert into public.booking_reconciliation_cases (
    subject_booking_id,
    operation_id,
    case_type,
    state,
    reason_code,
    reason_detail,
    opened_source,
    opened_by_user_id,
    opened_by_role,
    policy_version,
    assigned_team,
    severity,
    priority,
    due_at,
    supersedes_case_id
  ) values (
    v_case.subject_booking_id,
    v_case.operation_id,
    v_case.case_type,
    'awaiting_supplier',
    'stale_approved_proposal_superseded',
    'A prior approved ticketed-capture proposal expired before execution. New supplier evidence and a new maker/checker review are required.',
    'staff',
    p_actor_user_id,
    v_actor_role,
    v_case.policy_version,
    v_case.assigned_team,
    v_case.severity,
    v_case.priority,
    v_case.due_at,
    v_case.id
  ) returning id, version into v_successor_case_id, v_successor_case_version;

  insert into public.booking_reconciliation_proposal_supersessions (
    source_case_id,
    successor_case_id,
    superseded_proposal_hash,
    superseded_proposal,
    superseded_proposed_by_user_id,
    superseded_proposed_at,
    superseded_approved_by_user_id,
    superseded_approved_at,
    superseded_evidence_observation_ids,
    superseded_by_user_id,
    superseded_by_role,
    supersede_request_key,
    supersede_reason
  ) values (
    v_case.id,
    v_successor_case_id,
    v_case.proposal_hash,
    v_case.proposal,
    v_case.proposed_by_user_id,
    v_case.proposed_at,
    v_case.approved_by_user_id,
    v_case.approved_at,
    v_case.proposal->'evidenceObservationIds',
    p_actor_user_id,
    v_actor_role,
    p_request_key,
    p_reason
  ) returning id into v_supersession_id;

  update public.booking_reconciliation_cases
     set superseded_by_case_id = v_successor_case_id
   where id = v_case.id;

  -- This immutable, PII-minimized event deliberately records identifiers and
  -- hashes only. The exact prior proposal/reason remains in the immutable
  -- supersession snapshot, not copied into security audit metadata.
  insert into public.security_audit_events (
    actor_user_id, actor_role, action, target_type, target_id, outcome, metadata
  ) values (
    p_actor_user_id,
    v_actor_role,
    'booking.reconciliation.proposal_superseded',
    'flight_booking',
    p_booking_id::text,
    'succeeded',
    jsonb_build_object(
      'caseId', v_case.id,
      'successorCaseId', v_successor_case_id,
      'supersessionId', v_supersession_id,
      'supersededProposalHash', v_case.proposal_hash,
      'priorProposedByUserId', v_case.proposed_by_user_id,
      'priorProposedAt', v_case.proposed_at,
      'priorApprovedByUserId', v_case.approved_by_user_id,
      'priorApprovedAt', v_case.approved_at,
      'proposalEvidenceObservationIds', to_jsonb(v_evidence_ids),
      'priorReasonRecorded', coalesce(nullif(v_case.proposal->>'reason', ''), '') <> '',
      'supersedeReasonRecorded', true,
      'supersedeReasonHash', encode(sha256(convert_to(p_reason, 'UTF8')), 'hex'),
      'sourceCaseState', 'superseded',
      'successorCaseState', 'awaiting_supplier',
      'proposalBodyStored', false,
      'bookingMutation', false,
      'walletMutation', false,
      'reservationMutation', false,
      'ledgerMutation', false,
      'supplierWrite', false
    )
  );

  return jsonb_build_object(
    'ok', true,
    'replay', false,
    'caseId', v_case.id,
    'caseVersion', v_source_case_version,
    'proposalHash', v_case.proposal_hash,
    'supersessionId', v_supersession_id,
    'successorCaseId', v_successor_case_id,
    'successorCaseVersion', v_successor_case_version,
    'requiresFreshEvidence', true,
    'bookingMutation', false,
    'walletMutation', false,
    'reservationMutation', false,
    'ledgerMutation', false,
    'supplierWrite', false
  );
end;
$$;

revoke all on table public.booking_reconciliation_proposal_supersessions
  from public, anon, authenticated;
revoke all on function public.deny_booking_reconciliation_proposal_supersession_mutation_v1()
  from public, anon, authenticated, service_role;
revoke all on function public.supersede_stale_approved_booking_reconciliation_v1(
  uuid, uuid, integer, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.supersede_stale_approved_booking_reconciliation_v1(
  uuid, uuid, integer, text, text, text, text
) to service_role;

comment on table public.booking_reconciliation_proposal_supersessions is
  'Immutable, case-bound snapshots of approved stale reconciliation proposals superseded before financial execution.';
comment on function public.supersede_stale_approved_booking_reconciliation_v1(
  uuid, uuid, integer, text, text, text, text
) is
  'Super Admin-only, audited, no-money recovery for an approved ticketed-capture proposal whose every proposal-bound evidence observation has expired. It preserves the source case and opens an empty-evidence successor case.';
