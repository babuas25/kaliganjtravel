-- Request-scoped Ticket Management Hold/Capture/Release substrate.
--
-- This extends, but does not reuse or alter, the original booking reservation.
-- Debit quotation approval and its Hold are atomic. Final Capture/Release is
-- deliberately left to the action-specific settlement migrations.

alter table public.wallet_reservations
  add column ticket_management_request_id uuid
    references public.ticket_management_requests(id) on delete restrict;

alter table public.wallet_reservations
  drop constraint if exists wallet_reservations_check;
alter table public.wallet_reservations
  add constraint wallet_reservations_exactly_one_subject_check
  check (
    (booking_id is not null)::integer
    + (booking_attempt_id is not null)::integer
    + (ticket_management_request_id is not null)::integer = 1
  );

create unique index wallet_reservations_ticket_management_request_key
  on public.wallet_reservations(ticket_management_request_id)
  where ticket_management_request_id is not null;

alter table public.wallet_ledger_entries
  add column ticket_management_request_id uuid
    references public.ticket_management_requests(id) on delete restrict,
  add column ticket_management_quote_id uuid
    references public.ticket_management_quotes(id) on delete restrict;

alter table public.wallet_ledger_entries
  drop constraint if exists wallet_ledger_entries_transaction_type_check;
alter table public.wallet_ledger_entries
  add constraint wallet_ledger_entries_transaction_type_check
  check (transaction_type in (
    'deposit', 'booking_hold', 'booking_confirm', 'hold_release', 'refund',
    'manual_credit', 'manual_debit', 'adjustment', 'reversal',
    'superadmin_resolution_credit',
    'superadmin_resolution_debit',
    'superadmin_resolution_hold_release',
    'superadmin_resolution_hold_capture',
    'ticket_management_hold',
    'ticket_management_capture',
    'ticket_management_release',
    'ticket_management_void_credit'
  ));

create index wallet_ledger_ticket_management_request_idx
  on public.wallet_ledger_entries(ticket_management_request_id, created_at desc, id)
  where ticket_management_request_id is not null;

alter table public.ticket_management_requests
  add column active_wallet_reservation_id uuid
    references public.wallet_reservations(id) on delete restrict,
  add column hold_ledger_entry_id uuid
    references public.wallet_ledger_entries(id) on delete restrict,
  add column capture_ledger_entry_id uuid
    references public.wallet_ledger_entries(id) on delete restrict,
  add column release_ledger_entry_id uuid
    references public.wallet_ledger_entries(id) on delete restrict,
  add column credit_ledger_entry_id uuid
    references public.wallet_ledger_entries(id) on delete restrict,
  add constraint ticket_management_requests_wallet_result_check
    check (
      capture_ledger_entry_id is null or release_ledger_entry_id is null
    );

