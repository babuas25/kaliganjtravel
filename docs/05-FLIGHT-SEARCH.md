# Flight Search System

The flight search system provides real-time flight availability and pricing through integration with the Triplover supplier API. It handles search request building, response processing, markup application, and result caching.

## Search Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client Component                              │
│                  Flight Search Form                               │
│           (Routes, Dates, Passengers, Cabin)                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Server Action
                              │
┌─────────────────────────────────────────────────────────────────┐
│                 API Route (/api/flights/search)                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Request Validation                               │  │
│  │  - Parameter validation                                     │  │
│  │  - Session authentication                                    │  │
│  │  - Rate limiting                                             │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ lib/triplover/search.ts
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Search Request Building                              │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  buildSearchRequest() - Map to Triplover format             │  │
│  │  - Route normalization                                     │  │
│  │  - Passenger type mapping                                  │  │
│  │  - Cabin class mapping                                      │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ lib/triplover/client.ts
                              │
┌─────────────────────────────────────────────────────────────────┐
│                   Triplover API Call                              │
│              POST /api/Search                                    │
│            (with authentication token)                           │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Response
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Response Processing                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Defensive parsing of supplier response                     │  │
│  │  - Itinerary mapping                                        │  │
│  │  - Segment mapping                                          │  │
│  │  - Fare breakdown extraction                                │  │
│  │  - Baggage information extraction                           │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ lib/markup.ts
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Markup Application                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  selectMarkupRules() - Rule selection                       │  │
│  │  priceOffer() - Two-stage pricing                           │  │
│  │  - Base rule pricing                                       │  │
│  │  - Adjustment rule pricing                                 │  │
│  │  - Cap and floor enforcement                               │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ lib/flights/search-cache.ts
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Shared Redis Quote Authority                         │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  storeSearch() - confirmed 20-minute absolute TTL          │  │
│  │  - Supplier reference tokens                                │  │
│  │  - Pricing snapshot                                        │  │
│  │  - Minimal RePrice identity and public-snapshot digest      │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Redis Cloud (`flight:quote:v4:{<searchId>}`)
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Cached Results                                      │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  - Search ID (UUID)                                        │  │
│  │  - Supplier references (uniqueTransID, itemCodeRef, etc.) │  │
│  │  - Pricing snapshot with markup                            │  │
│  │  - Expiry timestamp (20 minutes)                           │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ Response to Client
                              │
