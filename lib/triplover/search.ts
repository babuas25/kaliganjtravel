import 'server-only';

import { currencyForBdtContract } from '@/lib/currency';
import {
  bookingSnapshotDigestFor,
  canonicalBookingSnapshot,
  SearchQuoteTooLargeError,
  SearchReferenceStoreError,
  selectionSignatureForItinerary,
  storeSearch,
  type ItineraryRefs,
  type SearchPersistenceTiming,
} from '@/lib/flights/search-cache';
import type {
  FlightSearchTraceEvent,
  FlightSearchTraceObserver,
} from '@/lib/flights/search-trace';
import { activeMarkupRulesFor } from '@/lib/db/markup-rules';
import {
  type AirlineFilter,
  type FareBreakdown,
  type FlightItinerary,
  type FlightSearchInput,
  type FlightSearchResult,
  type ItineraryLeg,
  type ItinerarySegment,
  type StandaloneFlightItinerary,
} from '@/lib/flights/types';
import { groupUpsellOptions } from '@/lib/flights/upsells';
import {
  B2C_PRICING_AUDIENCE,
  priceOffer,
  selectMarkupRules,
  type PricingAudience,
  type SupplierFarePricing,
} from '@/lib/markup';
import { triploverCall, type TriploverCallTiming } from '@/lib/triplover/client';
import type { FlightReadSupplier } from '@/lib/flights/supplier';
import { shapontravelsRead } from '@/lib/shapontravels/client';
import { shapontravelsPricedOffer, type ShapontravelsFareBreakdown } from '@/lib/shapontravels/pricing';

/**
 * Search: request building and the mapping back to our own itinerary model.
 *
 * The supplier's payload is large and unevenly populated, so every read here is
 * defensive. Where a shape cannot be understood the offer is dropped and
 * counted rather than guessed at — a wrong itinerary on a results page is worse
 * than a shorter list.
 */

/* ── Request ─────────────────────────────────────────────────────────── */

type TriploverSearchRequest = {
  routes: { origin: string; destination: string; departureDate: string }[];
  adults: number;
  childs: number;
  infants: number;
  cabinClass: number;
  preferredCarriers: string[];
  prohibitedCarriers: string[];
  childrenAges: number[];
};

/**
 * `fareType` is **deliberately not sent.** The panel offers Regular and Student
 * fares, but the supplier documents the field without ever defining its values
 * (their own multicity fixture sends `1` and the enum appears nowhere). Sending
 * a guessed integer would silently change which fares are returned. Student
 * Fare is therefore unavailable in the UI and rejected by the public search
 * endpoint until Triplover publishes the enum.
 */
export function buildSearchRequest(input: FlightSearchInput): TriploverSearchRequest {
  return {
    routes: input.routes.map((route) => ({
      origin: route.origin.toUpperCase(),
      destination: route.destination.toUpperCase(),
      departureDate: route.departureDate,
    })),
    adults: input.adults,
    // The supplier's `childs` counts every child from 2 to under 12; it splits
    // them into `chd` (5–11) and `cnn` (2–4) itself, using `childrenAges`.
    childs: input.children,
    infants: input.infants,
    cabinClass: input.cabinClass,
    preferredCarriers: input.preferredCarriers.map((c) => c.toUpperCase()),
    prohibitedCarriers: [],
    childrenAges: input.childrenAges,
  };
}

/* ── Raw supplier shapes (only the parts we read) ────────────────────── */

type RawBaggage = { units?: string; amount?: number; passengerTypeCode?: string };

type RawSegment = {
  from?: string;
  fromAirport?: string;
  to?: string;
  toAirport?: string;
  departure?: string;
  arrival?: string;
  airline?: string;
  airlineCode?: string;
  operationCarrier?: unknown;
  operatingCarrier?: unknown;
  isCodeShared?: unknown;
  isCodeshare?: unknown;
  flightNumber?: string;
  segmentCodeRef?: string;
  serviceClass?: string;
  bookingClass?: string;
  bookingCount?: string;
  handBaggage?: string;
  baggage?: RawBaggage[];
  cabinClass?: string;
  plane?: string[];
  duration?: string[];
  details?: { flightTime?: string; travelTime?: string; equipment?: string }[];
};

type RawDirection = {
  from?: string;
  to?: string;
  stops?: number;
  segments?: RawSegment[];
  travelTime?: string;
};

type RawPassengerFare = {
  currency?: unknown;
  currencyCode?: unknown;
  basePrice?: number;
  taxes?: number;
  ait?: number;
  serviceCharge?: number;
  discountPrice?: number;
  totalPrice?: number;
};

