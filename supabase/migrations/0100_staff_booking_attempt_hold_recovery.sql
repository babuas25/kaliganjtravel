-- Controlled recovery for a staff-created held booking whose supplier response
-- was received but could not be durably finalized. The caller must first read
-- the supplier by the attempt's immutable transaction identity. No wallet
-- reservation is created or modified by this function.

create or replace function public.recover_staff_booking_attempt_hold_v1(
  p_attempt_id uuid,
  p_actor_user_id text,
  p_expected_unique_trans_id text,
  p_supplier_observed_at timestamptz,
  p_supplier_evidence_hash text,
  p_outcome jsonb
)
returns public.flight_bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.booking_attempts;
  v_actor_role text;
  v_case public.booking_reconciliation_cases;
  v_booking public.flight_bookings;
begin
  select role into v_actor_role
    from public.app_users
   where clerk_id = p_actor_user_id;
  if v_actor_role <> 'superadmin' then
    raise exception 'super admin recovery authority is required'
      using errcode = '42501';
  end if;

  select * into v_attempt
    from public.booking_attempts
   where id = p_attempt_id
   for update;
  if not found then
    raise exception 'booking attempt does not exist' using errcode = 'P0002';
  end if;
  if not v_attempt.staff_on_behalf or v_attempt.state <> 'unknown' then
    raise exception 'only an unknown staff-created booking attempt can be recovered'
      using errcode = '23514';
  end if;
  if nullif(btrim(p_expected_unique_trans_id), '') is null
     or p_expected_unique_trans_id is distinct from v_attempt.unique_trans_id then
    raise exception 'supplier transaction identity mismatch'
      using errcode = '22023';
  end if;
  if p_supplier_observed_at is null
     or p_supplier_observed_at > now() + interval '5 minutes' then
    raise exception 'invalid supplier observation time' using errcode = '22023';
  end if;
  if p_supplier_evidence_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid supplier evidence hash' using errcode = '22023';
  end if;
  if p_outcome is null or jsonb_typeof(p_outcome) <> 'object'
     or p_outcome->>'status' <> 'held'
     or nullif(btrim(p_outcome->>'pnr'), '') is null
     or nullif(btrim(p_outcome->>'bookingCodeRef'), '') is null
     or coalesce(p_outcome->'ticketNumbers', '[]'::jsonb) <> '[]'::jsonb
     or nullif(btrim(p_outcome->>'ticketCodeRef'), '') is not null then
    raise exception 'recovery outcome is not a verified supplier hold'
      using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_outcome->'airlinesPnr', 'null'::jsonb)) <> 'array'
     or jsonb_array_length(p_outcome->'airlinesPnr') = 0 then
    raise exception 'recovery outcome requires an airline PNR'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from public.wallet_reservations
     where booking_attempt_id = p_attempt_id
  ) then
    raise exception 'staff booking recovery cannot touch a wallet-backed attempt'
      using errcode = '23514';
  end if;
  if exists (
    select 1 from public.flight_bookings where attempt_id = p_attempt_id
  ) then
    raise exception 'booking attempt already has a business booking'
      using errcode = '23514';
  end if;

  select * into v_case
    from public.booking_reconciliation_cases
   where subject_booking_attempt_id = p_attempt_id
     and case_type = 'attempt_uncertainty'
     and state in (
       'open', 'assigned', 'awaiting_supplier',
       'awaiting_finance', 'awaiting_approval'
     )
   for update;
  if not found then
    raise exception 'open attempt reconciliation case is required'
      using errcode = '23514';
  end if;

  -- Re-enter the existing atomic finalizer only after the manual supplier read
  -- has proved the original unique transaction produced an unpaid hold.
  update public.booking_attempts
     set state = 'submitting',
         supplier_response_received_at = coalesce(
           supplier_response_received_at,
           p_supplier_observed_at
         ),
         supplier_response_http_status = coalesce(
           supplier_response_http_status,
           200
         )
   where id = p_attempt_id;

  v_booking := public.create_booking_from_attempt_v2(
    p_attempt_id,
    v_attempt.operation_request_key,
    v_attempt.operation_request_payload_hash,
    p_outcome
  );

  update public.booking_attempts
     set error_code = null,
         supplier_message = coalesce(
           nullif(btrim(p_outcome->>'message'), ''),
           'Recovered from a verified supplier hold'
         )
   where id = p_attempt_id;

  update public.booking_reconciliation_cases
     set state = 'resolved',
         resolution_outcome = 'booking_recovered_held',
         resolution_reason = 'Original supplier transaction verified as an unpaid hold',
         resolution = jsonb_build_object(
           'bookingId', v_booking.id,
           'bookingPublicRef', v_booking.public_ref,
           'supplierEvidenceHash', p_supplier_evidence_hash,
           'supplierObservedAt', p_supplier_observed_at,
           'financialDisposition', 'none'
         ),
         financial_disposition = 'none',
         resolved_by_user_id = p_actor_user_id,
         resolved_at = now(),
         closed_at = now(),
         version = version + 1
   where id = v_case.id;

  return v_booking;
end;
$$;

revoke all on function public.recover_staff_booking_attempt_hold_v1(
  uuid, text, text, timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.recover_staff_booking_attempt_hold_v1(
  uuid, text, text, timestamptz, text, jsonb
) to service_role;

comment on function public.recover_staff_booking_attempt_hold_v1(
  uuid, text, text, timestamptz, text, jsonb
) is
  'Super Admin-only recovery of an unknown staff-created booking after an identity-matched supplier read proves the original transaction produced an unpaid hold. Never reserves or charges wallet funds.';
