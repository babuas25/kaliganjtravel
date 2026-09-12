-- Local time-limit approval for Triplover On Hold bookings.
--
-- supplier_ticketing_* is the current supplier evidence. The established
-- ticketing_deadline_at remains the operational/effective deadline so the
-- lifecycle resolver, issue/cancel claims, expiry worker, notifications and
-- reconciliation continue to use one authority. A local approval changes the
-- effective deadline only; supplier evidence is retained independently and in
-- append-only observations.

alter table public.flight_bookings
  add column if not exists supplier_ticketing_time_limit text,
  add column if not exists supplier_ticketing_deadline_at timestamptz,
  add column if not exists supplier_deadline_source text,
  add column if not exists local_ticketing_deadline_at timestamptz,
  add column if not exists active_local_time_limit_request_id uuid;

update public.flight_bookings
   set supplier_ticketing_time_limit = coalesce(
         supplier_ticketing_time_limit, ticketing_time_limit
       ),
       supplier_ticketing_deadline_at = coalesce(
         supplier_ticketing_deadline_at, ticketing_deadline_at
       ),
       supplier_deadline_source = coalesce(
         supplier_deadline_source, deadline_source, 'migration_baseline'
       )
 where lower(coalesce(supplier, '')) = 'triplover'
   and (
     supplier_ticketing_time_limit is null
     or supplier_ticketing_deadline_at is null
     or supplier_deadline_source is null
   );

alter table public.flight_bookings
  drop constraint if exists flight_bookings_deadline_source_check;
alter table public.flight_bookings
  add constraint flight_bookings_deadline_source_check
  check (
    deadline_source is null
    or deadline_source in ('supplier', 'pnr_call', 'assumed', 'local_approved')
  );

create table public.booking_deadline_observations (
  id                         uuid primary key default gen_random_uuid(),
  booking_id                 uuid not null
                             references public.flight_bookings(id)
                             on delete restrict,
  observation_source        text not null,
  supplier_status           text,
  supplier_time_limit_raw   text,
  supplier_deadline_at      timestamptz,
  supplier_deadline_source  text,
  actor_user_id              text not null,
  actor_role                 text not null,
  normalized_evidence        jsonb not null default '{}'::jsonb,
  evidence_hash              text not null,
  observed_at                timestamptz not null default clock_timestamp(),
  constraint booking_deadline_observations_source_check check (
    observation_source in ('migration_baseline', 'booking_create', 'pnr_sync')
  ),
  constraint booking_deadline_observations_actor_role_check check (
    actor_role in (
      'superadmin', 'admin', 'staff_support', 'staff_account',
      'customer', 'b2b', 'b2b_sub', 'system'
    )
  ),
  constraint booking_deadline_observations_hash_check check (
    evidence_hash ~ '^[a-f0-9]{64}$'
  ),
  unique (booking_id, evidence_hash)
);

create index booking_deadline_observations_booking_idx
  on public.booking_deadline_observations (booking_id, observed_at desc, id);

create table public.booking_local_time_limit_requests (
  id                         uuid primary key default gen_random_uuid(),
  booking_id                 uuid not null
                             references public.flight_bookings(id)
                             on delete restrict,
  state                      text not null default 'pending',
  eligibility_reason         text not null,
  supplier_time_limit_snapshot text,
  supplier_deadline_snapshot timestamptz,
  requested_by_user_id       text not null,
  requested_by_role          text not null,
  request_key                text not null,
  requested_at               timestamptz not null default clock_timestamp(),
  granted_minutes            integer,
  approved_deadline_at       timestamptz,
  verification_note          text,
  decided_by_user_id         text,
  decided_by_role            text,
  decided_at                 timestamptz,
  rejection_reason           text,
  superseded_at              timestamptz,
  superseded_reason          text,
  superseded_by_request_id   uuid
                             references public.booking_local_time_limit_requests(id)
                             on delete restrict,
  version                    integer not null default 1,
  created_at                 timestamptz not null default clock_timestamp(),
  updated_at                 timestamptz not null default clock_timestamp(),
  constraint booking_local_ttl_state_check check (
    state in ('pending', 'approved', 'rejected', 'superseded')
  ),
  constraint booking_local_ttl_reason_check check (
    eligibility_reason in (
      'supplier_deadline_missing',
      'supplier_deadline_under_15_minutes'
    )
  ),
  constraint booking_local_ttl_requester_role_check check (
    requested_by_role in ('b2b', 'b2b_sub', 'customer')
  ),
  constraint booking_local_ttl_decider_role_check check (
    decided_by_role is null
    or decided_by_role in ('superadmin', 'admin', 'staff_support')
  ),
  constraint booking_local_ttl_grant_check check (
    granted_minutes is null or granted_minutes between 1 and 30
  ),
  constraint booking_local_ttl_request_key_check check (
    char_length(request_key) between 1 and 255
  ),
  constraint booking_local_ttl_version_check check (version > 0),
  constraint booking_local_ttl_pending_shape_check check (
    state <> 'pending'
    or (
      granted_minutes is null and approved_deadline_at is null
      and verification_note is null and decided_by_user_id is null
      and decided_by_role is null and decided_at is null
      and rejection_reason is null and superseded_at is null
    )
  ),
  constraint booking_local_ttl_approved_shape_check check (
    state <> 'approved'
    or (
      granted_minutes is not null and approved_deadline_at is not null
      and verification_note is not null and decided_by_user_id is not null
      and decided_by_role is not null and decided_at is not null
      and rejection_reason is null
    )
  ),
  constraint booking_local_ttl_rejected_shape_check check (
    state <> 'rejected'
    or (
      rejection_reason is not null and decided_by_user_id is not null
      and decided_by_role is not null and decided_at is not null
      and granted_minutes is null and approved_deadline_at is null
    )
  ),
  unique (requested_by_user_id, request_key)
);

