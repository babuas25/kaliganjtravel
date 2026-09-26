import 'server-only';

import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { createClient } from 'redis';
import { deflateRawSync, inflateRawSync } from 'zlib';

import type { BookedItinerary } from '@/lib/flights/booking';
import {
  samePricingPrincipal,
  type PricingPrincipal,
} from '@/lib/flights/pricing-principal';
import type {
  FlightSearchTraceEvent,
  FlightSearchTraceObserver,
} from '@/lib/flights/search-trace';
import type {
  FareBreakdown,
  ItineraryLeg,
  ItinerarySegment,
  SearchRoute,
} from '@/lib/flights/types';
import type { PricingSnapshot } from '@/lib/markup';
import { isFlightReadSupplier, type FlightReadSupplier } from '@/lib/flights/supplier';

/**
 * Shared Redis authority for the short-lived supplier reference graph.
 *
 * A browser receives only our random search id and public itinerary ids. The
 * supplier transaction, item, segment, and RePrice references live only in a
 * Redis Cloud key with the quote's original absolute expiry. Process memory is
 * intentionally not a quote authority or fallback.
 */

// v4 removes full public itinerary copies from the private Redis graph and
// stores the immutable graph as compressed canonical JSON. It also defines
// supplier-omitted terminal fields as explicit nulls in the signed public
// snapshot. A namespace bump prevents a rolling deploy from interpreting an
// older quote under the changed integrity contract.
const QUOTE_KEY_PREFIX = 'flight:quote:v4:';
const QUOTE_SCHEMA_VERSION = 4;
// New writes use binary deflate instead of Base64. Keep the legacy text decoder
// for quotes written by the previous deployment until their 20-minute TTL ends.
const QUOTE_BINARY_PREFIX = Buffer.from('b:', 'ascii');
const QUOTE_LEGACY_PREFIX = 'z:';
const DEFAULT_QUOTE_TTL_SECONDS = 20 * 60;
const MAX_QUOTE_TTL_SECONDS = 20 * 60;
const DEFAULT_QUOTE_MAX_BYTES = 256 * 1024;
const MAX_QUOTE_INFLATED_BYTES = 2 * 1024 * 1024;
const REDIS_COMMAND_TIMEOUT_MS = 1_500;
const REDIS_RECOVERY_TOTAL_TIMEOUT_MS = 4_000;

export type SearchPricingContext = {
  carrierCode: string;
  routes: SearchRoute[];
  passengerCounts: Record<string, number>;
  passengerCount: number;
};

/** Only the two original-Search prices RePrice needs for its comparison. */
export type SearchQuotePricing = Pick<
  PricingSnapshot,
  'supplierTotalPrice' | 'sellingPrice'
>;

/**
 * The immutable flight identity RePrice must echo for a chosen option. This is
 * deliberately much smaller than the public booking itinerary: it contains
 * every field needed to prove the returned journey is the selected journey,
 * but none of the display-only text duplicated across hundreds of fares.
 */
export type ItinerarySelectionSignature = {
  legs: Array<{
    segments: Array<{
      from: string;
      to: string;
      departure: string;
      arrival: string;
      airlineCode: string;
      flightNumber: string;
    }>;
  }>;
};

export type RepricedSelection = {
  uniqueTransId: string;
  itemCodeRef: string;
  priceCodeRef: string;
  pricing: PricingSnapshot;
  /** Verified per-passenger-type money, carried into the booking draft. */
  fares: FareBreakdown[];
  currency: string;
  bookable: boolean;
  requiresConfirmation: boolean;
  repricedAt: string;
  /** Server-derived identity allowed to prepare this exact live price. */
  principal: PricingPrincipal;
  /** Internal per-principal CAS revision. Never sent to the browser. */
  quoteStoreVersion?: number;
  /** Internal idempotency digest. Never sent to the browser. */
  quoteStoreDigest?: string;
};

/** The private reference set one itinerary option needs. */
export type ItineraryRefs = {
  itemCodeRef: string;
  /** Flattened across every requested route in route order. */
  segmentCodeRefs: string[];
  /** Such a selection cannot be repriced unambiguously yet. */
  ambiguousSelection: boolean;
  /**
   * Search grouped alternate directions under one item reference. This remains
   * selectable only when its own segment-reference vector is complete, and
   * RePrice must echo the exact displayed itinerary before Book can use its
   * resulting price reference.
   */
  alternativeSelection?: boolean;
  /** Inputs required to select and recalculate the rule after RePrice. */
  context: SearchPricingContext;
  /** Minimal commercial Search quote needed before the live RePrice replaces it. */
  pricing: SearchQuotePricing;
  /**
   * The minimal supplier itinerary identity RePrice must echo. It is stored
   * independently of public display fields so a large Search remains within
   * the Redis quote budget without weakening selection verification.
   */
  selection: ItinerarySelectionSignature;
  /**
   * SHA-256 of the complete public BookedItinerary issued in the Search
   * result. Prepare accepts a browser-supplied snapshot only when it hashes
   * exactly to this Redis-authoritative value.
   */
  bookingSnapshotDigest: string;
};

export type StoredSearch = {
  /** Redis accepted this quote graph before it was exposed. */
  durableConfirmed: true;
  /** Credential account fixed when the supplier Search request was sent. */
  supplierAccount: FlightReadSupplier;
  uniqueTransId: string;
  refsByItineraryId: Map<string, ItineraryRefs>;
  expiresAt: number;
  /** Monotonic quote revision for observability and future migrations. */
  quoteVersion: number;
};

type SerializedRefs = Record<string, ItineraryRefs>;

type SearchCandidate = {
  searchId: string;
  supplierAccount: FlightReadSupplier;
  uniqueTransId: string;
  itineraryRefs: SerializedRefs;
  expiresAt: number;
};

/**
 * Redis stores only the private capability graph and the immutable flight
 * signature needed to RePrice it. The browser already has the public display
 * itinerary from Search; Prepare hashes and verifies that snapshot before it
 * becomes a permanent booking_attempts record. This prevents a large Search
 * from duplicating public itinerary text in Redis.
 */
type CompactSearchContext = {
  /** routes: [origin, destination, departureDate][] */
  r: [string, string, string][];
  /** passenger counts: [type, count][] */
  p: [string, number][];
  /** total passenger count */
  n: number;
};

/** Inline immutable string or index into the quote-level string dictionary. */
type CompactStoredString = string | number;

type CompactSelectionSegment = [
  CompactStoredString,
  CompactStoredString,
  CompactStoredString,
  CompactStoredString,
  CompactStoredString,
  CompactStoredString,
];

/** One selected requested route, containing its ordered flight segments. */
type CompactSelectionLeg = CompactSelectionSegment[];
type CompactSelectionItinerary = CompactSelectionLeg[];
type CompactSupplierReference = CompactStoredString;

type CompactItineraryRefs = {
  /** itemCodeRef */
  i: CompactSupplierReference;
  /** ordered segmentCodeRefs */
  s: CompactSupplierReference[];
  /** carrierCode used for markup selection */
  c: CompactStoredString;
  /** [supplierTotalPrice, sellingPrice] */
  p: [number, number];
  /** index into the quote-level immutable RePrice-match signature pool */
  t: number;
  /** SHA-256 digest of the public BookedItinerary supplied later to Prepare. */
  d: CompactStoredString;
  /** true only for an alternative selection */
  a?: 1;
};

