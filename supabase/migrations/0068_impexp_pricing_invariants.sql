-- Imported commercial truth has two intentionally independent amounts:
-- Supplier Gross may be refreshed from supplier evidence, while User Payable
-- and its currency are fixed at import and are the only permitted booking
-- capture amount. Enforce that split at every persistence boundary.

create or replace function public.impexp_pricing_minor_amount_v1(
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
     or jsonb_typeof(p_pricing->p_key) <> 'number' then
    return null;
  end if;
  v_text := p_pricing->>p_key;
  if v_text !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$' then
    return null;
  end if;
  v_minor := v_text::numeric * 100;
  if v_minor <> trunc(v_minor)
     or v_minor > 9223372036854775807::numeric then
    return null;
  end if;
  return v_minor::bigint;
end;
$$;

alter table public.flight_bookings
  add constraint flight_bookings_impexp_pricing_truth_check
  check (
    import_source is distinct from 'IMP_EXP'
    or (
      user_payable_amount is not null
      and user_payable_amount > 0
      and supplier_gross_amount is not null
      and supplier_gross_amount >= 0
      and public.impexp_pricing_minor_amount_v1(
        pricing_snapshot, 'sellingPrice'
      ) = user_payable_amount
      and public.impexp_pricing_minor_amount_v1(
        pricing_snapshot, 'supplierTotalPrice'
      ) = supplier_gross_amount
      and public.impexp_pricing_minor_amount_v1(
        pricing_snapshot, 'grossPrice'
      ) = supplier_gross_amount
      and (payment_amount is null or payment_amount = user_payable_amount)
      and captured_amount is not null
      and captured_amount in (0, user_payable_amount)
      and refunded_amount is not null
      and refunded_amount between 0 and captured_amount
    )
  ) not valid;

create or replace function public.enforce_impexp_booking_pricing_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' then
    if old.import_source = 'IMP_EXP' then
      if new.import_source is distinct from old.import_source then
        raise exception 'imported booking source is immutable'
          using errcode = '23514',
            constraint = 'flight_bookings_impexp_import_source_immutable';
      end if;
      if new.user_payable_amount is distinct from old.user_payable_amount then
        raise exception 'imported User Payable is immutable'
          using errcode = '23514',
            constraint = 'flight_bookings_impexp_user_payable_immutable';
      end if;
      if new.currency is distinct from old.currency then
        raise exception 'imported User Payable currency is immutable'
          using errcode = '23514',
            constraint = 'flight_bookings_impexp_currency_immutable';
      end if;
    end if;
  end if;

  if new.import_source is distinct from 'IMP_EXP' then
    return new;
  end if;
  if new.user_payable_amount is null or new.user_payable_amount <= 0
     or new.supplier_gross_amount is null or new.supplier_gross_amount < 0
     or public.impexp_pricing_minor_amount_v1(
          new.pricing_snapshot, 'sellingPrice'
        ) is distinct from new.user_payable_amount
     or public.impexp_pricing_minor_amount_v1(
          new.pricing_snapshot, 'supplierTotalPrice'
        ) is distinct from new.supplier_gross_amount
     or public.impexp_pricing_minor_amount_v1(
          new.pricing_snapshot, 'grossPrice'
        ) is distinct from new.supplier_gross_amount
     or (new.payment_amount is not null
       and new.payment_amount is distinct from new.user_payable_amount)
     or new.captured_amount is null
     or new.captured_amount not in (0, new.user_payable_amount)
     or new.refunded_amount is null
     or new.refunded_amount < 0
     or new.refunded_amount > new.captured_amount then
    raise exception 'imported Supplier Gross/User Payable invariant failed'
      using errcode = '23514',
        constraint = 'flight_bookings_impexp_pricing_truth_check';
  end if;
  return new;
end;
$$;

drop trigger if exists flight_bookings_enforce_impexp_pricing
  on public.flight_bookings;
create trigger flight_bookings_enforce_impexp_pricing
  before insert or update of
    import_source, currency, pricing_snapshot, supplier_gross_amount,
    user_payable_amount, payment_state, payment_amount, captured_amount,
    refunded_amount
  on public.flight_bookings
  for each row execute function public.enforce_impexp_booking_pricing_v1();

create or replace function public.enforce_impexp_reservation_amount_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
begin
  if new.booking_id is null then
    return new;
  end if;
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = new.booking_id;
  if found and v_booking.import_source = 'IMP_EXP'
     and (new.amount is distinct from v_booking.user_payable_amount
       or upper(new.currency) is distinct from upper(v_booking.currency)) then
    raise exception 'imported reservation must equal protected User Payable'
      using errcode = '23514',
        constraint = 'wallet_reservations_impexp_user_payable_check';
  end if;
  return new;
end;
$$;

drop trigger if exists wallet_reservations_enforce_impexp_amount
  on public.wallet_reservations;
create trigger wallet_reservations_enforce_impexp_amount
  before insert or update of booking_id, amount, currency
  on public.wallet_reservations
  for each row execute function public.enforce_impexp_reservation_amount_v1();

create or replace function public.enforce_impexp_capture_ledger_amount_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
begin
  if new.booking_id is null or new.transaction_type <> 'booking_confirm' then
    return new;
  end if;
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = new.booking_id;
  if found and v_booking.import_source = 'IMP_EXP'
     and (new.amount is distinct from v_booking.user_payable_amount
       or upper(new.currency) is distinct from upper(v_booking.currency)
       or new.metadata->>'userPayableAmount'
          is distinct from v_booking.user_payable_amount::text
       or new.metadata->>'supplierGrossAmount'
          is distinct from v_booking.supplier_gross_amount::text) then
    raise exception 'imported capture ledger must equal protected User Payable'
      using errcode = '23514',
        constraint = 'wallet_ledger_entries_impexp_user_payable_check';
  end if;
  return new;
end;
$$;

drop trigger if exists wallet_ledger_enforce_impexp_capture_amount
  on public.wallet_ledger_entries;
create trigger wallet_ledger_enforce_impexp_capture_amount
  before insert on public.wallet_ledger_entries
  for each row execute function public.enforce_impexp_capture_ledger_amount_v1();

revoke all on function public.impexp_pricing_minor_amount_v1(jsonb, text)
  from public, anon, authenticated;
grant execute on function public.impexp_pricing_minor_amount_v1(jsonb, text)
  to service_role;
revoke all on function public.enforce_impexp_booking_pricing_v1()
  from public, anon, authenticated;
revoke all on function public.enforce_impexp_reservation_amount_v1()
  from public, anon, authenticated;
revoke all on function public.enforce_impexp_capture_ledger_amount_v1()
  from public, anon, authenticated;

comment on constraint flight_bookings_impexp_pricing_truth_check
  on public.flight_bookings is
  'New or updated IMP_EXP rows keep Supplier Gross in supplier pricing fields, keep protected User Payable in selling/payment/capture fields, and never conflate the two.';
comment on function public.enforce_impexp_booking_pricing_v1() is
  'Makes imported User Payable and currency immutable while allowing a synchronized Supplier Gross only when its pricing snapshot changes consistently.';
comment on function public.enforce_impexp_reservation_amount_v1() is
  'Rejects imported booking reservations whose amount/currency differ from protected User Payable.';
comment on function public.enforce_impexp_capture_ledger_amount_v1() is
  'Rejects imported booking-confirm ledger debits or metadata that substitute Supplier Gross for protected User Payable.';