create unique index booking_local_ttl_one_pending_idx
  on public.booking_local_time_limit_requests (booking_id)
  where state = 'pending';
create index booking_local_ttl_queue_idx
  on public.booking_local_time_limit_requests (requested_at, id)
  where state = 'pending';
create index booking_local_ttl_booking_history_idx
  on public.booking_local_time_limit_requests (booking_id, requested_at desc, id);

alter table public.flight_bookings
  add constraint flight_bookings_active_local_ttl_request_fk
  foreign key (active_local_time_limit_request_id)
  references public.booking_local_time_limit_requests(id)
  on delete restrict
  not valid;

create table public.booking_local_time_limit_events (
  id                    bigint generated always as identity primary key,
  booking_id            uuid not null
                        references public.flight_bookings(id) on delete restrict,
  request_id            uuid not null
                        references public.booking_local_time_limit_requests(id)
                        on delete restrict,
  event_type            text not null,
  actor_user_id         text not null,
  actor_role            text not null,
  prior_deadline_at     timestamptz,
  resulting_deadline_at timestamptz,
  granted_minutes       integer,
  reason                text,
  operation_request_key text,
  evidence              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default clock_timestamp(),
  constraint booking_local_ttl_events_type_check check (
    event_type in (
      'requested', 'approved', 'rejected', 'superseded',
      'used_for_ticketing', 'used_for_cancellation', 'supplier_conflict'
    )
  ),
  constraint booking_local_ttl_events_actor_role_check check (
    actor_role in (
      'superadmin', 'admin', 'staff_support', 'staff_account',
      'customer', 'b2b', 'b2b_sub', 'system'
    )
  ),
  constraint booking_local_ttl_events_grant_check check (
    granted_minutes is null or granted_minutes between 1 and 30
  )
);

create index booking_local_ttl_events_booking_idx
  on public.booking_local_time_limit_events (booking_id, created_at desc, id);
create unique index booking_local_ttl_events_operation_once_idx
  on public.booking_local_time_limit_events (
    request_id, event_type, operation_request_key
  ) where operation_request_key is not null;

create or replace function public.prevent_booking_deadline_audit_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'booking deadline audit records are immutable'
    using errcode = '55000';
end;
$$;

create trigger booking_deadline_observations_immutable
  before update or delete on public.booking_deadline_observations
  for each row execute function public.prevent_booking_deadline_audit_mutation();
create trigger booking_local_ttl_events_immutable
  before update or delete on public.booking_local_time_limit_events
  for each row execute function public.prevent_booking_deadline_audit_mutation();

create trigger booking_local_ttl_requests_touch_updated_at
  before update on public.booking_local_time_limit_requests
  for each row execute function public.touch_updated_at();

-- Capture legacy writers as supplier evidence and prevent them from replacing
-- an active local effective deadline during a rolling application deployment.
create or replace function public.enforce_booking_deadline_authority_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_local_authority_write boolean;
  v_explicit_supplier_write boolean;
  v_legacy_deadline_write boolean;
begin
  if tg_op = 'INSERT' then
    new.supplier_ticketing_time_limit := coalesce(
      new.supplier_ticketing_time_limit, new.ticketing_time_limit
    );
    new.supplier_ticketing_deadline_at := coalesce(
      new.supplier_ticketing_deadline_at, new.ticketing_deadline_at
    );
    new.supplier_deadline_source := coalesce(
      new.supplier_deadline_source, new.deadline_source, 'booking_create'
    );
    if new.active_local_time_limit_request_id is not null then
      new.ticketing_deadline_at := new.local_ticketing_deadline_at;
      new.deadline_source := 'local_approved';
    end if;
    return new;
  end if;

  v_local_authority_write :=
    new.active_local_time_limit_request_id is distinct from
      old.active_local_time_limit_request_id
    or new.local_ticketing_deadline_at is distinct from
      old.local_ticketing_deadline_at;
  v_explicit_supplier_write :=
    new.supplier_ticketing_time_limit is distinct from
      old.supplier_ticketing_time_limit
    or new.supplier_ticketing_deadline_at is distinct from
      old.supplier_ticketing_deadline_at
    or new.supplier_deadline_source is distinct from
      old.supplier_deadline_source;
  v_legacy_deadline_write :=
    new.ticketing_time_limit is distinct from old.ticketing_time_limit
    or new.ticketing_deadline_at is distinct from old.ticketing_deadline_at
    or new.deadline_source is distinct from old.deadline_source;

  if not v_local_authority_write
     and not v_explicit_supplier_write
     and v_legacy_deadline_write then
    new.supplier_ticketing_time_limit := new.ticketing_time_limit;
    new.supplier_ticketing_deadline_at := new.ticketing_deadline_at;
    new.supplier_deadline_source := coalesce(
      new.deadline_source, 'legacy_supplier_writer'
    );
  end if;

  if new.active_local_time_limit_request_id is not null then
    new.ticketing_deadline_at := new.local_ticketing_deadline_at;
    new.deadline_source := 'local_approved';
    new.ticketing_time_limit := new.supplier_ticketing_time_limit;
  elsif v_local_authority_write or v_explicit_supplier_write
        or v_legacy_deadline_write then
    new.ticketing_time_limit := new.supplier_ticketing_time_limit;
    new.ticketing_deadline_at := new.supplier_ticketing_deadline_at;
    new.deadline_source := case
      when new.supplier_ticketing_deadline_at is null
        then coalesce(new.supplier_deadline_source, 'pnr_call')
      when new.supplier_deadline_source in ('supplier', 'pnr_call', 'assumed')
        then new.supplier_deadline_source
      else 'pnr_call'
    end;
  end if;
  return new;
