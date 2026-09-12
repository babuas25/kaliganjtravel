-- Fail-closed, outcome-specific reconciliation execution contracts.
--
-- These RPCs deliberately validate an approved proposal but do not yet mutate
-- booking, operation, wallet, ledger, lifecycle-event, or notification state.
-- Later Phase 5 migrations replace each exact outcome body with its atomic
-- implementation. There is intentionally no generic status/resolution RPC.

create or replace function public.booking_reconciliation_resolution_contract_v1(
  p_booking_id uuid,
  p_case_id uuid,
  p_expected_case_version integer,
  p_proposal_hash text,
  p_actor_user_id text,
  p_execution_request_key text,
  p_resolution_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_booking public.flight_bookings;
  v_case_operation_id uuid;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_maker_checker boolean;
  v_terminal_correction boolean;
  v_historical_repair boolean;
begin
  if p_booking_id is null or p_case_id is null
     or p_expected_case_version is null or p_expected_case_version < 1
     or p_proposal_hash !~ '^[a-f0-9]{64}$'
     or nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_execution_request_key), '') is null
     or char_length(p_execution_request_key) > 220
     or p_resolution_kind not in (
       'ticketed', 'nonissuance', 'cancelled',
       'financial', 'terminal_correction', 'historical_repair'
     ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_RESOLUTION_CONTRACT');
  end if;

  select app_user.role into v_actor_role
    from public.app_users app_user
   where app_user.clerk_id = p_actor_user_id;
  if v_actor_role not in ('superadmin', 'admin') then
    return jsonb_build_object('ok', false, 'code', 'EXECUTION_FORBIDDEN');
  end if;

  -- Global reconciliation lock order is booking -> linked operation -> case
  -- -> reservation -> wallet owner -> currency account. The preliminary case
  -- read discovers the immutable operation identity without taking a lock;
  -- the locked case row must still contain that exact identity.
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select reconciliation_case.operation_id into v_case_operation_id
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.id = p_case_id
     and reconciliation_case.subject_booking_id = p_booking_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND');
  end if;
  if v_case_operation_id is not null then
    select operation.* into v_operation
      from public.booking_operations operation
     where operation.id = v_case_operation_id
       and operation.booking_id = p_booking_id
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'CASE_OPERATION_MISMATCH');
    end if;
  end if;
  select reconciliation_case.* into v_case
    from public.booking_reconciliation_cases reconciliation_case
   where reconciliation_case.id = p_case_id
     and reconciliation_case.subject_booking_id = p_booking_id
   for update;
  if v_case.operation_id is distinct from v_case_operation_id then
    return jsonb_build_object('ok', false, 'code', 'CASE_OPERATION_CHANGED');
  end if;
  if v_case.state in ('resolved', 'closed_no_change')
     or v_case.resolved_at is not null then
    if v_case.state = 'resolved'
       and v_case.proposal_hash = p_proposal_hash
       and v_case.resolution->>'executionRequestKey' = p_execution_request_key
       and v_case.resolution->>'resolutionKind' = p_resolution_kind then
      return coalesce(v_case.resolution->'result', '{}'::jsonb)
        || jsonb_build_object(
          'ok', true,
          'replay', true,
          'caseId', v_case.id,
          'caseVersion', v_case.version,
          'proposalHash', v_case.proposal_hash,
          'resolutionKind', p_resolution_kind
        );
    end if;
    return jsonb_build_object('ok', false, 'code', 'CASE_ALREADY_RESOLVED');
  end if;

  select reservation.* into v_reservation
    from public.wallet_reservations reservation
   where reservation.booking_id = p_booking_id
      or (reservation.booking_id is null
        and reservation.booking_attempt_id = v_booking.attempt_id)
   order by reservation.booking_id nulls last
   limit 1
   for update;
  if found then
    select wallet.* into v_wallet
      from public.wallets wallet
      join public.wallet_accounts account on account.wallet_id = wallet.id
     where account.id = v_reservation.wallet_account_id
     for update of wallet;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'WALLET_OWNER_NOT_FOUND');
    end if;
    select account.* into v_account
      from public.wallet_accounts account
     where account.id = v_reservation.wallet_account_id
       and account.wallet_id = v_wallet.id
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
    end if;
  end if;

  if v_case.rejected_at is not null then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_REJECTED');
  end if;
  if v_case.version <> p_expected_case_version then
    return jsonb_build_object(
      'ok', false, 'code', 'CASE_VERSION_CONFLICT',
      'caseVersion', v_case.version
    );
  end if;
  if v_case.proposal_hash is null
     or v_case.proposal_hash <> p_proposal_hash
     or v_case.proposal->>'version' <> '1' then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_CHANGED');
  end if;
  if v_case.proposal->>'expectedBookingStatus' is distinct from v_booking.status
     or v_case.proposal->>'expectedPaymentState'
        is distinct from v_booking.payment_state then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_STATE_CHANGED');
  end if;

  v_maker_checker := coalesce(
    (v_case.proposal->>'makerCheckerRequired')::boolean,
    false
  );
  if v_maker_checker then
    if v_case.state <> 'awaiting_approval'
       or v_case.approved_by_user_id is null
       or v_case.approved_at is null
       or v_case.approved_by_user_id = v_case.proposed_by_user_id then
      return jsonb_build_object('ok', false, 'code', 'INDEPENDENT_APPROVAL_REQUIRED');
    end if;
  elsif v_case.state <> 'assigned' then
    return jsonb_build_object('ok', false, 'code', 'PROPOSAL_NOT_EXECUTABLE');
  end if;

  if jsonb_typeof(v_case.proposal->'evidenceObservationIds') <> 'array'
     or jsonb_array_length(v_case.proposal->'evidenceObservationIds') = 0 then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_REQUIRED');
  end if;
  if exists (
    select 1
      from jsonb_array_elements_text(
        v_case.proposal->'evidenceObservationIds'
      ) evidence(observation_id)
      left join public.booking_reconciliation_observations observation
        on observation.id = evidence.observation_id::uuid
       and observation.reconciliation_case_id = v_case.id
     where observation.id is null
        or observation.observed_at < clock_timestamp() - interval '5 minutes'
  ) then
    return jsonb_build_object('ok', false, 'code', 'FRESH_CASE_EVIDENCE_REQUIRED');
  end if;

  v_terminal_correction := coalesce(
    v_case.proposal->'riskFlags' @> '["terminal_correction"]'::jsonb,
    false
  );
  v_historical_repair := coalesce(
    v_case.proposal->'riskFlags' @> '["historical_repair"]'::jsonb,
    false
  );
  if p_resolution_kind = 'ticketed'
     and (v_case.proposed_outcome <> 'ticketed'
       or v_terminal_correction or v_historical_repair) then
    return jsonb_build_object('ok', false, 'code', 'OUTCOME_CONTRACT_MISMATCH');
  elsif p_resolution_kind = 'nonissuance'
     and (v_case.proposed_outcome <> 'held_not_ticketed'
       or v_terminal_correction or v_historical_repair) then
    return jsonb_build_object('ok', false, 'code', 'OUTCOME_CONTRACT_MISMATCH');
  elsif p_resolution_kind = 'cancelled'
     and (v_case.proposed_outcome <> 'cancelled'
       or v_terminal_correction or v_historical_repair) then
    return jsonb_build_object('ok', false, 'code', 'OUTCOME_CONTRACT_MISMATCH');
  elsif p_resolution_kind = 'financial'
     and (v_case.proposed_outcome <> 'financial_only'
       or v_terminal_correction or v_historical_repair) then
    return jsonb_build_object('ok', false, 'code', 'OUTCOME_CONTRACT_MISMATCH');
  elsif p_resolution_kind = 'terminal_correction'
     and (not v_terminal_correction or v_historical_repair) then
    return jsonb_build_object('ok', false, 'code', 'OUTCOME_CONTRACT_MISMATCH');
  elsif p_resolution_kind = 'historical_repair'
     and not (
       v_historical_repair or v_case.proposed_outcome = 'historical_repair'
     ) then
    return jsonb_build_object('ok', false, 'code', 'OUTCOME_CONTRACT_MISMATCH');
  end if;
  if v_case.financial_disposition = 'manual_adjustment_required' then
    return jsonb_build_object('ok', false, 'code', 'MANUAL_ADJUSTMENT_REQUIRED');
  end if;

  return jsonb_build_object(
    'ok', true,
    'contractValidated', true,
    'executionEnabled', false,
    'resolutionKind', p_resolution_kind,
    'executionRequestKey', p_execution_request_key,
    'actorRole', v_actor_role,
    'bookingId', v_booking.id,
    'caseId', v_case.id,
    'caseVersion', v_case.version,
    'operationId', v_case.operation_id,
    'reservationId', v_reservation.id,
    'walletId', v_wallet.id,
    'walletAccountId', v_account.id,
    'proposalHash', v_case.proposal_hash,
    'proposedOutcome', v_case.proposed_outcome,
    'financialDisposition', v_case.financial_disposition,
    'makerCheckerRequired', v_maker_checker
  );
