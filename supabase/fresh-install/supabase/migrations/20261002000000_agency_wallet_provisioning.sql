-- Create the agency's BDT wallet when its identity is established, so financial
-- operators can find it before the partner first opens their wallet dashboard.
-- The existing account helper only inserts missing zero-balance accounts; it
-- preserves funded/frozen wallets, account IDs and all financial history.
begin;

create or replace function public.provision_agency_wallet()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.wallet_ensure_account('agency', new.agency_code, 'BDT');
  return new;
end;
$$;

revoke all on function public.provision_agency_wallet()
  from public, anon, authenticated, service_role;

drop trigger if exists agencies_provision_wallet on public.agencies;
create trigger agencies_provision_wallet
  after insert on public.agencies
  for each row execute function public.provision_agency_wallet();

-- Repair existing agencies that never visited the wallet/deposit page.
do $$
declare
  v_agency record;
begin
  for v_agency in
    select agency_code from public.agencies order by agency_code
  loop
    perform public.wallet_ensure_account('agency', v_agency.agency_code, 'BDT');
  end loop;
end;
$$;

commit;
