-- Ticket Management quotation, customer-decision, deadline, and assignment
-- boundary. This migration performs no wallet movement. Debit-direction quote
-- approval remains fail-closed until the request-scoped Hold migration lands.

create table public.ticket_management_quotes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.ticket_management_requests(id) on delete restrict,
  quote_version integer not null check (quote_version > 0),
  request_key text not null unique
    check (char_length(request_key) between 1 and 220),
  quote_hash text not null check (quote_hash ~ '^[a-f0-9]{64}$'),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  direction text not null check (direction in ('credit', 'debit', 'none')),
  supplier_gross_amount bigint not null default 0 check (supplier_gross_amount >= 0),
  supplier_payable_amount bigint not null default 0 check (supplier_payable_amount >= 0),
  user_payable_entitlement_amount bigint not null default 0
    check (user_payable_entitlement_amount >= 0),
  fare_difference bigint not null default 0 check (fare_difference >= 0),
  airline_fee bigint not null default 0 check (airline_fee >= 0),
  void_fee bigint not null default 0 check (void_fee >= 0),
  service_fee bigint not null default 0 check (service_fee >= 0),
  customer_amount bigint not null check (customer_amount >= 0),
  details text check (details is null or char_length(details) <= 4000),
  published_by_user_id text not null,
  published_by_role text not null,
  published_at timestamptz not null default clock_timestamp(),
  confirmation_deadline_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (request_id, quote_version),
  constraint ticket_management_quotes_deadline_check
    check (confirmation_deadline_at > published_at),
  constraint ticket_management_quotes_direction_amount_check
    check (
      (direction = 'none' and customer_amount = 0)
      or (direction in ('credit', 'debit') and customer_amount > 0)
    )
);

create index ticket_management_quotes_request_created_idx
  on public.ticket_management_quotes(request_id, quote_version desc, id);
create index ticket_management_quotes_deadline_idx
  on public.ticket_management_quotes(confirmation_deadline_at, request_id);

create table public.ticket_management_customer_decisions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.ticket_management_requests(id) on delete restrict,
  quote_id uuid not null
    references public.ticket_management_quotes(id) on delete restrict,
  decision text not null check (decision in ('approved', 'rejected')),
  quote_version integer not null check (quote_version > 0),
  quote_hash text not null check (quote_hash ~ '^[a-f0-9]{64}$'),
  request_key text not null unique
    check (char_length(request_key) between 1 and 220),
  decided_by_user_id text not null,
  decided_by_role text not null,
  note text check (note is null or char_length(note) <= 2000),
  decided_at timestamptz not null default clock_timestamp(),
  unique (quote_id),
  unique (request_id, quote_id)
);

create index ticket_management_decisions_request_idx
  on public.ticket_management_customer_decisions(request_id, decided_at desc, id);

create table public.ticket_management_assignments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null
    references public.ticket_management_requests(id) on delete restrict,
  previous_assignee_user_id text,
  assignee_user_id text not null,
  assignee_role_snapshot text not null
    check (assignee_role_snapshot in ('staff_account', 'admin', 'superadmin')),
  assigned_by_user_id text not null,
  assigned_by_role text not null,
  request_version integer not null check (request_version > 0),
  reason text check (reason is null or char_length(reason) <= 2000),
  request_key text not null unique
    check (char_length(request_key) between 1 and 220),
  assigned_at timestamptz not null default clock_timestamp()
);

create index ticket_management_assignments_request_idx
  on public.ticket_management_assignments(request_id, assigned_at desc, id);
create index ticket_management_assignments_assignee_idx
  on public.ticket_management_assignments(assignee_user_id, assigned_at desc, id);

alter table public.ticket_management_requests
  add column active_quote_id uuid
    references public.ticket_management_quotes(id) on delete restrict,
  add column approved_quote_id uuid
    references public.ticket_management_quotes(id) on delete restrict,
  add column active_assignment_id uuid
    references public.ticket_management_assignments(id) on delete restrict,
  add column active_assignee_user_id text,
  add column active_assignee_role text
    check (active_assignee_role is null or active_assignee_role in (
      'staff_account', 'admin', 'superadmin'
    )),
  add column assigned_at timestamptz,
  add constraint ticket_management_requests_assignee_pair_check
    check (
      (active_assignee_user_id is null) = (active_assignee_role is null)
      and (active_assignment_id is null) = (active_assignee_user_id is null)
    );

create unique index ticket_management_requests_one_active_quote_idx
  on public.ticket_management_requests(active_quote_id)
  where active_quote_id is not null;

create or replace function public.prevent_ticket_management_audit_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'ticket management quotation, decision, and assignment records are immutable'
    using errcode = '55000';
end;
$$;

