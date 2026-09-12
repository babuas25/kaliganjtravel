-- Persist the Voluntary/Involuntary classification for every Ticket
-- Management request. Historical requests predate this field, so they retain
-- the safe default of voluntary rather than being inferred from free text.

alter table public.ticket_management_requests
  add column request_type text not null default 'voluntary'
    check (request_type in ('voluntary', 'involuntary'));

create index ticket_management_requests_action_type_status_idx
  on public.ticket_management_requests(action, request_type, status, created_at desc, id);

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
begin
  if v_request_type not in ('voluntary', 'involuntary') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST_TYPE');
  end if;

  v_result := public.create_ticket_management_request_v2(
    p_booking_id, p_action, p_actor_user_id, p_request_key,
    p_request_payload_hash, p_passenger_indexes, p_note
  );
  if not coalesce((v_result->>'ok')::boolean, false) then
    return v_result;
  end if;

  -- The v2 creation path performs all owner, entitlement, and idempotency
  -- checks. This update runs in the same transaction and writes the selected
  -- category before the request becomes visible to readers.
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

comment on column public.ticket_management_requests.request_type is
  'Customer-declared Ticket Management category: voluntary or involuntary. Historical records default to voluntary and are not inferred from notes.';
comment on function public.create_ticket_management_request_v3(
  uuid, text, text, text, text, integer[], text, text
) is
  'Creates an owner-authorized Ticket Management request with a persisted Voluntary/Involuntary category.';
