-- Supplier reads never issue tickets or move money. This separate, narrow
-- Admin/Super Admin command can capture only the original, verified issue hold.
create table public.triplover_booking_status_checks (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.flight_bookings(id) on delete restrict,
  actor_user_id text not null,
  actor_role text not null check (actor_role in ('admin','superadmin')),
  booking_snapshot_hash text not null check (booking_snapshot_hash ~ '^[a-f0-9]{64}$'),
  facts jsonb not null check (jsonb_typeof(facts) = 'object'),
  checked_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  check (expires_at = checked_at + interval '5 minutes')
);
create index triplover_booking_status_checks_latest on public.triplover_booking_status_checks(booking_id,checked_at desc,id desc);
create index triplover_booking_status_checks_issued_fence on public.triplover_booking_status_checks(booking_id)
  where facts @> '{"verified":true,"verifiedStatus":"issued","source":"ticket_report"}'::jsonb;

create table public.triplover_issued_hold_confirmations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.flight_bookings(id) on delete restrict,
  check_id uuid not null references public.triplover_booking_status_checks(id) on delete restrict,
  actor_user_id text not null,
  actor_role text not null check (actor_role in ('admin','superadmin')),
  request_key text not null unique,
  preview_hash text not null check (preview_hash ~ '^[a-f0-9]{64}$'),
  reservation_id uuid not null unique references public.wallet_reservations(id) on delete restrict,
  ledger_entry_id uuid not null unique references public.wallet_ledger_entries(id) on delete restrict,
  lifecycle_event_id bigint not null references public.booking_status_events(id) on delete restrict,
  evidence jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.triplover_booking_status_checks enable row level security;
alter table public.triplover_issued_hold_confirmations enable row level security;
revoke all on public.triplover_booking_status_checks,public.triplover_issued_hold_confirmations
  from public,anon,authenticated,service_role;
grant select on public.triplover_booking_status_checks,public.triplover_issued_hold_confirmations to service_role;

create function public.triplover_status_records_immutable_v1()
returns trigger language plpgsql set search_path=public as $$
begin
  raise exception 'Triplover verification and confirmation records are immutable' using errcode='55000';
end;
$$;
create trigger triplover_booking_status_checks_immutable before update or delete on public.triplover_booking_status_checks
  for each row execute function public.triplover_status_records_immutable_v1();
create trigger triplover_issued_hold_confirmations_immutable before update or delete on public.triplover_issued_hold_confirmations
  for each row execute function public.triplover_status_records_immutable_v1();

-- An immutable issued observation remains a stop signal after confirmation
-- freshness expires, and a later unavailable/unknown read cannot erase it.
-- The normal operation claimant also takes this booking lock, so recording a
-- check and claiming a NEW destructive supplier operation serialize atomically.
-- Existing operation replay and the original resolver only read/update rows.
create function public.guard_triplover_issued_status_operation_v1()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_booking public.flight_bookings;
begin
  if new.kind not in ('ticketing','cancellation') then return new; end if;
  select * into v_booking from public.flight_bookings where id=new.booking_id for update;
  if found and v_booking.supplier='triplover'
     and v_booking.supplier_account in ('triplover','firsttrip','takeoff')
     and v_booking.import_source is null and not v_booking.legacy_operational and not v_booking.direct_ticketing
     and exists(select 1 from public.triplover_booking_status_checks c where c.booking_id=new.booking_id
       and c.facts @> '{"verified":true,"verifiedStatus":"issued","source":"ticket_report"}'::jsonb) then
    raise exception 'TRIPLOVER_SUPPLIER_ISSUED_REVIEW_REQUIRED' using errcode='P0001';
  end if;
  return new;
end;
$$;
create trigger booking_operations_triplover_issued_status_guard before insert on public.booking_operations
  for each row execute function public.guard_triplover_issued_status_operation_v1();

-- This internal fingerprint deliberately includes the complete local supplier
-- and financial footprint, rather than trusting a caller-supplied timestamp.
create function public.triplover_status_snapshot_v1(p_booking_id uuid)
returns text language sql security definer set search_path=public as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'booking',to_jsonb(b),
    'operations',coalesce((select jsonb_agg(to_jsonb(o) order by o.id)
      from public.booking_operations o where o.booking_id=b.id),'[]'::jsonb),
    'cases',coalesce((select jsonb_agg(to_jsonb(c) order by c.id)
      from public.booking_reconciliation_cases c where c.subject_booking_id=b.id
        or c.subject_booking_attempt_id=b.attempt_id),'[]'::jsonb),
    'reservations',coalesce((select jsonb_agg(to_jsonb(r) order by r.id)
      from public.wallet_reservations r where r.booking_id=b.id
        or (r.booking_id is null and r.booking_attempt_id=b.attempt_id)),'[]'::jsonb),
    'ledger',coalesce((select jsonb_agg(to_jsonb(l) order by l.id)
      from public.wallet_ledger_entries l where l.booking_id=b.id
        or l.reservation_id in (select r.id from public.wallet_reservations r
          where r.booking_id=b.id or (r.booking_id is null and r.booking_attempt_id=b.attempt_id))),'[]'::jsonb)
    )::text,'UTF8')),'hex') from public.flight_bookings b where b.id=p_booking_id;
