-- Execute the imported manual-ticket SLA policy in bounded, concurrent-safe
-- batches. Escalation changes internal ownership only; it never invents
-- supplier truth, changes public booking status, or mutates financial rows.

create index if not exists booking_reconciliation_cases_impexp_escalation_idx
  on public.booking_reconciliation_cases (
    due_at, escalation_level, opened_at, subject_booking_id, id
  )
  where case_type = 'imported_manual_ticketing'
    and state in (
      'open', 'assigned', 'awaiting_supplier',
      'awaiting_finance', 'awaiting_approval'
    );

create or replace function public.process_impexp_manual_ticket_escalations_v1(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_candidate record;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_now timestamptz := clock_timestamp();
  v_action text;
  v_processed integer := 0;
  v_warned integer := 0;
  v_admin_escalated integer := 0;
  v_superadmin_escalated integer := 0;
  v_remaining integer := 0;
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ESCALATION_LIMIT');
  end if;

  for v_candidate in
    select
      booking.id as booking_id,
      operation.id as operation_id,
      reconciliation_case.id as case_id
    from public.booking_reconciliation_cases reconciliation_case
    join public.booking_operations operation
      on operation.id = reconciliation_case.operation_id
    join public.flight_bookings booking
      on booking.id = reconciliation_case.subject_booking_id
     and booking.active_operation_id = operation.id
   where reconciliation_case.case_type = 'imported_manual_ticketing'
     and reconciliation_case.state in (
       'open', 'assigned', 'awaiting_supplier',
       'awaiting_finance', 'awaiting_approval'
     )
     and operation.kind = 'imported_manual_ticketing'
     and operation.state in ('awaiting_external_action', 'needs_reconciliation')
     and booking.import_source = 'IMP_EXP'
     and booking.status = 'in-progress'
     and (
       (reconciliation_case.due_at is not null
         and reconciliation_case.escalation_level < 2
         and v_now >= reconciliation_case.due_at + interval '60 minutes')
       or (reconciliation_case.due_at is not null
         and reconciliation_case.escalation_level < 1
         and v_now >= reconciliation_case.due_at)
       or (reconciliation_case.escalation_level = 0
         and reconciliation_case.assignee_user_id is null
         and v_now >= reconciliation_case.opened_at + interval '30 minutes'
         and reconciliation_case.escalation_reason
           is distinct from 'manual_ticket_unassigned_warning')
     )
   order by
     coalesce(reconciliation_case.due_at, reconciliation_case.opened_at),
     reconciliation_case.id
   limit p_limit
   for update of booking skip locked
  loop
    -- The candidate query already owns the booking serialization root. Lock
    -- the remaining mutable rows in global booking -> operation -> case order.
    select operation.* into v_operation
      from public.booking_operations operation
     where operation.id = v_candidate.operation_id
       and operation.booking_id = v_candidate.booking_id
     for update;
    if not found then
      continue;
    end if;
    select reconciliation_case.* into v_case
      from public.booking_reconciliation_cases reconciliation_case
     where reconciliation_case.id = v_candidate.case_id
       and reconciliation_case.subject_booking_id = v_candidate.booking_id
       and reconciliation_case.operation_id = v_operation.id
     for update;
    if not found
       or v_case.state not in (
         'open', 'assigned', 'awaiting_supplier',
         'awaiting_finance', 'awaiting_approval'
       )
       or v_operation.kind <> 'imported_manual_ticketing'
       or v_operation.state not in (
         'awaiting_external_action', 'needs_reconciliation'
       ) then
      continue;
    end if;

    v_action := null;
    if v_case.due_at is not null
       and v_case.escalation_level < 2
       and v_now >= v_case.due_at + interval '60 minutes' then
      v_action := 'superadmin';
    elsif v_case.due_at is not null
       and v_case.escalation_level < 1
       and v_now >= v_case.due_at then
      v_action := 'admin';
    elsif v_case.escalation_level = 0
       and v_case.assignee_user_id is null
       and v_now >= v_case.opened_at + interval '30 minutes'
       and v_case.escalation_reason
         is distinct from 'manual_ticket_unassigned_warning' then
      v_action := 'warning';
    end if;
    if v_action is null then
      continue;
    end if;

    if v_action = 'warning' then
      update public.booking_reconciliation_cases
         set priority = greatest(priority, 60),
             escalation_reason = 'manual_ticket_unassigned_warning',
             escalated_at = v_now,
             evidence = evidence || jsonb_build_array(jsonb_build_object(
               'type', 'manual_ticket_sla_escalation',
               'level', 0,
               'reason', 'manual_ticket_unassigned_warning',
               'recordedAt', v_now,
               'publicStatusMutation', false,
               'walletMutation', false
             )),
             version = version + 1
       where id = v_case.id;
      v_warned := v_warned + 1;
    else
      update public.booking_operations
         set state = 'needs_reconciliation',
             reason_code = case
               when state = 'awaiting_external_action'
                 then 'imported_manual_ticketing_overdue'
               else reason_code
             end,
             reason_detail = case
               when state = 'awaiting_external_action'
                 then 'Manual ticketing exceeded its external-action SLA and requires explicit reconciliation.'
               else reason_detail
             end,
             reconciliation_required_at = coalesce(
               reconciliation_required_at, v_now
             ),
             error_code = case
               when state = 'awaiting_external_action'
                 then 'IMPEXP_MANUAL_TICKETING_OVERDUE'
               else error_code
             end,
             error_message = case
               when state = 'awaiting_external_action'
                 then 'External manual ticketing exceeded its due time.'
               else error_message
             end,
             supplier_evidence = supplier_evidence || jsonb_build_object(
               'lastSlaEscalation', jsonb_build_object(
                 'level', case when v_action = 'superadmin' then 2 else 1 end,
                 'reason', case when v_action = 'superadmin'
                   then 'manual_ticket_superadmin_escalation'
                   else 'manual_ticket_admin_escalation' end,
                 'escalatedAt', v_now,
                 'supplierTruthInferred', false,
                 'publicStatusMutation', false,
                 'walletMutation', false
               )
             )
       where id = v_operation.id;

      update public.booking_reconciliation_cases
         set state = case
               when state in ('awaiting_finance', 'awaiting_approval')
                 then state
               else 'assigned'
             end,
             reason_code = case
               when state in ('awaiting_finance', 'awaiting_approval')
                 then reason_code
               else 'imported_manual_ticketing_overdue'
             end,
             reason_detail = case
               when state in ('awaiting_finance', 'awaiting_approval')
                 then reason_detail
               else 'Manual ticketing exceeded its SLA; Admin reconciliation is required.'
             end,
             assigned_team = 'admin',
             assignee_user_id = null,
             assigned_at = v_now,
             severity = 'critical',
             priority = case when v_action = 'superadmin' then 100
               else greatest(priority, 90) end,
             escalation_level = case when v_action = 'superadmin' then 2 else 1 end,
             escalation_reason = case when v_action = 'superadmin'
               then 'manual_ticket_superadmin_escalation'
               else 'manual_ticket_admin_escalation' end,
             escalated_at = v_now,
             evidence = evidence || jsonb_build_array(jsonb_build_object(
               'type', 'manual_ticket_sla_escalation',
               'level', case when v_action = 'superadmin' then 2 else 1 end,
               'reason', case when v_action = 'superadmin'
                 then 'manual_ticket_superadmin_escalation'
                 else 'manual_ticket_admin_escalation' end,
               'dueAt', v_case.due_at,
               'overdueSeconds', greatest(
                 0, extract(epoch from (v_now - v_case.due_at))::integer
               ),
               'supplierTruthInferred', false,
               'financialDisposition', v_case.financial_disposition,
               'publicStatusMutation', false,
               'walletMutation', false,
               'recordedAt', v_now
             )),
             version = version + 1
       where id = v_case.id;
      if v_action = 'superadmin' then
        v_superadmin_escalated := v_superadmin_escalated + 1;
      else
        v_admin_escalated := v_admin_escalated + 1;
      end if;
    end if;
    v_processed := v_processed + 1;
  end loop;

  select count(*)::integer into v_remaining
    from public.booking_reconciliation_cases reconciliation_case
    join public.booking_operations operation
      on operation.id = reconciliation_case.operation_id
    join public.flight_bookings booking
      on booking.id = reconciliation_case.subject_booking_id
     and booking.active_operation_id = operation.id
   where reconciliation_case.case_type = 'imported_manual_ticketing'
     and reconciliation_case.state in (
       'open', 'assigned', 'awaiting_supplier',
       'awaiting_finance', 'awaiting_approval'
     )
     and operation.kind = 'imported_manual_ticketing'
     and operation.state in ('awaiting_external_action', 'needs_reconciliation')
     and booking.status = 'in-progress'
     and (
       (reconciliation_case.due_at is not null
         and reconciliation_case.escalation_level < 2
         and v_now >= reconciliation_case.due_at + interval '60 minutes')
       or (reconciliation_case.due_at is not null
         and reconciliation_case.escalation_level < 1
         and v_now >= reconciliation_case.due_at)
       or (reconciliation_case.escalation_level = 0
         and reconciliation_case.assignee_user_id is null
         and v_now >= reconciliation_case.opened_at + interval '30 minutes'
         and reconciliation_case.escalation_reason
           is distinct from 'manual_ticket_unassigned_warning')
     );

  return jsonb_build_object(
    'ok', true,
    'processed', v_processed,
    'unassignedWarnings', v_warned,
    'adminEscalations', v_admin_escalated,
    'superadminEscalations', v_superadmin_escalated,
    'remainingEligible', v_remaining,
    'limit', p_limit,
    'publicStatusMutation', false,
    'walletMutation', false,
    'supplierTruthInferred', false
  );
end;
$$;

revoke all on function public.process_impexp_manual_ticket_escalations_v1(integer)
  from public, anon, authenticated;
grant execute on function public.process_impexp_manual_ticket_escalations_v1(integer)
  to service_role;

comment on function public.process_impexp_manual_ticket_escalations_v1(integer) is
  'Processes a bounded imported manual-ticket SLA batch: unassigned warning at 30 minutes, Admin reconciliation at due time, and level-2 Super Admin attention after 60 overdue minutes. Never changes booking status, supplier truth, or money.';
