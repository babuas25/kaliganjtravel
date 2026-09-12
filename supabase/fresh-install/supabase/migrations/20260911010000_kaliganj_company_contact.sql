begin;

-- Public contact details from https://kaliganjtravel.com/, verified 2026-09-11.
-- This forward migration leaves the applied baseline and business records intact.
-- Login identity, licence, SMTP/BCC, SMS recipients and payment accounts are
-- separate settings: a public contact page does not establish those values.
do $company$
begin
  if not exists (select 1 from public.company_settings where id and display_name = 'Kaliganj Travels') then
    raise exception 'KALIGANJ_COMPANY_SETTINGS_REQUIRED';
  end if;
end $company$;

update public.company_settings
set phone = '+880 1795-271171',
    email = 'support@kaliganjtravel.com',
    address = '1st Floor, Janata Super Market, Kaligonj, Jhenaidah, Bangladesh'
where id;

commit;
