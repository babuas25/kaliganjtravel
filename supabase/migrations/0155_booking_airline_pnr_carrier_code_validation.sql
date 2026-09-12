-- Carrier codes are not airline record locators. Recover historical values
-- only from identity-matched, unambiguous snapshots; preserve lifecycle history.
create or replace function public.valid_booking_airline_pnrs_v1(p_value jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select coalesce(jsonb_agg(locator order by ordinal), '[]'::jsonb)
  from (
    select btrim(value #>> '{}') as locator, min(ordinal) as ordinal
    from jsonb_array_elements(case when jsonb_typeof(p_value) = 'array'
      then p_value else '[]'::jsonb end) with ordinality as item(value, ordinal)
    where jsonb_typeof(value) = 'string' and length(btrim(value #>> '{}')) > 2
    group by btrim(value #>> '{}')
  ) valid;
$$;
revoke all on function public.valid_booking_airline_pnrs_v1(jsonb)
  from public, anon, authenticated;
grant execute on function public.valid_booking_airline_pnrs_v1(jsonb) to service_role;

create or replace function public.validate_supplier_airline_pnrs_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_valid jsonb;
begin
  if new.supplier = 'triplover' and new.import_source is distinct from 'MANUAL' then
    v_valid := public.valid_booking_airline_pnrs_v1(new.airlines_pnr);
    if tg_op = 'UPDATE' and jsonb_array_length(v_valid) = 0 then
      v_valid := public.valid_booking_airline_pnrs_v1(old.airlines_pnr);
    end if;
    new.airlines_pnr := v_valid;
  end if;
  return new;
end;
$$;
create trigger flight_bookings_validate_supplier_airline_pnrs
  before insert or update of airlines_pnr on public.flight_bookings
  for each row execute function public.validate_supplier_airline_pnrs_v1();
revoke all on function public.validate_supplier_airline_pnrs_v1()
  from public, anon, authenticated;

create or replace function public.booking_airline_pnrs_after_refresh_v1(
  p_current jsonb, p_incoming jsonb, p_pnr text, p_booking_ref text
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
begin
  p_current := public.valid_booking_airline_pnrs_v1(p_current);
  p_incoming := public.valid_booking_airline_pnrs_v1(p_incoming);
  if not public.jsonb_is_nonempty_array(p_incoming) then
    return p_current;
  end if;
  if public.jsonb_is_nonempty_array(p_current)
     and not exists (
       select 1 from jsonb_array_elements_text(p_incoming) locator(value)
       where upper(btrim(locator.value)) <> all (array[
         upper(btrim(coalesce(p_pnr, ''))), upper(btrim(coalesce(p_booking_ref, '')))
       ])
     )
     and exists (
       select 1 from jsonb_array_elements_text(p_current) locator(value)
       where nullif(btrim(locator.value), '') is not null
         and upper(btrim(locator.value)) <> all (array[
           upper(btrim(coalesce(p_pnr, ''))), upper(btrim(coalesce(p_booking_ref, '')))
         ])
     ) then
    return p_current;
  end if;
  return p_incoming;
end;
$$;

create or replace function public.enqueue_booking_issued_sms_v1()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_booking public.flight_bookings;
  v_phone text;
  v_number text;
  v_state text := 'pending';
  v_suppression_reason text;
  v_pnr text;
  v_passenger_name text;
begin
  select booking.* into v_booking
    from public.flight_bookings booking
   where booking.id = new.booking_id;
  if not found then
    raise exception 'issued SMS booking not found' using errcode = '23503';
  end if;

  if v_booking.audience = 'agency' and v_booking.agency_code is not null then
    select regexp_replace(coalesce(profile.agency_mobile, ''), '[^0-9]', '', 'g')
      into v_phone
      from public.agencies agency
      join public.user_profiles profile
        on profile.clerk_id = agency.owner_user_id
     where agency.agency_code = v_booking.agency_code;
  end if;
  v_phone := coalesce(v_phone, '');

  if left(v_phone, 2) = '00' then
    v_number := substr(v_phone, 3);
  elsif left(v_phone, 3) = '880' then
    v_number := v_phone;
  elsif left(v_phone, 2) = '01' then
    v_number := '880' || substr(v_phone, 2);
  elsif char_length(v_phone) = 10 and left(v_phone, 1) = '1' then
    v_number := '880' || v_phone;
  else
    v_number := v_phone;
  end if;

  if coalesce(new.event_snapshot->>'notificationDisposition', '') = 'audit_only'
     or new.supplier_operation = 'MigrationBaseline' then
    v_state := 'suppressed';
    v_suppression_reason := 'historical_or_audit_only';
  elsif v_booking.audience <> 'agency' then
    v_state := 'suppressed';
    v_suppression_reason := 'b2b_partner_only';
  elsif v_booking.hidden_from_user then
    v_state := 'suppressed';
    v_suppression_reason := 'booking_hidden_from_user';
  elsif coalesce(v_number, '') !~ '^[1-9][0-9]{7,14}$' then
    v_state := 'suppressed';
    v_suppression_reason := 'missing_or_invalid_b2b_partner_phone';
  end if;

  select nullif(btrim(locator.value), '') into v_pnr
    from jsonb_array_elements_text(
      public.valid_booking_airline_pnrs_v1(v_booking.airlines_pnr))
      with ordinality as locator(value, ordinal)
    where nullif(btrim(locator.value), '') is not null
    order by locator.ordinal limit 1;
  v_pnr := coalesce(v_pnr, 'Not available');
  v_passenger_name := btrim(concat_ws(' ',
    nullif(btrim(v_booking.passengers #>> '{travellers,0,firstName}'), ''),
    nullif(btrim(v_booking.passengers #>> '{travellers,0,lastName}'), '')
  ));

  insert into public.booking_issued_sms_deliveries (
    lifecycle_event_id, booking_id, occurrence_id,
    recipient_number, recipient_number_hash, content_snapshot,
    state, suppression_reason, completed_at
  ) values (
    new.id, new.booking_id, new.occurrence_id,
    case when v_state = 'suppressed' then null else v_number end,
    case when v_state = 'suppressed' then null
      else encode(digest(v_number, 'sha256'), 'hex') end,
    jsonb_build_object(
      'version', 1,
      'bookingReference', v_booking.public_ref,
      'pnr', v_pnr,
      'pnrType', 'airline',
      'passengerName', v_passenger_name,
      'airlineCode', coalesce(v_booking.itinerary->>'carrierCode', ''),
      'airlineName', coalesce(v_booking.itinerary->>'carrierName', ''),
      'itinerary', coalesce(v_booking.itinerary, 'null'::jsonb),
      'currency', v_booking.currency,
      'grossAmount', v_booking.pricing_snapshot->'grossPrice'
    ),
    v_state, v_suppression_reason,
    case when v_state = 'suppressed' then clock_timestamp() else null end
  )
  on conflict (lifecycle_event_id) do nothing;
  return new;
end;
$$;

-- Recover only carrier-only corruption with one unambiguous historical
-- airline-locator set. Identity must match the immutable booking snapshot.
-- Do not touch status, money, primary supplier locators, or sent notifications.
with historical as (
  select booking.id,
    public.valid_booking_airline_pnrs_v1(
      outbox.event_snapshot #> '{bookingSnapshot,airlinesPnr}'
    ) as airline_pnrs
  from public.flight_bookings booking
  join public.booking_notification_outbox outbox on outbox.booking_id = booking.id
  where booking.supplier = 'triplover'
    and booking.import_source is distinct from 'MANUAL'
    and public.jsonb_is_nonempty_array(booking.airlines_pnr)
    and public.valid_booking_airline_pnrs_v1(booking.airlines_pnr) = '[]'::jsonb
    and outbox.event_snapshot #>> '{bookingSnapshot,bookingId}' = booking.id::text
    and outbox.event_snapshot #>> '{bookingSnapshot,publicRef}' = booking.public_ref
), recoverable as (
  select id, jsonb_agg(distinct airline_pnrs)->0 as airline_pnrs
  from historical
  where jsonb_array_length(airline_pnrs) > 0
  group by id
  having count(distinct airline_pnrs) = 1
)
update public.flight_bookings booking
set airlines_pnr = recoverable.airline_pnrs
from recoverable
where booking.id = recoverable.id
  and public.jsonb_is_nonempty_array(booking.airlines_pnr)
  and public.valid_booking_airline_pnrs_v1(booking.airlines_pnr) = '[]'::jsonb;
