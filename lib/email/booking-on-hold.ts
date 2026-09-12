import 'server-only';

import type { BookingRow } from '@/lib/db/flight-bookings';
import { sendBookingStatusEmailOnce } from '@/lib/email/booking-status-delivery';

/** Claims and sends exactly once after an authoritative held booking is stored. */
export async function sendOnHoldBookingEmailOnce(row: BookingRow): Promise<boolean> {
  return sendBookingStatusEmailOnce(row, 'on-hold');
}
