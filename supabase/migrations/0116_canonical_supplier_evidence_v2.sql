-- Canonical Supplier Evidence V2.
--
-- V1 observations and functions remain unchanged for immutable historical and
-- supplier-import evidence. New live reconciliation reads use a distinct V2
-- observation/idempotency namespace and one supplier-neutral evidence shape.

create or replace function public.booking_reconciliation_evidence_v2_authoritative(
  p_booking_id uuid,
  p_case_id uuid,
  p_observation_id uuid,
  p_truth text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_observation public.booking_reconciliation_observations;
  v_facts jsonb;
  v_evidence_at timestamptz;
  v_expected_payable_minor bigint;
begin
  if p_truth not in ('ticketed', 'cancelled') then return false; end if;
  select * into v_booking from public.flight_bookings where id = p_booking_id;
  select * into v_observation
    from public.booking_reconciliation_observations
   where id = p_observation_id and reconciliation_case_id = p_case_id;
  if v_booking.id is null or v_observation.id is null then return false; end if;
  v_facts := v_observation.normalized_facts;
  begin
    v_evidence_at := (v_facts->>'evidenceObservedAt')::timestamptz;
    v_expected_payable_minor := round(
      ((v_booking.pricing_snapshot->>'supplierTotalPrice')::numeric) * 100
    )::bigint;
  exception when others then
    return false;
  end;

  return
    v_observation.observation_kind = 'staff_evidence'
    and v_observation.observation_source = 'supplier_read'
    and v_facts->>'version' = '2'
    and v_facts->>'evidenceContract' = 'canonical_supplier_evidence_v2'
    and v_facts->>'action' = 'supplier_evidence_read'
    and v_facts->>'bookingId' = p_booking_id::text
    and v_facts->>'caseId' = p_case_id::text
    and v_facts->>'requestedPurpose' = p_truth
    and v_facts #>> '{validation,contractVersion}' = '2'
    and v_facts #>> '{validation,authoritativeFor}' = p_truth
    and coalesce((v_facts #>> '{validation,valid}')::boolean, false)
    and coalesce((v_facts #>> '{validation,complete}')::boolean, false)
    and coalesce((v_facts #>> '{validation,fresh}')::boolean, false)
    and coalesce((v_facts #>> '{validation,identityMatches}')::boolean, false)
    and coalesce((v_facts->>'statusMutation')::boolean, true) is false
    and coalesce((v_facts->>'walletMutation')::boolean, true) is false
    and coalesce((v_facts->>'destructiveSupplierCall')::boolean, true) is false
    and v_evidence_at between clock_timestamp() - interval '5 minutes'
                          and clock_timestamp() + interval '1 minute'
    and coalesce(v_facts->'recordedSources', '[]'::jsonb)
          @> '["pnr", "ticket-report"]'::jsonb
    and v_facts #>> '{evidence,pnr,schemaVersion}' = '2'
    and v_facts #>> '{evidence,pnr,source}' = 'pnr'
    and v_facts #>> '{evidence,ticketReport,schemaVersion}' = '2'
    and v_facts #>> '{evidence,ticketReport,source}' = 'ticket-report'
    and v_facts #>> '{expectedIdentity,supplierAccount}'
          is not distinct from v_booking.supplier_account
    and v_facts #>> '{expectedIdentity,bookingIdentity,transactionId}'
          is not distinct from v_booking.supplier_refs->>'uniqueTransId'
    and v_facts #>> '{expectedIdentity,bookingIdentity,supplierPnr}'
          is not distinct from v_booking.pnr
    and v_facts #>> '{expectedIdentity,bookingIdentity,bookingReference}'
          is not distinct from v_booking.booking_ref_number
    and v_facts #>> '{expectedIdentity,bookingIdentity,operationalReferences,itemCodeRef}'
          is not distinct from v_booking.supplier_refs->>'itemCodeRef'
    and v_facts #>> '{expectedIdentity,bookingIdentity,operationalReferences,priceCodeRef}'
          is not distinct from v_booking.supplier_refs->>'priceCodeRef'
    and v_facts #>> '{expectedIdentity,bookingIdentity,operationalReferences,bookingCodeRef}'
          is not distinct from v_booking.booking_code_ref
    and v_facts #>> '{evidence,ticketReport,bookingIdentity,transactionId}'
          is not distinct from v_booking.supplier_refs->>'uniqueTransId'
    and v_facts #>> '{evidence,ticketReport,bookingIdentity,supplierPnr}'
          is not distinct from v_booking.pnr
    and v_facts #>> '{evidence,ticketReport,bookingIdentity,bookingReference}'
          is not distinct from v_booking.booking_ref_number
    and v_facts #>> '{evidence,ticketReport,bookingIdentity,operationalReferences,itemCodeRef}'
          is not distinct from v_booking.supplier_refs->>'itemCodeRef'
    and v_facts #>> '{evidence,ticketReport,bookingIdentity,operationalReferences,priceCodeRef}'
          is not distinct from v_booking.supplier_refs->>'priceCodeRef'
    and v_facts #>> '{evidence,ticketReport,bookingIdentity,operationalReferences,bookingCodeRef}'
          is not distinct from v_booking.booking_code_ref
    and v_facts #>> '{evidence,pnr,requestIdentity,transactionId}'
          is not distinct from v_booking.supplier_refs->>'uniqueTransId'
    and v_facts #>> '{evidence,pnr,requestIdentity,supplierPnr}'
          is not distinct from v_booking.pnr
    and v_facts #>> '{evidence,pnr,requestIdentity,bookingReference}'
          is not distinct from v_booking.booking_ref_number
    and upper(v_facts #>> '{expectedIdentity,financial,currency}')
          is not distinct from upper(v_booking.currency)
    and (v_facts #>> '{expectedIdentity,financial,supplierPayableMinor}')::bigint
          = v_expected_payable_minor
    and v_expected_payable_minor > 0
    and (v_facts #>> '{evidence,ticketReport,financial,supplierPayableMinor}')::bigint
          = v_expected_payable_minor
    and upper(v_facts #>> '{evidence,ticketReport,financial,currency}')
          is not distinct from upper(v_booking.currency)
    and v_facts #>> '{localContext,storedStatus}' = v_booking.status
    and v_facts #>> '{localContext,paymentState}' = v_booking.payment_state
    and (
      v_booking.status <> 'confirmed'
      or (
        jsonb_typeof(coalesce(v_booking.ticket_numbers, '[]'::jsonb)) = 'array'
        and jsonb_array_length(coalesce(v_booking.ticket_numbers, '[]'::jsonb)) > 0
        and (
          select array_agg(upper(btrim(value)) order by upper(btrim(value)))
            from jsonb_array_elements_text(v_booking.ticket_numbers)
        ) = (
          select array_agg(
                   upper(btrim(ticket.value->>'fullNumber'))
                   order by upper(btrim(ticket.value->>'fullNumber'))
                 )
            from jsonb_array_elements(coalesce(
              v_facts #> '{evidence,ticketReport,tickets}', '[]'::jsonb
            )) ticket(value)
           where jsonb_typeof(ticket.value) = 'object'
             and nullif(btrim(ticket.value->>'fullNumber'), '') is not null
        )
      )
    );
exception when others then
  return false;
end;
$$;

revoke all on function public.booking_reconciliation_evidence_v2_authoritative(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
grant execute on function public.booking_reconciliation_evidence_v2_authoritative(
  uuid, uuid, uuid, text
) to service_role;

create or replace function public.record_booking_reconciliation_evidence_read_v2(
  p_booking_id uuid,
  p_case_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_observation_key text,
  p_normalized_facts jsonb,
  p_normalized_facts_hash text,
  p_observed_at timestamptz,
  p_evidence_observed_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_case public.booking_reconciliation_cases;
  v_observation public.booking_reconciliation_observations;
  v_existing_hash text;
  v_created boolean := false;
  v_case_version integer;
begin
  if p_booking_id is null or p_case_id is null
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or p_actor_role not in ('staff_support', 'admin', 'superadmin', 'system')
     or p_observation_key !~ '^evidence-read:v2:[a-f0-9]{64}$'
     or p_normalized_facts_hash !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(coalesce(p_normalized_facts, '{}'::jsonb)) <> 'object'
     or p_normalized_facts->>'version' <> '2'
     or p_normalized_facts->>'evidenceContract' <> 'canonical_supplier_evidence_v2'
     or p_normalized_facts->>'action' <> 'supplier_evidence_read'
     or coalesce((p_normalized_facts->>'statusMutation')::boolean, true)
     or coalesce((p_normalized_facts->>'walletMutation')::boolean, true)
     or coalesce((p_normalized_facts->>'destructiveSupplierCall')::boolean, true)
     or p_normalized_facts->>'bookingId' is distinct from p_booking_id::text
     or p_normalized_facts->>'caseId' is distinct from p_case_id::text
     or p_normalized_facts #>> '{validation,contractVersion}' <> '2'
     or p_observed_at is null
     or p_observed_at > clock_timestamp() + interval '1 minute'
     or p_observed_at < clock_timestamp() - interval '5 minutes'
     or (p_evidence_observed_at is not null and (
       p_evidence_observed_at > p_observed_at + interval '1 minute'
       or p_evidence_observed_at < p_observed_at - interval '5 minutes'
     )) then
    raise exception 'invalid canonical V2 reconciliation evidence observation'
      using errcode = '22023';
  end if;

  select * into v_case from public.booking_reconciliation_cases
   where id = p_case_id and subject_booking_id = p_booking_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND'); end if;
  if v_case.state not in (
    'open', 'assigned', 'awaiting_supplier', 'awaiting_finance', 'awaiting_approval'
  ) then return jsonb_build_object('ok', false, 'code', 'CASE_NOT_OPEN'); end if;
  if not exists (select 1 from public.flight_bookings where id = p_booking_id) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  insert into public.booking_reconciliation_observations (
    reconciliation_case_id, observation_key, observation_kind,
    observation_source, actor_user_id, actor_role, normalized_facts,
    normalized_facts_hash, observed_at
  ) values (
    p_case_id, p_observation_key, 'staff_evidence', 'supplier_read',
    p_actor_user_id, p_actor_role, p_normalized_facts,
    p_normalized_facts_hash, p_observed_at
  ) on conflict (reconciliation_case_id, observation_key) do nothing
  returning * into v_observation;

  if v_observation.id is null then
    select normalized_facts_hash into v_existing_hash
      from public.booking_reconciliation_observations
     where reconciliation_case_id = p_case_id and observation_key = p_observation_key;
    if v_existing_hash is distinct from p_normalized_facts_hash then
      raise exception 'canonical V2 evidence request payload mismatch' using errcode = '22023';
    end if;
    select * into v_observation from public.booking_reconciliation_observations
     where reconciliation_case_id = p_case_id and observation_key = p_observation_key;
  else
    v_created := true;
    update public.booking_reconciliation_cases
       set evidence_latest_at = case
             when p_evidence_observed_at is null then evidence_latest_at
             when evidence_latest_at is null then p_evidence_observed_at
             else greatest(evidence_latest_at, p_evidence_observed_at) end,
           evidence_normalizer_version = case
             when p_evidence_observed_at is null then evidence_normalizer_version else 2 end,
           version = version + 1
     where id = p_case_id;
  end if;
  select version into v_case_version from public.booking_reconciliation_cases where id = p_case_id;
  return jsonb_build_object(
    'ok', true, 'replay', not v_created, 'caseId', p_case_id,
    'caseVersion', v_case_version, 'observationId', v_observation.id,
    'evidenceLatestAt', p_evidence_observed_at,
    'statusMutation', false, 'walletMutation', false,
    'destructiveSupplierCall', false
  );
end;
$$;

revoke all on function public.record_booking_reconciliation_evidence_read_v2(
  uuid, uuid, text, text, text, jsonb, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_booking_reconciliation_evidence_read_v2(
  uuid, uuid, text, text, text, jsonb, text, timestamptz, timestamptz
) to service_role;

create or replace function public.close_booking_reconciliation_no_change_v2(
  p_booking_id uuid,
  p_case_id uuid,
  p_observation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_reservation public.wallet_reservations;
  v_operation_id uuid;
  v_truth text;
begin
  if p_booking_id is null or p_case_id is null or p_observation_id is null then
    raise exception 'invalid V2 no-change closure request' using errcode = '22023';
  end if;
  select operation_id into v_operation_id from public.booking_reconciliation_cases
   where id = p_case_id and subject_booking_id = p_booking_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND'); end if;
  select * into v_booking from public.flight_bookings
   where id = p_booking_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;
  if v_operation_id is not null then
    select * into v_operation from public.booking_operations
     where id = v_operation_id and booking_id = p_booking_id for update;
  end if;
  select * into v_case from public.booking_reconciliation_cases
   where id = p_case_id and subject_booking_id = p_booking_id for update;
  if v_case.state = 'closed_no_change'
     and v_case.resolution_outcome = 'supplier_truth_unchanged'
     and v_case.resolution->>'observationId' = p_observation_id::text then
    return jsonb_build_object(
      'ok', true, 'replay', true, 'caseId', p_case_id,
      'observationId', p_observation_id, 'closedNoChange', true,
      'statusMutation', false, 'walletMutation', false
    );
  end if;
  if v_case.state not in (
    'open', 'assigned', 'awaiting_supplier', 'awaiting_finance', 'awaiting_approval'
  ) then return jsonb_build_object('ok', false, 'code', 'CASE_NOT_OPEN'); end if;
  select * into v_reservation from public.wallet_reservations
   where booking_id = p_booking_id for update;
  if v_case.case_type not in ('ticketing_uncertainty', 'cancellation_uncertainty')
     or v_case.proposed_outcome is not null
     or v_case.financial_disposition <> 'none'
     or v_case.operation_id is null
     or v_operation.id is null
     or v_operation.state <> 'needs_reconciliation'
     or (v_booking.active_operation_id is not null
       and v_booking.active_operation_id <> v_operation.id)
     or exists (
       select 1 from public.booking_reconciliation_cases other_case
        where other_case.subject_booking_id = p_booking_id
          and other_case.id <> p_case_id
          and other_case.state in (
            'open', 'assigned', 'awaiting_supplier',
            'awaiting_finance', 'awaiting_approval'
          )
     ) then
    return jsonb_build_object('ok', false, 'code', 'NO_CHANGE_CLOSURE_NOT_ELIGIBLE');
  end if;
  v_truth := case v_booking.status
    when 'confirmed' then 'ticketed'
    when 'cancelled' then 'cancelled'
    else null end;
  if v_truth is null or not public.booking_reconciliation_evidence_v2_authoritative(
    p_booking_id, p_case_id, p_observation_id, v_truth
  ) or (v_truth = 'ticketed' and v_operation.kind <> 'ticketing')
     or (v_truth = 'cancelled' and v_operation.kind <> 'cancellation') then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_NOT_AUTHORITATIVE');
  end if;
  if (
    v_truth = 'ticketed' and not (
      v_booking.payment_state = 'captured'
      and v_booking.captured_amount > 0
      and v_booking.refunded_amount = 0
      and v_booking.payment_amount = v_booking.captured_amount
      and v_reservation.id is not null
      and v_reservation.state = 'captured'
      and v_reservation.amount = v_booking.captured_amount
      and v_reservation.currency = v_booking.currency
    )
  ) or (
    v_truth = 'cancelled' and not (
      (v_booking.payment_state = 'unpaid' and v_booking.captured_amount = 0
        and v_booking.refunded_amount = 0 and v_reservation.id is null)
      or (v_booking.payment_state = 'released' and v_booking.captured_amount = 0
        and v_booking.refunded_amount = 0 and v_reservation.id is not null
        and v_reservation.state = 'released')
      or (v_booking.payment_state = 'refunded' and v_booking.captured_amount > 0
        and v_booking.refunded_amount = v_booking.captured_amount
        and v_reservation.id is not null and v_reservation.state = 'captured')
    )
  ) then return jsonb_build_object('ok', false, 'code', 'FINANCIAL_CONFLICT'); end if;

  update public.booking_operations
     set state = 'succeeded', completed_at = coalesce(completed_at, clock_timestamp()),
         error_code = null, error_message = null,
         supplier_evidence = coalesce(supplier_evidence, '{}'::jsonb) ||
           jsonb_build_object('canonicalV2NoChangeClosure', jsonb_build_object(
             'observationId', p_observation_id, 'authoritativeFor', v_truth,
             'closedAt', clock_timestamp()))
   where id = v_operation.id;
  update public.flight_bookings
     set active_operation_id = null, operation_kind = null, operation_reason = null,
         operation_request_id = null, operation_actor_user_id = null,
         operation_started_at = null, operation_prior_status = null
   where id = p_booking_id;
  update public.booking_reconciliation_cases
     set state = 'closed_no_change', resolution_outcome = 'supplier_truth_unchanged',
         resolution = jsonb_build_object(
           'version', 2, 'evidenceContract', 'canonical_supplier_evidence_v2',
           'observationId', p_observation_id, 'authoritativeFor', v_truth,
           'statusMutation', false, 'walletMutation', false),
         resolution_reason =
           'Fresh canonical V2 supplier evidence confirms existing terminal and financial truth',
         resolved_by_user_id = 'system:evidence-v2-no-change',
         resolved_at = clock_timestamp(), closed_at = clock_timestamp(),
         version = version + 1
   where id = p_case_id;
  insert into public.security_audit_events (
    actor_user_id, actor_role, action, target_type, target_id, outcome, metadata
  ) values (
    'system:evidence-v2-no-change', 'system',
    'booking.reconciliation.closed_no_change_v2', 'flight_booking',
    p_booking_id::text, 'succeeded', jsonb_build_object(
      'caseId', p_case_id, 'operationId', v_operation.id,
      'observationId', p_observation_id, 'authoritativeFor', v_truth,
      'statusMutation', false, 'walletMutation', false)
  );
  return jsonb_build_object(
    'ok', true, 'replay', false, 'caseId', p_case_id,
    'operationId', v_operation.id, 'observationId', p_observation_id,
    'closedNoChange', true, 'statusMutation', false, 'walletMutation', false
  );
end;
$$;

revoke all on function public.close_booking_reconciliation_no_change_v2(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.close_booking_reconciliation_no_change_v2(uuid, uuid, uuid)
  to service_role;

create or replace function public.close_booking_ticketing_race_no_change_v2(
  p_booking_id uuid,
  p_case_id uuid,
  p_observation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_reservation public.wallet_reservations;
  v_operation_id uuid;
begin
  if p_booking_id is null or p_case_id is null or p_observation_id is null then
    raise exception 'invalid V2 ticketing-race closure request' using errcode = '22023';
  end if;
  select operation_id into v_operation_id from public.booking_reconciliation_cases
   where id = p_case_id and subject_booking_id = p_booking_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'CASE_NOT_FOUND'); end if;
  select * into v_booking from public.flight_bookings where id = p_booking_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;
  if v_operation_id is not null then
    select * into v_operation from public.booking_operations
     where id = v_operation_id and booking_id = p_booking_id for update;
  end if;
  select * into v_case from public.booking_reconciliation_cases
   where id = p_case_id and subject_booking_id = p_booking_id for update;
  if v_case.state = 'closed_no_change'
     and v_case.resolution_outcome = 'supplier_truth_unchanged'
     and v_case.resolution->>'observationId' = p_observation_id::text then
    return jsonb_build_object(
      'ok', true, 'replay', true, 'caseId', p_case_id,
      'observationId', p_observation_id, 'closedNoChange', true,
      'statusMutation', false, 'walletMutation', false);
  end if;
  if v_case.state not in (
    'open', 'assigned', 'awaiting_supplier', 'awaiting_finance', 'awaiting_approval'
  ) then return jsonb_build_object('ok', false, 'code', 'CASE_NOT_OPEN'); end if;
  select * into v_reservation from public.wallet_reservations
   where booking_id = p_booking_id for update;
  if v_case.case_type <> 'ticketing_uncertainty'
     or v_case.reason_code <> 'pnr_sync_conflicts_with_local_truth'
     or v_case.opened_source <> 'supplier_sync'
     or v_case.proposed_outcome is not null
     or v_case.financial_disposition <> 'none'
     or v_case.operation_id is null or v_operation.id is null
     or v_operation.kind <> 'ticketing' or v_operation.state <> 'succeeded'
     or v_operation.completed_at is null
     or v_case.opened_at < v_operation.claimed_at - interval '1 minute'
     or v_case.opened_at > v_operation.completed_at + interval '1 minute'
     or v_booking.active_operation_id is not null
     or v_booking.status <> 'confirmed'
     or exists (
       select 1 from public.booking_reconciliation_cases other_case
        where other_case.subject_booking_id = p_booking_id and other_case.id <> p_case_id
          and other_case.state in (
            'open', 'assigned', 'awaiting_supplier', 'awaiting_finance', 'awaiting_approval'
          )
     ) then
    return jsonb_build_object('ok', false, 'code', 'TICKETING_RACE_CLOSURE_NOT_ELIGIBLE');
  end if;
  if not public.booking_reconciliation_evidence_v2_authoritative(
    p_booking_id, p_case_id, p_observation_id, 'ticketed'
  ) then return jsonb_build_object('ok', false, 'code', 'EVIDENCE_NOT_AUTHORITATIVE'); end if;
  if not (
    v_booking.payment_state = 'captured' and v_booking.captured_amount > 0
    and v_booking.refunded_amount = 0
    and v_booking.payment_amount = v_booking.captured_amount
    and v_reservation.id is not null and v_reservation.state = 'captured'
    and v_reservation.amount = v_booking.captured_amount
    and v_reservation.currency = v_booking.currency
  ) then return jsonb_build_object('ok', false, 'code', 'FINANCIAL_CONFLICT'); end if;
  update public.booking_reconciliation_cases
     set state = 'closed_no_change', resolution_outcome = 'supplier_truth_unchanged',
         resolution = jsonb_build_object(
           'version', 2, 'evidenceContract', 'canonical_supplier_evidence_v2',
           'observationId', p_observation_id, 'authoritativeFor', 'ticketed',
           'closureKind', 'ticketing_operation_window_race',
           'statusMutation', false, 'walletMutation', false),
         resolution_reason =
           'Fresh canonical V2 supplier evidence confirms the issued ticket, complete identity, and already-captured financial state',
         resolved_by_user_id = 'system:post-ticketing-evidence-v2',
         resolved_at = clock_timestamp(), closed_at = clock_timestamp(),
         version = version + 1
   where id = p_case_id;
  insert into public.security_audit_events (
    actor_user_id, actor_role, action, target_type, target_id, outcome, metadata
  ) values (
    'system:post-ticketing-evidence-v2', 'system',
    'booking.reconciliation.ticketing_race_closed_no_change_v2',
    'flight_booking', p_booking_id::text, 'succeeded', jsonb_build_object(
      'caseId', p_case_id, 'operationId', v_operation.id,
      'observationId', p_observation_id, 'authoritativeFor', 'ticketed',
      'statusMutation', false, 'walletMutation', false)
  );
  return jsonb_build_object(
    'ok', true, 'replay', false, 'caseId', p_case_id,
    'operationId', v_operation.id, 'observationId', p_observation_id,
    'closedNoChange', true, 'statusMutation', false, 'walletMutation', false
  );
end;
$$;

revoke all on function public.close_booking_ticketing_race_no_change_v2(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.close_booking_ticketing_race_no_change_v2(uuid, uuid, uuid)
  to service_role;

create or replace function public.resolve_booking_reconciliation_ticketed_v2(
  p_booking_id uuid,
  p_case_id uuid,
  p_expected_case_version integer,
  p_proposal_hash text,
  p_actor_user_id text,
  p_execution_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract jsonb;
  v_booking public.flight_bookings;
  v_case public.booking_reconciliation_cases;
  v_operation public.booking_operations;
  v_reservation public.wallet_reservations;
  v_account public.wallet_accounts;
  v_evidence public.booking_reconciliation_observations;
  v_ticket_numbers jsonb;
  v_supplier_pnr text;
  v_airlines_pnr jsonb;
  v_supplier_status text;
  v_issued_at timestamptz;
  v_supplier_unique_trans_id text;
  v_supplier_internal_booking_id text;
  v_supplier_identifiers jsonb;
  v_available_before bigint;
  v_hold_before bigint;
  v_ledger_entry_id uuid;
  v_event_id bigint;
  v_occurrence_number integer;
  v_from_lifecycle text;
  v_resolution_result jsonb;
begin
  v_contract := public.booking_reconciliation_resolution_contract_v1(
    p_booking_id, p_case_id, p_expected_case_version, p_proposal_hash,
    p_actor_user_id, p_execution_request_key, 'ticketed'
  );
  if coalesce((v_contract->>'ok')::boolean, false) is not true
     or coalesce((v_contract->>'replay')::boolean, false) then
    return v_contract;
  end if;
  select * into strict v_booking from public.flight_bookings where id = p_booking_id;
  select * into strict v_case from public.booking_reconciliation_cases where id = p_case_id;
  if v_case.financial_disposition <> 'capture_existing_hold' then
    return jsonb_build_object('ok', false, 'code', 'CAPTURE_DISPOSITION_REQUIRED');
  end if;
  if v_booking.status not in ('on-hold', 'pending', 'in-progress') then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_STATUS_NOT_TICKETABLE');
  end if;
  if v_booking.payment_state not in ('held', 'reconciliation')
     or v_booking.captured_amount <> 0 or v_booking.refunded_amount <> 0 then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_PAYMENT_NOT_CAPTURABLE');
  end if;
  if v_case.operation_id is not null then
    select * into v_operation from public.booking_operations where id = v_case.operation_id;
    if v_operation.state <> 'needs_reconciliation' then
      return jsonb_build_object('ok', false, 'code', 'OPERATION_NOT_RECONCILING');
    end if;
  end if;
  select * into v_reservation from public.wallet_reservations
   where id = (v_contract->>'reservationId')::uuid;
  if not found or v_reservation.state not in ('active', 'reconciliation')
     or v_reservation.booking_id is distinct from p_booking_id
     or v_reservation.amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'PROTECTED_HOLD_REQUIRED');
  end if;
  select * into v_account from public.wallet_accounts
   where id = v_reservation.wallet_account_id;
  if not found
     or v_account.id is distinct from (v_contract->>'walletAccountId')::uuid
     or v_account.currency <> v_reservation.currency
     or v_booking.currency <> v_reservation.currency
     or (v_booking.payment_amount is not null
       and v_booking.payment_amount <> v_reservation.amount)
     or (v_booking.charged_wallet_account_id is not null
       and v_booking.charged_wallet_account_id <> v_account.id) then
    return jsonb_build_object('ok', false, 'code', 'CAPTURE_IDENTITY_MISMATCH');
  end if;
  if v_account.hold_balance < v_reservation.amount then
    return jsonb_build_object('ok', false, 'code', 'HOLD_BALANCE_MISMATCH');
  end if;

  select observation.* into v_evidence
    from jsonb_array_elements_text(v_case.proposal->'evidenceObservationIds') evidence_id(id)
    join public.booking_reconciliation_observations observation
      on observation.id = evidence_id.id::uuid
     and observation.reconciliation_case_id = v_case.id
   where observation.normalized_facts->>'version' = '2'
     and observation.normalized_facts->>'evidenceContract' = 'canonical_supplier_evidence_v2'
     and observation.normalized_facts->>'requestedPurpose' = 'ticketed'
     and observation.normalized_facts #>> '{validation,authoritativeFor}' = 'ticketed'
   order by observation.observed_at desc, observation.id desc limit 1;
  if not found or not public.booking_reconciliation_evidence_v2_authoritative(
    p_booking_id, p_case_id, v_evidence.id, 'ticketed'
  ) then
    return jsonb_build_object('ok', false, 'code', 'AUTHORITATIVE_TICKET_EVIDENCE_REQUIRED');
  end if;

  v_supplier_unique_trans_id := v_evidence.normalized_facts
    #>> '{evidence,ticketReport,bookingIdentity,transactionId}';
  v_supplier_internal_booking_id := nullif(btrim(v_evidence.normalized_facts
    #>> '{evidence,ticketReport,bookingIdentity,supplierBookingId}'), '');
  if v_supplier_unique_trans_id is distinct from
       (v_booking.supplier_refs->>'uniqueTransId')
     or v_supplier_internal_booking_id is null then
    return jsonb_build_object('ok', false, 'code', 'SUPPLIER_BOOKING_IDENTITY_MISMATCH');
  end if;
  select coalesce(jsonb_agg(to_jsonb(ticket.value->>'fullNumber')), '[]'::jsonb)
    into v_ticket_numbers
    from jsonb_array_elements(coalesce(
      v_evidence.normalized_facts #> '{evidence,ticketReport,tickets}', '[]'::jsonb
    )) ticket(value)
   where jsonb_typeof(ticket.value) = 'object'
     and nullif(btrim(ticket.value->>'fullNumber'), '') is not null;
  if jsonb_array_length(v_ticket_numbers) = 0
     or jsonb_array_length(v_ticket_numbers) <>
       jsonb_array_length(coalesce(
         v_evidence.normalized_facts #> '{evidence,ticketReport,passengers}', '[]'::jsonb
       )) then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_INCOMPLETE');
  end if;
  v_supplier_pnr := nullif(btrim(v_evidence.normalized_facts
    #>> '{evidence,ticketReport,bookingIdentity,supplierPnr}'), '');
  v_airlines_pnr := v_evidence.normalized_facts
    #> '{evidence,ticketReport,bookingIdentity,airlinePnrs}';
  v_supplier_status := nullif(btrim(v_evidence.normalized_facts
    #>> '{evidence,ticketReport,lifecycle,rawStatus}'), '');
  begin
    v_issued_at := nullif(v_evidence.normalized_facts
      #>> '{evidence,ticketReport,lifecycle,issuedAt}', '')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ISSUED_TIMESTAMP');
  end;
  if v_issued_at is null or v_issued_at > v_evidence.observed_at + interval '1 minute' then
    return jsonb_build_object('ok', false, 'code', 'ISSUED_TIMESTAMP_REQUIRED');
  end if;
  v_supplier_identifiers := jsonb_build_object(
    'evidenceContract', 'canonical_supplier_evidence_v2',
    'supplierAccount', v_booking.supplier_account,
    'supplierUniqueTransId', v_supplier_unique_trans_id,
    'supplierInternalBookingId', v_supplier_internal_booking_id,
    'supplierPnr', v_supplier_pnr,
    'bookingReference', v_evidence.normalized_facts
      #>> '{evidence,ticketReport,bookingIdentity,bookingReference}'
  );

  if exists (
    select 1 from public.wallet_ledger_entries
     where idempotency_key = p_execution_request_key || ':capture'
  ) then return jsonb_build_object('ok', false, 'code', 'CAPTURE_IDEMPOTENCY_CONFLICT'); end if;
  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  update public.wallet_accounts set hold_balance = hold_balance - v_reservation.amount
   where id = v_account.id;
  update public.wallet_reservations
     set booking_id = p_booking_id, booking_attempt_id = null, state = 'captured',
         issued_by_user_id = p_actor_user_id, captured_at = clock_timestamp(),
         reconciliation_at = null, reconciliation_reason = null
   where id = v_reservation.id;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks, metadata
  ) values (
    v_account.id, 'booking_confirm', v_reservation.amount, v_reservation.currency,
    v_available_before, v_available_before, v_hold_before,
    v_hold_before - v_reservation.amount, v_booking.id, v_booking.public_ref,
    v_reservation.id, p_execution_request_key || ':capture', p_actor_user_id,
    v_contract->>'actorRole', 'Approved canonical V2 ticketing reconciliation capture',
    jsonb_build_object(
      'reconciliationCaseId', v_case.id, 'proposalHash', v_case.proposal_hash,
      'operationId', v_case.operation_id, 'evidenceObservationId', v_evidence.id,
      'resolutionKind', 'ticketed', 'supplierIdentifiers', v_supplier_identifiers)
  ) returning id into v_ledger_entry_id;

  v_from_lifecycle := public.resolve_booking_lifecycle(
    v_booking.status, v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, v_booking.operation_kind
  );
  update public.flight_bookings
     set status = 'confirmed', charged_wallet_account_id = v_account.id,
         payment_state = 'captured', payment_amount = v_reservation.amount,
         captured_amount = v_reservation.amount, refunded_amount = 0,
         issued_by_user_id = p_actor_user_id,
         -- A later report can never overwrite an already accepted authoritative instant.
         issued_at = coalesce(issued_at, v_issued_at),
         pnr = coalesce(v_supplier_pnr, pnr),
         airlines_pnr = case when jsonb_typeof(v_airlines_pnr) = 'array'
           and jsonb_array_length(v_airlines_pnr) > 0 then v_airlines_pnr
           else airlines_pnr end,
         supplier_refs = v_booking.supplier_refs,
         ticketing_deadline_at = v_booking.ticketing_deadline_at,
         booking_status = coalesce(v_supplier_status, 'Confirmed'),
         -- ticketCodeRef is opaque workflow metadata, not ticket identity.
         ticket_code_ref = v_booking.ticket_code_ref,
         ticket_numbers = v_ticket_numbers,
         active_operation_id = null, operation_kind = null,
         operation_reason = null, operation_request_id = null,
         operation_actor_user_id = null, operation_started_at = null,
         operation_prior_status = null
   where id = v_booking.id;
  if v_case.operation_id is not null then
    update public.booking_operations
       set state = 'succeeded', completed_at = clock_timestamp(),
           error_code = null, error_message = null,
           supplier_evidence = coalesce(supplier_evidence, '{}'::jsonb) ||
             jsonb_build_object('canonicalV2ReconciliationResolution', jsonb_build_object(
               'caseId', v_case.id, 'outcome', 'ticketed',
               'evidenceObservationId', v_evidence.id,
               'supplierIdentifiers', v_supplier_identifiers))
     where id = v_case.operation_id;
  end if;
  select count(*)::integer + 1 into v_occurrence_number
    from public.booking_status_events
   where booking_id = v_booking.id and to_lifecycle_status = 'confirmed';
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, operation_id,
    reconciliation_case_id, occurrence_number,
    effective_at, observed_at, event_snapshot, event_version
  ) values (
    v_booking.id, v_from_lifecycle, 'confirmed', v_booking.status, 'confirmed',
    v_booking.operation_kind, v_booking.operation_reason, p_actor_user_id,
    'ReconciliationTicketedV2', jsonb_build_object(
      'evidenceObservationId', v_evidence.id,
      'ticketCount', jsonb_array_length(v_ticket_numbers),
      'supplierIdentifiers', v_supplier_identifiers),
    p_execution_request_key || ':confirmed', v_case.operation_id,
    v_case.id, v_occurrence_number, v_issued_at, clock_timestamp(),
    jsonb_build_object(
      'version', 2, 'evidenceContract', 'canonical_supplier_evidence_v2',
      'bookingReference', v_booking.public_ref, 'lifecycleStatus', 'confirmed',
      'paymentState', 'captured', 'ticketCount', jsonb_array_length(v_ticket_numbers),
      'operationKind', coalesce(v_booking.operation_kind, 'reconciliation'),
      'reconciliationCaseId', v_case.id,
      'supplierIdentifiers', v_supplier_identifiers), 1
  ) returning id into v_event_id;
  v_resolution_result := jsonb_build_object(
    'bookingStatus', 'confirmed', 'paymentState', 'captured',
    'reservationId', v_reservation.id, 'walletAccountId', v_account.id,
    'ledgerEntryId', v_ledger_entry_id, 'lifecycleEventId', v_event_id,
    'capturedAmount', v_reservation.amount, 'currency', v_reservation.currency,
    'availableBalance', v_available_before,
    'holdBalance', v_hold_before - v_reservation.amount,
    'supplierUniqueTransId', v_supplier_unique_trans_id,
    'supplierInternalBookingId', v_supplier_internal_booking_id,
    'supplierIdentifiers', v_supplier_identifiers
  );
  update public.booking_reconciliation_cases
     set state = 'resolved', resolution_outcome = 'ticketed',
         resolution = jsonb_build_object(
           'version', 2, 'evidenceContract', 'canonical_supplier_evidence_v2',
           'executionRequestKey', p_execution_request_key,
           'proposalHash', v_case.proposal_hash, 'resolutionKind', 'ticketed',
           'executedByRole', v_contract->>'actorRole',
           'evidenceObservationIds', v_case.proposal->'evidenceObservationIds',
           'supplierIdentifiers', v_supplier_identifiers,
           'result', v_resolution_result),
         resolution_reason = v_case.proposal->>'reason',
         resolved_by_user_id = p_actor_user_id,
         resolved_at = clock_timestamp(), closed_at = clock_timestamp(),
         version = version + 1
   where id = v_case.id;
  return v_resolution_result || jsonb_build_object(
    'ok', true, 'replay', false, 'caseId', v_case.id,
    'caseVersion', v_case.version + 1, 'resolutionKind', 'ticketed'
  );
end;
$$;

revoke all on function public.resolve_booking_reconciliation_ticketed_v2(
  uuid, uuid, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.resolve_booking_reconciliation_ticketed_v2(
  uuid, uuid, integer, text, text, text
) to service_role;

comment on function public.resolve_booking_reconciliation_ticketed_v2(
  uuid, uuid, integer, text, text, text
) is
  'Supplier-neutral V2 ticketed resolver. It accepts only fresh canonical evidence and performs the existing approved, idempotent protected-hold capture.';
