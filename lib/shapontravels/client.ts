import 'server-only';

/** Shapontravels uses issued machine credentials, not the Triplover login. */
export type ShapontravelsRead = 'Search' | 'FareRules' | 'Reprice' | 'Accept';

const PATHS: Record<ShapontravelsRead, string> = {
  Search: 'api/Search',
  FareRules: 'api/FareRules',
  Reprice: 'api/Reprice',
  Accept: 'api/Reprice/accept',
};
const TOKEN_MARGIN_MS = 60_000;
const LOGIN_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS: Record<ShapontravelsRead, number> = {
  Search: 125_000,
  FareRules: 60_000,
  Reprice: 60_000,
  Accept: 30_000,
};
const BODY_LIMIT: Record<ShapontravelsRead, number> = {
  Search: 64 * 1024 * 1024,
  FareRules: 8 * 1024 * 1024,
  Reprice: 8 * 1024 * 1024,
  Accept: 128 * 1024,
};

type Credentials = { base: URL; clientId: string; clientSecret: string };
type Token = { value: string; expiresAt: number; identity: string };
let cachedToken: Token | null = null;
let tokenInFlight: { identity: string; promise: Promise<Token> } | null = null;

export class ShapontravelsReadError extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
    readonly requestId: string | null = null
  ) {
    super(`Shapontravels ${code}`);
    this.name = 'ShapontravelsReadError';
  }
}