type RedisQuotePayload = {
  /** schemaVersion */
  v: number;
  /** quoteVersion */
  q: number;
  /** searchId */
  i: string;
  /** supplierAccount */
  a: FlightReadSupplier;
  /** uniqueTransId */
  u: string;
  /** immutable absolute expiry, checked by the application */
  e: number;
  /** shared Search context */
  c: CompactSearchContext;
  /** de-duplicated, minimal RePrice-match signatures */
  t: CompactSelectionItinerary[];
  /** Repeated immutable strings, indexed from the compact records/signatures. */
  h?: string[];
  /** refs indexed by public itinerary id */
  r: Record<string, CompactItineraryRefs>;
};

type QuoteStoreConfig = {
  ttlMs: number;
  maxBytes: number;
};

export type SearchReferenceStoreErrorKind =
  | 'unavailable'
  | 'integrity'
  | 'conflict';

/**
 * A private-reference failure is intentionally distinct from supplier errors.
 * Callers must never retry Search/RePrice/Book because Redis persistence or
 * retrieval was uncertain.
 */
export class SearchReferenceStoreError extends Error {
  readonly kind: SearchReferenceStoreErrorKind;
  readonly retryable: boolean;

  constructor(kind: SearchReferenceStoreErrorKind, message: string) {
    super(message);
    this.name = 'SearchReferenceStoreError';
    this.kind = kind;
    this.retryable = kind === 'unavailable';
  }
}

/** The quote is valid, but its complete reference graph cannot fit in one Redis value. */
export class SearchQuoteTooLargeError extends SearchReferenceStoreError {
  constructor() {
    super('integrity', 'Search reference graph exceeds the configured Redis quote limit.');
    this.name = 'SearchQuoteTooLargeError';
  }
}

export type SearchReadOptions = {
  /**
   * Retained for callers during the migration. Redis is authoritative for both
   * modes; there is intentionally no process-memory quote cache.
   */
  consistency?: 'cache' | 'durable';
};

export type SearchPersistenceTiming = {
  redisPersistenceMs: number | null;
  redisPersistenceOutcome: 'success' | 'failed' | 'skipped';
};

export type StoredSearchWrite = {
  searchId: string;
  timing: SearchPersistenceTiming;
};

export type RedisFlightQuoteClient = {
  set(
    key: string,
    value: string | Buffer,
    options: { NX?: true; PX?: number }
  ): Promise<string | null>;
  get(key: string): Promise<string | Buffer | null>;
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] }
  ): Promise<unknown>;
};

export type RedisFlightQuoteStore = {
  storeSearch(
    uniqueTransId: string,
    refsByItineraryId: Map<string, ItineraryRefs>,
    supplierAccount: FlightReadSupplier,
    options?: { trace?: FlightSearchTraceObserver; searchId?: string }
  ): Promise<StoredSearchWrite>;
  readSearch(searchId: string, options?: SearchReadOptions): Promise<StoredSearch | null>;
  readRepricedSelection(
    searchId: string,
    itineraryId: string,
    principal: PricingPrincipal
  ): Promise<RepricedSelection | null>;
  storeRepricedSelection(
    searchId: string,
    itineraryId: string,
    reprice: Omit<RepricedSelection, 'principal' | 'quoteStoreVersion' | 'quoteStoreDigest'>,
    principal: PricingPrincipal,
    expectedSelectionVersion: number
  ): Promise<boolean>;
};

export type RedisFlightQuoteStoreOptions = {
  client: RedisFlightQuoteClient;
  ttlSeconds?: number;
  maxBytes?: number;
  now?: () => number;
  createSearchId?: () => string;
};

function nonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function serializeRefs(refs: Map<string, ItineraryRefs>): SerializedRefs {
  const serialized: SerializedRefs = {};
  refs.forEach((value, key) => {
    serialized[key] = value;
  });
  return serialized;
}

function compactContext(context: SearchPricingContext): CompactSearchContext {
  return {
    r: context.routes.map((route) => [
      route.origin,
      route.destination,
      route.departureDate,
    ]),
    p: Object.entries(context.passengerCounts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => [type, count]),
    n: context.passengerCount,
  };
}

/**
 * Builds the exact journey identity RePrice must echo, without retaining the
 * public-only airport names, baggage, equipment, cabin labels, terminals, or
 * seat counts in Redis.
 */
export function selectionSignatureForItinerary(
  itinerary: Pick<BookedItinerary, 'legs'>
): ItinerarySelectionSignature {
  return {
    legs: itinerary.legs.map((leg) => ({
      segments: leg.segments.map((segment) => ({
        from: segment.from,
        to: segment.to,
        departure: segment.departure,
        arrival: segment.arrival,
        airlineCode: segment.airlineCode,
        flightNumber: segment.flightNumber,
      })),
    })),
  };
}

/** A compact array representation of the immutable RePrice-match signature. */
function compactSelectionSignature(
  selection: ItinerarySelectionSignature
): CompactSelectionItinerary {
  return selection.legs.map((leg) =>
    leg.segments.map((segment) => [
      segment.from,
      segment.to,
      segment.departure,
      segment.arrival,
      segment.airlineCode,
      segment.flightNumber,
    ])
  );
}

/**
 * The browser can carry display data, but it cannot author it. This digest is
 * emitted only after Redis persistence and later binds the supplied snapshot
 * to the exact Search option that produced the private supplier references.
 */
export function bookingSnapshotDigestFor(
  itinerary: BookedItinerary
): string {
  const canonical = canonicalBookingSnapshot(itinerary);
  if (!canonical) {
    throw new SearchReferenceStoreError(
      'integrity',
      'Search attempted to hash an invalid public booking snapshot.'
    );
  }
  return createHash('sha256')
    .update(canonicalJson(canonical), 'utf8')
    .digest('base64url');
}

