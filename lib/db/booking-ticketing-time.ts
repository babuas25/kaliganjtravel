import 'server-only';

import type { BookingRow } from '@/lib/db/flight-bookings';
import { supabaseAdmin } from '@/lib/supabase/server';

export type BookingTicketingTime = {
  ticketingDeadlineAt: string | null;
  lastTicketingTime: string | null;
  updatedAt?: string;
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
    .select('ticketing_deadline_at,supplier_ticketing_time_limit,updated_at')
    .maybeSingle();
  if (error) {
    console.error('[booking] ticketing time save failed:', error.code);
    throw new Error('The ticketing time could not be saved.');
  }
  if (!data) return null;
  return {
    ticketingDeadlineAt: data.ticketing_deadline_at,
    lastTicketingTime: data.supplier_ticketing_time_limit,
    ...(typeof data.updated_at === 'string' ? { updatedAt: data.updated_at } : {}),
  };
}

/** Save only the canonical Shapontravels deadline, preserving local authority. */
export async function saveShapontravelsTicketingTime(
  booking: BookingRow, supplierPublicRef: string, deadlineAt: string | null,
  revision: number | null = null,
): Promise<(BookingTicketingTime & { updated: boolean }) | null> {
  if (booking.supplier !== 'shapontravels' || booking.supplier_account !== 'shapontravels' || booking.import_source) {
    throw new Error('This is not a native Shapontravels booking.');
  }
  if (!booking.booking_code_ref || !booking.updated_at) return null;
  const db = supabaseAdmin();
  if (!db) throw new Error('Booking storage is unavailable.');
  const { data, error } = await db.rpc('apply_shapon_booking_deadline', {
    p_booking_id: booking.id,
    p_supplier_booking_id: booking.booking_code_ref,
    p_supplier_public_ref: supplierPublicRef,
    p_expected_updated_at: booking.updated_at,
    p_revision: revision,
    p_deadline_at: deadlineAt,
    p_event_id: null,
  });
  if (error) {
    console.error('[booking] supplier ticketing time save failed:', error.code);
    throw new Error('The ticketing time could not be saved.');
  }
  if (['missing', 'changed', 'ignored', 'deferred'].includes(data?.result)) return null;
  if (!data || !['updated', 'unchanged', 'stale'].includes(data.result) ||
      (data.ticketingDeadlineAt !== null && typeof data.ticketingDeadlineAt !== 'string') ||
      (data.lastTicketingTime !== null && typeof data.lastTicketingTime !== 'string') ||
      typeof data.updatedAt !== 'string') {
    throw new Error('The saved ticketing time could not be verified.');
  }
  return { updated: data.result === 'updated', ticketingDeadlineAt: data.ticketingDeadlineAt,
    lastTicketingTime: data.lastTicketingTime, updatedAt: data.updatedAt };
}
