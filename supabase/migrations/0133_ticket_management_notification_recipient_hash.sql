-- PGlite-compatible recipient hashing for the Ticket Management outbox.
-- The value is an idempotency/deduplication key, not a password or security
-- credential. It keeps the raw email out of the unique-key lookup surface.

create or replace function public.expand_ticket_management_notification_recipients_v1(
  p_outbox_id uuid,
  p_claim_token uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox public.ticket_management_notification_outbox;
  v_count integer;
begin
  select candidate.* into v_outbox
    from public.ticket_management_notification_outbox candidate
   where candidate.id = p_outbox_id
   for update;
  if not found or v_outbox.state <> 'processing'
     or v_outbox.claim_token is distinct from p_claim_token then
    raise exception 'notification outbox claim mismatch' using errcode = '40001';
  end if;

  if v_outbox.recipients_expanded_at is null then
    insert into public.ticket_management_notification_deliveries (
      outbox_id, recipient_kind, recipient_address, recipient_address_hash
    )
    select p_outbox_id, recipient.kind, recipient.address, md5(recipient.address)
      from (
        select distinct on (address) kind, address
          from (
            select 'requester'::text as kind, lower(btrim(app_user.email)) as address
              from public.ticket_management_requests request
              join public.app_users app_user
                on app_user.clerk_id = request.requested_by_user_id
             where request.id = v_outbox.request_id
               and v_outbox.audience = 'customer'
            union all
            select 'booking_user', lower(btrim(app_user.email))
              from public.ticket_management_requests request
              join public.flight_bookings booking on booking.id = request.booking_id
              join public.app_users app_user on app_user.clerk_id = booking.user_id
             where request.id = v_outbox.request_id
               and v_outbox.audience = 'customer'
            union all
            select 'booking_contact', lower(btrim(booking.passengers #>> '{contact,customerEmail}'))
              from public.ticket_management_requests request
              join public.flight_bookings booking on booking.id = request.booking_id
             where request.id = v_outbox.request_id
               and v_outbox.audience = 'customer'
            union all
            select 'internal_staff', lower(btrim(app_user.email))
              from public.app_users app_user
             where v_outbox.audience = 'internal'
               and app_user.role in ('staff_support', 'staff_account', 'admin', 'superadmin')
          ) candidates
         where address ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
           and char_length(address) <= 320
         order by address, kind
      ) recipient
    on conflict (outbox_id, recipient_address_hash) do nothing;

    select count(*)::integer into v_count
      from public.ticket_management_notification_deliveries delivery
     where delivery.outbox_id = p_outbox_id;
    if v_count = 0 then
      raise exception 'notification has no recipient' using errcode = '23514';
    end if;
    update public.ticket_management_notification_outbox
       set recipients_expanded_at = clock_timestamp()
     where id = p_outbox_id;
  end if;
  select count(*)::integer into v_count
    from public.ticket_management_notification_deliveries delivery
   where delivery.outbox_id = p_outbox_id;
  return v_count;
end;
$$;

comment on function public.expand_ticket_management_notification_recipients_v1(uuid, uuid) is
  'Expands one immutable audience recipient set. The normalized address hash is used solely for idempotent delivery deduplication.';
