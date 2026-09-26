import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { currencyModule } from './helpers/currency.mjs';

const require = createRequire(import.meta.url);
const typescript = require('typescript');

const root = process.cwd();
const cachePath = 'lib/flights/search-cache.ts';
const searchPath = 'lib/triplover/search.ts';
const upsellsPath = 'lib/flights/upsells.ts';
const repricePath = 'lib/triplover/reprice.ts';
const shaponPricingPath = 'lib/shapontravels/pricing.ts';
const preparePath = 'app/api/flights/booking/prepare/route.ts';
const bookPath = 'app/api/flights/booking/route.ts';
const firstTripPath = 'lib/triplover/client.ts';
const envPath = '.env.example';

const [cacheSource, searchSource, upsellsSource, repriceSource, shaponPricingSource, prepareSource, bookSource, clientSource, envSource] =
  await Promise.all(
    [
      cachePath,
      searchPath,
      upsellsPath,
      repricePath,
      shaponPricingPath,
      preparePath,
      bookPath,
      firstTripPath,
      envPath,
    ].map((path) => readFile(path, 'utf8'))
  );

function loadQuoteStore() {
  const compiled = typescript.transpileModule(cacheSource, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    fileName: cachePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => {
    if (id === 'server-only') return {};
    if (id === 'crypto') return require('node:crypto');
    if (id === 'zlib') return require('node:zlib');
    if (id === 'redis') {
      return {
        createClient() {
          throw new Error('Runtime Redis client must not be used by this verifier.');
        },
      };
    }
    if (id === '@/lib/flights/supplier') {
      return {
        isFlightReadSupplier(value) {
          return value === 'takeoff' || value === 'firsttrip' || value === 'triplover' || value === 'shapontravels';
        },
      };
    }
    if (id === '@/lib/flights/pricing-principal') {
      return {
        samePricingPrincipal(left, right) {
          return (
            left?.userId === right?.userId &&
            left?.audience === right?.audience &&
            left?.agencyCode === right?.agencyCode
          );
        },
      };
    }
    throw new Error(`Unexpected cache import in verifier: ${id}`);
  };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: localRequire,
    Buffer,
    console,
    performance,
    setTimeout,
    clearTimeout,
    process: { env: {} },
  }, { filename: cachePath });
  return module.exports;
}

const quote = loadQuoteStore();
const {
  SearchReferenceStoreError,
  SearchQuoteTooLargeError,
  bookingSnapshotDigestFor,
  canonicalBookingSnapshot,
  createRedisFlightQuoteStore,
  matchesBookingSnapshot,
  pricingPrincipalKey,
  selectionSignatureForItinerary,
  verifyBookingSnapshot,
} = quote;

function loadUpsellModule() {
  return compileModule(upsellsSource, upsellsPath, (id) => {
    throw new Error(`Unexpected upsell import in verifier: ${id}`);
  });
}

const { groupUpsellOptions } = loadUpsellModule();
const { shapontravelsPricedOffer } = compileModule(shaponPricingSource, shaponPricingPath, (id) => {
  throw new Error(`Unexpected Shapon pricing import in verifier: ${id}`);
});

class FakeRedis {
  constructor(clock) {
    this.clock = clock;
    this.entries = new Map();
    this.calls = { set: 0, get: 0, eval: 0 };
    this.failSet = null;
    this.failGet = false;
    this.failEval = null;
    this.lastScript = '';
  }

  entry(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.clock.now) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  async set(key, value, options) {
    this.calls.set += 1;
    const failure = this.failSet;
    this.failSet = null;
    if (failure === 'before') throw new Error('redis transport unavailable');
    if (failure === 'timeout-before') {
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      return 'OK';
    }

    const existing = this.entry(key);
    if (options.NX && existing) return null;
    const expiresAt = options.PX
      ? this.clock.now + options.PX
      : existing?.expiresAt ?? this.clock.now;
    this.entries.set(key, { value, expiresAt });
    if (failure === 'after') throw new Error('redis transport ambiguous after commit');
    if (failure === 'timeout-after') {
      await new Promise((resolve) => setTimeout(resolve, 1_600));
    }
    return 'OK';
  }

  async get(key) {
    this.calls.get += 1;
    if (this.failGet) throw new Error('redis read unavailable');
    return this.entry(key)?.value ?? null;
  }

  async eval(script, options) {
    this.calls.eval += 1;
    this.lastScript = script;
    const failure = this.failEval;
    this.failEval = null;
    if (failure === 'before') throw new Error('redis eval unavailable');

    const root = this.entry(options.keys[0]);
    if (!root) return ['missing'];
    const selectionKey = options.keys[1];
    const [expectedVersion, digest, candidateJson, maxBytes] = options.arguments;
    const existingEntry = this.entry(selectionKey);
    const existing = existingEntry ? JSON.parse(existingEntry.value) : null;
    if (existing) {
      if (existing.quoteStoreDigest === digest) return ['replay'];
      if (Number(existing.quoteStoreVersion) !== Number(expectedVersion)) {
        return ['conflict'];
      }
    } else if (Number(expectedVersion) !== 0) {
      return ['conflict'];
    }
    if (Buffer.byteLength(candidateJson, 'utf8') > Number(maxBytes)) return ['oversized'];
    this.entries.set(selectionKey, { value: candidateJson, expiresAt: root.expiresAt });
    if (failure === 'after') throw new Error('redis eval ambiguous after commit');
    return ['updated', String(JSON.parse(candidateJson).quoteStoreVersion)];
  }
}

function principal(userId) {
  return { userId, audience: 'b2c', agencyCode: null };
}

function bookedItinerary(overrides = {}) {
  const segment = {
    from: 'DAC',
    fromAirport: 'DAC',
    to: 'SIN',
    toAirport: 'SIN',
    departureTerminal: null,
    arrivalTerminal: null,
    departure: '2026-08-23 10:00:00',
    arrival: '2026-08-23 16:00:00',
    airline: 'IndiGo',
    airlineCode: '6E',
    flightNumber: '6E-001',
    cabinClass: 'Economy',
    bookingClass: 'Y',
    duration: null,
    aircraft: null,
    baggage: null,
    handBaggage: null,
    seatsLeft: null,
  };
  const itinerary = {
    carrierCode: '6E',
    carrierName: 'IndiGo',
    refundable: false,
    legs: [
      {
        from: 'DAC',
        to: 'SIN',
        stops: 0,
        duration: null,
        departure: '2026-08-23 10:00:00',
        arrival: '2026-08-23 16:00:00',
        segments: [segment],
      },
    ],
  };
  return {
    ...itinerary,
    ...overrides,
    legs: overrides.legs ?? itinerary.legs,
  };
}

function roundTripBookedItinerary() {
  const outboundFirst = {
    from: 'DAC',
    fromAirport: 'Hazrat Shahjalal International Airport',
    to: 'DOH',
    toAirport: 'Hamad International Airport',
    departureTerminal: '1',
    arrivalTerminal: '1',
    departure: '2026-09-10 03:10:00',
    arrival: '2026-09-10 05:35:00',
    airline: 'Qatar Airways',
    airlineCode: 'QR',
    flightNumber: 'QR-639',
    cabinClass: 'Economy',
    bookingClass: 'Q',
    duration: '5h 25m',
    aircraft: 'Boeing 777',
    baggage: '30 Kg',
    handBaggage: '7 Kg',
    seatsLeft: 4,
  };
  const outboundSecond = {
    ...outboundFirst,
    from: 'DOH',
    fromAirport: 'Hamad International Airport',
    to: 'JFK',
    toAirport: 'John F. Kennedy International Airport',
    departure: '2026-09-10 08:15:00',
    arrival: '2026-09-10 15:10:00',
    flightNumber: 'QR-701',
    duration: '13h 55m',
  };
  const inbound = {
    ...outboundFirst,
    from: 'JFK',
    fromAirport: 'John F. Kennedy International Airport',
    to: 'DAC',
    toAirport: 'Hazrat Shahjalal International Airport',
    departure: '2026-09-30 22:15:00',
    arrival: '2026-10-02 07:30:00',
    flightNumber: 'QR-742',
    duration: '20h 15m',
  };
  return {
    carrierCode: 'QR',
    carrierName: 'Qatar Airways',
    refundable: false,
    legs: [
      {
        from: 'DAC',
        to: 'JFK',
        stops: 1,
        duration: '22h',
        departure: outboundFirst.departure,
        arrival: outboundSecond.arrival,
        segments: [outboundFirst, outboundSecond],
      },
      {
        from: 'JFK',
        to: 'DAC',
        stops: 0,
        duration: inbound.duration,
        departure: inbound.departure,
        arrival: inbound.arrival,
        segments: [inbound],
      },
    ],
  };
}

function refs(overrides = {}) {
  const { bookingItinerary = bookedItinerary(), ...referenceOverrides } = overrides;
  return new Map([
    [
      'itn-0-0',
      {
        itemCodeRef: 'item-ref',
        segmentCodeRefs: ['segment-ref'],
        ambiguousSelection: false,
        context: {
          carrierCode: '6E',
          routes: [{ origin: 'DAC', destination: 'SIN', departureDate: '2026-08-23' }],
          passengerCounts: { adt: 1 },
          passengerCount: 1,
        },
        pricing: { sellingPrice: 100, supplierTotalPrice: 90 },
        selection: selectionSignatureForItinerary(bookingItinerary),
        bookingSnapshotDigest: bookingSnapshotDigestFor(bookingItinerary),
        ...referenceOverrides,
      },
    ],
  ]);
}

