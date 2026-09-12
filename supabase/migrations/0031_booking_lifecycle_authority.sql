-- Authoritative booking lifecycle, supplier-operation claims, and immutable
-- transition history. Public lifecycle is a projection; supplier writes are
-- protected by transactional claims on the underlying booking row.

alter table public.flight_bookings
  add column if not exists operation_kind text,
  add column if not exists operation_reason text,
  add column if not exists operation_request_id text,
  add column if not exists operation_actor_user_id text,
  add column if not exists operation_started_at timestamptz,
  add column if not exists operation_prior_status text;

-- Old in-progress rows predate durable operation metadata. They are unsafe to
-- classify as ticketing or cancellation, so retain them for explicit review.
update public.flight_bookings
   set operation_kind = 'reconciliation',
       operation_reason = 'legacy_reconciliation',
       operation_started_at = coalesce(updated_at, now()),
       operation_prior_status = 'on-hold'
 where not legacy_operational
   and status = 'in-progress'
   and operation_kind is null;

alter table public.flight_bookings
  add constraint flight_bookings_operation_kind_check
  check (operation_kind is null or operation_kind in (
    'ticketing', 'cancellation', 'reconciliation'
  )),
  add constraint flight_bookings_operation_reason_check
  check (operation_reason is null or operation_reason in (
    'ticketing',
    'supplier_balance_insufficient',
    'ticketing_reconciliation',
    'cancellation',
    'cancellation_reconciliation',
    'terminal_state_conflict',
    'direct_ticket_payment_reconciliation',
    'legacy_reconciliation'
  )),
  add constraint flight_bookings_operation_shape_check
  check (
    legacy_operational
    or (
      (status = 'in-progress' and operation_kind is not null
        and operation_reason is not null and operation_started_at is not null)
      or
      (status in ('confirmed','cancelled')
        and operation_kind = 'reconciliation'
        and operation_reason in ('terminal_state_conflict','direct_ticket_payment_reconciliation')
        and operation_started_at is not null)
      or
      (status <> 'in-progress' and operation_kind is null
        and operation_reason is null and operation_request_id is null
        and operation_actor_user_id is null and operation_started_at is null
        and operation_prior_status is null)
    )
  );

create index if not exists flight_bookings_active_operation_idx
  on public.flight_bookings (operation_started_at)
  where status = 'in-progress' and not legacy_operational;

create table if not exists public.booking_status_events (
  id                    bigint generated always as identity primary key,
  booking_id            uuid not null references public.flight_bookings(id) on delete restrict,
  from_lifecycle_status text,
  to_lifecycle_status   text not null,
  stored_status_before  text,
  stored_status_after   text not null,
  operation_kind        text,
  operation_reason      text,
  actor_user_id         text,
  supplier_operation    text,
  supplier_evidence     jsonb not null default '{}'::jsonb,
  idempotency_key       text,
  created_at            timestamptz not null default now(),
  check (from_lifecycle_status is null or from_lifecycle_status in (
    'on-hold', 'pending', 'in-progress', 'confirmed', 'expired',
    'unconfirmed', 'cancelled'
  )),
  check (to_lifecycle_status in (
    'on-hold', 'pending', 'in-progress', 'confirmed', 'expired',
    'unconfirmed', 'cancelled'
  ))
);

create unique index if not exists booking_status_events_idempotency_idx
  on public.booking_status_events (booking_id, idempotency_key, to_lifecycle_status)
  where idempotency_key is not null;
create index if not exists booking_status_events_booking_created_idx
  on public.booking_status_events (booking_id, created_at desc);

alter table public.booking_status_events enable row level security;
revoke all on table public.booking_status_events from public, anon, authenticated;
grant select, insert on table public.booking_status_events to service_role;
grant usage, select on sequence public.booking_status_events_id_seq to service_role;

create or replace function public.jsonb_is_nonempty_array(p_value jsonb)
returns boolean language sql immutable as $$
  select case when jsonb_typeof(p_value) = 'array'
    then jsonb_array_length(p_value) > 0 else false end
$$;
revoke all on function public.jsonb_is_nonempty_array(jsonb)
  from public, anon, authenticated;
grant execute on function public.jsonb_is_nonempty_array(jsonb) to service_role;

