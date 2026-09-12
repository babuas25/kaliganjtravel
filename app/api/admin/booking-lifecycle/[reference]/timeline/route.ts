import { NextResponse } from 'next/server';

import { bookingLifecycleAccessForRole } from '@/lib/dashboard/booking-lifecycle';
import { getDashboardSession } from '@/lib/dashboard/session';
import { readStaffBookingLifecycleTimeline } from '@/lib/db/booking-lifecycle-timeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(status: number, error: string) {
  return NextResponse.json(
    { success: false, error },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ reference: string }> }
) {
  const [session, { reference }] = await Promise.all([
    getDashboardSession(),
    params,
  ]);
  if (!session) return fail(401, 'Authentication required.');
  if (!bookingLifecycleAccessForRole(session.role)) {
    return fail(403, 'Booking lifecycle staff access is required.');
  }
  if (!/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(reference)) {
    return fail(400, 'Invalid booking reference.');
  }

  try {
    const data = await readStaffBookingLifecycleTimeline(session.role, reference);
    return NextResponse.json(
      { success: true, data },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[booking-lifecycle] timeline read failed:', error);
    return fail(503, 'Booking lifecycle timeline is temporarily unavailable.');
  }
}
