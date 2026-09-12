-- Independent visible-recipient delivery and partial retry.

alter table public.booking_notification_outbox
  add column if not exists recipients_expanded_at timestamptz;

create or replace function public.claim_booking_notification_outbox_v2(
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
  recipients_expanded boolean,
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
       and candidate.attempt_count < candidate.max_attempts
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
    claimed.recipients_expanded_at is not null,
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
  v_existing public.booking_notification_deliveries;
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
  select delivery.* into v_existing
    from public.booking_notification_deliveries delivery
   where delivery.outbox_id = p_outbox_id
     and delivery.channel = 'email'
     and delivery.recipient_address_hash = v_address_hash;
  if found then
    return query select
      v_existing.id, v_existing.outbox_id, v_existing.recipient_kind,
      v_existing.recipient_address, v_existing.recipient_address_hash,
      v_existing.is_hidden_copy, v_existing.state;
    return;
  end if;
  if v_outbox.recipients_expanded_at is not null then
    raise exception 'notification recipient set is immutable'
      using errcode = '23514';
  end if;

  insert into public.booking_notification_deliveries (
    outbox_id, recipient_kind, recipient_address,
    recipient_address_hash, is_hidden_copy, channel,
    state, next_attempt_at
  ) values (
    p_outbox_id, p_recipient_kind, v_address,
    v_address_hash, p_recipient_kind = 'system_copy', 'email',
    'pending', clock_timestamp()
  ) returning * into v_existing;
  return query select
    v_existing.id, v_existing.outbox_id, v_existing.recipient_kind,
    v_existing.recipient_address, v_existing.recipient_address_hash,
    v_existing.is_hidden_copy, v_existing.state;
end;
$$;

create or replace function public.complete_booking_notification_recipient_expansion_v1(
  p_outbox_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  perform 1 from public.booking_notification_outbox candidate
   where candidate.id = p_outbox_id
     and candidate.state = 'processing'
     and candidate.claim_token = p_claim_token
   for update;
  if not found then
    raise exception 'notification outbox claim mismatch' using errcode = '40001';
  end if;
  select count(*)::integer into v_count
    from public.booking_notification_deliveries delivery
   where delivery.outbox_id = p_outbox_id
     and not delivery.is_hidden_copy;
  if v_count = 0 then
    raise exception 'notification has no visible recipient' using errcode = '23514';
  end if;
  update public.booking_notification_outbox
     set recipients_expanded_at = coalesce(
       recipients_expanded_at, clock_timestamp()
     )
   where id = p_outbox_id;
  return true;
end;
$$;

create or replace function public.claim_booking_notification_deliveries_v1(
  p_outbox_id uuid,
  p_outbox_claim_token uuid,
  p_limit integer default 25
)
returns table (
  delivery_id uuid,
  recipient_kind text,
  recipient_address text,
  recipient_address_hash text,
  is_hidden_copy boolean,
  rendered_content jsonb,
  delivery_claim_token uuid,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.booking_notification_outbox candidate
   where candidate.id = p_outbox_id
     and candidate.state = 'processing'
     and candidate.claim_token = p_outbox_claim_token
     and candidate.recipients_expanded_at is not null
   for update;
  if not found then
    raise exception 'notification outbox claim mismatch' using errcode = '40001';
  end if;
  return query
  with candidates as (
    select candidate.id
      from public.booking_notification_deliveries candidate
     where candidate.outbox_id = p_outbox_id
       and candidate.state in ('pending', 'retry')
       and candidate.next_attempt_at <= clock_timestamp()
       and candidate.attempt_count < candidate.max_attempts
       and not candidate.is_hidden_copy
     order by candidate.next_attempt_at, candidate.created_at, candidate.id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), claimed as (
    update public.booking_notification_deliveries target
       set state = 'processing',
           claimed_at = clock_timestamp(),
           claim_token = gen_random_uuid(),
           last_attempt_at = clock_timestamp(),
           attempt_count = target.attempt_count + 1,
           last_error = null
      from candidates
     where target.id = candidates.id
     returning target.*
  )
  select
    claimed.id, claimed.recipient_kind, claimed.recipient_address,
    claimed.recipient_address_hash, claimed.is_hidden_copy,
    claimed.rendered_content, claimed.claim_token, claimed.attempt_count
  from claimed
  order by claimed.created_at, claimed.id;
end;
$$;

create or replace function public.store_booking_notification_render_v1(
  p_delivery_id uuid,
  p_delivery_claim_token uuid,
  p_rendered_content jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_content jsonb;
begin
  if jsonb_typeof(p_rendered_content) <> 'object'
     or p_rendered_content->>'version' <> '1'
     or nullif(p_rendered_content->>'subject', '') is null
     or nullif(p_rendered_content->>'html', '') is null
     or nullif(p_rendered_content->>'text', '') is null then
    raise exception 'invalid rendered notification content' using errcode = '22023';
  end if;
  update public.booking_notification_deliveries delivery
     set rendered_content = coalesce(delivery.rendered_content, p_rendered_content)
   where delivery.id = p_delivery_id
     and delivery.state = 'processing'
     and delivery.claim_token = p_delivery_claim_token
  returning delivery.rendered_content into v_content;
  if not found then
    raise exception 'notification delivery claim mismatch' using errcode = '40001';
  end if;
  return v_content;
end;
$$;

create or replace function public.mark_booking_notification_delivery_sent_v1(
  p_delivery_id uuid,
  p_delivery_claim_token uuid,
  p_provider_message_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.booking_notification_deliveries delivery
     set state = 'sent',
         sent_at = clock_timestamp(),
         completed_at = clock_timestamp(),
         provider_message_id = nullif(left(p_provider_message_id, 500), ''),
         claimed_at = null,
         claim_token = null,
         last_error = null
   where delivery.id = p_delivery_id
     and delivery.state = 'processing'
     and delivery.claim_token = p_delivery_claim_token;
  return found;
end;
$$;

create or replace function public.fail_booking_notification_delivery_v1(
  p_delivery_id uuid,
  p_delivery_claim_token uuid,
  p_error text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_state text;
begin
  update public.booking_notification_deliveries delivery
     set state = case when delivery.attempt_count >= delivery.max_attempts
           then 'dead_letter' else 'retry' end,
         next_attempt_at = case when delivery.attempt_count >= delivery.max_attempts
           then delivery.next_attempt_at
           else clock_timestamp() + interval '1 minute' end,
         completed_at = case when delivery.attempt_count >= delivery.max_attempts
           then clock_timestamp() else null end,
         claimed_at = null,
         claim_token = null,
         last_error = left(coalesce(p_error, 'Notification delivery failed.'), 1000)
   where delivery.id = p_delivery_id
     and delivery.state = 'processing'
     and delivery.claim_token = p_delivery_claim_token
  returning delivery.state into v_state;
  if not found then
    raise exception 'notification delivery claim mismatch' using errcode = '40001';
  end if;
  return v_state;
end;
$$;

create or replace function public.finalize_booking_notification_outbox_v1(
  p_outbox_id uuid,
  p_claim_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox public.booking_notification_outbox;
  v_active integer;
  v_retry integer;
  v_dead integer;
  v_sent integer;
  v_next timestamptz;
begin
  select candidate.* into v_outbox
    from public.booking_notification_outbox candidate
   where candidate.id = p_outbox_id
   for update;
  if not found or v_outbox.state <> 'processing'
     or v_outbox.claim_token is distinct from p_claim_token then
    raise exception 'notification outbox claim mismatch' using errcode = '40001';
  end if;
  select
    count(*) filter (where state = 'processing'),
    count(*) filter (where state in ('pending', 'retry')),
    count(*) filter (where state in ('failed', 'dead_letter')),
    count(*) filter (where state = 'sent'),
    min(next_attempt_at) filter (where state in ('pending', 'retry'))
    into v_active, v_retry, v_dead, v_sent, v_next
    from public.booking_notification_deliveries
   where outbox_id = p_outbox_id and not is_hidden_copy;
  if v_active > 0 then
    return jsonb_build_object('ok', false, 'code', 'DELIVERIES_STILL_PROCESSING');
  elsif v_dead > 0 then
    update public.booking_notification_outbox
       set state = 'dead_letter', completed_at = clock_timestamp(),
           claimed_at = null, claim_token = null,
           last_error = 'One or more recipient deliveries exhausted retries.'
     where id = p_outbox_id;
    return jsonb_build_object('ok', true, 'state', 'dead_letter',
      'sent', v_sent, 'failed', v_dead);
  elsif v_retry > 0 then
    update public.booking_notification_outbox
       set state = 'pending', available_at = coalesce(v_next, clock_timestamp()),
           claimed_at = null, claim_token = null, completed_at = null
     where id = p_outbox_id;
    return jsonb_build_object('ok', true, 'state', 'pending',
      'sent', v_sent, 'retry', v_retry);
  elsif v_sent > 0 then
    update public.booking_notification_outbox
       set state = 'sent', completed_at = clock_timestamp(),
           claimed_at = null, claim_token = null, last_error = null
     where id = p_outbox_id;
    return jsonb_build_object('ok', true, 'state', 'sent', 'sent', v_sent);
  end if;
  return jsonb_build_object('ok', false, 'code', 'NO_VISIBLE_DELIVERIES');
end;
$$;

create or replace function public.fail_booking_notification_outbox_v1(
  p_outbox_id uuid,
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
  update public.booking_notification_outbox outbox
     set state = case when outbox.attempt_count >= outbox.max_attempts
           then 'dead_letter' else 'pending' end,
         available_at = case when outbox.attempt_count >= outbox.max_attempts
           then outbox.available_at else clock_timestamp() + interval '1 minute' end,
         completed_at = case when outbox.attempt_count >= outbox.max_attempts
           then clock_timestamp() else null end,
         claimed_at = null,
         claim_token = null,
         last_error = left(coalesce(p_error, 'Notification processing failed.'), 1000)
   where outbox.id = p_outbox_id
     and outbox.state = 'processing'
     and outbox.claim_token = p_claim_token
  returning outbox.state into v_state;
  if not found then
    raise exception 'notification outbox claim mismatch' using errcode = '40001';
  end if;
  return v_state;
end;
$$;

revoke all on function public.claim_booking_notification_outbox_v2(integer,uuid),
  public.complete_booking_notification_recipient_expansion_v1(uuid,uuid),
  public.claim_booking_notification_deliveries_v1(uuid,uuid,integer),
  public.store_booking_notification_render_v1(uuid,uuid,jsonb),
  public.mark_booking_notification_delivery_sent_v1(uuid,uuid,text),
  public.fail_booking_notification_delivery_v1(uuid,uuid,text),
  public.finalize_booking_notification_outbox_v1(uuid,uuid),
  public.fail_booking_notification_outbox_v1(uuid,uuid,text)
  from public, anon, authenticated;
revoke execute on function public.claim_booking_notification_outbox_v1(integer,uuid)
  from service_role;
grant execute on function public.claim_booking_notification_outbox_v2(integer,uuid),
  public.complete_booking_notification_recipient_expansion_v1(uuid,uuid),
  public.claim_booking_notification_deliveries_v1(uuid,uuid,integer),
  public.store_booking_notification_render_v1(uuid,uuid,jsonb),
  public.mark_booking_notification_delivery_sent_v1(uuid,uuid,text),
  public.fail_booking_notification_delivery_v1(uuid,uuid,text),
  public.finalize_booking_notification_outbox_v1(uuid,uuid),
  public.fail_booking_notification_outbox_v1(uuid,uuid,text)
  to service_role;

comment on column public.booking_notification_outbox.recipients_expanded_at is
  'Freezes the visible recipient set for this occurrence. Later retries cannot add a newly changed booking/profile address.';
comment on function public.finalize_booking_notification_outbox_v1(uuid,uuid) is
  'Derives occurrence outcome from independent visible-recipient rows; sent recipients stay terminal while only retry recipients become eligible again.';
