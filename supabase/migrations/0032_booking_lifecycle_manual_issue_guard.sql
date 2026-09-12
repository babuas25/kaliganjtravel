-- Align the manual-issue RPC signature with the application call and remove
-- the accidental three-argument overload introduced by migration 0031.

drop function if exists public.wallet_finalize_manual_issue(uuid,text,jsonb);

create or replace function public.wallet_finalize_manual_issue(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_supplier_outcome jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v_booking public.flight_bookings;
begin
  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id and not legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  if v_booking.status = 'confirmed' and v_booking.issued_at is not null then
    return jsonb_build_object('ok', true, 'replay', true);
  end if;
  if v_booking.status <> 'in-progress'
     or v_booking.payment_state <> 'captured'
     or v_booking.operation_kind <> 'ticketing'
     or v_booking.operation_reason <> 'legacy_reconciliation' then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_MANUALLY_ISSUABLE');
  end if;
  if nullif(trim(p_supplier_outcome->>'ticketCodeRef'), '') is null
     or not public.jsonb_is_nonempty_array(p_supplier_outcome->'ticketNumbers') then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_INCOMPLETE');
  end if;

  update public.flight_bookings
     set status = 'confirmed',
         issued_by_user_id = p_actor_user_id,
         issued_at = now(),
         pnr = coalesce(nullif(trim(p_supplier_outcome->>'pnr'), ''), pnr),
         booking_status = coalesce(
           nullif(trim(p_supplier_outcome->>'bookingStatus'), ''), 'Confirmed'
         ),
         ticket_code_ref = nullif(trim(p_supplier_outcome->>'ticketCodeRef'), ''),
         ticket_numbers = p_supplier_outcome->'ticketNumbers',
         warnings = case
           when jsonb_typeof(p_supplier_outcome->'warnings') = 'array'
             then p_supplier_outcome->'warnings'
           else warnings
         end,
         supplier_message = nullif(trim(p_supplier_outcome->>'message'), ''),
         operation_kind = null,
         operation_reason = null,
         operation_request_id = null,
         operation_actor_user_id = null,
         operation_started_at = null,
         operation_prior_status = null
   where id = p_booking_id;

  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation, supplier_evidence
  ) values (
    p_booking_id, 'in-progress', 'confirmed', 'in-progress', 'confirmed',
    'ticketing', 'legacy_reconciliation', p_actor_user_id, 'NewTicket',
    jsonb_build_object(
      'actorRole', p_actor_role,
      'ticketCodeRef', p_supplier_outcome->>'ticketCodeRef',
      'ticketNumbers', p_supplier_outcome->'ticketNumbers'
    )
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.wallet_finalize_manual_issue(uuid,text,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.wallet_finalize_manual_issue(uuid,text,text,jsonb)
  to service_role;

comment on function public.wallet_finalize_manual_issue(uuid,text,text,jsonb) is
  'Finalizes a guarded legacy manual ticket claim with complete supplier evidence.';
