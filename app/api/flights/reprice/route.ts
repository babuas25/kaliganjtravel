import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { UnsupportedCurrencyError } from '@/lib/currency';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  pricingPrincipalForSession,
  type PricingPrincipal,
} from '@/lib/flights/pricing-principal';
import { readSearch } from '@/lib/flights/search-cache';
import { resolveBookingActorContext } from '@/lib/flights/staff-booking.server';
import { requestActorKey } from '@/lib/http/actor-key';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { TriploverError } from '@/lib/triplover/client';
import { ShapontravelsReadError } from '@/lib/shapontravels/client';
import {
  FlightRepriceError,
  repriceFlight,
} from '@/lib/triplover/reprice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const repriceSchema = z.object({
  searchId: z.string().uuid(),
  itineraryId: z.string().regex(/^itn-\d+-\d+$/),
  assignedUserId: z.string().trim().min(1).max(128).optional(),
});

async function pricingPrincipal(
  assignedUserId?: string
): Promise<{ principal: PricingPrincipal; valid: boolean }> {
  try {
    const session = await getDashboardSession();
    if (!session) {
      return {
        principal: { userId: null, audience: 'b2c', agencyCode: null },
        valid: !assignedUserId,
      };
    }
    const context = await resolveBookingActorContext(session, assignedUserId);
    return context
      ? { principal: context.principal, valid: true }
      : { principal: { userId: session.clerkId, audience: 'b2c', agencyCode: null }, valid: false };
  } catch (error) {
    console.error('[markup] RePrice audience lookup failed:', error);
  }
  return {
    principal: { userId: null, audience: 'b2c', agencyCode: null },
    valid: false,
  };
}

function fail(status: number, errorCode: string, errorMessage: string) {
  return NextResponse.json(
    { success: false, error: { errorCode, errorMessage } },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request: NextRequest) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return fail(400, 'INVALID_BODY', 'Expected a JSON body.');
  }

  const parsed = repriceSchema.safeParse(payload);
  if (!parsed.success) {
    return fail(400, 'INVALID_REPRICE', 'Choose a valid fare to continue.');
  }

  const resolved = await pricingPrincipal(parsed.data.assignedUserId);
  if (!resolved.valid && !parsed.data.assignedUserId) {
    try {
      const search = await readSearch(parsed.data.searchId, { consistency: 'durable' });
      if (search?.supplierAccount === 'shapontravels') {
        resolved.principal = pricingPrincipalForSession(await getDashboardSession());
        resolved.valid = true;
      }
    } catch {
      // The normal Reprice read below reports an unavailable reference.
    }
  }
  if (!resolved.valid) {
    return fail(
      403,
      'BOOKING_ASSIGNEE_REQUIRED',
      'Select an eligible B2B or B2C user before booking.'
    );
  }
  const principal = resolved.principal;
  const limit = await checkActionLimit(
    'flightReprice',
    requestActorKey(request, principal.userId)
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

  try {
    const result = await repriceFlight({
      ...parsed.data,
      principal,
    });
    // `repriceFlight` returns only after its Redis Lua CAS has either updated
    // the selected principal's ref or verified an idempotent prior update.
    // Keep this correlation marker free of supplier references and user ids.
    console.info(
      '[flight-reprice] redis-cas-confirmed',
      JSON.stringify({ itineraryId: parsed.data.itineraryId })
    );
    return NextResponse.json(
      { success: true, data: result },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof ShapontravelsReadError) {
      console.error('[shapontravels] Reprice failed:', error.code, error.status, error.requestId);
      return fail(error.code === 'READ_NETWORK' ? 504 : 502, 'REPRICE_FAILED', 'The airline could not verify this fare. Please search again.');
    }
    if (error instanceof UnsupportedCurrencyError) {
      return fail(502, error.code, error.message);
    }
    if (error instanceof FlightRepriceError) {
      return fail(error.status, error.code, error.message);
    }
    if (error instanceof TriploverError) {
      console.error(`Flight RePrice failed [${error.kind}]:`, error.message);
      if (
        error.kind === 'supplier' &&
        /no eligible fare found/i.test(error.message)
      ) {
        return fail(422, 'NO_ELIGIBLE_FARE', 'No eligible fare found');
      }
      const timedOut = error.kind === 'network';
      return fail(
        timedOut ? 504 : 502,
        timedOut ? 'REPRICE_TIMEOUT' : 'REPRICE_FAILED',
        timedOut
          ? 'The airline took too long to verify this fare. Please try again.'
          : 'The airline could not verify this fare. Please search again.'
      );
    }
    console.error('Flight RePrice error:', error);
    return fail(
      500,
      'REPRICE_FAILED',
      'The fare could not be verified. Please try again.'
    );
  }
}
