-- Staff-controlled B2B booking visibility.
--
-- This is intentionally independent of booking lifecycle and accounting. A
-- hidden booking remains available to every internal worker and staff query;
-- only customer/B2B application readers apply the visibility flag.

alter table public.flight_bookings
  add column if not exists hidden_from_user boolean not null default false,
  add column if not exists hidden_by_user_id text,
  add column if not exists hidden_at timestamptz,
  add column if not exists hidden_reason text;

alter table public.flight_bookings
  drop constraint if exists flight_bookings_user_visibility_consistency;
alter table public.flight_bookings
  add constraint flight_bookings_user_visibility_consistency
  check (
    (
      hidden_from_user
      and hidden_at is not null
      and nullif(btrim(hidden_by_user_id), '') is not null
      and char_length(hidden_by_user_id) <= 255
      and char_length(btrim(hidden_reason)) between 3 and 1000
    )
    or
    (
      not hidden_from_user
      and hidden_at is null
      and hidden_by_user_id is null
      and hidden_reason is null
    )
  );

comment on column public.flight_bookings.hidden_from_user is
  'Visibility-only flag for normal B2B/customer reads. It never changes lifecycle, supplier, or wallet processing.';
comment on column public.flight_bookings.hidden_by_user_id is
  'Staff user who most recently hid the booking; cleared on restore while the immutable event remains.';
comment on column public.flight_bookings.hidden_at is
  'Time the current hidden state began; cleared on restore.';
comment on column public.flight_bookings.hidden_reason is
  'Reason for the current hidden state; immutable history is retained in booking_user_visibility_events.';

create index if not exists flight_bookings_visible_agency_created_idx
  on public.flight_bookings (agency_code, created_at desc)
  where not legacy_operational and not hidden_from_user;

create table if not exists public.booking_user_visibility_events (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.flight_bookings (id) on delete restrict,
  request_key text not null unique
    check (char_length(request_key) between 1 and 220),
  action text not null check (action in ('hide', 'unhide')),
  hidden_after boolean not null,
  actor_user_id text not null
    check (char_length(actor_user_id) between 1 and 255),
  actor_role text not null
    check (actor_role in ('superadmin', 'admin', 'staff_support')),
  reason text not null check (char_length(btrim(reason)) between 3 and 1000),
  effective_status text not null
    check (effective_status in (
      'pending', 'on-hold', 'in-progress', 'confirmed', 'cancelled',
      'expired', 'unconfirmed'
    )),
  eligibility_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(eligibility_snapshot) = 'object'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default clock_timestamp()
);

create index if not exists booking_user_visibility_events_booking_created_idx
  on public.booking_user_visibility_events (booking_id, created_at desc);

create or replace function public.deny_booking_user_visibility_event_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'booking user visibility events are immutable'
    using errcode = '55000';
end;
$$;

drop trigger if exists booking_user_visibility_events_immutable_v1
  on public.booking_user_visibility_events;
create trigger booking_user_visibility_events_immutable_v1
  before update or delete on public.booking_user_visibility_events
  for each row execute function public.deny_booking_user_visibility_event_mutation_v1();

alter table public.booking_user_visibility_events enable row level security;
revoke all on table public.booking_user_visibility_events
  from public, anon, authenticated;
grant select, insert on table public.booking_user_visibility_events
  to service_role;

comment on table public.booking_user_visibility_events is
  'Immutable audit trail for hiding and restoring B2B bookings in normal user-facing reads.';

