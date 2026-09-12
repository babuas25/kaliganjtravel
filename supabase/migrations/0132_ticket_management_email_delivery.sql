-- Durable, per-recipient Ticket Management email delivery.
--
-- 0126 intentionally stopped at render-safe notification intents. This
-- migration enables recipient expansion and email delivery while preserving
-- the transactional outbox boundary. Supplier commercial values never enter
-- customer notification snapshots.

alter table public.ticket_management_notification_outbox
  add column claim_token uuid,
  add column max_attempts integer not null default 8 check (max_attempts > 0),
  add column recipients_expanded_at timestamptz,
  add column completed_at timestamptz;

create table public.ticket_management_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null
    references public.ticket_management_notification_outbox(id) on delete restrict,
  recipient_kind text not null check (recipient_kind in (
    'requester', 'booking_contact', 'booking_user', 'internal_staff'
  )),
  recipient_address text not null,
  recipient_address_hash text not null,
  state text not null default 'pending' check (state in (
    'pending', 'processing', 'retry', 'sent', 'dead-letter'
  )),
  rendered_content jsonb,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 8 check (max_attempts > 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  claim_token uuid,
  sent_at timestamptz,
  completed_at timestamptz,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (outbox_id, recipient_address_hash)
);

create index ticket_management_notification_delivery_pending_idx
  on public.ticket_management_notification_deliveries(next_attempt_at, created_at, id)
  where state in ('pending', 'retry');
create trigger ticket_management_notification_delivery_touch_updated_at
  before update on public.ticket_management_notification_deliveries
  for each row execute function public.touch_updated_at();

create or replace function public.enqueue_ticket_management_notification_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.ticket_management_requests;
  v_quote public.ticket_management_quotes;
  v_snapshot jsonb;
  v_audience text;
begin
  select request.* into strict v_request
    from public.ticket_management_requests request
   where request.id = new.request_id;
  if v_request.active_quote_id is not null or v_request.approved_quote_id is not null then
    select quote.* into v_quote
      from public.ticket_management_quotes quote
     where quote.id = coalesce(v_request.approved_quote_id, v_request.active_quote_id);
  end if;

  v_snapshot := jsonb_build_object(
    'version', 1,
    'requestPublicRef', v_request.public_ref,
    'action', v_request.action,
    'status', new.to_status,
    'eventType', new.event_type,
    'effectiveAt', new.effective_at,
    'currency', v_request.currency,
    'quote', case when v_quote.id is null then null else jsonb_build_object(
      'quoteVersion', v_quote.quote_version,
      'direction', v_quote.direction,
      'customerAmount', v_quote.customer_amount,
      'confirmationDeadlineAt', v_quote.confirmation_deadline_at
    ) end
  );

  if new.event_type in (
    'requested', 'accepted', 'staff-rejected', 'quotation-published',
    'customer-approved', 'customer-rejected', 'confirmation-expired',
    'requote-started', 'assigned', 'reassigned', 'manual-processing-recorded',
    'completed'
  ) then
    foreach v_audience in array array['customer', 'internal'] loop
      insert into public.ticket_management_notification_outbox (
        event_id, request_id, audience, event_type, occurrence_key, snapshot
      ) values (
        new.id, new.request_id, v_audience, new.event_type,
        'ticket-management:' || new.id || ':' || v_audience,
        case when v_audience = 'internal' then
          v_snapshot || jsonb_build_object(
            'requestId', v_request.id,
            'activeAssigneeUserId', v_request.active_assignee_user_id,
            'activeAssigneeRole', v_request.active_assignee_role
          )
        else v_snapshot end
      ) on conflict (event_id, audience) do nothing;
    end loop;
  elsif new.event_type = 'financial-exception' then
    insert into public.ticket_management_notification_outbox (
      event_id, request_id, audience, event_type, occurrence_key, snapshot
    ) values (
      new.id, new.request_id, 'internal', new.event_type,
      'ticket-management:' || new.id || ':internal',
      v_snapshot || jsonb_build_object(
        'requestId', v_request.id,
        'activeAssigneeUserId', v_request.active_assignee_user_id,
        'activeAssigneeRole', v_request.active_assignee_role
      )
    ) on conflict (event_id, audience) do nothing;
  end if;
  return new;
end;
$$;

