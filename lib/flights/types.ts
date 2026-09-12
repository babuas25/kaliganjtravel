/**
 * The contract between the browser and `/api/flights/search`.
 *
 * Deliberately *not* the supplier's shape. Triplover's response is large,
 * inconsistently populated and carries opaque booking references that must never
 * reach the browser — the mapper in `lib/triplover/search.ts` reduces it to what
 * a results card actually renders, and the references stay server-side in
 * `lib/flights/search-cache.ts`.
 *
 * Client-safe: types plus pure helpers, no server imports.
 */

import type { CabinClassValue } from '@/lib/flights/cabin';

export type TripType = 'oneway' | 'round' | 'multicity';

/** One requested leg, in travel order. */
export type SearchRoute = {
  /** Airport IATA, uppercase. */
  origin: string;
  destination: string;
  /** ISO `YYYY-MM-DD`. */
  departureDate: string;
};

/** What the panel posts. Mirrors the state described in projectmap.md. */
export type FlightSearchInput = {
  tripType: TripType;
  routes: SearchRoute[];
  adults: number;
  /** Aged 2 to under 12. */
  children: number;
  infants: number;
  /** One real age per child, each 2–11. Affects pricing, so it is required. */
  childrenAges: number[];
  cabinClass: CabinClassValue;
  /** IATA codes; empty means no preference. */
  preferredCarriers: string[];
};

/** One flight in an itinerary. */
export type ItinerarySegment = {
  from: string;
  fromAirport: string;
  to: string;
  toAirport: string;
  /** Airline-supplied departure terminal, when available. */
  departureTerminal?: string | null;
  /** Airline-supplied arrival terminal, when available. */
  arrivalTerminal?: string | null;
  /** Local wall-clock `YYYY-MM-DD HH:mm:ss`, exactly as the supplier sends it. */
  departure: string;
  arrival: string;
  airline: string;
  airlineCode: string;
  flightNumber: string;
  cabinClass: string;
  bookingClass: string;
  /** Free-text, e.g. "1h 5m". */
  duration: string | null;
  aircraft: string | null;
  /** Checked allowance for the lead passenger type, e.g. "20 Kg". */
  baggage: string | null;
  handBaggage: string | null;
  /** Seats left in this RBD, when the supplier reports it. */
  seatsLeft: number | null;
};

/** One requested route's worth of flights within an itinerary. */
export type ItineraryLeg = {
  from: string;
  to: string;
  /** Layover count as the supplier reports it. */
  stops: number;
  segments: ItinerarySegment[];
  /** Supplier-authored total travel time for this route, including layovers. */
  duration: string | null;
  departure: string;
  arrival: string;
};

export type FareBreakdown = {
  passengerType: 'ADT' | 'CHD' | 'CNN' | 'INF' | 'INS';
  count: number;
  basePrice: number;
  taxes: number;
  /** Advance Income Tax — a third money component, NOT inside `taxes`. */
  ait: number;
  /** Explicit LCC service margin. Zero for every gross-capped normal fare. */
  serviceMargin: number;
  totalPrice: number;
};

/**
 * One independently priced fare for a flight schedule. Every option keeps its
 * own id because it resolves to a different supplier booking reference.
 */
export type FlightFareOption = {
  /** Our id, not the supplier's. Resolves to the stored refs server-side. */
  id: string;
  /** Server-authorized supplier audit values; populated only for Super Admins. */
  auditPricing: {
    grossPrice: number;
    netFare: number;
  } | null;
  /** Server-authorized agency values; populated only for B2B audiences. */
  agencyPricing: {
    grossPrice: number;
    agentFare: number;
  } | null;
  totalPrice: number;
  basePrice: number;
  taxes: number;
  ait: number;
  /** Explicit LCC-only amount charged above gross. */
  serviceMargin: number;
  carrierCode: string;
  carrierName: string;
  refundable: boolean;
  /** False means the supplier issues tickets at Booking, with no hold step. */
  bookable: boolean;
  legs: ItineraryLeg[];
  fares: FareBreakdown[];
  /**
   * True when this card was split out of a supplier offer that listed several
   * alternative flights under one reference. See the note in
   * `lib/triplover/search.ts` — such an itinerary is safe to display but cannot
   * yet be carried into RePrice unambiguously.
   */
  ambiguousSelection: boolean;
};

/** A priced option before equal schedules are grouped for public display. */
export type StandaloneFlightItinerary = FlightFareOption;

/**
 * The public itinerary a selected fare carries into Prepare. The server binds
 * this exact object to a Redis-held digest before it becomes the durable
 * booking_attempts offer snapshot; it contains no supplier capabilities.
 */
