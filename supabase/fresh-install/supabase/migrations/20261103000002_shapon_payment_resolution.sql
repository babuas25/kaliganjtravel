-- Derive ticket settlement from protected local accounting. Confirmed tickets
-- never release an existing hold, and a proven previous capture is never charged twice.
-- A separate, explicit Admin payment return never changes supplier/booking status.
begin;

alter table public.shapon_external_ticket_confirmations
  add column payment_effect text check (payment_effect in ('capture_hold','already_paid','charge_wallet')),
  add column original_capture_ledger_entry_id uuid references public.wallet_ledger_entries(id) on delete restrict;

-- Keep every previously committed decision immutable and replayable. Extend
-- only the allowed shape for a new confirmation reusing an original capture.
alter table public.shapon_external_ticket_confirmations
  drop constraint shapon_external_ticket_confirmations_settlement_check,
  drop constraint shapon_external_ticket_confirmations_check;
alter table public.shapon_external_ticket_confirmations
  add constraint shapon_external_ticket_confirmations_settlement_check
    check (settlement in ('owner_wallet','external_supplier_paid_no_wallet_charge','existing_owner_wallet_capture')),
  add constraint shapon_external_ticket_confirmations_payment_shape_check check (
    (charge_wallet and settlement='owner_wallet' and wallet_account_id is not null
      and reservation_id is not null and ledger_entry_id is not null
      and (payment_effect is null or payment_effect in ('capture_hold','charge_wallet')))
    or (not charge_wallet and settlement='external_supplier_paid_no_wallet_charge'
      and wallet_account_id is null and reservation_id is null and ledger_entry_id is null
      and payment_effect is null and original_capture_ledger_entry_id is null)
    or (charge_wallet and settlement='existing_owner_wallet_capture' and payment_effect='already_paid'
      and wallet_account_id is not null and ledger_entry_id is not null
      and original_capture_ledger_entry_id is not null and original_capture_ledger_entry_id=ledger_entry_id));

