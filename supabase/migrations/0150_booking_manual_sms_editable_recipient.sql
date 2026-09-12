-- Editable manual SMS copy and up to three distinct Bangladesh recipients.

alter table public.booking_manual_sms_deliveries
  add column message_text text;

alter table public.booking_manual_sms_deliveries
  add constraint booking_manual_sms_message_check check (
    message_text is null or char_length(btrim(message_text)) between 1 and 480
  );

create or replace function public.normalize_booking_sms_number_v1(p_phone text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  v_number text;
begin
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
  if coalesce(v_number, '') !~ '^8801[3-9][0-9]{8}$' then
    raise exception 'BOOKING_SMS_RECIPIENT_UNAVAILABLE' using errcode = 'P0001';
  end if;
  return v_number;
end;
$$;

create or replace function public.read_booking_manual_sms_status_v2(
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
declare
  v_booking public.flight_bookings;
  v_phone text;
  v_suggested_number text := '';
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

  select profile.agency_mobile into v_phone
    from public.agencies agency
    join public.user_profiles profile on profile.clerk_id = agency.owner_user_id
   where agency.agency_code = v_booking.agency_code;
  begin
    v_suggested_number := public.normalize_booking_sms_number_v1(v_phone);
  exception when others then
    v_suggested_number := '';
  end;

  select
    count(*) filter (where delivery.state = 'sent')::integer,
    count(*) filter (where delivery.state in ('sent', 'processing'))::integer
    into sent_count, reserved_count
    from public.booking_manual_sms_deliveries delivery
   where delivery.booking_id = p_booking_id;
  if v_suggested_number <> '' and exists (
    select 1 from public.booking_manual_sms_deliveries delivery
     where delivery.booking_id = p_booking_id
       and delivery.recipient_number = v_suggested_number
       and delivery.state in ('sent', 'processing')
  ) then
    v_suggested_number := '';
  end if;
  recipient_number := v_suggested_number;
  remaining_sends := greatest(0, 3 - reserved_count);
  return next;
end;
$$;

create or replace function public.claim_booking_manual_sms_send_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_request_id uuid,
  p_recipient_number text,
  p_message_text text
)
returns table (
  delivery_id uuid,
  recipient_number text,
  message_text text,
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
  v_message text := btrim(coalesce(p_message_text, ''));
begin
  if nullif(btrim(p_actor_user_id), '') is null then
    raise exception 'BOOKING_SMS_UNAVAILABLE' using errcode = 'P0001';
  end if;
  if char_length(v_message) not between 1 and 480 then
    raise exception 'BOOKING_SMS_MESSAGE_INVALID' using errcode = 'P0001';
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id
   for update;
  if not found then
    raise exception 'BOOKING_SMS_UNAVAILABLE' using errcode = 'P0001';
  end if;
  if v_booking.audience <> 'agency'
     or v_booking.agency_code is null
     or v_booking.hidden_from_user then
    raise exception 'BOOKING_SMS_UNAVAILABLE' using errcode = 'P0001';
  end if;
  if v_booking.status <> 'confirmed' then
    raise exception 'BOOKING_SMS_NOT_CONFIRMED' using errcode = 'P0001';
  end if;
  v_number := public.normalize_booking_sms_number_v1(p_recipient_number);

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
    message_text := coalesce(v_delivery.message_text, v_message);
    claim_token := coalesce(v_delivery.claim_token, gen_random_uuid());
    claim_state := 'sent';
    remaining_sends := greatest(0, 3 - reserved_count);
    return next;
    return;
  elsif v_delivery.id is not null and v_delivery.state = 'processing' then
    delivery_id := v_delivery.id;
    recipient_number := v_delivery.recipient_number;
    message_text := coalesce(v_delivery.message_text, v_message);
    claim_token := v_delivery.claim_token;
    claim_state := 'processing';
    remaining_sends := greatest(0, 3 - reserved_count);
    return next;
    return;
  end if;

  if exists (
    select 1 from public.booking_manual_sms_deliveries delivery
     where delivery.booking_id = p_booking_id
       and delivery.recipient_number = v_number
       and delivery.state in ('sent', 'processing')
       and delivery.request_id <> p_request_id
  ) then
    raise exception 'BOOKING_SMS_RECIPIENT_ALREADY_USED' using errcode = 'P0001';
  end if;
  if reserved_count >= 3 then
    raise exception 'BOOKING_SMS_LIMIT_REACHED' using errcode = 'P0001';
  end if;

  if v_delivery.id is not null then
    update public.booking_manual_sms_deliveries delivery
       set actor_user_id = p_actor_user_id,
           recipient_number = v_number,
           recipient_number_hash = encode(digest(v_number, 'sha256'), 'hex'),
           content_snapshot = jsonb_build_object('version', 2, 'message', v_message),
           message_text = v_message,
           state = 'processing', claim_token = gen_random_uuid(),
           attempt_count = delivery.attempt_count + 1,
           sent_at = null, completed_at = null,
           provider_message_id = null, last_error = null
     where delivery.id = v_delivery.id
     returning delivery.* into v_delivery;
  else
    insert into public.booking_manual_sms_deliveries (
      booking_id, actor_user_id, request_id,
      recipient_number, recipient_number_hash,
      content_snapshot, message_text, state, claim_token
    ) values (
      p_booking_id, p_actor_user_id, p_request_id,
      v_number, encode(digest(v_number, 'sha256'), 'hex'),
      jsonb_build_object('version', 2, 'message', v_message),
      v_message, 'processing', gen_random_uuid()
    ) returning * into v_delivery;
  end if;

  delivery_id := v_delivery.id;
  recipient_number := v_delivery.recipient_number;
  message_text := v_delivery.message_text;
  claim_token := v_delivery.claim_token;
  claim_state := 'claimed';
  reserved_count := reserved_count + 1;
  remaining_sends := greatest(0, 3 - reserved_count);
  return next;
end;
$$;

revoke all on function public.normalize_booking_sms_number_v1(text),
  public.read_booking_manual_sms_status_v2(uuid),
  public.claim_booking_manual_sms_send_v2(uuid,text,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.normalize_booking_sms_number_v1(text),
  public.read_booking_manual_sms_status_v2(uuid),
  public.claim_booking_manual_sms_send_v2(uuid,text,uuid,text,text)
  to service_role;

comment on column public.booking_manual_sms_deliveries.message_text is
  'The exact user-reviewed message submitted to BulkSMSBD for this attempt.';