-- One authoritative eligibility classifier is shared by the UI preview and
-- the locked mutation. It fails closed on either wallet records or stale
-- denormalized financial markers.
create or replace function public.booking_user_hide_eligibility_v1(
  p_booking_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_effective_status text;
  v_reservation_count integer := 0;
  v_ledger_count integer := 0;
  v_summary_clean boolean := false;
  v_eligible boolean := false;
  v_code text;
begin
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  v_effective_status := public.resolve_booking_lifecycle(
    v_booking.status,
    v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at,
    v_booking.operation_kind
  );

  select count(*)::integer into v_reservation_count
    from public.wallet_reservations reservation
   where reservation.booking_id = v_booking.id
      or reservation.booking_attempt_id = v_booking.attempt_id;

  select count(*)::integer into v_ledger_count
    from public.wallet_ledger_entries ledger
   where ledger.booking_id = v_booking.id
      or ledger.booking_reference = v_booking.public_ref
      or exists (
        select 1
          from public.wallet_reservations reservation
         where reservation.id = ledger.reservation_id
           and (
             reservation.booking_id = v_booking.id
             or reservation.booking_attempt_id = v_booking.attempt_id
           )
      );

  v_summary_clean :=
    v_booking.payment_state = 'unpaid'
    and v_booking.payment_amount is null
    and coalesce(v_booking.captured_amount, 0) = 0
    and coalesce(v_booking.refunded_amount, 0) = 0
    and v_booking.charged_wallet_account_id is null;

  if v_booking.legacy_operational
     or v_booking.audience <> 'agency'
     or v_booking.booking_owner_type <> 'agency'
     or nullif(btrim(v_booking.agency_code), '') is null then
    v_code := 'NOT_B2B_BOOKING';
  elsif v_effective_status not in ('on-hold', 'cancelled', 'expired') then
    v_code := 'STATUS_NOT_ELIGIBLE';
  elsif v_reservation_count > 0 or v_ledger_count > 0 then
    v_code := 'WALLET_FOOTPRINT_FOUND';
  elsif not v_summary_clean then
    v_code := 'FINANCIAL_SUMMARY_NOT_CLEAN';
  else
    v_eligible := true;
    v_code := 'ELIGIBLE';
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', v_code,
    'bookingId', v_booking.id,
    'bookingReference', v_booking.public_ref,
    'hiddenFromUser', v_booking.hidden_from_user,
    'hiddenByUserId', v_booking.hidden_by_user_id,
    'hiddenAt', v_booking.hidden_at,
    'hiddenReason', v_booking.hidden_reason,
    'effectiveStatus', v_effective_status,
    'eligibleToHide', v_eligible,
    'reservationCount', v_reservation_count,
    'ledgerCount', v_ledger_count,
    'financialSummaryClean', v_summary_clean
  );
end;
$$;

