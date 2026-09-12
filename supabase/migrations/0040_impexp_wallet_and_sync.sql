-- Imported-booking commercial pricing, controlled wallet capture, and
-- supplier synchronization. Imported bookings continue to use the shared
-- wallet, reservation, ledger, payment, ownership, and lifecycle tables.

alter table public.flight_bookings
  add column if not exists supplier_gross_amount bigint
    check (supplier_gross_amount is null or supplier_gross_amount >= 0),
  add column if not exists user_payable_amount bigint
    check (user_payable_amount is null or user_payable_amount > 0);

comment on column public.flight_bookings.supplier_gross_amount is
  'Supplier/reference gross in integer minor units. Never used as an imported customer wallet debit.';
comment on column public.flight_bookings.user_payable_amount is
  'Locally agreed customer/agency payable in integer minor units. The only amount an imported booking may charge.';

-- PostgreSQL expands `fb.*` when a view is created. Rebuild the lifecycle view
-- so columns added by IMP/EXP migrations (including import_source and the two
-- prices above) are available to the normal booking read path.
drop view if exists public.booking_payment_report_v;
drop view if exists public.booking_lifecycle_v;
create view public.booking_lifecycle_v
with (security_invoker = true)
as
select
  fb.*,
  public.resolve_booking_lifecycle(
    fb.status, fb.airlines_pnr, fb.ticketing_deadline_at, fb.operation_kind
  ) as lifecycle_status
from public.flight_bookings fb
where not fb.legacy_operational;

create view public.booking_payment_report_v
with (security_invoker = true)
as
select
  fb.id as booking_id,
  fb.public_ref,
  fb.booking_owner_type,
  fb.booking_owner_key,
  fb.booked_by_user_id,
  fb.issued_by_user_id,
  fb.charged_wallet_account_id,
  fb.payment_state,
  fb.payment_amount,
  fb.captured_amount,
  fb.refunded_amount,
  fb.currency,
  fb.lifecycle_status as booking_status,
  fb.created_at,
  fb.issued_at
from public.booking_lifecycle_v fb;

revoke all on table public.booking_lifecycle_v from public, anon, authenticated;
revoke all on table public.booking_payment_report_v from public, anon, authenticated;
grant select on table public.booking_lifecycle_v to service_role;
grant select on table public.booking_payment_report_v to service_role;

comment on view public.booking_lifecycle_v is
  'Canonical seven-state booking lifecycle projection, including current IMP/EXP columns.';
comment on view public.booking_payment_report_v is
  'One payment-state summary row per non-legacy business booking.';

-- A paid imported hold is intentionally waiting for manual external
-- ticketing, not for an application-side supplier call.
alter table public.flight_bookings
  drop constraint if exists flight_bookings_operation_reason_check;
alter table public.flight_bookings
  add constraint flight_bookings_operation_reason_check
  check (operation_reason is null or operation_reason in (
    'ticketing',
    'supplier_balance_insufficient',
    'ticketing_reconciliation',
    'cancellation',
    'cancellation_reconciliation',
    'terminal_state_conflict',
    'direct_ticket_payment_reconciliation',
    'legacy_reconciliation',
    'imported_manual_ticketing'
  ));

