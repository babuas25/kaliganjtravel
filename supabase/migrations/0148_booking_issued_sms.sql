-- Durable B2B partner SMS delivery for newly issued tickets.
--
-- One row is created in the same transaction as each future Confirmed
-- lifecycle occurrence. Historical rows are deliberately not backfilled: a
-- deployment must never surprise customers with old ticket confirmations.

create table public.booking_issued_sms_deliveries (
  id                     uuid primary key default gen_random_uuid(),
  lifecycle_event_id     bigint not null unique
                           references public.booking_status_events (id)
                           on delete restrict,
  booking_id             uuid not null
                           references public.flight_bookings (id)
                           on delete restrict,
  occurrence_id          uuid not null,
  recipient_number       text,
  recipient_number_hash  text,
  content_snapshot       jsonb not null,
  state                  text not null default 'pending',
  available_at           timestamptz not null default now(),
  claimed_at             timestamptz,
  claim_token            uuid,
  attempt_count          integer not null default 0,
  max_attempts           integer not null default 8,
  sent_at                timestamptz,
  completed_at           timestamptz,
  provider_message_id    text,
  last_error             text,
  suppression_reason     text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint booking_issued_sms_state_check check (state in (
    'pending', 'processing', 'retry', 'sent', 'suppressed', 'dead_letter'
  )),
  constraint booking_issued_sms_recipient_check check (
    (state = 'suppressed' and recipient_number is null
      and recipient_number_hash is null)
    or (recipient_number ~ '^[1-9][0-9]{7,14}$'
      and recipient_number_hash ~ '^[a-f0-9]{64}$')
  ),
  constraint booking_issued_sms_attempt_check check (
    attempt_count >= 0 and max_attempts between 1 and 20
  )
);

create trigger booking_issued_sms_touch_updated_at
  before update on public.booking_issued_sms_deliveries
  for each row execute function public.touch_updated_at();

create index booking_issued_sms_claim_idx
  on public.booking_issued_sms_deliveries (available_at, created_at, id)
  where state in ('pending', 'retry');

create index booking_issued_sms_booking_idx
  on public.booking_issued_sms_deliveries (booking_id, created_at desc);

create or replace function public.enqueue_booking_issued_sms_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_phone text;
  v_number text;
  v_state text := 'pending';
  v_suppression_reason text;
  v_pnr text;
  v_passenger_name text;
