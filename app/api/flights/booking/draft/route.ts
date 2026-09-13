import { NextResponse } from 'next/server';
import { z } from 'zod';
import { BOOKING_READ_ERROR_CODE, BOOKING_READ_ERROR_MESSAGE } from '@/lib/db/booking-read-error';

import { getDashboardSession } from '@/lib/dashboard/session';
import {
  publicBookingAttempt,
  readBookingAttempt,
} from '@/lib/db/booking-attempts';
import { getProfile } from '@/lib/db/profiles';
import { PHONE_COUNTRIES } from '@/lib/flights/countries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Reads the open attempt behind a checkout.
 *
 * The path still says `draft` because a deployed checkout page calls it by
 * that name; the source underneath is now `booking_attempts`. It is renamed to
 * `/attempt` once no in-flight checkout can still be holding the old URL.
 */

const schema = z.object({
  bookingId: z.string().uuid(),
  accessToken: z.string().min(32).max(128),
});

function fail(status: number, errorCode: string, errorMessage: string) {
  return NextResponse.json(
    { success: false, error: { errorCode, errorMessage } },
    { status, headers: { 'Cache-Control': 'no-store' } }
  );
}

function savedPhoneContact(value: string): {
  phone: string;
  phoneCountryCode: string;
} | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;

  if (trimmed.startsWith('+')) {
    const country = [...PHONE_COUNTRIES]
      .sort((a, b) => b.dialCode.length - a.dialCode.length)
      .find((candidate) => trimmed.startsWith(candidate.dialCode));
    if (country) {
      let phone = digits.slice(country.dialCode.length - 1);
      // Bangladesh profiles are commonly saved in E.164 form, while this
      // checkout intentionally displays the familiar national 01XXXXXXXXX.
      if (country.dialCode === '+880' && phone.startsWith('1')) phone = `0${phone}`;
      return phone ? { phone, phoneCountryCode: country.dialCode } : null;
    }
  }

  return { phone: digits, phoneCountryCode: '+880' };
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return fail(400, 'INVALID_BODY', 'Expected a JSON body.');
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return fail(400, 'INVALID_DRAFT', 'This booking link is invalid.');
  }

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
      'Please sign in to view this booking.'
    );
  }

  let row: Awaited<ReturnType<typeof readBookingAttempt>>;
  try {
    row = await readBookingAttempt(parsed.data.bookingId, parsed.data.accessToken);
  } catch {
    return fail(503, BOOKING_READ_ERROR_CODE, BOOKING_READ_ERROR_MESSAGE);
  }
  // An attempt nobody owns, or one owned by someone else, is treated the same
  // as one that does not exist — the reply must not confirm the id is real.
  if (
    !row ||
    (row.user_id !== session.clerkId && row.created_by_user_id !== session.clerkId)
  ) {
    return fail(404, 'DRAFT_NOT_FOUND', 'This booking draft is unavailable.');
  }
  // An attempt that already went to the supplier is not something to re-enter
  // traveller details against. Its state is deliberately not disclosed.
  if (row.state !== 'draft') {
    return fail(409, 'DRAFT_CLOSED', 'This booking has already been submitted.');
  }

  let suggestedContact: ReturnType<typeof savedPhoneContact> = null;
  // Seed the editable customer phone for every signed-in role when a profile
  // value exists. This is only a suggestion; checkout keeps it editable.
  const profile = await getProfile(row.user_id ?? session.clerkId);
  if (profile.ok) {
    suggestedContact = savedPhoneContact(
      profile.values.mobile || profile.values.agencyMobile
    );
  }

  return NextResponse.json(
    {
      success: true,
      data: {
        ...(await publicBookingAttempt(row)),
        ...(suggestedContact ? { suggestedContact } : {}),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
