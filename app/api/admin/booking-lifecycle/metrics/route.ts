import { NextResponse } from 'next/server';

import { bookingLifecycleAccessForRole } from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import { readBookingLifecycleMetrics } from '@/lib/db/booking-lifecycle-metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(status: number, error: string) {
  return NextResponse.json(
    { success: false, error },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function GET() {
  const session = await getDashboardSession();
  if (!session) return fail(401, 'Authentication required.');
  if (!bookingLifecycleAccessForRole(session.role)) {
    return fail(403, 'Booking lifecycle staff access is required.');
  }

  try {
    const data = await readBookingLifecycleMetrics(session.role);
    return NextResponse.json(
      { success: true, data },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[booking-lifecycle] metrics read failed:', error);
    return fail(503, 'Booking lifecycle metrics are temporarily unavailable.');
  }
}
