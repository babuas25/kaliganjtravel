-- Managed homepage travel-offer section.
-- Public rendering uses the server-only service client; Super Admin, Admin,
-- and Media Staff edits are authorized in server actions and written through
-- service-only functions with optimistic versioning for text changes.

create table if not exists public.homepage_offer_settings (
  id          text primary key check (id = 'primary'),
  heading     text not null check (char_length(btrim(heading)) between 1 and 100),
  subheading  text not null check (char_length(btrim(subheading)) between 1 and 180),
  version     integer not null default 1 check (version > 0),
  updated_at  timestamptz not null default now(),
  updated_by  text not null check (char_length(updated_by) between 1 and 255)
);

create table if not exists public.homepage_travel_offers (
  id                uuid primary key,
  eyebrow           text not null check (char_length(btrim(eyebrow)) between 1 and 80),
  title              text not null check (char_length(btrim(title)) between 1 and 100),
  description        text not null check (char_length(btrim(description)) between 1 and 240),
  is_active          boolean not null default true,
  sort_order         integer not null check (sort_order between 0 and 2),
  image_public_id    text,
  image_url          text,
  image_format       text,
  image_width        integer,
  image_height       integer,
  image_updated_at   timestamptz,
  created_at         timestamptz not null default now(),
  created_by         text not null check (char_length(created_by) between 1 and 255),
  updated_at         timestamptz not null default now(),
  updated_by         text not null check (char_length(updated_by) between 1 and 255),
  constraint homepage_travel_offers_sort_order_key unique (sort_order),
  constraint homepage_travel_offers_image_complete check (
    (image_public_id is null and image_url is null and image_format is null
      and image_width is null and image_height is null and image_updated_at is null)
    or
    (char_length(btrim(image_public_id)) between 1 and 500
      and image_url ~ '^https://'
      and char_length(btrim(image_format)) between 2 and 12
      and image_width > 0 and image_height > 0 and image_updated_at is not null)
  )
);

alter table public.homepage_offer_settings enable row level security;
alter table public.homepage_travel_offers enable row level security;
revoke all on table public.homepage_offer_settings from public, anon, authenticated;
revoke all on table public.homepage_travel_offers from public, anon, authenticated;
grant select, insert, update, delete on table public.homepage_offer_settings to service_role;
grant select, insert, update, delete on table public.homepage_travel_offers to service_role;

insert into public.homepage_offer_settings (
  id, heading, subheading, version, updated_by
) values (
  'primary',
  'Save Big with Limited-Time Travel Offers',
  'Exclusive flight deals, all in one place.',
  1,
  'system:migration'
) on conflict (id) do nothing;

insert into public.homepage_travel_offers (
  id, eyebrow, title, description, is_active, sort_order, created_by, updated_by
) values
  (
    'bc665cb7-e276-42b9-a63f-cd931b2c3ea7',
    'Upgrade your airport experience',
    'BALAKA Executive Lounge',
    'Relax in style before your flight with premium amenities and fast-track service.',
    true, 0, 'system:migration', 'system:migration'
  ),
  (
    '460b0fb1-dc51-45d0-8473-8c233b9dfb73',
    'New offer',
    'EBL SkyLounge access',
    'Enjoy lounge access, refreshments and rest zones for your next journey.',
    true, 1, 'system:migration', 'system:migration'
  ),
  (
    '523f37e1-50d1-4094-8bfe-719af47ff077',
    'Best deals',
    'Exclusive loyalty rewards',
    'Earn points faster and redeem more rewards on every flight booking.',
    true, 2, 'system:migration', 'system:migration'
  )
on conflict (id) do nothing;