create or replace function public.booking_user_visibility_context_v1(
  p_booking_id uuid,
  p_actor_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_context jsonb;
  v_last_event public.booking_user_visibility_events;
begin
  select user_row.role into v_actor_role
    from public.app_users user_row
   where user_row.clerk_id = p_actor_user_id;
  if v_actor_role is null
     or v_actor_role not in ('superadmin', 'admin', 'staff_support') then
    return jsonb_build_object('ok', false, 'code', 'VISIBILITY_FORBIDDEN');
  end if;

  v_context := public.booking_user_hide_eligibility_v1(p_booking_id);
  if coalesce((v_context->>'ok')::boolean, false) = false then
    return v_context;
  end if;

  select event.* into v_last_event
    from public.booking_user_visibility_events event
   where event.booking_id = p_booking_id
   order by event.created_at desc, event.id desc
   limit 1;

  return v_context || jsonb_build_object(
    'canManage', true,
    'lastAction', v_last_event.action,
    'lastActionAt', v_last_event.created_at,
    'lastActionByUserId', v_last_event.actor_user_id,
    'lastActionReason', v_last_event.reason
  );
end;
$$;

create or replace function public.set_booking_user_visibility_v1(
  p_booking_reference text,
  p_action text,
  p_reason text,
  p_actor_user_id text,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_booking public.flight_bookings;
  v_attempt public.booking_attempts;
  v_existing public.booking_user_visibility_events;
  v_eligibility jsonb;
  v_effective_status text;
  v_result jsonb;
  v_hidden_after boolean;
  v_suppressed_outboxes integer := 0;
begin
  if p_action not in ('hide', 'unhide')
     or nullif(btrim(p_booking_reference), '') is null
     or nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_request_key), '') is null
     or char_length(p_request_key) > 220
     or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 1000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_VISIBILITY_REQUEST');
  end if;

  select user_row.role into v_actor_role
    from public.app_users user_row
   where user_row.clerk_id = p_actor_user_id;
  if v_actor_role is null
     or v_actor_role not in ('superadmin', 'admin', 'staff_support') then
    return jsonb_build_object('ok', false, 'code', 'VISIBILITY_FORBIDDEN');
  end if;

  -- Serialize replay detection too: two deliveries of the same command must
  -- converge on one immutable event rather than racing the unique constraint.
  perform pg_advisory_xact_lock(
    hashtextextended('booking-user-visibility:' || p_request_key, 0)
  );

  select event.* into v_existing
    from public.booking_user_visibility_events event
   where event.request_key = p_request_key;
  if found then
    if v_existing.actor_user_id <> p_actor_user_id
       or v_existing.action <> p_action
       or v_existing.reason <> btrim(p_reason)
       or not exists (
         select 1 from public.flight_bookings booking
          where booking.id = v_existing.booking_id
            and booking.public_ref = btrim(p_booking_reference)
       ) then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_KEY_REUSED');
    end if;
    return v_existing.result || jsonb_build_object('replay', true);
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.public_ref = btrim(p_booking_reference)
     and not booking.legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  -- Lock the attempt as well as all related reservation rows. Existing wallet
  -- functions use these foreign-key subjects, so the eligibility snapshot and
  -- state change are serialized with normal booking finance operations.
  select attempt.* into v_attempt
    from public.booking_attempts attempt
   where attempt.id = v_booking.attempt_id
   for update;

  perform 1
    from public.wallet_reservations reservation
   where reservation.booking_id = v_booking.id
      or reservation.booking_attempt_id = v_booking.attempt_id
   for update;

  v_eligibility := public.booking_user_hide_eligibility_v1(v_booking.id);
  v_effective_status := v_eligibility->>'effectiveStatus';

  if p_action = 'hide' then
    if v_booking.hidden_from_user then
      return jsonb_build_object(
        'ok', false, 'code', 'ALREADY_HIDDEN',
        'hiddenFromUser', true
      );
    end if;
    if coalesce((v_eligibility->>'eligibleToHide')::boolean, false) = false then
      return jsonb_build_object(
        'ok', false,
        'code', coalesce(v_eligibility->>'code', 'NOT_ELIGIBLE'),
        'context', v_eligibility
      );
    end if;

    -- Serialize with recipient claiming. Once a visible delivery has entered
    -- its external send window, hiding waits for that attempt to finish rather
    -- than claiming success while an email may still leave the process.
    perform 1
      from public.booking_notification_outbox outbox
     where outbox.booking_id = v_booking.id
       and outbox.state in ('pending', 'processing')
     order by outbox.id
     for update;
    if exists (
      select 1
        from public.booking_notification_deliveries delivery
        join public.booking_notification_outbox outbox
          on outbox.id = delivery.outbox_id
       where outbox.booking_id = v_booking.id
         and delivery.state = 'processing'
         and not delivery.is_hidden_copy
    ) then
      return jsonb_build_object(
        'ok', false,
        'code', 'NOTIFICATION_DELIVERY_IN_PROGRESS'
      );
    end if;

    update public.flight_bookings
       set hidden_from_user = true,
           hidden_by_user_id = p_actor_user_id,
           hidden_at = clock_timestamp(),
           hidden_reason = btrim(p_reason)
     where id = v_booking.id;

    update public.booking_notification_deliveries delivery
       set state = 'suppressed',
           suppression_reason = 'booking_hidden_from_user',
           completed_at = clock_timestamp(),
           claimed_at = null,
           claim_token = null,
           last_error = null
      from public.booking_notification_outbox outbox
     where outbox.id = delivery.outbox_id
       and outbox.booking_id = v_booking.id
       and delivery.state in ('pending', 'retry', 'failed')
       and not delivery.is_hidden_copy;

    update public.booking_notification_outbox outbox
       set state = 'suppressed',
           delivery_policy = 'suppress',
           suppression_reason = 'booking_hidden_from_user',
           completed_at = clock_timestamp(),
           claimed_at = null,
           claim_token = null,
           last_error = null
     where outbox.booking_id = v_booking.id
       and outbox.state in ('pending', 'processing');
    get diagnostics v_suppressed_outboxes = row_count;
    v_hidden_after := true;
  else
    if not v_booking.hidden_from_user then
      return jsonb_build_object(
        'ok', false, 'code', 'ALREADY_VISIBLE',
        'hiddenFromUser', false
      );
    end if;
    update public.flight_bookings
       set hidden_from_user = false,
           hidden_by_user_id = null,
           hidden_at = null,
           hidden_reason = null
     where id = v_booking.id;
    v_hidden_after := false;
  end if;

  v_result := jsonb_build_object(
    'ok', true,
    'replay', false,
    'bookingId', v_booking.id,
    'bookingReference', v_booking.public_ref,
    'action', p_action,
    'hiddenFromUser', v_hidden_after,
    'effectiveStatus', v_effective_status,
    'suppressedNotificationOutboxes', v_suppressed_outboxes
  );

  insert into public.booking_user_visibility_events (
    booking_id, request_key, action, hidden_after, actor_user_id,
    actor_role, reason, effective_status, eligibility_snapshot, result
  ) values (
    v_booking.id, p_request_key, p_action, v_hidden_after, p_actor_user_id,
    v_actor_role, btrim(p_reason), v_effective_status, v_eligibility, v_result
  );

  insert into public.security_audit_events (
    actor_user_id, actor_role, action, target_type, target_id,
    outcome, metadata
  ) values (
    p_actor_user_id, v_actor_role,
    case when p_action = 'hide'
      then 'flight_booking.hide_from_user'
      else 'flight_booking.restore_to_user'
    end,
    'flight_booking', v_booking.id::text, 'succeeded',
    jsonb_build_object(
      'requestKey', p_request_key,
      'bookingReference', v_booking.public_ref,
      'effectiveStatus', v_effective_status,
      'hiddenAfter', v_hidden_after,
      'suppressedNotificationOutboxes', v_suppressed_outboxes,
      'walletMutation', false,
      'supplierMutation', false,
      'lifecycleMutation', false
    )
  );

  return v_result;
