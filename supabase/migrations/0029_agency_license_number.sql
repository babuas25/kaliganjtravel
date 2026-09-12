-- Optional agency license number shown on agency-issued ticket headers.
-- Tickets fall back to Shapon Travels' license number when this is blank.
alter table public.user_profiles
  add column if not exists agency_license_no text;
