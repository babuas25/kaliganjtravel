import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { bookingLifecycleAccessForRole } from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import { listBookingAttemptReconciliationQueue } from '@/lib/db/booking-attempt-reconciliation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const limit = z.coerce.number().int().min(1).max(200).default(100);

function fail(status: number, error: string) {
  return NextResponse.json(
    { success: false, error },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

/** Staff-only, read-only queue of orphaned Book attempts and safe read plans. */
export async function GET(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) return fail(401, 'Authentication required.');
  if (!bookingLifecycleAccessForRole(session.role)) {
    return fail(403, 'Booking lifecycle staff access is required.');
  }

  const parsedLimit = limit.safeParse(
    request.nextUrl.searchParams.get('limit') ?? 100
  );
  if (!parsedLimit.success) return fail(400, 'Invalid queue limit.');

  try {
    const data = await listBookingAttemptReconciliationQueue(session.role, {
      limit: parsedLimit.data,
    });
    return NextResponse.json(
      { success: true, data },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[booking-lifecycle] attempt queue read failed:', error);
    return fail(
      503,
      'Booking attempt reconciliation queue is temporarily unavailable.'
    );
  }
}