end;
$$;

create trigger flight_bookings_deadline_authority_v1
  before insert or update of
    ticketing_time_limit, ticketing_deadline_at, deadline_source,
    supplier_ticketing_time_limit, supplier_ticketing_deadline_at,
    supplier_deadline_source, local_ticketing_deadline_at,
    active_local_time_limit_request_id
  on public.flight_bookings
  for each row execute function public.enforce_booking_deadline_authority_v1();

insert into public.booking_deadline_observations (
  booking_id, observation_source, supplier_status,
  supplier_time_limit_raw, supplier_deadline_at, supplier_deadline_source,
  actor_user_id, actor_role, normalized_evidence, evidence_hash, observed_at
)
select
  booking.id, 'migration_baseline', booking.booking_status,
  booking.supplier_ticketing_time_limit,
  booking.supplier_ticketing_deadline_at,
  booking.supplier_deadline_source,
  'system:migration-0083', 'system',
  jsonb_build_object('migration', '0083', 'preservedOriginalEvidence', true),
  encode(sha256(convert_to(concat_ws('|',
    booking.id::text, 'migration_baseline',
    coalesce(booking.supplier_ticketing_time_limit, ''),
    coalesce(booking.supplier_ticketing_deadline_at::text, ''),
    coalesce(booking.supplier_deadline_source, '')
  ), 'UTF8')), 'hex'),
  clock_timestamp()
from public.flight_bookings booking
on conflict do nothing;

create or replace function public.record_initial_booking_deadline_observation_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_hash text;
begin
  v_hash := encode(sha256(convert_to(concat_ws('|',
    new.id::text, 'booking_create',
    coalesce(new.supplier_ticketing_time_limit, ''),
    coalesce(new.supplier_ticketing_deadline_at::text, ''),
    coalesce(new.supplier_deadline_source, '')
  ), 'UTF8')), 'hex');
  insert into public.booking_deadline_observations (
    booking_id, observation_source, supplier_status,
    supplier_time_limit_raw, supplier_deadline_at, supplier_deadline_source,
    actor_user_id, actor_role, normalized_evidence, evidence_hash
  ) values (
    new.id, 'booking_create', new.booking_status,
    new.supplier_ticketing_time_limit, new.supplier_ticketing_deadline_at,
    new.supplier_deadline_source, 'system:booking-create', 'system',
    '{}'::jsonb, v_hash
  ) on conflict do nothing;
  return new;
end;
$$;

create trigger flight_bookings_initial_deadline_observation_v1
  after insert on public.flight_bookings
  for each row execute function public.record_initial_booking_deadline_observation_v1();