begin
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = new.booking_id;
  if not found then
    raise exception 'issued SMS booking not found' using errcode = '23503';
  end if;

  if v_booking.audience = 'agency' and v_booking.agency_code is not null then
    select regexp_replace(coalesce(profile.agency_mobile, ''), '[^0-9]', '', 'g')
      into v_phone
      from public.agencies agency
      join public.user_profiles profile
        on profile.clerk_id = agency.owner_user_id
     where agency.agency_code = v_booking.agency_code;
  end if;
  v_phone := coalesce(v_phone, '');

  if left(v_phone, 2) = '00' then
    v_number := substr(v_phone, 3);
  elsif left(v_phone, 3) = '880' then
    v_number := v_phone;
  elsif left(v_phone, 2) = '01' then
    v_number := '880' || substr(v_phone, 2);
  elsif char_length(v_phone) = 10 and left(v_phone, 1) = '1' then
    v_number := '880' || v_phone;
  else
    v_number := v_phone;
  end if;

  if coalesce(new.event_snapshot->>'notificationDisposition', '') = 'audit_only'
     or new.supplier_operation = 'MigrationBaseline' then
    v_state := 'suppressed';
    v_suppression_reason := 'historical_or_audit_only';
  elsif v_booking.audience <> 'agency' then
    v_state := 'suppressed';
    v_suppression_reason := 'b2b_partner_only';
  elsif v_booking.hidden_from_user then
    v_state := 'suppressed';
    v_suppression_reason := 'booking_hidden_from_user';
  elsif coalesce(v_number, '') !~ '^[1-9][0-9]{7,14}$' then
    v_state := 'suppressed';
    v_suppression_reason := 'missing_or_invalid_b2b_partner_phone';
  end if;

  if jsonb_typeof(v_booking.airlines_pnr) = 'array' then
    v_pnr := nullif(btrim(v_booking.airlines_pnr->>0), '');
  end if;
  v_pnr := coalesce(
    v_pnr,
    nullif(btrim(v_booking.pnr), ''),
    nullif(btrim(v_booking.booking_ref_number), ''),
    '--'
  );
  v_passenger_name := btrim(concat_ws(' ',
    nullif(btrim(v_booking.passengers #>> '{travellers,0,firstName}'), ''),
    nullif(btrim(v_booking.passengers #>> '{travellers,0,lastName}'), '')
  ));

  insert into public.booking_issued_sms_deliveries (
    lifecycle_event_id, booking_id, occurrence_id,
    recipient_number, recipient_number_hash, content_snapshot,
    state, suppression_reason, completed_at
  ) values (
    new.id, new.booking_id, new.occurrence_id,
    case when v_state = 'suppressed' then null else v_number end,
    case when v_state = 'suppressed' then null
      else encode(digest(v_number, 'sha256'), 'hex') end,
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'pnr', v_pnr,
      'passengerName', v_passenger_name,
      'airlineCode', coalesce(v_booking.itinerary->>'carrierCode', ''),
      'airlineName', coalesce(v_booking.itinerary->>'carrierName', ''),
      'itinerary', coalesce(v_booking.itinerary, 'null'::jsonb),
      'currency', v_booking.currency,
      'grossAmount', v_booking.pricing_snapshot->'grossPrice'
    ),
    v_state, v_suppression_reason,
    case when v_state = 'suppressed' then clock_timestamp() else null end
  )
  on conflict (lifecycle_event_id) do nothing;
  return new;
end;
$$;

create trigger booking_status_events_enqueue_issued_sms
  after insert on public.booking_status_events
  for each row
  when (new.to_lifecycle_status = 'confirmed')
  execute function public.enqueue_booking_issued_sms_v1();

-- Serialize Hide with SMS claim. If claim won, Hide reports the same retryable
-- conflict used for in-flight email. If Hide won, the pending SMS is retained
-- as suppressed evidence and Restore never sends it later.
create or replace function public.guard_and_suppress_hidden_booking_sms_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(old.hidden_from_user, false) = false
     and coalesce(new.hidden_from_user, false) = true then
    if exists (
      select 1 from public.booking_issued_sms_deliveries delivery
       where delivery.booking_id = new.id
         and delivery.state = 'processing'
    ) then
      raise exception 'NOTIFICATION_DELIVERY_IN_PROGRESS'
        using errcode = '55000';
    end if;
    update public.booking_issued_sms_deliveries delivery
       set state = 'suppressed',
           recipient_number = null,
           recipient_number_hash = null,
           suppression_reason = 'booking_hidden_from_user',
           completed_at = clock_timestamp(),
           claimed_at = null,
           claim_token = null,
           last_error = null
     where delivery.booking_id = new.id
       and delivery.state in ('pending', 'retry');
  end if;
  return new;
end;
$$;

create trigger flight_bookings_guard_and_suppress_hidden_sms
  before update of hidden_from_user on public.flight_bookings
  for each row execute function public.guard_and_suppress_hidden_booking_sms_v1();

create or replace function public.claim_booking_issued_sms_v1(
  p_limit integer default 10,
  p_booking_id uuid default null
)
returns table (
  delivery_id uuid,
  booking_id uuid,
  occurrence_id uuid,
  recipient_number text,
  recipient_number_hash text,
  content_snapshot jsonb,
  delivery_claim_token uuid,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate record;
  v_booking public.flight_bookings;
  v_delivery public.booking_issued_sms_deliveries;
  v_returned integer := 0;
begin
  for v_candidate in
    select candidate.id, candidate.booking_id
      from public.booking_issued_sms_deliveries candidate
     where candidate.state in ('pending', 'retry')
       and candidate.available_at <= clock_timestamp()
       and candidate.attempt_count < candidate.max_attempts
       and (p_booking_id is null or candidate.booking_id = p_booking_id)
     order by candidate.available_at, candidate.created_at, candidate.id
     limit greatest(1, least(coalesce(p_limit, 10), 50)) * 4
  loop
    select booking.* into v_booking
      from public.flight_bookings booking
     where booking.id = v_candidate.booking_id
     for update;
    if not found then
      continue;
    end if;

    select candidate.* into v_delivery
      from public.booking_issued_sms_deliveries candidate
     where candidate.id = v_candidate.id
     for update;
    if not found
       or v_delivery.state not in ('pending', 'retry')
       or v_delivery.available_at > clock_timestamp()
       or v_delivery.attempt_count >= v_delivery.max_attempts then
      continue;
    end if;

    if v_booking.audience = 'agency' and v_booking.hidden_from_user then
      update public.booking_issued_sms_deliveries delivery
         set state = 'suppressed', recipient_number = null,
             recipient_number_hash = null,
             suppression_reason = 'booking_hidden_from_user',
             completed_at = clock_timestamp(), claimed_at = null,
             claim_token = null, last_error = null
       where delivery.id = v_delivery.id;
      continue;
    end if;

    update public.booking_issued_sms_deliveries delivery
       set state = 'processing', claimed_at = clock_timestamp(),
           claim_token = gen_random_uuid(),
           attempt_count = delivery.attempt_count + 1,
           last_error = null
     where delivery.id = v_delivery.id
     returning delivery.* into v_delivery;

    delivery_id := v_delivery.id;
    booking_id := v_delivery.booking_id;
    occurrence_id := v_delivery.occurrence_id;
    recipient_number := v_delivery.recipient_number;
    recipient_number_hash := v_delivery.recipient_number_hash;
    content_snapshot := v_delivery.content_snapshot;
    delivery_claim_token := v_delivery.claim_token;
    attempt_count := v_delivery.attempt_count;
    return next;

    v_returned := v_returned + 1;
    exit when v_returned >= greatest(1, least(coalesce(p_limit, 10), 50));
  end loop;
end;
$$;

create or replace function public.mark_booking_issued_sms_sent_v1(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_provider_message_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.booking_issued_sms_deliveries delivery
     set state = 'sent', sent_at = clock_timestamp(),
         completed_at = clock_timestamp(), claimed_at = null,
         claim_token = null,
         provider_message_id = nullif(left(p_provider_message_id, 500), ''),
         last_error = null
   where delivery.id = p_delivery_id
     and delivery.state = 'processing'
     and delivery.claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.fail_booking_issued_sms_v1(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_error text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_state text;
begin
  update public.booking_issued_sms_deliveries delivery
     set state = case when delivery.attempt_count >= delivery.max_attempts
           then 'dead_letter' else 'retry' end,
         available_at = case when delivery.attempt_count >= delivery.max_attempts
           then delivery.available_at
           else clock_timestamp()
             + make_interval(mins => least(delivery.attempt_count * 5, 60)) end,
         completed_at = case when delivery.attempt_count >= delivery.max_attempts
           then clock_timestamp() else null end,
         claimed_at = null,
         claim_token = null,
         last_error = left(coalesce(p_error, 'SMS delivery failed.'), 1000)
   where delivery.id = p_delivery_id
     and delivery.state = 'processing'
     and delivery.claim_token = p_claim_token
  returning delivery.state into v_state;
  if not found then
    raise exception 'issued SMS claim mismatch' using errcode = '40001';
  end if;
  return v_state;
end;
$$;

create or replace function public.recover_stale_booking_issued_sms_claims_v1(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  with stale as (
    select candidate.id
      from public.booking_issued_sms_deliveries candidate
     where candidate.state = 'processing'
       and candidate.claimed_at < clock_timestamp() - interval '10 minutes'
     order by candidate.claimed_at, candidate.id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  update public.booking_issued_sms_deliveries delivery
     set state = case when delivery.attempt_count >= delivery.max_attempts
           then 'dead_letter' else 'retry' end,
         available_at = clock_timestamp(),
         completed_at = case when delivery.attempt_count >= delivery.max_attempts
           then clock_timestamp() else null end,
         claimed_at = null,
         claim_token = null,
         last_error = 'Stale SMS delivery claim recovered.'
    from stale
   where delivery.id = stale.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter table public.booking_issued_sms_deliveries enable row level security;
revoke all on table public.booking_issued_sms_deliveries
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.booking_issued_sms_deliveries
  to service_role;

revoke all on function public.enqueue_booking_issued_sms_v1(),
  public.guard_and_suppress_hidden_booking_sms_v1()
  from public, anon, authenticated, service_role;
revoke all on function public.claim_booking_issued_sms_v1(integer,uuid),
  public.mark_booking_issued_sms_sent_v1(uuid,uuid,text),
  public.fail_booking_issued_sms_v1(uuid,uuid,text),
  public.recover_stale_booking_issued_sms_claims_v1(integer)
  from public, anon, authenticated;
grant execute on function public.claim_booking_issued_sms_v1(integer,uuid),
  public.mark_booking_issued_sms_sent_v1(uuid,uuid,text),
  public.fail_booking_issued_sms_v1(uuid,uuid,text),
  public.recover_stale_booking_issued_sms_claims_v1(integer)
  to service_role;

comment on table public.booking_issued_sms_deliveries is
  'One durable, retryable B2B partner SMS intent for each future ticketed lifecycle occurrence. Recipient numbers and message inputs are protected by RLS.';
