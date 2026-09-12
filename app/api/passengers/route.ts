import { z } from 'zod';

import {
  createPassengerProfile,
  deletePassengerProfile,
  listPassengerProfiles,
  passengerAccessFor,
  updatePassengerProfile,
} from '@/lib/db/passengers';
import { getDashboardSession } from '@/lib/dashboard/session';
import {
  PassengerProfileCheckoutCreateSchema,
  PassengerProfileCreateSchema,
  PassengerProfileDeleteSchema,
  PassengerProfileUpdateSchema,
} from '@/lib/passengers';
import { checkActionLimit, rateLimitMessage } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

function fail(status: number, errorCode: string, errorMessage: string) {
  return Response.json({ success: false, error: { errorCode, errorMessage } }, { status });
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

async function requirePassengerAccess() {
  const session = await getDashboardSession();
  if (!session) return { error: fail(401, 'SIGN_IN_REQUIRED', 'Please sign in.') };
  const access = passengerAccessFor(session);
  if (!access) return { error: fail(403, 'PASSENGER_ACCESS_DENIED', 'You cannot manage saved passengers.') };
  return { session, access };
}

export async function GET(request: Request) {
  const permitted = await requirePassengerAccess();
  if ('error' in permitted) return permitted.error;

  const params = new URL(request.url).searchParams;
  const limit = Math.min(100, Math.max(1, Number(params.get('limit') || 50) || 50));
  const passengerType = z.enum(['ADT', 'CHD', 'CNN', 'INF', 'INS']).safeParse(params.get('passengerType'));
  if (params.has('passengerType') && !passengerType.success) {
    return fail(400, 'INVALID_PASSENGER_TYPE', 'Choose a valid passenger type.');
  }
  const result = await listPassengerProfiles(permitted.access, {
    limit,
    ...(passengerType.success ? { passengerType: passengerType.data } : {}),
  });
  if (!result.ok) return fail(503, 'PASSENGER_STORAGE_ERROR', result.message);
  return Response.json({ success: true, data: { passengers: result.passengers } });
}

export async function POST(request: Request) {
  const permitted = await requirePassengerAccess();
  if ('error' in permitted) return permitted.error;
  const limited = await checkActionLimit('passengerProfile', permitted.session.clerkId);
  if (!limited.ok) return fail(429, 'RATE_LIMITED', rateLimitMessage(limited.retryAfterSeconds));

  const body = await readBody(request);
  const fromCheckout = Boolean(
    body &&
    typeof body === 'object' &&
    'source' in body &&
    body.source === 'checkout'
  );
  const parsed = (fromCheckout
    ? PassengerProfileCheckoutCreateSchema
    : PassengerProfileCreateSchema
  ).safeParse(body);
  if (!parsed.success) {
    return fail(400, 'INVALID_PASSENGER', parsed.error.issues[0]?.message ?? 'Check the passenger details.');
  }
  const result = await createPassengerProfile(permitted.session.clerkId, parsed.data);
  if (!result.ok) return fail(503, 'PASSENGER_STORAGE_ERROR', result.message);
  return Response.json({ success: true, data: { passenger: result.passenger } }, { status: 201 });
}

export async function PATCH(request: Request) {
  const permitted = await requirePassengerAccess();
  if ('error' in permitted) return permitted.error;
  const limited = await checkActionLimit('passengerProfile', permitted.session.clerkId);
  if (!limited.ok) return fail(429, 'RATE_LIMITED', rateLimitMessage(limited.retryAfterSeconds));

  const parsed = PassengerProfileUpdateSchema.safeParse(await readBody(request));
  if (!parsed.success) {
    return fail(400, 'INVALID_PASSENGER', parsed.error.issues[0]?.message ?? 'Check the passenger details.');
  }
  const { id, ...input } = parsed.data;
  const result = await updatePassengerProfile(permitted.access, id, input);
  if (!result.ok) return fail(result.notFound ? 404 : 503, result.notFound ? 'PASSENGER_NOT_FOUND' : 'PASSENGER_STORAGE_ERROR', result.message);
  return Response.json({ success: true, data: { passenger: result.passenger } });
}

export async function DELETE(request: Request) {
  const permitted = await requirePassengerAccess();
  if ('error' in permitted) return permitted.error;
  if (permitted.access.kind !== 'all') {
    return fail(403, 'PASSENGER_DELETE_DENIED', 'Only an administrator can delete a saved passenger.');
  }
  const limited = await checkActionLimit('passengerProfile', permitted.session.clerkId);
  if (!limited.ok) return fail(429, 'RATE_LIMITED', rateLimitMessage(limited.retryAfterSeconds));

  const parsed = PassengerProfileDeleteSchema.safeParse(await readBody(request));
  if (!parsed.success) return fail(400, 'INVALID_PASSENGER', 'Choose a saved passenger.');
  const result = await deletePassengerProfile(permitted.access, parsed.data.id);
  if (!result.ok) return fail(result.notFound ? 404 : 503, result.notFound ? 'PASSENGER_NOT_FOUND' : 'PASSENGER_STORAGE_ERROR', result.message);
  return Response.json({ success: true, data: { removed: true } });
}