create or replace function public.resolve_booking_lifecycle(
  p_status text,
  p_airlines_pnr jsonb,
  p_ticketing_deadline_at timestamptz,
  p_operation_kind text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_status = 'cancelled' then 'cancelled'
    when p_status = 'confirmed' then 'confirmed'
    when p_status = 'in-progress' or p_operation_kind is not null then 'in-progress'
    when p_status = 'pending' then 'pending'
    when p_status = 'on-hold'
      and not public.jsonb_is_nonempty_array(p_airlines_pnr) then 'unconfirmed'
    when p_status = 'on-hold'
      and p_ticketing_deadline_at is not null
      and p_ticketing_deadline_at <= now() then 'expired'
    else 'on-hold'
  end
$$;

revoke all on function public.resolve_booking_lifecycle(text,jsonb,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.resolve_booking_lifecycle(text,jsonb,timestamptz,text)
  to service_role;

create or replace view public.booking_lifecycle_v
with (security_invoker = true)
as
select
  fb.*,
  public.resolve_booking_lifecycle(
    fb.status, fb.airlines_pnr, fb.ticketing_deadline_at, fb.operation_kind
  ) as lifecycle_status
from public.flight_bookings fb
where not fb.legacy_operational;

revoke all on table public.booking_lifecycle_v from public, anon, authenticated;
grant select on table public.booking_lifecycle_v to service_role;

create or replace view public.booking_payment_report_v
with (security_invoker = true)
as
select
  fb.id as booking_id,
  fb.public_ref,
  fb.booking_owner_type,
  fb.booking_owner_key,
  fb.booked_by_user_id,
  fb.issued_by_user_id,
  fb.charged_wallet_account_id,
  fb.payment_state,
  fb.payment_amount,
  fb.captured_amount,
  fb.refunded_amount,
  fb.currency,
  fb.lifecycle_status as booking_status,
  fb.created_at,
  fb.issued_at
from public.booking_lifecycle_v fb;

insert into public.booking_status_events (
  booking_id, from_lifecycle_status, to_lifecycle_status,
  stored_status_before, stored_status_after, operation_kind,
  operation_reason, supplier_operation, supplier_evidence,
  idempotency_key, created_at
)
select
  fb.id, null,
  public.resolve_booking_lifecycle(
    fb.status, fb.airlines_pnr, fb.ticketing_deadline_at, fb.operation_kind
  ),
  null, fb.status, fb.operation_kind, fb.operation_reason,
  'MigrationBaseline', jsonb_build_object('baseline', true),
  'migration-0031-baseline', now()
from public.flight_bookings fb
where not fb.legacy_operational
on conflict do nothing;

create or replace function public.record_initial_booking_status_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not new.legacy_operational then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, supplier_operation, supplier_evidence,
      idempotency_key, created_at
    ) values (
      new.id, null,
      public.resolve_booking_lifecycle(
        new.status, new.airlines_pnr, new.ticketing_deadline_at, new.operation_kind
      ),
      null, new.status, new.operation_kind, new.operation_reason, 'Book',
      jsonb_build_object('bookingStatus', new.booking_status,
        'airlinesPnr', new.airlines_pnr),
      'booking-created', new.created_at
    ) on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists flight_bookings_initial_status_event
  on public.flight_bookings;
create trigger flight_bookings_initial_status_event
  after insert on public.flight_bookings
  for each row execute function public.record_initial_booking_status_event();

revoke all on function public.record_initial_booking_status_event()
  from public, anon, authenticated;

-- Atomically validates lifecycle and wallet eligibility, reserves funds, and
-- claims the one supplier-write slot before NewTicket leaves the database.
create or replace function public.wallet_begin_booking_issue(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_amount bigint;
  v_result jsonb;
begin
  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id and not legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  if v_booking.status = 'confirmed' or v_booking.payment_state = 'captured' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CAPTURED');
  end if;
  if v_booking.status <> 'on-hold' or v_booking.operation_kind is not null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_ISSUABLE');
  end if;
  if not public.jsonb_is_nonempty_array(v_booking.airlines_pnr) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_UNCONFIRMED');
  end if;
  if v_booking.ticketing_deadline_at is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_DEADLINE_REQUIRED');
  end if;
  if v_booking.ticketing_deadline_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_EXPIRED');
  end if;
  if v_booking.booking_owner_type is null or v_booking.booking_owner_key is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_OWNER_REQUIRED');
  end if;

  begin
    v_amount := round(
      (v_booking.pricing_snapshot->>'sellingPrice')::numeric * 100
    )::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
  end;

  v_result := public.wallet_reserve_amount(
    v_booking.id, null, v_booking.booking_owner_type,
    v_booking.booking_owner_key, v_amount, v_booking.currency,
    p_actor_user_id, p_actor_role, p_idempotency_key,
    v_booking.public_ref
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    return v_result;
  end if;

  update public.flight_bookings
     set status = 'in-progress',
         operation_kind = 'ticketing',
         operation_reason = 'ticketing',
         operation_request_id = p_idempotency_key,
         operation_actor_user_id = p_actor_user_id,
         operation_started_at = now(),
         operation_prior_status = 'on-hold'
   where id = v_booking.id;

  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation, idempotency_key
  ) values (
    v_booking.id, 'on-hold', 'in-progress', 'on-hold', 'in-progress',
    'ticketing', 'ticketing', p_actor_user_id, 'NewTicket',
    p_idempotency_key || ':ticketing-start'
  ) on conflict do nothing;

  return v_result || jsonb_build_object('status', 'in-progress');
end;
$$;

-- Legacy paid Pending rows need a claim too; without it concurrent operational
-- retries can both call NewTicket. No new code should create these rows.
create or replace function public.wallet_begin_legacy_manual_issue(
  p_booking_id uuid,
  p_actor_user_id text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_booking public.flight_bookings;
begin
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  if v_booking.status = 'confirmed' and v_booking.issued_at is not null then
    return jsonb_build_object('ok', true, 'replay', true);
  end if;
  if v_booking.status <> 'pending' or v_booking.payment_state <> 'captured'
     or v_booking.operation_kind is not null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_MANUALLY_ISSUABLE');
  end if;
  update public.flight_bookings set
    status = 'in-progress', operation_kind = 'ticketing',
    operation_reason = 'legacy_reconciliation',
    operation_request_id = p_idempotency_key,
    operation_actor_user_id = p_actor_user_id,
    operation_started_at = now(), operation_prior_status = 'pending'
  where id = p_booking_id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation, idempotency_key
  ) values (
    p_booking_id, 'pending', 'in-progress', 'pending', 'in-progress',
    'ticketing', 'legacy_reconciliation', p_actor_user_id, 'NewTicket',
    p_idempotency_key || ':legacy-ticketing-start'
  ) on conflict do nothing;
  return jsonb_build_object('ok', true, 'status', 'in-progress');
end;
$$;

-- Definitive non-issuance releases the reservation and restores the prior
-- held state in one local transaction.
create or replace function public.wallet_fail_booking_issue(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_release jsonb;
  v_prior text;
begin
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;
  if v_booking.status <> 'in-progress'
     or v_booking.operation_kind not in ('ticketing', 'reconciliation') then
    return jsonb_build_object('ok', false, 'code', 'ISSUE_OPERATION_NOT_ACTIVE');
  end if;
  v_prior := case when v_booking.operation_prior_status = 'pending'
    then 'pending' else 'on-hold' end;
  if v_booking.payment_state = 'captured' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CAPTURED');
  end if;
  v_release := public.wallet_release_reservation(
    p_booking_id, null, p_actor_user_id, p_actor_role,
    p_idempotency_key, p_reason
  );
  if coalesce((v_release->>'ok')::boolean, false) is not true then return v_release; end if;
  update public.flight_bookings set
    status = v_prior, operation_kind = null, operation_reason = null,
    operation_request_id = null, operation_actor_user_id = null,
    operation_started_at = null, operation_prior_status = null
  where id = p_booking_id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key
  ) values (
    p_booking_id, 'in-progress', v_prior, 'in-progress', v_prior,
    v_booking.operation_kind, v_booking.operation_reason, p_actor_user_id,
    'NewTicket', jsonb_build_object('reason', left(coalesce(p_reason,''),1000)),
    p_idempotency_key || ':ticketing-failed'
  ) on conflict do nothing;
  return v_release || jsonb_build_object('status', v_prior);
end;
$$;

-- A single cancellation claim shares the booking-row lock with ticketing.
create or replace function public.begin_booking_cancellation(
  p_booking_id uuid,
  p_actor_user_id text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_booking public.flight_bookings;
begin
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;
  if v_booking.status <> 'on-hold' or v_booking.operation_kind is not null
     or v_booking.issued_at is not null or v_booking.direct_ticketing
     or v_booking.payment_state in ('held','captured','reconciliation') then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_CANCELLABLE');
  end if;
  if not public.jsonb_is_nonempty_array(v_booking.airlines_pnr) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_UNCONFIRMED');
  end if;
  if v_booking.ticketing_deadline_at is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_DEADLINE_REQUIRED');
  end if;
  if v_booking.ticketing_deadline_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_EXPIRED');
  end if;
  update public.flight_bookings set
    status = 'in-progress', operation_kind = 'cancellation',
    operation_reason = 'cancellation', operation_request_id = p_idempotency_key,
    operation_actor_user_id = p_actor_user_id, operation_started_at = now(),
    operation_prior_status = 'on-hold'
  where id = p_booking_id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation, idempotency_key
  ) values (
    p_booking_id, 'on-hold', 'in-progress', 'on-hold', 'in-progress',
    'cancellation', 'cancellation', p_actor_user_id, 'Cancel',
    p_idempotency_key || ':cancellation-start'
  ) on conflict do nothing;
  return jsonb_build_object('ok', true, 'status', 'in-progress');
end;
$$;

-- Restore only after a fresh authoritative PNR read has persisted a valid PNR
-- and future deadline. The route must not use this for ambiguous Cancel results.
create or replace function public.resolve_booking_cancellation_refusal(
  p_booking_id uuid,
  p_actor_user_id text,
  p_idempotency_key text,
  p_evidence jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_booking public.flight_bookings;
begin
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;
  if v_booking.status <> 'in-progress'
     or v_booking.operation_reason <> 'cancellation' then
    return jsonb_build_object('ok', false, 'code', 'CANCELLATION_OPERATION_NOT_ACTIVE');
  end if;
  if not public.jsonb_is_nonempty_array(v_booking.airlines_pnr)
     or v_booking.ticketing_deadline_at is null
     or v_booking.ticketing_deadline_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'HELD_BOOKING_NOT_VERIFIED');
  end if;
  update public.flight_bookings set
    status = 'on-hold', operation_kind = null, operation_reason = null,
    operation_request_id = null, operation_actor_user_id = null,
    operation_started_at = null, operation_prior_status = null
  where id = p_booking_id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key
  ) values (
    p_booking_id, 'in-progress', 'on-hold', 'in-progress', 'on-hold',
    'cancellation', 'cancellation', p_actor_user_id, 'Cancel',
    coalesce(p_evidence,'{}'::jsonb), p_idempotency_key || ':cancel-refused'
  ) on conflict do nothing;
  return jsonb_build_object('ok', true, 'status', 'on-hold');
end;
$$;

-- Preserve operation identity when a supplier-write outcome is ambiguous.
create or replace function public.wallet_mark_reconciliation(
  p_booking_id uuid,
  p_booking_attempt_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_booking_id uuid;
  v_operation_reason text;
  v_stored_status text;
  v_current_operation text;
  v_attempt_id uuid;
begin
  if (p_booking_id is null) = (p_booking_attempt_id is null) then
    raise exception 'exactly one reservation subject is required' using errcode = '22023';
  end if;
  if p_booking_id is not null then
    select attempt_id into v_attempt_id from public.flight_bookings
     where id = p_booking_id;
  end if;
  update public.wallet_reservations
     set state = 'reconciliation', reconciliation_at = now(),
         reconciliation_reason = left(coalesce(p_reason, 'Supplier outcome unknown'), 1000)
   where ((p_booking_id is not null and (
          booking_id = p_booking_id
          or (booking_id is null and booking_attempt_id = v_attempt_id)
        ))
       or (p_booking_attempt_id is not null and booking_attempt_id = p_booking_attempt_id))
     and state = 'active'
  returning id into v_id;

  if p_booking_id is not null then
    select status, operation_kind into v_stored_status, v_current_operation
      from public.flight_bookings where id = p_booking_id for update;
    v_operation_reason := case
      when v_stored_status = 'confirmed' then 'direct_ticket_payment_reconciliation'
      when v_stored_status = 'cancelled' then 'terminal_state_conflict'
      when v_current_operation = 'cancellation' then 'cancellation_reconciliation'
      else 'ticketing_reconciliation'
    end;
    update public.flight_bookings set
      payment_state = case when payment_state = 'held' then 'reconciliation' else payment_state end,
      status = case when status in ('confirmed','cancelled') then status else 'in-progress' end,
      operation_kind = 'reconciliation',
      operation_reason = v_operation_reason,
      operation_started_at = coalesce(operation_started_at, now())
    where id = p_booking_id and not legacy_operational
    returning id into v_booking_id;
  end if;
  return jsonb_build_object(
    'ok', v_id is not null or v_booking_id is not null,
    'reservationId', v_id
  );
end;
$$;

-- Supplier refresh may enrich an already-decided matching state, but it may
-- not silently overwrite local lifecycle or money. Conflicting evidence opens
-- a protected reconciliation operation instead.
create or replace function public.record_booking_supplier_refresh(
  p_booking_id uuid,
  p_supplier_status text,
  p_airlines_pnr jsonb,
  p_ticket_numbers jsonb,
  p_issued_at timestamptz,
  p_cancelled_at timestamptz
)
returns public.flight_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_target text;
begin
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then raise exception 'booking not found' using errcode = 'P0002'; end if;

  v_target := case lower(trim(coalesce(p_supplier_status,'')))
    when 'issued' then 'confirmed'
    when 'confirmed' then 'confirmed'
    when 'cancelled' then 'cancelled'
    else null
  end;

  update public.flight_bookings set
    synced_at = now(), booking_status = p_supplier_status,
    airlines_pnr = case when public.jsonb_is_nonempty_array(p_airlines_pnr)
      then p_airlines_pnr else airlines_pnr end,
    ticket_numbers = case when public.jsonb_is_nonempty_array(p_ticket_numbers)
      then p_ticket_numbers else ticket_numbers end,
    issued_at = case when status = 'confirmed' and v_target = 'confirmed'
      then coalesce(p_issued_at, issued_at) else issued_at end,
    cancelled_at = case when status = 'cancelled' and v_target = 'cancelled'
      then coalesce(p_cancelled_at, cancelled_at) else cancelled_at end
  where id = p_booking_id;

  if v_target is not null and v_target <> v_booking.status then
    update public.flight_bookings set
      status = case when status in ('confirmed','cancelled') then status else 'in-progress' end,
      operation_kind = 'reconciliation',
      operation_reason = 'terminal_state_conflict',
      operation_started_at = coalesce(operation_started_at, now()),
      operation_prior_status = coalesce(operation_prior_status, v_booking.status)
    where id = p_booking_id;
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, supplier_operation, supplier_evidence
    ) values (
      p_booking_id,
      public.resolve_booking_lifecycle(v_booking.status, v_booking.airlines_pnr,
        v_booking.ticketing_deadline_at, v_booking.operation_kind),
      case when v_booking.status in ('confirmed','cancelled') then v_booking.status else 'in-progress' end,
      v_booking.status,
      case when v_booking.status in ('confirmed','cancelled') then v_booking.status else 'in-progress' end,
      'reconciliation', 'terminal_state_conflict', 'AirTicketingDetails',
      jsonb_build_object('supplierStatus', p_supplier_status,
        'proposedStatus', v_target, 'ticketNumbers', p_ticket_numbers)
    );
  end if;

  select * into v_booking from public.flight_bookings where id = p_booking_id;
  return v_booking;
end;
$$;

create or replace function public.record_booking_pnr_refresh(
  p_booking_id uuid,
  p_supplier_status text,
  p_airlines_pnr jsonb,
  p_ticketing_time_limit text,
  p_ticketing_deadline_at timestamptz
)
returns public.flight_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.flight_bookings;
  v_after public.flight_bookings;
  v_before_lifecycle text;
  v_after_lifecycle text;
begin
  select * into v_before from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then raise exception 'booking not found' using errcode = 'P0002'; end if;
  v_before_lifecycle := public.resolve_booking_lifecycle(
    v_before.status, v_before.airlines_pnr,
    v_before.ticketing_deadline_at, v_before.operation_kind
  );

  update public.flight_bookings set
    synced_at = now(), booking_status = p_supplier_status,
    airlines_pnr = case when public.jsonb_is_nonempty_array(p_airlines_pnr)
      then p_airlines_pnr else airlines_pnr end,
    ticketing_time_limit = case when p_ticketing_deadline_at is not null
      then p_ticketing_time_limit else ticketing_time_limit end,
    ticketing_deadline_at = coalesce(p_ticketing_deadline_at, ticketing_deadline_at),
    deadline_source = case when p_ticketing_deadline_at is not null
      then 'pnr_call' else deadline_source end
  where id = p_booking_id
  returning * into v_after;

  v_after_lifecycle := public.resolve_booking_lifecycle(
    v_after.status, v_after.airlines_pnr,
    v_after.ticketing_deadline_at, v_after.operation_kind
  );
  if v_after_lifecycle <> v_before_lifecycle then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, supplier_operation, supplier_evidence
    ) values (
      p_booking_id, v_before_lifecycle, v_after_lifecycle,
      v_before.status, v_after.status, v_after.operation_kind,
      v_after.operation_reason, 'Pnr',
      jsonb_build_object('supplierStatus', p_supplier_status,
        'airlinesPnr', p_airlines_pnr,
        'ticketingDeadlineAt', p_ticketing_deadline_at)
    );
  end if;
  return v_after;
