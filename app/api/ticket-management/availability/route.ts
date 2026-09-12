import { NextRequest } from 'next/server';

import { bookingScopeFor } from '@/lib/dashboard/bookings';
import { getDashboardSession } from '@/lib/dashboard/session';
import { readBookingByPublicRef } from '@/lib/db/flight-bookings';
import { listTicketManagementPassengerAvailability } from '@/lib/db/ticket-management';
import { ticketManagementFail, ticketManagementOk } from '@/lib/ticket-management/http';
import { canViewTicketManagementRequest } from '@/lib/ticket-management/permissions';
import { ticketManagementRolloutEnabled } from '@/lib/ticket-management/rollout';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getDashboardSession();
  if (!session) {
    return ticketManagementFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
  }
  if (!ticketManagementRolloutEnabled()) {
    return ticketManagementFail(
      503,
      'TICKET_MANAGEMENT_DISABLED',
      'Ticket Management is not enabled.'
    );
  }
  if (!canViewTicketManagementRequest(session.role)) {
    return ticketManagementFail(
      403,
      'TICKET_MANAGEMENT_READ_FORBIDDEN',
      'Ticket Management access is required.'
    );
  }
  const bookingReference = request.nextUrl.searchParams.get('bookingReference');
  if (!bookingReference || !/^(?:STR\d{12}|KTT[A-Z0-9]{1,100})$/.test(bookingReference)) {
    return ticketManagementFail(
      400,
      'INVALID_BOOKING_REFERENCE',
      'Check the booking reference.'
    );
  }

  try {
    const booking = await readBookingByPublicRef(
      bookingReference,
      bookingScopeFor(session)
    );
    if (!booking) {
      return ticketManagementFail(404, 'BOOKING_NOT_FOUND', 'Booking not found.');
    }
    const passengers = await listTicketManagementPassengerAvailability(booking.id);
    return ticketManagementOk({ passengers });
  } catch (error) {
    console.error('[ticket-management] availability failed:', error);
    return ticketManagementFail(
      503,
      'TICKET_MANAGEMENT_READ_UNAVAILABLE',
      'Ticket availability is temporarily unavailable.'
    );
  }
}
