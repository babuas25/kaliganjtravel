-- Add Triplover's direct credential account alongside FirstTrip and TakeOff.
-- The integration name remains `triplover`; `supplier_account` selects the
-- immutable credential and host set used by a search and its booking.

alter table public.flight_search_quotes
  drop constraint if exists flight_search_quotes_supplier_account_check;
alter table public.flight_search_quotes
  add constraint flight_search_quotes_supplier_account_check
  check (supplier_account is null or supplier_account in ('firsttrip', 'takeoff', 'triplover'));

alter table public.booking_attempts
  drop constraint if exists booking_attempts_supplier_account_check;
alter table public.booking_attempts
  add constraint booking_attempts_supplier_account_check
  check (supplier_account is null or supplier_account in ('firsttrip', 'takeoff', 'triplover'));

alter table public.flight_bookings
  drop constraint if exists flight_bookings_supplier_account_check;
alter table public.flight_bookings
  add constraint flight_bookings_supplier_account_check
  check (supplier_account is null or supplier_account in ('firsttrip', 'takeoff', 'triplover'));

alter table public.supplier_operational_settings
  drop constraint if exists supplier_operational_settings_active_supplier_check;
alter table public.supplier_operational_settings
  add constraint supplier_operational_settings_active_supplier_check
  check (active_supplier in ('firsttrip', 'takeoff', 'triplover'));

alter table public.flight_search_supplier_limits
  drop constraint if exists flight_search_supplier_limits_supplier_check;
alter table public.flight_search_supplier_limits
  add constraint flight_search_supplier_limits_supplier_check
  check (supplier in ('firsttrip', 'takeoff', 'triplover'));

insert into public.flight_search_supplier_limits (supplier, daily_limit)
values ('triplover', null)
on conflict (supplier) do nothing;

alter table public.flight_search_usage_events
  drop constraint if exists flight_search_usage_events_supplier_account_check;
alter table public.flight_search_usage_events
  add constraint flight_search_usage_events_supplier_account_check
  check (supplier_account in ('firsttrip', 'takeoff', 'triplover'));