type RawOffer = {
  fareBreakdown?: ShapontravelsFareBreakdown;
  currency?: unknown;
  currencyCode?: unknown;
  uniqueTransID?: string;
  uniqueTransId?: string;
  UniqueTransID?: string;
  UniqueTransId?: string;
  itemCodeRef?: string;
  totalPrice?: number;
  basePrice?: number;
  taxes?: number;
  platingCarrier?: string;
  platingCarrierName?: string;
  refundable?: boolean;
  bookable?: boolean;
  isCodeShared?: boolean;
  directions?: RawDirection[][];
  passengerFares?: Record<string, RawPassengerFare | null>;
  passengerCounts?: Record<string, number>;
  bookingComponents?: { ait?: number }[];
};

type RawSearchPayload = {
  currency?: unknown;
  currencyCode?: unknown;
  airSearchResponses?: RawOffer[];
  airlineFilters?: {
    airlineCode?: string;
    airlineName?: string;
    totalFlights?: number;
    minPrice?: number;
  }[];
  minMaxPrice?: { minPrice?: number; maxPrice?: number };
};

/* ── The multi-direction shape ───────────────────────────────────────── */

/**
 * How many itineraries one supplier offer may expand into. Guards against an
 * offer that lists many alternatives on several routes multiplying out.
 */
const MAX_COMBINATIONS_PER_OFFER = 12;

/**
 * Cartesian product across routes, so an offer that lists alternatives becomes
 * one itinerary per combination. Returns null past the cap.
 *
 * **This exists because of an undocumented supplier shape.** `directions` is
 * documented as one sub-list per requested route, and every example in the
 * documentation has exactly one direction inside each. Live DAC→CXB on
 * 2026-07-28 returned two Biman offers whose single route contained **two**
 * directions — BG433 at 10:15 and BG437 at 15:30, both DAC→CXB with `stops: 0`.
 * They are not a connection; they are alternative departures sharing one
 * `itemCodeRef` and one price.
 *
 * Flattening them into a single itinerary would render a nonsense
 * "DAC→CXB then DAC→CXB" journey, so each alternative becomes its own card.
 * Triplover can provide a distinct, ordered `segmentCodeRef` vector for every
 * card even though `itemCodeRef` is shared. Such a card is selectable only
 * when that vector is complete and unique; RePrice then has to echo the exact
 * displayed itinerary before its price reference can reach Book. Missing or
 * duplicate segment references remain `ambiguousSelection` and fail closed.
 */
function expandRouteAlternatives(directions: RawDirection[][]): RawDirection[][] | null {
  const total = directions.reduce((product, route) => product * Math.max(route.length, 1), 1);
  if (total > MAX_COMBINATIONS_PER_OFFER) return null;

  let combinations: RawDirection[][] = [[]];
  for (const route of directions) {
    const alternatives = route.length > 0 ? route : [];
    if (alternatives.length === 0) return null;
    const next: RawDirection[][] = [];
    for (const partial of combinations) {
      for (const alternative of alternatives) {
        next.push([...partial, alternative]);
      }
    }
    combinations = next;
  }
  return combinations;
}

/* ── Mapping ─────────────────────────────────────────────────────────── */

function mapSegment(raw: RawSegment): ItinerarySegment | null {
  const from = raw.from;
  const to = raw.to;
  const departure = raw.departure;
  const arrival = raw.arrival;
  // Without these four a card cannot be rendered honestly.
  if (!from || !to || !departure || !arrival) return null;

  const checked = raw.baggage?.find((b) => b.passengerTypeCode === 'ADT') ?? raw.baggage?.[0];
  const seats = Number.parseInt(raw.bookingCount ?? '', 10);
  // Only explicit operating-carrier fields establish who operates the flight.
  // airlineCode alone must not produce an "Operated by" claim.
  const operator = [raw.operationCarrier, raw.operatingCarrier].find(
    (value): value is string => typeof value === 'string' && /^[A-Z0-9]{2}$/.test(value.trim().toUpperCase())
  );
  const codeshare = typeof raw.isCodeShared === 'boolean'
    ? raw.isCodeShared
    : typeof raw.isCodeshare === 'boolean' ? raw.isCodeshare : undefined;

  return {
    from,
    fromAirport: raw.fromAirport ?? from,
    to,
    toAirport: raw.toAirport ?? to,
    // TakeOff currently does not provide terminals in this Search shape.
    // Emit their canonical absence explicitly so the public Search snapshot,
    // Redis digest and later Prepare payload share the same representation.
    departureTerminal: null,
    arrivalTerminal: null,
    departure,
    arrival,
    airline: raw.airline ?? raw.airlineCode ?? '',
    airlineCode: raw.airlineCode ?? '',
    ...(operator ? { operatingCarrierCode: operator.trim().toUpperCase() } : {}),
    ...(codeshare !== undefined ? { codeshare } : {}),
    flightNumber: raw.flightNumber ?? '',
    cabinClass: raw.cabinClass ?? '',
    bookingClass: raw.bookingClass ?? raw.serviceClass ?? '',
    duration:
      raw.duration?.[0] ??
      raw.details?.[0]?.flightTime ??
      raw.details?.[0]?.travelTime ??
      null,
    aircraft: raw.plane?.[0] ?? raw.details?.[0]?.equipment ?? null,
    baggage:
      checked?.amount != null ? `${checked.amount} ${checked.units ?? 'Kg'}`.trim() : null,
    handBaggage: raw.handBaggage ?? null,
    seatsLeft: Number.isFinite(seats) ? seats : null,
  };
}