function compactReferenceGraph(refs: Map<string, ItineraryRefs>): {
  context: CompactSearchContext;
  itineraries: CompactSelectionItinerary[];
  repeatedStrings: string[];
  refs: Record<string, CompactItineraryRefs>;
} | null {
  let sharedContext: CompactSearchContext | null = null;
  const compact: Record<string, CompactItineraryRefs> = {};
  const itineraries: CompactSelectionItinerary[] = [];
  const itineraryIndexes = new Map<string, number>();
  let valid = true;

  refs.forEach((value, itineraryId) => {
    if (!valid) {
      valid = false;
      return;
    }
    const context = compactContext(value.context);
    if (
      sharedContext &&
      canonicalJson(sharedContext) !== canonicalJson(context)
    ) {
      // Search input is shared by every fare. A mismatch would make the
      // compact graph ambiguous, so reject it rather than picking one.
      valid = false;
      return;
    }
    sharedContext ??= context;
    const compactItineraryValue = compactSelectionSignature(value.selection);
    const itineraryIdentity = canonicalJson(compactItineraryValue);
    let itineraryIndex = itineraryIndexes.get(itineraryIdentity);
    if (itineraryIndex === undefined) {
      itineraryIndex = itineraries.length;
      itineraries.push(compactItineraryValue);
      itineraryIndexes.set(itineraryIdentity, itineraryIndex);
    }
    compact[itineraryId] = {
      i: value.itemCodeRef,
      s: value.segmentCodeRefs,
      c: value.context.carrierCode,
      p: [value.pricing.supplierTotalPrice, value.pricing.sellingPrice],
      t: itineraryIndex,
      d: value.bookingSnapshotDigest,
      ...(value.alternativeSelection ? { a: 1 as const } : {}),
    };
  });

  if (!valid) return null;

  // Index every repeated immutable string in the server-only graph: opaque
  // refs, RePrice-match signatures, carrier codes, and snapshot digests. This
  // is lossless: a unique string stays inline, so a dictionary can never make
  // a sparse quote larger merely for its own metadata.
  const stringCounts = new Map<string, number>();
  const count = (value: string): void => {
    stringCounts.set(value, (stringCounts.get(value) ?? 0) + 1);
  };
  itineraries.forEach((itinerary) => {
    itinerary.forEach((leg) => {
      leg.forEach((segment) => segment.forEach((value) => count(value as string)));
    });
  });
  Object.values(compact).forEach((value) => {
    count(value.i as string);
    value.s.forEach((reference) => count(reference as string));
    count(value.c as string);
    count(value.d as string);
  });
  const repeatedStrings = Array.from(stringCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
  const repeatedStringIndexes = new Map(
    repeatedStrings.map((value, index) => [value, index])
  );
  const compactString = (value: string): CompactStoredString =>
    repeatedStringIndexes.get(value) ?? value;

  itineraries.forEach((itinerary) => {
    itinerary.forEach((leg) => {
      leg.forEach((segment) => {
        for (let index = 0; index < segment.length; index += 1) {
          segment[index] = compactString(segment[index] as string);
        }
      });
    });
  });
  Object.values(compact).forEach((value) => {
    value.i = compactString(value.i as string);
    value.s = value.s.map((reference) => compactString(reference as string));
    value.c = compactString(value.c as string);
    value.d = compactString(value.d as string);
  });

  return {
    context: sharedContext ?? { r: [], p: [], n: 0 },
    itineraries,
    repeatedStrings,
    refs: compact,
  };
}

function validPricingContext(value: unknown): value is SearchPricingContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const context = value as Partial<SearchPricingContext>;
  return (
    typeof context.carrierCode === 'string' &&
    Array.isArray(context.routes) &&
    context.passengerCounts !== null &&
    typeof context.passengerCounts === 'object' &&
    typeof context.passengerCount === 'number'
  );
}

function validPrincipal(value: unknown): value is PricingPrincipal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const principal = value as Partial<PricingPrincipal>;
  return (
    (typeof principal.userId === 'string' || principal.userId === null) &&
    (principal.audience === 'b2c' ||
      principal.audience === 'agency' ||
      principal.audience === 'superadmin') &&
    (typeof principal.agencyCode === 'string' || principal.agencyCode === null) &&
    (principal.audience === 'agency'
      ? Boolean(principal.agencyCode)
      : principal.agencyCode === null)
  );
}

function validRepricedSelection(value: unknown): value is RepricedSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const selection = value as Partial<RepricedSelection>;
  return (
    nonEmptyText(selection.uniqueTransId) &&
    nonEmptyText(selection.itemCodeRef) &&
    nonEmptyText(selection.priceCodeRef) &&
    Boolean(selection.pricing) &&
    typeof selection.pricing === 'object' &&
    Array.isArray(selection.fares) &&
    nonEmptyText(selection.currency) &&
    typeof selection.bookable === 'boolean' &&
    typeof selection.requiresConfirmation === 'boolean' &&
    nonEmptyText(selection.repricedAt) &&
    validPrincipal(selection.principal) &&
    (selection.quoteStoreVersion === undefined ||
      positiveInteger(selection.quoteStoreVersion)) &&
    (selection.quoteStoreDigest === undefined ||
      /^[0-9a-f]{64}$/.test(selection.quoteStoreDigest))
  );
}

/** A selectable itinerary needs a complete, ordered, one-to-one ref vector. */
function validSegmentReferenceVector(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const normalized = value.map((reference) =>
    typeof reference === 'string' ? reference.trim() : ''
  );
  return (
    normalized.every((reference) => reference.length > 0) &&
    new Set(normalized).size === normalized.length
  );
}

function validSelectionSignature(
  value: unknown
): value is ItinerarySelectionSignature {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const legs = (value as { legs?: unknown }).legs;
  if (!Array.isArray(legs) || legs.length === 0) return false;

  return legs.every((leg) => {
    if (!leg || typeof leg !== 'object' || Array.isArray(leg)) return false;
    const segments = (leg as { segments?: unknown }).segments;
    return (
      Array.isArray(segments) &&
      segments.length > 0 &&
      segments.every((segment) => {
        if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
          return false;
        }
        const candidate = segment as Record<string, unknown>;
        return (
          nonEmptyText(candidate.from) &&
          nonEmptyText(candidate.to) &&
          nonEmptyText(candidate.departure) &&
          nonEmptyText(candidate.arrival) &&
          typeof candidate.airlineCode === 'string' &&
          typeof candidate.flightNumber === 'string'
        );
      })
    );
  });
}

function displayedSegmentCount(value: ItinerarySelectionSignature): number {
  return value.legs.reduce((count, leg) => count + leg.segments.length, 0);
}

function hasCompleteSelectableReferences(refs: ItineraryRefs): boolean {
  if (refs.ambiguousSelection) return true;
  return (
    nonEmptyText(refs.itemCodeRef) &&
    validSegmentReferenceVector(refs.segmentCodeRefs) &&
    validSelectionSignature(refs.selection) &&
    /^[A-Za-z0-9_-]{43}$/.test(refs.bookingSnapshotDigest) &&
    refs.segmentCodeRefs.length === displayedSegmentCount(refs.selection)
  );
}

