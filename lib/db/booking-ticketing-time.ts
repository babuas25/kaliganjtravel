import 'server-only';

import type { BookingRow } from '@/lib/db/flight-bookings';
import { supabaseAdmin } from '@/lib/supabase/server';

export type BookingTicketingTime = {
  ticketingDeadlineAt: string | null;
  lastTicketingTime: string | null;
};

/** A manual PNR read may change deadline fields only, never supplier status. */
export async function saveBookingTicketingTime(
  booking: BookingRow,
  deadline: { rawLastTicketTime: string; ticketingDeadlineAt: string }
): Promise<BookingTicketingTime | null> {
  const db = supabaseAdmin();
  if (!db) throw new Error('Booking storage is unavailable.');
  if (!booking.updated_at || !deadline.rawLastTicketTime.trim() ||
      !Number.isFinite(Date.parse(deadline.ticketingDeadlineAt))) {
    throw new Error('The ticketing time could not be verified.');
  }

  // The deadline-authority trigger mirrors these into the effective deadline
  // unless a local approval/override is active. Do not use the general PNR
  // sync RPC: it can also change lifecycle state, locators and local approvals.
  const { data, error } = await db.from('flight_bookings')
    .update({
      supplier_ticketing_time_limit: deadline.rawLastTicketTime,
      supplier_ticketing_deadline_at: deadline.ticketingDeadlineAt,
      supplier_deadline_source: 'pnr_call',
    })
    .eq('id', booking.id)
    // A concurrent issue, cancellation, owner/reference edit or newer refresh
    // invalidates this read. Never overwrite a newer snapshot with it.
    .eq('updated_at', booking.updated_at)
    .select('ticketing_deadline_at,supplier_ticketing_time_limit')
    .maybeSingle();
  if (error) {
    console.error('[booking] ticketing time save failed:', error.code);
    throw new Error('The ticketing time could not be saved.');
  }
  if (!data) return null;
  return {
    ticketingDeadlineAt: data.ticketing_deadline_at,
    lastTicketingTime: data.supplier_ticketing_time_limit,
  };
}
