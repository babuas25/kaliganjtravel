import 'server-only';

import { createHash } from 'crypto';

import {
  LOGIN_TIMEOUT_MS,
  SUPPLIER_TIMEOUT_MS,
  triploverConfig,
  type TriploverConfig,
  type TriploverSupplier,
} from '@/lib/triplover/config';
import type { SupplierReadReceipt } from '@/lib/booking-lifecycle/supplier-evidence';
import type {
  FlightSearchTraceEvent,
  FlightSearchTraceObserver,
} from '@/lib/flights/search-trace';

/**
 * Transport for the Triplover API: authentication, host routing, envelope
 * unwrapping and the retry policy. Everything above this layer deals in mapped
 * domain objects and never sees a bearer token.
 *
 * Three behaviours here come from probing UAT on 2026-07-28 rather than from the
 * documentation, which is wrong or silent on all three. They are marked below.
 */

/* ── Errors ──────────────────────────────────────────────────────────── */

export type TriploverErrorKind =
  /** Credentials rejected, or the token could not be minted. */
  | 'auth'
  /** The supplier answered, but reported a business-level failure. */
  | 'supplier'
  /** Timed out, DNS, TLS, socket — we never got a usable answer. */
  | 'network'
  /** We got an answer we could not parse. */
  | 'protocol'
  /** Env vars absent. */
  | 'unconfigured';

/**
 * Safe transport diagnostics for server logs. These deliberately exclude raw
 * errors, URLs, headers, request bodies, credentials and bearer tokens.
 */
export type TriploverTransportKind = 'timeout' | 'dns' | 'tls' | 'connection' | 'unknown';

export type TriploverFailurePhase = 'request' | 'response-body';

export type TriploverFailureDiagnostic = {
  /** Stable, searchable code such as TOKEN_LOGIN_TIMEOUT or SEARCH_NETWORK_TLS. */
  code: string;
  operation: TriploverOperation;
  supplier: TriploverSupplier;
  phase: TriploverFailurePhase;
  transport: TriploverTransportKind;
  /** A sanitized Node/Undici error code, when one is available. */
  transportCode: string | null;
  elapsedMs: number;
  /** Present when the failure happened after a bounded login retry sequence. */
  loginAttempts?: number;
};

export class TriploverError extends Error {
  readonly kind: TriploverErrorKind;
  readonly status: number | null;
  readonly diagnostic: TriploverFailureDiagnostic | null;

  constructor(
    kind: TriploverErrorKind,
    message: string,
    status: number | null = null,
    diagnostic: TriploverFailureDiagnostic | null = null
  ) {
    super(message);
    this.name = 'TriploverError';
    this.kind = kind;
    this.status = status;
    this.diagnostic = diagnostic;
  }
}

/* ── Operations and the retry policy ─────────────────────────────────── */

/**
 * Every endpoint, tagged with whether replaying it is safe.
 *
 * This exists so that when the booking slices land, nobody has to remember the
 * rule: replaying `Book` or `NewTicket` after an ambiguous failure can issue a
 * second ticket against a real card. The switch is exhaustive, so a new
 * operation cannot be added without answering the question.
 */
export type TriploverOperation =
  | 'LogIn'
  | 'Search'
  | 'FareRules'
  | 'RePrice'
  | 'Book'
  | 'Cancel'
  | 'NewTicket'
  | 'Pnr'
  | 'AirTicketingDetails';

export function isRetrySafe(operation: TriploverOperation): boolean {
  switch (operation) {
    case 'LogIn':
    case 'Search':
    case 'FareRules':
    case 'RePrice':
    case 'Pnr':
    case 'AirTicketingDetails':
      return true;
    // Each of these can create or destroy a booking. If the outcome is unknown,
    // it stays unknown — resolve it by reading the PNR, never by repeating.
    case 'Book':
    case 'Cancel':
    case 'NewTicket':
      return false;
  }
}

/** Which host serves an operation. Search is on its own host (doc §1). */
function hostFor(operation: TriploverOperation, config: TriploverConfig): string {
  return operation === 'Search' ? config.searchBaseUrl : config.baseUrl;
}

/**
 * One small, bounded retry is safe only for a TakeOff token minting request.
 * It must never be moved to `triploverCall`: replaying Search or any supplier
 * write after an ambiguous transport failure would change their semantics.
 */
