-- Shopon Travels International — customer → B2B upgrade requests.
-- Applied with `supabase db push --linked` (project gvbovgdjqmskcjgowppa).
-- Safe to re-run: every statement is idempotent.
--
-- A customer asks to become a B2B partner from the sidebar's "Upgrade to
-- Business" button; an admin accepts or rejects it in Users & Roles. This table
-- is the request, and nothing else: **it never decides anybody's role.** The
-- role still lives in Clerk and `app_users.role`, and an accepted request is a
-- record of the decision, not the mechanism.
--
-- Deliberately **its own table, not columns on `user_profiles`**, for the same
-- reason `staff_details` is:
--
--   * an application is a moment in time — who applied, what they claimed, who
--     decided and when. A profile is current truth, edited freely by its owner.
--     Storing an application in an editable profile would let the applicant
--     change what an admin is reviewing;
--   * these fields never reach the profile completion meter, which counts
--     `user_profiles` columns;
--   * a decided request can be kept for the audit trail long after the profile
--     it seeded has moved on.
--
-- **One row per user, not one per attempt.** A rejected request is resubmitted
-- over the top, which is what makes "does this person have something waiting?"
-- a primary-key lookup rather than a max-by-date over a history. Keeping every
-- attempt is a later migration if it is ever wanted; the reviewer columns below
-- already carry the outcome of the last one.

create table if not exists public.upgrade_requests (
  -- Cascades with the account: deleting someone should not leave their
  -- application behind for an admin to review.
  user_id           text primary key
                    references public.app_users (clerk_id) on delete cascade,

  -- Business info. Required at submission time — `lib/upgrade.ts` is the
  -- contract and the server action enforces it — but nullable here, because a
  -- not-null constraint would make a future "save a draft" a migration.
  agency_name       text,
  business_mobile   text,
  business_email    text,
  business_address  text,

  -- Personal info.
  full_name         text,
  -- Proprietor or Partner. Checked rather than free text: it is a closed set
  -- the reviewer reads at a glance, and a typo would be invisible.
  business_type     text check (business_type in ('proprietor', 'partner')),
  personal_mobile   text,
  personal_address  text,

  -- Supporting documents are deliberately absent, the same way `user_profiles`
  -- leaves out the five B2B uploads: they are files, and they arrive with the
  -- **Cloudinary** slice as a column of provider references. Adding a column
  -- now would be guessing at the shape Cloudinary hands back.

  status            text not null default 'pending'
                    check (status in ('pending', 'accepted', 'rejected')),
  -- Who decided, and when. Null while pending. Not a foreign key: the decision
  -- should outlive the admin's account.
  reviewed_by       text,
  reviewed_at       timestamptz,
  -- The reviewer's note on a rejection, shown to the applicant.
  review_note       text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- The roster asks one question of this table — "which of these people have
-- something waiting?" — so the index is on status.
create index if not exists upgrade_requests_status_idx
  on public.upgrade_requests (status);

drop trigger if exists upgrade_requests_touch_updated_at on public.upgrade_requests;
create trigger upgrade_requests_touch_updated_at
  before update on public.upgrade_requests
  for each row execute function public.touch_updated_at();

-- Same access model as every other table here: RLS on, no policies, which
-- denies anon and authenticated outright. Only the server's service-role key
-- gets in, and it checks the role before reading or writing a row.
alter table public.upgrade_requests enable row level security;
