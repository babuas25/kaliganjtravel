-- Idempotent internal observability backfill and staff-only read model.
--
-- This migration creates no customer notification, performs no supplier call,
-- and changes no existing booking, lifecycle, payment, wallet, reservation, or
-- ledger row. Ambiguous history becomes a case in later statements instead of
-- being invented as an operation.

-- 1. Backfill only operations whose compatibility metadata identifies the
-- action unambiguously.
with candidates as (
  select
    fb.id as booking_id,
    case
      when fb.operation_reason = 'imported_manual_ticketing'
        then 'imported_manual_ticketing'
      when fb.operation_kind = 'cancellation'
        or fb.operation_reason = 'cancellation_reconciliation'
        then 'cancellation'
      else 'ticketing'
    end as kind,
    case
      when fb.operation_reason = 'imported_manual_ticketing'
        then 'awaiting_external_action'
      when fb.operation_kind = 'reconciliation'
        or coalesce(fb.operation_started_at, fb.updated_at, fb.created_at)
          <= now() - interval '3 minutes'
        then 'needs_reconciliation'
      else 'claimed'
    end as state,
    fb.operation_reason as reason_code,
    'Backfilled from authoritative compatibility operation metadata.'::text
      as reason_detail,
    'backfill:0044:operation:' || fb.id::text as request_key,
    fb.id::text || ':' || fb.operation_kind || ':' ||
      fb.operation_reason || ':v1' as payload_seed,
    coalesce(
      nullif(btrim(fb.operation_actor_user_id), ''),
      'system:backfill-0044'
    ) as actor_user_id,
    fb.operation_prior_status,
    case
      when fb.operation_prior_status is null then null
      else public.resolve_booking_lifecycle(
        fb.operation_prior_status,
        fb.airlines_pnr,
        fb.ticketing_deadline_at,
        null
      )
    end as prior_lifecycle_status,
    fb.supplier,
    case
      when fb.operation_reason = 'imported_manual_ticketing'
        then 'ManualTicketing'
      when fb.operation_kind = 'cancellation'
        or fb.operation_reason = 'cancellation_reconciliation'
        then 'Cancel'
      when fb.direct_ticketing then 'Book'
      else 'NewTicket'
    end as supplier_operation,
    nullif(btrim(fb.supplier_refs->>'uniqueTransId'), '')
      as supplier_unique_trans_id,
    fb.booking_code_ref as supplier_booking_code_ref,
    fb.pnr as supplier_pnr,
    jsonb_build_object(
      'backfillVersion', 1,
      'source', 'flight_bookings.operation_*',
      'legacyOperationKind', fb.operation_kind,
      'legacyOperationReason', fb.operation_reason,
      'supplierCallStartedAtKnown', false
    ) as supplier_evidence,
    coalesce(fb.operation_started_at, fb.updated_at, fb.created_at)
      as claimed_at,
    case
      when fb.operation_reason = 'imported_manual_ticketing' then least(
        coalesce(fb.operation_started_at, fb.updated_at, fb.created_at)
          + interval '2 hours',
        fb.ticketing_deadline_at - interval '1 hour'
      )
      else null
    end as external_action_due_at,
    case
      when fb.operation_kind = 'reconciliation'
        or coalesce(fb.operation_started_at, fb.updated_at, fb.created_at)
          <= now() - interval '3 minutes'
        then coalesce(fb.operation_started_at, fb.updated_at, fb.created_at)
      else null
    end as reconciliation_required_at
  from public.booking_lifecycle_v fb
  where fb.operation_reason is not null
    and (
      fb.operation_kind in ('ticketing', 'cancellation')
      or (
        fb.operation_kind = 'reconciliation'
        and fb.operation_reason in (
          'ticketing_reconciliation',
          'cancellation_reconciliation'
        )
      )
    )
)
insert into public.booking_operations (
  booking_id,
  kind,
  state,
  reason_code,
  reason_detail,
  request_key,
  request_payload_hash,
  actor_user_id,
  actor_role,
  source,
  prior_stored_status,
  prior_lifecycle_status,
  supplier,
  supplier_operation,
  supplier_unique_trans_id,
  supplier_booking_code_ref,
  supplier_pnr,
  supplier_evidence,
  policy_version,
  claimed_at,
  supplier_call_started_at,
  external_action_due_at,
  reconciliation_required_at
)
select
  booking_id,
  kind,
  state,
  reason_code,
  reason_detail,
  request_key,
  md5(payload_seed) || md5('second:' || payload_seed),
  actor_user_id,
  'backfill',
  'backfill',
  operation_prior_status,
  prior_lifecycle_status,
  supplier,
  supplier_operation,
  supplier_unique_trans_id,
  supplier_booking_code_ref,
  supplier_pnr,
  supplier_evidence,
  1,
  claimed_at,
  null,
  external_action_due_at,
  reconciliation_required_at
