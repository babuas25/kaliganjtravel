-- Durable confirmation SMS for approved B2B wallet deposit requests.
-- The intent is inserted by the same transaction that credits the wallet.

create table public.deposit_approved_sms_deliveries (
  id                     uuid primary key default gen_random_uuid(),
  deposit_request_id     uuid not null unique
                           references public.wallet_deposit_requests (id)
                           on delete restrict,
  recipient_number       text,
  recipient_number_hash  text,
  content_snapshot       jsonb not null,
  state                  text not null default 'pending',
  available_at           timestamptz not null default now(),
  claimed_at             timestamptz,
  claim_token            uuid,
  attempt_count          integer not null default 0,
  max_attempts           integer not null default 8,
  sent_at                timestamptz,
  completed_at           timestamptz,
  provider_message_id    text,
  last_error             text,
  suppression_reason     text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint deposit_approved_sms_state_check check (state in (
    'pending', 'processing', 'retry', 'sent', 'suppressed', 'dead_letter'
  )),
  constraint deposit_approved_sms_recipient_check check (
    (state = 'suppressed' and recipient_number is null
      and recipient_number_hash is null)
    or (recipient_number ~ '^[1-9][0-9]{7,14}$'
      and recipient_number_hash ~ '^[a-f0-9]{64}$')
  ),
  constraint deposit_approved_sms_snapshot_check check (
    jsonb_typeof(content_snapshot) = 'object'
  ),
  constraint deposit_approved_sms_attempt_check check (
    attempt_count >= 0 and max_attempts between 1 and 20
  )
);

create trigger deposit_approved_sms_touch_updated_at
  before update on public.deposit_approved_sms_deliveries
  for each row execute function public.touch_updated_at();

create index deposit_approved_sms_claim_idx
  on public.deposit_approved_sms_deliveries (available_at, created_at, id)
  where state in ('pending', 'retry');

create or replace function public.enqueue_deposit_approved_sms_v1()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_owner_type text;
  v_owner_key text;
  v_phone text;
  v_number text;
  v_state text := 'pending';
  v_suppression_reason text;
begin
  select wallet.owner_type, wallet.owner_key
    into v_owner_type, v_owner_key
    from public.wallet_accounts account
    join public.wallets wallet on wallet.id = account.wallet_id
   where account.id = new.wallet_account_id;

  if v_owner_type = 'agency' then
    select regexp_replace(coalesce(profile.agency_mobile, ''), '[^0-9]', '', 'g')
      into v_phone
      from public.agencies agency
      join public.user_profiles profile on profile.clerk_id = agency.owner_user_id
     where agency.agency_code = v_owner_key;
  end if;
  v_phone := coalesce(v_phone, '');

  if left(v_phone, 2) = '00' then
    v_number := substr(v_phone, 3);
  elsif left(v_phone, 3) = '880' then
    v_number := v_phone;
  elsif left(v_phone, 2) = '01' then
    v_number := '880' || substr(v_phone, 2);
  elsif char_length(v_phone) = 10 and left(v_phone, 1) = '1' then
    v_number := '880' || v_phone;
  else
    v_number := v_phone;
  end if;

  if v_owner_type <> 'agency' then
    v_state := 'suppressed';
    v_suppression_reason := 'b2b_partner_only';
  elsif coalesce(v_number, '') !~ '^[1-9][0-9]{7,14}$' then
    v_state := 'suppressed';
    v_suppression_reason := 'missing_or_invalid_b2b_partner_phone';
  end if;

  insert into public.deposit_approved_sms_deliveries (
    deposit_request_id, recipient_number, recipient_number_hash,
    content_snapshot, state, suppression_reason, completed_at
  ) values (
    new.id,
    case when v_state = 'suppressed' then null else v_number end,
    case when v_state = 'suppressed' then null
      else encode(digest(v_number, 'sha256'), 'hex') end,
    jsonb_build_object(
      'version', 1,
      'requestReference', new.public_ref,
      'currency', new.currency,
      'amountMinor', new.amount
    ),
    v_state,
    v_suppression_reason,
    case when v_state = 'suppressed' then clock_timestamp() else null end
  )
  on conflict (deposit_request_id) do nothing;
  return new;
end;
$$;

create trigger wallet_deposit_requests_enqueue_approved_sms
  after update of status on public.wallet_deposit_requests
  for each row
  when (new.status = 'approved' and old.status is distinct from new.status)
  execute function public.enqueue_deposit_approved_sms_v1();

