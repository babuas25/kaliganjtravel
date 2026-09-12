-- Material lifecycle re-entry notification policy.
--
-- Returning to On Hold, Pending, In Progress, Expired, or Unconfirmed after a
-- different lifecycle state is a new customer occurrence. Repeating the same
-- non-terminal state without leaving it is audit-only. Historical/backfill and
-- timestamp/case-only repairs may suppress only with an approved explicit code.

create or replace function public.resolve_booking_notification_policy_v1(
  p_from_lifecycle_status text,
  p_to_lifecycle_status text,
  p_operation_kind text,
  p_supplier_operation text,
  p_event_snapshot jsonb
)
returns table (
  resolved_policy text,
  resolved_suppression_reason text,
  resolved_grace_seconds integer
)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_disposition text := nullif(
    btrim(coalesce(p_event_snapshot->>'notificationDisposition', '')), ''
  );
  v_reason text := nullif(
    btrim(coalesce(p_event_snapshot->>'suppressionReason', '')), ''
  );
begin
  if v_disposition is not null and v_disposition <> 'audit_only' then
    raise exception 'invalid notification disposition' using errcode = '22023';
  end if;
  if v_disposition = 'audit_only' then
    if v_reason not in (
      'historical_baseline', 'backfill_observation', 'timestamp_repair',
      'case_only_repair'
    ) then
      raise exception 'unapproved notification suppression reason'
        using errcode = '22023';
    end if;
    return query select 'suppress'::text, v_reason, null::integer;
    return;
  end if;

  if p_supplier_operation = 'MigrationBaseline' then
    return query
      select 'suppress'::text, 'historical_baseline'::text, null::integer;
    return;
  end if;

  if p_to_lifecycle_status in (
       'on-hold', 'pending', 'in-progress', 'expired', 'unconfirmed'
     )
     and p_from_lifecycle_status = p_to_lifecycle_status then
    return query
      select 'suppress'::text, 'non_material_same_status'::text, null::integer;
    return;
  end if;

  if p_to_lifecycle_status = 'in-progress'
     and p_operation_kind in ('ticketing', 'cancellation')
     and coalesce(
       p_event_snapshot->>'operationSource',
       case when p_operation_kind = 'imported_manual_ticketing'
         then 'imported_manual_ticketing' else 'triplover' end
     ) <> 'imported_manual_ticketing' then
    return query select 'grace'::text, null::text, 120;
    return;
  end if;

  return query select 'send'::text, null::text, 0;
end;
$$;

create or replace function public.enqueue_booking_lifecycle_event_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_booking_ref text;
  v_payment_state text;
  v_policy text;
  v_suppression_reason text;
  v_grace_seconds integer;
  v_available_at timestamptz;
  v_grace_expires_at timestamptz;
  v_snapshot jsonb;
  v_outbox_id uuid;
  v_state text;
  v_completed_at timestamptz;
begin
  if new.to_lifecycle_status not in (
    'on-hold', 'pending', 'in-progress', 'confirmed',
    'expired', 'unconfirmed', 'cancelled'
  ) then
    raise exception 'unsupported lifecycle notification status'
      using errcode = '23514';
  end if;
  select booking.public_ref, booking.payment_state
    into v_booking_ref, v_payment_state
    from public.flight_bookings booking
   where booking.id = new.booking_id;
  if not found then
    raise exception 'notification booking not found' using errcode = '23503';
  end if;

  select policy.resolved_policy,
         policy.resolved_suppression_reason,
         policy.resolved_grace_seconds
    into v_policy, v_suppression_reason, v_grace_seconds
    from public.resolve_booking_notification_policy_v1(
      new.from_lifecycle_status,
      new.to_lifecycle_status,
      new.operation_kind,
      new.supplier_operation,
      coalesce(new.event_snapshot, '{}'::jsonb)
    ) policy;

  if v_policy = 'grace' then
    v_grace_expires_at := v_now + make_interval(secs => v_grace_seconds);
    v_available_at := v_grace_expires_at;
  else
    v_available_at := v_now;
  end if;
  if v_policy = 'suppress' then
    v_state := 'suppressed';
    v_completed_at := v_now;
  else
    v_state := 'pending';
  end if;

  v_snapshot := coalesce(new.event_snapshot, '{}'::jsonb)
    || jsonb_strip_nulls(jsonb_build_object(
      'version', greatest(coalesce(new.event_version, 1), 1),
      'bookingReference', v_booking_ref,
      'lifecycleStatus', new.to_lifecycle_status,
      'paymentState', v_payment_state,
      'occurrenceId', new.occurrence_id,
      'occurrenceNumber', new.occurrence_number,
      'effectiveAt', new.effective_at,
      'observedAt', coalesce(new.observed_at, v_now)
    ));

  insert into public.booking_notification_outbox (
    lifecycle_event_id, booking_id, notification_kind,
    lifecycle_status, event_snapshot, delivery_policy,
    state, policy_version, available_at, grace_expires_at,
    suppression_reason, completed_at
  ) values (
    new.id, new.booking_id, 'booking_status',
    new.to_lifecycle_status, v_snapshot, v_policy,
    v_state, 1, v_available_at, v_grace_expires_at,
    v_suppression_reason, v_completed_at
  )
  on conflict (lifecycle_event_id, notification_kind) do nothing
  returning id into v_outbox_id;

  if v_outbox_id is null then
    select candidate.id into v_outbox_id
      from public.booking_notification_outbox candidate
     where candidate.lifecycle_event_id = new.id
       and candidate.notification_kind = 'booking_status';
  end if;

  if v_policy <> 'suppress'
     and new.to_lifecycle_status in ('confirmed', 'cancelled') then
    update public.booking_notification_outbox intermediate
       set state = 'superseded',
           suppression_reason = 'terminal_during_in_progress_grace',
           superseded_by_outbox_id = v_outbox_id,
           completed_at = v_now
     where intermediate.booking_id = new.booking_id
       and intermediate.id <> v_outbox_id
       and intermediate.lifecycle_status = 'in-progress'
       and intermediate.delivery_policy = 'grace'
       and intermediate.state = 'pending'
       and intermediate.grace_expires_at > v_now;
  end if;

  return new;
end;
$$;

revoke all on function public.resolve_booking_notification_policy_v1(
  text,text,text,text,jsonb
) from public, anon, authenticated;
grant execute on function public.resolve_booking_notification_policy_v1(
  text,text,text,text,jsonb
) to service_role;
revoke all on function public.enqueue_booking_lifecycle_event_v1()
  from public, anon, authenticated, service_role;

comment on function public.resolve_booking_notification_policy_v1(
  text,text,text,text,jsonb
) is 'Version-1 material occurrence policy. Cross-status non-terminal re-entry sends again; same-status non-terminal and approved historical/timestamp/case-only repair are retained as suppressed outbox evidence.';