┌─────────────────────────────────────────────────────────────────┐
│              Client Display                                     │
│           (Flight results with prices)                          │
└─────────────────────────────────────────────────────────────────┘
```

## Search Request Building

### Input Parameters

Search accepts the following parameters:

```typescript
type FlightSearchInput = {
  routes: Array<{
    origin: string;        // 3-letter airport code
    destination: string;   // 3-letter airport code
    departureDate: string; // YYYY-MM-DD format
  }>;
  adults: number;          // Adult passengers (12+)
  children: number;       // Child passengers (2-11)
  infants: number;        // Infant passengers (0-1)
  cabinClass: number;     // Cabin class code
  preferredCarriers: string[];  // Preferred airline codes
  childrenAges: number[];       // Ages of child passengers
};
```

### Triplover Request Mapping

The search request is mapped to Triplover's format in `lib/triplover/search.ts`:

```typescript
export function buildSearchRequest(input: FlightSearchInput): TriploverSearchRequest {
  return {
    routes: input.routes.map((route) => ({
      origin: route.origin.toUpperCase(),
      destination: route.destination.toUpperCase(),
      departureDate: route.departureDate,
    })),
    adults: input.adults,
    childs: input.children,
    infants: input.infants,
    cabinClass: input.cabinClass,
    preferredCarriers: input.preferredCarriers.map((c) => c.toUpperCase()),
    prohibitedCarriers: [],
    childrenAges: input.childrenAges,
  };
}
```

**Important Notes**:
- Airport codes are normalized to uppercase
- `fareType` is deliberately not sent (Triplover doesn't document its values). Student Fare is disabled with an unavailable notice; the API rejects non-regular fare preferences instead of silently searching regular fares.
- `childs` counts all children 2-11, supplier splits into CHD (5-11) and CNN (2-4)

## Supplier API Integration

### Authentication

Search uses the Triplover API client with automatic token management:

- Token cached with 30-minute expiry
- Automatic renewal before expiry
- Single-flight guard for concurrent logins
- Retry-safe operation (can be retried on failure)

### API Call

```typescript
const call = await triploverCall('Search', '/api/Search', {
  routes: request.routes,
  adults: request.adults,
  childs: request.childs,
  infants: request.infants,
  cabinClass: request.cabinClass,
  preferredCarriers: request.preferredCarriers,
  prohibitedCarriers: request.prohibitedCarriers,
  childrenAges: request.childrenAges,
});
```

### Error Handling

Search handles errors classified as:
- **auth**: Authentication failure
- **supplier**: Business-level failure from supplier
- **network**: Network timeout, DNS, TLS errors
- **protocol**: Unparseable response

## Response Processing

### Defensive Parsing

Supplier responses are parsed defensively:

```typescript
// Example from lib/triplover/search.ts
const rawSegment = segment as RawSegment;
if (!rawSegment.from || !rawSegment.to) {
  return null; // Drop malformed itineraries
}
```

**Strategy**:
- Missing required fields → drop itinerary
- Unparseable data → drop itinerary
- Malformed structures → drop itinerary
- Count dropped offers rather than guess

### Itinerary Mapping

Response data is mapped to internal types:

```typescript
type FlightItinerary = {
  id: string;
  carrierCode: string;
  carrierName: string;
  refundable: boolean;
  legs: ItineraryLeg[];
  totalPrice: number;
  currency: string;
  // ... other fields
};
```

### Baggage Information

Baggage data is extracted and normalized:

```typescript
type BaggageInfo = {
  units: string;        // 'KG' or 'PC'
  amount: number;       // Weight or piece count
  passengerType: string; // 'ADT', 'CHD', etc.
};
```

## Markup Application

### Rule Selection

Markup rules are selected based on the user's pricing audience:

```typescript
const audience = pricingAudienceForRole(session.role, session.agencyCode);
const rules = await activeMarkupRulesFor(audience);
const selected = selectMarkupRules(rules, itinerary);
```

See [06-PRICING-AND-MARKUP.md](06-PRICING-AND-MARKUP.md) for detailed markup logic.

### Two-Stage Pricing

Pricing applies two rules:

1. **Base Rule**: Prices the supplier fare (all airlines, all routes)
2. **Adjustment Rule**: Modifies the base result (airline/route-specific)

```typescript
const priced = priceOffer(supplierFare, selected.base, selected.adjustment);
```

### Price Enforcement

Prices are enforced with caps and floors:

- Gross price cannot exceed calculated gross
- Net price cannot go below supplier payable
- LCC service margin mode has special handling
- Caps and floors checked after each stage

## Search Caching

### Cache Storage

Search keeps only the server-private capability graph in shared Redis; the
full public itinerary stays in the browser result and is digest-verified at
Prepare before it enters the durable `booking_attempts` snapshot:

```typescript
await storeSearch(uniqueTransId, refsByItineraryId, supplierAccount);
// Redis confirms the immutable quote before Search emits a result event.
```

The graph is compressed and stored as binary bytes. The reader also accepts
Base64-encoded quotes written by the preceding deployment until they expire.
Each Search quote is capped by `FLIGHT_QUOTE_MAX_BYTES` (256 KiB by default),
so a large supplier result is reduced before it is shown. Redis still needs
headroom for its own overhead and RePrice keys; the 30 MB plan is not a promise
of a fixed number of simultaneous searches.

### Cache TTL

- **Duration**: 20 minutes
- **Purpose**: Balance freshness with performance
- **Expiration**: Redis TTL expires the quote without a Search-time cleanup query

### Cache Keys

- `searchId`: UUID for the search session
- `itineraryId`: Unique identifier for the itinerary
- Supplier references: critical private tokens that cannot be re-derived

## Repricing and Fare Verification

### Repricing

Before booking, fares are re-verified through `/api/flights/reprice`:

```typescript
const reprice = await repriceItinerary(refs);
if (reprice.supplierTotalPrice !== originalPrice) {
  // Price has changed, inform user
}
```

### Fare Rules

Fare rules can be retrieved via `/api/flights/fare-rules`:

```typescript
const fareRules = await getFareRules(refs);
```

## API Route Implementation

### Route Definition

```typescript
// app/api/flights/search/route.ts
export async function POST(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) {
    return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
  }

  const input = await request.json();
  const validated = searchSchema.parse(input);

  const audience = pricingAudienceForRole(session.role, session.agencyCode);
  const results = await searchFlights(validated, audience);

  return NextResponse.json(results);
}
```

### Authentication

- Session required for all searches
- Pricing audience derived from session
- B2B users get agency-specific pricing
- Super Admin sees supplier payable (no markup)

### Rate Limiting

Search is rate-limited to prevent abuse:

```typescript
const limit = await checkActionLimit(
  'flightSearch',
  requestActorKey(request, session.clerkId)
);
if (!limit.ok) {
  return NextResponse.json(
    { error: 'Rate limited' },
    { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
  );
}
```

## Search Parameter Validation

### Validation Schema

```typescript
const searchSchema = z.object({
  routes: z.array(z.object({
    origin: z.string().length(3).uppercase(),
    destination: z.string().length(3).uppercase(),
    departureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })).min(1).max(6),
  adults: z.number().min(1).max(9),
  children: z.number().min(0).max(8),
  infants: z.number().min(0).max(8),
  cabinClass: z.number(),
  preferredCarriers: z.array(z.string().length(2)).max(10),
  childrenAges: z.array(z.number().min(2).max(11)),
});
```

### Validation Rules

- Airport codes must be 3-letter IATA codes
- Dates must be in YYYY-MM-DD format
- Passenger counts must be reasonable
- Cabin class must be valid
- Carrier codes must be 2-letter IATA codes

## Error Handling

### Error Classification

```typescript
try {
  const results = await searchFlights(input, audience);
  return NextResponse.json(results);
} catch (error) {
  if (error instanceof TriploverError) {
    switch (error.kind) {
      case 'auth':
        return NextResponse.json({ error: 'Supplier auth failed' }, { status: 503 });
      case 'network':
        return NextResponse.json({ error: 'Network error' }, { status: 503 });
      case 'supplier':
        return NextResponse.json({ error: 'Supplier error' }, { status: 502 });
      default:
        return NextResponse.json({ error: 'Search failed' }, { status: 500 });
    }
  }
  return NextResponse.json({ error: 'Internal error' }, { status: 500 });
}
```

### Fallback Behavior

- Network errors → Service unavailable
- Supplier errors → Return available results or error
- Protocol errors → Log and return error
- Timeout → Return cached results if available

## Edge Cases

### No Results

If search returns no results:
- Return empty array
- Inform user of no availability
- Suggest alternative dates/routes

### Price Changes

If reprice shows price change:
- Inform user of new price
- Require confirmation before booking
- Update pricing snapshot

### Cache Miss

If cache lookup fails:
- Fall back to live search
- Update cache with new results
- Log cache miss for monitoring

### Supplier Outage

If supplier is unavailable:
- Return cached results if available and recent
- Inform user of temporary issues
- Retry with exponential backoff

## Related Documentation

- [06-PRICING-AND-MARKUP.md](06-PRICING-AND-MARKUP.md) - Pricing and markup system
- [09-SUPPLIER-INTEGRATION.md](09-SUPPLIER-INTEGRATION.md) - Triplover API integration
- [07-BOOKING-SYSTEM.md](07-BOOKING-SYSTEM.md) - Booking system
- [12-DATABASE.md](12-DATABASE.md) - Database schema

## Critical Invariants

### Supplier References
- Supplier reference tokens (uniqueTransID, itemCodeRef, priceCodeRef) must be preserved
- These tokens cannot be re-derived and are required for booking
- They must be stored in cache and passed through to booking

### Pricing Consistency
- Markup must be applied consistently across search and booking
- Reprice must use the same markup rules as search
- Price changes must be detected and communicated to user

### Cache Safety
- Cached results must expire within 20 minutes
- Cache keys must be unique and collision-resistant
- Cache misses must fall back to live search

### Error Handling
- Network errors must not expose sensitive information
- Supplier errors must be classified and handled appropriately
- Protocol errors must not crash the application

## Before Modifying This System

1. **Understand Supplier Contract**: Review Triplover API documentation
2. **Test Markup Changes**: Verify markup logic with test cases
3. **Check Cache Dependencies**: Identify components using cached results
4. **Validate Parameter Changes**: Ensure validation schema covers new parameters
5. **Test Error Paths**: Verify error handling for all failure modes
6. **Performance Testing**: Test with realistic search volumes
7. **Monitor Cache Hit Rate**: Ensure caching is effective
8. **Update Related Systems**: Update booking system if search output changes