const TAKEOFF_LOGIN_NETWORK_RETRY_COUNT = 1;
const TAKEOFF_LOGIN_RETRY_DELAY_MS = 250;

/* ── Token cache ─────────────────────────────────────────────────────── */

type CachedToken = { token: string; expiresAt: number };

type LoginResult = { token: string; attempts: number };

export type TokenSource = 'cache-hit' | 'login' | 'shared-login';

type TokenAcquisition = {
  token: string;
  source: TokenSource;
  /** 0 for cache hits; otherwise the physical Login calls shared by this request. */
  loginAttempts: number;
};

/**
 * Module-scope, exactly like the counters in `lib/rate-limit.ts` and for the
 * same reasons: on Vercel this is one cache per warm instance, not one per
 * deployment. That costs at most one extra login per cold instance per 30
 * minutes, which is negligible — and the alternative, a shared token in
 * Postgres, would put a live credential in a second place for no real gain.
 */
const cachedTokens = new Map<TriploverSupplier, CachedToken>();

/**
 * The in-flight login, if one is running. This is the single-flight guard: a
 * burst of concurrent searches on a cold instance all await the same promise
 * instead of firing a login each.
 */
const loginsInFlight = new Map<TriploverSupplier, Promise<LoginResult>>();

/**
 * Renew this far ahead of the server's stated expiry, so a request that is
 * issued just under the wire does not arrive just over it.
 *
 * There is deliberately **no refresh flow**. The login response advertises a
 * `refreshToken`, but the API exposes no endpoint that redeems one — confirmed
 * by reading every endpoint in the supplier documentation. Re-login is the
 * supported path.
 */
const RENEW_MARGIN_MS = 120_000;

/**
 * Drops the cached token only if it is the one the supplier just rejected.
 * A concurrent caller can already have renewed it by the time an old 401 is
 * observed; deleting that fresh token would cause an avoidable duplicate Login.
 */
function invalidateToken(supplier: TriploverSupplier, rejectedToken?: string): void {
  const cached = cachedTokens.get(supplier);
  // This race hardening is scoped to the TakeOff investigation. FirstTrip keeps
  // its established invalidation behavior unchanged.
  if (!cached || (supplier === 'takeoff' && rejectedToken && cached.token !== rejectedToken)) return;
  cachedTokens.delete(supplier);
}

async function loginOnce(config: TriploverConfig): Promise<string> {
  const response = await fetchJson(
    `${config.baseUrl}/api/user/apiLogIn`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // The password is already base64 from the provider — sent verbatim.
      body: JSON.stringify({ email: config.email, password: config.password }),
    },
    LOGIN_TIMEOUT_MS,
    'LogIn',
    config.supplier
  );

  const body = response.body as {
    isSuccess?: boolean;
    message?: string;
    data?: { token?: string; tokenExpieryTime?: string };
  } | null;

  if (!body?.isSuccess || !body.data?.token) {
    throw new TriploverError(
      'auth',
      body?.message ? `Triplover login failed: ${body.message}` : 'Triplover login failed.',
      response.status
    );
  }

  // Note the supplier's spelling — `tokenExpieryTime`, not `tokenExpiryTime`.
  // Matching their typo is required; correcting it silently disables renewal.
  const statedExpiry = Date.parse(body.data.tokenExpieryTime ?? '');
  // Their tokens run 30 minutes. If the field is missing or unparseable, assume
  // a short life rather than a long one — an early renewal is free, a late one
  // is a failed search.
  const expiresAt = Number.isFinite(statedExpiry) ? statedExpiry : Date.now() + 25 * 60_000;

  cachedTokens.set(config.supplier, { token: body.data.token, expiresAt });
  return body.data.token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loginFailureWithAttempts(error: unknown, attempts: number): unknown {
  if (!(error instanceof TriploverError) || !error.diagnostic) return error;
  return new TriploverError(error.kind, error.message, error.status, {
    ...error.diagnostic,
    loginAttempts: attempts,
  });
}

/**
 * TakeOff Login is idempotent and the only request given a transport retry.
 * The retry remains inside the single-flight promise, so concurrent callers
 * share the same two physical attempts rather than multiplying them.
 */
