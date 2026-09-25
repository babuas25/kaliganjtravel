-- Enable Shapontravels for read-only supplier selection and Search usage accounting.
-- Booking tables deliberately retain their existing Triplover-only supplier checks.

alter table public.supplier_operational_settings
  drop constraint if exists supplier_operational_settings_active_supplier_check;
alter table public.supplier_operational_settings
  add constraint supplier_operational_settings_active_supplier_check
  check (active_supplier in ('firsttrip', 'takeoff', 'triplover', 'shapontravels'));

alter table public.flight_search_supplier_limits
  drop constraint if exists flight_search_supplier_limits_supplier_check;
alter table public.flight_search_supplier_limits
  add constraint flight_search_supplier_limits_supplier_check
  check (supplier in ('firsttrip', 'takeoff', 'triplover', 'shapontravels'));

insert into public.flight_search_supplier_limits (supplier, daily_limit)
values ('shapontravels', null)
on conflict (supplier) do nothing;

alter table public.flight_search_usage_events
  drop constraint if exists flight_search_usage_events_supplier_account_check;
alter table public.flight_search_usage_events
  add constraint flight_search_usage_events_supplier_account_check
  check (supplier_account in ('firsttrip', 'takeoff', 'triplover', 'shapontravels'));

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
  if p_supplier not in ('firsttrip', 'takeoff', 'triplover', 'shapontravels') then
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
