-- Ticket Management quotations must snapshot supplier commercial facts from
-- the booking. Browser and application callers cannot choose or override them.

create or replace function public.ticket_management_booking_commercial_basis_v1(
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_currency text;
  v_booking_currency text;
  v_stored_supplier_gross bigint;
  v_snapshot_supplier_gross bigint;
  v_supplier_payable bigint;
  v_supplier_gross bigint;
begin
  select request.currency,
         booking.currency,
         booking.supplier_gross_amount,
         public.manual_pricing_minor_amount_v1(
           booking.pricing_snapshot,
           'grossPrice'
         ),
         public.manual_pricing_minor_amount_v1(
           booking.pricing_snapshot,
           'supplierTotalPrice'
         )
    into v_request_currency,
         v_booking_currency,
         v_stored_supplier_gross,
         v_snapshot_supplier_gross,
         v_supplier_payable
    from public.ticket_management_requests request
    join public.flight_bookings booking on booking.id = request.booking_id
   where request.id = p_request_id;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
  end if;
  if upper(v_booking_currency) is distinct from upper(v_request_currency) then
    return jsonb_build_object('ok', false, 'code', 'QUOTE_CURRENCY_MISMATCH');
  end if;

  v_supplier_gross := case
    when v_stored_supplier_gross > 0 then v_stored_supplier_gross
    when v_snapshot_supplier_gross > 0 then v_snapshot_supplier_gross
    else null
  end;
  if v_supplier_gross is null or v_supplier_payable is null
     or v_supplier_payable <= 0 then
    return jsonb_build_object(
      'ok', false,
      'code', 'SUPPLIER_COMMERCIAL_BASIS_UNAVAILABLE'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'currency', upper(v_booking_currency),
    'supplierGrossAmount', v_supplier_gross,
    'supplierPayableAmount', v_supplier_payable
  );
end;
$$;

create or replace function public.publish_ticket_management_quote_v2(
  p_request_id uuid,
  p_actor_user_id text,
  p_expected_version integer,
  p_request_key text,
  p_direction text,
  p_currency text,
  p_user_payable_entitlement_amount bigint,
  p_fare_difference bigint,
  p_airline_fee bigint,
  p_void_fee bigint,
  p_service_fee bigint,
  p_customer_amount bigint,
  p_confirmation_deadline_at timestamptz,
  p_details text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_basis jsonb;
begin
  v_basis := public.ticket_management_booking_commercial_basis_v1(p_request_id);
  if not coalesce((v_basis->>'ok')::boolean, false) then
    return v_basis;
  end if;
  if upper(p_currency) is distinct from v_basis->>'currency' then
    return jsonb_build_object('ok', false, 'code', 'QUOTE_CURRENCY_MISMATCH');
  end if;

  return public.publish_ticket_management_quote_v1(
    p_request_id,
    p_actor_user_id,
    p_expected_version,
    p_request_key,
    p_direction,
    p_currency,
    (v_basis->>'supplierGrossAmount')::bigint,
    (v_basis->>'supplierPayableAmount')::bigint,
    p_user_payable_entitlement_amount,
    p_fare_difference,
    p_airline_fee,
    p_void_fee,
    p_service_fee,
    p_customer_amount,
    p_confirmation_deadline_at,
    p_details
  );
end;
$$;

create or replace function public.publish_ticket_management_reissue_quote_v2(
  p_request_id uuid,
  p_actor_user_id text,
  p_expected_version integer,
  p_request_key text,
  p_direction text,
  p_currency text,
  p_fare_difference bigint,
  p_airline_fee bigint,
  p_service_fee bigint,
  p_customer_amount bigint,
  p_confirmation_deadline_at timestamptz,
  p_fare_difference_allocations jsonb,
  p_details text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_basis jsonb;
begin
  v_basis := public.ticket_management_booking_commercial_basis_v1(p_request_id);
  if not coalesce((v_basis->>'ok')::boolean, false) then
    return v_basis;
  end if;
  if upper(p_currency) is distinct from v_basis->>'currency' then
    return jsonb_build_object('ok', false, 'code', 'QUOTE_CURRENCY_MISMATCH');
  end if;

  return public.publish_ticket_management_reissue_quote_v1(
    p_request_id,
    p_actor_user_id,
    p_expected_version,
    p_request_key,
    p_direction,
    p_currency,
    (v_basis->>'supplierGrossAmount')::bigint,
    (v_basis->>'supplierPayableAmount')::bigint,
    p_fare_difference,
    p_airline_fee,
    p_service_fee,
    p_customer_amount,
    p_confirmation_deadline_at,
    p_fare_difference_allocations,
    p_details
  );
end;
$$;

revoke all on function public.ticket_management_booking_commercial_basis_v1(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.publish_ticket_management_quote_v1(
  uuid, text, integer, text, text, text, bigint, bigint, bigint,
  bigint, bigint, bigint, bigint, bigint, timestamptz, text
) from service_role;
revoke all on function public.publish_ticket_management_reissue_quote_v1(
  uuid, text, integer, text, text, text, bigint, bigint, bigint,
  bigint, bigint, bigint, timestamptz, jsonb, text
) from service_role;

revoke all on function public.publish_ticket_management_quote_v2(
  uuid, text, integer, text, text, text, bigint, bigint, bigint,
  bigint, bigint, bigint, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.publish_ticket_management_quote_v2(
  uuid, text, integer, text, text, text, bigint, bigint, bigint,
  bigint, bigint, bigint, timestamptz, text
) to service_role;

revoke all on function public.publish_ticket_management_reissue_quote_v2(
  uuid, text, integer, text, text, text, bigint, bigint, bigint,
  bigint, timestamptz, jsonb, text
) from public, anon, authenticated;
grant execute on function public.publish_ticket_management_reissue_quote_v2(
  uuid, text, integer, text, text, text, bigint, bigint, bigint,
  bigint, timestamptz, jsonb, text
) to service_role;

comment on function public.ticket_management_booking_commercial_basis_v1(uuid) is
  'Internal booking-derived Supplier Gross Fare and Supplier Payable basis for immutable Ticket Management quote audit records.';
comment on function public.publish_ticket_management_quote_v2(
  uuid, text, integer, text, text, text, bigint, bigint, bigint,
  bigint, bigint, bigint, timestamptz, text
) is
  'Publishes a quotation while sourcing supplier audit values from the booking; callers cannot provide them.';
comment on column public.ticket_management_quotes.service_fee is
  'Shapon Travels Service Fee, explicitly separate from supplier amounts and airline fees.';
