-- Enforce currency/account consistency at the database boundary and remove
-- direct service-role access to balance mutations. Balance changes must pass
-- through the audited SECURITY DEFINER wallet functions.

create or replace function public.enforce_wallet_account_currency()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_currency text;
begin
  select currency into strict v_currency
    from public.wallet_accounts
   where id = new.wallet_account_id;
  if new.currency <> v_currency then
    raise exception 'wallet currency does not match the selected account'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

do $$
begin
  if exists (
    select 1 from public.wallet_reservations r
    join public.wallet_accounts wa on wa.id = r.wallet_account_id
    where r.currency <> wa.currency
  ) or exists (
    select 1 from public.wallet_ledger_entries le
    join public.wallet_accounts wa on wa.id = le.wallet_account_id
    where le.currency <> wa.currency
  ) or exists (
    select 1 from public.wallet_deposit_requests dr
    join public.wallet_accounts wa on wa.id = dr.wallet_account_id
    where dr.currency <> wa.currency
  ) or exists (
    select 1 from public.wallet_adjustment_requests ar
    join public.wallet_accounts wa on wa.id = ar.wallet_account_id
    where ar.currency <> wa.currency
  ) then
    raise exception 'existing wallet currency mismatch must be reconciled';
  end if;
end;
$$;

drop trigger if exists wallet_reservations_currency_guard
  on public.wallet_reservations;
create trigger wallet_reservations_currency_guard
  before insert or update of wallet_account_id, currency
  on public.wallet_reservations
  for each row execute function public.enforce_wallet_account_currency();

drop trigger if exists wallet_ledger_currency_guard
  on public.wallet_ledger_entries;
create trigger wallet_ledger_currency_guard
  before insert on public.wallet_ledger_entries
  for each row execute function public.enforce_wallet_account_currency();

drop trigger if exists wallet_deposits_currency_guard
  on public.wallet_deposit_requests;
create trigger wallet_deposits_currency_guard
  before insert or update of wallet_account_id, currency
  on public.wallet_deposit_requests
  for each row execute function public.enforce_wallet_account_currency();

drop trigger if exists wallet_adjustments_currency_guard
  on public.wallet_adjustment_requests;
create trigger wallet_adjustments_currency_guard
  before insert or update of wallet_account_id, currency
  on public.wallet_adjustment_requests
  for each row execute function public.enforce_wallet_account_currency();

revoke all on table public.wallets,
  public.wallet_accounts,
  public.wallet_reservations,
  public.wallet_ledger_entries,
  public.wallet_deposit_requests,
  public.wallet_adjustment_requests
  from service_role;

grant select on table public.wallets,
  public.wallet_accounts,
  public.wallet_reservations,
  public.wallet_ledger_entries,
  public.wallet_deposit_requests,
  public.wallet_adjustment_requests
  to service_role;

grant update (status, frozen_at, frozen_by, freeze_reason)
  on table public.wallets to service_role;
grant insert on table public.wallet_deposit_requests,
  public.wallet_adjustment_requests to service_role;

revoke execute on function public.enforce_wallet_account_currency()
  from public, anon, authenticated, service_role;

