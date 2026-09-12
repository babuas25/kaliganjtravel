'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  Check,
  ArrowLeftRight,
  // Hotel, // Restore with the future product tabs below.
  Search,
  Plane,
  // TreePalm,
  X,
} from 'lucide-react';

import AirportSelection, { type AirportOption } from '@/components/layout/AirportSelection';
import FlightDatePicker, {
  addDays,
  getTodayDate,
  getTomorrowDate,
} from '@/components/layout/FlightDatePicker';
import MulticitySegments, {
  AddCityButton,
  MAX_SEGMENTS,
  MIN_SEGMENTS,
  type FlightSegment,
} from '@/components/layout/MulticitySegments';
import TravelerSelection, {
  DEFAULT_TRAVELERS,
  type TravelerData,
} from '@/components/layout/TravelerSelection';
import { POPULAR_BANGLADESH_AIRPORTS } from '@/lib/airports/popular';
import PreferredAirlines from '@/components/layout/PreferredAirlines';
import { CABIN_CLASSES, cabinClassValue } from '@/lib/flights/cabin';
import { encodeSearchParams } from '@/lib/flights/search-params';
import type { FlightSearchInput, SearchRoute, TripType } from '@/lib/flights/types';

type FareType = 'regular' | 'student';

/** Turn an entry of the popular shortlist into a pre-filled From / To value. */
function popularAirport(iata: string): AirportOption | null {
  const airport = POPULAR_BANGLADESH_AIRPORTS.find((a) => a.iata === iata);
  return airport ? { id: `default-${airport.iata}`, ...airport } : null;
}

/** Default route shown when the search panel first loads. */
const DEFAULT_FROM = popularAirport('DAC');
const DEFAULT_TO: AirportOption = {
  id: 'default-SIN',
  iata: 'SIN',
  name: 'Singapore Changi International Airport',
  city: 'Singapore',
  country: 'Singapore',
};

let segmentCounter = 0;
function nextSegmentId() {
  segmentCounter += 1;
  return `segment-${segmentCounter}`;
}

/** Push any leg that would depart before the one before it to the next day. */
function chainDates(segments: FlightSegment[]): FlightSegment[] {
  const next = [...segments];
  for (let i = 1; i < next.length; i++) {
    const previous = next[i - 1]?.departureDate;
    const current = next[i];
    if (!previous || !current?.departureDate) continue;
    if (current.departureDate < previous) {
      next[i] = { ...current, departureDate: addDays(previous, 1) };
    }
  }
  return next;
}

/**
 * Multi City opens on the route already in the panel, plus an onward leg
 * continuing from it the next day — a single leg would just be a one-way.
 */
function buildInitialSegments(
  from: AirportOption | null,
  to: AirportOption | null,
  departureDate: string
): FlightSegment[] {
  const firstDate = departureDate || getTomorrowDate();
  return [
    { id: nextSegmentId(), from, to, departureDate: firstDate },
    { id: nextSegmentId(), from: to, to: null, departureDate: addDays(firstDate, 1) },
  ];
}

/* Future products: restore these definitions and icon imports with the tabs below.
const comingSoonTabs = [
  { label: 'Hotel', icon: Hotel },
  { label: 'Holidays', icon: TreePalm },
];
*/

const tripOptions: { id: TripType; label: string }[] = [
  { id: 'oneway', label: 'One Way' },
  { id: 'round', label: 'Round Trip' },
  { id: 'multicity', label: 'Multi City' },
];

type FlightSearchPanelProps = {
  initialInput?: FlightSearchInput;
  initialAirports?: Record<string, AirportOption>;
  variant?: 'hero' | 'modify';
  onSubmitted?: () => void;
};

function initialAirport(
  code: string | undefined,
  options: Record<string, AirportOption>
): AirportOption | null {
  if (!code) return null;
  return (
    options[code] ?? {
      id: `initial-${code}`,
      iata: code,
      city: code,
      name: 'Airport',
      country: '',
    }
  );
}

