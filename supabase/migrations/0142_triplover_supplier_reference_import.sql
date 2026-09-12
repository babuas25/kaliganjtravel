-- Extend Supplier API Import to Triplover's own TLL transaction references.
-- The original import migration predates the direct Triplover credential
-- account, so both its persisted authorization checks and its two atomic RPCs
-- must be widened together.

alter table public.supplier_reference_charge_authorizations
  drop constraint if exists supplier_reference_charge_account_check;
alter table public.supplier_reference_charge_authorizations
  add constraint supplier_reference_charge_account_check
  check (supplier_account in ('firsttrip', 'takeoff', 'triplover'));

alter table public.supplier_reference_charge_authorizations
  drop constraint if exists supplier_reference_charge_reference_check;
alter table public.supplier_reference_charge_authorizations
  add constraint supplier_reference_charge_reference_check
  check (supplier_reference ~ '^(FST|TOT|TLL)[0-9]{18}$');

do $migration$
declare
  v_signature text;
  v_definition text;
  v_updated text;
begin
  foreach v_signature in array array[
    'public.authorize_supplier_reference_charge_v1(text,text,bigint,bigint,jsonb,text)',
    'public.create_supplier_reference_booking_v1(text,text,bigint,bigint,jsonb,text,uuid,text)'
  ] loop
    select pg_get_functiondef(to_regprocedure(v_signature))
      into v_definition;

    if v_definition is null then
      raise exception 'required Supplier API Import function is missing: %',
        v_signature;
    end if;

    v_updated := replace(
      v_definition,
      'v_supplier_account not in (''firsttrip'', ''takeoff'')',
      'v_supplier_account not in (''firsttrip'', ''takeoff'', ''triplover'')'
    );
    v_updated := replace(
      v_updated,
      'or (v_supplier_account = ''takeoff''
       and v_supplier_reference !~ ''^TOT[0-9]{18}$'')',
      'or (v_supplier_account = ''takeoff''
       and v_supplier_reference !~ ''^TOT[0-9]{18}$'')
     or (v_supplier_account = ''triplover''
       and v_supplier_reference !~ ''^TLL[0-9]{18}$'')'
    );

    if v_updated = v_definition
       or position(
         'v_supplier_account not in (''firsttrip'', ''takeoff'', ''triplover'')'
         in v_updated
       ) = 0
       or position(
         'v_supplier_reference !~ ''^TLL[0-9]{18}$'''
         in v_updated
       ) = 0 then
      raise exception 'could not safely extend Supplier API Import function: %',
        v_signature;
    end if;

    execute v_updated;
  end loop;
end;
$migration$;

comment on function public.authorize_supplier_reference_charge_v1(
  text, text, bigint, bigint, jsonb, text
) is
  'Records a five-minute, one-use, exact-payload authorization for FirstTrip, TakeOff, or Triplover supplier-reference imports after checking the assigned owner wallet. It never mutates wallet money or creates a booking.';

comment on function public.create_supplier_reference_booking_v1(
  text, text, bigint, bigint, jsonb, text, uuid, text
) is
  'Atomically creates an ordinary Triplover API-backed booking from real FirstTrip, TakeOff, or Triplover references. Held and terminal historical imports make no wallet movement; explicit confirmed Import & Charge consumes one fresh authorization and writes the captured reservation and immutable ledger in the same transaction.';