create trigger ticket_management_quotes_deny_update_delete
  before update or delete on public.ticket_management_quotes
  for each row execute function public.prevent_ticket_management_audit_mutation_v1();
create trigger ticket_management_decisions_deny_update_delete
  before update or delete on public.ticket_management_customer_decisions
  for each row execute function public.prevent_ticket_management_audit_mutation_v1();
create trigger ticket_management_assignments_deny_update_delete
  before update or delete on public.ticket_management_assignments
  for each row execute function public.prevent_ticket_management_audit_mutation_v1();

create or replace function public.ticket_management_append_event_v1(
  p_request_id uuid,
  p_event_type text,
  p_from_status text,
  p_to_status text,
  p_request_version integer,
  p_actor_user_id text,
  p_actor_role text,
  p_idempotency_key text,
  p_note text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_id uuid;
  v_occurrence integer;
begin
  select coalesce(max(event.occurrence_number), 0) + 1
    into v_occurrence
    from public.ticket_management_request_events event
   where event.request_id = p_request_id;

  insert into public.ticket_management_request_events (
    request_id, occurrence_number, event_type, from_status, to_status,
    request_version, actor_user_id, actor_role, note, metadata,
    idempotency_key
  ) values (
    p_request_id, v_occurrence, p_event_type, p_from_status, p_to_status,
    p_request_version, p_actor_user_id, p_actor_role,
    nullif(btrim(p_note), ''), coalesce(p_metadata, '{}'::jsonb),
    p_idempotency_key
  ) returning id into v_event_id;
  return v_event_id;
end;
$$;

create or replace function public.create_ticket_management_request_v1(
  p_booking_id uuid,
  p_action text,
  p_actor_user_id text,
  p_request_key text,
  p_request_payload_hash text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor public.app_users;
  v_booking public.flight_bookings;
  v_existing public.ticket_management_requests;
  v_request public.ticket_management_requests;
begin
  if p_booking_id is null
     or p_action not in ('refund', 'reissue', 'void')
     or nullif(btrim(p_actor_user_id), '') is null
     or nullif(btrim(p_request_key), '') is null
     or char_length(p_request_key) > 220
     or p_request_payload_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid Ticket Management request identity'
      using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  select request.* into v_existing
    from public.ticket_management_requests request
   where request.request_key = p_request_key
   for update;
  if found then
    if v_existing.booking_id is distinct from p_booking_id
       or v_existing.action is distinct from p_action
       or v_existing.requested_by_user_id is distinct from p_actor_user_id
       or v_existing.request_payload_hash is distinct from p_request_payload_hash then
      return jsonb_build_object('ok', false, 'code', 'REQUEST_IDEMPOTENCY_CONFLICT');
    end if;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', v_existing.id,
      'publicReference', v_existing.public_ref,
      'status', v_existing.status, 'version', v_existing.version
    );
  end if;

  select actor.* into v_actor
    from public.app_users actor
   where actor.clerk_id = p_actor_user_id;
  if not found or v_actor.role not in ('customer', 'b2b', 'b2b_sub') then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_CREATE_FORBIDDEN');
  end if;

  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = p_booking_id and not booking.legacy_operational
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_FOUND');
  end if;
  if v_booking.status <> 'confirmed'
     or v_booking.issued_at is null
     or v_booking.charged_wallet_account_id is null
     or v_booking.booking_owner_type is null
     or v_booking.booking_owner_key is null
     or v_booking.captured_amount <= 0
     or v_booking.payment_state not in ('captured', 'partially-refunded') then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_NOT_TICKET_MANAGEABLE');
  end if;
  if not (
    (v_actor.role = 'customer'
      and v_booking.booking_owner_type = 'user'
      and v_booking.booking_owner_key = p_actor_user_id)
    or
    (v_actor.role in ('b2b', 'b2b_sub')
      and v_booking.booking_owner_type = 'agency'
      and nullif(btrim(v_actor.agency_code), '') is not null
      and v_booking.booking_owner_key = v_actor.agency_code)
  ) then
    return jsonb_build_object('ok', false, 'code', 'BOOKING_OWNER_FORBIDDEN');
  end if;

  insert into public.ticket_management_requests (
    booking_id, action, request_key, request_payload_hash,
    requested_by_user_id, requested_by_role, request_note,
    booking_owner_type, booking_owner_key, charged_wallet_account_id,
    currency, captured_amount_snapshot, refunded_amount_snapshot
  ) values (
    v_booking.id, p_action, p_request_key, p_request_payload_hash,
    p_actor_user_id, v_actor.role, nullif(btrim(p_note), ''),
    v_booking.booking_owner_type, v_booking.booking_owner_key,
    v_booking.charged_wallet_account_id, upper(v_booking.currency),
    v_booking.captured_amount, v_booking.refunded_amount
  ) returning * into v_request;

  perform public.ticket_management_append_event_v1(
    v_request.id, 'requested', null, 'requested', v_request.version,
    p_actor_user_id, v_actor.role, p_request_key || ':event', p_note,
    jsonb_build_object('action', p_action, 'bookingId', v_booking.id)
  );
  return jsonb_build_object(
    'ok', true, 'replay', false, 'requestId', v_request.id,
    'publicReference', v_request.public_ref,
    'status', v_request.status, 'version', v_request.version
  );
end;
$$;

create or replace function public.review_ticket_management_request_v1(
  p_request_id uuid,
  p_decision text,
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
  v_actor_role text;
  v_request public.ticket_management_requests;
  v_existing_event public.ticket_management_request_events;
  v_status text;
  v_outcome text;
  v_event_type text;
  v_version integer;
begin
  if p_decision not in ('accept', 'reject')
     or p_expected_version is null or p_expected_version < 1
     or nullif(btrim(p_request_key), '') is null then
    raise exception 'invalid Ticket Management review' using errcode = '22023';
  end if;
  select role into v_actor_role from public.app_users where clerk_id = p_actor_user_id;
  if v_actor_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'OPERATION_FORBIDDEN');
  end if;
  select event.* into v_existing_event
    from public.ticket_management_request_events event
   where event.idempotency_key = p_request_key || ':event';
  if found then
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', p_request_id,
      'status', v_existing_event.to_status,
      'version', v_existing_event.request_version
    );
  end if;
  select request.* into v_request
    from public.ticket_management_requests request
   where request.id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND'); end if;
  if v_request.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_VERSION_CONFLICT', 'version', v_request.version);
  end if;
  if v_request.status <> 'requested' then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_REVIEWABLE');
  end if;

  if p_decision = 'accept' then
    v_status := 'in-progress'; v_outcome := null; v_event_type := 'accepted';
    update public.ticket_management_requests
       set status = v_status, terminal_outcome = null,
           accepted_by_user_id = p_actor_user_id,
           accepted_at = clock_timestamp(), status_changed_at = clock_timestamp(),
           version = version + 1
     where id = v_request.id returning version into v_version;
  else
    v_status := 'rejected'; v_outcome := 'staff-rejected';
    v_event_type := 'staff-rejected';
    update public.ticket_management_requests
       set status = v_status, terminal_outcome = v_outcome,
           rejected_at = clock_timestamp(), status_changed_at = clock_timestamp(),
           version = version + 1
     where id = v_request.id returning version into v_version;
  end if;
  perform public.ticket_management_append_event_v1(
    v_request.id, v_event_type, 'requested', v_status, v_version,
    p_actor_user_id, v_actor_role, p_request_key || ':event', p_note,
    jsonb_build_object('decision', p_decision)
  );
  return jsonb_build_object(
    'ok', true, 'replay', false, 'requestId', v_request.id,
    'status', v_status, 'version', v_version
  );
