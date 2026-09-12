-- Shopon Travels International — authoritative wallet and payment ledger.
--
-- Money is stored in integer minor units. Every mutation locks the affected
-- currency account, changes its balances and appends an immutable ledger row
-- in the same transaction. The service role is the only database principal
-- allowed to use this module; application routes add the role/ownership gates.

-- 1. Wallet ownership and currency accounts ---------------------------------

create table if not exists public.wallets (
  id          uuid primary key default gen_random_uuid(),
  owner_type  text not null check (owner_type in ('user', 'agency')),
  -- Durable external owner key: Clerk user id or agencies.agency_code. It is
  -- intentionally not a foreign key so financial history survives deletion
  -- or replacement of an identity-provider record.
  owner_key   text not null check (char_length(owner_key) between 1 and 255),
  status      text not null default 'active'
              check (status in ('active', 'frozen')),
  frozen_at   timestamptz,
  frozen_by   text,
  freeze_reason text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (owner_type, owner_key)
);

create table if not exists public.wallet_accounts (
  id                uuid primary key default gen_random_uuid(),
  wallet_id         uuid not null references public.wallets (id) on delete restrict,
  currency          text not null check (currency ~ '^[A-Z]{3}$'),
  available_balance bigint not null default 0 check (available_balance >= 0),
  hold_balance      bigint not null default 0 check (hold_balance >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (wallet_id, currency)
);

create index if not exists wallets_status_idx
  on public.wallets (status, updated_at desc);
create index if not exists wallet_accounts_wallet_idx
  on public.wallet_accounts (wallet_id, currency);

drop trigger if exists wallets_touch_updated_at on public.wallets;
create trigger wallets_touch_updated_at
  before update on public.wallets
  for each row execute function public.touch_updated_at();

drop trigger if exists wallet_accounts_touch_updated_at on public.wallet_accounts;
create trigger wallet_accounts_touch_updated_at
  before update on public.wallet_accounts
  for each row execute function public.touch_updated_at();

-- 2. Booking ownership and payment state ------------------------------------

alter table public.flight_bookings
  add column if not exists booking_owner_type text
    check (booking_owner_type in ('user', 'agency')),
  add column if not exists booking_owner_key text,
  add column if not exists booked_by_user_id text,
  add column if not exists issued_by_user_id text,
  add column if not exists charged_wallet_account_id uuid
    references public.wallet_accounts (id) on delete restrict,
  add column if not exists payment_state text not null default 'unpaid'
    check (payment_state in (
      'unpaid', 'held', 'captured', 'released', 'reconciliation',
      'partially-refunded', 'refunded'
    )),
  add column if not exists payment_amount bigint,
  add column if not exists captured_amount bigint not null default 0
    check (captured_amount >= 0),
  add column if not exists refunded_amount bigint not null default 0
    check (refunded_amount >= 0 and refunded_amount <= captured_amount);

create index if not exists flight_bookings_wallet_account_idx
  on public.flight_bookings (charged_wallet_account_id, created_at desc);
create index if not exists flight_bookings_owner_idx
  on public.flight_bookings (booking_owner_type, booking_owner_key, created_at desc);

-- Existing rows used user_id as the creator. Agency rows belong financially
-- to the agency; B2C rows belong to that user. Legacy Super Admin rows are left
-- ownerless and therefore cannot be charged until explicitly reconciled.
update public.flight_bookings
   set booked_by_user_id = coalesce(booked_by_user_id, user_id),
       booking_owner_type = coalesce(
         booking_owner_type,
         case
           when audience = 'agency' and agency_code is not null then 'agency'
           when audience = 'b2c' and user_id is not null then 'user'
         end
       ),
       booking_owner_key = coalesce(
         booking_owner_key,
         case
           when audience = 'agency' and agency_code is not null then agency_code
           when audience = 'b2c' and user_id is not null then user_id
         end
       )
 where booked_by_user_id is null
    or booking_owner_type is null
    or booking_owner_key is null;

create or replace function public.set_booking_wallet_ownership()
returns trigger
language plpgsql
as $$
begin
  new.booked_by_user_id := coalesce(new.booked_by_user_id, new.user_id);
  if new.booking_owner_type is null or new.booking_owner_key is null then
    if new.audience = 'agency' and new.agency_code is not null then
      new.booking_owner_type := 'agency';
      new.booking_owner_key := new.agency_code;
    elsif new.audience = 'b2c' and new.user_id is not null then
      new.booking_owner_type := 'user';
      new.booking_owner_key := new.user_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists flight_bookings_set_wallet_ownership
  on public.flight_bookings;
create trigger flight_bookings_set_wallet_ownership
  before insert or update of audience, agency_code, user_id,
    booking_owner_type, booking_owner_key, booked_by_user_id
  on public.flight_bookings
  for each row execute function public.set_booking_wallet_ownership();

-- 3. Reservations and immutable ledger --------------------------------------

create table if not exists public.wallet_reservations (
  id                       uuid primary key default gen_random_uuid(),
  wallet_account_id        uuid not null
                            references public.wallet_accounts (id) on delete restrict,
  booking_id               uuid references public.flight_bookings (id) on delete restrict,
  booking_attempt_id       uuid references public.booking_attempts (id) on delete restrict,
  amount                   bigint not null check (amount > 0),
  currency                 text not null check (currency ~ '^[A-Z]{3}$'),
  state                    text not null default 'active'
                           check (state in ('active', 'captured', 'released', 'reconciliation')),
  cycle                    integer not null default 1 check (cycle > 0),
  requested_by_user_id     text not null,
  issued_by_user_id        text,
  supplier_call_started_at timestamptz,
  captured_at              timestamptz,
  released_at              timestamptz,
  reconciliation_at        timestamptz,
  reconciliation_reason    text,
  release_reason           text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check ((booking_id is not null)::integer +
         (booking_attempt_id is not null)::integer = 1)
);

create unique index if not exists wallet_reservations_booking_key
  on public.wallet_reservations (booking_id) where booking_id is not null;
create unique index if not exists wallet_reservations_attempt_key
  on public.wallet_reservations (booking_attempt_id)
  where booking_attempt_id is not null;
create index if not exists wallet_reservations_state_idx
  on public.wallet_reservations (state, updated_at desc);

drop trigger if exists wallet_reservations_touch_updated_at
  on public.wallet_reservations;
create trigger wallet_reservations_touch_updated_at
  before update on public.wallet_reservations
  for each row execute function public.touch_updated_at();

create table if not exists public.wallet_ledger_entries (
  id               uuid primary key default gen_random_uuid(),
  wallet_account_id uuid not null
                    references public.wallet_accounts (id) on delete restrict,
  transaction_type text not null check (transaction_type in (
    'deposit', 'booking_hold', 'booking_confirm', 'hold_release', 'refund',
    'manual_credit', 'manual_debit', 'adjustment', 'reversal'
  )),
  amount           bigint not null check (amount > 0),
  currency         text not null check (currency ~ '^[A-Z]{3}$'),
  available_before bigint not null check (available_before >= 0),
  available_after  bigint not null check (available_after >= 0),
  hold_before      bigint not null check (hold_before >= 0),
  hold_after       bigint not null check (hold_after >= 0),
  booking_id       uuid references public.flight_bookings (id) on delete restrict,
  booking_reference text,
  reservation_id   uuid references public.wallet_reservations (id) on delete restrict,
  related_entry_id uuid references public.wallet_ledger_entries (id) on delete restrict,
  idempotency_key  text not null unique
                   check (char_length(idempotency_key) between 1 and 255),
  created_by_user_id text not null,
  created_by_role  text not null,
  remarks          text,
  metadata         jsonb not null default '{}'::jsonb
                   check (jsonb_typeof(metadata) = 'object'),
  created_at       timestamptz not null default now()
);

create index if not exists wallet_ledger_account_created_idx
  on public.wallet_ledger_entries (wallet_account_id, created_at desc);
create index if not exists wallet_ledger_booking_created_idx
  on public.wallet_ledger_entries (booking_id, created_at desc);
create index if not exists wallet_ledger_type_created_idx
  on public.wallet_ledger_entries (transaction_type, created_at desc);

create or replace function public.prevent_wallet_ledger_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'wallet ledger entries are immutable' using errcode = '55000';
end;
$$;

drop trigger if exists wallet_ledger_immutable on public.wallet_ledger_entries;
create trigger wallet_ledger_immutable
  before update or delete on public.wallet_ledger_entries
  for each row execute function public.prevent_wallet_ledger_mutation();

-- 4. Deposit and maker-checker adjustment workflows ------------------------

create table if not exists public.wallet_deposit_requests (
  id                 uuid primary key default gen_random_uuid(),
  wallet_account_id  uuid not null
                     references public.wallet_accounts (id) on delete restrict,
  amount             bigint not null check (amount > 0),
  currency           text not null check (currency ~ '^[A-Z]{3}$'),
  method             text not null check (method in ('cash', 'bank', 'mobile')),
  reference_number   text,
  remarks            text,
  status             text not null default 'pending'
                     check (status in ('pending', 'approved', 'rejected')),
  requested_by_user_id text not null,
  reviewed_by_user_id  text,
  review_remarks       text,
  ledger_entry_id      uuid references public.wallet_ledger_entries (id) on delete restrict,
  requested_at         timestamptz not null default now(),
  reviewed_at          timestamptz,
  updated_at           timestamptz not null default now()
);

create table if not exists public.wallet_adjustment_requests (
  id                  uuid primary key default gen_random_uuid(),
  wallet_account_id   uuid not null
                      references public.wallet_accounts (id) on delete restrict,
  adjustment_type     text not null check (adjustment_type in ('credit', 'debit')),
  amount              bigint not null check (amount > 0),
  currency            text not null check (currency ~ '^[A-Z]{3}$'),
  reason              text not null check (char_length(trim(reason)) between 1 and 1000),
  status              text not null default 'pending'
                      check (status in ('pending', 'approved', 'rejected')),
  requested_by_user_id text not null,
  requested_by_role   text not null,
  reviewed_by_user_id text,
  review_remarks      text,
  ledger_entry_id     uuid references public.wallet_ledger_entries (id) on delete restrict,
  requested_at        timestamptz not null default now(),
  reviewed_at         timestamptz,
  updated_at          timestamptz not null default now()
);

create index if not exists wallet_deposit_queue_idx
  on public.wallet_deposit_requests (status, requested_at desc);
create index if not exists wallet_adjustment_queue_idx
  on public.wallet_adjustment_requests (status, requested_at desc);

drop trigger if exists wallet_deposits_touch_updated_at
  on public.wallet_deposit_requests;
create trigger wallet_deposits_touch_updated_at
  before update on public.wallet_deposit_requests
  for each row execute function public.touch_updated_at();

drop trigger if exists wallet_adjustments_touch_updated_at
  on public.wallet_adjustment_requests;
create trigger wallet_adjustments_touch_updated_at
  before update on public.wallet_adjustment_requests
  for each row execute function public.touch_updated_at();

-- 5. Shared account resolver ------------------------------------------------

create or replace function public.wallet_ensure_account(
  p_owner_type text,
  p_owner_key text,
  p_currency text default 'BDT'
)
returns public.wallet_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_currency text := upper(trim(p_currency));
begin
  if p_owner_type not in ('user', 'agency')
     or nullif(trim(p_owner_key), '') is null
     or v_currency !~ '^[A-Z]{3}$' then
    raise exception 'invalid wallet owner or currency' using errcode = '22023';
  end if;

  insert into public.wallets (owner_type, owner_key)
  values (p_owner_type, trim(p_owner_key))
  on conflict (owner_type, owner_key) do nothing;

  select * into strict v_wallet
    from public.wallets
   where owner_type = p_owner_type
     and owner_key = trim(p_owner_key);

  insert into public.wallet_accounts (wallet_id, currency)
  values (v_wallet.id, v_currency)
  on conflict (wallet_id, currency) do nothing;

  select * into strict v_account
    from public.wallet_accounts
   where wallet_id = v_wallet.id and currency = v_currency;
  return v_account;
end;
$$;

-- 6. Atomic reservation helpers --------------------------------------------

create or replace function public.wallet_reserve_amount(
  p_booking_id uuid,
  p_booking_attempt_id uuid,
  p_owner_type text,
  p_owner_key text,
  p_amount bigint,
  p_currency text,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text,
  p_booking_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.wallet_accounts;
  v_wallet public.wallets;
  v_reservation public.wallet_reservations;
  v_available_before bigint;
  v_hold_before bigint;
  v_currency text := upper(trim(p_currency));
begin
  if (p_booking_id is null) = (p_booking_attempt_id is null)
     or p_amount is null or p_amount <= 0
     or v_currency !~ '^[A-Z]{3}$'
     or nullif(trim(p_actor_user_id), '') is null
     or nullif(trim(p_idempotency_key), '') is null then
    raise exception 'invalid wallet reservation request' using errcode = '22023';
  end if;

  if p_booking_id is not null then
    select * into v_reservation
      from public.wallet_reservations
     where booking_id = p_booking_id
     for update;
  else
    select * into v_reservation
      from public.wallet_reservations
     where booking_attempt_id = p_booking_attempt_id
     for update;
  end if;

  if found and v_reservation.state = 'captured' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CAPTURED');
  elsif found and v_reservation.state = 'reconciliation' then
    return jsonb_build_object('ok', false, 'code', 'RECONCILIATION_REQUIRED');
  elsif found and v_reservation.state = 'active' then
    return jsonb_build_object('ok', false, 'code', 'ISSUE_IN_PROGRESS');
  end if;

  v_account := public.wallet_ensure_account(
    p_owner_type, p_owner_key, v_currency
  );

  -- PostgreSQL cannot assign two composite rows in one INTO target list.
  -- Lock the wallet first, then its currency account, consistently across
  -- balance-changing functions.
  select w.* into strict v_wallet
    from public.wallets w
    join public.wallet_accounts wa on wa.wallet_id = w.id
   where wa.id = v_account.id
   for update of w;
  select * into strict v_account
    from public.wallet_accounts
   where id = v_account.id
   for update;

  if v_wallet.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN');
  end if;
  if v_account.available_balance < p_amount then
    return jsonb_build_object(
      'ok', false,
      'code', 'INSUFFICIENT_FUNDS',
      'available', v_account.available_balance,
      'required', p_amount,
      'currency', v_currency
    );
  end if;

  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  update public.wallet_accounts
     set available_balance = available_balance - p_amount,
         hold_balance = hold_balance + p_amount
   where id = v_account.id;

  if v_reservation.id is null then
    insert into public.wallet_reservations (
      wallet_account_id, booking_id, booking_attempt_id, amount, currency,
      requested_by_user_id, supplier_call_started_at
    ) values (
      v_account.id, p_booking_id, p_booking_attempt_id, p_amount, v_currency,
      p_actor_user_id, now()
    ) returning * into v_reservation;
  else
    update public.wallet_reservations
       set wallet_account_id = v_account.id,
           amount = p_amount,
           currency = v_currency,
           state = 'active',
           cycle = cycle + 1,
           requested_by_user_id = p_actor_user_id,
           issued_by_user_id = null,
           supplier_call_started_at = now(),
           captured_at = null,
           released_at = null,
           reconciliation_at = null,
           reconciliation_reason = null,
           release_reason = null
     where id = v_reservation.id
     returning * into v_reservation;
  end if;

  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks
  ) values (
    v_account.id, 'booking_hold', p_amount, v_currency,
    v_available_before, v_available_before - p_amount,
    v_hold_before, v_hold_before + p_amount,
    p_booking_id, p_booking_reference, v_reservation.id,
    p_idempotency_key || ':hold', p_actor_user_id, p_actor_role,
    'Funds reserved before supplier ticket issuance'
  );

  if p_booking_id is not null then
    update public.flight_bookings
       set charged_wallet_account_id = v_account.id,
           payment_state = 'held',
           payment_amount = p_amount
     where id = p_booking_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'reservationId', v_reservation.id,
    'accountId', v_account.id,
    'amount', p_amount,
    'currency', v_currency,
    'availableBalance', v_available_before - p_amount,
    'holdBalance', v_hold_before + p_amount
  );
