-- Assigned Reissue completion and controlled failure/requotation.
--
-- A customer-approved additional payment is captured only after the manual
-- supplier/GDS operation succeeds. Only the fare-difference component becomes
-- additional future User Payable ticket entitlement; airline and ShopOnTravels
-- service fees remain separately audited and non-refundable by default.

drop index public.wallet_reservations_ticket_management_request_key;
create unique index wallet_reservations_ticket_management_active_request_key
  on public.wallet_reservations(ticket_management_request_id)
  where ticket_management_request_id is not null and state = 'active';

create table public.ticket_management_reissue_quote_terms (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.ticket_management_requests(id) on delete restrict,
  quote_id uuid not null unique
    references public.ticket_management_quotes(id) on delete restrict,
  allocation_hash text not null check (allocation_hash ~ '^[a-f0-9]{64}$'),
  fare_difference_amount bigint not null check (fare_difference_amount >= 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (request_id, allocation_hash)
);

create table public.ticket_management_reissue_quote_allocations (
  id uuid primary key default gen_random_uuid(),
  terms_id uuid not null
    references public.ticket_management_reissue_quote_terms(id) on delete restrict,
  request_id uuid not null
    references public.ticket_management_requests(id) on delete restrict,
  quote_id uuid not null
    references public.ticket_management_quotes(id) on delete restrict,
  entitlement_id uuid not null
    references public.ticket_management_ticket_entitlements(id) on delete restrict,
  passenger_index integer not null check (passenger_index >= 0),
  fare_difference_amount bigint not null check (fare_difference_amount >= 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (quote_id, entitlement_id),
  unique (quote_id, passenger_index)
);

create index ticket_management_reissue_quote_allocations_request_idx
  on public.ticket_management_reissue_quote_allocations(request_id, passenger_index, id);

create trigger ticket_management_reissue_quote_terms_deny_update_delete
  before update or delete on public.ticket_management_reissue_quote_terms
  for each row execute function public.prevent_ticket_management_audit_mutation_v1();
create trigger ticket_management_reissue_quote_allocations_deny_update_delete
  before update or delete on public.ticket_management_reissue_quote_allocations
  for each row execute function public.prevent_ticket_management_audit_mutation_v1();

create or replace function public.publish_ticket_management_reissue_quote_v1(
  p_request_id uuid,
  p_actor_user_id text,
  p_expected_version integer,
  p_request_key text,
  p_direction text,
  p_currency text,
  p_supplier_gross_amount bigint,
  p_supplier_payable_amount bigint,
  p_fare_difference bigint,
  p_airline_fee bigint,
  p_service_fee bigint,
  p_customer_amount bigint,
  p_confirmation_deadline_at timestamptz,
  p_fare_difference_allocations jsonb,
  p_details text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.ticket_management_requests;
  v_result jsonb;
  v_quote_id uuid;
  v_terms public.ticket_management_reissue_quote_terms;
  v_existing_terms public.ticket_management_reissue_quote_terms;
  v_normalized jsonb;
  v_allocation_hash text;
  v_count integer;
  v_selected_count integer;
  v_total bigint;
begin
  if p_fare_difference_allocations is null
     or jsonb_typeof(p_fare_difference_allocations) <> 'array'
     or jsonb_array_length(p_fare_difference_allocations) = 0 then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_FARE_ALLOCATION_REQUIRED');
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_fare_difference_allocations) item(value)
     where jsonb_typeof(item.value) <> 'object'
        or jsonb_typeof(item.value->'entitlementId') <> 'string'
        or (item.value->>'entitlementId')
             !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or jsonb_typeof(item.value->'fareDifferenceAmount') <> 'number'
        or (item.value->>'fareDifferenceAmount')::numeric < 0
        or (item.value->>'fareDifferenceAmount')::numeric
             <> trunc((item.value->>'fareDifferenceAmount')::numeric)
        or (item.value->>'fareDifferenceAmount')::numeric > 9223372036854775807
  ) then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_FARE_ALLOCATION_INVALID');
  end if;
  select jsonb_agg(jsonb_build_object(
      'entitlementId', lower(item.value->>'entitlementId'),
      'fareDifferenceAmount', (item.value->>'fareDifferenceAmount')::bigint
    ) order by lower(item.value->>'entitlementId')),
    count(*)::integer,
    sum((item.value->>'fareDifferenceAmount')::bigint)
    into v_normalized, v_count, v_total
    from jsonb_array_elements(p_fare_difference_allocations) item(value);
  if v_count <> (
      select count(distinct lower(item.value->>'entitlementId'))
        from jsonb_array_elements(p_fare_difference_allocations) item(value)
    ) or v_total <> p_fare_difference then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_FARE_ALLOCATION_TOTAL_MISMATCH');
  end if;
  v_allocation_hash := encode(sha256(convert_to(v_normalized::text, 'UTF8')), 'hex');

  select request.* into v_request
    from public.ticket_management_requests request
   where request.id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND'); end if;
  if v_request.action <> 'reissue' or v_request.status <> 'in-progress'
     or v_request.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_REQUEST_NOT_QUOTABLE',
      'version', v_request.version);
  end if;
  select count(*)::integer into v_selected_count
    from public.ticket_management_request_selections selection
   where selection.request_id = v_request.id;
  if v_selected_count <> v_count
     or exists (
       select 1
         from jsonb_to_recordset(v_normalized)
           as allocation("entitlementId" text, "fareDifferenceAmount" bigint)
         left join public.ticket_management_request_selections selection
           on selection.request_id = v_request.id
          and selection.entitlement_id = allocation."entitlementId"::uuid
        where selection.id is null
     ) then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_FARE_ALLOCATION_SELECTION_MISMATCH');
  end if;

  v_result := public.publish_ticket_management_quote_v1(
    p_request_id, p_actor_user_id, p_expected_version, p_request_key,
    p_direction, p_currency, p_supplier_gross_amount, p_supplier_payable_amount,
    0, p_fare_difference, p_airline_fee, 0, p_service_fee,
    p_customer_amount, p_confirmation_deadline_at, p_details
  );
  if not coalesce((v_result->>'ok')::boolean, false) then return v_result; end if;
  v_quote_id := (v_result->>'quoteId')::uuid;
  select terms.* into v_existing_terms
    from public.ticket_management_reissue_quote_terms terms
   where terms.quote_id = v_quote_id;
  if found then
    if v_existing_terms.request_id is distinct from p_request_id
       or v_existing_terms.allocation_hash is distinct from v_allocation_hash
       or v_existing_terms.fare_difference_amount <> p_fare_difference then
      return jsonb_build_object('ok', false, 'code', 'REISSUE_QUOTE_IDEMPOTENCY_CONFLICT');
    end if;
    return v_result || jsonb_build_object(
      'allocationHash', v_allocation_hash,
      'allocatedPassengerCount', v_count
    );
  end if;
  insert into public.ticket_management_reissue_quote_terms (
    request_id, quote_id, allocation_hash, fare_difference_amount
  ) values (
    p_request_id, v_quote_id, v_allocation_hash, p_fare_difference
  ) returning * into v_terms;
  insert into public.ticket_management_reissue_quote_allocations (
    terms_id, request_id, quote_id, entitlement_id,
    passenger_index, fare_difference_amount
  )
  select v_terms.id, p_request_id, v_quote_id, selection.entitlement_id,
         selection.passenger_index, allocation."fareDifferenceAmount"
    from jsonb_to_recordset(v_normalized)
      as allocation("entitlementId" text, "fareDifferenceAmount" bigint)
    join public.ticket_management_request_selections selection
      on selection.request_id = p_request_id
     and selection.entitlement_id = allocation."entitlementId"::uuid;
  return v_result || jsonb_build_object(
    'allocationHash', v_allocation_hash,
    'allocatedPassengerCount', v_count
  );
