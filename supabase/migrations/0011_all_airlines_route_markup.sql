-- Extend all-airlines markup from the global fallback to optional route
-- coverage. The existing route-pair constraint still requires both airport
-- codes and prevents identical origins and destinations.

alter table public.markup_rules
  drop constraint if exists markup_rules_airline_scope_check;

-- Above-gross LCC exceptions remain tied to a named airline. Normal capped
-- markup may target every airline globally or on a specific route.
alter table public.markup_rules
  add constraint markup_rules_airline_scope_check check (
    airline_code is not null or lcc_service_margin = false
  );

comment on column public.markup_rules.airline_code is
  'Two-character airline code, or NULL to target every airline globally or on a specific route.';
