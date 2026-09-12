-- Supabase installs pgcrypto in `extensions`, while PGlite/local installations
-- may expose it in `public`. Keep both schemas in the runtime lookup path for
-- the three SMS functions that hash recipient numbers.

alter function public.enqueue_booking_issued_sms_v1()
  set search_path = public, extensions;

alter function public.claim_booking_manual_sms_send_v1(uuid,text,uuid,jsonb)
  set search_path = public, extensions;

alter function public.claim_booking_manual_sms_send_v2(uuid,text,uuid,text,text)
  set search_path = public, extensions;
