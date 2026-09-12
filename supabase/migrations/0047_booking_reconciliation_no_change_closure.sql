-- Narrow automatic closure for evidence that confirms existing terminal truth.
-- Lock order is booking -> operation -> case -> reservation. The function can
-- complete internal ownership metadata but cannot change lifecycle status,
-- wallet balances, reservations, ledger, lifecycle events, or notifications.

create or replace function public.close_booking_reconciliation_no_change_v1(
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
  v_observation public.booking_reconciliation_observations;
  v_operation_id uuid;
  v_expected_truth text;
  v_evidence_truth text;
  v_evidence_at timestamptz;
begin
  if p_booking_id is null or p_case_id is null or p_observation_id is null then
    raise exception 'invalid no-change closure request' using errcode = '22023';
  end if;

  -- Read the immutable operation reference first, then acquire every mutable
  -- row in the global lifecycle/financial lock order.
  select candidate.operation_id into v_operation_id
    from public.booking_reconciliation_cases candidate
   where candidate.id = p_case_id
     and candidate.subject_booking_id = p_booking_id;
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

  if v_operation_id is not null then
    select operation.* into v_operation
      from public.booking_operations operation
     where operation.id = v_operation_id
       and operation.booking_id = p_booking_id
     for update;
  end if;

  select candidate.* into v_case
    from public.booking_reconciliation_cases candidate
   where candidate.id = p_case_id
     and candidate.subject_booking_id = p_booking_id
   for update;
  if v_case.state = 'closed_no_change'
     and v_case.resolution_outcome = 'supplier_truth_unchanged'
     and v_case.resolution->>'observationId' = p_observation_id::text then
    return jsonb_build_object(
      'ok', true,
      'replay', true,
      'caseId', p_case_id,
      'observationId', p_observation_id,
      'statusMutation', false,
      'walletMutation', false
    );
  end if;
  if v_case.state not in (
    'open', 'assigned', 'awaiting_supplier',
    'awaiting_finance', 'awaiting_approval'
  ) then
    return jsonb_build_object('ok', false, 'code', 'CASE_NOT_OPEN');
  end if;

  select reservation.* into v_reservation
    from public.wallet_reservations reservation
   where reservation.booking_id = p_booking_id
   for update;

  select observation.* into v_observation
    from public.booking_reconciliation_observations observation
   where observation.id = p_observation_id
     and observation.reconciliation_case_id = p_case_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_NOT_FOUND');
  end if;

  if v_case.case_type not in (
       'ticketing_uncertainty', 'cancellation_uncertainty'
     )
     or v_case.proposed_outcome is not null
     or v_case.financial_disposition <> 'none'
     or v_case.operation_id is null
     or v_operation.id is null
     or v_operation.state <> 'needs_reconciliation'
     or v_booking.active_operation_id is not null
        and v_booking.active_operation_id <> v_operation.id
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

  v_expected_truth := case v_booking.status
    when 'confirmed' then 'ticketed'
    when 'cancelled' then 'cancelled'
    else null
  end;
  v_evidence_truth := v_observation.normalized_facts
    #>> '{validation,authoritativeFor}';
  begin
    v_evidence_at := (
      v_observation.normalized_facts->>'evidenceObservedAt'
    )::timestamptz;
  exception when others then
    v_evidence_at := null;
  end;

  if v_expected_truth is null
     or v_evidence_truth is distinct from v_expected_truth
     or v_observation.observation_kind <> 'staff_evidence'
     or v_observation.observation_source <> 'supplier_read'
     or v_observation.normalized_facts->>'action'
        is distinct from 'supplier_evidence_read'
     or v_observation.normalized_facts->>'bookingId'
        is distinct from p_booking_id::text
     or v_observation.normalized_facts->>'caseId'
        is distinct from p_case_id::text
     or coalesce(
          (v_observation.normalized_facts #>> '{validation,valid}')::boolean,
          false
        ) is not true
     or coalesce(
          (v_observation.normalized_facts #>> '{validation,complete}')::boolean,
          false
        ) is not true
     or coalesce(
          (v_observation.normalized_facts #>> '{validation,fresh}')::boolean,
          false
        ) is not true
     or coalesce(
          (
            v_observation.normalized_facts
              #>> '{validation,identityMatches}'
          )::boolean,
          false
        ) is not true
     or v_evidence_at is null
     or v_evidence_at < clock_timestamp() - interval '5 minutes'
     or v_evidence_at > clock_timestamp() + interval '1 minute'
     or not (
       coalesce(
         v_observation.normalized_facts->'recordedSources', '[]'::jsonb
       ) @> '["pnr", "air-ticketing-details"]'::jsonb
     )
     or v_observation.normalized_facts #>> '{evidence,pnr,source}'
        is distinct from 'pnr'
     or v_observation.normalized_facts
          #>> '{evidence,airTicketing,source}'
        is distinct from 'air-ticketing-details'
     or upper(btrim(coalesce(
          v_observation.normalized_facts
            #>> '{expectedIdentity,uniqueTransId}',
          ''
        ))) is distinct from upper(btrim(coalesce(
          v_booking.supplier_refs->>'uniqueTransId',
          ''
        )))
     or upper(btrim(coalesce(
          v_observation.normalized_facts
            #>> '{expectedIdentity,bookingCodeRef}',
          ''
        ))) is distinct from upper(btrim(coalesce(
          v_booking.booking_code_ref,
          ''
        )))
     or v_observation.normalized_facts #>> '{localContext,storedStatus}'
        is distinct from v_booking.status
     or v_observation.normalized_facts #>> '{localContext,paymentState}'
        is distinct from v_booking.payment_state
     or (v_expected_truth = 'ticketed' and v_operation.kind <> 'ticketing')
     or (v_expected_truth = 'cancelled' and v_operation.kind <> 'cancellation')
     then
    return jsonb_build_object('ok', false, 'code', 'EVIDENCE_NOT_AUTHORITATIVE');
  end if;

  if (
    v_booking.status = 'confirmed'
    and not (
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
    v_booking.status = 'cancelled'
    and not (
      (
        v_booking.payment_state = 'unpaid'
        and v_booking.captured_amount = 0
        and v_booking.refunded_amount = 0
        and v_reservation.id is null
      )
      or (
        v_booking.payment_state = 'released'
        and v_booking.captured_amount = 0
        and v_booking.refunded_amount = 0
        and v_reservation.id is not null
        and v_reservation.state = 'released'
      )
      or (
        v_booking.payment_state = 'refunded'
        and v_booking.captured_amount > 0
        and v_booking.refunded_amount = v_booking.captured_amount
        and v_reservation.id is not null
        and v_reservation.state = 'captured'
      )
    )
  ) then
    return jsonb_build_object('ok', false, 'code', 'FINANCIAL_CONFLICT');
  end if;

  update public.booking_operations
     set state = 'succeeded',
         completed_at = coalesce(completed_at, clock_timestamp()),
         error_code = null,
         error_message = null,
         supplier_evidence = supplier_evidence || jsonb_build_object(
           'noChangeClosure', jsonb_build_object(
             'observationId', p_observation_id,
             'authoritativeFor', v_evidence_truth,
             'closedAt', clock_timestamp()
           )
         )
   where id = v_operation.id;

  update public.flight_bookings
     set active_operation_id = null,
         operation_kind = null,
         operation_reason = null,
         operation_request_id = null,
         operation_actor_user_id = null,
         operation_started_at = null,
         operation_prior_status = null
   where id = p_booking_id;

  update public.booking_reconciliation_cases
     set state = 'closed_no_change',
         resolution_outcome = 'supplier_truth_unchanged',
         resolution = jsonb_build_object(
           'observationId', p_observation_id,
           'authoritativeFor', v_evidence_truth,
           'statusMutation', false,
           'walletMutation', false
         ),
         resolution_reason =
           'Fresh complete supplier evidence confirms existing terminal truth and financial state is already consistent',
         resolved_by_user_id = 'system:evidence-no-change',
         resolved_at = clock_timestamp(),
         closed_at = clock_timestamp(),
         version = version + 1
   where id = p_case_id;

  insert into public.security_audit_events (
    actor_user_id, actor_role, action, target_type, target_id, outcome, metadata
  ) values (
    'system:evidence-no-change',
    'system',
    'booking.reconciliation.closed_no_change',
    'flight_booking',
    p_booking_id::text,
    'succeeded',
    jsonb_build_object(
      'caseId', p_case_id,
      'operationId', v_operation.id,
      'observationId', p_observation_id,
      'authoritativeFor', v_evidence_truth,
      'statusMutation', false,
      'walletMutation', false
    )
  );

  return jsonb_build_object(
    'ok', true,
    'replay', false,
    'caseId', p_case_id,
    'operationId', v_operation.id,
    'observationId', p_observation_id,
    'closedNoChange', true,
    'statusMutation', false,
    'walletMutation', false
  );
end;
$$;

revoke all on function public.close_booking_reconciliation_no_change_v1(
  uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.close_booking_reconciliation_no_change_v1(
  uuid, uuid, uuid
) to service_role;

comment on function public.close_booking_reconciliation_no_change_v1(
  uuid, uuid, uuid
) is
  'Closes one ticketing/cancellation uncertainty case and completes its operation only when fresh complete PNR+AirTicketingDetails evidence matches the existing terminal status and the wallet/reservation state is already consistent. It creates no lifecycle event or notification and moves no money.';
