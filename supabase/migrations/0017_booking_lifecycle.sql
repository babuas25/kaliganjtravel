-- The business lifecycle, public references, and atomic booking finalization.
--
-- This is the additive half of Step 3. Legacy operational rows are copied to
-- booking_attempts and retained in flight_bookings with legacy_operational =
-- true. They are excluded from business reads and removed only by a later,
-- separately approved cleanup migration after production verification.

-- 1. Public reference series -------------------------------------------------

create table if not exists public.booking_ref_counters (
  ref_date   date primary key,
  last_value integer not null default 0 check (last_value >= 0),
  updated_at timestamptz not null default now()
);

alter table public.booking_ref_counters enable row level security;
revoke all on table public.booking_ref_counters from anon, authenticated;
grant select, insert, update on table public.booking_ref_counters
  to service_role;

comment on table public.booking_ref_counters is
  'One row per Dhaka day holding the last public booking reference issued.';

create or replace function public.allocate_booking_ref_for(p_date date)
returns text
language plpgsql
as $$
declare
  v_next integer;
begin
  insert into public.booking_ref_counters as c (ref_date, last_value)
  values (p_date, 1)
  on conflict (ref_date) do update
    set last_value = c.last_value + 1,
        updated_at = now()
  returning c.last_value into v_next;

  return 'STR' || to_char(p_date, 'YYMMDD') || lpad(v_next::text, 6, '0');
end;
$$;

create or replace function public.allocate_booking_ref()
returns text
language sql
as $$
  select public.allocate_booking_ref_for(
    (now() at time zone 'Asia/Dhaka')::date
  );
$$;

revoke execute on function public.allocate_booking_ref_for(date)
  from public, anon, authenticated;
revoke execute on function public.allocate_booking_ref()
  from public, anon, authenticated;
grant execute on function public.allocate_booking_ref_for(date)
  to service_role;
grant execute on function public.allocate_booking_ref()
  to service_role;

-- Triplover Booking returns DD/MM/YYYY HH24:MI:SS in production. The ISO
-- branch preserves compatibility with older fixtures and imported rows.
create or replace function public.parse_triplover_booking_deadline(p_value text)
returns timestamptz
language plpgsql
stable
as $$
declare
  v_value text := nullif(trim(p_value), '');
  v_match text[];
begin
  if v_value is null then
    return null;
  end if;

  v_match := regexp_match(
    v_value,
    '^([0-9]{2})/([0-9]{2})/([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2})$'
  );
  if v_match is not null then
    return make_timestamptz(
      v_match[3]::integer,
      v_match[2]::integer,
      v_match[1]::integer,
      v_match[4]::integer,
      v_match[5]::integer,
      v_match[6]::double precision,
      'Asia/Dhaka'
    );
  end if;

  v_match := regexp_match(
    v_value,
    '^([0-9]{4})-([0-9]{2})-([0-9]{2})[ T]([0-9]{2}):([0-9]{2}):([0-9]{2})$'
  );
  if v_match is not null then
    return make_timestamptz(
      v_match[1]::integer,
      v_match[2]::integer,
      v_match[3]::integer,
      v_match[4]::integer,
      v_match[5]::integer,
      v_match[6]::double precision,
      'Asia/Dhaka'
    );
  end if;

  return null;
end;
$$;

revoke execute on function public.parse_triplover_booking_deadline(text)
  from public, anon, authenticated;
grant execute on function public.parse_triplover_booking_deadline(text)
  to service_role;

-- 2. Additive lifecycle columns ---------------------------------------------

alter table public.flight_bookings
  add column if not exists public_ref text,
  add column if not exists attempt_id uuid references public.booking_attempts (id),
  add column if not exists supplier text not null default 'triplover',
  add column if not exists ticketing_deadline_at timestamptz,
  add column if not exists deadline_source text
    check (deadline_source in ('supplier', 'pnr_call', 'assumed')),
  add column if not exists issued_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by text,
  add column if not exists cancel_reason text,
  add column if not exists synced_at timestamptz,
  -- Defaults true for the short database-first rollout window: the pre-Step-3
  -- application can still insert old draft rows safely. The Step-3 RPC always
  -- writes false explicitly.
  add column if not exists legacy_operational boolean not null default true;

