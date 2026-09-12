-- Canonical FirstTrip/TakeOff booking import by supplier uniqueTransID.
-- These rows remain ordinary Triplover API bookings: import_source stays NULL,
-- the real reference chain and supplier_account are immutable, and every
-- existing Issue/Cancel/PNR/wallet/lifecycle path continues to apply.

alter table public.flight_bookings
  add column if not exists booking_origin text;

alter table public.flight_bookings
  drop constraint if exists flight_bookings_booking_origin_check;
alter table public.flight_bookings
  add constraint flight_bookings_booking_origin_check
  check (
    booking_origin is null
    or booking_origin = 'supplier_reference_import'
  );

create unique index if not exists
  flight_bookings_supplier_account_unique_trans_id_key
  on public.flight_bookings (
    supplier_account,
    ((supplier_refs->>'uniqueTransId'))
  )
  where not legacy_operational
    and supplier_account is not null
    and nullif(btrim(supplier_refs->>'uniqueTransId'), '') is not null;

create index if not exists flight_bookings_supplier_reference_origin_created_idx
  on public.flight_bookings (created_at desc)
  where booking_origin = 'supplier_reference_import';

comment on column public.flight_bookings.booking_origin is
  'Nullable audit origin. supplier_reference_import marks API-backed FirstTrip/TakeOff imports without changing their ordinary Triplover operational behavior.';

create or replace function public.protect_supplier_reference_booking_identity_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.booking_origin = 'supplier_reference_import' and (
    new.booking_origin is distinct from old.booking_origin
    or new.supplier is distinct from old.supplier
    or new.supplier_account is distinct from old.supplier_account
    or new.supplier_refs->>'uniqueTransId'
       is distinct from old.supplier_refs->>'uniqueTransId'
    or new.supplier_refs->>'itemCodeRef'
       is distinct from old.supplier_refs->>'itemCodeRef'
    or new.supplier_refs->>'priceCodeRef'
       is distinct from old.supplier_refs->>'priceCodeRef'
    or new.booking_code_ref is distinct from old.booking_code_ref
    or new.booking_ref_number is distinct from old.booking_ref_number
  ) then
    raise exception 'supplier-reference booking identity is immutable'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists flight_bookings_protect_supplier_reference_identity_v1
  on public.flight_bookings;
create trigger flight_bookings_protect_supplier_reference_identity_v1
  before update of
    booking_origin, supplier, supplier_account, supplier_refs,
    booking_code_ref, booking_ref_number
  on public.flight_bookings
  for each row execute function
    public.protect_supplier_reference_booking_identity_v1();

revoke all on function
  public.protect_supplier_reference_booking_identity_v1()
  from public, anon, authenticated;

create table if not exists public.supplier_reference_charge_authorizations (
  id                         uuid primary key default gen_random_uuid(),
  request_key                text not null unique,
  actor_user_id              text not null,
  actor_role                 text not null,
  assigned_user_id           text not null,
  owner_type                 text not null,
  owner_key                  text not null,
  supplier_account           text not null,
  supplier_reference         text not null,
  currency                   text not null,
  user_payable_amount        bigint not null,
  supplier_gross_amount      bigint not null,
  authorization_payload_hash text not null,
  authorized_at              timestamptz not null default clock_timestamp(),
  expires_at                 timestamptz not null,
  consumed_at                timestamptz,
  consumed_booking_id        uuid
                             references public.flight_bookings(id)
                             on delete restrict,
  created_at                 timestamptz not null default clock_timestamp(),
  constraint supplier_reference_charge_actor_role_check
    check (actor_role in ('staff_support', 'admin', 'superadmin')),
  constraint supplier_reference_charge_owner_check
    check (owner_type in ('user', 'agency') and btrim(owner_key) <> ''),
  constraint supplier_reference_charge_account_check
    check (supplier_account in ('firsttrip', 'takeoff')),
  constraint supplier_reference_charge_reference_check
    check (supplier_reference ~ '^(FST|TOT)[0-9]{18}$'),
  constraint supplier_reference_charge_currency_check
    check (currency ~ '^[A-Z]{3}$'),
  constraint supplier_reference_charge_amount_check
    check (user_payable_amount > 0 and supplier_gross_amount > 0),
  constraint supplier_reference_charge_hash_check
    check (authorization_payload_hash ~ '^[a-f0-9]{64}$'),
  constraint supplier_reference_charge_request_check
    check (
      request_key ~ '^supplier-reference-charge:v1:[0-9a-f-]{36}$'
    ),
  constraint supplier_reference_charge_time_check
    check (expires_at > authorized_at),
  constraint supplier_reference_charge_consumption_check
    check (
      (consumed_at is null and consumed_booking_id is null)
      or (consumed_at is not null and consumed_booking_id is not null)
    )
);

create index if not exists supplier_reference_charge_expiry_idx
  on public.supplier_reference_charge_authorizations (expires_at, id)
  where consumed_at is null;