export type FlightBookingItinerarySnapshot = Pick<
  FlightFareOption,
  'carrierCode' | 'carrierName' | 'refundable' | 'legs'
>;

export function bookingItinerarySnapshotFor(
  option: FlightFareOption
): FlightBookingItinerarySnapshot {
  return {
    carrierCode: option.carrierCode,
    carrierName: option.carrierName,
    refundable: option.refundable,
    legs: option.legs,
  };
}

/**
 * One visible flight card. The cheapest fare is the card itself; higher-priced
 * offers for the exact same flights are retained as selectable upsell options.
 */
export type FlightItinerary = StandaloneFlightItinerary & {
  upsellOptions: FlightFareOption[];
};

export type AirlineFilter = {
  airlineCode: string;
  airlineName: string;
  totalFlights: number;
  minPrice: number;
};

export type FlightSearchResult = {
  /** Key for the server-side reference store; required by every later step. */
  searchId: string;
  /** Fixed BDT — the supplier returns `currency: null` on Search. */
  currency: string;
  itineraries: FlightItinerary[];
  airlines: AirlineFilter[];
  minPrice: number | null;
  maxPrice: number | null;
  /** True when at least one of the supplier's own sources failed. */
  partial: boolean;
  /** Offers we refused to render because their shape was unmappable. */
  droppedOfferCount: number;
};

/** Public, repriced selling fare. Supplier references remain server-side. */
export type FlightRepriceResult = {
  itineraryId: string;
  currency: string;
  previousTotalPrice: number;
  totalPrice: number;
  priceDifference: number;
  basePrice: number;
  taxes: number;
  ait: number;
  serviceMargin: number;
  fares: FareBreakdown[];
  bookable: boolean;
  /**
   * Cabin and booking class the airline actually quoted, e.g. `"Economy C"`.
   * Null when the supplier omits its directions from the RePrice response.
   * Only used to tell the customer which fare replaced the one they picked.
   */
  fareClass: string | null;
  supplierPriceChanged: boolean;
  sellingPriceChanged: boolean;
  requiresConfirmation: boolean;
  repricedAt: string;
};

/** One supplier-authored section from Triplover FareRules. */
export type FareRuleSection = {
  type: string;
  /** Multi-line GDS narrative. Render with whitespace preserved. */
  detail: string;
};

/** Public FareRules result. Supplier reference tokens never leave the server. */
export type FlightFareRulesResult = {
  itineraryId: string;
  rules: FareRuleSection[];
};

const MINUTES_PER_HOUR = 60;

/** `"2026-09-04 07:30:00"` → `"07:30"`. Returns '' for anything unparseable. */
export function timeOf(stamp: string): string {
  const match = /\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/.exec(stamp);
  return match ? `${match[1]}:${match[2]}` : '';
}

/** `"2026-09-04 07:30:00"` → `"2026-09-04"`. */
export function dateOf(stamp: string): string {
  return /^\d{4}-\d{2}-\d{2}/.exec(stamp)?.[0] ?? '';
}

/**
 * Minutes between two supplier stamps, or null when either is unparseable.
 *
 * Parsed as *local wall clock* — the supplier sends no zone, and inventing one
 * would misreport every duration that crosses a timezone.
 */
export function minutesBetween(from: string, to: string): number | null {
  const a = parseWallClock(from);
  const b = parseWallClock(to);
  if (a === null || b === null) return null;
  return Math.round((b - a) / 60_000);
}

/** Parses supplier duration text such as `"4h 15m"` into minutes. */
export function durationMinutes(value: string | null | undefined): number | null {
  const text = value?.trim().toLowerCase();
  if (!text) return null;

  const clock = /^(\d+):(\d{2})$/.exec(text);
  if (clock) return Number(clock[1]) * MINUTES_PER_HOUR + Number(clock[2]);

  const hours = /(\d+)\s*h/.exec(text);
  const minutes = /(\d+)\s*m/.exec(text);
  if (!hours && !minutes) return null;

  return (
    Number(hours?.[1] ?? 0) * MINUTES_PER_HOUR +
    Number(minutes?.[1] ?? 0)
  );
}

/**
 * Total minutes for one requested route.
 *
 * Triplover's duration is authoritative because its departure and arrival
 * timestamps are local to different airports. Subtracting those wall clocks
 * would add or remove the timezone difference. Older/missing supplier values
 * fall back to segment durations plus same-airport layovers, then wall clocks.
 */
