-- Assigned Refund final settlement.
-- The selected User Payable ticket entitlement is consumed, while only the immutable
-- customer-approved net amount is credited to the original booking account.

create or replace function public.complete_ticket_management_refund_v1(
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
  v_existing_event public.ticket_management_request_events;
  v_ledger public.wallet_ledger_entries;
  v_selected_remaining bigint;
  v_version integer;
begin
  if p_expected_version is null or p_expected_version < 1
     or nullif(btrim(p_request_key), '') is null then
    raise exception 'invalid Refund settlement request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_key, 0));
  select event.* into v_existing_event
    from public.ticket_management_request_events event
   where event.idempotency_key = p_request_key || ':completed';
  if found then
    if v_existing_event.request_id is distinct from p_request_id then
      return jsonb_build_object('ok', false, 'code', 'SETTLEMENT_IDEMPOTENCY_CONFLICT');
    end if;
    select request.* into v_request from public.ticket_management_requests request
     where request.id = p_request_id;
    return jsonb_build_object('ok', true, 'replay', true,
      'requestId', p_request_id, 'status', v_request.status,
      'version', v_request.version, 'ledgerEntryId', v_request.credit_ledger_entry_id);
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
  if v_request.action <> 'refund' or v_request.status <> 'approved'
     or v_request.active_assignee_user_id is distinct from p_actor_user_id
     or v_request.active_assignee_role is distinct from v_actor_role
     or v_request.approved_quote_id is null then
    return jsonb_build_object('ok', false, 'code', 'REFUND_SETTLEMENT_NOT_AUTHORIZED');
  end if;
  select quote.* into v_quote from public.ticket_management_quotes quote
   where quote.id = v_request.approved_quote_id and quote.request_id = v_request.id
   for update;
  if not found or v_quote.direction not in ('credit', 'none')
     or v_quote.selection_hash is distinct from v_request.selection_hash then
    return jsonb_build_object('ok', false, 'code', 'APPROVED_REFUND_QUOTE_INVALID');
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
    return jsonb_build_object('ok', false, 'code', 'REFUND_ENTITLEMENT_CONFLICT');
  end if;

  if v_quote.direction = 'credit' then
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
      v_account.id, 'refund', v_quote.customer_amount, v_quote.currency,
      v_account.available_balance, v_account.available_balance + v_quote.customer_amount,
      v_account.hold_balance, v_account.hold_balance, v_booking.id, null,
      v_request.id, v_quote.id, p_request_key || ':refund',
      p_actor_user_id, v_actor_role,
      coalesce(nullif(btrim(p_note), ''), 'Ticket Management approved Refund credit'),
      jsonb_build_object('quoteHash', v_quote.quote_hash,
        'supplierGrossAmount', v_quote.supplier_gross_amount,
        'supplierPayableAmount', v_quote.supplier_payable_amount,
        'userPayableEntitlementConsumed', v_quote.user_payable_entitlement_amount,
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
  end if;

  update public.ticket_management_ticket_entitlements entitlement
     set consumed_amount = entitlement.entitlement_amount, state = 'refunded'
    from public.ticket_management_request_selections selection
   where selection.request_id = v_request.id
     and selection.entitlement_id = entitlement.id;
  update public.ticket_management_entitlement_claims
     set state = 'consumed', consumed_at = clock_timestamp()
   where request_id = v_request.id and state = 'active';
  update public.ticket_management_requests
     set status = 'completed', terminal_outcome = 'refunded',
         completed_at = clock_timestamp(), status_changed_at = clock_timestamp(),
         credit_ledger_entry_id = v_ledger.id, version = version + 1
   where id = v_request.id returning version into v_version;
  if v_ledger.id is not null then
    perform public.ticket_management_append_event_v1(
      v_request.id, 'wallet-credited', 'approved', 'completed', v_version,
      p_actor_user_id, v_actor_role, p_request_key || ':credit', p_note,
      jsonb_build_object('ledgerEntryId', v_ledger.id,
        'amount', v_quote.customer_amount,
        'userPayableEntitlementConsumed', v_quote.user_payable_entitlement_amount)
    );
  end if;
  perform public.ticket_management_append_event_v1(
    v_request.id, 'completed', 'approved', 'completed', v_version,
    p_actor_user_id, v_actor_role, p_request_key || ':completed', p_note,
    jsonb_build_object('outcome', 'refunded', 'quoteId', v_quote.id,
      'ledgerEntryId', v_ledger.id,
      'supplierGrossAmount', v_quote.supplier_gross_amount,
      'supplierPayableAmount', v_quote.supplier_payable_amount,
      'userPayableEntitlementConsumed', v_quote.user_payable_entitlement_amount,
      'netCustomerCredit', v_quote.customer_amount)
  );
  return jsonb_build_object('ok', true, 'replay', false,
    'requestId', v_request.id, 'status', 'completed', 'outcome', 'refunded',
    'version', v_version, 'ledgerEntryId', v_ledger.id,
    'creditedAmount', v_quote.customer_amount,
    'consumedEntitlementAmount', v_quote.user_payable_entitlement_amount);
end;
$$;

revoke all on function public.complete_ticket_management_refund_v1(
  uuid, text, integer, text, text
) from public, anon, authenticated;
grant execute on function public.complete_ticket_management_refund_v1(
  uuid, text, integer, text, text
) to service_role;

comment on function public.complete_ticket_management_refund_v1(
  uuid, text, integer, text, text
) is
  'Assigned Accounts/Admin/Superadmin Refund completion. Atomically consumes selected User Payable entitlement, credits only the immutable approved final customer amount to the original charged account, and completes the request.';
