-- Durable proposal / approval / rejection controls. These functions do not
-- change booking status, operations, reservations, wallet balances, ledger,
-- lifecycle events, or notifications. Outcome execution is added separately.

alter table public.booking_reconciliation_cases
  add constraint booking_reconciliation_cases_proposal_shape_v1_check
  check (
    (proposal_hash is null
      and proposed_by_user_id is null
      and proposed_at is null)
    or (proposal_hash is not null
      and proposed_by_user_id is not null
      and proposed_at is not null
      and proposal->>'version' = '1'
      and nullif(proposal->>'requestKey', '') is not null
      and nullif(proposal->>'domain', '') is not null
      and jsonb_typeof(proposal->'riskFlags') = 'array'
      and jsonb_typeof(proposal->'confirmationCodes') = 'array'
      and jsonb_typeof(proposal->'evidenceObservationIds') = 'array')
  ) not valid,
  add constraint booking_reconciliation_cases_approval_shape_v1_check
  check (
    (approved_by_user_id is null and approved_at is null)
    or (approved_by_user_id is not null
      and approved_at is not null
      and proposal_hash is not null
      and coalesce((proposal->>'makerCheckerRequired')::boolean, false)
      and approved_by_user_id <> proposed_by_user_id)
  ) not valid,
  add constraint booking_reconciliation_cases_rejection_shape_v1_check
  check (
    (rejected_by_user_id is null and rejected_at is null)
    or (rejected_by_user_id is not null
      and rejected_at is not null
      and nullif(btrim(rejection_reason), '') is not null
      and proposal_hash is not null)
  ) not valid;

create or replace function public.propose_booking_reconciliation_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_expected_case_version integer,
  p_request_key text,
  p_actor_user_id text,
  p_domain text,
  p_proposed_outcome text,
  p_financial_disposition text,
  p_financial_amount bigint,
  p_financial_currency text,
  p_external_settlement_reference text,
  p_evidence_observation_ids uuid[],
  p_confirmation_codes text[],
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
  v_case public.booking_reconciliation_cases;
  v_evidence_ids uuid[];
  v_confirmation_codes text[];
  v_risk_flags text[] := array[]::text[];
  v_required_codes text[] := array[]::text[];
  v_target_status text;
  v_has_identity_exception boolean;
  v_has_incomplete_exception boolean;
  v_maker_checker boolean;
  v_proposal jsonb;
  v_proposal_hash text;