async function login(config: TriploverConfig): Promise<LoginResult> {
  const maximumAttempts =
    config.supplier === 'takeoff' ? 1 + TAKEOFF_LOGIN_NETWORK_RETRY_COUNT : 1;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return { token: await loginOnce(config), attempts: attempt };
    } catch (error) {
      const retryable =
        config.supplier === 'takeoff' &&
        error instanceof TriploverError &&
        error.kind === 'network' &&
        attempt < maximumAttempts;

      if (!retryable) throw loginFailureWithAttempts(error, attempt);

      // Intentionally structured and secret-free: never serialize the error,
      // request, headers, credentials, token, or raw supplier response.
      console.warn(
        '[triplover-token-login-retry]',
        JSON.stringify({
          supplier: config.supplier,
          errorCode: error.diagnostic?.code ?? 'TOKEN_LOGIN_NETWORK_UNKNOWN',
          attempt,
          retryAfterMs: TAKEOFF_LOGIN_RETRY_DELAY_MS,
        })
      );
      await sleep(TAKEOFF_LOGIN_RETRY_DELAY_MS);
    }
  }

  // The loop always returns or throws. This keeps TypeScript's control-flow
  // analysis explicit if the retry constants are ever changed.
  throw new TriploverError('network', 'Triplover LogIn could not be reached.');
}

/** Returns a live token and says whether it came from memory or a login call. */
async function getToken(config: TriploverConfig): Promise<TokenAcquisition> {
  const current = cachedTokens.get(config.supplier);
  if (current && current.expiresAt - RENEW_MARGIN_MS > Date.now()) {
    return { token: current.token, source: 'cache-hit', loginAttempts: 0 };
  }

  // Single flight: the first caller starts the login, everyone else awaits it.
  const existingLogin = loginsInFlight.get(config.supplier);
  if (existingLogin) {
    const result = await existingLogin;
    return { ...result, source: 'shared-login', loginAttempts: result.attempts };
  }

  const loginPromise = login(config).finally(() => {
    loginsInFlight.delete(config.supplier);
  });
  loginsInFlight.set(config.supplier, loginPromise);

  const result = await loginPromise;
  return { ...result, source: 'login', loginAttempts: result.attempts };
}

/* ── HTTP ────────────────────────────────────────────────────────────── */

type HttpTiming = {
  /** Request start through the complete response body arriving. */
  requestMs: number;
  /** Request start through response headers arriving. */
  ttfbMs: number;
  /** Response headers through the complete body arriving. */
  responseReadMs: number;
  /** JSON.parse only; excluded from requestMs. */
  responseParseMs: number;
};

type RawResponse = {
  status: number;
  body: unknown;
  text: string;
  timing: HttpTiming;
  receipt: SupplierReadReceipt;
};

type FetchLifecycleHooks = {
  onRequestStart?: () => void;
  onResponseHeaders?: (status: number) => void;
  onResponseComplete?: (status: number) => void;
  onResponseParsed?: (status: number) => void;
};

/** Observability must never make a live search fail or take a different path. */
function emitSearchTrace(
  observer: FlightSearchTraceObserver | undefined,
  event: FlightSearchTraceEvent
): void {
  try {
    observer?.(event);
  } catch {
    // The request's correctness and retry behavior always win over telemetry.
  }
}

function safeErrorCode(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const code = (value as { code?: unknown }).code;
  if (typeof code !== 'string' || !/^[A-Za-z0-9_:-]{1,80}$/.test(code)) return null;
  return code.toUpperCase();
}

function transportCodeFor(error: unknown): string | null {
  const direct = safeErrorCode(error);
  if (direct) return direct;
  if (!error || typeof error !== 'object') return null;
  return safeErrorCode((error as { cause?: unknown }).cause);
}

function transportKindFor(
  error: unknown,
  aborted: boolean
): TriploverTransportKind {
  if (aborted || (error instanceof Error && error.name === 'AbortError')) return 'timeout';

  const code = transportCodeFor(error);
  if (code && ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME'].includes(code)) {
    return 'dns';
  }
  if (
    code &&
    (
      code.startsWith('ERR_TLS_') ||
      code.startsWith('ERR_SSL_') ||
      [
        'CERT_HAS_EXPIRED',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'EPROTO',
      ].includes(code)
    )
  ) {
    return 'tls';
  }
  if (
    code &&
    (
      code.startsWith('UND_ERR_') ||
      [
        'ECONNABORTED',
        'ECONNREFUSED',
        'ECONNRESET',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'ETIMEDOUT',
      ].includes(code)
    )
  ) {
    return 'connection';
  }
  return 'unknown';
}