export function legDurationMinutes(leg: ItineraryLeg): number | null {
  const supplied = durationMinutes(leg.duration);
  if (supplied !== null) return supplied;

  if (leg.segments.length > 0) {
    let total = 0;
    let complete = true;

    for (let index = 0; index < leg.segments.length; index += 1) {
      const segment = leg.segments[index];
      const flight = durationMinutes(segment.duration);
      if (flight === null) {
        complete = false;
        break;
      }
      total += flight;

      const nextSegment = leg.segments[index + 1];
      if (nextSegment) {
        const layover = minutesBetween(segment.arrival, nextSegment.departure);
        if (layover === null || layover < 0) {
          complete = false;
          break;
        }
        total += layover;
      }
    }

    if (complete) return total;
  }

  const wallClock = minutesBetween(leg.departure, leg.arrival);
  return wallClock !== null && wallClock >= 0 ? wallClock : null;
}

/** Total waiting time between the connected segments of one route. */
export function legLayoverMinutes(leg: ItineraryLeg): number | null {
  if (leg.segments.length < 2) return null;

  let timestampTotal = 0;
  let timestampsComplete = true;

  for (let index = 0; index < leg.segments.length - 1; index += 1) {
    const current = leg.segments[index];
    const next = leg.segments[index + 1];
    const layover = minutesBetween(current.arrival, next.departure);

    if (layover === null || layover < 0) {
      timestampsComplete = false;
      break;
    }
    timestampTotal += layover;
  }

  if (timestampsComplete) return timestampTotal;

  const totalDuration = legDurationMinutes(leg);
  const flightDurations = leg.segments.map((segment) =>
    durationMinutes(segment.duration)
  );
  if (
    totalDuration !== null &&
    flightDurations.every((minutes): minutes is number => minutes !== null)
  ) {
    const totalFlightTime = flightDurations.reduce(
      (total, minutes) => total + minutes,
      0
    );
    return Math.max(0, totalDuration - totalFlightTime);
  }

  return null;
}

function parseWallClock(stamp: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(stamp);
  if (!m) return null;
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? '0')
  );
}

/**
 * What to call one route of an itinerary: `Outbound` / `Return` for a round
 * trip, `Trip 1` … `Trip 3` for a multi-city one.
 *
 * Decided from the shape of the legs rather than the trip type the search was
 * submitted with, because a priced itinerary does not carry that type — it is
 * a list of routes by the time it reaches a card. Two legs that end where the
 * first began is a round trip; anything else is numbered.
 *
 * A two-leg multi-city search that happens to fly home therefore reads as
 * Outbound/Return. That is the same journey either way, so the label is not
 * wrong — and it is the only case the shape cannot tell apart.
 */
export function legLabel(legs: ItineraryLeg[], index: number): string {
  const isRoundTrip =
    legs.length === 2 &&
    !!legs[0] &&
    !!legs[1] &&
    legs[1].to.toUpperCase() === legs[0].from.toUpperCase();

  if (isRoundTrip) return index === 0 ? 'Outbound' : 'Return';
  return `Trip ${index + 1}`;
}

/**
 * How many columns a card lays an itinerary's routes out in from `xl` up.
 *
 * Two only when they divide evenly into two — a round trip, or a four- or
 * six-leg multi-city. Three legs in two columns leaves a half-width orphan on
 * the second row, so those stack full width instead. A search can hold up to
 * six legs (`MAX_SEGMENTS`), so this answers for 1 through 6.
 */
export function legColumns(legCount: number): 1 | 2 {
  return legCount >= 2 && legCount % 2 === 0 ? 2 : 1;
}

/** `95` → `"1h 35m"`. */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / MINUTES_PER_HOUR);
  const m = minutes % MINUTES_PER_HOUR;
  if (h <= 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * `"Economy G"` — the cabin and its booking class, deduplicated across every
 * segment. One helper so a card, an upsell row and a repriced fare all name the
 * same thing the same way; the customer is asked to compare these labels when
 * the airline swaps one fare for another.
 */
export function fareClassLabel(
  segments: readonly Pick<ItinerarySegment, 'cabinClass' | 'bookingClass'>[]
): string {
  return Array.from(
    new Set(
      segments
        .map((segment) => {
          const cabinClass = segment.cabinClass?.trim() ?? '';
          const bookingClass = segment.bookingClass?.trim() ?? '';
          if (cabinClass) {
            return [cabinClass, bookingClass].filter(Boolean).join(' ');
          }
          return bookingClass ? `Booking Class ${bookingClass}` : '';
        })
        .filter(Boolean)
    )
  ).join(', ');
}

/** BDT formatting that preserves supplier/markup poisha when present. */
export function formatPrice(amount: number, currency = 'BDT'): string {
  const hasMinorUnits = Math.abs(amount - Math.round(amount)) > 0.0001;
  return `${currency} ${amount.toLocaleString('en-US', {
    minimumFractionDigits: hasMinorUnits ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}
