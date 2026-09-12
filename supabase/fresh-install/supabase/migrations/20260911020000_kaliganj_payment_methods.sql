-- New company payment configuration explicitly requested by owner.
-- Source: https://kaliganjtravel.com/ (2026-09-11). No historical records.
-- Allow multiple account numbers for the same MFS provider/payment type.
begin;
drop index if exists public.wallet_company_mfs_accounts_channel_key;
create unique index wallet_company_mfs_accounts_channel_key
  on public.wallet_company_mfs_accounts (lower(mfs_name), payment_type, account_number);

insert into public.wallet_company_bank_accounts
  (bank_name, account_name, account_number, branch_name, routing_number, sort_order)
values
  ('Islami Bank Bangladesh Ltd', 'Ibrahim Hossain', '20502870200832100', 'Kaligonj, Jhenaidah', '125440790', 0),
  ('Islami Bank Bangladesh Ltd', 'Kaliganj tour and Travel', '20502870100261215', 'Kaligonj, Jhenaidah', '125440790', 1),
  ('Dutch Bangla Bank', 'Kaliganj Tour And Travels', '2281100098356', 'Kaliganj Jhenaidah', '090440641', 2),
  ('City Bank PLC', 'Ibrahim Hossain', '2204404513001', 'Agent banking, Kaliganj Jhenaidah', '225272684', 3),
  ('City Bank PLC', 'KALIGANJ TOUR AND TRAVEL', '1504776623001', 'Jashore Branch', '225410941', 4),
  ('United Commercial Bank PLC', 'Ibrahim Hossain', '0453201000126954', 'JHENAIDAH', '245440641', 5),
  ('Sonali Bank', 'Ibrahim Hossain', '2409101030403', 'Kaliganj, Jhenaidah', '200440828', 6),
  ('Brac Bank', 'Kaliganj Tour and Travel', '2081511000001', 'Jossore Branch', null, 7),
  ('Brac Bank', 'Ibrahim Hossain', '1077767220001', 'Kaliganj, Jhenaidah', '060440642', 8),
  ('Pubali Bank PLC', 'Kaliganj Tour and Travel', '1377901000903', 'Kaliganj, Jhenaidah', '175440645', 9),
  ('IFIC Bank PLC', 'Kaliganj Tour and Travel', '0240108223001', 'Kaliganj, Jhenaidah', '120440803', 10)
on conflict (account_number) do nothing;

insert into public.wallet_company_mfs_accounts
  (mfs_name, account_number, payment_type, sort_order)
values
  ('bKash', '01795271171', 'send_money', 0),
  ('bKash', '01323800024', 'send_money', 1),
  ('bKash', '01985222661', 'cashout', 2),
  ('Nagad', '01795271171', 'send_money', 3),
  ('Nagad', '01323800024', 'send_money', 4),
  ('Nagad', '01985222661', 'cashout', 5)
on conflict (lower(mfs_name), payment_type, account_number) do nothing;
commit;
