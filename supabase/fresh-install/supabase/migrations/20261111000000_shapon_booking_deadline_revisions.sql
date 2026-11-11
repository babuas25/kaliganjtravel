-- The API supplier's deadline stream is independent of local booking status
-- and finance. Existing booking rows and cutoff authorities are preserved.
create table public.shapon_booking_deadline_versions (
  booking_id uuid primary key references public.flight_bookings(id) on delete restrict,
  revision bigint not null check (revision > 0),
  deadline_at text
);

create table public.shapon_booking_deadline_event_receipts (
  event_id uuid primary key,
  booking_id uuid not null references public.flight_bookings(id) on delete restrict,
  supplier_booking_id text not null,
  supplier_public_ref text not null,
  revision bigint not null check (revision > 0),
  deadline_at text,
  recorded_at timestamptz not null default clock_timestamp()
);

alter table public.shapon_booking_deadline_versions enable row level security;
alter table public.shapon_booking_deadline_event_receipts enable row level security;
revoke all on table public.shapon_booking_deadline_versions,
  public.shapon_booking_deadline_event_receipts from public, anon, authenticated, service_role;

create trigger shapon_booking_deadline_event_receipts_immutable
  before update or delete on public.shapon_booking_deadline_event_receipts
  for each row execute function public.prevent_booking_deadline_audit_mutation();
create trigger shapon_booking_deadline_event_receipts_no_truncate
  before truncate on public.shapon_booking_deadline_event_receipts
  for each statement execute function public.prevent_booking_deadline_audit_mutation();

