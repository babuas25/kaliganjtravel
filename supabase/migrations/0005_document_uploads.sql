-- Shopon Travels International — file uploads land, backed by Cloudinary.
-- Applied with `supabase db push --linked` (project gvbovgdjqmskcjgowppa).
-- Safe to re-run: every statement is idempotent.
--
-- This is the slice `0001` and `0004` both deferred to. Two places needed it:
-- a B2B partner's business documents on their company profile, and the
-- attachments on a customer's upgrade application.
--
-- **What is stored is a handle, never a URL.** Each entry is a Cloudinary
-- `public_id` plus the `format` needed to sign a link for it. A stored URL
-- would be one of two wrong things: a public one (these are trade licences,
-- TIN certificates and NID cards) or an expiring one, and an expiring URL in a
-- database is a value that is false for most of its life. Links are minted per
-- view — see `lib/cloudinary.ts`.
--
-- **`jsonb`, not a column pair per document.** The alternative was
-- `trade_license_public_id` + `trade_license_format` and so on: ten columns for
-- the profile, and a migration every time a document type is added or renamed.
-- The set of documents is a product decision that lives in `lib/profile.ts`,
-- and this keeps the schema from having an opinion about it. Nothing is
-- queried *by* document — they are read as a unit with the row that owns them —
-- so there is no index to lose.

-- ── The B2B business documents, on the company profile ───────────────────
--
-- Shape: an object keyed by the file field names in lib/profile.ts, e.g.
--   { "tradeLicense": { "publicId": "...", "format": "pdf", "uploadedAt": "..." } }
-- Absent key means never uploaded. `lib/documents.ts` is the contract.
alter table public.user_profiles
  add column if not exists documents jsonb not null default '{}'::jsonb;

-- ── The upgrade application's attachments ────────────────────────────────
--
-- Shape: an array, because these are unnamed supporting files rather than
-- named slots — the applicant attaches what they have.
--   [ { "publicId": "...", "format": "pdf", "uploadedAt": "..." } ]
alter table public.upgrade_requests
  add column if not exists documents jsonb not null default '[]'::jsonb;

-- Both tables already have RLS enabled with no policies, and adding a column
-- does not change that: anon and authenticated stay denied outright, and the
-- server's service-role key remains the only way in.