-- Keep the atomic supplier/user daily-budget claim aligned with the expanded
-- supplier constraint.
create or replace function public.claim_flight_search_supplier_hit_v1(
  p_event_id uuid,
  p_supplier text,
  p_user_id text
)
returns table (
  allowed boolean,
  result_code text,
  supplier_count integer,
  supplier_limit integer,
  user_count integer,
  user_limit integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := timezone('Asia/Dhaka', clock_timestamp())::date;
  v_supplier_count integer := 0;
  v_supplier_limit integer;
  v_user_count integer := 0;
  v_user_limit integer;
  v_user_enabled boolean := true;
  v_code text;
begin
  if p_supplier not in ('firsttrip', 'takeoff', 'triplover') then
    raise exception 'unsupported supplier' using errcode = '22023';
  end if;

  insert into public.flight_search_daily_counters (
    scope_type, scope_key, usage_date, hit_count
  ) values ('supplier', p_supplier, v_today, 0)
  on conflict do nothing;

  select counter.hit_count into v_supplier_count
    from public.flight_search_daily_counters counter
   where counter.scope_type = 'supplier'
     and counter.scope_key = p_supplier
     and counter.usage_date = v_today
   for update;

  select limits.daily_limit into v_supplier_limit
    from public.flight_search_supplier_limits limits
   where limits.supplier = p_supplier;

  if p_user_id is not null then
    insert into public.flight_search_daily_counters (
      scope_type, scope_key, usage_date, hit_count
    ) values ('user', p_user_id, v_today, 0)
    on conflict do nothing;

    select counter.hit_count into v_user_count
      from public.flight_search_daily_counters counter
     where counter.scope_type = 'user'
       and counter.scope_key = p_user_id
       and counter.usage_date = v_today
     for update;

    select controls.search_enabled, controls.daily_limit
      into v_user_enabled, v_user_limit
      from public.flight_search_user_controls controls
     where controls.user_id = p_user_id;
    if not found then
      v_user_enabled := true;
      v_user_limit := null;
    end if;
  end if;

  v_code := case
    when p_user_id is not null and not v_user_enabled then 'USER_SEARCH_DISABLED'
    when p_user_id is not null and v_user_limit is not null
      and v_user_count >= v_user_limit then 'USER_DAILY_LIMIT_REACHED'
    when v_supplier_limit is not null and v_supplier_count >= v_supplier_limit
      then 'SUPPLIER_DAILY_LIMIT_REACHED'
    else 'ALLOWED'
  end;

  if v_code <> 'ALLOWED' then
    update public.flight_search_usage_events
       set outcome = case v_code
             when 'USER_SEARCH_DISABLED' then 'user_disabled'
             when 'USER_DAILY_LIMIT_REACHED' then 'user_daily_limit'
             else 'supplier_daily_limit'
           end,
           http_status = case when v_code = 'USER_SEARCH_DISABLED' then 403
                              when v_code = 'USER_DAILY_LIMIT_REACHED' then 429
                              else 503 end,
           error_code = v_code,
           completed_at = clock_timestamp()
     where id = p_event_id;
    return query select false, v_code, v_supplier_count, v_supplier_limit,
      v_user_count, v_user_limit;
    return;
  end if;

  update public.flight_search_daily_counters
     set hit_count = hit_count + 1,
         updated_at = clock_timestamp()
   where scope_type = 'supplier' and scope_key = p_supplier and usage_date = v_today;
  v_supplier_count := v_supplier_count + 1;

  if p_user_id is not null then
    update public.flight_search_daily_counters
       set hit_count = hit_count + 1,
           updated_at = clock_timestamp()
     where scope_type = 'user' and scope_key = p_user_id and usage_date = v_today;
    v_user_count := v_user_count + 1;
  end if;

  update public.flight_search_usage_events
     set supplier_api_hit = true,
         outcome = 'supplier_called'
   where id = p_event_id;

  return query select true, 'ALLOWED'::text, v_supplier_count, v_supplier_limit,
    v_user_count, v_user_limit;
end;
$$;

-- Direct Triplover holds use the same bounded read-only PNR refresh workflow.
create or replace function public.enqueue_booking_pnr_refresh_job_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_carrier_group text;
begin
  if new.legacy_operational
     or lower(coalesce(new.supplier, '')) <> 'triplover'
     or new.status <> 'on-hold'
     or new.direct_ticketing
     or new.import_source is not null
     or coalesce(new.supplier_account, '') not in ('firsttrip', 'takeoff', 'triplover')
     or nullif(btrim(coalesce(new.pnr, '')), '') is null
     or nullif(btrim(coalesce(new.booking_code_ref, '')), '') is null
     or nullif(btrim(new.supplier_refs->>'uniqueTransId'), '') is null
     or nullif(btrim(new.supplier_refs->>'itemCodeRef'), '') is null
     or nullif(btrim(new.supplier_refs->>'priceCodeRef'), '') is null then
    return new;
  end if;

  v_carrier_group := case upper(btrim(coalesce(new.itinerary->>'carrierCode', '')))
    when 'BS' then 'bs_immediate'
    else 'non_bs_delayed'
  end;
  insert into public.booking_pnr_refresh_jobs (
    booking_id, carrier_group, next_attempt_at
  ) values (
    new.id,
    v_carrier_group,
    public.booking_pnr_refresh_initial_due_at_v1(v_carrier_group, new.created_at)
  ) on conflict (booking_id) do nothing;
  return new;
end;
$$;

create or replace function public.claim_due_booking_pnr_refresh_job_v1(
  p_worker_id text
)
returns table (
  job_id uuid,
  booking_id uuid,
  supplier_account text,
  supplier_refs jsonb,
  pnr text,
  booking_ref_number text,
  booking_code_ref text,
  carrier_code text,
  deadline_not_before timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(btrim(p_worker_id), '') is null or char_length(p_worker_id) > 255 then
    raise exception 'PNR refresh worker identity is required' using errcode = '22023';
  end if;

  update public.booking_pnr_refresh_jobs
     set state = 'pending', claimed_at = null, claimed_by = null,
         last_error_code = coalesce(last_error_code, 'WORKER_LEASE_EXPIRED')
   where state = 'running'
     and claimed_at < clock_timestamp() - interval '3 minutes';

  update public.booking_pnr_refresh_jobs job
     set state = 'skipped', completed_at = clock_timestamp(),
         completion_reason = 'booking_not_refreshable',
         claimed_at = null, claimed_by = null
    from public.flight_bookings booking
   where booking.id = job.booking_id
     and job.state = 'pending'
     and job.next_attempt_at <= clock_timestamp()
     and (
       booking.legacy_operational
       or lower(coalesce(booking.supplier, '')) <> 'triplover'
       or booking.status <> 'on-hold'
       or booking.operation_kind is not null
       or booking.import_source is not null
       or coalesce(booking.supplier_account, '') not in ('firsttrip', 'takeoff', 'triplover')
       or nullif(btrim(coalesce(booking.pnr, '')), '') is null
       or nullif(btrim(coalesce(booking.booking_code_ref, '')), '') is null
       or nullif(btrim(booking.supplier_refs->>'uniqueTransId'), '') is null
       or nullif(btrim(booking.supplier_refs->>'itemCodeRef'), '') is null
       or nullif(btrim(booking.supplier_refs->>'priceCodeRef'), '') is null
     );

  return query
  with candidate as (
    select job.id
      from public.booking_pnr_refresh_jobs job
      join public.flight_bookings booking on booking.id = job.booking_id
     where job.state = 'pending'
       and job.next_attempt_at <= clock_timestamp()
       and not booking.legacy_operational
       and lower(coalesce(booking.supplier, '')) = 'triplover'
       and booking.status = 'on-hold'
       and booking.operation_kind is null
       and booking.import_source is null
       and booking.supplier_account in ('firsttrip', 'takeoff', 'triplover')
     order by job.next_attempt_at, job.id
     limit 1
     for update of job skip locked
  ), claimed as (
    update public.booking_pnr_refresh_jobs job
       set state = 'running', claimed_at = clock_timestamp(), claimed_by = p_worker_id
      from candidate
     where job.id = candidate.id
    returning job.id, job.booking_id
  )
  select
    claimed.id,
    booking.id,
    booking.supplier_account,
    booking.supplier_refs,
    booking.pnr,
    booking.booking_ref_number,
    booking.booking_code_ref,
    booking.itinerary->>'carrierCode',
    coalesce(booking.submission_started_at, booking.created_at)
  from claimed
  join public.flight_bookings booking on booking.id = claimed.booking_id;
end;
$$;

comment on table public.supplier_operational_settings is
  'Singleton Super Admin control for the active FirstTrip, TakeOff, or direct Triplover credential account and booking/ticketing gates.';
