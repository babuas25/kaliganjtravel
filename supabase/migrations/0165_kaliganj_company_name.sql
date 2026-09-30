begin;

-- Update the company identity used for future notification snapshots.
-- Existing notification snapshots retain the name recorded at creation.
update public.company_settings
set display_name = 'Kaliganj Tours & Travel'
where id and display_name = 'Kaliganj Travels';

commit;