end;
$$;

create or replace function public.publish_ticket_management_quote_v1(
  p_request_id uuid,
  p_actor_user_id text,
  p_expected_version integer,
  p_request_key text,
  p_direction text,
  p_currency text,
  p_supplier_gross_amount bigint,
  p_supplier_payable_amount bigint,
  p_user_payable_entitlement_amount bigint,
  p_fare_difference bigint,
  p_airline_fee bigint,
  p_void_fee bigint,
  p_service_fee bigint,
  p_customer_amount bigint,
  p_confirmation_deadline_at timestamptz,
  p_details text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_request public.ticket_management_requests;
  v_existing public.ticket_management_quotes;
  v_quote public.ticket_management_quotes;
  v_quote_version integer;
  v_payload jsonb;
  v_hash text;
  v_expected_direction text;
  v_expected_amount bigint;
  v_version integer;
begin
  if p_expected_version is null or p_expected_version < 1
     or nullif(btrim(p_request_key), '') is null
     or p_direction not in ('credit', 'debit', 'none')
     or p_currency !~ '^[A-Z]{3}$'
     or p_supplier_gross_amount < 0 or p_supplier_payable_amount < 0
     or p_user_payable_entitlement_amount < 0
     or p_fare_difference < 0 or p_airline_fee < 0
     or p_void_fee < 0 or p_service_fee < 0 or p_customer_amount < 0
     or p_confirmation_deadline_at is null
     or p_confirmation_deadline_at <= clock_timestamp() then
    raise exception 'invalid Ticket Management quotation' using errcode = '22023';
  end if;
  select role into v_actor_role from public.app_users where clerk_id = p_actor_user_id;
  if v_actor_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'QUOTE_FORBIDDEN');
  end if;

  v_payload := jsonb_build_object(
    'requestId', p_request_id, 'direction', p_direction,
    'currency', upper(p_currency),
    'supplierGrossAmount', p_supplier_gross_amount,
    'supplierPayableAmount', p_supplier_payable_amount,
    'userPayableEntitlementAmount', p_user_payable_entitlement_amount,
    'fareDifference', p_fare_difference, 'airlineFee', p_airline_fee,
    'voidFee', p_void_fee, 'serviceFee', p_service_fee,
    'customerAmount', p_customer_amount,
    'confirmationDeadlineAt', p_confirmation_deadline_at,
    'details', nullif(btrim(p_details), '')
  );
  v_hash := encode(sha256(convert_to(v_payload::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  select quote.* into v_existing
    from public.ticket_management_quotes quote
   where quote.request_key = p_request_key for update;
  if found then
    if v_existing.request_id is distinct from p_request_id
       or v_existing.quote_hash is distinct from v_hash
       or v_existing.published_by_user_id is distinct from p_actor_user_id then
      return jsonb_build_object('ok', false, 'code', 'QUOTE_IDEMPOTENCY_CONFLICT');
    end if;
    select request.* into v_request
      from public.ticket_management_requests request
     where request.id = p_request_id;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', p_request_id,
      'quoteId', v_existing.id, 'quoteVersion', v_existing.quote_version,
      'quoteHash', v_existing.quote_hash, 'status', v_request.status,
      'version', v_request.version
    );
  end if;

  select request.* into v_request
    from public.ticket_management_requests request
   where request.id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND'); end if;
  if v_request.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_VERSION_CONFLICT', 'version', v_request.version);
  end if;
  if v_request.status <> 'in-progress' then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_QUOTABLE');
  end if;
  if upper(p_currency) <> v_request.currency then
    return jsonb_build_object('ok', false, 'code', 'QUOTE_CURRENCY_MISMATCH');
  end if;
  if p_supplier_gross_amount <= 0 or p_supplier_payable_amount <= 0 then
    return jsonb_build_object('ok', false, 'code', 'SUPPLIER_COMMERCIAL_BASIS_REQUIRED');
  end if;

  if v_request.action = 'refund' then
    if p_fare_difference <> 0 or p_void_fee <> 0
       or p_user_payable_entitlement_amount < p_airline_fee + p_service_fee then
      return jsonb_build_object('ok', false, 'code', 'REFUND_QUOTE_BREAKDOWN_INVALID');
    end if;
    v_expected_amount := p_user_payable_entitlement_amount
      - p_airline_fee - p_service_fee;
    v_expected_direction := case when v_expected_amount = 0 then 'none' else 'credit' end;
  elsif v_request.action = 'reissue' then
    if p_user_payable_entitlement_amount <> 0 or p_void_fee <> 0 then
      return jsonb_build_object('ok', false, 'code', 'REISSUE_QUOTE_BREAKDOWN_INVALID');
    end if;
    v_expected_amount := p_fare_difference + p_airline_fee + p_service_fee;
    v_expected_direction := case when v_expected_amount = 0 then 'none' else 'debit' end;
  else
    if p_fare_difference <> 0 or p_airline_fee <> 0 then
      return jsonb_build_object('ok', false, 'code', 'VOID_QUOTE_BREAKDOWN_INVALID');
    end if;
    if p_user_payable_entitlement_amount > p_void_fee + p_service_fee then
      v_expected_direction := 'credit';
      v_expected_amount := p_user_payable_entitlement_amount
        - p_void_fee - p_service_fee;
    elsif p_user_payable_entitlement_amount < p_void_fee + p_service_fee then
      v_expected_direction := 'debit';
      v_expected_amount := p_void_fee + p_service_fee
        - p_user_payable_entitlement_amount;
    else
      v_expected_direction := 'none'; v_expected_amount := 0;
    end if;
  end if;
  if p_direction <> v_expected_direction or p_customer_amount <> v_expected_amount then
    return jsonb_build_object('ok', false, 'code', 'QUOTE_TOTAL_MISMATCH');
  end if;

  select coalesce(max(quote.quote_version), 0) + 1 into v_quote_version
    from public.ticket_management_quotes quote
   where quote.request_id = v_request.id;
  insert into public.ticket_management_quotes (
    request_id, quote_version, request_key, quote_hash, currency, direction,
    supplier_gross_amount, supplier_payable_amount,
    user_payable_entitlement_amount, fare_difference, airline_fee, void_fee,
    service_fee, customer_amount, details, published_by_user_id,
    published_by_role, confirmation_deadline_at
  ) values (
    v_request.id, v_quote_version, p_request_key, v_hash, upper(p_currency),
    p_direction, p_supplier_gross_amount, p_supplier_payable_amount,
    p_user_payable_entitlement_amount, p_fare_difference,
    p_airline_fee, p_void_fee, p_service_fee, p_customer_amount,
    nullif(btrim(p_details), ''), p_actor_user_id, v_actor_role,
    p_confirmation_deadline_at
  ) returning * into v_quote;

  update public.ticket_management_requests
     set status = 'awaiting-confirmation', active_quote_id = v_quote.id,
         approved_quote_id = null, approved_at = null,
         status_changed_at = clock_timestamp(), version = version + 1
   where id = v_request.id returning version into v_version;
  perform public.ticket_management_append_event_v1(
    v_request.id, 'quotation-published', 'in-progress',
    'awaiting-confirmation', v_version, p_actor_user_id, v_actor_role,
    p_request_key || ':event', p_details,
    jsonb_build_object(
      'quoteId', v_quote.id, 'quoteVersion', v_quote.quote_version,
      'quoteHash', v_quote.quote_hash,
      'confirmationDeadlineAt', v_quote.confirmation_deadline_at
    )
  );
  return jsonb_build_object(
    'ok', true, 'replay', false, 'requestId', v_request.id,
    'quoteId', v_quote.id, 'quoteVersion', v_quote.quote_version,
    'quoteHash', v_quote.quote_hash, 'status', 'awaiting-confirmation',
    'version', v_version
  );
end;
$$;

create or replace function public.decide_ticket_management_quote_v1(
  p_request_id uuid,
  p_quote_id uuid,
  p_decision text,
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
  v_actor public.app_users;
  v_request public.ticket_management_requests;
  v_quote public.ticket_management_quotes;
  v_existing public.ticket_management_customer_decisions;
  v_decision public.ticket_management_customer_decisions;
  v_event_id uuid;
  v_version integer;
begin
  if p_decision not in ('approved', 'rejected')
     or p_expected_version is null or p_expected_version < 1
     or nullif(btrim(p_request_key), '') is null then
    raise exception 'invalid Ticket Management customer decision' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  select decision.* into v_existing
    from public.ticket_management_customer_decisions decision
   where decision.request_key = p_request_key for update;
  if found then
    if v_existing.request_id is distinct from p_request_id
       or v_existing.quote_id is distinct from p_quote_id
       or v_existing.decision is distinct from p_decision
       or v_existing.decided_by_user_id is distinct from p_actor_user_id then
      return jsonb_build_object('ok', false, 'code', 'DECISION_IDEMPOTENCY_CONFLICT');
    end if;
    select request.* into v_request from public.ticket_management_requests request
     where request.id = p_request_id;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', p_request_id,
      'decisionId', v_existing.id, 'status', v_request.status,
      'version', v_request.version
    );
  end if;

  select actor.* into v_actor from public.app_users actor
   where actor.clerk_id = p_actor_user_id;
  if not found or v_actor.role not in ('customer', 'b2b', 'b2b_sub') then
    return jsonb_build_object('ok', false, 'code', 'CUSTOMER_DECISION_FORBIDDEN');
  end if;
  select request.* into v_request
    from public.ticket_management_requests request
   where request.id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND'); end if;
  if v_request.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_VERSION_CONFLICT', 'version', v_request.version);
  end if;
  if v_request.status <> 'awaiting-confirmation'
     or v_request.active_quote_id is distinct from p_quote_id then
    return jsonb_build_object('ok', false, 'code', 'QUOTE_NOT_ACTIONABLE');
  end if;
  if not (
    (v_actor.role = 'customer' and v_request.booking_owner_type = 'user'
      and v_request.booking_owner_key = p_actor_user_id)
    or
    (v_actor.role in ('b2b', 'b2b_sub')
      and v_request.booking_owner_type = 'agency'
      and v_actor.agency_code = v_request.booking_owner_key)
  ) then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_OWNER_FORBIDDEN');
  end if;
  select quote.* into v_quote from public.ticket_management_quotes quote
   where quote.id = p_quote_id and quote.request_id = p_request_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'QUOTE_NOT_FOUND'); end if;

  if v_quote.confirmation_deadline_at <= clock_timestamp() then
    update public.ticket_management_requests
       set status = 'expired', terminal_outcome = 'confirmation-expired',
           expired_at = clock_timestamp(), status_changed_at = clock_timestamp(),
           version = version + 1
     where id = v_request.id returning version into v_version;
    v_event_id := public.ticket_management_append_event_v1(
      v_request.id, 'confirmation-expired', 'awaiting-confirmation',
      'expired', v_version, 'system:ticket-management', 'system',
      'ticket-expire:' || v_request.id || ':' || v_quote.id,
      'Customer confirmation deadline passed',
      jsonb_build_object('quoteId', v_quote.id, 'deadline', v_quote.confirmation_deadline_at)
    );
    return jsonb_build_object(
      'ok', false, 'code', 'QUOTE_EXPIRED', 'requestId', v_request.id,
      'status', 'expired', 'version', v_version, 'eventId', v_event_id
    );
  end if;
  if p_decision = 'approved' and v_quote.direction = 'debit' then
    return jsonb_build_object('ok', false, 'code', 'WALLET_HOLD_REQUIRED');
  end if;

  insert into public.ticket_management_customer_decisions (
    request_id, quote_id, decision, quote_version, quote_hash, request_key,
    decided_by_user_id, decided_by_role, note
  ) values (
    v_request.id, v_quote.id, p_decision, v_quote.quote_version,
    v_quote.quote_hash, p_request_key, p_actor_user_id, v_actor.role,
    nullif(btrim(p_note), '')
  ) returning * into v_decision;
  if p_decision = 'approved' then
    update public.ticket_management_requests
       set status = 'approved', approved_quote_id = v_quote.id,
           approved_at = clock_timestamp(), status_changed_at = clock_timestamp(),
           version = version + 1
     where id = v_request.id returning version into v_version;
    perform public.ticket_management_append_event_v1(
      v_request.id, 'customer-approved', 'awaiting-confirmation',
      'approved', v_version, p_actor_user_id, v_actor.role,
      p_request_key || ':event', p_note,
      jsonb_build_object('quoteId', v_quote.id, 'quoteHash', v_quote.quote_hash)
    );
  else
    update public.ticket_management_requests
       set status = 'rejected', terminal_outcome = 'customer-rejected',
           rejected_at = clock_timestamp(), status_changed_at = clock_timestamp(),
           version = version + 1
     where id = v_request.id returning version into v_version;
    perform public.ticket_management_append_event_v1(
      v_request.id, 'customer-rejected', 'awaiting-confirmation',
      'rejected', v_version, p_actor_user_id, v_actor.role,
      p_request_key || ':event', p_note,
      jsonb_build_object('quoteId', v_quote.id, 'quoteHash', v_quote.quote_hash)
    );
  end if;
  return jsonb_build_object(
    'ok', true, 'replay', false, 'requestId', v_request.id,
    'decisionId', v_decision.id,
    'status', case when p_decision = 'approved' then 'approved' else 'rejected' end,
    'version', v_version
  );
end;
$$;

create or replace function public.expire_ticket_management_quotes_v1(
  p_limit integer default 200
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_version integer;
  v_count integer := 0;
begin
  for v_row in
    select request.id as request_id, request.version,
           quote.id as quote_id, quote.confirmation_deadline_at
      from public.ticket_management_requests request
      join public.ticket_management_quotes quote
        on quote.id = request.active_quote_id
     where request.status = 'awaiting-confirmation'
       and quote.confirmation_deadline_at <= clock_timestamp()
     order by quote.confirmation_deadline_at, request.id
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
     for update of request skip locked
  loop
    update public.ticket_management_requests
       set status = 'expired', terminal_outcome = 'confirmation-expired',
           expired_at = clock_timestamp(), status_changed_at = clock_timestamp(),
           version = version + 1
     where id = v_row.request_id and status = 'awaiting-confirmation'
     returning version into v_version;
    if found then
      perform public.ticket_management_append_event_v1(
        v_row.request_id, 'confirmation-expired', 'awaiting-confirmation',
        'expired', v_version, 'system:ticket-management', 'system',
        'ticket-expire:' || v_row.request_id || ':' || v_row.quote_id,
        'Customer confirmation deadline passed',
        jsonb_build_object('quoteId', v_row.quote_id, 'deadline', v_row.confirmation_deadline_at)
      );
      v_count := v_count + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'expiredCount', v_count);
end;
$$;

create or replace function public.reopen_ticket_management_request_v1(
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
  v_version integer;
begin
  if p_expected_version is null or p_expected_version < 1
     or nullif(btrim(p_request_key), '') is null
     or nullif(btrim(p_reason), '') is null then
    raise exception 'invalid Ticket Management requote request' using errcode = '22023';
  end if;
  select role into v_actor_role from public.app_users where clerk_id = p_actor_user_id;
  if v_actor_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'REQUOTE_FORBIDDEN');
  end if;
  select event.* into v_existing_event
    from public.ticket_management_request_events event
   where event.idempotency_key = p_request_key || ':event';
  if found then
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', p_request_id,
      'status', v_existing_event.to_status,
      'version', v_existing_event.request_version
    );
  end if;
  select request.* into v_request
    from public.ticket_management_requests request
   where request.id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND'); end if;
  if v_request.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_VERSION_CONFLICT', 'version', v_request.version);
  end if;
  if v_request.status <> 'approved' or v_request.approved_quote_id is null then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_REQUOTABLE');
  end if;
  select quote.* into v_quote from public.ticket_management_quotes quote
   where quote.id = v_request.approved_quote_id and quote.request_id = v_request.id;
  if not found then return jsonb_build_object('ok', false, 'code', 'APPROVED_QUOTE_NOT_FOUND'); end if;
  if v_quote.direction = 'debit' then
    return jsonb_build_object('ok', false, 'code', 'WALLET_RELEASE_REQUIRED');
  end if;

  update public.ticket_management_requests
     set status = 'in-progress', active_quote_id = null,
         approved_quote_id = null, approved_at = null,
         active_assignment_id = null, active_assignee_user_id = null,
         active_assignee_role = null, assigned_at = null,
         status_changed_at = clock_timestamp(), version = version + 1
   where id = v_request.id returning version into v_version;
  perform public.ticket_management_append_event_v1(
    v_request.id, 'requote-started', 'approved', 'in-progress', v_version,
    p_actor_user_id, v_actor_role, p_request_key || ':event', p_reason,
    jsonb_build_object(
      'supersededQuoteId', v_quote.id,
      'supersededQuoteVersion', v_quote.quote_version,
      'supersededQuoteHash', v_quote.quote_hash,
      'previousAssignmentId', v_request.active_assignment_id
    )
  );
  return jsonb_build_object(
    'ok', true, 'replay', false, 'requestId', v_request.id,
    'status', 'in-progress', 'version', v_version,
    'supersededQuoteId', v_quote.id
  );
