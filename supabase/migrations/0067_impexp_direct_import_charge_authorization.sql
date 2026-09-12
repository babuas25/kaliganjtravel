-- Direct confirmed import and wallet capture are separate decisions. Import &
-- Charge requires a fresh server-recorded authorization bound to the supplier,
-- assignee/owner, protected User Payable, supplier gross, currency, and a
-- normalized supplier snapshot hash. Import only never touches wallet money.

create table if not exists public.impexp_import_charge_authorizations (
  id                         uuid primary key default gen_random_uuid(),
  request_key                text not null unique,
  actor_user_id              text not null,
  actor_role                 text not null,
  assigned_user_id           text not null,
  owner_type                 text not null,
  owner_key                  text not null,
  supplier                   text not null,
  supplier_reference         text not null,
  currency                   text not null,
  user_payable_amount        bigint not null,
  supplier_gross_amount      bigint not null,
  authorization_payload_hash text not null,
  authorized_at              timestamptz not null default clock_timestamp(),
  expires_at                 timestamptz not null,
  consumed_at                timestamptz,
  consumed_booking_id        uuid references public.flight_bookings(id)
                             on delete restrict,
  created_at                 timestamptz not null default clock_timestamp(),
  constraint impexp_import_charge_auth_actor_role_check
    check (actor_role in ('staff_support', 'admin', 'superadmin')),
  constraint impexp_import_charge_auth_owner_check
    check (owner_type in ('user', 'agency') and btrim(owner_key) <> ''),
  constraint impexp_import_charge_auth_supplier_check
    check (supplier in ('US_BANGLA', 'AIR_ASTRA', 'NOVOAIR')),
  constraint impexp_import_charge_auth_currency_check
    check (currency ~ '^[A-Z]{3}$'),
  constraint impexp_import_charge_auth_amount_check
    check (user_payable_amount > 0 and supplier_gross_amount >= 0),
  constraint impexp_import_charge_auth_hash_check
    check (authorization_payload_hash ~ '^[a-f0-9]{64}$'),
  constraint impexp_import_charge_auth_request_check
    check (request_key ~ '^impexp-charge-authorization:v1:[0-9a-f-]{36}$'),
  constraint impexp_import_charge_auth_time_check
    check (expires_at > authorized_at),
  constraint impexp_import_charge_auth_consumption_check
    check (
      (consumed_at is null and consumed_booking_id is null)
      or (consumed_at is not null and consumed_booking_id is not null)
    )
);

create index if not exists impexp_import_charge_authorizations_expiry_idx
  on public.impexp_import_charge_authorizations (expires_at, id)
  where consumed_at is null;

alter table public.impexp_import_charge_authorizations enable row level security;
revoke all on table public.impexp_import_charge_authorizations
  from public, anon, authenticated;
grant select, insert, update on table public.impexp_import_charge_authorizations
  to service_role;

create or replace function public.impexp_charge_authorization_payload_v1(
  p_assigned_user_id text,
  p_user_payable_amount bigint,
  p_supplier_gross_amount bigint,
  p_data jsonb
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'version', 1,
    'assignedUserId', p_assigned_user_id,
    'userPayableAmount', p_user_payable_amount,
    'supplierGrossAmount', p_supplier_gross_amount,
    'provider', p_data->>'provider',
    'supplierReference', p_data->>'supplierReference',
    'storedStatus', p_data->>'storedStatus',
    'lifecycleStatus', p_data->>'lifecycleStatus',
    'currency', upper(p_data->>'currency'),
    'passengerCounts', p_data->'passengerCounts',
    'itinerary', p_data->'itinerary',
    'passengers', p_data->'passengers',
    'pnr', p_data->>'pnr',
    'airlinesPnr', p_data->'airlinesPnr',
    'ticketNumbers', p_data->'ticketNumbers'
  );
$$;