end;
$$;

create or replace function public.wallet_begin_booking_issue(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_amount bigint;
begin
  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id and not legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  if v_booking.status = 'confirmed' or v_booking.payment_state = 'captured' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CAPTURED');
  end if;
  if v_booking.status <> 'on-hold' then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_ISSUABLE');
  end if;
  if v_booking.ticketing_deadline_at is not null
     and v_booking.ticketing_deadline_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_EXPIRED');
  end if;
  if v_booking.booking_owner_type is null or v_booking.booking_owner_key is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_OWNER_REQUIRED');
  end if;

  begin
    v_amount := round(
      (v_booking.pricing_snapshot->>'sellingPrice')::numeric * 100
    )::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
  end;

  return public.wallet_reserve_amount(
    v_booking.id, null, v_booking.booking_owner_type,
    v_booking.booking_owner_key, v_amount, v_booking.currency,
    p_actor_user_id, p_actor_role, p_idempotency_key,
    v_booking.public_ref
  );
end;
$$;

create or replace function public.wallet_begin_direct_ticket(
  p_attempt_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.booking_attempts;
  v_owner_type text;
  v_owner_key text;
  v_amount bigint;
  v_currency text;
begin
  select * into v_attempt
    from public.booking_attempts
   where id = p_attempt_id
   for update;
  if not found or v_attempt.state <> 'submitting' then
    return jsonb_build_object('ok', false, 'code', 'ATTEMPT_NOT_CLAIMED');
  end if;
  if coalesce((v_attempt.offer_snapshot->>'directTicketing')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'code', 'NOT_DIRECT_TICKETING');
  end if;
  if v_attempt.audience = 'agency' and v_attempt.agency_code is not null then
    v_owner_type := 'agency';
    v_owner_key := v_attempt.agency_code;
  elsif v_attempt.audience = 'b2c' and v_attempt.user_id is not null then
    v_owner_type := 'user';
    v_owner_key := v_attempt.user_id;
  else
    return jsonb_build_object('ok', false, 'code', 'BOOKING_OWNER_REQUIRED');
  end if;

  begin
    v_amount := round(
      (v_attempt.offer_snapshot->'pricing'->>'sellingPrice')::numeric * 100
    )::bigint;
    v_currency := upper(v_attempt.offer_snapshot->>'currency');
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
  end;

  return public.wallet_reserve_amount(
    null, v_attempt.id, v_owner_type, v_owner_key, v_amount, v_currency,
    p_actor_user_id, p_actor_role, p_idempotency_key, null
  );
end;
$$;

-- 7. Capture, release and reconciliation ------------------------------------

create or replace function public.wallet_capture_reservation(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text,
  p_supplier_outcome jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_reservation public.wallet_reservations;
  v_account public.wallet_accounts;
  v_available_before bigint;
  v_hold_before bigint;
begin
  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id and not legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  select * into v_reservation
    from public.wallet_reservations
   where booking_id = p_booking_id
      or (booking_id is null and booking_attempt_id = v_booking.attempt_id)
   order by booking_id nulls last
   limit 1
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'RESERVATION_NOT_FOUND');
  end if;
  if v_reservation.state = 'captured' then
    return jsonb_build_object('ok', true, 'replay', true,
      'reservationId', v_reservation.id);
  end if;
  if v_reservation.state = 'released' then
    return jsonb_build_object('ok', false, 'code', 'RESERVATION_RELEASED');
  end if;

  select * into strict v_account
    from public.wallet_accounts
   where id = v_reservation.wallet_account_id
   for update;
  if v_account.hold_balance < v_reservation.amount then
    return jsonb_build_object('ok', false, 'code', 'HOLD_BALANCE_MISMATCH');
  end if;
  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;

  update public.wallet_accounts
     set hold_balance = hold_balance - v_reservation.amount
   where id = v_account.id;

  update public.wallet_reservations
     set booking_id = p_booking_id,
         booking_attempt_id = null,
         state = 'captured',
         issued_by_user_id = p_actor_user_id,
         captured_at = now(),
         reconciliation_at = null,
         reconciliation_reason = null
   where id = v_reservation.id;

  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks
  ) values (
    v_account.id, 'booking_confirm', v_reservation.amount,
    v_reservation.currency, v_available_before, v_available_before,
    v_hold_before, v_hold_before - v_reservation.amount,
    v_booking.id, v_booking.public_ref, v_reservation.id,
    p_idempotency_key || ':capture', p_actor_user_id, p_actor_role,
    'Supplier confirmed ticket issuance'
  );

  update public.flight_bookings
     set charged_wallet_account_id = v_account.id,
         payment_state = 'captured',
         payment_amount = v_reservation.amount,
         captured_amount = v_reservation.amount,
         status = 'confirmed',
         issued_by_user_id = p_actor_user_id,
         issued_at = coalesce(issued_at, now()),
         pnr = coalesce(nullif(trim(p_supplier_outcome->>'pnr'), ''), pnr),
         booking_status = coalesce(
           nullif(trim(p_supplier_outcome->>'bookingStatus'), ''),
           booking_status,
           'Confirmed'
         ),
         ticket_code_ref = coalesce(
           nullif(trim(p_supplier_outcome->>'ticketCodeRef'), ''),
           ticket_code_ref
         ),
         ticket_numbers = case
           when jsonb_typeof(p_supplier_outcome->'ticketNumbers') = 'array'
             then p_supplier_outcome->'ticketNumbers'
           else ticket_numbers
         end,
         warnings = case
           when jsonb_typeof(p_supplier_outcome->'warnings') = 'array'
             then p_supplier_outcome->'warnings'
           else warnings
         end,
         supplier_message = coalesce(
           nullif(trim(p_supplier_outcome->>'message'), ''), supplier_message
         )
   where id = v_booking.id;

  return jsonb_build_object(
    'ok', true,
    'reservationId', v_reservation.id,
    'availableBalance', v_available_before,
    'holdBalance', v_hold_before - v_reservation.amount
  );
end;
$$;

create or replace function public.wallet_release_reservation(
  p_booking_id uuid,
  p_booking_attempt_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reservation public.wallet_reservations;
  v_account public.wallet_accounts;
  v_booking_ref text;
  v_available_before bigint;
  v_hold_before bigint;
begin
  if (p_booking_id is null) = (p_booking_attempt_id is null) then
    raise exception 'exactly one reservation subject is required' using errcode = '22023';
  end if;
  select * into v_reservation
    from public.wallet_reservations
   where (p_booking_id is not null and booking_id = p_booking_id)
      or (p_booking_attempt_id is not null and booking_attempt_id = p_booking_attempt_id)
   for update;
  if not found then
    return jsonb_build_object('ok', true, 'replay', true);
  end if;
  if v_reservation.state = 'released' then
    return jsonb_build_object('ok', true, 'replay', true,
      'reservationId', v_reservation.id);
  end if;
  if v_reservation.state = 'captured' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CAPTURED');
  end if;

  select * into strict v_account
    from public.wallet_accounts
   where id = v_reservation.wallet_account_id
   for update;
  if v_account.hold_balance < v_reservation.amount then
    return jsonb_build_object('ok', false, 'code', 'HOLD_BALANCE_MISMATCH');
  end if;
  if p_booking_id is not null then
    select public_ref into v_booking_ref
      from public.flight_bookings where id = p_booking_id;
  end if;
  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;

  update public.wallet_accounts
     set available_balance = available_balance + v_reservation.amount,
         hold_balance = hold_balance - v_reservation.amount
   where id = v_account.id;
  update public.wallet_reservations
     set state = 'released',
         released_at = now(),
         release_reason = left(coalesce(p_reason, 'Supplier declined issuance'), 1000)
   where id = v_reservation.id;

  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks
  ) values (
    v_account.id, 'hold_release', v_reservation.amount,
    v_reservation.currency, v_available_before,
    v_available_before + v_reservation.amount,
    v_hold_before, v_hold_before - v_reservation.amount,
    p_booking_id, v_booking_ref, v_reservation.id,
    p_idempotency_key || ':release', p_actor_user_id, p_actor_role,
    left(coalesce(p_reason, 'Supplier declined issuance'), 1000)
  );

  if p_booking_id is not null then
    update public.flight_bookings
       set payment_state = 'released'
     where id = p_booking_id and payment_state <> 'captured';
  end if;
  return jsonb_build_object(
    'ok', true,
    'reservationId', v_reservation.id,
    'availableBalance', v_available_before + v_reservation.amount,
    'holdBalance', v_hold_before - v_reservation.amount
  );
end;
$$;

create or replace function public.wallet_mark_reconciliation(
  p_booking_id uuid,
  p_booking_attempt_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if (p_booking_id is null) = (p_booking_attempt_id is null) then
    raise exception 'exactly one reservation subject is required' using errcode = '22023';
  end if;
  update public.wallet_reservations
     set state = 'reconciliation',
         reconciliation_at = now(),
         reconciliation_reason = left(coalesce(p_reason, 'Supplier outcome unknown'), 1000)
   where ((p_booking_id is not null and booking_id = p_booking_id)
       or (p_booking_attempt_id is not null and booking_attempt_id = p_booking_attempt_id))
     and state = 'active'
  returning id into v_id;
  if p_booking_id is not null then
    update public.flight_bookings
       set payment_state = 'reconciliation', status = 'in-progress'
     where id = p_booking_id and payment_state = 'held';
  end if;
  return jsonb_build_object('ok', v_id is not null, 'reservationId', v_id);
end;
$$;

-- 8. Deposit, adjustment and refund settlement -----------------------------

create or replace function public.wallet_review_deposit(
  p_request_id uuid,
  p_decision text,
  p_actor_user_id text,
  p_actor_role text,
  p_review_remarks text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.wallet_deposit_requests;
  v_account public.wallet_accounts;
  v_entry_id uuid;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid deposit decision' using errcode = '22023';
  end if;
  select * into v_request from public.wallet_deposit_requests
   where id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if v_request.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_REVIEWED');
  end if;
  if v_request.requested_by_user_id = p_actor_user_id then
    return jsonb_build_object('ok', false, 'code', 'SELF_APPROVAL_FORBIDDEN');
  end if;
  if p_decision = 'rejected' then
    update public.wallet_deposit_requests set
      status = 'rejected', reviewed_by_user_id = p_actor_user_id,
      review_remarks = p_review_remarks, reviewed_at = now()
    where id = p_request_id;
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  select * into strict v_account from public.wallet_accounts
   where id = v_request.wallet_account_id for update;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    idempotency_key, created_by_user_id, created_by_role, remarks
  ) values (
    v_account.id, 'deposit', v_request.amount, v_request.currency,
    v_account.available_balance, v_account.available_balance + v_request.amount,
    v_account.hold_balance, v_account.hold_balance,
    'deposit:' || v_request.id, p_actor_user_id, p_actor_role,
    coalesce(p_review_remarks, v_request.remarks)
  ) returning id into v_entry_id;
  update public.wallet_accounts set
    available_balance = available_balance + v_request.amount
  where id = v_account.id;
  update public.wallet_deposit_requests set
    status = 'approved', reviewed_by_user_id = p_actor_user_id,
    review_remarks = p_review_remarks, reviewed_at = now(),
    ledger_entry_id = v_entry_id
  where id = p_request_id;
  return jsonb_build_object('ok', true, 'status', 'approved',
    'availableBalance', v_account.available_balance + v_request.amount);
end;
$$;

create or replace function public.wallet_review_adjustment(
  p_request_id uuid,
  p_decision text,
  p_actor_user_id text,
  p_actor_role text,
  p_review_remarks text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.wallet_adjustment_requests;
  v_account public.wallet_accounts;
  v_wallet public.wallets;
  v_entry_id uuid;
  v_after bigint;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid adjustment decision' using errcode = '22023';
  end if;
  select * into v_request from public.wallet_adjustment_requests
   where id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if v_request.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_REVIEWED');
  end if;
  if v_request.requested_by_user_id = p_actor_user_id then
    return jsonb_build_object('ok', false, 'code', 'SELF_APPROVAL_FORBIDDEN');
  end if;
  if p_decision = 'rejected' then
    update public.wallet_adjustment_requests set
      status = 'rejected', reviewed_by_user_id = p_actor_user_id,
      review_remarks = p_review_remarks, reviewed_at = now()
    where id = p_request_id;
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  select w.* into strict v_wallet
    from public.wallets w
    join public.wallet_accounts wa on wa.wallet_id = w.id
   where wa.id = v_request.wallet_account_id
   for update of w;
  select * into strict v_account
    from public.wallet_accounts
   where id = v_request.wallet_account_id
   for update;
  if v_request.adjustment_type = 'debit' and v_wallet.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN');
  end if;
  if v_request.adjustment_type = 'debit'
     and v_account.available_balance < v_request.amount then
    return jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_FUNDS',
      'available', v_account.available_balance, 'required', v_request.amount);
  end if;
  v_after := v_account.available_balance +
    case when v_request.adjustment_type = 'credit'
      then v_request.amount else -v_request.amount end;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    idempotency_key, created_by_user_id, created_by_role, remarks,
    metadata
  ) values (
    v_account.id,
    case when v_request.adjustment_type = 'credit'
      then 'manual_credit' else 'manual_debit' end,
    v_request.amount, v_request.currency,
    v_account.available_balance, v_after,
    v_account.hold_balance, v_account.hold_balance,
    'adjustment:' || v_request.id, p_actor_user_id, p_actor_role,
    v_request.reason,
    jsonb_build_object('requestedBy', v_request.requested_by_user_id)
  ) returning id into v_entry_id;
  update public.wallet_accounts set available_balance = v_after
   where id = v_account.id;
  update public.wallet_adjustment_requests set
    status = 'approved', reviewed_by_user_id = p_actor_user_id,
    review_remarks = p_review_remarks, reviewed_at = now(),
    ledger_entry_id = v_entry_id
  where id = p_request_id;
  return jsonb_build_object('ok', true, 'status', 'approved',
    'availableBalance', v_after);
end;
$$;

create or replace function public.wallet_refund_booking(
  p_booking_id uuid,
  p_amount bigint,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text,
  p_remarks text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_account public.wallet_accounts;
  v_existing public.wallet_ledger_entries;
  v_outstanding bigint;
begin
  if p_amount is null or p_amount <= 0
     or nullif(trim(p_actor_user_id), '') is null
     or nullif(trim(p_idempotency_key), '') is null then
    raise exception 'invalid refund request' using errcode = '22023';
  end if;
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;
  select * into v_existing
    from public.wallet_ledger_entries
   where idempotency_key = p_idempotency_key || ':refund';
  if found then
    return jsonb_build_object(
      'ok', true,
      'replay', true,
      'availableBalance', v_existing.available_after,
      'refundedAmount', v_booking.refunded_amount
    );
  end if;
  v_outstanding := v_booking.captured_amount - v_booking.refunded_amount;
  if v_booking.payment_state not in ('captured', 'partially-refunded')
     or p_amount > v_outstanding then
    return jsonb_build_object('ok', false, 'code', 'REFUND_EXCEEDS_CAPTURE',
      'refundable', greatest(v_outstanding, 0));
  end if;
  select * into strict v_account from public.wallet_accounts
   where id = v_booking.charged_wallet_account_id for update;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, idempotency_key,
    created_by_user_id, created_by_role, remarks
  ) values (
    v_account.id, 'refund', p_amount, v_account.currency,
    v_account.available_balance, v_account.available_balance + p_amount,
    v_account.hold_balance, v_account.hold_balance,
    v_booking.id, v_booking.public_ref, p_idempotency_key || ':refund',
    p_actor_user_id, p_actor_role, p_remarks
  );
  update public.wallet_accounts set
    available_balance = available_balance + p_amount where id = v_account.id;
  update public.flight_bookings set
    refunded_amount = refunded_amount + p_amount,
    payment_state = case when refunded_amount + p_amount = captured_amount
      then 'refunded' else 'partially-refunded' end
  where id = v_booking.id;
  return jsonb_build_object('ok', true,
    'availableBalance', v_account.available_balance + p_amount,
    'refundedAmount', v_booking.refunded_amount + p_amount);
end;
$$;

-- 9. Reporting views --------------------------------------------------------

create or replace view public.wallet_report_v as
select
  w.id as wallet_id,
  w.owner_type,
  w.owner_key,
  w.status,
  wa.id as wallet_account_id,
  wa.currency,
  wa.available_balance,
  wa.hold_balance,
  wa.available_balance + wa.hold_balance as total_balance,
  wa.updated_at
from public.wallets w
join public.wallet_accounts wa on wa.wallet_id = w.id;

create or replace view public.wallet_transaction_report_v as
select
  le.*,
  w.owner_type,
  w.owner_key,
  fb.public_ref as joined_booking_reference
from public.wallet_ledger_entries le
join public.wallet_accounts wa on wa.id = le.wallet_account_id
join public.wallets w on w.id = wa.wallet_id
left join public.flight_bookings fb on fb.id = le.booking_id;

create or replace view public.booking_payment_report_v as
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
  fb.status as booking_status,
  fb.created_at,
  fb.issued_at
from public.flight_bookings fb
where not fb.legacy_operational;

-- 10. Database boundary -----------------------------------------------------

alter table public.wallets enable row level security;
alter table public.wallet_accounts enable row level security;
alter table public.wallet_reservations enable row level security;
alter table public.wallet_ledger_entries enable row level security;
alter table public.wallet_deposit_requests enable row level security;
alter table public.wallet_adjustment_requests enable row level security;

revoke all on table public.wallets, public.wallet_accounts,
  public.wallet_reservations, public.wallet_ledger_entries,
  public.wallet_deposit_requests, public.wallet_adjustment_requests
  from public, anon, authenticated;
grant select, insert, update, delete on table public.wallets,
  public.wallet_accounts, public.wallet_reservations,
  public.wallet_deposit_requests, public.wallet_adjustment_requests
  to service_role;
grant select, insert on table public.wallet_ledger_entries to service_role;
grant select on table public.wallet_report_v,
  public.wallet_transaction_report_v, public.booking_payment_report_v
  to service_role;

revoke execute on function public.wallet_ensure_account(text, text, text),
  public.wallet_reserve_amount(uuid, uuid, text, text, bigint, text, text, text, text, text),
  public.wallet_begin_booking_issue(uuid, text, text, text),
  public.wallet_begin_direct_ticket(uuid, text, text, text),
  public.wallet_capture_reservation(uuid, text, text, text, jsonb),
  public.wallet_release_reservation(uuid, uuid, text, text, text, text),
  public.wallet_mark_reconciliation(uuid, uuid, text),
  public.wallet_review_deposit(uuid, text, text, text, text),
  public.wallet_review_adjustment(uuid, text, text, text, text),
  public.wallet_refund_booking(uuid, bigint, text, text, text, text)
  from public, anon, authenticated;

grant execute on function public.wallet_ensure_account(text, text, text),
  public.wallet_begin_booking_issue(uuid, text, text, text),
  public.wallet_begin_direct_ticket(uuid, text, text, text),
  public.wallet_capture_reservation(uuid, text, text, text, jsonb),
  public.wallet_release_reservation(uuid, uuid, text, text, text, text),
  public.wallet_mark_reconciliation(uuid, uuid, text),
  public.wallet_review_deposit(uuid, text, text, text, text),
  public.wallet_review_adjustment(uuid, text, text, text, text),
  public.wallet_refund_booking(uuid, bigint, text, text, text, text)
  to service_role;

-- Internal helper: callable only by owner functions, never through PostgREST.
revoke execute on function public.wallet_reserve_amount(
  uuid, uuid, text, text, bigint, text, text, text, text, text
) from service_role;

comment on table public.wallet_ledger_entries is
  'Immutable financial ledger. Corrections are new adjustment/reversal rows; existing rows cannot be edited or deleted.';
comment on table public.wallet_reservations is
  'Booking funds moved from available to hold before an irreversible supplier ticketing call.';
