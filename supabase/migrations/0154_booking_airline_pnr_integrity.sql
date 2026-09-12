-- A PNR lookup can echo only the GDS/reservation reference even when Book
-- returned a distinct airline locator. Protect that known value only on this
-- refresh path; ticket reports and explicit corrections remain authoritative.
create or replace function public.booking_airline_pnrs_after_refresh_v1(
  p_current jsonb, p_incoming jsonb, p_pnr text, p_booking_ref text
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
begin
  if not public.jsonb_is_nonempty_array(p_incoming) then
    return p_current;
  end if;
  if public.jsonb_is_nonempty_array(p_current)
     and not exists (
       select 1 from jsonb_array_elements_text(p_incoming) locator(value)
       where upper(btrim(locator.value)) <> all (array[
         upper(btrim(coalesce(p_pnr, ''))), upper(btrim(coalesce(p_booking_ref, '')))
       ])
     )
     and exists (
       select 1 from jsonb_array_elements_text(p_current) locator(value)
       where nullif(btrim(locator.value), '') is not null
         and upper(btrim(locator.value)) <> all (array[
           upper(btrim(coalesce(p_pnr, ''))), upper(btrim(coalesce(p_booking_ref, '')))
         ])
     ) then
    return p_current;
  end if;
  return p_incoming;
end;
$$;
revoke all on function public.booking_airline_pnrs_after_refresh_v1(jsonb,jsonb,text,text)
  from public, anon, authenticated;
grant execute on function public.booking_airline_pnrs_after_refresh_v1(jsonb,jsonb,text,text)
  to service_role;

create or replace function public.record_booking_pnr_refresh_v2(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_sync_source text,
  p_supplier_status text,
  p_airlines_pnr jsonb,
  p_ticketing_time_limit text,
  p_ticketing_deadline_at timestamptz,
  p_normalized_evidence jsonb
)
returns public.flight_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.flight_bookings;
  v_after public.flight_bookings;
  v_target text;
  v_case_type text;
  v_conflict boolean;
  v_terminal boolean;
  v_transitional boolean;
  v_overlap_operation_id uuid;
  v_before_lifecycle text;
  v_after_lifecycle text;
  v_facts jsonb;
begin
  if nullif(btrim(p_actor_user_id), '') is null
     or p_actor_role not in (
       'superadmin', 'admin', 'staff_support', 'staff_account',
       'customer', 'b2b', 'b2b_sub', 'system'
     )
     or p_sync_source not in (
       'ordinary_sync', 'cancellation_verification', 'compatibility_sync'
     ) then
    raise exception 'invalid PNR refresh actor' using errcode = '22023';
  end if;

  select booking.* into v_before
    from public.flight_bookings booking
   where booking.id = p_booking_id and not booking.legacy_operational
   for update;
  if not found then raise exception 'booking not found' using errcode = 'P0002'; end if;

  v_target := case lower(btrim(coalesce(p_supplier_status, '')))
    when 'issued' then 'confirmed'
    when 'confirmed' then 'confirmed'
    when 'cancelled' then 'cancelled'
    when 'canceled' then 'cancelled'
    when 'booked' then 'on-hold'
    when 'created' then 'on-hold'
    when 'held' then 'on-hold'
    else null
  end;
  v_overlap_operation_id := case when v_target = 'on-hold'
    then public.booking_ticketing_observation_overlap_v1(
      p_booking_id, coalesce(p_normalized_evidence, '{}'::jsonb)
    ) else null end;
  v_transitional := v_overlap_operation_id is not null;
  v_terminal := v_before.status in ('confirmed', 'cancelled');
  v_conflict := case
    when v_transitional then false
    when v_terminal then v_target is distinct from v_before.status
    when p_sync_source = 'cancellation_verification'
      and v_before.status = 'in-progress' and v_target = 'on-hold' then false
    else v_target in ('confirmed', 'cancelled')
      or (v_target is not null and v_target <> v_before.status)
  end;
  v_before_lifecycle := public.resolve_booking_lifecycle(
    v_before.status, v_before.airlines_pnr,
    v_before.ticketing_deadline_at, v_before.operation_kind
  );
  v_facts := jsonb_build_object(
    'version', 2,
    'action', 'ordinary_supplier_sync',
    'source', 'pnr',
    'syncSource', p_sync_source,
    'bookingId', p_booking_id,
    'localStoredStatus', v_before.status,
    'localLifecycleStatus', v_before_lifecycle,
    'supplierStatus', p_supplier_status,
    'candidateLifecycleStatus', v_target,
    'protectedTerminal', v_terminal,
    'ticketingOperationOverlap', v_transitional,
    'overlapOperationId', v_overlap_operation_id,
    'statusMutation', false,
    'walletMutation', false,
    'evidence', coalesce(p_normalized_evidence, '{}'::jsonb)
  );

  if v_conflict then
    update public.flight_bookings
       set synced_at = clock_timestamp(), booking_status = p_supplier_status
     where id = p_booking_id returning * into v_after;
    v_case_type := case
      when v_terminal then 'terminal_conflict'
      when v_target = 'cancelled' then 'cancellation_uncertainty'
      else 'ticketing_uncertainty'
    end;
    perform public.record_booking_sync_case_v1(
      p_booking_id, v_case_type, 'pnr_sync_conflicts_with_local_truth',
      'Ordinary PNR Sync differs from local lifecycle truth and requires controlled resolution.',
      p_actor_user_id, p_actor_role,
      v_facts || jsonb_build_object('caseType', v_case_type)
    );
  else
    update public.flight_bookings
       set synced_at = clock_timestamp(),
           booking_status = case
             when v_transitional and v_terminal then booking_status
             else p_supplier_status
           end,
           airlines_pnr = public.booking_airline_pnrs_after_refresh_v1(
             airlines_pnr, p_airlines_pnr, pnr, booking_ref_number
           ),
           ticketing_time_limit = case
             when p_ticketing_deadline_at is not null and not (v_transitional and v_terminal)
               then p_ticketing_time_limit else ticketing_time_limit
           end,
           ticketing_deadline_at = case
             when v_transitional and v_terminal then ticketing_deadline_at
             else coalesce(p_ticketing_deadline_at, ticketing_deadline_at)
           end,
           deadline_source = case
             when p_ticketing_deadline_at is not null and not (v_transitional and v_terminal)
               then 'pnr_call' else deadline_source
           end
     where id = p_booking_id returning * into v_after;
  end if;

  v_after_lifecycle := public.resolve_booking_lifecycle(
    v_after.status, v_after.airlines_pnr,
    v_after.ticketing_deadline_at, v_after.operation_kind
  );
  if v_after_lifecycle is distinct from v_before_lifecycle then
    insert into public.booking_status_events (
      booking_id, from_lifecycle_status, to_lifecycle_status,
      stored_status_before, stored_status_after, operation_kind,
      operation_reason, actor_user_id, supplier_operation, supplier_evidence
    ) values (
      p_booking_id, v_before_lifecycle, v_after_lifecycle,
      v_before.status, v_after.status, v_after.operation_kind,
      v_after.operation_reason, p_actor_user_id, 'PnrRefreshV2',
      jsonb_build_object(
        'supplierStatus', p_supplier_status,
        'airlinesPnr', p_airlines_pnr,
        'ticketingDeadlineAt', p_ticketing_deadline_at,
        'ticketingOperationOverlap', v_transitional,
        'statusMutation', false, 'walletMutation', false
      )
    );
  end if;
  return v_after;
end;
$$;

-- Store matched report locators in the SAME update as confirmation, before
-- either email or SMS freezes its event-time snapshot. Financial guards and
-- replay behavior are unchanged.

create or replace function public.wallet_capture_reservation(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text,
  p_supplier_outcome jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_reservation public.wallet_reservations;
  v_account public.wallet_accounts;
  v_available_before bigint;
  v_hold_before bigint;
begin
  select * into v_booking from public.flight_bookings
   where id = p_booking_id and not legacy_operational for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND'); end if;

  select * into v_reservation from public.wallet_reservations
   where booking_id = p_booking_id
      or (booking_id is null and booking_attempt_id = v_booking.attempt_id)
   order by booking_id nulls last limit 1 for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'RESERVATION_NOT_FOUND'); end if;
  if v_reservation.state = 'captured' then
    return jsonb_build_object('ok', true, 'replay', true, 'reservationId', v_reservation.id);
  end if;
  if v_reservation.state = 'released' then
    return jsonb_build_object('ok', false, 'code', 'RESERVATION_RELEASED');
  end if;

  if nullif(trim(p_supplier_outcome->>'ticketCodeRef'), '') is null
     or not public.jsonb_is_nonempty_array(p_supplier_outcome->'ticketNumbers') then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_INCOMPLETE');
  end if;

  if not (
    (v_booking.status = 'in-progress'
      and v_booking.operation_kind in ('ticketing','reconciliation'))
    or
    (v_booking.status = 'confirmed' and v_booking.direct_ticketing
      and v_booking.issued_at is not null)
  ) then
    return jsonb_build_object('ok', false, 'code', 'ISSUE_OPERATION_NOT_ACTIVE');
  end if;

  select * into strict v_account from public.wallet_accounts
   where id = v_reservation.wallet_account_id for update;
  if v_account.hold_balance < v_reservation.amount then
    return jsonb_build_object('ok', false, 'code', 'HOLD_BALANCE_MISMATCH');
  end if;
  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;

  update public.wallet_accounts set hold_balance = hold_balance - v_reservation.amount
   where id = v_account.id;
  update public.wallet_reservations set
    booking_id = p_booking_id, booking_attempt_id = null, state = 'captured',
    issued_by_user_id = p_actor_user_id, captured_at = now(),
    reconciliation_at = null, reconciliation_reason = null
  where id = v_reservation.id;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, booking_reference, reservation_id, idempotency_key,
    created_by_user_id, created_by_role, remarks
  ) values (
    v_account.id, 'booking_confirm', v_reservation.amount, v_reservation.currency,
    v_available_before, v_available_before, v_hold_before,
    v_hold_before - v_reservation.amount, v_booking.id, v_booking.public_ref,
    v_reservation.id, p_idempotency_key || ':capture', p_actor_user_id,
    p_actor_role, 'Supplier confirmed ticket issuance'
  );
  update public.flight_bookings set
    charged_wallet_account_id = v_account.id, payment_state = 'captured',
    payment_amount = v_reservation.amount, captured_amount = v_reservation.amount,
    status = 'confirmed', issued_by_user_id = p_actor_user_id,
    issued_at = coalesce(issued_at, now()),
    pnr = coalesce(nullif(trim(p_supplier_outcome->>'pnr'), ''), pnr),
    airlines_pnr = case when public.jsonb_is_nonempty_array(p_supplier_outcome->'airlinesPnr')
      then p_supplier_outcome->'airlinesPnr' else airlines_pnr end,
    booking_status = coalesce(nullif(trim(p_supplier_outcome->>'bookingStatus'), ''), 'Confirmed'),
    ticket_code_ref = nullif(trim(p_supplier_outcome->>'ticketCodeRef'), ''),
    ticket_numbers = p_supplier_outcome->'ticketNumbers',
    warnings = case when jsonb_typeof(p_supplier_outcome->'warnings') = 'array'
      then p_supplier_outcome->'warnings' else warnings end,
    supplier_message = coalesce(nullif(trim(p_supplier_outcome->>'message'), ''), supplier_message),
    operation_kind = null, operation_reason = null, operation_request_id = null,
    operation_actor_user_id = null, operation_started_at = null,
    operation_prior_status = null
  where id = v_booking.id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation,
    supplier_evidence, idempotency_key
  ) values (
    v_booking.id,
    case when v_booking.status = 'confirmed' then 'confirmed' else 'in-progress' end,
    'confirmed', v_booking.status, 'confirmed', v_booking.operation_kind,
    v_booking.operation_reason, p_actor_user_id,
    case when v_booking.direct_ticketing then 'Book' else 'NewTicket' end,
    jsonb_build_object('ticketCodeRef', p_supplier_outcome->>'ticketCodeRef',
      'ticketNumbers', p_supplier_outcome->'ticketNumbers'),
    p_idempotency_key || ':confirmed'
  ) on conflict do nothing;
  return jsonb_build_object(
    'ok', true, 'reservationId', v_reservation.id,
    'availableBalance', v_available_before,
    'holdBalance', v_hold_before - v_reservation.amount
  );
