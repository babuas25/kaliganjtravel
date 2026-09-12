-- B2B-initiated confirmation SMS shares. The booking row is locked while a
-- send slot is reserved, making the three-send maximum safe under concurrency.

create table public.booking_manual_sms_deliveries (
  id                    uuid primary key default gen_random_uuid(),
  booking_id            uuid not null references public.flight_bookings (id)
                          on delete restrict,
  actor_user_id         text not null,
  request_id            uuid not null,
  recipient_number      text not null,
  recipient_number_hash text not null,
  content_snapshot      jsonb not null,
  state                 text not null default 'processing',
  claim_token           uuid,
  attempt_count         integer not null default 1,
  sent_at               timestamptz,
  completed_at          timestamptz,
  provider_message_id   text,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint booking_manual_sms_request_unique unique (booking_id, request_id),
  constraint booking_manual_sms_state_check
    check (state in ('processing', 'sent', 'failed')),
  constraint booking_manual_sms_recipient_check check (
    recipient_number ~ '^[1-9][0-9]{7,14}$'
    and recipient_number_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint booking_manual_sms_snapshot_check check (
    jsonb_typeof(content_snapshot) = 'object'
  ),
  constraint booking_manual_sms_attempt_check check (attempt_count between 1 and 20)
);

create trigger booking_manual_sms_touch_updated_at
  before update on public.booking_manual_sms_deliveries
  for each row execute function public.touch_updated_at();

create index booking_manual_sms_booking_idx
  on public.booking_manual_sms_deliveries (booking_id, created_at desc);

create or replace function public.booking_sms_recipient_v1(p_booking_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_phone text;
  v_number text;
begin
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id;
  if not found
     or v_booking.audience <> 'agency'
     or v_booking.agency_code is null
     or v_booking.hidden_from_user then
    raise exception 'BOOKING_SMS_UNAVAILABLE' using errcode = 'P0001';
  end if;
  if v_booking.status <> 'confirmed' then
    raise exception 'BOOKING_SMS_NOT_CONFIRMED' using errcode = 'P0001';
  end if;

  select regexp_replace(coalesce(profile.agency_mobile, ''), '[^0-9]', '', 'g')
    into v_phone
    from public.agencies agency
    join public.user_profiles profile on profile.clerk_id = agency.owner_user_id
   where agency.agency_code = v_booking.agency_code;
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

  if coalesce(v_number, '') !~ '^[1-9][0-9]{7,14}$' then
    raise exception 'BOOKING_SMS_RECIPIENT_UNAVAILABLE' using errcode = 'P0001';
  end if;
  return v_number;
end;
$$;

create or replace function public.read_booking_manual_sms_status_v1(
  p_booking_id uuid
)
returns table (
  recipient_number text,
  sent_count integer,
  reserved_count integer,
  remaining_sends integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  recipient_number := public.booking_sms_recipient_v1(p_booking_id);
  select
    count(*) filter (where delivery.state = 'sent')::integer,
    count(*) filter (where delivery.state in ('sent', 'processing'))::integer
    into sent_count, reserved_count
    from public.booking_manual_sms_deliveries delivery
   where delivery.booking_id = p_booking_id;
  remaining_sends := greatest(0, 3 - reserved_count);
  return next;
end;
$$;

create or replace function public.claim_booking_manual_sms_send_v1(
  p_booking_id uuid,
  p_actor_user_id text,
  p_request_id uuid,
  p_content_snapshot jsonb
)
returns table (
  delivery_id uuid,
  recipient_number text,
  content_snapshot jsonb,
  claim_token uuid,
  claim_state text,
  sent_count integer,
  reserved_count integer,
  remaining_sends integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_delivery public.booking_manual_sms_deliveries;
  v_number text;
begin
  if nullif(btrim(p_actor_user_id), '') is null
     or jsonb_typeof(p_content_snapshot) <> 'object' then
    raise exception 'BOOKING_SMS_UNAVAILABLE' using errcode = 'P0001';
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    raise exception 'BOOKING_SMS_UNAVAILABLE' using errcode = 'P0001';
  end if;
  v_number := public.booking_sms_recipient_v1(p_booking_id);

  select delivery.* into v_delivery
    from public.booking_manual_sms_deliveries delivery
   where delivery.booking_id = p_booking_id
     and delivery.request_id = p_request_id;

  select
    count(*) filter (where delivery.state = 'sent')::integer,
    count(*) filter (where delivery.state in ('sent', 'processing'))::integer
    into sent_count, reserved_count
    from public.booking_manual_sms_deliveries delivery
   where delivery.booking_id = p_booking_id;

  if v_delivery.id is not null and v_delivery.state = 'sent' then
    delivery_id := v_delivery.id;
    recipient_number := v_delivery.recipient_number;
    content_snapshot := v_delivery.content_snapshot;
    claim_token := coalesce(v_delivery.claim_token, gen_random_uuid());
    claim_state := 'sent';
    remaining_sends := greatest(0, 3 - reserved_count);
    return next;
    return;
  elsif v_delivery.id is not null and v_delivery.state = 'processing' then
    delivery_id := v_delivery.id;
    recipient_number := v_delivery.recipient_number;
    content_snapshot := v_delivery.content_snapshot;
    claim_token := v_delivery.claim_token;
    claim_state := 'processing';
    remaining_sends := greatest(0, 3 - reserved_count);
    return next;
    return;
  end if;

  if reserved_count >= 3 then
    raise exception 'BOOKING_SMS_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  if v_delivery.id is not null then
    update public.booking_manual_sms_deliveries delivery
       set actor_user_id = p_actor_user_id,
           recipient_number = v_number,
           recipient_number_hash = encode(digest(v_number, 'sha256'), 'hex'),
           content_snapshot = p_content_snapshot,
           state = 'processing', claim_token = gen_random_uuid(),
           attempt_count = delivery.attempt_count + 1,
           sent_at = null, completed_at = null,
           provider_message_id = null, last_error = null
     where delivery.id = v_delivery.id
     returning delivery.* into v_delivery;
  else
    insert into public.booking_manual_sms_deliveries (
      booking_id, actor_user_id, request_id,
      recipient_number, recipient_number_hash, content_snapshot,
      state, claim_token
    ) values (
      p_booking_id, p_actor_user_id, p_request_id,
      v_number, encode(digest(v_number, 'sha256'), 'hex'), p_content_snapshot,
      'processing', gen_random_uuid()
    ) returning * into v_delivery;
  end if;

  delivery_id := v_delivery.id;
  recipient_number := v_delivery.recipient_number;
  content_snapshot := v_delivery.content_snapshot;
  claim_token := v_delivery.claim_token;
  claim_state := 'claimed';
  reserved_count := reserved_count + 1;
  remaining_sends := greatest(0, 3 - reserved_count);
  return next;
end;
$$;

create or replace function public.mark_booking_manual_sms_sent_v1(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_provider_message_id text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_id uuid;
  v_sent_count integer;
begin
  update public.booking_manual_sms_deliveries delivery
     set state = 'sent', sent_at = clock_timestamp(),
         completed_at = clock_timestamp(), claim_token = null,
         provider_message_id = nullif(left(p_provider_message_id, 500), ''),
         last_error = null
   where delivery.id = p_delivery_id
     and delivery.state = 'processing'
     and delivery.claim_token = p_claim_token
  returning delivery.booking_id into v_booking_id;
  if not found then return -1; end if;

  select count(*)::integer into v_sent_count
    from public.booking_manual_sms_deliveries delivery
   where delivery.booking_id = v_booking_id and delivery.state = 'sent';
  return v_sent_count;
end;
$$;

create or replace function public.fail_booking_manual_sms_send_v1(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.booking_manual_sms_deliveries delivery
     set state = 'failed', completed_at = clock_timestamp(),
         claim_token = null,
         last_error = left(coalesce(p_error, 'SMS delivery failed.'), 1000)
   where delivery.id = p_delivery_id
     and delivery.state = 'processing'
     and delivery.claim_token = p_claim_token;
  return found;
end;
$$;

alter table public.booking_manual_sms_deliveries enable row level security;
revoke all on table public.booking_manual_sms_deliveries
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.booking_manual_sms_deliveries
  to service_role;

revoke all on function public.booking_sms_recipient_v1(uuid),
  public.read_booking_manual_sms_status_v1(uuid),
  public.claim_booking_manual_sms_send_v1(uuid,text,uuid,jsonb),
  public.mark_booking_manual_sms_sent_v1(uuid,uuid,text),
  public.fail_booking_manual_sms_send_v1(uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.booking_sms_recipient_v1(uuid),
  public.read_booking_manual_sms_status_v1(uuid),
  public.claim_booking_manual_sms_send_v1(uuid,text,uuid,jsonb),
  public.mark_booking_manual_sms_sent_v1(uuid,uuid,text),
  public.fail_booking_manual_sms_send_v1(uuid,uuid,text)
  to service_role;

comment on table public.booking_manual_sms_deliveries is
  'Durable manual B2B confirmation SMS attempts; at most three sent or in-flight shares per booking.';
