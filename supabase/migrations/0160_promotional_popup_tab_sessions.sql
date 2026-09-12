-- Each new tab may show the promotion independently of other open tabs.
-- Preserve the audience, eligible pages, delay and repeat interval already saved.
update public.promotional_popup_settings
set display_settings = display_settings || '{"frequencyScope":"tab"}'::jsonb,
    version = version + 1,
    updated_at = now()
where not (display_settings ? 'frequencyScope');

alter table public.promotional_popup_settings
  alter column display_settings set default
    '{"audience":"b2b","frequencyScope":"tab","pages":["/dashboard","/dashboard/flight-search"],"showOnLogin":true,"delaySeconds":0,"repeatMinutes":60}'::jsonb,
  add constraint promotional_popup_frequency_scope_check
    check (display_settings ? 'frequencyScope' and display_settings->'frequencyScope' in ('"browser"'::jsonb, '"tab"'::jsonb));
