-- Manual imports persist amounts in minor units, but PostgreSQL numeric division
-- can retain more than two trailing decimal places in the JSON pricing snapshot.
-- The shared IMP/EXP helper deliberately rejects that representation. Manual
-- bookings need the same cent-precision rule without rejecting harmless scale.

create or replace function public.manual_pricing_minor_amount_v1(
  p_pricing jsonb,
  p_key text
)
returns bigint
language plpgsql
immutable
set search_path = public
as $$
declare
  v_text text;
  v_minor numeric;
begin
  if p_pricing is null
     or jsonb_typeof(p_pricing) <> 'object'
     or nullif(btrim(coalesce(p_key, '')), '') is null
     or jsonb_typeof(p_pricing -> p_key) <> 'number' then
    return null;
  end if;

  v_text := p_pricing ->> p_key;
  begin
    v_minor := v_text::numeric * 100;
  exception when others then
    return null;
  end;

  if v_minor < 0
     or v_minor <> trunc(v_minor)
     or v_minor > 9223372036854775807::numeric then
    return null;
  end if;

  return v_minor::bigint;
end;
$$;

alter table public.flight_bookings
  drop constraint if exists flight_bookings_manual_pricing_truth_check;

alter table public.flight_bookings
  add constraint flight_bookings_manual_pricing_truth_check
  check (
    import_source is distinct from 'MANUAL'
    or (
      user_payable_amount is not null and user_payable_amount > 0
      and supplier_gross_amount is not null and supplier_gross_amount >= 0
      and public.manual_pricing_minor_amount_v1(pricing_snapshot, 'sellingPrice') = user_payable_amount
      and public.manual_pricing_minor_amount_v1(pricing_snapshot, 'supplierTotalPrice') = supplier_gross_amount
      and public.manual_pricing_minor_amount_v1(pricing_snapshot, 'grossPrice') = supplier_gross_amount
      and (payment_amount is null or payment_amount = user_payable_amount)
      and captured_amount in (0, user_payable_amount)
      and refunded_amount between 0 and captured_amount
    )
  ) not valid;

create or replace function public.enforce_manual_booking_invariants_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.import_source = 'MANUAL' then
    if new.import_source is distinct from old.import_source then
      raise exception 'manual booking source is immutable'
        using errcode = '23514', constraint = 'flight_bookings_manual_source_immutable';
    end if;
    if new.user_payable_amount is distinct from old.user_payable_amount
       or new.currency is distinct from old.currency then
      raise exception 'manual User Payable and currency are immutable'
        using errcode = '23514', constraint = 'flight_bookings_manual_payable_immutable';
    end if;
  end if;

  if new.import_source is distinct from 'MANUAL' then
    return new;
  end if;

  if new.user_payable_amount is null or new.user_payable_amount <= 0
     or new.supplier_gross_amount is null or new.supplier_gross_amount < 0
     or public.manual_pricing_minor_amount_v1(new.pricing_snapshot, 'sellingPrice') is distinct from new.user_payable_amount
     or public.manual_pricing_minor_amount_v1(new.pricing_snapshot, 'supplierTotalPrice') is distinct from new.supplier_gross_amount
     or public.manual_pricing_minor_amount_v1(new.pricing_snapshot, 'grossPrice') is distinct from new.supplier_gross_amount
     or (new.payment_amount is not null and new.payment_amount is distinct from new.user_payable_amount)
     or new.captured_amount not in (0, new.user_payable_amount)
     or new.refunded_amount < 0 or new.refunded_amount > new.captured_amount then
    raise exception 'manual Supplier Gross/User Payable invariant failed'
      using errcode = '23514', constraint = 'flight_bookings_manual_pricing_truth_check';
  end if;

  return new;
end;
$$;

revoke all on function public.manual_pricing_minor_amount_v1(jsonb, text)
  from public, anon, authenticated;
grant execute on function public.manual_pricing_minor_amount_v1(jsonb, text)
  to service_role;

comment on function public.manual_pricing_minor_amount_v1(jsonb, text) is
  'Manual booking pricing accepts numerically exact minor-unit values regardless of harmless PostgreSQL decimal scale.';
