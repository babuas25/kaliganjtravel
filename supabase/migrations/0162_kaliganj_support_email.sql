begin;

-- Update the public support contact for existing installations.
update public.company_settings
set email = 'support@kaliganjtravel.com'
where id and display_name = 'Kaliganj Travels';

commit;