-- New business rows no longer carry either value, but retained legacy rows do.
-- Drop only NOT NULL; the columns themselves remain until verified cleanup.
alter table public.flight_bookings
  alter column access_token_hash drop not null,
  alter column expires_at drop not null;

-- Preserve the historical updated_at values while the migration backfills
-- structural columns. Normal writes resume trigger maintenance afterwards.
alter table public.flight_bookings
  disable trigger flight_bookings_touch_updated_at;

-- 3. Copy legacy operational rows without deleting them ---------------------

insert into public.booking_attempts (
  id, access_token_hash, user_id, audience, agency_code, supplier, state,
  search_id, itinerary_id, unique_trans_id, item_code_ref, price_code_ref,
  booking_code_ref, pnr, offer_snapshot, passenger_snapshot, error_code,
  expires_at, submitted_at, resolved_at, created_at
)
select
  fb.id,
  fb.access_token_hash,
  fb.user_id,
  fb.audience,
  fb.agency_code,
  'triplover',
  case fb.status
    when 'draft' then 'draft'
    when 'submitting' then 'submitting'
    when 'failed' then 'failed'
    else 'unknown'
  end,
  fb.search_id,
  fb.itinerary_id,
  coalesce(fb.supplier_refs->>'uniqueTransId', ''),
  coalesce(fb.supplier_refs->>'itemCodeRef', ''),
  coalesce(fb.supplier_refs->>'priceCodeRef', ''),
  fb.booking_code_ref,
  fb.pnr,
  jsonb_build_object(
    'itinerary', fb.itinerary,
    'fares', coalesce(fb.fares, '[]'::jsonb),
    'currency', fb.currency,
    'pricing', fb.pricing_snapshot,
    'passengerCounts', fb.passenger_counts,
    'travelDate', fb.travel_date::text,
    'directTicketing', fb.direct_ticketing,
    'passportRequired', coalesce(fb.passport_required, true),
    'repricedAt', fb.repriced_at::text
  ),
  fb.passengers,
  fb.error_code,
  fb.expires_at,
  fb.submission_started_at,
  case when fb.status in ('failed', 'unknown') then fb.updated_at end,
  fb.created_at
from public.flight_bookings fb
where fb.status in ('draft', 'submitting', 'failed', 'unknown');

do $$
begin
  if exists (
    select 1
      from public.flight_bookings fb
      left join public.booking_attempts ba
        on ba.id = fb.id
       and ba.access_token_hash = fb.access_token_hash
     where fb.status in ('draft', 'submitting', 'failed', 'unknown')
       and ba.id is null
  ) then
    raise exception 'legacy booking attempt copy verification failed';
  end if;
end;
$$;

-- 4. Give the five existing business bookings synthetic attempts ------------

insert into public.booking_attempts (
  id, access_token_hash, user_id, audience, agency_code, supplier, state,
  search_id, itinerary_id, unique_trans_id, item_code_ref, price_code_ref,
  booking_code_ref, pnr, offer_snapshot, passenger_snapshot,
  expires_at, submitted_at, resolved_at, created_at
)
select
  gen_random_uuid(),
  fb.access_token_hash,
  fb.user_id,
  fb.audience,
  fb.agency_code,
  'triplover',
  'succeeded',
  fb.search_id,
  fb.itinerary_id,
  coalesce(fb.supplier_refs->>'uniqueTransId', ''),
  coalesce(fb.supplier_refs->>'itemCodeRef', ''),
  coalesce(fb.supplier_refs->>'priceCodeRef', ''),
  fb.booking_code_ref,
  fb.pnr,
  jsonb_build_object(
    'itinerary', fb.itinerary,
    'fares', coalesce(fb.fares, '[]'::jsonb),
    'currency', fb.currency,
    'pricing', fb.pricing_snapshot,
    'passengerCounts', fb.passenger_counts,
    'travelDate', fb.travel_date::text,
    'directTicketing', fb.direct_ticketing,
    'passportRequired', coalesce(fb.passport_required, true),
    'repricedAt', fb.repriced_at::text
  ),
  fb.passengers,
  fb.expires_at,
  fb.submission_started_at,
  fb.updated_at,
  fb.created_at
