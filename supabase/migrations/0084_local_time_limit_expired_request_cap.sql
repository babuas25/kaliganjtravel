-- Keep the existing NULL and under-15-minute eligibility paths, but cap new
-- requests for an expired supplier deadline at three hours. The request RPC
-- and the direct-write trigger both use database time as the authority.

alter table public.booking_local_time_limit_requests
  drop constraint if exists booking_local_ttl_reason_check;
alter table public.booking_local_time_limit_requests
  add constraint booking_local_ttl_reason_check check (
    eligibility_reason in (
      'supplier_deadline_missing',
      'supplier_deadline_under_15_minutes',
      'supplier_deadline_expired_under_3_hours'
    )
  );

create or replace function public.request_booking_local_time_limit_v1(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_actor_role text;
  v_actor_agency text;
  v_existing public.booking_local_time_limit_requests;
  v_request public.booking_local_time_limit_requests;
  v_reason text;
  v_now timestamptz;
begin
  if nullif(btrim(p_actor_user_id), '') is null
     or p_actor_role not in ('b2b', 'b2b_sub', 'customer')
     or nullif(btrim(p_request_key), '') is null
     or char_length(p_request_key) > 255 then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_FORBIDDEN');
  end if;

  select role, agency_code into v_actor_role, v_actor_agency
    from public.app_users where clerk_id = p_actor_user_id;
  if not found or v_actor_role is distinct from p_actor_role then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_FORBIDDEN');
  end if;

  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  v_now := clock_timestamp();

  if not (
    (p_actor_role = 'customer'
      and v_booking.booking_owner_type = 'user'
      and v_booking.booking_owner_key = p_actor_user_id)
    or
    (p_actor_role in ('b2b', 'b2b_sub')
      and v_actor_agency is not null
      and v_booking.booking_owner_type = 'agency'
      and v_booking.booking_owner_key = v_actor_agency)
  ) then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_FORBIDDEN');
  end if;

  select * into v_existing
    from public.booking_local_time_limit_requests
   where requested_by_user_id = p_actor_user_id
     and request_key = p_request_key;
  if found then
    if v_existing.booking_id is distinct from p_booking_id then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_KEY_CONFLICT');
    end if;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', v_existing.id,
      'state', v_existing.state, 'requestedAt', v_existing.requested_at,
      'version', v_existing.version
    );
  end if;

  if lower(coalesce(v_booking.supplier, '')) <> 'triplover'
     or v_booking.status <> 'on-hold'
     or v_booking.operation_kind is not null
     or v_booking.direct_ticketing
     or v_booking.issued_at is not null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_ELIGIBLE');
  end if;
  if not public.jsonb_is_nonempty_array(v_booking.airlines_pnr) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_UNCONFIRMED');
  end if;
  if exists (
    select 1 from public.booking_reconciliation_cases c
     where c.subject_booking_id = p_booking_id
       and c.state in (
         'open', 'assigned', 'awaiting_supplier',
         'awaiting_finance', 'awaiting_approval'
       )
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'BOOKING_RECONCILIATION_REQUIRED'
    );
  end if;
  if v_booking.active_local_time_limit_request_id is not null then
    return jsonb_build_object(
      'ok', false,
      'code', case
        when v_booking.local_ticketing_deadline_at <= v_now
          then 'BOOKING_EXPIRED'
        else 'LOCAL_TIME_LIMIT_ACTIVE'
      end
    );
  end if;
  if v_booking.supplier_ticketing_deadline_at >=
       v_now + interval '15 minutes' then
    return jsonb_build_object(
      'ok', false, 'code', 'SUPPLIER_DEADLINE_SUFFICIENT'
    );
  end if;
  if v_booking.supplier_ticketing_deadline_at <=
       v_now - interval '3 hours' then
    return jsonb_build_object(
      'ok', false, 'code', 'LOCAL_TIME_LIMIT_REQUEST_WINDOW_EXPIRED'
    );
  end if;

  select * into v_existing
    from public.booking_local_time_limit_requests
   where booking_id = p_booking_id and state = 'pending'
   for update;
  if found then
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', v_existing.id,
      'state', v_existing.state, 'requestedAt', v_existing.requested_at,
      'version', v_existing.version
    );
  end if;

  v_reason := case
    when v_booking.supplier_ticketing_deadline_at is null
      then 'supplier_deadline_missing'
    when v_booking.supplier_ticketing_deadline_at <= v_now
      then 'supplier_deadline_expired_under_3_hours'
    else 'supplier_deadline_under_15_minutes'
  end;
  insert into public.booking_local_time_limit_requests (
    booking_id, eligibility_reason, supplier_time_limit_snapshot,
    supplier_deadline_snapshot, requested_by_user_id,
    requested_by_role, request_key
  ) values (
    p_booking_id, v_reason, v_booking.supplier_ticketing_time_limit,
    v_booking.supplier_ticketing_deadline_at, p_actor_user_id,
    p_actor_role, p_request_key
  ) returning * into v_request;

  insert into public.booking_local_time_limit_events (
    booking_id, request_id, event_type, actor_user_id, actor_role,
    prior_deadline_at, reason, evidence
  ) values (
    p_booking_id, v_request.id, 'requested', p_actor_user_id, p_actor_role,
    v_booking.ticketing_deadline_at, v_reason,
    jsonb_build_object(
      'supplierTimeLimit', v_booking.supplier_ticketing_time_limit,
      'supplierDeadlineAt', v_booking.supplier_ticketing_deadline_at,
      'thresholdMinutes', 15,
      'expiredRequestWindowMinutes', 180,
      'walletMutation', false
    )
  );
  return jsonb_build_object(
    'ok', true, 'replay', false, 'requestId', v_request.id,
    'state', v_request.state, 'requestedAt', v_request.requested_at,
    'version', v_request.version
  );
end;
$$;

create or replace function public.enforce_local_time_limit_request_window_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_supplier_deadline timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  select booking.supplier_ticketing_deadline_at
    into v_supplier_deadline
    from public.flight_bookings booking
   where booking.id = new.booking_id
   for key share;
  if not found then
    raise exception 'booking not found'
      using errcode = 'P0002';
  end if;

  if v_supplier_deadline >= v_now + interval '15 minutes' then
    raise exception 'supplier ticketing deadline has at least 15 minutes remaining'
      using
        errcode = '23514',
        constraint = 'booking_local_ttl_under_15_minutes_check';
  end if;
  if v_supplier_deadline <= v_now - interval '3 hours' then
    raise exception 'supplier ticketing deadline expired at least 3 hours ago'
      using
        errcode = '23514',
        constraint = 'booking_local_ttl_expired_request_window_check';
  end if;
  return new;
end;
$$;

drop trigger if exists booking_local_ttl_request_window_v1
  on public.booking_local_time_limit_requests;
create trigger booking_local_ttl_request_window_v1
  before insert
  on public.booking_local_time_limit_requests
  for each row execute function public.enforce_local_time_limit_request_window_v1();

revoke all on function public.enforce_local_time_limit_request_window_v1()
  from public, anon, authenticated, service_role;

comment on function public.request_booking_local_time_limit_v1(
  uuid, text, text, text
) is
  'Creates one owner-scoped request when Triplover TTL is missing, has less than 15 minutes remaining, or expired less than 3 hours ago; database time is authoritative and users cannot choose minutes.';

comment on function public.enforce_local_time_limit_request_window_v1() is
  'Prevents direct request inserts outside the NULL, under-15-minute, and less-than-3-hours-expired eligibility window using database time.';
