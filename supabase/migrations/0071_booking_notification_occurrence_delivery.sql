-- Occurrence-aware notification claims and recipient registration.
--
-- Legacy booking_status_email_deliveries remains immutable rollout evidence.
-- New work is identified by lifecycle event/outbox, and each normalized
-- recipient has one durable row per outbox occurrence.

create or replace function public.claim_booking_notification_outbox_v1(
  p_limit integer default 25,
  p_booking_id uuid default null
)
returns table (
  outbox_id uuid,
  lifecycle_event_id bigint,
  booking_id uuid,
  occurrence_id uuid,
  lifecycle_status text,
  event_snapshot jsonb,
  claim_token uuid,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select candidate.id
      from public.booking_notification_outbox candidate
     where candidate.state = 'pending'
       and candidate.delivery_policy in ('send', 'grace')
       and candidate.available_at <= clock_timestamp()
       and (p_booking_id is null or candidate.booking_id = p_booking_id)
     order by candidate.available_at, candidate.created_at, candidate.id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), claimed as (
    update public.booking_notification_outbox target
       set state = 'processing',
           claimed_at = clock_timestamp(),
           claim_token = gen_random_uuid(),
           attempt_count = target.attempt_count + 1,
           last_error = null
      from candidates
     where target.id = candidates.id
     returning target.*
  )
  select
    claimed.id,
    claimed.lifecycle_event_id,
    claimed.booking_id,
    event.occurrence_id,
    claimed.lifecycle_status,
    claimed.event_snapshot,
    claimed.claim_token,
    claimed.attempt_count
  from claimed
  join public.booking_status_events event
    on event.id = claimed.lifecycle_event_id
  order by claimed.available_at, claimed.created_at, claimed.id;
end;
$$;

create or replace function public.register_booking_notification_delivery_v1(
  p_outbox_id uuid,
  p_claim_token uuid,
  p_recipient_kind text,
  p_recipient_address text
)
returns table (
  delivery_id uuid,
  outbox_id uuid,
  recipient_kind text,
  recipient_address text,
  recipient_address_hash text,
  is_hidden_copy boolean,
  state text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox public.booking_notification_outbox;
  v_address text := lower(btrim(coalesce(p_recipient_address, '')));
  v_address_hash text;
begin
  if p_recipient_kind not in (
    'customer_contact', 'booking_user', 'agency_user', 'system_copy'
  ) then
    raise exception 'invalid notification recipient kind' using errcode = '22023';
  end if;
  if v_address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or char_length(v_address) > 320 then
    raise exception 'invalid notification recipient address' using errcode = '22023';
  end if;
  select candidate.* into v_outbox
    from public.booking_notification_outbox candidate
   where candidate.id = p_outbox_id
   for update;
  if not found then
    raise exception 'notification outbox not found' using errcode = 'P0002';
  end if;
  if v_outbox.state <> 'processing'
     or v_outbox.claim_token is distinct from p_claim_token then
    raise exception 'notification outbox claim mismatch' using errcode = '40001';
  end if;

  v_address_hash := encode(digest(v_address, 'sha256'), 'hex');
  insert into public.booking_notification_deliveries (
    outbox_id, recipient_kind, recipient_address,
    recipient_address_hash, is_hidden_copy, channel,
    state, next_attempt_at
  ) values (
    p_outbox_id, p_recipient_kind, v_address,
    v_address_hash, p_recipient_kind = 'system_copy', 'email',
    'pending', clock_timestamp()
  )
  on conflict (outbox_id, channel, recipient_address_hash) do nothing;

  return query
  select
    delivery.id,
    delivery.outbox_id,
    delivery.recipient_kind,
    delivery.recipient_address,
    delivery.recipient_address_hash,
    delivery.is_hidden_copy,
    delivery.state
  from public.booking_notification_deliveries delivery
  where delivery.outbox_id = p_outbox_id
    and delivery.channel = 'email'
    and delivery.recipient_address_hash = v_address_hash;
end;
$$;

revoke all on function public.claim_booking_notification_outbox_v1(integer,uuid),
  public.register_booking_notification_delivery_v1(uuid,uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.claim_booking_notification_outbox_v1(integer,uuid),
  public.register_booking_notification_delivery_v1(uuid,uuid,text,text)
  to service_role;

comment on function public.claim_booking_notification_outbox_v1(integer,uuid) is
  'Claims eligible notification event occurrences with SKIP LOCKED. Legacy once-per-booking/status delivery rows are not consulted.';
comment on function public.register_booking_notification_delivery_v1(uuid,uuid,text,text) is
  'Registers one normalized recipient per outbox occurrence and address hash. Exact replay returns the same delivery row.';