alter table public.supplier_reference_charge_authorizations
  enable row level security;
revoke all on table public.supplier_reference_charge_authorizations
  from public, anon, authenticated;
grant select, insert, update
  on table public.supplier_reference_charge_authorizations
  to service_role;

create or replace function public.supplier_reference_import_payload_hash_v1(
  p_assigned_user_id text,
  p_user_payable_amount bigint,
  p_supplier_gross_amount bigint,
  p_data jsonb
)
returns text
language sql
immutable
set search_path = public
as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'version', 1,
    'assignedUserId', p_assigned_user_id,
    'userPayableAmount', p_user_payable_amount,
    'supplierGrossAmount', p_supplier_gross_amount,
    -- retrievedAt is the local observation time of each mandatory live fetch.
    -- Authorization and import deliberately fetch again, so that one volatile
    -- field cannot be part of their otherwise exact shared fingerprint.
    'booking', p_data - array[
      'retrievedAt', 'pricingCalculatedAt', 'supplierEvidenceTimestamp'
    ]
  )::text, 'UTF8')), 'hex');
$$;

create or replace function public.supplier_reference_money_minor_v1(
  p_value jsonb
)
returns bigint
language plpgsql
immutable
set search_path = public
as $$
declare
  v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'number' then return null; end if;
  v_text := p_value #>> '{}';
  if v_text !~ '^-?[0-9]+([.][0-9]+)?$' then return null; end if;
  return round(v_text::numeric * 100)::bigint;
exception when others then
  return null;
end;
$$;