-- Users submit no duration. Eligibility and ownership are decided under the
-- booking row lock using database time and the stored user/agency registry.
create or replace function public.request_booking_local_time_limit_v1(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_actor_role text;
  v_actor_agency text;
  v_existing public.booking_local_time_limit_requests;
  v_request public.booking_local_time_limit_requests;
  v_reason text;
begin
  if nullif(btrim(p_actor_user_id), '') is null
     or p_actor_role not in ('b2b', 'b2b_sub', 'customer')
     or nullif(btrim(p_request_key), '') is null
     or char_length(p_request_key) > 255 then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_FORBIDDEN');
  end if;

  select role, agency_code into v_actor_role, v_actor_agency
    from public.app_users where clerk_id = p_actor_user_id;
  if not found or v_actor_role is distinct from p_actor_role then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_FORBIDDEN');
  end if;

  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;

  if not (
    (p_actor_role = 'customer'
      and v_booking.booking_owner_type = 'user'
      and v_booking.booking_owner_key = p_actor_user_id)
    or
    (p_actor_role in ('b2b', 'b2b_sub')
      and v_actor_agency is not null
      and v_booking.booking_owner_type = 'agency'
      and v_booking.booking_owner_key = v_actor_agency)
  ) then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_FORBIDDEN');
  end if;

  select * into v_existing
    from public.booking_local_time_limit_requests
   where requested_by_user_id = p_actor_user_id
     and request_key = p_request_key;
  if found then
    if v_existing.booking_id is distinct from p_booking_id then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_KEY_CONFLICT');
    end if;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', v_existing.id,
      'state', v_existing.state, 'requestedAt', v_existing.requested_at,
      'version', v_existing.version
    );
  end if;

  if lower(coalesce(v_booking.supplier, '')) <> 'triplover'
     or v_booking.status <> 'on-hold'
     or v_booking.operation_kind is not null
     or v_booking.direct_ticketing
     or v_booking.issued_at is not null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_ELIGIBLE');
  end if;
  if not public.jsonb_is_nonempty_array(v_booking.airlines_pnr) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_UNCONFIRMED');
  end if;
  if exists (
    select 1 from public.booking_reconciliation_cases c
     where c.subject_booking_id = p_booking_id
       and c.state in (
         'open', 'assigned', 'awaiting_supplier',
         'awaiting_finance', 'awaiting_approval'
       )
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'BOOKING_RECONCILIATION_REQUIRED'
    );
  end if;
  if v_booking.active_local_time_limit_request_id is not null then
    return jsonb_build_object(
      'ok', false,
      'code', case
        when v_booking.local_ticketing_deadline_at <= clock_timestamp()
          then 'BOOKING_EXPIRED'
        else 'LOCAL_TIME_LIMIT_ACTIVE'
      end
    );
  end if;
  if v_booking.supplier_ticketing_deadline_at >=
       clock_timestamp() + interval '15 minutes' then
    return jsonb_build_object(
      'ok', false, 'code', 'SUPPLIER_DEADLINE_SUFFICIENT'
    );
  end if;

  select * into v_existing
    from public.booking_local_time_limit_requests
   where booking_id = p_booking_id and state = 'pending'
   for update;
  if found then
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', v_existing.id,
      'state', v_existing.state, 'requestedAt', v_existing.requested_at,
      'version', v_existing.version
    );
  end if;

  v_reason := case
    when v_booking.supplier_ticketing_deadline_at is null
      then 'supplier_deadline_missing'
    else 'supplier_deadline_under_15_minutes'
  end;
  insert into public.booking_local_time_limit_requests (
    booking_id, eligibility_reason, supplier_time_limit_snapshot,
    supplier_deadline_snapshot, requested_by_user_id,
    requested_by_role, request_key
  ) values (
    p_booking_id, v_reason, v_booking.supplier_ticketing_time_limit,
    v_booking.supplier_ticketing_deadline_at, p_actor_user_id,
    p_actor_role, p_request_key
  ) returning * into v_request;

  insert into public.booking_local_time_limit_events (
    booking_id, request_id, event_type, actor_user_id, actor_role,
    prior_deadline_at, reason, evidence
  ) values (
    p_booking_id, v_request.id, 'requested', p_actor_user_id, p_actor_role,
    v_booking.ticketing_deadline_at, v_reason,
    jsonb_build_object(
      'supplierTimeLimit', v_booking.supplier_ticketing_time_limit,
      'supplierDeadlineAt', v_booking.supplier_ticketing_deadline_at,
      'thresholdMinutes', 15,
      'walletMutation', false
    )
  );
  return jsonb_build_object(
    'ok', true, 'replay', false, 'requestId', v_request.id,
    'state', v_request.state, 'requestedAt', v_request.requested_at,
    'version', v_request.version
  );
end;
$$;