create or replace function public.decide_ticket_management_quote_v2(
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
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_reservation public.wallet_reservations;
  v_ledger public.wallet_ledger_entries;
  v_available_before bigint;
  v_hold_before bigint;
  v_version integer;
begin
  if p_decision <> 'approved' then
    return public.decide_ticket_management_quote_v1(
      p_request_id, p_quote_id, p_decision, p_actor_user_id,
      p_expected_version, p_request_key, p_note
    );
  end if;
  select quote.* into v_quote
    from public.ticket_management_quotes quote
   where quote.id = p_quote_id and quote.request_id = p_request_id;
  if not found or v_quote.direction <> 'debit' then
    return public.decide_ticket_management_quote_v1(
      p_request_id, p_quote_id, p_decision, p_actor_user_id,
      p_expected_version, p_request_key, p_note
    );
  end if;
  if p_expected_version is null or p_expected_version < 1
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
       or v_existing.decision <> 'approved'
       or v_existing.decided_by_user_id is distinct from p_actor_user_id then
      return jsonb_build_object('ok', false, 'code', 'DECISION_IDEMPOTENCY_CONFLICT');
    end if;
    select request.* into v_request from public.ticket_management_requests request
     where request.id = p_request_id;
    return jsonb_build_object(
      'ok', true, 'replay', true, 'requestId', p_request_id,
      'decisionId', v_existing.id, 'status', v_request.status,
      'version', v_request.version,
      'reservationId', v_request.active_wallet_reservation_id,
      'ledgerEntryId', v_request.hold_ledger_entry_id
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
    or (v_actor.role in ('b2b', 'b2b_sub')
      and v_request.booking_owner_type = 'agency'
      and v_actor.agency_code = v_request.booking_owner_key)
  ) then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_OWNER_FORBIDDEN');
  end if;
  select quote.* into v_quote
    from public.ticket_management_quotes quote
   where quote.id = p_quote_id and quote.request_id = p_request_id
   for update;
  if v_quote.confirmation_deadline_at <= clock_timestamp() then
    update public.ticket_management_requests
       set status = 'expired', terminal_outcome = 'confirmation-expired',
           expired_at = clock_timestamp(), status_changed_at = clock_timestamp(),
           version = version + 1
     where id = v_request.id returning version into v_version;
    perform public.ticket_management_append_event_v1(
      v_request.id, 'confirmation-expired', 'awaiting-confirmation',
      'expired', v_version, 'system:ticket-management', 'system',
      'ticket-expire:' || v_request.id || ':' || v_quote.id,
      'Customer confirmation deadline passed',
      jsonb_build_object('quoteId', v_quote.id, 'deadline', v_quote.confirmation_deadline_at)
    );
    return jsonb_build_object('ok', false, 'code', 'QUOTE_EXPIRED',
      'requestId', v_request.id, 'status', 'expired', 'version', v_version);
  end if;

  perform entitlement.id
    from public.ticket_management_request_selections selection
    join public.ticket_management_ticket_entitlements entitlement
      on entitlement.id = selection.entitlement_id
   where selection.request_id = v_request.id
   order by entitlement.id for update of entitlement;
  if exists (
    select 1 from public.ticket_management_entitlement_claims claim
     where claim.request_id = v_request.id and claim.state <> 'active'
  ) then
    return jsonb_build_object('ok', false, 'code', 'ENTITLEMENT_CLAIM_INACTIVE');
  end if;
  if exists (
    select 1 from public.wallet_reservations reservation
     where reservation.ticket_management_request_id = v_request.id
       and reservation.state = 'active'
  ) then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_RESERVATION_CONFLICT');
  end if;

  select wallet.* into v_wallet
    from public.wallets wallet
    join public.wallet_accounts account on account.wallet_id = wallet.id
   where account.id = v_request.charged_wallet_account_id
   for update of wallet;
  if not found or v_wallet.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'OWNER_WALLET_UNAVAILABLE');
  end if;
  select account.* into v_account
    from public.wallet_accounts account
   where account.id = v_request.charged_wallet_account_id
   for update;
  if not found or v_account.currency <> v_request.currency
     or v_account.currency <> v_quote.currency then
    return jsonb_build_object('ok', false, 'code', 'OWNER_WALLET_CURRENCY_CONFLICT');
  end if;
  if v_account.available_balance < v_quote.customer_amount then
    return jsonb_build_object('ok', false, 'code', 'INSUFFICIENT_AVAILABLE_BALANCE');
  end if;

  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  update public.wallet_accounts
     set available_balance = available_balance - v_quote.customer_amount,
         hold_balance = hold_balance + v_quote.customer_amount
   where id = v_account.id;
  insert into public.wallet_reservations (
    wallet_account_id, ticket_management_request_id, amount, currency,
    state, requested_by_user_id
  ) values (
    v_account.id, v_request.id, v_quote.customer_amount, v_quote.currency,
    'active', p_actor_user_id
  ) returning * into v_reservation;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, reservation_id, ticket_management_request_id,
    ticket_management_quote_id, idempotency_key, created_by_user_id,
    created_by_role, remarks, metadata
  ) values (
    v_account.id, 'ticket_management_hold', v_quote.customer_amount,
    v_quote.currency, v_available_before,
    v_available_before - v_quote.customer_amount,
    v_hold_before, v_hold_before + v_quote.customer_amount,
    v_request.booking_id, v_reservation.id, v_request.id, v_quote.id,
    p_request_key || ':hold', p_actor_user_id, v_actor.role,
    'Ticket Management customer-approved additional payment Hold',
    jsonb_build_object('action', v_request.action, 'quoteHash', v_quote.quote_hash)
  ) returning * into v_ledger;
  insert into public.ticket_management_customer_decisions (
    request_id, quote_id, decision, quote_version, quote_hash, request_key,
    decided_by_user_id, decided_by_role, note
  ) values (
    v_request.id, v_quote.id, 'approved', v_quote.quote_version,
    v_quote.quote_hash, p_request_key, p_actor_user_id, v_actor.role,
    nullif(btrim(p_note), '')
  ) returning * into v_decision;
  update public.ticket_management_requests
     set status = 'approved', approved_quote_id = v_quote.id,
         approved_at = clock_timestamp(), status_changed_at = clock_timestamp(),
         active_wallet_reservation_id = v_reservation.id,
         hold_ledger_entry_id = v_ledger.id, version = version + 1
   where id = v_request.id returning version into v_version;
  perform public.ticket_management_append_event_v1(
    v_request.id, 'wallet-held', 'awaiting-confirmation', 'approved', v_version,
    p_actor_user_id, v_actor.role, p_request_key || ':hold:event', null,
    jsonb_build_object('quoteId', v_quote.id, 'reservationId', v_reservation.id,
      'ledgerEntryId', v_ledger.id, 'amount', v_quote.customer_amount)
  );
  perform public.ticket_management_append_event_v1(
    v_request.id, 'customer-approved', 'awaiting-confirmation', 'approved', v_version,
    p_actor_user_id, v_actor.role, p_request_key || ':event', p_note,
    jsonb_build_object('quoteId', v_quote.id, 'quoteHash', v_quote.quote_hash,
      'reservationId', v_reservation.id, 'ledgerEntryId', v_ledger.id)
  );
  return jsonb_build_object(
    'ok', true, 'replay', false, 'requestId', v_request.id,
    'decisionId', v_decision.id, 'status', 'approved', 'version', v_version,
    'reservationId', v_reservation.id, 'ledgerEntryId', v_ledger.id
  );