-- Complete the audience pair only for notification work that has not yet
-- been delivered. This avoids a historical bulk-mail backfill.
insert into public.ticket_management_notification_outbox (
  event_id, request_id, audience, event_type, occurrence_key, snapshot,
  state, available_at
)
select
  source.event_id,
  source.request_id,
  case source.audience when 'customer' then 'internal' else 'customer' end,
  source.event_type,
  'ticket-management:' || source.event_id || ':' ||
    case source.audience when 'customer' then 'internal' else 'customer' end,
  case when source.audience = 'customer' then
    source.snapshot || jsonb_build_object(
      'requestId', request.id,
      'activeAssigneeUserId', request.active_assignee_user_id,
      'activeAssigneeRole', request.active_assignee_role
    )
  else source.snapshot - 'requestId' - 'activeAssigneeUserId' - 'activeAssigneeRole' end,
  'pending',
  source.available_at
from public.ticket_management_notification_outbox source
join public.ticket_management_requests request on request.id = source.request_id
where source.state = 'pending'
  and source.event_type in (
    'requested', 'accepted', 'staff-rejected', 'quotation-published',
    'customer-approved', 'customer-rejected', 'confirmation-expired',
    'requote-started', 'assigned', 'reassigned', 'manual-processing-recorded',
    'completed'
  )
on conflict (event_id, audience) do nothing;

create or replace function public.claim_ticket_management_notification_outbox_v1(
  p_limit integer default 25,
  p_request_id uuid default null
)
returns table (
  outbox_id uuid,
  request_id uuid,
  audience text,
  event_type text,
  snapshot jsonb,
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
      from public.ticket_management_notification_outbox candidate
     where candidate.state = 'pending'
       and candidate.available_at <= clock_timestamp()
       and candidate.attempt_count < candidate.max_attempts
       and (p_request_id is null or candidate.request_id = p_request_id)
     order by candidate.available_at, candidate.created_at, candidate.id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), claimed as (
    update public.ticket_management_notification_outbox target
       set state = 'processing', claimed_at = clock_timestamp(),
           claim_token = gen_random_uuid(),
           attempt_count = target.attempt_count + 1,
           last_error = null
      from candidates
     where target.id = candidates.id
     returning target.*
  )
  select claimed.id, claimed.request_id, claimed.audience,
         claimed.event_type, claimed.snapshot,
         claimed.recipients_expanded_at is not null,
         claimed.claim_token, claimed.attempt_count
    from claimed
   order by claimed.available_at, claimed.created_at, claimed.id;
end;
$$;

create or replace function public.expand_ticket_management_notification_recipients_v1(
  p_outbox_id uuid,
  p_claim_token uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox public.ticket_management_notification_outbox;
  v_count integer;
begin
  select candidate.* into v_outbox
    from public.ticket_management_notification_outbox candidate
   where candidate.id = p_outbox_id
   for update;
  if not found or v_outbox.state <> 'processing'
     or v_outbox.claim_token is distinct from p_claim_token then
    raise exception 'notification outbox claim mismatch' using errcode = '40001';
  end if;

  if v_outbox.recipients_expanded_at is null then
    insert into public.ticket_management_notification_deliveries (
      outbox_id, recipient_kind, recipient_address, recipient_address_hash
    )
    select p_outbox_id, recipient.kind, recipient.address,
           encode(digest(recipient.address, 'sha256'), 'hex')
      from (
        select distinct on (address) kind, address
          from (
            select 'requester'::text as kind, lower(btrim(app_user.email)) as address
              from public.ticket_management_requests request
              join public.app_users app_user
                on app_user.clerk_id = request.requested_by_user_id
             where request.id = v_outbox.request_id
               and v_outbox.audience = 'customer'
            union all
            select 'booking_user', lower(btrim(app_user.email))
              from public.ticket_management_requests request
              join public.flight_bookings booking on booking.id = request.booking_id
              join public.app_users app_user on app_user.clerk_id = booking.user_id
             where request.id = v_outbox.request_id
               and v_outbox.audience = 'customer'
            union all
            select 'booking_contact', lower(btrim(booking.passengers #>> '{contact,customerEmail}'))
              from public.ticket_management_requests request
              join public.flight_bookings booking on booking.id = request.booking_id
             where request.id = v_outbox.request_id
               and v_outbox.audience = 'customer'
            union all
            select 'internal_staff', lower(btrim(app_user.email))
              from public.app_users app_user
             where v_outbox.audience = 'internal'
               and app_user.role in ('staff_support', 'staff_account', 'admin', 'superadmin')
          ) candidates
         where address ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
           and char_length(address) <= 320
         order by address, kind
      ) recipient
    on conflict (outbox_id, recipient_address_hash) do nothing;

    select count(*)::integer into v_count
      from public.ticket_management_notification_deliveries delivery
     where delivery.outbox_id = p_outbox_id;
    if v_count = 0 then
      raise exception 'notification has no recipient' using errcode = '23514';
    end if;
    update public.ticket_management_notification_outbox
       set recipients_expanded_at = clock_timestamp()
     where id = p_outbox_id;
  end if;
  select count(*)::integer into v_count
    from public.ticket_management_notification_deliveries delivery
   where delivery.outbox_id = p_outbox_id;
  return v_count;
end;
$$;

create or replace function public.claim_ticket_management_notification_deliveries_v1(
  p_outbox_id uuid,
  p_outbox_claim_token uuid,
  p_limit integer default 25
)
returns table (
  delivery_id uuid,
  recipient_address text,
  recipient_address_hash text,
  rendered_content jsonb,
  delivery_claim_token uuid
)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.ticket_management_notification_outbox candidate
   where candidate.id = p_outbox_id and candidate.state = 'processing'
     and candidate.claim_token = p_outbox_claim_token
     and candidate.recipients_expanded_at is not null
   for update;
  if not found then
    raise exception 'notification outbox claim mismatch' using errcode = '40001';
  end if;
  return query
  with candidates as (
    select candidate.id
      from public.ticket_management_notification_deliveries candidate
     where candidate.outbox_id = p_outbox_id
       and candidate.state in ('pending', 'retry')
       and candidate.next_attempt_at <= clock_timestamp()
       and candidate.attempt_count < candidate.max_attempts
     order by candidate.next_attempt_at, candidate.created_at, candidate.id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 25), 100))
  ), claimed as (
    update public.ticket_management_notification_deliveries target
       set state = 'processing', claimed_at = clock_timestamp(),
           claim_token = gen_random_uuid(),
           attempt_count = target.attempt_count + 1,
           last_error = null
      from candidates
     where target.id = candidates.id
     returning target.*
  )
  select claimed.id, claimed.recipient_address,
         claimed.recipient_address_hash, claimed.rendered_content,
         claimed.claim_token
    from claimed order by claimed.created_at, claimed.id;
