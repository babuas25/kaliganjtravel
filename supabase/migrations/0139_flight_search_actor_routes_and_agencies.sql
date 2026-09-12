-- Add agency-first identity and searched-route summaries to the Super Admin
-- flight-search report without changing the immutable v1 reporting contract.

create or replace function public.flight_search_usage_by_actor_v2(
  p_from timestamptz,
  p_to timestamptz
)
returns table (
  user_id text,
  display_name text,
  email text,
  role text,
  agency_code text,
  agency_name text,
  searched_routes jsonb,
  distinct_route_count bigint,
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
  ), event_routes as (
    select
      event.id,
      event.actor_user_id,
      string_agg(
        upper(segment.value ->> 'origin') || ' → ' ||
          upper(segment.value ->> 'destination'),
        ' / ' order by segment.ordinality
      ) as route_label
    from public.flight_search_usage_events event
    cross join lateral jsonb_array_elements(event.routes)
      with ordinality as segment(value, ordinality)
    where event.created_at >= p_from and event.created_at < p_to
      and nullif(trim(segment.value ->> 'origin'), '') is not null
      and nullif(trim(segment.value ->> 'destination'), '') is not null
    group by event.id, event.actor_user_id
  ), route_counts as (
    select
      event_routes.actor_user_id,
      event_routes.route_label,
      count(*)::bigint as request_count
    from event_routes
    group by event_routes.actor_user_id, event_routes.route_label
  ), ranked_routes as (
    select
      route_counts.*,
      row_number() over (
        partition by route_counts.actor_user_id
        order by route_counts.request_count desc, route_counts.route_label
      ) as route_rank,
      count(*) over (partition by route_counts.actor_user_id)::bigint
        as distinct_route_count
    from route_counts
  ), route_summary as (
    select
      ranked_routes.actor_user_id,
      jsonb_agg(
        jsonb_build_object(
          'route', ranked_routes.route_label,
          'requestCount', ranked_routes.request_count
        ) order by ranked_routes.request_count desc, ranked_routes.route_label
      ) filter (where ranked_routes.route_rank <= 50) as searched_routes,
      max(ranked_routes.distinct_route_count)::bigint as distinct_route_count
    from ranked_routes
    group by ranked_routes.actor_user_id
  ), rows as (
    select
      usr.clerk_id as user_id,
      nullif(trim(concat_ws(' ', usr.first_name, usr.last_name)), '') as display_name,
      usr.email,
      usr.role,
      usr.agency_code,
      case when usr.role in ('b2b', 'b2b_sub') then
        nullif(trim(agency_profile.agency_name), '')
      else null end as agency_name,
      coalesce(route_summary.searched_routes, '[]'::jsonb) as searched_routes,
      coalesce(route_summary.distinct_route_count, 0)::bigint as distinct_route_count,
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
    left join route_summary on route_summary.actor_user_id = usr.clerk_id
    left join public.agencies agency on agency.agency_code = usr.agency_code
    left join public.user_profiles agency_profile
      on agency_profile.clerk_id = coalesce(
        agency.owner_user_id,
        case when usr.role = 'b2b' then usr.clerk_id else null end
      )
    left join public.flight_search_user_controls control
      on control.user_id = usr.clerk_id
    left join public.flight_search_daily_counters counter
      on counter.scope_type = 'user'
     and counter.scope_key = usr.clerk_id
     and counter.usage_date = timezone('Asia/Dhaka', clock_timestamp())::date
    union all
    select
      null, 'Anonymous visitors', null, 'anonymous', null, null,
      coalesce(route_summary.searched_routes, '[]'::jsonb),
      coalesce(route_summary.distinct_route_count, 0)::bigint,
      usage.request_count, usage.hit_count, usage.success_count,
      usage.failed_count, usage.blocked_count, usage.last_search_at,
      usage.average_total_ms, true, null, 0, 0
    from usage
    left join route_summary on route_summary.actor_user_id is null
    where usage.actor_user_id is null
  )
  select * from rows
  order by request_count desc, last_search_at desc nulls last, user_id;
$$;

revoke all on function public.flight_search_usage_by_actor_v2(
  timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.flight_search_usage_by_actor_v2(
  timestamptz, timestamptz
) to service_role;

comment on function public.flight_search_usage_by_actor_v2(
  timestamptz, timestamptz
) is 'Super Admin actor usage report with agency identity and up to 50 searched routes per actor.';