-- Staff chooses the duration only after supplier-portal verification. The
-- optimistic version prevents two staff decisions from racing.
create or replace function public.decide_booking_local_time_limit_v1(
  p_booking_id uuid,
  p_request_id uuid,
  p_expected_version integer,
  p_actor_user_id text,
  p_action text,
  p_granted_minutes numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_request public.booking_local_time_limit_requests;
  v_actor_role text;
  v_granted_minutes integer;
  v_approved_at timestamptz;
  v_deadline timestamptz;
  v_before_lifecycle text;
  v_after_lifecycle text;
begin
  select role into v_actor_role
    from public.app_users where clerk_id = p_actor_user_id;
  if not found or v_actor_role not in ('superadmin', 'admin', 'staff_support') then
    return jsonb_build_object('ok', false, 'code', 'DECISION_FORBIDDEN');
  end if;
  if p_action not in ('approve', 'reject')
     or p_expected_version is null or p_expected_version < 1
     or nullif(btrim(p_reason), '') is null
     or char_length(btrim(p_reason)) < 3
     or char_length(btrim(p_reason)) > 1000 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DECISION');
  end if;

  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  select * into v_request from public.booking_local_time_limit_requests
   where id = p_request_id and booking_id = p_booking_id
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
  end if;
  if v_request.state <> 'pending'
     or v_request.version <> p_expected_version then
    return jsonb_build_object(
      'ok', false, 'code', 'REQUEST_VERSION_CONFLICT',
      'state', v_request.state, 'version', v_request.version
    );
  end if;

  if p_action = 'reject' then
    update public.booking_local_time_limit_requests set
      state = 'rejected', rejection_reason = btrim(p_reason),
      decided_by_user_id = p_actor_user_id,
      decided_by_role = v_actor_role, decided_at = clock_timestamp(),
      version = version + 1
    where id = p_request_id returning * into v_request;
    insert into public.booking_local_time_limit_events (
      booking_id, request_id, event_type, actor_user_id, actor_role,
      prior_deadline_at, reason, evidence
    ) values (
      p_booking_id, p_request_id, 'rejected', p_actor_user_id, v_actor_role,
      v_booking.ticketing_deadline_at, btrim(p_reason),
      jsonb_build_object('walletMutation', false)
    );
    return jsonb_build_object(
      'ok', true, 'requestId', v_request.id, 'state', v_request.state,
      'version', v_request.version
    );
  end if;

  if p_granted_minutes is null
     or p_granted_minutes <> trunc(p_granted_minutes)
     or p_granted_minutes < 1
     or p_granted_minutes > 30 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_GRANT_MINUTES');
  end if;
  v_granted_minutes := p_granted_minutes::integer;
  if lower(coalesce(v_booking.supplier, '')) <> 'triplover'
     or v_booking.status <> 'on-hold'
     or v_booking.operation_kind is not null
     or v_booking.direct_ticketing
     or v_booking.issued_at is not null
     or not public.jsonb_is_nonempty_array(v_booking.airlines_pnr) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_ELIGIBLE');
  end if;
  if exists (
    select 1 from public.booking_reconciliation_cases c
     where c.subject_booking_id = p_booking_id
       and c.state in (
         'open', 'assigned', 'awaiting_supplier',
         'awaiting_finance', 'awaiting_approval'
       )
  ) then
    return jsonb_build_object(
      'ok', false, 'code', 'BOOKING_RECONCILIATION_REQUIRED'
    );
  end if;

  if v_booking.supplier_ticketing_deadline_at >=
       clock_timestamp() + interval '15 minutes' then
    update public.booking_local_time_limit_requests set
      state = 'superseded', superseded_at = clock_timestamp(),
      superseded_reason = 'supplier_deadline_now_sufficient',
      version = version + 1
    where id = p_request_id returning * into v_request;
    insert into public.booking_local_time_limit_events (
      booking_id, request_id, event_type, actor_user_id, actor_role,
      prior_deadline_at, resulting_deadline_at, reason, evidence
    ) values (
      p_booking_id, p_request_id, 'superseded', p_actor_user_id, v_actor_role,
      v_booking.ticketing_deadline_at,
      v_booking.supplier_ticketing_deadline_at,
      'supplier_deadline_now_sufficient',
      jsonb_build_object('thresholdMinutes', 15, 'walletMutation', false)
    );
    return jsonb_build_object(
      'ok', false, 'code', 'SUPPLIER_DEADLINE_SUFFICIENT',
      'requestId', v_request.id, 'state', v_request.state,
      'version', v_request.version
    );
  end if;

  v_before_lifecycle := public.resolve_booking_lifecycle(
    v_booking.status, v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, v_booking.operation_kind
  );
  v_approved_at := clock_timestamp();
  v_deadline := v_approved_at + make_interval(mins => v_granted_minutes);
  update public.booking_local_time_limit_requests set
    state = 'approved', granted_minutes = v_granted_minutes,
    approved_deadline_at = v_deadline,
    verification_note = btrim(p_reason),
    decided_by_user_id = p_actor_user_id,
    decided_by_role = v_actor_role, decided_at = v_approved_at,
    version = version + 1
  where id = p_request_id returning * into v_request;

  if v_booking.active_local_time_limit_request_id is not null
     and v_booking.active_local_time_limit_request_id <> p_request_id then
    update public.booking_local_time_limit_requests set
      state = 'superseded', superseded_at = clock_timestamp(),
      superseded_reason = 'replaced_by_new_approval',
      superseded_by_request_id = p_request_id, version = version + 1
    where id = v_booking.active_local_time_limit_request_id
      and state = 'approved';
  end if;
  update public.flight_bookings set
    local_ticketing_deadline_at = v_deadline,
    active_local_time_limit_request_id = p_request_id,
    ticketing_deadline_at = v_deadline,
    deadline_source = 'local_approved'
  where id = p_booking_id
  returning * into v_booking;

  insert into public.booking_local_time_limit_events (
    booking_id, request_id, event_type, actor_user_id, actor_role,
    prior_deadline_at, resulting_deadline_at, granted_minutes, reason, evidence
  ) values (
    p_booking_id, p_request_id, 'approved', p_actor_user_id, v_actor_role,
    v_request.supplier_deadline_snapshot, v_deadline,
    v_granted_minutes, btrim(p_reason),
    jsonb_build_object(
      'supplierPortalVerified', true,
      'supplierDeadlinePreserved', true,
      'walletMutation', false
    )
  );

  v_after_lifecycle := public.resolve_booking_lifecycle(
    v_booking.status, v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at, v_booking.operation_kind
  );
  if v_after_lifecycle is distinct from v_before_lifecycle then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, actor_user_id, supplier_operation,
      supplier_evidence, idempotency_key
    ) values (
      p_booking_id, v_before_lifecycle, v_after_lifecycle,
      v_booking.status, v_booking.status, v_booking.operation_kind,
      v_booking.operation_reason, p_actor_user_id, 'LocalTimeLimitApproval',
      jsonb_build_object(
        'requestId', p_request_id, 'grantedMinutes', v_granted_minutes,
        'approvedDeadlineAt', v_deadline, 'walletMutation', false
      ), 'local-time-limit:' || p_request_id::text || ':approved'
    ) on conflict do nothing;
  end if;
  return jsonb_build_object(
    'ok', true, 'requestId', v_request.id, 'state', v_request.state,
    'grantedMinutes', v_granted_minutes,
    'approvedDeadlineAt', v_deadline,
    'lifecycleStatus', v_after_lifecycle, 'version', v_request.version
  );
end;
$$;

-- PNR V3 records explicit NULL deadlines, keeps local and supplier authority
-- separate, and supersedes a local grant if the supplier later supplies a
-- normal (>= 15 minute) deadline or terminal truth.
create or replace function public.record_booking_pnr_refresh_v3(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_sync_source text,
  p_supplier_status text,
  p_airlines_pnr jsonb,
  p_ticketing_time_limit text,
  p_ticketing_deadline_at timestamptz,
  p_normalized_evidence jsonb
)
returns public.flight_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.flight_bookings;
  v_after_sync public.flight_bookings;
  v_after public.flight_bookings;
  v_request_id uuid;
  v_target text;
  v_hash text;
  v_before_lifecycle text;
  v_after_sync_lifecycle text;
  v_after_lifecycle text;
  v_supersede_reason text;