function nullableStringValue(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One strict, shared representation for the public itinerary carried through
 * Search, RePrice and Prepare.  The supplier does not always send terminals;
 * absence is canonically represented as null.  Every other field must be
 * present and no additional browser-provided fields are accepted, so this
 * normalisation cannot hide a tampered snapshot.
 */
export function canonicalBookingSnapshot(
  value: unknown
): BookedItinerary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const allowedRootKeys = new Set(['carrierCode', 'carrierName', 'refundable', 'codeshare', 'legs']);
  if (
    !Object.keys(candidate).every((key) => allowedRootKeys.has(key)) ||
    typeof candidate.carrierCode !== 'string' ||
    typeof candidate.carrierName !== 'string' ||
    typeof candidate.refundable !== 'boolean' ||
    (candidate.codeshare !== undefined && typeof candidate.codeshare !== 'boolean') ||
    !Array.isArray(candidate.legs) ||
    candidate.legs.length === 0
  ) {
    return null;
  }

  const legs: ItineraryLeg[] = [];
  const allowedLegKeys = new Set([
    'from',
    'to',
    'stops',
    'segments',
    'duration',
    'departure',
    'arrival',
  ]);
  const allowedSegmentKeys = new Set([
    'from',
    'fromAirport',
    'to',
    'toAirport',
    'departureTerminal',
    'arrivalTerminal',
    'departure',
    'arrival',
    'airline',
    'airlineCode',
    'operatingCarrierCode',
    'codeshare',
    'flightNumber',
    'cabinClass',
    'bookingClass',
    'duration',
    'aircraft',
    'baggage',
    'handBaggage',
    'seatsLeft',
  ]);

  for (const leg of candidate.legs) {
    if (!leg || typeof leg !== 'object' || Array.isArray(leg)) return null;
    const item = leg as Record<string, unknown>;
    const duration = nullableStringValue(item.duration);
    if (
      !Object.keys(item).every((key) => allowedLegKeys.has(key)) ||
      !nonEmptyText(item.from) ||
      !nonEmptyText(item.to) ||
      !nonNegativeInteger(item.stops) ||
      duration === undefined ||
      !nonEmptyText(item.departure) ||
      !nonEmptyText(item.arrival) ||
      !Array.isArray(item.segments) ||
      item.segments.length === 0
    ) {
      return null;
    }
    const segments: ItinerarySegment[] = [];
    for (const segment of item.segments) {
      if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
        return null;
      }
      const record = segment as Record<string, unknown>;
      const departureTerminal = nullableStringValue(record.departureTerminal);
      const arrivalTerminal = nullableStringValue(record.arrivalTerminal);
      const segmentDuration = nullableStringValue(record.duration);
      const aircraft = nullableStringValue(record.aircraft);
      const baggage = nullableStringValue(record.baggage);
      const handBaggage = nullableStringValue(record.handBaggage);
      if (
        !Object.keys(record).every((key) => allowedSegmentKeys.has(key)) ||
        !nonEmptyText(record.from) ||
        !nonEmptyText(record.fromAirport) ||
        !nonEmptyText(record.to) ||
        !nonEmptyText(record.toAirport) ||
        !nonEmptyText(record.departure) ||
        !nonEmptyText(record.arrival) ||
        typeof record.airline !== 'string' ||
        typeof record.airlineCode !== 'string' ||
        (record.operatingCarrierCode !== undefined && record.operatingCarrierCode !== null &&
          (typeof record.operatingCarrierCode !== 'string' || !/^[A-Z0-9]{2}$/.test(record.operatingCarrierCode))) ||
        (record.codeshare !== undefined && record.codeshare !== null && typeof record.codeshare !== 'boolean') ||
        typeof record.flightNumber !== 'string' ||
        typeof record.cabinClass !== 'string' ||
        typeof record.bookingClass !== 'string' ||
        // `undefined` means a malformed explicitly supplied field for every
        // nullable property except terminals.  Their absence is canonical null.
        segmentDuration === undefined ||
        aircraft === undefined ||
        baggage === undefined ||
        handBaggage === undefined ||
        (record.seatsLeft !== null && finiteNumber(record.seatsLeft) === null) ||
        (Object.prototype.hasOwnProperty.call(record, 'departureTerminal') && departureTerminal === undefined) ||
        (Object.prototype.hasOwnProperty.call(record, 'arrivalTerminal') && arrivalTerminal === undefined)
      ) {
        return null;
      }
      segments.push({
        from: record.from,
        fromAirport: record.fromAirport,
        to: record.to,
        toAirport: record.toAirport,
        departureTerminal: departureTerminal ?? null,
        arrivalTerminal: arrivalTerminal ?? null,
        departure: record.departure,
        arrival: record.arrival,
        airline: record.airline,
        airlineCode: record.airlineCode,
        ...(record.operatingCarrierCode !== undefined ? { operatingCarrierCode: record.operatingCarrierCode as string | null } : {}),
        ...(record.codeshare !== undefined ? { codeshare: record.codeshare as boolean | null } : {}),
        flightNumber: record.flightNumber,
        cabinClass: record.cabinClass,
        bookingClass: record.bookingClass,
        duration: segmentDuration,
        aircraft,
        baggage,
        handBaggage,
        seatsLeft: record.seatsLeft as number | null,
      });
    }
    legs.push({
      from: item.from,
      to: item.to,
      stops: item.stops,
      segments,
      duration,
      departure: item.departure,
      arrival: item.arrival,
    });
  }

  return {
    carrierCode: candidate.carrierCode,
    carrierName: candidate.carrierName,
    refundable: candidate.refundable,
    ...(candidate.codeshare !== undefined ? { codeshare: candidate.codeshare as boolean } : {}),
    legs,
  };
}

export type BookingSnapshotVerification =
  | 'match'
  | 'invalid_shape'
  | 'digest_mismatch';

/**
 * Verifies the browser's public snapshot without ever exposing a digest or a
 * supplier reference. Callers may log this state to distinguish malformed
 * display data from a genuine integrity mismatch.
 */
export function verifyBookingSnapshot(
  refs: ItineraryRefs,
  value: unknown
): BookingSnapshotVerification {
  const canonical = canonicalBookingSnapshot(value);
  if (!canonical) return 'invalid_shape';
  const expected = Buffer.from(refs.bookingSnapshotDigest, 'utf8');
  const actual = Buffer.from(bookingSnapshotDigestFor(canonical), 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual)
    ? 'match'
    : 'digest_mismatch';
}

/** The Prepare boundary accepts only the exact public Search snapshot. */
export function matchesBookingSnapshot(
  refs: ItineraryRefs,
  value: unknown
): value is BookedItinerary {
  return verifyBookingSnapshot(refs, value) === 'match';
}

function hydrateCompactContext(value: unknown): CompactSearchContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<CompactSearchContext>;
  if (!Array.isArray(candidate.r) || !Array.isArray(candidate.p) || !nonNegativeInteger(candidate.n)) {
    return null;
  }
  const routes: [string, string, string][] = [];
  for (const route of candidate.r) {
    if (
      !Array.isArray(route) ||
      route.length !== 3 ||
      !nonEmptyText(route[0]) ||
      !nonEmptyText(route[1]) ||
      !nonEmptyText(route[2])
    ) {
      return null;
    }
    routes.push([route[0], route[1], route[2]]);
  }
  const passengerCounts: [string, number][] = [];
  for (const passenger of candidate.p) {
    if (
      !Array.isArray(passenger) ||
      passenger.length !== 2 ||
      !nonEmptyText(passenger[0]) ||
      !nonNegativeInteger(passenger[1])
    ) {
      return null;
    }
    passengerCounts.push([passenger[0], passenger[1]]);
  }
  return { r: routes, p: passengerCounts, n: candidate.n };
}

function hydrateCompactSelectionSegment(
  value: unknown,
  dictionary: readonly string[]
): ItinerarySelectionSignature['legs'][number]['segments'][number] | null {
  if (!Array.isArray(value) || value.length !== 6) return null;
  const [rawFrom, rawTo, rawDeparture, rawArrival, rawAirlineCode, rawFlightNumber] = value;
  const from = hydrateStoredString(rawFrom, dictionary);
  const to = hydrateStoredString(rawTo, dictionary);
  const departure = hydrateStoredString(rawDeparture, dictionary);
  const arrival = hydrateStoredString(rawArrival, dictionary);
  const airlineCode = hydrateStoredString(rawAirlineCode, dictionary);
  const flightNumber = hydrateStoredString(rawFlightNumber, dictionary);
  if (
    !nonEmptyText(from) ||
    !nonEmptyText(to) ||
    !nonEmptyText(departure) ||
    !nonEmptyText(arrival) ||
    typeof airlineCode !== 'string' ||
    typeof flightNumber !== 'string'
  ) {
    return null;
  }
  return { from, to, departure, arrival, airlineCode, flightNumber };
}

