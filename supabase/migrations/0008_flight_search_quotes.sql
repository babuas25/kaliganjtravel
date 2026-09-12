-- Durable, private Search references for the RePrice and Booking pipeline.
--
-- Browser clients receive only the random row id (`searchId`) and our own
-- itinerary ids. Supplier transaction/item/segment/price references and the
-- commercial pricing snapshot stay inside `itinerary_refs`.

create table if not exists public.flight_search_quotes (
  id               uuid primary key,
  unique_trans_id  text not null
                   check (char_length(unique_trans_id) between 1 and 512),
  itinerary_refs   jsonb not null
                   check (jsonb_typeof(itinerary_refs) = 'object'),
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

drop trigger if exists flight_search_quotes_touch_updated_at
  on public.flight_search_quotes;
create trigger flight_search_quotes_touch_updated_at
  before update on public.flight_search_quotes
  for each row execute function public.touch_updated_at();

create index if not exists flight_search_quotes_expires_at_idx
  on public.flight_search_quotes (expires_at);

alter table public.flight_search_quotes enable row level security;

-- Defense in depth in addition to RLS-with-no-policies. Only the service-role
-- server client may read or mutate supplier references.
revoke all on table public.flight_search_quotes from anon, authenticated;

comment on table public.flight_search_quotes is
  'Private, expiring Triplover Search/RePrice references and pricing snapshots.';