begin
  select * into v_before from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then raise exception 'booking not found' using errcode = 'P0002'; end if;

  v_before_lifecycle := public.resolve_booking_lifecycle(
    v_before.status, v_before.airlines_pnr,
    v_before.ticketing_deadline_at, v_before.operation_kind
  );
  v_after_sync := public.record_booking_pnr_refresh_v2(
    p_booking_id, p_actor_user_id, p_actor_role, p_sync_source,
    p_supplier_status, p_airlines_pnr, null, null,
    coalesce(p_normalized_evidence, '{}'::jsonb)
  );
  v_after_sync_lifecycle := public.resolve_booking_lifecycle(
    v_after_sync.status, v_after_sync.airlines_pnr,
    v_after_sync.ticketing_deadline_at, v_after_sync.operation_kind
  );
  v_target := case lower(btrim(coalesce(p_supplier_status, '')))
    when 'issued' then 'confirmed'
    when 'confirmed' then 'confirmed'
    when 'cancelled' then 'cancelled'
    when 'canceled' then 'cancelled'
    else null
  end;
  v_hash := encode(sha256(convert_to(concat_ws('|',
    p_booking_id::text, 'pnr_sync', coalesce(p_sync_source, ''),
    coalesce(p_supplier_status, ''), coalesce(p_ticketing_time_limit, ''),
    coalesce(p_ticketing_deadline_at::text, ''),
    coalesce(p_normalized_evidence, '{}'::jsonb)::text
  ), 'UTF8')), 'hex');
  insert into public.booking_deadline_observations (
    booking_id, observation_source, supplier_status,
    supplier_time_limit_raw, supplier_deadline_at, supplier_deadline_source,
    actor_user_id, actor_role, normalized_evidence, evidence_hash
  ) values (
    p_booking_id, 'pnr_sync', p_supplier_status,
    p_ticketing_time_limit, p_ticketing_deadline_at, 'pnr_call',
    p_actor_user_id, p_actor_role,
    coalesce(p_normalized_evidence, '{}'::jsonb), v_hash
  ) on conflict do nothing;

  v_request_id := v_after_sync.active_local_time_limit_request_id;
  v_supersede_reason := case
    when v_target is not null then 'supplier_terminal_evidence'
    when p_ticketing_deadline_at >= clock_timestamp() + interval '15 minutes'
      then 'supplier_deadline_now_sufficient'
    else null
  end;
  if v_request_id is not null and v_supersede_reason is not null then
    update public.booking_local_time_limit_requests set
      state = 'superseded', superseded_at = clock_timestamp(),
      superseded_reason = v_supersede_reason, version = version + 1
    where id = v_request_id and state = 'approved';
    insert into public.booking_local_time_limit_events (
      booking_id, request_id, event_type, actor_user_id, actor_role,
      prior_deadline_at, resulting_deadline_at, reason, evidence
    ) values (
      p_booking_id, v_request_id,
      case when v_target is null then 'superseded' else 'supplier_conflict' end,
      p_actor_user_id, p_actor_role,
      v_after_sync.local_ticketing_deadline_at, p_ticketing_deadline_at,
      v_supersede_reason,
      jsonb_build_object(
        'supplierStatus', p_supplier_status,
        'supplierDeadlineAt', p_ticketing_deadline_at,
        'walletMutation', false
      )
    );
  end if;

  update public.flight_bookings set
    supplier_ticketing_time_limit = p_ticketing_time_limit,
    supplier_ticketing_deadline_at = p_ticketing_deadline_at,
    supplier_deadline_source = 'pnr_call',
    active_local_time_limit_request_id = case
      when v_supersede_reason is not null then null
      else active_local_time_limit_request_id
    end,
    ticketing_time_limit = p_ticketing_time_limit,
    ticketing_deadline_at = case
      when v_supersede_reason is not null then p_ticketing_deadline_at
      when active_local_time_limit_request_id is not null
        then local_ticketing_deadline_at
      else p_ticketing_deadline_at
    end,
    deadline_source = case
      when v_supersede_reason is null
           and active_local_time_limit_request_id is not null
        then 'local_approved'
      else 'pnr_call'
    end
  where id = p_booking_id returning * into v_after;

  v_after_lifecycle := public.resolve_booking_lifecycle(
    v_after.status, v_after.airlines_pnr,
    v_after.ticketing_deadline_at, v_after.operation_kind
  );
  if v_after_lifecycle is distinct from v_after_sync_lifecycle then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, actor_user_id, supplier_operation,
      supplier_evidence, idempotency_key
    ) values (
      p_booking_id, v_after_sync_lifecycle, v_after_lifecycle,
      v_after_sync.status, v_after.status, v_after.operation_kind,
      v_after.operation_reason, p_actor_user_id, 'PnrRefreshV3',
      jsonb_build_object(
        'supplierStatus', p_supplier_status,
        'supplierDeadlineAt', p_ticketing_deadline_at,
        'localGrantSuperseded', v_supersede_reason is not null,
        'walletMutation', false
      ), 'pnr-refresh-v3:' || v_hash
    ) on conflict do nothing;
  end if;
  return v_after;
end;
$$;