end;
$$;

-- Intended for a bounded scheduler/worker. It observes clock-derived lifecycle
-- changes once without turning ordinary reads into writes.
create or replace function public.record_booking_lifecycle_observations(
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  with candidates as (
    select fb.id, fb.status,
      public.resolve_booking_lifecycle(
        fb.status, fb.airlines_pnr, fb.ticketing_deadline_at, fb.operation_kind
      ) as lifecycle_status
    from public.flight_bookings fb
    where not fb.legacy_operational and fb.status = 'on-hold'
    order by fb.updated_at
    limit greatest(1, least(coalesce(p_limit,500),2000))
  ), changed as (
    select c.*,
      (select e.to_lifecycle_status from public.booking_status_events e
        where e.booking_id = c.id order by e.created_at desc, e.id desc limit 1) as last_status
    from candidates c
    where c.lifecycle_status in ('expired','unconfirmed')
  ), inserted as (
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, supplier_operation
    )
    select id, coalesce(last_status,'on-hold'), lifecycle_status,
      status, status, 'LifecycleSweep'
    from changed where last_status is distinct from lifecycle_status
    returning 1
  ) select count(*) into v_count from inserted;
  return v_count;
end;
$$;

-- Replace successful capture with evidence and operation checks. Direct-ticket
-- Book is the only path allowed to arrive already Confirmed without an active
-- booking operation.
create or replace function public.wallet_capture_reservation(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text,
  p_supplier_outcome jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_reservation public.wallet_reservations;
  v_account public.wallet_accounts;
  v_available_before bigint;
  v_hold_before bigint;
begin
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;

  select * into v_reservation from public.wallet_reservations
   where booking_id = p_booking_id
      or (booking_id is null and booking_attempt_id = v_booking.attempt_id)
   order by booking_id nulls last limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'RESERVATION_NOT_FOUND'); end if;
  if v_reservation.state = 'captured' then
    return jsonb_build_object('ok', true, 'replay', true, 'reservationId', v_reservation.id);
  end if;
  if v_reservation.state = 'released' then
    return jsonb_build_object('ok', false, 'code', 'RESERVATION_RELEASED');
  end if;

  if nullif(trim(p_supplier_outcome->>'ticketCodeRef'), '') is null
     or not public.jsonb_is_nonempty_array(p_supplier_outcome->'ticketNumbers') then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_INCOMPLETE');
  end if;

  if not (
    (v_booking.status = 'in-progress'
      and v_booking.operation_kind in ('ticketing','reconciliation'))
    or
    (v_booking.status = 'confirmed' and v_booking.direct_ticketing
      and v_booking.issued_at is not null)
  ) then
    return jsonb_build_object('ok', false, 'code', 'ISSUE_OPERATION_NOT_ACTIVE');
  end if;

  select * into strict v_account from public.wallet_accounts
   where id = v_reservation.wallet_account_id for update;
  if v_account.hold_balance < v_reservation.amount then
    return jsonb_build_object('ok', false, 'code', 'HOLD_BALANCE_MISMATCH');
  end if;
  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;

  update public.wallet_accounts set hold_balance = hold_balance - v_reservation.amount
   where id = v_account.id;
  update public.wallet_reservations set
    booking_id = p_booking_id, booking_attempt_id = null, state = 'captured',
    issued_by_user_id = p_actor_user_id, captured_at = now(),
    reconciliation_at = null, reconciliation_reason = null
  where id = v_reservation.id;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks
  ) values (
    v_account.id, 'booking_confirm', v_reservation.amount, v_reservation.currency,
    v_available_before, v_available_before, v_hold_before,
    v_hold_before - v_reservation.amount, v_booking.id, v_booking.public_ref,
    v_reservation.id, p_idempotency_key || ':capture', p_actor_user_id,
    p_actor_role, 'Supplier confirmed ticket issuance'
  );
  update public.flight_bookings set
    charged_wallet_account_id = v_account.id, payment_state = 'captured',
    payment_amount = v_reservation.amount, captured_amount = v_reservation.amount,
    status = 'confirmed', issued_by_user_id = p_actor_user_id,
    issued_at = coalesce(issued_at, now()),
    pnr = coalesce(nullif(trim(p_supplier_outcome->>'pnr'), ''), pnr),
    booking_status = coalesce(nullif(trim(p_supplier_outcome->>'bookingStatus'), ''), 'Confirmed'),
    ticket_code_ref = nullif(trim(p_supplier_outcome->>'ticketCodeRef'), ''),
    ticket_numbers = p_supplier_outcome->'ticketNumbers',
    warnings = case when jsonb_typeof(p_supplier_outcome->'warnings') = 'array'
      then p_supplier_outcome->'warnings' else warnings end,
    supplier_message = coalesce(nullif(trim(p_supplier_outcome->>'message'), ''), supplier_message),
    operation_kind = null, operation_reason = null, operation_request_id = null,
    operation_actor_user_id = null, operation_started_at = null,
    operation_prior_status = null
  where id = v_booking.id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key
  ) values (
    v_booking.id,
    case when v_booking.status = 'confirmed' then 'confirmed' else 'in-progress' end,
    'confirmed', v_booking.status, 'confirmed', v_booking.operation_kind,
    v_booking.operation_reason, p_actor_user_id,
    case when v_booking.direct_ticketing then 'Book' else 'NewTicket' end,
    jsonb_build_object('ticketCodeRef', p_supplier_outcome->>'ticketCodeRef',
      'ticketNumbers', p_supplier_outcome->'ticketNumbers'),
    p_idempotency_key || ':confirmed'
  ) on conflict do nothing;
  return jsonb_build_object(
    'ok', true, 'reservationId', v_reservation.id,
    'availableBalance', v_available_before,
    'holdBalance', v_hold_before - v_reservation.amount
  );
