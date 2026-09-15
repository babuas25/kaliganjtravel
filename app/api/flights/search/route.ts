import { after, NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { CABIN_CLASSES } from '@/lib/flights/cabin';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  pricingAudienceForPrincipal,
  pricingPrincipalForSession,
  type PricingPrincipal,
} from '@/lib/flights/pricing-principal';
import { SearchReferenceStoreError } from '@/lib/flights/search-cache';
import type { FlightSearchInput } from '@/lib/flights/types';
import type {
  FlightSearchTraceDetails,
  FlightSearchTraceEvent,
  FlightSearchTraceObserver,
} from '@/lib/flights/search-trace';
import { requestActorKey } from '@/lib/http/actor-key';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { TriploverError } from '@/lib/triplover/client';
import { UnsupportedCurrencyError } from '@/lib/currency';
import { isTriploverConfigured } from '@/lib/triplover/config';
import { getSupplierOperationalControls } from '@/lib/db/supplier-controls';
import { recordFlightSearch } from '@/lib/db/flight-search-history';
import {
  beginFlightSearchUsage,
  claimFlightSearchSupplierHit,
  finishFlightSearchUsage,
  type FlightSearchUsageClaim,
} from '@/lib/db/flight-search-usage';
import {
  searchFlights,
  type FlightSearchExecutionTiming,
} from '@/lib/triplover/search';

/**
 * Flight search.
 *
 * Public on purpose — the search panel sits on the marketing home page as well
 * as in the dashboard, so a signed-out visitor must be able to use it. That
 * makes this the one endpoint here that is rate limited by address.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Triplover's Search is slow: a live one-way DAC→CXB took **57 seconds** and a
 * round trip returning 66 offers took longer, because the supplier fans out to
 * several of its own sources and waits for the slowest.
 *
 * Vercel's default function duration is far below that, so without this the
 * platform kills the function before the supplier answers and every search
 * looks broken. The value is clamped to whatever the plan allows — on a plan
 * capped at 60s this endpoint will still time out on slow routes, which is a
 * hosting decision rather than something the code can fix.
 */
export const maxDuration = 300;

const MAX_SEATS = 9;
const MAX_ROUTES = 6;

const iata = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Airport codes are three letters.');

const routeSchema = z.object({
  origin: iata,
  destination: iata,
  departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD.'),
});