from public.flight_bookings fb
where fb.status in ('held', 'ticketed')
  and fb.attempt_id is null;

update public.flight_bookings fb
   set attempt_id = ba.id
  from public.booking_attempts ba
 where ba.access_token_hash = fb.access_token_hash
   and ba.state = 'succeeded'
   and fb.status in ('held', 'ticketed')
   and fb.attempt_id is null;

do $$
begin
  if exists (
    select 1
      from public.flight_bookings
     where status in ('held', 'ticketed')
       and attempt_id is null
  ) then
    raise exception 'business booking attempt backfill verification failed';
  end if;
end;
$$;

-- Allocate historical references in deterministic creation order.
do $$
declare
  r record;
begin
  for r in
    select id, (created_at at time zone 'Asia/Dhaka')::date as ref_date
      from public.flight_bookings
     where status in ('held', 'ticketed')
       and public_ref is null
     order by created_at, id
  loop
    update public.flight_bookings
       set public_ref = public.allocate_booking_ref_for(r.ref_date)
     where id = r.id;
  end loop;
end;
$$;

-- Refuse to continue if Triplover supplied a non-empty deadline format this
-- migration does not understand.
do $$
begin
  if exists (
    select 1
      from public.flight_bookings
     where status in ('held', 'ticketed')
       and nullif(trim(ticketing_time_limit), '') is not null
       and public.parse_triplover_booking_deadline(ticketing_time_limit) is null
  ) then
    raise exception 'unrecognised Triplover ticketing_time_limit format';
  end if;
end;
$$;

-- Remove the old six-value constraint before writing the new vocabulary. The
-- replacement transitional constraint is installed immediately afterwards in
-- the same migration transaction.
alter table public.flight_bookings
  drop constraint if exists flight_bookings_status_check;

update public.flight_bookings
   set status = case
                  when status = 'ticketed' then 'confirmed'
                  else 'on-hold'
                end,
       legacy_operational = false,
       issued_at = case when status = 'ticketed' then updated_at end,
       ticketing_deadline_at =
         public.parse_triplover_booking_deadline(ticketing_time_limit),
       deadline_source = case
         when nullif(trim(ticketing_time_limit), '') is not null then 'supplier'
         else null
       end
 where status in ('held', 'ticketed');

-- 5. Transitional constraints and indexes ----------------------------------

alter table public.flight_bookings
  add constraint flight_bookings_status_check
  check (
    (
      legacy_operational
      and status in ('draft', 'submitting', 'held', 'ticketed', 'failed', 'unknown')
    )
    or
    (
      not legacy_operational
      and status in ('on-hold', 'pending', 'in-progress', 'confirmed', 'cancelled')
    )
  );

-- A business booking is always complete. Retained legacy rows are the only
-- rows allowed to omit the new relationship and public reference.
alter table public.flight_bookings
  add constraint flight_bookings_business_identity_check
  check (
    legacy_operational
    or (public_ref is not null and attempt_id is not null)
  );

alter table public.flight_bookings
  add constraint flight_bookings_public_ref_format_check
  check (public_ref is null or public_ref ~ '^STR[0-9]{12}$');

create unique index if not exists flight_bookings_public_ref_key
  on public.flight_bookings (public_ref);
create unique index if not exists flight_bookings_attempt_id_key
  on public.flight_bookings (attempt_id);
create index if not exists flight_bookings_deadline_idx
  on public.flight_bookings (ticketing_deadline_at)
  where status = 'on-hold' and not legacy_operational;
