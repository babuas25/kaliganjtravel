-- Private per-user flight-search history with an anonymized popular-search
-- fallback for the dashboard. Only the service-role server can read or write
-- the underlying rows; browsers never query this table directly.

create table if not exists public.flight_search_history (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references public.app_users (clerk_id) on delete cascade,

  -- Exact validated request fingerprint. Repeating the same search moves its
  -- existing row to the front instead of filling the list with duplicates.
  search_key text not null check (search_key ~ '^[0-9a-f]{64}$'),
  -- Route/trip/cabin fingerprint used only for anonymous aggregation. Dates
  -- and passenger details are deliberately absent from this grouping key.
  popularity_key text not null check (popularity_key ~ '^[0-9a-f]{64}$'),

  trip_type text not null check (trip_type in ('oneway', 'round', 'multicity')),
  routes jsonb not null
    check (jsonb_typeof(routes) = 'array' and jsonb_array_length(routes) between 1 and 6),
  first_departure_date date not null,
  adults smallint not null check (adults between 1 and 9),
  children smallint not null check (children between 0 and 8),
  infants smallint not null check (infants between 0 and 9),
  children_ages jsonb not null default '[]'::jsonb
    check (jsonb_typeof(children_ages) = 'array'),
  cabin_class smallint not null check (cabin_class between 1 and 5),
  preferred_carriers jsonb not null default '[]'::jsonb
    check (jsonb_typeof(preferred_carriers) = 'array'),
  searched_at timestamptz not null default now(),

  constraint flight_search_history_user_search_key unique (user_id, search_key)
);

create index if not exists flight_search_history_user_recent_idx
  on public.flight_search_history (user_id, searched_at desc);
create index if not exists flight_search_history_popular_idx
  on public.flight_search_history
  (first_departure_date, popularity_key, searched_at desc);
create index if not exists flight_search_history_searched_at_idx
  on public.flight_search_history (searched_at);

alter table public.flight_search_history enable row level security;
revoke all on table public.flight_search_history from anon, authenticated;
grant select, insert, update, delete on table public.flight_search_history
  to service_role;

-- Returns one recent representative for each popular route/trip/cabin group.
-- A group must have searches from multiple distinct users before it can leave
-- the database, preventing an individual's search from becoming a "popular"
-- recommendation by itself. No user id is part of the result contract.
create or replace function public.popular_flight_searches_v1(
  p_since timestamptz,
  p_today date,
  p_limit integer default 5,
  p_min_distinct_users integer default 2
)
returns table (
  id uuid,
  trip_type text,
  routes jsonb,
  first_departure_date date,
  adults smallint,
  children smallint,
  infants smallint,
  cabin_class smallint,
  searched_at timestamptz,
  search_count bigint,
  distinct_user_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with eligible as (
    select h.*
    from public.flight_search_history h
    where h.searched_at >= p_since
      and h.first_departure_date >= p_today
  ),
  grouped as (
    select
      e.popularity_key,
      count(*)::bigint as search_count,
      count(distinct e.user_id)::bigint as distinct_user_count,
      max(e.searched_at) as latest_search_at
    from eligible e
    group by e.popularity_key
    having count(distinct e.user_id) >= greatest(p_min_distinct_users, 2)
  ),
  representatives as (
    select distinct on (e.popularity_key)
      e.popularity_key,
      e.id,
      e.trip_type,
      e.routes,
      e.first_departure_date,
      e.adults,
      e.children,
      e.infants,
      e.cabin_class,
      e.searched_at
    from eligible e
    join grouped g on g.popularity_key = e.popularity_key
    order by e.popularity_key, e.searched_at desc, e.id
  )
  select
    r.id,
    r.trip_type,
    r.routes,
    r.first_departure_date,
    r.adults,
    r.children,
    r.infants,
    r.cabin_class,
    r.searched_at,
    g.search_count,
    g.distinct_user_count
  from representatives r
  join grouped g on g.popularity_key = r.popularity_key
  order by
    g.distinct_user_count desc,
    g.search_count desc,
    g.latest_search_at desc
  limit least(greatest(p_limit, 1), 10);
$$;

revoke execute on function public.popular_flight_searches_v1(
  timestamptz, date, integer, integer
) from public, anon, authenticated;
grant execute on function public.popular_flight_searches_v1(
  timestamptz, date, integer, integer
) to service_role;

comment on table public.flight_search_history is
  'Validated successful flight searches for private recent-history and anonymous multi-user popularity.';
comment on function public.popular_flight_searches_v1(
  timestamptz, date, integer, integer
) is
  'Anonymized popular future searches; returns only groups searched by at least two distinct users.';