end;
$$;

create or replace function public.ticket_management_require_reissue_quote_terms_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action text;
  v_quote public.ticket_management_quotes;
  v_terms public.ticket_management_reissue_quote_terms;
  v_count integer;
  v_total bigint;
begin
  select request.action into strict v_action
    from public.ticket_management_requests request
   where request.id = new.request_id;
  if v_action <> 'reissue' or new.decision <> 'approved' then return new; end if;
  select quote.* into strict v_quote
    from public.ticket_management_quotes quote
   where quote.id = new.quote_id and quote.request_id = new.request_id;
  select terms.* into v_terms
    from public.ticket_management_reissue_quote_terms terms
   where terms.quote_id = new.quote_id;
  if not found then
    raise exception 'approved Reissue quote has no immutable passenger fare allocation'
      using errcode = '23514';
  end if;
  select count(*)::integer, coalesce(sum(allocation.fare_difference_amount), 0)
    into v_count, v_total
    from public.ticket_management_reissue_quote_allocations allocation
   where allocation.quote_id = new.quote_id;
  if v_count <> (
       select count(*) from public.ticket_management_request_selections selection
        where selection.request_id = new.request_id
     ) or v_total <> v_quote.fare_difference
     or v_total <> v_terms.fare_difference_amount then
    raise exception 'approved Reissue quote passenger fare allocation is incomplete'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger ticket_management_customer_decisions_require_reissue_terms
  before insert on public.ticket_management_customer_decisions
  for each row execute function public.ticket_management_require_reissue_quote_terms_v1();