end;
$$;

create or replace function public.ticket_management_capture_hold_v1(
  p_request_id uuid,
  p_actor_user_id text,
  p_request_key text
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
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_existing public.wallet_ledger_entries;
  v_ledger public.wallet_ledger_entries;
  v_available_before bigint;
  v_hold_before bigint;
  v_version integer;
begin
  if nullif(btrim(p_request_key), '') is null then
    raise exception 'wallet capture request key is required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  select ledger.* into v_existing from public.wallet_ledger_entries ledger
   where ledger.idempotency_key = p_request_key;
  if found then
    if v_existing.transaction_type <> 'ticket_management_capture'
       or v_existing.ticket_management_request_id is distinct from p_request_id then
      return jsonb_build_object('ok', false, 'code', 'WALLET_IDEMPOTENCY_CONFLICT');
    end if;
    return jsonb_build_object('ok', true, 'replay', true,
      'ledgerEntryId', v_existing.id, 'requestId', p_request_id);
  end if;
  select role into v_actor_role from public.app_users where clerk_id = p_actor_user_id;
  if v_actor_role not in ('staff_account', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'FINAL_SETTLEMENT_FORBIDDEN');
  end if;
  select request.* into v_request from public.ticket_management_requests request
   where request.id = p_request_id for update;
  if not found or v_request.status <> 'approved'
     or v_request.active_assignee_user_id is distinct from p_actor_user_id
     or v_request.active_assignee_role is distinct from v_actor_role
     or v_request.approved_quote_id is null
     or v_request.active_wallet_reservation_id is null then
    return jsonb_build_object('ok', false, 'code', 'FINAL_SETTLEMENT_NOT_AUTHORIZED');
  end if;
  select quote.* into strict v_quote from public.ticket_management_quotes quote
   where quote.id = v_request.approved_quote_id and quote.direction = 'debit';
  select reservation.* into v_reservation from public.wallet_reservations reservation
   where reservation.id = v_request.active_wallet_reservation_id
     and reservation.ticket_management_request_id = v_request.id
   for update;
  if not found or v_reservation.state <> 'active'
     or v_reservation.amount <> v_quote.customer_amount
     or v_reservation.wallet_account_id <> v_request.charged_wallet_account_id then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_HOLD_NOT_CAPTURABLE');
  end if;
  select wallet.* into v_wallet from public.wallets wallet
    join public.wallet_accounts account on account.wallet_id = wallet.id
   where account.id = v_request.charged_wallet_account_id for update of wallet;
  select account.* into strict v_account from public.wallet_accounts account
   where account.id = v_request.charged_wallet_account_id for update;
  if v_wallet.status <> 'active' or v_account.currency <> v_quote.currency
     or v_account.hold_balance < v_reservation.amount then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_HOLD_BALANCE_CONFLICT');
  end if;
  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  update public.wallet_accounts set hold_balance = hold_balance - v_reservation.amount
   where id = v_account.id;
  update public.wallet_reservations
     set state = 'captured', captured_at = clock_timestamp(),
         issued_by_user_id = p_actor_user_id
   where id = v_reservation.id;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, reservation_id, ticket_management_request_id,
    ticket_management_quote_id, idempotency_key, created_by_user_id,
    created_by_role, remarks, metadata
  ) values (
    v_account.id, 'ticket_management_capture', v_reservation.amount,
    v_quote.currency, v_available_before, v_available_before,
    v_hold_before, v_hold_before - v_reservation.amount,
    v_request.booking_id, v_reservation.id, v_request.id, v_quote.id,
    p_request_key, p_actor_user_id, v_actor_role,
    'Ticket Management approved additional payment captured',
    jsonb_build_object('action', v_request.action, 'quoteHash', v_quote.quote_hash)
  ) returning * into v_ledger;
  update public.ticket_management_requests
     set capture_ledger_entry_id = v_ledger.id, version = version + 1
   where id = v_request.id returning version into v_version;
  perform public.ticket_management_append_event_v1(
    v_request.id, 'wallet-captured', 'approved', 'approved', v_version,
    p_actor_user_id, v_actor_role, p_request_key || ':event', null,
    jsonb_build_object('reservationId', v_reservation.id,
      'ledgerEntryId', v_ledger.id, 'amount', v_reservation.amount)
  );
  return jsonb_build_object('ok', true, 'replay', false,
    'requestId', v_request.id, 'ledgerEntryId', v_ledger.id,
    'reservationId', v_reservation.id, 'version', v_version);
