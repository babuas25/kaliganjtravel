-- A recorded HTTP response proves the Book request completed at the transport
-- boundary. It must not be reported as a supplier-call timeout simply because
-- a process died before the response could be finalized into a booking.
--
-- The normal request path persists the booking immediately after Book. This
-- secondary branch only catches a genuine crash between that response and the
-- transaction, and preserves the no-replay reconciliation policy.

create or replace function public.process_booking_attempt_watchdog(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.booking_attempts;
  v_state_before text;
  v_reason_code text;
  v_reason_detail text;
  v_wallet_result jsonb;
  v_case_id uuid;
  v_processed integer := 0;
  v_cases_created integer := 0;
  v_cutoff timestamptz := now() - interval '3 minutes';
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'attempt watchdog limit must be between 1 and 500'
      using errcode = '22023';
  end if;

  for v_attempt in
    select attempt.*
      from public.booking_attempts attempt
     where attempt.state in ('submitting', 'unknown')
       and attempt.operation_request_key is not null
       and coalesce(
         attempt.supplier_response_received_at,
         attempt.supplier_call_started_at,
         attempt.submitted_at,
         attempt.resolved_at,
         attempt.updated_at
       ) <= v_cutoff
       and not exists (
         select 1
           from public.booking_reconciliation_cases open_case
          where open_case.subject_booking_attempt_id = attempt.id
            and open_case.case_type = 'attempt_uncertainty'
            and open_case.state in (
              'open', 'assigned', 'awaiting_supplier',
              'awaiting_finance', 'awaiting_approval'
            )
       )
     order by coalesce(
       attempt.supplier_response_received_at,
       attempt.supplier_call_started_at,
       attempt.submitted_at,
       attempt.resolved_at,
       attempt.updated_at
     ), attempt.id
     limit p_limit
     for update skip locked
  loop
    v_state_before := v_attempt.state;
    v_reason_code := case
      when v_attempt.supplier_response_received_at is not null
        then 'book_response_finalization_watchdog_timeout'
      when v_attempt.supplier_call_started_at is not null
        then 'book_supplier_call_watchdog_timeout'
      else 'book_local_claim_watchdog_timeout'
    end;
    v_reason_detail := case
      when v_attempt.supplier_response_received_at is not null then
        'Book received an HTTP response but no booking outcome was finalized within the three-minute watchdog; reconcile by authoritative read and never replay the write.'
      when v_attempt.supplier_call_started_at is not null then
        'Book supplier write exceeded the three-minute watchdog; reconcile by authoritative read and never replay the write.'
      else
        'Book attempt claim exceeded the three-minute watchdog before the supplier-call boundary was recorded.'
    end;

    v_wallet_result := public.wallet_mark_reconciliation(
      null,
      v_attempt.id,
      v_reason_detail
    );

    update public.booking_attempts
       set state = 'unknown',
           error_code = upper(v_reason_code),
           supplier_message = coalesce(supplier_message, v_reason_detail),
           resolved_at = coalesce(resolved_at, now())
     where id = v_attempt.id;

    v_case_id := null;
    insert into public.booking_reconciliation_cases (
      subject_booking_attempt_id, case_type, state,
      reason_code, reason_detail, opened_source,
      opened_by_user_id, opened_by_role, opened_at,
      assigned_team, severity, priority, due_at,
      evidence, evidence_latest_at, evidence_normalizer_version,
      policy_version
    ) values (
      v_attempt.id, 'attempt_uncertainty', 'open',
      v_reason_code, v_reason_detail, 'operation',
      'system:attempt-watchdog', 'system', now(),
      'support', 'high', 85, now() + interval '15 minutes',
      jsonb_build_array(jsonb_build_object(
        'kind', 'attempt_watchdog_observation',
        'observedAt', now(),
        'attemptStateBefore', v_state_before,
        'supplierCallStartedAt', v_attempt.supplier_call_started_at,
        'supplierResponseRecorded',
          v_attempt.supplier_response_received_at is not null,
        'walletPositionProtected', coalesce(
          (v_wallet_result->>'ok')::boolean, false
        ),
        'automaticSupplierReplay', false
      )),
      now(), 1, 1
    ) on conflict do nothing
    returning id into v_case_id;

    v_processed := v_processed + 1;
    if v_case_id is not null then
      v_cases_created := v_cases_created + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'processed', v_processed,
    'casesCreated', v_cases_created,
    'thresholdSeconds', 180,
    'caseDueSeconds', 900,
    'limit', p_limit,
    'historicalNullIdentityExcluded', true,
    'automaticSupplierReplay', false
  );
end;
$$;

revoke all on function public.process_booking_attempt_watchdog(integer)
  from public, anon, authenticated;
grant execute on function public.process_booking_attempt_watchdog(integer)
  to service_role;

comment on function public.process_booking_attempt_watchdog(integer) is
  'Moves stale operation-identified attempts to owned reconciliation after three minutes. A recorded HTTP response is classified as finalization timeout, never as a supplier-call timeout; no supplier write is replayed.';