create table public.booking_payment_returns (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.flight_bookings(id) on delete restrict,
  request_id uuid not null unique,
  actor_user_id text not null,
  actor_role text not null check (actor_role in ('admin','superadmin')),
  reason text not null check (length(btrim(reason)) between 3 and 1000 and reason !~ '[[:cntrl:]]'),
  capture_ledger_entry_id uuid not null unique references public.wallet_ledger_entries(id) on delete restrict,
  refund_ledger_entry_id uuid not null unique references public.wallet_ledger_entries(id) on delete restrict,
  wallet_account_id uuid not null references public.wallet_accounts(id) on delete restrict,
  captured_amount bigint not null check (captured_amount>0),
  refunded_before bigint not null check (refunded_before>=0 and refunded_before<captured_amount),
  returned_amount bigint not null check (returned_amount>0 and returned_amount=captured_amount-refunded_before),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  available_before bigint not null check (available_before>=0),
  available_after bigint not null check (available_after=available_before+returned_amount),
  hold_balance bigint not null check (hold_balance>=0),
  booking_status_snapshot text not null,
  owner_type text not null check (owner_type in ('user','agency')),
  owner_key text not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.booking_payment_returns enable row level security;
revoke all on public.booking_payment_returns from public,anon,authenticated,service_role;
grant select on public.booking_payment_returns to service_role;
create function public.prevent_booking_payment_return_mutation_v1()
returns trigger language plpgsql set search_path=public as $$
begin raise exception 'booking payment return decisions are immutable' using errcode='55000'; end;
$$;
create trigger booking_payment_returns_immutable before update or delete on public.booking_payment_returns
  for each row execute function public.prevent_booking_payment_return_mutation_v1();
revoke all on function public.prevent_booking_payment_return_mutation_v1() from public,anon,authenticated,service_role;

-- This private read-only context follows the ORIGINAL capture amount, not a
-- later selling price. It can therefore safely return a mistaken-sized charge.
create function public.booking_payment_return_accounting_v1(p_booking_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_booking public.flight_bookings;
  v_capture public.wallet_ledger_entries;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_count integer;
  v_refunded bigint;
  v_hold_net bigint;
begin
  select * into v_booking from public.flight_bookings where id=p_booking_id;
  if not found then return jsonb_build_object('ok',false,'code','BOOKING_NOT_FOUND'); end if;
  if v_booking.booking_owner_type not in ('user','agency')
     or nullif(btrim(v_booking.booking_owner_key),'') is null
     or (v_booking.booking_owner_type='user' and (v_booking.audience<>'b2c'
       or v_booking.booking_owner_key is distinct from v_booking.user_id))
     or (v_booking.booking_owner_type='agency' and (v_booking.audience<>'agency'
       or v_booking.booking_owner_key is distinct from v_booking.agency_code)) then
    return jsonb_build_object('ok',false,'code','BOOKING_OWNER_REQUIRED');
  end if;
  select count(*) into v_count from public.wallet_ledger_entries
    where booking_id=p_booking_id and transaction_type='booking_confirm';
  if v_count=0 then return jsonb_build_object('ok',false,'code','NO_CAPTURED_PAYMENT'); end if;
  if v_count<>1 then return jsonb_build_object('ok',false,'code','MULTIPLE_CAPTURE_LEDGER_ENTRIES'); end if;
  select * into v_capture from public.wallet_ledger_entries
    where booking_id=p_booking_id and transaction_type='booking_confirm';
  if v_capture.amount<=0 or v_capture.amount>9007199254740991
     or v_capture.currency is distinct from v_booking.currency
     or not ((v_capture.available_before-v_capture.available_after=v_capture.amount
       and v_capture.hold_before=v_capture.hold_after)
       or (v_capture.available_before=v_capture.available_after
         and v_capture.hold_before-v_capture.hold_after=v_capture.amount)) then
    return jsonb_build_object('ok',false,'code','CAPTURE_ACCOUNTING_CONFLICT');
  end if;
  select count(*) into v_count from public.wallet_reservations
    where booking_id=p_booking_id or (booking_id is null and booking_attempt_id=v_booking.attempt_id);
  if v_count>1 then return jsonb_build_object('ok',false,'code','MULTIPLE_RESERVATIONS'); end if;
  select * into v_reservation from public.wallet_reservations
    where booking_id=p_booking_id or (booking_id is null and booking_attempt_id=v_booking.attempt_id);
  if (v_reservation.id is null and v_capture.reservation_id is not null)
     or (v_reservation.id is not null and (v_reservation.id is distinct from v_capture.reservation_id
       or v_reservation.state<>'captured' or v_reservation.amount<>v_capture.amount
       or v_reservation.currency<>v_capture.currency
       or v_reservation.wallet_account_id<>v_capture.wallet_account_id)) then
    return jsonb_build_object('ok',false,'code','CAPTURE_ACCOUNTING_CONFLICT');
  end if;
  select * into v_account from public.wallet_accounts where id=v_capture.wallet_account_id;
  if not found or v_account.currency is distinct from v_capture.currency then
    return jsonb_build_object('ok',false,'code','WALLET_ACCOUNT_NOT_FOUND');
  end if;
  select * into v_wallet from public.wallets where id=v_account.wallet_id;
  if not found or v_wallet.owner_type is distinct from v_booking.booking_owner_type
     or v_wallet.owner_key is distinct from v_booking.booking_owner_key then
    return jsonb_build_object('ok',false,'code','RESERVATION_ACCOUNT_CONFLICT');
  end if;
  -- A separate manual adjustment, servicing debit/credit or foreign reservation
  -- makes a simple full return ambiguous. Preserve those reviewed workflows.
  if exists(select 1 from public.wallet_ledger_entries ledger where ledger.booking_id=p_booking_id and (
       ledger.transaction_type not in ('booking_hold','hold_release','booking_confirm','refund')
       or ledger.wallet_account_id<>v_account.id or ledger.currency<>v_capture.currency
       or ledger.reservation_id is distinct from v_capture.reservation_id
       or (ledger.transaction_type='booking_hold' and (
         ledger.available_before-ledger.available_after<>ledger.amount
         or ledger.hold_after-ledger.hold_before<>ledger.amount))
       or (ledger.transaction_type='hold_release' and (
         ledger.available_after-ledger.available_before<>ledger.amount
         or ledger.hold_before-ledger.hold_after<>ledger.amount))
       or (ledger.transaction_type='refund' and (
         ledger.available_after-ledger.available_before<>ledger.amount or ledger.hold_before<>ledger.hold_after
         or (ledger.related_entry_id is not null and ledger.related_entry_id<>v_capture.id))))) then
    return jsonb_build_object('ok',false,'code','PAYMENT_ACCOUNTING_REVIEW_REQUIRED');
  end if;
  if v_reservation.id is not null then
    if exists(select 1 from public.wallet_ledger_entries ledger where ledger.reservation_id=v_reservation.id
       and ledger.booking_id is distinct from p_booking_id) then
      return jsonb_build_object('ok',false,'code','PAYMENT_ACCOUNTING_REVIEW_REQUIRED');
    end if;
    select coalesce(sum(case when transaction_type='booking_hold' then amount
      when transaction_type='hold_release' then -amount
      when transaction_type='booking_confirm' and hold_before-hold_after=amount then -amount else 0 end),0)
      into v_hold_net from public.wallet_ledger_entries where reservation_id=v_reservation.id;
    if v_hold_net<>0 then return jsonb_build_object('ok',false,'code','CAPTURE_ACCOUNTING_CONFLICT'); end if;
  end if;
  select coalesce(sum(amount),0) into v_refunded from public.wallet_ledger_entries
    where booking_id=p_booking_id and transaction_type='refund';
  if v_refunded>v_capture.amount or v_refunded<0
     or v_account.available_balance>9007199254740991-v_capture.amount+v_refunded
     or v_account.hold_balance>9007199254740991 then
    return jsonb_build_object('ok',false,'code','REFUND_ACCOUNTING_CONFLICT');
  end if;
  return jsonb_build_object('ok',true,'captureLedgerEntryId',v_capture.id,
    'reservationId',v_reservation.id,'walletAccountId',v_account.id,
    'capturedAmount',v_capture.amount,'refundedAmount',v_refunded,
    'refundableAmount',v_capture.amount-v_refunded,'currency',v_capture.currency,
    'availableBalance',v_account.available_balance,'holdBalance',v_account.hold_balance,
    'ownerType',v_wallet.owner_type,'ownerKey',v_wallet.owner_key,'bookingStatus',v_booking.status);
end;
$$;
revoke all on function public.booking_payment_return_accounting_v1(uuid) from public,anon,authenticated,service_role;

create function public.preview_booking_payment_return_v1(
  p_booking_id uuid,p_actor_user_id text,p_actor_role text
)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare v_role text; v_context jsonb;
begin
  select role into v_role from public.app_users where clerk_id=p_actor_user_id;
  if v_role is null or v_role not in ('admin','superadmin') then
    return jsonb_build_object('ok',false,'eligible',false,'code','PAYMENT_RETURN_FORBIDDEN');
  end if;
  if p_actor_role is distinct from v_role then
    return jsonb_build_object('ok',false,'eligible',false,'code','ACTOR_ROLE_MISMATCH');
  end if;
  v_context:=public.booking_payment_return_accounting_v1(p_booking_id);
  if v_context->>'ok' is distinct from 'true' then return v_context||jsonb_build_object('eligible',false); end if;
  return v_context||jsonb_build_object('eligible',(v_context->>'refundableAmount')::bigint>0,
    'code',case when (v_context->>'refundableAmount')::bigint=0 then 'ALREADY_REFUNDED' else null end);
end;
$$;
revoke all on function public.preview_booking_payment_return_v1(uuid,text,text) from public,anon,authenticated;
grant execute on function public.preview_booking_payment_return_v1(uuid,text,text) to service_role;

create function public.return_booking_payment_v1(
  p_booking_id uuid,p_actor_user_id text,p_actor_role text,p_request_id uuid,
  p_expected_capture_ledger_entry_id uuid,p_expected_refunded_amount bigint,
  p_expected_refundable_amount bigint,p_expected_available_balance bigint,
  p_expected_hold_balance bigint,p_confirmation boolean,p_reason text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_role text;
  v_booking public.flight_bookings;
  v_decision public.booking_payment_returns;
  v_context jsonb;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_return_id uuid:=gen_random_uuid();
  v_ledger_id uuid;
  v_amount bigint;
  v_captured bigint;
  v_refunded bigint;
  v_now timestamptz:=clock_timestamp();
begin
  select role into v_role from public.app_users where clerk_id=p_actor_user_id;
  if v_role is null or v_role not in ('admin','superadmin') then
    return jsonb_build_object('ok',false,'code','PAYMENT_RETURN_FORBIDDEN');
  end if;
  if p_actor_role is distinct from v_role then return jsonb_build_object('ok',false,'code','ACTOR_ROLE_MISMATCH'); end if;
  if p_booking_id is null or p_request_id is null or p_confirmation is distinct from true
     or p_reason is null or length(btrim(p_reason)) not between 3 and 1000 or p_reason ~ '[[:cntrl:]]'
     or p_expected_capture_ledger_entry_id is null or p_expected_refunded_amount is null
     or p_expected_refundable_amount is null or p_expected_available_balance is null or p_expected_hold_balance is null then
    return jsonb_build_object('ok',false,'code','PAYMENT_RETURN_CONFIRMATION_REQUIRED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('booking-payment-return:'||p_request_id::text,0));
  select * into v_booking from public.flight_bookings where id=p_booking_id for update;
  if not found then return jsonb_build_object('ok',false,'code','BOOKING_NOT_FOUND'); end if;
  select * into v_decision from public.booking_payment_returns where request_id=p_request_id;
  if found then
    if v_decision.booking_id is distinct from p_booking_id or v_decision.actor_user_id is distinct from p_actor_user_id
       or v_decision.actor_role is distinct from v_role or v_decision.reason is distinct from btrim(p_reason)
       or v_decision.capture_ledger_entry_id is distinct from p_expected_capture_ledger_entry_id
       or v_decision.refunded_before is distinct from p_expected_refunded_amount
       or v_decision.returned_amount is distinct from p_expected_refundable_amount
       or v_decision.available_before is distinct from p_expected_available_balance
       or v_decision.hold_balance is distinct from p_expected_hold_balance then
      return jsonb_build_object('ok',false,'code','PAYMENT_RETURN_REQUEST_CONFLICT');
    end if;
    return jsonb_build_object('ok',true,'replay',true,'returnDecisionId',v_decision.id,
      'captureLedgerEntryId',v_decision.capture_ledger_entry_id,'ledgerEntryId',v_decision.refund_ledger_entry_id,
      'returnedAmount',v_decision.returned_amount,'capturedAmount',v_decision.captured_amount,
      'refundedAmount',v_decision.captured_amount,'currency',v_decision.currency,
      'availableBalance',v_decision.available_after,'holdBalance',v_decision.hold_balance,'paymentState','refunded');
  end if;
  -- Global financial lock order is unchanged; operations and cases are locked
  -- for serialization only and their status/history is never modified here.
  for v_operation in select * from public.booking_operations where booking_id=p_booking_id order by id for update loop null; end loop;
  for v_case in select * from public.booking_reconciliation_cases
    where subject_booking_id=p_booking_id or subject_booking_attempt_id=v_booking.attempt_id order by id for update loop null; end loop;
  for v_reservation in select * from public.wallet_reservations
    where booking_id=p_booking_id or (booking_id is null and booking_attempt_id=v_booking.attempt_id) order by id for update loop null; end loop;
  v_context:=public.booking_payment_return_accounting_v1(p_booking_id);
  if v_context->>'ok' is distinct from 'true' then return v_context; end if;
  select wallet.* into v_wallet from public.wallets wallet join public.wallet_accounts account on account.wallet_id=wallet.id
    where account.id=(v_context->>'walletAccountId')::uuid for update of wallet;
  select * into v_account from public.wallet_accounts where id=(v_context->>'walletAccountId')::uuid for update;
  v_context:=public.booking_payment_return_accounting_v1(p_booking_id);
  if v_context->>'ok' is distinct from 'true' then return v_context; end if;
  v_amount:=(v_context->>'refundableAmount')::bigint;
  v_captured:=(v_context->>'capturedAmount')::bigint;
  v_refunded:=(v_context->>'refundedAmount')::bigint;
  if v_amount<=0 then return jsonb_build_object('ok',false,'code','ALREADY_REFUNDED'); end if;
  if v_context->>'captureLedgerEntryId' is distinct from p_expected_capture_ledger_entry_id::text
     or v_refunded is distinct from p_expected_refunded_amount or v_amount is distinct from p_expected_refundable_amount
     or v_account.available_balance is distinct from p_expected_available_balance
     or v_account.hold_balance is distinct from p_expected_hold_balance then
    return jsonb_build_object('ok',false,'code','PAYMENT_RETURN_PREVIEW_CHANGED');
  end if;
  if exists(select 1 from public.booking_payment_returns where capture_ledger_entry_id=p_expected_capture_ledger_entry_id) then
    return jsonb_build_object('ok',false,'code','ALREADY_REFUNDED');
  end if;
  -- Credits are permitted on a frozen wallet. No hold is fabricated or touched.
  update public.wallet_accounts set available_balance=available_balance+v_amount where id=v_account.id;
  insert into public.wallet_ledger_entries(wallet_account_id,transaction_type,amount,currency,
    available_before,available_after,hold_before,hold_after,booking_id,booking_reference,
    reservation_id,related_entry_id,idempotency_key,created_by_user_id,created_by_role,remarks,metadata)
  values(v_account.id,'refund',v_amount,v_account.currency,v_account.available_balance,v_account.available_balance+v_amount,
    v_account.hold_balance,v_account.hold_balance,p_booking_id,v_booking.public_ref,
    (v_context->>'reservationId')::uuid,p_expected_capture_ledger_entry_id,'booking-payment-return:'||p_request_id::text,
    p_actor_user_id,v_role,btrim(p_reason),jsonb_build_object('returnDecisionId',v_return_id,
      'captureLedgerEntryId',p_expected_capture_ledger_entry_id,'paymentReturn',true,
      'bookingStatusUnchanged',v_booking.status,'supplierApiCalled',false)) returning id into v_ledger_id;
  update public.flight_bookings set charged_wallet_account_id=v_account.id,payment_amount=v_captured,
    captured_amount=v_captured,refunded_amount=v_captured,payment_state='refunded' where id=p_booking_id;
  insert into public.booking_payment_returns(id,booking_id,request_id,actor_user_id,actor_role,reason,
    capture_ledger_entry_id,refund_ledger_entry_id,wallet_account_id,captured_amount,refunded_before,returned_amount,
    currency,available_before,available_after,hold_balance,booking_status_snapshot,owner_type,owner_key)
  values(v_return_id,p_booking_id,p_request_id,p_actor_user_id,v_role,btrim(p_reason),p_expected_capture_ledger_entry_id,
    v_ledger_id,v_account.id,v_captured,v_refunded,v_amount,v_account.currency,v_account.available_balance,
    v_account.available_balance+v_amount,v_account.hold_balance,v_booking.status,v_wallet.owner_type,v_wallet.owner_key);
  return jsonb_build_object('ok',true,'replay',false,'returnDecisionId',v_return_id,
    'captureLedgerEntryId',p_expected_capture_ledger_entry_id,'ledgerEntryId',v_ledger_id,
    'returnedAmount',v_amount,'capturedAmount',v_captured,'refundedAmount',v_captured,
    'currency',v_account.currency,'availableBalance',v_account.available_balance+v_amount,
    'holdBalance',v_account.hold_balance,'paymentState','refunded');
end;
$$;
revoke all on function public.return_booking_payment_v1(uuid,text,text,uuid,uuid,bigint,bigint,bigint,bigint,boolean,text)
  from public,anon,authenticated;
grant execute on function public.return_booking_payment_v1(uuid,text,text,uuid,uuid,bigint,bigint,bigint,bigint,boolean,text) to service_role;

-- Staff status Refresh uses this only after independent supplier booking and
-- ticket proofs. It is an eligibility/financial preview, never a money writer.
create function public.preview_shapon_ticket_payment_v1(
  p_booking_id uuid,p_actor_user_id text,p_actor_role text
)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare
  v_role text;
  v_booking public.flight_bookings;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_case_count integer:=0;
  v_recovery boolean;
  v_accounting jsonb;
  v_paid jsonb;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_amount bigint;
  v_effect text;
begin
  select role into v_role from public.app_users where clerk_id=p_actor_user_id;
  if v_role is null or v_role not in ('admin','superadmin') then
    return jsonb_build_object('ok',false,'eligible',false,'code','CONFIRMATION_FORBIDDEN');
  end if;
  if p_actor_role is distinct from v_role then return jsonb_build_object('ok',false,'eligible',false,'code','ACTOR_ROLE_MISMATCH'); end if;
  select * into v_booking from public.flight_bookings where id=p_booking_id;
  if not found then return jsonb_build_object('ok',false,'eligible',false,'code','BOOKING_NOT_FOUND'); end if;
  if v_booking.supplier is distinct from 'shapontravels' or v_booking.supplier_account is distinct from 'shapontravels'
     or v_booking.import_source is not null or v_booking.direct_ticketing or v_booking.legacy_operational
     or not public.booking_uses_saved_references(v_booking) then
    return jsonb_build_object('ok',false,'eligible',false,'code','SUPPLIER_BOOKING_UNSUPPORTED');
  end if;
  if exists(select 1 from public.shapon_external_ticket_confirmations where booking_id=p_booking_id)
     or v_booking.status in ('confirmed','cancelled') then
    return jsonb_build_object('ok',false,'eligible',false,'code','BOOKING_ALREADY_CONFIRMED');
  end if;
  v_recovery:=v_booking.status='in-progress' and v_booking.operation_kind='reconciliation'
    and v_booking.operation_reason='ticketing_reconciliation' and v_booking.active_operation_id is not null;
  if v_recovery then
    select * into v_operation from public.booking_operations where id=v_booking.active_operation_id and booking_id=p_booking_id;
    if not found or v_operation.kind<>'ticketing' or v_operation.state<>'needs_reconciliation'
       or v_operation.supplier is distinct from 'shapontravels' or v_operation.supplier_operation is distinct from 'NewTicket'
       or v_operation.supplier_unique_trans_id is distinct from v_booking.supplier_refs->>'uniqueTransId'
       or v_operation.supplier_booking_code_ref is distinct from v_booking.booking_code_ref
       or v_operation.supplier_pnr is distinct from v_booking.pnr
       or v_operation.request_key is distinct from v_booking.operation_request_id
       or v_operation.supplier_call_started_at is null or v_operation.reconciliation_required_at is null then
      return jsonb_build_object('ok',false,'eligible',false,'code','RECONCILIATION_REQUIRED');
    end if;
  elsif v_booking.status not in ('on-hold','pending') or v_booking.operation_kind is not null
     or v_booking.operation_reason is not null or v_booking.active_operation_id is not null
     or v_booking.operation_request_id is not null or v_booking.operation_actor_user_id is not null
     or v_booking.operation_started_at is not null or v_booking.operation_prior_status is not null then
    return jsonb_build_object('ok',false,'eligible',false,'code','RECONCILIATION_REQUIRED');
  end if;
  if exists(select 1 from public.booking_operations where booking_id=p_booking_id
     and state in ('claimed','supplier_call_started','awaiting_external_action','needs_reconciliation')
     and (not v_recovery or id<>v_operation.id)) then
    return jsonb_build_object('ok',false,'eligible',false,'code','RECONCILIATION_REQUIRED');
  end if;
  for v_case in select * from public.booking_reconciliation_cases
    where (subject_booking_id=p_booking_id or subject_booking_attempt_id=v_booking.attempt_id)
      and state not in ('resolved','closed_no_change','superseded') loop
    v_case_count:=v_case_count+1;
    if not v_recovery or v_case.subject_booking_id is distinct from p_booking_id
       or v_case.operation_id is distinct from v_operation.id or v_case.case_type<>'ticketing_uncertainty'
       or v_case.state not in ('open','assigned','awaiting_supplier','awaiting_finance')
       or v_case.proposal_hash is not null or v_case.proposed_outcome is not null
       or v_case.proposal<>'{}'::jsonb or v_case.approved_at is not null then
      return jsonb_build_object('ok',false,'eligible',false,'code','RECONCILIATION_REQUIRED');
    end if;
  end loop;
  if (v_recovery and v_case_count<>1) or (not v_recovery and v_case_count<>0) then
    return jsonb_build_object('ok',false,'eligible',false,'code','RECONCILIATION_REQUIRED');
  end if;
  if v_booking.booking_owner_type not in ('user','agency') or nullif(btrim(v_booking.booking_owner_key),'') is null
     or (v_booking.booking_owner_type='user' and (v_booking.audience<>'b2c' or v_booking.booking_owner_key is distinct from v_booking.user_id))
     or (v_booking.booking_owner_type='agency' and (v_booking.audience<>'agency' or v_booking.booking_owner_key is distinct from v_booking.agency_code)) then
    return jsonb_build_object('ok',false,'eligible',false,'code','BOOKING_OWNER_REQUIRED');
  end if;
  begin
    if jsonb_typeof(v_booking.pricing_snapshot->'sellingPrice') is distinct from 'number' then
      return jsonb_build_object('ok',false,'eligible',false,'code','INVALID_BOOKING_AMOUNT');
    end if;
    v_amount:=round((v_booking.pricing_snapshot->>'sellingPrice')::numeric*100)::bigint;
  exception when others then return jsonb_build_object('ok',false,'eligible',false,'code','INVALID_BOOKING_AMOUNT'); end;
  if v_amount is null or v_amount<=0 or v_amount>9007199254740991 or v_booking.currency !~ '^[A-Z]{3}$' then
    return jsonb_build_object('ok',false,'eligible',false,'code','INVALID_BOOKING_AMOUNT');
  end if;
  v_accounting:=public.classify_superadmin_booking_accounting_v1(p_booking_id);
  if v_accounting->>'ok' is distinct from 'true' then return v_accounting||jsonb_build_object('eligible',false); end if;
  if (v_accounting->>'expectedAmount')::bigint<>v_amount then
    return jsonb_build_object('ok',false,'eligible',false,'code','CAPTURE_ACCOUNTING_CONFLICT');
  end if;
  if v_accounting->>'accountingState'='paid' then
    v_paid:=public.booking_payment_return_accounting_v1(p_booking_id);
    if v_paid->>'ok' is distinct from 'true' then return v_paid||jsonb_build_object('eligible',false); end if;
    if (v_paid->>'capturedAmount')::bigint<>v_amount or (v_paid->>'refundedAmount')::bigint<>0 then
      return jsonb_build_object('ok',false,'eligible',false,'code','CAPTURE_ACCOUNTING_CONFLICT');
    end if;
    v_effect:='already_paid';
    return jsonb_build_object('ok',true,'eligible',true,'paymentEffect',v_effect,'amount',v_amount,
      'existingHoldAmount',0,'currency',v_booking.currency,'capturedAmount',v_amount,'refundedAmount',0,
      'walletAccountId',v_paid->'walletAccountId','originalCaptureLedgerEntryId',v_paid->'captureLedgerEntryId',
      'availableBalance',v_paid->'availableBalance','holdBalance',v_paid->'holdBalance');
  end if;
  -- No existing capture can be overwritten by a held/unpaid interpretation.
  if v_booking.issued_at is not null or nullif(btrim(v_booking.ticket_code_ref),'') is not null
     or coalesce(v_booking.ticket_numbers,'[]'::jsonb)<>'[]'::jsonb then
    return jsonb_build_object('ok',false,'eligible',false,'code','BOOKING_CONFIRMATION_CONFLICT');
  end if;
  select * into v_wallet from public.wallets where owner_type=v_booking.booking_owner_type and owner_key=v_booking.booking_owner_key;
  if not found then return jsonb_build_object('ok',false,'eligible',false,'code','WALLET_NOT_FOUND'); end if;
  select * into v_account from public.wallet_accounts where wallet_id=v_wallet.id and currency=v_booking.currency;
  if not found then return jsonb_build_object('ok',false,'eligible',false,'code','WALLET_ACCOUNT_NOT_FOUND'); end if;
  if v_wallet.status<>'active' then return jsonb_build_object('ok',false,'eligible',false,'code','WALLET_FROZEN'); end if;
  if v_accounting->>'accountingState'='active_hold' then
    select * into v_reservation from public.wallet_reservations where id=(v_accounting->>'reservationId')::uuid;
    if v_reservation.wallet_account_id is distinct from v_account.id or v_reservation.amount<>v_amount
       or v_reservation.currency<>v_booking.currency
       or v_account.hold_balance<(select coalesce(sum(amount),0) from public.wallet_reservations
         where wallet_account_id=v_account.id and state in ('active','reconciliation'))
       or exists(select 1 from public.wallet_ledger_entries ledger where ledger.reservation_id=v_reservation.id and (
         ledger.booking_id is distinct from p_booking_id or ledger.wallet_account_id<>v_account.id
         or ledger.currency<>v_booking.currency or ledger.transaction_type not in ('booking_hold','hold_release')
         or (ledger.transaction_type='booking_hold' and (ledger.available_before-ledger.available_after<>ledger.amount
           or ledger.hold_after-ledger.hold_before<>ledger.amount))
         or (ledger.transaction_type='hold_release' and (ledger.available_after-ledger.available_before<>ledger.amount
           or ledger.hold_before-ledger.hold_after<>ledger.amount)))) then
      return jsonb_build_object('ok',false,'eligible',false,'code','ACTIVE_HOLD_ACCOUNTING_CONFLICT');
    end if;
    v_effect:='capture_hold';
  elsif v_accounting->>'accountingState'='unpaid' then
    if v_recovery then return jsonb_build_object('ok',false,'eligible',false,'code','PROTECTED_HOLD_REQUIRED'); end if;
    if v_account.available_balance<v_amount then return jsonb_build_object('ok',false,'eligible',false,'code','INSUFFICIENT_FUNDS',
      'available',v_account.available_balance,'required',v_amount,'currency',v_booking.currency); end if;
    v_effect:='charge_wallet';
  else return jsonb_build_object('ok',false,'eligible',false,'code','PAYMENT_ACCOUNTING_REVIEW_REQUIRED');
  end if;
  return jsonb_build_object('ok',true,'eligible',true,'paymentEffect',v_effect,'amount',v_amount,
    'existingHoldAmount',case when v_effect='capture_hold' then v_amount else 0 end,
    'currency',v_booking.currency,'capturedAmount',0,'refundedAmount',0,
    'walletAccountId',v_account.id,'availableBalance',v_account.available_balance,'holdBalance',v_account.hold_balance);
end;
$$;
revoke all on function public.preview_shapon_ticket_payment_v1(uuid,text,text) from public,anon,authenticated;
grant execute on function public.preview_shapon_ticket_payment_v1(uuid,text,text) to service_role;

create or replace function public.confirm_shapon_external_ticket_v1(
  p_booking_id uuid,p_actor_user_id text,p_actor_role text,p_request_id uuid,
  p_charge_wallet boolean,p_receipt_identity jsonb,p_ticket_proof jsonb,p_checked_at timestamptz
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_booking public.flight_bookings;
  v_decision public.shapon_external_ticket_confirmations;
  v_actor_role text;
  v_reservation public.wallet_reservations;
  v_wallet public.wallets;
  v_account public.wallet_accounts;
  v_operation public.booking_operations;
  v_case public.booking_reconciliation_cases;
  v_lock_case public.booking_reconciliation_cases;
  v_lock_operation public.booking_operations;
  v_preview jsonb;
  v_payment_effect text;
  v_original_capture_id uuid;
  v_ticket_code_ref text;
  v_ledger_id uuid;
  v_decision_id uuid:=gen_random_uuid();
  v_amount bigint;
  v_currency text;
  v_count integer:=0;
  v_count_value jsonb;
  v_passenger_ticket jsonb;
  v_number jsonb;
  v_numbers jsonb:='[]'::jsonb;
  v_numeric_seen text[]:=array[]::text[];
  v_row_seen text[];
  v_numeric_ticket text;
  v_locator boolean;
  v_6e boolean:=false;
  v_leg jsonb;
  v_segment jsonb;
  v_now timestamptz:=clock_timestamp();
  v_issued_at timestamptz;
  v_prior_lifecycle text;
  v_settlement text;
  v_recovery boolean:=false;
begin
  if p_booking_id is null or p_request_id is null or p_charge_wallet is null
     or nullif(btrim(p_actor_user_id),'') is null then
    return jsonb_build_object('ok',false,'code','INVALID_CONFIRMATION_REQUEST');
  end if;
  select role into v_actor_role from public.app_users where clerk_id=p_actor_user_id;
  if v_actor_role is null or v_actor_role not in ('admin','superadmin') then
    return jsonb_build_object('ok',false,'code','CONFIRMATION_FORBIDDEN');
  end if;
  if p_actor_role is distinct from v_actor_role then return jsonb_build_object('ok',false,'code','ACTOR_ROLE_MISMATCH'); end if;
  perform pg_advisory_xact_lock(hashtextextended('shapon-external:'||p_request_id::text,0));
  select * into v_booking from public.flight_bookings where id=p_booking_id for update;
  if not found then return jsonb_build_object('ok',false,'code','BOOKING_NOT_FOUND'); end if;
  select * into v_decision from public.shapon_external_ticket_confirmations where request_id=p_request_id;
  if found then
    if (p_receipt_identity is not null and jsonb_typeof(p_receipt_identity) is distinct from 'object')
       or (p_ticket_proof is not null and jsonb_typeof(p_ticket_proof) is distinct from 'object') then
      return jsonb_build_object('ok',false,'code','CONFIRMATION_REQUEST_CONFLICT');
    end if;
    if v_decision.booking_id is distinct from p_booking_id or v_decision.actor_user_id is distinct from p_actor_user_id
       or v_decision.actor_role is distinct from v_actor_role or v_decision.charge_wallet is distinct from p_charge_wallet
       or ((p_receipt_identity is not null or p_ticket_proof is not null) and
         (p_receipt_identity is distinct from v_decision.receipt_identity
           or (p_ticket_proof-'issuedAt') is distinct from (v_decision.ticket_proof-'issuedAt'))) then
      return jsonb_build_object('ok',false,'code','CONFIRMATION_REQUEST_CONFLICT');
    end if;
    v_payment_effect:=v_decision.payment_effect;
    if v_payment_effect is null and v_decision.charge_wallet then
      select case when hold_before-hold_after=amount then 'capture_hold' else 'charge_wallet' end
        into v_payment_effect from public.wallet_ledger_entries where id=v_decision.ledger_entry_id;
    end if;
    return jsonb_build_object('ok',true,'replay',true,'confirmed',true,'bookingId',v_decision.booking_id,
      'decisionId',v_decision.id,'status','confirmed','paymentState',case when v_decision.charge_wallet then 'captured' else 'unpaid' end,
      'chargeWallet',v_decision.charge_wallet,'charged',v_decision.charge_wallet and v_payment_effect is distinct from 'already_paid',
      'settlement',v_decision.settlement,'paymentEffect',v_payment_effect,
      'walletAccountId',v_decision.wallet_account_id,'originalCaptureLedgerEntryId',
        coalesce(v_decision.original_capture_ledger_entry_id,v_decision.ledger_entry_id),
      'chargedAmount',case when v_decision.charge_wallet and v_payment_effect is distinct from 'already_paid' then v_decision.amount else 0 end,
      'amount',v_decision.amount,'currency',v_decision.currency);
  end if;
  if exists(select 1 from public.shapon_external_ticket_confirmations where booking_id=p_booking_id) then
    return jsonb_build_object('ok',false,'code','BOOKING_ALREADY_CONFIRMED');
  end if;
  -- This comes AFTER historical replay. New Confirmed tickets cannot release
  -- protected customer funds or create a new unpaid/no-charge settlement.
  if not p_charge_wallet then return jsonb_build_object('ok',false,'code','PAYMENT_REQUIRED'); end if;
  if jsonb_typeof(p_receipt_identity) is distinct from 'object' or pg_column_size(p_receipt_identity)>5000
     or not public.shapon_booking_status_identity_matches_v1(v_booking,p_receipt_identity) then
    return jsonb_build_object('ok',false,'code','SUPPLIER_IDENTITY_UNVERIFIED');
  end if;
  for v_lock_operation in select * from public.booking_operations where booking_id=p_booking_id order by id for update loop null; end loop;
  for v_lock_case in select * from public.booking_reconciliation_cases
    where subject_booking_id=p_booking_id or subject_booking_attempt_id=v_booking.attempt_id order by id for update loop null; end loop;
  select * into v_reservation from public.wallet_reservations where booking_id=p_booking_id
    or (booking_id is null and booking_attempt_id=v_booking.attempt_id) order by id limit 1 for update;
  v_preview:=public.preview_shapon_ticket_payment_v1(p_booking_id,p_actor_user_id,p_actor_role);
  if v_preview->>'ok' is distinct from 'true' or v_preview->>'eligible' is distinct from 'true' then return v_preview; end if;
  select wallet.* into v_wallet from public.wallets wallet join public.wallet_accounts account on account.wallet_id=wallet.id
    where account.id=(v_preview->>'walletAccountId')::uuid for update of wallet;
  select * into v_account from public.wallet_accounts where id=(v_preview->>'walletAccountId')::uuid for update;
  v_preview:=public.preview_shapon_ticket_payment_v1(p_booking_id,p_actor_user_id,p_actor_role);
  if v_preview->>'ok' is distinct from 'true' or v_preview->>'eligible' is distinct from 'true' then return v_preview; end if;
  v_payment_effect:=v_preview->>'paymentEffect';
  if p_ticket_proof->>'expectedPaymentEffect' not in ('capture_hold','already_paid','charge_wallet')
     or jsonb_typeof(p_ticket_proof->'expectedPaymentEffect') is distinct from 'string'
     or jsonb_typeof(p_ticket_proof->'expectedPayableAmount') is distinct from 'number' then
    return jsonb_build_object('ok',false,'code','PAYMENT_PREVIEW_REQUIRED');
  end if;
  if p_ticket_proof->>'expectedPaymentEffect' is distinct from v_payment_effect
     or p_ticket_proof->'expectedPayableAmount' is distinct from v_preview->'amount' then
    return jsonb_build_object('ok',false,'code','PAYMENT_PREVIEW_CHANGED');
  end if;
  v_recovery:=v_booking.status='in-progress';
  if v_recovery then
    select * into v_operation from public.booking_operations where id=v_booking.active_operation_id;
    select * into v_case from public.booking_reconciliation_cases where subject_booking_id=p_booking_id
      and operation_id=v_operation.id and state not in ('resolved','closed_no_change','superseded');
  end if;
  if p_checked_at is null or not isfinite(p_checked_at)
     or p_checked_at < v_now - interval '5 minutes' or p_checked_at > v_now + interval '30 seconds'
     or jsonb_typeof(p_ticket_proof) is distinct from 'object'
     or pg_column_size(p_ticket_proof) > 64000
     or p_ticket_proof->'verified' is distinct from 'true'::jsonb
     or p_ticket_proof->'issued' is distinct from 'true'::jsonb
     or p_ticket_proof->'paid' is distinct from 'true'::jsonb
     or coalesce(p_ticket_proof->>'source', '') not in ('supplier_ticket_details', 'supplier_saved_ticket_details')
     or p_ticket_proof->>'bookingStatus' is distinct from 'Confirmed'
     or p_ticket_proof->>'paymentStatus' is distinct from 'Paid'
     or p_ticket_proof->>'pnr' is distinct from v_booking.pnr
     or not coalesce((
       (p_ticket_proof->>'source' = 'supplier_ticket_details'
         and jsonb_typeof(p_ticket_proof->'ticketCodeRef') = 'string'
         and coalesce(p_ticket_proof->>'ticketCodeRef', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
       or (p_ticket_proof->>'source' = 'supplier_saved_ticket_details'
         and p_ticket_proof->'schemaVersion' = '1'::jsonb
         and (p_ticket_proof->'ticketCodeRef' = 'null'::jsonb
           or (jsonb_typeof(p_ticket_proof->'ticketCodeRef') = 'string'
             and coalesce(p_ticket_proof->>'ticketCodeRef', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')))), false)
     or jsonb_typeof(p_ticket_proof->'passengerCount') is distinct from 'number'
     or jsonb_typeof(p_ticket_proof->'passengerTickets') is distinct from 'array'
     or jsonb_typeof(p_ticket_proof->'ticketNumbers') is distinct from 'array'
     or jsonb_typeof(p_ticket_proof->'airlinesPnr') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
  end if;
  if jsonb_array_length(p_ticket_proof->'airlinesPnr') not between 1 and 20
     or exists (select 1 from jsonb_array_elements(p_ticket_proof->'airlinesPnr') n(value)
       where jsonb_typeof(n.value) <> 'string' or n.value #>> '{}' !~ '^[A-Z0-9]{3,12}$')
     or (select count(distinct value) from jsonb_array_elements(p_ticket_proof->'airlinesPnr'))
       <> jsonb_array_length(p_ticket_proof->'airlinesPnr') then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
  end if;
  -- Both saved passenger counts and saved traveller rows must be complete.
  for v_count_value in select value from jsonb_each(v_booking.passenger_counts) loop
    if jsonb_typeof(v_count_value) <> 'number' or v_count_value::text !~ '^[0-9]{1,3}$' then
      return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
    end if;
    v_count := v_count + v_count_value::text::integer;
  end loop;
  if v_count not between 1 and 100
     or p_ticket_proof->'passengerCount' is distinct from to_jsonb(v_count)
     or jsonb_array_length(p_ticket_proof->'passengerTickets') <> v_count
     or jsonb_typeof(v_booking.passengers->'travellers') is distinct from 'array' then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
  end if;
  if jsonb_array_length(v_booking.passengers->'travellers') <> v_count then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
  end if;
  -- IndiGo may use its airline locator as the ticket identifier. Establish
  -- the special carrier contract from the server-saved complete itinerary.
  if v_booking.itinerary->>'carrierCode' = '6E'
     and jsonb_typeof(v_booking.itinerary->'legs') = 'array'
     and jsonb_array_length(v_booking.itinerary->'legs') > 0 then
    v_6e := true;
    for v_leg in select value from jsonb_array_elements(v_booking.itinerary->'legs') loop
      if jsonb_typeof(v_leg->'segments') is distinct from 'array' then v_6e := false; exit; end if;
      if jsonb_array_length(v_leg->'segments') = 0 then v_6e := false; exit; end if;
      for v_segment in select value from jsonb_array_elements(v_leg->'segments') loop
        if v_segment->>'airlineCode' is distinct from '6E' then v_6e := false; exit; end if;
      end loop;
      exit when not v_6e;
    end loop;
  end if;
  for v_passenger_ticket in select value from jsonb_array_elements(p_ticket_proof->'passengerTickets') loop
    if jsonb_typeof(v_passenger_ticket) is distinct from 'object'
       or jsonb_typeof(v_passenger_ticket->'ticketNumbers') is distinct from 'array'
       or coalesce(jsonb_typeof(v_passenger_ticket->'ticketNumberSource'), 'null') not in ('null', 'string')
       or coalesce(v_passenger_ticket->>'ticketNumberSource', '') not in ('', 'airline_pnr') then
      return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
    end if;
    if jsonb_array_length(v_passenger_ticket->'ticketNumbers') not between 1 and 20 then
      return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
    end if;
    v_locator := v_passenger_ticket->>'ticketNumberSource' = 'airline_pnr';
    v_row_seen := array[]::text[];
    for v_number in select value from jsonb_array_elements(v_passenger_ticket->'ticketNumbers') loop
      if jsonb_typeof(v_number) <> 'string' or v_number #>> '{}' = any(v_row_seen) then
        return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
      end if;
      if coalesce(v_locator, false) then
        if p_ticket_proof->>'ticketCodeRef' is null
           or not v_6e or v_number #>> '{}' !~ '^[A-Z0-9]{6}$'
           or not (p_ticket_proof->'airlinesPnr' @> jsonb_build_array(v_number)) then
          return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
        end if;
      else
        if v_number #>> '{}' !~ '^[0-9]{10,16}$' or v_number #>> '{}' = any(v_numeric_seen) then
          return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
        end if;
        v_numeric_seen := array_append(v_numeric_seen, v_number #>> '{}');
      end if;
      v_row_seen := array_append(v_row_seen, v_number #>> '{}');
      v_numbers := v_numbers || jsonb_build_array(v_number);
    end loop;
  end loop;
  if p_ticket_proof->'ticketNumbers' is distinct from v_numbers then
    return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
  end if;
  if p_ticket_proof ? 'issuedAt' and p_ticket_proof->'issuedAt' <> 'null'::jsonb then
    if jsonb_typeof(p_ticket_proof->'issuedAt') <> 'string'
       or length(p_ticket_proof->>'issuedAt') > 64
       or p_ticket_proof->>'issuedAt' !~ '^\d{4}-\d{2}-\d{2}T(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.\d{1,9})?(Z|[+-](0[0-9]|1[0-9]|2[0-3]):[0-5][0-9])$' then
      return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
    end if;
    begin v_issued_at := (p_ticket_proof->>'issuedAt')::timestamptz;
    exception when others then return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED'); end;
    if not isfinite(v_issued_at) or v_issued_at > p_checked_at + interval '30 seconds'
       or v_issued_at < v_booking.created_at then
      return jsonb_build_object('ok', false, 'code', 'TICKET_EVIDENCE_UNVERIFIED');
    end if;
  end if;

  -- Reject reusing another local booking's ticket receipt. The extra ticket
  -- lock serializes competing confirmations on different booking rows.
  if p_ticket_proof->>'ticketCodeRef' is not null then
    perform pg_advisory_xact_lock(hashtextextended('shapon-ticket:' || lower(p_ticket_proof->>'ticketCodeRef'), 0));
  end if;
  for v_numeric_ticket in select unnest(v_numeric_seen) order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended('shapon-ticket-number:' || v_numeric_ticket, 0));
  end loop;
  if exists (select 1 from public.flight_bookings other where other.id <> p_booking_id
    and (lower(other.ticket_code_ref) = lower(p_ticket_proof->>'ticketCodeRef')
      or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(other.ticket_numbers) = 'array'
        then other.ticket_numbers else '[]'::jsonb end) n(value)
        where n.value #>> '{}' = any(v_numeric_seen)))) then
    return jsonb_build_object('ok', false, 'code', 'TICKET_ALREADY_ASSIGNED');
  end if;
  begin
    if jsonb_typeof(v_booking.pricing_snapshot->'sellingPrice') <> 'number'
       or v_booking.pricing_snapshot->>'sellingPrice' in ('NaN', 'Infinity', '-Infinity') then
      return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
    end if;
    v_amount := round((v_booking.pricing_snapshot->>'sellingPrice')::numeric * 100)::bigint;
  exception when others then return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT'); end;
  v_currency := v_booking.currency;
  if v_amount is null or v_amount <= 0 or v_currency is null or v_currency !~ '^[A-Z]{3}$' then
    return jsonb_build_object('ok', false, 'code', 'INVALID_BOOKING_AMOUNT');
  end if;

  if v_amount is distinct from (v_preview->>'amount')::bigint then
    return jsonb_build_object('ok',false,'code','PAYMENT_PREVIEW_CHANGED');
  end if;
  if v_payment_effect='already_paid' and (
       (v_booking.ticket_code_ref is not null and (
         (p_ticket_proof->>'ticketCodeRef' is not null and v_booking.ticket_code_ref is distinct from p_ticket_proof->>'ticketCodeRef')
         or (p_ticket_proof->>'ticketCodeRef' is null and (
           not public.jsonb_is_nonempty_array(v_booking.ticket_numbers)
           or v_booking.ticket_numbers is distinct from v_numbers))))
       or (coalesce(v_booking.ticket_numbers,'[]'::jsonb)<>'[]'::jsonb and v_booking.ticket_numbers is distinct from v_numbers)
       or (v_booking.issued_at is not null and v_issued_at is not null and v_booking.issued_at<>v_issued_at)) then
    return jsonb_build_object('ok',false,'code','BOOKING_TICKET_CONFLICT');
  end if;
  -- A newer saved receipt may omit the old supplier UUID. Retain a known
  -- local UUID only when the complete immutable local/fresh ticket numbers pin it.
  v_ticket_code_ref:=case when v_payment_effect='already_paid' and p_ticket_proof->>'ticketCodeRef' is null
    then v_booking.ticket_code_ref else p_ticket_proof->>'ticketCodeRef' end;
  v_prior_lifecycle:=public.resolve_booking_lifecycle(v_booking.status,v_booking.airlines_pnr,
    v_booking.ticketing_deadline_at,v_booking.operation_kind);
  v_settlement:=case when v_payment_effect='already_paid' then 'existing_owner_wallet_capture' else 'owner_wallet' end;
  if v_payment_effect='already_paid' then
    v_ledger_id:=(v_preview->>'originalCaptureLedgerEntryId')::uuid;
    v_original_capture_id:=v_ledger_id;
  elsif v_payment_effect='capture_hold' then
    update public.wallet_accounts set hold_balance=hold_balance-v_amount where id=v_account.id;
    update public.wallet_reservations set booking_id=p_booking_id,booking_attempt_id=null,state='captured',
      issued_by_user_id=p_actor_user_id,captured_at=v_now,reconciliation_at=null,reconciliation_reason=null
      where id=v_reservation.id;
    insert into public.wallet_ledger_entries(wallet_account_id,transaction_type,amount,currency,
      available_before,available_after,hold_before,hold_after,booking_id,booking_reference,
      reservation_id,idempotency_key,created_by_user_id,created_by_role,remarks,metadata)
    values(v_account.id,'booking_confirm',v_amount,v_currency,v_account.available_balance,v_account.available_balance,
      v_account.hold_balance,v_account.hold_balance-v_amount,p_booking_id,v_booking.public_ref,v_reservation.id,
      'shapon-external-recovery:'||p_booking_id::text,p_actor_user_id,v_actor_role,
      'Admin confirmed issued ticket using its existing protected wallet hold',
      jsonb_build_object('decisionId',v_decision_id,'requestId',p_request_id,'paymentEffect',v_payment_effect,
        'operationId',v_operation.id,'reconciliationCaseId',v_case.id,'supplierApiCalled',false)) returning id into v_ledger_id;
    v_original_capture_id:=v_ledger_id;
  else
    update public.wallet_accounts set available_balance=available_balance-v_amount where id=v_account.id;
    if v_reservation.id is null then
      insert into public.wallet_reservations(wallet_account_id,booking_id,amount,currency,state,
        requested_by_user_id,issued_by_user_id,captured_at)
      values(v_account.id,p_booking_id,v_amount,v_currency,'captured',p_actor_user_id,p_actor_user_id,v_now)
      returning * into v_reservation;
    else
      update public.wallet_reservations set wallet_account_id=v_account.id,booking_id=p_booking_id,booking_attempt_id=null,
        amount=v_amount,currency=v_currency,state='captured',cycle=cycle+1,requested_by_user_id=p_actor_user_id,
        issued_by_user_id=p_actor_user_id,captured_at=v_now,supplier_call_started_at=null,released_at=null,release_reason=null,
        reconciliation_at=null,reconciliation_reason=null where id=v_reservation.id returning * into v_reservation;
    end if;
    insert into public.wallet_ledger_entries(wallet_account_id,transaction_type,amount,currency,
      available_before,available_after,hold_before,hold_after,booking_id,booking_reference,reservation_id,
      idempotency_key,created_by_user_id,created_by_role,remarks,metadata)
    values(v_account.id,'booking_confirm',v_amount,v_currency,v_account.available_balance,v_account.available_balance-v_amount,
      v_account.hold_balance,v_account.hold_balance,p_booking_id,v_booking.public_ref,v_reservation.id,
      'shapon-external-confirm:'||p_booking_id::text,p_actor_user_id,v_actor_role,
      'Admin confirmed supplier-issued ticket with saved owner-wallet payment',
      jsonb_build_object('decisionId',v_decision_id,'requestId',p_request_id,'paymentEffect',v_payment_effect,
        'supplierApiCalled',false)) returning id into v_ledger_id;
    v_original_capture_id:=v_ledger_id;
  end if;
  update public.flight_bookings set status='confirmed',booking_status='Confirmed',
    ticket_code_ref=v_ticket_code_ref,ticket_numbers=v_numbers,airlines_pnr=p_ticket_proof->'airlinesPnr',
    issued_at=coalesce(v_issued_at,issued_at),issued_by_user_id=p_actor_user_id,
    payment_state='captured',charged_wallet_account_id=v_account.id,payment_amount=v_amount,captured_amount=v_amount,refunded_amount=0,
    active_operation_id=null,operation_kind=null,operation_reason=null,operation_request_id=null,
    operation_actor_user_id=null,operation_started_at=null,operation_prior_status=null where id=p_booking_id;
  insert into public.shapon_external_ticket_confirmations(id,booking_id,request_id,actor_user_id,actor_role,
    charge_wallet,receipt_identity,ticket_proof,checked_at,settlement,amount,currency,wallet_account_id,
    reservation_id,ledger_entry_id,payment_effect,original_capture_ledger_entry_id)
  values(v_decision_id,p_booking_id,p_request_id,p_actor_user_id,v_actor_role,true,p_receipt_identity,p_ticket_proof,
    p_checked_at,v_settlement,v_amount,v_currency,v_account.id,v_reservation.id,v_ledger_id,v_payment_effect,v_original_capture_id);
  if v_recovery then
    update public.booking_operations set state='succeeded',completed_at=v_now,error_code=null,error_message=null,
      supplier_evidence=supplier_evidence||jsonb_build_object('externalTicketRecovery',
        jsonb_build_object('decisionId',v_decision_id,'requestId',p_request_id,'caseId',v_case.id,
          'paymentEffect',v_payment_effect,'captureLedgerEntryId',v_original_capture_id,'checkedAt',p_checked_at))
      where id=v_operation.id;
    update public.booking_reconciliation_cases set state='resolved',resolution_outcome='ticketed',
      financial_disposition=case when v_payment_effect='capture_hold' then 'capture_existing_hold' else 'none' end,
      financial_amount=case when v_payment_effect='capture_hold' then v_amount else null end,
      financial_currency=case when v_payment_effect='capture_hold' then v_currency else null end,
      resolution=jsonb_build_object('version',1,'resolutionKind','shapon_external_ticket','decisionId',v_decision_id,
        'requestId',p_request_id,'operationId',v_operation.id,'paymentEffect',v_payment_effect,
        'captureLedgerEntryId',v_original_capture_id,'checkedAt',p_checked_at,'executedByRole',v_actor_role),
      resolution_reason='Admin confirmed matching issued ticket using authoritative local accounting',
      resolved_by_user_id=p_actor_user_id,resolved_at=v_now,closed_at=v_now,version=version+1 where id=v_case.id;
  end if;
  insert into public.booking_status_events(booking_id,from_lifecycle_status,to_lifecycle_status,
    stored_status_before,stored_status_after,actor_user_id,supplier_operation,supplier_evidence,idempotency_key,
    effective_at,observed_at,event_snapshot,operation_id,reconciliation_case_id,operation_kind,operation_reason)
  values(p_booking_id,v_prior_lifecycle,'confirmed',v_booking.status,'confirmed',p_actor_user_id,'ExternalTicketConfirmation',
    jsonb_build_object('decisionId',v_decision_id,'requestId',p_request_id,'actorRole',v_actor_role,
      'paymentEffect',v_payment_effect,'captureLedgerEntryId',v_original_capture_id,'amount',v_amount,'currency',v_currency,
      'supplierApiCalled',false,'ticketCodeRef',v_ticket_code_ref,
      'supplierTicketCodeRef',p_ticket_proof->>'ticketCodeRef','ticketNumbers',v_numbers),
    'shapon-external-confirm:'||p_request_id::text,v_issued_at,v_now,
    jsonb_build_object('operationSource','shapontravels','externalTicketConfirmation',true,'settlement',v_settlement,
      'chargeWallet',true,'paymentEffect',v_payment_effect,'paymentState','captured','recovery',v_recovery),
    v_operation.id,v_case.id,v_booking.operation_kind,v_booking.operation_reason);
  return jsonb_build_object('ok',true,'replay',false,'confirmed',true,'bookingId',p_booking_id,'decisionId',v_decision_id,
    'status','confirmed','paymentState','captured','chargeWallet',true,'charged',v_payment_effect<>'already_paid',
    'paymentEffect',v_payment_effect,'settlement',v_settlement,'walletAccountId',v_account.id,
    'chargedAmount',case when v_payment_effect='already_paid' then 0 else v_amount end,
    'originalCaptureLedgerEntryId',v_original_capture_id,'amount',v_amount,'currency',v_currency,'recovery',v_recovery);
end;
$$;
revoke all on function public.confirm_shapon_external_ticket_v1(uuid,text,text,uuid,boolean,jsonb,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function public.confirm_shapon_external_ticket_v1(uuid,text,text,uuid,boolean,jsonb,jsonb,timestamptz) to service_role;
comment on function public.confirm_shapon_external_ticket_v1(uuid,text,text,uuid,boolean,jsonb,jsonb,timestamptz) is
  'Confirms proven supplier-issued tickets using mandatory existing-hold capture, original paid-capture reuse or normal owner-wallet charge. New unpaid/no-charge confirmations are rejected; immutable historical decisions still replay. Never sends a supplier write.';

commit;
