-- Separate bank deposits from bank transfers and retain the user's source account.

alter table public.wallet_deposit_requests
  add column if not exists user_bank_account jsonb
    check (
      user_bank_account is null
      or jsonb_typeof(user_bank_account) = 'object'
    );

alter table public.wallet_deposit_requests
  drop constraint if exists wallet_deposit_requests_method_check;
alter table public.wallet_deposit_requests
  add constraint wallet_deposit_requests_method_check
  check (method in ('cash', 'bank', 'bank_transfer', 'mobile', 'cheque'));

-- NOT VALID keeps legacy rows while enforcing complete method fields for all
-- new requests written after this migration.
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

comment on column public.wallet_deposit_requests.user_bank_account is
  'Snapshot of the requesting user saved bank account selected for a bank transfer.';