create table public.ticket_management_reissue_completions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique
    references public.ticket_management_requests(id) on delete restrict,
  quote_id uuid not null unique
    references public.ticket_management_quotes(id) on delete restrict,
  request_key text not null unique
    check (char_length(request_key) between 1 and 180),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  reissue_allocation_hash text not null check (reissue_allocation_hash ~ '^[a-f0-9]{64}$'),
  supplier_gross_amount bigint not null check (supplier_gross_amount > 0),
  supplier_payable_amount bigint not null check (supplier_payable_amount > 0),
  carried_user_payable_amount bigint not null check (carried_user_payable_amount > 0),
  fare_difference_amount bigint not null check (fare_difference_amount >= 0),
  airline_fee_amount bigint not null check (airline_fee_amount >= 0),
  service_fee_amount bigint not null check (service_fee_amount >= 0),
  customer_amount_captured bigint not null check (customer_amount_captured >= 0),
  capture_ledger_entry_id uuid
    references public.wallet_ledger_entries(id) on delete restrict,
  finalized_by_user_id text not null,
  finalized_by_role text not null
    check (finalized_by_role in ('staff_account', 'admin', 'superadmin')),
  note text check (note is null or char_length(note) <= 2000),
  finalized_at timestamptz not null default clock_timestamp(),
  constraint ticket_management_reissue_completion_total_check
    check (
      customer_amount_captured
        = fare_difference_amount + airline_fee_amount + service_fee_amount
    ),
  constraint ticket_management_reissue_completion_capture_check
    check (
      (customer_amount_captured = 0 and capture_ledger_entry_id is null)
      or (customer_amount_captured > 0 and capture_ledger_entry_id is not null)
    )
);

create table public.ticket_management_reissue_lineages (
  id uuid primary key default gen_random_uuid(),
  completion_id uuid not null
    references public.ticket_management_reissue_completions(id) on delete restrict,
  request_id uuid not null
    references public.ticket_management_requests(id) on delete restrict,
  booking_id uuid not null
    references public.flight_bookings(id) on delete restrict,
  quote_id uuid not null
    references public.ticket_management_quotes(id) on delete restrict,
  predecessor_entitlement_id uuid not null unique
    references public.ticket_management_ticket_entitlements(id) on delete restrict,
  successor_entitlement_id uuid not null unique
    references public.ticket_management_ticket_entitlements(id) on delete restrict,
  passenger_index integer not null check (passenger_index >= 0),
  previous_ticket_number text not null
    check (char_length(btrim(previous_ticket_number)) between 1 and 80),
  new_ticket_number text not null
    check (char_length(btrim(new_ticket_number)) between 1 and 80),
  carried_user_payable_amount bigint not null check (carried_user_payable_amount > 0),
  fare_difference_amount bigint not null check (fare_difference_amount >= 0),
  successor_user_payable_entitlement_amount bigint not null
    check (successor_user_payable_entitlement_amount > 0),
  created_at timestamptz not null default clock_timestamp(),
  unique (request_id, passenger_index),
  unique (booking_id, new_ticket_number),
  constraint ticket_management_reissue_lineage_total_check
    check (
      successor_user_payable_entitlement_amount
        = carried_user_payable_amount + fare_difference_amount
    ),
  constraint ticket_management_reissue_lineage_ticket_change_check
    check (upper(btrim(previous_ticket_number)) <> upper(btrim(new_ticket_number)))
);

create index ticket_management_reissue_lineages_completion_idx
  on public.ticket_management_reissue_lineages(completion_id, passenger_index, id);
create index ticket_management_reissue_lineages_booking_idx
  on public.ticket_management_reissue_lineages(booking_id, passenger_index, id);

create trigger ticket_management_reissue_completions_deny_update_delete
  before update or delete on public.ticket_management_reissue_completions
  for each row execute function public.prevent_ticket_management_audit_mutation_v1();
create trigger ticket_management_reissue_lineages_deny_update_delete
  before update or delete on public.ticket_management_reissue_lineages
  for each row execute function public.prevent_ticket_management_audit_mutation_v1();

