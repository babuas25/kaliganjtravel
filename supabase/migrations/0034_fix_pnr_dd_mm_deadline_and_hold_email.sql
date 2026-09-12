-- Triplover PNR lastTicketTime is DD/MM/YYYY. Migration 0030 documented the
-- opposite and the application normalized 07/08/2026 as 8 July. Correct the
-- one booking backed by the operator-provided supplier document, retain the
-- original event, and append an explicit correction event.
--
-- This migration never calls the supplier and never touches wallet state.

alter table public.flight_bookings
  add column if not exists on_hold_email_claimed_at timestamptz,
  add column if not exists on_hold_email_sent_at timestamptz;

create or replace function public.claim_on_hold_booking_email(p_booking_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
begin
  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id
     and not legacy_operational
   for update;

  if not found
     or v_booking.on_hold_email_sent_at is not null
     or public.resolve_booking_lifecycle(
       v_booking.status,
       v_booking.airlines_pnr,
       v_booking.ticketing_deadline_at,
       v_booking.operation_kind
     ) <> 'on-hold'
     or (
       v_booking.on_hold_email_claimed_at is not null
       and v_booking.on_hold_email_claimed_at > now() - interval '15 minutes'
     ) then
    return false;
  end if;

  update public.flight_bookings
     set on_hold_email_claimed_at = now()
   where id = v_booking.id;
  return true;
end;
$$;

create or replace function public.mark_on_hold_booking_email_sent(p_booking_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.flight_bookings
     set on_hold_email_sent_at = now()
   where id = p_booking_id
     and on_hold_email_claimed_at is not null
     and on_hold_email_sent_at is null;
$$;

create or replace function public.release_on_hold_booking_email_claim(p_booking_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.flight_bookings
     set on_hold_email_claimed_at = null
   where id = p_booking_id
     and on_hold_email_sent_at is null;
$$;

revoke all on function public.claim_on_hold_booking_email(uuid),
  public.mark_on_hold_booking_email_sent(uuid),
  public.release_on_hold_booking_email_claim(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_on_hold_booking_email(uuid),
  public.mark_on_hold_booking_email_sent(uuid),
  public.release_on_hold_booking_email_claim(uuid)
  to service_role;

comment on function public.claim_on_hold_booking_email(uuid) is
  'Row-locking, lease-based claim for one ON HOLD email per authoritative held booking.';

do $$
declare
  v_booking public.flight_bookings;
  v_event_id bigint;
begin
  select * into v_booking
    from public.flight_bookings
   where public_ref = 'STR260807000001'
     and not legacy_operational
   for update;

  if not found then
    raise exception '0034 expected booking STR260807000001 was not found';
  end if;

  if v_booking.status = 'on-hold'
     and v_booking.operation_kind is null
     and v_booking.deadline_source = 'pnr_call'
     and v_booking.ticketing_time_limit = '2026-07-08 18:32:00'
     and v_booking.ticketing_deadline_at = timestamptz '2026-07-08 12:32:00+00' then
    update public.flight_bookings
       set ticketing_time_limit = '2026-08-07 18:32:00',
           ticketing_deadline_at = timestamptz '2026-08-07 12:32:00+00'
     where id = v_booking.id;

    insert into public.booking_status_events (
      booking_id,
      from_lifecycle_status,
      to_lifecycle_status,
      stored_status_before,
      stored_status_after,
      operation_kind,
      operation_reason,
      actor_user_id,
      supplier_operation,
      supplier_evidence,
      idempotency_key
    ) values (
      v_booking.id,
      'expired',
      'on-hold',
      v_booking.status,
      v_booking.status,
      v_booking.operation_kind,
      v_booking.operation_reason,
      'migration:0034',
      'VerifiedDeadlineCorrection',
      jsonb_build_object(
        'verificationMethod', 'operator_supplied_supplier_document',
        'supplierDisplayedDeadline', '07/08/2026 18:32:00',
        'supplierDateOrder', 'DD/MM/YYYY',
        'previousDeadlineAt', v_booking.ticketing_deadline_at,
        'correctedDeadlineAt', timestamptz '2026-08-07 12:32:00+00',
        'supplierApiCalled', false,
        'walletMutation', false
      ),
      'migration-0034-pnr-dd-mm-STR260807000001'
    )
    on conflict (booking_id, idempotency_key, to_lifecycle_status)
      where idempotency_key is not null
    do nothing
    returning id into v_event_id;

    if public.resolve_booking_lifecycle(
      v_booking.status,
      v_booking.airlines_pnr,
      timestamptz '2026-08-07 12:32:00+00',
      v_booking.operation_kind
    ) <> 'on-hold' then
      raise exception '0034 corrected booking does not resolve to on-hold';
    end if;

    insert into public.security_audit_events (
      actor_user_id,
      actor_role,
      action,
      target_type,
      target_id,
      outcome,
      metadata
    ) values (
      'migration:0034',
      'system',
      'booking.verified_deadline_corrected',
      'booking',
      v_booking.id::text,
      'succeeded',
      jsonb_build_object(
        'publicRef', v_booking.public_ref,
        'statusEventId', v_event_id,
        'supplierApiCalled', false,
        'walletMutation', false
      )
    );
  elsif v_booking.status = 'on-hold'
        and v_booking.operation_kind is null
        and v_booking.deadline_source = 'pnr_call'
        and v_booking.ticketing_time_limit = '2026-08-07 18:32:00'
        and v_booking.ticketing_deadline_at = timestamptz '2026-08-07 12:32:00+00'
        and exists (
          select 1
            from public.booking_status_events event
           where event.booking_id = v_booking.id
             and event.idempotency_key = 'migration-0034-pnr-dd-mm-STR260807000001'
             and event.to_lifecycle_status = 'on-hold'
        ) then
    null;
  else
    raise exception '0034 refused unexpected state for STR260807000001';
  end if;
end;
$$;
