-- Transactional Ticket Management notification intents.
--
-- These rows are deliberately separate from booking-status notification
-- tables because Ticket Management statuses and audiences are a different
-- domain. This migration queues render-safe intents only; it does not send
-- email or expand real recipients.

create table public.ticket_management_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null
    references public.ticket_management_request_events(id) on delete restrict,
  request_id uuid not null
    references public.ticket_management_requests(id) on delete restrict,
  audience text not null check (audience in ('customer', 'internal')),
  event_type text not null,
  occurrence_key text not null unique
    check (char_length(occurrence_key) between 1 and 255),
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  state text not null default 'pending'
    check (state in ('pending', 'processing', 'processed', 'suppressed', 'dead-letter')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default clock_timestamp(),
  claimed_at timestamptz,
  processed_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (event_id, audience)
);

create index ticket_management_notification_pending_idx
  on public.ticket_management_notification_outbox(available_at, created_at, id)
  where state = 'pending';
create index ticket_management_notification_request_idx
  on public.ticket_management_notification_outbox(request_id, created_at, id);

create trigger ticket_management_notification_touch_updated_at
  before update on public.ticket_management_notification_outbox
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
    'accepted', 'staff-rejected', 'quotation-published',
    'confirmation-expired', 'requote-started', 'completed'
  ) then
    insert into public.ticket_management_notification_outbox (
      event_id, request_id, audience, event_type, occurrence_key, snapshot
    ) values (
      new.id, new.request_id, 'customer', new.event_type,
      'ticket-management:' || new.id || ':customer', v_snapshot
    ) on conflict (event_id, audience) do nothing;
  end if;

  if new.event_type in (
    'requested', 'customer-approved', 'customer-rejected',
    'completed', 'financial-exception'
  ) then
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

create trigger ticket_management_events_enqueue_notification
  after insert on public.ticket_management_request_events
  for each row execute function public.enqueue_ticket_management_notification_v1();

alter table public.ticket_management_notification_outbox enable row level security;
revoke all on public.ticket_management_notification_outbox
  from public, anon, authenticated;
grant select on public.ticket_management_notification_outbox to service_role;
revoke all on function public.enqueue_ticket_management_notification_v1()
  from public, anon, authenticated, service_role;

comment on table public.ticket_management_notification_outbox is
  'Transactional render-safe Ticket Management notification intents. Recipient expansion and delivery remain disabled until separately approved.';