end;
$$;

create or replace function public.assign_ticket_management_settlement_v1(
  p_request_id uuid,
  p_assignee_user_id text,
  p_actor_user_id text,
  p_expected_version integer,
  p_request_key text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role text;
  v_assignee_role text;
  v_request public.ticket_management_requests;
  v_existing public.ticket_management_assignments;
  v_assignment public.ticket_management_assignments;
  v_version integer;
  v_event_type text;
begin
  if p_expected_version is null or p_expected_version < 1
     or nullif(btrim(p_assignee_user_id), '') is null
     or nullif(btrim(p_request_key), '') is null then
    raise exception 'invalid Ticket Management assignment' using errcode = '22023';
  end if;
  select role into v_actor_role from public.app_users where clerk_id = p_actor_user_id;
  if v_actor_role not in ('staff_support', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'ASSIGNMENT_FORBIDDEN');
  end if;
  select role into v_assignee_role from public.app_users where clerk_id = p_assignee_user_id;
  if v_assignee_role not in ('staff_account', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'ASSIGNEE_ROLE_INVALID');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  select assignment.* into v_existing
    from public.ticket_management_assignments assignment
   where assignment.request_key = p_request_key for update;
  if found then
    if v_existing.request_id is distinct from p_request_id
       or v_existing.assignee_user_id is distinct from p_assignee_user_id
       or v_existing.assigned_by_user_id is distinct from p_actor_user_id then
      return jsonb_build_object('ok', false, 'code', 'ASSIGNMENT_IDEMPOTENCY_CONFLICT');
    end if;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', p_request_id,
      'assignmentId', v_existing.id, 'assigneeUserId', v_existing.assignee_user_id,
      'assigneeRole', v_existing.assignee_role_snapshot
    );
  end if;
  select request.* into v_request
    from public.ticket_management_requests request
   where request.id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_FOUND'); end if;
  if v_request.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_VERSION_CONFLICT', 'version', v_request.version);
  end if;
  if v_request.status <> 'approved' or v_request.approved_quote_id is null then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_NOT_ASSIGNABLE');
  end if;
  if v_request.active_assignee_user_id = p_assignee_user_id then
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', v_request.id,
      'assignmentId', v_request.active_assignment_id,
      'assigneeUserId', p_assignee_user_id, 'assigneeRole', v_assignee_role,
      'version', v_request.version
    );
  end if;

  v_event_type := case when v_request.active_assignment_id is null
    then 'assigned' else 'reassigned' end;
  insert into public.ticket_management_assignments (
    request_id, previous_assignee_user_id, assignee_user_id,
    assignee_role_snapshot, assigned_by_user_id, assigned_by_role,
    request_version, reason, request_key
  ) values (
    v_request.id, v_request.active_assignee_user_id, p_assignee_user_id,
    v_assignee_role, p_actor_user_id, v_actor_role, v_request.version + 1,
    nullif(btrim(p_reason), ''), p_request_key
  ) returning * into v_assignment;
  update public.ticket_management_requests
     set active_assignment_id = v_assignment.id,
         active_assignee_user_id = p_assignee_user_id,
         active_assignee_role = v_assignee_role,
         assigned_at = v_assignment.assigned_at,
         version = version + 1
   where id = v_request.id returning version into v_version;
  perform public.ticket_management_append_event_v1(
    v_request.id, v_event_type, 'approved', 'approved', v_version,
    p_actor_user_id, v_actor_role, p_request_key || ':event', p_reason,
    jsonb_build_object(
      'assignmentId', v_assignment.id,
      'previousAssigneeUserId', v_request.active_assignee_user_id,
      'assigneeUserId', p_assignee_user_id,
      'assigneeRole', v_assignee_role
    )
  );
  return jsonb_build_object(
    'ok', true, 'replay', false, 'requestId', v_request.id,
    'assignmentId', v_assignment.id, 'assigneeUserId', p_assignee_user_id,
    'assigneeRole', v_assignee_role, 'version', v_version
  );
