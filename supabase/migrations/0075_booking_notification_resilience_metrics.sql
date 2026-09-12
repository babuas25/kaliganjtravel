-- Notification retry, stale-claim recovery, dead-letter escalation, and metrics.

alter table public.booking_notification_outbox
  add column if not exists dead_lettered_at timestamptz,
  add column if not exists escalated_at timestamptz;
alter table public.booking_notification_deliveries
  add column if not exists dead_lettered_at timestamptz;

alter table public.booking_notification_outbox
  add constraint booking_notification_outbox_dead_letter_time_check
  check (state <> 'dead_letter' or dead_lettered_at is not null) not valid;
alter table public.booking_notification_deliveries
  add constraint booking_notification_deliveries_dead_letter_time_check
  check (state <> 'dead_letter' or dead_lettered_at is not null) not valid;

create or replace function public.stamp_booking_notification_dead_letter_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.state = 'dead_letter' then
    new.dead_lettered_at := coalesce(new.dead_lettered_at, clock_timestamp());
  end if;
  return new;
end;
$$;

drop trigger if exists booking_notification_outbox_stamp_dead_letter
  on public.booking_notification_outbox;
create trigger booking_notification_outbox_stamp_dead_letter
  before insert or update on public.booking_notification_outbox
  for each row execute function public.stamp_booking_notification_dead_letter_v1();
drop trigger if exists booking_notification_deliveries_stamp_dead_letter
  on public.booking_notification_deliveries;
create trigger booking_notification_deliveries_stamp_dead_letter
  before insert or update on public.booking_notification_deliveries
  for each row execute function public.stamp_booking_notification_dead_letter_v1();

create or replace function public.booking_notification_retry_delay_v1(
  p_attempt_count integer
)
returns interval
language sql
immutable
set search_path = public
as $$
  select case
    when p_attempt_count <= 1 then interval '1 minute'
    when p_attempt_count = 2 then interval '5 minutes'
    when p_attempt_count = 3 then interval '15 minutes'
    when p_attempt_count = 4 then interval '1 hour'
    when p_attempt_count = 5 then interval '4 hours'
    when p_attempt_count = 6 then interval '12 hours'
    else interval '24 hours'
  end
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
           else clock_timestamp()
             + public.booking_notification_retry_delay_v1(delivery.attempt_count)
           end,
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
           then outbox.available_at
           else clock_timestamp()
             + public.booking_notification_retry_delay_v1(outbox.attempt_count)
           end,
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

