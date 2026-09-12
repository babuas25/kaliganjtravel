-- Manual imports now retain three separate commercial values:
-- gross amount, supplier payable, and the wallet-captured user payable.
-- Supplier payable is stored in the existing pricing snapshot, which is the
-- source used by the booking list and profit reports.

alter table public.flight_bookings
  drop constraint if exists flight_bookings_manual_pricing_truth_check;

alter table public.flight_bookings
  add constraint flight_bookings_manual_pricing_truth_check
  check (
    import_source is distinct from 'MANUAL'
    or (
      user_payable_amount is not null
      and user_payable_amount > 0
      and supplier_gross_amount is not null
      and supplier_gross_amount >= 0
      and public.manual_pricing_minor_amount_v1(pricing_snapshot, 'sellingPrice')
        = user_payable_amount
      and public.manual_pricing_minor_amount_v1(pricing_snapshot, 'grossPrice')
        = supplier_gross_amount
      and public.manual_pricing_minor_amount_v1(pricing_snapshot, 'supplierTotalPrice')
        is not null
      and public.manual_pricing_minor_amount_v1(pricing_snapshot, 'supplierTotalPrice')
        >= 0
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
     or public.manual_pricing_minor_amount_v1(new.pricing_snapshot, 'sellingPrice')
          is distinct from new.user_payable_amount
     or public.manual_pricing_minor_amount_v1(new.pricing_snapshot, 'grossPrice')
          is distinct from new.supplier_gross_amount
     or public.manual_pricing_minor_amount_v1(new.pricing_snapshot, 'supplierTotalPrice')
          is null
     or public.manual_pricing_minor_amount_v1(new.pricing_snapshot, 'supplierTotalPrice') < 0
     or (new.payment_amount is not null
       and new.payment_amount is distinct from new.user_payable_amount)
     or new.captured_amount not in (0, new.user_payable_amount)
     or new.refunded_amount < 0 or new.refunded_amount > new.captured_amount then
    raise exception 'manual Gross/Supplier Payable/User Payable invariant failed'
      using errcode = '23514', constraint = 'flight_bookings_manual_pricing_truth_check';
  end if;

  return new;
end;
$$;

create or replace function public.create_manual_booking_v2(
  p_actor_user_id text,
  p_assigned_user_id text,
  p_user_payable_amount bigint,
  p_supplier_gross_amount bigint,
  p_supplier_payable_amount bigint,
  p_data jsonb,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_booking_id uuid;
  v_attempt_id uuid;
  v_supplier_payable_major numeric;
  v_payload_minor numeric;
begin
  if p_supplier_payable_amount is null or p_supplier_payable_amount < 0
     or p_data is null or jsonb_typeof(p_data) <> 'object'
     or jsonb_typeof(p_data -> 'supplierPayableAmount') <> 'number' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_MANUAL_IMPORT_DATA');
  end if;

  begin
    v_payload_minor := (p_data ->> 'supplierPayableAmount')::numeric * 100;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_MANUAL_IMPORT_DATA');
  end;
  if v_payload_minor < 0
     or v_payload_minor <> trunc(v_payload_minor)
     or v_payload_minor is distinct from p_supplier_payable_amount::numeric then
    return jsonb_build_object('ok', false, 'code', 'INVALID_MANUAL_IMPORT_DATA');
  end if;

  -- v1 owns the durable booking, wallet, ledger, and idempotency transaction.
  -- This wrapper keeps those safeguards intact, then records the supplier cost
  -- in the same transaction before the booking can be returned to the caller.
  v_result := public.create_manual_booking_v1(
    p_actor_user_id,
    p_assigned_user_id,
    p_user_payable_amount,
    p_supplier_gross_amount,
    p_data,
    p_request_key
  );
  if coalesce((v_result ->> 'ok')::boolean, false) is not true then
    return v_result;
  end if;

  begin
    v_booking_id := (v_result #>> '{booking,id}')::uuid;
  exception when others then
    raise exception 'manual booking result omitted its booking identity';
  end;
  v_supplier_payable_major := p_supplier_payable_amount::numeric / 100;

  update public.flight_bookings
     set pricing_snapshot = coalesce(pricing_snapshot, '{}'::jsonb)
           || jsonb_build_object('supplierTotalPrice', v_supplier_payable_major),
         import_metadata = coalesce(import_metadata, '{}'::jsonb)
           || jsonb_build_object('supplierPayableAmount', v_supplier_payable_major)
   where id = v_booking_id
     and import_source = 'MANUAL'
  returning attempt_id into v_attempt_id;
  if not found then
    raise exception 'manual booking pricing target was not found';
  end if;

  update public.booking_attempts
     set offer_snapshot = coalesce(offer_snapshot, '{}'::jsonb)
           || jsonb_build_object(
             'pricing',
             coalesce(offer_snapshot -> 'pricing', '{}'::jsonb)
               || jsonb_build_object('supplierTotalPrice', v_supplier_payable_major)
           )
   where id = v_attempt_id;

  return v_result || jsonb_build_object(
    'supplierPayableAmount', p_supplier_payable_amount
  );
end;
$$;

revoke all on function public.create_manual_booking_v2(text, text, bigint, bigint, bigint, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.create_manual_booking_v2(text, text, bigint, bigint, bigint, jsonb, text)
  to service_role;

comment on function public.create_manual_booking_v2(text, text, bigint, bigint, bigint, jsonb, text) is
  'Creates a manual booking with separate Gross, Supplier Payable, and User Payable values.';