from candidates
on conflict (request_key) do nothing;

-- 2. Give every backfilled unresolved operation an owned case. No evidence is
-- fabricated: the evidence entry records only the source link and classifier.
insert into public.booking_reconciliation_cases (
  subject_booking_id,
  operation_id,
  case_type,
  state,
  reason_code,
  reason_detail,
  opened_source,
  opened_by_user_id,
  opened_by_role,
  opened_at,
  assigned_team,
  severity,
  priority,
  due_at,
  evidence,
  policy_version
)
select
  operation.booking_id,
  operation.id,
  case
    when operation.kind = 'cancellation' then 'cancellation_uncertainty'
    when operation.kind = 'imported_manual_ticketing'
      then 'imported_manual_ticketing'
    else 'ticketing_uncertainty'
  end,
  'open',
  operation.reason_code,
  'Backfilled unresolved operation requires controlled staff resolution.',
  'backfill',
  'system:backfill-0044',
  'backfill',
  now(),
  'support',
  'high',
  case when operation.kind = 'imported_manual_ticketing' then 30 else 20 end,
  case
    when operation.kind = 'imported_manual_ticketing'
      then coalesce(operation.external_action_due_at, now() + interval '2 hours')
    else now() + interval '30 minutes'
  end,
  jsonb_build_array(jsonb_build_object(
    'type', 'backfill_operation_link',
    'operationId', operation.id,
    'operationState', operation.state,
    'supplierEvidenceInvented', false
  )),
  1
from public.booking_operations operation
where operation.state in (
  'needs_reconciliation', 'awaiting_external_action'
)
on conflict do nothing;

-- 3. Compatibility reconciliation metadata whose original action is not
-- certain becomes a case without an invented operation row.
insert into public.booking_reconciliation_cases (
  subject_booking_id,
  case_type,
  state,
  reason_code,
  reason_detail,
  opened_source,
  opened_by_user_id,
  opened_by_role,
  opened_at,
  assigned_team,
  severity,
  priority,
  due_at,
  evidence,
  policy_version
)
select
  booking.id,
  case booking.operation_reason
    when 'legacy_reconciliation' then 'legacy_review'
    when 'terminal_state_conflict' then 'terminal_conflict'
    when 'direct_ticket_payment_reconciliation'
      then 'direct_ticket_payment_failure'
    when 'cancellation_reconciliation' then 'cancellation_uncertainty'
    else 'ticketing_uncertainty'
  end,
  'open',
  booking.operation_reason,
  'Compatibility metadata is insufficient to reconstruct a trustworthy operation.',
  'backfill',
  'system:backfill-0044',
  'backfill',
  now(),
  case
    when booking.operation_reason in (
      'legacy_reconciliation',
      'terminal_state_conflict',
      'direct_ticket_payment_reconciliation'
    ) then 'admin'
    else 'support'
  end,
  case
    when booking.operation_reason in (
      'terminal_state_conflict',
      'direct_ticket_payment_reconciliation'
    ) then 'critical'
    else 'high'
  end,
  case
    when booking.operation_reason in (
      'terminal_state_conflict',
      'direct_ticket_payment_reconciliation'
    ) then 0
    when booking.operation_reason = 'legacy_reconciliation' then 40
    else 20
  end,
  case
    when booking.operation_reason in (
      'terminal_state_conflict',
      'direct_ticket_payment_reconciliation'
    ) then now() + interval '1 hour'
    when booking.operation_reason = 'legacy_reconciliation'
      then now() + interval '1 day'
    else now() + interval '30 minutes'
  end,
  jsonb_build_array(jsonb_build_object(
    'type', 'compatibility_metadata',
    'legacyOperationKind', booking.operation_kind,
    'legacyOperationReason', booking.operation_reason,
    'operationReconstructed', false,
    'supplierEvidenceInvented', false
  )),
  1
from public.booking_lifecycle_v booking
where booking.operation_kind = 'reconciliation'
  and booking.operation_reason is not null
  and not exists (
    select 1
    from public.booking_operations operation
    where operation.booking_id = booking.id
      and operation.state in (
        'claimed', 'supplier_call_started', 'awaiting_external_action',
        'needs_reconciliation'
      )
  )
on conflict do nothing;