function hydrateCompactSelection(
  value: unknown,
  dictionary: readonly string[]
): ItinerarySelectionSignature | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const legs: ItinerarySelectionSignature['legs'] = [];
  for (const rawLeg of value) {
    if (!Array.isArray(rawLeg) || rawLeg.length === 0) return null;
    const segments = rawLeg.map((segment) =>
      hydrateCompactSelectionSegment(segment, dictionary)
    );
    if (segments.some((segment) => segment === null)) return null;
    legs.push({
      segments: segments as ItinerarySelectionSignature['legs'][number]['segments'],
    });
  }
  const selection = { legs };
  return validSelectionSignature(selection) ? selection : null;
}

function hydrateReferenceDictionary(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(nonEmptyText)) return null;
  return value;
}

function hydrateStoredString(
  value: unknown,
  dictionary: readonly string[]
): string | null {
  if (typeof value === 'string') return value;
  if (!nonNegativeInteger(value)) return null;
  return dictionary[value] ?? null;
}

function hydrateCompactRefs(
  value: unknown,
  compactContext: CompactSearchContext,
  rawSelections: unknown,
  rawReferenceDictionary: unknown
): Map<string, ItineraryRefs> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Array.isArray(rawSelections)) return null;
  const referenceDictionary = hydrateReferenceDictionary(rawReferenceDictionary);
  if (!referenceDictionary) return null;
  const selections = rawSelections.map((selection) =>
    hydrateCompactSelection(selection, referenceDictionary)
  );
  if (selections.some((selection) => selection === null)) return null;
  const routes = compactContext.r.map(([origin, destination, departureDate]) => ({
    origin,
    destination,
    departureDate,
  }));
  const passengerCounts = Object.fromEntries(compactContext.p);
  const refs = new Map<string, ItineraryRefs>();

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const candidate = raw as Partial<CompactItineraryRefs>;
    if (
      !nonEmptyText(key) ||
      !Array.isArray(candidate.s) ||
      !Array.isArray(candidate.p) ||
      candidate.p.length !== 2 ||
      finiteNumber(candidate.p[0]) === null ||
      finiteNumber(candidate.p[1]) === null ||
      !nonNegativeInteger(candidate.t) ||
      !selections[candidate.t] ||
      (candidate.a !== undefined && candidate.a !== 1)
    ) {
      return null;
    }
    const carrierCode = hydrateStoredString(candidate.c, referenceDictionary);
    const bookingSnapshotDigest = hydrateStoredString(
      candidate.d,
      referenceDictionary
    );
    const itemCodeRef = hydrateStoredString(candidate.i, referenceDictionary);
    const segmentCodeRefs = candidate.s
      .map((reference) => hydrateStoredString(reference, referenceDictionary));
    if (
      !nonEmptyText(carrierCode) ||
      !bookingSnapshotDigest ||
      !/^[A-Za-z0-9_-]{43}$/.test(bookingSnapshotDigest) ||
      !nonEmptyText(itemCodeRef) ||
      segmentCodeRefs.some((reference) => !nonEmptyText(reference))
    ) {
      return null;
    }
    const selection = selections[candidate.t] as ItinerarySelectionSignature;
    const hydrated: ItineraryRefs = {
      itemCodeRef,
      segmentCodeRefs: segmentCodeRefs as string[],
      ambiguousSelection: false,
      alternativeSelection: candidate.a === 1,
      context: {
        carrierCode,
        routes,
        passengerCounts,
        passengerCount: compactContext.n,
      },
      pricing: {
        supplierTotalPrice: candidate.p[0],
        sellingPrice: candidate.p[1],
      },
      selection,
      bookingSnapshotDigest,
    };
    if (!hasCompleteSelectableReferences(hydrated)) return null;
    refs.set(key, hydrated);
  }
  return refs;
}

function canonicalJson(value: unknown): string {
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function quoteKey(searchId: string): string {
  // The hash tag keeps the immutable root and each mutable RePrice key in one
  // Redis Cluster slot, so the two-key Lua CAS remains atomic on Redis Cloud.
  return `${QUOTE_KEY_PREFIX}{${searchId}}`;
}

/** The mutable RePrice capability is intentionally separate from the immutable quote graph. */
function repriceKey(
  searchId: string,
  itineraryId: string,
  principalKey: string
): string {
  return `${quoteKey(searchId)}:reprice:${itineraryId}:${principalKey}`;
}

function encodeQuote(serialized: string): {
  value: Buffer;
  compressedBytes: number;
} {
  const compressed = deflateRawSync(Buffer.from(serialized, 'utf8'), {
    level: 9,
  });
  return {
    value: Buffer.concat([QUOTE_BINARY_PREFIX, compressed]),
    compressedBytes: compressed.byteLength,
  };
}

function decodeQuote(value: string | Buffer): string | null {
  try {
    const raw = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    let compressed: Buffer;
    if (raw.subarray(0, QUOTE_BINARY_PREFIX.length).equals(QUOTE_BINARY_PREFIX)) {
      compressed = raw.subarray(QUOTE_BINARY_PREFIX.length);
    } else if (
      raw.subarray(0, QUOTE_LEGACY_PREFIX.length).toString('ascii') ===
      QUOTE_LEGACY_PREFIX
    ) {
      compressed = Buffer.from(
        raw.subarray(QUOTE_LEGACY_PREFIX.length).toString('ascii'),
        'base64url'
      );
    } else {
      return null;
    }
    if (compressed.byteLength === 0) return null;
    return inflateRawSync(compressed, {
      maxOutputLength: MAX_QUOTE_INFLATED_BYTES,
    }).toString('utf8');
  } catch {
    return null;
  }
}

function parsePositiveEnv(name: string, fallback: number, maximum?: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || (maximum && parsed > maximum)) {
    throw new SearchReferenceStoreError(
      'unavailable',
      `${name} is not configured to a safe positive value.`
    );
  }
  return parsed;
}

function runtimeConfig(): QuoteStoreConfig {
  if (process.env.FLIGHT_QUOTE_STORE !== 'redis') {
    throw new SearchReferenceStoreError(
      'unavailable',
      'Shared Redis quote storage is not configured.'
    );
  }
  return {
    ttlMs:
      parsePositiveEnv(
        'FLIGHT_QUOTE_TTL_SECONDS',
        DEFAULT_QUOTE_TTL_SECONDS,
        MAX_QUOTE_TTL_SECONDS
      ) * 1_000,
    maxBytes: parsePositiveEnv(
      'FLIGHT_QUOTE_MAX_BYTES',
      DEFAULT_QUOTE_MAX_BYTES
    ),
  };
}

function testConfig(options: RedisFlightQuoteStoreOptions): QuoteStoreConfig {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_QUOTE_TTL_SECONDS;
  const maxBytes = options.maxBytes ?? DEFAULT_QUOTE_MAX_BYTES;
  if (!positiveInteger(ttlSeconds) || ttlSeconds > MAX_QUOTE_TTL_SECONDS) {
    throw new SearchReferenceStoreError('integrity', 'Invalid Redis quote TTL.');
  }
  if (!positiveInteger(maxBytes)) {
    throw new SearchReferenceStoreError('integrity', 'Invalid Redis quote size limit.');
  }
  return { ttlMs: ttlSeconds * 1_000, maxBytes };
}

function emitSearchTrace(
  observer: FlightSearchTraceObserver | undefined,
  event: FlightSearchTraceEvent
): void {
  try {
    observer?.(event);
  } catch {
    // Observability never changes Search or Redis persistence behavior.
  }
}