function mapLeg(raw: RawDirection): ItineraryLeg | null {
  const segments = (raw.segments ?? [])
    .map(mapSegment)
    .filter((s): s is ItinerarySegment => s !== null);

  if (segments.length === 0) return null;

  const first = segments[0];
  const last = segments[segments.length - 1];

  return {
    from: raw.from ?? first.from,
    to: raw.to ?? last.to,
    // Prefer the supplier's own count; fall back to the segment count.
    stops: typeof raw.stops === 'number' ? raw.stops : segments.length - 1,
    segments,
    duration: raw.travelTime ?? null,
    departure: first.departure,
    arrival: last.arrival,
  };
}

const PAX_TYPES: FareBreakdown['passengerType'][] = ['ADT', 'CHD', 'CNN', 'INF', 'INS'];

/**
 * Per-passenger-type fares.
 *
 * `passengerFares.<type>` holds **per-passenger** amounts and
 * `passengerCounts.<type>` the head count — verified live: a 2 adult trip
 * reported `adt.totalPrice: 11731` against a total of 33963, where
 * 11731 × 2 + child + infant reconciles. Multiplying here keeps the card's
 * breakdown honest.
 */
function mapFares(offer: RawOffer): SupplierFarePricing[] {
  const fares = offer.passengerFares ?? {};
  const counts = offer.passengerCounts ?? {};

  return PAX_TYPES.flatMap((type) => {
    const key = type.toLowerCase();
    const fare = fares[key];
    const count = counts[key] ?? 0;
    if (!fare || count <= 0) return [];
    return [
      {
        passengerType: type,
        count,
        basePrice: (fare.basePrice ?? 0) * count,
        taxes: (fare.taxes ?? 0) * count,
        ait: (fare.ait ?? 0) * count,
        serviceCharge: (fare.serviceCharge ?? 0) * count,
        supplierTotalPrice: (fare.totalPrice ?? 0) * count,
      },
    ];
  });
}

/**
 * Advance Income Tax, the third money component.
 *
 * `totalPrice = basePrice + taxes + ait` — verified live (4424 + 1125 + 15 =
 * 5564) when no discount or service charge is present. AIT is *not* inside
 * `taxes`, and the offer carries no top-level `ait` field, so populated
 * per-passenger fares are the authority. The remainder is only a fallback when
 * there are no passenger fares; a discount makes it unsuitable otherwise.
 */
function resolveAit(offer: RawOffer, fares: SupplierFarePricing[]): number {
  if (fares.length > 0) {
    return fares.reduce((sum, fare) => sum + fare.ait, 0);
  }

  const total = offer.totalPrice ?? 0;
  const base = offer.basePrice ?? 0;
  const taxes = offer.taxes ?? 0;
  const remainder = total - base - taxes;
  return remainder > 0 ? remainder : 0;
}

type SupplierItinerary = Omit<
  StandaloneFlightItinerary,
  | 'auditPricing'
  | 'agencyPricing'
  | 'totalPrice'
  | 'basePrice'
  | 'taxes'
  | 'ait'
  | 'serviceMargin'
  | 'fares'
> & {
  supplierTotalPrice: number;
  basePrice: number;
  taxes: number;
  ait: number;
  fares: SupplierFarePricing[];
};

type SupplierRefs = Pick<
  ItineraryRefs,
  | 'itemCodeRef'
  | 'segmentCodeRefs'
  | 'ambiguousSelection'
  | 'alternativeSelection'
>;

/**
 * A supplier may group alternate directions under one `itemCodeRef`. Each
 * displayed combination is safe to send to RePrice only when every displayed
 * segment contributes one non-empty, non-duplicated reference in journey
 * order. A shared segment across *different* combinations is fine; duplicate
 * references inside the same chosen journey are not.
 */
function completeSelectionSegmentRefs(
  combination: RawDirection[],
  legs: ItineraryLeg[]
): string[] | null {
  const rawSegments = combination.flatMap((direction) => direction.segments ?? []);
  const displayedSegmentCount = legs.reduce(
    (count, leg) => count + leg.segments.length,
    0
  );
  if (rawSegments.length === 0 || rawSegments.length !== displayedSegmentCount) {
    return null;
  }

  const refs = rawSegments.map((segment) => segment.segmentCodeRef?.trim() ?? '');
  if (refs.some((ref) => ref.length === 0) || new Set(refs).size !== refs.length) {
    return null;
  }
  return refs;
}