end;
$$;

create or replace function public.resolve_booking_reconciliation_ticketed_v1(
  p_booking_id uuid, p_case_id uuid, p_expected_case_version integer,
  p_proposal_hash text, p_actor_user_id text, p_execution_request_key text
)
returns jsonb language sql security definer set search_path = public
as $$
  select case when coalesce((contract.result->>'ok')::boolean, false)
    then contract.result || jsonb_build_object(
      'ok', false, 'code', 'RESOLUTION_EXECUTION_NOT_ENABLED'
    )
    else contract.result
  end
  from (select public.booking_reconciliation_resolution_contract_v1(
    p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
    p_actor_user_id, p_execution_request_key, 'ticketed'
  ) as result) contract;
$$;

create or replace function public.resolve_booking_reconciliation_nonissuance_v1(
  p_booking_id uuid, p_case_id uuid, p_expected_case_version integer,
  p_proposal_hash text, p_actor_user_id text, p_execution_request_key text
)
returns jsonb language sql security definer set search_path = public
as $$
  select case when coalesce((contract.result->>'ok')::boolean, false)
    then contract.result || jsonb_build_object(
      'ok', false, 'code', 'RESOLUTION_EXECUTION_NOT_ENABLED'
    )
    else contract.result
  end
  from (select public.booking_reconciliation_resolution_contract_v1(
    p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
    p_actor_user_id, p_execution_request_key, 'nonissuance'
  ) as result) contract;
