begin;

-- Saved supplier display observations are independent of the original booking
-- identity, accepted fare, ticket documents, and local payment accounting.
create table public.shapon_booking_supplier_payable_observations (
  booking_id uuid not null references public.flight_bookings(id) on delete restrict,
  request_started_at timestamptz not null check (isfinite(request_started_at)),
  receipt_identity jsonb not null check (jsonb_typeof(receipt_identity) = 'object'),
  currency text not null check (currency = 'BDT'),
  supplier_payable_minor bigint check (supplier_payable_minor > 0),
  special_discount_minor bigint check (special_discount_minor < 0),
  display_pnr text check (display_pnr ~ '^[A-Za-z0-9][A-Za-z0-9-]{2,31}$'),
  airline_pnrs jsonb check (jsonb_typeof(airline_pnrs) = 'array'),
  check ((supplier_payable_minor is null) = (special_discount_minor is null)),
  check ((display_pnr is null) = (airline_pnrs is null)),
  check (supplier_payable_minor is not null or display_pnr is not null),
  primary key (booking_id, request_started_at)
);

alter table public.shapon_booking_supplier_payable_observations enable row level security;
revoke all on table public.shapon_booking_supplier_payable_observations
  from public, anon, authenticated, service_role;
grant select on table public.shapon_booking_supplier_payable_observations to service_role;

