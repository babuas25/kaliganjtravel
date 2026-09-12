-- Keep the public lifecycle to the agreed seven stages:
-- Requested -> In Progress -> Quotation -> Approved | Rejected | Expired.
-- A successful wallet/ticket settlement is an immutable audit event and final
-- outcome of Approved; it must not move the request into a separate Completed
-- stage.

alter table public.ticket_management_requests
  drop constraint ticket_management_requests_terminal_state_check,
  drop constraint ticket_management_requests_action_outcome_check,
  drop constraint ticket_management_requests_status_timestamps_check;

alter table public.ticket_management_requests
  add constraint ticket_management_requests_terminal_state_check
    check (
      (status in ('approved', 'completed') and terminal_outcome in ('refunded', 'reissued', 'voided'))
      or (status = 'rejected' and terminal_outcome in ('staff-rejected', 'customer-rejected'))
      or (status = 'expired' and terminal_outcome = 'confirmation-expired')
      or (
        status in ('requested', 'in-progress', 'awaiting-confirmation', 'approved', 'completed')
        and terminal_outcome is null
      )
    ),
  add constraint ticket_management_requests_action_outcome_check
    check (
      terminal_outcome is null
      or (action = 'refund' and terminal_outcome = 'refunded')
      or (action = 'reissue' and terminal_outcome = 'reissued')
      or (action = 'void' and terminal_outcome = 'voided')
      or terminal_outcome in ('staff-rejected', 'customer-rejected', 'confirmation-expired')
    ),
  add constraint ticket_management_requests_status_timestamps_check
    check (
      (terminal_outcome not in ('refunded', 'reissued', 'voided') or completed_at is not null)
      and (status <> 'rejected' or rejected_at is not null)
      and (status <> 'expired' or expired_at is not null)
    );

-- Normalize historical settlements without changing their immutable completion
-- records, ledger entries, amounts, or event timestamps.
update public.ticket_management_requests
   set status = 'approved'
 where status = 'completed'
   and terminal_outcome in ('refunded', 'reissued', 'voided');

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
  v_result jsonb;
begin
  v_prepared := public.ticket_management_prepare_direct_settlement_v1(
    p_request_id, p_actor_user_id, p_expected_version, p_request_key
  );
  if not coalesce((v_prepared->>'ok')::boolean, false) then return v_prepared; end if;
  v_result := public.complete_ticket_management_refund_v1(
    p_request_id, p_actor_user_id,
    (v_prepared->>'settlementVersion')::integer,
    p_request_key, p_note
  );
  if not coalesce((v_result->>'ok')::boolean, false) then return v_result; end if;
  update public.ticket_management_requests
     set status = 'approved'
   where id = p_request_id
     and status = 'completed'
     and terminal_outcome = 'refunded';
  return v_result || jsonb_build_object('status', 'approved');
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
  v_result jsonb;
begin
  v_prepared := public.ticket_management_prepare_direct_settlement_v1(
    p_request_id, p_actor_user_id, p_expected_version, p_request_key
  );
  if not coalesce((v_prepared->>'ok')::boolean, false) then return v_prepared; end if;
  v_result := public.complete_ticket_management_reissue_v1(
    p_request_id, p_actor_user_id,
    (v_prepared->>'settlementVersion')::integer,
    p_request_key, p_new_tickets, p_note
  );
  if not coalesce((v_result->>'ok')::boolean, false) then return v_result; end if;
  update public.ticket_management_requests
     set status = 'approved'
   where id = p_request_id
     and status = 'completed'
     and terminal_outcome = 'reissued';
  return v_result || jsonb_build_object('status', 'approved');
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
  v_result jsonb;
begin
  v_prepared := public.ticket_management_prepare_direct_settlement_v1(
    p_request_id, p_actor_user_id, p_expected_version, p_request_key
  );
  if not coalesce((v_prepared->>'ok')::boolean, false) then return v_prepared; end if;
  v_result := public.complete_ticket_management_void_v1(
    p_request_id, p_actor_user_id,
    (v_prepared->>'settlementVersion')::integer,
    p_request_key, p_note
  );
  if not coalesce((v_result->>'ok')::boolean, false) then return v_result; end if;
  update public.ticket_management_requests
     set status = 'approved'
   where id = p_request_id
     and status = 'completed'
     and terminal_outcome = 'voided';
  return v_result || jsonb_build_object('status', 'approved');
end;
$$;

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
revoke all on function public.complete_ticket_management_void_v2(
  uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.complete_ticket_management_void_v2(
  uuid, text, integer, text, text
) to service_role;

comment on column public.ticket_management_requests.completed_at is
  'Timestamp at which the approved financial settlement was recorded. The request remains in Approved status.';
