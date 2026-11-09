import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { BOOKING_CURRENCY, isBookingCurrency, UNSUPPORTED_CURRENCY_MESSAGE } from '@/lib/currency';

import { passportRequiredFor } from '@/lib/airports/country';
import { getDashboardSession } from '@/lib/dashboard/session';
import { createBookingAttempt } from '@/lib/db/booking-attempts';
import {
  canonicalBookingSnapshot,
  readSearch,
  readRepricedSelection,
  SearchReferenceStoreError,
  verifyBookingSnapshot,
} from '@/lib/flights/search-cache';
import type { BookingPassengerType } from '@/lib/flights/booking';
import {
  canCreateBookingOnBehalf,
  resolveBookingActorContext,
} from '@/lib/flights/staff-booking.server';
import { requestActorKey } from '@/lib/http/actor-key';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { canCreateOwnBooking } from '@/lib/wallet/permissions';
import { shapontravelsRead, ShapontravelsReadError } from '@/lib/shapontravels/client';
import { getSupplierOperationalControls } from '@/lib/db/supplier-controls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REPRICE_FRESH_MS = 5 * 60_000;

const schema = z.object({
  searchId: z.string().uuid(),
  itineraryId: z.string().regex(/^itn-\d+-\d+$/),
  acceptedRepricedAt: z.string().datetime().nullable(),
  // The result page already owns this public display data. It is never trusted
  // by itself: after the authoritative Redis read we verify its SHA-256 digest
  // against the exact Search option before it can enter booking_attempts.
  itinerary: z.unknown(),
  assignedUserId: z.string().trim().min(1).max(128).optional(),
});