$$;

create function public.triplover_status_check_context_v1(
  p_booking_id uuid,p_actor_user_id text,p_actor_role text
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_role text; v_booking public.flight_bookings;
begin
  select role into v_role from public.app_users where clerk_id=p_actor_user_id;
  if v_role is null or v_role not in ('admin','superadmin') then
    return jsonb_build_object('ok',false,'code','STATUS_CHECK_FORBIDDEN');
  end if;
  if p_actor_role is distinct from v_role then
    return jsonb_build_object('ok',false,'code','ACTOR_ROLE_MISMATCH');
  end if;
  select * into v_booking from public.flight_bookings where id=p_booking_id for share;
  if not found then return jsonb_build_object('ok',false,'code','BOOKING_NOT_FOUND'); end if;
  if v_booking.supplier is distinct from 'triplover'
     or coalesce(v_booking.supplier_account,'') not in ('triplover','firsttrip','takeoff')
     or v_booking.import_source is not null or v_booking.legacy_operational or v_booking.direct_ticketing
     or v_booking.audience not in ('agency','b2c') then
    return jsonb_build_object('ok',false,'code','SUPPLIER_BOOKING_UNSUPPORTED');
  end if;
  return jsonb_build_object('ok',true,'bookingSnapshotHash',public.triplover_status_snapshot_v1(p_booking_id),
    'booking',to_jsonb(v_booking)||jsonb_build_object('lifecycle_status',public.resolve_booking_lifecycle(
      v_booking.status,v_booking.airlines_pnr,v_booking.ticketing_deadline_at,v_booking.operation_kind)));
end;
$$;

create function public.record_triplover_status_check_v1(
  p_booking_id uuid,p_actor_user_id text,p_actor_role text,p_booking_snapshot_hash text,p_facts jsonb
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_context jsonb; v_check public.triplover_booking_status_checks; v_now timestamptz:=clock_timestamp();
begin
  -- Serialize reads being recorded against the finalizer's booking lock.
  perform 1 from public.flight_bookings where id=p_booking_id for update;
  v_context:=public.triplover_status_check_context_v1(p_booking_id,p_actor_user_id,p_actor_role);
  if coalesce((v_context->>'ok')::boolean,false) is not true then return v_context; end if;
  if p_booking_snapshot_hash is distinct from v_context->>'bookingSnapshotHash' then
    return jsonb_build_object('ok',false,'code','BOOKING_STATE_CHANGED');
  end if;
  if jsonb_typeof(p_facts) is distinct from 'object' or pg_column_size(p_facts)>64000
     or jsonb_typeof(p_facts->'verified') is distinct from 'boolean'
     or coalesce(p_facts->>'verifiedStatus','') not in ('issued','held','cancelled','unknown')
     or coalesce(p_facts->>'source','') not in ('ticket_report','pnr','unavailable')
     or p_facts->>'currency' is distinct from 'BDT'
     or jsonb_typeof(p_facts->'airlinePnrs') is distinct from 'array'
     or jsonb_typeof(p_facts->'tickets') is distinct from 'array'
     or jsonb_array_length(p_facts->'airlinePnrs')>20 or jsonb_array_length(p_facts->'tickets')>100
     or coalesce(jsonb_typeof(p_facts->'rawPayloadHash'),'null') not in ('string','null')
     or (p_facts->>'rawPayloadHash' is not null and p_facts->>'rawPayloadHash' !~ '^[a-f0-9]{64}$') then
    return jsonb_build_object('ok',false,'code','INVALID_STATUS_FACTS');
  end if;
  -- Nullable scalar fields still have a precise server-owned shape. The full
  -- identity/itinerary/passenger comparison happens in the trusted read adapter.
  if exists(select 1 from unnest(array['supplierStatus','pnr','ticketCodeRef','issuedAt','reason']) k(name)
      where coalesce(jsonb_typeof(p_facts->k.name),'null') not in ('string','null'))
     or coalesce(jsonb_typeof(p_facts->'supplierPayableMinor'),'null') not in ('number','null') then
    return jsonb_build_object('ok',false,'code','INVALID_STATUS_FACTS');
  end if;
  insert into public.triplover_booking_status_checks(booking_id,actor_user_id,actor_role,booking_snapshot_hash,facts,checked_at,expires_at)
    values(p_booking_id,p_actor_user_id,p_actor_role,p_booking_snapshot_hash,p_facts,v_now,v_now+interval '5 minutes')
    returning * into v_check;
  return jsonb_build_object('ok',true,'id',v_check.id,'checkId',v_check.id,'checkedAt',v_check.checked_at,
    'expiresAt',v_check.expires_at,'facts',v_check.facts,'bookingSnapshotHash',v_check.booking_snapshot_hash);
end;
$$;

create function public.preview_triplover_issued_hold_confirmation_v1(
  p_booking_id uuid,p_actor_user_id text,p_actor_role text,p_check_id uuid
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_context jsonb; v_booking public.flight_bookings; v_check public.triplover_booking_status_checks;
  v_operation public.booking_operations; v_case public.booking_reconciliation_cases;
  v_reservation public.wallet_reservations; v_account public.wallet_accounts; v_wallet public.wallets;
  v_accounting jsonb; v_facts jsonb; v_result jsonb; v_hash text;
  v_count integer:=0; v_value jsonb; v_row jsonb; v_number jsonb;
  v_tickets jsonb:='[]'::jsonb; v_slots integer[]:=array[]::integer[]; v_slot integer;
  v_numbers text[]:=array[]::text[]; v_row_numbers text[]; v_is_6e boolean:=false;
  v_leg jsonb; v_segment jsonb; v_protected bigint; v_hold_total bigint; v_issued_at timestamptz;
  v_supplier_amount bigint;
begin
  v_context:=public.triplover_status_check_context_v1(p_booking_id,p_actor_user_id,p_actor_role);
  if coalesce((v_context->>'ok')::boolean,false) is not true then return v_context; end if;
  select * into v_booking from public.flight_bookings where id=p_booking_id;
  select * into v_check from public.triplover_booking_status_checks where id=p_check_id and booking_id=p_booking_id;
  if not found then return jsonb_build_object('ok',false,'eligible',false,'code','STATUS_CHECK_NOT_FOUND'); end if;
  if v_check.id is distinct from (select id from public.triplover_booking_status_checks where booking_id=p_booking_id
      order by checked_at desc,id desc limit 1) then
    return jsonb_build_object('ok',false,'eligible',false,'code','STATUS_CHECK_SUPERSEDED');
  end if;
  if v_check.expires_at<clock_timestamp() or v_check.checked_at>clock_timestamp()+interval '30 seconds' then
    return jsonb_build_object('ok',false,'eligible',false,'code','STATUS_CHECK_EXPIRED');
  end if;
  if v_check.booking_snapshot_hash is distinct from v_context->>'bookingSnapshotHash' then
    return jsonb_build_object('ok',false,'eligible',false,'code','BOOKING_STATE_CHANGED');
  end if;
  if v_booking.status in ('confirmed','cancelled') or exists(select 1 from public.triplover_issued_hold_confirmations where booking_id=p_booking_id) then
    return jsonb_build_object('ok',false,'eligible',false,'code','BOOKING_ALREADY_SETTLED');
  end if;
  if v_booking.status not in ('on-hold','pending','in-progress') or v_booking.payment_state not in ('held','reconciliation')
     or v_booking.captured_amount<>0 or v_booking.refunded_amount<>0 then
    return jsonb_build_object('ok',false,'eligible',false,'code','BOOKING_NOT_CAPTURABLE');
  end if;
  v_facts:=v_check.facts;
  if v_facts->'verified' is distinct from 'true'::jsonb or v_facts->>'verifiedStatus' is distinct from 'issued'
     or v_facts->>'source' is distinct from 'ticket_report' or v_facts->>'pnr' is distinct from v_booking.pnr
     or nullif(btrim(v_booking.pnr),'') is null
     or coalesce(v_facts->>'rawPayloadHash','') !~ '^[a-f0-9]{64}$'
     or v_facts->>'currency' is distinct from v_booking.currency
     or lower(coalesce(v_facts->>'supplierStatus','')) not in ('issued','ticketed','confirmed') then
    return jsonb_build_object('ok',false,'eligible',false,'code','ISSUED_EVIDENCE_REQUIRED');
  end if;
  begin
    v_issued_at:=(v_facts->>'issuedAt')::timestamptz;
    v_supplier_amount:=round((v_booking.pricing_snapshot->>'supplierTotalPrice')::numeric*100)::bigint;
  exception when others then return jsonb_build_object('ok',false,'eligible',false,'code','ISSUED_EVIDENCE_INVALID'); end;
  if v_issued_at is null or not isfinite(v_issued_at) or v_issued_at>v_check.checked_at+interval '1 minute'
     or v_issued_at<v_booking.created_at-interval '1 minute'
     or v_supplier_amount is null or v_supplier_amount<=0
     or jsonb_typeof(v_facts->'supplierPayableMinor') is distinct from 'number'
     or v_facts->'supplierPayableMinor' is distinct from to_jsonb(v_supplier_amount)
     or (v_booking.issued_at is not null and v_booking.issued_at is distinct from v_issued_at)
     or (nullif(btrim(v_booking.ticket_code_ref),'') is not null and nullif(btrim(v_facts->>'ticketCodeRef'),'') is not null
       and v_booking.ticket_code_ref is distinct from v_facts->>'ticketCodeRef') then
    return jsonb_build_object('ok',false,'eligible',false,'code','ISSUED_EVIDENCE_INVALID');
  end if;
  if jsonb_array_length(v_facts->'airlinePnrs') not between 1 and 20
     or exists(select 1 from jsonb_array_elements(v_facts->'airlinePnrs') n(value)
       where jsonb_typeof(n.value)<>'string' or n.value#>>'{}' !~ '^[A-Z0-9]{3,12}$')
     or (select count(distinct value) from jsonb_array_elements(v_facts->'airlinePnrs'))<>jsonb_array_length(v_facts->'airlinePnrs') then
    return jsonb_build_object('ok',false,'eligible',false,'code','TICKET_EVIDENCE_INVALID');
  end if;
  for v_value in select value from jsonb_each(v_booking.passenger_counts) loop
    if jsonb_typeof(v_value)<>'number' or v_value::text !~ '^[0-9]{1,3}$' then
      return jsonb_build_object('ok',false,'eligible',false,'code','TICKET_EVIDENCE_INVALID');
    end if;
    v_count:=v_count+v_value::text::integer;
  end loop;
  if v_count not between 1 and 100 or jsonb_typeof(v_booking.passengers->'travellers') is distinct from 'array' then
    return jsonb_build_object('ok',false,'eligible',false,'code','TICKET_EVIDENCE_INVALID');
  end if;
  if jsonb_array_length(v_booking.passengers->'travellers')<>v_count or jsonb_array_length(v_facts->'tickets')<>v_count then
    return jsonb_build_object('ok',false,'eligible',false,'code','TICKET_EVIDENCE_INVALID');
  end if;
  if v_booking.itinerary->>'carrierCode'='6E' and jsonb_typeof(v_booking.itinerary->'legs')='array' then
    v_is_6e:=jsonb_array_length(v_booking.itinerary->'legs')>0;
    for v_leg in select value from jsonb_array_elements(v_booking.itinerary->'legs') loop
      if jsonb_typeof(v_leg->'segments') is distinct from 'array' then v_is_6e:=false; exit; end if;
      if jsonb_array_length(v_leg->'segments')=0 then v_is_6e:=false; exit; end if;
      for v_segment in select value from jsonb_array_elements(v_leg->'segments') loop
        if v_segment->>'airlineCode' is distinct from '6E' then v_is_6e:=false; exit; end if;
      end loop;
      exit when not v_is_6e;
    end loop;
  end if;
  if exists(select 1 from jsonb_array_elements(v_facts->'tickets') t(value)
      where jsonb_typeof(t.value) is distinct from 'object'
        or jsonb_typeof(t.value->'passengerIndex') is distinct from 'number'
        or coalesce(t.value->>'passengerIndex','') !~ '^[0-9]{1,3}$') then
    return jsonb_build_object('ok',false,'eligible',false,'code','TICKET_EVIDENCE_INVALID');
  end if;
  for v_row in select value from jsonb_array_elements(v_facts->'tickets') order by (value->>'passengerIndex')::integer loop
    if jsonb_typeof(v_row) is distinct from 'object' or jsonb_typeof(v_row->'passengerIndex') is distinct from 'number'
       or coalesce(v_row->>'passengerIndex','') !~ '^[0-9]{1,3}$'
       or jsonb_typeof(v_row->'ticketNumbers') is distinct from 'array' then
      return jsonb_build_object('ok',false,'eligible',false,'code','TICKET_EVIDENCE_INVALID');
    end if;
    v_slot:=(v_row->>'passengerIndex')::integer;
    if v_slot<0 or v_slot>=v_count or v_slot=any(v_slots) or jsonb_array_length(v_row->'ticketNumbers') not between 1 and 20 then
      return jsonb_build_object('ok',false,'eligible',false,'code','TICKET_EVIDENCE_INVALID');
    end if;
    v_slots:=array_append(v_slots,v_slot); v_row_numbers:=array[]::text[];
    for v_number in select value from jsonb_array_elements(v_row->'ticketNumbers') loop
      if jsonb_typeof(v_number)<>'string' or v_number#>>'{}'=any(v_row_numbers) then
        return jsonb_build_object('ok',false,'eligible',false,'code','TICKET_EVIDENCE_INVALID');
      end if;
      if v_number#>>'{}' ~ '^[0-9]{10,16}$' then
        if v_number#>>'{}'=any(v_numbers) then
          return jsonb_build_object('ok',false,'eligible',false,'code','TICKET_EVIDENCE_INVALID');
        end if;
        v_numbers:=array_append(v_numbers,v_number#>>'{}');
      elsif not v_is_6e or v_number#>>'{}' !~ '^[A-Z0-9]{6}$'
        or not (v_facts->'airlinePnrs' @> jsonb_build_array(v_number))
        or not (coalesce(v_booking.airlines_pnr,'[]'::jsonb) @> jsonb_build_array(v_number)) then
        return jsonb_build_object('ok',false,'eligible',false,'code','TICKET_EVIDENCE_INVALID');
      end if;
      v_row_numbers:=array_append(v_row_numbers,v_number#>>'{}');
      v_tickets:=v_tickets||jsonb_build_array(v_number);
    end loop;
  end loop;
  if coalesce(v_booking.ticket_numbers,'[]'::jsonb)<>'[]'::jsonb and v_booking.ticket_numbers is distinct from v_tickets then
    return jsonb_build_object('ok',false,'eligible',false,'code','TICKET_IDENTITY_CHANGED');
  end if;
  select * into v_operation from public.booking_operations where id=v_booking.active_operation_id and booking_id=p_booking_id;
  if not found or v_operation.kind is distinct from 'ticketing' or v_operation.state is distinct from 'needs_reconciliation'
     or v_operation.supplier is distinct from 'triplover' or v_operation.supplier_operation is distinct from 'NewTicket'
     or v_operation.supplier_call_started_at is null or v_operation.supplier_response_received_at is null
     or v_operation.supplier_evidence->'httpStatus' is distinct from '200'::jsonb
     or v_operation.supplier_evidence->'responseObserved' is distinct from 'true'::jsonb
     or v_operation.supplier_unique_trans_id is distinct from v_booking.supplier_refs->>'uniqueTransId'
     or v_operation.supplier_booking_code_ref is distinct from v_booking.booking_code_ref
     or v_operation.supplier_pnr is distinct from v_booking.pnr
     or v_booking.operation_kind is distinct from 'reconciliation'
     or v_booking.operation_reason is distinct from 'ticketing_reconciliation'
     or exists(select 1 from public.booking_operations o where o.booking_id=p_booking_id and o.id<>v_operation.id
       and o.state in ('claimed','supplier_call_started','awaiting_external_action','needs_reconciliation')) then
    return jsonb_build_object('ok',false,'eligible',false,'code','ORIGINAL_TICKETING_OPERATION_REQUIRED');
  end if;
  select * into v_case from public.booking_reconciliation_cases where subject_booking_id=p_booking_id
    and operation_id=v_operation.id and case_type='ticketing_uncertainty' and state in ('open','assigned','awaiting_supplier','awaiting_finance');
  if not found or v_case.proposal_hash is not null or v_case.approved_at is not null
     or exists(select 1 from public.booking_reconciliation_cases c
       where (c.subject_booking_id=p_booking_id or c.subject_booking_attempt_id=v_booking.attempt_id)
       and c.state not in ('resolved','closed_no_change','superseded') and c.id<>v_case.id) then
    return jsonb_build_object('ok',false,'eligible',false,'code','RECONCILIATION_REVIEW_REQUIRED');
  end if;
  v_accounting:=public.classify_superadmin_booking_accounting_v1(p_booking_id);
  if coalesce((v_accounting->>'ok')::boolean,false) is not true or v_accounting->>'accountingState' is distinct from 'active_hold' then
    return jsonb_build_object('ok',false,'eligible',false,'code','EXISTING_HOLD_ACCOUNTING_REQUIRED');
  end if;
  select * into v_reservation from public.wallet_reservations where id=(v_accounting->>'reservationId')::uuid;
  select * into v_account from public.wallet_accounts where id=v_reservation.wallet_account_id;
  select * into v_wallet from public.wallets where id=v_account.wallet_id;
  if v_reservation.booking_id is distinct from p_booking_id or v_reservation.state not in ('active','reconciliation')
     or v_reservation.supplier_call_started_at is null or v_reservation.captured_at is not null or v_reservation.released_at is not null
     or v_reservation.supplier_call_started_at>v_operation.supplier_call_started_at
     or v_reservation.currency is distinct from v_booking.currency or v_reservation.amount<=0
     or v_wallet.status is distinct from 'active' or v_wallet.owner_type is distinct from v_booking.booking_owner_type
     or v_wallet.owner_key is distinct from v_booking.booking_owner_key
     or (v_wallet.owner_type='user' and (v_booking.audience<>'b2c' or v_wallet.owner_key is distinct from v_booking.user_id))
     or (v_wallet.owner_type='agency' and (v_booking.audience<>'agency' or v_wallet.owner_key is distinct from v_booking.agency_code)) then
    return jsonb_build_object('ok',false,'eligible',false,'code','ORIGINAL_HOLD_IDENTITY_MISMATCH');
  end if;
  select coalesce(sum(amount),0)::bigint into v_hold_total from public.wallet_reservations
    where wallet_account_id=v_account.id and state in ('active','reconciliation');
  v_protected:=v_hold_total-v_reservation.amount;
  if v_account.hold_balance is distinct from v_hold_total then
    return jsonb_build_object('ok',false,'eligible',false,'code','PROTECTED_HOLD_ACCOUNTING_CONFLICT');
  end if;
  v_result:=jsonb_build_object('ok',true,'eligible',true,'checkId',v_check.id,'walletEffect','capture_hold',
    'amount',v_reservation.amount,'currency',v_reservation.currency,'availableBefore',v_account.available_balance,
    'availableAfter',v_account.available_balance,'holdBefore',v_account.hold_balance,
    'holdAfter',v_account.hold_balance-v_reservation.amount,'protectedHold',v_protected,
    'bookingId',p_booking_id,'operationId',v_operation.id,'caseId',v_case.id,
    'reservationId',v_reservation.id,'walletAccountId',v_account.id,
    'issuedAt',v_issued_at,'ticketNumbers',v_tickets);
  v_hash:=encode(sha256(convert_to(jsonb_build_object('preview',v_result,'bookingSnapshotHash',v_check.booking_snapshot_hash,
    'facts',v_facts,'wallet',to_jsonb(v_wallet),'account',to_jsonb(v_account),
    'protectedReservations',(select jsonb_agg(to_jsonb(r) order by r.id) from public.wallet_reservations r
      where r.wallet_account_id=v_account.id and r.state in ('active','reconciliation')))::text,'UTF8')),'hex');
  return v_result||jsonb_build_object('previewHash',v_hash);
exception when invalid_text_representation or numeric_value_out_of_range then
  return jsonb_build_object('ok',false,'eligible',false,'code','ISSUED_EVIDENCE_INVALID');
end;
$$;

create function public.confirm_triplover_issued_hold_v1(
  p_booking_id uuid,p_actor_user_id text,p_actor_role text,p_check_id uuid,p_preview_hash text,
  p_request_key text,p_money_movement_confirmed boolean
)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_role text; v_existing public.triplover_issued_hold_confirmations;
  v_preview jsonb; v_booking public.flight_bookings; v_check public.triplover_booking_status_checks;
  v_operation public.booking_operations; v_reservation public.wallet_reservations;
  v_ledger_id uuid; v_event_id bigint; v_decision_id uuid:=gen_random_uuid(); v_result jsonb;
  v_occurrence integer; v_from text;
begin
  select role into v_role from public.app_users where clerk_id=p_actor_user_id;
  if v_role is null or v_role not in ('admin','superadmin') then
    return jsonb_build_object('ok',false,'code','CONFIRMATION_FORBIDDEN');
  end if;
  if p_actor_role is distinct from v_role then return jsonb_build_object('ok',false,'code','ACTOR_ROLE_MISMATCH'); end if;
  if p_request_key is null or p_request_key !~ '^triplover-issued-hold:v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_booking_id is null or p_check_id is null or coalesce(p_preview_hash,'') !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('ok',false,'code','INVALID_CONFIRMATION_REQUEST');
  end if;
  if p_money_movement_confirmed is not true then
    return jsonb_build_object('ok',false,'code','MONEY_MOVEMENT_CONFIRMATION_REQUIRED');
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request_key,0));
  select * into v_existing from public.triplover_issued_hold_confirmations where request_key=p_request_key;
  if found then
    if v_existing.booking_id is distinct from p_booking_id or v_existing.check_id is distinct from p_check_id
       or v_existing.actor_user_id is distinct from p_actor_user_id or v_existing.actor_role is distinct from p_actor_role
       or v_existing.preview_hash is distinct from p_preview_hash then
      return jsonb_build_object('ok',false,'code','CONFIRMATION_REQUEST_CONFLICT');
    end if;
    return v_existing.result||jsonb_build_object('ok',true,'replay',true);
  end if;
  -- Existing lifecycle lock order, with the request lock outermost.
  select * into v_booking from public.flight_bookings where id=p_booking_id for update;
  if not found then return jsonb_build_object('ok',false,'code','BOOKING_NOT_FOUND'); end if;
  perform 1 from public.booking_operations where booking_id=p_booking_id order by id for update;
  perform 1 from public.booking_reconciliation_cases where subject_booking_id=p_booking_id
    or subject_booking_attempt_id=v_booking.attempt_id order by id for update;
  perform 1 from public.wallet_reservations where booking_id=p_booking_id
    or (booking_id is null and booking_attempt_id=v_booking.attempt_id) order by id for update;
  -- A preliminary preview discovers the exact existing account. No mutation.
  v_preview:=public.preview_triplover_issued_hold_confirmation_v1(p_booking_id,p_actor_user_id,p_actor_role,p_check_id);
  if coalesce((v_preview->>'eligible')::boolean,false) is not true then return v_preview; end if;
  perform 1 from public.wallets w join public.wallet_accounts a on a.wallet_id=w.id
    where a.id=(v_preview->>'walletAccountId')::uuid for update of w;
  perform 1 from public.wallet_accounts where id=(v_preview->>'walletAccountId')::uuid for update;
  -- Other hold writers also lock this wallet/account. Recheck after those locks.
  v_preview:=public.preview_triplover_issued_hold_confirmation_v1(p_booking_id,p_actor_user_id,p_actor_role,p_check_id);
  if coalesce((v_preview->>'eligible')::boolean,false) is not true then return v_preview; end if;
  if v_preview->>'previewHash' is distinct from p_preview_hash then
    return jsonb_build_object('ok',false,'code','PREVIEW_CHANGED');
  end if;
  select * into strict v_check from public.triplover_booking_status_checks where id=p_check_id;
  select * into strict v_operation from public.booking_operations where id=(v_preview->>'operationId')::uuid;
  select * into strict v_reservation from public.wallet_reservations where id=(v_preview->>'reservationId')::uuid;
  if exists(select 1 from public.wallet_ledger_entries where idempotency_key=p_request_key||':capture') then
    return jsonb_build_object('ok',false,'code','CAPTURE_IDEMPOTENCY_CONFLICT');
  end if;
  update public.wallet_accounts set hold_balance=hold_balance-v_reservation.amount where id=v_reservation.wallet_account_id;
  update public.wallet_reservations set state='captured',issued_by_user_id=p_actor_user_id,captured_at=clock_timestamp(),
    reconciliation_at=null,reconciliation_reason=null where id=v_reservation.id;
  insert into public.wallet_ledger_entries(wallet_account_id,transaction_type,amount,currency,
    available_before,available_after,hold_before,hold_after,booking_id,booking_reference,reservation_id,
    idempotency_key,created_by_user_id,created_by_role,remarks,metadata)
  values(v_reservation.wallet_account_id,'booking_confirm',v_reservation.amount,v_reservation.currency,
    (v_preview->>'availableBefore')::bigint,(v_preview->>'availableAfter')::bigint,
    (v_preview->>'holdBefore')::bigint,(v_preview->>'holdAfter')::bigint,p_booking_id,v_booking.public_ref,
    v_reservation.id,p_request_key||':capture',p_actor_user_id,p_actor_role,'Verified Triplover issued ticket: original hold capture',
    jsonb_build_object('decisionId',v_decision_id,'checkId',p_check_id,'operationId',v_operation.id,'previewHash',p_preview_hash))
    returning id into v_ledger_id;
  v_from:=public.resolve_booking_lifecycle(v_booking.status,v_booking.airlines_pnr,v_booking.ticketing_deadline_at,v_booking.operation_kind);
  update public.flight_bookings set status='confirmed',payment_state='captured',payment_amount=v_reservation.amount,
    captured_amount=v_reservation.amount,refunded_amount=0,charged_wallet_account_id=v_reservation.wallet_account_id,
    issued_by_user_id=p_actor_user_id,issued_at=(v_preview->>'issuedAt')::timestamptz,
    booking_status=v_check.facts->>'supplierStatus',ticket_numbers=v_preview->'ticketNumbers',
    airlines_pnr=v_check.facts->'airlinePnrs',ticket_code_ref=coalesce(nullif(btrim(v_check.facts->>'ticketCodeRef'),''),ticket_code_ref),
    active_operation_id=null,operation_kind=null,operation_reason=null,operation_request_id=null,
    operation_actor_user_id=null,operation_started_at=null,operation_prior_status=null where id=p_booking_id;
  update public.booking_operations set state='succeeded',completed_at=clock_timestamp(),error_code=null,error_message=null,
    supplier_evidence=supplier_evidence||jsonb_build_object('triploverIssuedHoldConfirmation',jsonb_build_object(
      'decisionId',v_decision_id,'checkId',p_check_id,'previewHash',p_preview_hash)) where id=v_operation.id;
  update public.booking_reconciliation_cases set state='resolved',resolution_outcome='ticketed',
    resolution=jsonb_build_object('decisionId',v_decision_id,'checkId',p_check_id,'requestKey',p_request_key,
      'financialDisposition','capture_existing_hold','ledgerEntryId',v_ledger_id),
    resolution_reason='Verified supplier-issued ticket; original issue hold captured',resolved_by_user_id=p_actor_user_id,
    resolved_at=clock_timestamp(),closed_at=clock_timestamp(),version=version+1 where id=(v_preview->>'caseId')::uuid;
  select count(*)::integer+1 into v_occurrence from public.booking_status_events where booking_id=p_booking_id and to_lifecycle_status='confirmed';
  insert into public.booking_status_events(booking_id,from_lifecycle_status,to_lifecycle_status,stored_status_before,
    stored_status_after,operation_kind,operation_reason,actor_user_id,supplier_operation,supplier_evidence,
    idempotency_key,operation_id,reconciliation_case_id,occurrence_number,effective_at,observed_at,event_snapshot,event_version)
  values(p_booking_id,v_from,'confirmed',v_booking.status,'confirmed',v_booking.operation_kind,v_booking.operation_reason,
    p_actor_user_id,'TriploverIssuedHoldConfirmation',jsonb_build_object('decisionId',v_decision_id,'checkId',p_check_id),
    p_request_key||':confirmed',v_operation.id,(v_preview->>'caseId')::uuid,v_occurrence,
    (v_preview->>'issuedAt')::timestamptz,clock_timestamp(),jsonb_build_object('version',1,'decisionId',v_decision_id,
      'checkId',p_check_id,'walletEffect','capture_hold','amount',v_reservation.amount,'currency',v_reservation.currency),1)
    returning id into v_event_id;
  v_result:=jsonb_build_object('ok',true,'replay',false,'confirmed',true,'decisionId',v_decision_id,'checkId',p_check_id,
    'bookingId',p_booking_id,'bookingReference',v_booking.public_ref,'bookingStatus','confirmed','paymentState','captured','walletEffect','capture_hold',
    'amount',v_reservation.amount,'capturedAmount',v_reservation.amount,'currency',v_reservation.currency,
    'availableBefore',v_preview->'availableBefore','availableAfter',v_preview->'availableAfter',
    'holdBefore',v_preview->'holdBefore','holdAfter',v_preview->'holdAfter',
    'ledgerEntryId',v_ledger_id,'lifecycleEventId',v_event_id);
  insert into public.triplover_issued_hold_confirmations(id,booking_id,check_id,actor_user_id,actor_role,request_key,
    preview_hash,reservation_id,ledger_entry_id,lifecycle_event_id,evidence,result)
  values(v_decision_id,p_booking_id,p_check_id,p_actor_user_id,p_actor_role,p_request_key,p_preview_hash,
    v_reservation.id,v_ledger_id,v_event_id,to_jsonb(v_check),v_result);
  return v_result;
end;
$$;

revoke all on function public.triplover_status_records_immutable_v1(),public.triplover_status_snapshot_v1(uuid),
  public.guard_triplover_issued_status_operation_v1()
  from public,anon,authenticated,service_role;
revoke all on function public.triplover_status_check_context_v1(uuid,text,text),
  public.record_triplover_status_check_v1(uuid,text,text,text,jsonb),
  public.preview_triplover_issued_hold_confirmation_v1(uuid,text,text,uuid),
  public.confirm_triplover_issued_hold_v1(uuid,text,text,uuid,text,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.triplover_status_check_context_v1(uuid,text,text),
  public.record_triplover_status_check_v1(uuid,text,text,text,jsonb),
  public.preview_triplover_issued_hold_confirmation_v1(uuid,text,text,uuid),
  public.confirm_triplover_issued_hold_v1(uuid,text,text,uuid,text,text,boolean) to service_role;
