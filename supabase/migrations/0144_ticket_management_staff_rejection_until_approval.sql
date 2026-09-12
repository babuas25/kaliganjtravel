-- Support/Admin may reject an operational request at any point before the
-- customer approves its quotation. Rejection remains terminal, releases the
-- selected ticket claims through the existing status trigger, and preserves
-- any published quotation as immutable audit history.

create or replace function public.review_ticket_management_request_v1(
  p_request_id uuid,
  p_decision text,
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
  v_actor_role text;
  v_request public.ticket_management_requests;
  v_existing_event public.ticket_management_request_events;
  v_from_status text;
  v_status text;
  v_outcome text;
  v_event_type text;
  v_version integer;
begin
  if p_decision not in ('accept', 'reject')
     or p_expected_version is null or p_expected_version < 1
     or nullif(btrim(p_request_key), '') is null then
    raise exception 'invalid Ticket Management review' using errcode = '22023';
  end if;
  v_event_type := case when p_decision = 'accept' then 'accepted' else 'staff-rejected' end;

  select role into v_actor_role from public.app_users where clerk_id = p_actor_user_id;
  if v_actor_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_FORBIDDEN');
  end if;
  select event.* into v_existing_event
    from public.ticket_management_request_events event
   where event.idempotency_key = p_request_key || ':event';
  if found then
    if v_existing_event.request_id is distinct from p_request_id
       or v_existing_event.event_type is distinct from v_event_type then
      return jsonb_build_object('ok', false, 'code', 'REVIEW_IDEMPOTENCY_CONFLICT');
    end if;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', p_request_id,
      'status', v_existing_event.to_status,
      'version', v_existing_event.request_version
    );
  end if;

  select request.* into v_request
    from public.ticket_management_requests request
   where request.id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND'); end if;
  if v_request.version <> p_expected_version then
    return jsonb_build_object(
      'ok', false, 'code', 'REQUEST_VERSION_CONFLICT', 'version', v_request.version
    );
  end if;
  if p_decision = 'accept' and v_request.status <> 'requested' then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_REVIEWABLE');
  end if;
  if p_decision = 'reject'
     and v_request.status not in ('requested', 'in-progress', 'awaiting-confirmation') then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_REJECTABLE');
  end if;

  v_from_status := v_request.status;
  if p_decision = 'accept' then
    v_status := 'in-progress';
    v_outcome := null;
    update public.ticket_management_requests
       set status = v_status, terminal_outcome = null,
           accepted_by_user_id = p_actor_user_id,
           accepted_at = clock_timestamp(), status_changed_at = clock_timestamp(),
           version = version + 1
     where id = v_request.id returning version into v_version;
  else
    v_status := 'rejected';
    v_outcome := 'staff-rejected';
    update public.ticket_management_requests
       set status = v_status, terminal_outcome = v_outcome,
           rejected_at = clock_timestamp(), status_changed_at = clock_timestamp(),
           version = version + 1
     where id = v_request.id returning version into v_version;
  end if;

  perform public.ticket_management_append_event_v1(
    v_request.id, v_event_type, v_from_status, v_status, v_version,
    p_actor_user_id, v_actor_role, p_request_key || ':event', p_note,
    jsonb_build_object('decision', p_decision)
  );
  return jsonb_build_object(
    'ok', true, 'replay', false, 'requestId', v_request.id,
    'status', v_status, 'version', v_version
  );
end;
$$;

revoke all on function public.review_ticket_management_request_v1(
  uuid, text, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.review_ticket_management_request_v1(
  uuid, text, text, integer, text, text
) to service_role;

comment on function public.review_ticket_management_request_v1(
  uuid, text, text, integer, text, text
) is
  'Accepts a newly requested item or lets Support/Admin reject it until customer quotation approval; terminal rejection releases ticket claims through the request status trigger.';
