-- Keep the popup brief; staff choose one of the supported display durations.
alter table public.promotional_popup_settings
  add column auto_close_seconds integer not null default 10
  check (auto_close_seconds in (10, 15, 20, 25, 30));