function diagnosticPrefix(operation: TriploverOperation): string {
  if (operation === 'LogIn') return 'TOKEN_LOGIN';
  if (operation === 'Search') return 'SEARCH';
  return `TRIPLOVER_${operation.toUpperCase()}`;
}

function networkDiagnostic(
  error: unknown,
  operation: TriploverOperation,
  supplier: TriploverSupplier,
  phase: TriploverFailurePhase,
  requestStartedPerf: number,
  aborted: boolean
): TriploverFailureDiagnostic {
  const transport = transportKindFor(error, aborted);
  const prefix = diagnosticPrefix(operation);
  return {
    code:
      transport === 'timeout'
        ? `${prefix}_TIMEOUT`
        : `${prefix}_NETWORK_${transport.toUpperCase()}`,
    operation,
    supplier,
    phase,
    transport,
    transportCode: transportCodeFor(error),
    elapsedMs: Math.round(performance.now() - requestStartedPerf),
  };
}

/**
 * One HTTP round trip, with a timeout and defensive parsing.
 *
 * **Observed on UAT, not documented:** a 200 response is not necessarily JSON.
 * `POST /api/FareRules` answered `200` with the plain-text body "Your request
 * could not be processed... Index was outside the bounds of the array." A bare
 * `response.json()` throws a `SyntaxError` on that, which would surface as an
 * unhandled 500. So the body is read as text and parsed defensively.
 */
async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  operation: TriploverOperation,
  supplier: TriploverSupplier,
  hooks?: FetchLifecycleHooks
): Promise<RawResponse> {
  const requestStartedAt = new Date().toISOString();
  const requestStartedPerf = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const keepDeadlineThroughResponseBody = supplier === 'takeoff';

  let response: Response;
  let headersReceivedAt = requestStartedPerf;
  let text: string;
  let phase: TriploverFailurePhase = 'request';
  try {
    hooks?.onRequestStart?.();
    response = await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
    headersReceivedAt = performance.now();
    hooks?.onResponseHeaders?.(response.status);
    phase = 'response-body';
    // Scope the body deadline to TakeOff, the investigated provider. This fixes
    // an unbounded TakeOff body read without changing FirstTrip's legacy timing.
    if (!keepDeadlineThroughResponseBody) clearTimeout(timer);
    text = await response.text();
    hooks?.onResponseComplete?.(response.status);
  } catch (error) {
    const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError');
    const diagnostic = networkDiagnostic(
      error,
      operation,
      supplier,
      phase,
      requestStartedPerf,
      aborted
    );
    throw new TriploverError(
      'network',
      aborted
        ? `Triplover ${operation} timed out after ${Math.round(timeoutMs / 1000)}s.`
        : `Triplover ${operation} could not be reached.`,
      null,
      diagnostic
    );
  } finally {
    clearTimeout(timer);
  }

  const responseReceivedAt = new Date().toISOString();
  const bodyReceivedAt = performance.now();
  const parseStartedAt = performance.now();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  const parseFinishedAt = performance.now();
  hooks?.onResponseParsed?.(response.status);

  return {
    status: response.status,
    body,
    text,
    timing: {
      requestMs: bodyReceivedAt - requestStartedPerf,
      ttfbMs: headersReceivedAt - requestStartedPerf,
      responseReadMs: bodyReceivedAt - headersReceivedAt,
      responseParseMs: parseFinishedAt - parseStartedAt,
    },
    receipt: {
      requestStartedAt,
      responseReceivedAt,
      httpStatus: response.status,
      rawPayloadHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    },
  };
}

/* ── Envelope ────────────────────────────────────────────────────────── */

type EnvelopeMeta = {
  isSuccess?: boolean;
  message?: string | null;
  uniqueTransID?: string;
  uniqueTransId?: string;
  UniqueTransID?: string;
  UniqueTransId?: string;
  apiRef?: number;
};

const UNIQUE_TRANSACTION_REFERENCE_KEYS = [
  'uniqueTransID',
  'uniqueTransId',
  'UniqueTransID',
  'UniqueTransId',
] as const;

