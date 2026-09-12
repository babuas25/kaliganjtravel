-- Shared security primitives for route and dashboard hardening.

-- 1. Atomic, deployment-wide rate limits -----------------------------------

create table if not exists public.security_rate_limits (
  key        text primary key check (char_length(key) between 1 and 512),
  count      integer not null check (count >= 1),
  reset_at   timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists security_rate_limits_reset_at_idx
  on public.security_rate_limits (reset_at);

alter table public.security_rate_limits enable row level security;
revoke all on table public.security_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.security_rate_limits
  to service_role;

create or replace function public.consume_security_rate_limit(
  p_key text,
  p_limit integer,
  p_window_ms bigint
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_count integer;
  v_reset_at timestamptz;
begin
  if p_key is null or char_length(p_key) not between 1 and 512 then
    raise exception 'rate-limit key is invalid' using errcode = '22023';
  end if;
  if p_limit < 1 or p_window_ms < 1000 then
    raise exception 'rate-limit policy is invalid' using errcode = '22023';
  end if;

  -- The indexed delete bounds cardinality even when public callers continually
  -- introduce new address keys and no booking-retention pass happens that day.
  delete from public.security_rate_limits
   where reset_at < v_now - interval '1 day';

  insert into public.security_rate_limits as limits (
    key, count, reset_at, updated_at
  )
  values (
    p_key,
    1,
    v_now + make_interval(secs => p_window_ms::double precision / 1000),
    v_now
  )
  on conflict (key) do update
    set count = case
          when limits.reset_at <= v_now then 1
          else limits.count + 1
        end,
        reset_at = case
          when limits.reset_at <= v_now
            then v_now + make_interval(
              secs => p_window_ms::double precision / 1000
            )
          else limits.reset_at
        end,
        updated_at = v_now
  returning count, reset_at into v_count, v_reset_at;

  allowed := v_count <= p_limit;
  retry_after_seconds := greatest(
    1,
    ceil(extract(epoch from (v_reset_at - v_now)))::integer
  );
  return next;
end;
$$;

revoke execute on function public.consume_security_rate_limit(text, integer, bigint)
  from public, anon, authenticated;
grant execute on function public.consume_security_rate_limit(text, integer, bigint)
  to service_role;

comment on function public.consume_security_rate_limit(text, integer, bigint) is
  'Atomically consumes one deployment-wide allowance and returns its retry window.';

-- 2. Cross-instance lock for privileged identity mutations -----------------

create table if not exists public.security_operation_locks (
  name         text primary key check (char_length(name) between 1 and 100),
  holder       uuid not null,
  locked_until timestamptz not null,
  updated_at   timestamptz not null default now()
);

alter table public.security_operation_locks enable row level security;
revoke all on table public.security_operation_locks
  from public, anon, authenticated;
grant select, insert, update, delete on table public.security_operation_locks
  to service_role;

create or replace function public.try_acquire_security_lock(
  p_name text,
  p_holder uuid,
  p_lease_seconds integer default 60
)
returns boolean
language plpgsql
as $$
declare
  v_acquired boolean := false;
  v_now timestamptz := clock_timestamp();
begin
  if p_name is null or char_length(p_name) not between 1 and 100 then
    raise exception 'security lock name is invalid' using errcode = '22023';
  end if;
  if p_holder is null or p_lease_seconds not between 5 and 300 then
    raise exception 'security lock lease is invalid' using errcode = '22023';
  end if;

  insert into public.security_operation_locks as locks (
    name, holder, locked_until, updated_at
  )
  values (
    p_name,
    p_holder,
    v_now + make_interval(secs => p_lease_seconds),
    v_now
  )
  on conflict (name) do update
    set holder = excluded.holder,
        locked_until = excluded.locked_until,
        updated_at = excluded.updated_at
    where locks.locked_until <= v_now
       or locks.holder = p_holder
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

create or replace function public.release_security_lock(
  p_name text,
  p_holder uuid
)
returns boolean
language plpgsql
as $$
declare
  v_row_count bigint;
begin
  delete from public.security_operation_locks
   where name = p_name
     and holder = p_holder;
  get diagnostics v_row_count = row_count;
  return v_row_count > 0;
end;
$$;

revoke execute on function public.try_acquire_security_lock(text, uuid, integer)
  from public, anon, authenticated;
revoke execute on function public.release_security_lock(text, uuid)
  from public, anon, authenticated;
grant execute on function public.try_acquire_security_lock(text, uuid, integer)
  to service_role;
grant execute on function public.release_security_lock(text, uuid)
  to service_role;

-- 3. Durable security audit trail ------------------------------------------

create table if not exists public.security_audit_events (
  id            uuid primary key default gen_random_uuid(),
  actor_user_id text not null check (char_length(actor_user_id) between 1 and 255),
  actor_role    text not null check (char_length(actor_role) between 1 and 50),
  action        text not null check (char_length(action) between 1 and 100),
  target_type   text not null check (char_length(target_type) between 1 and 50),
  target_id     text check (target_id is null or char_length(target_id) <= 512),
  outcome       text not null default 'succeeded'
                check (outcome in ('attempted', 'succeeded', 'failed', 'denied')),
  metadata      jsonb not null default '{}'::jsonb
                check (jsonb_typeof(metadata) = 'object'),
  created_at    timestamptz not null default now()
);

create index if not exists security_audit_events_actor_created_idx
  on public.security_audit_events (actor_user_id, created_at desc);
create index if not exists security_audit_events_target_created_idx
  on public.security_audit_events (target_type, target_id, created_at desc);

alter table public.security_audit_events enable row level security;
revoke all on table public.security_audit_events
  from public, anon, authenticated;
grant insert, select on table public.security_audit_events to service_role;

comment on table public.security_audit_events is
  'Append-only server-side trail of privileged identity and sensitive-data operations.';

-- 4. Booking-attempt sensitive-data retention ------------------------------

create or replace function public.clear_succeeded_attempt_passengers()
returns trigger
language plpgsql
as $$
begin
  if new.state = 'succeeded' then
    new.passenger_snapshot := null;
  end if;
  return new;
end;
$$;

drop trigger if exists booking_attempts_clear_succeeded_passengers
  on public.booking_attempts;
create trigger booking_attempts_clear_succeeded_passengers
  before insert or update of state, passenger_snapshot
  on public.booking_attempts
  for each row execute function public.clear_succeeded_attempt_passengers();

create or replace function public.enforce_security_retention()
returns jsonb
language plpgsql
as $$
declare
  v_drafts bigint;
  v_failed bigint;
  v_snapshots bigint;
  v_rate_limits bigint;
  v_locks bigint;
begin
  delete from public.booking_attempts
   where state = 'draft'
     and created_at < now() - interval '7 days';
  get diagnostics v_drafts = row_count;

  delete from public.booking_attempts
   where state = 'failed'
     and coalesce(resolved_at, created_at) < now() - interval '90 days';
  get diagnostics v_failed = row_count;

  update public.booking_attempts
     set passenger_snapshot = null
   where passenger_snapshot is not null
     and (
       state = 'succeeded'
       or (
         state = 'unknown'
         and coalesce(resolved_at, created_at) < now() - interval '90 days'
       )
     );
  get diagnostics v_snapshots = row_count;

  delete from public.security_rate_limits
   where reset_at < now() - interval '1 day';
  get diagnostics v_rate_limits = row_count;

  delete from public.security_operation_locks
   where locked_until < now();
  get diagnostics v_locks = row_count;

  return jsonb_build_object(
    'draftsDeleted', v_drafts,
    'failedDeleted', v_failed,
    'passengerSnapshotsCleared', v_snapshots,
    'rateLimitsDeleted', v_rate_limits,
    'locksDeleted', v_locks
  );
end;
$$;

revoke execute on function public.enforce_security_retention()
  from public, anon, authenticated;
grant execute on function public.enforce_security_retention()
  to service_role;

comment on function public.enforce_security_retention() is
  'Prunes expired operational rows and removes passenger PII no longer needed for reconciliation.';