create function public.apply_shapon_booking_deadline(
  p_booking_id uuid,
  p_supplier_booking_id text,
  p_supplier_public_ref text,
  p_expected_updated_at timestamptz,
  p_revision bigint,
  p_deadline_at text,
  p_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_booking public.flight_bookings%rowtype;
  v_version public.shapon_booking_deadline_versions%rowtype;
  v_event public.shapon_booking_deadline_event_receipts%rowtype;
  v_deadline timestamptz;
  v_result text;
  v_deferred boolean;
  v_eligible boolean;
begin
  if p_supplier_booking_id is null
     or p_supplier_booking_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_supplier_public_ref is null
     or p_supplier_public_ref !~ '^STR[A-Z0-9]{6,32}$'
     or (p_revision is not null and p_revision not between 1 and 9007199254740991)
     or (p_event_id is null and (p_booking_id is null or p_expected_updated_at is null
                                 or not isfinite(p_expected_updated_at)))
     or (p_event_id is not null and (p_booking_id is not null or p_expected_updated_at is not null
                                     or p_revision is null)) then
    raise exception 'SHAPON_DEADLINE_INPUT_INVALID' using errcode = '22023';
  end if;
  if p_deadline_at is not null then
    if length(p_deadline_at) > 40
       or p_deadline_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]{1,9})?(Z|[+-](0[0-9]|1[0-5]):[0-5][0-9])$'
       or (p_revision is not null and right(p_deadline_at, 6) <> '+06:00') then
      raise exception 'SHAPON_DEADLINE_INPUT_INVALID' using errcode = '22023';
    end if;
    begin
      v_deadline := p_deadline_at::timestamptz;
    exception when datetime_field_overflow or invalid_datetime_format then
      raise exception 'SHAPON_DEADLINE_INPUT_INVALID' using errcode = '22023';
    end;
  end if;

  -- Receipt identity remains immutable even after the local booking changes.
  if p_event_id is not null then
    select * into v_event from public.shapon_booking_deadline_event_receipts where event_id = p_event_id;
    if found then
      if row(v_event.supplier_booking_id, v_event.supplier_public_ref, v_event.revision, v_event.deadline_at)
         is distinct from row(p_supplier_booking_id, p_supplier_public_ref, p_revision, p_deadline_at) then
        raise exception 'SHAPON_DEADLINE_EVENT_CONFLICT' using errcode = '22023';
      end if;
      return jsonb_build_object('result', 'duplicate',
        'ticketingDeadlineAt', null, 'lastTicketingTime', null, 'updatedAt', null, 'revision', v_event.revision);
    end if;
  end if;

  -- Both paths lock the same local row before touching revision or event state.
  if p_booking_id is null then
    select * into v_booking from public.flight_bookings
      where supplier_public_ref = p_supplier_public_ref for update;
  else
    select * into v_booking from public.flight_bookings
      where id = p_booking_id for update;
  end if;
  if not found then
    return jsonb_build_object('result', 'missing',
      'ticketingDeadlineAt', null, 'lastTicketingTime', null, 'updatedAt', null, 'revision', null);
  end if;
  if v_booking.booking_code_ref is distinct from p_supplier_booking_id
     or v_booking.supplier_public_ref is distinct from p_supplier_public_ref then
    if p_event_id is not null then
      raise exception 'SHAPON_DEADLINE_IDENTITY_MISMATCH' using errcode = '22023';
    end if;
    return jsonb_build_object('result', 'changed',
      'ticketingDeadlineAt', null, 'lastTicketingTime', null, 'updatedAt', null, 'revision', null);
  end if;
  if v_booking.supplier is distinct from 'shapontravels'
     or v_booking.supplier_account is distinct from 'shapontravels'
     or v_booking.import_source is not null or v_booking.booking_origin is not null
     or v_booking.legacy_operational or v_booking.direct_ticketing then
    return jsonb_build_object('result', 'ignored',
      'ticketingDeadlineAt', null, 'lastTicketingTime', null, 'updatedAt', null, 'revision', null);
  end if;
  if p_expected_updated_at is not null and v_booking.updated_at is distinct from p_expected_updated_at then
    return jsonb_build_object('result', 'changed',
      'ticketingDeadlineAt', null, 'lastTicketingTime', null, 'updatedAt', null, 'revision', null);
  end if;

  select * into v_version from public.shapon_booking_deadline_versions
    where booking_id = v_booking.id;
  v_deferred := v_booking.issued_at is null and v_booking.status not in ('confirmed', 'cancelled')
    and (v_booking.status in ('pending', 'in-progress')
      or v_booking.operation_kind is not null or v_booking.active_operation_id is not null);
  v_eligible := v_booking.status = 'on-hold' and v_booking.issued_at is null and not v_deferred;

  if p_event_id is not null and not v_deferred then
    insert into public.shapon_booking_deadline_event_receipts(
      event_id, booking_id, supplier_booking_id, supplier_public_ref, revision, deadline_at
    ) values (p_event_id, v_booking.id, p_supplier_booking_id, p_supplier_public_ref, p_revision, p_deadline_at)
    on conflict (event_id) do nothing;
    if not found then
      -- A concurrent delivery may have committed after the first receipt read.
      select * into strict v_event from public.shapon_booking_deadline_event_receipts where event_id = p_event_id;
      if row(v_event.booking_id, v_event.supplier_booking_id, v_event.supplier_public_ref,
             v_event.revision, v_event.deadline_at)
         is distinct from row(v_booking.id, p_supplier_booking_id, p_supplier_public_ref,
                              p_revision, p_deadline_at) then
        raise exception 'SHAPON_DEADLINE_EVENT_CONFLICT' using errcode = '22023';
      end if;
      return jsonb_build_object('result', 'duplicate',
        'ticketingDeadlineAt', null, 'lastTicketingTime', null, 'updatedAt', null, 'revision', v_event.revision);
    end if;
  end if;

  if v_deferred then
    v_result := 'deferred';
  elsif not v_eligible then
    v_result := 'ignored';
  elsif v_version.revision is not null and (p_revision is null or p_revision < v_version.revision) then
    v_result := 'stale';
  elsif p_revision = v_version.revision then
    if p_deadline_at is distinct from v_version.deadline_at then
      raise exception 'SHAPON_DEADLINE_REVISION_CONFLICT' using errcode = '22023';
    end if;
    v_result := 'unchanged';
  elsif p_revision is null and p_deadline_at is null then
    -- A saved GET's null conveys missing evidence, not a versioned clear.
    v_result := 'unchanged';
  else
    if p_revision is not null then
      insert into public.shapon_booking_deadline_versions(booking_id, revision, deadline_at)
      values (v_booking.id, p_revision, p_deadline_at)
      on conflict (booking_id) do update
        set revision = excluded.revision, deadline_at = excluded.deadline_at
      returning * into v_version;
    end if;
    if v_booking.supplier_ticketing_deadline_at is distinct from v_deadline
       or v_booking.supplier_ticketing_time_limit is distinct from p_deadline_at then
      -- The existing deadline authority trigger projects the effective local
      -- or supplier cutoff. Only supplier deadline evidence is written here.
      update public.flight_bookings
        set supplier_ticketing_deadline_at = v_deadline,
            supplier_ticketing_time_limit = p_deadline_at,
            supplier_deadline_source = 'supplier'
        where id = v_booking.id returning * into v_booking;
      v_result := 'updated';
    else
      v_result := 'unchanged';
    end if;
  end if;
  return jsonb_build_object(
    'result', v_result, 'ticketingDeadlineAt', v_booking.ticketing_deadline_at,
    'lastTicketingTime', v_booking.supplier_ticketing_time_limit,
    'updatedAt', v_booking.updated_at, 'revision', v_version.revision);
end;
$$;

revoke all on function public.apply_shapon_booking_deadline(uuid, text, text, timestamptz, bigint, text, uuid)
  from public, anon, authenticated;
grant execute on function public.apply_shapon_booking_deadline(uuid, text, text, timestamptz, bigint, text, uuid)
  to service_role;
