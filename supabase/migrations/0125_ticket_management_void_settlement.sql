-- Assigned VOID settlement.
--
-- Net-return VOID credits the immutable approved amount to the original booking
-- owner wallet. Payable VOID captures the request-scoped approved Hold. Both
-- paths consume selected User Payable ticket entitlement atomically and remain
-- independent from held-booking cancellation/release functions.

create table public.ticket_management_void_completions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique
    references public.ticket_management_requests(id) on delete restrict,
  quote_id uuid not null unique
    references public.ticket_management_quotes(id) on delete restrict,
  request_key text not null unique
    check (char_length(request_key) between 1 and 180),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  direction text not null check (direction in ('credit', 'debit', 'none')),
  supplier_gross_amount bigint not null check (supplier_gross_amount > 0),
  supplier_payable_amount bigint not null check (supplier_payable_amount > 0),
  user_payable_entitlement_amount bigint not null
    check (user_payable_entitlement_amount > 0),
  airline_void_fee_amount bigint not null check (airline_void_fee_amount >= 0),
  service_fee_amount bigint not null check (service_fee_amount >= 0),
  customer_amount bigint not null check (customer_amount >= 0),
  credit_ledger_entry_id uuid
    references public.wallet_ledger_entries(id) on delete restrict,
  capture_ledger_entry_id uuid
    references public.wallet_ledger_entries(id) on delete restrict,
  finalized_by_user_id text not null,
  finalized_by_role text not null
    check (finalized_by_role in ('staff_account', 'admin', 'superadmin')),
  note text check (note is null or char_length(note) <= 2000),
  finalized_at timestamptz not null default clock_timestamp(),
  constraint ticket_management_void_completion_amount_check
    check (
      (direction = 'credit'
        and user_payable_entitlement_amount
          > airline_void_fee_amount + service_fee_amount
        and customer_amount = user_payable_entitlement_amount
          - airline_void_fee_amount - service_fee_amount)
      or (direction = 'debit'
        and user_payable_entitlement_amount
          < airline_void_fee_amount + service_fee_amount
        and customer_amount = airline_void_fee_amount + service_fee_amount
          - user_payable_entitlement_amount)
      or (direction = 'none'
        and user_payable_entitlement_amount
          = airline_void_fee_amount + service_fee_amount
        and customer_amount = 0)
    ),
  constraint ticket_management_void_completion_ledger_check
    check (
      (direction = 'credit'
        and credit_ledger_entry_id is not null
        and capture_ledger_entry_id is null)
      or (direction = 'debit'
        and credit_ledger_entry_id is null
        and capture_ledger_entry_id is not null)
      or (direction = 'none'
        and credit_ledger_entry_id is null
        and capture_ledger_entry_id is null)
    )
);

create index ticket_management_void_completions_finalizer_idx
  on public.ticket_management_void_completions(
    finalized_by_user_id, finalized_at desc, id
  );

create trigger ticket_management_void_completions_deny_update_delete
  before update or delete on public.ticket_management_void_completions
  for each row execute function public.prevent_ticket_management_audit_mutation_v1();

