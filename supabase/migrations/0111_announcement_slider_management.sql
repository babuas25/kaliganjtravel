-- Managed public announcement slider.
--
-- The public site reads these rows through the server-only service client.
-- Dashboard writes replace the complete ordered set in one transaction, with
-- an optimistic version check so two editors cannot silently overwrite one
-- another.

create table if not exists public.announcement_slider_settings (
  id          text primary key check (id = 'primary'),
  version     integer not null default 1 check (version > 0),
  updated_at  timestamptz not null default now(),
  updated_by  text not null check (char_length(updated_by) between 1 and 255)
);

create table if not exists public.announcement_slider_messages (
  id          uuid primary key,
  message     text not null
              check (char_length(btrim(message)) between 1 and 180),
  is_active   boolean not null default true,
  sort_order  integer not null check (sort_order >= 0),
  created_at  timestamptz not null default now(),
  created_by  text not null check (char_length(created_by) between 1 and 255),
  updated_at  timestamptz not null default now(),
  updated_by  text not null check (char_length(updated_by) between 1 and 255)
);

create index if not exists announcement_slider_messages_order_idx
  on public.announcement_slider_messages (sort_order, created_at, id);

alter table public.announcement_slider_settings enable row level security;
alter table public.announcement_slider_messages enable row level security;
revoke all on table public.announcement_slider_settings
  from public, anon, authenticated;
revoke all on table public.announcement_slider_messages
  from public, anon, authenticated;
grant select, insert, update, delete on table public.announcement_slider_settings
  to service_role;
grant select, insert, update, delete on table public.announcement_slider_messages
  to service_role;

insert into public.announcement_slider_settings (id, version, updated_by)
values ('primary', 1, 'system:migration')
on conflict (id) do nothing;

insert into public.announcement_slider_messages (
  id, message, is_active, sort_order, created_by, updated_by
)
values
  (
    'c32b714b-78c4-4e06-a6e6-1448f78fb629',
    'Summer Sale — up to 40% off select flights to Europe',
    true, 0, 'system:migration', 'system:migration'
  ),
  (
    'ee4ace2c-f824-4f9a-9c18-153a90350666',
    'New route: London → Tokyo now available daily',
    true, 1, 'system:migration', 'system:migration'
  ),
  (
    '834c5ffd-b94f-4382-a397-434994e29bed',
    'Members earn 2x miles on weekend bookings',
    true, 2, 'system:migration', 'system:migration'
  ),
  (
    '435fbed5-14c5-4530-a84d-e23af430bb29',
    'Free cancellation on Premium fares through August',
    true, 3, 'system:migration', 'system:migration'
  )
on conflict (id) do nothing;

create or replace function public.replace_announcement_slider_messages_v1(
  p_actor_user_id text,
  p_expected_version integer,
  p_messages jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_version integer;
  v_next_version integer;
  v_message_count integer;
begin
  if p_actor_user_id is null
     or char_length(btrim(p_actor_user_id)) not between 1 and 255 then
    raise exception 'invalid announcement actor' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'invalid announcement version' using errcode = '22023';
  end if;
  if p_messages is null or jsonb_typeof(p_messages) <> 'array' then
    raise exception 'announcement messages must be an array' using errcode = '22023';
  end if;

  v_message_count := jsonb_array_length(p_messages);
  if v_message_count > 12 then
    raise exception 'too many announcement messages' using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_array_elements(p_messages) item
     where jsonb_typeof(item) <> 'object'
        or not (item ? 'id')
        or coalesce(item->>'id', '') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or not (item ? 'text')
        or char_length(btrim(coalesce(item->>'text', ''))) not between 1 and 180
        or not (item ? 'active')
        or jsonb_typeof(item->'active') <> 'boolean'
  ) then
    raise exception 'invalid announcement message' using errcode = '22023';
  end if;

  if (
    select count(distinct item->>'id')
      from jsonb_array_elements(p_messages) item
  ) <> v_message_count then
    raise exception 'duplicate announcement message id' using errcode = '22023';
  end if;

  select version
    into v_current_version
    from public.announcement_slider_settings
   where id = 'primary'
   for update;

  if not found then
    raise exception 'announcement settings are unavailable' using errcode = '55000';
  end if;
  if v_current_version <> p_expected_version then
    raise exception 'announcement settings changed in another session'
      using errcode = '40001';
  end if;

  delete from public.announcement_slider_messages existing
   where not exists (
     select 1
       from jsonb_array_elements(p_messages) item
      where (item->>'id')::uuid = existing.id
   );

  insert into public.announcement_slider_messages (
    id, message, is_active, sort_order, created_by, updated_by
  )
  select
    (item->>'id')::uuid,
    btrim(item->>'text'),
    (item->>'active')::boolean,
    (ordinality - 1)::integer,
    btrim(p_actor_user_id),
    btrim(p_actor_user_id)
  from jsonb_array_elements(p_messages) with ordinality as incoming(item, ordinality)
  on conflict (id) do update
    set message = excluded.message,
        is_active = excluded.is_active,
        sort_order = excluded.sort_order,
        updated_at = now(),
        updated_by = excluded.updated_by;

  update public.announcement_slider_settings
     set version = version + 1,
         updated_at = now(),
         updated_by = btrim(p_actor_user_id)
   where id = 'primary'
  returning version into v_next_version;

  return v_next_version;
end;
$$;

revoke all on function public.replace_announcement_slider_messages_v1(
  text, integer, jsonb
) from public, anon, authenticated;
grant execute on function public.replace_announcement_slider_messages_v1(
  text, integer, jsonb
) to service_role;

comment on table public.announcement_slider_settings is
  'Singleton version and editor metadata for the public announcement slider.';
comment on table public.announcement_slider_messages is
  'Ordered public announcement-slider messages managed by Super Admin, Admin, and Media Staff.';
comment on function public.replace_announcement_slider_messages_v1(text, integer, jsonb) is
  'Atomically validates and replaces the complete ordered announcement-slider message set.';