type RedisAttempt<T> =
  | { state: 'value'; value: T }
  | { state: 'timeout' }
  | { state: 'error' };

async function withRedisTimeout<T>(
  request: () => Promise<T>,
  timeoutMs = REDIS_COMMAND_TIMEOUT_MS
): Promise<RedisAttempt<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const result = await Promise.race([request(), timeout]);
    return result === 'timeout'
      ? { state: 'timeout' }
      : { state: 'value', value: result as T };
  } catch {
    return { state: 'error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateSearchCandidate(candidate: SearchCandidate, currentTime: number): void {
  if (!nonEmptyText(candidate.searchId)) {
    throw new SearchReferenceStoreError('integrity', 'Search id is invalid.');
  }
  if (!nonEmptyText(candidate.uniqueTransId)) {
    throw new SearchReferenceStoreError(
      'integrity',
      'Search returned no supplier transaction reference.'
    );
  }
  if (!isFlightReadSupplier(candidate.supplierAccount)) {
    throw new SearchReferenceStoreError(
      'integrity',
      'Search returned an invalid supplier account.'
    );
  }
  if (!Number.isFinite(candidate.expiresAt) || candidate.expiresAt <= currentTime) {
    throw new SearchReferenceStoreError(
      'integrity',
      'Search returned an invalid reference expiry.'
    );
  }
  for (const [itineraryId, refs] of Object.entries(candidate.itineraryRefs)) {
    if (
      !nonEmptyText(itineraryId) ||
      !nonEmptyText(refs.itemCodeRef) ||
      !hasCompleteSelectableReferences(refs)
    ) {
      throw new SearchReferenceStoreError(
        'integrity',
        'Search returned an incomplete fare reference.'
      );
    }
  }
}

function hydrateQuote(payload: unknown, now: number): StoredSearch | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const candidate = payload as Partial<RedisQuotePayload>;
  const schemaVersion = candidate.v;
  const quoteVersion = candidate.q;
  const searchId = candidate.i;
  const supplierAccount = candidate.a;
  const uniqueTransId = candidate.u;
  const expiresAt = candidate.e;
  const compactContext = hydrateCompactContext(candidate.c);
  const refsByItineraryId = compactContext
    ? hydrateCompactRefs(candidate.r, compactContext, candidate.t, candidate.h)
    : null;
  if (
    schemaVersion !== QUOTE_SCHEMA_VERSION ||
    !positiveInteger(quoteVersion) ||
    !nonEmptyText(searchId) ||
    !isFlightReadSupplier(supplierAccount) ||
    !nonEmptyText(uniqueTransId) ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    !refsByItineraryId
  ) {
    return null;
  }
  return {
    durableConfirmed: true,
    supplierAccount: supplierAccount.trim().toLowerCase() as FlightReadSupplier,
    uniqueTransId,
    refsByItineraryId,
    expiresAt,
    quoteVersion,
  };
}

function parseQuote(raw: string | Buffer, now: number): StoredSearch | null {
  try {
    const decoded = decodeQuote(raw);
    return decoded ? hydrateQuote(JSON.parse(decoded), now) : null;
  } catch {
    return null;
  }
}

function exactStoredCandidate(
  raw: string | Buffer | null,
  expected: Buffer
): 'match' | 'missing' | 'mismatch' {
  if (raw === null) return 'missing';
  return Buffer.isBuffer(raw) && raw.equals(expected) ? 'match' : 'mismatch';
}

function luaStatus(value: unknown): string {
  if (!Array.isArray(value) || typeof value[0] !== 'string') return '';
  return value[0];
}

const UPDATE_REPRICE_LUA = `
-- KEYS[1] = immutable compressed quote; KEYS[2] = one principal's live RePrice
-- selection. The root's TTL is authoritative and is copied without extension.
local rootTtl = redis.call('PTTL', KEYS[1])
if rootTtl <= 0 then return {'missing'} end

local expectedVersion = tonumber(ARGV[1])
local digest = ARGV[2]
local raw = redis.call('GET', KEYS[2])
if raw then
  local existingOk, existing = pcall(cjson.decode, raw)
  if not existingOk or type(existing) ~= 'table' then return {'invalid'} end
  if existing.quoteStoreDigest == digest then return {'replay'} end
  if tonumber(existing.quoteStoreVersion) ~= expectedVersion then return {'conflict'} end
elseif expectedVersion ~= 0 then
  return {'conflict'}
end

local candidateOk, candidate = pcall(cjson.decode, ARGV[3])
if not candidateOk or type(candidate) ~= 'table' then return {'invalid'} end
if string.len(ARGV[3]) > tonumber(ARGV[4]) then return {'oversized'} end
redis.call('SET', KEYS[2], ARGV[3], 'PX', rootTtl)
return {'updated', tostring(candidate.quoteStoreVersion)}
`;

function repriceMaterial(
  selection: Omit<RepricedSelection, 'quoteStoreVersion' | 'quoteStoreDigest'>
): string {
  return canonicalJson(selection);
}

function candidateReprice(
  reprice: Omit<RepricedSelection, 'principal' | 'quoteStoreVersion' | 'quoteStoreDigest'>,
  principal: PricingPrincipal,
  expectedSelectionVersion: number
): RepricedSelection {
  const base: Omit<RepricedSelection, 'quoteStoreVersion' | 'quoteStoreDigest'> = {
    ...reprice,
    principal,
  };
  const digest = sha256(repriceMaterial(base));
  return {
    ...base,
    quoteStoreVersion: expectedSelectionVersion + 1,
    quoteStoreDigest: digest,
  };
}

function validRepriceCandidate(candidate: RepricedSelection): boolean {
  return (
    validRepricedSelection(candidate) &&
    positiveInteger(candidate.quoteStoreVersion) &&
    nonEmptyText(candidate.quoteStoreDigest)
  );
}

function selectionVerification(
  raw: string | Buffer | null,
  principal: PricingPrincipal,
  digest: string
): 'match' | 'missing' | 'uncommitted' | 'mismatch' | 'invalid' {
  if (raw === null) return 'missing';
  const selection = parseRepricedSelection(raw, principal);
  if (!selection) return 'invalid';
  return selection.quoteStoreDigest === digest ? 'match' : 'mismatch';
}

function parseRepricedSelection(
  raw: string | Buffer,
  principal: PricingPrincipal
): RepricedSelection | null {
  try {
    const candidate: unknown = JSON.parse(
      Buffer.isBuffer(raw) ? raw.toString('utf8') : raw
    );
    return validRepricedSelection(candidate) &&
      samePricingPrincipal(candidate.principal, principal)
      ? candidate
      : null;
  } catch {
    return null;
  }
}

/** A non-reversible map key; raw user and agency ids never become Redis JSON keys. */
export function pricingPrincipalKey(principal: PricingPrincipal): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        principal.userId,
        principal.audience,
        principal.agencyCode,
      ]),
      'utf8'
    )
    .digest('hex');
}

/**
 * Injectable store factory used by the regression verifier. Runtime callers
 * use the same behavior through the Redis Cloud client below.
 */
