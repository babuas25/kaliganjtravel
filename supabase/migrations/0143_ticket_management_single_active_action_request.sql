-- Permit only one open request for a booking/action pair. Exact retries keep
-- their original request identity, while rejected, expired, and fully-settled
-- requests no longer block a later Refund, Reissue, or VOID request.

create index if not exists ticket_management_requests_open_action_lookup_idx
  on public.ticket_management_requests(booking_id, action, created_at desc, id)
  where status in ('requested', 'in-progress', 'awaiting-confirmation')
     or (status = 'approved' and terminal_outcome is null);

create or replace function public.ticket_management_enforce_single_open_action_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('requested', 'in-progress', 'awaiting-confirmation')
     or (new.status = 'approved' and new.terminal_outcome is null) then
    perform pg_advisory_xact_lock(hashtextextended(
      concat_ws(':', 'ticket-management-open-action-v1',
        new.booking_id::text, new.action),
      0
    ));
    if exists (
      select 1
        from public.ticket_management_requests request
       where request.booking_id = new.booking_id
         and request.action = new.action
         and request.id <> new.id
         and (
           request.status in ('requested', 'in-progress', 'awaiting-confirmation')
           or (request.status = 'approved' and request.terminal_outcome is null)
         )
    ) then
      raise exception 'ticket management action already has an active request'
        using errcode = '23505';
    end if;
  end if;
  return new;
end;
$$;

create trigger ticket_management_requests_single_open_action
  before insert or update of booking_id, action, status, terminal_outcome
  on public.ticket_management_requests
  for each row execute function public.ticket_management_enforce_single_open_action_v1();

create or replace function public.create_ticket_management_request_v3(
  p_booking_id uuid,
  p_action text,
  p_actor_user_id text,
  p_request_key text,
  p_request_payload_hash text,
  p_passenger_indexes integer[],
  p_request_type text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_request_type text := lower(btrim(coalesce(p_request_type, '')));
  v_active public.ticket_management_requests;
begin
  if v_request_type not in ('voluntary', 'involuntary') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST_TYPE');
  end if;

  -- Serialize new identities for the same booking/action. The lower-level
  -- request-key lock still owns exact replay and payload-conflict handling.
  perform pg_advisory_xact_lock(hashtextextended(
    concat_ws(':', 'ticket-management-open-action-v1',
      coalesce(p_booking_id::text, ''), coalesce(p_action, '')),
    0
  ));

  select request.* into v_active
    from public.ticket_management_requests request
   where request.booking_id = p_booking_id
     and request.action = p_action
     and request.request_key <> p_request_key
     and (
       request.status in ('requested', 'in-progress', 'awaiting-confirmation')
       or (request.status = 'approved' and request.terminal_outcome is null)
     )
   order by request.created_at desc, request.id desc
   limit 1;
  if found then
    return jsonb_build_object(
      'ok', false,
      'code', 'ACTIVE_REQUEST_EXISTS',
      'requestId', v_active.id,
      'publicReference', v_active.public_ref,
      'status', v_active.status,
      'version', v_active.version
    );
  end if;

  v_result := public.create_ticket_management_request_v2(
    p_booking_id, p_action, p_actor_user_id, p_request_key,
    p_request_payload_hash, p_passenger_indexes, p_note
  );
  if not coalesce((v_result->>'ok')::boolean, false) then
    return v_result;
  end if;

  update public.ticket_management_requests
     set request_type = v_request_type
   where id = (v_result->>'requestId')::uuid;

  return v_result || jsonb_build_object('requestType', v_request_type);
end;
$$;

revoke all on function public.create_ticket_management_request_v3(
  uuid, text, text, text, text, integer[], text, text
) from public, anon, authenticated;
grant execute on function public.create_ticket_management_request_v3(
  uuid, text, text, text, text, integer[], text, text
) to service_role;

comment on function public.create_ticket_management_request_v3(
  uuid, text, text, text, text, integer[], text, text
) is
  'Creates an owner-authorized request and rejects a second open request for the same booking and Refund, Reissue, or VOID action; exact request-key retries remain idempotent.';