-- AirTicketingDetails has no TTL field. It retains deadline evidence but closes
-- an active local grant when terminal supplier evidence is observed.
create or replace function public.record_booking_supplier_refresh_v3(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_sync_source text,
  p_supplier_status text,
  p_airlines_pnr jsonb,
  p_ticket_numbers jsonb,
  p_issued_at timestamptz,
  p_cancelled_at timestamptz,
  p_normalized_evidence jsonb
)
returns public.flight_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_after_sync public.flight_bookings;
  v_after public.flight_bookings;
  v_request_id uuid;
  v_target text;
  v_before_clear_lifecycle text;
  v_after_lifecycle text;
begin
  v_after_sync := public.record_booking_supplier_refresh_v2(
    p_booking_id, p_actor_user_id, p_actor_role, p_sync_source,
    p_supplier_status, p_airlines_pnr, p_ticket_numbers,
    p_issued_at, p_cancelled_at,
    coalesce(p_normalized_evidence, '{}'::jsonb)
  );
  v_target := case lower(btrim(coalesce(p_supplier_status, '')))
    when 'issued' then 'confirmed'
    when 'confirmed' then 'confirmed'
    when 'cancelled' then 'cancelled'
    when 'canceled' then 'cancelled'
    else null
  end;
  v_request_id := v_after_sync.active_local_time_limit_request_id;
  if v_target is null or v_request_id is null then
    return v_after_sync;
  end if;
  v_before_clear_lifecycle := public.resolve_booking_lifecycle(
    v_after_sync.status, v_after_sync.airlines_pnr,
    v_after_sync.ticketing_deadline_at, v_after_sync.operation_kind
  );
  update public.booking_local_time_limit_requests set
    state = 'superseded', superseded_at = clock_timestamp(),
    superseded_reason = 'supplier_terminal_evidence', version = version + 1
  where id = v_request_id and state = 'approved';
  insert into public.booking_local_time_limit_events (
    booking_id, request_id, event_type, actor_user_id, actor_role,
    prior_deadline_at, reason, evidence
  ) values (
    p_booking_id, v_request_id, 'supplier_conflict',
    p_actor_user_id, p_actor_role,
    v_after_sync.local_ticketing_deadline_at,
    'supplier_terminal_evidence',
    jsonb_build_object(
      'supplierStatus', p_supplier_status,
      'source', 'AirTicketingDetails', 'walletMutation', false
    )
  );
  update public.flight_bookings set
    active_local_time_limit_request_id = null,
    ticketing_deadline_at = supplier_ticketing_deadline_at,
    deadline_source = case
      when supplier_ticketing_deadline_at is null then 'pnr_call'
      when supplier_deadline_source in ('supplier', 'pnr_call', 'assumed')
        then supplier_deadline_source
      else 'pnr_call'
    end
  where id = p_booking_id returning * into v_after;
  v_after_lifecycle := public.resolve_booking_lifecycle(
    v_after.status, v_after.airlines_pnr,
    v_after.ticketing_deadline_at, v_after.operation_kind
  );
  if v_after_lifecycle is distinct from v_before_clear_lifecycle then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, actor_user_id, supplier_operation,
      supplier_evidence
    ) values (
      p_booking_id, v_before_clear_lifecycle, v_after_lifecycle,
      v_after_sync.status, v_after.status, v_after.operation_kind,
      v_after.operation_reason, p_actor_user_id,
      'SupplierRefreshV3LocalGrantClosed',
      jsonb_build_object(
        'requestId', v_request_id, 'supplierStatus', p_supplier_status,
        'walletMutation', false
      )
    );
  end if;
  return v_after;
end;
$$;

-- Add the local-deadline gate to the established transactional claims. The
-- pricing_snapshot sellingPrice reserve/capture behavior is intentionally
-- unchanged.
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
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;
  if v_booking.status = 'confirmed' or v_booking.payment_state = 'captured' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CAPTURED');
  end if;
  if v_booking.status <> 'on-hold' or v_booking.operation_kind is not null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_ISSUABLE');
  end if;
  if not public.jsonb_is_nonempty_array(v_booking.airlines_pnr) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_UNCONFIRMED');
  end if;
  if v_booking.active_local_time_limit_request_id is not null then
    if v_booking.local_ticketing_deadline_at is null
       or v_booking.local_ticketing_deadline_at <= clock_timestamp() then
      return jsonb_build_object('ok', false, 'code', 'BOOKING_EXPIRED');
    end if;
  elsif v_booking.supplier_ticketing_deadline_at is null
     or v_booking.supplier_ticketing_deadline_at <
          clock_timestamp() + interval '15 minutes' then
    return jsonb_build_object('ok', false, 'code', 'LOCAL_TIME_LIMIT_REQUIRED');
  end if;
  if v_booking.ticketing_deadline_at is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_DEADLINE_REQUIRED');
  end if;
  if v_booking.ticketing_deadline_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_EXPIRED');
  end if;
  if v_booking.booking_owner_type is null or v_booking.booking_owner_key is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_OWNER_REQUIRED');
  end if;
  begin
    v_amount := round((v_booking.pricing_snapshot->>'sellingPrice')::numeric * 100)::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
  end;
  v_result := public.wallet_reserve_amount(
    v_booking.id, null, v_booking.booking_owner_type,
    v_booking.booking_owner_key, v_amount, v_booking.currency,
    p_actor_user_id, p_actor_role, p_idempotency_key, v_booking.public_ref
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then return v_result; end if;
  if v_booking.active_local_time_limit_request_id is not null then
    insert into public.booking_local_time_limit_events (
      booking_id, request_id, event_type, actor_user_id, actor_role,
      resulting_deadline_at, operation_request_key, evidence
    ) values (
      p_booking_id, v_booking.active_local_time_limit_request_id,
      'used_for_ticketing', p_actor_user_id, p_actor_role,
      v_booking.local_ticketing_deadline_at, p_idempotency_key,
      jsonb_build_object('walletAmountMinor', v_amount)
    ) on conflict do nothing;
  end if;
  update public.flight_bookings set
    status = 'in-progress', operation_kind = 'ticketing',
    operation_reason = 'ticketing', operation_request_id = p_idempotency_key,
    operation_actor_user_id = p_actor_user_id, operation_started_at = now(),
    operation_prior_status = 'on-hold'
  where id = p_booking_id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation, idempotency_key
  ) values (
    p_booking_id, 'on-hold', 'in-progress', 'on-hold', 'in-progress',
    'ticketing', 'ticketing', p_actor_user_id, 'NewTicket',
    p_idempotency_key || ':ticketing-start'
  ) on conflict do nothing;
  return v_result || jsonb_build_object('status', 'in-progress');
