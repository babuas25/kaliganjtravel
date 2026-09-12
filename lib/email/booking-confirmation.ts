import 'server-only';

import type { BookingRow } from '@/lib/db/flight-bookings';
import { sendBookingStatusEmailOnce } from '@/lib/email/booking-status-delivery';

/** Claims and sends exactly once after persisted ticket issuance is established. */
export async function sendConfirmedBookingEmailOnce(row: BookingRow): Promise<boolean> {
  return sendBookingStatusEmailOnce(row, 'confirmed');
}