end;
$$;

create or replace function public.store_ticket_management_notification_render_v1(
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
  update public.ticket_management_notification_deliveries delivery
     set rendered_content = coalesce(delivery.rendered_content, p_rendered_content)
   where delivery.id = p_delivery_id and delivery.state = 'processing'
     and delivery.claim_token = p_delivery_claim_token
  returning delivery.rendered_content into v_content;
  if not found then raise exception 'delivery claim mismatch' using errcode = '40001'; end if;
  return v_content;
end;
$$;

create or replace function public.mark_ticket_management_notification_delivery_sent_v1(
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
  update public.ticket_management_notification_deliveries delivery
     set state = 'sent', sent_at = clock_timestamp(), completed_at = clock_timestamp(),
         provider_message_id = nullif(left(p_provider_message_id, 500), ''),
         claimed_at = null, claim_token = null, last_error = null
   where delivery.id = p_delivery_id and delivery.state = 'processing'
     and delivery.claim_token = p_delivery_claim_token;
  return found;
end;
$$;

create or replace function public.fail_ticket_management_notification_delivery_v1(
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
  update public.ticket_management_notification_deliveries delivery
     set state = case when delivery.attempt_count >= delivery.max_attempts
           then 'dead-letter' else 'retry' end,
         next_attempt_at = clock_timestamp() +
           case delivery.attempt_count when 1 then interval '1 minute'
             when 2 then interval '5 minutes' when 3 then interval '15 minutes'
             else interval '1 hour' end,
         completed_at = case when delivery.attempt_count >= delivery.max_attempts
           then clock_timestamp() else null end,
         claimed_at = null, claim_token = null,
         last_error = left(coalesce(p_error, 'Email delivery failed.'), 1000)
   where delivery.id = p_delivery_id and delivery.state = 'processing'
     and delivery.claim_token = p_delivery_claim_token
  returning delivery.state into v_state;
  if not found then raise exception 'delivery claim mismatch' using errcode = '40001'; end if;
  return v_state;
end;
$$;

create or replace function public.finalize_ticket_management_notification_outbox_v1(
  p_outbox_id uuid,
  p_claim_token uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_processing integer; v_waiting integer; v_dead integer; v_next timestamptz; v_state text;
begin
  perform 1 from public.ticket_management_notification_outbox candidate
   where candidate.id = p_outbox_id and candidate.state = 'processing'
     and candidate.claim_token = p_claim_token for update;
  if not found then raise exception 'outbox claim mismatch' using errcode = '40001'; end if;
  select count(*) filter (where state = 'processing'),
         count(*) filter (where state in ('pending', 'retry')),
         count(*) filter (where state = 'dead-letter'),
         min(next_attempt_at) filter (where state in ('pending', 'retry'))
    into v_processing, v_waiting, v_dead, v_next
    from public.ticket_management_notification_deliveries
   where outbox_id = p_outbox_id;
  if v_processing > 0 then return 'processing'; end if;
  v_state := case when v_dead > 0 then 'dead-letter'
                  when v_waiting > 0 then 'pending' else 'processed' end;
  update public.ticket_management_notification_outbox
     set state = v_state,
         available_at = case when v_state = 'pending' then coalesce(v_next, clock_timestamp()) else available_at end,
         completed_at = case when v_state in ('processed', 'dead-letter') then clock_timestamp() else null end,
         processed_at = case when v_state = 'processed' then clock_timestamp() else processed_at end,
         claimed_at = null, claim_token = null,
         last_error = case when v_state = 'dead-letter' then 'One or more email deliveries exhausted retries.' else null end
   where id = p_outbox_id;
  return v_state;
end;
$$;

create or replace function public.fail_ticket_management_notification_outbox_v1(
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
  update public.ticket_management_notification_outbox outbox
     set state = case when outbox.attempt_count >= outbox.max_attempts then 'dead-letter' else 'pending' end,
         available_at = clock_timestamp() + interval '5 minutes',
         completed_at = case when outbox.attempt_count >= outbox.max_attempts then clock_timestamp() else null end,
         claimed_at = null, claim_token = null,
         last_error = left(coalesce(p_error, 'Notification processing failed.'), 1000)
   where outbox.id = p_outbox_id and outbox.state = 'processing'
     and outbox.claim_token = p_claim_token
  returning outbox.state into v_state;
  if not found then raise exception 'outbox claim mismatch' using errcode = '40001'; end if;
  return v_state;
end;
$$;

create or replace function public.recover_stale_ticket_management_notification_claims_v1(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_delivery_count integer := 0; v_outbox_count integer := 0; v_cutoff timestamptz := clock_timestamp() - interval '15 minutes';
begin
  with candidates as (
    select id from public.ticket_management_notification_deliveries
     where state = 'processing' and claimed_at <= v_cutoff
     order by claimed_at, id for update skip locked
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  update public.ticket_management_notification_deliveries delivery
     set state = 'retry', next_attempt_at = clock_timestamp(),
         claimed_at = null, claim_token = null,
         last_error = 'Recovered stale email delivery claim.'
    from candidates where delivery.id = candidates.id;
  get diagnostics v_delivery_count = row_count;
  with candidates as (
    select id from public.ticket_management_notification_outbox
     where state = 'processing' and claimed_at <= v_cutoff
     order by claimed_at, id for update skip locked
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  update public.ticket_management_notification_outbox outbox
     set state = 'pending', available_at = clock_timestamp(),
         claimed_at = null, claim_token = null,
         last_error = 'Recovered stale notification outbox claim.'
    from candidates where outbox.id = candidates.id;
  get diagnostics v_outbox_count = row_count;
  return jsonb_build_object('recoveredDeliveries', v_delivery_count, 'recoveredOutboxes', v_outbox_count);
end;
$$;

alter table public.ticket_management_notification_deliveries enable row level security;
revoke all on public.ticket_management_notification_deliveries
  from public, anon, authenticated;
grant select on public.ticket_management_notification_deliveries to service_role;

revoke all on function public.claim_ticket_management_notification_outbox_v1(integer,uuid),
  public.expand_ticket_management_notification_recipients_v1(uuid,uuid),
  public.claim_ticket_management_notification_deliveries_v1(uuid,uuid,integer),
  public.store_ticket_management_notification_render_v1(uuid,uuid,jsonb),
  public.mark_ticket_management_notification_delivery_sent_v1(uuid,uuid,text),
  public.fail_ticket_management_notification_delivery_v1(uuid,uuid,text),
  public.finalize_ticket_management_notification_outbox_v1(uuid,uuid),
  public.fail_ticket_management_notification_outbox_v1(uuid,uuid,text),
  public.recover_stale_ticket_management_notification_claims_v1(integer)
  from public, anon, authenticated;
grant execute on function public.claim_ticket_management_notification_outbox_v1(integer,uuid),
  public.expand_ticket_management_notification_recipients_v1(uuid,uuid),
  public.claim_ticket_management_notification_deliveries_v1(uuid,uuid,integer),
  public.store_ticket_management_notification_render_v1(uuid,uuid,jsonb),
  public.mark_ticket_management_notification_delivery_sent_v1(uuid,uuid,text),
  public.fail_ticket_management_notification_delivery_v1(uuid,uuid,text),
  public.finalize_ticket_management_notification_outbox_v1(uuid,uuid),
  public.fail_ticket_management_notification_outbox_v1(uuid,uuid,text),
  public.recover_stale_ticket_management_notification_claims_v1(integer)
  to service_role;

comment on table public.ticket_management_notification_deliveries is
  'Immutable-recipient, independently retried email deliveries for one Ticket Management event audience.';