/** Reject impossible time ordering between adjoining airport-local legs. */
function hasOverlappingLegs(legs: ItineraryLeg[]): boolean {
  return legs.some((leg, index) => {
    const previous = legs[index - 1];
    if (!previous) return false;
    const arrivalSegment = previous.segments[previous.segments.length - 1];
    const departureSegment = leg.segments[0];
    // Supplier times are airport-local. Only compare adjoining legs at the
    // same airport; an open-jaw journey can cross time zones on the ground.
    if (arrivalSegment.to.trim().toUpperCase() !== departureSegment.from.trim().toUpperCase()) {
      return false;
    }
    const arrival = arrivalSegment.arrival.trim();
    const departure = departureSegment.departure.trim();
    const timestamp = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;
    if (!timestamp.test(arrival) || !timestamp.test(departure)) return false;
    const zone = /(?:Z|[+-]\d{2}:?\d{2})$/i;
    if (zone.test(arrival) !== zone.test(departure)) return false;
    // Appending Z to two local times compares their calendar values without
    // involving the server time zone. Explicit offsets retain their meaning.
    const comparableTime = (value: string) => Date.parse(
      value.replace(' ', 'T') + (zone.test(value) ? '' : 'Z')
    );
    return comparableTime(departure) <= comparableTime(arrival);
  });
}

/** Maps one supplier offer into zero or more itineraries. */
function mapOffer(
  offer: RawOffer,
  index: number
): { itineraries: SupplierItinerary[]; refs: SupplierRefs[] } | null {
  const directions = offer.directions;
  const itemCodeRef = offer.itemCodeRef?.trim();
  if (!Array.isArray(directions) || directions.length === 0 || !itemCodeRef) return null;

  const combinations = expandRouteAlternatives(directions);
  if (!combinations) return null;

  const alternativeSelection = directions.some((route) => route.length > 1);
  const fares = mapFares(offer);
  const ait = resolveAit(offer, fares);

  const itineraries: SupplierItinerary[] = [];
  const refs: SupplierRefs[] = [];

  combinations.forEach((combination, combinationIndex) => {
    const legs = combination.map(mapLeg).filter((leg): leg is ItineraryLeg => leg !== null);
    // One unmappable leg means we do not know the whole journey — drop it all.
    if (legs.length !== combination.length) return;
    // Grouped outbound/return alternatives may form impossible combinations.
    // Drop those before exposing a card or persisting supplier references.
    if (hasOverlappingLegs(legs)) return;

    const incompleteSegmentCodeRefs = combination.flatMap((direction) =>
      (direction.segments ?? [])
        .map((segment) => segment.segmentCodeRef?.trim())
        .filter((ref): ref is string => Boolean(ref))
    );
    const selectedSegmentCodeRefs = completeSelectionSegmentRefs(combination, legs);
    // A missing/duplicate vector is never safe to RePrice, whether this is a
    // grouped alternative or a single supplier direction. The entry point
    // below excludes it before any public result or Redis quote is created.
    const ambiguousSelection = selectedSegmentCodeRefs === null;
    const segmentCodeRefs = selectedSegmentCodeRefs ?? incompleteSegmentCodeRefs;

    const id = `itn-${index}-${combinationIndex}`;

    itineraries.push({
      id,
      supplierTotalPrice: offer.totalPrice ?? 0,
      basePrice: offer.basePrice ?? 0,
      taxes: offer.taxes ?? 0,
      ait,
      carrierCode: (
        offer.platingCarrier ??
        legs[0]?.segments[0]?.airlineCode ??
        ''
      ).toUpperCase(),
      carrierName: offer.platingCarrierName ?? legs[0]?.segments[0]?.airline ?? '',
      refundable: offer.refundable === true,
      ...(typeof offer.isCodeShared === 'boolean' ? { codeshare: offer.isCodeShared } : {}),
      bookable: offer.bookable !== false,
      legs,
      fares,
      ambiguousSelection,
    });

    refs.push({
      itemCodeRef,
      segmentCodeRefs,
      ambiguousSelection,
      alternativeSelection,
    });
  });

  return itineraries.length > 0 ? { itineraries, refs } : null;
}

function completeReferenceVector(
  refs: Pick<
    ItineraryRefs,
    'itemCodeRef' | 'segmentCodeRefs' | 'ambiguousSelection'
  >,
  itinerary: { legs: ItineraryLeg[] }
): boolean {
  const segmentCount = itinerary.legs.reduce(
    (count, leg) => count + leg.segments.length,
    0
  );
  const vector = refs.segmentCodeRefs.map((value) => value.trim());
  return (
    refs.itemCodeRef.trim().length > 0 &&
    segmentCount > 0 &&
    vector.length === segmentCount &&
    vector.every(Boolean) &&
    new Set(vector).size === vector.length
  );
}