$$;

create or replace function public.resolve_booking_reconciliation_cancelled_v1(
  p_booking_id uuid, p_case_id uuid, p_expected_case_version integer,
  p_proposal_hash text, p_actor_user_id text, p_execution_request_key text
)
returns jsonb language sql security definer set search_path = public
as $$
  select case when coalesce((contract.result->>'ok')::boolean, false)
    then contract.result || jsonb_build_object(
      'ok', false, 'code', 'RESOLUTION_EXECUTION_NOT_ENABLED'
    )
    else contract.result
  end
  from (select public.booking_reconciliation_resolution_contract_v1(
    p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
    p_actor_user_id, p_execution_request_key, 'cancelled'
  ) as result) contract;
$$;

create or replace function public.resolve_booking_reconciliation_financial_v1(
  p_booking_id uuid, p_case_id uuid, p_expected_case_version integer,
  p_proposal_hash text, p_actor_user_id text, p_execution_request_key text
)
returns jsonb language sql security definer set search_path = public
as $$
  select case when coalesce((contract.result->>'ok')::boolean, false)
    then contract.result || jsonb_build_object(
      'ok', false, 'code', 'RESOLUTION_EXECUTION_NOT_ENABLED'
    )
    else contract.result
  end
  from (select public.booking_reconciliation_resolution_contract_v1(
    p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
    p_actor_user_id, p_execution_request_key, 'financial'
  ) as result) contract;
$$;

create or replace function public.resolve_booking_reconciliation_terminal_correction_v1(
  p_booking_id uuid, p_case_id uuid, p_expected_case_version integer,
  p_proposal_hash text, p_actor_user_id text, p_execution_request_key text
)
returns jsonb language sql security definer set search_path = public
as $$
  select case when coalesce((contract.result->>'ok')::boolean, false)
    then contract.result || jsonb_build_object(
      'ok', false, 'code', 'RESOLUTION_EXECUTION_NOT_ENABLED'
    )
    else contract.result
  end
  from (select public.booking_reconciliation_resolution_contract_v1(
    p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
    p_actor_user_id, p_execution_request_key, 'terminal_correction'
  ) as result) contract;