function credentials(): Credentials {
  const baseText = process.env.SHAPONTRAVELS_SEARCH_BASE_URL;
  const clientId = process.env.SHAPONTRAVELS_CLIENT_ID?.trim() || process.env.CLIENT_ID?.trim();
  const clientSecret = process.env.SHAPONTRAVELS_CLIENT_SECRET || process.env.CLIENT_SECRET;
  if (!baseText || !clientId || !clientSecret?.trim()) {
    throw new ShapontravelsReadError('NOT_CONFIGURED');
  }
  let base: URL;
  try {
    base = new URL(baseText);
  } catch {
    throw new ShapontravelsReadError('INVALID_CONFIGURATION');
  }
  if (
    base.protocol !== 'https:' ||
    !base.hostname ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)
  ) {
    throw new ShapontravelsReadError('INVALID_CONFIGURATION');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/`;
  return { base, clientId, clientSecret };
}

export function isShapontravelsConfigured(): boolean {
  try {
    credentials();
    return true;
  } catch {
    return false;
  }
}

function responseCode(body: unknown): string {
  if (!body || typeof body !== 'object') return 'HTTP_ERROR';
  const value = (body as Record<string, unknown>).error;
  return typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value)
    ? value
    : 'HTTP_ERROR';
}

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) {
    throw new ShapontravelsReadError('RESPONSE_TOO_LARGE', response.status);
  }
  if (!response.body) throw new ShapontravelsReadError('INVALID_RESPONSE', response.status);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ShapontravelsReadError('RESPONSE_TOO_LARGE', response.status);
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof ShapontravelsReadError) throw error;
    throw new ShapontravelsReadError('INVALID_RESPONSE', response.status);
  } finally {
    reader.releaseLock();
  }
}

async function exchange(config: Credentials): Promise<Token> {
  let response: Response;
  try {
    response = await fetch(new URL('auth/token', config.base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    });
  } catch {
    throw new ShapontravelsReadError('AUTH_NETWORK');
  }
  const body = await boundedJson(response, 128 * 1024);
  const requestId = response.headers.get('x-request-id');
  if (!response.ok) {
    throw new ShapontravelsReadError(responseCode(body), response.status, requestId);
  }
  const token = body as Record<string, unknown>;
  if (
    typeof token.access_token !== 'string' ||
    !token.access_token.startsWith('stm_') ||
    token.token_type !== 'Bearer' ||
    typeof token.expires_in !== 'number' ||
    !Number.isFinite(token.expires_in) ||
    token.expires_in <= 0
  ) {
    throw new ShapontravelsReadError('INVALID_TOKEN_RESPONSE', response.status, requestId);
  }
  return {
    value: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    identity: `${config.base.origin}|${config.base.pathname}|${config.clientId}`,
  };
}

async function accessToken(config: Credentials): Promise<Token> {
  const identity = `${config.base.origin}|${config.base.pathname}|${config.clientId}`;
  if (cachedToken?.identity === identity && cachedToken.expiresAt > Date.now() + TOKEN_MARGIN_MS) {
    return cachedToken;
  }
  if (tokenInFlight?.identity !== identity) {
    const flight = exchange(config).then((token) => {
      cachedToken = token;
      return token;
    });
    tokenInFlight = { identity, promise: flight };
    void flight.finally(() => {
      if (tokenInFlight?.promise === flight) tokenInFlight = null;
    }).catch(() => undefined);
  }
  return tokenInFlight.promise;
}

/** Reprice acceptance is safe to repeat for the same private price reference. */
export async function shapontravelsRead(
  operation: ShapontravelsRead,
  payload: unknown
): Promise<unknown> {
  const config = credentials();
  const endpoint = new URL(PATHS[operation], config.base);
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(config);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.value}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(READ_TIMEOUT_MS[operation]),
      });
    } catch {
      throw new ShapontravelsReadError('READ_NETWORK');
    }
    if (response.status === 401 && attempt === 0) {
      if (cachedToken?.value === token.value) cachedToken = null;
      await response.body?.cancel();
      continue;
    }
    const body = await boundedJson(response, BODY_LIMIT[operation]);
    if (!response.ok) {
      throw new ShapontravelsReadError(
        responseCode(body),
        response.status,
        response.headers.get('x-request-id')
      );
    }
    return body;
  }
  throw new ShapontravelsReadError('AUTH_FAILED');
}

export class ShapontravelsWriteError extends Error {
  constructor(
    readonly kind: 'unconfigured' | 'auth' | 'network' | 'supplier' | 'protocol' | 'pending',
    readonly code: string,
    readonly status: number | null = null,
    readonly requestId: string | null = null,
    readonly pendingBookingId: string | null = null,
    readonly pendingReference: string | null = null
  ) {
    super(`Shapontravels Book ${code}` +
      (pendingBookingId ? ` bookingId=${pendingBookingId}` : '') +
      (pendingReference ? ` reference=${pendingReference}` : ''));
    this.name = 'ShapontravelsWriteError';
  }
}

function bookingPublicReference(response: Response): string | null {
  const reference = response.headers.get('x-booking-reference')?.trim();
  return reference && /^STR[A-Z0-9]{6,32}$/.test(reference) ? reference : null;
}

export type ShapontravelsBookingRead = {
  httpStatus: 200 | 202 | 404;
  supplierPublicRef: string | null;
  body: unknown;
};

/** Reads a saved supplier booking. This never sends Book, Issue, or Cancel. */
export async function shapontravelsReadBooking(
  lookup: { bookingId: string } | { reference: string }
): Promise<ShapontravelsBookingRead> {
  const config = credentials();
  const path = 'bookingId' in lookup
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lookup.bookingId)
      ? `api/bookings/${lookup.bookingId}` : null
    : /^STR[A-Z0-9]{6,32}$/.test(lookup.reference)
      ? `api/bookings/by-reference/${lookup.reference}` : null;
  if (!path) throw new ShapontravelsReadError('INVALID_BOOKING_LOOKUP');

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(config);
    let response: Response;
    try {
      response = await fetch(new URL(path, config.base), {
        method: 'GET',
        headers: { authorization: `Bearer ${token.value}` },
        cache: 'no-store',
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ShapontravelsReadError('BOOKING_READ_NETWORK');
    }
    if (response.status === 401 && attempt === 0) {
      if (cachedToken?.value === token.value) cachedToken = null;
      await response.body?.cancel();
      continue;
    }
    const body = await boundedJson(response, 8 * 1024 * 1024);
    if (response.status === 200 || response.status === 202 || response.status === 404) {
      return {
        httpStatus: response.status,
        supplierPublicRef: bookingPublicReference(response),
        body,
      };
    }
    throw new ShapontravelsReadError(
      responseCode(body), response.status, response.headers.get('x-request-id')
    );
  }
  throw new ShapontravelsReadError('AUTH_FAILED');
}

/** One physical Book request. An ambiguous result is never sent again. */
export async function shapontravelsBookRequest(
  payload: unknown,
  idempotencyKey: string,
  hooks: import('@/lib/triplover/client').SupplierWriteLifecycleHooks
): Promise<{ body: unknown; supplierPublicRef: string | null }> {
  let config: Credentials;
  try {
    config = credentials();
  } catch {
    throw new ShapontravelsWriteError('unconfigured', 'NOT_CONFIGURED');
  }
  let token: Token;
  try {
    token = await accessToken(config);
  } catch {
    throw new ShapontravelsWriteError('auth', 'AUTH_UNAVAILABLE');
  }
  await hooks.beforeRequest();
  let response: Response;
  try {
    response = await fetch(new URL('api/Book', config.base), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.value}`,
        'content-type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(110_000),
    });
  } catch {
    throw new ShapontravelsWriteError('network', 'BOOK_NETWORK');
  }
  let body: unknown;
  try {
    body = await boundedJson(response, 8 * 1024 * 1024);
  } catch {
    throw new ShapontravelsWriteError('protocol', 'INVALID_BOOK_RESPONSE', response.status,
      response.headers.get('x-request-id'));
  }
  await hooks.onResponse({ httpStatus: response.status, receivedAt: new Date().toISOString() });
  const requestId = response.headers.get('x-request-id');
  if (response.status === 202) {
    const pending = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const bookingId = typeof pending.bookingId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pending.bookingId)
        ? pending.bookingId : null;
    const reference = bookingPublicReference(response);
    throw new ShapontravelsWriteError('pending', 'BOOKING_OUTCOME_UNKNOWN',
      202, requestId, bookingId, reference);
  }
  if (!response.ok) {
    throw new ShapontravelsWriteError(
      response.status === 401 ? 'auth' : 'supplier',
      responseCode(body), response.status, requestId
    );
  }
  return { body, supplierPublicRef: bookingPublicReference(response) };
}