create or replace function public.replace_homepage_travel_offer_text_v1(
  p_actor_user_id text,
  p_expected_version integer,
  p_heading text,
  p_subheading text,
  p_offers jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_version integer;
  v_next_version integer;
  v_offer_count integer;
begin
  if p_actor_user_id is null
     or char_length(btrim(p_actor_user_id)) not between 1 and 255 then
    raise exception 'invalid homepage offer actor' using errcode = '22023';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'invalid homepage offer version' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_heading, ''))) not between 1 and 100
     or char_length(btrim(coalesce(p_subheading, ''))) not between 1 and 180 then
    raise exception 'invalid homepage offer section text' using errcode = '22023';
  end if;
  if p_offers is null or jsonb_typeof(p_offers) <> 'array'
     or jsonb_array_length(p_offers) <> 3 then
    raise exception 'homepage offers must contain exactly three items' using errcode = '22023';
  end if;

  v_offer_count := jsonb_array_length(p_offers);
  if exists (
    select 1
      from jsonb_array_elements(p_offers) item
     where jsonb_typeof(item) <> 'object'
        or coalesce(item->>'id', '') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or char_length(btrim(coalesce(item->>'eyebrow', ''))) not between 1 and 80
        or char_length(btrim(coalesce(item->>'title', ''))) not between 1 and 100
        or char_length(btrim(coalesce(item->>'description', ''))) not between 1 and 240
        or jsonb_typeof(item->'active') <> 'boolean'
  ) then
    raise exception 'invalid homepage offer item' using errcode = '22023';
  end if;
  if (
    select count(distinct item->>'id')
      from jsonb_array_elements(p_offers) item
  ) <> v_offer_count then
    raise exception 'duplicate homepage offer item' using errcode = '22023';
  end if;
  if (
    select count(*)
      from public.homepage_travel_offers existing
     where existing.id in (
       select (item->>'id')::uuid from jsonb_array_elements(p_offers) item
     )
  ) <> v_offer_count then
    raise exception 'unknown homepage offer item' using errcode = '22023';
  end if;

  select version
    into v_current_version
    from public.homepage_offer_settings
   where id = 'primary'
   for update;
  if not found then
    raise exception 'homepage offer settings are unavailable' using errcode = '55000';
  end if;
  if v_current_version <> p_expected_version then
    raise exception 'homepage offers changed in another session' using errcode = '40001';
  end if;

  update public.homepage_travel_offers existing
     set eyebrow = btrim(incoming.item->>'eyebrow'),
         title = btrim(incoming.item->>'title'),
         description = btrim(incoming.item->>'description'),
         is_active = (incoming.item->>'active')::boolean,
         sort_order = (incoming.ordinality - 1)::integer,
         updated_at = now(),
         updated_by = btrim(p_actor_user_id)
    from jsonb_array_elements(p_offers) with ordinality
         as incoming(item, ordinality)
   where existing.id = (incoming.item->>'id')::uuid;

  update public.homepage_offer_settings
     set heading = btrim(p_heading),
         subheading = btrim(p_subheading),
         version = version + 1,
         updated_at = now(),
         updated_by = btrim(p_actor_user_id)
   where id = 'primary'
  returning version into v_next_version;

  return v_next_version;
end;
$$;

create or replace function public.set_homepage_travel_offer_image_v1(
  p_actor_user_id text,
  p_offer_id uuid,
  p_image_public_id text,
  p_image_url text,
  p_image_format text,
  p_image_width integer,
  p_image_height integer,
  p_image_updated_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next_version integer;
begin
  if p_actor_user_id is null
     or char_length(btrim(p_actor_user_id)) not between 1 and 255
     or p_offer_id is null then
    raise exception 'invalid homepage offer image actor or item' using errcode = '22023';
  end if;
  if not (
    (p_image_public_id is null and p_image_url is null and p_image_format is null
      and p_image_width is null and p_image_height is null and p_image_updated_at is null)
    or
    (char_length(btrim(coalesce(p_image_public_id, ''))) between 1 and 500
      and coalesce(p_image_url, '') ~ '^https://'
      and char_length(btrim(coalesce(p_image_format, ''))) between 2 and 12
      and p_image_width > 0 and p_image_height > 0 and p_image_updated_at is not null)
  ) then
    raise exception 'invalid homepage offer image' using errcode = '22023';
  end if;

  perform version
    from public.homepage_offer_settings
   where id = 'primary'
   for update;
  if not found then
    raise exception 'homepage offer settings are unavailable' using errcode = '55000';
  end if;

  update public.homepage_travel_offers
     set image_public_id = p_image_public_id,
         image_url = p_image_url,
         image_format = p_image_format,
         image_width = p_image_width,
         image_height = p_image_height,
         image_updated_at = p_image_updated_at,
         updated_at = now(),
         updated_by = btrim(p_actor_user_id)
   where id = p_offer_id;
  if not found then
    raise exception 'unknown homepage offer item' using errcode = '22023';
  end if;

  update public.homepage_offer_settings
     set version = version + 1,
         updated_at = now(),
         updated_by = btrim(p_actor_user_id)
   where id = 'primary'
  returning version into v_next_version;

  return v_next_version;
end;
$$;

revoke all on function public.replace_homepage_travel_offer_text_v1(
  text, integer, text, text, jsonb
) from public, anon, authenticated;
grant execute on function public.replace_homepage_travel_offer_text_v1(
  text, integer, text, text, jsonb
) to service_role;

revoke all on function public.set_homepage_travel_offer_image_v1(
  text, uuid, text, text, text, integer, integer, timestamptz
) from public, anon, authenticated;
grant execute on function public.set_homepage_travel_offer_image_v1(
  text, uuid, text, text, text, integer, integer, timestamptz
) to service_role;

comment on table public.homepage_offer_settings is
  'Singleton version and section copy for the managed homepage travel offers.';
comment on table public.homepage_travel_offers is
  'Three ordered homepage offer cards managed by Super Admin, Admin, and Media Staff.';
