-- Keep recipient hashing compatible with the restricted SECURITY DEFINER
-- search path. sha256(bytea) is available without relying on the pgcrypto
-- extension schema being present in search_path.
create or replace function public.register_booking_notification_delivery_v1(
  p_outbox_id uuid,
  p_claim_token uuid,
  p_recipient_kind text,
  p_recipient_address text
)
returns table (
  delivery_id uuid,
  outbox_id uuid,
  recipient_kind text,
  recipient_address text,
  recipient_address_hash text,
  is_hidden_copy boolean,
  state text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_outbox public.booking_notification_outbox;
  v_address text := lower(btrim(coalesce(p_recipient_address, '')));
  v_address_hash text;
  v_existing public.booking_notification_deliveries;
begin
  if p_recipient_kind not in (
    'customer_contact', 'booking_user', 'agency_user', 'system_copy'
  ) then
    raise exception 'invalid notification recipient kind' using errcode = '22023';
  end if;
  if v_address !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or char_length(v_address) > 320 then
    raise exception 'invalid notification recipient address' using errcode = '22023';
  end if;
  select candidate.* into v_outbox
    from public.booking_notification_outbox candidate
   where candidate.id = p_outbox_id
   for update;
  if not found then
    raise exception 'notification outbox not found' using errcode = 'P0002';
  end if;
  if v_outbox.state <> 'processing'
     or v_outbox.claim_token is distinct from p_claim_token then
    raise exception 'notification outbox claim mismatch' using errcode = '40001';
  end if;

  v_address_hash := encode(sha256(convert_to(v_address, 'UTF8')), 'hex');
  select delivery.* into v_existing
    from public.booking_notification_deliveries delivery
   where delivery.outbox_id = p_outbox_id
     and delivery.channel = 'email'
     and delivery.recipient_address_hash = v_address_hash;
  if found then
    return query select
      v_existing.id, v_existing.outbox_id, v_existing.recipient_kind,
      v_existing.recipient_address, v_existing.recipient_address_hash,
      v_existing.is_hidden_copy, v_existing.state;
    return;
  end if;
  if v_outbox.recipients_expanded_at is not null then
    raise exception 'notification recipient set is immutable'
      using errcode = '23514';
  end if;

  insert into public.booking_notification_deliveries (
    outbox_id, recipient_kind, recipient_address,
    recipient_address_hash, is_hidden_copy, channel,
    state, next_attempt_at
  ) values (
    p_outbox_id, p_recipient_kind, v_address,
    v_address_hash, p_recipient_kind = 'system_copy', 'email',
    'pending', clock_timestamp()
  ) returning * into v_existing;
  return query select
    v_existing.id, v_existing.outbox_id, v_existing.recipient_kind,
    v_existing.recipient_address, v_existing.recipient_address_hash,
    v_existing.is_hidden_copy, v_existing.state;
end;
$$;

comment on function public.register_booking_notification_delivery_v1(
  uuid, uuid, text, text
) is
  'Registers one immutable email recipient for a claimed outbox row using a search-path-safe SHA-256 address hash.';
