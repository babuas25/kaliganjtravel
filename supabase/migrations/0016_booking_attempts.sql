-- The operational layer: one row per fare selection that may become a booking.
--
-- This table exists for reliability, not for business reporting. It records
-- everything needed to recover from a lost supplier answer — the reference
-- chain in particular, which per the supplier contract cannot be re-derived —
-- and it is written *before* the irreversible Book call so that an orphaned
-- PNR is always traceable.
--
-- Step 1 of BOOKING_ARCHITECTURE.md. Nothing reads this table yet: the current
-- flow still treats `flight_bookings` as authoritative and mirrors into here.
-- During that window an attempt shares the id of the draft it mirrors, so the
-- two are trivially correlated; from step 2 the attempt id stands alone.

create table if not exists public.booking_attempts (
  id                 uuid primary key,
  -- The checkout capability, same scheme as flight_bookings today.
  access_token_hash  text not null unique
                     check (access_token_hash ~ '^[a-f0-9]{64}$'),
  user_id            text references public.app_users (clerk_id) on delete set null,
  audience           text not null
                     check (audience in ('b2c', 'agency', 'superadmin')),
  agency_code        text,
  supplier           text not null default 'triplover',
  state              text not null default 'draft'
                     check (state in ('draft', 'submitting', 'succeeded', 'failed', 'unknown')),

  search_id          uuid not null,
  itinerary_id       text not null,

  -- Recovery keys. Present from the moment the attempt is created; the last
  -- two arrive only with a successful Book response.
  unique_trans_id    text not null,
  item_code_ref      text not null,
  price_code_ref     text not null,
  booking_code_ref   text,
  pnr                text,

  -- Self-sufficient copies: flight_search_quotes expires in 20 minutes and the
  -- attempt has to stay meaningful long after that.
  offer_snapshot     jsonb not null check (jsonb_typeof(offer_snapshot) = 'object'),
  passenger_snapshot jsonb,

  error_code         text,
  supplier_message   text,
  warnings           jsonb,

  -- Quote expiry. Bounds `draft` only; a submitted attempt is not released.
  expires_at         timestamptz not null,
  submitted_at       timestamptz,
  resolved_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

drop trigger if exists booking_attempts_touch_updated_at
  on public.booking_attempts;
create trigger booking_attempts_touch_updated_at
  before update on public.booking_attempts
  for each row execute function public.touch_updated_at();

create index if not exists booking_attempts_user_created_idx
  on public.booking_attempts (user_id, created_at desc);
create index if not exists booking_attempts_state_idx
  on public.booking_attempts (state, updated_at desc);
-- The orphan sweep: attempts that went to the supplier and never came back.
create index if not exists booking_attempts_in_flight_idx
  on public.booking_attempts (submitted_at)
  where state = 'submitting';
-- Reconciliation against the supplier is keyed on the transaction id.
create index if not exists booking_attempts_unique_trans_idx
  on public.booking_attempts (unique_trans_id);

alter table public.booking_attempts enable row level security;
revoke all on table public.booking_attempts from anon, authenticated;

comment on table public.booking_attempts is
  'Durable record of every fare selection sent, or about to be sent, to a supplier. Audit and recovery only — never a business booking.';
comment on column public.booking_attempts.state is
  'draft | submitting | succeeded | failed | unknown. Never a business booking status.';
comment on column public.booking_attempts.offer_snapshot is
  'Itinerary, fares, pricing, passenger counts and flags as they stood when the fare was selected.';