$$;

create or replace function public.resolve_booking_reconciliation_historical_repair_v1(
  p_booking_id uuid, p_case_id uuid, p_expected_case_version integer,
  p_proposal_hash text, p_actor_user_id text, p_execution_request_key text
)
returns jsonb language sql security definer set search_path = public
as $$
  select case when coalesce((contract.result->>'ok')::boolean, false)
    then contract.result || jsonb_build_object(
      'ok', false, 'code', 'RESOLUTION_EXECUTION_NOT_ENABLED'
    )
    else contract.result
  end
  from (select public.booking_reconciliation_resolution_contract_v1(
    p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
    p_actor_user_id, p_execution_request_key, 'historical_repair'
  ) as result) contract;
$$;

revoke all on function public.booking_reconciliation_resolution_contract_v1(
  uuid, uuid, integer, text, text, text, text
) from public, anon, authenticated, service_role;

revoke all on function public.resolve_booking_reconciliation_ticketed_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
revoke all on function public.resolve_booking_reconciliation_nonissuance_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
revoke all on function public.resolve_booking_reconciliation_cancelled_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
revoke all on function public.resolve_booking_reconciliation_financial_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
revoke all on function public.resolve_booking_reconciliation_terminal_correction_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
revoke all on function public.resolve_booking_reconciliation_historical_repair_v1(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;

grant execute on function public.resolve_booking_reconciliation_ticketed_v1(
  uuid, uuid, integer, text, text, text
) to service_role;
grant execute on function public.resolve_booking_reconciliation_nonissuance_v1(
  uuid, uuid, integer, text, text, text
) to service_role;
grant execute on function public.resolve_booking_reconciliation_cancelled_v1(
  uuid, uuid, integer, text, text, text
) to service_role;
grant execute on function public.resolve_booking_reconciliation_financial_v1(
  uuid, uuid, integer, text, text, text
) to service_role;
grant execute on function public.resolve_booking_reconciliation_terminal_correction_v1(
  uuid, uuid, integer, text, text, text
) to service_role;
grant execute on function public.resolve_booking_reconciliation_historical_repair_v1(
  uuid, uuid, integer, text, text, text
) to service_role;

comment on function public.booking_reconciliation_resolution_contract_v1(
  uuid, uuid, integer, text, text, text, text
) is
  'Private fail-closed validator shared by exact reconciliation outcome RPCs. It is not executable by service clients and does not mutate lifecycle or financial truth.';
comment on function public.resolve_booking_reconciliation_ticketed_v1(
  uuid, uuid, integer, text, text, text
) is 'Exact ticketed reconciliation contract. Execution is fail-closed until its atomic Phase 5 implementation replaces this body.';
comment on function public.resolve_booking_reconciliation_nonissuance_v1(
  uuid, uuid, integer, text, text, text
) is 'Exact held/non-issuance reconciliation contract. Execution is fail-closed until its atomic Phase 5 implementation replaces this body.';
comment on function public.resolve_booking_reconciliation_cancelled_v1(
  uuid, uuid, integer, text, text, text
) is 'Exact cancellation reconciliation contract. Execution is fail-closed until its atomic Phase 5 implementation replaces this body.';
comment on function public.resolve_booking_reconciliation_financial_v1(
  uuid, uuid, integer, text, text, text
) is 'Exact financial-only reconciliation contract. Execution is fail-closed until its atomic Phase 5 implementation replaces this body.';
comment on function public.resolve_booking_reconciliation_terminal_correction_v1(
  uuid, uuid, integer, text, text, text
) is 'Exact terminal-correction reconciliation contract. Execution is fail-closed until its atomic Phase 5 implementation replaces this body.';
comment on function public.resolve_booking_reconciliation_historical_repair_v1(
  uuid, uuid, integer, text, text, text
) is 'Exact historical/legacy repair reconciliation contract. Execution is fail-closed until its atomic Phase 5 implementation replaces this body.';