/**
 * Supplier reference spelling is inconsistent between deployed Search hosts.
 * Accept only the known casing variants, and always keep the opaque value
 * server-side.  This does not manufacture a reference or relax validation.
 */
function uniqueTransactionReferencesFromValue(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const references: string[] = [];
  for (const key of UNIQUE_TRANSACTION_REFERENCE_KEYS) {
    const candidate = record[key];
    if (
      typeof candidate === 'string' &&
      candidate.trim().length > 0 &&
      !references.includes(candidate)
    ) {
      references.push(candidate);
    }
  }
  return references;
}

/**
 * Retain every supplier envelope transaction echo in response order. A caller
 * may still use `uniqueTransId` for the established first-value contract, but
 * reconciliation evidence needs the complete set so conflicting supplier
 * echoes cannot be silently discarded.
 */
function uniqueTransactionReferences(values: EnvelopeMeta[]): string[] {
  const references: string[] = [];
  for (const value of values) {
    for (const reference of uniqueTransactionReferencesFromValue(value)) {
      if (!references.includes(reference)) references.push(reference);
    }
  }
  return references;
}

/**
 * Reads `item2`, which is **an object on every endpoint except Search, where it
 * is an array** — one entry per upstream source the supplier queried. The
 * documentation (§3.2) shows only the object form.
 *
 * That array matters for more than parsing. A live DAC→CXB search returned four
 * entries of which one was `isSuccess: false` ("Invalid access token for
 * Sabre") while the search itself returned ten perfectly good offers. Treating
 * "any entry failed" as a failed search would have thrown away a working
 * result, so success here means **any** entry succeeded, and the caller is told
 * separately whether the answer was partial.
 */
function readEnvelope(body: unknown): {
  item1: unknown;
  metas: EnvelopeMeta[];
  isSuccess: boolean;
  partial: boolean;
  message: string | null;
} {
  const envelope = (body ?? {}) as { item1?: unknown; item2?: unknown };
  const rawMeta = envelope.item2;

  const metas: EnvelopeMeta[] = Array.isArray(rawMeta)
    ? (rawMeta as EnvelopeMeta[])
    : rawMeta && typeof rawMeta === 'object'
      ? [rawMeta as EnvelopeMeta]
      : [];

  const succeeded = metas.filter((m) => m.isSuccess === true);
  const failed = metas.filter((m) => m.isSuccess === false);

  // No metadata at all: fall back to whether there is a payload, so a shape we
  // have not seen cannot silently read as failure.
  const isSuccess = metas.length === 0 ? envelope.item1 != null : succeeded.length > 0;

  const message = failed.find((m) => m.message)?.message ?? metas.find((m) => m.message)?.message ?? null;

  return {
    item1: envelope.item1 ?? null,
    metas,
    isSuccess,
    partial: succeeded.length > 0 && failed.length > 0,
    message: message ?? null,
  };
}

/**
 * Whether a response is the supplier telling us **our** token died.
 *
 * **Probed on UAT:** an expired or tampered token returns a clean **HTTP 401**
 * on both hosts (verified against `/api/Search` and `/api/Reprice`, plus a
 * missing header). The documentation contradicts itself — §5.2 says 401 but
 * §5.1 shows a `200` whose `item2.message` reads "Token has expired". Both are
 * handled: 401 is what actually happens today, and the 200 form costs little to
 * stay safe against.
 *
 * The two guards on the 200 branch are not paranoia, they are a bug this code
 * already had. A successful live search returns per-source entries in `item2`,
 * and one of them regularly reads **"Invalid access token for Sabre"** — that
 * is Triplover's credential for *its* upstream, on a search that returned ten
 * good offers. A looser pattern matched it, so the client discarded a perfectly
 * good token, logged in again, saw the same message and failed the search.
 * Hence: only when the envelope reports overall failure, and only for the
 * documented wording.
 */
function isTokenExpiry(
  status: number,
  envelope: { isSuccess: boolean; message: string | null }
): boolean {
  if (status === 401) return true;
  if (status !== 200 || envelope.isSuccess) return false;
  return /token\s+(has\s+)?expired/i.test(envelope.message ?? '');
}

/* ── Public call surface ─────────────────────────────────────────────── */