-- Supplier synchronization is deliberately non-financial. It updates only
-- supplier-controlled snapshots and safe lifecycle state. In particular it
-- never writes wallet tables, payment fields, the wallet owner, or the local
-- user payable.
create or replace function public.sync_impexp_booking(
  p_actor_user_id text,
  p_booking_id uuid,
  p_supplier_gross_amount bigint,
  p_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_booking public.flight_bookings;
  v_updated public.flight_bookings;
  v_supplier text;
  v_supplier_ref text;
  v_supplier_status text;
  v_supplier_lifecycle text;
  v_old_lifecycle text;
  v_new_status text;
  v_new_operation_kind text;
  v_new_operation_reason text;
  v_sync_at timestamptz;
  v_supplier_gross_major numeric;
  v_pricing jsonb;
  v_offer jsonb;
begin
  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role not in ('superadmin', 'admin', 'staff_support') then
    return jsonb_build_object('ok', false, 'code', 'IMPEXP_FORBIDDEN');
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object'
     or p_supplier_gross_amount is null or p_supplier_gross_amount < 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_DATA');
  end if;

  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id and import_source = 'IMP_EXP'
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_NOT_FOUND');
  end if;
  if v_booking.user_payable_amount is null
     or v_booking.booking_owner_type is null
     or v_booking.booking_owner_key is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'HISTORICAL_IMPORT_RECONCILIATION_REQUIRED'
    );
  end if;

  v_supplier := nullif(trim(p_data->>'provider'), '');
  v_supplier_ref := nullif(trim(p_data->>'supplierReference'), '');
  if v_supplier is distinct from v_booking.supplier
     or v_supplier_ref is distinct from v_booking.booking_ref_number then
    return jsonb_build_object('ok', false, 'code', 'IMPORT_IDENTITY_MISMATCH');
  end if;
  if jsonb_typeof(p_data->'passengerCounts') <> 'object'
     or jsonb_typeof(p_data->'itinerary') <> 'object'
     or jsonb_typeof(p_data->'fares') <> 'array'
     or jsonb_typeof(p_data->'passengers') <> 'object'
     or jsonb_typeof(p_data->'airlinesPnr') <> 'array'
     or jsonb_typeof(p_data->'ticketNumbers') <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_DATA');
  end if;

  v_supplier_status := p_data->>'storedStatus';
  v_supplier_lifecycle := p_data->>'lifecycleStatus';
  if v_supplier_status not in (
       'on-hold', 'pending', 'in-progress', 'confirmed', 'cancelled'
     ) or v_supplier_lifecycle not in (
       'on-hold', 'pending', 'in-progress', 'confirmed', 'expired',
       'unconfirmed', 'cancelled'
     ) then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_STATUS');
  end if;

  v_old_lifecycle := public.resolve_booking_lifecycle(
    v_booking.status,
    v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at,
    v_booking.operation_kind
  );
  v_sync_at := coalesce(nullif(p_data->>'importedAt', '')::timestamptz, now());
  v_supplier_gross_major := p_supplier_gross_amount::numeric / 100;
  v_pricing := coalesce(v_booking.pricing_snapshot, '{}'::jsonb)
    || jsonb_build_object(
      'supplierTotalPrice', v_supplier_gross_major,
      'grossPrice', v_supplier_gross_major
    );
  select offer_snapshot into v_offer
    from public.booking_attempts
   where id = v_booking.attempt_id;
  v_offer := coalesce(v_offer, '{}'::jsonb)
    || jsonb_build_object(
      'itinerary', p_data->'itinerary',
      'fares', p_data->'fares',
      'currency', v_booking.currency,
      'pricing', coalesce(v_offer->'pricing', v_pricing) || jsonb_build_object(
        'supplierTotalPrice', v_supplier_gross_major,
        'grossPrice', v_supplier_gross_major,
        'sellingPrice', v_booking.user_payable_amount::numeric / 100
      ),
      'passengerCounts', p_data->'passengerCounts',
      'travelDate', p_data->>'travelDate',
      'passportRequired', coalesce((p_data->>'passportRequired')::boolean, true),
      'repricedAt', v_sync_at
    );

  -- Captured In Progress rows only become Confirmed on authoritative supplier
  -- confirmation. A held response leaves the manual-ticketing state intact.
  if v_booking.payment_state = 'captured' then
    if v_booking.status = 'in-progress' and v_supplier_lifecycle = 'confirmed' then
      v_new_status := 'confirmed';
      v_new_operation_kind := null;
      v_new_operation_reason := null;
    elsif v_booking.status = 'in-progress' then
      v_new_status := 'in-progress';
      if v_supplier_lifecycle in ('cancelled', 'expired', 'unconfirmed') then
        v_new_operation_kind := 'reconciliation';
        v_new_operation_reason := 'ticketing_reconciliation';
      else
        v_new_operation_kind := coalesce(v_booking.operation_kind, 'ticketing');
        v_new_operation_reason := coalesce(
          v_booking.operation_reason,
          'imported_manual_ticketing'
        );
      end if;
    elsif v_booking.status = 'confirmed' then
      v_new_status := 'confirmed';
      if v_supplier_lifecycle in ('cancelled', 'expired', 'unconfirmed') then
        v_new_operation_kind := 'reconciliation';
        v_new_operation_reason := 'terminal_state_conflict';
      else
        v_new_operation_kind := null;
        v_new_operation_reason := null;
      end if;
    else
      v_new_status := 'in-progress';
      v_new_operation_kind := 'reconciliation';
      v_new_operation_reason := 'ticketing_reconciliation';
    end if;
  else
    -- Sync never turns an unpaid supplier confirmation into a paid booking.
    if v_supplier_lifecycle = 'confirmed' then
      v_new_status := 'in-progress';
      v_new_operation_kind := 'reconciliation';
      v_new_operation_reason := 'ticketing_reconciliation';
    else
      v_new_status := v_supplier_status;
      v_new_operation_kind := case when v_supplier_status = 'in-progress'
        then 'reconciliation' else null end;
      v_new_operation_reason := case when v_supplier_status = 'in-progress'
        then 'ticketing_reconciliation' else null end;
    end if;
  end if;

  update public.booking_attempts
     set supplier = v_supplier,
         offer_snapshot = v_offer,
         passenger_snapshot = p_data->'passengers',
         pnr = coalesce(nullif(p_data->>'pnr', ''), v_supplier_ref),
         resolved_at = v_sync_at
   where id = v_booking.attempt_id;

  update public.flight_bookings
     set status = v_new_status,
         operation_kind = v_new_operation_kind,
         operation_reason = v_new_operation_reason,
         operation_request_id = case when v_new_operation_kind is null
           then null else operation_request_id end,
         operation_actor_user_id = case when v_new_operation_kind is null
           then null else coalesce(operation_actor_user_id, p_actor_user_id) end,
         operation_started_at = case when v_new_operation_kind is null
           then null else coalesce(operation_started_at, v_sync_at) end,
         operation_prior_status = case when v_new_operation_kind is null
           then null else coalesce(operation_prior_status, 'on-hold') end,
         pricing_snapshot = v_pricing,
         supplier_gross_amount = p_supplier_gross_amount,
         passenger_counts = p_data->'passengerCounts',
         travel_date = (p_data->>'travelDate')::date,
         direct_ticketing = v_new_status = 'confirmed',
         itinerary = p_data->'itinerary',
         fares = p_data->'fares',
         passport_required = coalesce((p_data->>'passportRequired')::boolean, true),
         supplier_refs = jsonb_strip_nulls(
           coalesce(supplier_refs, '{}'::jsonb)
           || jsonb_build_object(
             'originalReference', nullif(p_data->>'originalReference', '')
           )
         ),
         repriced_at = v_sync_at,
         passengers = p_data->'passengers',
         pnr = coalesce(nullif(p_data->>'pnr', ''), v_supplier_ref),
         airlines_pnr = p_data->'airlinesPnr',
         booking_status = p_data->>'orderStatus',
         ticketing_time_limit = nullif(p_data->>'ticketingTimeLimit', ''),
         ticketing_deadline_at = nullif(p_data->>'ticketingDeadlineAt', '')::timestamptz,
         deadline_source = case
           when nullif(p_data->>'ticketingDeadlineAt', '') is not null
             then 'supplier'
           else null
         end,
         ticket_numbers = p_data->'ticketNumbers',
         supplier_message = nullif(p_data->>'supplierMessage', ''),
         issued_at = case when v_new_status = 'confirmed'
           then coalesce(issued_at, v_sync_at) else issued_at end,
         cancelled_at = case
           when v_booking.payment_state <> 'captured' and v_new_status = 'cancelled'
             then coalesce(cancelled_at, v_sync_at)
           else cancelled_at
         end,
         import_metadata = coalesce(import_metadata, '{}'::jsonb)
           || jsonb_strip_nulls(jsonb_build_object(
             'provider', v_supplier,
             'supplierReference', v_supplier_ref,
             'originalReference', nullif(p_data->>'originalReference', ''),
             'orderStatus', p_data->>'orderStatus',
             'lifecycleStatus', v_supplier_lifecycle,
             'lastSyncedAt', v_sync_at,
             'lastSyncedBy', p_actor_user_id
           ))
   where id = v_booking.id
   returning * into v_updated;

  if v_old_lifecycle is distinct from public.resolve_booking_lifecycle(
       v_updated.status,
       v_updated.airlines_pnr,
       v_updated.ticketing_deadline_at,
       v_updated.operation_kind
     ) then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, actor_user_id, supplier_operation, supplier_evidence
    ) values (
      v_updated.id,
      v_old_lifecycle,
      public.resolve_booking_lifecycle(
        v_updated.status,
        v_updated.airlines_pnr,
        v_updated.ticketing_deadline_at,
        v_updated.operation_kind
      ),
      v_booking.status,
      v_updated.status,
      v_updated.operation_kind,
      v_updated.operation_reason,
      p_actor_user_id,
      'ImportSync',
      jsonb_build_object(
        'provider', v_supplier,
        'supplierStatus', p_data->>'orderStatus',
        'lifecycleStatus', v_supplier_lifecycle,
        'airlinesPnr', p_data->'airlinesPnr',
        'ticketNumbers', p_data->'ticketNumbers',
        'walletMutation', false
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'booking', to_jsonb(v_updated),
    'walletCharged', false,
    'status', public.resolve_booking_lifecycle(
      v_updated.status,
      v_updated.airlines_pnr,
      v_updated.ticketing_deadline_at,
      v_updated.operation_kind
    )
  );
end;
$$;

-- A customer or agency user confirms an imported hold without calling a
-- supplier ticket API. The payable capture, ledger row, payment attribution,
-- and On Hold -> In Progress transition share this one transaction.
create or replace function public.wallet_confirm_impexp_booking(
  p_booking_id uuid,
  p_actor_user_id text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_actor_role text;
  v_actor_agency text;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_reservation public.wallet_reservations;
  v_available_before bigint;
  v_hold_before bigint;
  v_ledger_key text;
begin
  if nullif(trim(p_actor_user_id), '') is null
     or nullif(trim(p_idempotency_key), '') is null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CONFIRM_REQUEST');
  end if;
  select role, agency_code into v_actor_role, v_actor_agency
    from public.app_users
   where clerk_id = p_actor_user_id;
  if not found or v_actor_role not in ('customer', 'b2b', 'b2b_sub') then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_CONFIRM_FORBIDDEN');
  end if;

  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id and import_source = 'IMP_EXP'
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_BOOKING_NOT_FOUND');
  end if;
  if not (
    (v_actor_role = 'customer'
      and v_booking.booking_owner_type = 'user'
      and v_booking.booking_owner_key = p_actor_user_id)
    or
    (v_actor_role in ('b2b', 'b2b_sub')
      and nullif(trim(v_actor_agency), '') is not null
      and v_booking.booking_owner_type = 'agency'
      and v_booking.booking_owner_key = v_actor_agency)
  ) then
    return jsonb_build_object('ok', false, 'code', 'IMPORTED_CONFIRM_FORBIDDEN');
  end if;

  if v_booking.payment_state = 'captured' then
    return jsonb_build_object(
      'ok', true,
      'replay', true,
      'status', public.resolve_booking_lifecycle(
        v_booking.status,
        v_booking.airlines_pnr,
        v_booking.ticketing_deadline_at,
        v_booking.operation_kind
      ),
      'accountId', v_booking.charged_wallet_account_id,
      'amount', v_booking.captured_amount
    );
  end if;
  if v_booking.status <> 'on-hold'
     or v_booking.operation_kind is not null
     or v_booking.payment_state <> 'unpaid'
     or public.resolve_booking_lifecycle(
       v_booking.status,
       v_booking.airlines_pnr,
       v_booking.ticketing_deadline_at,
       v_booking.operation_kind
     ) <> 'on-hold' then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_ISSUABLE');
  end if;
  if v_booking.user_payable_amount is null or v_booking.user_payable_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
  end if;

  select * into v_wallet
    from public.wallets
   where owner_type = v_booking.booking_owner_type
     and owner_key = v_booking.booking_owner_key
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND');
  end if;
  select * into v_account
    from public.wallet_accounts
   where wallet_id = v_wallet.id and currency = upper(v_booking.currency)
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;
  if v_wallet.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN');
  end if;
  if v_account.available_balance < v_booking.user_payable_amount then
    return jsonb_build_object(
      'ok', false,
      'code', 'INSUFFICIENT_FUNDS',
      'available', v_account.available_balance,
      'required', v_booking.user_payable_amount,
      'currency', v_account.currency
    );
  end if;
  if exists (
    select 1 from public.wallet_reservations where booking_id = v_booking.id
  ) then
    return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REQUIRED');
  end if;

  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  v_ledger_key := 'impexp-payment:' || v_booking.id::text;

  update public.wallet_accounts
     set available_balance = available_balance - v_booking.user_payable_amount
   where id = v_account.id;
  insert into public.wallet_reservations (
    wallet_account_id, booking_id, amount, currency, state,
    requested_by_user_id, issued_by_user_id, captured_at
  ) values (
    v_account.id, v_booking.id, v_booking.user_payable_amount,
    v_account.currency, 'captured', p_actor_user_id, p_actor_user_id, now()
  ) returning * into v_reservation;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks, metadata
  ) values (
    v_account.id, 'booking_confirm', v_booking.user_payable_amount,
    v_account.currency, v_available_before,
    v_available_before - v_booking.user_payable_amount,
    v_hold_before, v_hold_before, v_booking.id, v_booking.public_ref,
    v_reservation.id, v_ledger_key, p_actor_user_id, v_actor_role,
    'Customer confirmed imported booking for manual external ticketing',
    jsonb_build_object(
      'importSource', 'IMP_EXP',
      'supplierGrossAmount', v_booking.supplier_gross_amount,
      'userPayableAmount', v_booking.user_payable_amount,
      'requestId', p_idempotency_key
    )
  );
  update public.flight_bookings
     set charged_wallet_account_id = v_account.id,
         payment_state = 'captured',
         payment_amount = user_payable_amount,
         captured_amount = user_payable_amount,
         status = 'in-progress',
         operation_kind = 'ticketing',
         operation_reason = 'imported_manual_ticketing',
         operation_request_id = p_idempotency_key,
         operation_actor_user_id = p_actor_user_id,
         operation_started_at = now(),
         operation_prior_status = 'on-hold'
   where id = v_booking.id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key
  ) values (
    v_booking.id, 'on-hold', 'in-progress', 'on-hold', 'in-progress',
    'ticketing', 'imported_manual_ticketing', p_actor_user_id,
    'ImportCustomerConfirm',
    jsonb_build_object(
      'walletCaptured', true,
      'supplierApiCalled', false,
      'userPayableAmount', v_booking.user_payable_amount
    ),
    v_ledger_key || ':in-progress'
  ) on conflict do nothing;

  return jsonb_build_object(
    'ok', true,
    'status', 'in-progress',
    'reservationId', v_reservation.id,
    'accountId', v_account.id,
    'amount', v_booking.user_payable_amount,
    'currency', v_account.currency,
    'availableBalance', v_available_before - v_booking.user_payable_amount,
    'holdBalance', v_hold_before
  );