function reprice(priceCodeRef) {
  return {
    uniqueTransId: 'supplier-trans',
    itemCodeRef: 'item-ref',
    priceCodeRef,
    pricing: { sellingPrice: 101, supplierTotalPrice: 91 },
    fares: [],
    currency: 'BDT',
    bookable: true,
    requiresConfirmation: false,
    repricedAt: '2026-08-18T00:00:00.000Z',
  };
}

function storeFor(redis, clock, searchId = '00000000-0000-4000-8000-000000000001', options = {}) {
  return createRedisFlightQuoteStore({
    client: redis,
    now: () => clock.now,
    createSearchId: () => searchId,
    ttlSeconds: options.ttlSeconds ?? 1200,
    maxBytes: options.maxBytes ?? 262144,
  });
}

async function expectStoreError(action, kind) {
  await assert.rejects(action, (error) =>
    error instanceof SearchReferenceStoreError && error.kind === kind
  );
}

function compileModule(source, fileName, localRequire) {
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ES2022,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    fileName,
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    compiled,
    {
      module,
      exports: module.exports,
      require: (id) => id === '@/lib/currency' ? currencyModule : localRequire(id),
      Buffer,
      console,
      performance,
      setTimeout,
      clearTimeout,
      process: { env: {} },
    },
    { filename: fileName }
  );
  return module.exports;
}

function verifiedPrepareReprice() {
  return {
    uniqueTransId: 'supplier-trans',
    itemCodeRef: 'item-ref',
    priceCodeRef: 'price-ref',
    pricing: {
      audience: 'b2c',
      agencyCode: null,
      sellingPrice: 100,
      serviceMarginAmount: 0,
      supplierTotalPrice: 90,
      grossPrice: 90,
      ruleId: null,
      basis: 'test',
    },
    fares: [],
    currency: 'BDT',
    bookable: true,
    requiresConfirmation: false,
    repricedAt: new Date().toISOString(),
  };
}

/**
 * Loads the real Prepare route with only its surrounding infrastructure
 * replaced. That lets this verifier prove a rejected browser snapshot never
 * reaches the durable booking_attempts handoff.
 */
function loadPrepareRoute({ search, createdAttempts, preparedReprice = verifiedPrepareReprice() }) {
  const nextServer = {
    NextResponse: {
      json(body, init = {}) {
        return {
          status: init.status ?? 200,
          body,
          headers: init.headers ?? {},
        };
      },
    },
  };
  const localRequire = (id) => {
    if (id === 'next/server') return nextServer;
    if (id === 'zod') return require('zod');
    if (id === '@/lib/airports/country') return { passportRequiredFor: () => true };
    if (id === '@/lib/dashboard/session') {
      return {
        getDashboardSession: async () => ({ clerkId: 'prepare-owner', role: 'user' }),
      };
    }
    if (id === '@/lib/db/booking-attempts') {
      return {
        createBookingAttempt: async (input) => {
          createdAttempts.push(input);
          return { attemptId: `attempt-${createdAttempts.length}` };
        },
      };
    }
    if (id === '@/lib/flights/search-cache') {
      return {
        SearchReferenceStoreError,
        canonicalBookingSnapshot,
        readSearch: async () => search,
        readRepricedSelection: async () => preparedReprice,
        verifyBookingSnapshot,
      };
    }
    if (id === '@/lib/flights/staff-booking.server') {
      return {
        canCreateBookingOnBehalf: () => false,
        resolveBookingActorContext: async () => ({
          principal: principal('prepare-owner'),
          ownerUserId: 'prepare-owner',
          createdByUserId: 'prepare-owner',
          staffOnBehalf: false,
        }),
      };
    }
    if (id === '@/lib/flights/pricing-principal') {
      return { pricingPrincipalForSession: () => principal('prepare-owner') };
    }
    if (id === '@/lib/http/actor-key') return { requestActorKey: () => 'prepare-test' };
    if (id === '@/lib/rate-limit') {
      return { checkActionLimit: async () => ({ ok: true }), rateLimitMessage: () => '' };
    }
    if (id === '@/lib/wallet/permissions') return { canCreateOwnBooking: () => true };
    if (id === '@/lib/db/supplier-controls') return {
      getSupplierOperationalControls: async () => ({ bookingEnabled: true }),
    };
    if (id === '@/lib/shapontravels/client') return {
      ShapontravelsReadError: class extends Error {},
      shapontravelsRead: async (_operation, payload) => ({
        accepted: true, priceCodeRef: payload.priceCodeRef, pricingVersion: 1,
      }),
    };
    throw new Error(`Unexpected Prepare import in verifier: ${id}`);
  };
  return compileModule(prepareSource, preparePath, localRequire);
}

function repriceDirectionsFor(selection) {
  return selection.legs.map((leg) => [
    {
      segments: leg.segments.map((segment) => ({ ...segment })),
    },
  ]);
}

/**
 * Executes the real RePrice mapper against a private reference graph and an
 * in-memory supplier response. The surrounding I/O is mocked so the test can
 * assert a mismatch gets exactly one supplier call and no Redis update.
 */
function loadRepriceModule({ search, response, calls }) {
  class TestTriploverError extends Error {}
  const localRequire = (id) => {
    if (id === 'server-only') return {};
    if (id === '@/lib/db/markup-rules') {
      return { activeMarkupRulesFor: async () => ({ ok: true, rules: [] }) };
    }
    if (id === '@/lib/flights/search-cache') {
      return {
        SearchReferenceStoreError,
        readSearch: async () => search,
        readRepricedSelection: async () => null,
        storeRepricedSelection: async (...args) => {
          calls.persist.push(args);
          return true;
        },
      };
    }
    if (id === '@/lib/flights/pricing-principal') {
      return { pricingAudienceForPrincipal: () => ({ kind: 'b2c' }) };
    }
    if (id === '@/lib/flights/types') return { fareClassLabel: () => '' };
    if (id === '@/lib/markup') {
      return {
        priceOffer: (input) => {
          calls.pricing = (calls.pricing ?? 0) + 1;
          return {
          totalPrice: input.supplierTotalPrice,
          basePrice: input.basePrice,
          taxes: input.taxes,
          ait: input.ait,
          serviceMargin: 0,
          fares: input.fares,
          snapshot: {
            audience: 'b2c',
            agencyCode: null,
            sellingPrice: input.supplierTotalPrice,
            serviceMarginAmount: 0,
            supplierTotalPrice: input.supplierTotalPrice,
            grossPrice: input.basePrice + input.taxes,
            ruleId: null,
            basis: 'test',
          },
          };
        },
        selectMarkupRules: () => [],
      };
    }
    if (id === '@/lib/triplover/client') {
      return {
        TriploverError: TestTriploverError,
        triploverCall: async () => {
          calls.supplier += 1;
          return { data: response, uniqueTransId: 'supplier-trans' };
        },
      };
    }
    if (id === '@/lib/shapontravels/client') return {
      ShapontravelsReadError: class extends Error {},
      shapontravelsRead: async () => {
        calls.shapon = (calls.shapon ?? 0) + 1;
        return { item1: response, item2: { isSuccess: true } };
      },
    };
    if (id === '@/lib/shapontravels/pricing') return { shapontravelsPricedOffer };
    throw new Error(`Unexpected RePrice import in verifier: ${id}`);
  };
  return compileModule(repriceSource, repricePath, localRequire);
}

/** Runs the real Search mapper with supplier/network work isolated. */
function loadSearchModule({
  response,
  storedRefs,
  canonicalizer = canonicalBookingSnapshot,
  maxStoredOptions = Infinity,
}) {
  const localRequire = (id) => {
    if (id === 'server-only') return {};
    if (id === '@/lib/flights/search-cache') {
      return {
        SearchReferenceStoreError,
        SearchQuoteTooLargeError,
        bookingSnapshotDigestFor,
        canonicalBookingSnapshot: canonicalizer,
        selectionSignatureForItinerary,
        storeSearch: async (_transaction, refsByItineraryId, supplier) => {
          if (refsByItineraryId.size > maxStoredOptions) {
            throw new SearchQuoteTooLargeError();
          }
          storedRefs.set('refs', refsByItineraryId);
          storedRefs.set('supplier', supplier);
          return {
            searchId: '00000000-0000-4000-8000-000000000099',
            timing: { redisPersistenceMs: 0, redisPersistenceOutcome: 'success' },
          };
        },
      };
    }
    if (id === '@/lib/db/markup-rules') {
      return { activeMarkupRulesFor: async () => ({ ok: true, rules: [] }) };
    }
    if (id === '@/lib/flights/upsells') {
      return {
        groupUpsellOptions,
      };
    }
    if (id === '@/lib/markup') {
      return {
        B2C_PRICING_AUDIENCE: { kind: 'b2c' },
        priceOffer: (input) => ({
          totalPrice: input.supplierTotalPrice,
          basePrice: input.basePrice,
          taxes: input.taxes,
          ait: input.ait,
          serviceMargin: 0,
          fares: input.fares,
          snapshot: {
            audience: 'b2c',
            agencyCode: null,
            sellingPrice: input.supplierTotalPrice,
            serviceMarginAmount: 0,
            supplierTotalPrice: input.supplierTotalPrice,
            grossPrice: input.basePrice + input.taxes,
            ruleId: null,
            basis: 'test',
          },
        }),
        selectMarkupRules: () => [],
      };
    }
    if (id === '@/lib/triplover/client') {
      return {
        triploverCall: async () => ({
          data: response,
          uniqueTransId: 'supplier-trans',
          partial: false,
          timing: {},
        }),
      };
    }
    if (id === '@/lib/shapontravels/client') return { shapontravelsRead: async () => { throw new Error('Unexpected Shapontravels call'); } };
    if (id === '@/lib/shapontravels/pricing') return { shapontravelsPricedOffer: () => null };
    throw new Error(`Unexpected Search import in verifier: ${id}`);
  };
  return compileModule(searchSource, searchPath, localRequire);
}