-- 4. Attempts are operational subjects, not public bookings. Aged uncertainty
-- is visible to Support without creating a business booking or public status.
insert into public.booking_reconciliation_cases (
  subject_booking_attempt_id,
  case_type,
  state,
  reason_code,
  reason_detail,
  opened_source,
  opened_by_user_id,
  opened_by_role,
  opened_at,
  assigned_team,
  severity,
  priority,
  due_at,
  evidence,
  policy_version
)
select
  attempt.id,
  'attempt_uncertainty',
  'open',
  case
    when attempt.state = 'unknown' then 'unknown_supplier_outcome'
    else 'aged_submitting_attempt'
  end,
  'Supplier-submitted attempt has no controlled local resolution.',
  'backfill',
  'system:backfill-0044',
  'backfill',
  now(),
  'support',
  'high',
  10,
  now() + interval '15 minutes',
  jsonb_build_array(jsonb_build_object(
    'type', 'attempt_state',
    'state', attempt.state,
    'submittedAt', attempt.submitted_at,
    'resolvedAt', attempt.resolved_at,
    'supplierEvidenceInvented', false
  )),
  1
from public.booking_attempts attempt
where attempt.state in ('submitting', 'unknown')
  and coalesce(attempt.submitted_at, attempt.updated_at)
    <= now() - interval '15 minutes'
on conflict do nothing;

-- 5. Objective lifecycle/financial contradictions become owned cases only;
-- this backfill never chooses their final status or financial disposition.
insert into public.booking_reconciliation_cases (
  subject_booking_id, case_type, state, reason_code, reason_detail,
  opened_source, opened_by_user_id, opened_by_role, opened_at,
  assigned_team, severity, priority, due_at, evidence, policy_version
)
select
  booking.id,
  'historical_inconsistency',
  'open',
  'cancelled_missing_authoritative_timestamp',
  'Cancelled booking has no authoritative cancellation timestamp.',
  'backfill', 'system:backfill-0044', 'backfill', now(),
  'admin', 'medium', 50, now() + interval '1 day',
  jsonb_build_array(jsonb_build_object(
    'type', 'objective_invariant',
    'storedStatus', booking.status,
    'cancelledAtPresent', false,
    'supplierEvidenceInvented', false
  )),
  1
from public.booking_lifecycle_v booking
where booking.status = 'cancelled'
  and booking.cancelled_at is null
on conflict do nothing;

insert into public.booking_reconciliation_cases (
  subject_booking_id, case_type, state, reason_code, reason_detail,
  opened_source, opened_by_user_id, opened_by_role, opened_at,
  assigned_team, severity, priority, due_at, evidence, policy_version
)
select
  booking.id,
  'terminal_conflict',
  'open',
  'cancelled_with_outstanding_captured_funds',
  'Cancelled booking retains captured funds without a complete refund disposition.',
  'backfill', 'system:backfill-0044', 'backfill', now(),
  'admin', 'critical', 0, now() + interval '1 hour',
  jsonb_build_array(jsonb_build_object(
    'type', 'objective_financial_invariant',
    'paymentState', booking.payment_state,
    'capturedAmount', booking.captured_amount,
    'refundedAmount', booking.refunded_amount,
    'financialDispositionChosen', false,
    'supplierEvidenceInvented', false
  )),
  1
from public.booking_lifecycle_v booking
where booking.status = 'cancelled'
  and booking.captured_amount > booking.refunded_amount
on conflict do nothing;

insert into public.booking_reconciliation_cases (
  subject_booking_id, case_type, state, reason_code, reason_detail,
  opened_source, opened_by_user_id, opened_by_role, opened_at,
  assigned_team, severity, priority, due_at, evidence, policy_version
)
select
  booking.id,
  case
    when booking.import_source = 'IMP_EXP' then 'imported_payment_conflict'
    else 'direct_ticket_payment_failure'
  end,
  'open',
  case
    when booking.import_source = 'IMP_EXP' then 'imported_confirmed_unpaid'
    else 'confirmed_without_captured_payment'
  end,
  'Confirmed ticket truth has no matching captured or externally settled payment.',
  'backfill', 'system:backfill-0044', 'backfill', now(),
  case when booking.import_source = 'IMP_EXP' then 'accounts' else 'admin' end,
  'critical', 0, now() + interval '1 hour',
  jsonb_build_array(jsonb_build_object(
    'type', 'objective_financial_invariant',
    'importSource', booking.import_source,
    'paymentState', booking.payment_state,
    'capturedAmount', booking.captured_amount,
    'financialDispositionChosen', false,
    'supplierEvidenceInvented', false
  )),
  1
from public.booking_lifecycle_v booking
where booking.status = 'confirmed'
  and booking.payment_state = 'unpaid'
on conflict do nothing;

