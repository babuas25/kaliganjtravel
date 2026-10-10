begin;

-- Bangla QR receiving accounts and manual wallet deposit requests.

create table if not exists public.wallet_company_bangla_qr_accounts (
  id            uuid primary key default gen_random_uuid(),
  merchant_name text not null
                check (char_length(trim(merchant_name)) between 1 and 150),
  bank_name     text
                check (bank_name is null or char_length(trim(bank_name)) between 1 and 150),
  merchant_id   text
                check (merchant_id is null or char_length(trim(merchant_id)) between 1 and 100),
  qr_code       jsonb check (qr_code is null or jsonb_typeof(qr_code) = 'object'),
  active        boolean not null default true,
  sort_order    integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists wallet_company_bangla_qr_accounts_touch_updated_at
  on public.wallet_company_bangla_qr_accounts;
create trigger wallet_company_bangla_qr_accounts_touch_updated_at
  before update on public.wallet_company_bangla_qr_accounts
  for each row execute function public.touch_updated_at();

alter table public.wallet_deposit_requests
  add column if not exists bangla_qr_account_id uuid
    references public.wallet_company_bangla_qr_accounts (id) on delete restrict;

alter table public.wallet_deposit_requests
  drop constraint if exists wallet_deposit_requests_method_check;
alter table public.wallet_deposit_requests
  add constraint wallet_deposit_requests_method_check
  check (method in ('cash', 'bangla_qr', 'bank', 'bank_transfer', 'mobile', 'cheque'));

-- Preserve legacy requests while requiring complete fields on every new write.
-- The existing manual review function applies to every method and credits a
-- wallet only after Accounts approval; Bangla QR has no separate settlement.
alter table public.wallet_deposit_requests
  drop constraint if exists wallet_deposit_method_fields_check;
alter table public.wallet_deposit_requests
  add constraint wallet_deposit_method_fields_check check (
    (method = 'cash'
      and branch_id is not null
      and received_by_user_id is not null)
    or
    (method = 'bangla_qr'
      and bangla_qr_account_id is not null
      and nullif(trim(reference_number), '') is not null
      and attachment is not null)
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

alter table public.wallet_company_bangla_qr_accounts enable row level security;
revoke all on table public.wallet_company_bangla_qr_accounts
  from public, anon, authenticated;
grant select, insert, update, delete on table public.wallet_company_bangla_qr_accounts
  to service_role;

comment on column public.wallet_company_bangla_qr_accounts.qr_code is
  'Public Cloudinary image handle or a bundled localPath under /images/payments/.';
comment on column public.wallet_deposit_requests.bangla_qr_account_id is
  'Company Bangla QR receiving account selected for a manual deposit request.';

-- The site owner explicitly chose the same supplied Shapon Travels merchant QR.
-- These QR image bytes are preserved from the original attached PDF.
insert into public.wallet_company_bangla_qr_accounts
  (id, merchant_name, bank_name, merchant_id, qr_code, active, sort_order)
values
  ('0bb7a4ae-bf95-4e49-8d96-0ea527314650', 'SHAPON TRAVELS INTERNATIONAL',
   'Sonali Bank PLC', 'QR31469450',
   '{"localPath":"/images/payments/bangla-qr.png"}'::jsonb, true, 0)
on conflict (id) do nothing;

commit;