end;
$$;

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
declare
  v_booking public.flight_bookings;
  v_actor_role text;
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
  if v_booking.active_local_time_limit_request_id is not null then
    if v_booking.local_ticketing_deadline_at is null
       or v_booking.local_ticketing_deadline_at <= clock_timestamp() then
      return jsonb_build_object('ok', false, 'code', 'BOOKING_EXPIRED');
    end if;
  elsif v_booking.supplier_ticketing_deadline_at is null
     or v_booking.supplier_ticketing_deadline_at <
          clock_timestamp() + interval '15 minutes' then
    return jsonb_build_object('ok', false, 'code', 'LOCAL_TIME_LIMIT_REQUIRED');
  end if;
  if v_booking.ticketing_deadline_at is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_DEADLINE_REQUIRED');
  end if;
  if v_booking.ticketing_deadline_at <= clock_timestamp() then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_EXPIRED');
  end if;
  if v_booking.active_local_time_limit_request_id is not null then
    select role into v_actor_role
      from public.app_users where clerk_id = p_actor_user_id;
    insert into public.booking_local_time_limit_events (
      booking_id, request_id, event_type, actor_user_id, actor_role,
      resulting_deadline_at, operation_request_key, evidence
    ) values (
      p_booking_id, v_booking.active_local_time_limit_request_id,
      'used_for_cancellation', p_actor_user_id,
      case
        when v_actor_role in (
          'superadmin', 'admin', 'staff_support', 'staff_account',
          'customer', 'b2b', 'b2b_sub'
        ) then v_actor_role
        else 'system'
      end,
      v_booking.local_ticketing_deadline_at, p_idempotency_key,
      jsonb_build_object('walletMutation', false)
    ) on conflict do nothing;
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

alter table public.booking_deadline_observations enable row level security;
alter table public.booking_local_time_limit_requests enable row level security;
alter table public.booking_local_time_limit_events enable row level security;

revoke all on table public.booking_deadline_observations
  from public, anon, authenticated;
revoke all on table public.booking_local_time_limit_requests
  from public, anon, authenticated;
revoke all on table public.booking_local_time_limit_events
  from public, anon, authenticated;
grant select, insert on table public.booking_deadline_observations to service_role;
grant select, insert, update on table public.booking_local_time_limit_requests to service_role;
grant select, insert on table public.booking_local_time_limit_events to service_role;
grant usage, select on sequence public.booking_local_time_limit_events_id_seq
  to service_role;

revoke all on function public.request_booking_local_time_limit_v1(
  uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.decide_booking_local_time_limit_v1(
  uuid, uuid, integer, text, text, numeric, text
) from public, anon, authenticated;
revoke all on function public.record_booking_pnr_refresh_v3(
  uuid, text, text, text, text, jsonb, text, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.record_booking_supplier_refresh_v3(
  uuid, text, text, text, text, jsonb, jsonb, timestamptz, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.request_booking_local_time_limit_v1(
  uuid, text, text, text
) to service_role;
grant execute on function public.decide_booking_local_time_limit_v1(
  uuid, uuid, integer, text, text, numeric, text
) to service_role;
grant execute on function public.record_booking_pnr_refresh_v3(
  uuid, text, text, text, text, jsonb, text, timestamptz, jsonb
) to service_role;
grant execute on function public.record_booking_supplier_refresh_v3(
  uuid, text, text, text, text, jsonb, jsonb, timestamptz, timestamptz, jsonb
) to service_role;

comment on column public.flight_bookings.supplier_ticketing_deadline_at is
  'Current supplier deadline evidence. A local approval never overwrites it.';
comment on column public.flight_bookings.local_ticketing_deadline_at is
  'Most recently approved local deadline. ticketing_deadline_at is effective while its request is active.';
comment on table public.booking_deadline_observations is
  'Append-only supplier TTL/deadline observations, including explicit missing deadlines.';
comment on table public.booking_local_time_limit_requests is
  'User duration-free requests and staff-reviewed custom whole-minute local grants from 1 through 30 minutes.';
comment on function public.request_booking_local_time_limit_v1(uuid,text,text,text) is
  'Creates one owner-scoped request only when Triplover TTL is missing or has less than 15 minutes remaining; users cannot choose minutes.';
comment on function public.decide_booking_local_time_limit_v1(uuid,uuid,integer,text,text,numeric,text) is
  'Approves or rejects after staff verification. Approval sets the effective deadline without changing wallet state or supplier evidence.';
