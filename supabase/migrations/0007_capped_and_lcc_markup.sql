-- Gross-capped normal markup plus an explicit LCC service-margin exception.
--
-- A normal rule can never spend more than the supplier-to-gross margin.
-- `lcc_service_margin = true` is the deliberate, auditable exception that may
-- add a fixed or base-percentage service margin above gross.

alter table public.markup_rules
  add column if not exists lcc_service_margin boolean not null default false;

alter table public.markup_rules
  drop constraint if exists markup_rules_markup_type_check;

alter table public.markup_rules
  add constraint markup_rules_markup_type_check check (
    markup_type in ('fixed', 'percentage', 'margin_share')
  );

alter table public.markup_rules
  drop constraint if exists markup_rules_value_check;

alter table public.markup_rules
  add constraint markup_rules_value_check check (
    (markup_type = 'percentage' and value > 0 and value <= 100) or
    (markup_type = 'fixed' and value > 0 and value <= 1000000) or
    (markup_type = 'margin_share' and value >= 0 and value <= 100)
  );

alter table public.markup_rules
  drop constraint if exists markup_rules_lcc_mode_check;

alter table public.markup_rules
  add constraint markup_rules_lcc_mode_check check (
    lcc_service_margin = false or markup_type in ('fixed', 'percentage')
  );

comment on column public.markup_rules.lcc_service_margin is
  'Explicit LCC-only exception: add this rule above gross as a visible service margin.';