export function createRedisFlightQuoteStore(
  options: RedisFlightQuoteStoreOptions
): RedisFlightQuoteStore {
  const config = testConfig(options);
  const now = options.now ?? Date.now;
  const createSearchId = options.createSearchId ?? randomUUID;

  const get = async (key: string): Promise<RedisAttempt<string | Buffer | null>> =>
    withRedisTimeout(() => options.client.get(key));

  const verifySearchWrite = async (
    key: string,
    serialized: Buffer
  ): Promise<'match' | 'missing' | 'mismatch' | 'unavailable'> => {
    const read = await get(key);
    if (read.state !== 'value') return 'unavailable';
    return exactStoredCandidate(read.value, serialized);
  };

  return {
    async storeSearch(uniqueTransId, refsByItineraryId, supplierAccount, writeOptions = {}) {
      const searchId = writeOptions.searchId ?? createSearchId();
      const expiresAt = now() + config.ttlMs;
      const candidate: SearchCandidate = {
        searchId,
        supplierAccount,
        uniqueTransId,
        itineraryRefs: serializeRefs(refsByItineraryId),
        expiresAt,
      };
      const trace = supplierAccount === 'takeoff' ? writeOptions.trace : undefined;
      emitSearchTrace(trace, {
        name: 'redis_reference_validation_start',
        details: { itineraryReferenceCount: refsByItineraryId.size },
      });
      validateSearchCandidate(candidate, now());
      emitSearchTrace(trace, { name: 'redis_reference_validation_complete' });
      const compactGraph = compactReferenceGraph(refsByItineraryId);
      if (!compactGraph) {
        throw new SearchReferenceStoreError(
          'integrity',
          'Search returned an invalid compact reference graph.'
        );
      }
      const payload: RedisQuotePayload = {
        v: QUOTE_SCHEMA_VERSION,
        q: 1,
        i: searchId,
        a: supplierAccount,
        u: uniqueTransId,
        e: expiresAt,
        c: compactGraph.context,
        t: compactGraph.itineraries,
        ...(compactGraph.repeatedStrings.length > 0
          ? { h: compactGraph.repeatedStrings }
          : {}),
        r: compactGraph.refs,
      };
      const serialized = canonicalJson(payload);
      const serializedBytes = Buffer.byteLength(serialized, 'utf8');
      const encoded = encodeQuote(serialized);
      const storedBytes = encoded.value.byteLength;
      const sectionBytes = {
        context: Buffer.byteLength(canonicalJson(compactGraph.context), 'utf8'),
        signatures: Buffer.byteLength(canonicalJson(compactGraph.itineraries), 'utf8'),
        dictionary: Buffer.byteLength(canonicalJson(compactGraph.repeatedStrings), 'utf8'),
        refs: Buffer.byteLength(canonicalJson(compactGraph.refs), 'utf8'),
      };
      emitSearchTrace(trace, {
        name: 'redis_quote_size_checked',
        details: {
          serializedBytes,
          compressedBytes: encoded.compressedBytes,
          storedBytes,
          maxBytes: config.maxBytes,
          signatureCount: compactGraph.itineraries.length,
          repeatedStringCount: compactGraph.repeatedStrings.length,
          sectionBytes: canonicalJson(sectionBytes),
        },
      });
      if (storedBytes > config.maxBytes || serializedBytes > MAX_QUOTE_INFLATED_BYTES) {
        throw new SearchQuoteTooLargeError();
      }

      emitSearchTrace(trace, { name: 'redis_persistence_start' });
      const startedAt = performance.now();
      const deadlineAt = now() + REDIS_RECOVERY_TOTAL_TIMEOUT_MS;
      let persisted = false;
      let conflict = false;
      let failure = false;

      const attemptSet = async (): Promise<void> => {
        const write = await withRedisTimeout(() =>
          options.client.set(quoteKey(searchId), encoded.value, {
            NX: true,
            // Use a relative TTL because the Redis Cloud and application
            // clocks need not agree exactly. `expiresAt` remains immutable in
            // the payload and is checked on every authoritative read.
            PX: config.ttlMs,
          })
        );
        if (write.state === 'value' && write.value === 'OK') {
          persisted = true;
          return;
        }
        if (write.state === 'value' && write.value !== null) {
          failure = true;
          return;
        }

        // A null SET result, a timeout, or a connection error can all leave
        // the outcome ambiguous. Verify the exact capability before one safe,
        // idempotent Redis-only retry. Supplier Search is never replayed.
        emitSearchTrace(trace, { name: 'redis_persistence_verify' });
        const verification = await verifySearchWrite(quoteKey(searchId), encoded.value);
        if (verification === 'match') {
          persisted = true;
        } else if (verification === 'mismatch') {
          conflict = true;
        } else if (verification === 'unavailable') {
          failure = true;
        }
      };

      await attemptSet();
      if (!persisted && !conflict && !failure && now() < deadlineAt) {
        emitSearchTrace(trace, { name: 'redis_persistence_retry' });
        await attemptSet();
      }

      const redisPersistenceMs = performance.now() - startedAt;
      if (!persisted) {
        emitSearchTrace(trace, {
          name: 'redis_persistence_failed',
          details: { outcome: conflict ? 'conflict' : 'unavailable' },
        });
        if (conflict) {
          throw new SearchReferenceStoreError(
            'conflict',
            'Redis search id conflicts with a different quote payload.'
          );
        }
        throw new SearchReferenceStoreError(
          'unavailable',
          'Redis could not confirm the Search reference graph.'
        );
      }

      emitSearchTrace(trace, {
        name: 'redis_persistence_confirmed',
        details: { redisPersistenceMs: Math.round(redisPersistenceMs * 100) / 100 },
      });
      return {
        searchId,
        timing: {
          redisPersistenceMs,
          redisPersistenceOutcome: 'success',
        },
      };
    },

    async readSearch(searchId) {
      if (!nonEmptyText(searchId)) {
        throw new SearchReferenceStoreError('integrity', 'Search id is invalid.');
      }
      const read = await get(quoteKey(searchId));
      if (read.state !== 'value') {
        throw new SearchReferenceStoreError(
          'unavailable',
          'Redis could not read the Search reference graph.'
        );
      }
      if (read.value === null) return null;
      const search = parseQuote(read.value, now());
      if (!search) {
        throw new SearchReferenceStoreError(
          'integrity',
          'Redis Search reference graph has an invalid shape.'
        );
      }
      return search;
    },

    async readRepricedSelection(searchId, itineraryId, principal) {
      if (!nonEmptyText(searchId) || !nonEmptyText(itineraryId)) {
        throw new SearchReferenceStoreError(
          'integrity',
          'RePrice reference read has invalid identifiers.'
        );
      }
      const read = await get(
        repriceKey(searchId, itineraryId, pricingPrincipalKey(principal))
      );
      if (read.state !== 'value') {
        throw new SearchReferenceStoreError(
          'unavailable',
          'Redis could not read the RePrice reference.'
        );
      }
      if (read.value === null) return null;
      const selection = parseRepricedSelection(read.value, principal);
      if (!selection) {
        throw new SearchReferenceStoreError(
          'integrity',
          'Redis RePrice reference has an invalid shape.'
        );
      }
      return selection;
    },

    async storeRepricedSelection(
      searchId,
      itineraryId,
      reprice,
      principal,
      expectedSelectionVersion
    ) {
      if (
        !nonEmptyText(searchId) ||
        !nonEmptyText(itineraryId) ||
        !nonNegativeInteger(expectedSelectionVersion)
      ) {
        throw new SearchReferenceStoreError(
          'integrity',
          'RePrice reference update has invalid identifiers.'
        );
      }
      const candidate = candidateReprice(
        reprice,
        principal,
        expectedSelectionVersion
      );
      if (!validRepriceCandidate(candidate)) {
        throw new SearchReferenceStoreError(
          'integrity',
          'RePrice returned an incomplete supplier reference.'
        );
      }
      const candidateJson = canonicalJson(candidate);
      const principalKey = pricingPrincipalKey(principal);
      const runUpdate = async (): Promise<RedisAttempt<unknown>> =>
        withRedisTimeout(() =>
          options.client.eval(UPDATE_REPRICE_LUA, {
            keys: [
              quoteKey(searchId),
              repriceKey(searchId, itineraryId, principalKey),
            ],
            arguments: [
              String(expectedSelectionVersion),
              candidate.quoteStoreDigest as string,
              candidateJson,
              String(config.maxBytes),
            ],
          })
        );

      const handleStatus = (status: string): 'saved' | 'retry' | 'missing' | 'conflict' | 'integrity' => {
        if (status === 'updated' || status === 'replay') return 'saved';
        if (status === 'missing') return 'missing';
        if (status === 'conflict') return 'conflict';
        if (status === 'oversized' || status === 'invalid') return 'integrity';
        return 'retry';
      };

      const verify = async (): Promise<'saved' | 'retry' | 'missing' | 'conflict' | 'integrity' | 'unavailable'> => {
        const read = await get(
          repriceKey(searchId, itineraryId, principalKey)
        );
        if (read.state !== 'value') return 'unavailable';
        const verified = selectionVerification(
          read.value,
          principal,
          candidate.quoteStoreDigest as string
        );
        if (verified === 'match') return 'saved';
        if (verified === 'missing') return 'missing';
        if (verified === 'mismatch') return 'conflict';
        if (verified === 'invalid') return 'integrity';
        return 'retry';
      };

      const deadlineAt = now() + REDIS_RECOVERY_TOTAL_TIMEOUT_MS;
      for (let attempt = 0; attempt < 2 && now() < deadlineAt; attempt += 1) {
        const write = await runUpdate();
        if (write.state === 'value') {
          const outcome = handleStatus(luaStatus(write.value));
          if (outcome === 'saved') return true;
          if (outcome === 'missing') return false;
          if (outcome === 'conflict') {
            throw new SearchReferenceStoreError(
              'conflict',
              'A newer RePrice selection already exists for this principal.'
            );
          }
          if (outcome === 'integrity') {
            throw new SearchReferenceStoreError(
              'integrity',
              'Redis rejected the RePrice reference graph.'
            );
          }
        }

        const verified = await verify();
        if (verified === 'saved') return true;
        if (verified === 'missing') return false;
        if (verified === 'conflict') {
          throw new SearchReferenceStoreError(
            'conflict',
            'A different RePrice selection already exists for this principal.'
          );
        }
        if (verified === 'integrity') {
          throw new SearchReferenceStoreError(
            'integrity',
            'Redis RePrice reference graph has an invalid shape.'
          );
        }
        if (verified === 'unavailable') break;
      }

      throw new SearchReferenceStoreError(
        'unavailable',
        'Redis could not confirm the RePrice reference update.'
      );
    },
  };
}