function initialTravelers(input?: FlightSearchInput): TravelerData {
  if (!input) return DEFAULT_TRAVELERS;
  return {
    adults: input.adults,
    children: input.children,
    infants: input.infants,
    childrenAges: [...input.childrenAges],
    bookingClass:
      CABIN_CLASSES.find((cabin) => cabin.value === input.cabinClass)?.label ??
      DEFAULT_TRAVELERS.bookingClass,
  };
}

function initialSegments(
  input: FlightSearchInput | undefined,
  options: Record<string, AirportOption>
): FlightSegment[] {
  if (!input || input.tripType !== 'multicity') return [];
  return input.routes.map((route) => ({
    id: nextSegmentId(),
    from: initialAirport(route.origin, options),
    to: initialAirport(route.destination, options),
    departureDate: route.departureDate,
  }));
}

function Radio({
  active,
  label,
  onClick,
  compact = false,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex min-h-10 items-center justify-center gap-1 rounded-xl px-2 py-2 text-xs font-medium transition sm:gap-2 sm:px-3 sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange focus-visible:ring-offset-2 ${compact ? 'text-xs' : ''} ${active ? 'bg-brand-orange text-black shadow-sm' : 'text-neutral-600 hover:bg-white hover:text-navy-950'}`}
    >
      {active && <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />}
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}

export default function FlightSearchPanel({
  initialInput,
  initialAirports = {},
  variant = 'hero',
  onSubmitted,
}: FlightSearchPanelProps = {}) {
  const router = useRouter();
  const initialFirstRoute = initialInput?.routes[0];
  // One Way is the landing state; existing searches retain their selected trip type.
  const [tripType, setTripType] = useState<TripType>(initialInput?.tripType ?? 'oneway');
  const [fareType, setFareType] = useState<FareType>('regular');
  // Lifted out of PreferredAirlines so both layout branches share one list and
  // the search request can read it.
  const [preferredAirlines, setPreferredAirlines] = useState<string[]>(
    initialInput ? [...initialInput.preferredCarriers] : []
  );
  /** Shown under the panel when a required field is missing. */
  const [error, setError] = useState<string | null>(null);
  // Held here rather than in the fields: the desktop and mobile layouts each
  // render their own pair, and both have to show the same route.
  const [from, setFrom] = useState<AirportOption | null>(
    initialInput
      ? initialAirport(initialFirstRoute?.origin, initialAirports)
      : DEFAULT_FROM
  );
  const [to, setTo] = useState<AirportOption | null>(
    initialInput ? initialAirport(initialFirstRoute?.destination, initialAirports) : DEFAULT_TO
  );
  // ISO `YYYY-MM-DD`, or '' for "not picked". Seeded after mount rather than in
  // the initial state: "tomorrow" on the server can be a different day here.
  const [departureDate, setDepartureDate] = useState(initialFirstRoute?.departureDate ?? '');
  const [returnDate, setReturnDate] = useState(
    initialInput?.tripType === 'round' ? (initialInput.routes[1]?.departureDate ?? '') : ''
  );
  const [travelers, setTravelers] = useState<TravelerData>(() =>
    initialTravelers(initialInput)
  );
  // Multi City only. Seeded when that tab is first opened, then kept, so
  // flipping to Round Trip and back does not throw away the legs.
  const [segments, setSegments] = useState<FlightSegment[]>(() =>
    initialSegments(initialInput, initialAirports)
  );

  // An earlier validation message no longer describes a revised search.
  useEffect(() => {
    setError(null);
  }, [tripType, from, to, departureDate, returnDate, travelers, segments]);

  useEffect(() => {
    setDepartureDate((prev) => prev || getTomorrowDate());
  }, []);

  const isReturnDisabled = tripType !== 'round';
  const isMulticity = tripType === 'multicity';

  // A return date only means something on a round trip.
  useEffect(() => {
    if (isReturnDisabled) setReturnDate('');
  }, [isReturnDisabled]);

  const swapLocations = () => {
    setFrom(to);
    setTo(from);
  };

  const handleDepartureDateChange = (nextDate: string) => {
    setDepartureDate(nextDate);
    // Drop a return that would now fall before departure. Same-day stays.
    if (returnDate && nextDate && returnDate < nextDate) {
      setReturnDate('');
    }
  };

  /**
   * Switching tabs carries the route across rather than resetting it, in both
   * directions: entering Multi City pulls the panel's route into trip 1, and
   * leaving it pushes trip 1 back out. The later legs are kept either way.
   */
  const changeTripType = (next: TripType) => {
    if (next === 'multicity') {
      setSegments((prev) => {
        if (prev.length === 0) return buildInitialSegments(from, to, departureDate);
        const first = prev[0];
        if (!first) return prev;
        return chainDates([
          { ...first, from, to, departureDate: departureDate || first.departureDate },
          ...prev.slice(1),
        ]);
      });
    } else if (isMulticity) {
      const first = segments[0];
      if (first) {
        setFrom(first.from);
        setTo(first.to);
        if (first.departureDate) setDepartureDate(first.departureDate);
      }
    }
    setTripType(next);
  };

  const activateRoundTrip = () => {
    if (tripType !== 'round') changeTripType('round');
  };

  // The × on Return means "no return flight", not just "clear the date": it
  // drops the trip to one way, and the effect above clears the date.
  const dropReturnFlight = () => changeTripType('oneway');

  const updateSegment = (id: string, patch: Partial<FlightSegment>) => {
    setSegments((prev) => {
      const next = prev.map((segment) => (segment.id === id ? { ...segment, ...patch } : segment));
      // Moving a date forward pushes every later leg that would now be in the past.
      return patch.departureDate === undefined ? next : chainDates(next);
    });
  };

  const swapSegment = (id: string) => {
    setSegments((prev) =>
      prev.map((segment) =>
        segment.id === id ? { ...segment, from: segment.to, to: segment.from } : segment
      )
    );
  };

  const addSegment = () => {
    setSegments((prev) => {
      if (prev.length >= MAX_SEGMENTS) return prev;
      const last = prev[prev.length - 1];
      // The next leg starts where the last one landed, a day later.
      return [
        ...prev,
        {
          id: nextSegmentId(),
          from: last?.to ?? null,
          to: null,
          departureDate: last?.departureDate ? addDays(last.departureDate, 1) : getTomorrowDate(),
        },
      ];
    });
  };

  const removeSegment = (id: string) => {
    setSegments((prev) => (prev.length <= MIN_SEGMENTS ? prev : prev.filter((s) => s.id !== id)));
  };

  /**
   * Collects the panel into the legs the API asks for. Round Trip becomes two
   * routes and Multi City one per leg — there is no separate journey-type field
   * on the supplier's request, the route list *is* the journey.
   *
   * Returns a message instead of routes when something required is missing, so
   * the caller can show it rather than sending a half-empty search.
   */
  const collectRoutes = (): { routes: SearchRoute[] } | { message: string } => {
    if (isMulticity) {
      // Indexed rather than `for...of segments.entries()`: the project compiles
      // to ES5, where iterating an iterator directly is not available.
      const routes: SearchRoute[] = [];
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        if (!segment.from || !segment.to || !segment.departureDate) {
          return { message: `Complete trip ${index + 1} before searching.` };
        }
        if (segment.from.iata === segment.to.iata) {
          return { message: `Trip ${index + 1} departs and arrives at the same airport.` };
        }
        routes.push({
          origin: segment.from.iata,
          destination: segment.to.iata,
          departureDate: segment.departureDate,
        });
      }
      return routes.length >= 2
        ? { routes }
        : { message: 'A multi-city trip needs at least two legs.' };
    }

    if (!from || !to) return { message: 'Choose where you are flying from and to.' };
    if (from.iata === to.iata) {
      return { message: 'Origin and destination cannot be the same airport.' };
    }
    if (!departureDate) return { message: 'Choose a departure date.' };

    const outbound: SearchRoute = {
      origin: from.iata,
      destination: to.iata,
      departureDate,
    };

    if (tripType !== 'round') return { routes: [outbound] };

    if (!returnDate) return { message: 'Choose a return date, or switch to One Way.' };
    return {
      routes: [
        outbound,
        { origin: to.iata, destination: from.iata, departureDate: returnDate },
      ],
    };
  };

  /**
   * Hands the search to the results page as a URL rather than fetching here:
   * the panel is rendered on the home page and in the dashboard, and a
   * shareable, refreshable `/flights?…` keeps both behaving the same.
   *
   * Note that `fareType` is collected but not sent. Student Fare has no
   * documented value in the supplier's API, so sending a guess would quietly
   * search a different fare — it stays inert until they publish the enum.
   */
  const submit = () => {
    const collected = collectRoutes();
    if ('message' in collected) {
      setError(collected.message);
      return;
    }

    const childrenAges = travelers.childrenAges.slice(0, travelers.children);
    if (childrenAges.length !== travelers.children || childrenAges.some((age) => !age)) {
      setError('Add an age for every child.');
      return;
    }

    setError(null);

    const input: FlightSearchInput = {
      tripType,
      routes: collected.routes,
      adults: travelers.adults,
      children: travelers.children,
      infants: travelers.infants,
      childrenAges,
      cabinClass: cabinClassValue(travelers.bookingClass),
      preferredCarriers: preferredAirlines,
    };

    onSubmitted?.();
    router.push(`/flights?${encodeSearchParams(input)}`);
  };

  const isModifyVariant = variant === 'modify';

  return (
    <section aria-label="Flight search" className={isModifyVariant ? 'relative w-full' : 'relative mx-auto w-full max-w-[1180px]'}>
      <div className={isModifyVariant ? '' : 'rounded-3xl border border-white/70 bg-white text-navy-950 shadow-[0_20px_70px_-20px_rgba(4,37,81,0.35)]'}>
        <div className={isModifyVariant ? 'space-y-3' : 'space-y-3 p-3 sm:p-4'}>
          <div className="flex flex-wrap items-center gap-3">
            {!isModifyVariant && (
              <div className="hidden items-center gap-2 pr-2 text-sm font-bold text-navy-950 sm:flex" aria-label="Travel products">
                <Plane className="h-4 w-4 text-brand-orange" aria-hidden /> Flights
              {/* Future products: uncomment when ready to restore Hotel and Holidays.
              {comingSoonTabs.map(({ label, icon: Icon }) => (
                <button key={label} type="button" disabled title="Coming soon" className="inline-flex cursor-not-allowed items-center gap-2 px-3 py-3 text-xs font-medium text-neutral-400 sm:text-sm">
                  <Icon className="hidden h-4 w-4 sm:block" aria-hidden /> {label}
                </button>
              ))}
              */}

              </div>
            )}
            <div role="group" aria-label="Trip type" className="inline-flex max-w-full items-center gap-1 rounded-2xl bg-neutral-100 p-1">
              {tripOptions.map(({ id, label }) => (
                <Radio key={id} active={tripType === id} label={label} onClick={() => changeTripType(id)} />
              ))}
            </div>
            <p className="ml-auto hidden text-xs text-neutral-500 lg:block">{isMulticity ? 'Build your trip, one stop at a time' : 'Choose your route and travel dates'}</p>
          </div>

          {isMulticity ? (
            <div className="space-y-3">
              <div className="hidden md:block">
                <MulticitySegments segments={segments} layout="row" idPrefix="mc" onChange={updateSegment} onSwap={swapSegment} onRemove={removeSegment}
                  firstRowAction={<div className="flex min-w-0 flex-1 rounded-2xl border border-neutral-200 bg-navy-50/50"><TravelerSelection value={travelers} onChange={setTravelers} className="flex-1 px-4 py-3" /></div>}
                  lastRowAction={<AddCityButton count={segments.length} onClick={addSegment} />} />
              </div>
              <div className="space-y-3 md:hidden">
                <MulticitySegments segments={segments} layout="stacked" idPrefix="mc-mobile" onChange={updateSegment} onSwap={swapSegment} onRemove={removeSegment} />
                <AddCityButton count={segments.length} onClick={addSegment} className="w-full" />
                <div className="flex rounded-2xl border border-neutral-200 bg-navy-50/50"><TravelerSelection value={travelers} onChange={setTravelers} className="flex-1 px-4 py-3" /></div>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-12">
              <div className="relative grid grid-cols-2 gap-3 md:col-span-2 xl:col-span-5">
                <AirportSelection label="From" inputId="flight-from" inputName="from" value={from} onChange={setFrom} placeholder="City or airport"
                  className="min-w-0 rounded-2xl border border-neutral-200 bg-navy-50/50 py-3 pl-4 pr-6 transition hover:border-navy-200 focus-within:border-brand-orange focus-within:bg-white focus-within:ring-2 focus-within:ring-brand-orange/15" />
                <AirportSelection label="To" inputId="flight-to" inputName="to" value={to} onChange={setTo} placeholder="City or airport"
                  className="min-w-0 rounded-2xl border border-neutral-200 bg-navy-50/50 py-3 pl-6 pr-4 transition hover:border-navy-200 focus-within:border-brand-orange focus-within:bg-white focus-within:ring-2 focus-within:ring-brand-orange/15" />
                <button type="button" onClick={swapLocations} aria-label="Swap origin and destination"
                  className="absolute left-1/2 top-1/2 z-10 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-neutral-200 bg-white text-navy-700 shadow-sm transition hover:rotate-180 hover:border-brand-orange hover:text-brand-orange-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange">
                  <ArrowLeftRight className="h-4 w-4" aria-hidden />
                </button>
              </div>

              <div className="grid grid-cols-2 overflow-hidden rounded-2xl border border-neutral-200 bg-navy-50/50 transition focus-within:border-brand-orange xl:col-span-4">
                <FlightDatePicker label="Departure" value={departureDate} onChange={handleDepartureDateChange} minDate={getTodayDate()} className="border-r border-neutral-200 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-orange" />
                <div className="relative min-w-0">
                  <FlightDatePicker label="Return" value={returnDate} onChange={setReturnDate} muted={isReturnDisabled} onOpen={activateRoundTrip} minDate={departureDate || getTodayDate()} openToDate={departureDate} placeholder="Add return" className="h-full w-full py-3 pl-4 pr-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-orange" />
                  {!isReturnDisabled && (
                    <button type="button" onClick={dropReturnFlight} aria-label="Remove return flight and switch to one way" className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full text-neutral-500 transition hover:bg-neutral-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange"><X className="h-3.5 w-3.5" /></button>
                  )}
                </div>
              </div>

              <div className="flex min-w-0 rounded-2xl border border-neutral-200 bg-navy-50/50 transition hover:border-navy-200 focus-within:border-brand-orange xl:col-span-3">
                <TravelerSelection value={travelers} onChange={setTravelers} className="flex-1 px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-orange rounded-2xl" />
              </div>
            </div>
          )}

          <div className="flex flex-col gap-3 border-t border-neutral-100 pt-3 md:flex-row md:flex-wrap md:items-end">
            <div className="shrink-0">
              <p className="mb-2 text-xs font-medium text-neutral-500">Fare preference</p>
              <div role="group" aria-label="Fare preference" className="inline-flex gap-1 rounded-xl bg-neutral-100 p-1">
                <Radio compact active={fareType === 'regular'} label="Regular Fare" onClick={() => setFareType('regular')} />
                <Radio compact active={fareType === 'student'} label="Student Fare" onClick={() => setFareType('student')} />
              </div>
            </div>
            <PreferredAirlines className="min-w-0 md:w-72 lg:w-80" value={preferredAirlines} onChange={setPreferredAirlines} />
            <button type="button" onClick={submit} className="group inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-3 rounded-xl bg-brand-orange px-6 py-3 text-sm font-bold text-navy-950 shadow-sm transition hover:bg-brand-orange-dark hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange focus-visible:ring-offset-2 md:ml-auto md:w-auto">
              <Search className="h-5 w-5" aria-hidden /> Search Flights <ArrowRight className="h-4 w-4 transition group-hover:translate-x-1" aria-hidden />
            </button>
          </div>
          {error && <p role="alert" className="flex items-center gap-2 rounded-xl bg-red-50 p-3 text-sm font-medium text-red-700"><AlertCircle className="h-4 w-4 shrink-0" />{error}</p>}
        </div>
      </div>
    </section>
  );
}
