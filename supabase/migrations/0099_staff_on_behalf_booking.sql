-- Staff may create supplier holds for a selected customer/agency, but may not
-- reserve wallet funds or issue tickets. Creator and financial owner remain
-- distinct, durable audit identities.

alter table public.booking_attempts
  add column if not exists created_by_user_id text
    references public.app_users (clerk_id) on delete set null,
  add column if not exists staff_on_behalf boolean not null default false;

update public.booking_attempts
   set created_by_user_id = coalesce(created_by_user_id, user_id)
 where created_by_user_id is null;

create index if not exists booking_attempts_creator_created_idx
  on public.booking_attempts (created_by_user_id, created_at desc);

create or replace function public.enforce_staff_on_behalf_booking_v1()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_attempt public.booking_attempts;
  v_creator_role text;
  v_owner_role text;
  v_owner_agency text;
begin
  if new.attempt_id is null then return new; end if;
  select * into v_attempt from public.booking_attempts where id = new.attempt_id;
  if not found or not v_attempt.staff_on_behalf then return new; end if;

  select role into v_creator_role
    from public.app_users where clerk_id = v_attempt.created_by_user_id;
  select role, agency_code into v_owner_role, v_owner_agency
    from public.app_users where clerk_id = v_attempt.user_id;

  if v_creator_role not in ('superadmin', 'admin', 'staff_support') then
    raise exception 'staff booking creator is not authorized' using errcode = '42501';
  end if;
  if v_owner_role not in ('b2b', 'b2b_sub', 'customer') then
    raise exception 'staff booking owner is not eligible' using errcode = '42501';
  end if;
  if new.user_id is distinct from v_attempt.user_id then
    raise exception 'staff booking owner changed during finalization' using errcode = '23514';
  end if;
  if v_owner_role in ('b2b', 'b2b_sub') and
     (v_owner_agency is null or new.audience <> 'agency' or
      new.agency_code is distinct from v_owner_agency) then
    raise exception 'staff booking agency owner mismatch' using errcode = '23514';
  end if;
  if v_owner_role = 'customer' and new.audience <> 'b2c' then
    raise exception 'staff booking B2C owner mismatch' using errcode = '23514';
  end if;
  if new.status <> 'on-hold' or new.direct_ticketing or new.issued_at is not null or
     new.payment_state <> 'unpaid' or new.charged_wallet_account_id is not null or
     coalesce(new.captured_amount, 0) <> 0 or coalesce(new.refunded_amount, 0) <> 0 then
    raise exception 'staff booking must remain an unpaid hold' using errcode = '23514';
  end if;

  new.booked_by_user_id := v_attempt.created_by_user_id;
  return new;
end;
$$;

drop trigger if exists flight_bookings_staff_on_behalf_invariant_v1
  on public.flight_bookings;
create trigger flight_bookings_staff_on_behalf_invariant_v1
  before insert on public.flight_bookings
  for each row execute function public.enforce_staff_on_behalf_booking_v1();

-- Backend defense-in-depth: even a future route calling the wallet RPC cannot
-- make Admin or Support the actor for NewTicket.
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
  if p_actor_role in ('superadmin', 'admin', 'staff_support') then
    return jsonb_build_object('ok', false, 'code', 'ISSUE_FORBIDDEN');
  end if;
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
    v_amount := round((v_booking.pricing_snapshot->>'sellingPrice')::numeric * 100)::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
  end;
  v_result := public.wallet_reserve_amount(
    v_booking.id, null, v_booking.booking_owner_type, v_booking.booking_owner_key,
    v_amount, v_booking.currency, p_actor_user_id, p_actor_role,
    p_idempotency_key, v_booking.public_ref
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then return v_result; end if;
  update public.flight_bookings set
    status = 'in-progress', operation_kind = 'ticketing',
    operation_reason = 'ticketing', operation_request_id = p_idempotency_key,
    operation_actor_user_id = p_actor_user_id, operation_started_at = now(),
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

create or replace function public.wallet_begin_booking_issue_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_request_key text,
  p_request_payload_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claim jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_operation_id uuid;
begin
  if p_actor_role in ('superadmin', 'admin', 'staff_support') then
    return jsonb_build_object('ok', false, 'code', 'ISSUE_FORBIDDEN');
  end if;
  v_claim := public.claim_booking_operation_identity(
    p_booking_id, 'ticketing', 'ticketing', null,
    p_request_key, p_request_payload_hash,
    p_actor_user_id, p_actor_role, 'staff', 'NewTicket', null
  );
  if coalesce((v_claim->>'ok')::boolean, false) is not true then return v_claim; end if;
  v_replay := public.booking_operation_replay_response(v_claim);
  if v_replay is not null then return v_replay; end if;
  v_operation_id := (v_claim->>'operationId')::uuid;
  v_result := public.wallet_begin_booking_issue(
    p_booking_id, p_actor_user_id, p_actor_role, p_request_key
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    update public.booking_operations set
      state = 'failed', completed_at = now(),
      error_code = coalesce(v_result->>'code', 'CLAIM_FAILED'),
      supplier_evidence = jsonb_build_object(
        'phase', 'local_claim', 'resultCode', v_result->>'code'
      )
    where id = v_operation_id and state = 'claimed';
    return v_result || jsonb_build_object(
      'operationId', v_operation_id, 'operationState', 'failed'
    );
  end if;
  update public.flight_bookings set active_operation_id = v_operation_id
    where id = p_booking_id;
  update public.booking_status_events set operation_id = v_operation_id
    where booking_id = p_booking_id
      and idempotency_key = p_request_key || ':ticketing-start';
  return v_result || jsonb_build_object(
    'replay', false, 'operationId', v_operation_id, 'operationState', 'claimed'
  );
end;
$$;

-- Add creator identity to the already-narrow paginated list in the same query.
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
  nullif(owner_profile.agency_name, '') as creator_agency_name,
  lower(concat_ws(' ',
    coalesce(creator.first_name, ''), coalesce(creator.last_name, ''),
    coalesce(creator.email, ''), coalesce(creator.role, ''),
    coalesce(creator.agency_code, ''), coalesce(owner_profile.agency_name, '')
  )) as creator_search_text
from public.booking_dashboard_list_ordered_v list
join public.flight_bookings booking on booking.id = list.id
left join public.app_users creator
  on creator.clerk_id = coalesce(booking.booked_by_user_id, booking.user_id)
left join public.agencies creator_agency
  on creator_agency.agency_code = creator.agency_code
left join public.user_profiles owner_profile
  on owner_profile.clerk_id = creator_agency.owner_user_id;

revoke all on table public.booking_dashboard_creator_v from public, anon, authenticated;
grant select on table public.booking_dashboard_creator_v to service_role;

comment on view public.booking_dashboard_creator_v is
  'Paginated booking list with creator role and agency identity resolved in one read.';