type RuntimeRedisClient = ReturnType<typeof createClient>;

let sharedRedisClient: RuntimeRedisClient | null = null;
let redisConnectPromise: Promise<RuntimeRedisClient> | null = null;

function discardClient(client: RuntimeRedisClient): void {
  try {
    client.disconnect();
  } catch {
    // The socket may already have closed.
  }
}

async function runtimeRedisClient(): Promise<RuntimeRedisClient> {
  if (sharedRedisClient?.isReady) return sharedRedisClient;
  if (redisConnectPromise) return redisConnectPromise;

  const url = process.env.REDIS_URL;
  if (!url || url.trim().length === 0) {
    throw new SearchReferenceStoreError(
      'unavailable',
      'Shared Redis quote storage is not configured.'
    );
  }

  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: REDIS_COMMAND_TIMEOUT_MS,
      reconnectStrategy: false,
    },
  });
  // Redis client errors are handled at each operation. Never log raw errors:
  // connection messages may include provider host details.
  client.on('error', () => undefined);

  redisConnectPromise = (async () => {
    const connected = await withRedisTimeout(() => client.connect());
    if (connected.state !== 'value') {
      discardClient(client);
      throw new SearchReferenceStoreError(
        'unavailable',
        'Shared Redis quote storage is unavailable.'
      );
    }
    sharedRedisClient = client;
    return client;
  })();

  try {
    return await redisConnectPromise;
  } finally {
    redisConnectPromise = null;
  }
}

const runtimeRedisAdapter: RedisFlightQuoteClient = {
  async set(key, value, options) {
    const client = await runtimeRedisClient();
    const args = ['SET', key, value];
    if (options.NX) args.push('NX');
    if (typeof options.PX === 'number') args.push('PX', String(options.PX));
    return (await client.sendCommand(args)) as string | null;
  },
  async get(key) {
    const client = await runtimeRedisClient();
    return client.sendCommand<Buffer | null>(['GET', key], { returnBuffers: true });
  },
  async eval(script, options) {
    const client = await runtimeRedisClient();
    return client.sendCommand([
      'EVAL',
      script,
      String(options.keys.length),
      ...options.keys,
      ...options.arguments,
    ]);
  },
};

function runtimeStore(): RedisFlightQuoteStore {
  const config = runtimeConfig();
  return createRedisFlightQuoteStore({
    client: runtimeRedisAdapter,
    ttlSeconds: config.ttlMs / 1_000,
    maxBytes: config.maxBytes,
  });
}

/** Persists the compact Search reference graph before exposing a search id. */
export async function storeSearch(
  uniqueTransId: string,
  refsByItineraryId: Map<string, ItineraryRefs>,
  supplierAccount: FlightReadSupplier,
  options: { trace?: FlightSearchTraceObserver } = {}
): Promise<StoredSearchWrite> {
  return runtimeStore().storeSearch(
    uniqueTransId,
    refsByItineraryId,
    supplierAccount,
    options
  );
}

/** Returns null only for a confirmed missing or expired Redis quote. */
export async function readSearch(
  searchId: string,
  _options: SearchReadOptions = {}
): Promise<StoredSearch | null> {
  return runtimeStore().readSearch(searchId, _options);
}

/** Returns this principal's separately persisted live RePrice capability. */
export async function readRepricedSelection(
  searchId: string,
  itineraryId: string,
  principal: PricingPrincipal
): Promise<RepricedSelection | null> {
  return runtimeStore().readRepricedSelection(searchId, itineraryId, principal);
}

/**
 * Persists exactly one principal's RePrice references with a Redis Lua CAS.
 * `expectedSelectionVersion` must be captured from the authoritative read made
 * before the supplier call; no supplier operation is repeated for persistence.
 */
export async function storeRepricedSelection(
  searchId: string,
  itineraryId: string,
  reprice: Omit<RepricedSelection, 'principal' | 'quoteStoreVersion' | 'quoteStoreDigest'>,
  principal: PricingPrincipal,
  expectedSelectionVersion: number
): Promise<boolean> {
  return runtimeStore().storeRepricedSelection(
    searchId,
    itineraryId,
    reprice,
    principal,
    expectedSelectionVersion
  );
}