begin
  if p_booking_id is null or p_case_id is null
     or p_expected_case_version is null or p_expected_case_version < 1
     or nullif(btrim(p_request_key), '') is null
     or char_length(p_request_key) > 255
     or nullif(btrim(p_actor_user_id), '') is null
     or p_domain not in (
       'supplier_truth', 'financial', 'combined_supplier_financial'
     )
     or p_proposed_outcome not in (
       'ticketed', 'cancelled', 'held_not_ticketed',
       'financial_only', 'historical_repair'
     )
     or p_financial_disposition not in (
       'none', 'capture_existing_hold', 'release_existing_hold',
       'full_refund', 'partial_refund', 'no_refund_due',
       'externally_settled', 'manual_adjustment_required'
     )
     or nullif(btrim(p_reason), '') is null
     or char_length(p_reason) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_PROPOSAL');
  end if;

  select app_user.role into v_actor_role
    from public.app_users app_user
   where app_user.clerk_id = p_actor_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'ACTOR_NOT_FOUND');
  end if;
  if (p_domain = 'supplier_truth'
        and v_actor_role not in ('superadmin', 'admin', 'staff_support'))
     or (p_domain = 'financial'
        and v_actor_role not in ('superadmin', 'admin', 'staff_account'))
     or (p_domain = 'combined_supplier_financial'
        and v_actor_role not in ('superadmin', 'admin')) then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_FORBIDDEN');
  end if;

  if (p_domain = 'supplier_truth' and p_financial_disposition <> 'none')
     or (p_domain = 'financial'
       and (p_proposed_outcome <> 'financial_only'
         or p_financial_disposition = 'none'))
     or (p_domain = 'combined_supplier_financial'
       and (p_proposed_outcome = 'financial_only'
         or p_financial_disposition = 'none')) then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_DOMAIN_MISMATCH');
  end if;
  if p_financial_disposition = 'none' and (
       p_financial_amount is not null
       or p_financial_currency is not null
       or p_external_settlement_reference is not null
     ) then
    return jsonb_build_object('ok', false, 'code', 'UNEXPECTED_FINANCIAL_DETAIL');
  end if;
  if p_financial_disposition = 'partial_refund' and (
       p_financial_amount is null or p_financial_amount <= 0
       or upper(coalesce(p_financial_currency, '')) !~ '^[A-Z]{3}$'
     ) then
    return jsonb_build_object('ok', false, 'code', 'PARTIAL_REFUND_DETAIL_REQUIRED');
  end if;
  if p_financial_disposition in (
       'capture_existing_hold', 'release_existing_hold',
       'full_refund', 'no_refund_due', 'externally_settled'
     ) and (p_financial_amount is not null or p_financial_currency is not null) then
    return jsonb_build_object('ok', false, 'code', 'UNEXPECTED_FINANCIAL_AMOUNT');
  end if;
  if p_financial_disposition <> 'externally_settled'
     and p_external_settlement_reference is not null then
    return jsonb_build_object('ok', false, 'code', 'UNEXPECTED_SETTLEMENT_REFERENCE');
  end if;
  if p_financial_disposition = 'externally_settled'
     and nullif(btrim(p_external_settlement_reference), '') is null then
    return jsonb_build_object('ok', false, 'code', 'SETTLEMENT_REFERENCE_REQUIRED');
  end if;

  select array_agg(distinct observation_id order by observation_id)
    into v_evidence_ids
    from unnest(coalesce(p_evidence_observation_ids, array[]::uuid[]))
      as evidence_input(observation_id);
  if coalesce(cardinality(v_evidence_ids), 0) = 0 then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_REQUIRED');
  end if;
  select array_agg(distinct lower(btrim(code)) order by lower(btrim(code)))
    into v_confirmation_codes
    from unnest(coalesce(p_confirmation_codes, array[]::text[]))
      as confirmation_input(code)
   where nullif(btrim(code), '') is not null;
  v_confirmation_codes := coalesce(v_confirmation_codes, array[]::text[]);
  if exists (
    select 1 from unnest(v_confirmation_codes) as confirmation(code)
     where confirmation.code not in (
       'confirm_supplier_outcome',
       'confirm_held_nonissuance_basis',
       'confirm_terminal_correction',
       'confirm_supplier_identity_exception',
       'confirm_incomplete_evidence_exception',
       'confirm_legacy_review_path',
       'confirm_financial_disposition',
       'confirm_fee_or_no_refund',
       'confirm_external_settlement',
       'confirm_historical_repair',
       'confirm_manual_resolution_basis'
     )
  ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CONFIRMATION_CODE');
  end if;

  -- Global write lock order begins with booking, followed by case. Proposal
  -- writes no operation or money rows.
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select reconciliation_case.* into v_case
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.id = p_case_id
     and reconciliation_case.subject_booking_id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND');
  end if;
  if v_case.state not in (
       'open', 'assigned', 'awaiting_supplier',
       'awaiting_finance', 'awaiting_approval'
     ) then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_OPEN');
  end if;
  if v_case.approved_at is not null then
    return jsonb_build_object('ok', false, 'code', 'APPROVED_PROPOSAL_LOCKED');
  end if;

  if (select count(*) from public.booking_reconciliation_observations observation
       where observation.reconciliation_case_id = p_case_id
         and observation.id = any(v_evidence_ids))
     <> cardinality(v_evidence_ids) then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_CASE_MISMATCH');
  end if;
  if not exists (
    select 1 from public.booking_reconciliation_observations observation
     where observation.reconciliation_case_id = p_case_id
       and observation.id = any(v_evidence_ids)
       and observation.observed_at >= clock_timestamp() - interval '5 minutes'
  ) then
    return jsonb_build_object('ok', false, 'code', 'FRESH_EVIDENCE_REQUIRED');
  end if;

  select
    coalesce(bool_or(
      coalesce((observation.normalized_facts
        #>> '{validation,identityMatches}')::boolean, false) is not true
    ) filter (where observation.normalized_facts->>'action'
      = 'supplier_evidence_read'), false),
    coalesce(bool_or(
      coalesce((observation.normalized_facts
        #>> '{validation,valid}')::boolean, false) is not true
      or coalesce((observation.normalized_facts
        #>> '{validation,complete}')::boolean, false) is not true
      or coalesce((observation.normalized_facts
        #>> '{validation,fresh}')::boolean, false) is not true
    ) filter (where observation.normalized_facts->>'action'
      = 'supplier_evidence_read'), false)
    into v_has_identity_exception, v_has_incomplete_exception
    from public.booking_reconciliation_observations observation
   where observation.reconciliation_case_id = p_case_id
     and observation.id = any(v_evidence_ids);

  v_target_status := case p_proposed_outcome
    when 'ticketed' then 'confirmed'
    when 'cancelled' then 'cancelled'
    when 'held_not_ticketed' then 'on-hold'
    else null
  end;
  if v_target_status is not null
     and v_booking.status in ('confirmed', 'cancelled')
     and v_target_status <> v_booking.status then
    v_risk_flags := array_append(v_risk_flags, 'terminal_correction');
    v_required_codes := array_append(
      v_required_codes, 'confirm_terminal_correction'
    );
  end if;
  if p_financial_disposition <> 'none' then
    v_risk_flags := array_append(v_risk_flags, 'money_movement');
    v_required_codes := array_append(
      v_required_codes, 'confirm_financial_disposition'
    );
  end if;
  if p_financial_disposition in ('partial_refund', 'no_refund_due') then
    v_risk_flags := array_append(v_risk_flags, 'fee_or_no_refund');
    v_required_codes := array_append(
      v_required_codes, 'confirm_fee_or_no_refund'
    );
  end if;
  if p_financial_disposition = 'externally_settled' then
    v_risk_flags := array_append(v_risk_flags, 'external_settlement');
    v_required_codes := array_append(
      v_required_codes, 'confirm_external_settlement'
    );
  end if;
  if v_case.case_type in ('legacy_review', 'historical_inconsistency')
     or p_proposed_outcome = 'historical_repair' then
    v_risk_flags := array_append(v_risk_flags, 'historical_repair');
    v_required_codes := array_append(
      v_required_codes, 'confirm_historical_repair'
    );
  end if;
  if p_domain in ('supplier_truth', 'combined_supplier_financial') then
    v_required_codes := array_append(
      v_required_codes, 'confirm_supplier_outcome'
    );
  end if;
  if p_proposed_outcome = 'held_not_ticketed' then
    v_required_codes := array_append(
      v_required_codes, 'confirm_held_nonissuance_basis'
    );
    v_required_codes := array_append(
      v_required_codes, 'confirm_manual_resolution_basis'
    );
  end if;
  if v_case.case_type = 'legacy_review' then
    v_required_codes := array_append(
      v_required_codes, 'confirm_legacy_review_path'
    );
  end if;
  if v_has_identity_exception then
    v_required_codes := array_append(
      v_required_codes, 'confirm_supplier_identity_exception'
    );
  end if;
  if v_has_incomplete_exception then
    v_required_codes := array_append(
      v_required_codes, 'confirm_incomplete_evidence_exception'
    );
  end if;
  select array_agg(distinct risk order by risk) into v_risk_flags
    from unnest(v_risk_flags) as risks(risk);
  select array_agg(distinct code order by code) into v_required_codes
    from unnest(v_required_codes) as required(code);
  v_risk_flags := coalesce(v_risk_flags, array[]::text[]);
  v_required_codes := coalesce(v_required_codes, array[]::text[]);
  if not (v_confirmation_codes @> v_required_codes) then
    return jsonb_build_object(
      'ok', false,
      'code', 'REQUIRED_CONFIRMATION_MISSING',
      'requiredConfirmationCodes', to_jsonb(v_required_codes)
    );
  end if;
  v_maker_checker := cardinality(v_risk_flags) > 0;

  v_proposal := jsonb_build_object(
    'version', 1,
    'requestKey', p_request_key,
    'domain', p_domain,
    'proposedOutcome', p_proposed_outcome,
    'riskFlags', to_jsonb(v_risk_flags),
    'makerCheckerRequired', v_maker_checker,
    'confirmationCodes', to_jsonb(v_confirmation_codes),
    'evidenceObservationIds', to_jsonb(v_evidence_ids),
    'expectedBookingStatus', v_booking.status,
    'expectedPaymentState', v_booking.payment_state,
    'financialDisposition', p_financial_disposition,
    'financialAmount', p_financial_amount,
    'financialCurrency', case when p_financial_currency is null
      then null else upper(p_financial_currency) end,
    'externalSettlementReference', p_external_settlement_reference,
    'reason', p_reason,
    'statusMutationAuthorized', false,
    'walletMutationAuthorized', false
  );
  v_proposal_hash := encode(
    sha256(convert_to(v_proposal::text, 'UTF8')),
    'hex'
  );

  if v_case.proposal->>'requestKey' = p_request_key then
    if v_case.proposal_hash = v_proposal_hash
       and v_case.proposed_by_user_id = p_actor_user_id then
      return jsonb_build_object(
        'ok', true, 'replay', true,
        'caseId', p_case_id,
        'caseVersion', v_case.version,
        'proposalHash', v_case.proposal_hash,
        'makerCheckerRequired', v_maker_checker,
        'statusMutation', false,
        'walletMutation', false
      );
    end if;
    raise exception 'proposal request identity mismatch' using errcode = '22023';
  end if;
  if v_case.version <> p_expected_case_version then
    return jsonb_build_object(
      'ok', false, 'code', 'CASE_VERSION_CONFLICT',
      'caseVersion', v_case.version
    );
  end if;

  update public.booking_reconciliation_cases
     set state = case when v_maker_checker
           then 'awaiting_approval' else 'assigned' end,
         proposed_outcome = p_proposed_outcome,
         proposal = v_proposal,
         proposal_hash = v_proposal_hash,
         proposed_by_user_id = p_actor_user_id,
         proposed_at = clock_timestamp(),
         approved_by_user_id = null,
         approved_at = null,
         rejected_by_user_id = null,
         rejected_at = null,
         rejection_reason = null,
         financial_disposition = p_financial_disposition,
         financial_amount = p_financial_amount,
         financial_currency = case when p_financial_currency is null
           then null else upper(p_financial_currency) end,
         external_settlement_reference = p_external_settlement_reference,
         version = version + 1
   where id = p_case_id
   returning version into p_expected_case_version;

  return jsonb_build_object(
    'ok', true, 'replay', false,
    'caseId', p_case_id,
    'caseVersion', p_expected_case_version,
    'proposalHash', v_proposal_hash,
    'riskFlags', to_jsonb(v_risk_flags),
    'makerCheckerRequired', v_maker_checker,
    'statusMutation', false,
    'walletMutation', false
  );
end;
$$;

create or replace function public.approve_booking_reconciliation_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_expected_case_version integer,
  p_proposal_hash text,
  p_actor_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_booking public.flight_bookings;
  v_case public.booking_reconciliation_cases;
  v_new_version integer;
begin
  select app_user.role into v_actor_role
    from public.app_users app_user
   where app_user.clerk_id = p_actor_user_id;
  if v_actor_role not in ('superadmin', 'admin') then
    return jsonb_build_object('ok', false, 'code', 'APPROVAL_FORBIDDEN');
  end if;
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select reconciliation_case.* into v_case
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.id = p_case_id
     and reconciliation_case.subject_booking_id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND');
  end if;
  if v_case.approved_at is not null then
    if v_case.approved_by_user_id = p_actor_user_id
       and v_case.proposal_hash = p_proposal_hash then
      return jsonb_build_object(
        'ok', true, 'replay', true,
        'caseId', p_case_id,
        'caseVersion', v_case.version,
        'proposalHash', v_case.proposal_hash
      );
    end if;
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_ALREADY_APPROVED');
  end if;
  if v_case.state <> 'awaiting_approval'
     or v_case.proposal_hash is null
     or v_case.proposal_hash <> p_proposal_hash
     or coalesce((v_case.proposal->>'makerCheckerRequired')::boolean, false)
        is not true then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_APPROVABLE');
  end if;
  if v_case.version <> p_expected_case_version then
    return jsonb_build_object(
      'ok', false, 'code', 'CASE_VERSION_CONFLICT',
      'caseVersion', v_case.version
    );
  end if;
  if v_case.proposed_by_user_id = p_actor_user_id then
    return jsonb_build_object('ok', false, 'code', 'SELF_APPROVAL_FORBIDDEN');
  end if;

  update public.booking_reconciliation_cases
     set approved_by_user_id = p_actor_user_id,
         approved_at = clock_timestamp(),
         version = version + 1
   where id = p_case_id
   returning version into v_new_version;
  return jsonb_build_object(
    'ok', true, 'replay', false,
    'caseId', p_case_id,
    'caseVersion', v_new_version,
    'proposalHash', p_proposal_hash
  );
end;
$$;

create or replace function public.reject_booking_reconciliation_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_expected_case_version integer,
  p_proposal_hash text,
  p_actor_user_id text,
  p_rejection_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_booking public.flight_bookings;
  v_case public.booking_reconciliation_cases;
  v_new_version integer;
begin
  if nullif(btrim(p_rejection_reason), '') is null
     or char_length(p_rejection_reason) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'REJECTION_REASON_REQUIRED');
  end if;
  select app_user.role into v_actor_role
    from public.app_users app_user
   where app_user.clerk_id = p_actor_user_id;
  if v_actor_role not in ('superadmin', 'admin') then
    return jsonb_build_object('ok', false, 'code', 'REJECTION_FORBIDDEN');
  end if;
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select reconciliation_case.* into v_case
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.id = p_case_id
     and reconciliation_case.subject_booking_id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND');
  end if;
  if v_case.rejected_at is not null then
    if v_case.rejected_by_user_id = p_actor_user_id
       and v_case.proposal_hash = p_proposal_hash
       and v_case.rejection_reason = p_rejection_reason then
      return jsonb_build_object(
        'ok', true, 'replay', true,
        'caseId', p_case_id,
        'caseVersion', v_case.version,
        'proposalHash', v_case.proposal_hash
      );
    end if;
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_ALREADY_REJECTED');
  end if;
  if v_case.proposal_hash is null
     or v_case.proposal_hash <> p_proposal_hash
     or v_case.approved_at is not null then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_REJECTABLE');
  end if;
  if v_case.version <> p_expected_case_version then
    return jsonb_build_object(
      'ok', false, 'code', 'CASE_VERSION_CONFLICT',
      'caseVersion', v_case.version
    );
  end if;

  update public.booking_reconciliation_cases
     set state = 'assigned',
         rejected_by_user_id = p_actor_user_id,
         rejected_at = clock_timestamp(),
         rejection_reason = p_rejection_reason,
         approved_by_user_id = null,
         approved_at = null,
         version = version + 1
   where id = p_case_id
   returning version into v_new_version;
  return jsonb_build_object(
    'ok', true, 'replay', false,
    'caseId', p_case_id,
    'caseVersion', v_new_version,
    'proposalHash', p_proposal_hash
  );
end;
$$;

revoke all on function public.propose_booking_reconciliation_v1(
  uuid, uuid, integer, text, text, text, text, text,
  bigint, text, text, uuid[], text[], text
) from public, anon, authenticated;
revoke all on function public.approve_booking_reconciliation_v1(
  uuid, uuid, integer, text, text
) from public, anon, authenticated;
revoke all on function public.reject_booking_reconciliation_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.propose_booking_reconciliation_v1(
  uuid, uuid, integer, text, text, text, text, text,
  bigint, text, text, uuid[], text[], text
) to service_role;
grant execute on function public.approve_booking_reconciliation_v1(
  uuid, uuid, integer, text, text
) to service_role;
grant execute on function public.reject_booking_reconciliation_v1(
  uuid, uuid, integer, text, text, text
) to service_role;

comment on function public.propose_booking_reconciliation_v1(
  uuid, uuid, integer, text, text, text, text, text,
  bigint, text, text, uuid[], text[], text
) is
  'Creates a case-bound, evidence-linked, payload-fingerprinted reconciliation proposal. High-risk flags and required confirmations are derived server-side; no status or money changes.';
comment on function public.approve_booking_reconciliation_v1(
  uuid, uuid, integer, text, text
) is
  'Approves an unchanged high-risk proposal only for a different Admin/Super Admin maker-checker actor. It does not execute the proposal.';
comment on function public.reject_booking_reconciliation_v1(
  uuid, uuid, integer, text, text, text
) is
  'Rejects an unchanged proposal with a recorded reason. It does not execute or mutate booking/wallet truth.';