create or replace function public.claim_deposit_approved_sms_v1(
  p_limit integer default 10,
  p_deposit_request_id uuid default null
)
returns table (
  delivery_id uuid,
  deposit_request_id uuid,
  recipient_number text,
  recipient_number_hash text,
  content_snapshot jsonb,
  delivery_claim_token uuid,
  attempt_count integer
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidates as (
    select delivery.id
      from public.deposit_approved_sms_deliveries delivery
     where delivery.state in ('pending', 'retry')
       and delivery.available_at <= clock_timestamp()
       and delivery.attempt_count < delivery.max_attempts
       and (p_deposit_request_id is null
         or delivery.deposit_request_id = p_deposit_request_id)
     order by delivery.available_at, delivery.created_at, delivery.id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 10), 50))
  ), claimed as (
    update public.deposit_approved_sms_deliveries delivery
       set state = 'processing', claimed_at = clock_timestamp(),
           claim_token = gen_random_uuid(),
           attempt_count = delivery.attempt_count + 1,
           last_error = null
      from candidates
     where delivery.id = candidates.id
    returning delivery.*
  )
  select claimed.id, claimed.deposit_request_id,
         claimed.recipient_number, claimed.recipient_number_hash,
         claimed.content_snapshot, claimed.claim_token,
         claimed.attempt_count
    from claimed
   order by claimed.created_at, claimed.id;
end;
$$;

create or replace function public.mark_deposit_approved_sms_sent_v1(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_provider_message_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.deposit_approved_sms_deliveries delivery
     set state = 'sent', sent_at = clock_timestamp(),
         completed_at = clock_timestamp(), claimed_at = null,
         claim_token = null,
         provider_message_id = nullif(left(p_provider_message_id, 500), ''),
         last_error = null
   where delivery.id = p_delivery_id
     and delivery.state = 'processing'
     and delivery.claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.fail_deposit_approved_sms_v1(
  p_delivery_id uuid,
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
  update public.deposit_approved_sms_deliveries delivery
     set state = case when delivery.attempt_count >= delivery.max_attempts
           then 'dead_letter' else 'retry' end,
         available_at = case when delivery.attempt_count >= delivery.max_attempts
           then delivery.available_at
           else clock_timestamp()
             + make_interval(mins => least(delivery.attempt_count * 5, 60)) end,
         completed_at = case when delivery.attempt_count >= delivery.max_attempts
           then clock_timestamp() else null end,
         claimed_at = null,
         claim_token = null,
         last_error = left(coalesce(p_error, 'SMS delivery failed.'), 1000)
   where delivery.id = p_delivery_id
     and delivery.state = 'processing'
     and delivery.claim_token = p_claim_token
  returning delivery.state into v_state;
  if not found then
    raise exception 'deposit approval SMS claim mismatch' using errcode = '40001';
  end if;
  return v_state;
end;
$$;

create or replace function public.recover_stale_deposit_approved_sms_claims_v1(
  p_limit integer default 100
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_count integer;
begin
  with stale as (
    select delivery.id
      from public.deposit_approved_sms_deliveries delivery
     where delivery.state = 'processing'
       and delivery.claimed_at < clock_timestamp() - interval '10 minutes'
     order by delivery.claimed_at, delivery.id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  update public.deposit_approved_sms_deliveries delivery
     set state = case when delivery.attempt_count >= delivery.max_attempts
           then 'dead_letter' else 'retry' end,
         available_at = clock_timestamp(),
         completed_at = case when delivery.attempt_count >= delivery.max_attempts
           then clock_timestamp() else null end,
         claimed_at = null,
         claim_token = null,
         last_error = 'Stale SMS delivery claim recovered.'
    from stale
   where delivery.id = stale.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

alter table public.deposit_approved_sms_deliveries enable row level security;
revoke all on table public.deposit_approved_sms_deliveries
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.deposit_approved_sms_deliveries
  to service_role;

revoke all on function public.enqueue_deposit_approved_sms_v1()
  from public, anon, authenticated, service_role;
revoke all on function public.claim_deposit_approved_sms_v1(integer,uuid),
  public.mark_deposit_approved_sms_sent_v1(uuid,uuid,text),
  public.fail_deposit_approved_sms_v1(uuid,uuid,text),
  public.recover_stale_deposit_approved_sms_claims_v1(integer)
  from public, anon, authenticated;
grant execute on function public.claim_deposit_approved_sms_v1(integer,uuid),
  public.mark_deposit_approved_sms_sent_v1(uuid,uuid,text),
  public.fail_deposit_approved_sms_v1(uuid,uuid,text),
  public.recover_stale_deposit_approved_sms_claims_v1(integer)
  to service_role;

comment on table public.deposit_approved_sms_deliveries is
  'One durable, retryable B2B partner SMS intent for each approved deposit request.';