end;
$$;

-- Complete an existing captured legacy Pending ticket after the guarded retry.
create or replace function public.wallet_finalize_manual_issue(
  p_booking_id uuid, p_actor_user_id text, p_supplier_outcome jsonb
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_booking public.flight_bookings;
begin
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;
  if v_booking.status = 'confirmed' and v_booking.issued_at is not null then
    return jsonb_build_object('ok', true, 'replay', true);
  end if;
  if v_booking.status <> 'in-progress' or v_booking.payment_state <> 'captured'
     or v_booking.operation_kind <> 'ticketing'
     or v_booking.operation_reason <> 'legacy_reconciliation' then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_MANUALLY_ISSUABLE');
  end if;
  if nullif(trim(p_supplier_outcome->>'ticketCodeRef'), '') is null
     or not public.jsonb_is_nonempty_array(p_supplier_outcome->'ticketNumbers') then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_INCOMPLETE');
  end if;
  update public.flight_bookings set
    status = 'confirmed', issued_by_user_id = p_actor_user_id,
    issued_at = now(), pnr = coalesce(nullif(trim(p_supplier_outcome->>'pnr'), ''), pnr),
    booking_status = coalesce(nullif(trim(p_supplier_outcome->>'bookingStatus'), ''), 'Confirmed'),
    ticket_code_ref = nullif(trim(p_supplier_outcome->>'ticketCodeRef'), ''),
    ticket_numbers = p_supplier_outcome->'ticketNumbers',
    warnings = case when jsonb_typeof(p_supplier_outcome->'warnings') = 'array'
      then p_supplier_outcome->'warnings' else warnings end,
    supplier_message = nullif(trim(p_supplier_outcome->>'message'), ''),
    operation_kind = null, operation_reason = null, operation_request_id = null,
    operation_actor_user_id = null, operation_started_at = null,
    operation_prior_status = null
  where id = p_booking_id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation, supplier_evidence
  ) values (
    p_booking_id, 'in-progress', 'confirmed', 'in-progress', 'confirmed',
    'ticketing', 'legacy_reconciliation', p_actor_user_id, 'NewTicket',
    jsonb_build_object('ticketCodeRef', p_supplier_outcome->>'ticketCodeRef',
      'ticketNumbers', p_supplier_outcome->'ticketNumbers')
  );
  return jsonb_build_object('ok', true);