create or replace function public.authorize_supplier_reference_charge_v1(
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
  v_audience text;
  v_owner_type text;
  v_owner_key text;
  v_supplier_account text;
  v_supplier_reference text;
  v_currency text;
  v_payload_hash text;
  v_traveller_count integer;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_existing public.supplier_reference_charge_authorizations;
  v_authorization public.supplier_reference_charge_authorizations;
  v_now timestamptz := clock_timestamp();
begin
  if p_data is null
     or jsonb_typeof(p_data) <> 'object'
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or nullif(btrim(coalesce(p_assigned_user_id, '')), '') is null
     or p_user_payable_amount is null or p_user_payable_amount <= 0
     or p_supplier_gross_amount is null or p_supplier_gross_amount <= 0
     or p_request_key
        !~ '^supplier-reference-charge:v1:[0-9a-f-]{36}$' then
    return jsonb_build_object(
      'ok', false, 'code', 'INVALID_CHARGE_AUTHORIZATION'
    );
  end if;

  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role is null
     or v_actor_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object(
      'ok', false, 'code', 'SUPPLIER_REFERENCE_IMPORT_FORBIDDEN'
    );
  end if;

  select role, agency_code into v_target_role, v_agency_code
    from public.app_users
   where clerk_id = p_assigned_user_id;
  if not found or v_target_role not in ('b2b', 'b2b_sub', 'customer') then
    return jsonb_build_object(
      'ok', false, 'code', 'INVALID_IMPORT_ASSIGNEE'
    );
  end if;
  if v_target_role in ('b2b', 'b2b_sub') then
    if nullif(btrim(v_agency_code), '') is null then
      return jsonb_build_object(
        'ok', false, 'code', 'ASSIGNEE_AGENCY_REQUIRED'
      );
    end if;
    v_owner_type := 'agency';
    v_owner_key := v_agency_code;
    v_audience := 'agency';
  else
    v_owner_type := 'user';
    v_owner_key := p_assigned_user_id;
    v_audience := 'b2c';
    v_agency_code := null;
  end if;

  v_supplier_account := nullif(btrim(p_data->>'supplierAccount'), '');
  v_supplier_reference := nullif(btrim(p_data->>'supplierReference'), '');
  v_currency := upper(coalesce(nullif(btrim(p_data->>'currency'), ''), 'BDT'));
  v_traveller_count := case
    when jsonb_typeof(p_data #> '{passengers,travellers}') = 'array'
      then jsonb_array_length(p_data #> '{passengers,travellers}')
    else 0
  end;
  if v_supplier_account not in ('firsttrip', 'takeoff')
     or v_supplier_reference is null
     or (v_supplier_account = 'firsttrip'
       and v_supplier_reference !~ '^FST[0-9]{18}$')
     or (v_supplier_account = 'takeoff'
       and v_supplier_reference !~ '^TOT[0-9]{18}$')
     or p_data #>> '{supplierRefs,uniqueTransId}'
        is distinct from v_supplier_reference
     or p_data->>'lifecycleStatus' is distinct from 'confirmed'
     or p_data->>'storedStatus' is distinct from 'confirmed'
     or v_currency <> 'BDT'
     or p_data->>'pricingMode' is distinct from 'import_time_current_markup'
     or nullif(p_data->>'pricingCalculatedAt', '') is null
     or nullif(p_data->>'supplierEvidenceTimestamp', '') is null
     or p_data->>'supplierEvidenceTimestamp' is distinct from p_data->>'retrievedAt'
     or jsonb_typeof(p_data->'supplierFares') <> 'array'
     or jsonb_typeof(p_data->'pricingRoutes') <> 'array'
     or coalesce(p_data->>'pricingCarrierCode', '') !~ '^[A-Z0-9]{2}$'
     or jsonb_typeof(p_data->'pricingSnapshot') <> 'object'
     or jsonb_typeof(p_data #> '{pricingSnapshot,components}') <> 'array'
     or p_data #>> '{pricingSnapshot,audience}' is distinct from v_audience
     or p_data #>> '{pricingSnapshot,agencyCode}' is distinct from v_agency_code
     or public.supplier_reference_money_minor_v1(
          p_data #> '{pricingSnapshot,sellingPrice}'
        ) is distinct from p_user_payable_amount
     or public.supplier_reference_money_minor_v1(p_data->'supplierGross')
        is distinct from p_supplier_gross_amount
     or public.supplier_reference_money_minor_v1(
          p_data #> '{pricingSnapshot,grossPrice}'
        ) is distinct from p_supplier_gross_amount
     or public.supplier_reference_money_minor_v1(p_data->'supplierPayable')
        is distinct from public.supplier_reference_money_minor_v1(
          p_data #> '{pricingSnapshot,supplierTotalPrice}'
        ) then
    return jsonb_build_object(
      'ok', false, 'code', 'CHARGE_NOT_APPLICABLE'
    );
  end if;
  if v_traveller_count <= 0
     or jsonb_typeof(p_data->'ticketNumbers') <> 'array'
     or jsonb_array_length(case
          when jsonb_typeof(p_data->'ticketNumbers') = 'array'
            then p_data->'ticketNumbers' else '[]'::jsonb end)
        <> v_traveller_count
     or exists (
       select 1
         from jsonb_array_elements(case
           when jsonb_typeof(p_data->'ticketNumbers') = 'array'
             then p_data->'ticketNumbers' else '[]'::jsonb end) ticket(value)
        where jsonb_typeof(ticket.value) <> 'string'
           or nullif(btrim(ticket.value #>> '{}'), '') is null
     )
     or (select count(distinct ticket.value #>> '{}')
           from jsonb_array_elements(case
             when jsonb_typeof(p_data->'ticketNumbers') = 'array'
               then p_data->'ticketNumbers' else '[]'::jsonb end) ticket(value))
        <> v_traveller_count then
    return jsonb_build_object(
      'ok', false, 'code', 'COMPLETE_TICKET_EVIDENCE_REQUIRED'
    );
  end if;

  v_payload_hash := public.supplier_reference_import_payload_hash_v1(
    p_assigned_user_id,
    p_user_payable_amount,
    p_supplier_gross_amount,
    p_data
  );
  select * into v_existing
    from public.supplier_reference_charge_authorizations charge_auth
   where charge_auth.request_key = p_request_key
   for update;
  if found then
    if v_existing.actor_user_id = p_actor_user_id
       and v_existing.assigned_user_id = p_assigned_user_id
       and v_existing.authorization_payload_hash = v_payload_hash then
      return jsonb_build_object(
        'ok', true,
        'replay', true,
        'authorizationId', v_existing.id,
        'expiresAt', v_existing.expires_at,
        'consumed', v_existing.consumed_at is not null,
        'amount', v_existing.user_payable_amount,
        'currency', v_existing.currency
      );
    end if;
    raise exception 'supplier-reference charge request identity mismatch'
      using errcode = '22023';
  end if;

  select * into v_wallet
    from public.wallets wallet
   where wallet.owner_type = v_owner_type
     and wallet.owner_key = v_owner_key;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND');
  end if;
  select * into v_account
    from public.wallet_accounts account
   where account.wallet_id = v_wallet.id
     and account.currency = v_currency;
  if not found then
    return jsonb_build_object(
      'ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND'
    );
  end if;
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

  insert into public.supplier_reference_charge_authorizations (
    request_key, actor_user_id, actor_role, assigned_user_id,
    owner_type, owner_key, supplier_account, supplier_reference,
    currency, user_payable_amount, supplier_gross_amount,
    authorization_payload_hash, authorized_at, expires_at
  ) values (
    p_request_key, p_actor_user_id, v_actor_role, p_assigned_user_id,
    v_owner_type, v_owner_key, v_supplier_account, v_supplier_reference,
    v_currency, p_user_payable_amount, p_supplier_gross_amount,
    v_payload_hash, v_now, v_now + interval '5 minutes'
  ) returning * into v_authorization;

  return jsonb_build_object(
    'ok', true,
    'replay', false,
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

create or replace function public.create_supplier_reference_booking_v1(
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
  v_audience text;
  v_owner_type text;
  v_owner_key text;
  v_supplier_account text;
  v_supplier_reference text;
  v_currency text;
  v_status text;
  v_payload_hash text;
  v_traveller_count integer;
  v_existing public.flight_bookings;
  v_authorization public.supplier_reference_charge_authorizations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_booking public.flight_bookings;
  v_reservation public.wallet_reservations;
  v_attempt_id uuid := gen_random_uuid();
  v_booking_id uuid := gen_random_uuid();
  v_search_id uuid := gen_random_uuid();
  v_public_ref text;
  v_available_before bigint;
  v_hold_before bigint;
  v_created_at timestamptz;
  v_issued_at timestamptz;
  v_cancelled_at timestamptz;
  v_deadline_at timestamptz;
  v_effective_at timestamptz;
  v_pricing jsonb;
  v_wallet_charged boolean := false;
begin
  if p_data is null
     or jsonb_typeof(p_data) <> 'object'
     or nullif(btrim(coalesce(p_actor_user_id, '')), '') is null
     or nullif(btrim(coalesce(p_assigned_user_id, '')), '') is null
     or p_user_payable_amount is null or p_user_payable_amount <= 0
     or p_supplier_gross_amount is null or p_supplier_gross_amount <= 0
     or p_import_decision not in ('import_only', 'import_and_charge')
     or p_request_key
        !~ '^supplier-reference-import:v1:[0-9a-f-]{36}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_DATA');
  end if;

  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role is null
     or v_actor_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object(
      'ok', false, 'code', 'SUPPLIER_REFERENCE_IMPORT_FORBIDDEN'
    );
  end if;
  select role, agency_code into v_target_role, v_agency_code
    from public.app_users
   where clerk_id = p_assigned_user_id;
  if not found or v_target_role not in ('b2b', 'b2b_sub', 'customer') then
    return jsonb_build_object(
      'ok', false, 'code', 'INVALID_IMPORT_ASSIGNEE'
    );
  end if;
  if v_target_role in ('b2b', 'b2b_sub') then
    if nullif(btrim(v_agency_code), '') is null then
      return jsonb_build_object(
        'ok', false, 'code', 'ASSIGNEE_AGENCY_REQUIRED'
      );
    end if;
    v_owner_type := 'agency';
    v_owner_key := v_agency_code;
    v_audience := 'agency';
  else
    v_owner_type := 'user';
    v_owner_key := p_assigned_user_id;
    v_audience := 'b2c';
    v_agency_code := null;
  end if;

  v_supplier_account := nullif(btrim(p_data->>'supplierAccount'), '');
  v_supplier_reference := nullif(btrim(p_data->>'supplierReference'), '');
  v_currency := upper(coalesce(nullif(btrim(p_data->>'currency'), ''), 'BDT'));
  v_status := nullif(btrim(p_data->>'storedStatus'), '');
  v_traveller_count := case
    when jsonb_typeof(p_data #> '{passengers,travellers}') = 'array'
      then jsonb_array_length(p_data #> '{passengers,travellers}')
    else 0
  end;
  if v_supplier_account not in ('firsttrip', 'takeoff')
     or v_supplier_reference is null
     or (v_supplier_account = 'firsttrip'
       and v_supplier_reference !~ '^FST[0-9]{18}$')
     or (v_supplier_account = 'takeoff'
       and v_supplier_reference !~ '^TOT[0-9]{18}$')
     or p_data #>> '{supplierRefs,uniqueTransId}'
        is distinct from v_supplier_reference
     or p_data->>'lifecycleStatus' is distinct from v_status
     or v_status not in ('on-hold', 'confirmed', 'cancelled')
     or v_currency <> 'BDT'
     or p_data->>'pricingMode' is distinct from 'import_time_current_markup'
     or nullif(p_data->>'pricingCalculatedAt', '') is null
     or nullif(p_data->>'supplierEvidenceTimestamp', '') is null
     or p_data->>'supplierEvidenceTimestamp' is distinct from p_data->>'retrievedAt'
     or jsonb_typeof(p_data->'pricingRoutes') <> 'array'
     or coalesce(p_data->>'pricingCarrierCode', '') !~ '^[A-Z0-9]{2}$'
     or jsonb_typeof(p_data->'pricingSnapshot') <> 'object'
     or jsonb_typeof(p_data #> '{pricingSnapshot,components}') <> 'array'
     or p_data #>> '{pricingSnapshot,audience}' is distinct from v_audience
     or p_data #>> '{pricingSnapshot,agencyCode}' is distinct from v_agency_code
     or public.supplier_reference_money_minor_v1(
          p_data #> '{pricingSnapshot,sellingPrice}'
        ) is distinct from p_user_payable_amount
     or public.supplier_reference_money_minor_v1(p_data->'supplierGross')
        is distinct from p_supplier_gross_amount
     or public.supplier_reference_money_minor_v1(
          p_data #> '{pricingSnapshot,grossPrice}'
        ) is distinct from p_supplier_gross_amount
     or public.supplier_reference_money_minor_v1(p_data->'supplierPayable')
        is distinct from public.supplier_reference_money_minor_v1(
          p_data #> '{pricingSnapshot,supplierTotalPrice}'
        ) then
    return jsonb_build_object(
      'ok', false, 'code', 'INVALID_SUPPLIER_REFERENCE_IDENTITY'
    );
  end if;
  if v_status <> 'confirmed'
     and (p_import_decision <> 'import_only'
       or p_charge_authorization_id is not null) then
    return jsonb_build_object(
      'ok', false, 'code', 'CHARGE_DECISION_NOT_APPLICABLE'
    );
  end if;
  if p_import_decision = 'import_and_charge'
     and (v_status <> 'confirmed' or p_charge_authorization_id is null) then
    return jsonb_build_object(
      'ok', false, 'code', 'FRESH_MATCHING_CHARGE_AUTHORIZATION_REQUIRED'
    );
  end if;
  if p_import_decision = 'import_only'
     and p_charge_authorization_id is not null then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_DATA');
  end if;

  if v_traveller_count <= 0
     or jsonb_typeof(p_data->'passengerCounts') <> 'object'
     or jsonb_typeof(p_data->'itinerary') <> 'object'
     or jsonb_typeof(p_data->'fares') <> 'array'
     or jsonb_typeof(p_data->'supplierFares') <> 'array'
     or jsonb_typeof(p_data->'airlinesPnr') <> 'array'
     or jsonb_array_length(case
          when jsonb_typeof(p_data->'airlinesPnr') = 'array'
            then p_data->'airlinesPnr' else '[]'::jsonb end) = 0
     or coalesce(p_data->>'travelDate', '')
        !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     or nullif(btrim(p_data->>'pnr'), '') is null
     or nullif(btrim(p_data->>'bookingRefNumber'), '') is null
     or nullif(btrim(p_data->>'bookingCodeRef'), '') is null
     or nullif(btrim(p_data #>> '{supplierRefs,itemCodeRef}'), '') is null
     or nullif(btrim(p_data #>> '{supplierRefs,priceCodeRef}'), '') is null then
    return jsonb_build_object(
      'ok', false, 'code', 'OPERATIONAL_REFERENCES_INCOMPLETE'
    );
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_data->'airlinesPnr') airline(value)
     where jsonb_typeof(airline.value) <> 'string'
        or nullif(btrim(airline.value #>> '{}'), '') is null
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'OPERATIONAL_REFERENCES_INCOMPLETE'
    );
  end if;
  if v_status = 'confirmed' and (
    jsonb_typeof(p_data->'ticketNumbers') <> 'array'
    or jsonb_array_length(case
         when jsonb_typeof(p_data->'ticketNumbers') = 'array'
           then p_data->'ticketNumbers' else '[]'::jsonb end)
       <> v_traveller_count
    or exists (
      select 1
        from jsonb_array_elements(case
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
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'COMPLETE_TICKET_EVIDENCE_REQUIRED'
    );
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'SUPPLIER_REFERENCE:' || v_supplier_account || ':' || v_supplier_reference,
    0
  ));
  select * into v_existing
    from public.flight_bookings booking
   where booking.supplier_account = v_supplier_account
     and booking.supplier_refs->>'uniqueTransId' = v_supplier_reference
   limit 1
   for update;
  if found then
    if v_existing.booking_origin = 'supplier_reference_import'
       and v_existing.import_metadata->>'importRequestKey' = p_request_key
       and v_existing.user_id is not distinct from p_assigned_user_id
       and v_existing.booking_owner_type is not distinct from v_owner_type
       and v_existing.booking_owner_key is not distinct from v_owner_key
       and v_existing.user_payable_amount = p_user_payable_amount
       and v_existing.import_metadata->>'importDecision'
         = p_import_decision then
      return jsonb_build_object(
        'ok', true,
        'replay', true,
        'booking', to_jsonb(v_existing),
        'walletCharged', v_existing.payment_state = 'captured',
        'amount', case when v_existing.payment_state = 'captured'
          then v_existing.captured_amount else 0 end,
        'currency', v_existing.currency,
        'accountId', v_existing.charged_wallet_account_id,
        'importDecision', p_import_decision
      );
    end if;
    if v_existing.user_id is distinct from p_assigned_user_id
       or v_existing.booking_owner_type is distinct from v_owner_type
       or v_existing.booking_owner_key is distinct from v_owner_key then
      return jsonb_build_object(
        'ok', false, 'code', 'IMPORT_ASSIGNEE_MISMATCH'
      );
    end if;
    if v_existing.user_payable_amount is distinct from p_user_payable_amount then
      return jsonb_build_object(
        'ok', false, 'code', 'IMPORT_PAYABLE_MISMATCH'
      );
    end if;
    return jsonb_build_object(
      'ok', false, 'code', 'SUPPLIER_REFERENCE_ALREADY_EXISTS'
    );
  end if;

  v_payload_hash := public.supplier_reference_import_payload_hash_v1(
    p_assigned_user_id,
    p_user_payable_amount,
    p_supplier_gross_amount,
    p_data
  );
  if p_import_decision = 'import_and_charge' then
    select * into v_authorization
      from public.supplier_reference_charge_authorizations charge_auth
     where charge_auth.id = p_charge_authorization_id
     for update;
    if not found
       or v_authorization.actor_user_id <> p_actor_user_id
       or v_authorization.assigned_user_id <> p_assigned_user_id
       or v_authorization.owner_type <> v_owner_type
       or v_authorization.owner_key <> v_owner_key
       or v_authorization.supplier_account <> v_supplier_account
       or v_authorization.supplier_reference <> v_supplier_reference
       or v_authorization.currency <> v_currency
       or v_authorization.user_payable_amount <> p_user_payable_amount
       or v_authorization.supplier_gross_amount <> p_supplier_gross_amount
       or v_authorization.authorization_payload_hash <> v_payload_hash
       or v_authorization.expires_at < clock_timestamp()
       or v_authorization.consumed_at is not null then
      return jsonb_build_object(
        'ok', false,
        'code', 'FRESH_MATCHING_CHARGE_AUTHORIZATION_REQUIRED'
      );
    end if;

    select * into v_wallet
      from public.wallets wallet
     where wallet.owner_type = v_owner_type
       and wallet.owner_key = v_owner_key
     for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'WALLET_NOT_FOUND');
    end if;
    select * into v_account
      from public.wallet_accounts account
     where account.wallet_id = v_wallet.id
       and account.currency = v_currency
     for update;
    if not found then
      return jsonb_build_object(
        'ok', false, 'code', 'WALLET_ACCOUNT_NOT_FOUND'
      );
    end if;
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
    v_available_before := v_account.available_balance;
    v_hold_before := v_account.hold_balance;
    v_wallet_charged := true;
  end if;

  begin
    v_created_at := coalesce(
      nullif(p_data->>'bookedAt', '')::timestamptz,
      clock_timestamp()
    );
    v_issued_at := nullif(p_data->>'issuedAt', '')::timestamptz;
    v_cancelled_at := nullif(p_data->>'cancelledAt', '')::timestamptz;
    v_deadline_at := nullif(p_data->>'ticketingDeadlineAt', '')::timestamptz;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_IMPORT_DATA');
  end;

  v_public_ref := public.allocate_booking_ref();
  v_pricing := p_data->'pricingSnapshot';

  insert into public.booking_attempts (
    id, access_token_hash, user_id, audience, agency_code,
    supplier, state, search_id, itinerary_id,
    unique_trans_id, item_code_ref, price_code_ref,
    booking_code_ref, pnr, offer_snapshot, passenger_snapshot,
    expires_at, submitted_at, resolved_at, created_at,
    supplier_account, created_by_user_id, staff_on_behalf
  ) values (
    v_attempt_id,
    encode(sha256(convert_to(
      'supplier-reference:' || v_supplier_account || ':' || v_supplier_reference,
      'UTF8'
    )), 'hex'),
    p_assigned_user_id, v_audience, v_agency_code,
    'triplover', 'succeeded', v_search_id,
    'supplier-reference:' || v_supplier_account || ':' || v_supplier_reference,
    v_supplier_reference,
    p_data #>> '{supplierRefs,itemCodeRef}',
    p_data #>> '{supplierRefs,priceCodeRef}',
    p_data->>'bookingCodeRef', p_data->>'pnr',
    jsonb_build_object(
      'itinerary', p_data->'itinerary',
      'fares', p_data->'fares',
      'supplierFareEvidence', p_data->'supplierFares',
      'currency', v_currency,
      'pricing', v_pricing,
      'passengerCounts', p_data->'passengerCounts',
      'travelDate', p_data->>'travelDate',
      'directTicketing', coalesce((p_data->>'directTicketing')::boolean, false),
      'passportRequired', coalesce((p_data->>'passportRequired')::boolean, true),
      'repricedAt', p_data->>'pricingCalculatedAt',
      'pricingMode', p_data->>'pricingMode',
      'supplierPayable', p_data->'supplierPayable',
      'supplierGross', p_data->'supplierGross',
      'supplierDiscount', p_data->'supplierDiscount',
      'supplierEvidenceTimestamp', p_data->>'supplierEvidenceTimestamp',
      'bookingOrigin', 'supplier_reference_import'
    ),
    p_data->'passengers',
    coalesce(v_deadline_at, v_created_at),
    v_created_at, clock_timestamp(), v_created_at,
    v_supplier_account, p_actor_user_id, false
  );

  if v_wallet_charged then
    update public.wallet_accounts
       set available_balance = available_balance - p_user_payable_amount
     where id = v_account.id;
  end if;

  perform set_config('app.skip_initial_booking_status_event', 'true', true);
  insert into public.flight_bookings (
    id, public_ref, attempt_id, supplier, user_id, audience, agency_code,
    search_id, itinerary_id, status, currency, pricing_snapshot,
    passenger_counts, travel_date, direct_ticketing, itinerary, fares,
    passport_required, supplier_refs, repriced_at, accepted_at, passengers,
    pnr, airlines_pnr, booking_ref_number, booking_status,
    ticketing_time_limit, ticketing_deadline_at, deadline_source,
    supplier_ticketing_time_limit, supplier_ticketing_deadline_at,
    supplier_deadline_source, booking_code_ref, ticket_code_ref,
    ticket_numbers, warnings, supplier_message, issued_at, cancelled_at,
    submission_started_at, legacy_operational, booked_by_user_id,
    issued_by_user_id, booking_owner_type, booking_owner_key,
    charged_wallet_account_id, payment_state, payment_amount,
    captured_amount, refunded_amount, supplier_gross_amount,
    user_payable_amount, import_source, imported_by_user_id,
    import_metadata, booking_origin, synced_at, created_at
  ) values (
    v_booking_id, v_public_ref, v_attempt_id, 'triplover',
    p_assigned_user_id, v_audience, v_agency_code,
    v_search_id,
    'supplier-reference:' || v_supplier_account || ':' || v_supplier_reference,
    v_status, v_currency, v_pricing,
    p_data->'passengerCounts', (p_data->>'travelDate')::date,
    coalesce((p_data->>'directTicketing')::boolean, false),
    p_data->'itinerary', p_data->'fares',
    coalesce((p_data->>'passportRequired')::boolean, true),
    p_data->'supplierRefs',
    coalesce(nullif(p_data->>'pricingCalculatedAt', '')::timestamptz, clock_timestamp()),
    v_created_at, p_data->'passengers',
    p_data->>'pnr', p_data->'airlinesPnr', p_data->>'bookingRefNumber',
    p_data->>'supplierStatus', nullif(p_data->>'ticketingTimeLimit', ''),
    v_deadline_at, case when v_deadline_at is not null then 'pnr_call' end,
    nullif(p_data->>'ticketingTimeLimit', ''), v_deadline_at,
    case when v_deadline_at is not null then 'pnr_call' end,
    p_data->>'bookingCodeRef', nullif(p_data->>'ticketCodeRef', ''),
    coalesce(p_data->'ticketNumbers', '[]'::jsonb), '[]'::jsonb,
    nullif(p_data->>'supplierMessage', ''), v_issued_at, v_cancelled_at,
    v_created_at, false, p_actor_user_id, null,
    v_owner_type, v_owner_key,
    case when v_wallet_charged then v_account.id else null end,
    case when v_wallet_charged then 'captured' else 'unpaid' end,
    case when v_wallet_charged then p_user_payable_amount else null end,
    case when v_wallet_charged then p_user_payable_amount else 0 end,
    0, p_supplier_gross_amount, p_user_payable_amount,
    null, p_actor_user_id,
    jsonb_build_object(
      'source', 'supplier_reference_import',
      'supplierAccount', v_supplier_account,
      'supplierReference', v_supplier_reference,
      'supplierBookingId', p_data->'supplierBookingId',
      'importRequestKey', p_request_key,
      'importDecision', p_import_decision,
      'walletCharged', v_wallet_charged,
      'retrievedAt', p_data->>'retrievedAt',
      'pricingMode', p_data->>'pricingMode',
      'pricingCalculatedAt', p_data->>'pricingCalculatedAt',
      'supplierEvidenceTimestamp', p_data->>'supplierEvidenceTimestamp',
      'supplierPayable', p_data->'supplierPayable',
      'supplierGross', p_data->'supplierGross',
      'supplierDiscount', p_data->'supplierDiscount',
      'pricingCarrierCode', p_data->>'pricingCarrierCode',
      'pricingRoutes', p_data->'pricingRoutes',
      'canonicalPricingSnapshot', p_data->'pricingSnapshot',
      'supplierFareEvidence', p_data->'supplierFares'
    ),
    'supplier_reference_import',
    coalesce(nullif(p_data->>'retrievedAt', '')::timestamptz, clock_timestamp()),
    v_created_at
  ) returning * into v_booking;

  if v_wallet_charged then
    insert into public.wallet_reservations (
      wallet_account_id, booking_id, amount, currency, state,
      requested_by_user_id, issued_by_user_id, captured_at
    ) values (
      v_account.id, v_booking.id, p_user_payable_amount, v_currency,
      'captured', p_actor_user_id, p_actor_user_id, clock_timestamp()
    ) returning * into v_reservation;

    insert into public.wallet_ledger_entries (
      wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after,
      booking_id, booking_reference, reservation_id, idempotency_key,
      created_by_user_id, created_by_role, remarks, metadata
    ) values (
      v_account.id, 'booking_confirm', p_user_payable_amount, v_currency,
      v_available_before, v_available_before - p_user_payable_amount,
      v_hold_before, v_hold_before,
      v_booking.id, v_booking.public_ref, v_reservation.id,
      'supplier-reference-payment:' || v_booking.id::text,
      p_actor_user_id, v_actor_role,
      'Explicitly authorized supplier-reference Import & Charge',
      jsonb_build_object(
        'bookingOrigin', 'supplier_reference_import',
        'supplierAccount', v_supplier_account,
        'supplierReference', v_supplier_reference,
        'supplierGrossAmount', p_supplier_gross_amount,
        'supplierPayableAmount', public.supplier_reference_money_minor_v1(
          p_data->'supplierPayable'
        ),
        'userPayableAmount', p_user_payable_amount,
        'pricingMode', p_data->>'pricingMode',
        'importDecision', p_import_decision,
        'chargeAuthorizationId', v_authorization.id
      )
    );

    update public.supplier_reference_charge_authorizations
       set consumed_at = clock_timestamp(),
           consumed_booking_id = v_booking.id
     where id = v_authorization.id;
  end if;

  v_effective_at := case v_status
    when 'confirmed' then v_issued_at
    when 'cancelled' then v_cancelled_at
    else v_created_at
  end;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after,
    actor_user_id, supplier_operation, supplier_evidence,
    idempotency_key, occurrence_number, effective_at, observed_at,
    event_snapshot, event_version
  ) values (
    v_booking.id, null,
    public.resolve_booking_lifecycle(
      v_booking.status, v_booking.airlines_pnr,
      v_booking.ticketing_deadline_at, v_booking.operation_kind
    ),
    null, v_booking.status,
    p_actor_user_id, 'SupplierReferenceImport',
    jsonb_build_object(
      'bookingOrigin', 'supplier_reference_import',
      'supplierAccount', v_supplier_account,
      'supplierReference', v_supplier_reference,
      'supplierStatus', p_data->>'supplierStatus',
      'walletCharged', v_wallet_charged,
      'importDecision', p_import_decision
      ,'pricingMode', p_data->>'pricingMode'
      ,'pricingCalculatedAt', p_data->>'pricingCalculatedAt'
      ,'supplierEvidenceTimestamp', p_data->>'supplierEvidenceTimestamp'
      ,'supplierPayable', p_data->'supplierPayable'
      ,'supplierGross', p_data->'supplierGross'
      ,'supplierDiscount', p_data->'supplierDiscount'
      ,'canonicalPricingSnapshot', p_data->'pricingSnapshot'
    ),
    p_request_key || ':created', 1, v_effective_at, clock_timestamp(),
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'lifecycleStatus', public.resolve_booking_lifecycle(
        v_booking.status, v_booking.airlines_pnr,
        v_booking.ticketing_deadline_at, v_booking.operation_kind
      ),
      'paymentState', v_booking.payment_state,
      'operationSource', 'supplier_reference_import',
      'bookingOrigin', 'supplier_reference_import',
      'supplierAccount', v_supplier_account,
      'importDecision', p_import_decision,
      'userPayableAmount', p_user_payable_amount,
      'currency', v_currency
    ), 1
  );

  return jsonb_build_object(
    'ok', true,
    'replay', false,
    'booking', to_jsonb(v_booking),
    'walletCharged', v_wallet_charged,
    'amount', case when v_wallet_charged then p_user_payable_amount else 0 end,
    'currency', v_currency,
    'accountId', case when v_wallet_charged then v_account.id else null end,
    'importDecision', p_import_decision
  );
end;
$$;

revoke all on function public.supplier_reference_import_payload_hash_v1(
  text, bigint, bigint, jsonb
) from public, anon, authenticated;
revoke all on function public.supplier_reference_money_minor_v1(jsonb)
  from public, anon, authenticated;
revoke all on function public.authorize_supplier_reference_charge_v1(
  text, text, bigint, bigint, jsonb, text
) from public, anon, authenticated;
revoke all on function public.create_supplier_reference_booking_v1(
  text, text, bigint, bigint, jsonb, text, uuid, text
) from public, anon, authenticated;

grant execute on function public.authorize_supplier_reference_charge_v1(
  text, text, bigint, bigint, jsonb, text
) to service_role;
grant execute on function public.create_supplier_reference_booking_v1(
  text, text, bigint, bigint, jsonb, text, uuid, text
) to service_role;

comment on function public.authorize_supplier_reference_charge_v1(
  text, text, bigint, bigint, jsonb, text
) is
  'Records a five-minute, one-use, exact-payload authorization after checking the assigned owner wallet. It never mutates wallet money or creates a booking.';
comment on function public.create_supplier_reference_booking_v1(
  text, text, bigint, bigint, jsonb, text, uuid, text
) is
  'Atomically creates an ordinary Triplover API-backed booking from real FirstTrip/TakeOff references. Held and terminal historical imports make no wallet movement; explicit confirmed Import & Charge consumes one fresh authorization and writes the captured reservation and immutable ledger in the same transaction.';