/**
 * The public response can contain a primary card and nested upsell choices.
 * Each selectable id must resolve to the exact private reference persisted
 * alongside it; otherwise no result is safe to expose as bookable.
 */
function assertPublicReferenceContract(
  itineraries: FlightItinerary[],
  refsByItineraryId: Map<string, ItineraryRefs>
): void {
  const publicOptions = itineraries.flatMap((itinerary) => [
    itinerary,
    ...itinerary.upsellOptions,
  ]);
  const publicIds = new Set<string>();

  for (const option of publicOptions) {
    if (publicIds.has(option.id)) {
      throw new SearchReferenceStoreError(
        'integrity',
        'Search produced duplicate public fare identifiers.'
      );
    }
    publicIds.add(option.id);

    const refs = refsByItineraryId.get(option.id);
    if (!refs || refs.ambiguousSelection !== option.ambiguousSelection) {
      throw new SearchReferenceStoreError(
        'integrity',
        'Search produced a fare without its private supplier reference.'
      );
    }
    if (!option.ambiguousSelection && !completeReferenceVector(refs, option)) {
      throw new SearchReferenceStoreError(
        'integrity',
        'Search produced a selectable fare with incomplete supplier references.'
      );
    }
  }

  if (publicIds.size !== refsByItineraryId.size) {
    throw new SearchReferenceStoreError(
      'integrity',
      'Search reference set does not exactly match the public fare set.'
    );
  }
}

function referencesForDisplayedFares(
  itineraries: FlightItinerary[],
  source: Map<string, ItineraryRefs>
): Map<string, ItineraryRefs> {
  const displayedIds = new Set(itineraries.flatMap((itinerary) => [
    itinerary.id,
    ...itinerary.upsellOptions.map((option) => option.id),
  ]));
  return new Map(Array.from(source.entries()).filter(([id]) => displayedIds.has(id)));
}

/* ── Entry point ─────────────────────────────────────────────────────── */

export type FlightSearchExecutionTiming = TriploverCallTiming & {
  /** The pricing-rule read that begins alongside the supplier call. */
  markupRulesMs: number;
  /** The portion of markup-rule work that remained after Search completed. */
  postSupplierMarkupWaitMs: number;
  mappingMs: number;
  cacheWriteMs: number;
  /** Supplier body complete through Redis confirmation, including mapping. */
  supplierCompleteToRedisConfirmedMs: number;
  /** Server monotonic timestamp used only to measure final SSE enqueue. */
  redisPersistenceConfirmedAt: number;
} & SearchPersistenceTiming;

export type FlightSearchExecution = {
  result: FlightSearchResult;
  timing: FlightSearchExecutionTiming;
};

function uniqueTransactionReference(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  for (const key of [
    'uniqueTransID',
    'uniqueTransId',
    'UniqueTransID',
    'UniqueTransId',
  ]) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return null;
}

/**
 * A few deployed Search responses place the per-search transaction reference
 * below a provider-specific wrapper rather than on `item2` or the top-level
 * offer.  Discover only the documented field name (with casing variants),
 * never log its opaque value, and accept it only when the entire response
 * agrees on exactly one value.  Multiple references are ambiguous and remain
 * fail-closed.
 */
function uniqueTransactionReferencesInPayload(value: unknown): string[] {
  const references = new Set<string>();
  const seen = new Set<object>();

  const visit = (node: unknown, depth: number): void => {
    if (depth > 12 || !node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, depth + 1));
      return;
    }

    const record = node as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (key.toLowerCase() === 'uniquetransid' && typeof child === 'string') {
        const reference = child.trim();
        if (reference) references.add(reference);
      }
      visit(child, depth + 1);
    }
  };

  visit(value, 0);
  return Array.from(references);
}

/**
 * Milestones reached only after the supplier has delivered its complete Search
 * response. They intentionally do not imply that an individual flight offer
 * arrived early: the upstream API currently returns one JSON envelope.
 */
export type FlightSearchProgressStage = 'processing' | 'finalizing';

export type FlightSearchOptions = {
  onProgress?: (stage: FlightSearchProgressStage) => void;
  /** TakeOff-only request timeline for production search diagnostics. */
  trace?: FlightSearchTraceObserver;
};

function emitSearchTrace(
  observer: FlightSearchTraceObserver | undefined,
  event: FlightSearchTraceEvent
): void {
  try {
    observer?.(event);
  } catch {
    // Observability never alters a supplier search or the quote write path.
  }
}

function searchPayloadTraceDetails(request: TriploverSearchRequest) {
  return {
    routes: request.routes
      .map((route) => `${route.origin}-${route.destination}-${route.departureDate}`)
      .join('|'),
    adults: request.adults,
    childs: request.childs,
    infants: request.infants,
    cabinClass: request.cabinClass,
    preferredCarriers: request.preferredCarriers.join(',') || '(none)',
    prohibitedCarriers: request.prohibitedCarriers.join(',') || '(none)',
    childrenAges: request.childrenAges.join(',') || '(none)',
  };
}