const searchSchema = z
  .object({
    tripType: z.enum(['oneway', 'round', 'multicity']),
    // Reject unsupported fare preferences instead of stripping them and
    // silently returning ordinary fares.
    fareType: z.literal('regular', {
      errorMap: () => ({ message: 'Only regular fares are currently available.' }),
    }).optional(),
    routes: z.array(routeSchema).min(1).max(MAX_ROUTES),
    adults: z.number().int().min(1).max(MAX_SEATS),
    children: z.number().int().min(0).max(8),
    infants: z.number().int().min(0).max(MAX_SEATS),
    // Real ages only, 2–11. The supplier buckets them into CHD (5–11) and
    // CNN (2–4) itself, and the bucketing changes the price.
    childrenAges: z.array(z.number().int().min(2).max(11)).max(8),
    cabinClass: z.union([
      z.literal(CABIN_CLASSES[0].value),
      z.literal(CABIN_CLASSES[1].value),
      z.literal(CABIN_CLASSES[2].value),
      z.literal(CABIN_CLASSES[3].value),
      z.literal(CABIN_CLASSES[4].value),
    ]),
    preferredCarriers: z
      .array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2}$/))
      .max(8),
  })
  .superRefine((value, ctx) => {
    // Seats are what is capped; an infant rides on a lap.
    if (value.adults + value.children > MAX_SEATS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `A search can carry at most ${MAX_SEATS} seated passengers.`,
      });
    }
    if (value.infants > value.adults) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Each infant must travel with an adult.',
      });
    }
    // One age per child. A partial list is worse than none: an adapter that
    // trusts it misprices someone.
    if (value.childrenAges.length !== value.children) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Every child needs an age.',
      });
    }
    if (value.tripType === 'oneway' && value.routes.length !== 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A one-way trip has one route.' });
    }
    if (value.tripType === 'round' && value.routes.length !== 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A round trip has two routes.' });
    }
    if (value.tripType === 'multicity' && value.routes.length < 2) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A multi-city trip has at least two routes.' });
    }
    value.routes.forEach((route, index) => {
      if (route.origin === route.destination) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Leg ${index + 1} departs and arrives at the same airport.`,
        });
      }
    });
  });

/**
 * Ceiling on searches running at once, across every caller on this instance.
 *
 * The per-actor rate limit bounds how often one person can search; this bounds
 * how much of the supplier we occupy at any moment. With each call holding a
 * connection open for the better part of a minute, concurrency — not request
 * rate — is what a slow supplier actually feels, and Triplover publishes no
 * budget for either.
 */
const MAX_CONCURRENT_SEARCHES = 8;
let inFlightSearches = 0;

type RouteTiming = Partial<FlightSearchExecutionTiming> & {
  supplierControlsMs?: number;
  validationMs?: number;
  authorizationMs?: number;
  rateLimitMs?: number;
  serializationMs?: number;
  /** Redis confirmation through the final SSE result enqueue. */
  redisConfirmedToFinalSseResultMs?: number;
  totalMs?: number;
};

type TimingLogMeta = {
  outcome: 'success' | 'error';
  errorCode?: string;
  itineraryCount?: number;
  partial?: boolean;
};

type StreamProgressStage =
  | 'accepted'
  | 'validating'
  | 'authorizing'
  | 'searching'
  | 'processing'
  | 'finalizing';

type StreamProgress = {
  stage: StreamProgressStage;
  /** Opaque server-issued identifier for correlating this SSE response to logs. */
  traceId?: string;
};

type SearchTraceEntry = {
  name: string;
  at: string;
  offsetMs: number;
  details?: FlightSearchTraceDetails;
};

type SearchTrace = {
  id: string;
  requestReceivedAt: string;
  entries: SearchTraceEntry[];
  mark: FlightSearchTraceObserver;
};

const SERVER_TIMING_FIELDS: ReadonlyArray<{
  key: keyof RouteTiming;
  name: string;
  description: string;
}> = [
  { key: 'supplierControlsMs', name: 'supplier-controls', description: 'Supplier operational-control lookup' },
  { key: 'validationMs', name: 'validation', description: 'Body parsing and validation' },
  { key: 'authorizationMs', name: 'authorization', description: 'Session and pricing-principal lookup' },
  { key: 'rateLimitMs', name: 'rate-limit', description: 'Shared flight-search rate-limit check' },
  { key: 'tokenMs', name: 'token', description: 'Triplover token acquisition' },
  { key: 'apiRequestMs', name: 'triplover', description: 'Triplover API request and body transfer' },
  { key: 'apiTtfbMs', name: 'triplover-ttfb', description: 'Triplover time to response headers' },
  { key: 'responseReadMs', name: 'response-read', description: 'Triplover response body transfer' },
  { key: 'responseParseMs', name: 'response-parse', description: 'Triplover response JSON parsing' },
  { key: 'markupRulesMs', name: 'markup-rules', description: 'Markup-rule lookup running beside supplier Search' },
  { key: 'postSupplierMarkupWaitMs', name: 'markup-tail', description: 'Markup-rule wait after supplier Search completes' },
  { key: 'mappingMs', name: 'mapping', description: 'Offer mapping and normalization' },
  { key: 'cacheWriteMs', name: 'cache-write', description: 'Redis quote persistence wrapper' },
  { key: 'redisPersistenceMs', name: 'redis-persist', description: 'Redis quote persistence confirmation' },
  { key: 'supplierCompleteToRedisConfirmedMs', name: 'supplier-to-redis', description: 'Supplier response complete through Redis confirmation' },
  { key: 'redisConfirmedToFinalSseResultMs', name: 'redis-to-sse', description: 'Redis confirmation through final SSE result enqueue' },
  { key: 'serializationMs', name: 'serialize', description: 'Browser response JSON serialization' },
  { key: 'totalMs', name: 'total', description: 'Total route execution' },
];

function rounded(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/**
 * All entries use the server handler's monotonic clock, with an ISO timestamp
 * alongside it for Vercel-log correlation. They intentionally describe server
 * enqueue/close operations, not browser receipt or TCP teardown.
 */
function createSearchTrace(): SearchTrace {
  const requestReceivedAt = new Date().toISOString();
  const startedAt = performance.now();
  const entries: SearchTraceEntry[] = [];
  const trace: SearchTrace = {
    id: randomUUID(),
    requestReceivedAt,
    entries,
    mark(event: FlightSearchTraceEvent) {
      entries.push({
        name: event.name,
        at: new Date().toISOString(),
        offsetMs: rounded(performance.now() - startedAt),
        ...(event.details ? { details: { ...event.details } } : {}),
      });
    },
  };
  trace.mark({ name: 'request_received' });
  return trace;
}

function serverTimingHeader(timing: RouteTiming): string {
  return SERVER_TIMING_FIELDS.flatMap(({ key, name, description }) => {
    const value = timing[key];
    if (typeof value !== 'number') return [];

    const metricDescription =
      key === 'tokenMs' && timing.tokenSource
        ? `${description} (${timing.tokenSource})`
        : description;
    return `${name};dur=${rounded(value)};desc="${metricDescription}"`;
  }).join(', ');
}

function logSearchTiming(
  timing: RouteTiming,
  status: number,
  meta: TimingLogMeta,
  trace?: SearchTrace
) {
  const timingsMs = Object.fromEntries(
    SERVER_TIMING_FIELDS.flatMap(({ key }) => {
      const value = timing[key];
      return typeof value === 'number' ? [[key, rounded(value)]] : [];
    })
  );
  console.info(
    '[flight-search-timing]',
    JSON.stringify({
      ...meta,
      status,
      tokenSource: timing.tokenSource ?? null,
      tokenLoginAttempts: timing.tokenLoginAttempts ?? null,
      attempts: timing.attempts ?? null,
      redisPersistenceOutcome: timing.redisPersistenceOutcome ?? null,
      timingsMs,
      trace: trace
        ? {
            id: trace.id,
            requestReceivedAt: trace.requestReceivedAt,
            entries: trace.entries,
          }
        : null,
    })
  );
}

type PublicSearchFailure = {
  status: number;
  errorCode: string;
  errorMessage: string;
};

function searchControlFailure(
  claim: FlightSearchUsageClaim
): PublicSearchFailure {
  switch (claim.code) {
    case 'USER_SEARCH_DISABLED':
      return {
        status: 403,
        errorCode: claim.code,
        errorMessage:
          'Flight search is disabled for this account. Please contact support.',
      };
    case 'USER_DAILY_LIMIT_REACHED':
      return {
        status: 429,
        errorCode: claim.code,
        errorMessage:
          'Your daily flight-search limit has been reached. Please try again tomorrow or contact support.',
      };
    case 'SUPPLIER_DAILY_LIMIT_REACHED':
      return {
        status: 503,
        errorCode: claim.code,
        errorMessage:
          'The supplier daily search limit has been reached. Please try again later.',
      };
    default:
      return {
        status: 503,
        errorCode: 'SEARCH_USAGE_CONTROLS_UNAVAILABLE',
        errorMessage:
          'Flight-search controls are temporarily unavailable. Please try again shortly.',
      };
  }
}

/**
 * Keep supplier transport diagnostics in server logs while returning only a
 * stable, user-safe explanation to the browser.
 */
function publicSearchFailure(error: TriploverError): PublicSearchFailure {
  if (error.kind === 'supplier' && error.status === 200) {
    return {
      status: 502,
      errorCode: 'SUPPLIER_SEARCH_REJECTED',
      errorMessage: 'The airline supplier could not complete this search. Try another date or route, or contact support. This does not mean no flights are available.',
    };
  }
  const diagnosticCode = error.diagnostic?.code;
  // The diagnostic and retry work is intentionally TakeOff-scoped. Preserve
  // the other accounts' stable browser contract while still emitting safe logs.
  if (error.diagnostic?.supplier !== 'takeoff') {
    return error.kind === 'network'
      ? {
          status: 504,
          errorCode: 'SEARCH_TIMEOUT',
          errorMessage: 'The airline system took too long to respond. Please try again.',
        }
      : {
          status: 502,
          errorCode: 'SEARCH_FAILED',
          errorMessage: 'Flight search is temporarily unavailable. Please try again.',
        };
  }
  if (diagnosticCode === 'TOKEN_LOGIN_TIMEOUT') {
    return {
      status: 504,
      errorCode: 'TOKEN_LOGIN_TIMEOUT',
      errorMessage: 'The airline sign-in service took too long to respond. Please try again.',
    };
  }
  if (diagnosticCode?.startsWith('TOKEN_LOGIN_NETWORK_')) {
    return {
      status: 502,
      errorCode: 'TOKEN_LOGIN_NETWORK',
      errorMessage: 'The airline sign-in service is temporarily unavailable. Please try again.',
    };
  }
  if (diagnosticCode === 'SEARCH_TIMEOUT') {
    return {
      status: 504,
      errorCode: 'SEARCH_TIMEOUT',
      errorMessage: 'The airline system took too long to respond. Please try again.',
    };
  }
  if (diagnosticCode?.startsWith('SEARCH_NETWORK_')) {
    return {
      status: 502,
      errorCode: 'SEARCH_NETWORK',
      errorMessage: 'The airline system is temporarily unavailable. Please try again.',
    };
  }
  if (error.kind === 'network') {
    return {
      status: 502,
      errorCode: 'SEARCH_NETWORK',
      errorMessage: 'The airline system is temporarily unavailable. Please try again.',
    };
  }
  return {
    status: 502,
    errorCode: 'SEARCH_FAILED',
    errorMessage: 'Flight search is temporarily unavailable. Please try again.',
  };
}

/**
 * A live supplier result is not usable until its opaque supplier references
 * are durably available to any Vercel instance. Keep persistence diagnostics
 * out of the browser while making that fail-closed boundary explicit.
 */
function publicSearchReferenceFailure(
  error: SearchReferenceStoreError
): PublicSearchFailure {
  if (error.kind === 'unavailable') {
    return {
      status: 503,
      errorCode: 'SEARCH_REFERENCE_PERSISTENCE_UNAVAILABLE',
      errorMessage:
        'We could not securely save the live fare references. Nothing was booked. Please search again.',
    };
  }
  return {
    status: 502,
    errorCode: 'SEARCH_REFERENCE_INVALID',
    errorMessage:
      'The airline returned fare references that could not be verified safely. Please search again.',
  };
}

function logSearchReferenceFailure(error: SearchReferenceStoreError): void {
  // Do not include an error message or the opaque references: both can carry
  // supplier/database details that do not belong in public-facing diagnostics.
  console.error(
    '[flight-search-reference-failure]',
    JSON.stringify({
      kind: error.kind,
      retryable: error.retryable,
    })
  );
}

function logTriploverSearchFailure(error: TriploverError): void {
  const diagnostic = error.diagnostic;
  // This intentionally avoids error.message and raw causes: either may contain
  // supplier-provided text. These fields are safe operational metadata only.
  console.error(
    '[flight-search-failure]',
    JSON.stringify({
      kind: error.kind,
      errorCode: diagnostic?.code ?? `TRIPLOVER_${error.kind.toUpperCase()}`,
      operation: diagnostic?.operation ?? null,
      supplier: diagnostic?.supplier ?? null,
      phase: diagnostic?.phase ?? null,
      transport: diagnostic?.transport ?? null,
      transportCode: diagnostic?.transportCode ?? null,
      elapsedMs: diagnostic?.elapsedMs ?? null,
      loginAttempts: diagnostic?.loginAttempts ?? null,
      supplierStatus: error.status,
    })
  );
}

function timedJson(
  payload: unknown,
  status: number,
  routeStartedAt: number,
  timing: RouteTiming,
  meta: TimingLogMeta,
  extraHeaders?: HeadersInit,
  trace?: SearchTrace
) {
  const serializationStartedAt = performance.now();
  const body = JSON.stringify(payload);
  timing.serializationMs = performance.now() - serializationStartedAt;

  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  timing.totalMs = performance.now() - routeStartedAt;
  // Include Server-Timing in the constructor so the runtime receives it with
  // the rest of the response metadata instead of relying on a later mutation.
  const serializedTiming = serverTimingHeader(timing);
  headers.set('Server-Timing', serializedTiming);
  // Some CDN paths consume Server-Timing. Keep an equivalent diagnostic header
  // so the edge proxy can restore the standard header on the public response.
  headers.set('X-Flight-Search-Timing', serializedTiming);
  const response = new NextResponse(body, { status, headers });
  trace?.mark({ name: 'json_response_ready', details: { status } });
  logSearchTiming(timing, status, meta, trace);

  return response;
}

function fail(
  status: number,
  errorCode: string,
  errorMessage: string,
  routeStartedAt: number,
  timing: RouteTiming,
  extraHeaders?: HeadersInit,
  trace?: SearchTrace
) {
  trace?.mark({ name: 'json_search_failed', details: { status, errorCode } });
  return timedJson(
    { success: false, error: { errorCode, errorMessage } },
    status,
    routeStartedAt,
    timing,
    { outcome: 'error', errorCode },
    extraHeaders,
    trace
  );
}

/**
 * Audience is derived from the server session, never accepted from the search
 * payload. A Super Admin sees supplier payable for auditing. An owner and their
 * sub users share one agency code and therefore one price. Any uncertain
 * identity/storage answer falls back to B2C gross pricing, which is the safe
 * side of an incomplete lookup.
 */
async function pricingPrincipal(): Promise<PricingPrincipal> {
  try {
    const session = await getDashboardSession();
    return pricingPrincipalForSession(session);
  } catch (error) {
    console.error('[markup] pricing audience lookup failed:', error);
  }
  return pricingPrincipalForSession(null);
}

function isStreamRequest(request: NextRequest): boolean {
  return request.headers.get('accept')?.includes('text/event-stream') ?? false;
}

function streamEvent(event: string, payload: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

/**
 * The supplier's Search endpoint currently answers with one complete JSON
 * envelope. This stream makes the *search request* immediately observable and
 * keeps the browser informed truthfully while it waits; it cannot emit flight
 * cards before Triplover has supplied them.
 */
function streamedSearch(request: NextRequest): Response {
  const routeStartedAt = performance.now();
  const timing: RouteTiming = {};
  const trace = createSearchTrace();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let streamOpen = true;
      let searchSlotHeld = false;
      let currentStage: StreamProgressStage = 'accepted';
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let hasEnqueuedSseEvent = false;
      let usageEventId: string | null = null;

      const send = (event: string, payload: unknown): boolean => {
        if (!streamOpen) return false;
        const firstEvent = !hasEnqueuedSseEvent;
        const finalEvent = event === 'result' || event === 'error';
        if (firstEvent) {
          trace.mark({ name: 'first_sse_event_enqueue_start', details: { event } });
        }
        if (finalEvent) {
          trace.mark({ name: 'final_sse_event_enqueue_start', details: { event } });
        }
        try {
          controller.enqueue(streamEvent(event, payload));
          hasEnqueuedSseEvent = true;
          if (firstEvent) {
            trace.mark({ name: 'first_sse_event_enqueued', details: { event } });
          }
          if (finalEvent) {
            trace.mark({ name: 'final_sse_event_enqueued', details: { event } });
          }
          return true;
        } catch {
          // A navigating browser can close a long search stream. The supplier
          // call still follows its normal timeout/error handling, but no more
          // chunks should be written to the disconnected client.
          streamOpen = false;
          trace.mark({ name: 'sse_event_enqueue_failed', details: { event } });
          return false;
        }
      };

      const sendProgress = (stage: StreamProgressStage) => {
        currentStage = stage;
        send('progress', { stage, traceId: trace.id } satisfies StreamProgress);
      };

      const close = () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        const wasOpen = streamOpen;
        trace.mark({ name: 'sse_stream_close_start', details: { wasOpen } });
        if (!streamOpen) {
          trace.mark({ name: 'sse_stream_close_complete', details: { closed: false } });
          return;
        }
        streamOpen = false;
        let closed = true;
        try {
          controller.close();
        } catch {
          // The browser may have disconnected while the final event was sent.
          closed = false;
        }
        trace.mark({ name: 'sse_stream_close_complete', details: { closed } });
      };

      // This first event is written before any database/session/supplier work.
      // It is the immediate response that lets the page prove the request is
      // live rather than appearing frozen behind a long supplier call.
      send('progress', {
        stage: currentStage,
        traceId: trace.id,
      } satisfies StreamProgress);

      heartbeat = setInterval(() => {
        // A keep-alive is deliberately the current real milestone, not a
        // fabricated supplier progress percentage.
        send('progress', { stage: currentStage } satisfies StreamProgress);
      }, 5_000);

      const executionTask = (async () => {
        const streamFailure = async (
          status: number,
          errorCode: string,
          errorMessage: string
        ) => {
          trace.mark({ name: 'search_failed', details: { status, errorCode } });
          timing.totalMs = performance.now() - routeStartedAt;
          await finishFlightSearchUsage({
            eventId: usageEventId,
            outcome: errorCode === 'RATE_LIMITED'
              ? 'rate_limited'
              : errorCode === 'SEARCH_BUSY'
                ? 'busy'
                : 'failed',
            httpStatus: status,
            errorCode,
            totalMs: timing.totalMs,
            supplierMs: timing.apiRequestMs,
          });
          // Persist the terminal outcome before sending the final event:
          // consumers may disconnect as soon as they receive it.
          const serializationStartedAt = performance.now();
          send('error', { errorCode, errorMessage });
          timing.serializationMs = performance.now() - serializationStartedAt;
          close();
          logSearchTiming(timing, status, { outcome: 'error', errorCode }, trace);
        };

        try {
          sendProgress('validating');
          trace.mark({ name: 'supplier_control_start' });
          const supplierControlsStartedAt = performance.now();
          const supplierControls = await getSupplierOperationalControls();
          timing.supplierControlsMs = performance.now() - supplierControlsStartedAt;
          trace.mark({
            name: 'supplier_control_complete',
            details: {
              supplier: supplierControls.activeSupplier,
              configured: isTriploverConfigured(supplierControls.activeSupplier),
            },
          });
          if (!isTriploverConfigured(supplierControls.activeSupplier)) {
            await streamFailure(
              503,
              'SEARCH_UNCONFIGURED',
              'Flight search is not configured.'
            );
            return;
          }

          const validationStartedAt = performance.now();
          trace.mark({ name: 'validation_start' });
          let payload: unknown;
          try {
            payload = await request.json();
          } catch {
            timing.validationMs = performance.now() - validationStartedAt;
            trace.mark({ name: 'validation_failed' });
            await streamFailure(400, 'INVALID_BODY', 'Expected a JSON body.');
            return;
          }

          const parsed = searchSchema.safeParse(payload);
          timing.validationMs = performance.now() - validationStartedAt;
          if (!parsed.success) {
            trace.mark({ name: 'validation_failed' });
            await streamFailure(
              400,
              'INVALID_SEARCH',
              parsed.error.issues[0]?.message ?? 'That search is not valid.'
            );
            return;
          }
          trace.mark({ name: 'validation_complete' });

          sendProgress('authorizing');
          trace.mark({ name: 'authorization_start' });
          const authorizationStartedAt = performance.now();
          const principal = await pricingPrincipal();
          timing.authorizationMs = performance.now() - authorizationStartedAt;
          const audience = pricingAudienceForPrincipal(principal);
          const actorKey = requestActorKey(request, principal.userId);
          usageEventId = await beginFlightSearchUsage({
            traceId: trace.id,
            actorUserId: principal.userId,
            actorKey,
            actorRole: principal.audience,
            agencyCode: principal.agencyCode,
            supplier: supplierControls.activeSupplier,
            requestMode: 'stream',
            search: parsed.data as FlightSearchInput,
          });
          trace.mark({
            name: 'authorization_complete',
            details: { audience: audience.kind },
          });
          trace.mark({ name: 'rate_limit_start' });
          const rateLimitStartedAt = performance.now();
          const limit = await checkActionLimit(
            'flightSearch',
            actorKey
          );
          timing.rateLimitMs = performance.now() - rateLimitStartedAt;
          trace.mark({ name: 'rate_limit_complete', details: { allowed: limit.ok } });
          if (!limit.ok) {
            await streamFailure(
              429,
              'RATE_LIMITED',
              rateLimitMessage(limit.retryAfterSeconds)
            );
            return;
          }

          if (inFlightSearches >= MAX_CONCURRENT_SEARCHES) {
            trace.mark({ name: 'supplier_admission_rejected' });
            await streamFailure(
              503,
              'SEARCH_BUSY',
              'Too many searches are running just now. Try again in a moment.'
            );
            return;
          }

          inFlightSearches += 1;
          searchSlotHeld = true;
          const usageClaim = await claimFlightSearchSupplierHit({
            eventId: usageEventId,
            supplier: supplierControls.activeSupplier,
            userId: principal.userId,
          });
          if (!usageClaim.allowed) {
            const failure = searchControlFailure(usageClaim);
            if (usageClaim.code !== 'USAGE_CONTROLS_UNAVAILABLE') {
              // The atomic claim already finalized the precise limit outcome.
              usageEventId = null;
            }
            await streamFailure(
              failure.status,
              failure.errorCode,
              failure.errorMessage
            );
            return;
          }

          trace.mark({ name: 'supplier_admission_complete', details: { accepted: true } });
          sendProgress('searching');
          trace.mark({ name: 'search_execution_start' });
          const execution = await searchFlights(
            parsed.data as FlightSearchInput,
            supplierControls.activeSupplier,
            audience,
            {
              onProgress(stage) {
                sendProgress(stage);
              },
              trace: trace.mark,
            }
          );
          Object.assign(timing, execution.timing);

          await recordFlightSearch(
            principal.userId,
            parsed.data as FlightSearchInput
          );

          timing.totalMs = performance.now() - routeStartedAt;
          await finishFlightSearchUsage({
            eventId: usageEventId,
            outcome: 'success',
            httpStatus: 200,
            itineraryCount: execution.result.itineraries.length,
            partial: execution.result.partial,
            totalMs: timing.totalMs,
            supplierMs: timing.apiRequestMs,
          });
          const serializationStartedAt = performance.now();
          const resultEnqueued = send('result', { data: execution.result });
          timing.serializationMs = performance.now() - serializationStartedAt;
          if (
            resultEnqueued &&
            typeof execution.timing.redisPersistenceConfirmedAt === 'number'
          ) {
            timing.redisConfirmedToFinalSseResultMs = Math.max(
              0,
              performance.now() - execution.timing.redisPersistenceConfirmedAt
            );
          }
          close();
          timing.totalMs = performance.now() - routeStartedAt;
          logSearchTiming(
            timing,
            200,
            {
              outcome: 'success',
              itineraryCount: execution.result.itineraries.length,
              partial: execution.result.partial,
            },
            trace
          );
        } catch (error) {
          if (error instanceof UnsupportedCurrencyError) {
            await streamFailure(502, error.code, error.message);
            return;
          }
          if (error instanceof SearchReferenceStoreError) {
            const failure = publicSearchReferenceFailure(error);
            logSearchReferenceFailure(error);
            await streamFailure(
              failure.status,
              failure.errorCode,
              failure.errorMessage
            );
            return;
          }
          if (error instanceof TriploverError) {
            const failure = publicSearchFailure(error);
            logTriploverSearchFailure(error);
            await streamFailure(
              failure.status,
              failure.errorCode,
              failure.errorMessage
            );
            return;
          }
          console.error('Flight search error:', error);
          await streamFailure(
            500,
            'SEARCH_FAILED',
            'Flight search is temporarily unavailable.'
          );
        } finally {
          if (searchSlotHeld) inFlightSearches -= 1;
          if (streamOpen || heartbeat) close();
        }
      })();
      // Keep an admitted search and its terminal usage write alive even if
      // the browser closes the stream. Bounded by this route's maxDuration.
      after(() => executionTask);
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Flight-Search-Trace': trace.id,
    },
  });
}

export async function POST(request: NextRequest) {
  if (isStreamRequest(request)) return streamedSearch(request);

  const routeStartedAt = performance.now();
  const timing: RouteTiming = {};
  const trace = createSearchTrace();
  const traceHeaders = { 'X-Flight-Search-Trace': trace.id };

  trace.mark({ name: 'supplier_control_start' });
  const supplierControlsStartedAt = performance.now();
  const supplierControls = await getSupplierOperationalControls();
  timing.supplierControlsMs = performance.now() - supplierControlsStartedAt;
  trace.mark({
    name: 'supplier_control_complete',
    details: {
      supplier: supplierControls.activeSupplier,
      configured: isTriploverConfigured(supplierControls.activeSupplier),
    },
  });
  if (!isTriploverConfigured(supplierControls.activeSupplier)) {
    return fail(
      503,
      'SEARCH_UNCONFIGURED',
      'Flight search is not configured.',
      routeStartedAt,
      timing,
      traceHeaders,
      trace
    );
  }

  const validationStartedAt = performance.now();
  trace.mark({ name: 'validation_start' });
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    timing.validationMs = performance.now() - validationStartedAt;
    trace.mark({ name: 'validation_failed' });
    return fail(
      400,
      'INVALID_BODY',
      'Expected a JSON body.',
      routeStartedAt,
      timing,
      traceHeaders,
      trace
    );
  }

  const parsed = searchSchema.safeParse(payload);
  timing.validationMs = performance.now() - validationStartedAt;
  if (!parsed.success) {
    trace.mark({ name: 'validation_failed' });
    return fail(
      400,
      'INVALID_SEARCH',
      parsed.error.issues[0]?.message ?? 'That search is not valid.',
      routeStartedAt,
      timing,
      traceHeaders,
      trace
    );
  }
  trace.mark({ name: 'validation_complete' });

  trace.mark({ name: 'authorization_start' });
  const authorizationStartedAt = performance.now();
  const principal = await pricingPrincipal();
  timing.authorizationMs = performance.now() - authorizationStartedAt;
  const audience = pricingAudienceForPrincipal(principal);
  const actorKey = requestActorKey(request, principal.userId);
  const usageEventId = await beginFlightSearchUsage({
    traceId: trace.id,
    actorUserId: principal.userId,
    actorKey,
    actorRole: principal.audience,
    agencyCode: principal.agencyCode,
    supplier: supplierControls.activeSupplier,
    requestMode: 'json',
    search: parsed.data as FlightSearchInput,
  });
  trace.mark({
    name: 'authorization_complete',
    details: { audience: audience.kind },
  });
  trace.mark({ name: 'rate_limit_start' });
  const rateLimitStartedAt = performance.now();
  const limit = await checkActionLimit(
    'flightSearch',
    actorKey
  );
  timing.rateLimitMs = performance.now() - rateLimitStartedAt;
  trace.mark({ name: 'rate_limit_complete', details: { allowed: limit.ok } });
  if (!limit.ok) {
    await finishFlightSearchUsage({
      eventId: usageEventId,
      outcome: 'rate_limited',
      httpStatus: 429,
      errorCode: 'RATE_LIMITED',
      totalMs: performance.now() - routeStartedAt,
    });
    return timedJson(
      {
        success: false,
        error: { errorCode: 'RATE_LIMITED', errorMessage: rateLimitMessage(limit.retryAfterSeconds) },
      },
      429,
      routeStartedAt,
      timing,
      { outcome: 'error', errorCode: 'RATE_LIMITED' },
      { ...traceHeaders, 'Retry-After': String(limit.retryAfterSeconds) },
      trace
    );
  }

  if (inFlightSearches >= MAX_CONCURRENT_SEARCHES) {
    trace.mark({ name: 'supplier_admission_rejected' });
    await finishFlightSearchUsage({
      eventId: usageEventId,
      outcome: 'busy',
      httpStatus: 503,
      errorCode: 'SEARCH_BUSY',
      totalMs: performance.now() - routeStartedAt,
    });
    return timedJson(
      {
        success: false,
        error: {
          errorCode: 'SEARCH_BUSY',
          errorMessage: 'Too many searches are running just now. Try again in a moment.',
        },
      },
      503,
      routeStartedAt,
      timing,
      { outcome: 'error', errorCode: 'SEARCH_BUSY' },
      { ...traceHeaders, 'Retry-After': '15' },
      trace
    );
  }

  inFlightSearches += 1;
  const usageClaim = await claimFlightSearchSupplierHit({
    eventId: usageEventId,
    supplier: supplierControls.activeSupplier,
    userId: principal.userId,
  });
  if (!usageClaim.allowed) {
    inFlightSearches -= 1;
    const failure = searchControlFailure(usageClaim);
    if (usageClaim.code === 'USAGE_CONTROLS_UNAVAILABLE') {
      await finishFlightSearchUsage({
        eventId: usageEventId,
        outcome: 'failed',
        httpStatus: failure.status,
        errorCode: failure.errorCode,
        totalMs: performance.now() - routeStartedAt,
      });
    }
    return timedJson(
      { success: false, error: failure },
      failure.status,
      routeStartedAt,
      timing,
      { outcome: 'error', errorCode: failure.errorCode },
      { ...traceHeaders, 'Retry-After': '60' },
      trace
    );
  }

  trace.mark({ name: 'supplier_admission_complete', details: { accepted: true } });
  try {
    trace.mark({ name: 'search_execution_start' });
    const execution = await searchFlights(
      parsed.data as FlightSearchInput,
      supplierControls.activeSupplier,
      audience,
      { trace: trace.mark }
    );
    Object.assign(timing, execution.timing);
    await recordFlightSearch(
      principal.userId,
      parsed.data as FlightSearchInput
    );
    await finishFlightSearchUsage({
      eventId: usageEventId,
      outcome: 'success',
      httpStatus: 200,
      itineraryCount: execution.result.itineraries.length,
      partial: execution.result.partial,
      totalMs: performance.now() - routeStartedAt,
      supplierMs: timing.apiRequestMs,
    });
    return timedJson(
      { success: true, data: execution.result },
      200,
      routeStartedAt,
      timing,
      {
        outcome: 'success',
        itineraryCount: execution.result.itineraries.length,
        partial: execution.result.partial,
      },
      // Prices are live and the payload carries a session-scoped searchId.
      { ...traceHeaders, 'Cache-Control': 'no-store' },
      trace
    );
  } catch (error) {
    if (error instanceof SearchReferenceStoreError) {
      const failure = publicSearchReferenceFailure(error);
      logSearchReferenceFailure(error);
      await finishFlightSearchUsage({
        eventId: usageEventId,
        outcome: 'failed',
        httpStatus: failure.status,
        errorCode: failure.errorCode,
        totalMs: performance.now() - routeStartedAt,
        supplierMs: timing.apiRequestMs,
      });
      return fail(
        failure.status,
        failure.errorCode,
        failure.errorMessage,
        routeStartedAt,
        timing,
        traceHeaders,
        trace
      );
    }
    if (error instanceof UnsupportedCurrencyError) {
      await finishFlightSearchUsage({
        eventId: usageEventId,
        outcome: 'failed',
        httpStatus: 502,
        errorCode: error.code,
        totalMs: performance.now() - routeStartedAt,
        supplierMs: timing.apiRequestMs,
      });
      return fail(502, error.code, error.message, routeStartedAt, timing, traceHeaders, trace);
    }
    if (error instanceof TriploverError) {
      const failure = publicSearchFailure(error);
      logTriploverSearchFailure(error);
      await finishFlightSearchUsage({
        eventId: usageEventId,
        outcome: 'failed',
        httpStatus: failure.status,
        errorCode: failure.errorCode,
        totalMs: performance.now() - routeStartedAt,
        supplierMs: timing.apiRequestMs,
      });
      return fail(
        failure.status,
        failure.errorCode,
        failure.errorMessage,
        routeStartedAt,
        timing,
        traceHeaders,
        trace
      );
    }
    console.error('Flight search error:', error);
    await finishFlightSearchUsage({
      eventId: usageEventId,
      outcome: 'failed',
      httpStatus: 500,
      errorCode: 'SEARCH_FAILED',
      totalMs: performance.now() - routeStartedAt,
      supplierMs: timing.apiRequestMs,
    });
    return fail(
      500,
      'SEARCH_FAILED',
      'Flight search is temporarily unavailable.',
      routeStartedAt,
      timing,
      traceHeaders,
      trace
    );
  } finally {
    inFlightSearches -= 1;
  }
}
