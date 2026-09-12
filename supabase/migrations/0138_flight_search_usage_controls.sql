-- Super Admin flight-search usage reporting and atomic daily API budgets.
--
-- `flight_search_history` is intentionally unsuitable for billing/usage: it
-- deduplicates repeated searches and records successful signed-in searches
-- only. This ledger stores one row for every validated request that reaches
-- the application controls, while `supplier_api_hit` distinguishes a website
-- request from an outbound supplier Search attempt.

create table if not exists public.flight_search_supplier_limits (
  supplier text primary key check (supplier in ('firsttrip', 'takeoff')),
  daily_limit integer check (daily_limit is null or daily_limit between 0 and 1000000),
  version integer not null default 1 check (version > 0),
  updated_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.flight_search_supplier_limits (supplier, daily_limit)
values ('firsttrip', null), ('takeoff', null)
on conflict (supplier) do nothing;

create table if not exists public.flight_search_user_controls (
  user_id text primary key references public.app_users (clerk_id) on delete cascade,
  search_enabled boolean not null default true,
  daily_limit integer check (daily_limit is null or daily_limit between 1 and 1000000),
  version integer not null default 1 check (version > 0),
  updated_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.flight_search_daily_counters (
  scope_type text not null check (scope_type in ('supplier', 'user')),
  scope_key text not null check (char_length(scope_key) between 1 and 255),
  usage_date date not null,
  hit_count integer not null default 0 check (hit_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (scope_type, scope_key, usage_date)
);

create table if not exists public.flight_search_usage_events (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null unique,
  actor_user_id text references public.app_users (clerk_id) on delete set null,
  actor_key_hash text not null check (actor_key_hash ~ '^sha256:[0-9a-f]{64}$'),
  actor_role text,
  agency_code text,
  supplier_account text not null check (supplier_account in ('firsttrip', 'takeoff')),
  request_mode text not null check (request_mode in ('stream', 'json')),
  trip_type text not null check (trip_type in ('oneway', 'round', 'multicity')),
  routes jsonb not null check (jsonb_typeof(routes) = 'array'),
  adults smallint not null check (adults between 1 and 9),
  children smallint not null check (children between 0 and 8),
  infants smallint not null check (infants between 0 and 9),
  cabin_class smallint not null check (cabin_class between 1 and 5),
  outcome text not null default 'received' check (
    outcome in (
      'received', 'supplier_called', 'success', 'failed', 'rate_limited',
      'busy', 'user_disabled', 'user_daily_limit', 'supplier_daily_limit'
    )
  ),
  supplier_api_hit boolean not null default false,
  http_status smallint check (http_status is null or http_status between 100 and 599),
  error_code text check (error_code is null or char_length(error_code) between 1 and 80),
  itinerary_count integer check (itinerary_count is null or itinerary_count >= 0),
  partial boolean,
  total_ms integer check (total_ms is null or total_ms >= 0),
  supplier_ms integer check (supplier_ms is null or supplier_ms >= 0),
  usage_date date not null default (timezone('Asia/Dhaka', now())::date),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists flight_search_usage_events_created_idx
  on public.flight_search_usage_events (created_at desc, id);
create index if not exists flight_search_usage_events_user_created_idx
  on public.flight_search_usage_events (actor_user_id, created_at desc)
  where actor_user_id is not null;
create index if not exists flight_search_usage_events_supplier_created_idx
  on public.flight_search_usage_events (supplier_account, created_at desc);
create index if not exists flight_search_usage_events_supplier_hit_idx
  on public.flight_search_usage_events (usage_date, supplier_account, created_at desc)
  where supplier_api_hit;

alter table public.flight_search_supplier_limits enable row level security;
alter table public.flight_search_user_controls enable row level security;
alter table public.flight_search_daily_counters enable row level security;
alter table public.flight_search_usage_events enable row level security;

revoke all on table public.flight_search_supplier_limits,
  public.flight_search_user_controls,
  public.flight_search_daily_counters,
  public.flight_search_usage_events from anon, authenticated;
grant select, insert, update, delete on table public.flight_search_supplier_limits,
  public.flight_search_user_controls,
  public.flight_search_daily_counters,
  public.flight_search_usage_events to service_role;

-- Atomically reserves one outbound supplier Search attempt. Locks always use
-- supplier then user order, preventing two concurrent requests from crossing
-- either configured daily ceiling.
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
  if p_supplier not in ('firsttrip', 'takeoff') then
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

revoke all on function public.claim_flight_search_supplier_hit_v1(
  uuid, text, text
) from public, anon, authenticated;
grant execute on function public.claim_flight_search_supplier_hit_v1(
  uuid, text, text
) to service_role;

create or replace function public.flight_search_usage_totals_v1(
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  request_count bigint,
  supplier_api_hit_count bigint,
  success_count bigint,
  failed_count bigint,
  blocked_count bigint,
  anonymous_count bigint,
  unique_user_count bigint,
  average_total_ms numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    count(*)::bigint,
    count(*) filter (where event.supplier_api_hit)::bigint,
    count(*) filter (where event.outcome = 'success')::bigint,
    count(*) filter (where event.outcome = 'failed')::bigint,
    count(*) filter (where event.outcome in (
      'rate_limited', 'busy', 'user_disabled', 'user_daily_limit',
      'supplier_daily_limit'
    ))::bigint,
    count(*) filter (where event.actor_user_id is null)::bigint,
    count(distinct event.actor_user_id)::bigint,
    round(avg(event.total_ms), 2)
  from public.flight_search_usage_events event
  where event.created_at >= p_from and event.created_at < p_to;
$$;

create or replace function public.flight_search_usage_by_actor_v1(
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  user_id text,
  display_name text,
  email text,
  role text,
  agency_code text,
  request_count bigint,
  supplier_api_hit_count bigint,
  success_count bigint,
  failed_count bigint,
  blocked_count bigint,
  last_search_at timestamptz,
  average_total_ms numeric,
  search_enabled boolean,
  daily_limit integer,
  control_version integer,
  today_hit_count integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with usage as (
    select
      event.actor_user_id,
      count(*)::bigint as request_count,
      count(*) filter (where event.supplier_api_hit)::bigint as hit_count,
      count(*) filter (where event.outcome = 'success')::bigint as success_count,
      count(*) filter (where event.outcome = 'failed')::bigint as failed_count,
      count(*) filter (where event.outcome in (
        'rate_limited', 'busy', 'user_disabled', 'user_daily_limit',
        'supplier_daily_limit'
      ))::bigint as blocked_count,
      max(event.created_at) as last_search_at,
      round(avg(event.total_ms), 2) as average_total_ms
    from public.flight_search_usage_events event
    where event.created_at >= p_from and event.created_at < p_to
    group by event.actor_user_id
  ), rows as (
    select
      usr.clerk_id as user_id,
      nullif(trim(concat_ws(' ', usr.first_name, usr.last_name)), '') as display_name,
      usr.email,
      usr.role,
      usr.agency_code,
      coalesce(usage.request_count, 0)::bigint as request_count,
      coalesce(usage.hit_count, 0)::bigint as hit_count,
      coalesce(usage.success_count, 0)::bigint as success_count,
      coalesce(usage.failed_count, 0)::bigint as failed_count,
      coalesce(usage.blocked_count, 0)::bigint as blocked_count,
      usage.last_search_at,
      usage.average_total_ms,
      coalesce(control.search_enabled, true) as search_enabled,
      control.daily_limit,
      coalesce(control.version, 0) as control_version,
      coalesce(counter.hit_count, 0) as today_hit_count
    from public.app_users usr
    left join usage on usage.actor_user_id = usr.clerk_id
    left join public.flight_search_user_controls control
      on control.user_id = usr.clerk_id
    left join public.flight_search_daily_counters counter
      on counter.scope_type = 'user'
     and counter.scope_key = usr.clerk_id
     and counter.usage_date = timezone('Asia/Dhaka', clock_timestamp())::date
    union all
    select
      null, 'Anonymous visitors', null, 'anonymous', null,
      usage.request_count, usage.hit_count, usage.success_count,
      usage.failed_count, usage.blocked_count, usage.last_search_at,
      usage.average_total_ms, true, null, 0, 0
    from usage where usage.actor_user_id is null
  )
  select * from rows
  order by request_count desc, last_search_at desc nulls last, user_id;
$$;

create or replace function public.flight_search_usage_by_supplier_v1(
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  supplier text,
  request_count bigint,
  supplier_api_hit_count bigint,
  success_count bigint,
  failed_count bigint,
  blocked_count bigint,
  last_search_at timestamptz,
  daily_limit integer,
  limit_version integer,
  today_hit_count integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    limits.supplier,
    count(event.id)::bigint,
    count(event.id) filter (where event.supplier_api_hit)::bigint,
    count(event.id) filter (where event.outcome = 'success')::bigint,
    count(event.id) filter (where event.outcome = 'failed')::bigint,
    count(event.id) filter (where event.outcome = 'supplier_daily_limit')::bigint,
    max(event.created_at),
    limits.daily_limit,
    limits.version,
    coalesce(counter.hit_count, 0)
  from public.flight_search_supplier_limits limits
  left join public.flight_search_usage_events event
    on event.supplier_account = limits.supplier
   and event.created_at >= p_from and event.created_at < p_to
  left join public.flight_search_daily_counters counter
    on counter.scope_type = 'supplier'
   and counter.scope_key = limits.supplier
   and counter.usage_date = timezone('Asia/Dhaka', clock_timestamp())::date
  group by limits.supplier, limits.daily_limit, limits.version, counter.hit_count
  order by limits.supplier;
$$;

revoke all on function public.flight_search_usage_totals_v1(
  timestamptz, timestamptz
), public.flight_search_usage_by_actor_v1(
  timestamptz, timestamptz
), public.flight_search_usage_by_supplier_v1(
  timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.flight_search_usage_totals_v1(
  timestamptz, timestamptz
), public.flight_search_usage_by_actor_v1(
  timestamptz, timestamptz
), public.flight_search_usage_by_supplier_v1(
  timestamptz, timestamptz
) to service_role;

comment on table public.flight_search_usage_events is
  'One row per validated flight-search request; supplier_api_hit marks an outbound supplier Search attempt.';
comment on table public.flight_search_daily_counters is
  'Atomic Asia/Dhaka-day counters used to enforce supplier and signed-in-user Search budgets.';
