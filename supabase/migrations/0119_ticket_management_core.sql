-- Ticket Management core domain.
--
-- This migration adds request identity and immutable request history only. It
-- deliberately does not add quotations, wallet movement, API exposure,
-- supplier integration, or customer/staff UI behavior.

create table public.ticket_management_requests (
  id uuid primary key default gen_random_uuid(),
  public_ref text not null default (
    'TMR' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  ),
  booking_id uuid not null
    references public.flight_bookings(id) on delete restrict,
  action text not null
    check (action in ('refund', 'reissue', 'void')),
  status text not null default 'requested'
    check (status in (
      'requested', 'in-progress', 'awaiting-confirmation', 'approved',
      'completed', 'rejected', 'expired'
    )),
  terminal_outcome text
    check (terminal_outcome is null or terminal_outcome in (
      'staff-rejected', 'customer-rejected', 'confirmation-expired',
      'refunded', 'reissued', 'voided'
    )),
  version integer not null default 1 check (version > 0),
  request_key text not null unique
    check (char_length(request_key) between 1 and 220),
  request_payload_hash text not null
    check (request_payload_hash ~ '^[a-f0-9]{64}$'),

  requested_by_user_id text not null,
  requested_by_role text not null,
  request_note text
    check (request_note is null or char_length(request_note) <= 2000),

  booking_owner_type text not null
    check (booking_owner_type in ('user', 'agency')),
  booking_owner_key text not null
    check (char_length(btrim(booking_owner_key)) between 1 and 255),
  charged_wallet_account_id uuid not null
    references public.wallet_accounts(id) on delete restrict,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  captured_amount_snapshot bigint not null
    check (captured_amount_snapshot >= 0),
  refunded_amount_snapshot bigint not null
    check (
      refunded_amount_snapshot >= 0
      and refunded_amount_snapshot <= captured_amount_snapshot
    ),

  accepted_by_user_id text,
  accepted_at timestamptz,
  approved_at timestamptz,
  completed_at timestamptz,
  rejected_at timestamptz,
  expired_at timestamptz,
  status_changed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  constraint ticket_management_requests_public_ref_check
    check (public_ref ~ '^TMR[A-F0-9]{12}$'),
  constraint ticket_management_requests_terminal_state_check
    check (
      (status = 'completed' and terminal_outcome in ('refunded', 'reissued', 'voided'))
      or (status = 'rejected' and terminal_outcome in ('staff-rejected', 'customer-rejected'))
      or (status = 'expired' and terminal_outcome = 'confirmation-expired')
      or (
        status not in ('completed', 'rejected', 'expired')
        and terminal_outcome is null
      )
    ),
  constraint ticket_management_requests_action_outcome_check
    check (
      status <> 'completed'
      or (action = 'refund' and terminal_outcome = 'refunded')
      or (action = 'reissue' and terminal_outcome = 'reissued')
      or (action = 'void' and terminal_outcome = 'voided')
    ),
  constraint ticket_management_requests_status_timestamps_check
    check (
      (status <> 'completed' or completed_at is not null)
      and (status <> 'rejected' or rejected_at is not null)
      and (status <> 'expired' or expired_at is not null)
    )
);

create unique index ticket_management_requests_public_ref_key
  on public.ticket_management_requests(public_ref);
create index ticket_management_requests_booking_created_idx
  on public.ticket_management_requests(booking_id, created_at desc, id);
create index ticket_management_requests_queue_idx
  on public.ticket_management_requests(action, status, created_at, id);
create index ticket_management_requests_owner_idx
  on public.ticket_management_requests(
    booking_owner_type, booking_owner_key, created_at desc, id
  );
create index ticket_management_requests_wallet_idx
  on public.ticket_management_requests(charged_wallet_account_id, created_at desc);

create trigger ticket_management_requests_touch_updated_at
  before update on public.ticket_management_requests
  for each row execute function public.touch_updated_at();

create table public.ticket_management_request_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.ticket_management_requests(id) on delete restrict,
  occurrence_number integer not null check (occurrence_number > 0),
  event_type text not null
    check (event_type in (
      'requested', 'accepted', 'staff-rejected', 'quotation-published',
      'customer-approved', 'customer-rejected', 'confirmation-expired',
      'assigned', 'reassigned', 'manual-processing-recorded',
      'requote-started', 'wallet-held', 'wallet-captured',
      'wallet-released', 'wallet-credited', 'completed',
      'financial-exception'
    )),
  from_status text
    check (from_status is null or from_status in (
      'requested', 'in-progress', 'awaiting-confirmation', 'approved',
      'completed', 'rejected', 'expired'
    )),
  to_status text not null
    check (to_status in (
      'requested', 'in-progress', 'awaiting-confirmation', 'approved',
      'completed', 'rejected', 'expired'
    )),
  request_version integer not null check (request_version > 0),
  actor_user_id text not null,
  actor_role text not null,
  note text check (note is null or char_length(note) <= 2000),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  idempotency_key text not null unique
    check (char_length(idempotency_key) between 1 and 220),
  effective_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  unique (request_id, occurrence_number)
);

create index ticket_management_events_request_created_idx
  on public.ticket_management_request_events(request_id, occurrence_number, id);
create index ticket_management_events_type_created_idx
  on public.ticket_management_request_events(event_type, created_at desc, id);

create or replace function public.prevent_ticket_management_event_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'ticket management request events are immutable'
    using errcode = '55000';
end;
$$;

create trigger ticket_management_events_deny_update_delete
  before update or delete on public.ticket_management_request_events
  for each row execute function public.prevent_ticket_management_event_mutation_v1();

alter table public.ticket_management_requests enable row level security;
alter table public.ticket_management_request_events enable row level security;

revoke all on public.ticket_management_requests
  from public, anon, authenticated;
revoke all on public.ticket_management_request_events
  from public, anon, authenticated;
grant select, insert, update on public.ticket_management_requests to service_role;
grant select, insert on public.ticket_management_request_events to service_role;

revoke all on function public.prevent_ticket_management_event_mutation_v1()
  from public, anon, authenticated, service_role;

comment on table public.ticket_management_requests is
  'Independent Refund/Reissue/VOID request lifecycle for confirmed/ticketed bookings. Financial action is added only through later request-bound functions.';
comment on table public.ticket_management_request_events is
  'Immutable occurrence history for Ticket Management status, assignment, quotation, operational, and wallet events.';
