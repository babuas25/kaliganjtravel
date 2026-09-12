import 'server-only';

import { activeMarkupRulesFor } from '@/lib/db/markup-rules';
import {
  readSearch,
  readRepricedSelection,
  SearchReferenceStoreError,
  storeRepricedSelection,
  type ItinerarySelectionSignature,
} from '@/lib/flights/search-cache';
import {
  pricingAudienceForPrincipal,
  type PricingPrincipal,
} from '@/lib/flights/pricing-principal';
import {
  fareClassLabel,
  type FareBreakdown,
  type FlightRepriceResult,
} from '@/lib/flights/types';
import {
  priceOffer,
  selectMarkupRules,
  type SupplierFarePricing,
} from '@/lib/markup';
import { TriploverError, triploverCall } from '@/lib/triplover/client';

type RawPassengerFare = {
  basePrice?: number;
  taxes?: number;
  ait?: number;
  serviceCharge?: number;
  totalPrice?: number;
};

type RawSegment = {
  from?: unknown;
  to?: unknown;
  departure?: unknown;
  arrival?: unknown;
  airlineCode?: unknown;
  flightNumber?: unknown;
  cabinClass?: unknown;
  bookingClass?: unknown;
};

type RawDirection = {
  segments?: unknown;
};

type RawReprice = {
  isPriceChanged?: boolean;
  /** Same shape as Search. Populated inconsistently, so read defensively. */
  directions?: unknown;
  priceCodeRef?: string;
  itemCodeRef?: string;
  uniqueTransID?: string;
  currency?: string | null;
  totalPrice?: number;
  basePrice?: number;
  taxes?: number;
  platingCarrier?: string;
  bookable?: boolean;
  passengerFares?: Record<string, RawPassengerFare | null>;
  passengerCounts?: Record<string, number>;
  bookingComponents?: { ait?: number }[];
};

const PASSENGER_TYPES: FareBreakdown['passengerType'][] = [
  'ADT',
  'CHD',
  'CNN',
  'INF',
  'INS',
];

export type FlightRepriceErrorCode =
  | 'SEARCH_EXPIRED'
  | 'FARE_NOT_FOUND'
  | 'AMBIGUOUS_FARE'
  | 'SELECTION_MISMATCH'
  | 'SEARCH_REFERENCE_UNAVAILABLE'
  | 'REPRICE_REFERENCE_PERSISTENCE_UNAVAILABLE'
  | 'REPRICE_REFERENCE_CONFLICT'
  | 'REPRICE_REFERENCE_INVALID';

export class FlightRepriceError extends Error {
  readonly code: FlightRepriceErrorCode;
  readonly status: number;

  constructor(
    code: FlightRepriceErrorCode,
    status: number,
    message: string
  ) {
    super(message);
    this.name = 'FlightRepriceError';
    this.code = code;
    this.status = status;
  }
}

function finiteMoney(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function positiveCounts(
  responseCounts: Record<string, number> | undefined,
  storedCounts: Record<string, number>
): Record<string, number> {
  const counts: Record<string, number> = {};
  PASSENGER_TYPES.forEach((type) => {
    const key = type.toLowerCase();
    const responseCount = responseCounts?.[key];
    const storedCount = storedCounts[key];
    const count =
      typeof responseCount === 'number' && responseCount > 0
        ? responseCount
        : storedCount;
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
      counts[key] = Math.floor(count);
    }
  });
  return counts;
}

/** Maps Triplover's per-passenger amounts to totals for the selected party. */
function mapFares(
  response: RawReprice,
  storedCounts: Record<string, number>
): SupplierFarePricing[] {
  const fares = response.passengerFares ?? {};
  const counts = positiveCounts(response.passengerCounts, storedCounts);

  return PASSENGER_TYPES.flatMap((passengerType) => {
    const key = passengerType.toLowerCase();
    const fare = fares[key];
    const count = counts[key] ?? 0;
    if (!fare || count <= 0) return [];

    return [
      {
        passengerType,
        count,
        basePrice: (finiteMoney(fare.basePrice) ? fare.basePrice : 0) * count,
        taxes: (finiteMoney(fare.taxes) ? fare.taxes : 0) * count,
        ait: (finiteMoney(fare.ait) ? fare.ait : 0) * count,
        serviceCharge:
          (finiteMoney(fare.serviceCharge) ? fare.serviceCharge : 0) *
          count,
        supplierTotalPrice:
          (finiteMoney(fare.totalPrice) ? fare.totalPrice : 0) * count,
      },
    ];
  });
}

function resolveAit(
  response: RawReprice,
  fares: readonly SupplierFarePricing[]
): number {
  if (fares.length > 0) {
    return fares.reduce((sum, fare) => sum + fare.ait, 0);
  }

  const componentAit = (response.bookingComponents ?? []).reduce(
    (sum, component) =>
      sum + (finiteMoney(component.ait) ? component.ait : 0),
    0
  );
  if (componentAit > 0) return componentAit;

  const total = response.totalPrice ?? 0;
  const base = response.basePrice ?? 0;
  const taxes = response.taxes ?? 0;
  return Math.max(0, total - base - taxes);
}