-- 6. Staff-only lifecycle truth. Deliberately excludes passenger/contact data,
-- raw supplier evidence, proposal bodies, and recipient addresses.
create or replace view public.booking_lifecycle_staff_v
with (security_invoker = true)
as
select
  booking.id as booking_id,
  booking.public_ref,
  booking.supplier,
  booking.import_source,
  booking.status as stored_status,
  booking.lifecycle_status,
  booking.created_at as booked_at,
  booking.updated_at as booking_updated_at,
  booking.ticketing_deadline_at,
  booking.issued_at,
  booking.cancelled_at,
  booking.payment_state,
  booking.payment_amount,
  booking.captured_amount,
  booking.refunded_amount,
  booking.currency,
  booking.operation_kind as compatibility_operation_kind,
  booking.operation_reason as compatibility_operation_reason,
  booking.operation_started_at as compatibility_operation_started_at,
  internal_booking.active_operation_id,
  operation.id as operation_id,
  operation.kind as operation_kind,
  operation.state as operation_state,
  operation.reason_code as operation_reason_code,
  operation.reason_detail as operation_reason_detail,
  operation.source as operation_source,
  operation.actor_user_id as operation_actor_user_id,
  operation.actor_role as operation_actor_role,
  operation.claimed_at as operation_claimed_at,
  operation.supplier_call_started_at,
  operation.supplier_response_received_at,
  operation.external_action_due_at,
  operation.reconciliation_required_at,
  operation.completed_at as operation_completed_at,
  case
    when operation.claimed_at is null then null
    else greatest(
      0,
      extract(epoch from (coalesce(operation.completed_at, now())
        - operation.claimed_at))::bigint
    )
  end as operation_elapsed_seconds,
  (
    internal_booking.active_operation_id is not null
    and internal_booking.active_operation_id is distinct from operation.id
  ) as operation_pointer_mismatch,
  reservation.id as reservation_id,
  reservation.state as reservation_state,
  reservation.amount as reservation_amount,
  reservation.currency as reservation_currency,
  reservation.supplier_call_started_at as reservation_supplier_call_started_at,
  reservation.reconciliation_at as reservation_reconciliation_at,
  reservation.reconciliation_reason as reservation_reconciliation_reason,
  primary_case.id as primary_case_id,
  primary_case.case_type as primary_case_type,
  primary_case.state as primary_case_state,
  primary_case.reason_code as primary_case_reason_code,
  primary_case.reason_detail as primary_case_reason_detail,
  primary_case.assigned_team as primary_case_assigned_team,
  primary_case.assignee_user_id as primary_case_assignee_user_id,
  primary_case.severity as primary_case_severity,
  primary_case.priority as primary_case_priority,
  primary_case.due_at as primary_case_due_at,
  primary_case.escalation_level as primary_case_escalation_level,
  primary_case.evidence_latest_at as primary_case_evidence_latest_at,
  case
    when primary_case.evidence_latest_at is null then false
    else primary_case.evidence_latest_at >= now() - interval '5 minutes'
  end as primary_case_evidence_is_fresh,
  primary_case.financial_disposition,
  primary_case.version as primary_case_version,
  coalesce(primary_case.open_case_count, 0)::integer as open_case_count,
  (
    primary_case.due_at is not null
    and primary_case.due_at <= now()
  ) as case_sla_breached,
  case
    when booking.status = 'confirmed' and booking.payment_state = 'unpaid'
      then 'confirmed_unpaid'
    when booking.status = 'cancelled'
      and booking.captured_amount > booking.refunded_amount
      then 'cancelled_outstanding_capture'
    when booking.payment_state = 'held'
      and coalesce(reservation.state, 'missing') <> 'active'
      then 'held_without_active_reservation'
    when reservation.state = 'reconciliation'
      then 'reservation_reconciliation'
    else null
  end as payment_conflict_code,
  (
    primary_case.case_type = 'terminal_conflict'
    or booking.operation_reason = 'terminal_state_conflict'
  ) as terminal_conflict_visible,
  (
    primary_case.id is not null
    or operation.state in (
      'needs_reconciliation', 'awaiting_external_action'
    )
    or (
      booking.status = 'confirmed' and booking.payment_state = 'unpaid'
    )
    or (
      booking.status = 'cancelled'
      and booking.captured_amount > booking.refunded_amount
    )
  ) as staff_attention_required
from public.booking_lifecycle_v booking
join public.flight_bookings internal_booking
  on internal_booking.id = booking.id