function fail(status: number, errorCode: string, errorMessage: string) {
  return NextResponse.json(
    { success: false, error: { errorCode, errorMessage } },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

/**
 * Emits only structural diagnostics for the browser-carried public snapshot.
 * It deliberately excludes supplier capabilities, route values, and digest
 * values; it is safe to correlate a Prepare rejection without logging them.
 */
function publicSnapshotShape(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: Array.isArray(value) ? 'array' : typeof value };
  }
  const record = value as { legs?: unknown };
  const legs = Array.isArray(record.legs) ? record.legs : null;
  return {
    kind: 'object',
    keys: Object.keys(value).sort(),
    legCount: legs?.length ?? null,
    segmentCounts: legs?.map((leg) =>
      leg && typeof leg === 'object' && !Array.isArray(leg) && Array.isArray((leg as { segments?: unknown }).segments)
        ? (leg as { segments: unknown[] }).segments.length
        : null
    ) ?? null,
  };
}

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return fail(400, 'INVALID_BODY', 'Expected a JSON body.');
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return fail(400, 'INVALID_SELECTION', 'Choose a verified fare to continue.');
  }

  // Identity first: it is the cheapest check, and answering an anonymous caller
  // with the state of a fare quote would tell them which references are real.
  let session: Awaited<ReturnType<typeof getDashboardSession>> = null;
  try {
    session = await getDashboardSession();
  } catch (error) {
    console.error('[booking] session lookup failed:', error);
  }
  if (!session) {
    return fail(
      401,
      'SIGN_IN_REQUIRED',
      'Please sign in to continue with this booking.'
    );
  }
  const canBookForSelf = canCreateOwnBooking(session.role);
  const canBookForUser = canCreateBookingOnBehalf(session.role);
  if (!canBookForSelf && !canBookForUser) {
    return fail(
      403,
      'BOOKING_OWNER_REQUIRED',
      'Operational accounts cannot create personal bookings. Open an existing owner booking to confirm it on their behalf.'
    );
  }
  const actorContext = await resolveBookingActorContext(
    session,
    parsed.data.assignedUserId
  );
  if (!actorContext) {
    return fail(
      403,
      'BOOKING_ASSIGNEE_REQUIRED',
      canBookForUser
        ? 'Select an eligible B2B or B2C user before booking.'
        : 'This booking cannot be assigned to another user.'
    );
  }
  const userId = session.clerkId;
  const limit = await checkActionLimit(
    'flightBookingPrepare',
    requestActorKey(request, userId)
  );
  if (!limit.ok) {
    return NextResponse.json(
      {
        success: false,
        error: {
          errorCode: 'RATE_LIMITED',
          errorMessage: rateLimitMessage(limit.retryAfterSeconds),
        },
      },
      {
        status: 429,
        headers: {
          'Cache-Control': 'no-store',
          'Retry-After': String(limit.retryAfterSeconds),
        },
      }
    );
  }

  // A booking draft is a cross-instance handoff, so its source quote must be
  // read from the shared Redis authority rather than served from this
  // instance's process memory. A Redis outage is not proof that the fare
  // expired.
  let search: Awaited<ReturnType<typeof readSearch>>;
  try {
    search = await readSearch(parsed.data.searchId, { consistency: 'durable' });
  } catch (error) {
    if (error instanceof SearchReferenceStoreError) {
      console.error(
        '[booking] durable search-reference read failed:',
        JSON.stringify({ kind: error.kind, retryable: error.retryable })
      );
      return error.kind === 'unavailable'
        ? fail(
            503,
            'SEARCH_REFERENCE_UNAVAILABLE',
            'We could not securely retrieve the verified fare reference. Please search again.'
          )
        : fail(
            502,
            'SEARCH_REFERENCE_INVALID',
            'This fare reference could not be verified safely. Please search again.'
          );
    }
    throw error;
  }
  const refs = search?.refsByItineraryId.get(parsed.data.itineraryId);
  const principal = actorContext.principal;
  let reprice: Awaited<ReturnType<typeof readRepricedSelection>> = null;
  if (search && refs) {
    try {
      reprice = await readRepricedSelection(
        parsed.data.searchId,
        parsed.data.itineraryId,
        principal
      );
    } catch (error) {
      if (error instanceof SearchReferenceStoreError) {
        console.error(
          '[booking] durable RePrice-reference read failed:',
          JSON.stringify({ kind: error.kind, retryable: error.retryable })
        );
        return error.kind === 'unavailable'
          ? fail(
              503,
              'SEARCH_REFERENCE_UNAVAILABLE',
              'We could not securely retrieve the verified fare reference. Please search again.'
            )
          : fail(
              502,
              'SEARCH_REFERENCE_INVALID',
              'This fare reference could not be verified safely. Please search again.'
            );
      }
      throw error;
    }
  }
  if (!search || !refs || !reprice) {
    return fail(
      410,
      'REPRICE_REQUIRED',
      'Verify this fare again while signed in before continuing.'
    );
  }
  if (!isBookingCurrency(reprice.currency)) {
    return fail(409, 'UNSUPPORTED_CURRENCY', UNSUPPORTED_CURRENCY_MESSAGE);
  }
  const repricedAtMs = Date.parse(reprice.repricedAt);
  if (
    !Number.isFinite(repricedAtMs) ||
    Date.now() - repricedAtMs > REPRICE_FRESH_MS
  ) {
    return fail(410, 'REPRICE_EXPIRED', 'The verified fare is stale. Verify it again.');
  }
  if (
    reprice.requiresConfirmation &&
    parsed.data.acceptedRepricedAt !== reprice.repricedAt
  ) {
    return fail(
      409,
      'PRICE_NOT_ACCEPTED',
      'Accept the updated fare before continuing.'
    );
  }
  if (search.supplierAccount === 'shapontravels') {
    const controls = await getSupplierOperationalControls();
    if (!controls.bookingEnabled) {
      return fail(503, 'BOOKING_DISABLED', 'Booking submission is awaiting operational activation.');
    }
    if (!reprice.bookable) {
      return fail(409, 'HOLD_FARE_REQUIRED', 'This fare cannot be held. Choose a holdable fare.');
    }
  }

  const submittedItinerary = parsed.data.itinerary;
  const snapshotVerification = verifyBookingSnapshot(
    refs,
    parsed.data.itinerary
  );
  if (snapshotVerification !== 'match') {
    console.info(
      '[booking] prepare-snapshot-check',
      JSON.stringify({
        searchFound: Boolean(search),
        optionFound: Boolean(refs),
        repriceFound: Boolean(reprice),
        publicItinerarySnapshotPresent: submittedItinerary !== undefined && submittedItinerary !== null,
        snapshotVerification,
        storedAndSubmittedDigest:
          snapshotVerification === 'digest_mismatch' ? 'mismatch' : 'not_compared',
        snapshotShape: publicSnapshotShape(submittedItinerary),
      })
    );
    return fail(
      409,
      'BOOKING_SNAPSHOT_INVALID',
      'This fare selection could not be verified safely. Please choose the flight again.'
    );
  }
  console.info(
    '[booking] prepare-snapshot-check',
    JSON.stringify({
      searchFound: true,
      optionFound: true,
      repriceFound: true,
      publicItinerarySnapshotPresent: true,
      snapshotVerification,
      storedAndSubmittedDigest: 'match',
      snapshotShape: publicSnapshotShape(submittedItinerary),
    })
  );
  // Store the same canonical display representation Search hashed. In
  // particular, a supplier-omitted terminal remains an explicit null rather
  // than becoming a browser-shape-dependent field in booking_attempts.
  const itinerary = canonicalBookingSnapshot(submittedItinerary);
  if (!itinerary) {
    return fail(
      409,
      'BOOKING_SNAPSHOT_INVALID',
      'This fare selection could not be verified safely. Please choose the flight again.'
    );
  }

  const passengerCounts = Object.fromEntries(
    Object.entries(refs.context.passengerCounts)
      .filter(([, count]) => Number.isFinite(count) && count > 0)
      .map(([type, count]) => [
        type.toUpperCase() as BookingPassengerType,
        Math.floor(count),
      ])
  );
  // Every airport the traveller touches, not just the requested endpoints —
  // a connection abroad makes an otherwise domestic trip international.
  const airportCodes = itinerary.legs.flatMap((leg) =>
    leg.segments.flatMap((segment) => [segment.from, segment.to])
  );
  const routeCodes = refs.context.routes.flatMap((route) => [
    route.origin,
    route.destination,
  ]);

  const passportRequired = passportRequiredFor(
    airportCodes.length > 0 ? airportCodes : routeCodes
  );
  // A fare the supplier will not hold is ticketed by the Book call itself. The
  // draft is prepared so travellers can be entered and reviewed; the submit
  // route still refuses to send it, because that call spends money immediately
  // and has no Cancel path.
  if (actorContext.staffOnBehalf && !reprice.bookable) {
    return fail(
      409,
      'HOLD_FARE_REQUIRED',
      'Staff can only create On Hold bookings. Choose a fare that supports holding.'
    );
  }
  const directTicketing = actorContext.staffOnBehalf ? false : !reprice.bookable;
  const travelDate = refs.context.routes[0]?.departureDate ?? '';
  const pricing = {
    audience: reprice.pricing.audience,
    agencyCode: reprice.pricing.agencyCode,
    sellingPrice: reprice.pricing.sellingPrice,
    serviceMarginAmount: reprice.pricing.serviceMarginAmount,
    supplierTotalPrice: reprice.pricing.supplierTotalPrice,
    grossPrice: reprice.pricing.grossPrice,
    ruleId: reprice.pricing.ruleId,
    basis: reprice.pricing.basis,
  };
  const supplierRefs = {
    uniqueTransId: reprice.uniqueTransId,
    itemCodeRef: reprice.itemCodeRef,
    priceCodeRef: reprice.priceCodeRef,
  };

  if (search.supplierAccount === 'shapontravels') {
    try {
      const accepted = await shapontravelsRead('Accept', {
        priceCodeRef: reprice.priceCodeRef,
      }) as { accepted?: boolean; priceCodeRef?: string; pricingVersion?: number };
      if (accepted?.accepted !== true ||
          accepted.priceCodeRef !== reprice.priceCodeRef ||
          !Number.isInteger(accepted.pricingVersion) ||
          Number(accepted.pricingVersion) < 1) {
        return fail(502, 'FARE_ACCEPTANCE_UNVERIFIED', 'The airline could not accept this fare. Check it again.');
      }
    } catch (error) {
      if (error instanceof ShapontravelsReadError) {
        console.error('[shapontravels] fare acceptance failed:', error.code, error.status, error.requestId);
      }
      return fail(502, 'FARE_ACCEPTANCE_FAILED', 'The airline could not accept this fare. Check it again.');
    }
  }

  // One insert into the operational table. No booking exists yet and none
  // will until the supplier says so — see BOOKING_ARCHITECTURE.md §3.
  const prepared = await createBookingAttempt({
    userId: actorContext.ownerUserId,
    createdByUserId: actorContext.createdByUserId,
    staffOnBehalf: actorContext.staffOnBehalf,
    audience: pricing.audience,
    agencyCode: pricing.agencyCode,
    supplierAccount: search.supplierAccount,
    searchId: parsed.data.searchId,
    itineraryId: parsed.data.itineraryId,
    supplierRefs,
    offerSnapshot: {
      itinerary,
      fares: reprice.fares ?? [],
      currency: BOOKING_CURRENCY,
      pricing,
      passengerCounts,
      travelDate,
      directTicketing,
      passportRequired,
      repricedAt: reprice.repricedAt,
    },
    sourceExpiresAt: search.expiresAt,
  });
  if (!prepared) {
    return fail(503, 'BOOKING_STORAGE_FAILED', 'Booking storage is unavailable.');
  }

  return NextResponse.json(
    { success: true, data: prepared },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
