-- Staff-managed promotional carousel; disabled until artwork is configured.
create table public.promotional_popup_settings (
  id text primary key default 'primary' check (id = 'primary'),
  enabled boolean not null default false,
  slides jsonb not null default '[]'::jsonb check (jsonb_typeof(slides) = 'array' and jsonb_array_length(slides) <= 6),
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.promotional_popup_settings enable row level security;
revoke all on public.promotional_popup_settings from anon, authenticated;
grant select, update on public.promotional_popup_settings to service_role;
insert into public.promotional_popup_settings (id) values ('primary');