left join lateral (
  select candidate.*
  from public.booking_operations candidate
  where candidate.booking_id = booking.id
    and candidate.state in (
      'claimed', 'supplier_call_started', 'awaiting_external_action',
      'needs_reconciliation'
    )
  order by
    (candidate.id = internal_booking.active_operation_id) desc,
    candidate.claimed_at desc,
    candidate.id desc
  limit 1
) operation on true
left join public.wallet_reservations reservation
  on reservation.booking_id = booking.id
left join lateral (
  select candidate.*,
    count(*) over () as open_case_count
  from public.booking_reconciliation_cases candidate
  where candidate.subject_booking_id = booking.id
    and candidate.state in (
      'open', 'assigned', 'awaiting_supplier',
      'awaiting_finance', 'awaiting_approval'
    )
  order by
    candidate.priority,
    candidate.due_at nulls last,
    candidate.created_at,
    candidate.id
  limit 1
) primary_case on true;

revoke all on table public.booking_lifecycle_staff_v
  from public, anon, authenticated;
grant select on table public.booking_lifecycle_staff_v to service_role;

comment on view public.booking_lifecycle_staff_v is
  'Staff-only public lifecycle plus internal operation, primary open case, reservation, evidence freshness, SLA, and payment-conflict metadata. Contains no passenger/contact or raw evidence payload.';

-- 7. Bounded aggregate health signals for staff dashboards and alerts. The
-- thresholds match policy version 1: three minutes for a supplier operation,
-- fifteen minutes for an unresolved submission, and case-specific due_at for
-- all longer-running/manual work.
create or replace view public.booking_lifecycle_metrics_v
with (security_invoker = true)
as
with open_cases as (
  select candidate.*
  from public.booking_reconciliation_cases candidate
  where candidate.state in (
    'open', 'assigned', 'awaiting_supplier',
    'awaiting_finance', 'awaiting_approval'
  )
),
aged_operations as (
  select operation.*
  from public.booking_operations operation
  where (
    operation.state in ('claimed', 'supplier_call_started')
    and coalesce(
      operation.supplier_call_started_at,
      operation.claimed_at
    ) <= now() - interval '3 minutes'
  ) or (
    operation.state = 'awaiting_external_action'
    and operation.external_action_due_at is not null
    and operation.external_action_due_at <= now()
  ) or (
    operation.state = 'needs_reconciliation'
    and coalesce(
      operation.reconciliation_required_at,
      operation.claimed_at
    ) <= now() - interval '30 minutes'
  )
),
aged_attempts as (
  select attempt.*
  from public.booking_attempts attempt
  where attempt.state in ('submitting', 'unknown')
    and coalesce(attempt.submitted_at, attempt.created_at)
      <= now() - interval '15 minutes'
),
terminal_conflict_bookings as (
  select booking.id
  from public.booking_lifecycle_v booking
  where (
    booking.status = 'confirmed'
    and booking.payment_state = 'unpaid'
  ) or (
    booking.status = 'cancelled'
    and booking.captured_amount > booking.refunded_amount
  ) or exists (
    select 1
    from open_cases candidate
    where candidate.subject_booking_id = booking.id
      and candidate.case_type = 'terminal_conflict'
  )
),
wallet_inconsistent_bookings as (
  select staff.booking_id
  from public.booking_lifecycle_staff_v staff
  where staff.payment_conflict_code is not null
    or staff.reservation_state = 'reconciliation'
)
select
  now() as observed_at,
  (select count(*) from open_cases)::bigint as open_case_count,
  (select min(opened_at) from open_cases) as oldest_open_case_at,
  (select count(*) from aged_operations)::bigint as aged_operation_count,
  (select min(claimed_at) from aged_operations) as oldest_aged_operation_at,
  (select count(*) from aged_attempts)::bigint as aged_attempt_count,
  (
    select min(coalesce(submitted_at, created_at))
    from aged_attempts
  ) as oldest_aged_attempt_at,
  (
    select count(*) from open_cases where due_at <= now()
  )::bigint as sla_breach_count,
  (
    select min(due_at) from open_cases where due_at <= now()
  ) as oldest_sla_breach_at,
  (
    select count(distinct id) from terminal_conflict_bookings
  )::bigint as terminal_conflict_count,
  (
    select count(distinct booking_id) from wallet_inconsistent_bookings
  )::bigint as wallet_inconsistency_count;

revoke all on table public.booking_lifecycle_metrics_v
  from public, anon, authenticated;
grant select on table public.booking_lifecycle_metrics_v to service_role;

comment on view public.booking_lifecycle_metrics_v is
  'Staff-only aggregate lifecycle health metrics. Contains counts and oldest timestamps only; no booking, passenger, supplier-evidence, or financial amount detail.';
