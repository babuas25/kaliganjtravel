-- Method-specific wallet deposit requests and the company's payment catalogs.

create table if not exists public.wallet_payment_branches (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(trim(name)) between 1 and 150),
  address    text,
  active     boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists wallet_payment_branches_name_key
  on public.wallet_payment_branches (lower(name));

drop trigger if exists wallet_payment_branches_touch_updated_at
  on public.wallet_payment_branches;
create trigger wallet_payment_branches_touch_updated_at
  before update on public.wallet_payment_branches
  for each row execute function public.touch_updated_at();

create table if not exists public.wallet_company_bank_accounts (
  id             uuid primary key default gen_random_uuid(),
  bank_name      text not null check (char_length(trim(bank_name)) between 1 and 150),
  account_name   text not null check (char_length(trim(account_name)) between 1 and 150),
  account_number text not null check (char_length(trim(account_number)) between 1 and 100),
  branch_name    text,
  branch_code    text,
  routing_number text,
  swift_code     text,
  logo           jsonb
                 check (logo is null or jsonb_typeof(logo) = 'object'),
  active         boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.wallet_company_bank_accounts
  add column if not exists logo jsonb
    check (logo is null or jsonb_typeof(logo) = 'object');

alter table public.wallet_company_bank_accounts
  add column if not exists branch_code text;

create unique index if not exists wallet_company_bank_accounts_number_key
  on public.wallet_company_bank_accounts (account_number);

drop trigger if exists wallet_company_bank_accounts_touch_updated_at
  on public.wallet_company_bank_accounts;
create trigger wallet_company_bank_accounts_touch_updated_at
  before update on public.wallet_company_bank_accounts
  for each row execute function public.touch_updated_at();

create table if not exists public.wallet_company_mfs_accounts (
  id             uuid primary key default gen_random_uuid(),
  mfs_name       text not null check (char_length(trim(mfs_name)) between 1 and 100),
  account_number text not null check (char_length(trim(account_number)) between 3 and 100),
  payment_type   text not null check (payment_type in ('merchant', 'send_money', 'cashout')),
  charge_bps     integer not null default 0 check (charge_bps between 0 and 10000),
  logo           jsonb check (logo is null or jsonb_typeof(logo) = 'object'),
  qr_code        jsonb check (qr_code is null or jsonb_typeof(qr_code) = 'object'),
  active         boolean not null default true,
  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists wallet_company_mfs_accounts_channel_key
  on public.wallet_company_mfs_accounts (lower(mfs_name), payment_type);

drop trigger if exists wallet_company_mfs_accounts_touch_updated_at
  on public.wallet_company_mfs_accounts;
create trigger wallet_company_mfs_accounts_touch_updated_at
  before update on public.wallet_company_mfs_accounts
  for each row execute function public.touch_updated_at();

insert into public.wallet_payment_branches (id, name, address, sort_order)
values (
  '00000000-0000-4000-8000-000000000001',
  'Head Office',
  'Shomobai Shopping Market (2nd Floor), Dhankhola Bazar, Gangni, Meherpur-7110',
  0
)
on conflict (id) do update set
  name = excluded.name,
  address = excluded.address;

alter table public.wallet_deposit_requests
  add column if not exists branch_id uuid
    references public.wallet_payment_branches (id) on delete restrict,
  add column if not exists received_by_user_id text,
  add column if not exists company_bank_account_id uuid
    references public.wallet_company_bank_accounts (id) on delete restrict,
  add column if not exists deposit_date date,
  add column if not exists cheque_issued_date date,
  add column if not exists cheque_issued_bank text,
  add column if not exists payment_date date,
  add column if not exists mfs_provider text,
  add column if not exists mfs_account_id uuid
    references public.wallet_company_mfs_accounts (id) on delete restrict,
  add column if not exists mfs_payment_type text
    check (mfs_payment_type in ('merchant', 'send_money', 'cashout')),
  add column if not exists gateway_fee_bps integer
    check (gateway_fee_bps between 0 and 10000),
  add column if not exists gross_amount bigint check (gross_amount > 0),
  add column if not exists attachment jsonb
    check (attachment is null or jsonb_typeof(attachment) = 'object');

alter table public.wallet_deposit_requests
  drop constraint if exists wallet_deposit_requests_method_check;
alter table public.wallet_deposit_requests
  add constraint wallet_deposit_requests_method_check
  check (method in ('cash', 'bank', 'mobile', 'cheque'));

-- NOT VALID preserves legacy generic requests while enforcing complete fields
-- for every new request written after this migration.
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

alter table public.wallet_payment_branches enable row level security;
alter table public.wallet_company_bank_accounts enable row level security;
alter table public.wallet_company_mfs_accounts enable row level security;

revoke all on table public.wallet_payment_branches,
  public.wallet_company_bank_accounts,
  public.wallet_company_mfs_accounts from public, anon, authenticated;
grant select, insert, update, delete on table public.wallet_payment_branches,
  public.wallet_company_bank_accounts,
  public.wallet_company_mfs_accounts to service_role;

comment on column public.wallet_deposit_requests.attachment is
  'Authenticated Cloudinary handle; never a public or expiring URL.';