end;
$$;

drop function if exists public.create_impexp_booking(text,text,jsonb);

-- Initial import and direct-confirmed capture are serialized by stable supplier
-- identity. A retry/re-import sees the existing row before any possible debit.
create or replace function public.create_impexp_booking(
  p_actor_user_id text,
  p_assigned_user_id text,
  p_user_payable_amount bigint,
  p_supplier_gross_amount bigint,
  p_data jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_target_role text;
  v_agency_code text;
  v_audience text;
  v_owner_type text;
  v_owner_key text;
  v_supplier text;
  v_supplier_ref text;
  v_currency text;
  v_status text;
  v_lifecycle_status text;
  v_imported_at timestamptz;
  v_attempt_id uuid := gen_random_uuid();
  v_search_id uuid := gen_random_uuid();
  v_access_hash text;
  v_offer jsonb;
  v_existing public.flight_bookings;
  v_booking public.flight_bookings;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_reservation public.wallet_reservations;
  v_available_before bigint;
  v_hold_before bigint;
  v_ledger_key text;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object'
     or nullif(trim(p_assigned_user_id), '') is null
     or p_user_payable_amount is null or p_user_payable_amount <= 0
     or p_supplier_gross_amount is null or p_supplier_gross_amount < 0 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_DATA');
  end if;
  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role not in ('superadmin', 'admin', 'staff_support') then
    return jsonb_build_object('ok', false, 'code', 'IMPEXP_FORBIDDEN');
  end if;

  v_supplier := nullif(trim(p_data->>'provider'), '');
  v_supplier_ref := nullif(trim(p_data->>'supplierReference'), '');
  v_currency := upper(coalesce(nullif(trim(p_data->>'currency'), ''), 'BDT'));
  if v_supplier not in ('US_BANGLA', 'AIR_ASTRA', 'NOVOAIR')
     or v_supplier_ref is null or v_currency !~ '^[A-Z]{3}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_IDENTITY');
  end if;
  perform pg_advisory_xact_lock(
    hashtextextended('IMP_EXP:' || v_supplier || ':' || v_supplier_ref, 0)
  );

  select role, agency_code into v_target_role, v_agency_code
    from public.app_users
   where clerk_id = p_assigned_user_id;
  if not found or v_target_role not in ('b2b', 'b2b_sub', 'customer') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_ASSIGNEE');
  end if;
  if v_target_role in ('b2b', 'b2b_sub') then
    if nullif(trim(v_agency_code), '') is null then
      return jsonb_build_object('ok', false, 'code', 'ASSIGNEE_AGENCY_REQUIRED');
    end if;
    v_audience := 'agency';
    v_owner_type := 'agency';
    v_owner_key := v_agency_code;
  else
    v_audience := 'b2c';
    v_agency_code := null;
    v_owner_type := 'user';
    v_owner_key := p_assigned_user_id;
  end if;

  v_status := p_data->>'storedStatus';
  v_lifecycle_status := p_data->>'lifecycleStatus';
  if v_status not in ('on-hold', 'pending', 'in-progress', 'confirmed', 'cancelled')
     or v_lifecycle_status not in (
       'on-hold', 'pending', 'in-progress', 'confirmed', 'expired',
       'unconfirmed', 'cancelled'
     )
     or (v_lifecycle_status in ('expired', 'unconfirmed') and v_status <> 'on-hold')
     or (v_lifecycle_status not in ('expired', 'unconfirmed')
       and v_lifecycle_status <> v_status)
     or coalesce(p_data->>'travelDate', '') !~ '^\d{4}-\d{2}-\d{2}$'
     or jsonb_typeof(p_data->'passengerCounts') <> 'object'
     or jsonb_typeof(p_data->'itinerary') <> 'object'
     or jsonb_typeof(p_data->'fares') <> 'array'
     or jsonb_typeof(p_data->'passengers') <> 'object'
     or jsonb_typeof(p_data->'airlinesPnr') <> 'array'
     or jsonb_typeof(p_data->'ticketNumbers') <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_DATA');
  end if;

  select * into v_existing
    from public.flight_bookings
   where import_source = 'IMP_EXP'
     and supplier = v_supplier
     and booking_ref_number = v_supplier_ref
   limit 1
   for update;
  if found then
    if v_existing.user_payable_amount is null
       or v_existing.booking_owner_type is null
       or v_existing.booking_owner_key is null then
      return jsonb_build_object(
        'ok', false,
        'code', 'HISTORICAL_IMPORT_RECONCILIATION_REQUIRED'
      );
    end if;
    if v_existing.user_id is distinct from p_assigned_user_id
       or v_existing.booking_owner_type is distinct from v_owner_type
       or v_existing.booking_owner_key is distinct from v_owner_key then
      return jsonb_build_object('ok', false, 'code', 'IMPORT_ASSIGNEE_MISMATCH');
    end if;
    if v_existing.user_payable_amount <> p_user_payable_amount then
      return jsonb_build_object('ok', false, 'code', 'IMPORT_PAYABLE_MISMATCH');
    end if;
    if v_existing.payment_state <> 'captured'
       and v_lifecycle_status = 'confirmed' then
      return jsonb_build_object(
        'ok', false,
        'code', 'REIMPORT_CONFIRMATION_REQUIRES_RECONCILIATION'
      );
    end if;
    return public.sync_impexp_booking(
      p_actor_user_id,
      v_existing.id,
      p_supplier_gross_amount,
      p_data
    ) || jsonb_build_object('reimport', true, 'walletCharged', false);
  end if;

  -- Assignment is required to resolve to an already-existing wallet account.
  -- On Hold imports do not require funds yet, but they may not be ownerless.
  select * into v_wallet
    from public.wallets
   where owner_type = v_owner_type and owner_key = v_owner_key;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND');
  end if;
  select * into v_account
    from public.wallet_accounts
   where wallet_id = v_wallet.id and currency = v_currency;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;
  if v_status = 'confirmed' then
    select * into strict v_wallet
      from public.wallets where id = v_wallet.id for update;
    select * into strict v_account
      from public.wallet_accounts where id = v_account.id for update;
    if v_wallet.status <> 'active' then
      return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN');
    end if;
    if v_account.available_balance < p_user_payable_amount then
      return jsonb_build_object(
        'ok', false,
        'code', 'INSUFFICIENT_FUNDS',
        'available', v_account.available_balance,
        'required', p_user_payable_amount,
        'currency', v_currency
      );
    end if;
  end if;

  v_imported_at := coalesce(nullif(p_data->>'importedAt', '')::timestamptz, now());
  v_offer := jsonb_build_object(
    'itinerary', p_data->'itinerary',
    'fares', p_data->'fares',
    'currency', v_currency,
    'pricing', jsonb_build_object(
      'audience', v_audience,
      'agencyCode', v_agency_code,
      'sellingPrice', p_user_payable_amount::numeric / 100,
      'supplierTotalPrice', p_supplier_gross_amount::numeric / 100,
      'grossPrice', p_supplier_gross_amount::numeric / 100,
      'serviceMarginAmount', 0,
      'ruleId', null,
      'basis', 'supplier'
    ),
    'passengerCounts', p_data->'passengerCounts',
    'travelDate', p_data->>'travelDate',
    'directTicketing', v_status = 'confirmed',
    'passportRequired', coalesce((p_data->>'passportRequired')::boolean, true),
    'repricedAt', v_imported_at
  );
  v_access_hash := md5(v_attempt_id::text || clock_timestamp()::text)
    || md5(v_search_id::text || random()::text);

  insert into public.booking_attempts (
    id, access_token_hash, user_id, audience, agency_code, supplier, state,
    search_id, itinerary_id, unique_trans_id, item_code_ref, price_code_ref,
    booking_code_ref, pnr, offer_snapshot, passenger_snapshot,
    expires_at, submitted_at, resolved_at, created_at
  ) values (
    v_attempt_id, v_access_hash, p_assigned_user_id, v_audience, v_agency_code,
    v_supplier, 'succeeded', v_search_id,
    'impexp:' || lower(v_supplier) || ':' || v_supplier_ref,
    v_supplier_ref, v_supplier_ref, v_supplier_ref,
    'impexp:' || v_supplier_ref,
    coalesce(nullif(p_data->>'pnr', ''), v_supplier_ref),
    v_offer, p_data->'passengers', v_imported_at, v_imported_at,
    v_imported_at, v_imported_at
  );

  insert into public.flight_bookings (
    id, public_ref, attempt_id, supplier, user_id, audience, agency_code,
    search_id, itinerary_id, status, operation_kind, operation_reason,
    operation_actor_user_id, operation_started_at, operation_prior_status,
    currency, pricing_snapshot, supplier_gross_amount, user_payable_amount,
    passenger_counts, travel_date, direct_ticketing, itinerary, fares,
    passport_required, supplier_refs, repriced_at, accepted_at, passengers,
    pnr, airlines_pnr, booking_ref_number, booking_status, ticketing_time_limit,
    ticketing_deadline_at, deadline_source, booking_code_ref, ticket_numbers,
    warnings, supplier_message, issued_at, cancelled_at, submission_started_at,
    legacy_operational, booked_by_user_id, issued_by_user_id,
    charged_wallet_account_id, payment_state, payment_amount, captured_amount,
    import_source, imported_by_user_id, import_metadata, created_at
  ) values (
    gen_random_uuid(), public.allocate_booking_ref(), v_attempt_id, v_supplier,
    p_assigned_user_id, v_audience, v_agency_code, v_search_id,
    'impexp:' || lower(v_supplier) || ':' || v_supplier_ref,
    v_status,
    case when v_status = 'in-progress' then 'reconciliation' else null end,
    case when v_status = 'in-progress' then 'ticketing_reconciliation' else null end,
    case when v_status = 'in-progress' then p_actor_user_id else null end,
    case when v_status = 'in-progress' then v_imported_at else null end,
    case when v_status = 'in-progress' then 'on-hold' else null end,
    v_currency, v_offer->'pricing', p_supplier_gross_amount,
    p_user_payable_amount, p_data->'passengerCounts',
    (p_data->>'travelDate')::date, v_status = 'confirmed',
    p_data->'itinerary', p_data->'fares',
    coalesce((p_data->>'passportRequired')::boolean, true),
    jsonb_strip_nulls(jsonb_build_object(
      'uniqueTransId', v_supplier_ref,
      'itemCodeRef', v_supplier_ref,
      'priceCodeRef', v_supplier_ref,
      'externalImport', true,
      'originalReference', nullif(p_data->>'originalReference', '')
    )),
    v_imported_at, v_imported_at, p_data->'passengers',
    coalesce(nullif(p_data->>'pnr', ''), v_supplier_ref),
    p_data->'airlinesPnr', v_supplier_ref, p_data->>'orderStatus',
    nullif(p_data->>'ticketingTimeLimit', ''),
    nullif(p_data->>'ticketingDeadlineAt', '')::timestamptz,
    case when nullif(p_data->>'ticketingDeadlineAt', '') is not null
      then 'supplier' else null end,
    'impexp:' || v_supplier_ref, p_data->'ticketNumbers', '[]'::jsonb,
    nullif(p_data->>'supplierMessage', ''),
    case when v_status = 'confirmed' then v_imported_at end,
    case when v_status = 'cancelled' then v_imported_at end,
    v_imported_at, false, p_actor_user_id,
    case when v_status = 'confirmed' then p_actor_user_id end,
    case when v_status = 'confirmed' then v_account.id end,
    case when v_status = 'confirmed' then 'captured' else 'unpaid' end,
    case when v_status = 'confirmed' then p_user_payable_amount end,
    case when v_status = 'confirmed' then p_user_payable_amount else 0 end,
    'IMP_EXP', p_actor_user_id,
    jsonb_strip_nulls(jsonb_build_object(
      'provider', v_supplier,
      'supplierReference', v_supplier_ref,
      'originalReference', nullif(p_data->>'originalReference', ''),
      'lookupLastName', nullif(p_data->>'lookupLastName', ''),
      'orderStatus', p_data->>'orderStatus',
      'lifecycleStatus', v_lifecycle_status,
      'lastSyncedAt', v_imported_at
    )),
    v_imported_at
  ) returning * into v_booking;

  if v_status = 'confirmed' then
    v_available_before := v_account.available_balance;
    v_hold_before := v_account.hold_balance;
    v_ledger_key := 'impexp-payment:' || v_booking.id::text;
    update public.wallet_accounts
       set available_balance = available_balance - p_user_payable_amount
     where id = v_account.id;
    insert into public.wallet_reservations (
      wallet_account_id, booking_id, amount, currency, state,
      requested_by_user_id, issued_by_user_id, captured_at
    ) values (
      v_account.id, v_booking.id, p_user_payable_amount, v_currency,
      'captured', p_actor_user_id, p_actor_user_id, v_imported_at
    ) returning * into v_reservation;
    insert into public.wallet_ledger_entries (
      wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after,
      booking_id, booking_reference, reservation_id, idempotency_key,
      created_by_user_id, created_by_role, remarks, metadata
    ) values (
      v_account.id, 'booking_confirm', p_user_payable_amount, v_currency,
      v_available_before, v_available_before - p_user_payable_amount,
      v_hold_before, v_hold_before, v_booking.id, v_booking.public_ref,
      v_reservation.id, v_ledger_key, p_actor_user_id, v_actor_role,
      'Confirmed imported booking payment',
      jsonb_build_object(
        'importSource', 'IMP_EXP',
        'supplierGrossAmount', p_supplier_gross_amount,
        'userPayableAmount', p_user_payable_amount,
        'directConfirmedImport', true
      )
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'booking', to_jsonb(v_booking),
    'walletCharged', v_status = 'confirmed',
    'amount', case when v_status = 'confirmed' then p_user_payable_amount else 0 end,
    'accountId', case when v_status = 'confirmed' then v_account.id else null end,
    'status', v_lifecycle_status
  );
end;
$$;

revoke all on function public.sync_impexp_booking(text,uuid,bigint,jsonb)
  from public, anon, authenticated;
revoke all on function public.wallet_confirm_impexp_booking(uuid,text,text)
  from public, anon, authenticated;
revoke all on function public.create_impexp_booking(text,text,bigint,bigint,jsonb)
  from public, anon, authenticated;
grant execute on function public.sync_impexp_booking(text,uuid,bigint,jsonb)
  to service_role;
grant execute on function public.wallet_confirm_impexp_booking(uuid,text,text)
  to service_role;
grant execute on function public.create_impexp_booking(text,text,bigint,bigint,jsonb)
  to service_role;
