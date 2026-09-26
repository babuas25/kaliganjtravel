'use client';

import {
  Plane,
  CalendarDays,
  Filter,
  Loader2,
  PlaneTakeoff,
  RefreshCw,
  UsersRound,
} from 'lucide-react';
import {
  addDays,
  differenceInCalendarDays,
  format,
  isBefore,
  isValid,
  parseISO,
  startOfDay,
} from 'date-fns';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useUser } from '@clerk/nextjs';

import AirlineFilterBar from '@/components/flights/AirlineFilterBar';
import FlightFilters, {
  type DepartureBandKey,
  type FlightFilterOptions,
  type FlightFilterState,
  type StopFilterKey,
} from '@/components/flights/FlightFilters';
import ItineraryCard from '@/components/flights/ItineraryCard';
import ResultsDateNavigator from '@/components/flights/ResultsDateNavigator';
import ResultsSortBar, {
  type ResultsSortKey,
} from '@/components/flights/ResultsSortBar';
import { encodeSearchParams } from '@/lib/flights/search-params';
import { CABIN_CLASSES } from '@/lib/flights/cabin';
import {
  formatPrice,
  legDurationMinutes,
  legLayoverMinutes,
  timeOf,
  type AirlineFilter,
  type FlightItinerary,
  type FlightSearchInput,
  type FlightSearchResult,
} from '@/lib/flights/types';
import { resolveRole } from '@/lib/roles';
import { resultDisplayPrice } from '@/lib/flights/display-pricing';

/**
 * Runs the search from the browser rather than on the server.
 *
 * Triplover's Search takes the better part of a minute — a live one-way took 57
 * seconds. Doing it in the page's server render would leave the visitor on the
 * previous screen with no feedback for that whole time, so the page shells in
 * immediately and this component reports progress while it waits.
 */

type Envelope =
  | { success: true; data: FlightSearchResult }
  | { success: false; error: { errorCode: string; errorMessage: string } };

type SearchProgressStage =
  | 'accepted'
  | 'validating'
  | 'authorizing'
  | 'searching'
  | 'processing'
  | 'finalizing';

type SearchStreamEvent = {
  event: string;
  data: unknown;
};

type BookingAssignee = {
  id: string;
  name: string;
  email: string;
  role: 'b2b' | 'b2b_sub' | 'customer';
  agencyCode: string | null;
  agencyName: string | null;
};

