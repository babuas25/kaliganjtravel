-- One irreversible claim per confirmed booking prevents repeated supplier or
-- idempotent ticketing responses from sending duplicate confirmation emails.
alter table public.flight_bookings
  add column if not exists confirmed_email_claimed_at timestamptz,
  add column if not exists confirmed_email_sent_at timestamptz;

create or replace function public.claim_confirmed_booking_email(p_booking_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.flight_bookings
     set confirmed_email_claimed_at = now()
   where id = p_booking_id
     and status = 'confirmed'
     and issued_at is not null
     and confirmed_email_claimed_at is null;
  return found;
end;
$$;

create or replace function public.mark_confirmed_booking_email_sent(p_booking_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.flight_bookings
     set confirmed_email_sent_at = now()
   where id = p_booking_id
     and confirmed_email_claimed_at is not null
     and confirmed_email_sent_at is null;
$$;

revoke execute on function public.claim_confirmed_booking_email(uuid),
  public.mark_confirmed_booking_email_sent(uuid) from public, anon, authenticated;
grant execute on function public.claim_confirmed_booking_email(uuid),
  public.mark_confirmed_booking_email_sent(uuid) to service_role;