end;
$$;

create or replace function public.ticket_management_release_hold_v1(
  p_request_id uuid,
  p_actor_user_id text,
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
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_existing public.wallet_ledger_entries;
  v_ledger public.wallet_ledger_entries;
  v_available_before bigint;
  v_hold_before bigint;
  v_version integer;
begin
  if nullif(btrim(p_request_key), '') is null or nullif(btrim(p_reason), '') is null then
    raise exception 'wallet release request key and reason are required' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  select ledger.* into v_existing from public.wallet_ledger_entries ledger
   where ledger.idempotency_key = p_request_key;
  if found then
    if v_existing.transaction_type <> 'ticket_management_release'
       or v_existing.ticket_management_request_id is distinct from p_request_id then
      return jsonb_build_object('ok', false, 'code', 'WALLET_IDEMPOTENCY_CONFLICT');
    end if;
    return jsonb_build_object('ok', true, 'replay', true,
      'ledgerEntryId', v_existing.id, 'requestId', p_request_id);
  end if;
  select role into v_actor_role from public.app_users where clerk_id = p_actor_user_id;
  if v_actor_role not in ('staff_account', 'admin', 'superadmin') then
    return jsonb_build_object('ok', false, 'code', 'FINAL_SETTLEMENT_FORBIDDEN');
  end if;
  select request.* into v_request from public.ticket_management_requests request
   where request.id = p_request_id for update;
  if not found or v_request.status <> 'approved'
     or v_request.active_assignee_user_id is distinct from p_actor_user_id
     or v_request.active_assignee_role is distinct from v_actor_role
     or v_request.active_wallet_reservation_id is null then
    return jsonb_build_object('ok', false, 'code', 'FINAL_SETTLEMENT_NOT_AUTHORIZED');
  end if;
  select quote.* into strict v_quote from public.ticket_management_quotes quote
   where quote.id = v_request.approved_quote_id and quote.direction = 'debit';
  select reservation.* into v_reservation from public.wallet_reservations reservation
   where reservation.id = v_request.active_wallet_reservation_id
     and reservation.ticket_management_request_id = v_request.id for update;
  if not found or v_reservation.state <> 'active'
     or v_reservation.amount <> v_quote.customer_amount then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_HOLD_NOT_RELEASABLE');
  end if;
  select wallet.* into v_wallet from public.wallets wallet
    join public.wallet_accounts account on account.wallet_id = wallet.id
   where account.id = v_request.charged_wallet_account_id for update of wallet;
  select account.* into strict v_account from public.wallet_accounts account
   where account.id = v_request.charged_wallet_account_id for update;
  if v_wallet.status <> 'active' or v_account.currency <> v_quote.currency
     or v_account.hold_balance < v_reservation.amount then
    return jsonb_build_object('ok', false, 'code', 'REQUEST_HOLD_BALANCE_CONFLICT');
  end if;
  v_available_before := v_account.available_balance;
  v_hold_before := v_account.hold_balance;
  update public.wallet_accounts
     set available_balance = available_balance + v_reservation.amount,
         hold_balance = hold_balance - v_reservation.amount
   where id = v_account.id;
  update public.wallet_reservations
     set state = 'released', released_at = clock_timestamp(),
         release_reason = p_reason, issued_by_user_id = p_actor_user_id
   where id = v_reservation.id;
  insert into public.wallet_ledger_entries (
    wallet_account_id, transaction_type, amount, currency,
    available_before, available_after, hold_before, hold_after,
    booking_id, reservation_id, ticket_management_request_id,
    ticket_management_quote_id, idempotency_key, created_by_user_id,
    created_by_role, remarks, metadata
  ) values (
    v_account.id, 'ticket_management_release', v_reservation.amount,
    v_quote.currency, v_available_before, v_available_before + v_reservation.amount,
    v_hold_before, v_hold_before - v_reservation.amount,
    v_request.booking_id, v_reservation.id, v_request.id, v_quote.id,
    p_request_key, p_actor_user_id, v_actor_role,
    'Ticket Management approved additional payment Hold released',
    jsonb_build_object('action', v_request.action, 'quoteHash', v_quote.quote_hash,
      'reason', p_reason)
  ) returning * into v_ledger;
  update public.ticket_management_requests
     set release_ledger_entry_id = v_ledger.id, version = version + 1
   where id = v_request.id returning version into v_version;
  perform public.ticket_management_append_event_v1(
    v_request.id, 'wallet-released', 'approved', 'approved', v_version,
    p_actor_user_id, v_actor_role, p_request_key || ':event', p_reason,
    jsonb_build_object('reservationId', v_reservation.id,
      'ledgerEntryId', v_ledger.id, 'amount', v_reservation.amount)
  );
  return jsonb_build_object('ok', true, 'replay', false,
    'requestId', v_request.id, 'ledgerEntryId', v_ledger.id,
    'reservationId', v_reservation.id, 'version', v_version);
end;
$$;

revoke execute on function public.decide_ticket_management_quote_v1(
  uuid, uuid, text, text, integer, text, text
) from service_role;
revoke all on function public.decide_ticket_management_quote_v2(
  uuid, uuid, text, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.decide_ticket_management_quote_v2(
  uuid, uuid, text, text, integer, text, text
) to service_role;
revoke all on function public.ticket_management_capture_hold_v1(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.ticket_management_release_hold_v1(uuid, text, text, text)
  from public, anon, authenticated, service_role;

comment on function public.decide_ticket_management_quote_v2(
  uuid, uuid, text, text, integer, text, text
) is
  'Customer decision boundary. Debit approval atomically places a request-scoped Hold on the original booking owner wallet; all other decisions retain v1 semantics.';
