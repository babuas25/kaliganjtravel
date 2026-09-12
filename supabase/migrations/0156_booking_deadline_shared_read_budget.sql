-- One durable automatic supplier-read budget per booking, shared by browser
-- requests and the background worker. Page opens never reset this budget.
create table public.booking_deadline_read_budgets (
  booking_id uuid primary key references public.flight_bookings(id) on delete restrict,
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  claim_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null,
  complete boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.booking_deadline_read_budgets enable row level security;
revoke all on public.booking_deadline_read_budgets from public, anon, authenticated;

create or replace function public.claim_booking_deadline_read_v1(p_booking_id uuid)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_booking public.flight_bookings;
  v_budget public.booking_deadline_read_budgets;
  v_token uuid;
begin
  select * into v_booking from public.flight_bookings where id = p_booking_id;
  if not found or v_booking.ticketing_deadline_at is not null
     or v_booking.legacy_operational
     or v_booking.supplier is distinct from 'triplover' or v_booking.import_source = 'MANUAL'
     or v_booking.status not in ('on-hold', 'pending')
     or v_booking.operation_kind is not null then
    return jsonb_build_object('claimed', false, 'complete', true);
  end if;
  insert into public.booking_deadline_read_budgets(booking_id, attempt_count, next_attempt_at)
    values (p_booking_id, coalesce((
      select job.attempt_count from public.booking_pnr_refresh_jobs job
      where job.booking_id = p_booking_id
    ), 0), v_booking.created_at + interval '5 seconds')
    on conflict (booking_id) do nothing;
  select * into v_budget from public.booking_deadline_read_budgets
    where booking_id = p_booking_id for update;
  if v_budget.complete then
    return jsonb_build_object('claimed', false, 'complete', true);
  end if;
  if v_budget.lease_until > clock_timestamp() then
    return jsonb_build_object('claimed', false, 'complete', false);
  end if;
  if v_budget.attempt_count >= 3 then
    update public.booking_deadline_read_budgets set complete = true,
      claim_token = null, lease_until = null, updated_at = clock_timestamp()
      where booking_id = p_booking_id;
    return jsonb_build_object('claimed', false, 'complete', true);
  end if;
  if v_budget.next_attempt_at > clock_timestamp() then
    return jsonb_build_object('claimed', false, 'complete', false);
  end if;
  v_token := gen_random_uuid();
  update public.booking_deadline_read_budgets
    set attempt_count = attempt_count + 1, claim_token = v_token,
        lease_until = clock_timestamp() + interval '3 minutes',
        next_attempt_at = clock_timestamp() + interval '5 seconds',
        updated_at = clock_timestamp()
    where booking_id = p_booking_id;
  return jsonb_build_object('claimed', true, 'complete', false, 'claimToken', v_token);
end;
$$;

create or replace function public.finish_booking_deadline_read_v1(p_booking_id uuid, p_claim_token uuid)
returns boolean
language plpgsql security definer set search_path = public
as $$
begin
  update public.booking_deadline_read_budgets budget
    set claim_token = null, lease_until = null, updated_at = clock_timestamp(),
        complete = budget.attempt_count >= 3 or exists (
          select 1 from public.flight_bookings booking
          where booking.id = p_booking_id and booking.ticketing_deadline_at is not null
        )
    where budget.booking_id = p_booking_id and budget.claim_token = p_claim_token;
  return found;
end;
$$;
revoke all on function public.claim_booking_deadline_read_v1(uuid),
  public.finish_booking_deadline_read_v1(uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_booking_deadline_read_v1(uuid),
  public.finish_booking_deadline_read_v1(uuid,uuid) to service_role;
