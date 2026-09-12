# Supplier Integration

This document describes Triplover, the primary supplier for flight search,
booking, and ticketing, plus the direct airline Manage Booking adapters used for
IMP/EXP imported booking retrieval and synchronization.

## Table of Contents

1. [Supplier Integration Architecture](#1-supplier-integration-architecture)
2. [Triplover API Client](#2-triplover-api-client)
3. [Authentication and Token Management](#3-authentication-and-token-management)
4. [API Operations](#4-api-operations)
5. [Retry Policy and Safety Rules](#5-retry-policy-and-safety-rules)
6. [Error Handling and Classification](#6-error-handling-and-classification)
7. [Timeout Handling](#7-timeout-handling)
8. [Request/Response Mapping](#8-requestresponse-mapping)
9. [Operation-Specific Implementations](#9-operation-specific-implementations)
10. [Configuration Management](#10-configuration-management)
11. [IMP/EXP Direct Airline Retrieval and Sync](#11-impexp-direct-airline-retrieval-and-sync)
12. [FirstTrip and TakeOff Reference Import](#12-firsttrip-and-takeoff-reference-import)

---

## 1. Supplier Integration Architecture

### Overview

The Triplover integration is a JSON-over-HTTPS B2B API that provides:

- **Flight Search**: Real-time availability and pricing for one-way, round-trip, and multicity routes
- **Fare Rules**: Fare rule inspection before booking
- **Repricing**: Live fare confirmation before booking
- **Booking**: Seat reservation and PNR creation
- **Cancellation**: Held booking cancellation
- **Ticketing**: Ticket issuance against confirmed bookings
- **Reporting**: Back-office ticketing reports for reconciliation

### Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
│  (Dashboard UI, API Routes, Server Actions)                 │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                Business Logic Layer                          │
│  ┌──────────────────┐  ┌──────────────────┐                │
│  │ Flight Search    │  │ Booking System   │                │
│  │ (lib/flights/)   │  │ (lib/flights/)   │                │
│  └────────┬─────────┘  └────────┬─────────┘                │
└───────────┼────────────────────┼───────────────────────────┘
            │                    │
┌───────────▼────────────────────▼───────────────────────────┐
│              Supplier Integration Layer                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │           Triplover API Client                        │  │
│  │         (lib/triplover/client.ts)                     │  │
│  │  • Authentication & Token Management                  │  │
│  │  • HTTP Transport & Timeout Handling                   │  │
│  │  • Envelope Unwrapping                                │  │
│  │  • Retry Policy & Safety Rules                         │  │
│  │  • Error Classification                               │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │   Search     │  │   Book       │  │   Ticket     │      │
│  │ (search.ts)  │  │  (book.ts)   │  │ (ticket.ts)  │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  RePrice     │  │   Cancel     │  │    PNR       │      │
│  │(reprice.ts)  │  │ (cancel.ts)  │  │   (pnr.ts)   │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│  ┌──────────────┐  ┌──────────────┐                        │
│  │ FareRules    │  │ AirTicketing │                        │
│  │(fare-rules.ts)│ │  Details     │                        │
│  │              │  │(air-ticketing│                        │
│  │              │  │ -details.ts) │                        │
│  └──────────────┘  └──────────────┘                        │
└─────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                   Triplover API                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  searchapi-uat.triplover.com                          │  │
│  │  (POST /api/Search only)                              │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  userapi-uat.triplover.com                            │  │
│  │  (LogIn, FareRules, RePrice, Book, Cancel, NewTicket,│  │
│  │   PNR, AirTicketingDetails)                           │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Key Design Principles

1. **Server-Only Execution**: All Triplover integration code is marked with `'server-only'` to prevent credential leakage to the browser
2. **Domain Separation**: The API client layer handles transport concerns; operation modules handle domain mapping
3. **Defensive Parsing**: All supplier responses are parsed defensively to handle undocumented shapes and inconsistencies
4. **Safety-First Retry**: Only idempotent operations are retried; write operations are never automatically retried
5. **Token Isolation**: Bearer tokens are never exposed to business logic layers

### Cross-References

- **Flight Search Architecture**: See [05-FLIGHT-SEARCH.md](05-FLIGHT-SEARCH.md) for search flow
- **Booking System**: See [07-BOOKING-SYSTEM.md](07-BOOKING-SYSTEM.md) for booking integration
- **Supplier Documentation**: See root-level `Triploaver_API_Documentation.md` for official API contract

---

## 2. Triplover API Client

### Location

`lib/triplover/client.ts`

### Purpose

The client is the transport layer for all Triplover API interactions. It handles:

- Authentication and token lifecycle management
- HTTP request/response handling with timeout enforcement
- Response envelope unwrapping
- Retry policy enforcement based on operation safety
- Error classification and reporting
- Performance timing metrics

### Core Components

#### Error Types

```typescript
export type TriploverErrorKind =
  | 'auth'        // Credentials rejected or token minting failed
  | 'supplier'    // Supplier reported a business-level failure
  | 'network'     // Transport failures (timeout, DNS, TLS, socket)
  | 'protocol'    // Unparseable response
  | 'unconfigured'; // Environment variables missing
```

#### Operation Types

```typescript
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
```

#### Safety Classification

Each operation is classified as retry-safe or not:

```typescript
export function isRetrySafe(operation: TriploverOperation): boolean {
  switch (operation) {
    case 'LogIn':
    case 'Search':
    case 'FareRules':
    case 'RePrice':
    case 'Pnr':
    case 'AirTicketingDetails':
      return true;
    // Write operations are never retried
    case 'Book':
    case 'Cancel':
    case 'NewTicket':
      return false;
  }
}
```

**Critical Invariant**: Adding a new operation requires explicit classification in `isRetrySafe()`. Write operations must return `false` to prevent duplicate bookings or tickets.

### Public API

#### `triploverCall()`

The main entry point for all Triplover API calls:

```typescript
export async function triploverCall(
  operation: TriploverOperation,
  path: string,
  payload: unknown,
  options?: {
    timeoutMs?: number;
    method?: 'GET' | 'POST';
    topLevelPayload?: boolean;
  }
): Promise<TriploverCallResult>
```

**Parameters**:
- `operation`: The operation type for safety classification
- `path`: API endpoint path (e.g., `/api/Search`)
- `payload`: Request body (for POST requests)
- `options.timeoutMs`: Override default timeout (default: `SUPPLIER_TIMEOUT_MS`)
- `options.method`: HTTP method (default: `'POST'`)
- `options.topLevelPayload`: Bypass envelope unwrapping for AirTicketingDetails

**Returns**:
```typescript
export type TriploverCallResult = {
  data: unknown;              // The unwrapped item1 payload
  partial: boolean;           // Some upstream sources failed
  uniqueTransId: string | null; // Transaction identifier
  timing: TriploverCallTiming; // Performance metrics
};
```

**Throws**: `TriploverError` with appropriate kind and HTTP status

### Performance Timing

The client tracks detailed timing metrics:

```typescript
export type TriploverCallTiming = {
  tokenMs: number;           // Token acquisition time
  tokenSource: string;       // 'cache-hit', 'login', 'shared-login'
  apiRequestMs: number;      // Total API request time
  apiTtfbMs: number;         // Time to first byte
  responseReadMs: number;    // Response body read time
  responseParseMs: number;   // JSON parse time
  attempts: number;          // Number of HTTP attempts (1 or 2)
};
```

---

## 3. Authentication and Token Management

### Authentication Flow

Triplover uses Bearer token authentication obtained via `POST /api/user/apiLogIn`:

1. **Initial Login**: Client sends email and base64-encoded password
2. **Token Receipt**: Server returns JWT token with 30-minute expiry
3. **Token Caching**: Token is cached in module scope per Vercel instance
4. **Token Renewal**: Token is renewed 2 minutes before expiry
5. **Token Invalidation**: Token is invalidated on 401 responses

### Token Cache Implementation

**Location**: `lib/triplover/client.ts` (lines 89-189)

```typescript
type CachedToken = { token: string; expiresAt: number };

// Module-scope cache (one per warm Vercel instance)
let cachedToken: CachedToken | null = null;

// Single-flight guard prevents concurrent logins
let loginInFlight: Promise<string> | null = null;

// Renew 2 minutes before stated expiry
const RENEW_MARGIN_MS = 120_000;
```

### Token Acquisition Logic

```typescript
async function getToken(config: TriploverConfig): Promise<TokenAcquisition> {
  const current = cachedToken;
  // Cache hit: token is valid with margin
  if (current && current.expiresAt - RENEW_MARGIN_MS > Date.now()) {
    return { token: current.token, source: 'cache-hit' };
  }

  // Single flight: concurrent requests share one login
  const existingLogin = loginInFlight;
  if (existingLogin) {
    return { token: await existingLogin, source: 'shared-login' };
  }

  // Start new login
  loginInFlight = login(config).finally(() => {
    loginInFlight = null;
  });

  return { token: await loginInFlight, source: 'login' };
}
```

### Login Implementation

```typescript
async function login(config: TriploverConfig): Promise<string> {
  const response = await fetchJson(
    `${config.baseUrl}/api/user/apiLogIn`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: config.email,
        password: config.password, // Already base64-encoded
      }),
    },
    LOGIN_TIMEOUT_MS,
    'LogIn'
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

  // Note: Supplier spells it "tokenExpieryTime" (typo preserved)
  const statedExpiry = Date.parse(body.data.tokenExpieryTime ?? '');
  const expiresAt = Number.isFinite(statedExpiry)
    ? statedExpiry
    : Date.now() + 25 * 60_000; // Fallback: 25 minutes

  cachedToken = { token: body.data.token, expiresAt };
  return body.data.token;
}
```

### Important Notes

1. **No Refresh Flow**: The API advertises a `refreshToken` but provides no endpoint to redeem it. Re-login is the supported path.
2. **Supplier Typo**: The response field is `tokenExpieryTime` (not `tokenExpiryTime`). This typo must be preserved.
3. **Single-Flight Pattern**: Concurrent requests on a cold instance share one login to prevent credential storms.
4. **Instance-Scoped Cache**: On Vercel, the cache is per warm instance, not per deployment. This costs at most one extra login per cold instance per 30 minutes.

### Token Expiry Detection

The client detects token expiry in two ways:

1. **HTTP 401**: Clean 401 response on any endpoint
2. **Envelope Message**: HTTP 200 with `item2.message` containing "Token has expired"

```typescript
function isTokenExpiry(
  status: number,
  envelope: { isSuccess: boolean; message: string | null }
): boolean {
  if (status === 401) return true;
  if (status !== 200 || envelope.isSuccess) return false;
  return /token\s+(has\s+)?expired/i.test(envelope.message ?? '');
}
```

**Critical Invariant**: The 200 detection has strict guards to avoid false positives. Triplover returns "Invalid access token for Sabre" in successful searches (this is Triplover's upstream credential issue, not ours). Only when the envelope reports overall failure do we invalidate the token.

---

## 4. API Operations

### Operation Pipeline

The Triplover API follows a strict pipeline where each step's response carries reference tokens required by the next step:

```
LogIn → Search → (optional FareRules) → RePrice → Booking → NewTicket
                                                       ↘ Book Cancel
                                                       ↘ (direct-ticket: Booking
                                                          issues tickets in one step)
```

### Reference Tokens

Reference tokens are opaque base64-encoded strings issued by the server. They must be passed through verbatim:

- `uniqueTransID`: Transaction identifier (from Search, RePrice)
- `itemCodeRef`: Itinerary identifier (from Search)
- `priceCodeRef`: Price identifier (from RePrice)
- `bookingCodeRef`: Booking identifier (from Book)
- `segmentCodeRefs`: Segment identifiers (from Search)
- `pnr`: Passenger Name Record (from Book, PNR)

**Critical Invariant**: Never construct, decode, or modify reference tokens on the client.

### Host Routing

Triplover uses two separate hosts:

| Host | Purpose |
|------|---------|
| `searchapi-uat.triplover.com` | `POST /api/Search` only |
| `userapi-uat.triplover.com` | LogIn, FareRules, RePrice, Book, Cancel, NewTicket, PNR, AirTicketingDetails |

**Implementation**: `lib/triplover/client.ts` (line 85)

```typescript
function hostFor(operation: TriploverOperation, config: TriploverConfig): string {
  return operation === 'Search' ? config.searchBaseUrl : config.baseUrl;
}
```

### Operation Summary

| Operation | Host | Method | Purpose | Retry-Safe |
|-----------|------|--------|---------|------------|
| LogIn | userapi | POST | Obtain bearer token | Yes |
| Search | searchapi | POST | Search flights | Yes |
| FareRules | userapi | POST | Get fare rules | Yes |
| RePrice | userapi | POST | Confirm live fare | Yes |
| Book | userapi | POST | Create booking | **No** |
| Cancel | userapi | POST | Cancel booking | **No** |
| NewTicket | userapi | POST | Issue ticket | **No** |
| Pnr | userapi | POST | Read PNR details | Yes |
| AirTicketingDetails | userapi | GET | Get ticketing report | Yes |

---

## 5. Retry Policy and Safety Rules

### Safety Classification

The retry policy is operation-specific based on whether replaying the operation is safe:

**Retry-Safe Operations**:
- `LogIn`: Idempotent credential exchange
- `Search`: Read-only search with no side effects
- `FareRules`: Read-only rule inspection
- `RePrice`: Read-only price confirmation
- `Pnr`: Read-only PNR lookup
- `AirTicketingDetails`: Read-only report

**Non-Retry-Safe Operations**:
- `Book`: Creates a booking; retry could issue duplicate PNR
- `Cancel`: Destroys a booking; retry could cancel twice
- `NewTicket`: Issues tickets; retry could charge a card twice

### Retry Logic

**Location**: `lib/triplover/client.ts` (lines 457-476)

```typescript
if (isTokenExpiry(response.status, envelope)) {
  invalidateToken();
  if (!isRetrySafe(operation)) {
    throw new TriploverError(
      'auth',
      `Triplover ${operation} was rejected for an expired token and cannot be safely retried.`,
      response.status
    );
  }
  // Retry once with fresh token
  response = await timedAttempt(await acquireToken());
  envelope = readEnvelope(response.body);

  // If it fails again, give up
  if (isTokenExpiry(response.status, envelope)) {
    throw new TriploverError(
      'auth',
      'Triplover rejected a freshly issued token.',
      response.status
    );
  }
}
```

### Retry Conditions

Retries occur **only** when:
1. The operation is classified as retry-safe
2. The failure is specifically token expiry (401 or envelope message)
3. The token is invalidated and a fresh one is obtained

### No Other Retries

The client does **not** retry on:
- Network timeouts (operation fails immediately)
- 5xx errors (operation fails immediately)
- 429 rate limits (operation fails immediately)
- Protocol errors (operation fails immediately)
- Supplier business failures (operation fails immediately)

**Rationale**: Arbitrary retries on write operations could cause duplicate bookings or tickets. Network-level retries are handled by the underlying fetch implementation.

### Critical Invariants

1. **Write Operations Never Retry**: Book, Cancel, and NewTicket are never retried, even for token expiry.
2. **Ambiguous Failures Require Manual Resolution**: If a write operation fails with an unknown outcome, it must be resolved by reading the PNR, not by repeating.
3. **Single Retry on Token Expiry**: Only one retry is attempted; a second token expiry is a hard failure.

---

## 6. Error Handling and Classification

### Error Kinds

The client classifies errors into five kinds:

| Kind | Description | Example |
|------|-------------|---------|
| `auth` | Credentials rejected or token minting failed | Invalid login, expired token |
| `supplier` | Supplier reported a business-level failure | Fare sold out, booking rejected |
| `network` | Transport failures (no usable answer) | Timeout, DNS failure, TLS error |
| `protocol` | Unparseable response | Non-JSON body, missing required fields |
| `unconfigured` | Selected supplier environment variables missing | `FIRSTTRIP_EMAIL` or `TAKEOFF_EMAIL` not set |

### Error Detection

#### Authentication Errors

```typescript
// Login failure
if (!body?.isSuccess || !body.data?.token) {
  throw new TriploverError('auth', 'Triplover login failed.', response.status);
}

// Token expiry during operation
if (isTokenExpiry(response.status, envelope)) {
  throw new TriploverError('auth', 'Token expired.', response.status);
}
```

#### Network Errors

```typescript
try {
  response = await fetch(url, { ...init, signal: controller.signal });
} catch (error) {
  const aborted = error instanceof Error && error.name === 'AbortError';
  throw new TriploverError(
    'network',
    aborted
      ? `Triplover ${operation} timed out after ${Math.round(timeoutMs / 1000)}s.`
      : `Triplover ${operation} could not be reached.`
  );
}
```

#### Supplier Errors

```typescript
// 5xx errors
if (response.status >= 500) {
  throw new TriploverError('supplier', `Triplover ${operation} failed upstream.`, response.status);
}

// 429 rate limiting
if (response.status === 429) {
  throw new TriploverError('supplier', `Triplover rate-limited the ${operation} call.`, 429);
}

// Business failures in envelope
if (!envelope.isSuccess) {
  throw new TriploverError(
    'supplier',
    envelope.message ?? `Triplover ${operation} reported a failure.`,
    response.status
  );
}
```

#### Protocol Errors

```typescript
// Non-JSON response
if (response.body === null) {
  throw new TriploverError(
    'protocol',
    `Triplover ${operation} returned a non-JSON response.`,
    response.status
  );
}
```

#### Unconfigured Errors

```typescript
const config = triploverConfig(supplierAccount);
if (!config) {
  throw new TriploverError('unconfigured', 'Triplover credentials are not configured.');
}
```

### Observed Undocumented Behaviors

The following error behaviors were discovered through UAT probing and are not documented:

1. **Plain-Text Error Responses**: `POST /api/FareRules` returns HTTP 200 with plain-text body "Your request could not be processed... Index was outside the bounds of the array." The client reads as text first, then parses defensively.

2. **Multi-Source Search Metadata**: Search returns `item2` as an array (one entry per upstream source), not an object as documented. Some entries may fail while others succeed. Success means **any** entry succeeded.

3. **Ambiguous Token Messages**: Successful searches regularly return "Invalid access token for Sabre" in one `item2` entry. This is Triplover's upstream credential issue, not ours. The client only invalidates tokens when the envelope reports overall failure.

4. **Token Expiry HTTP Status**: Documentation shows 200 with envelope message, but actual UAT returns clean HTTP 401. Both are handled.

### Error Propagation

All errors are thrown as `TriploverError` instances with:
- `kind`: Error classification
- `message`: Human-readable description
- `status`: HTTP status code (if applicable)

Operation modules may wrap these in domain-specific errors (e.g., `FlightRepriceError`, `FlightFareRulesError`) with additional context.

---

## 7. Timeout Handling

### Timeout Configuration

**Location**: `lib/triplover/config.ts` (lines 73-76)

```typescript
export const SUPPLIER_TIMEOUT_MS = 110_000;  // 110 seconds for API calls
export const LOGIN_TIMEOUT_MS = 20_000;      // 20 seconds for login
```

### Timeout Rationale

**Supplier Timeout (110s)**:
- Measured against UAT on 2026-07-28
- Single one-way DAC→CXB search took **57 seconds**
- Round trip with 66 offers took longer
- Supplier fans out to multiple upstream sources and waits for the slowest
- Kept below Vercel route handler's `maxDuration` to return clean errors

**Login Timeout (20s)**:
- Login is a small call against a fast endpoint
- Should never approach this limit
- Shorter timeout prevents hanging on misconfigured hosts

### Timeout Implementation

**Location**: `lib/triplover/client.ts` (lines 220-245)

```typescript
async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  operation: TriploverOperation
): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new TriploverError(
      'network',
      aborted
        ? `Triplover ${operation} timed out after ${Math.round(timeoutMs / 1000)}s.`
        : `Triplover ${operation} could not be reached.`
    );
  } finally {
    clearTimeout(timer);
  }
  // ... rest of implementation
}
```

### Timeout Behavior

- **Timeout on Request**: If the request exceeds the timeout, the controller aborts the fetch
- **Error Classification**: Timeout is classified as `network` error
- **No Retry**: Timeouts are not retried (operation fails immediately)
- **Timing Metrics**: TTFB (time to first byte) is tracked separately from total request time

### Performance Timing Breakdown

The client tracks detailed timing:

```typescript
type HttpTiming = {
  requestMs: number;      // Request start through complete body
  ttfbMs: number;         // Request start through headers
  responseReadMs: number; // Headers through complete body
  responseParseMs: number; // JSON.parse only
};
```

This helps diagnose slow responses and distinguish between:
- Slow server (high TTFB)
- Slow network (high responseReadMs)
- Large payloads (high responseParseMs)

---

## 8. Request/Response Mapping

### Standard Response Envelope

Triplover wraps responses in an envelope:

```typescript
{
  item1: { /* domain payload — varies per endpoint */ },
  item2: {
    apiRef: number,
    uniqueTransID: string,
    isSuccess: boolean,
    requestTime: string,
    responseTime: string,
    message: string | null,
    // ... other metadata
  }
}
```

**Exception**: Search returns `item2` as an array (one entry per upstream source).

### Envelope Unwrapping

**Location**: `lib/triplover/client.ts` (lines 273-326)

```typescript
function readEnvelope(body: unknown): {
  item1: unknown;
  metas: EnvelopeMeta[];
  isSuccess: boolean;
  partial: boolean;
  message: string | null;
} {
  const envelope = (body ?? {}) as { item1?: unknown; item2?: unknown };
  const rawMeta = envelope.item2;

  // Handle array form (Search) or object form (other endpoints)
  const metas: EnvelopeMeta[] = Array.isArray(rawMeta)
    ? (rawMeta as EnvelopeMeta[])
    : rawMeta && typeof rawMeta === 'object'
      ? [rawMeta as EnvelopeMeta]
      : [];

  const succeeded = metas.filter((m) => m.isSuccess === true);
  const failed = metas.filter((m) => m.isSuccess === false);

  // Success if any entry succeeded
  const isSuccess = metas.length === 0
    ? envelope.item1 != null
    : succeeded.length > 0;

  // Partial if some succeeded and some failed
  const partial = succeeded.length > 0 && failed.length > 0;

  // Message from first failed entry, or first entry, or null
  const message = failed.find((m) => m.message)?.message
    ?? metas.find((m) => m.message)?.message
    ?? null;

  return {
    item1: envelope.item1 ?? null,
    metas,
    isSuccess,
    partial,
    message,
  };
}
```

### Partial Success Handling

For Search (and potentially other endpoints), the supplier may return partial results where some upstream sources failed:

```typescript
export type TriploverCallResult = {
  data: unknown;
  partial: boolean;  // True if some sources failed
  uniqueTransId: string | null;
  timing: TriploverCallTiming;
};
```

Callers can check `partial` to determine if the result is complete.

### Top-Level Payload Exception

**AirTicketingDetails** is documented to return the report object directly at the top level, bypassing the envelope:

```typescript
const call = await triploverCall(
  'AirTicketingDetails',
  `/api/B2BReport/AirTicketingDetails/${uniqueTransId}/${status}`,
  null,
  { method: 'GET', topLevelPayload: true }
);
```

When `topLevelPayload: true` is set, the client returns the raw response body without envelope unwrapping.

---

## 9. Operation-Specific Implementations

### Search

**Location**: `lib/triplover/search.ts`

**Request Building**:
```typescript
export function buildSearchRequest(input: FlightSearchInput): TriploverSearchRequest {
  return {
    routes: input.routes.map(route => ({
      origin: route.origin.toUpperCase(),
      destination: route.destination.toUpperCase(),
      departureDate: route.departureDate,
    })),
    adults: input.adults,
    childs: input.children,  // Children 2-11
    infants: input.infants,
    cabinClass: input.cabinClass,
    preferredCarriers: input.preferredCarriers.map(c => c.toUpperCase()),
    prohibitedCarriers: [],
    childrenAges: input.childrenAges,
  };
}
```

**Important Notes**:
- `fareType` is deliberately not sent (supplier documents it without defining values)
- Supplier splits children into `chd` (5-11) and `cnn` (2-4) using `childrenAges`
- All codes are uppercased

**Response Mapping**:
- Defensive parsing of all fields
- Ambiguous direction alternatives (undocumented shape) are expanded into separate itineraries
- Offers with ambiguous selection are flagged (`ambiguousSelection: true`)
- Markup rules are applied via `lib/markup`

**Cross-Reference**: See [05-FLIGHT-SEARCH.md](05-FLIGHT-SEARCH.md) for search architecture

### RePrice

**Location**: `lib/triplover/reprice.ts`

**Purpose**: Confirm live fare before booking

**Request**:
```typescript
const call = await triploverCall('RePrice', '/api/Reprice', {
  uniqueTransID: search.uniqueTransId,
  itemCodeRef: refs.itemCodeRef,
  segmentCodeRefs: refs.segmentCodeRefs,
  taxRedemptions: [],
  commissionOnTaxes: [],
  brandedFareRefs: '',
});
```

**Response Handling**:
- Validates price fields are finite numbers
- Maps per-passenger fares to totals
- Applies markup rules
- Detects price changes
- Returns new references (`priceCodeRef`, `uniqueTransID`)

**Error Codes**:
- `SEARCH_EXPIRED`: Search cache entry not found
- `FARE_NOT_FOUND`: Itinerary not in search results
- `AMBIGUOUS_FARE`: Cannot safely reprice (due to ambiguous alternatives)

### Book

**Location**: `lib/triplover/book.ts`

**Purpose**: Create booking (held PNR or direct ticket)

**Request**:
```typescript
const call = await triploverCall('Book', '/api/Book', {
  passengerInfoes: submittedPassengers,
  BookingWiseContactInfo: {},
  agentInfo: null,
  taxRedemptions: [],
  priceCodeRef: refs.priceCodeRef,
  uniqueTransID: refs.uniqueTransId,
  itemCodeRef: refs.itemCodeRef,
  commissionOnTaxes: [],
});
```

**Response Handling**:
- Extracts PNR (from `pnr` or `bookingRefNumber`)
- Detects direct-ticket response (when `ticketInfoes` is present)
- Reads ticket numbers if direct-ticketed
- Authoritative TTL from PNR read (Book's TTL is provisional)
- Returns booking references for subsequent operations

**Safety**: Never retried (see retry policy)

### NewTicket

**Location**: `lib/triplover/ticket.ts`

**Purpose**: Issue ticket against held booking

**Request**:
```typescript
const call = await triploverCall('NewTicket', '/api/ticket/NewTicket', {
  PNR: input.pnr,
  BookingRefNumber: input.bookingRefNumber,
  UniqueTransID: input.uniqueTransId,
  PriceCodeRef: input.priceCodeRef,
  ItemCodeRef: input.itemCodeRef,
  BookingCodeRef: input.bookingCodeRef,
});
```

**Response Handling**:
- Extracts ticket numbers
- Validates `ticketCodeRef` is present
- Returns booking status as 'Confirmed'

**Safety**: Never retried (see retry policy)

### Cancel

**Location**: `lib/triplover/cancel.ts`

**Purpose**: Cancel held booking

**Request**:
```typescript
const call = await triploverCall('Cancel', '/api/Cancel', {
  PNR: input.pnr,
  BookingRefNumber: input.bookingRefNumber,
  UniqueTransID: input.uniqueTransId,
  PriceCodeRef: input.priceCodeRef,
  ItemCodeRef: input.itemCodeRef,
  BookingCodeRef: input.bookingCodeRef,
});
```

**Response Handling**:
- Validates `isCancel: true`
- Extracts refund amounts
- Returns confirmation

**Safety**: Never retried (see retry policy)

### Pnr

**Location**: `lib/triplover/pnr.ts`

**Purpose**: Read PNR details for deadline verification

**Request**:
```typescript
const call = await triploverCall('Pnr', '/api/pnr', {
  PNR: input.pnr,
  BookingRefNumber: input.bookingRefNumber,
  UniqueTransID: input.uniqueTransId,
  PriceCodeRef: input.priceCodeRef,
  ItemCodeRef: input.itemCodeRef,
  BookingCodeRef: input.bookingCodeRef,
});
```

**Response Handling**:
- Extracts PNR status
- Normalizes `lastTicketTime` (handles ambiguous DD/MM vs MM/DD)
- FirstTrip and direct Triplover use MM/DD/YYYY for US-Bangla (`BS`) and DD/MM/YYYY otherwise
- TakeOff uses MM/DD/YYYY for every carrier
- Uses booking instant to resolve ambiguous dates
- Returns airline PNRs

**Deadline Normalization**:
```typescript
export function normalizePnrLastTicketTime(
  value: unknown,
  deadlineNotBefore?: string | number | Date | null,
  carrierCode?: string | null,
  supplier?: TriploverSupplier
): string | null
```

The configured credential account selects the rule. FirstTrip and direct
Triplover prefer MM/DD/YYYY for US-Bangla (`BS`) and DD/MM/YYYY otherwise;
TakeOff prefers MM/DD/YYYY for every carrier. If the preferred interpretation
predates the booking, the viable alternate is used.

### FareRules

**Location**: `lib/triplover/fare-rules.ts`

**Purpose**: Get fare rule narrative

**Request**:
```typescript
const call = await triploverCall('FareRules', '/api/FareRules', {
  itemCodeRef: refs.itemCodeRef,
  uniqueTransID: search.uniqueTransId,
  segmentCodeRefs: refs.segmentCodeRefs,
  brandedFareRefs: '',
});
```

**Response Handling**:
- Maps fare rule details with types
- Normalizes line breaks (Windows/Unix to `\n`)
- Returns structured rule sections

**Error Codes**:
- `SEARCH_EXPIRED`: Search cache entry not found
- `FARE_NOT_FOUND`: Itinerary not in search results

### AirTicketingDetails

**Location**: `lib/triplover/air-ticketing-details.ts`

**Purpose**: Get back-office ticketing report for reconciliation

**Request**:
```typescript
const call = await triploverCall(
  'AirTicketingDetails',
  `/api/B2BReport/AirTicketingDetails/${uniqueTransId}/${status}`,
  null,
  { method: 'GET', topLevelPayload: true }
);
```

**Response Handling**:
- Extracts ticket numbers from passenger records
- Parses issue and cancellation dates
- Returns supplier status and timestamps

**Latest Record Lookup**:
```typescript
export async function readLatestAirTicketingDetails(
  uniqueTransId: string
): Promise<AirTicketingDetails>
```

Tries status filters in order: Cancelled, Confirmed, Refunded.

---

## 10. Configuration Management

### Configuration Schema

**Location**: `lib/triplover/config.ts`

```typescript
export type TriploverConfig = {
  supplier: 'firsttrip' | 'takeoff' | 'triplover'; // Named credential account
  searchBaseUrl: string;  // Host for POST /api/Search only
  baseUrl: string;        // Host for all other operations
  email: string;          // API credential email
  password: string;       // Base64-encoded password (from provider)
};
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FIRSTTRIP_SEARCH_BASE_URL` | Yes | FirstTrip Search API host |
| `FIRSTTRIP_BASE_URL` | Yes | FirstTrip user/API host |
| `FIRSTTRIP_EMAIL` | Yes | FirstTrip API credential email |
| `FIRSTTRIP_PASSWORD` | Yes | FirstTrip base64-encoded password |
| `TAKEOFF_SEARCH_BASE_URL` | Yes | TakeOff Search API host |
| `TAKEOFF_BASE_URL` | Yes | TakeOff user/API host |
| `TAKEOFF_EMAIL` | Yes | TakeOff API credential email |
| `TAKEOFF_PASSWORD` | Yes | TakeOff base64-encoded password |
| `TRIPLOVER_SEARCH_BASE_URL` | Yes | Direct Triplover Search API host |
| `TRIPLOVER_BASE_URL` | Yes | Direct Triplover user/API host |
| `TRIPLOVER_EMAIL` | Yes | Direct Triplover API credential email |
| `TRIPLOVER_PASSWORD` | Yes | Direct Triplover base64-encoded password |

`active_supplier`, `booking_enabled`, and `ticketing_enabled` are database
settings changed only from **Dashboard → Supplier Control** by a Super Admin.
They are not deployment environment variables. During the one-time rolling
transition only, the legacy Triplover flags are used while the control table is
absent or empty; after the first Super Admin save, the database is authoritative.

### Configuration Loading

```typescript
export function triploverConfig(
  supplier: TriploverSupplier
): TriploverConfig | null {
  const prefix = supplier.toUpperCase();
  const searchBaseUrl = process.env[`${prefix}_SEARCH_BASE_URL`];
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const email = process.env[`${prefix}_EMAIL`];
  const password = process.env[`${prefix}_PASSWORD`];

  if (!searchBaseUrl || !baseUrl || !email || !password) return null;

  return {
    supplier,
    searchBaseUrl: searchBaseUrl.replace(/\/+$/, ''),
    baseUrl: baseUrl.replace(/\/+$/, ''),
    email,
    password,
  };
}
```

**Important**:
- Trailing slashes are stripped from URLs
- Returns `null` if any required variable is missing
- Read per call (not at module scope) to pick up runtime changes on Vercel

### Supplier Binding and Operational Controls

The active database setting is read only when creating a new search. Its account
name is stored with the search quote, copied to the booking attempt, and copied
to the final booking in the same transaction. RePrice, FareRules, Book, PNR,
Cancel, NewTicket, and AirTicketingDetails use that stored account—not the
current active setting. This prevents an Admin switch from redirecting an
in-flight booking to a different credential account.

Booking submission and paid-ticket issuance are separately controlled by the
same Super Admin database row. A database-read failure fails closed. A ticketing
setting cannot be enabled while booking is disabled.

### Server-Only Enforcement

The config module imports `'server-only'` to prevent credential leakage:

```typescript
import 'server-only';
```

If a client component accidentally imports this module, the build fails rather than leaking credentials to the browser.

### Critical Invariants

1. **Server-Only Access**: Configuration must never be imported from `'use client'` files
2. **Runtime Reads**: Configuration is read per call, not at module scope
3. **Password Passthrough**: Password is already base64-encoded by the provider; do not decode/re-encode
4. **URL Normalization**: Trailing slashes are stripped to prevent double-slash URLs
5. **Feature Gates**: Booking and ticketing are separately controlled in the audited Super Admin database setting

---

## 11. IMP/EXP Direct Airline Retrieval and Sync

IMP/EXP is a separate external-supplier path. It launches server-side Chromium
against approved US-Bangla, Air Astra, or NOVOAIR Manage Booking pages through
`lib/impexp/providers.server.ts` and provider adapters. It does not use the
Triplover Book, NewTicket, Cancel, PNR, or AirTicketingDetails APIs.

The workflow is intentionally retrieve-first:

1. Preview retrieves and normalizes authoritative supplier evidence.
2. Import re-retrieves the booking, validates mandatory assignment and User
   Payable, and calls the transactional import RPC.
3. Manual ticket issuance/verification happens in the external supplier system.
4. Operations-only Sync re-retrieves the same provider/reference and persists
   authoritative supplier-controlled fields.

Sync may update supplier status/evidence, airline PNR, ticket numbers,
passenger/ticket details, itinerary, fare detail, Supplier Gross, ticketing
deadline, messages, and import audit metadata. It must not update User Payable,
assignment, financial owner, charged wallet account, payment state, captured
amount, ledger, or reservation rows.

A paid In Progress import remains In Progress when the supplier still reports
Held. It becomes Confirmed only when normalized supplier evidence is
authoritatively ticketed/confirmed. Negative evidence after capture is routed
to reconciliation; Sync never refunds, releases, or directly edits a balance.

The normal `/api/flights/booking/issue`, `/cancel`, and `/refresh-details`
routes reject `supplier !== 'triplover'` with `EXTERNAL_SUPPLIER_BOOKING` so an
imported record cannot accidentally call the wrong supplier write API.

### Browser and Device-Verification Boundary

The Chromium runtime and Playwright assets only make browser execution possible;
they do not make a Vercel/server browser equivalent to the operator's Chrome.
Each supplier request uses a fresh server-side context and a cloud network. A
pasted TTInteractive `(S(...))` URL carries only the URL token and does not copy
the operator's cookies, local storage, browser/device fingerprint, completed
Device Check, or residential network identity.

US-Bangla and other airline sites may therefore return an invisible Device
Check or CAPTCHA to production while the same PNR succeeds in an operator's
normal browser or on localhost. The adapters detect that evidence and fail the
preview safely with an upstream error; they must not attempt to solve, suppress,
or bypass the airline's security challenge. A supported production integration
requires an official supplier API or a supplier-approved execution host/network.

See [IMP/EXP Booking Imports](17-IMP-EXP-IMPORTS.md) for provider URLs,
normalization, pricing, wallet, and lifecycle rules.

---

## 12. FirstTrip, TakeOff, and Triplover Reference Import

Supplier API Import is a separate path from airline scraping, MANUAL, and
IMP_EXP. Staff selects the credential account and supplies its matching
transaction reference (`FST...` for FirstTrip, `TOT...` for TakeOff, or
`TLL...` for Triplover).

The server calls `AirTicketingDetails` first, parses the real PNR,
BookingRefNumber, UniqueTransID, ItemCodeRef, PriceCodeRef, and BookingCodeRef
from `ticketInfo.referenceLog`, and then calls `/api/pnr` with those exact
values. Import fails if the account prefix, supplier echoes, report status, PNR
status, passenger/ticket evidence, or required operational references conflict.

Booking Owner is selected before preview because that owner determines the
canonical pricing principal and B2C/agency rule audience. Supplier API Import
does not accept a manual User Payable. It strictly converts the reconciled
supplier passenger fares to `SupplierFarePricing[]`, then invokes the same
`resolveBookingActorContext`, `pricingAudienceForPrincipal`,
`activeMarkupRulesFor`, `selectMarkupRules`, and `priceOffer` sequence used by
Search/RePrice. The result is read-only and explicitly means:

`authoritative supplier booked payable + import-time current markup = User Payable`

This is not an estimate of the historical selling price. The complete canonical
pricing snapshot, selected rule components, supplier payable/gross/discount,
pricing timestamp, and supplier evidence timestamp are retained with
`pricingMode = 'import_time_current_markup'`.

Normalization is fail-closed. BDT is the only supported currency contract;
passenger/type totals must reconcile to `ticketingPrice`; supplier discounts
remain supplier evidence; `agentAdditionalPrice` is never interpreted as a
ShoponTravels service margin. Reissue, partial cancellation/refund, additional
collection, ambiguous carrier/codeshare, multi-carrier-without-plating-carrier,
or incomplete route/cabin/fare evidence is rejected instead of falling back to
manual pricing.

Preview returns a short-lived server-signed confirmation bound to the operator,
owner, normalized supplier evidence, and canonical pricing snapshot. Import and
Import & Charge retrieve and calculate again on the server. If supplier evidence
or applicable pricing differs, the confirmation is rejected and staff must
retrieve and explicitly confirm the new read-only amount; browser-supplied money
is never trusted.

The stored row remains a normal Triplover API booking:

- `supplier = 'triplover'`
- `import_source IS NULL`
- `booking_origin = 'supplier_reference_import'`
- `supplier_account` is the selected FirstTrip/TakeOff/Triplover account
- `supplier_refs`, PNR, booking code, and booking reference are supplier values

The supplier account and operational identity are immutable. Duplicate identity
is `(supplier_account, supplier_refs.uniqueTransId)` across both imported and
already-local API bookings, protected by both an advisory transaction lock and
a unique database index. Consequently later
Issue, Cancel, PNR refresh, reconciliation, reports, details, and email flows
use the existing API lifecycle and the originally bound credential account.

Held/Booked imports are On Hold and Unpaid with no wallet mutation. Issue Now
later uses the normal API wallet reservation and NewTicket flow. Confirmed
imports require an explicit choice: historical Import Only creates no local
financial history, while Import & Charge uses a separately audited five-minute,
one-use exact-payload authorization and atomically writes the debit, captured
reservation, ledger entry, booking, and consumed authorization. Cancelled or
refunded imports create no invented debit or refund.

Primary implementation paths:

- `lib/supplier-reference-import/retrieve.server.ts`
- `app/api/supplier-reference-import/*`
- `lib/db/supplier-reference-import.ts`
- `supabase/migrations/0109_supplier_reference_api_import.sql`
- `supabase/migrations/0142_triplover_supplier_reference_import.sql`

---

## Cross-References

### Related Documentation

- **Flight Search**: [05-FLIGHT-SEARCH.md](05-FLIGHT-SEARCH.md) - Search architecture and flow
- **Booking System**: [07-BOOKING-SYSTEM.md](07-BOOKING-SYSTEM.md) - Booking integration
- **Pricing and Markup**: [06-PRICING-AND-MARKUP.md](06-PRICING-AND-MARKUP.md) - Markup application
- **Booking Lifecycle**: [08-BOOKING-LIFECYCLE.md](08-BOOKING-LIFECYCLE.md) - Status transitions
- **Supplier API**: `Triploaver_API_Documentation.md` (root) - Official API contract
- **IMP/EXP Imports**: [17-IMP-EXP-IMPORTS.md](17-IMP-EXP-IMPORTS.md) - Direct airline retrieval and non-financial Sync

### Related Code

- **Client**: `lib/triplover/client.ts` - API client implementation
- **Config**: `lib/triplover/config.ts` - Configuration management
- **Search**: `lib/triplover/search.ts` - Search operation
- **RePrice**: `lib/triplover/reprice.ts` - Reprice operation
- **Book**: `lib/triplover/book.ts` - Booking operation
- **Cancel**: `lib/triplover/cancel.ts` - Cancellation operation
- **Ticket**: `lib/triplover/ticket.ts` - Ticket issuance
- **PNR**: `lib/triplover/pnr.ts` - PNR lookup
- **FareRules**: `lib/triplover/fare-rules.ts` - Fare rules
- **AirTicketingDetails**: `lib/triplover/air-ticketing-details.ts` - Reporting
- **Supplier reference import**: `lib/supplier-reference-import/retrieve.server.ts` - AirTicketingDetails-to-PNR verified import
- **IMP/EXP providers**: `lib/impexp/providers.server.ts` and provider adapters - Direct airline retrieval
- **IMP/EXP normalization**: `lib/impexp/normalize.ts` - Canonical imported booking mapping

### Before Modifying This System

1. **Understand the retry policy**: Adding a new operation requires explicit safety classification
2. **Test with UAT**: Many behaviors are undocumented and discovered through probing
3. **Check token expiry handling**: Ensure new operations handle 401 and envelope message expiry
4. **Validate envelope handling**: Search returns array `item2`; other endpoints return object
5. **Consider timeouts**: Long-running operations may need custom timeouts
6. **Preserve reference tokens**: Never construct, decode, or modify opaque tokens
7. **Update feature flags**: If adding new write operations, consider adding a feature flag

### Critical Invariants Summary

1. **Write operations never retry**: Book, Cancel, NewTicket are never retried
2. **Token isolation**: Bearer tokens never leak to business logic layers
3. **Server-only execution**: All Triplover code is server-only
4. **Reference token opacity**: Tokens are passed through verbatim
5. **Safety classification**: New operations must be classified in `isRetrySafe()`
6. **Partial success handling**: Search may return partial results
7. **Deadline normalization**: PNR dates are ambiguous and require booking context
8. **Feature gates**: Booking and ticketing are behind separate flags
9. **Supplier Boundary**: Imported external-supplier bookings must never call Triplover Issue, Cancel, or Refresh operations
10. **Non-Financial Sync**: IMP/EXP Sync may update supplier-controlled fields only and must never charge or overwrite User Payable
11. **Imported API Identity**: FirstTrip/TakeOff reference imports retain their original immutable supplier account and real operational reference chain
12. **No Invented Finance**: Supplier payment/status evidence never creates local wallet history without an explicit Import & Charge authorization
