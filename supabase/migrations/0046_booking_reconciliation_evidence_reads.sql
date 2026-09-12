-- Controlled, idempotent staff supplier-evidence reads.
-- This migration records normalized read evidence against an existing open
-- reconciliation case. It never changes booking lifecycle truth, creates a
-- lifecycle event/outbox row, or reads/writes wallet balances or ledger rows.

create or replace function public.record_booking_reconciliation_evidence_read_v1(
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
  if p_booking_id is null
     or p_case_id is null
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or p_actor_role not in ('staff_support', 'admin', 'superadmin')
     or p_observation_key !~ '^evidence-read:v1:[a-f0-9]{64}$'
     or p_normalized_facts_hash !~ '^[a-f0-9]{64}$'
     or jsonb_typeof(coalesce(p_normalized_facts, '{}'::jsonb)) <> 'object'
     or coalesce(p_normalized_facts->>'version', '') <> '1'
     or coalesce(p_normalized_facts->>'action', '')
        <> 'supplier_evidence_read'
     or coalesce((p_normalized_facts->>'statusMutation')::boolean, true)
        is not false
     or coalesce((p_normalized_facts->>'walletMutation')::boolean, true)
        is not false
     or coalesce(
          (p_normalized_facts->>'destructiveSupplierCall')::boolean,
          true
        ) is not false
     or p_normalized_facts->>'bookingId' is distinct from p_booking_id::text
     or p_normalized_facts->>'caseId' is distinct from p_case_id::text
     or p_observed_at is null
     or p_observed_at > clock_timestamp() + interval '1 minute'
     or p_observed_at < clock_timestamp() - interval '5 minutes'
     or (
       p_evidence_observed_at is not null
       and (
         p_evidence_observed_at > p_observed_at + interval '1 minute'
         or p_evidence_observed_at < p_observed_at - interval '5 minutes'
       )
     ) then
    raise exception 'invalid reconciliation evidence-read observation'
      using errcode = '22023';
  end if;

  select candidate.* into v_case
    from public.booking_reconciliation_cases candidate
   where candidate.id = p_case_id
     and candidate.subject_booking_id = p_booking_id
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
  if not exists (
    select 1 from public.flight_bookings booking
     where booking.id = p_booking_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  insert into public.booking_reconciliation_observations (
    reconciliation_case_id,
    observation_key,
    observation_kind,
    observation_source,
    actor_user_id,
    actor_role,
    normalized_facts,
    normalized_facts_hash,
    observed_at
  ) values (
    p_case_id,
    p_observation_key,
    'staff_evidence',
    'supplier_read',
    p_actor_user_id,
    p_actor_role,
    p_normalized_facts,
    p_normalized_facts_hash,
    p_observed_at
  ) on conflict (reconciliation_case_id, observation_key) do nothing
  returning * into v_observation;

  if v_observation.id is null then
    select observation.normalized_facts_hash
      into v_existing_hash
      from public.booking_reconciliation_observations observation
     where observation.reconciliation_case_id = p_case_id
       and observation.observation_key = p_observation_key;
    if v_existing_hash is distinct from p_normalized_facts_hash then
      raise exception 'evidence-read request payload mismatch'
        using errcode = '22023';
    end if;
    select observation.* into v_observation
      from public.booking_reconciliation_observations observation
     where observation.reconciliation_case_id = p_case_id
       and observation.observation_key = p_observation_key;
  else
    v_created := true;
    update public.booking_reconciliation_cases
       set evidence_latest_at = case
             when p_evidence_observed_at is null then evidence_latest_at
             when evidence_latest_at is null then p_evidence_observed_at
             else greatest(evidence_latest_at, p_evidence_observed_at)
           end,
           evidence_normalizer_version = case
             when p_evidence_observed_at is null
               then evidence_normalizer_version
             else 1
           end,
           version = version + 1
     where id = p_case_id;
  end if;

  select version into v_case_version
    from public.booking_reconciliation_cases
   where id = p_case_id;

  return jsonb_build_object(
    'ok', true,
    'replay', not v_created,
    'caseId', p_case_id,
    'caseVersion', v_case_version,
    'observationId', v_observation.id,
    'evidenceLatestAt', case
      when p_evidence_observed_at is null then null
      else p_evidence_observed_at
    end,
    'statusMutation', false,
    'walletMutation', false,
    'destructiveSupplierCall', false
  );
end;
$$;

revoke all on function public.record_booking_reconciliation_evidence_read_v1(
  uuid, uuid, text, text, text, jsonb, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_booking_reconciliation_evidence_read_v1(
  uuid, uuid, text, text, text, jsonb, text, timestamptz, timestamptz
) to service_role;

comment on function public.record_booking_reconciliation_evidence_read_v1(
  uuid, uuid, text, text, text, jsonb, text, timestamptz, timestamptz
) is
  'Appends one payload-bound, idempotent normalized staff evidence read to an existing open booking reconciliation case. Never changes booking status, lifecycle events, notifications, wallet balances, reservations, or ledger entries.';
