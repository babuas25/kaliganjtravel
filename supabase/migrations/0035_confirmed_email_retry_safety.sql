-- Confirmed ticket email claims need a retry lease: a PDF/SMTP failure must not
-- permanently suppress the customer's issued-ticket notification.
-- This migration changes email-delivery metadata only; it never touches the
-- booking lifecycle, supplier, wallet, ticket, refund, or ledger state.

alter table public.flight_bookings
  add column if not exists confirmed_email_attempt_count integer not null default 0,
  add column if not exists confirmed_email_last_error text;

create or replace function public.claim_confirmed_booking_email(p_booking_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_booking public.flight_bookings;
begin
  select * into v_booking
    from public.flight_bookings
   where id = p_booking_id
     and not legacy_operational
   for update;

  if not found
     or v_booking.status <> 'confirmed'
     or v_booking.issued_at is null
     or v_booking.confirmed_email_sent_at is not null
     or (
       v_booking.confirmed_email_claimed_at is not null
       and v_booking.confirmed_email_claimed_at > now() - interval '15 minutes'
     ) then
    return false;
  end if;

  update public.flight_bookings
     set confirmed_email_claimed_at = now(),
         confirmed_email_attempt_count = confirmed_email_attempt_count + 1,
         confirmed_email_last_error = null
   where id = v_booking.id;
  return true;
end;
$$;

create or replace function public.mark_confirmed_booking_email_sent(p_booking_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.flight_bookings
     set confirmed_email_sent_at = now(),
         confirmed_email_last_error = null
   where id = p_booking_id
     and confirmed_email_claimed_at is not null
     and confirmed_email_sent_at is null;
$$;

create or replace function public.fail_confirmed_booking_email(
  p_booking_id uuid,
  p_error text
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.flight_bookings
     set confirmed_email_claimed_at = null,
         confirmed_email_last_error = left(
           coalesce(nullif(trim(p_error), ''), 'Confirmed email delivery failed.'),
           500
         )
   where id = p_booking_id
     and confirmed_email_sent_at is null;
$$;

revoke all on function public.claim_confirmed_booking_email(uuid),
  public.mark_confirmed_booking_email_sent(uuid),
  public.fail_confirmed_booking_email(uuid,text)
  from public, anon, authenticated;
grant execute on function public.claim_confirmed_booking_email(uuid),
  public.mark_confirmed_booking_email_sent(uuid),
  public.fail_confirmed_booking_email(uuid,text)
  to service_role;

-- Preserve the known failed attempt as auditable metadata. The stale lease is
-- intentionally left in place; the claim function itself decides retry safety.
update public.flight_bookings
   set confirmed_email_attempt_count = 1,
       confirmed_email_last_error =
         'PDF generation failed: bundled PDFKit could not resolve Helvetica.afm.'
 where public_ref = 'STR260807000002'
   and status = 'confirmed'
   and issued_at is not null
   and confirmed_email_claimed_at =
     timestamptz '2026-08-06 19:03:45.66741+00'
   and confirmed_email_sent_at is null
   and payment_state = 'captured'
   and confirmed_email_attempt_count = 0;

comment on function public.claim_confirmed_booking_email(uuid) is
  'Row-locking 15-minute lease for retry-safe confirmed-ticket email delivery.';
