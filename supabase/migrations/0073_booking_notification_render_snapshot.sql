-- Immutable email render snapshot captured at lifecycle-event time.
--
-- The snapshot contains the booking document fields the customer email uses,
-- a minimized passenger projection, and no recipient address, contact phone,
-- supplier capability token, passport number, or passport expiry. A later
-- booking/profile edit cannot change the meaning of this occurrence.

create or replace function public.enrich_booking_notification_snapshot_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.booking_status_events;
  v_booking public.flight_bookings;
  v_profile public.user_profiles;
  v_header jsonb;
  v_travellers jsonb;
begin
  select candidate.* into v_event
    from public.booking_status_events candidate
   where candidate.id = new.lifecycle_event_id;
  if not found or v_event.booking_id <> new.booking_id then
    raise exception 'notification event identity mismatch' using errcode = '23503';
  end if;
  select candidate.* into v_booking
    from public.flight_bookings candidate
   where candidate.id = new.booking_id;
  if not found then
    raise exception 'notification booking not found' using errcode = '23503';
  end if;

  if v_booking.audience = 'agency' and v_booking.agency_code is not null then
    select profile.* into v_profile
      from public.agencies agency
      join public.user_profiles profile
        on profile.clerk_id = agency.owner_user_id
     where agency.agency_code = v_booking.agency_code;
  end if;
  if v_booking.audience = 'agency' then
    v_header := jsonb_build_object(
      'name', coalesce(nullif(btrim(v_profile.agency_name), ''),
        v_booking.agency_code, 'Shapon Travels International'),
      'licenseNo', coalesce(nullif(btrim(v_profile.agency_license_no), ''),
        '0016548'),
      'mobile', coalesce(nullif(btrim(v_profile.agency_mobile), ''), '--'),
      'email', coalesce(nullif(btrim(v_profile.agency_email), ''), '--'),
      'address', coalesce(nullif(btrim(v_profile.agency_address), ''), '--'),
      'logoUrl', null
    );
  else
    v_header := jsonb_build_object(
      'name', 'Shapon Travels International',
      'licenseNo', '0016548',
      'mobile', '+8801921-232941',
      'email', 'support@shapontravels.com',
      'address',
        'Shomobai Shopping Market (2nd Floor), Dhankhola Bazar, Gangni, Meherpur-7110',
      'logoUrl', null
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'passengerType', traveller->>'passengerType',
    'title', traveller->>'title',
    'firstName', traveller->>'firstName',
    'lastName', traveller->>'lastName',
    'gender', traveller->>'gender',
    'dateOfBirth', traveller->>'dateOfBirth',
    'nationality', traveller->>'nationality'
  ) order by ordinal), '[]'::jsonb)
    into v_travellers
    from jsonb_array_elements(
      case
        when jsonb_typeof(v_booking.passengers->'travellers') = 'array'
          then v_booking.passengers->'travellers'
        else '[]'::jsonb
      end
    ) with ordinality as item(traveller, ordinal);

  -- Remove any caller-provided bookingSnapshot before writing enforced fields.
  new.event_snapshot := (coalesce(new.event_snapshot, '{}'::jsonb)
      - 'bookingSnapshot')
    || jsonb_build_object('bookingSnapshot', jsonb_build_object(
      'snapshotVersion', 1,
      'bookingId', v_booking.id,
      'publicRef', v_booking.public_ref,
      'lifecycleStatus', v_event.to_lifecycle_status,
      'storedStatus', v_booking.status,
      'audience', v_booking.audience,
      'agencyCode', v_booking.agency_code,
      'supplier', v_booking.supplier,
      'importSource', v_booking.import_source,
      'paymentState', v_booking.payment_state,
      'currency', v_booking.currency,
      'pricingSnapshot', v_booking.pricing_snapshot,
      'supplierGrossAmount', v_booking.supplier_gross_amount,
      'passengerCounts', v_booking.passenger_counts,
      'travelDate', v_booking.travel_date,
      'directTicketing', v_booking.direct_ticketing,
      'passportRequired', coalesce(v_booking.passport_required, true),
      'itinerary', v_booking.itinerary,
      'fares', coalesce(v_booking.fares, '[]'::jsonb),
      'repricedAt', v_booking.repriced_at,
      'pnr', v_booking.pnr,
      'airlinesPnr', coalesce(v_booking.airlines_pnr, '[]'::jsonb),
      'bookingRefNumber', v_booking.booking_ref_number,
      'bookingStatus', v_booking.booking_status,
      'ticketingTimeLimit', v_booking.ticketing_time_limit,
      'ticketingDeadlineAt', v_booking.ticketing_deadline_at,
      'ticketNumbers', coalesce(v_booking.ticket_numbers, '[]'::jsonb),
      'warnings', coalesce(v_booking.warnings, '[]'::jsonb),
      'submissionStartedAt', v_booking.submission_started_at,
      'bookedAt', coalesce(v_booking.submission_started_at, v_booking.created_at),
      'processingSince', case when v_event.to_lifecycle_status = 'in-progress'
        then v_booking.operation_started_at else null end,
      'issuedAt', v_booking.issued_at,
      'cancelledAt', v_booking.cancelled_at,
      'operationKind', v_event.operation_kind,
      'operationReason', v_event.operation_reason,
      'headerContact', v_header,
      'travellers', v_travellers
    ));
  return new;
end;
$$;

drop trigger if exists booking_notification_outbox_render_snapshot
  on public.booking_notification_outbox;
create trigger booking_notification_outbox_render_snapshot
  before insert on public.booking_notification_outbox
  for each row execute function public.enrich_booking_notification_snapshot_v1();

revoke all on function public.enrich_booking_notification_snapshot_v1()
  from public, anon, authenticated, service_role;

-- If an event lands in the schema-first rollout interval after 0060 but before
-- this snapshot trigger exists, its historical document cannot be recreated
-- exactly. Keep it as explicit non-send evidence; the old worker remains the
-- delivery authority until the application cutover.
update public.booking_notification_outbox
   set delivery_policy = 'suppress',
       state = 'suppressed',
       suppression_reason = 'pre_snapshot_cutover_legacy_delivery',
       completed_at = clock_timestamp(),
       claimed_at = null,
       claim_token = null
 where state in ('pending', 'processing')
   and not (event_snapshot ? 'bookingSnapshot');

comment on function public.enrich_booking_notification_snapshot_v1() is
  'Enforces versioned event-time email document data without recipient/contact addresses, supplier tokens, or passenger passport fields.';
