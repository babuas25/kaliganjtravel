import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { bookingLifecycleAccessForRole } from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import { listStaffBookingLifecycle } from '@/lib/db/booking-lifecycle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const reference = z.string().regex(/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/);
const limit = z.coerce.number().int().min(1).max(200).default(100);

function fail(status: number, error: string) {
  return NextResponse.json(
    { success: false, error },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

/** Staff-only, read-only access to normalized lifecycle operations and cases. */
export async function GET(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) return fail(401, 'Authentication required.');
  if (!bookingLifecycleAccessForRole(session.role)) {
    return fail(403, 'Booking lifecycle staff access is required.');
  }

  const values = request.nextUrl.searchParams
    .getAll('ref')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const references = z.array(reference).max(100).safeParse(values);
  const parsedLimit = limit.safeParse(request.nextUrl.searchParams.get('limit') ?? 100);
  if (!references.success || !parsedLimit.success) {
    return fail(400, 'Invalid lifecycle query.');
  }

  const attentionOnly =
    request.nextUrl.searchParams.get('attention') === 'true';

  try {
    const data = await listStaffBookingLifecycle(session.role, {
      publicRefs: references.data.length ? references.data : undefined,
      attentionOnly,
      limit: parsedLimit.data,
    });
    return NextResponse.json(
      { success: true, data },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[booking-lifecycle] read failed:', error);
    return fail(503, 'Booking lifecycle records are temporarily unavailable.');
  }
}
