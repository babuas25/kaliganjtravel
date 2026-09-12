-- Supabase may apply default SELECT privileges to newly created views.
-- Keep reporting behind the trusted server boundary, and make the views use
-- the caller's RLS context as defense in depth if a grant is added later.

alter view public.wallet_report_v set (security_invoker = true);
alter view public.wallet_transaction_report_v set (security_invoker = true);
alter view public.booking_payment_report_v set (security_invoker = true);

revoke all on table public.wallet_report_v,
  public.wallet_transaction_report_v,
  public.booking_payment_report_v
  from public, anon, authenticated;

grant select on table public.wallet_report_v,
  public.wallet_transaction_report_v,
  public.booking_payment_report_v
  to service_role;