create or replace function public.complete_ticket_management_void_v1(
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
  v_actor_role text;
  v_request_hint public.ticket_management_requests;
  v_request public.ticket_management_requests;
  v_booking public.flight_bookings;
  v_quote public.ticket_management_quotes;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_existing public.ticket_management_void_completions;
  v_completion public.ticket_management_void_completions;
  v_ledger public.wallet_ledger_entries;
  v_capture_result jsonb;
  v_capture_ledger_id uuid;
  v_payload_hash text;
  v_selected_remaining bigint;
  v_version integer;
begin
  if p_expected_version is null or p_expected_version < 1
     or nullif(btrim(p_request_key), '') is null
     or char_length(p_request_key) > 180
     or (p_note is not null and char_length(p_note) > 2000) then
    raise exception 'invalid VOID settlement request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  select completion.* into v_existing
    from public.ticket_management_void_completions completion
   where completion.request_key = p_request_key
   for update;
  if found then
    v_payload_hash := encode(sha256(convert_to(jsonb_build_object(
      'requestId', p_request_id, 'quoteId', v_existing.quote_id,
      'note', nullif(btrim(p_note), '')
    )::text, 'UTF8')), 'hex');
    if v_existing.request_id is distinct from p_request_id
       or v_existing.payload_hash is distinct from v_payload_hash
       or v_existing.finalized_by_user_id is distinct from p_actor_user_id then
      return jsonb_build_object('ok', false, 'code', 'VOID_COMPLETION_IDEMPOTENCY_CONFLICT');
    end if;
    select request.* into v_request from public.ticket_management_requests request
     where request.id = p_request_id;
    return jsonb_build_object('ok', true, 'replay', true,
      'requestId', p_request_id, 'completionId', v_existing.id,
      'status', v_request.status, 'version', v_request.version,
      'direction', v_existing.direction,
      'ledgerEntryId', coalesce(
        v_existing.credit_ledger_entry_id, v_existing.capture_ledger_entry_id
      ));
  end if;
  select completion.* into v_existing
    from public.ticket_management_void_completions completion
   where completion.request_id = p_request_id;
  if found then
    return jsonb_build_object('ok', false, 'code', 'VOID_ALREADY_COMPLETED');
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
  if v_request.action <> 'void' or v_request.status <> 'approved'
     or v_request.active_assignee_user_id is distinct from p_actor_user_id
     or v_request.active_assignee_role is distinct from v_actor_role
     or v_request.approved_quote_id is null then
    return jsonb_build_object('ok', false, 'code', 'VOID_SETTLEMENT_NOT_AUTHORIZED');
  end if;
  select quote.* into v_quote from public.ticket_management_quotes quote
   where quote.id = v_request.approved_quote_id and quote.request_id = v_request.id
   for update;
  if not found or v_quote.direction not in ('credit', 'debit', 'none')
     or v_quote.selection_hash is distinct from v_request.selection_hash
     or v_quote.fare_difference <> 0 or v_quote.airline_fee <> 0
     or (
       v_quote.direction = 'credit'
       and (
         v_quote.user_payable_entitlement_amount
           <= v_quote.void_fee + v_quote.service_fee
         or v_quote.customer_amount <> v_quote.user_payable_entitlement_amount
           - v_quote.void_fee - v_quote.service_fee
       )
     ) or (
       v_quote.direction = 'debit'
       and (
         v_quote.user_payable_entitlement_amount
           >= v_quote.void_fee + v_quote.service_fee
         or v_quote.customer_amount <> v_quote.void_fee + v_quote.service_fee
           - v_quote.user_payable_entitlement_amount
       )
     ) or (
       v_quote.direction = 'none'
       and (
         v_quote.user_payable_entitlement_amount
           <> v_quote.void_fee + v_quote.service_fee
         or v_quote.customer_amount <> 0
       )
     ) then
    return jsonb_build_object('ok', false, 'code', 'APPROVED_VOID_QUOTE_INVALID');
  end if;
  if v_booking.charged_wallet_account_id is distinct from v_request.charged_wallet_account_id
     or v_booking.booking_owner_type is distinct from v_request.booking_owner_type
     or v_booking.booking_owner_key is distinct from v_request.booking_owner_key
     or upper(v_booking.currency) <> v_request.currency
     or v_booking.payment_state not in ('captured', 'partially-refunded') then
    return jsonb_build_object('ok', false, 'code', 'ORIGINAL_BOOKING_WALLET_CONFLICT');
  end if;

  perform entitlement.id
    from public.ticket_management_request_selections selection
    join public.ticket_management_ticket_entitlements entitlement
      on entitlement.id = selection.entitlement_id
   where selection.request_id = v_request.id
   order by entitlement.id for update of entitlement;
  select coalesce(sum(entitlement.entitlement_amount - entitlement.consumed_amount), 0)
    into v_selected_remaining
    from public.ticket_management_request_selections selection
    join public.ticket_management_ticket_entitlements entitlement
      on entitlement.id = selection.entitlement_id
    join public.ticket_management_entitlement_claims claim
      on claim.request_id = selection.request_id
     and claim.entitlement_id = selection.entitlement_id
   where selection.request_id = v_request.id
     and entitlement.state = 'active' and claim.state = 'active';
  if v_selected_remaining <> v_quote.user_payable_entitlement_amount then
    return jsonb_build_object('ok', false, 'code', 'VOID_ENTITLEMENT_CONFLICT');
  end if;

  if v_quote.direction = 'credit' then
    if v_request.active_wallet_reservation_id is not null then
      return jsonb_build_object('ok', false, 'code', 'VOID_CREDIT_RESERVATION_CONFLICT');
    end if;
    select wallet.* into v_wallet from public.wallets wallet
      join public.wallet_accounts account on account.wallet_id = wallet.id
     where account.id = v_request.charged_wallet_account_id for update of wallet;
    select account.* into v_account from public.wallet_accounts account
     where account.id = v_request.charged_wallet_account_id for update;
    if not found or v_account.currency <> v_quote.currency then
      return jsonb_build_object('ok', false, 'code', 'ORIGINAL_WALLET_CURRENCY_CONFLICT');
    end if;
    insert into public.wallet_ledger_entries (
      wallet_account_id, transaction_type, amount, currency,
      available_before, available_after, hold_before, hold_after,
      booking_id, reservation_id, ticket_management_request_id,
      ticket_management_quote_id, idempotency_key, created_by_user_id,
      created_by_role, remarks, metadata
    ) values (
      v_account.id, 'ticket_management_void_credit', v_quote.customer_amount,
      v_quote.currency, v_account.available_balance,
      v_account.available_balance + v_quote.customer_amount,
      v_account.hold_balance, v_account.hold_balance, v_booking.id, null,
      v_request.id, v_quote.id, p_request_key || ':credit',
      p_actor_user_id, v_actor_role,
      coalesce(nullif(btrim(p_note), ''), 'Ticket Management approved VOID credit'),
      jsonb_build_object('quoteHash', v_quote.quote_hash,
        'supplierGrossAmount', v_quote.supplier_gross_amount,
        'supplierPayableAmount', v_quote.supplier_payable_amount,
        'userPayableEntitlementConsumed', v_quote.user_payable_entitlement_amount,
        'airlineVoidFeeAmount', v_quote.void_fee,
        'serviceFeeAmount', v_quote.service_fee,
        'netCustomerCredit', v_quote.customer_amount)
    ) returning * into v_ledger;
    update public.wallet_accounts
       set available_balance = available_balance + v_quote.customer_amount
     where id = v_account.id;
    update public.flight_bookings
       set refunded_amount = refunded_amount + v_quote.customer_amount,
           payment_state = case
             when refunded_amount + v_quote.customer_amount = captured_amount
               then 'refunded' else 'partially-refunded' end
     where id = v_booking.id;
  elsif v_quote.direction = 'debit' then
    v_capture_result := public.ticket_management_capture_hold_v1(
      v_request.id, p_actor_user_id, p_request_key || ':capture'
    );
    if not coalesce((v_capture_result->>'ok')::boolean, false) then
      return v_capture_result;
    end if;
    v_capture_ledger_id := (v_capture_result->>'ledgerEntryId')::uuid;
    update public.flight_bookings
       set captured_amount = captured_amount + v_quote.customer_amount
     where id = v_booking.id;
  elsif v_request.active_wallet_reservation_id is not null then
    return jsonb_build_object('ok', false, 'code', 'VOID_ZERO_TOTAL_RESERVATION_CONFLICT');
  end if;

  v_payload_hash := encode(sha256(convert_to(jsonb_build_object(
    'requestId', v_request.id, 'quoteId', v_quote.id,
    'note', nullif(btrim(p_note), '')
  )::text, 'UTF8')), 'hex');
  insert into public.ticket_management_void_completions (
    request_id, quote_id, request_key, payload_hash, direction,
    supplier_gross_amount, supplier_payable_amount,
    user_payable_entitlement_amount, airline_void_fee_amount,
    service_fee_amount, customer_amount, credit_ledger_entry_id,
    capture_ledger_entry_id, finalized_by_user_id, finalized_by_role, note
  ) values (
    v_request.id, v_quote.id, p_request_key, v_payload_hash, v_quote.direction,
    v_quote.supplier_gross_amount, v_quote.supplier_payable_amount,
    v_quote.user_payable_entitlement_amount, v_quote.void_fee,
    v_quote.service_fee, v_quote.customer_amount, v_ledger.id,
    v_capture_ledger_id, p_actor_user_id, v_actor_role,
    nullif(btrim(p_note), '')
  ) returning * into v_completion;
  update public.ticket_management_ticket_entitlements entitlement
     set consumed_amount = entitlement.entitlement_amount, state = 'voided'
    from public.ticket_management_request_selections selection
   where selection.request_id = v_request.id
     and selection.entitlement_id = entitlement.id;
  update public.ticket_management_entitlement_claims
     set state = 'consumed', consumed_at = clock_timestamp()
   where request_id = v_request.id and state = 'active';
  update public.ticket_management_requests
     set status = 'completed', terminal_outcome = 'voided',
         completed_at = clock_timestamp(), status_changed_at = clock_timestamp(),
         credit_ledger_entry_id = v_ledger.id, version = version + 1
   where id = v_request.id returning version into v_version;
  if v_ledger.id is not null then
    perform public.ticket_management_append_event_v1(
      v_request.id, 'wallet-credited', 'approved', 'completed', v_version,
      p_actor_user_id, v_actor_role, p_request_key || ':wallet-credit', p_note,
      jsonb_build_object('ledgerEntryId', v_ledger.id,
        'amount', v_quote.customer_amount,
        'userPayableEntitlementConsumed', v_quote.user_payable_entitlement_amount)
    );
  end if;
  perform public.ticket_management_append_event_v1(
    v_request.id, 'completed', 'approved', 'completed', v_version,
    p_actor_user_id, v_actor_role, p_request_key || ':completed', p_note,
    jsonb_build_object('outcome', 'voided', 'quoteId', v_quote.id,
      'completionId', v_completion.id, 'direction', v_quote.direction,
      'ledgerEntryId', coalesce(v_ledger.id, v_capture_ledger_id),
      'supplierGrossAmount', v_quote.supplier_gross_amount,
      'supplierPayableAmount', v_quote.supplier_payable_amount,
      'userPayableEntitlementConsumed', v_quote.user_payable_entitlement_amount,
      'airlineVoidFeeAmount', v_quote.void_fee,
      'serviceFeeAmount', v_quote.service_fee,
      'customerAmount', v_quote.customer_amount)
  );
  return jsonb_build_object('ok', true, 'replay', false,
    'requestId', v_request.id, 'completionId', v_completion.id,
    'status', 'completed', 'outcome', 'voided', 'version', v_version,
    'direction', v_quote.direction,
    'ledgerEntryId', coalesce(v_ledger.id, v_capture_ledger_id),
    'customerAmount', v_quote.customer_amount,
    'consumedEntitlementAmount', v_quote.user_payable_entitlement_amount);
end;
$$;

create or replace function public.release_and_reopen_ticket_management_void_v1(
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
    raise exception 'invalid VOID release/reopen request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  select event.* into v_existing_event
    from public.ticket_management_request_events event
   where event.idempotency_key = p_request_key || ':reopened';
  if found then
    if v_existing_event.request_id is distinct from p_request_id
       or v_existing_event.actor_user_id is distinct from p_actor_user_id
       or v_existing_event.note is distinct from nullif(btrim(p_reason), '') then
      return jsonb_build_object('ok', false, 'code', 'VOID_RELEASE_IDEMPOTENCY_CONFLICT');
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
  if v_request.action <> 'void' or v_request.status <> 'approved'
     or v_request.active_assignee_user_id is distinct from p_actor_user_id
     or v_request.active_assignee_role is distinct from v_actor_role
     or v_request.approved_quote_id is null then
    return jsonb_build_object('ok', false, 'code', 'VOID_RELEASE_NOT_AUTHORIZED');
  end if;
  select quote.* into v_quote from public.ticket_management_quotes quote
   where quote.id = v_request.approved_quote_id and quote.request_id = v_request.id
   for update;
  if not found or v_quote.direction <> 'debit' then
    return jsonb_build_object('ok', false, 'code', 'VOID_HOLD_NOT_PRESENT');
  end if;
  v_release_result := public.ticket_management_release_hold_v1(
    v_request.id, p_actor_user_id, p_request_key || ':release', p_reason
  );
  if not coalesce((v_release_result->>'ok')::boolean, false) then
    return v_release_result;
  end if;
  v_release_ledger_id := (v_release_result->>'ledgerEntryId')::uuid;
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
    jsonb_build_object('supersededQuoteId', v_quote.id,
      'supersededQuoteVersion', v_quote.quote_version,
      'supersededQuoteHash', v_quote.quote_hash,
      'previousAssignmentId', v_request.active_assignment_id,
      'releaseLedgerEntryId', v_release_ledger_id,
      'manualVoidPerformed', false)
  );
  return jsonb_build_object('ok', true, 'replay', false,
    'requestId', v_request.id, 'status', 'in-progress',
    'version', v_version, 'releasedAmount', v_quote.customer_amount,
    'ledgerEntryId', v_release_ledger_id,
    'supersededQuoteId', v_quote.id);
end;
$$;

alter table public.ticket_management_void_completions enable row level security;
revoke all on public.ticket_management_void_completions
  from public, anon, authenticated;
grant select, insert on public.ticket_management_void_completions to service_role;

revoke all on function public.complete_ticket_management_void_v1(
  uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.complete_ticket_management_void_v1(
  uuid, text, integer, text, text
) to service_role;
revoke all on function public.release_and_reopen_ticket_management_void_v1(
  uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.release_and_reopen_ticket_management_void_v1(
  uuid, text, integer, text, text
) to service_role;

comment on function public.complete_ticket_management_void_v1(
  uuid, text, integer, text, text
) is
  'Assigned Accounts/Admin/Superadmin VOID completion. Atomically credits an approved net return or captures an approved additional-payment Hold on the original booking owner wallet, consumes ticket entitlement, and completes the request.';
comment on function public.release_and_reopen_ticket_management_void_v1(
  uuid, text, integer, text, text
) is
  'Assigned Accounts/Admin/Superadmin payable-VOID non-performance path. Atomically releases the request Hold and returns the request to In Progress for new quotation and customer approval.';
