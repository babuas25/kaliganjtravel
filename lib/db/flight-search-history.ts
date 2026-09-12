import 'server-only';

import { createHash } from 'node:crypto';

import { isCabinClassValue } from '@/lib/flights/cabin';
import type {
  FlightSearchInput,
  SearchRoute,
  TripType,
} from '@/lib/flights/types';
import { supabaseAdmin } from '@/lib/supabase/server';

const RECENT_LIMIT = 5;
const POPULAR_LOOKBACK_DAYS = 30;
const POPULAR_MIN_DISTINCT_USERS = 2;
const IATA = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CARRIER = /^[A-Z0-9]{2}$/;

type HistoryRow = {
  id: string;
  trip_type: unknown;
  routes: unknown;
  adults: unknown;
  children: unknown;
  infants: unknown;
  children_ages?: unknown;
  cabin_class: unknown;
  preferred_carriers?: unknown;
  searched_at: string;
};

export type FlightSearchSuggestion = {
  id: string;
  input: FlightSearchInput;
  searchedAt: string;
};

export type FlightSearchSuggestionList = {
  kind: 'recent' | 'popular';
  items: FlightSearchSuggestion[];
};

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Canonical shape keeps deduplication stable across equivalent requests. */
function canonical(input: FlightSearchInput): FlightSearchInput {
  return {
    tripType: input.tripType,
    routes: input.routes.map((route) => ({
      origin: route.origin.trim().toUpperCase(),
      destination: route.destination.trim().toUpperCase(),
      departureDate: route.departureDate,
    })),
    adults: input.adults,
    children: input.children,
    infants: input.infants,
    childrenAges: input.childrenAges.slice(0, input.children),
    cabinClass: input.cabinClass,
    preferredCarriers: Array.from(
      new Set(input.preferredCarriers.map((code) => code.toUpperCase()))
    ).sort(),
  };
}

function popularityShape(input: FlightSearchInput) {
  return {
    tripType: input.tripType,
    routes: input.routes.map(({ origin, destination }) => ({ origin, destination })),
    cabinClass: input.cabinClass,
  };
}

/**
 * Records only a successful, validated search made by a signed-in user.
 * Failure is non-fatal: history must never turn a valid supplier result into
 * an error for the traveller.
 */
export async function recordFlightSearch(
  userId: string | null,
  input: FlightSearchInput
): Promise<void> {
  if (!userId) return;
  const supabase = supabaseAdmin();
  if (!supabase) return;

  const normalized = canonical(input);
  const firstDepartureDate = normalized.routes[0]?.departureDate;
  if (!firstDepartureDate) return;

  try {
    // A new Clerk account can search during the same response in which its
    // deferred registry visit is recorded. Ensure the FK target exists without
    // overwriting any mirrored identity already present.
    const { error: userError } = await supabase.from('app_users').upsert(
      { clerk_id: userId },
      { onConflict: 'clerk_id', ignoreDuplicates: true }
    );
    if (userError) {
      console.error('[db] flight search history user stub failed:', userError.message);
      return;
    }

    const { error } = await supabase.from('flight_search_history').upsert(
      {
        user_id: userId,
        search_key: hash(normalized),
        popularity_key: hash(popularityShape(normalized)),
        trip_type: normalized.tripType,
        routes: normalized.routes,
        first_departure_date: firstDepartureDate,
        adults: normalized.adults,
        children: normalized.children,
        infants: normalized.infants,
        children_ages: normalized.childrenAges,
        cabin_class: normalized.cabinClass,
        preferred_carriers: normalized.preferredCarriers,
        searched_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,search_key' }
    );

    if (error) console.error('[db] recordFlightSearch failed:', error.message);
  } catch (error) {
    console.error(
      '[db] recordFlightSearch unavailable:',
      error instanceof Error ? error.message : 'unknown database error'
    );
  }
}

function integer(value: unknown, min: number, max: number): number | null {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : null;
}

function routes(value: unknown): SearchRoute[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) return null;
  const parsed: SearchRoute[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const row = item as Record<string, unknown>;
    const origin = typeof row.origin === 'string' ? row.origin : '';
    const destination = typeof row.destination === 'string' ? row.destination : '';
    const departureDate =
      typeof row.departureDate === 'string' ? row.departureDate : '';
    if (
      !IATA.test(origin) ||
      !IATA.test(destination) ||
      origin === destination ||
      !ISO_DATE.test(departureDate)
    ) {
      return null;
    }
    parsed.push({ origin, destination, departureDate });
  }
  return parsed;
}

