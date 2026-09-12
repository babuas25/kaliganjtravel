-- Shopon Travels International — user registry + dashboard profiles.
-- Applied with `supabase db push --linked` (project gvbovgdjqmskcjgowppa).
-- Safe to re-run: every statement is idempotent.
--
-- Access model: no client ever queries these tables. RLS is enabled with NO
-- policies, which denies anon and authenticated outright; the server's
-- service-role key bypasses RLS and is the only way in. Clerk stays the
-- authority on identity and role — app_users mirrors it so the dashboard can
-- list and filter people without paging the Clerk API.

-- ── Shared updated_at trigger ────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── Registry: one row per person who has opened the dashboard ────────────
create table if not exists public.app_users (
  clerk_id     text primary key,
  email        text,
  first_name   text,
  last_name    text,
  -- Mirror of Clerk publicMetadata.role. Never written from the dev role
  -- switcher, so previewing as another role cannot rewrite the real one.
  role         text not null default 'customer',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists app_users_role_idx on public.app_users (role);
create index if not exists app_users_email_idx on public.app_users (email);

drop trigger if exists app_users_touch_updated_at on public.app_users;
create trigger app_users_touch_updated_at
  before update on public.app_users
  for each row execute function public.touch_updated_at();

-- ── Profiles: the dashboard form, one row per user ───────────────────────
-- Column names are the snake_case of the field names in lib/profile.ts, and
-- lib/db/profiles.ts converts between them mechanically. Renaming a field
-- there means renaming the column here.
--
-- Everything is nullable: a profile is filled in over time, and a half-filled
-- form still saves. Blank inputs are stored as NULL, never ''.
create table if not exists public.user_profiles (
  clerk_id       text primary key
                 references public.app_users (clerk_id) on delete cascade,

  -- Personal
  given_name     text,
  surname        text,
  gender         text,
  date_of_birth  date,
  address        text,

  -- Passport
  nationality    text,
  passport_no    text,
  passport_expiry date,

  -- Contact
  mobile         text,
  email          text,

  -- Business info (B2B)
  agency_name    text,
  agency_address text,
  agency_email   text,
  agency_mobile  text,
  website        text,
  facebook_page  text,

  -- Bank account (B2B + customers)
  bank_name      text,
  account_name   text,
  account_number text,
  routing_number text,
  swift_code     text,
  branch_code    text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

drop trigger if exists user_profiles_touch_updated_at on public.user_profiles;
create trigger user_profiles_touch_updated_at
  before update on public.user_profiles
  for each row execute function public.touch_updated_at();

-- Business documents (trade license, TIN, agency license, NID, agency logo)
-- are deliberately absent — they are files, and land with the upload slice as
-- <name>_path columns pointing into a private Storage bucket.

-- ── Lock both tables down ────────────────────────────────────────────────
alter table public.app_users enable row level security;
alter table public.user_profiles enable row level security;