end;
$$;

alter table public.ticket_management_quotes enable row level security;
alter table public.ticket_management_customer_decisions enable row level security;
alter table public.ticket_management_assignments enable row level security;

revoke all on public.ticket_management_quotes from public, anon, authenticated;
revoke all on public.ticket_management_customer_decisions from public, anon, authenticated;
revoke all on public.ticket_management_assignments from public, anon, authenticated;
grant select, insert on public.ticket_management_quotes to service_role;
grant select, insert on public.ticket_management_customer_decisions to service_role;
grant select, insert on public.ticket_management_assignments to service_role;

revoke all on function public.prevent_ticket_management_audit_mutation_v1()
  from public, anon, authenticated, service_role;
revoke all on function public.ticket_management_append_event_v1(
  uuid, text, text, text, integer, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.create_ticket_management_request_v1(
  uuid, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.review_ticket_management_request_v1(
  uuid, text, text, integer, text, text
) from public, anon, authenticated;
revoke all on function public.publish_ticket_management_quote_v1(
  uuid, text, integer, text, text, text, bigint, bigint, bigint,
  bigint, bigint, bigint, bigint, bigint, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.decide_ticket_management_quote_v1(
  uuid, uuid, text, text, integer, text, text
) from public, anon, authenticated;
revoke all on function public.expire_ticket_management_quotes_v1(integer)
  from public, anon, authenticated;
revoke all on function public.reopen_ticket_management_request_v1(
  uuid, text, integer, text, text
) from public, anon, authenticated;
revoke all on function public.assign_ticket_management_settlement_v1(
  uuid, text, text, integer, text, text
) from public, anon, authenticated;

grant execute on function public.ticket_management_append_event_v1(
  uuid, text, text, text, integer, text, text, text, text, jsonb
) to service_role;
grant execute on function public.create_ticket_management_request_v1(
  uuid, text, text, text, text, text
) to service_role;
grant execute on function public.review_ticket_management_request_v1(
  uuid, text, text, integer, text, text
) to service_role;
grant execute on function public.publish_ticket_management_quote_v1(
  uuid, text, integer, text, text, text, bigint, bigint, bigint,
  bigint, bigint, bigint, bigint, bigint, timestamptz, text
) to service_role;
grant execute on function public.decide_ticket_management_quote_v1(
  uuid, uuid, text, text, integer, text, text
) to service_role;
grant execute on function public.expire_ticket_management_quotes_v1(integer)
  to service_role;
grant execute on function public.reopen_ticket_management_request_v1(
  uuid, text, integer, text, text
) to service_role;
grant execute on function public.assign_ticket_management_settlement_v1(
  uuid, text, text, integer, text, text
) to service_role;

comment on function public.decide_ticket_management_quote_v1(
  uuid, uuid, text, text, integer, text, text
) is
  'Customer decision boundary for credit/none quotations. Debit approval remains blocked until request-scoped wallet Hold support is added.';

comment on column public.ticket_management_quotes.supplier_gross_amount is
  'Selected-ticket supplier Gross Fare audit fact. Never used to calculate customer Refund or VOID wallet amounts.';
comment on column public.ticket_management_quotes.supplier_payable_amount is
  'Selected-ticket Supplier Payable audit/economic fact. Never used as the customer entitlement base.';
comment on column public.ticket_management_quotes.user_payable_entitlement_amount is
  'Authoritative selected-ticket User Payable entitlement. Refund/VOID customer calculations and entitlement consumption use this amount.';
comment on column public.ticket_management_quotes.airline_fee is
  'Airline/supplier fee applicable to the action; deducted from User Payable for Refund and added for Reissue.';
comment on column public.ticket_management_quotes.service_fee is
  'ShopOnTravels service fee, explicitly separate from supplier amounts and airline fees.';
comment on column public.ticket_management_quotes.customer_amount is
  'Final immutable customer wallet credit/debit approved by the customer.';