export type TriploverCallResult = {
  /** The `item1` payload. */
  data: unknown;
  /** At least one upstream source failed but others succeeded. */
  partial: boolean;
  /** `item2.uniqueTransID`, when present. */
  uniqueTransId: string | null;
  /**
   * Every exact non-empty `item2.uniqueTransID` echo, in supplier response
   * order. This is response-origin metadata, never request-derived.
   */
  uniqueTransIds: string[];
  timing: TriploverCallTiming;
  /** Hash/timestamps only; the raw supplier payload is not retained here. */
  receipt: SupplierReadReceipt;
};

export type TriploverCallTiming = {
  /** Token cache lookup or login, including a retry acquisition if needed. */
  tokenMs: number;
  /** Cache hit, login, shared login, or a retry sequence such as hit+login. */
  tokenSource: string;
  /** Physical Login attempts (0 for a warm token cache hit). */
  tokenLoginAttempts: number;
  /** All Triplover attempts through complete body receipt. */
  apiRequestMs: number;
  /** Time to response headers across attempts. */
  apiTtfbMs: number;
  /** Time spent reading response bodies. */
  responseReadMs: number;
  /** JSON.parse time for response bodies. */
  responseParseMs: number;
  /** Normally one; two when an expired token causes a safe retry. */
  attempts: number;
};

export type SupplierWriteLifecycleHooks = {
  /** Runs after authentication and immediately before the destructive HTTP. */
  beforeRequest: () => Promise<void>;
  /** Runs after the complete response body arrives, before it is interpreted. */
  onResponse: (observation: {
    httpStatus: number;
    receivedAt: string;
  }) => Promise<void>;
};

/**
 * Calls a Triplover endpoint with a live token, unwraps the envelope, and
 * retries once on token expiry — but only for operations where a replay is
 * safe. A write that fails with an expired token is reported, not repeated.
 */