end;
$$;

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
    airlines_pnr = case when public.jsonb_is_nonempty_array(p_supplier_outcome->'airlinesPnr')
      then p_supplier_outcome->'airlinesPnr' else airlines_pnr end,
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

create or replace function public.enqueue_booking_issued_sms_v1()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_booking public.flight_bookings;
  v_phone text;
  v_number text;
  v_state text := 'pending';
  v_suppression_reason text;
  v_pnr text;
  v_passenger_name text;
begin
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = new.booking_id;
  if not found then
    raise exception 'issued SMS booking not found' using errcode = '23503';
  end if;

  if v_booking.audience = 'agency' and v_booking.agency_code is not null then
    select regexp_replace(coalesce(profile.agency_mobile, ''), '[^0-9]', '', 'g')
      into v_phone
      from public.agencies agency
      join public.user_profiles profile
        on profile.clerk_id = agency.owner_user_id
     where agency.agency_code = v_booking.agency_code;
  end if;
  v_phone := coalesce(v_phone, '');

  if left(v_phone, 2) = '00' then
    v_number := substr(v_phone, 3);
  elsif left(v_phone, 3) = '880' then
    v_number := v_phone;
  elsif left(v_phone, 2) = '01' then
    v_number := '880' || substr(v_phone, 2);
  elsif char_length(v_phone) = 10 and left(v_phone, 1) = '1' then
    v_number := '880' || v_phone;
  else
    v_number := v_phone;
  end if;

  if coalesce(new.event_snapshot->>'notificationDisposition', '') = 'audit_only'
     or new.supplier_operation = 'MigrationBaseline' then
    v_state := 'suppressed';
    v_suppression_reason := 'historical_or_audit_only';
  elsif v_booking.audience <> 'agency' then
    v_state := 'suppressed';
    v_suppression_reason := 'b2b_partner_only';
  elsif v_booking.hidden_from_user then
    v_state := 'suppressed';
    v_suppression_reason := 'booking_hidden_from_user';
  elsif coalesce(v_number, '') !~ '^[1-9][0-9]{7,14}$' then
    v_state := 'suppressed';
    v_suppression_reason := 'missing_or_invalid_b2b_partner_phone';
  end if;

  select nullif(btrim(locator.value), '') into v_pnr
    from jsonb_array_elements_text(case
      when jsonb_typeof(v_booking.airlines_pnr) = 'array'
        then v_booking.airlines_pnr else '[]'::jsonb end)
      with ordinality as locator(value, ordinal)
    where nullif(btrim(locator.value), '') is not null
    order by locator.ordinal limit 1;
  v_pnr := coalesce(v_pnr, 'Not available');
  v_passenger_name := btrim(concat_ws(' ',
    nullif(btrim(v_booking.passengers #>> '{travellers,0,firstName}'), ''),
    nullif(btrim(v_booking.passengers #>> '{travellers,0,lastName}'), '')
  ));

  insert into public.booking_issued_sms_deliveries (
    lifecycle_event_id, booking_id, occurrence_id,
    recipient_number, recipient_number_hash, content_snapshot,
    state, suppression_reason, completed_at
  ) values (
    new.id, new.booking_id, new.occurrence_id,
    case when v_state = 'suppressed' then null else v_number end,
    case when v_state = 'suppressed' then null
      else encode(digest(v_number, 'sha256'), 'hex') end,
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'pnr', v_pnr,
      'pnrType', 'airline',
      'passengerName', v_passenger_name,
      'airlineCode', coalesce(v_booking.itinerary->>'carrierCode', ''),
      'airlineName', coalesce(v_booking.itinerary->>'carrierName', ''),
      'itinerary', coalesce(v_booking.itinerary, 'null'::jsonb),
      'currency', v_booking.currency,
      'grossAmount', v_booking.pricing_snapshot->'grossPrice'
    ),
    v_state, v_suppression_reason,
    case when v_state = 'suppressed' then clock_timestamp() else null end
  )
  on conflict (lifecycle_event_id) do nothing;
  return new;
end;
$$;
