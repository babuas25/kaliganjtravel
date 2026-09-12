import Link from 'next/link';
import { format, isValid, parseISO } from 'date-fns';
import { ArrowRight } from 'lucide-react';

import { searchAirports } from '@/lib/airports/search';
import type {
  FlightSearchSuggestion,
  FlightSearchSuggestionList,
} from '@/lib/db/flight-search-history';
import { CABIN_CLASSES } from '@/lib/flights/cabin';
import { encodeSearchParams } from '@/lib/flights/search-params';
import type { FlightSearchInput, TripType } from '@/lib/flights/types';

type Props = {
  suggestions: FlightSearchSuggestionList;
};

const cityCache = new Map<string, string>();

function city(code: string): string {
  const cached = cityCache.get(code);
  if (cached) return cached;
  const airport = searchAirports(code, 20).find((item) => item.iata === code);
  const label = airport?.city || code;
  cityCache.set(code, label);
  return label;
}

function dateLabel(value: string): string {
  const parsed = parseISO(value);
  return isValid(parsed) ? format(parsed, 'd MMM yyyy') : value;
}

function tripLabel(tripType: TripType): string {
  if (tripType === 'round') return 'Round trip';
  if (tripType === 'multicity') return 'Multi city';
  return 'One way';
}

function routeLabel(input: FlightSearchInput): string {
  if (input.tripType === 'multicity') {
    const stops = [input.routes[0]?.origin, ...input.routes.map((route) => route.destination)]
      .filter((code): code is string => Boolean(code))
      .map(city);
    return stops.join(' → ');
  }
  const route = input.routes[0];
  return route ? `${city(route.origin)} → ${city(route.destination)}` : '';
}

function datesLabel(input: FlightSearchInput): string {
  const first = input.routes[0]?.departureDate;
  const last = input.routes[input.routes.length - 1]?.departureDate;
  if (!first) return '';
  return input.routes.length > 1 && last && last !== first
    ? `${dateLabel(first)} – ${dateLabel(last)}`
    : dateLabel(first);
}

function passengerLabel(input: FlightSearchInput): string {
  const parts: string[] = [];
  if (input.adults) parts.push(`${input.adults} Adult${input.adults === 1 ? '' : 's'}`);
  if (input.children) {
    parts.push(`${input.children} Child${input.children === 1 ? '' : 'ren'}`);
  }
  if (input.infants) parts.push(`${input.infants} Infant${input.infants === 1 ? '' : 's'}`);
  return parts.join(', ');
}

function cabinLabel(input: FlightSearchInput): string {
  return (
    CABIN_CLASSES.find((cabin) => cabin.value === input.cabinClass)?.label ??
    'Economy'
  );
}

function SearchCard({ item }: { item: FlightSearchSuggestion }) {
  const href = `/flights?${encodeSearchParams(item.input)}`;
  const route = routeLabel(item.input);
  return (
    <Link
      href={href}
      prefetch={false}
      title={`Search flights: ${route}`}
      className="group flex min-h-32 min-w-[270px] flex-1 snap-start flex-col rounded-xl border border-neutral-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-brand-orange/35 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange lg:min-w-0"
    >
      <span className="flex min-w-0 items-start justify-between gap-3">
        <span className="shrink-0 text-[11px] font-bold uppercase tracking-wide text-emerald-600">
          {tripLabel(item.input.tripType)}
        </span>
        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-neutral-500">
          {datesLabel(item.input)}
        </span>
      </span>
      <span className="mt-3 flex items-center gap-2 text-sm font-semibold text-navy-950">
        <span className="min-w-0 flex-1 truncate">{route}</span>
        <ArrowRight
          aria-hidden
          className="h-4 w-4 shrink-0 text-neutral-300 transition group-hover:translate-x-0.5 group-hover:text-brand-orange"
        />
      </span>
      <span className="mt-auto pt-3 text-xs text-neutral-600">
        {passengerLabel(item.input)} · {cabinLabel(item.input)}
      </span>
    </Link>
  );
}

export default function FlightSearchSuggestions({ suggestions }: Props) {
  const heading = suggestions.kind === 'recent' ? 'Recent searches' : 'Popular searches';

  return (
    <section aria-labelledby="flight-search-suggestions-heading">
      <h2
        id="flight-search-suggestions-heading"
        className="text-base font-semibold text-navy-950"
      >
        {heading}
      </h2>
      {suggestions.items.length > 0 ? (
        <div className="mt-3 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 lg:overflow-visible">
          {suggestions.items.map((item) => (
            <SearchCard key={item.id} item={item} />
          ))}
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-dashed border-neutral-300 bg-white/70 px-5 py-7 text-center">
          <p className="text-sm font-medium text-navy-950">No popular searches yet</p>
          <p className="mt-1 text-xs text-neutral-500">
            Popular routes appear after multiple users successfully search them.
          </p>
        </div>
      )}
    </section>
  );
}
