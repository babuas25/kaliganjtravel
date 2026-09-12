-- Treat the 0095 archival `superseded` state as terminal in the small number
-- of legacy functions that previously used a resolved/closed deny-list.
--
-- These forward redefinitions are deliberately source-guarded: each block
-- obtains the already-deployed function definition, verifies the exact known
-- predicate/anchor count, changes only that terminal-state handling, and then
-- re-creates the same function. If an unexpected function revision is live,
-- the migration fails before making a partial change. No function body runs
-- while this migration is applied, and no booking, supplier, wallet,
-- reservation, ledger, or case data is changed by this migration.

-- Shared resolution contracts must reject a superseded source before locking a
-- protected reservation or wallet. All exact outcome resolvers inherit this.
do $$
declare
  v_definition text;
  v_anchor text := $anchor$  if v_case.state in ('resolved', 'closed_no_change')
     or v_case.resolved_at is not null then$anchor$;
  v_guard text := $guard$  if v_case.state = 'superseded' then
    return jsonb_build_object(
      'ok', false,
      'code', 'PROPOSAL_SUPERSEDED',
      'caseId', v_case.id,
      'successorCaseId', v_case.superseded_by_case_id
    );
  end if;

$guard$;
begin
  select pg_get_functiondef(
    'public.booking_reconciliation_resolution_contract_v1(uuid,uuid,integer,text,text,text,text)'::regprocedure
  ) into v_definition;
  if v_definition is null
     or (length(v_definition) - length(replace(v_definition, v_anchor, '')))
        / nullif(length(v_anchor), 0) <> 1 then
    raise exception 'unexpected booking reconciliation resolution contract; refusing superseded compatibility rewrite'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_anchor, v_guard || v_anchor);
end;
$$;

-- A historic checker approval must not replay successfully after its proposal
-- has been superseded. The successor always requires a new independent
-- approval.
do $$
declare
  v_definition text;
  v_anchor text := $anchor$  if v_case.approved_at is not null then$anchor$;
  v_guard text := $guard$  if v_case.state = 'superseded' then
    return jsonb_build_object(
      'ok', false,
      'code', 'PROPOSAL_SUPERSEDED',
      'caseId', v_case.id,
      'successorCaseId', v_case.superseded_by_case_id
    );
  end if;
$guard$;
begin
  select pg_get_functiondef(
    'public.approve_booking_reconciliation_v1(uuid,uuid,integer,text,text)'::regprocedure
  ) into v_definition;
  if v_definition is null
     or (length(v_definition) - length(replace(v_definition, v_anchor, '')))
        / nullif(length(v_anchor), 0) <> 1 then
    raise exception 'unexpected reconciliation approval contract; refusing superseded compatibility rewrite'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_anchor, v_guard || v_anchor);
end;
$$;

-- Generic release remains unavailable while a real open case exists, but must
-- ignore a terminal superseded source after its successor is resolved.
do $$
declare
  v_definition text;
  v_find text := $find$       and reconciliation_case.state not in ('resolved', 'closed_no_change')$find$;
  v_replace text := $replace$       and reconciliation_case.state in (
         'open', 'assigned', 'awaiting_supplier', 'awaiting_finance', 'awaiting_approval'
       )$replace$;
begin
  select pg_get_functiondef(
    'public.wallet_release_reservation(uuid,uuid,text,text,text,text)'::regprocedure
  ) into v_definition;
  if v_definition is null
     or (length(v_definition) - length(replace(v_definition, v_find, '')))
        / nullif(length(v_find), 0) <> 2 then
    raise exception 'unexpected wallet release guard; refusing superseded compatibility rewrite'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_find, v_replace);
end;
$$;

-- The ordinary captured-booking refund path likewise ignores only terminal
-- source history; it still blocks on any active successor case.
do $$
declare
  v_definition text;
  v_find text := $find$     and reconciliation_case.state not in ('resolved', 'closed_no_change')$find$;
  v_replace text := $replace$     and reconciliation_case.state in (
       'open', 'assigned', 'awaiting_supplier', 'awaiting_finance', 'awaiting_approval'
     )$replace$;
begin
  select pg_get_functiondef(
    'public.wallet_refund_booking(uuid,bigint,text,text,text,text)'::regprocedure
  ) into v_definition;
  if v_definition is null
     or (length(v_definition) - length(replace(v_definition, v_find, '')))
        / nullif(length(v_find), 0) <> 1 then
    raise exception 'unexpected wallet refund guard; refusing superseded compatibility rewrite'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_find, v_replace);
end;
$$;

-- The live 0086 owner-confirm function must not treat a superseded historic
-- case as an active imported/manual case.
do $$
declare
  v_definition text;
  v_find text := $find$state not in ('resolved','closed_no_change')$find$;
  v_replace text := $replace$state in ('open','assigned','awaiting_supplier','awaiting_finance','awaiting_approval')$replace$;
begin
  select pg_get_functiondef(
    'public.wallet_confirm_impexp_booking(uuid,text,text)'::regprocedure
  ) into v_definition;
  if v_definition is null
     or (length(v_definition) - length(replace(v_definition, v_find, '')))
        / nullif(length(v_find), 0) <> 1 then
    raise exception 'unexpected imported/manual confirmation guard; refusing superseded compatibility rewrite'
      using errcode = '55000';
  end if;
  execute replace(v_definition, v_find, v_replace);
end;
$$;

-- The live 0086 manual-status function uses the same open-case selection.
-- It additionally fails closed when no active case exists, rather than ever
-- proceeding with a null case record after ignoring a terminal source.
do $$
declare
  v_definition text;
  v_find text := $find$state not in ('resolved','closed_no_change')$find$;
  v_replace text := $replace$state in ('open','assigned','awaiting_supplier','awaiting_finance','awaiting_approval')$replace$;
  v_anchor text := $anchor$      select * into v_reservation from public.wallet_reservations where booking_id=v_booking.id for update;
      if v_booking.payment_state<>'captured'$anchor$;
  v_guarded_anchor text := $guard$      select * into v_reservation from public.wallet_reservations where booking_id=v_booking.id for update;
      if v_case.id is null then
        return jsonb_build_object('ok',false,'code','MANUAL_TICKETING_RECONCILIATION_REQUIRED');
      end if;
      if v_booking.payment_state<>'captured'$guard$;
begin
  select pg_get_functiondef(
    'public.update_manual_booking_status_v1(uuid,text,text,jsonb,text)'::regprocedure
  ) into v_definition;
  if v_definition is null
     or (length(v_definition) - length(replace(v_definition, v_find, '')))
        / nullif(length(v_find), 0) <> 1
     or (length(v_definition) - length(replace(v_definition, v_anchor, '')))
        / nullif(length(v_anchor), 0) <> 1 then
    raise exception 'unexpected manual status guard; refusing superseded compatibility rewrite'
      using errcode = '55000';
  end if;
  v_definition := replace(v_definition, v_find, v_replace);
  execute replace(v_definition, v_anchor, v_guarded_anchor);
end;
$$;

comment on function public.booking_reconciliation_resolution_contract_v1(
  uuid, uuid, integer, text, text, text, text
) is
  'Shared reconciliation contract. A superseded source proposal is terminal and must use its successor case; no reservation or wallet lock is taken for that rejected source.';