function changed(a: number, b: number): boolean {
  return Math.abs(a - b) >= 0.01;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function comparable(value: unknown): string {
  return text(value).trim().toUpperCase().replace(/\s+/g, ' ');
}

/**
 * A grouped Search offer is selectable only when RePrice proves that the
 * chosen segment-reference vector resolved to the exact card the visitor saw.
 * Missing fields or a different order fail closed rather than letting Book use
 * a price reference for a different flight.
 */
function repriceMatchesSelectedItinerary(
  response: RawReprice,
  selection: ItinerarySelectionSignature
): boolean {
  if (!Array.isArray(response.directions)) return false;
  if (response.directions.length !== selection.legs.length) return false;

  return response.directions.every((group, legIndex) => {
    if (!Array.isArray(group) || group.length !== 1) return false;
    const direction = group[0] as RawDirection | null;
    const expectedLeg = selection.legs[legIndex];
    if (!direction || !expectedLeg || !Array.isArray(direction.segments)) return false;
    if (direction.segments.length !== expectedLeg.segments.length) return false;

    return direction.segments.every((rawSegment, segmentIndex) => {
      const segment = rawSegment as RawSegment | null;
      const expected = expectedLeg.segments[segmentIndex];
      return Boolean(
        segment &&
          expected &&
          comparable(segment.from) === comparable(expected.from) &&
          comparable(segment.to) === comparable(expected.to) &&
          comparable(segment.departure) === comparable(expected.departure) &&
          comparable(segment.arrival) === comparable(expected.arrival) &&
          comparable(segment.airlineCode) === comparable(expected.airlineCode) &&
          comparable(segment.flightNumber) === comparable(expected.flightNumber)
      );
    });
  });
}

/**
 * The cabin/booking class the airline just quoted, e.g. `"Economy C"`.
 *
 * RePrice is where a customer learns their chosen RBD sold out, so this is what
 * names the replacement fare in the price-change confirmation. `directions` is
 * documented as Search's shape but is not guaranteed present — a null result
 * simply drops the class from the message rather than failing the RePrice.
 */
function liveFareClass(response: RawReprice): string | null {
  if (!Array.isArray(response.directions)) return null;

  const segments = (response.directions as unknown[])
    .flatMap((group) => (Array.isArray(group) ? (group as RawDirection[]) : []))
    .flatMap((direction) =>
      Array.isArray(direction?.segments)
        ? (direction.segments as RawSegment[])
        : []
    )
    .map((segment) => ({
      cabinClass: text(segment?.cabinClass),
      bookingClass: text(segment?.bookingClass),
    }));

  const label = fareClassLabel(segments);
  return label.length > 0 ? label : null;
}

function referenceFailure(
  error: SearchReferenceStoreError,
  stage: 'read' | 'persist'
): FlightRepriceError {
  if (error.kind === 'unavailable') {
    return new FlightRepriceError(
      stage === 'read'
        ? 'SEARCH_REFERENCE_UNAVAILABLE'
        : 'REPRICE_REFERENCE_PERSISTENCE_UNAVAILABLE',
      503,
      stage === 'read'
        ? 'We could not securely retrieve this fare reference. Please search again.'
        : 'We could not securely save the verified fare reference. Please try again.'
    );
  }
  if (error.kind === 'conflict') {
    return new FlightRepriceError(
      'REPRICE_REFERENCE_CONFLICT',
      409,
      'A newer verified fare is already active. Verify the fare again.'
    );
  }
  return new FlightRepriceError(
    'REPRICE_REFERENCE_INVALID',
    502,
    'This fare reference could not be verified safely. Please search again.'
  );
}

export async function repriceFlight({
  searchId,
  itineraryId,
  principal,
}: {
  searchId: string;
  itineraryId: string;
  principal: PricingPrincipal;
}): Promise<FlightRepriceResult> {
  const audience = pricingAudienceForPrincipal(principal);
  let search: Awaited<ReturnType<typeof readSearch>>;
  try {
    // RePrice is a cross-instance state transition, so it must resolve the
    // original supplier references from the shared Redis authority rather
    // than local process memory.
    search = await readSearch(searchId, { consistency: 'durable' });
  } catch (error) {
    if (error instanceof SearchReferenceStoreError) {
      throw referenceFailure(error, 'read');
    }
    throw error;
  }
  if (!search) {
    throw new FlightRepriceError(
      'SEARCH_EXPIRED',
      410,
      'This fare search has expired. Run the search again.'
    );
  }

  const refs = search.refsByItineraryId.get(itineraryId);
  if (!refs) {
    throw new FlightRepriceError(
      'FARE_NOT_FOUND',
      404,
      'That fare option is no longer available.'
    );
  }
  if (refs.ambiguousSelection) {
    throw new FlightRepriceError(
      'AMBIGUOUS_FARE',
      409,
      'This supplier fare cannot be revalidated safely. Choose another option or search again.'
    );
  }

  // Capture the Redis CAS revision before the one supplier RePrice call. A
  // stale response may never replace a newer same-principal selection. The
  // mutable selection is intentionally separate from the compressed immutable
  // Search graph, so a large Search is never rewritten after RePrice.
  let currentSelection: Awaited<ReturnType<typeof readRepricedSelection>>;
  try {
    currentSelection = await readRepricedSelection(
      searchId,
      itineraryId,
      principal
    );
  } catch (error) {
    if (error instanceof SearchReferenceStoreError) {
      throw referenceFailure(error, 'read');
    }
    throw error;
  }
  const expectedSelectionVersion =
    currentSelection?.quoteStoreVersion &&
    Number.isInteger(currentSelection.quoteStoreVersion) &&
    currentSelection.quoteStoreVersion > 0
      ? currentSelection.quoteStoreVersion
      : 0;

  const rulesPromise = activeMarkupRulesFor(audience);
  const call = await triploverCall('RePrice', '/api/Reprice', {
    uniqueTransID: search.uniqueTransId,
    itemCodeRef: refs.itemCodeRef,
    segmentCodeRefs: refs.segmentCodeRefs,
    taxRedemptions: [],
    commissionOnTaxes: [],
    brandedFareRefs: '',
  }, { supplier: search.supplierAccount });
  const rulesResult = await rulesPromise;

  const response = (call.data ?? {}) as RawReprice;
  if (
    !finiteMoney(response.totalPrice) ||
    !finiteMoney(response.basePrice) ||
    !finiteMoney(response.taxes) ||
    typeof response.priceCodeRef !== 'string' ||
    response.priceCodeRef.length === 0
  ) {
    throw new TriploverError(
      'protocol',
      'Triplover RePrice returned an incomplete price.'
    );
  }
  const supplierReturnedDirections = Array.isArray(response.directions);
  const matchesSelectedItinerary = supplierReturnedDirections
    ? repriceMatchesSelectedItinerary(response, refs.selection)
    : false;
  // Every returned itinerary shape is verified, not just grouped
  // alternatives. Alternatives additionally require the supplier to return a
  // match at all, because a shared item ref alone is insufficient proof.
  if (
    (supplierReturnedDirections && !matchesSelectedItinerary) ||
    (refs.alternativeSelection === true && !matchesSelectedItinerary)
  ) {
    throw new FlightRepriceError(
      'SELECTION_MISMATCH',
      409,
      'The airline could not confirm the selected flight. Choose another option or search again.'
    );
  }

  const fares = mapFares(response, refs.context.passengerCounts);
  const ait = resolveAit(response, fares);
  const selectedRules = selectMarkupRules(
    rulesResult.rules,
    audience,
    refs.context.carrierCode,
    refs.context.routes
  );
  const priced = priceOffer({
    audience,
    rulesAvailable: rulesResult.ok,
    rules: selectedRules,
    supplierTotalPrice: response.totalPrice,
    basePrice: response.basePrice,
    taxes: response.taxes,
    ait,
    fares,
    passengerCount: refs.context.passengerCount,
  });

  const repricedAt = new Date().toISOString();
  const uniqueTransId =
    response.uniqueTransID || call.uniqueTransId || search.uniqueTransId;
  const itemCodeRef = response.itemCodeRef || refs.itemCodeRef;
  const previousTotalPrice = refs.pricing.sellingPrice;
  const supplierPriceChanged =
    response.isPriceChanged === true ||
    changed(response.totalPrice, refs.pricing.supplierTotalPrice);
  const sellingPriceChanged = changed(
    priced.totalPrice,
    previousTotalPrice
  );
  const requiresConfirmation = supplierPriceChanged || sellingPriceChanged;
  const currency =
    typeof response.currency === 'string' && response.currency.length > 0
      ? response.currency
      : 'BDT';
  const bookable = response.bookable !== false;

  let saved: boolean;
  try {
    saved = await storeRepricedSelection(
      searchId,
      itineraryId,
      {
        uniqueTransId,
        itemCodeRef,
        priceCodeRef: response.priceCodeRef,
        pricing: priced.snapshot,
        fares: priced.fares,
        currency,
        bookable,
        requiresConfirmation,
        repricedAt,
      },
      principal,
      expectedSelectionVersion
    );
  } catch (error) {
    if (error instanceof SearchReferenceStoreError) {
      throw referenceFailure(error, 'persist');
    }
    throw error;
  }
  if (!saved) {
    throw new FlightRepriceError(
      'SEARCH_EXPIRED',
      410,
      'This fare search has expired. Run the search again.'
    );
  }

  return {
    itineraryId,
    currency,
    previousTotalPrice,
    totalPrice: priced.totalPrice,
    priceDifference:
      Math.round((priced.totalPrice - previousTotalPrice) * 100) / 100,
    basePrice: priced.basePrice,
    taxes: priced.taxes,
    ait: priced.ait,
    serviceMargin: priced.serviceMargin,
    fares: priced.fares,
    bookable,
    fareClass: liveFareClass(response),
    supplierPriceChanged,
    sellingPriceChanged,
    requiresConfirmation,
    repricedAt,
  };
}
