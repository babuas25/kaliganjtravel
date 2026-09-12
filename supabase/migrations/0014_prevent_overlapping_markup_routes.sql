-- Prevent route rules whose directionality makes them compete for the same
-- itinerary. Opposite one-way rules are valid; a bidirectional rule conflicts
-- with either one-way direction for the same audience and airline scope.

do $$
begin
  if exists (
    select 1
    from public.markup_rules first_rule
    join public.markup_rules second_rule
      on first_rule.id::text < second_rule.id::text
     and first_rule.audience = second_rule.audience
     and first_rule.agency_code is not distinct from second_rule.agency_code
     and first_rule.airline_code is not distinct from second_rule.airline_code
     and first_rule.origin is not null
     and second_rule.origin is not null
     and (
       (
         first_rule.origin = second_rule.origin and
         first_rule.destination = second_rule.destination
       ) or (
         (first_rule.bidirectional or second_rule.bidirectional) and
         first_rule.origin = second_rule.destination and
         first_rule.destination = second_rule.origin
       )
     )
  ) then
    raise exception
      'Existing markup rules contain overlapping route scopes. Resolve them before applying migration 0014.';
  end if;
end
$$;

create or replace function public.prevent_overlapping_markup_routes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.origin is null then
    return new;
  end if;

  if exists (
    select 1
    from public.markup_rules existing
    where existing.id is distinct from new.id
      and existing.audience = new.audience
      and existing.agency_code is not distinct from new.agency_code
      and existing.airline_code is not distinct from new.airline_code
      and existing.origin is not null
      and (
        (
          existing.origin = new.origin and
          existing.destination = new.destination
        ) or (
          (existing.bidirectional or new.bidirectional) and
          existing.origin = new.destination and
          existing.destination = new.origin
        )
      )
  ) then
    raise exception using
      errcode = '23505',
      constraint = 'markup_rules_route_overlap_check',
      message =
        'A markup rule already overlaps this audience, airline, and route.';
  end if;

  return new;
end
$$;

drop trigger if exists markup_rules_prevent_route_overlap
  on public.markup_rules;

create trigger markup_rules_prevent_route_overlap
  before insert or update on public.markup_rules
  for each row execute function public.prevent_overlapping_markup_routes();

comment on function public.prevent_overlapping_markup_routes() is
  'Rejects duplicate or bidirectionally overlapping markup route scopes while allowing opposite one-way rules.';
