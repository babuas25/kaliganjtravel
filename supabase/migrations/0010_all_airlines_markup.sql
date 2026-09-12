-- Allow a markup rule to act as the audience-wide fallback for every airline.
-- Existing airline and route rules remain unchanged and take precedence in
-- application code.

alter table public.markup_rules
  alter column airline_code drop not null;

alter table public.markup_rules
  drop constraint if exists markup_rules_airline_code_check;

alter table public.markup_rules
  add constraint markup_rules_airline_code_check check (
    airline_code is null or airline_code ~ '^[A-Z0-9]{2}$'
  );

-- A route exception must still name the airline it belongs to. A null airline
-- is deliberately limited to the all-airlines, all-routes fallback.
alter table public.markup_rules
  drop constraint if exists markup_rules_airline_scope_check;

alter table public.markup_rules
  add constraint markup_rules_airline_scope_check check (
    airline_code is not null or (
      origin is null and
      destination is null and
      bidirectional = false and
      lcc_service_margin = false
    )
  );

-- Include the nullable airline target in uniqueness. Without COALESCE,
-- PostgreSQL would allow several identical global rules because NULL values
-- are distinct in a conventional unique index.
drop index if exists public.markup_rules_scope_unique_idx;

create unique index markup_rules_scope_unique_idx
  on public.markup_rules (
    audience,
    coalesce(agency_code, ''),
    coalesce(airline_code, ''),
    coalesce(origin, ''),
    coalesce(destination, ''),
    bidirectional
  );

comment on column public.markup_rules.airline_code is
  'Two-character airline code, or NULL for an all-airlines and all-routes fallback.';