create or replace function public.complete_ticket_management_reissue_v1(
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
  v_actor_role text;
  v_request_hint public.ticket_management_requests;
  v_request public.ticket_management_requests;
  v_booking public.flight_bookings;
  v_quote public.ticket_management_quotes;
  v_reissue_terms public.ticket_management_reissue_quote_terms;
  v_existing public.ticket_management_reissue_completions;
  v_completion public.ticket_management_reissue_completions;
  v_entitlement public.ticket_management_ticket_entitlements;
  v_successor public.ticket_management_ticket_entitlements;
  v_capture_result jsonb;
  v_capture_ledger_id uuid;
  v_normalized_tickets jsonb;
  v_payload_hash text;
  v_mapping_count integer;
  v_selection_count integer;
  v_fare_difference_total bigint;
  v_carried_total bigint;
  v_ticket_numbers jsonb;
  v_item record;
  v_version integer;
begin
  if p_expected_version is null or p_expected_version < 1
     or nullif(btrim(p_request_key), '') is null
     or char_length(p_request_key) > 180
     or p_new_tickets is null
     or jsonb_typeof(p_new_tickets) <> 'array'
     or jsonb_array_length(p_new_tickets) = 0
     or (p_note is not null and char_length(p_note) > 2000) then
    raise exception 'invalid Reissue completion request' using errcode = '22023';
  end if;
  if exists (
    select 1
      from jsonb_array_elements(p_new_tickets) item(value)
     where jsonb_typeof(item.value) <> 'object'
        or jsonb_typeof(item.value->'predecessorEntitlementId') <> 'string'
        or (item.value->>'predecessorEntitlementId')
             !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or jsonb_typeof(item.value->'newTicketNumber') <> 'string'
        or nullif(btrim(item.value->>'newTicketNumber'), '') is null
        or char_length(btrim(item.value->>'newTicketNumber')) > 80
        or jsonb_typeof(item.value->'fareDifferenceAmount') <> 'number'
        or (item.value->>'fareDifferenceAmount')::numeric < 0
        or (item.value->>'fareDifferenceAmount')::numeric
             <> trunc((item.value->>'fareDifferenceAmount')::numeric)
        or (item.value->>'fareDifferenceAmount')::numeric > 9223372036854775807
  ) then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_TICKET_MAPPING_INVALID');
  end if;

  select jsonb_agg(jsonb_build_object(
      'predecessorEntitlementId', lower(item.value->>'predecessorEntitlementId'),
      'newTicketNumber', upper(btrim(item.value->>'newTicketNumber')),
      'fareDifferenceAmount', (item.value->>'fareDifferenceAmount')::bigint
    ) order by lower(item.value->>'predecessorEntitlementId')),
    count(*)::integer,
    sum((item.value->>'fareDifferenceAmount')::bigint)
    into v_normalized_tickets, v_mapping_count, v_fare_difference_total
    from jsonb_array_elements(p_new_tickets) item(value);
  if v_mapping_count <> (
      select count(distinct lower(item.value->>'predecessorEntitlementId'))
        from jsonb_array_elements(p_new_tickets) item(value)
    ) or v_mapping_count <> (
      select count(distinct upper(btrim(item.value->>'newTicketNumber')))
        from jsonb_array_elements(p_new_tickets) item(value)
    ) then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_TICKET_MAPPING_DUPLICATE');
  end if;
  v_payload_hash := encode(sha256(convert_to(jsonb_build_object(
    'requestId', p_request_id,
    'tickets', v_normalized_tickets,
    'note', nullif(btrim(p_note), '')
  )::text, 'UTF8')), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  select completion.* into v_existing
    from public.ticket_management_reissue_completions completion
   where completion.request_key = p_request_key
   for update;
  if found then
    if v_existing.request_id is distinct from p_request_id
       or v_existing.payload_hash is distinct from v_payload_hash
       or v_existing.finalized_by_user_id is distinct from p_actor_user_id then
      return jsonb_build_object('ok', false, 'code', 'REISSUE_COMPLETION_IDEMPOTENCY_CONFLICT');
    end if;
    select request.* into v_request from public.ticket_management_requests request
     where request.id = p_request_id;
    return jsonb_build_object('ok', true, 'replay', true,
      'requestId', p_request_id, 'completionId', v_existing.id,
      'status', v_request.status, 'version', v_request.version,
      'ledgerEntryId', v_existing.capture_ledger_entry_id);
  end if;
  select completion.* into v_existing
    from public.ticket_management_reissue_completions completion
   where completion.request_id = p_request_id;
  if found then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_ALREADY_COMPLETED');
  end if;

  select role into v_actor_role from public.app_users where clerk_id = p_actor_user_id;
  if v_actor_role not in ('staff_account', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'FINAL_SETTLEMENT_FORBIDDEN');
  end if;
  select request.* into v_request_hint from public.ticket_management_requests request
   where request.id = p_request_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND'); end if;
  select booking.* into v_booking from public.flight_bookings booking
   where booking.id = v_request_hint.booking_id for update;
  select request.* into v_request from public.ticket_management_requests request
   where request.id = p_request_id for update;
  if v_request.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_VERSION_CONFLICT',
      'version', v_request.version);
  end if;
  if v_request.action <> 'reissue' or v_request.status <> 'approved'
     or v_request.active_assignee_user_id is distinct from p_actor_user_id
     or v_request.active_assignee_role is distinct from v_actor_role
     or v_request.approved_quote_id is null then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_SETTLEMENT_NOT_AUTHORIZED');
  end if;
  select quote.* into v_quote from public.ticket_management_quotes quote
   where quote.id = v_request.approved_quote_id and quote.request_id = v_request.id
   for update;
  if not found or v_quote.direction not in ('debit', 'none')
     or v_quote.selection_hash is distinct from v_request.selection_hash
     or v_quote.user_payable_entitlement_amount <> 0
     or v_quote.void_fee <> 0
     or v_quote.customer_amount
          <> v_quote.fare_difference + v_quote.airline_fee + v_quote.service_fee
     or v_quote.fare_difference <> v_fare_difference_total then
    return jsonb_build_object('ok', false, 'code', 'APPROVED_REISSUE_QUOTE_INVALID');
  end if;
  select terms.* into v_reissue_terms
    from public.ticket_management_reissue_quote_terms terms
   where terms.quote_id = v_quote.id and terms.request_id = v_request.id;
  if not found or v_reissue_terms.fare_difference_amount <> v_quote.fare_difference then
    return jsonb_build_object('ok', false, 'code', 'APPROVED_REISSUE_ALLOCATION_INVALID');
  end if;
  if v_booking.charged_wallet_account_id is distinct from v_request.charged_wallet_account_id
     or v_booking.booking_owner_type is distinct from v_request.booking_owner_type
     or v_booking.booking_owner_key is distinct from v_request.booking_owner_key
     or upper(v_booking.currency) <> v_request.currency
     or jsonb_typeof(v_booking.ticket_numbers) <> 'array' then
    return jsonb_build_object('ok', false, 'code', 'ORIGINAL_BOOKING_WALLET_CONFLICT');
  end if;

  perform entitlement.id
    from public.ticket_management_request_selections selection
    join public.ticket_management_ticket_entitlements entitlement
      on entitlement.id = selection.entitlement_id
   where selection.request_id = v_request.id
   order by entitlement.id for update of entitlement;
  select count(*)::integer, coalesce(sum(entitlement.entitlement_amount), 0)
    into v_selection_count, v_carried_total
    from public.ticket_management_request_selections selection
    join public.ticket_management_ticket_entitlements entitlement
      on entitlement.id = selection.entitlement_id
    join public.ticket_management_entitlement_claims claim
      on claim.request_id = selection.request_id
     and claim.entitlement_id = selection.entitlement_id
   where selection.request_id = v_request.id
     and entitlement.booking_id = v_request.booking_id
     and entitlement.state = 'active'
     and entitlement.consumed_amount = 0
     and claim.state = 'active';
  if v_selection_count = 0 or v_selection_count <> v_mapping_count
     or v_selection_count <> (
       select count(*) from public.ticket_management_request_selections selection
        where selection.request_id = v_request.id
     ) then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_ENTITLEMENT_CONFLICT');
  end if;
  if exists (
    select 1
      from jsonb_to_recordset(v_normalized_tickets)
        as mapping("predecessorEntitlementId" text, "newTicketNumber" text,
          "fareDifferenceAmount" bigint)
      left join public.ticket_management_request_selections selection
        on selection.request_id = v_request.id
       and selection.entitlement_id = mapping."predecessorEntitlementId"::uuid
     where selection.id is null
  ) or exists (
    select 1
      from public.ticket_management_request_selections selection
      left join jsonb_to_recordset(v_normalized_tickets)
        as mapping("predecessorEntitlementId" text, "newTicketNumber" text,
          "fareDifferenceAmount" bigint)
        on mapping."predecessorEntitlementId"::uuid = selection.entitlement_id
     where selection.request_id = v_request.id
       and mapping."predecessorEntitlementId" is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_TICKET_MAPPING_MISMATCH');
  end if;
  if exists (
    select 1
      from jsonb_to_recordset(v_normalized_tickets)
        as mapping("predecessorEntitlementId" text, "newTicketNumber" text,
          "fareDifferenceAmount" bigint)
      left join public.ticket_management_reissue_quote_allocations allocation
        on allocation.quote_id = v_quote.id
       and allocation.entitlement_id = mapping."predecessorEntitlementId"::uuid
     where allocation.id is null
        or allocation.fare_difference_amount <> mapping."fareDifferenceAmount"
  ) then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_TICKET_ALLOCATION_MISMATCH');
  end if;
  if exists (
    select 1
      from jsonb_to_recordset(v_normalized_tickets)
        as mapping("predecessorEntitlementId" text, "newTicketNumber" text,
          "fareDifferenceAmount" bigint)
      join public.ticket_management_ticket_entitlements predecessor
        on predecessor.id = mapping."predecessorEntitlementId"::uuid
      left join public.ticket_management_ticket_entitlements active_ticket
        on active_ticket.booking_id = v_request.booking_id
       and active_ticket.state = 'active'
       and upper(active_ticket.active_ticket_number) = mapping."newTicketNumber"
     where upper(predecessor.active_ticket_number) = mapping."newTicketNumber"
        or active_ticket.id is not null
        or predecessor.passenger_index >= jsonb_array_length(v_booking.ticket_numbers)
        or predecessor.entitlement_amount
             > 9223372036854775807 - mapping."fareDifferenceAmount"
  ) then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_SUCCESSOR_TICKET_CONFLICT');
  end if;

  if v_quote.direction = 'debit' then
    v_capture_result := public.ticket_management_capture_hold_v1(
      v_request.id, p_actor_user_id, p_request_key || ':capture'
    );
    if not coalesce((v_capture_result->>'ok')::boolean, false) then
      return v_capture_result;
    end if;
    v_capture_ledger_id := (v_capture_result->>'ledgerEntryId')::uuid;
  elsif v_request.active_wallet_reservation_id is not null then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_ZERO_TOTAL_RESERVATION_CONFLICT');
  end if;

  insert into public.ticket_management_reissue_completions (
    request_id, quote_id, request_key, payload_hash, reissue_allocation_hash,
    supplier_gross_amount, supplier_payable_amount,
    carried_user_payable_amount, fare_difference_amount,
    airline_fee_amount, service_fee_amount, customer_amount_captured,
    capture_ledger_entry_id, finalized_by_user_id, finalized_by_role, note
  ) values (
    v_request.id, v_quote.id, p_request_key, v_payload_hash,
    v_reissue_terms.allocation_hash,
    v_quote.supplier_gross_amount, v_quote.supplier_payable_amount,
    v_carried_total, v_quote.fare_difference,
    v_quote.airline_fee, v_quote.service_fee, v_quote.customer_amount,
    v_capture_ledger_id, p_actor_user_id, v_actor_role,
    nullif(btrim(p_note), '')
  ) returning * into v_completion;

  v_ticket_numbers := v_booking.ticket_numbers;
  for v_item in
    select mapping."predecessorEntitlementId"::uuid as predecessor_id,
           mapping."newTicketNumber" as new_ticket_number,
           mapping."fareDifferenceAmount" as fare_difference_amount
      from jsonb_to_recordset(v_normalized_tickets)
        as mapping("predecessorEntitlementId" text, "newTicketNumber" text,
          "fareDifferenceAmount" bigint)
     order by mapping."predecessorEntitlementId"
  loop
    select entitlement.* into strict v_entitlement
      from public.ticket_management_ticket_entitlements entitlement
     where entitlement.id = v_item.predecessor_id;
    update public.ticket_management_ticket_entitlements
       set consumed_amount = entitlement_amount, state = 'reissued'
     where id = v_entitlement.id;
    insert into public.ticket_management_ticket_entitlements (
      booking_id, predecessor_entitlement_id, passenger_index,
      passenger_snapshot, passenger_name, passenger_type,
      original_ticket_number, active_ticket_number, currency,
      entitlement_amount, consumed_amount, user_payable_source_minor,
      allocation_source, allocation_hash, state
    ) values (
      v_entitlement.booking_id, v_entitlement.id, v_entitlement.passenger_index,
      v_entitlement.passenger_snapshot, v_entitlement.passenger_name,
      v_entitlement.passenger_type, v_entitlement.original_ticket_number,
      v_item.new_ticket_number, v_entitlement.currency,
      v_entitlement.entitlement_amount + v_item.fare_difference_amount,
      0, v_entitlement.entitlement_amount + v_item.fare_difference_amount,
      'reissue-lineage', encode(sha256(convert_to(concat_ws('|',
        v_quote.quote_hash, v_entitlement.id::text, v_item.new_ticket_number,
        v_item.fare_difference_amount::text,
        (v_entitlement.entitlement_amount + v_item.fare_difference_amount)::text
      ), 'UTF8')), 'hex'), 'active'
    ) returning * into v_successor;
    insert into public.ticket_management_reissue_lineages (
      completion_id, request_id, booking_id, quote_id,
      predecessor_entitlement_id, successor_entitlement_id, passenger_index,
      previous_ticket_number, new_ticket_number,
      carried_user_payable_amount, fare_difference_amount,
      successor_user_payable_entitlement_amount
    ) values (
      v_completion.id, v_request.id, v_request.booking_id, v_quote.id,
      v_entitlement.id, v_successor.id, v_entitlement.passenger_index,
      v_entitlement.active_ticket_number, v_successor.active_ticket_number,
      v_entitlement.entitlement_amount, v_item.fare_difference_amount,
      v_successor.entitlement_amount
    );
    v_ticket_numbers := jsonb_set(
      v_ticket_numbers, array[v_entitlement.passenger_index::text],
      to_jsonb(v_successor.active_ticket_number), false
    );
  end loop;

  update public.flight_bookings
     set ticket_numbers = v_ticket_numbers,
         captured_amount = captured_amount + v_quote.customer_amount
   where id = v_booking.id;
  update public.ticket_management_entitlement_claims
     set state = 'consumed', consumed_at = clock_timestamp()
   where request_id = v_request.id and state = 'active';
  update public.ticket_management_requests
     set status = 'completed', terminal_outcome = 'reissued',
         completed_at = clock_timestamp(), status_changed_at = clock_timestamp(),
         version = version + 1
   where id = v_request.id returning version into v_version;
  perform public.ticket_management_append_event_v1(
    v_request.id, 'completed', 'approved', 'completed', v_version,
    p_actor_user_id, v_actor_role, p_request_key || ':completed', p_note,
    jsonb_build_object(
      'outcome', 'reissued', 'quoteId', v_quote.id,
      'completionId', v_completion.id,
      'captureLedgerEntryId', v_capture_ledger_id,
      'supplierGrossAmount', v_quote.supplier_gross_amount,
      'supplierPayableAmount', v_quote.supplier_payable_amount,
      'carriedUserPayableAmount', v_carried_total,
      'fareDifferenceAmount', v_quote.fare_difference,
      'airlineFeeAmount', v_quote.airline_fee,
      'serviceFeeAmount', v_quote.service_fee,
      'customerAmountCaptured', v_quote.customer_amount,
      'tickets', v_normalized_tickets
    )
  );
  return jsonb_build_object('ok', true, 'replay', false,
    'requestId', v_request.id, 'completionId', v_completion.id,
    'status', 'completed', 'outcome', 'reissued', 'version', v_version,
    'ledgerEntryId', v_capture_ledger_id,
    'capturedAmount', v_quote.customer_amount,
    'futureEntitlementIncrease', v_quote.fare_difference);
end;
$$;

create or replace function public.release_and_reopen_ticket_management_reissue_v1(
  p_request_id uuid,
  p_actor_user_id text,
  p_expected_version integer,
  p_request_key text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_request public.ticket_management_requests;
  v_quote public.ticket_management_quotes;
  v_existing_event public.ticket_management_request_events;
  v_release_result jsonb;
  v_release_ledger_id uuid;
  v_version integer;
begin
  if p_expected_version is null or p_expected_version < 1
     or nullif(btrim(p_request_key), '') is null
     or char_length(p_request_key) > 180
     or nullif(btrim(p_reason), '') is null
     or char_length(p_reason) > 2000 then
    raise exception 'invalid Reissue release/reopen request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  select event.* into v_existing_event
    from public.ticket_management_request_events event
   where event.idempotency_key = p_request_key || ':reopened';
  if found then
    if v_existing_event.request_id is distinct from p_request_id
       or v_existing_event.actor_user_id is distinct from p_actor_user_id
       or v_existing_event.note is distinct from nullif(btrim(p_reason), '') then
      return jsonb_build_object('ok', false, 'code', 'REISSUE_RELEASE_IDEMPOTENCY_CONFLICT');
    end if;
    return jsonb_build_object('ok', true, 'replay', true,
      'requestId', p_request_id, 'status', v_existing_event.to_status,
      'version', v_existing_event.request_version,
      'ledgerEntryId', v_existing_event.metadata->>'releaseLedgerEntryId');
  end if;
  select role into v_actor_role from public.app_users where clerk_id = p_actor_user_id;
  if v_actor_role not in ('staff_account', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'FINAL_SETTLEMENT_FORBIDDEN');
  end if;
  select request.* into v_request from public.ticket_management_requests request
   where request.id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND'); end if;
  if v_request.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_VERSION_CONFLICT',
      'version', v_request.version);
  end if;
  if v_request.action <> 'reissue' or v_request.status <> 'approved'
     or v_request.active_assignee_user_id is distinct from p_actor_user_id
     or v_request.active_assignee_role is distinct from v_actor_role
     or v_request.approved_quote_id is null then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_RELEASE_NOT_AUTHORIZED');
  end if;
  select quote.* into v_quote from public.ticket_management_quotes quote
   where quote.id = v_request.approved_quote_id and quote.request_id = v_request.id
   for update;
  if not found or v_quote.direction not in ('debit', 'none') then
    return jsonb_build_object('ok', false, 'code', 'APPROVED_REISSUE_QUOTE_INVALID');
  end if;
  if v_quote.direction = 'debit' then
    v_release_result := public.ticket_management_release_hold_v1(
      v_request.id, p_actor_user_id, p_request_key || ':release', p_reason
    );
    if not coalesce((v_release_result->>'ok')::boolean, false) then
      return v_release_result;
    end if;
    v_release_ledger_id := (v_release_result->>'ledgerEntryId')::uuid;
  elsif v_request.active_wallet_reservation_id is not null then
    return jsonb_build_object('ok', false, 'code', 'REISSUE_ZERO_TOTAL_RESERVATION_CONFLICT');
  end if;

  update public.ticket_management_requests
     set status = 'in-progress', active_quote_id = null,
         approved_quote_id = null, approved_at = null,
         active_assignment_id = null, active_assignee_user_id = null,
         active_assignee_role = null, assigned_at = null,
         active_wallet_reservation_id = null,
         hold_ledger_entry_id = null, capture_ledger_entry_id = null,
         release_ledger_entry_id = null,
         status_changed_at = clock_timestamp(), version = version + 1
   where id = v_request.id returning version into v_version;
  perform public.ticket_management_append_event_v1(
    v_request.id, 'requote-started', 'approved', 'in-progress', v_version,
    p_actor_user_id, v_actor_role, p_request_key || ':reopened', p_reason,
    jsonb_build_object(
      'supersededQuoteId', v_quote.id,
      'supersededQuoteVersion', v_quote.quote_version,
      'supersededQuoteHash', v_quote.quote_hash,
      'previousAssignmentId', v_request.active_assignment_id,
      'releaseLedgerEntryId', v_release_ledger_id,
      'manualReissuePerformed', false
    )
  );
  return jsonb_build_object('ok', true, 'replay', false,
    'requestId', v_request.id, 'status', 'in-progress',
    'version', v_version, 'releasedAmount', v_quote.customer_amount,
    'ledgerEntryId', v_release_ledger_id,
    'supersededQuoteId', v_quote.id);
end;
$$;

alter table public.ticket_management_reissue_quote_terms enable row level security;
alter table public.ticket_management_reissue_quote_allocations enable row level security;
alter table public.ticket_management_reissue_completions enable row level security;
alter table public.ticket_management_reissue_lineages enable row level security;

revoke all on public.ticket_management_reissue_quote_terms
  from public, anon, authenticated;
revoke all on public.ticket_management_reissue_quote_allocations
  from public, anon, authenticated;
revoke all on public.ticket_management_reissue_completions
  from public, anon, authenticated;
revoke all on public.ticket_management_reissue_lineages
  from public, anon, authenticated;
grant select, insert on public.ticket_management_reissue_completions to service_role;
grant select, insert on public.ticket_management_reissue_lineages to service_role;
grant select on public.ticket_management_reissue_quote_terms to service_role;
grant select on public.ticket_management_reissue_quote_allocations to service_role;

revoke all on function public.publish_ticket_management_reissue_quote_v1(
  uuid, text, integer, text, text, text, bigint, bigint, bigint, bigint,
  bigint, bigint, timestamptz, jsonb, text
) from public, anon, authenticated;
grant execute on function public.publish_ticket_management_reissue_quote_v1(
  uuid, text, integer, text, text, text, bigint, bigint, bigint, bigint,
  bigint, bigint, timestamptz, jsonb, text
) to service_role;
revoke all on function public.ticket_management_require_reissue_quote_terms_v1()
  from public, anon, authenticated, service_role;

revoke all on function public.complete_ticket_management_reissue_v1(
  uuid, text, integer, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.complete_ticket_management_reissue_v1(
  uuid, text, integer, text, jsonb, text
) to service_role;
revoke all on function public.release_and_reopen_ticket_management_reissue_v1(
  uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.release_and_reopen_ticket_management_reissue_v1(
  uuid, text, integer, text, text
) to service_role;

comment on function public.complete_ticket_management_reissue_v1(
  uuid, text, integer, text, jsonb, text
) is
  'Assigned Accounts/Admin/Superadmin Reissue completion. Atomically captures the exact approved Hold, consumes predecessor tickets, creates successor ticket lineage, and carries forward only prior User Payable plus approved fare difference.';
comment on function public.publish_ticket_management_reissue_quote_v1(
  uuid, text, integer, text, text, text, bigint, bigint, bigint, bigint,
  bigint, bigint, timestamptz, jsonb, text
) is
  'Reissue quotation boundary. Freezes an exact per-passenger fare-difference allocation so final settlement cannot redistribute future User Payable entitlement.';
comment on function public.release_and_reopen_ticket_management_reissue_v1(
  uuid, text, integer, text, text
) is
  'Assigned Accounts/Admin/Superadmin non-performance path. Atomically releases the exact Reissue Hold and returns the request to In Progress for a new quotation and customer approval.';
