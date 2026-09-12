-- Generic wallet authorization hardening.
--
-- Support may inspect wallet queues and reports through the application, but
-- only Accounts/Admin/Superadmin may create or review unrestricted manual
-- adjustments. The database mirror in app_users is the canonical role source;
-- caller-supplied role text is never accepted as authority.

create or replace function public.enforce_wallet_adjustment_request_actor_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
begin
  if tg_op = 'UPDATE' then
    if new.requested_by_user_id is distinct from old.requested_by_user_id
       or new.requested_by_role is distinct from old.requested_by_role then
      raise exception 'adjustment requester identity is immutable'
        using errcode = '55000';
    end if;
    return new;
  end if;

  select app_user.role into v_actor_role
    from public.app_users app_user
   where app_user.clerk_id = new.requested_by_user_id;
  if v_actor_role not in ('superadmin', 'admin', 'staff_account') then
    raise exception 'WALLET_ADJUSTMENT_CREATE_FORBIDDEN'
      using errcode = '42501';
  end if;
  if new.requested_by_role is distinct from v_actor_role then
    raise exception 'WALLET_ACTOR_ROLE_MISMATCH'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists wallet_adjustment_request_actor_guard
  on public.wallet_adjustment_requests;
create trigger wallet_adjustment_request_actor_guard
  before insert or update of requested_by_user_id, requested_by_role
  on public.wallet_adjustment_requests
  for each row execute function public.enforce_wallet_adjustment_request_actor_v1();

create or replace function public.wallet_review_adjustment(
  p_request_id uuid,
  p_decision text,
  p_actor_user_id text,
  p_actor_role text,
  p_review_remarks text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_request public.wallet_adjustment_requests;
  v_account public.wallet_accounts;
  v_wallet public.wallets;
  v_entry_id uuid;
  v_after bigint;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'invalid adjustment decision' using errcode = '22023';
  end if;
  if nullif(btrim(p_actor_user_id), '') is null then
    raise exception 'invalid adjustment actor' using errcode = '22023';
  end if;

  select app_user.role into v_actor_role
    from public.app_users app_user
   where app_user.clerk_id = p_actor_user_id;
  if v_actor_role not in ('superadmin', 'admin', 'staff_account') then
    return jsonb_build_object(
      'ok', false, 'code', 'WALLET_ADJUSTMENT_REVIEW_FORBIDDEN'
    );
  end if;
  if p_actor_role is distinct from v_actor_role then
    return jsonb_build_object(
      'ok', false, 'code', 'WALLET_ACTOR_ROLE_MISMATCH'
    );
  end if;

  select * into v_request from public.wallet_adjustment_requests
   where id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if v_request.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_REVIEWED');
  end if;
  if v_request.requested_by_user_id = p_actor_user_id then
    return jsonb_build_object('ok', false, 'code', 'SELF_APPROVAL_FORBIDDEN');
  end if;
  if p_decision = 'rejected' then
    update public.wallet_adjustment_requests set
      status = 'rejected', reviewed_by_user_id = p_actor_user_id,
      review_remarks = p_review_remarks, reviewed_at = now()
    where id = p_request_id;
    return jsonb_build_object('ok', true, 'status', 'rejected');
  end if;

  select w.* into strict v_wallet
    from public.wallets w
    join public.wallet_accounts wa on wa.wallet_id = w.id
   where wa.id = v_request.wallet_account_id
   for update of w;
  select * into strict v_account
    from public.wallet_accounts
   where id = v_request.wallet_account_id
   for update;
  if v_request.adjustment_type = 'debit' and v_wallet.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'WALLET_FROZEN');
  end if;
  if v_request.adjustment_type = 'debit'
     and v_account.available_balance < v_request.amount then
    return jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_FUNDS',
      'available', v_account.available_balance, 'required', v_request.amount);
  end if;
  v_after := v_account.available_balance +
    case when v_request.adjustment_type = 'credit'
      then v_request.amount else -v_request.amount end;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    idempotency_key, created_by_user_id, created_by_role, remarks,
    metadata
  ) values (
    v_account.id,
    case when v_request.adjustment_type = 'credit'
      then 'manual_credit' else 'manual_debit' end,
    v_request.amount, v_request.currency,
    v_account.available_balance, v_after,
    v_account.hold_balance, v_account.hold_balance,
    'adjustment:' || v_request.id, p_actor_user_id, v_actor_role,
    v_request.reason,
    jsonb_build_object('requestedBy', v_request.requested_by_user_id)
  ) returning id into v_entry_id;
  update public.wallet_accounts set available_balance = v_after
   where id = v_account.id;
  update public.wallet_adjustment_requests set
    status = 'approved', reviewed_by_user_id = p_actor_user_id,
    review_remarks = p_review_remarks, reviewed_at = now(),
    ledger_entry_id = v_entry_id
  where id = p_request_id;
  return jsonb_build_object('ok', true, 'status', 'approved',
    'availableBalance', v_after);
end;
$$;

revoke all on function public.enforce_wallet_adjustment_request_actor_v1()
  from public, anon, authenticated;
grant execute on function public.enforce_wallet_adjustment_request_actor_v1()
  to service_role;

revoke all on function public.wallet_review_adjustment(
  uuid, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.wallet_review_adjustment(
  uuid, text, text, text, text
) to service_role;

comment on function public.wallet_review_adjustment(
  uuid, text, text, text, text
) is
  'Maker/checker manual adjustment review. Canonical Accounts/Admin/Superadmin role is required; Support and caller-supplied role escalation are rejected.';

-- wallet_refund_booking was already replaced by migration 0059 with an
-- app_users canonical-role lookup restricted to Accounts/Admin/Superadmin.
-- Retain its service-only execution boundary explicitly in this hardening
-- migration so adjustment and refund authority are reviewed together.
revoke all on function public.wallet_refund_booking(
  uuid, bigint, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.wallet_refund_booking(
  uuid, bigint, text, text, text, text
) to service_role;

comment on function public.enforce_wallet_adjustment_request_actor_v1() is
  'Rejects Support/non-financial creators, spoofed role claims, and requester identity changes on unrestricted manual adjustment requests.';