export async function searchFlights(
  input: FlightSearchInput,
  supplier: FlightReadSupplier,
  audience: PricingAudience = B2C_PRICING_AUDIENCE,
  options: FlightSearchOptions = {}
): Promise<FlightSearchExecution> {
  const isShapontravels = supplier === 'shapontravels';
  // FirstTrip retains its current request behavior and telemetry surface. This
  // trace is intentionally limited to the TakeOff investigation.
  const trace = supplier === 'takeoff' ? options.trace : undefined;
  const searchRequest = buildSearchRequest(input);
  emitSearchTrace(trace, {
    name: 'takeoff_search_payload_ready',
    details: searchPayloadTraceDetails(searchRequest),
  });

  // Read pricing beside the slow supplier request, not after it.
  const markupRulesStartedAt = performance.now();
  emitSearchTrace(trace, { name: 'markup_rules_start' });
  let markupRulesCompletedAt = markupRulesStartedAt;
  const rulesPromise = supplier === 'shapontravels' ? null : activeMarkupRulesFor(audience).then(
    (result) => {
      markupRulesCompletedAt = performance.now();
      emitSearchTrace(trace, { name: 'markup_rules_complete' });
      return result;
    },
    (error) => {
      markupRulesCompletedAt = performance.now();
      emitSearchTrace(trace, { name: 'markup_rules_failed' });
      throw error;
    }
  );
  const call = supplier === 'shapontravels'
    ? await (async () => {
        const startedAt = performance.now();
        const envelope = await shapontravelsRead('Search', searchRequest) as {
          item1?: RawSearchPayload;
          item2?: unknown;
        };
        if (!envelope?.item1 || !Array.isArray(envelope.item1.airSearchResponses)) {
          throw new SearchReferenceStoreError('integrity', 'Shapontravels Search returned an invalid offer envelope.');
        }
        const supplierStatuses = Array.isArray(envelope.item2)
          ? envelope.item2
          : [envelope.item2];
        return {
          data: envelope.item1,
          uniqueTransId: null,
          partial: supplierStatuses.some((status) =>
            !!status && typeof status === 'object' &&
            (status as { isSuccess?: unknown }).isSuccess === false
          ),
          timing: {
            tokenMs: 0,
            tokenSource: 'shapontravels',
            tokenLoginAttempts: 0,
            apiRequestMs: performance.now() - startedAt,
            apiTtfbMs: 0,
            responseReadMs: 0,
            responseParseMs: 0,
            attempts: 1,
          },
        };
      })()
    : await triploverCall('Search', '/api/Search', searchRequest, { supplier, searchTrace: trace });
  const supplierCallCompletedAt = performance.now();
  emitSearchTrace(trace, { name: 'supplier_search_response_complete' });
  options.onProgress?.('processing');
  const rulesResult = rulesPromise ? await rulesPromise : null;
  const mappingStartedAt = performance.now();
  const markupRulesMs = markupRulesCompletedAt - markupRulesStartedAt;
  const postSupplierMarkupWaitMs = Math.max(
    0,
    mappingStartedAt - supplierCallCompletedAt
  );
  emitSearchTrace(trace, { name: 'mapping_start' });

  const payload = (call.data ?? {}) as RawSearchPayload;
  const offers = Array.isArray(payload.airSearchResponses) ? payload.airSearchResponses : [];
  if (isShapontravels && offers.length > 0) {
    const transactions = new Set(offers.map(uniqueTransactionReference));
    if (transactions.size !== 1 || transactions.has(null)) {
      throw new SearchReferenceStoreError(
        'integrity',
        'Shapontravels Search returned inconsistent transaction references.'
      );
    }
  }
  const currency = currencyForBdtContract(
    payload.currency,
    payload.currencyCode,
  );
  for (const offer of offers) {
    currencyForBdtContract(
      offer.currency,
      offer.currencyCode,
      ...Object.values(offer.passengerFares ?? {}).flatMap((fare) => [fare?.currency, fare?.currencyCode]),
    );
    if (supplier === 'shapontravels' && offer.fareBreakdown?.currency !== 'BDT') {
      throw new SearchReferenceStoreError('integrity', 'Shapontravels Search returned an unsupported currency.');
    }
  }

  const supplierItineraries: SupplierItinerary[] = [];
  const supplierRefsByItineraryId = new Map<string, SupplierRefs>();
  const shapontravelsPricingByItineraryId = new Map<string, NonNullable<ReturnType<typeof shapontravelsPricedOffer>>>();
  let droppedOfferCount = 0;

  offers.forEach((offer, index) => {
    const mapped = mapOffer(offer, index);
    if (!mapped) {
      droppedOfferCount += 1;
      return;
    }
    mapped.itineraries.forEach((itinerary, i) => {
      const refs = mapped.refs[i];
      if (supplier === 'shapontravels') {
        const priced = shapontravelsPricedOffer(offer.fareBreakdown, audience);
        if (!priced) {
          droppedOfferCount += 1;
          return;
        }
        shapontravelsPricingByItineraryId.set(itinerary.id, priced);
      }
      // A public flight card is only useful when its exact supplier reference
      // chain can be made durable.  Drop unsafe provider alternatives before
      // pricing/grouping so no primary or upsell card can look selectable
      // without a complete private graph.
      if (
        !refs ||
        refs.ambiguousSelection ||
        !completeReferenceVector(refs, itinerary)
      ) {
        droppedOfferCount += 1;
        return;
      }
      supplierItineraries.push(itinerary);
      supplierRefsByItineraryId.set(itinerary.id, refs);
    });
  });

  const passengerCount = input.adults + input.children + input.infants;
  const refsByItineraryId = new Map<string, ItineraryRefs>();
  const pricedItineraries: StandaloneFlightItinerary[] = [];
  for (const supplier of supplierItineraries) {
      const refs = supplierRefsByItineraryId.get(supplier.id);
      const bookingSnapshot = canonicalBookingSnapshot({
        carrierCode: supplier.carrierCode,
        carrierName: supplier.carrierName,
        refundable: supplier.refundable,
        ...(supplier.codeshare !== undefined ? { codeshare: supplier.codeshare } : {}),
        legs: supplier.legs,
      });
      // A malformed public snapshot belongs only to this independently
      // selectable supplier option. Drop it with its private refs rather than
      // failing an otherwise sound Search or exposing an unbookable card.
      if (!refs || !bookingSnapshot) {
        supplierRefsByItineraryId.delete(supplier.id);
        droppedOfferCount += 1;
        continue;
      }
      const selectedRules = isShapontravels ? null : selectMarkupRules(
        rulesResult!.rules,
        audience,
        supplier.carrierCode,
        input.routes
      );
      const priced = isShapontravels
        ? shapontravelsPricingByItineraryId.get(supplier.id)!
        : priceOffer({
        audience,
        rulesAvailable: rulesResult!.ok,
        rules: selectedRules!,
        supplierTotalPrice: supplier.supplierTotalPrice,
        basePrice: supplier.basePrice,
        taxes: supplier.taxes,
        ait: supplier.ait,
        fares: supplier.fares,
        passengerCount,
      });
      const passengerCounts = Object.fromEntries(
        supplier.fares.map((fare) => [
          fare.passengerType.toLowerCase(),
          fare.count,
        ])
      );
      // Some RePrice/Search responses omit passenger fare rows. Preserve the
      // requested party as a fallback so checkout can still require the exact
      // ADT/CHD/CNN/INF mix rather than accepting a caller-supplied one.
      passengerCounts.adt ??= input.adults;
      passengerCounts.chd ??= input.childrenAges.filter(
        (age) => age >= 5
      ).length;
      passengerCounts.cnn ??= input.childrenAges.filter(
        (age) => age < 5
      ).length;
      passengerCounts.inf ??= input.infants;
      refsByItineraryId.set(supplier.id, {
        ...refs,
        context: {
          carrierCode: bookingSnapshot.carrierCode,
          routes: input.routes,
          passengerCounts,
          passengerCount,
        },
        pricing: priced.snapshot,
        selection: selectionSignatureForItinerary(bookingSnapshot),
        bookingSnapshotDigest: bookingSnapshotDigestFor(bookingSnapshot),
      });

      pricedItineraries.push({
        id: supplier.id,
        auditPricing:
          audience.kind === 'superadmin'
            ? {
                grossPrice: isShapontravels
                  ? priced.snapshot.grossPrice
                  : Math.round((supplier.basePrice + supplier.taxes) * 100) / 100,
                netFare: priced.snapshot.supplierTotalPrice,
              }
            : null,
        agencyPricing:
          audience.kind === 'agency'
            ? {
                grossPrice: isShapontravels
                  ? priced.snapshot.grossPrice
                  : Math.round((supplier.basePrice + supplier.taxes) * 100) / 100,
                agentFare: priced.totalPrice,
              }
            : null,
        totalPrice: priced.totalPrice,
        basePrice: priced.basePrice,
        taxes: priced.taxes,
        ait: priced.ait,
        serviceMargin: priced.serviceMargin,
        carrierCode: bookingSnapshot.carrierCode,
        carrierName: bookingSnapshot.carrierName,
        refundable: bookingSnapshot.refundable,
        ...(bookingSnapshot.codeshare !== undefined ? { codeshare: bookingSnapshot.codeshare } : {}),
        bookable: supplier.bookable,
        // Public Search, Redis digest, and Prepare now share precisely this
        // normalized object, including explicit nulls for missing terminals.
        legs: bookingSnapshot.legs,
        fares: priced.fares,
        ambiguousSelection: supplier.ambiguousSelection,
      });
  }

  const itineraries: FlightItinerary[] = groupUpsellOptions(pricedItineraries);

  const directOfferReference = offers
    .map(uniqueTransactionReference)
    .find(Boolean);
  const payloadReferences =
    call.uniqueTransId || directOfferReference
      ? []
      : uniqueTransactionReferencesInPayload(payload);
  const discoveredPayloadReference =
    payloadReferences.length === 1 ? payloadReferences[0] : null;
  emitSearchTrace(trace, {
    name: 'supplier_transaction_reference_observed',
    details: {
      source: call.uniqueTransId
        ? 'envelope'
        : directOfferReference
          ? 'offer'
          : discoveredPayloadReference
            ? 'nested'
            : 'missing_or_ambiguous',
      distinctNestedReferenceCount: payloadReferences.length,
    },
  });
  const uniqueTransId =
    call.uniqueTransId ?? directOfferReference ?? discoveredPayloadReference ?? '';

  if (uniqueTransId.trim().length === 0) {
    throw new SearchReferenceStoreError(
      'integrity',
      'Search returned no supplier transaction reference.'
    );
  }
  assertPublicReferenceContract(itineraries, refsByItineraryId);
  emitSearchTrace(trace, {
    name: 'reference_graph_validated',
    details: { itineraryReferenceCount: refsByItineraryId.size },
  });

  const mappingMs = performance.now() - mappingStartedAt;
  emitSearchTrace(trace, {
    name: 'mapping_complete',
    details: { itineraryCount: itineraries.length, droppedOfferCount },
  });
  options.onProgress?.('finalizing');
  const cacheWriteStartedAt = performance.now();
  let displayedItineraries = itineraries;
  let displayedRefs = refsByItineraryId;
  let limitedByQuoteSize = false;
  let storedSearch: Awaited<ReturnType<typeof storeSearch>>;
  while (true) {
    try {
      assertPublicReferenceContract(displayedItineraries, displayedRefs);
      storedSearch = await storeSearch(uniqueTransId, displayedRefs, supplier, { trace });
      break;
    } catch (error) {
      // An oversized quote is rejected before Redis writes. Keep every distinct
      // flight first, shedding additional fare choices; if that is still too
      // large, retain the cheapest complete flights until the quote fits.
      if (!(error instanceof SearchQuoteTooLargeError)) throw error;
      if (displayedItineraries.some((itinerary) => itinerary.upsellOptions.length > 0)) {
        displayedItineraries = displayedItineraries.map((itinerary) => ({
          ...itinerary,
          upsellOptions: [],
        }));
      } else if (displayedItineraries.length > 1) {
        displayedItineraries = displayedItineraries.slice(
          0,
          Math.ceil(displayedItineraries.length / 2)
        );
      } else {
        throw error;
      }
      displayedRefs = referencesForDisplayedFares(displayedItineraries, refsByItineraryId);
      limitedByQuoteSize = true;
    }
  }
  const redisPersistenceConfirmedAt = performance.now();
  const cacheWriteMs = performance.now() - cacheWriteStartedAt;
  const supplierCompleteToRedisConfirmedMs =
    redisPersistenceConfirmedAt - supplierCallCompletedAt;

  // Summaries and filters must describe only the fares that were saved and
  // returned to the browser, including after a large-result reduction.
  const airlineMap = new Map<string, AirlineFilter>();
  displayedItineraries.forEach((itinerary) => {
    if (!itinerary.carrierCode) return;
    const current = airlineMap.get(itinerary.carrierCode);
    if (!current) {
      airlineMap.set(itinerary.carrierCode, {
        airlineCode: itinerary.carrierCode,
        airlineName: itinerary.carrierName || itinerary.carrierCode,
        totalFlights: 1,
        minPrice: itinerary.totalPrice,
      });
      return;
    }
    current.totalFlights += 1;
    current.minPrice = Math.min(current.minPrice, itinerary.totalPrice);
  });
  const airlines = Array.from(airlineMap.values());
  const prices = displayedItineraries.map((itinerary) => itinerary.totalPrice);

  return {
    result: {
      searchId: storedSearch.searchId,
      currency,
      itineraries: displayedItineraries,
      airlines,
      minPrice: prices.length ? Math.min(...prices) : null,
      maxPrice: prices.length ? Math.max(...prices) : null,
      partial: call.partial,
      droppedOfferCount,
      limitedByQuoteSize,
      bookingAvailable: true,
      holdOnly: supplier === 'shapontravels',
    },
    timing: {
      ...call.timing,
      markupRulesMs,
      postSupplierMarkupWaitMs,
      mappingMs,
      cacheWriteMs,
      supplierCompleteToRedisConfirmedMs,
      redisPersistenceConfirmedAt,
      ...storedSearch.timing,
    },
  };
}