function tripType(value: unknown, routeCount: number): TripType | null {
  if (value === 'oneway' && routeCount === 1) return value;
  if (value === 'round' && routeCount === 2) return value;
  if (value === 'multicity' && routeCount >= 2) return value;
  return null;
}

function inputFromRow(row: HistoryRow, popular: boolean): FlightSearchInput | null {
  const parsedRoutes = routes(row.routes);
  if (!parsedRoutes) return null;
  const parsedTripType = tripType(row.trip_type, parsedRoutes.length);
  const adults = integer(row.adults, 1, 9);
  const children = integer(row.children, 0, 8);
  const infants = integer(row.infants, 0, 9);
  if (
    !parsedTripType ||
    adults === null ||
    children === null ||
    infants === null ||
    adults + children > 9 ||
    infants > adults ||
    !isCabinClassValue(row.cabin_class)
  ) {
    return null;
  }

  const storedAges = Array.isArray(row.children_ages)
    ? row.children_ages.filter((age): age is number =>
        Number.isInteger(age) && age >= 2 && age <= 11
      )
    : [];
  const childrenAges = popular
    ? Array.from({ length: children }, () => 8)
    : storedAges;
  if (childrenAges.length !== children) return null;

  const preferredCarriers = popular
    ? []
    : Array.isArray(row.preferred_carriers)
      ? row.preferred_carriers.filter(
          (code): code is string => typeof code === 'string' && CARRIER.test(code)
        )
      : [];

  return {
    tripType: parsedTripType,
    routes: parsedRoutes,
    adults,
    children,
    infants,
    childrenAges,
    cabinClass: row.cabin_class,
    preferredCarriers,
  };
}

function suggestionRows(rows: HistoryRow[], popular: boolean): FlightSearchSuggestion[] {
  return rows.flatMap((row) => {
    const input = inputFromRow(row, popular);
    return input
      ? [{ id: row.id, input, searchedAt: row.searched_at }]
      : [];
  });
}

function dhakaToday(): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Current user's recent future searches, or anonymized global popularity. */
export async function getFlightSearchSuggestions(
  userId: string
): Promise<FlightSearchSuggestionList> {
  const supabase = supabaseAdmin();
  if (!supabase) return { kind: 'popular', items: [] };

  const today = dhakaToday();
  try {
    const { data: recent, error: recentError } = await supabase
      .from('flight_search_history')
      .select(
        'id, trip_type, routes, adults, children, infants, children_ages, cabin_class, preferred_carriers, searched_at'
      )
      .eq('user_id', userId)
      .gte('first_departure_date', today)
      .order('searched_at', { ascending: false })
      .limit(RECENT_LIMIT);

    if (recentError) {
      console.error('[db] recent flight searches failed:', recentError.message);
    } else {
      const items = suggestionRows((recent ?? []) as HistoryRow[], false);
      if (items.length > 0) return { kind: 'recent', items };
    }

    const since = new Date(
      Date.now() - POPULAR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const { data: popular, error: popularError } = await supabase.rpc(
      'popular_flight_searches_v1',
      {
        p_since: since,
        p_today: today,
        p_limit: RECENT_LIMIT,
        p_min_distinct_users: POPULAR_MIN_DISTINCT_USERS,
      }
    );

    if (popularError) {
      console.error('[db] popular flight searches failed:', popularError.message);
      return { kind: 'popular', items: [] };
    }
    return {
      kind: 'popular',
      items: suggestionRows((popular ?? []) as HistoryRow[], true),
    };
  } catch (error) {
    console.error(
      '[db] flight search suggestions unavailable:',
      error instanceof Error ? error.message : 'unknown database error'
    );
    return { kind: 'popular', items: [] };
  }
}
