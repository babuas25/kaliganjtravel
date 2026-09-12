import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';
import { requestActorKey } from '@/lib/http/actor-key';
import { TriploverError } from '@/lib/triplover/client';
import {
  FlightFareRulesError,
  getFlightFareRules,
} from '@/lib/triplover/fare-rules';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const fareRulesSchema = z.object({
  searchId: z.string().uuid(),
  itineraryId: z.string().regex(/^itn-\d+-\d+$/),
});

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

  const parsed = fareRulesSchema.safeParse(payload);
  if (!parsed.success) {
    return fail(
      400,
      'INVALID_FARE_RULES_REQUEST',
      'Choose a valid fare to view its airline policies.'
    );
  }

  const limit = await checkActionLimit(
    'flightFareRules',
    requestActorKey(request)
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
    const result = await getFlightFareRules(parsed.data);
    return NextResponse.json(
      { success: true, data: result },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof FlightFareRulesError) {
      return fail(error.status, error.code, error.message);
    }
    if (error instanceof TriploverError) {
      console.error(`Flight FareRules failed [${error.kind}]:`, error.message);
      const timedOut = error.kind === 'network';
      return fail(
        timedOut ? 504 : 502,
        timedOut ? 'FARE_RULES_TIMEOUT' : 'FARE_RULES_FAILED',
        timedOut
          ? 'The airline took too long to return its policies. Please try again.'
          : 'The airline policies are temporarily unavailable. Please try again.'
      );
    }
    console.error('Flight FareRules error:', error);
    return fail(
      500,
      'FARE_RULES_FAILED',
      'The airline policies could not be loaded. Please try again.'
    );
  }
}
