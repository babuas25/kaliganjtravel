-- Supplier-approved Search -> Reprice -> Book -> NewTicket flow, including
-- delayed issue from stored references. No automatic PNR lookup is required.
-- Existing confirmations, known deadlines, wallet ownership, operation claims,
-- and uncertain-write reconciliation remain authoritative.

create or replace function public.booking_uses_saved_references(p_booking public.flight_bookings)
returns boolean
language sql immutable set search_path = public
as $$
  select coalesce(
    p_booking.supplier = 'triplover'
    and p_booking.supplier_account in ('firsttrip', 'takeoff', 'triplover')
    and p_booking.import_source is null
    and not p_booking.legacy_operational,
    false
  );
$$;
revoke all on function public.booking_uses_saved_references(public.flight_bookings)
  from public, anon, authenticated;
grant execute on function public.booking_uses_saved_references(public.flight_bookings)
  to service_role;

-- Keep the trigger callable by older deployments, but enqueue no new reads.
create or replace function public.enqueue_booking_pnr_refresh_job_v1()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  return new;
end;
$$;

-- Retire work queued by earlier deployments without changing booking status,
-- supplier evidence, notifications, or wallet balances.
update public.booking_pnr_refresh_jobs
   set state = 'skipped', completed_at = clock_timestamp(),
       completion_reason = 'stored_reference_ticketing',
       claimed_at = null, claimed_by = null
 where state in ('pending', 'running');

