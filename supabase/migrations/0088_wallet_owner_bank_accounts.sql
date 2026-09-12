-- Multiple sender bank accounts for the owner of a wallet. B2B members share
-- the agency-owned rows because their wallet owner is the agency code.

create table if not exists public.wallet_owner_bank_accounts (
  id             uuid primary key default gen_random_uuid(),
  owner_type     text not null check (owner_type in ('user', 'agency')),
  owner_key      text not null check (char_length(trim(owner_key)) between 1 and 255),
  bank_name      text not null check (char_length(trim(bank_name)) between 2 and 150),
  account_name   text not null check (char_length(trim(account_name)) between 2 and 150),
  account_number text not null check (char_length(trim(account_number)) between 3 and 100),
  branch_code    text,
  routing_number text,
  swift_code     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (owner_type, owner_key, account_number)
);

create index if not exists wallet_owner_bank_accounts_owner_idx
  on public.wallet_owner_bank_accounts (owner_type, owner_key, bank_name, account_name);

drop trigger if exists wallet_owner_bank_accounts_touch_updated_at
  on public.wallet_owner_bank_accounts;
create trigger wallet_owner_bank_accounts_touch_updated_at
  before update on public.wallet_owner_bank_accounts
  for each row execute function public.touch_updated_at();

alter table public.wallet_owner_bank_accounts enable row level security;
revoke all on table public.wallet_owner_bank_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.wallet_owner_bank_accounts to service_role;

-- Preserve existing profile-bank users as their first saved account. A B2B
-- profile moves under its shared agency wallet; all other profiles stay with
-- their personal wallet owner. This keeps existing transfer users working
-- while new accounts use the dedicated multi-account store.
insert into public.wallet_owner_bank_accounts (
  owner_type,
  owner_key,
  bank_name,
  account_name,
  account_number,
  branch_code,
  routing_number,
  swift_code
)
select
  case
    when u.role in ('b2b', 'b2b_sub') and u.agency_code is not null then 'agency'
    else 'user'
  end,
  case
    when u.role in ('b2b', 'b2b_sub') and u.agency_code is not null then u.agency_code
    else u.clerk_id
  end,
  p.bank_name,
  p.account_name,
  p.account_number,
  nullif(trim(p.branch_code), ''),
  nullif(trim(p.routing_number), ''),
  nullif(trim(p.swift_code), '')
from public.user_profiles p
join public.app_users u on u.clerk_id = p.clerk_id
where nullif(trim(p.bank_name), '') is not null
  and nullif(trim(p.account_name), '') is not null
  and nullif(trim(p.account_number), '') is not null
on conflict (owner_type, owner_key, account_number) do nothing;

-- The account ID is deliberately not a foreign key. A saved account can be
-- deleted after use; the immutable `user_bank_account` JSON snapshot is the
-- historical source of truth while this ID retains the original audit link.
alter table public.wallet_deposit_requests
  add column if not exists source_bank_account_id uuid;

alter table public.wallet_deposit_requests
  drop constraint if exists wallet_deposit_method_fields_check;
alter table public.wallet_deposit_requests
  add constraint wallet_deposit_method_fields_check check (
    (method = 'cash'
      and branch_id is not null
      and received_by_user_id is not null)
    or
    (method = 'bank'
      and company_bank_account_id is not null
      and deposit_date is not null
      and nullif(trim(reference_number), '') is not null
      and attachment is not null)
    or
    (method = 'bank_transfer'
      and company_bank_account_id is not null
      and source_bank_account_id is not null
      and user_bank_account is not null
      and deposit_date is not null
      and nullif(trim(reference_number), '') is not null
      and attachment is not null)
    or
    (method = 'mobile'
      and mfs_provider is not null
      and mfs_account_id is not null
      and mfs_payment_type is not null
      and deposit_date is not null
      and nullif(trim(reference_number), '') is not null
      and gateway_fee_bps is not null
      and gross_amount is not null
      and attachment is not null)
    or
    (method = 'cheque'
      and cheque_issued_date is not null
      and cheque_issued_bank is not null
      and payment_date is not null
      and company_bank_account_id is not null
      and nullif(trim(reference_number), '') is not null
      and attachment is not null)
  ) not valid;

comment on table public.wallet_owner_bank_accounts is
  'Saved sender bank accounts scoped to a wallet owner; B2B accounts are agency-scoped.';
comment on column public.wallet_deposit_requests.source_bank_account_id is
  'Original selected saved sender account ID. It may outlive the saved account; user_bank_account is the immutable snapshot.';