// Source contracts: temporary quote authority is Redis only, with a compact
// key and no active Supabase write/read/cleanup fallback.
assert.match(cacheSource, /flight:quote:v4:/);
assert.match(cacheSource, /\{\$\{searchId\}\}/);
assert.match(cacheSource, /createClient/);
assert.match(cacheSource, /REDIS_URL/);
assert.match(cacheSource, /NX: true/);
assert.match(cacheSource, /PX: config\.ttlMs/);
assert.match(cacheSource, /PTTL/);
assert.match(cacheSource, /redis_persistence_start/);
assert.match(cacheSource, /redis_persistence_confirmed/);
assert.doesNotMatch(cacheSource, /supabaseAdmin|flight_search_quotes|persist_flight_search_quote_v1|persist_flight_reprice_selection_v1/);
assert.doesNotMatch(cacheSource, /const searches\s*=\s*new Map/);
assert.match(cacheSource, /bookingSnapshotDigestFor/);
assert.match(cacheSource, /canonicalBookingSnapshot/);
assert.match(cacheSource, /matchesBookingSnapshot/);
assert.match(cacheSource, /selectionSignatureForItinerary/);
assert.match(cacheSource, /timingSafeEqual/);
assert.match(envSource, /^REDIS_URL=$/m);
assert.match(envSource, /^FLIGHT_QUOTE_STORE=redis$/m);
assert.match(envSource, /^FLIGHT_QUOTE_TTL_SECONDS=1200$/m);
assert.match(envSource, /^FLIGHT_QUOTE_MAX_BYTES=262144$/m);
assert.doesNotMatch(envSource, /UPSTASH_REDIS/);
assert.equal((searchSource.match(/triploverCall\(\s*'Search'/g) ?? []).length, 1);
assert.equal((repriceSource.match(/triploverCall\(\s*'RePrice'/g) ?? []).length, 1);
assert.match(repriceSource, /readRepricedSelection\(/);
assert.match(repriceSource, /expectedSelectionVersion/);
assert.match(prepareSource, /createBookingAttempt\(/);
assert.match(prepareSource, /sourceExpiresAt: search\.expiresAt/);
assert.match(prepareSource, /priceCodeRef: reprice\.priceCodeRef/);
assert.match(prepareSource, /itinerary:\s*z\.unknown\(\)/);
assert.match(prepareSource, /verifyBookingSnapshot\(\s*refs,\s*parsed\.data\.itinerary\s*\)/);
assert.match(searchSource, /departureTerminal:\s*null/);
assert.match(searchSource, /arrivalTerminal:\s*null/);
assert.match(prepareSource, /BOOKING_SNAPSHOT_INVALID/);
assert.match(prepareSource, /offerSnapshot:\s*\{[\s\S]*?itinerary,/);
assert.match(repriceSource, /repriceMatchesSelectedItinerary/);
assert.match(repriceSource, /SELECTION_MISMATCH/);
assert.match(repriceSource, /refs\.selection/);
assert.doesNotMatch(bookSource, /readSearch\(|search-cache|redis/i);
assert.match(bookSource, /readBookingAttempt\(/);
assert.match(clientSource, /operation === 'Search' && config\.supplier === 'takeoff'/);

// A browser can carry the public booking itinerary, but it may never author
// it. Redis retains a canonical digest for each option. The exact snapshot is
// accepted, while display-data tampering, malformed data, and a snapshot from
// another fare are all rejected before Prepare can create a booking attempt.
const issuedPrimaryItinerary = bookedItinerary();
const issuedAlternativeItinerary = bookedItinerary({
  carrierCode: 'SQ',
  carrierName: 'Singapore Airlines',
  legs: [
    {
      ...issuedPrimaryItinerary.legs[0],
      segments: [
        {
          ...issuedPrimaryItinerary.legs[0].segments[0],
          airline: 'Singapore Airlines',
          airlineCode: 'SQ',
          flightNumber: 'SQ-447',
          departure: '2026-08-23 12:30:00',
          arrival: '2026-08-23 18:45:00',
        },
      ],
      departure: '2026-08-23 12:30:00',
      arrival: '2026-08-23 18:45:00',
    },
  ],
});
const issuedPrimaryRefs = refs({ bookingItinerary: issuedPrimaryItinerary }).get('itn-0-0');
const issuedAlternativeRefs = refs({ bookingItinerary: issuedAlternativeItinerary }).get('itn-0-0');
assert.ok(issuedPrimaryRefs);
assert.ok(issuedAlternativeRefs);
assert.match(issuedPrimaryRefs.bookingSnapshotDigest, /^[A-Za-z0-9_-]{43}$/);
assert.equal(matchesBookingSnapshot(issuedPrimaryRefs, issuedPrimaryItinerary), true);
assert.equal(matchesBookingSnapshot(issuedAlternativeRefs, issuedAlternativeItinerary), true);

// TakeOff's current Search shape does not include terminal values.  A browser
// snapshot that accurately reflects that absence must canonicalize to the
// same representation Search used when it produced the digest; an explicitly
// malformed terminal or an unknown field must still fail closed.
const terminalOmittedItinerary = structuredClone(issuedPrimaryItinerary);
delete terminalOmittedItinerary.legs[0].segments[0].departureTerminal;
delete terminalOmittedItinerary.legs[0].segments[0].arrivalTerminal;
const canonicalTerminalOmittedItinerary = canonicalBookingSnapshot(terminalOmittedItinerary);
assert.ok(canonicalTerminalOmittedItinerary);
assert.equal(canonicalTerminalOmittedItinerary.legs[0].segments[0].departureTerminal, null);
assert.equal(canonicalTerminalOmittedItinerary.legs[0].segments[0].arrivalTerminal, null);
assert.equal(
  bookingSnapshotDigestFor(canonicalTerminalOmittedItinerary),
  bookingSnapshotDigestFor(issuedPrimaryItinerary),
  'Search and Prepare must hash the same canonical terminal representation'
);
assert.equal(
  matchesBookingSnapshot(issuedPrimaryRefs, terminalOmittedItinerary),
  true,
  'a faithfully carried supplier snapshot without terminal keys remains valid'
);
assert.equal(
  verifyBookingSnapshot(issuedPrimaryRefs, terminalOmittedItinerary),
  'match'
);
const malformedTerminalItinerary = structuredClone(issuedPrimaryItinerary);
const codeshareItinerary = structuredClone(issuedPrimaryItinerary);
codeshareItinerary.legs[0].segments[0].operatingCarrierCode = 'BA';
codeshareItinerary.legs[0].segments[0].codeshare = true;
assert.equal(canonicalBookingSnapshot(codeshareItinerary).legs[0].segments[0].operatingCarrierCode, 'BA');
assert.notEqual(bookingSnapshotDigestFor(codeshareItinerary), bookingSnapshotDigestFor(issuedPrimaryItinerary));
assert.equal(matchesBookingSnapshot(issuedPrimaryRefs, codeshareItinerary), false,
  'a browser cannot add an unsigned operating carrier');
const malformedOperator = structuredClone(codeshareItinerary);
malformedOperator.legs[0].segments[0].operatingCarrierCode = { code: 'BA' };
assert.equal(canonicalBookingSnapshot(malformedOperator), null);
const malformedCodeshare = structuredClone(codeshareItinerary);
malformedCodeshare.legs[0].segments[0].codeshare = 'true';
assert.equal(canonicalBookingSnapshot(malformedCodeshare), null);
malformedTerminalItinerary.legs[0].segments[0].departureTerminal = 99;
assert.equal(
  matchesBookingSnapshot(issuedPrimaryRefs, malformedTerminalItinerary),
  false,
  'an explicitly malformed terminal cannot be normalized into a valid snapshot'
);
assert.equal(
  verifyBookingSnapshot(issuedPrimaryRefs, malformedTerminalItinerary),
  'invalid_shape'
);
assert.equal(
  matchesBookingSnapshot(issuedPrimaryRefs, issuedAlternativeItinerary),
  false,
  'a public snapshot from a different fare may not be used with this option\'s private refs'
);
assert.equal(
  matchesBookingSnapshot(issuedAlternativeRefs, issuedPrimaryItinerary),
  false,
  'the cross-option rejection must be symmetric'
);

const tamperedPublicItinerary = structuredClone(issuedPrimaryItinerary);
tamperedPublicItinerary.legs[0].segments[0].baggage = '99 Kg';
assert.equal(
  matchesBookingSnapshot(issuedPrimaryRefs, tamperedPublicItinerary),
  false,
  'even display-only public itinerary fields are immutable once issued'
);
assert.equal(
  verifyBookingSnapshot(issuedPrimaryRefs, tamperedPublicItinerary),
  'digest_mismatch'
);
const malformedPublicItinerary = structuredClone(issuedPrimaryItinerary);
delete malformedPublicItinerary.legs[0].segments[0].fromAirport;
assert.equal(
  matchesBookingSnapshot(issuedPrimaryRefs, malformedPublicItinerary),
  false,
  'Prepare must reject malformed browser snapshots before hashing them'
);
const extraPublicField = { ...issuedPrimaryItinerary, clientInjected: true };
assert.equal(
  matchesBookingSnapshot(issuedPrimaryRefs, extraPublicField),
  false,
  'unknown browser fields cannot be silently ignored when the issued snapshot is bound'
);
const extraNestedPublicField = structuredClone(issuedPrimaryItinerary);
extraNestedPublicField.legs[0].segments[0].clientInjected = true;
assert.equal(
  matchesBookingSnapshot(issuedPrimaryRefs, extraNestedPublicField),
  false,
  'unknown nested browser fields cannot be silently ignored when the issued snapshot is bound'
);
const reverseObjectKeys = (value) => {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, nested]) => [key, reverseObjectKeys(nested)])
  );
};
assert.equal(
  matchesBookingSnapshot(issuedPrimaryRefs, reverseObjectKeys(issuedPrimaryItinerary)),
  true,
  'property order is not part of the browser snapshot capability'
);

// The RePrice identity is intentionally only the six supplier journey fields
// per segment. It has to retain direction and segment order for a return trip,
// while leaving public-only fields out of the Redis capability graph.
const roundTripPublicItinerary = roundTripBookedItinerary();
assert.deepEqual(JSON.parse(JSON.stringify(selectionSignatureForItinerary(roundTripPublicItinerary))), {
  legs: [
    {
      segments: [
        {
          from: 'DAC',
          to: 'DOH',
          departure: '2026-09-10 03:10:00',
          arrival: '2026-09-10 05:35:00',
          airlineCode: 'QR',
          flightNumber: 'QR-639',
        },
        {
          from: 'DOH',
          to: 'JFK',
          departure: '2026-09-10 08:15:00',
          arrival: '2026-09-10 15:10:00',
          airlineCode: 'QR',
          flightNumber: 'QR-701',
        },
      ],
    },
    {
      segments: [
        {
          from: 'JFK',
          to: 'DAC',
          departure: '2026-09-30 22:15:00',
          arrival: '2026-10-02 07:30:00',
          airlineCode: 'QR',
          flightNumber: 'QR-742',
        },
      ],
    },
  ],
});

// Prepare receives the client-safe itinerary only after RePrice. Exercise the
// real route boundary: only the matching option may create a durable attempt;
// a tampered or cross-option snapshot must fail before the database insert.
const preparePrimaryRefs = refs({ bookingItinerary: issuedPrimaryItinerary }).get('itn-0-0');
const prepareAlternativeRefs = refs({ bookingItinerary: issuedAlternativeItinerary }).get('itn-0-0');
assert.ok(preparePrimaryRefs);
assert.ok(prepareAlternativeRefs);
const prepareSearch = {
  supplierAccount: 'takeoff',
  expiresAt: Date.now() + 60_000,
  refsByItineraryId: new Map([
    ['itn-0-0', preparePrimaryRefs],
    ['itn-0-1', prepareAlternativeRefs],
  ]),
};
const createdAttempts = [];
const prepareRoute = loadPrepareRoute({ search: prepareSearch, createdAttempts });
const preparePayload = (itineraryId, itinerary) => ({
  searchId: '00000000-0000-4000-8000-000000000001',
  itineraryId,
  acceptedRepricedAt: null,
  itinerary,
});
const validPrepare = await prepareRoute.POST({
  json: async () => preparePayload('itn-0-0', issuedPrimaryItinerary),
});
assert.equal(validPrepare.status, 200);
assert.equal(validPrepare.body.success, true);
assert.equal(createdAttempts.length, 1);
assert.deepEqual(
  JSON.parse(JSON.stringify(createdAttempts[0].offerSnapshot.itinerary)),
  issuedPrimaryItinerary,
  'the durable attempt retains the digest-verified public snapshot'
);

const prepareTerminalOmitted = await prepareRoute.POST({
  json: async () => preparePayload('itn-0-0', terminalOmittedItinerary),
});
assert.equal(prepareTerminalOmitted.status, 200);
assert.equal(prepareTerminalOmitted.body.success, true);
assert.equal(createdAttempts.length, 2);
assert.equal(
  createdAttempts[1].offerSnapshot.itinerary.legs[0].segments[0].departureTerminal,
  null,
  'the durable attempt canonicalizes a supplier-omitted departure terminal'
);
assert.equal(
  createdAttempts[1].offerSnapshot.itinerary.legs[0].segments[0].arrivalTerminal,
  null,
  'the durable attempt canonicalizes a supplier-omitted arrival terminal'
);

const prepareTampered = await prepareRoute.POST({
  json: async () => preparePayload('itn-0-0', tamperedPublicItinerary),
});
assert.equal(prepareTampered.status, 409);
assert.equal(prepareTampered.body.error.errorCode, 'BOOKING_SNAPSHOT_INVALID');
assert.equal(createdAttempts.length, 2, 'tampering cannot reach booking_attempts');

const prepareCrossOption = await prepareRoute.POST({
  json: async () => preparePayload('itn-0-0', issuedAlternativeItinerary),
});
assert.equal(prepareCrossOption.status, 409);
assert.equal(prepareCrossOption.body.error.errorCode, 'BOOKING_SNAPSHOT_INVALID');
assert.equal(createdAttempts.length, 2, 'an option A id cannot use option B\'s snapshot');

const prepareMalformed = await prepareRoute.POST({
  json: async () => preparePayload('itn-0-0', malformedPublicItinerary),
});
assert.equal(prepareMalformed.status, 409);
assert.equal(prepareMalformed.body.error.errorCode, 'BOOKING_SNAPSHOT_INVALID');
assert.equal(createdAttempts.length, 2, 'malformed public data cannot reach booking_attempts');

for (const currency of ['USD', 'EUR', '', null, undefined]) {
  const attempts = [];
  const route = loadPrepareRoute({
    search: prepareSearch,
    createdAttempts: attempts,
    preparedReprice: { ...verifiedPrepareReprice(), currency },
  });
  const result = await route.POST({ json: async () => preparePayload('itn-0-0', issuedPrimaryItinerary) });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.errorCode, 'UNSUPPORTED_CURRENCY');
  assert.equal(attempts.length, 0, 'a cached unsupported currency cannot create a booking attempt');
}

// RePrice must prove a supplied multi-direction itinerary is the selected
// option before it writes fresh priceCodeRef state. A mismatch gets one and
// only one supplier attempt, and must not persist a selection for another fare.
const roundTripRefs = refs({
  bookingItinerary: roundTripPublicItinerary,
  segmentCodeRefs: ['outbound-1', 'outbound-2', 'inbound-1'],
  context: {
    carrierCode: 'QR',
    routes: [
      { origin: 'DAC', destination: 'JFK', departureDate: '2026-09-10' },
      { origin: 'JFK', destination: 'DAC', departureDate: '2026-09-30' },
    ],
    passengerCounts: { adt: 1 },
    passengerCount: 1,
  },
  pricing: { sellingPrice: 1200, supplierTotalPrice: 1100 },
}).get('itn-0-0');
assert.ok(roundTripRefs);
const roundTripSearch = {
  uniqueTransId: 'supplier-trans',
  supplierAccount: 'takeoff',
  refsByItineraryId: new Map([['itn-0-0', roundTripRefs]]),
};
const matchingRepriceResponse = {
  totalPrice: 1100,
  basePrice: 1000,
  taxes: 100,
  priceCodeRef: 'repriced-roundtrip',
  directions: repriceDirectionsFor(roundTripRefs.selection),
};
const matchingCalls = { supplier: 0, persist: [] };
const matchingReprice = loadRepriceModule({
  search: roundTripSearch,
  response: matchingRepriceResponse,
  calls: matchingCalls,
});
const repricedRoundTrip = await matchingReprice.repriceFlight({
  searchId: '00000000-0000-4000-8000-000000000001',
  itineraryId: 'itn-0-0',
  principal: principal('roundtrip-owner'),
});
assert.equal(repricedRoundTrip.itineraryId, 'itn-0-0');
assert.equal(matchingCalls.supplier, 1);
assert.equal(matchingCalls.persist.length, 1);
assert.equal(matchingCalls.persist[0][1], 'itn-0-0');
assert.equal(matchingCalls.persist[0][2].priceCodeRef, 'repriced-roundtrip');
assert.equal(repricedRoundTrip.currency, 'BDT', 'omitted supplier currency retains the BDT contract');

for (const reported of [
  { currency: 'USD' },
  { currency: 'BDT', currencyCode: 'EUR' },
  { currency: 840 },
  { currency: 'BDT', passengerFares: { ADT: { currency: 'USD' } } },
]) {
  const calls = { supplier: 0, persist: [] };
  const reprice = loadRepriceModule({ search: roundTripSearch, response: { ...matchingRepriceResponse, ...reported }, calls });
  await assert.rejects(() => reprice.repriceFlight({
    searchId: '00000000-0000-4000-8000-000000000001', itineraryId: 'itn-0-0', principal: principal('roundtrip-owner'),
  }), currencyModule.UnsupportedCurrencyError);
  assert.equal(calls.supplier, 1);
  assert.equal(calls.pricing ?? 0, 0, 'foreign fares must not receive BDT markups');
  assert.equal(calls.persist.length, 0, 'foreign fares must not replace a verified quote');
}
{
  const calls = { supplier: 0, persist: [] };
  const reprice = loadRepriceModule({ search: roundTripSearch, response: { ...matchingRepriceResponse, currency: ' bdt ' }, calls });
  const result = await reprice.repriceFlight({
    searchId: '00000000-0000-4000-8000-000000000001', itineraryId: 'itn-0-0', principal: principal('roundtrip-owner'),
  });
  assert.equal(result.currency, 'BDT');
  assert.equal(calls.persist[0][2].currency, 'BDT');
  assert.equal(result.totalPrice, repricedRoundTrip.totalPrice, 'normalizing BDT does not change prices');
}

const mismatchedRepriceResponse = structuredClone(matchingRepriceResponse);
mismatchedRepriceResponse.directions[1][0].segments[0].flightNumber = 'QR-999';
const mismatchCalls = { supplier: 0, persist: [] };
const mismatchReprice = loadRepriceModule({
  search: roundTripSearch,
  response: mismatchedRepriceResponse,
  calls: mismatchCalls,
});
await assert.rejects(
  () =>
    mismatchReprice.repriceFlight({
      searchId: '00000000-0000-4000-8000-000000000001',
      itineraryId: 'itn-0-0',
      principal: principal('roundtrip-owner'),
    }),
  (error) => error?.code === 'SELECTION_MISMATCH'
);
assert.equal(mismatchCalls.supplier, 1, 'a mismatch does not replay supplier RePrice');
assert.equal(mismatchCalls.persist.length, 0, 'a mismatch cannot overwrite Redis selection state');

// The read-only provider must use its own Reprice transport and payable price,
// without creating a booking-capable Redis selection.
const shaponSearch = {
  ...roundTripSearch,
  supplierAccount: 'shapontravels',
  refsByItineraryId: new Map([['itn-0-0', {
    ...roundTripRefs,
    pricing: { sellingPrice: 5084.36, supplierTotalPrice: 5084.36 },
  }]]),
};
const shaponResponse = {
  ...matchingRepriceResponse,
  uniqueTransID: 'supplier-trans',
  itemCodeRef: roundTripRefs.itemCodeRef,
  bookable: true,
  currency: 'BDT',
  totalPrice: 5349,
  fareBreakdown: {
    currency: 'BDT', gross: '5349.00', payable: '5084.36',
    taxes: '1021.00', ait: '15.00',
    passengers: { adt: { count: 1, payable: '5084.36', taxes: '1021.00', ait: '15.00' } },
  },
};
const shaponCalls = { supplier: 0, persist: [] };
const shaponReprice = loadRepriceModule({ search: shaponSearch, response: shaponResponse, calls: shaponCalls });
const shaponResult = await shaponReprice.repriceFlight({
  searchId: '00000000-0000-4000-8000-000000000001',
  itineraryId: 'itn-0-0',
  principal: principal('shapon-reader'),
});
assert.equal(shaponResult.totalPrice, 5084.36);
assert.equal(shaponResult.bookingAvailable, true);
assert.equal(shaponCalls.shapon, 1);
assert.equal(shaponCalls.supplier, 0);
assert.equal(shaponCalls.persist.length, 1);
assert.equal(shaponCalls.persist[0][2].priceCodeRef, 'repriced-roundtrip');
const shaponMismatch = structuredClone(shaponResponse);
shaponMismatch.directions[1][0].segments[0].flightNumber = 'QR-999';
const shaponMismatchCalls = { supplier: 0, persist: [] };
await assert.rejects(
  () => loadRepriceModule({ search: shaponSearch, response: shaponMismatch, calls: shaponMismatchCalls })
    .repriceFlight({
      searchId: '00000000-0000-4000-8000-000000000001',
      itineraryId: 'itn-0-0',
      principal: principal('shapon-reader'),
    }),
  (error) => error?.code === 'SELECTION_MISMATCH'
);
assert.equal(shaponMismatchCalls.persist.length, 0);

// An invalid alternative in a round trip is independent of the valid selected
// combination. The mapper must emit and persist the safe one, drop the bad
// one, and preserve its ordered outbound/inbound reference vector.
const rawRoundTripSegment = (overrides = {}) => ({
  from: 'DAC',
  fromAirport: 'DAC',
  to: 'DOH',
  toAirport: 'DOH',
  departure: '2026-09-10 03:10:00',
  arrival: '2026-09-10 05:35:00',
  airline: 'Qatar Airways',
  airlineCode: 'QR',
  flightNumber: 'QR-639',
  segmentCodeRef: 'segment-outbound-1',
  bookingClass: 'Q',
  cabinClass: 'Economy',
  ...overrides,
});
const validOutbound = {
  from: 'DAC',
  to: 'JFK',
  stops: 1,
  travelTime: '22h',
  segments: [
    rawRoundTripSegment(),
    rawRoundTripSegment({
      from: 'DOH',
      to: 'JFK',
      departure: '2026-09-10 08:15:00',
      arrival: '2026-09-10 15:10:00',
      flightNumber: 'QR-701',
      segmentCodeRef: 'segment-outbound-2',
    }),
  ],
};
const invalidOutbound = {
  ...validOutbound,
  segments: [
    rawRoundTripSegment({
      departure: '2026-09-10 10:30:00',
      arrival: '2026-09-10 12:55:00',
      flightNumber: 'QR-641',
      segmentCodeRef: '',
    }),
    validOutbound.segments[1],
  ],
};
const validInbound = {
  from: 'JFK',
  to: 'DAC',
  stops: 0,
  travelTime: '20h 15m',
  segments: [
    rawRoundTripSegment({
      from: 'JFK',
      fromAirport: 'JFK',
      to: 'DAC',
      toAirport: 'DAC',
      departure: '2026-09-30 22:15:00',
      arrival: '2026-10-02 07:30:00',
      flightNumber: 'QR-742',
      segmentCodeRef: 'segment-inbound-1',
    }),
  ],
};
const mapperStoredRefs = new Map();
const mapper = loadSearchModule({
  response: {
    airSearchResponses: [
      {
        uniqueTransID: 'supplier-trans',
        itemCodeRef: 'roundtrip-item',
        totalPrice: 1100,
        basePrice: 1000,
        taxes: 100,
        platingCarrier: 'QR',
        platingCarrierName: 'Qatar Airways',
        directions: [[validOutbound, invalidOutbound], [validInbound]],
      },
    ],
  },
  storedRefs: mapperStoredRefs,
});
const mappedRoundTrip = await mapper.searchFlights(
  {
    tripType: 'round',
    routes: [
      { origin: 'DAC', destination: 'JFK', departureDate: '2026-09-10' },
      { origin: 'JFK', destination: 'DAC', departureDate: '2026-09-30' },
    ],
    adults: 1,
    children: 0,
    infants: 0,
    childrenAges: [],
    cabinClass: 1,
    preferredCarriers: [],
  },
  'takeoff'
);
assert.equal(mappedRoundTrip.result.itineraries.length, 1);
assert.equal(mappedRoundTrip.result.droppedOfferCount, 1);
assert.equal(mappedRoundTrip.result.currency, 'BDT');
for (const reported of [
  { currency: 'USD' },
  { currency: 'BDT', currencyCode: 'EUR' },
  { currency: 'BDT', airSearchResponses: [{ currency: 'USD' }] },
  { airSearchResponses: [{ currency: 'BDT', passengerFares: { ADT: { currencyCode: 'USD' } } }] },
]) {
  const storedRefs = new Map();
  const search = loadSearchModule({ response: reported, storedRefs });
  await assert.rejects(() => search.searchFlights({
    tripType: 'oneway', routes: [{ origin: 'DAC', destination: 'JFK', departureDate: '2026-09-10' }],
    adults: 1, children: 0, infants: 0, childrenAges: [], cabinClass: 1, preferredCarriers: [],
  }, 'takeoff'), currencyModule.UnsupportedCurrencyError);
  assert.equal(storedRefs.size, 0, 'foreign search prices must not be published or cached');
}
const storedRoundTripRefs = mapperStoredRefs.get('refs');
assert.equal(storedRoundTripRefs.size, 1);
const safeRoundTripRefs = storedRoundTripRefs.get('itn-0-0');
assert.ok(safeRoundTripRefs);
assert.deepEqual(
  Array.from(safeRoundTripRefs.segmentCodeRefs),
  ['segment-outbound-1', 'segment-outbound-2', 'segment-inbound-1']
);
assert.equal(safeRoundTripRefs.selection.legs.length, 2);
assert.equal(safeRoundTripRefs.selection.legs[0].segments.length, 2);
assert.equal(safeRoundTripRefs.selection.legs[1].segments.length, 1);

// Same-airport round trips must depart after the preceding arrival, including
// combinations expanded from grouped supplier alternatives.
const domesticDirection = (from, to, departure, arrival, ref) => ({
  from, to, stops: 0,
  segments: [rawRoundTripSegment({from, to, departure, arrival, segmentCodeRef: ref})],
});
for (const scenario of [
  {name:'return before arrival', arrival:'2026-09-30 14:05:00', departure:'2026-09-30 13:40:00', expected:0},
  {name:'grouped invalid and valid returns', arrival:'2026-09-30 14:05:00', departure:'2026-09-30 13:40:00', validAlternative:true, expected:1},
  {name:'return at arrival', arrival:'2026-09-30 14:05:00', departure:'2026-09-30 14:05:00', expected:0},
  {name:'later same day', arrival:'2026-09-30 14:05:00', departure:'2026-09-30 16:40:00', expected:1},
  {name:'overnight arrival', arrival:'2026-10-01 01:05:00', departure:'2026-09-30 23:40:00', expected:0},
  {name:'following day', arrival:'2026-09-30T14:05:00', departure:'2026-10-01T06:40:00', expected:1},
  {name:'explicit offsets', arrival:'2026-09-30T14:05:00+06:00', departure:'2026-09-30T08:00:00Z', expected:0},
  {name:'different airport local clocks', arrival:'2026-09-30 14:05:00', departure:'2026-09-30 13:40:00', returnFrom:'DOH', expected:1},
]) {
  const refs = new Map();
  const checked = loadSearchModule({response:{airSearchResponses:[{
    uniqueTransID:'chronology-trans', itemCodeRef:'chronology-item', totalPrice:1000, basePrice:900, taxes:100,
    directions:[
      [domesticDirection('DAC','CGP','2026-09-30 13:10:00',scenario.arrival,'chronology-out')],
      [domesticDirection(scenario.returnFrom??'CGP','DAC',scenario.departure,'2026-10-01 12:00:00','chronology-in'),
        ...(scenario.validAlternative ? [domesticDirection('CGP','DAC','2026-09-30 16:40:00','2026-09-30 17:35:00','chronology-valid-in')] : [])],
    ],
  }]},storedRefs:refs});
  const result = await checked.searchFlights({tripType:'round',routes:[
    {origin:'DAC',destination:'CGP',departureDate:'2026-09-30'},
    {origin:scenario.returnFrom??'CGP',destination:'DAC',departureDate:'2026-09-30'},
  ],adults:1,children:0,infants:0,childrenAges:[],cabinClass:1,preferredCarriers:[]},'takeoff');
  assert.equal(result.result.itineraries.length,scenario.expected,scenario.name);
  assert.equal(refs.get('refs')?.size??0,scenario.expected,`${scenario.name}: cached references`);
  if(scenario.validAlternative)assert.deepEqual(Array.from(refs.get('refs').keys()),['itn-0-1']);
}

// A real grouped card must retain the exact public snapshot for every option,
// not reconstruct its primary itinerary for an upsell click. These three
// fares share flights but deliberately differ in the display RBD, which is
// part of the signed booking snapshot while remaining outside the grouping key.
const groupedOffer = (index, bookingClass, totalPrice) => ({
  uniqueTransID: 'grouped-trans',
  itemCodeRef: `grouped-item-${index}`,
  totalPrice,
  basePrice: totalPrice - 100,
  taxes: 100,
  platingCarrier: 'QR',
  platingCarrierName: 'Qatar Airways',
  directions: [
    [
      {
        ...structuredClone(validOutbound),
        segments: validOutbound.segments.map((segment) => ({
          ...segment,
          bookingClass,
          operatingCarrier: ' ba ',
          isCodeShared: true,
        })),
      },
    ],
    [
      {
        ...structuredClone(validInbound),
        segments: validInbound.segments.map((segment) => ({
          ...segment,
          bookingClass,
        })),
      },
    ],
  ],
});
const groupedStoredRefs = new Map();
const groupedMapper = loadSearchModule({
  response: {
    airSearchResponses: [
      groupedOffer(0, 'U', 1000),
      groupedOffer(1, 'K', 1100),
      groupedOffer(2, 'T', 1200),
    ],
  },
  storedRefs: groupedStoredRefs,
});
const groupedSearch = await groupedMapper.searchFlights(
  {
    tripType: 'round',
    routes: [
      { origin: 'DAC', destination: 'JFK', departureDate: '2026-09-10' },
      { origin: 'JFK', destination: 'DAC', departureDate: '2026-09-30' },
    ],
    adults: 1,
    children: 0,
    infants: 0,
    childrenAges: [],
    cabinClass: 1,
    preferredCarriers: [],
  },
  'takeoff'
);
assert.equal(groupedSearch.result.itineraries.length, 1);
const groupedCard = groupedSearch.result.itineraries[0];
assert.equal(groupedCard.upsellOptions.length, 2);
const distinctRoundTrip = groupedOffer(3, 'M', 1300);
distinctRoundTrip.directions[0][0].segments[0].flightNumber = 'QR-999';
const limitedStoredRefs = new Map();
const limitedMapper = loadSearchModule({
  response: {
    airSearchResponses: [
      groupedOffer(0, 'U', 1000),
      groupedOffer(1, 'K', 1100),
      distinctRoundTrip,
    ],
  },
  storedRefs: limitedStoredRefs,
  maxStoredOptions: 1,
});
const limitedRoundTrip = await limitedMapper.searchFlights({
  tripType: 'round',
  routes: [
    { origin: 'DAC', destination: 'JFK', departureDate: '2026-09-10' },
    { origin: 'JFK', destination: 'DAC', departureDate: '2026-09-30' },
  ],
  adults: 1,
  children: 0,
  infants: 0,
  childrenAges: [],
  cabinClass: 1,
  preferredCarriers: [],
}, 'takeoff');
assert.equal(limitedRoundTrip.result.limitedByQuoteSize, true);
assert.equal(limitedRoundTrip.result.itineraries.length, 1);
assert.equal(limitedRoundTrip.result.itineraries[0].totalPrice, 1000);
assert.equal(limitedRoundTrip.result.itineraries[0].upsellOptions.length, 0);
assert.deepEqual(
  Array.from(limitedStoredRefs.get('refs').keys()),
  [limitedRoundTrip.result.itineraries[0].id],
  'only displayed fares retain private supplier references'
);
const codeshareOffer = groupedOffer(10, 'O', 1000);
codeshareOffer.isCodeShared = true;
const codeshareStoredRefs = new Map();
const codeshareMapper = loadSearchModule({
  response: { airSearchResponses: [codeshareOffer] },
  storedRefs: codeshareStoredRefs,
});
const codeshareSearch = await codeshareMapper.searchFlights({
  tripType: 'round', routes: [
    { origin: 'DAC', destination: 'JFK', departureDate: '2026-09-10' },
    { origin: 'JFK', destination: 'DAC', departureDate: '2026-09-30' },
  ], adults: 1, children: 0, infants: 0, childrenAges: [], cabinClass: 1, preferredCarriers: [],
}, 'takeoff');
const codeshareCard = codeshareSearch.result.itineraries[0];
assert.equal(codeshareCard.codeshare, true);
const codeshareSnapshot = {
  carrierCode: codeshareCard.carrierCode, carrierName: codeshareCard.carrierName,
  refundable: codeshareCard.refundable, codeshare: true, legs: codeshareCard.legs,
};
assert.equal(matchesBookingSnapshot(codeshareStoredRefs.get('refs').get(codeshareCard.id), codeshareSnapshot), true);
assert.equal(matchesBookingSnapshot(codeshareStoredRefs.get('refs').get(codeshareCard.id), {...codeshareSnapshot, codeshare: false}), false);
assert.equal(groupedCard.codeshare, undefined, 'missing codeshare flag must remain unknown');
const changedOperator = structuredClone(groupedCard);
changedOperator.id = 'different-operator';
changedOperator.legs[0].segments[0].operatingCarrierCode = 'AA';
assert.equal(groupUpsellOptions([groupedCard, changedOperator]).length, 2,
  'different operating carriers must not merge into a single schedule card');
const groupedOptions = [groupedCard, ...groupedCard.upsellOptions];
const groupedRefsById = groupedStoredRefs.get('refs');
assert.equal(groupedRefsById.size, 3);
for (const option of groupedOptions) {
  const optionRefs = groupedRefsById.get(option.id);
  assert.ok(optionRefs);
  assert.equal(
    matchesBookingSnapshot(optionRefs, {
      carrierCode: option.carrierCode,
      carrierName: option.carrierName,
      refundable: option.refundable,
      legs: option.legs,
    }),
    true,
    `grouped option ${option.id} must retain its own public snapshot digest`
  );
  for (const leg of option.legs) {
    for (const segment of leg.segments) {
      assert.equal(segment.departureTerminal, null);
      assert.equal(segment.arrivalTerminal, null);
    }
  }
  assert.equal(option.legs[0].segments[0].operatingCarrierCode, 'BA');
  assert.equal(option.legs[0].segments[0].codeshare, true);
  assert.equal(option.legs[1].segments[0].operatingCarrierCode, undefined,
    'airlineCode alone must not become a claimed operating carrier');
}
assert.equal(
  matchesBookingSnapshot(groupedRefsById.get(groupedOptions[0].id), {
    carrierCode: groupedOptions[1].carrierCode,
    carrierName: groupedOptions[1].carrierName,
    refundable: groupedOptions[1].refundable,
    legs: groupedOptions[1].legs,
  }),
  false,
  'an upsell snapshot cannot be used with the grouped primary private refs'
);
const groupedPrepareAttempts = [];
const groupedPrepareRoute = loadPrepareRoute({
  search: {
    supplierAccount: 'takeoff',
    expiresAt: Date.now() + 60_000,
    refsByItineraryId: groupedRefsById,
  },
  createdAttempts: groupedPrepareAttempts,
});
for (const option of groupedOptions) {
  const prepared = await groupedPrepareRoute.POST({
    json: async () =>
      preparePayload(option.id, {
        carrierCode: option.carrierCode,
        carrierName: option.carrierName,
        refundable: option.refundable,
        legs: option.legs,
      }),
  });
  assert.equal(prepared.status, 200, `Prepare accepts grouped option ${option.id}`);
}
assert.equal(groupedPrepareAttempts.length, 3);
const shaponPrepareAttempts = [];
const shaponPrepareRoute = loadPrepareRoute({
  search: {
    supplierAccount: 'shapontravels',
    expiresAt: Date.now() + 60_000,
    refsByItineraryId: groupedRefsById,
  },
  createdAttempts: shaponPrepareAttempts,
});
const shaponPrepare = await shaponPrepareRoute.POST({
  json: async () => preparePayload(groupedOptions[0].id, {
    carrierCode: groupedOptions[0].carrierCode,
    carrierName: groupedOptions[0].carrierName,
    refundable: groupedOptions[0].refundable,
    legs: groupedOptions[0].legs,
  }),
});
assert.equal(shaponPrepare.status, 200, 'Shapontravels accepted fare can create a booking attempt');
assert.equal(shaponPrepareAttempts.length, 1);
assert.equal(shaponPrepareAttempts[0].supplierAccount, 'shapontravels');
assert.deepEqual(
  groupedPrepareAttempts.map(
    (attempt) => attempt.offerSnapshot.itinerary.legs[0].segments[0].bookingClass
  ),
  groupedOptions.map((option) => option.legs[0].segments[0].bookingClass),
  'Prepare retains each clicked primary/upsell snapshot rather than the parent card'
);

// An independently malformed snapshot is dropped with its references, while
// another valid fare from the same Search remains durable and selectable.
const isolatedStoredRefs = new Map();
const isolatedMapper = loadSearchModule({
  response: {
    airSearchResponses: [groupedOffer(0, 'Y', 1000), groupedOffer(1, 'BAD', 1100)],
  },
  storedRefs: isolatedStoredRefs,
  canonicalizer: (snapshot) =>
    snapshot?.legs?.[0]?.segments?.[0]?.bookingClass === 'BAD'
      ? null
      : canonicalBookingSnapshot(snapshot),
});
const isolatedSearch = await isolatedMapper.searchFlights(
  {
    tripType: 'round',
    routes: [
      { origin: 'DAC', destination: 'JFK', departureDate: '2026-09-10' },
      { origin: 'JFK', destination: 'DAC', departureDate: '2026-09-30' },
    ],
    adults: 1,
    children: 0,
    infants: 0,
    childrenAges: [],
    cabinClass: 1,
    preferredCarriers: [],
  },
  'takeoff'
);
assert.equal(isolatedSearch.result.itineraries.length, 1);
assert.equal(isolatedSearch.result.droppedOfferCount, 1);
assert.equal(isolatedStoredRefs.get('refs').size, 1);

// FirstTrip shares the reference mapper/store but does not inherit TakeOff
// request/retry behavior. A FirstTrip Search still emits the canonical public
// terminal shape and persists only its own supplier account.
const firstTripMapperStoredRefs = new Map();
const firstTripMapper = loadSearchModule({
  response: { airSearchResponses: [groupedOffer(0, 'Y', 1000)] },
  storedRefs: firstTripMapperStoredRefs,
});
const firstTripMappedSearch = await firstTripMapper.searchFlights(
  {
    tripType: 'round',
    routes: [
      { origin: 'DAC', destination: 'JFK', departureDate: '2026-09-10' },
      { origin: 'JFK', destination: 'DAC', departureDate: '2026-09-30' },
    ],
    adults: 1,
    children: 0,
    infants: 0,
    childrenAges: [],
    cabinClass: 1,
    preferredCarriers: [],
  },
  'firsttrip'
);
assert.equal(firstTripMapperStoredRefs.get('supplier'), 'firsttrip');
assert.equal(firstTripMappedSearch.result.itineraries.length, 1);
assert.equal(
  firstTripMappedSearch.result.itineraries[0].legs[0].segments[0].departureTerminal,
  null
);

// The compact Redis v2 representation must preserve the full round-trip
// direction/segment boundary across an instance change. It carries only the
// minimal RePrice signature plus the public snapshot digest, not the full
// display object.
const roundTripRedisClock = { now: 900_000 };
const roundTripRedis = new FakeRedis(roundTripRedisClock);
const roundTripSearchId = '00000000-0000-4000-8000-000000000010';
const roundTripInstanceA = storeFor(roundTripRedis, roundTripRedisClock, roundTripSearchId);
await roundTripInstanceA.storeSearch(
  'supplier-trans',
  new Map([['itn-0-0', roundTripRefs]]),
  'takeoff'
);
const roundTripInstanceB = storeFor(roundTripRedis, roundTripRedisClock, roundTripSearchId);
const crossInstanceRoundTrip = await roundTripInstanceB.readSearch(roundTripSearchId, {
  consistency: 'durable',
});
const crossInstanceRoundTripRefs = crossInstanceRoundTrip?.refsByItineraryId.get('itn-0-0');
assert.ok(crossInstanceRoundTripRefs);
assert.equal(matchesBookingSnapshot(crossInstanceRoundTripRefs, roundTripPublicItinerary), true);
assert.deepEqual(
  Array.from(crossInstanceRoundTripRefs.segmentCodeRefs),
  ['outbound-1', 'outbound-2', 'inbound-1']
);
assert.equal(crossInstanceRoundTripRefs.selection.legs.length, 2);
assert.equal(crossInstanceRoundTripRefs.selection.legs[0].segments.length, 2);
assert.equal(crossInstanceRoundTripRefs.selection.legs[1].segments.length, 1);

// Instance A Search -> B RePrice -> C Prepare-like durable read -> D Book
// handoff. Each store object represents a distinct Vercel instance.
const clock = { now: 1_000_000 };
const redis = new FakeRedis(clock);
const searchId = '00000000-0000-4000-8000-000000000001';
const instanceA = storeFor(redis, clock, searchId);
const stored = await instanceA.storeSearch('supplier-trans', refs(), 'takeoff');
assert.equal(stored.searchId, searchId);
assert.equal(stored.timing.redisPersistenceOutcome, 'success');
assert.equal(redis.calls.set, 1);
const binaryQuote = redis.entry(`flight:quote:v4:{${searchId}}`)?.value;
assert.ok(Buffer.isBuffer(binaryQuote), 'new Redis quotes must be stored as binary');
assert.equal(binaryQuote.subarray(0, 2).toString('ascii'), 'b:');
const legacyTextQuote = `z:${binaryQuote.subarray(2).toString('base64url')}`;
assert.ok(
  binaryQuote.byteLength < Buffer.byteLength(legacyTextQuote, 'utf8'),
  'binary compression must save Redis bytes without losing reference data'
);

// Quotes from the prior deployment must remain readable until their TTL ends.
const legacyClock = { now: 1_000_000 };
const legacyRedis = new FakeRedis(legacyClock);
const legacyStore = storeFor(legacyRedis, legacyClock, searchId);
legacyRedis.entries.set(`flight:quote:v4:{${searchId}}`, {
  value: Buffer.from(legacyTextQuote, 'utf8'),
  expiresAt: legacyClock.now + 60_000,
});
const legacyRead = await legacyStore.readSearch(searchId);
assert.equal(legacyRead?.refsByItineraryId.size, refs().size);
assert.equal(legacyRead?.uniqueTransId, 'supplier-trans');

const instanceB = storeFor(redis, clock, searchId);
const searchB = await instanceB.readSearch(searchId, { consistency: 'durable' });
assert.ok(searchB);
const refB = searchB.refsByItineraryId.get('itn-0-0');
assert.ok(refB);
const owner = principal('owner-a');
const previousOwnerSelection = await instanceB.readRepricedSelection(
  searchId,
  'itn-0-0',
  owner
);
const expectedVersion = previousOwnerSelection?.quoteStoreVersion ?? 0;
assert.equal(expectedVersion, 0);
assert.equal(
  await instanceB.storeRepricedSelection(
    searchId,
    'itn-0-0',
    reprice('price-a'),
    owner,
    expectedVersion
  ),
  true
);

const instanceC = storeFor(redis, clock, searchId);
const searchC = await instanceC.readSearch(searchId, { consistency: 'durable' });
const refsC = searchC?.refsByItineraryId.get('itn-0-0');
assert.ok(refsC);
const verified = await instanceC.readRepricedSelection(searchId, 'itn-0-0', owner);
assert.equal(verified?.priceCodeRef, 'price-a');
const bookingAttemptSnapshot = {
  supplierAccount: searchC.supplierAccount,
  searchId,
  itineraryId: 'itn-0-0',
  supplierRefs: {
    uniqueTransId: verified.uniqueTransId,
    itemCodeRef: verified.itemCodeRef,
    priceCodeRef: verified.priceCodeRef,
  },
};
assert.deepEqual(bookingAttemptSnapshot.supplierRefs, {
  uniqueTransId: 'supplier-trans',
  itemCodeRef: 'item-ref',
  priceCodeRef: 'price-a',
});

// The shared quote graph is supplier-agnostic: FirstTrip uses the same
// cross-instance authority without changing any of its supplier retry rules.
const firstTripClock = { now: 1_500_000 };
const firstTripRedis = new FakeRedis(firstTripClock);
const firstTripSearchId = '00000000-0000-4000-8000-000000000009';
const firstTripStore = storeFor(firstTripRedis, firstTripClock, firstTripSearchId);
await firstTripStore.storeSearch('firsttrip-trans', refs(), 'firsttrip');
assert.equal(
  (await firstTripStore.readSearch(firstTripSearchId))?.supplierAccount,
  'firsttrip'
);

// D represents Book after the quote is deleted/expired: the durable attempt
// snapshot, not Redis, carries the supplier Book capability.
redis.entries.clear();
const instanceD = storeFor(redis, clock, searchId);
assert.equal(await instanceD.readSearch(searchId, { consistency: 'durable' }), null);
assert.equal(bookingAttemptSnapshot.supplierRefs.priceCodeRef, 'price-a');

// Search idempotency and no local-memory authority.
const idemClock = { now: 2_000_000 };
const idemRedis = new FakeRedis(idemClock);
const idemA = storeFor(idemRedis, idemClock, searchId);
const idemB = storeFor(idemRedis, idemClock, searchId);
await idemA.storeSearch('supplier-trans', refs(), 'takeoff');
await idemB.storeSearch('supplier-trans', refs(), 'takeoff');
assert.equal(idemRedis.calls.set, 2);
assert.equal((await idemB.readSearch(searchId))?.supplierAccount, 'takeoff');
idemRedis.failGet = true;
await expectStoreError(() => idemB.readSearch(searchId), 'unavailable');
idemRedis.failGet = false;

// Redis unavailable, failure-before-commit, and ambiguous after-commit Search
// writes fail closed or verify exactly without any supplier retry.
const failureClock = { now: 3_000_000 };
const failureRedis = new FakeRedis(failureClock);
const failureStore = storeFor(failureRedis, failureClock, searchId);
failureRedis.failSet = 'before';
failureRedis.failGet = true;
await expectStoreError(
  () => failureStore.storeSearch('supplier-trans', refs(), 'takeoff'),
  'unavailable'
);
failureRedis.failGet = false;
assert.equal(await failureStore.readSearch(searchId), null);

const afterCommitRedis = new FakeRedis(failureClock);
const afterCommitStore = storeFor(afterCommitRedis, failureClock, searchId);
afterCommitRedis.failSet = 'after';
assert.equal(
  (await afterCommitStore.storeSearch('supplier-trans', refs(), 'takeoff')).searchId,
  searchId
);
assert.equal(afterCommitRedis.calls.set, 1, 'ambiguous committed SET is verified, not replayed');
assert.ok(afterCommitRedis.calls.get >= 1);

const timeoutAfterCommitRedis = new FakeRedis(failureClock);
const timeoutAfterCommitStore = storeFor(timeoutAfterCommitRedis, failureClock, searchId);
timeoutAfterCommitRedis.failSet = 'timeout-after';
assert.equal(
  (await timeoutAfterCommitStore.storeSearch('supplier-trans', refs(), 'takeoff')).searchId,
  searchId
);
assert.equal(timeoutAfterCommitRedis.calls.set, 1, 'timeout-after-commit verifies before retrying');
assert.ok(timeoutAfterCommitRedis.calls.get >= 1);

const timeoutBeforeCommitRedis = new FakeRedis(failureClock);
const timeoutBeforeCommitStore = storeFor(timeoutBeforeCommitRedis, failureClock, searchId);
timeoutBeforeCommitRedis.failSet = 'timeout-before';
assert.equal(
  (await timeoutBeforeCommitStore.storeSearch('supplier-trans', refs(), 'takeoff')).searchId,
  searchId
);
assert.equal(timeoutBeforeCommitRedis.calls.set, 2, 'uncommitted timeout gets one Redis-only retry');

// TTL expiry, incomplete refs, and oversized graphs are rejected before a
// browser can receive a usable search id.
const ttlClock = { now: 4_000_000 };
const ttlRedis = new FakeRedis(ttlClock);
const ttlStore = storeFor(ttlRedis, ttlClock, searchId, { ttlSeconds: 1 });
await ttlStore.storeSearch('supplier-trans', refs(), 'takeoff');
ttlClock.now += 1_001;
assert.equal(await ttlStore.readSearch(searchId), null);

const invalidRedis = new FakeRedis(ttlClock);
const invalidStore = storeFor(invalidRedis, ttlClock, searchId);
await expectStoreError(
  () => invalidStore.storeSearch('supplier-trans', refs({ segmentCodeRefs: [] }), 'takeoff'),
  'integrity'
);
assert.equal(invalidRedis.calls.set, 0);
const oversizedRedis = new FakeRedis(ttlClock);
const oversizedStore = storeFor(oversizedRedis, ttlClock, searchId, { maxBytes: 16 });
await expectStoreError(
  () => oversizedStore.storeSearch('supplier-trans', refs(), 'takeoff'),
  'integrity'
);
await assert.rejects(
  () => oversizedStore.storeSearch('supplier-trans', refs(), 'takeoff'),
  SearchQuoteTooLargeError
);
assert.equal(oversizedRedis.calls.set, 0);
const corruptRedis = new FakeRedis(ttlClock);
const corruptStore = storeFor(corruptRedis, ttlClock, searchId);
corruptRedis.entries.set(`flight:quote:v4:{${searchId}}`, {
  value: JSON.stringify({ v: 3, q: 1, e: ttlClock.now + 60_000 }),
  expiresAt: ttlClock.now + 60_000,
});
await expectStoreError(() => corruptStore.readSearch(searchId), 'integrity');

// Atomic RePrice behavior: same-principal stale updates conflict, exact replay
// succeeds, distinct principals merge, and an after-commit error verifies.
const casClock = { now: 5_000_000 };
const casRedis = new FakeRedis(casClock);
const casStore = storeFor(casRedis, casClock, searchId);
await casStore.storeSearch('supplier-trans', refs(), 'takeoff');
const alpha = principal('alpha');
const beta = principal('beta');
assert.equal(await casStore.storeRepricedSelection(searchId, 'itn-0-0', reprice('alpha-1'), alpha, 0), true);
assert.equal(await casStore.storeRepricedSelection(searchId, 'itn-0-0', reprice('alpha-1'), alpha, 0), true);
await expectStoreError(
  () => casStore.storeRepricedSelection(searchId, 'itn-0-0', reprice('alpha-stale'), alpha, 0),
  'conflict'
);
assert.equal(await casStore.storeRepricedSelection(searchId, 'itn-0-0', reprice('beta-1'), beta, 0), true);
const merged = await casStore.readSearch(searchId);
const mergedRefs = merged?.refsByItineraryId.get('itn-0-0');
assert.ok(mergedRefs);
assert.equal(
  (await casStore.readRepricedSelection(searchId, 'itn-0-0', alpha))?.priceCodeRef,
  'alpha-1'
);
assert.equal(
  (await casStore.readRepricedSelection(searchId, 'itn-0-0', beta))?.priceCodeRef,
  'beta-1'
);
assert.match(casRedis.lastScript, /PTTL/);
assert.equal(pricingPrincipalKey(alpha).length, 64);

const casAfterCommitClock = { now: 6_000_000 };
const casAfterCommitRedis = new FakeRedis(casAfterCommitClock);
const casAfterCommitStore = storeFor(casAfterCommitRedis, casAfterCommitClock, searchId);
await casAfterCommitStore.storeSearch('supplier-trans', refs(), 'takeoff');
casAfterCommitRedis.failEval = 'after';
assert.equal(
  await casAfterCommitStore.storeRepricedSelection(
    searchId,
    'itn-0-0',
    reprice('verified-after-timeout'),
    principal('after-timeout'),
    0
  ),
  true
);
assert.ok(casAfterCommitRedis.calls.get >= 1);

const repriceUnavailableClock = { now: 7_000_000 };
const repriceUnavailableRedis = new FakeRedis(repriceUnavailableClock);
const repriceUnavailableStore = storeFor(repriceUnavailableRedis, repriceUnavailableClock, searchId);
await repriceUnavailableStore.storeSearch('supplier-trans', refs(), 'firsttrip');
repriceUnavailableRedis.failEval = 'before';
repriceUnavailableRedis.failGet = true;
await expectStoreError(
  () => repriceUnavailableStore.storeRepricedSelection(
    searchId,
    'itn-0-0',
    reprice('unavailable'),
    principal('redis-down'),
    0
  ),
  'unavailable'
);
repriceUnavailableRedis.failGet = false;
const afterUnavailable = await repriceUnavailableStore.readSearch(searchId);
assert.equal(
  await repriceUnavailableStore.readRepricedSelection(
    searchId,
    'itn-0-0',
    principal('redis-down')
  ),
  null
);

console.log('flight-search Redis reference safety verification passed');
