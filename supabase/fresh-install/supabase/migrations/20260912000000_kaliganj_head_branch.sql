-- Configure the new company's cash deposit branch; the baseline intentionally
-- omitted the previous company's branch. Keep existing branch IDs intact.
begin;

insert into public.wallet_payment_branches (name, address, active, sort_order)
values (
  'Head Branch',
  '1st Floor, Janata Super Market, Kaligonj, Jhenaidah, Bangladesh',
  true,
  0
)
on conflict (lower(name)) do update set
  address = excluded.address,
  active = excluded.active;

commit;
