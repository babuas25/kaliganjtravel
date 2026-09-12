-- Admin and Super Admin may finalize an approved Ticket Management request
-- directly. The wrapper records a self-assignment for audit continuity before
-- calling the existing exact settlement functions. Accounts Staff still need
-- an explicit assignment from Support/Admin/Super Admin.

create or replace function public.ticket_management_prepare_direct_settlement_v1(
  p_request_id uuid,
  p_actor_user_id text,
  p_expected_version integer,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_assignment jsonb;
  v_version integer;
begin
  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role not in ('staff_account', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'FINAL_SETTLEMENT_FORBIDDEN');
  end if;

  if v_actor_role in ('admin', 'superadmin') then
    v_assignment := public.assign_ticket_management_settlement_v1(
      p_request_id,
      p_actor_user_id,
      p_actor_user_id,
      p_expected_version,
      p_request_key || ':direct-assignment',
      'Direct settlement by ' || v_actor_role
    );
    if not coalesce((v_assignment->>'ok')::boolean, false) then
      return v_assignment;
    end if;
  end if;

  select request.version into v_version
    from public.ticket_management_requests request
   where request.id = p_request_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND');
  end if;

  return jsonb_build_object(
    'ok', true,
    'actorRole', v_actor_role,
    'settlementVersion', case
      when v_actor_role in ('admin', 'superadmin') then v_version
      else p_expected_version
    end
  );
end;
$$;

create or replace function public.complete_ticket_management_refund_v2(
  p_request_id uuid,
  p_actor_user_id text,
  p_expected_version integer,
  p_request_key text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prepared jsonb;
begin
  v_prepared := public.ticket_management_prepare_direct_settlement_v1(
    p_request_id, p_actor_user_id, p_expected_version, p_request_key
  );
  if not coalesce((v_prepared->>'ok')::boolean, false) then return v_prepared; end if;
  return public.complete_ticket_management_refund_v1(
    p_request_id, p_actor_user_id,
    (v_prepared->>'settlementVersion')::integer,
    p_request_key, p_note
  );
end;
$$;

create or replace function public.complete_ticket_management_reissue_v2(
  p_request_id uuid,
  p_actor_user_id text,
  p_expected_version integer,
  p_request_key text,
  p_new_tickets jsonb,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prepared jsonb;
begin
  v_prepared := public.ticket_management_prepare_direct_settlement_v1(
    p_request_id, p_actor_user_id, p_expected_version, p_request_key
  );
  if not coalesce((v_prepared->>'ok')::boolean, false) then return v_prepared; end if;
  return public.complete_ticket_management_reissue_v1(
    p_request_id, p_actor_user_id,
    (v_prepared->>'settlementVersion')::integer,
    p_request_key, p_new_tickets, p_note
  );
end;
$$;

create or replace function public.release_and_reopen_ticket_management_reissue_v2(
  p_request_id uuid,
  p_actor_user_id text,
  p_expected_version integer,
  p_request_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prepared jsonb;
begin
  v_prepared := public.ticket_management_prepare_direct_settlement_v1(
    p_request_id, p_actor_user_id, p_expected_version, p_request_key
  );
  if not coalesce((v_prepared->>'ok')::boolean, false) then return v_prepared; end if;
  return public.release_and_reopen_ticket_management_reissue_v1(
    p_request_id, p_actor_user_id,
    (v_prepared->>'settlementVersion')::integer,
    p_request_key, p_reason
  );
end;
$$;

create or replace function public.complete_ticket_management_void_v2(
  p_request_id uuid,
  p_actor_user_id text,
  p_expected_version integer,
  p_request_key text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prepared jsonb;
begin
  v_prepared := public.ticket_management_prepare_direct_settlement_v1(
    p_request_id, p_actor_user_id, p_expected_version, p_request_key
  );
  if not coalesce((v_prepared->>'ok')::boolean, false) then return v_prepared; end if;
  return public.complete_ticket_management_void_v1(
    p_request_id, p_actor_user_id,
    (v_prepared->>'settlementVersion')::integer,
    p_request_key, p_note
  );
end;
$$;

create or replace function public.release_and_reopen_ticket_management_void_v2(
  p_request_id uuid,
  p_actor_user_id text,
  p_expected_version integer,
  p_request_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prepared jsonb;
begin
  v_prepared := public.ticket_management_prepare_direct_settlement_v1(
    p_request_id, p_actor_user_id, p_expected_version, p_request_key
  );
  if not coalesce((v_prepared->>'ok')::boolean, false) then return v_prepared; end if;
  return public.release_and_reopen_ticket_management_void_v1(
    p_request_id, p_actor_user_id,
    (v_prepared->>'settlementVersion')::integer,
    p_request_key, p_reason
  );
end;
$$;

revoke all on function public.ticket_management_prepare_direct_settlement_v1(
  uuid, text, integer, text
) from public, anon, authenticated, service_role;

revoke all on function public.complete_ticket_management_refund_v1(
  uuid, text, integer, text, text
) from service_role;
revoke all on function public.complete_ticket_management_reissue_v1(
  uuid, text, integer, text, jsonb, text
) from service_role;
revoke all on function public.release_and_reopen_ticket_management_reissue_v1(
  uuid, text, integer, text, text
) from service_role;
revoke all on function public.complete_ticket_management_void_v1(
  uuid, text, integer, text, text
) from service_role;
revoke all on function public.release_and_reopen_ticket_management_void_v1(
  uuid, text, integer, text, text
) from service_role;

revoke all on function public.complete_ticket_management_refund_v2(
  uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.complete_ticket_management_refund_v2(
  uuid, text, integer, text, text
) to service_role;
revoke all on function public.complete_ticket_management_reissue_v2(
  uuid, text, integer, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.complete_ticket_management_reissue_v2(
  uuid, text, integer, text, jsonb, text
) to service_role;
revoke all on function public.release_and_reopen_ticket_management_reissue_v2(
  uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.release_and_reopen_ticket_management_reissue_v2(
  uuid, text, integer, text, text
) to service_role;
revoke all on function public.complete_ticket_management_void_v2(
  uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.complete_ticket_management_void_v2(
  uuid, text, integer, text, text
) to service_role;
revoke all on function public.release_and_reopen_ticket_management_void_v2(
  uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.release_and_reopen_ticket_management_void_v2(
  uuid, text, integer, text, text
) to service_role;

comment on function public.ticket_management_prepare_direct_settlement_v1(
  uuid, text, integer, text
) is
  'Internal settlement gate: Admin and Super Admin receive an audited self-assignment; Accounts Staff retain explicit assignment requirements.';