create or replace function public.claim_booking_deadline_read_v1(p_booking_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_budget public.booking_deadline_read_budgets;
  v_token uuid;
begin
  select * into v_booking from public.flight_bookings where id = p_booking_id;
  if not found or public.booking_uses_saved_references(v_booking)
     or v_booking.ticketing_deadline_at is not null
     or v_booking.legacy_operational
     or v_booking.supplier is distinct from 'triplover' or v_booking.import_source = 'MANUAL'
     or v_booking.status not in ('on-hold', 'pending')
     or v_booking.operation_kind is not null then
    return jsonb_build_object('claimed', false, 'complete', true);
  end if;
  insert into public.booking_deadline_read_budgets(booking_id, attempt_count, next_attempt_at)
    values (p_booking_id, coalesce((
      select job.attempt_count from public.booking_pnr_refresh_jobs job
      where job.booking_id = p_booking_id
    ), 0), v_booking.created_at + interval '5 seconds')
    on conflict (booking_id) do nothing;
  select * into v_budget from public.booking_deadline_read_budgets
    where booking_id = p_booking_id for update;
  if v_budget.complete then
    return jsonb_build_object('claimed', false, 'complete', true);
  end if;
  if v_budget.lease_until > clock_timestamp() then
    return jsonb_build_object('claimed', false, 'complete', false);
  end if;
  if v_budget.attempt_count >= 3 then
    update public.booking_deadline_read_budgets set complete = true,
      claim_token = null, lease_until = null, updated_at = clock_timestamp()
      where booking_id = p_booking_id;
    return jsonb_build_object('claimed', false, 'complete', true);
  end if;
  if v_budget.next_attempt_at > clock_timestamp() then
    return jsonb_build_object('claimed', false, 'complete', false);
  end if;
  v_token := gen_random_uuid();
  update public.booking_deadline_read_budgets
    set attempt_count = attempt_count + 1, claim_token = v_token,
        lease_until = clock_timestamp() + interval '3 minutes',
        next_attempt_at = clock_timestamp() + interval '5 seconds',
        updated_at = clock_timestamp()
    where booking_id = p_booking_id;
  return jsonb_build_object('claimed', true, 'complete', false, 'claimToken', v_token);
end;
$$;


create or replace function public.wallet_begin_booking_issue(
  p_booking_id uuid,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_amount bigint;
  v_result jsonb;
  v_saved_reference_flow boolean;
begin
  if p_actor_role = 'staff_support' then
    return jsonb_build_object('ok', false, 'code', 'ISSUE_FORBIDDEN');
  end if;
  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id and not legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  if v_booking.status = 'confirmed' or v_booking.payment_state = 'captured' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CAPTURED');
  end if;
  if v_booking.status <> 'on-hold' or v_booking.operation_kind is not null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_ISSUABLE');
  end if;
  if not public.jsonb_is_nonempty_array(v_booking.airlines_pnr) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_UNCONFIRMED');
  end if;
  v_saved_reference_flow := public.booking_uses_saved_references(v_booking);
  if v_saved_reference_flow and (
    coalesce(nullif(btrim(v_booking.booking_ref_number), ''), nullif(btrim(v_booking.pnr), '')) is null
    or nullif(btrim(v_booking.booking_code_ref), '') is null
    or nullif(btrim(v_booking.supplier_refs->>'uniqueTransId'), '') is null
    or nullif(btrim(v_booking.supplier_refs->>'itemCodeRef'), '') is null
    or nullif(btrim(v_booking.supplier_refs->>'priceCodeRef'), '') is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'SUPPLIER_REFERENCES_MISSING');
  end if;
  -- Absence of a supplier deadline is not an unlimited or locally invented
  -- hold. NewTicket decides availability; known/approved deadlines still apply.
  if v_booking.ticketing_deadline_at is null and (
    not v_saved_reference_flow
    or v_booking.active_local_time_limit_request_id is not null
    or v_booking.active_superadmin_deadline_override_id is not null
  ) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_DEADLINE_REQUIRED');
  end if;
  if v_booking.ticketing_deadline_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_EXPIRED');
  end if;
  if v_booking.booking_owner_type is null or v_booking.booking_owner_key is null then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_OWNER_REQUIRED');
  end if;
  begin
    v_amount := round(
      (v_booking.pricing_snapshot->>'sellingPrice')::numeric * 100
    )::bigint;
  exception when others then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
  end;
  v_result := public.wallet_reserve_amount(
    v_booking.id, null,
    v_booking.booking_owner_type, v_booking.booking_owner_key,
    v_amount, v_booking.currency,
    p_actor_user_id, p_actor_role,
    p_idempotency_key, v_booking.public_ref
  );
  if coalesce((v_result->>'ok')::boolean, false) is not true then
    return v_result;
  end if;
  update public.flight_bookings
     set status = 'in-progress',
         operation_kind = 'ticketing',
         operation_reason = 'ticketing',
         operation_request_id = p_idempotency_key,
         operation_actor_user_id = p_actor_user_id,
         operation_started_at = now(),
         operation_prior_status = 'on-hold'
   where id = v_booking.id;
  insert into public.booking_status_events (
    booking_id, from_lifecycle_status, to_lifecycle_status,
    stored_status_before, stored_status_after, operation_kind,
    operation_reason, actor_user_id, supplier_operation, idempotency_key,
    supplier_evidence
  ) values (
    v_booking.id, 'on-hold', 'in-progress', 'on-hold', 'in-progress',
    'ticketing', 'ticketing', p_actor_user_id, 'NewTicket',
    p_idempotency_key || ':ticketing-start',
    jsonb_build_object(
      'actorRole', p_actor_role,
      'walletOwnerType', v_booking.booking_owner_type,
      'walletOwnerKey', v_booking.booking_owner_key,
      'staffIssuedForOwner', p_actor_role in ('superadmin', 'admin')
    )
  ) on conflict do nothing;
  return v_result || jsonb_build_object(
    'status', 'in-progress',
    'walletOwnerType', v_booking.booking_owner_type,
    'walletOwnerKey', v_booking.booking_owner_key,
    'staffIssuedForOwner', p_actor_role in ('superadmin', 'admin')
  );
end;
$$;


create or replace function public.create_booking_from_attempt(
  p_attempt_id uuid,
  p_outcome jsonb
)
returns public.flight_bookings
language plpgsql
as $$
declare
  v_attempt public.booking_attempts;
  v_offer jsonb;
  v_booking public.flight_bookings;
  v_status text;
  v_pnr text;
  v_booking_code_ref text;
  v_ticket_code_ref text;
  v_ttl text;
  v_deadline timestamptz;
  v_refs jsonb;
begin
  -- Lock by id first, then decide whether this is a new finalization or an
  -- idempotent replay. A concurrent replay waits here until the first call has
  -- either committed or rolled back.
  select * into v_attempt
    from public.booking_attempts
   where id = p_attempt_id
   for update;

  if not found then
    raise exception 'booking attempt % does not exist', p_attempt_id
      using errcode = 'P0002';
  end if;

  select * into v_booking
    from public.flight_bookings
   where attempt_id = p_attempt_id
     and not legacy_operational;

  if found then
    if v_attempt.state = 'submitting' then
      update public.booking_attempts
         set state = 'succeeded',
             pnr = coalesce(v_attempt.pnr, v_booking.pnr),
             booking_code_ref = coalesce(
               v_attempt.booking_code_ref,
               v_booking.booking_code_ref
             ),
             resolved_at = coalesce(v_attempt.resolved_at, now())
       where id = p_attempt_id;
    elsif v_attempt.state <> 'succeeded' then
      raise exception 'booking attempt % conflicts with an existing booking',
        p_attempt_id using errcode = '23514';
    end if;
    return v_booking;
  end if;

  if v_attempt.state <> 'submitting' then
    raise exception 'booking attempt % is not awaiting an outcome', p_attempt_id
      using errcode = 'P0002';
  end if;

  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object' then
    raise exception 'supplier outcome must be a JSON object'
      using errcode = '22023';
  end if;

  v_status := nullif(trim(p_outcome->>'status'), '');
  v_pnr := nullif(trim(p_outcome->>'pnr'), '');
  v_booking_code_ref := nullif(trim(p_outcome->>'bookingCodeRef'), '');
  v_ticket_code_ref := nullif(trim(p_outcome->>'ticketCodeRef'), '');
  v_ttl := nullif(trim(p_outcome->>'ticketingTimeLimit'), '');

  if v_status is null or v_status not in ('held', 'ticketed') then
    raise exception 'supplier outcome has invalid status %', v_status
      using errcode = '22023';
  end if;
  if v_pnr is null then
    raise exception 'supplier outcome has no PNR' using errcode = '22023';
  end if;
  if v_booking_code_ref is null then
    raise exception 'supplier outcome has no bookingCodeRef'
      using errcode = '22023';
  end if;
  if v_status = 'ticketed' and v_ticket_code_ref is null then
    raise exception 'ticketed supplier outcome has no ticketCodeRef'
      using errcode = '22023';
  end if;
  if nullif(trim(v_attempt.unique_trans_id), '') is null
     or nullif(trim(v_attempt.item_code_ref), '') is null
     or nullif(trim(v_attempt.price_code_ref), '') is null then
    raise exception 'booking attempt is missing required supplier references'
      using errcode = '22023';
  end if;
  if p_outcome ? 'airlinesPnr'
     and jsonb_typeof(p_outcome->'airlinesPnr') <> 'array' then
    raise exception 'supplier outcome airlinesPnr must be an array'
      using errcode = '22023';
  end if;
  if p_outcome ? 'ticketNumbers'
     and jsonb_typeof(p_outcome->'ticketNumbers') <> 'array' then
    raise exception 'supplier outcome ticketNumbers must be an array'
      using errcode = '22023';
  end if;
  if p_outcome ? 'warnings'
     and jsonb_typeof(p_outcome->'warnings') <> 'array' then
    raise exception 'supplier outcome warnings must be an array'
      using errcode = '22023';
  end if;

  -- New adapters preserve Book's echoed tokens. Older application versions
  -- may omit supplierRefs during a rolling deployment, so keep their inputs.
  if p_outcome ? 'supplierRefs' and jsonb_typeof(p_outcome->'supplierRefs') <> 'object' then
    raise exception 'supplier outcome references must be an object' using errcode = '22023';
  end if;
  v_refs := jsonb_build_object(
    'uniqueTransId', v_attempt.unique_trans_id,
    'itemCodeRef', v_attempt.item_code_ref,
    'priceCodeRef', v_attempt.price_code_ref
  ) || coalesce(p_outcome->'supplierRefs', '{}'::jsonb);
  if jsonb_typeof(v_refs->'uniqueTransId') <> 'string'
     or jsonb_typeof(v_refs->'itemCodeRef') <> 'string'
     or jsonb_typeof(v_refs->'priceCodeRef') <> 'string'
     or nullif(btrim(v_refs->>'uniqueTransId'), '') is null
     or nullif(btrim(v_refs->>'itemCodeRef'), '') is null
     or nullif(btrim(v_refs->>'priceCodeRef'), '') is null
     or v_refs->>'uniqueTransId' is distinct from v_attempt.unique_trans_id then
    raise exception 'supplier outcome contains invalid or conflicting references' using errcode = '22023';
  end if;

  -- A missing/unparseable deadline must not discard a successful Book.
  -- Keep the raw value for support and leave the deadline unknown, without
  -- inventing a hold duration or replaying the supplier booking write.
  begin
    v_deadline := public.parse_triplover_booking_deadline(v_ttl);
  exception when datetime_field_overflow or invalid_datetime_format then
    v_deadline := null;
  end;

  v_offer := v_attempt.offer_snapshot;

  insert into public.flight_bookings (
    id, public_ref, attempt_id, supplier, user_id, audience, agency_code,
    search_id, itinerary_id, status, currency, pricing_snapshot,
    passenger_counts, travel_date, direct_ticketing, itinerary, fares,
    passport_required, supplier_refs, repriced_at, accepted_at, passengers,
    pnr, airlines_pnr, booking_ref_number, booking_status, ticketing_time_limit,
    ticketing_deadline_at, deadline_source, booking_code_ref, ticket_code_ref,
    ticket_numbers, warnings, supplier_message, issued_at,
    submission_started_at, legacy_operational
  )
  values (
    gen_random_uuid(),
    public.allocate_booking_ref(),
    v_attempt.id,
    v_attempt.supplier,
    v_attempt.user_id,
    v_attempt.audience,
    v_attempt.agency_code,
    v_attempt.search_id,
    v_attempt.itinerary_id,
    case when v_status = 'ticketed' then 'confirmed' else 'on-hold' end,
    v_offer->>'currency',
    v_offer->'pricing',
    v_offer->'passengerCounts',
    (v_offer->>'travelDate')::date,
    coalesce((v_offer->>'directTicketing')::boolean, false),
    nullif(v_offer->'itinerary', 'null'::jsonb),
    coalesce(nullif(v_offer->'fares', 'null'::jsonb), '[]'::jsonb),
    coalesce((v_offer->>'passportRequired')::boolean, true),
    v_refs,
    (v_offer->>'repricedAt')::timestamptz,
    v_attempt.created_at,
    v_attempt.passenger_snapshot,
    v_pnr,
    coalesce(p_outcome->'airlinesPnr', '[]'::jsonb),
    p_outcome->>'bookingRefNumber',
    p_outcome->>'bookingStatus',
    v_ttl,
    v_deadline,
    case when v_deadline is not null then 'supplier' else null end,
    v_booking_code_ref,
    v_ticket_code_ref,
    coalesce(p_outcome->'ticketNumbers', '[]'::jsonb),
    coalesce(p_outcome->'warnings', '[]'::jsonb),
    p_outcome->>'message',
    case when v_status = 'ticketed' then now() end,
    coalesce(v_attempt.submitted_at, now()),
    false
  )
  returning * into v_booking;

  update public.booking_attempts
     set state = 'succeeded',
         pnr = v_pnr,
         booking_code_ref = v_booking_code_ref,
         supplier_message = p_outcome->>'message',
         warnings = coalesce(p_outcome->'warnings', '[]'::jsonb),
         resolved_at = now()
   where id = p_attempt_id;

  return v_booking;
end;
$$;


comment on function public.wallet_begin_booking_issue(uuid, text, text, text) is
  'Claims held booking ticketing against the owner wallet. Normal API bookings may issue without a supplied deadline; known deadlines, confirmation and duplicate-write guards still apply.';