end $$;

-- Final cancellation now requires the active cancellation operation and clears
-- it as part of the same transaction that releases an uncaptured reservation.
create or replace function public.wallet_finalize_booking_cancel(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text,
  p_reason text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_booking public.flight_bookings;
  v_release jsonb;
begin
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;
  if v_booking.status = 'cancelled' then return jsonb_build_object('ok', true, 'replay', true); end if;
  if v_booking.status <> 'in-progress'
     or v_booking.operation_reason not in ('cancellation','cancellation_reconciliation')
     or v_booking.issued_at is not null or v_booking.direct_ticketing then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_CANCELLABLE');
  end if;

  v_release := public.wallet_release_reservation(
    p_booking_id, null, p_actor_user_id, p_actor_role, p_idempotency_key,
    coalesce(p_reason, 'Booking cancelled with supplier')
  );
  if coalesce((v_release->>'ok')::boolean, false) is not true
     and coalesce(v_release->>'code','') <> 'ALREADY_CAPTURED' then
    update public.flight_bookings set
      payment_state = 'reconciliation', operation_kind = 'reconciliation',
      operation_reason = 'cancellation_reconciliation'
    where id = p_booking_id;
    return v_release || jsonb_build_object('supplierCancelled', true);
  end if;
  if coalesce(v_release->>'code','') = 'ALREADY_CAPTURED' then
    update public.flight_bookings set operation_kind = 'reconciliation',
      operation_reason = 'terminal_state_conflict', payment_state = 'reconciliation'
    where id = p_booking_id;
    return jsonb_build_object('ok', false, 'code', 'CAPTURED_BOOKING_CANCEL_CONFLICT',
      'supplierCancelled', true);
  end if;

  update public.flight_bookings set
    status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor_user_id,
    cancel_reason = left(coalesce(p_reason, 'Booking cancelled with supplier'), 1000),
    operation_kind = null, operation_reason = null, operation_request_id = null,
    operation_actor_user_id = null, operation_started_at = null,
    operation_prior_status = null
  where id = p_booking_id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key
  ) values (
    p_booking_id, 'in-progress', 'cancelled', 'in-progress', 'cancelled',
    v_booking.operation_kind, v_booking.operation_reason, p_actor_user_id,
    'Cancel', jsonb_build_object('reason', left(coalesce(p_reason,''),1000)),
    p_idempotency_key || ':cancelled'
  ) on conflict do nothing;
  return v_release || jsonb_build_object('ok', true, 'status', 'cancelled');
