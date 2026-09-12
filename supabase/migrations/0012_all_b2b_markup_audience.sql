-- Add an all-B2B audience for rules shared by every agency and its sub-users.
-- Agency-specific rules remain separate and take precedence in application
-- code when both audiences match.

alter table public.markup_rules
  drop constraint if exists markup_rules_audience_check;

alter table public.markup_rules
  add constraint markup_rules_audience_check check (
    audience in ('b2c', 'b2b', 'agency')
  );

alter table public.markup_rules
  drop constraint if exists markup_rules_audience_target_check;

alter table public.markup_rules
  add constraint markup_rules_audience_target_check check (
    (audience in ('b2c', 'b2b') and agency_code is null) or
    (audience = 'agency' and agency_code is not null)
  );

comment on column public.markup_rules.audience is
  'b2c for public customers, b2b for every agency and sub-user, or agency for one named agency.';
