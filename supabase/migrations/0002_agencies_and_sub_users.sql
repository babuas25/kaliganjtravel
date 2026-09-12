-- Shopon Travels International — agencies and their sub users.
-- Applied with `supabase db push --linked` (project gvbovgdjqmskcjgowppa).
-- Safe to re-run: every statement is idempotent.
--
-- A B2B partner is the *owner* of an agency; a Sub User is a *member* of one.
-- The agency is the durable record and `agency_code` is its identity — a
-- branded, human-readable string that can be quoted to support, printed on a
-- report and kept through a change of authentication provider. Nothing here
-- names Clerk, deliberately: `owner_user_id` and `app_users.clerk_id` hold
-- whatever the current provider calls a user id, and the relationship between
-- an agency and its people is expressed entirely in these two tables.
--
-- **This is the source of truth for the parent-agency relationship.** The
-- provider's user metadata may mirror `agency_code` for convenience — an
-- invitation has to carry it before any row exists — but every authorization
-- decision reads the database, never the mirror.

-- ── Agencies ─────────────────────────────────────────────────────────────
-- The code is the primary key, so uniqueness is enforced by Postgres rather
-- than by a check-then-insert in application code, which would race. The
-- generator inserts a candidate and retries on 23505; see lib/db/agencies.ts.
--
-- The format is pinned here as well as in lib/agency.ts. A code that does not
-- match cannot be stored at all, whatever wrote it.
create table if not exists public.agencies (
  agency_code   text primary key
                check (agency_code ~ '^ST-B2B[0-9]{6}$'),

  -- The B2B partner who owns the agency. Nullable and `set null` on delete:
  -- an agency outlives the person who opened it, because its sub users and
  -- its bookings still point at it. An unowned agency is simply one nobody
  -- can administer — every ownership check below fails closed on NULL.
  owner_user_id text unique
                references public.app_users (clerk_id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

drop trigger if exists agencies_touch_updated_at on public.agencies;
create trigger agencies_touch_updated_at
  before update on public.agencies
  for each row execute function public.touch_updated_at();

-- ── Membership ───────────────────────────────────────────────────────────
-- Which agency a person belongs to. Set for both roles: an owner belongs to
-- their own agency, so "everyone in agency X" is one predicate rather than a
-- union of the owner and the members.
--
-- `set null` on delete for the same reason as above — losing the agency row
-- must not delete the people in it.
alter table public.app_users
  add column if not exists agency_code text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'app_users_agency_code_fkey'
  ) then
    alter table public.app_users
      add constraint app_users_agency_code_fkey
      foreign key (agency_code) references public.agencies (agency_code)
      on delete set null;
  end if;
end $$;

-- Listing an agency's sub users filters on both columns together.
create index if not exists app_users_agency_code_idx
  on public.app_users (agency_code, role);

-- ── Lock it down ─────────────────────────────────────────────────────────
-- Same access model as 0001: RLS on, no policies, which denies anon and
-- authenticated outright. Only the server's service-role key gets in.
alter table public.agencies enable row level security;