end $$;

revoke all on function public.wallet_begin_legacy_manual_issue(uuid,text,text),
  public.wallet_fail_booking_issue(uuid,text,text,text,text),
  public.begin_booking_cancellation(uuid,text,text),
  public.resolve_booking_cancellation_refusal(uuid,text,text,jsonb),
  public.record_booking_supplier_refresh(uuid,text,jsonb,jsonb,timestamptz,timestamptz),
  public.record_booking_pnr_refresh(uuid,text,jsonb,text,timestamptz),
  public.record_booking_lifecycle_observations(integer)
  from public, anon, authenticated;
grant execute on function public.wallet_begin_legacy_manual_issue(uuid,text,text),
  public.wallet_fail_booking_issue(uuid,text,text,text,text),
  public.begin_booking_cancellation(uuid,text,text),
  public.resolve_booking_cancellation_refusal(uuid,text,text,jsonb),
  public.record_booking_supplier_refresh(uuid,text,jsonb,jsonb,timestamptz,timestamptz),
  public.record_booking_pnr_refresh(uuid,text,jsonb,text,timestamptz),
  public.record_booking_lifecycle_observations(integer)
  to service_role;

-- Migration 0026 exposed the obsolete supplier-shortage -> paid Pending path.
-- Keep the function body for rollback archaeology but remove its callable
-- authority so no application path can create new rows with that meaning.
revoke execute on function public.wallet_queue_manual_issue(uuid,text,text,text,text)
  from service_role;

comment on view public.booking_lifecycle_v is
  'Authoritative seven-status booking lifecycle projection for all read consumers.';
comment on table public.booking_status_events is
  'Immutable, idempotent history of observed and decided booking lifecycle transitions.';
