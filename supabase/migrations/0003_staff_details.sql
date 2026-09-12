-- Shopon Travels International — staff records for agency sub users.
-- Applied with `supabase db push --linked` (project gvbovgdjqmskcjgowppa).
-- Safe to re-run: every statement is idempotent.
--
-- Deliberately **its own table, not columns on `user_profiles`**. Staff details
-- are employment facts about a person inside an agency; the profile is that
-- person's own travel identity, and the two are not the same record even where
-- a field name repeats. Keeping them apart means:
--
--   * staff fields never reach the company/business sections or the profile
--     completion meter, which counts `user_profiles` columns;
--   * a staff record can be deleted — the point of "remove this person's staff
--     details" — without touching their passport, bank account or login;
--   * `saveProfileAction`, which writes only the session user's own row, stays
--     exactly as strict as it is. Editing someone else's staff record is a
--     different action with its own ownership check, not a loosening of that.
--
-- There is intentionally **no `agency_code` column here.** Which agency a
-- person belongs to is already answered by `app_users.agency_code`, and that is
-- the authority; a copy on this table would be a second answer free to drift
-- from it. Listing an agency's staff joins through `app_users` instead.

create table if not exists public.staff_details (
  -- One record per person. Cascades with the account: deleting a sub user
  -- should not leave their employment details behind.
  user_id           text primary key
                    references public.app_users (clerk_id) on delete cascade,

  designation       text,
  email             text,
  phone             text,
  alternative_phone text,
  address           text,
  qualification     text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

drop trigger if exists staff_details_touch_updated_at on public.staff_details;
create trigger staff_details_touch_updated_at
  before update on public.staff_details
  for each row execute function public.touch_updated_at();

-- Same access model as every other table here: RLS on, no policies, which
-- denies anon and authenticated outright. Only the server's service-role key
-- gets in, and it checks agency ownership before reading or writing a row.
alter table public.staff_details enable row level security;