create or replace function public.recover_stale_booking_notification_claims_v1(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cutoff timestamptz := clock_timestamp() - interval '15 minutes';
  v_delivery_count integer := 0;
  v_outbox_count integer := 0;
begin
  with candidates as (
    select candidate.id
      from public.booking_notification_deliveries candidate
     where candidate.state = 'processing'
       and candidate.claimed_at <= v_cutoff
     order by candidate.claimed_at, candidate.id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  update public.booking_notification_deliveries delivery
     set state = case when delivery.attempt_count >= delivery.max_attempts
           then 'dead_letter' else 'retry' end,
         next_attempt_at = case when delivery.attempt_count >= delivery.max_attempts
           then delivery.next_attempt_at else clock_timestamp() end,
         completed_at = case when delivery.attempt_count >= delivery.max_attempts
           then clock_timestamp() else null end,
         claimed_at = null,
         claim_token = null,
         last_error = 'Recovered stale recipient delivery claim.'
    from candidates
   where delivery.id = candidates.id;
  get diagnostics v_delivery_count = row_count;

  with candidates as (
    select candidate.id
      from public.booking_notification_outbox candidate
     where candidate.state = 'processing'
       and candidate.claimed_at <= v_cutoff
       and not exists (
         select 1 from public.booking_notification_deliveries active
          where active.outbox_id = candidate.id
            and active.state = 'processing'
            and active.claimed_at > v_cutoff
       )
     order by candidate.claimed_at, candidate.id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  update public.booking_notification_outbox outbox
     set state = case
           when outbox.attempt_count >= outbox.max_attempts
             or exists (
               select 1 from public.booking_notification_deliveries delivery
                where delivery.outbox_id = outbox.id
                  and delivery.state in ('failed', 'dead_letter')
             ) then 'dead_letter'
           else 'pending'
         end,
         available_at = case
           when outbox.attempt_count >= outbox.max_attempts then outbox.available_at
           else coalesce((
             select min(delivery.next_attempt_at)
               from public.booking_notification_deliveries delivery
              where delivery.outbox_id = outbox.id
                and delivery.state in ('pending', 'retry')
           ), clock_timestamp())
         end,
         completed_at = case
           when outbox.attempt_count >= outbox.max_attempts
             or exists (
               select 1 from public.booking_notification_deliveries delivery
                where delivery.outbox_id = outbox.id
                  and delivery.state in ('failed', 'dead_letter')
             ) then clock_timestamp()
           else null
         end,
         claimed_at = null,
         claim_token = null,
         last_error = 'Recovered stale notification outbox claim.'
    from candidates
   where outbox.id = candidates.id;
  get diagnostics v_outbox_count = row_count;
  return jsonb_build_object(
    'recoveredDeliveries', v_delivery_count,
    'recoveredOutboxes', v_outbox_count
  );
end;
$$;

create or replace function public.escalate_booking_notification_dead_letters_v1(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  with candidates as (
    select candidate.id
      from public.booking_notification_outbox candidate
     where candidate.state = 'dead_letter'
       and candidate.escalated_at is null
     order by candidate.dead_lettered_at, candidate.id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  update public.booking_notification_outbox outbox
     set escalated_at = clock_timestamp()
    from candidates
   where outbox.id = candidates.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace view public.booking_notification_metrics_v
with (security_invoker = true)
as
select
  now() as observed_at,
  count(*) filter (where outbox.state = 'pending')::bigint
    as pending_outbox_count,
  count(*) filter (where outbox.state = 'processing')::bigint
    as processing_outbox_count,
  count(*) filter (where outbox.state = 'sent')::bigint
    as sent_outbox_count,
  count(*) filter (where outbox.state = 'suppressed')::bigint
    as suppressed_outbox_count,
  count(*) filter (where outbox.state = 'superseded')::bigint
    as superseded_outbox_count,
  count(*) filter (where outbox.state = 'dead_letter')::bigint
    as dead_letter_outbox_count,
  count(*) filter (
    where outbox.state = 'dead_letter' and outbox.escalated_at is null
  )::bigint as un_escalated_dead_letter_count,
  min(outbox.created_at) filter (where outbox.state = 'pending')
    as oldest_pending_outbox_at,
  min(outbox.dead_lettered_at) filter (where outbox.state = 'dead_letter')
    as oldest_dead_letter_at,
  (select count(*)::bigint
     from public.booking_notification_deliveries delivery
    where delivery.state = 'retry') as retry_delivery_count,
  (select count(*)::bigint
     from public.booking_notification_deliveries delivery
    where delivery.state = 'processing') as processing_delivery_count,
  (select count(*)::bigint
     from public.booking_notification_deliveries delivery
    where delivery.state = 'sent') as sent_delivery_count,
  (select count(*)::bigint
     from public.booking_notification_deliveries delivery
    where delivery.state = 'dead_letter') as dead_letter_delivery_count
from public.booking_notification_outbox outbox;

revoke all on table public.booking_notification_metrics_v
  from public, anon, authenticated;
grant select on table public.booking_notification_metrics_v to service_role;

revoke all on function public.stamp_booking_notification_dead_letter_v1(),
  public.booking_notification_retry_delay_v1(integer),
  public.recover_stale_booking_notification_claims_v1(integer),
  public.escalate_booking_notification_dead_letters_v1(integer)
  from public, anon, authenticated;
grant execute on function public.booking_notification_retry_delay_v1(integer),
  public.recover_stale_booking_notification_claims_v1(integer),
  public.escalate_booking_notification_dead_letters_v1(integer)
  to service_role;
revoke all on function public.stamp_booking_notification_dead_letter_v1()
  from service_role;

comment on view public.booking_notification_metrics_v is
  'Address-free occurrence/delivery health: pending, processing, retry, sent, suppression, supersession, dead-letter, and escalation counts.';