end;
$$;

-- Terminally suppresses one already-created occurrence when its booking is
-- hidden. The event and outbox row remain durable; Restore never requeues it.
create or replace function public.suppress_claimed_booking_notification_for_hidden_user_v1(
  p_outbox_id uuid,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking_id uuid;
  v_booking public.flight_bookings;
  v_outbox public.booking_notification_outbox;
begin
  select outbox.booking_id into v_booking_id
    from public.booking_notification_outbox outbox
   where outbox.id = p_outbox_id;
  if not found then return false; end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = v_booking_id
   for update;
  if not found
     or v_booking.audience <> 'agency'
     or not v_booking.hidden_from_user then
    return false;
  end if;

  select outbox.* into v_outbox
    from public.booking_notification_outbox outbox
   where outbox.id = p_outbox_id
   for update;
  if v_outbox.state = 'suppressed'
     and v_outbox.suppression_reason = 'booking_hidden_from_user' then
    return true;
  end if;
  if v_outbox.state <> 'processing'
     or v_outbox.claim_token is distinct from p_claim_token then
    return false;
  end if;

  update public.booking_notification_deliveries delivery
     set state = 'suppressed',
         suppression_reason = 'booking_hidden_from_user',
         completed_at = clock_timestamp(),
         claimed_at = null,
         claim_token = null,
         last_error = null
   where delivery.outbox_id = p_outbox_id
     and delivery.state in ('pending', 'retry', 'failed')
     and not delivery.is_hidden_copy;

  update public.booking_notification_outbox outbox
     set state = 'suppressed',
         delivery_policy = 'suppress',
         suppression_reason = 'booking_hidden_from_user',
         recipients_expanded_at = coalesce(
           outbox.recipients_expanded_at, clock_timestamp()
         ),
         completed_at = clock_timestamp(),
         claimed_at = null,
         claim_token = null,
         last_error = null
   where outbox.id = p_outbox_id;
  return true;
end;
$$;

-- An occurrence created during a hidden interval must stay suppressed even if
-- it is not claimed until after Restore. Preserve the outbox as evidence while
-- making its delivery decision terminal at creation time.
create or replace function public.suppress_hidden_booking_notification_outbox_on_insert_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hidden boolean := false;
begin
  select booking.audience = 'agency' and booking.hidden_from_user
    into v_hidden
    from public.flight_bookings booking
   where booking.id = new.booking_id
   for key share;
  if coalesce(v_hidden, false) then
    new.delivery_policy := 'suppress';
    new.state := 'suppressed';
    new.suppression_reason := 'booking_hidden_from_user';
    new.completed_at := clock_timestamp();
    new.claimed_at := null;
    new.claim_token := null;
  end if;
  return new;
end;
$$;

drop trigger if exists booking_notification_outbox_hidden_user_suppression_v1
  on public.booking_notification_outbox;
create trigger booking_notification_outbox_hidden_user_suppression_v1
  before insert on public.booking_notification_outbox
  for each row execute function
    public.suppress_hidden_booking_notification_outbox_on_insert_v1();

-- Replace the visible-recipient claim with a booking-row-serialized version.
-- This closes the race between Hide and the start of an external email send:
-- either the delivery claim wins and Hide asks staff to retry, or Hide wins and
-- the occurrence is suppressed without returning a recipient to the worker.
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
declare
  v_booking_id uuid;
  v_booking public.flight_bookings;
  v_outbox public.booking_notification_outbox;
begin
  select outbox.booking_id into v_booking_id
    from public.booking_notification_outbox outbox
   where outbox.id = p_outbox_id;
  if not found then
    raise exception 'notification outbox not found' using errcode = 'P0002';
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = v_booking_id
   for update;
  if not found then
    raise exception 'notification booking not found' using errcode = 'P0002';
  end if;

  select outbox.* into v_outbox
    from public.booking_notification_outbox outbox
   where outbox.id = p_outbox_id
   for update;

  if v_booking.audience = 'agency' and v_booking.hidden_from_user then
    update public.booking_notification_deliveries delivery
       set state = 'suppressed',
           suppression_reason = 'booking_hidden_from_user',
           completed_at = clock_timestamp(),
           claimed_at = null,
           claim_token = null,
           last_error = null
     where delivery.outbox_id = p_outbox_id
       and delivery.state in ('pending', 'retry', 'failed')
       and not delivery.is_hidden_copy;
    update public.booking_notification_outbox outbox
       set state = 'suppressed',
           delivery_policy = 'suppress',
           suppression_reason = 'booking_hidden_from_user',
           recipients_expanded_at = coalesce(
             outbox.recipients_expanded_at, clock_timestamp()
           ),
           completed_at = clock_timestamp(),
           claimed_at = null,
           claim_token = null,
           last_error = null
     where outbox.id = p_outbox_id;
    return;
  end if;

  if v_outbox.state <> 'processing'
     or v_outbox.claim_token is distinct from p_outbox_claim_token
     or v_outbox.recipients_expanded_at is null then
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

revoke all on function public.deny_booking_user_visibility_event_mutation_v1()
  from public, anon, authenticated;
revoke all on function public.booking_user_hide_eligibility_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.booking_user_visibility_context_v1(uuid, text)
  from public, anon, authenticated;
revoke all on function public.set_booking_user_visibility_v1(text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.suppress_claimed_booking_notification_for_hidden_user_v1(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.suppress_hidden_booking_notification_outbox_on_insert_v1()
  from public, anon, authenticated;
grant execute on function public.booking_user_visibility_context_v1(uuid, text)
  to service_role;
grant execute on function public.set_booking_user_visibility_v1(text, text, text, text, text)
  to service_role;
grant execute on function public.suppress_claimed_booking_notification_for_hidden_user_v1(uuid, uuid)
  to service_role;
grant execute on function public.claim_booking_notification_deliveries_v1(uuid, uuid, integer)
  to service_role;

-- PostgreSQL expands `fb.*` when a view is created. Preserve the existing
-- column order and append the visibility fields so dependent views remain
-- valid during a rolling deploy.
do $$
declare
  v_existing_columns text;
begin
  select string_agg(format('fb.%I', attribute.attname), ', ' order by attribute.attnum)
    into v_existing_columns
    from pg_attribute attribute
   where attribute.attrelid = 'public.booking_lifecycle_v'::regclass
     and attribute.attnum > 0
     and not attribute.attisdropped
     and attribute.attname not in (
       'lifecycle_status', 'supplier_account', 'hidden_from_user',
       'hidden_by_user_id', 'hidden_at', 'hidden_reason'
     );

  if v_existing_columns is null then
    raise exception 'booking_lifecycle_v has no expected source columns';
  end if;

  execute format(
    'create or replace view public.booking_lifecycle_v with (security_invoker = true) as
       select %s,
         public.resolve_booking_lifecycle(
           fb.status, fb.airlines_pnr, fb.ticketing_deadline_at, fb.operation_kind
         ) as lifecycle_status,
         fb.supplier_account,
         fb.hidden_from_user,
         fb.hidden_by_user_id,
         fb.hidden_at,
         fb.hidden_reason
       from public.flight_bookings fb
       where not fb.legacy_operational',
    v_existing_columns
  );
end;
$$;

-- Add visibility to the narrow dashboard projection without changing the
-- internal list/order views used by staff lifecycle reporting.
create or replace view public.booking_dashboard_creator_v
with (security_invoker = true)
as
select
  list.*,
  coalesce(nullif(concat_ws(' ', creator.first_name, creator.last_name), ''), creator.email, '')
    as creator_name,
  coalesce(creator.role, '') as creator_role,
  coalesce(creator.email, '') as creator_email,
  creator.agency_code as creator_agency_code,
  nullif(creator_agency_profile.agency_name, '') as creator_agency_name,
  lower(concat_ws(' ',
    coalesce(creator.first_name, ''), coalesce(creator.last_name, ''),
    coalesce(creator.email, ''), coalesce(creator.role, ''),
    coalesce(creator.agency_code, ''), coalesce(creator_agency_profile.agency_name, ''),
    coalesce(booking.agency_code, ''), coalesce(booking_agency_profile.agency_name, '')
  )) as creator_search_text,
  booking.agency_code as booking_agency_code,
  nullif(booking_agency_profile.agency_name, '') as booking_agency_name,
  booking.hidden_from_user,
  booking.hidden_at
from public.booking_dashboard_list_ordered_v list
join public.flight_bookings booking on booking.id = list.id
left join public.app_users creator
  on creator.clerk_id = coalesce(booking.booked_by_user_id, booking.user_id)
left join public.agencies creator_agency
  on creator_agency.agency_code = creator.agency_code
left join public.user_profiles creator_agency_profile
  on creator_agency_profile.clerk_id = creator_agency.owner_user_id
left join public.agencies booking_agency
  on booking_agency.agency_code = booking.agency_code
left join public.user_profiles booking_agency_profile
  on booking_agency_profile.clerk_id = booking_agency.owner_user_id;

comment on view public.booking_dashboard_creator_v is
  'Paginated booking list with creator, owning-agency, and user-visibility state resolved in one read.';