create function public.record_shapon_booking_supplier_payable_v1(
  p_booking_id uuid, p_request_started_at timestamptz, p_supplier_public_ref text,
  p_receipt_identity jsonb, p_supplier_payable_minor bigint, p_special_discount_minor bigint,
  p_currency text, p_display_pnr text, p_airline_pnrs jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_booking public.flight_bookings;
  v_prior public.shapon_booking_supplier_payable_observations;
  v_now timestamptz := clock_timestamp();
  v_identity jsonb;
begin
  if p_currency is distinct from 'BDT'
     or (p_supplier_payable_minor is null) <> (p_special_discount_minor is null)
     or p_supplier_payable_minor <= 0 or p_special_discount_minor >= 0
     or p_supplier_payable_minor::numeric - p_special_discount_minor::numeric > 9007199254740991
     or (p_display_pnr is null) <> (p_airline_pnrs is null)
     or (p_supplier_payable_minor is null and p_display_pnr is null)
     or p_display_pnr !~ '^[A-Za-z0-9][A-Za-z0-9-]{2,31}$'
     or p_request_started_at is null or not isfinite(p_request_started_at)
     or p_request_started_at > v_now + interval '30 seconds'
     or p_request_started_at < v_now - interval '5 minutes' then
    return jsonb_build_object('recorded',false,'code','INVALID_SUPPLIER_PAYABLE');
  end if;
  if p_airline_pnrs is not null and (case
       when jsonb_typeof(p_airline_pnrs) = 'array' then
         jsonb_array_length(p_airline_pnrs) > 20 or exists (
           select 1 from jsonb_array_elements(p_airline_pnrs) as locator(value)
           where jsonb_typeof(locator.value) <> 'string'
             or locator.value#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9-]{2,31}$'
         )
       else true
     end) then
    return jsonb_build_object('recorded',false,'code','INVALID_SUPPLIER_PNR');
  end if;
  select * into v_booking from public.flight_bookings where id=p_booking_id for update;
  if not found or p_currency is distinct from v_booking.currency
     or p_request_started_at < v_booking.created_at
     or p_supplier_public_ref is distinct from v_booking.supplier_public_ref
     or jsonb_typeof(p_receipt_identity) is distinct from 'object'
     or pg_column_size(p_receipt_identity) > 5000
     or not public.shapon_booking_status_identity_matches_v1(v_booking,p_receipt_identity) then
    return jsonb_build_object('recorded',false,'code','SUPPLIER_IDENTITY_UNVERIFIED');
  end if;
  if v_booking.status = 'cancelled' or v_booking.operation_kind = 'cancellation'
     or v_booking.operation_reason in ('cancellation','cancellation_reconciliation') then
    return jsonb_build_object('recorded',false,'code','SUPPLIER_PAYABLE_BOOKING_CANCELLED_OR_CANCELLING');
  end if;
  v_identity := jsonb_build_object(
    'uniqueTransId',p_receipt_identity->'uniqueTransId',
    'itemCodeRef',p_receipt_identity->'itemCodeRef',
    'priceCodeRef',p_receipt_identity->'priceCodeRef',
    'bookingCodeRef',p_receipt_identity->'bookingCodeRef',
    'bookingRefNumber',p_receipt_identity->'bookingRefNumber',
    'pnr',p_receipt_identity->'pnr',
    'supplierPublicRef',p_receipt_identity->'supplierPublicRef'
  );
  select * into v_prior from public.shapon_booking_supplier_payable_observations
   where booking_id=p_booking_id order by request_started_at desc limit 1;
  if found and p_request_started_at < v_prior.request_started_at then
    return jsonb_build_object('recorded',false,'code','STALE_SUPPLIER_PAYABLE');
  end if;
  if found and p_request_started_at = v_prior.request_started_at then
    if v_prior.receipt_identity = v_identity and v_prior.currency = p_currency
       and v_prior.supplier_payable_minor is not distinct from p_supplier_payable_minor
       and v_prior.special_discount_minor is not distinct from p_special_discount_minor
       and v_prior.display_pnr is not distinct from p_display_pnr
       and v_prior.airline_pnrs is not distinct from p_airline_pnrs then
      return jsonb_build_object('recorded',true,'replayed',true);
    end if;
    return jsonb_build_object('recorded',false,'code','SUPPLIER_PAYABLE_OBSERVATION_CONFLICT');
  end if;
  insert into public.shapon_booking_supplier_payable_observations
    (booking_id,request_started_at,receipt_identity,currency,supplier_payable_minor,special_discount_minor,
     display_pnr,airline_pnrs)
  values (p_booking_id,p_request_started_at,v_identity,p_currency,p_supplier_payable_minor,p_special_discount_minor,
    p_display_pnr,p_airline_pnrs);
  return jsonb_build_object('recorded',true,'replayed',false);
end;
$$;

revoke all on function public.record_shapon_booking_supplier_payable_v1(uuid,timestamptz,text,jsonb,bigint,bigint,text,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_shapon_booking_supplier_payable_v1(uuid,timestamptz,text,jsonb,bigint,bigint,text,text,jsonb)
  to service_role;

-- Preserve existing view columns, downstream sorting, and grants. The indexed
-- capture lookup applies only to bookings with a matching supplier observation.
do $migration$
declare
  v_definition text := pg_get_viewdef('public.booking_dashboard_list_v'::regclass,true);
  v_owner oid;
  v_acl aclitem[];
  v_options text[];
  v_fare text := $fare$COALESCE(NULLIF(booking.pricing_snapshot ->> 'sellingPrice'::text, ''::text)::numeric, 0::numeric)$fare$;
  v_cost text := $cost$NULLIF(booking.pricing_snapshot ->> 'supplierTotalPrice'::text, ''::text)::numeric$cost$;
  v_pnr text := $pnr$COALESCE(booking.pnr, ''::text) AS pnr$pnr$;
  v_airline_pnr text := $pnr$COALESCE(( SELECT string_agg(value.value, ', '::text) AS string_agg$pnr$;
  v_search text := $search$booking.public_ref, supplier_booking.supplier_public_ref, booking.pnr, COALESCE(( SELECT string_agg(value.value, ' '::text) AS string_agg$search$;
  v_list_from text := chr(10) || '   FROM booking_lifecycle_v booking';
  v_join text := 'LEFT JOIN app_users user_record ON user_record.clerk_id = booking.user_id';
  v_view regclass;
  v_from text;
begin
  select relowner,relacl,reloptions into v_owner,v_acl,v_options
    from pg_class where oid='public.booking_dashboard_list_v'::regclass;
  if (length(v_definition)-length(replace(v_definition,v_fare,'')))/length(v_fare) <> 2
     or (length(v_definition)-length(replace(v_definition,v_cost,'')))/length(v_cost) <> 2
     or (length(v_definition)-length(replace(v_definition,v_pnr,'')))/length(v_pnr) <> 1
     or (length(v_definition)-length(replace(v_definition,v_airline_pnr,'')))/length(v_airline_pnr) <> 1
     or (length(v_definition)-length(replace(v_definition,v_search,'')))/length(v_search) <> 1
     or (length(v_definition)-length(replace(v_definition,v_list_from,'')))/length(v_list_from) <> 1
     or (length(v_definition)-length(replace(v_definition,v_join,'')))/length(v_join) <> 1
     or v_options is distinct from array['security_invoker=true'] then
    raise exception 'Unexpected booking dashboard payable projection';
  end if;
  v_definition := replace(v_definition,v_fare,'COALESCE(local_capture.amount::numeric / 100, ' || v_fare || ')');
  v_definition := replace(v_definition,v_cost,'COALESCE(settlement.supplier_payable_minor::numeric / 100, ' || v_cost || ')');
  v_definition := replace(v_definition,v_pnr,$pnr$COALESCE(locator.display_pnr, booking.pnr, ''::text) AS pnr$pnr$);
  v_definition := replace(v_definition,v_airline_pnr,
    $pnr$COALESCE(locator.airline_pnr, ( SELECT string_agg(value.value, ', '::text) AS string_agg$pnr$);
  v_definition := replace(v_definition,v_search,$search$booking.public_ref, supplier_booking.supplier_public_ref,
    COALESCE(locator.display_pnr, booking.pnr),
    COALESCE(replace(locator.airline_pnr, ', ', ' '), ( SELECT string_agg(value.value, ' '::text) AS string_agg$search$);
  v_definition := replace(v_definition,v_list_from,
    ', locator.display_pnr AS shapon_display_pnr' || v_list_from);
  v_definition := replace(v_definition,v_join,v_join || $joins$
    left join lateral (
      select observed.supplier_payable_minor
        from public.shapon_booking_supplier_payable_observations observed
       where observed.booking_id=booking.id and observed.currency=supplier_booking.currency
         and observed.supplier_payable_minor is not null
         and public.shapon_booking_status_identity_matches_v1(supplier_booking,observed.receipt_identity)
       order by observed.request_started_at desc limit 1
    ) settlement on true
    left join lateral (
      select observed.display_pnr, array_to_string(array(
        select value from jsonb_array_elements_text(observed.airline_pnrs) with ordinality as airline(value, position)
        order by position
      ), ', ') as airline_pnr
        from public.shapon_booking_supplier_payable_observations observed
       where observed.booking_id=booking.id and observed.currency=supplier_booking.currency
         and observed.display_pnr is not null
         and public.shapon_booking_status_identity_matches_v1(supplier_booking,observed.receipt_identity)
       order by observed.request_started_at desc limit 1
    ) locator on true
    left join lateral (
      select min(capture.amount) amount
        from (
          select ledger.amount,ledger.currency,ledger.wallet_account_id,
            ledger.available_before,ledger.available_after,ledger.hold_before,ledger.hold_after
            from public.wallet_ledger_entries ledger
           where settlement.supplier_payable_minor is not null
             and supplier_booking.payment_state in ('captured','partially-refunded','refunded')
             and supplier_booking.captured_amount > 0
             and supplier_booking.captured_amount = supplier_booking.payment_amount
             and ledger.booking_id=booking.id and ledger.transaction_type='booking_confirm'
           limit 2
        ) capture
      having count(*)=1
         and bool_and(capture.amount=supplier_booking.captured_amount
           and capture.currency=supplier_booking.currency
           and capture.wallet_account_id=supplier_booking.charged_wallet_account_id
           and ((capture.available_before-capture.available_after=capture.amount
                 and capture.hold_before=capture.hold_after)
             or (capture.available_before=capture.available_after
                 and capture.hold_before-capture.hold_after=capture.amount)))
    ) local_capture on true$joins$);
  execute 'create or replace view public.booking_dashboard_list_v with (security_invoker=true) as ' || v_definition;
  if not exists (select 1 from pg_class where oid='public.booking_dashboard_list_v'::regclass
      and relowner=v_owner and relacl is not distinct from v_acl and reloptions=v_options) then
    raise exception 'Booking dashboard payable projection changed existing access';
  end if;
  for v_view, v_from in values
    ('public.booking_dashboard_list_ordered_v'::regclass, chr(10) || '   FROM booking_dashboard_list_v booking'),
    ('public.booking_dashboard_creator_v'::regclass, chr(10) || '   FROM booking_dashboard_list_ordered_v list')
  loop
    select relowner,relacl,reloptions into v_owner,v_acl,v_options from pg_class where oid=v_view;
    v_definition := pg_get_viewdef(v_view,true);
    if (length(v_definition)-length(replace(v_definition,v_from,'')))/length(v_from) <> 1
       or v_options is distinct from array['security_invoker=true'] then
      raise exception 'Unexpected booking dashboard locator projection: %', v_view;
    end if;
    v_definition := replace(v_definition,v_from,', shapon_display_pnr' || v_from);
    execute 'create or replace view ' || v_view || ' with (security_invoker=true) as ' || v_definition;
    if not exists (select 1 from pg_class where oid=v_view
        and relowner=v_owner and relacl is not distinct from v_acl and reloptions=v_options) then
      raise exception 'Booking dashboard locator projection changed existing access: %', v_view;
    end if;
  end loop;
end;
$migration$;

commit;