create or replace function public.authorize_impexp_import_charge_v1(
  p_actor_user_id text,
  p_assigned_user_id text,
  p_user_payable_amount bigint,
  p_supplier_gross_amount bigint,
  p_data jsonb,
  p_request_key text
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
  v_owner_type text;
  v_owner_key text;
  v_supplier text;
  v_supplier_ref text;
  v_currency text;
  v_payload_hash text;
  v_traveller_count integer;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_existing public.impexp_import_charge_authorizations;
  v_authorization public.impexp_import_charge_authorizations;
  v_now timestamptz := clock_timestamp();
begin
  if p_data is null
     or jsonb_typeof(p_data) <> 'object'
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or nullif(btrim(coalesce(p_assigned_user_id, '')), '') is null
     or p_user_payable_amount is null or p_user_payable_amount <= 0
     or p_supplier_gross_amount is null or p_supplier_gross_amount < 0
     or p_request_key
        !~ '^impexp-charge-authorization:v1:[0-9a-f-]{36}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_CHARGE_AUTHORIZATION');
  end if;
  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role is null
     or v_actor_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'IMPEXP_CHARGE_AUTHORIZATION_FORBIDDEN');
  end if;
  select role, agency_code into v_target_role, v_agency_code
    from public.app_users
   where clerk_id = p_assigned_user_id;
  if not found or v_target_role not in ('b2b', 'b2b_sub', 'customer') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_ASSIGNEE');
  end if;
  if v_target_role in ('b2b', 'b2b_sub') then
    if nullif(btrim(v_agency_code), '') is null then
      return jsonb_build_object('ok', false, 'code', 'ASSIGNEE_AGENCY_REQUIRED');
    end if;
    v_owner_type := 'agency';
    v_owner_key := v_agency_code;
  else
    v_owner_type := 'user';
    v_owner_key := p_assigned_user_id;
  end if;

  v_supplier := nullif(btrim(p_data->>'provider'), '');
  v_supplier_ref := nullif(btrim(p_data->>'supplierReference'), '');
  v_currency := upper(coalesce(nullif(btrim(p_data->>'currency'), ''), 'BDT'));
  v_traveller_count := case
    when jsonb_typeof(p_data #> '{passengers,travellers}') = 'array'
      then jsonb_array_length(p_data #> '{passengers,travellers}')
    else 0
  end;
  if v_supplier not in ('US_BANGLA', 'AIR_ASTRA', 'NOVOAIR')
     or v_supplier_ref is null
     or v_currency !~ '^[A-Z]{3}$'
     or p_data->>'storedStatus' is distinct from 'confirmed'
     or p_data->>'lifecycleStatus' is distinct from 'confirmed'
     or nullif(btrim(p_data->>'pnr'), '') is null
     or jsonb_typeof(p_data->'airlinesPnr') <> 'array'
     or jsonb_array_length(case
          when jsonb_typeof(p_data->'airlinesPnr') = 'array'
            then p_data->'airlinesPnr' else '[]'::jsonb end) = 0
     or jsonb_typeof(p_data->'ticketNumbers') <> 'array'
     or v_traveller_count <= 0
     or jsonb_array_length(case
          when jsonb_typeof(p_data->'ticketNumbers') = 'array'
            then p_data->'ticketNumbers' else '[]'::jsonb end)
        <> v_traveller_count
     or exists (
       select 1 from jsonb_array_elements(case
         when jsonb_typeof(p_data->'ticketNumbers') = 'array'
           then p_data->'ticketNumbers' else '[]'::jsonb end) ticket(value)
        where jsonb_typeof(ticket.value) <> 'string'
           or nullif(btrim(ticket.value #>> '{}'), '') is null
     )
     or (select count(distinct ticket.value #>> '{}')
           from jsonb_array_elements(case
             when jsonb_typeof(p_data->'ticketNumbers') = 'array'
               then p_data->'ticketNumbers' else '[]'::jsonb end) ticket(value))
        <> v_traveller_count
     or exists (
       select 1 from jsonb_array_elements(case
         when jsonb_typeof(p_data->'airlinesPnr') = 'array'
           then p_data->'airlinesPnr' else '[]'::jsonb end) airline(value)
        where jsonb_typeof(airline.value) <> 'string'
           or nullif(btrim(airline.value #>> '{}'), '') is null
     ) then
    return jsonb_build_object(
      'ok', false, 'code', 'COMPLETE_CONFIRMED_IMPORT_EVIDENCE_REQUIRED'
    );
  end if;

  v_payload_hash := encode(sha256(convert_to(
    public.impexp_charge_authorization_payload_v1(
      p_assigned_user_id, p_user_payable_amount,
      p_supplier_gross_amount, p_data
    )::text, 'UTF8'
  )), 'hex');
  select auth_row.* into v_existing
    from public.impexp_import_charge_authorizations auth_row
   where auth_row.request_key = p_request_key
   for update;
  if found then
    if v_existing.actor_user_id = p_actor_user_id
       and v_existing.assigned_user_id = p_assigned_user_id
       and v_existing.authorization_payload_hash = v_payload_hash then
      return jsonb_build_object(
        'ok', true, 'replay', true,
        'authorizationId', v_existing.id,
        'expiresAt', v_existing.expires_at,
        'consumed', v_existing.consumed_at is not null,
        'amount', v_existing.user_payable_amount,
        'currency', v_existing.currency
      );
    end if;
    raise exception 'import charge authorization request identity mismatch'
      using errcode = '22023';
  end if;

  select wallet.* into v_wallet
    from public.wallets wallet
   where wallet.owner_type = v_owner_type
     and wallet.owner_key = v_owner_key;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND');
  end if;
  select account.* into v_account
    from public.wallet_accounts account
   where account.wallet_id = v_wallet.id
     and account.currency = v_currency;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;
  if v_wallet.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN');
  end if;
  if v_account.available_balance < p_user_payable_amount then
    return jsonb_build_object(
      'ok', false, 'code', 'INSUFFICIENT_FUNDS',
      'available', v_account.available_balance,
      'required', p_user_payable_amount,
      'currency', v_currency
    );
  end if;

  insert into public.impexp_import_charge_authorizations (
    request_key, actor_user_id, actor_role, assigned_user_id,
    owner_type, owner_key, supplier, supplier_reference, currency,
    user_payable_amount, supplier_gross_amount,
    authorization_payload_hash, authorized_at, expires_at
  ) values (
    p_request_key, p_actor_user_id, v_actor_role, p_assigned_user_id,
    v_owner_type, v_owner_key, v_supplier, v_supplier_ref, v_currency,
    p_user_payable_amount, p_supplier_gross_amount,
    v_payload_hash, v_now, v_now + interval '5 minutes'
  ) returning * into v_authorization;

  return jsonb_build_object(
    'ok', true, 'replay', false,
    'authorizationId', v_authorization.id,
    'expiresAt', v_authorization.expires_at,
    'consumed', false,
    'amount', v_authorization.user_payable_amount,
    'currency', v_authorization.currency,
    'walletAvailable', v_account.available_balance,
    'walletMutation', false
  );
end;
$$;

create or replace function public.create_impexp_booking_v2(
  p_actor_user_id text,
  p_assigned_user_id text,
  p_user_payable_amount bigint,
  p_supplier_gross_amount bigint,
  p_data jsonb,
  p_import_decision text,
  p_charge_authorization_id uuid,
  p_request_key text
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
  v_owner_type text;
  v_owner_key text;
  v_supplier text;
  v_supplier_ref text;
  v_currency text;
  v_stored_status text;
  v_lifecycle_status text;
  v_payload_hash text;
  v_existing public.flight_bookings;
  v_authorization public.impexp_import_charge_authorizations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_booking public.flight_bookings;
  v_reservation public.wallet_reservations;
  v_case public.booking_reconciliation_cases;
  v_safe_data jsonb;
  v_created jsonb;
  v_available_before bigint;
  v_hold_before bigint;
  v_ledger_key text;
  v_imported_at timestamptz;
  v_event_id bigint;
  v_occurrence_number integer;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object'
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or nullif(btrim(coalesce(p_assigned_user_id, '')), '') is null
     or p_user_payable_amount is null or p_user_payable_amount <= 0
     or p_supplier_gross_amount is null or p_supplier_gross_amount < 0
     or p_import_decision not in ('import_only', 'import_and_charge')
     or p_request_key !~ '^impexp-import:v2:[0-9a-f-]{36}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_DATA');
  end if;
  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role is null
     or v_actor_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'IMPEXP_FORBIDDEN');
  end if;
  select role, agency_code into v_target_role, v_agency_code
    from public.app_users
   where clerk_id = p_assigned_user_id;
  if not found or v_target_role not in ('b2b', 'b2b_sub', 'customer') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_ASSIGNEE');
  end if;
  if v_target_role in ('b2b', 'b2b_sub') then
    if nullif(btrim(v_agency_code), '') is null then
      return jsonb_build_object('ok', false, 'code', 'ASSIGNEE_AGENCY_REQUIRED');
    end if;
    v_owner_type := 'agency';
    v_owner_key := v_agency_code;
  else
    v_owner_type := 'user';
    v_owner_key := p_assigned_user_id;
  end if;

  v_supplier := nullif(btrim(p_data->>'provider'), '');
  v_supplier_ref := nullif(btrim(p_data->>'supplierReference'), '');
  v_currency := upper(coalesce(nullif(btrim(p_data->>'currency'), ''), 'BDT'));
  v_stored_status := p_data->>'storedStatus';
  v_lifecycle_status := p_data->>'lifecycleStatus';
  if v_supplier not in ('US_BANGLA', 'AIR_ASTRA', 'NOVOAIR')
     or v_supplier_ref is null
     or v_currency !~ '^[A-Z]{3}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_IDENTITY');
  end if;
  if v_lifecycle_status <> 'confirmed'
     and (p_import_decision <> 'import_only'
       or p_charge_authorization_id is not null) then
    return jsonb_build_object('ok', false, 'code', 'CHARGE_DECISION_NOT_APPLICABLE');
  end if;
  if v_lifecycle_status = 'confirmed'
     and ((p_import_decision = 'import_and_charge'
         and p_charge_authorization_id is null)
       or (p_import_decision = 'import_only'
         and p_charge_authorization_id is not null)) then
    return jsonb_build_object('ok', false, 'code', 'CHARGE_AUTHORIZATION_MISMATCH');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('IMP_EXP:' || v_supplier || ':' || v_supplier_ref, 0)
  );
  select booking.* into v_existing
    from public.flight_bookings booking
   where booking.import_source = 'IMP_EXP'
     and booking.supplier = v_supplier
     and booking.booking_ref_number = v_supplier_ref
   limit 1
   for update;
  if found then
    if v_existing.user_payable_amount is null
       or v_existing.booking_owner_type is null
       or v_existing.booking_owner_key is null then
      return jsonb_build_object(
        'ok', false, 'code', 'HISTORICAL_IMPORT_RECONCILIATION_REQUIRED'
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
    if v_existing.import_metadata->>'importRequestKey' = p_request_key
       and v_existing.import_metadata->>'importDecision' = p_import_decision then
      return jsonb_build_object(
        'ok', true, 'replay', true,
        'booking', to_jsonb(v_existing),
        'walletCharged', false,
        'chargePreviouslyCaptured', v_existing.payment_state = 'captured',
        'amount', case when v_existing.payment_state = 'captured'
          then v_existing.captured_amount else 0 end,
        'accountId', v_existing.charged_wallet_account_id,
        'status', v_lifecycle_status,
        'importDecision', p_import_decision
      );
    end if;
    if v_existing.payment_state <> 'captured'
       and v_lifecycle_status = 'confirmed' then
      return jsonb_build_object(
        'ok', false,
        'code', 'REIMPORT_CONFIRMATION_REQUIRES_RECONCILIATION'
      );
    end if;
    return public.sync_impexp_booking_v2(
      p_actor_user_id, v_existing.id, p_supplier_gross_amount, p_data
    ) || jsonb_build_object(
      'reimport', true,
      'walletCharged', false,
      'importDecision', p_import_decision
    );
  end if;

  if v_lifecycle_status <> 'confirmed' then
    v_created := public.create_impexp_booking(
      p_actor_user_id, p_assigned_user_id, p_user_payable_amount,
      p_supplier_gross_amount, p_data
    );
    if coalesce((v_created->>'ok')::boolean, false) is not true then
      return v_created;
    end if;
    update public.flight_bookings
       set import_metadata = coalesce(import_metadata, '{}'::jsonb)
         || jsonb_build_object(
           'importDecision', 'import_only',
           'importRequestKey', p_request_key,
           'walletChargeAuthorized', false
         )
     where id = (v_created #>> '{booking,id}')::uuid
     returning * into v_booking;
    return v_created || jsonb_build_object(
      'booking', to_jsonb(v_booking),
      'walletCharged', false,
      'importDecision', 'import_only',
      'priorChargeAuthorizationVerified', false
    );
  end if;

  if v_stored_status <> 'confirmed'
     or jsonb_typeof(p_data #> '{passengers,travellers}') <> 'array'
     or jsonb_array_length(case
          when jsonb_typeof(p_data #> '{passengers,travellers}') = 'array'
            then p_data #> '{passengers,travellers}' else '[]'::jsonb end) = 0
     or nullif(btrim(p_data->>'pnr'), '') is null
     or jsonb_typeof(p_data->'ticketNumbers') <> 'array'
     or jsonb_array_length(case
          when jsonb_typeof(p_data->'ticketNumbers') = 'array'
            then p_data->'ticketNumbers' else '[]'::jsonb end)
       <> jsonb_array_length(case
          when jsonb_typeof(p_data #> '{passengers,travellers}') = 'array'
            then p_data #> '{passengers,travellers}' else '[]'::jsonb end)
     or exists (
       select 1 from jsonb_array_elements(case
         when jsonb_typeof(p_data->'ticketNumbers') = 'array'
           then p_data->'ticketNumbers' else '[]'::jsonb end) ticket(value)
        where jsonb_typeof(ticket.value) <> 'string'
           or nullif(btrim(ticket.value #>> '{}'), '') is null
     )
     or (select count(distinct ticket.value #>> '{}')
           from jsonb_array_elements(case
             when jsonb_typeof(p_data->'ticketNumbers') = 'array'
               then p_data->'ticketNumbers' else '[]'::jsonb end) ticket(value))
        <> jsonb_array_length(case
          when jsonb_typeof(p_data #> '{passengers,travellers}') = 'array'
            then p_data #> '{passengers,travellers}' else '[]'::jsonb end)
     or jsonb_typeof(p_data->'airlinesPnr') <> 'array'
     or jsonb_array_length(case
          when jsonb_typeof(p_data->'airlinesPnr') = 'array'
            then p_data->'airlinesPnr' else '[]'::jsonb end) = 0
     or exists (
       select 1 from jsonb_array_elements(case
         when jsonb_typeof(p_data->'airlinesPnr') = 'array'
           then p_data->'airlinesPnr' else '[]'::jsonb end) airline(value)
        where jsonb_typeof(airline.value) <> 'string'
           or nullif(btrim(airline.value #>> '{}'), '') is null
     ) then
    return jsonb_build_object(
      'ok', false, 'code', 'COMPLETE_CONFIRMED_IMPORT_EVIDENCE_REQUIRED'
    );
  end if;

  v_payload_hash := encode(sha256(convert_to(
    public.impexp_charge_authorization_payload_v1(
      p_assigned_user_id, p_user_payable_amount,
      p_supplier_gross_amount, p_data
    )::text, 'UTF8'
  )), 'hex');
  if p_import_decision = 'import_and_charge' then
    select auth_row.* into v_authorization
      from public.impexp_import_charge_authorizations auth_row
     where auth_row.id = p_charge_authorization_id
     for update;
    if not found
       or v_authorization.actor_user_id <> p_actor_user_id
       or v_authorization.assigned_user_id <> p_assigned_user_id
       or v_authorization.owner_type <> v_owner_type
       or v_authorization.owner_key <> v_owner_key
       or v_authorization.supplier <> v_supplier
       or v_authorization.supplier_reference <> v_supplier_ref
       or v_authorization.currency <> v_currency
       or v_authorization.user_payable_amount <> p_user_payable_amount
       or v_authorization.supplier_gross_amount <> p_supplier_gross_amount
       or v_authorization.authorization_payload_hash <> v_payload_hash
       or v_authorization.expires_at < clock_timestamp()
       or v_authorization.consumed_at is not null then
      return jsonb_build_object(
        'ok', false, 'code', 'FRESH_MATCHING_CHARGE_AUTHORIZATION_REQUIRED'
      );
    end if;
  end if;

  select wallet.* into v_wallet
    from public.wallets wallet
   where wallet.owner_type = v_owner_type
     and wallet.owner_key = v_owner_key;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND');
  end if;
  select account.* into v_account
    from public.wallet_accounts account
   where account.wallet_id = v_wallet.id
     and account.currency = v_currency;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND');
  end if;
  if p_import_decision = 'import_and_charge' then
    select wallet.* into strict v_wallet
      from public.wallets wallet
     where wallet.id = v_wallet.id
     for update;
    select account.* into strict v_account
      from public.wallet_accounts account
     where account.id = v_account.id
     for update;
    if v_wallet.status <> 'active' then
      return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN');
    end if;
    if v_account.available_balance < p_user_payable_amount then
      return jsonb_build_object(
        'ok', false, 'code', 'INSUFFICIENT_FUNDS',
        'available', v_account.available_balance,
        'required', p_user_payable_amount,
        'currency', v_currency
      );
    end if;
  end if;

  -- Reuse the mature non-financial import writer by creating a transaction-
  -- local On Hold/Unpaid row, then atomically apply the explicitly selected
  -- direct-confirmed outcome. No observer can see the intermediate row.
  v_safe_data := p_data || jsonb_build_object(
    'storedStatus', 'on-hold',
    'lifecycleStatus', 'on-hold'
  );
  v_created := public.create_impexp_booking(
    p_actor_user_id, p_assigned_user_id, p_user_payable_amount,
    p_supplier_gross_amount, v_safe_data
  );
  if coalesce((v_created->>'ok')::boolean, false) is not true then
    return v_created;
  end if;
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = (v_created #>> '{booking,id}')::uuid
   for update;
  v_imported_at := coalesce(
    nullif(p_data->>'importedAt', '')::timestamptz,
    clock_timestamp()
  );

  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  if p_import_decision = 'import_and_charge' then
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
    v_ledger_key := 'impexp-payment:' || v_booking.id::text;
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
      'Explicitly authorized direct confirmed import and charge',
      jsonb_build_object(
        'importSource', 'IMP_EXP',
        'supplierGrossAmount', p_supplier_gross_amount,
        'userPayableAmount', p_user_payable_amount,
        'directConfirmedImport', true,
        'importDecision', 'import_and_charge',
        'chargeAuthorizationId', v_authorization.id
      )
    );
  end if;

  update public.flight_bookings
     set status = 'confirmed',
         direct_ticketing = true,
         issued_at = v_imported_at,
         issued_by_user_id = p_actor_user_id,
         payment_state = case when p_import_decision = 'import_and_charge'
           then 'captured' else 'unpaid' end,
         payment_amount = case when p_import_decision = 'import_and_charge'
           then p_user_payable_amount else null end,
         captured_amount = case when p_import_decision = 'import_and_charge'
           then p_user_payable_amount else 0 end,
         charged_wallet_account_id = case
           when p_import_decision = 'import_and_charge'
             then v_account.id else null end,
         import_metadata = coalesce(import_metadata, '{}'::jsonb)
           || jsonb_build_object(
             'lifecycleStatus', 'confirmed',
             'importDecision', p_import_decision,
             'importRequestKey', p_request_key,
             'walletChargeAuthorized',
               p_import_decision = 'import_and_charge',
             'chargeAuthorizationId', case
               when p_import_decision = 'import_and_charge'
                 then v_authorization.id else null end
           )
   where id = v_booking.id
   returning * into v_booking;

  if p_import_decision = 'import_only' then
    insert into public.booking_reconciliation_cases (
      subject_booking_id, case_type, state, reason_code, reason_detail,
      opened_source, opened_by_user_id, opened_by_role, opened_at,
      assigned_team, assigned_at, severity, priority, due_at,
      evidence, financial_disposition, policy_version
    ) values (
      v_booking.id, 'imported_payment_conflict', 'awaiting_finance',
      'direct_confirmed_import_uncharged',
      'Confirmed supplier booking was explicitly imported without a wallet charge.',
      'staff', p_actor_user_id, v_actor_role, clock_timestamp(),
      'accounts', clock_timestamp(), 'critical', 90,
      clock_timestamp() + interval '1 hour',
      jsonb_build_array(jsonb_build_object(
        'type', 'direct_confirmed_import_decision',
        'importDecision', 'import_only',
        'supplier', v_supplier,
        'supplierReference', v_supplier_ref,
        'userPayableAmount', p_user_payable_amount,
        'currency', v_currency,
        'walletMutation', false,
        'recordedAt', clock_timestamp()
      )), 'none', 1
    ) returning * into v_case;
  else
    update public.impexp_import_charge_authorizations
       set consumed_at = clock_timestamp(),
           consumed_booking_id = v_booking.id
     where id = v_authorization.id;
  end if;

  select count(*)::integer + 1 into v_occurrence_number
    from public.booking_status_events event
   where event.booking_id = v_booking.id
     and event.to_lifecycle_status = 'confirmed';
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key, reconciliation_case_id,
    occurrence_number, effective_at, observed_at,
    event_snapshot, event_version
  ) values (
    v_booking.id, null, 'confirmed', null, 'confirmed', null,
    case when p_import_decision = 'import_and_charge'
      then 'direct_confirmed_import_charged'
      else 'direct_confirmed_import_uncharged' end,
    p_actor_user_id,
    case when p_import_decision = 'import_and_charge'
      then 'ImportAndCharge' else 'ImportOnly' end,
    jsonb_build_object(
      'importDecision', p_import_decision,
      'chargeAuthorizationId', case
        when p_import_decision = 'import_and_charge'
          then v_authorization.id else null end,
      'walletCharged', p_import_decision = 'import_and_charge'
    ),
    p_request_key || ':confirmed', case
      when p_import_decision = 'import_only' then v_case.id else null end,
    v_occurrence_number, v_imported_at, clock_timestamp(),
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'lifecycleStatus', 'confirmed',
      'paymentState', v_booking.payment_state,
      'operationSource', 'imported_direct_confirmed',
      'importDecision', p_import_decision,
      'reconciliationCaseId', case
        when p_import_decision = 'import_only' then v_case.id else null end,
      'userPayableAmount', p_user_payable_amount,
      'currency', v_currency
    ), 1
  ) returning id into v_event_id;

  return jsonb_build_object(
    'ok', true, 'replay', false,
    'booking', to_jsonb(v_booking),
    'status', 'confirmed',
    'importDecision', p_import_decision,
    'walletCharged', p_import_decision = 'import_and_charge',
    'priorChargeAuthorizationVerified',
      p_import_decision = 'import_and_charge',
    'chargeAuthorizationId', case
      when p_import_decision = 'import_and_charge'
        then v_authorization.id else null end,
    'reconciliationCaseId', case
      when p_import_decision = 'import_only' then v_case.id else null end,
    'lifecycleEventId', v_event_id,
    'amount', case when p_import_decision = 'import_and_charge'
      then p_user_payable_amount else 0 end,
    'accountId', case when p_import_decision = 'import_and_charge'
      then v_account.id else null end,
    'availableBalance', case when p_import_decision = 'import_and_charge'
      then v_available_before - p_user_payable_amount else null end,
    'currency', v_currency
  );
end;
$$;

revoke all on function public.impexp_charge_authorization_payload_v1(
  text, bigint, bigint, jsonb
) from public, anon, authenticated;
revoke all on function public.authorize_impexp_import_charge_v1(
  text, text, bigint, bigint, jsonb, text
) from public, anon, authenticated;
revoke all on function public.create_impexp_booking_v2(
  text, text, bigint, bigint, jsonb, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.authorize_impexp_import_charge_v1(
  text, text, bigint, bigint, jsonb, text
) to service_role;
grant execute on function public.create_impexp_booking_v2(
  text, text, bigint, bigint, jsonb, text, uuid, text
) to service_role;

-- The application has moved to v2. Keep the old signature only as a private
-- compatibility helper for non-confirmed import inside v2; clients cannot call
-- its legacy direct-confirmed auto-charge behavior.
revoke execute on function public.create_impexp_booking(
  text, text, bigint, bigint, jsonb
) from service_role;

comment on table public.impexp_import_charge_authorizations is
  'Five-minute, one-use server authorizations for an explicit direct-confirmed Import & Charge decision. Stores hashes and normalized identities, never raw supplier/passenger payloads.';
comment on function public.authorize_impexp_import_charge_v1(
  text, text, bigint, bigint, jsonb, text
) is
  'Records a non-financial, payload-bound prior authorization for Import & Charge after verifying complete confirmed supplier evidence and the assigned wallet snapshot.';
comment on function public.create_impexp_booking_v2(
  text, text, bigint, bigint, jsonb, text, uuid, text
) is
  'Imports with an explicit import_only or import_and_charge decision. A direct confirmed charge requires and atomically consumes a fresh matching prior authorization; import_only never changes wallet money and creates an Accounts-owned payment case.';