function StaffBookingAssigneePicker({
  selected,
  onSelect,
}: {
  selected: BookingAssignee | null;
  onSelect: (user: BookingAssignee | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<BookingAssignee[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/flights/booking/assignees?q=${encodeURIComponent(query)}`,
          { signal: controller.signal, cache: 'no-store' }
        );
        const envelope = (await response.json()) as {
          users?: BookingAssignee[];
          error?: string;
        };
        if (!response.ok) throw new Error(envelope.error || 'User search failed.');
        setUsers(envelope.users ?? []);
      } catch (fetchError) {
        if (fetchError instanceof DOMException && fetchError.name === 'AbortError') return;
        setError(fetchError instanceof Error ? fetchError.message : 'User search failed.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <section className="rounded-xl border border-brand-orange/25 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-orange-light text-brand-orange-dark">
          <UsersRound className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-navy-950">Book on behalf of user</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            Required. This booking will be On Hold only and no wallet funds will be touched.
          </p>
          {selected ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-navy-50 px-3 py-2.5 ring-1 ring-navy-100">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-navy-950">{selected.name}</p>
                {selected.role === 'customer' ? (
                  <p className="truncate text-xs text-neutral-500">
                    B2C User{selected.email ? ` · ${selected.email}` : ''}
                  </p>
                ) : (
                  <div className="mt-0.5 space-y-0.5 text-xs text-neutral-500">
                    <p className="truncate">
                      Agency: <span className="font-medium text-navy-800">{selected.agencyName || 'Agency name unavailable'}</span>
                    </p>
                    <p className="truncate">
                      Agency ID: <span className="font-mono font-medium text-navy-800">{selected.agencyCode || '—'}</span>
                      {selected.email ? ` · Email: ${selected.email}` : ''}
                    </p>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onSelect(null)}
                className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-semibold text-navy-950 hover:border-brand-orange/40"
              >
                Change user
              </button>
            </div>
          ) : (
            <div className="mt-3">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, email, agency or Agency ID"
                aria-label="Search booking assignee"
                className="h-10 w-full rounded-md border border-neutral-300 px-3 text-sm text-navy-950 outline-none focus:border-brand-orange focus:ring-2 focus:ring-brand-orange/20"
              />
              <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-neutral-200">
                {loading ? (
                  <p className="px-3 py-4 text-center text-xs text-neutral-500">Loading users…</p>
                ) : error ? (
                  <p className="px-3 py-4 text-center text-xs text-red-600">{error}</p>
                ) : users.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-neutral-500">No eligible users found.</p>
                ) : (
                  users.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => onSelect(candidate)}
                      className="flex w-full items-start justify-between gap-3 border-b border-neutral-100 px-3 py-2.5 text-left last:border-0 hover:bg-navy-50"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-navy-950">{candidate.name}</span>
                        {candidate.role !== 'customer' && (
                          <span className="mt-0.5 block truncate text-xs font-medium text-navy-700">
                            Agency: {candidate.agencyName || 'Agency name unavailable'}
                          </span>
                        )}
                        <span className="mt-0.5 block truncate text-xs text-neutral-500">
                          Email: {candidate.email || 'No email'}
                        </span>
                      </span>
                      <span className="shrink-0 text-right text-[11px] font-medium text-neutral-500">
                        {candidate.role === 'customer' ? (
                          'B2C User'
                        ) : (
                          <>
                            <span className="block">Agency ID</span>
                            <span className="mt-0.5 block font-mono text-navy-700">
                              {candidate.agencyCode || '—'}
                            </span>
                          </>
                        )}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Supplier-authoritative travel minutes across every requested route. */
function journeyMinutes(itinerary: FlightItinerary): number {
  return itinerary.legs.reduce((total, leg) => {
    return total + (legDurationMinutes(leg) ?? 0);
  }, 0);
}

/** Waiting time between connected segments across the itinerary. */
function layoverMinutes(itinerary: FlightItinerary): number {
  return itinerary.legs.reduce(
    (total, leg) => total + (legLayoverMinutes(leg) ?? 0),
    0
  );
}

function stopKey(itinerary: FlightItinerary): StopFilterKey {
  const stops = itinerary.legs.reduce(
    (highest, leg) => Math.max(highest, leg.stops, leg.segments.length - 1),
    0
  );
  if (stops <= 0) return 'nonstop';
  if (stops === 1) return 'one';
  return 'twoPlus';
}

function departureBand(itinerary: FlightItinerary): DepartureBandKey {
  const stamp = itinerary.legs[0]?.departure ?? '';
  const hour = Number(timeOf(stamp).slice(0, 2));
  if (!Number.isFinite(hour) || hour < 6) return 'night';
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

function filterOptions(result: FlightSearchResult): FlightFilterOptions {
  const stopCounts: FlightFilterOptions['stopCounts'] = {
    nonstop: 0,
    one: 0,
    twoPlus: 0,
  };
  const departureCounts: FlightFilterOptions['departureCounts'] = {
    night: 0,
    morning: 0,
    afternoon: 0,
    evening: 0,
  };

  for (const itinerary of result.itineraries) {
    stopCounts[stopKey(itinerary)] += 1;
    departureCounts[departureBand(itinerary)] += 1;
  }

  const prices = result.itineraries.map((itinerary) => itinerary.totalPrice);
  const durations = result.itineraries.map(journeyMinutes);

  return {
    stopCounts,
    refundableCount: result.itineraries.filter((itinerary) => itinerary.refundable).length,
    priceBounds: {
      min: Math.floor(Math.min(...prices)),
      max: Math.ceil(Math.max(...prices)),
    },
    durationBounds: {
      min: Math.floor(Math.min(...durations) / 5) * 5,
      max: Math.ceil(Math.max(...durations) / 5) * 5,
    },
    departureCounts,
  };
}

function defaultFilters(options: FlightFilterOptions): FlightFilterState {
  return {
    stops: [],
    refundableOnly: false,
    price: { ...options.priceBounds },
    duration: { ...options.durationBounds },
    departureBands: [],
    airlines: [],
  };
}

function isSearchProgressStage(value: unknown): value is SearchProgressStage {
  return (
    value === 'accepted' ||
    value === 'validating' ||
    value === 'authorizing' ||
    value === 'searching' ||
    value === 'processing' ||
    value === 'finalizing'
  );
}

function readSseEvent(block: string): SearchStreamEvent | null {
  let event = 'message';
  const data: string[] = [];

  for (const line of block.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      data.push(line.slice('data:'.length).trimStart());
    }
  }

  if (data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join('\n')) as unknown };
  } catch {
    // A malformed stream event must never turn into a fake result or error.
    return null;
  }
}

async function readSearchStream(
  response: Response,
  onEvent: (event: SearchStreamEvent) => void
): Promise<void> {
  if (!response.body) throw new Error('The search service did not provide a stream.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';

  while (true) {
    const { done, value } = await reader.read();
    if (value) pending += decoder.decode(value, { stream: !done });
    if (done) pending += decoder.decode();

    let boundary = /\r?\n\r?\n/.exec(pending);
    while (boundary?.index !== undefined) {
      const parsed = readSseEvent(pending.slice(0, boundary.index));
      if (parsed) onEvent(parsed);
      pending = pending.slice(boundary.index + boundary[0].length);
      boundary = /\r?\n\r?\n/.exec(pending);
    }

    if (done) break;
  }
}

const SEARCH_STAGES = [
  {
    label: 'Preparing your live search',
    detail: 'Getting your dates and traveller preferences ready.',
  },
  {
    label: 'Contacting airline systems',
    detail: 'Waiting for live flight and seat availability.',
  },
  {
    label: 'Comparing available flights',
    detail: 'Organising the available options for your journey.',
  },
  {
    label: 'Getting your results ready',
    detail: 'Preparing your flight options and live fares.',
  },
] as const;

function displayStageIndex(stage: SearchProgressStage): number {
  switch (stage) {
    case 'searching':
      return 1;
    case 'processing':
      return 2;
    case 'finalizing':
      return 3;
    case 'accepted':
    case 'validating':
    case 'authorizing':
      return 0;
  }
}

function SkeletonLine({ className }: { className: string }) {
  return <span className={`block animate-pulse rounded bg-neutral-200/80 ${className}`} />;
}

function ResultCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-neutral-200">
      <div className="grid min-h-36 grid-cols-[58px_minmax(0,1fr)] sm:grid-cols-[58px_135px_minmax(0,1fr)_155px]">
        <div className="flex justify-center border-r border-neutral-100 p-3">
          <div className="h-10 w-10 animate-pulse rounded-lg bg-neutral-200" />
        </div>
        <div className="hidden space-y-3 p-4 sm:block">
          <SkeletonLine className="h-3 w-24" />
          <SkeletonLine className="h-2.5 w-16" />
          <SkeletonLine className="mt-8 h-2.5 w-20" />
        </div>
        <div className="grid grid-cols-[1fr_80px_1fr] items-center gap-3 px-4 py-5">
          <div className="space-y-2">
            <SkeletonLine className="h-3 w-16" />
            <SkeletonLine className="h-6 w-20" />
            <SkeletonLine className="h-2.5 w-24" />
          </div>
          <div className="space-y-2">
            <SkeletonLine className="mx-auto h-2.5 w-14" />
            <SkeletonLine className="h-px w-full" />
            <SkeletonLine className="mx-auto h-2.5 w-12" />
          </div>
          <div className="space-y-2">
            <SkeletonLine className="ml-auto h-3 w-16" />
            <SkeletonLine className="ml-auto h-6 w-20" />
            <SkeletonLine className="ml-auto h-2.5 w-24" />
          </div>
        </div>
        <div className="hidden border-l border-neutral-100 p-4 sm:block">
          <SkeletonLine className="h-3 w-20" />
          <SkeletonLine className="mt-3 h-3 w-28" />
          <SkeletonLine className="mt-7 h-6 w-28" />
        </div>
      </div>
      <div className="flex h-11 items-center gap-5 border-t border-neutral-100 bg-neutral-50 px-4">
        <SkeletonLine className="h-2.5 w-20" />
        <SkeletonLine className="h-2.5 w-14" />
        <SkeletonLine className="h-2.5 w-16" />
        <SkeletonLine className="h-2.5 w-24" />
      </div>
    </div>
  );
}

function LoadingState({
  stage,
  input,
}: {
  stage: SearchProgressStage;
  input: FlightSearchInput;
}) {
  const stageIndex = displayStageIndex(stage);
  const { label: title, detail } = SEARCH_STAGES[stageIndex];
  const tripLabel = input.tripType === 'round' ? 'Round trip' : input.tripType === 'multicity' ? 'Multi-city' : 'One way';
  const travellerCount = input.adults + input.children + input.infants;
  const cabin = CABIN_CLASSES.find((option) => option.value === input.cabinClass)?.label ?? 'Economy';
  const routes = input.tripType === 'round' ? input.routes.slice(0, 1) : input.routes;
  const dateLabel = (value: string) => {
    const date = parseISO(value);
    return isValid(date) ? format(date, 'dd MMM yyyy') : value;
  };

  return (
    <section className="relative grid min-h-[650px]" aria-live="polite" aria-busy="true">
      <div aria-hidden className="col-start-1 row-start-1 grid gap-3 lg:grid-cols-[270px_minmax(0,1fr)] lg:items-start lg:gap-5">
        <aside className="hidden overflow-hidden rounded-lg bg-white ring-1 ring-neutral-200 lg:block">
          <div className="flex h-14 items-center gap-3 border-b border-neutral-200 px-5">
            <div className="h-5 w-5 animate-pulse rounded bg-neutral-200" />
            <SkeletonLine className="h-4 w-20" />
          </div>
          {[3, 1, 2, 2].map((rows, section) => (
            <div key={section} className="space-y-4 border-b border-neutral-100 p-5">
              <SkeletonLine className="h-4 w-24" />
              {Array.from({ length: rows }).map((_, row) => (
                <div key={row} className="flex items-center gap-3">
                  <div className="h-4 w-4 animate-pulse rounded border border-neutral-200 bg-neutral-100" />
                  <SkeletonLine className="h-3 w-24" />
                </div>
              ))}
            </div>
          ))}
        </aside>

        <div className="min-w-0 space-y-3">
          <div className="flex gap-2 overflow-hidden rounded-lg bg-white p-2 ring-1 ring-neutral-200">
            {[64, 112, 112, 112, 112].map((width, index) => (
              <div key={index} className="h-10 shrink-0 animate-pulse rounded-md bg-neutral-100" style={{ width }} />
            ))}
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-11 animate-pulse rounded-lg bg-white ring-1 ring-neutral-200" />
            ))}
          </div>
          <div className="flex h-12 items-center justify-between rounded-lg bg-white px-4 ring-1 ring-neutral-200">
            <SkeletonLine className="h-3 w-28" />
            <SkeletonLine className="h-3 w-36" />
            <SkeletonLine className="h-3 w-20" />
          </div>
          {[0, 1, 2].map((item) => <ResultCardSkeleton key={item} />)}
        </div>
      </div>

      <div className="relative z-10 col-start-1 row-start-1 flex items-start justify-center bg-navy-50/65 px-3 pb-8 pt-5 backdrop-blur-[3px] sm:pt-8">
        <div className="w-full max-w-[440px] overflow-hidden rounded-3xl border border-white bg-white shadow-[0_20px_70px_-24px_rgba(8,38,76,0.25)]">
          <div className="px-5 pt-5 sm:px-7 sm:pt-6">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-navy-950/60">Kaliganj Travels</span>
              <span className="rounded-full bg-navy-50 px-3 py-1 text-[11px] font-medium text-navy-950/70">{tripLabel}</span>
            </div>
            <h2 className="mt-4 text-[23px] font-semibold leading-tight tracking-tight text-navy-950 sm:text-[26px]">Your journey is taking shape</h2>
            <p className="mt-2 text-sm leading-6 text-neutral-500">Finding the right flight for you.</p>

            <div className="mt-4 space-y-4 rounded-2xl border border-orange-100 bg-gradient-to-br from-orange-50/80 via-white to-orange-50/40 px-4 py-4 sm:px-5">
              {routes.map((route, index) => (
                <div key={`${route.origin}-${route.destination}-${index}`} className={index > 0 ? 'border-t border-orange-100 pt-4' : ''}>
                  <div className="grid grid-cols-[1fr_88px_1fr] items-center gap-2">
                    <div>
                      <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-neutral-500">{input.tripType === 'multicity' ? `Flight ${index + 1} · From` : 'From'}</p>
                      <p className="mt-1 text-[32px] font-bold leading-none tracking-tight text-navy-950">{route.origin}</p>
                    </div>
                    <div aria-hidden className="relative h-10 overflow-hidden">
                      <span className="absolute inset-x-1 top-1/2 border-t border-dashed border-orange-200" />
                      <span className="absolute left-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-orange-200" />
                      <span className="absolute right-0 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-brand-orange" />
                      <span className="flight-search-route-traveller absolute left-1 top-1 w-[calc(100%_-_40px)]">
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-brand-orange shadow-sm ring-1 ring-orange-100">
                          <Plane className="h-4 w-4 rotate-45" />
                        </span>
                      </span>
                    </div>
                    <div className="text-right">
                      <p className="text-[9px] font-semibold uppercase tracking-[0.16em] text-neutral-500">To</p>
                      <p className="mt-1 text-[32px] font-bold leading-none tracking-tight text-navy-950">{route.destination}</p>
                    </div>
                  </div>
                  <p className="mt-4 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 text-[11px] text-neutral-500">
                    <CalendarDays className="h-3.5 w-3.5" aria-hidden />
                    {dateLabel(route.departureDate)}
                    {input.tripType === 'round' && input.routes[1] && <span>— {dateLabel(input.routes[1].departureDate)}</span>}
                  </p>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs text-neutral-500">
              <UsersRound className="h-3.5 w-3.5" aria-hidden />
              <span>{travellerCount} {travellerCount === 1 ? 'traveller' : 'travellers'}</span>
              <span aria-hidden className="mx-1 h-1 w-1 rounded-full bg-neutral-300" />
              <span>{cabin}</span>
            </div>

            <div className="pb-5 pt-5">
              <div className="flex items-center gap-2.5">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-brand-orange motion-reduce:animate-none" aria-hidden />
                <p className="text-[13px] font-semibold text-navy-950">{title}</p>
              </div>
              <p className="mt-2 text-xs leading-5 text-neutral-500">{detail}</p>
              <ol aria-label="Flight search stages" className="mt-4 grid grid-cols-4 gap-2">
                {SEARCH_STAGES.map(({ label }, index) => (
                  <li key={label} aria-current={index === stageIndex ? 'step' : undefined} className={`h-1.5 rounded-full transition-colors motion-reduce:transition-none ${index < stageIndex ? 'bg-brand-orange' : index === stageIndex ? 'animate-pulse bg-brand-orange/60 motion-reduce:animate-none' : 'bg-neutral-100'}`}>
                    <span className="sr-only">{label}: {index < stageIndex ? 'Complete' : index === stageIndex ? 'In progress' : 'Pending'}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
          <div className="border-t border-neutral-100 bg-neutral-50/70 px-6 py-3.5 text-center text-[11px] text-neutral-500">
            Your results will appear here automatically
          </div>
        </div>
      </div>
    </section>
  );
}

function UnavailableResultsState({
  input,
  title,
  description,
  onPreviousDay,
  onNextDay,
  onSearchAgain,
}: {
  input: FlightSearchInput;
  title: string;
  description: string;
  onPreviousDay: () => void;
  onNextDay: () => void;
  onSearchAgain: () => void;
}) {
  const departureDate = parseISO(input.routes[0]?.departureDate ?? '');
  const hasValidDate = isValid(departureDate);
  const previousDayDisabled =
    !hasValidDate || !isBefore(startOfDay(new Date()), startOfDay(departureDate));
  const routeSummary = input.routes
    .map((route) => `${route.origin} → ${route.destination}`)
    .join(' · ');
  const passengerCount = input.adults + input.children + input.infants;
  const cabin =
    CABIN_CLASSES.find((option) => option.value === input.cabinClass)?.label ??
    'Economy';

  return (
    <section
      aria-labelledby="unavailable-results-title"
      className="mx-auto max-w-3xl rounded-xl bg-white px-5 py-10 text-center shadow-sm ring-1 ring-neutral-200 sm:px-10 sm:py-12"
    >
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-brand-orange-light">
        <PlaneTakeoff className="h-8 w-8 text-brand-orange" aria-hidden />
      </div>

      <h1
        id="unavailable-results-title"
        className="mt-5 text-2xl font-bold tracking-tight text-navy-950 sm:text-3xl"
      >
        {title}
      </h1>
      <p className="mx-auto mt-2 max-w-xl text-base text-neutral-500">
        {description}
      </p>

      <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
        <span className="inline-flex min-h-11 items-center rounded-lg border border-neutral-200 bg-neutral-50 px-4 text-sm font-semibold text-navy-950">
          {routeSummary}
        </span>
        <span className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 text-sm font-semibold text-navy-950">
          <CalendarDays className="h-4 w-4 text-brand-orange" aria-hidden />
          {hasValidDate
            ? format(departureDate, 'EEE, dd MMM yyyy')
            : input.routes[0]?.departureDate}
        </span>
        <span className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-4 text-sm font-semibold text-navy-950">
          <UsersRound className="h-4 w-4 text-brand-orange" aria-hidden />
          {passengerCount} {passengerCount === 1 ? 'Passenger' : 'Passengers'}, {cabin}
        </span>
      </div>

      <div className="mx-auto mt-8 grid max-w-xl gap-3 sm:grid-cols-2">
        <button
          type="button"
          disabled={previousDayDisabled}
          onClick={onPreviousDay}
          className="min-h-12 rounded-lg border border-neutral-200 bg-white px-5 text-base font-semibold text-navy-950 transition hover:border-brand-orange/40 hover:bg-brand-orange-light disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-300"
        >
          Previous day
        </button>
        <button
          type="button"
          disabled={!hasValidDate}
          onClick={onNextDay}
          className="min-h-12 rounded-lg border border-neutral-200 bg-white px-5 text-base font-semibold text-navy-950 transition hover:border-brand-orange/40 hover:bg-brand-orange-light disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-300"
        >
          Next day
        </button>
        <button
          type="button"
          onClick={onSearchAgain}
          className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-brand-orange px-5 text-base font-semibold text-navy-950 shadow-md shadow-brand-orange/20 transition hover:bg-brand-orange-dark hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange focus-visible:ring-offset-2 sm:col-span-2"
        >
          <RefreshCw className="h-5 w-5" aria-hidden />
          Search again
        </button>
      </div>
    </section>
  );
}

export default function FlightResults({
  input,
  airportCities,
}: {
  input: FlightSearchInput;
  airportCities: Record<string, string>;
}) {
  const router = useRouter();
  const { isLoaded, isSignedIn, user } = useUser();
  const mobileFiltersId = useId();
  const [result, setResult] = useState<FlightSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [searchStage, setSearchStage] = useState<SearchProgressStage>('accepted');
  const [sort, setSort] = useState<ResultsSortKey>('none');
  const [filters, setFilters] = useState<FlightFilterState | null>(null);
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [bookingAssignee, setBookingAssignee] = useState<BookingAssignee | null>(null);
  const canSendItinerary = Boolean(
    isLoaded &&
      isSignedIn &&
      user &&
      resolveRole(user.publicMetadata?.role) !== 'customer'
  );
  const showAuditFares = Boolean(
    isLoaded &&
      isSignedIn &&
      user &&
      resolveRole(user.publicMetadata?.role) === 'superadmin'
  );
  const role = resolveRole(user?.publicMetadata?.role);
  const isStaffBookingRole =
    role === 'superadmin' || role === 'admin' || role === 'staff_support';
  const showAgencyFares = Boolean(
    isLoaded &&
      isSignedIn &&
      user &&
      (role === 'b2b' || role === 'b2b_sub')
  );

  // The search is described entirely by the URL, so its serialised form both
  // identifies the request (as the effect's dependency, since `input` is a new
  // object on every render) and *is* the request body.
  const inputKey = JSON.stringify(input);
  // Guards against a late response from a superseded search overwriting a newer
  // one — the visitor can change the URL while a slow search is still running.
  const requestRef = useRef(0);
  // React development Strict Mode replays effects once. Keep one active request
  // per identical URL search so that replay cannot create a second live
  // supplier call. A changed URL gets its own key, and this is cleared once the
  // current attempt settles so the visible "Search again" action still works.
  const activeSearchKeyRef = useRef<string | null>(null);

  const run = useCallback(async () => {
    if (activeSearchKeyRef.current === inputKey) return;
    activeSearchKeyRef.current = inputKey;

    const requestId = requestRef.current + 1;
    requestRef.current = requestId;

    setLoading(true);
    setError(null);
    setResult(null);
    setFilters(null);
    setMobileFiltersOpen(false);
    setSearchStage('accepted');

    try {
      const response = await fetch('/api/flights/search', {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: inputKey,
      });

      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        let reachedTerminalEvent = false;
        await readSearchStream(response, ({ event, data }) => {
          if (requestRef.current !== requestId) return;

          if (event === 'progress') {
            const stage = (data as { stage?: unknown } | null)?.stage;
            if (isSearchProgressStage(stage)) setSearchStage(stage);
            return;
          }

          if (event === 'result') {
            const result = (data as { data?: FlightSearchResult } | null)?.data;
            if (!result) return;
            reachedTerminalEvent = true;
            setResult(result);
            setFilters(defaultFilters(filterOptions(result)));
            return;
          }

          if (event === 'error') {
            const message = (data as { errorMessage?: unknown } | null)?.errorMessage;
            reachedTerminalEvent = true;
            setError(
              typeof message === 'string'
                ? message
                : 'Flight search is temporarily unavailable. Please try again.'
            );
          }
        });

        if (requestRef.current === requestId && !reachedTerminalEvent) {
          setError('The search connection ended before results were ready. Please try again.');
        }
      } else {
        // Retain the original JSON path for a proxy/runtime that cannot pass a
        // streaming response through. It still returns a correct result, only
        // without live server milestones.
        const envelope = (await response.json()) as Envelope;
        if (requestRef.current !== requestId) return;

        if (envelope.success) {
          setResult(envelope.data);
          setFilters(defaultFilters(filterOptions(envelope.data)));
        } else {
          setError(envelope.error.errorMessage);
        }
      }
    } catch {
      if (requestRef.current !== requestId) return;
      setError('We could not reach the search service. Please try again.');
    } finally {
      if (activeSearchKeyRef.current === inputKey) {
        activeSearchKeyRef.current = null;
      }
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [inputKey]);

  useEffect(() => {
    void run();
  }, [run]);

  const activeDate = input.routes[0]?.departureDate ?? '';

  const changeSearchDate = (nextDate: string) => {
    if (!activeDate) return;

    const current = parseISO(activeDate);
    const next = parseISO(nextDate);
    if (!isValid(current) || !isValid(next)) return;

    const dayShift = differenceInCalendarDays(next, current);
    const routes = input.routes.map((route, index) => {
      if (index === 0) return { ...route, departureDate: nextDate };

      const routeDate = parseISO(route.departureDate);
      return {
        ...route,
        departureDate: isValid(routeDate)
          ? format(addDays(routeDate, dayShift), 'yyyy-MM-dd')
          : route.departureDate,
      };
    });

    router.push(`/flights?${encodeSearchParams({ ...input, routes })}`);
  };

  const shiftSearchDate = (days: number) => {
    const current = parseISO(activeDate);
    if (!isValid(current)) return;
    changeSearchDate(format(addDays(current, days), 'yyyy-MM-dd'));
  };

  if (loading) return <LoadingState stage={searchStage} input={input} />;

  if (error) {
    return (
      <UnavailableResultsState
        input={input}
        title="Flight search unavailable"
        description={error}
        onPreviousDay={() => shiftSearchDate(-1)}
        onNextDay={() => shiftSearchDate(1)}
        onSearchAgain={() => void run()}
      />
    );
  }

  if (!result || result.itineraries.length === 0) {
    return (
      <UnavailableResultsState
        input={input}
        title="No flights available"
        description="No results found"
        onPreviousDay={() => shiftSearchDate(-1)}
        onNextDay={() => shiftSearchDate(1)}
        onSearchAgain={() => void run()}
      />
    );
  }

  const options = filterOptions(result);
  const activeFilters = filters ?? defaultFilters(options);
  const resetFilters = () => setFilters(defaultFilters(options));

  // Match the airline tabs to the card's primary price. Agency LCC fares use
  // payable when their service margin puts payable above gross; advertising
  // the lower gross in that case would show an amount the agency cannot pay.
  const airlineMap = new Map<string, AirlineFilter>();
  for (const itinerary of result.itineraries) {
    if (!itinerary.carrierCode) continue;
    const displayPrice = resultDisplayPrice(
      itinerary,
      showAuditFares,
      showAgencyFares
    );
    const current = airlineMap.get(itinerary.carrierCode);
    if (current) {
      current.totalFlights += 1;
      current.minPrice = Math.min(current.minPrice, displayPrice);
    } else {
      airlineMap.set(itinerary.carrierCode, {
        airlineCode: itinerary.carrierCode,
        airlineName: itinerary.carrierName || itinerary.carrierCode,
        totalFlights: 1,
        minPrice: displayPrice,
      });
    }
  }
  const displayAirlines = Array.from(airlineMap.values());

  const visible = result.itineraries
    .filter(
      (itinerary) =>
        (activeFilters.stops.length === 0 ||
          activeFilters.stops.includes(stopKey(itinerary))) &&
        (!activeFilters.refundableOnly || itinerary.refundable) &&
        itinerary.totalPrice >= activeFilters.price.min &&
        itinerary.totalPrice <= activeFilters.price.max &&
        journeyMinutes(itinerary) >= activeFilters.duration.min &&
        journeyMinutes(itinerary) <= activeFilters.duration.max &&
        (activeFilters.departureBands.length === 0 ||
          activeFilters.departureBands.includes(departureBand(itinerary))) &&
        (activeFilters.airlines.length === 0 ||
          activeFilters.airlines.includes(itinerary.carrierCode))
    )
    .slice()
    .sort((a, b) => {
      if (sort === 'price-low-high') return a.totalPrice - b.totalPrice;
      if (sort === 'price-high-low') return b.totalPrice - a.totalPrice;
      if (sort === 'dep-early-late') {
        return (a.legs[0]?.departure ?? '').localeCompare(b.legs[0]?.departure ?? '');
      }
      if (sort === 'dep-late-early') {
        return (b.legs[0]?.departure ?? '').localeCompare(a.legs[0]?.departure ?? '');
      }
      if (sort === 'layover-short-long') {
        return layoverMinutes(a) - layoverMinutes(b);
      }
      if (sort === 'layover-long-short') {
        return layoverMinutes(b) - layoverMinutes(a);
      }
      return 0;
    });

  return (
    <div className="space-y-4">
      {result.limitedByQuoteSize && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
          This large search shows the lowest-priced available flight choices. Some additional fares were hidden; narrow your search to see more.
        </p>
      )}
      {isLoaded && isSignedIn && isStaffBookingRole && (
        <StaffBookingAssigneePicker
          selected={bookingAssignee}
          onSelect={setBookingAssignee}
        />
      )}
      <div className="grid gap-3 lg:grid-cols-[270px_minmax(0,1fr)] lg:items-start lg:gap-5">
        <FlightFilters
          value={activeFilters}
          options={options}
          airlines={displayAirlines}
          currency={result.currency}
          resultCount={visible.length}
          onChange={setFilters}
          onClear={resetFilters}
          mobileOpen={mobileFiltersOpen}
          onMobileOpenChange={setMobileFiltersOpen}
          showMobileTrigger={false}
          contentId={mobileFiltersId}
        />

        <div className="min-w-0 space-y-3 sm:space-y-4">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-x-3">
            <div className="order-1 sm:col-span-2">
              <AirlineFilterBar
                airlines={displayAirlines}
                selectedAirlines={activeFilters.airlines}
                currency={result.currency}
                onChange={(airlines) => setFilters({ ...activeFilters, airlines })}
              />
            </div>

            <div className="order-3 sm:order-2 sm:col-span-2">
              <ResultsSortBar value={sort} onChange={setSort} />
            </div>

            <div className="order-4 flex min-w-0 items-center justify-between gap-2 sm:order-3">
              <p className="min-w-0 truncate text-sm text-neutral-600">
                <span className="font-semibold text-navy-950">{visible.length}</span>{' '}
                {visible.length === 1 ? 'flight' : 'flights'}
                {/* Taken from what is on screen, not the supplier's overall minimum:
                    with filters applied those differ, and quoting a "from" price
                    no visible card can match reads as a bait price. */}
                {visible.length > 0 && (
                  <>
                    {' '}
                    · from{' '}
                    {formatPrice(
                      visible.reduce((min, i) => Math.min(min, i.totalPrice), Infinity),
                      result.currency
                    )}
                  </>
                )}
              </p>

              <button
                type="button"
                aria-expanded={mobileFiltersOpen}
                aria-controls={mobileFiltersId}
                onClick={() => setMobileFiltersOpen((open) => !open)}
                className="flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-neutral-200 bg-white px-3 text-xs font-bold text-navy-950 shadow-sm transition hover:border-brand-orange/40 hover:bg-brand-orange-light hover:text-brand-orange-dark focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange lg:hidden"
              >
                <Filter className="h-4 w-4 text-brand-orange" aria-hidden />
                Filter
              </button>
            </div>

            <div className="order-2 sm:order-4">
              <ResultsDateNavigator value={activeDate} onChange={changeSearchDate} />
            </div>
          </div>

          {visible.length === 0 ? (
            <div className="rounded-lg bg-white p-10 text-center shadow-sm ring-1 ring-neutral-200">
              <Filter className="mx-auto h-8 w-8 text-neutral-400" />
              <p className="mt-4 text-base font-semibold text-navy-950">
                No flights match these filters
              </p>
              <p className="mt-1 text-sm text-neutral-500">
                Clear the filters to see every available itinerary.
              </p>
              <button
                type="button"
                onClick={resetFilters}
                className="mt-5 rounded-md bg-brand-orange px-5 py-2.5 text-sm font-semibold text-navy-950 transition hover:bg-brand-orange-dark hover:text-white"
              >
                Clear all filters
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {visible.map((itinerary) => (
                <ItineraryCard
                  key={itinerary.id}
                  itinerary={itinerary}
                  currency={result.currency}
                  searchId={result.searchId}
                  bookingAvailable={result.bookingAvailable !== false}
                  showSendItinerary={canSendItinerary}
                  airportCities={airportCities}
                  showAuditFares={showAuditFares}
                  showAgencyFares={showAgencyFares}
                  requiresBookingAssignee={isStaffBookingRole}
                  bookingAssigneeId={bookingAssignee?.id ?? null}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
