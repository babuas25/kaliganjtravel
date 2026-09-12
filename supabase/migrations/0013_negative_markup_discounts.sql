-- Permit Super Admins to configure bounded discounts with negative fixed or
-- base-percentage values. Margin share remains a 0–100% selector, and the
-- explicit LCC above-gross exception remains positive-only.

alter table public.markup_rules
  drop constraint if exists markup_rules_value_check;

alter table public.markup_rules
  add constraint markup_rules_value_check check (
    (
      markup_type = 'percentage' and
      value <> 0 and
      value >= -100 and
      value <= 100
    ) or
    (
      markup_type = 'fixed' and
      value <> 0 and
      value >= -1000000 and
      value <= 1000000
    ) or
    (
      markup_type = 'margin_share' and
      value >= 0 and
      value <= 100
    )
  );

alter table public.markup_rules
  drop constraint if exists markup_rules_lcc_mode_check;

alter table public.markup_rules
  add constraint markup_rules_lcc_mode_check check (
    lcc_service_margin = false or (
      markup_type in ('fixed', 'percentage') and
      value > 0
    )
  );

comment on column public.markup_rules.value is
  'Positive markup or negative discount for fixed/percentage rules; 0–100 for margin share.';
