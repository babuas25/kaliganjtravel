-- Shopon Travels International — Super Admin fare-markup rules.
-- Applied with `supabase db push --linked` (project gvbovgdjqmskcjgowppa).
--
-- Rules are private commercial data. Browsers never query this table: RLS is
-- enabled with no policies and only the server-side service-role client reads
-- or writes it.

create table if not exists public.markup_rules (
  id              uuid primary key default gen_random_uuid(),
  audience        text not null
                  check (audience in ('b2c', 'agency')),
  agency_code     text
                  references public.agencies (agency_code) on delete cascade,
  airline_code    text not null
                  check (airline_code ~ '^[A-Z0-9]{2}$'),
  origin          text
                  check (origin is null or origin ~ '^[A-Z]{3}$'),
  destination     text
                  check (destination is null or destination ~ '^[A-Z]{3}$'),
  bidirectional   boolean not null default false,
  markup_type     text not null
                  check (markup_type in ('fixed', 'percentage')),
  value           numeric(12, 2) not null,
  active          boolean not null default true,
  created_by      text
                  references public.app_users (clerk_id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- B2C rules never name an agency; agency rules always do.
  constraint markup_rules_audience_target_check check (
    (audience = 'b2c' and agency_code is null) or
    (audience = 'agency' and agency_code is not null)
  ),

  -- Airline-only rules leave both route fields empty. Route rules need both.
  constraint markup_rules_route_pair_check check (
    (origin is null and destination is null and bidirectional = false) or
    (origin is not null and destination is not null and origin <> destination)
  ),

  -- A percentage is intentionally capped; a fixed amount is bounded against
  -- accidental extra zeroes while remaining well above a plausible fare.
  constraint markup_rules_value_check check (
    (markup_type = 'percentage' and value > 0 and value <= 100) or
    (markup_type = 'fixed' and value > 0 and value <= 1000000)
  )
);

drop trigger if exists markup_rules_touch_updated_at on public.markup_rules;
create trigger markup_rules_touch_updated_at
  before update on public.markup_rules
  for each row execute function public.touch_updated_at();

-- PostgreSQL treats NULLs as distinct in ordinary unique indexes. Coalescing
-- the nullable target fields makes "B2C + BG" or "Agent X + BG + DAC→CXB"
-- genuinely unique, so two active-looking rows cannot compete silently.
create unique index if not exists markup_rules_scope_unique_idx
  on public.markup_rules (
    audience,
    coalesce(agency_code, ''),
    airline_code,
    coalesce(origin, ''),
    coalesce(destination, ''),
    bidirectional
  );

create index if not exists markup_rules_lookup_idx
  on public.markup_rules (audience, agency_code, airline_code, active);

alter table public.markup_rules enable row level security;
