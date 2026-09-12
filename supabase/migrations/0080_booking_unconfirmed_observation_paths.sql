-- Booking creation already emits the resolver-derived initial lifecycle event,
-- and PNR refresh emits a before/after transition. Imported Sync receives the
-- same primary-path guarantee here. The bounded repair function is audit-only
-- and exists solely for historical/missed-event recovery.

create or replace function public.ensure_import_sync_unconfirmed_event_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_last_status text;
  v_observed_at timestamptz := coalesce(new.synced_at, clock_timestamp());
begin
  if new.import_source is distinct from 'IMP_EXP'
     or new.synced_at is not distinct from old.synced_at
     or public.resolve_booking_lifecycle(
       new.status,
       new.airlines_pnr,
       new.ticketing_deadline_at,
       new.operation_kind
     ) <> 'unconfirmed' then
    return new;
  end if;

  select event.to_lifecycle_status into v_last_status
  from public.booking_status_events event
  where event.booking_id = new.id
  order by event.id desc
  limit 1;
  if v_last_status is not distinct from 'unconfirmed' then
    return new;
  end if;

  insert into public.booking_status_events (
    booking_id,
    from_lifecycle_status,
    to_lifecycle_status,
    stored_status_before,
    stored_status_after,
    operation_kind,
    operation_reason,
    actor_user_id,
    supplier_operation,
    supplier_evidence,
    idempotency_key,
    observed_at,
    event_snapshot
  ) values (
    new.id,
    coalesce(v_last_status, 'on-hold'),
    'unconfirmed',
    old.status,
    new.status,
    new.operation_kind,
    new.operation_reason,
    nullif(new.import_metadata->>'lastSyncedBy', ''),
    'ImportedSync',
    jsonb_build_object(
      'observationSource', 'import_sync',
      'statusMutation', false,
      'walletMutation', false
    ),
    'import-sync-unconfirmed:v1:' || to_char(
      v_observed_at at time zone 'UTC',
      'YYYYMMDD"T"HH24MISS.US"Z"'
    ),
    v_observed_at,
    jsonb_build_object('observationSource', 'import_sync')
  ) on conflict do nothing;
  return new;
end;
$$;

drop trigger if exists flight_bookings_import_sync_unconfirmed_event
  on public.flight_bookings;
create trigger flight_bookings_import_sync_unconfirmed_event
  after update of synced_at on public.flight_bookings
  for each row execute function public.ensure_import_sync_unconfirmed_event_v1();

revoke all on function public.ensure_import_sync_unconfirmed_event_v1()
  from public, anon, authenticated, service_role;

create index if not exists flight_bookings_unconfirmed_repair_idx
  on public.flight_bookings (id)
  where not legacy_operational
    and status = 'on-hold'
    and active_operation_id is null
    and operation_kind is null
    and not public.jsonb_is_nonempty_array(airlines_pnr);

create or replace function public.record_unconfirmed_booking_repair_batch_v1(
  p_after_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
  v_observed_at timestamptz := clock_timestamp();
  v_result jsonb;
begin
  with repair_candidates as materialized (
    select
      booking.id,
      booking.status,
      latest_event.id as last_event_id,
      coalesce(latest_event.to_lifecycle_status, 'on-hold') as last_status
    from public.flight_bookings booking
    left join lateral (
      select event.id, event.to_lifecycle_status
      from public.booking_status_events event
      where event.booking_id = booking.id
      order by event.id desc
      limit 1
    ) latest_event on true
    where not booking.legacy_operational
      and booking.status = 'on-hold'
      and booking.active_operation_id is null
      and booking.operation_kind is null
      and not public.jsonb_is_nonempty_array(booking.airlines_pnr)
      and coalesce(latest_event.to_lifecycle_status, 'on-hold') <> 'unconfirmed'
      and (p_after_id is null or booking.id > p_after_id)
    order by booking.id
    limit v_limit
    for update of booking skip locked
  ), inserted as (
    insert into public.booking_status_events (
      booking_id,
      from_lifecycle_status,
      to_lifecycle_status,
      stored_status_before,
      stored_status_after,
      supplier_operation,
      supplier_evidence,
      idempotency_key,
      observed_at,
      event_snapshot
    )
    select
      candidate.id,
      candidate.last_status,
      'unconfirmed',
      candidate.status,
      candidate.status,
      'LifecycleRepair',
      jsonb_build_object(
        'observationSource', 'unconfirmed_repair_backstop',
        'statusMutation', false,
        'walletMutation', false
      ),
      'derived-unconfirmed:repair:v1:'
        || coalesce(candidate.last_event_id::text, 'initial'),
      v_observed_at,
      jsonb_build_object(
        'observationSource', 'unconfirmed_repair_backstop',
        'notificationDisposition', 'audit_only',
        'suppressionReason', 'case_only_repair'
      )
    from repair_candidates candidate
    on conflict do nothing
    returning 1
  )
  select jsonb_build_object(
    'selectedCount', (select count(*) from repair_candidates),
    'insertedCount', (select count(*) from inserted),
    'nextId', (
      select candidate.id
      from repair_candidates candidate
      order by candidate.id desc
      limit 1
    ),
    'hasMore', (select count(*) = v_limit from repair_candidates),
    'observedAt', v_observed_at
  ) into v_result;
  return v_result;
end;
$$;

revoke all on function public.record_unconfirmed_booking_repair_batch_v1(
  uuid, integer
) from public, anon, authenticated, service_role;
grant execute on function public.record_unconfirmed_booking_repair_batch_v1(
  uuid, integer
) to service_role;

comment on function public.record_unconfirmed_booking_repair_batch_v1(
  uuid, integer
) is
  'Bounded audit-only repair for an On Hold/no-airline-PNR row whose current Unconfirmed occurrence was missed by booking creation or Sync.';
