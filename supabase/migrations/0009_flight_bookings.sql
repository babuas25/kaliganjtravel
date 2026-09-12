-- Private booking drafts and the irreversible Triplover Book outcome.

create table if not exists public.flight_bookings (
  id                     uuid primary key,
  access_token_hash      text not null unique
                         check (access_token_hash ~ '^[a-f0-9]{64}$'),
  user_id                text references public.app_users (clerk_id) on delete set null,
  audience               text not null check (audience in ('b2c', 'agency', 'superadmin')),
  agency_code            text,
  search_id              uuid not null,
  itinerary_id           text not null,
  status                 text not null default 'draft'
                         check (status in ('draft', 'submitting', 'held', 'ticketed', 'failed', 'unknown')),
  currency               text not null default 'BDT',
  pricing_snapshot       jsonb not null check (jsonb_typeof(pricing_snapshot) = 'object'),
  passenger_counts       jsonb not null check (jsonb_typeof(passenger_counts) = 'object'),
  travel_date            date not null,
  direct_ticketing       boolean not null default false,
  supplier_refs          jsonb not null check (jsonb_typeof(supplier_refs) = 'object'),
  repriced_at            timestamptz not null,
  accepted_at            timestamptz not null,
  expires_at             timestamptz not null,
  passengers             jsonb,
  pnr                    text,
  airlines_pnr           jsonb,
  booking_ref_number     text,
  booking_status         text,
  ticketing_time_limit   text,
  booking_code_ref       text,
  ticket_code_ref        text,
  ticket_numbers         jsonb,
  warnings               jsonb,
  supplier_message       text,
  error_code             text,
  submission_started_at  timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

drop trigger if exists flight_bookings_touch_updated_at
  on public.flight_bookings;
create trigger flight_bookings_touch_updated_at
  before update on public.flight_bookings
  for each row execute function public.touch_updated_at();

create index if not exists flight_bookings_user_created_idx
  on public.flight_bookings (user_id, created_at desc);
create index if not exists flight_bookings_status_idx
  on public.flight_bookings (status, updated_at desc);
create index if not exists flight_bookings_expires_idx
  on public.flight_bookings (expires_at);

alter table public.flight_bookings enable row level security;
revoke all on table public.flight_bookings from anon, authenticated;

comment on table public.flight_bookings is
  'Private traveller drafts, Triplover Book references, and held/direct-ticket outcomes.';