create index if not exists flight_bookings_business_created_idx
  on public.flight_bookings (created_at desc)
  where not legacy_operational;

comment on column public.flight_bookings.public_ref is
  'Customer-facing reference, STRYYMMDD###### (e.g. STR260801000001).';
comment on column public.flight_bookings.status is
  'Business state for non-legacy rows. Expired and Unconfirmed are computed.';
comment on column public.flight_bookings.legacy_operational is
  'True only for retained pre-attempt operational rows pending verified cleanup.';

alter table public.flight_bookings
  enable trigger flight_bookings_touch_updated_at;

-- 6. Atomic, validated, idempotent success path -----------------------------

create or replace function public.create_booking_from_attempt(
  p_attempt_id uuid,
  p_outcome jsonb
)
returns public.flight_bookings
language plpgsql
as $$
declare
  v_attempt public.booking_attempts;
  v_offer jsonb;
  v_booking public.flight_bookings;
  v_status text;
  v_pnr text;
  v_booking_code_ref text;
  v_ticket_code_ref text;
  v_ttl text;
  v_deadline timestamptz;
begin
  -- Lock by id first, then decide whether this is a new finalization or an
  -- idempotent replay. A concurrent replay waits here until the first call has
  -- either committed or rolled back.
  select * into v_attempt
    from public.booking_attempts
   where id = p_attempt_id
   for update;

  if not found then
    raise exception 'booking attempt % does not exist', p_attempt_id
      using errcode = 'P0002';
  end if;

  select * into v_booking
    from public.flight_bookings
   where attempt_id = p_attempt_id
     and not legacy_operational;

  if found then
    if v_attempt.state = 'submitting' then
      update public.booking_attempts
         set state = 'succeeded',
             pnr = coalesce(v_attempt.pnr, v_booking.pnr),
             booking_code_ref = coalesce(
               v_attempt.booking_code_ref,
               v_booking.booking_code_ref
             ),
             resolved_at = coalesce(v_attempt.resolved_at, now())
       where id = p_attempt_id;
    elsif v_attempt.state <> 'succeeded' then
      raise exception 'booking attempt % conflicts with an existing booking',
        p_attempt_id using errcode = '23514';
    end if;
    return v_booking;
  end if;

  if v_attempt.state <> 'submitting' then
    raise exception 'booking attempt % is not awaiting an outcome', p_attempt_id
      using errcode = 'P0002';
  end if;

  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object' then
    raise exception 'supplier outcome must be a JSON object'
      using errcode = '22023';
  end if;

  v_status := nullif(trim(p_outcome->>'status'), '');
  v_pnr := nullif(trim(p_outcome->>'pnr'), '');
  v_booking_code_ref := nullif(trim(p_outcome->>'bookingCodeRef'), '');
  v_ticket_code_ref := nullif(trim(p_outcome->>'ticketCodeRef'), '');
  v_ttl := nullif(trim(p_outcome->>'ticketingTimeLimit'), '');

  if v_status is null or v_status not in ('held', 'ticketed') then
    raise exception 'supplier outcome has invalid status %', v_status
      using errcode = '22023';
  end if;
  if v_pnr is null then
    raise exception 'supplier outcome has no PNR' using errcode = '22023';
  end if;
  if v_booking_code_ref is null then
    raise exception 'supplier outcome has no bookingCodeRef'
      using errcode = '22023';
  end if;
  if v_status = 'ticketed' and v_ticket_code_ref is null then
    raise exception 'ticketed supplier outcome has no ticketCodeRef'
      using errcode = '22023';
  end if;
  if nullif(trim(v_attempt.unique_trans_id), '') is null
     or nullif(trim(v_attempt.item_code_ref), '') is null
     or nullif(trim(v_attempt.price_code_ref), '') is null then
    raise exception 'booking attempt is missing required supplier references'
      using errcode = '22023';
  end if;
  if p_outcome ? 'airlinesPnr'
     and jsonb_typeof(p_outcome->'airlinesPnr') <> 'array' then
    raise exception 'supplier outcome airlinesPnr must be an array'
      using errcode = '22023';
  end if;
  if p_outcome ? 'ticketNumbers'
     and jsonb_typeof(p_outcome->'ticketNumbers') <> 'array' then
    raise exception 'supplier outcome ticketNumbers must be an array'
      using errcode = '22023';
  end if;
  if p_outcome ? 'warnings'
     and jsonb_typeof(p_outcome->'warnings') <> 'array' then
    raise exception 'supplier outcome warnings must be an array'
      using errcode = '22023';
  end if;

  v_deadline := public.parse_triplover_booking_deadline(v_ttl);
  if v_ttl is not null and v_deadline is null then
    raise exception 'unrecognised Triplover ticketingTimeLimit format: %', v_ttl
      using errcode = '22007';
  end if;

  v_offer := v_attempt.offer_snapshot;

  insert into public.flight_bookings (
    id, public_ref, attempt_id, supplier, user_id, audience, agency_code,
    search_id, itinerary_id, status, currency, pricing_snapshot,
    passenger_counts, travel_date, direct_ticketing, itinerary, fares,
    passport_required, supplier_refs, repriced_at, accepted_at, passengers,
    pnr, airlines_pnr, booking_ref_number, booking_status, ticketing_time_limit,
    ticketing_deadline_at, deadline_source, booking_code_ref, ticket_code_ref,
    ticket_numbers, warnings, supplier_message, issued_at,
    submission_started_at, legacy_operational
  )
  values (
    gen_random_uuid(),
    public.allocate_booking_ref(),
    v_attempt.id,
    v_attempt.supplier,
    v_attempt.user_id,
    v_attempt.audience,
    v_attempt.agency_code,
    v_attempt.search_id,
    v_attempt.itinerary_id,
    case when v_status = 'ticketed' then 'confirmed' else 'on-hold' end,
    v_offer->>'currency',
    v_offer->'pricing',
    v_offer->'passengerCounts',
    (v_offer->>'travelDate')::date,
    coalesce((v_offer->>'directTicketing')::boolean, false),
    nullif(v_offer->'itinerary', 'null'::jsonb),
    coalesce(nullif(v_offer->'fares', 'null'::jsonb), '[]'::jsonb),
    coalesce((v_offer->>'passportRequired')::boolean, true),
    jsonb_build_object(
      'uniqueTransId', v_attempt.unique_trans_id,
      'itemCodeRef', v_attempt.item_code_ref,
      'priceCodeRef', v_attempt.price_code_ref
    ),
    (v_offer->>'repricedAt')::timestamptz,
    v_attempt.created_at,
    v_attempt.passenger_snapshot,
    v_pnr,
    coalesce(p_outcome->'airlinesPnr', '[]'::jsonb),
    p_outcome->>'bookingRefNumber',
    p_outcome->>'bookingStatus',
    v_ttl,
    v_deadline,
    case when v_deadline is not null then 'supplier' else null end,
    v_booking_code_ref,
    v_ticket_code_ref,
    coalesce(p_outcome->'ticketNumbers', '[]'::jsonb),
    coalesce(p_outcome->'warnings', '[]'::jsonb),
    p_outcome->>'message',
    case when v_status = 'ticketed' then now() end,
    coalesce(v_attempt.submitted_at, now()),
    false
  )
  returning * into v_booking;

  update public.booking_attempts
     set state = 'succeeded',
         pnr = v_pnr,
         booking_code_ref = v_booking_code_ref,
         supplier_message = p_outcome->>'message',
         warnings = coalesce(p_outcome->'warnings', '[]'::jsonb),
         resolved_at = now()
   where id = p_attempt_id;

  return v_booking;
end;
$$;

revoke execute on function public.create_booking_from_attempt(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_booking_from_attempt(uuid, jsonb)
  to service_role;

comment on function public.create_booking_from_attempt(uuid, jsonb) is
  'Validates supplier success, atomically creates a booking, and returns the existing row on replay.';