export async function triploverCall(
  operation: TriploverOperation,
  path: string,
  payload: unknown,
  options: {
    /** The persisted credential account for this workflow. */
    supplier: TriploverSupplier;
    timeoutMs?: number;
    method?: 'GET' | 'POST';
    topLevelPayload?: boolean;
    lifecycleHooks?: SupplierWriteLifecycleHooks;
    /**
     * TakeOff Search-only instrumentation. It is deliberately ignored for
     * every other operation and supplier so FirstTrip's behavior stays exact.
     */
    searchTrace?: FlightSearchTraceObserver;
  }
): Promise<TriploverCallResult> {
  const config = triploverConfig(options.supplier);
  if (!config) {
    throw new TriploverError('unconfigured', 'Triplover credentials are not configured.');
  }

  const timeoutMs = options.timeoutMs ?? SUPPLIER_TIMEOUT_MS;
  const url = `${hostFor(operation, config)}${path}`;
  const searchTrace =
    operation === 'Search' && config.supplier === 'takeoff'
      ? options.searchTrace
      : undefined;
  const timing: TriploverCallTiming = {
    tokenMs: 0,
    tokenSource: '',
    tokenLoginAttempts: 0,
    apiRequestMs: 0,
    apiTtfbMs: 0,
    responseReadMs: 0,
    responseParseMs: 0,
    attempts: 0,
  };
  let tokenAcquisitions = 0;

  const attempt = async (token: string, attemptNumber: number): Promise<RawResponse> =>
    fetchJson(
      url,
      {
        method: options.method ?? 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        ...((options.method ?? 'POST') === 'POST'
          ? { body: JSON.stringify(payload) }
          : {}),
      },
      timeoutMs,
      operation,
      config.supplier,
      searchTrace
        ? {
            onRequestStart() {
              emitSearchTrace(searchTrace, {
                name: 'takeoff_search_request_start',
                details: { attempt: attemptNumber },
              });
            },
            onResponseHeaders(status) {
              // `fetch` resolving is the server-side first-byte/headers
              // boundary, distinct from the full response-body receipt.
              emitSearchTrace(searchTrace, {
                name: 'takeoff_search_first_byte',
                details: { attempt: attemptNumber, status },
              });
            },
            onResponseComplete(status) {
              emitSearchTrace(searchTrace, {
                name: 'takeoff_search_response_complete',
                details: { attempt: attemptNumber, status },
              });
            },
            onResponseParsed(status) {
              emitSearchTrace(searchTrace, {
                name: 'takeoff_search_response_parsed',
                details: { attempt: attemptNumber, status },
              });
            },
          }
        : undefined
    );

  const acquireToken = async (): Promise<string> => {
    tokenAcquisitions += 1;
    const acquisition = tokenAcquisitions;
    emitSearchTrace(searchTrace, {
      name: 'takeoff_token_acquisition_start',
      details: { acquisition },
    });
    const startedAt = performance.now();
    let acquired: TokenAcquisition;
    try {
      acquired = await getToken(config);
    } catch (error) {
      emitSearchTrace(searchTrace, {
        name: 'takeoff_token_acquisition_failed',
        details: { acquisition },
      });
      throw error;
    }
    timing.tokenMs += performance.now() - startedAt;
    timing.tokenSource = timing.tokenSource
      ? `${timing.tokenSource}+${acquired.source}`
      : acquired.source;
    timing.tokenLoginAttempts += acquired.loginAttempts;
    emitSearchTrace(searchTrace, {
      name: 'takeoff_token_acquisition_complete',
      details: {
        acquisition,
        source: acquired.source,
        loginAttempts: acquired.loginAttempts,
      },
    });
    return acquired.token;
  };

  const timedAttempt = async (token: string): Promise<RawResponse> => {
    const attemptNumber = timing.attempts + 1;
    await options.lifecycleHooks?.beforeRequest();
    const result = await attempt(token, attemptNumber);
    await options.lifecycleHooks?.onResponse({
      httpStatus: result.status,
      receivedAt: result.receipt.responseReceivedAt,
    });
    timing.attempts += 1;
    timing.apiRequestMs += result.timing.requestMs;
    timing.apiTtfbMs += result.timing.ttfbMs;
    timing.responseReadMs += result.timing.responseReadMs;
    timing.responseParseMs += result.timing.responseParseMs;
    return result;
  };

  let token = await acquireToken();
  let response = await timedAttempt(token);
  let envelope = readEnvelope(response.body);

  if (isTokenExpiry(response.status, envelope)) {
    emitSearchTrace(searchTrace, {
      name: 'takeoff_search_token_expiry_retry',
      details: { attempt: timing.attempts, status: response.status },
    });
    invalidateToken(config.supplier, token);
    if (!isRetrySafe(operation)) {
      throw new TriploverError(
        'auth',
        `Triplover ${operation} was rejected for an expired token and cannot be safely retried.`,
        response.status
      );
    }
    token = await acquireToken();
    response = await timedAttempt(token);
    envelope = readEnvelope(response.body);

    if (isTokenExpiry(response.status, envelope)) {
      throw new TriploverError(
        'auth',
        'Triplover rejected a freshly issued token.',
        response.status
      );
    }
  }

  if (response.status >= 500) {
    throw new TriploverError('supplier', `Triplover ${operation} failed upstream.`, response.status);
  }

  if (response.status === 429) {
    throw new TriploverError('supplier', `Triplover rate-limited the ${operation} call.`, 429);
  }

  if (response.status !== 200) {
    throw new TriploverError(
      'supplier',
      envelope.message ?? `Triplover ${operation} returned HTTP ${response.status}.`,
      response.status
    );
  }

  // 200 with an unparseable body — the plain-text error case described above.
  if (response.body === null) {
    throw new TriploverError(
      'protocol',
      `Triplover ${operation} returned a non-JSON response.`,
      response.status
    );
  }

  // AirTicketingDetails is the documented exception to Triplover's envelope:
  // its report object is returned directly at the top level.
  if (options.topLevelPayload) {
    return {
      data: response.body,
      partial: false,
      uniqueTransId: null,
      uniqueTransIds: [],
      timing,
      receipt: response.receipt,
    };
  }

  if (!envelope.isSuccess) {
    throw new TriploverError(
      'supplier',
      envelope.message ?? `Triplover ${operation} reported a failure.`,
      response.status
    );
  }

  const uniqueTransIds = uniqueTransactionReferences(envelope.metas);
  return {
    data: envelope.item1,
    partial: envelope.partial,
    uniqueTransId: uniqueTransIds[0] ?? null,
    uniqueTransIds,
    timing,
    receipt: response.receipt,
  };
}

/** Test seam: drops cached auth state. Not used on the request path. */
export function resetTriploverAuthForTesting(): void {
  cachedTokens.clear();
  loginsInFlight.clear();
}
