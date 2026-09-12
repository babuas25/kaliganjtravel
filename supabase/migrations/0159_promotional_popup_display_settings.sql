-- Keep popup targeting/timing together; existing artwork and publication are unchanged.
alter table public.promotional_popup_settings
  add column display_settings jsonb not null default
    '{"audience":"b2b","pages":["/dashboard","/dashboard/flight-search"],"showOnLogin":true,"delaySeconds":0,"repeatMinutes":60}'::jsonb
  check (
    jsonb_typeof(display_settings) = 'object'
    and display_settings ?& array['audience', 'pages', 'showOnLogin', 'delaySeconds', 'repeatMinutes']
    and display_settings->>'audience' in ('b2b', 'all')
    and jsonb_typeof(display_settings->'pages') = 'array'
    and jsonb_array_length(display_settings->'pages') between 1 and 3
    and display_settings->'pages' <@ '["/dashboard","/dashboard/flight-search","/dashboard/announcements"]'::jsonb
    and jsonb_typeof(display_settings->'showOnLogin') = 'boolean'
    and jsonb_typeof(display_settings->'delaySeconds') = 'number'
    and (display_settings->>'delaySeconds')::numeric between 0 and 300
    and (display_settings->>'delaySeconds')::numeric = trunc((display_settings->>'delaySeconds')::numeric)
    and display_settings->'repeatMinutes' in ('0'::jsonb, '15'::jsonb, '30'::jsonb, '60'::jsonb, '180'::jsonb, '360'::jsonb, '720'::jsonb, '1440'::jsonb, '10080'::jsonb)
    and ((display_settings->>'showOnLogin')::boolean or (display_settings->>'repeatMinutes')::integer > 0)
  );
