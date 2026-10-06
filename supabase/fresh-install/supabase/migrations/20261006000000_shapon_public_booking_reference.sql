-- Shapontravels' public API intentionally exposes bookingRefNumber as the
-- public PNR. Its Rust backend resolves the separate private supplier locator
-- from the saved Book response when dispatching NewTicket. bookingCodeRef and
-- the three quote identities remain platform UUIDs. Retain previously stored
-- UUID booking references during a rolling application deployment.
-- This changes only saved-reference eligibility: no booking evidence, known
-- deadlines, approvals, wallet balances or supplier operations are rewritten.
create or replace function public.booking_uses_saved_references(
  p_booking public.flight_bookings
)
returns boolean
language sql immutable set search_path = public
as $$
  select coalesce(
    p_booking.import_source is null
    and not p_booking.legacy_operational
    and (
      (
        p_booking.supplier = 'triplover'
        and p_booking.supplier_account in ('firsttrip', 'takeoff', 'triplover')
      )
      or (
        p_booking.supplier = 'shapontravels'
        and p_booking.supplier_account = 'shapontravels'
        and p_booking.direct_ticketing is false
        and p_booking.supplier_public_ref ~ '^STR[A-Z0-9]{6,32}$'
        and length(btrim(p_booking.pnr)) > 2
        and (
          p_booking.booking_ref_number = p_booking.pnr
          or p_booking.booking_ref_number ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        )
        and p_booking.booking_code_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and p_booking.supplier_refs->>'uniqueTransId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and p_booking.supplier_refs->>'itemCodeRef' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and p_booking.supplier_refs->>'priceCodeRef' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    ),
    false
  );
$$;

revoke all on function public.booking_uses_saved_references(public.flight_bookings)
  from public, anon, authenticated;
grant execute on function public.booking_uses_saved_references(public.flight_bookings)
  to service_role;
