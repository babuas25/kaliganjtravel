import { NextRequest, NextResponse } from 'next/server';

import { getDashboardSession } from '@/lib/dashboard/session';
import {
  canCreateBookingOnBehalf,
  searchStaffBookingAssignees,
} from '@/lib/flights/staff-booking.server';
import { checkActionLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) {
    return NextResponse.json({ error: 'Please sign in.' }, { status: 401 });
  }
  if (!canCreateBookingOnBehalf(session.role)) {
    return NextResponse.json({ error: 'This action is not allowed.' }, { status: 403 });
  }
  const limit = await checkActionLimit(
    'flightBookingPrepare',
    `staff-assignee:${session.clerkId}`
  );
  if (!limit.ok) {
    return NextResponse.json({ error: 'Too many user searches.' }, { status: 429 });
  }
  try {
    const users = await searchStaffBookingAssignees(
      request.nextUrl.searchParams.get('q') ?? ''
    );
    return NextResponse.json(
      { users },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('[booking] assignee search failed:', error);
    return NextResponse.json(
      { error: 'Eligible users could not be loaded.' },
      { status: 503 }
    );
  }
}
