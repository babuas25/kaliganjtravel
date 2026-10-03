import { airlinePnrs } from '@/lib/flights/airline-pnr';
import type { PublicBooking } from '@/lib/flights/booking';

/** Keep the airline locator distinct from the supplier's reservation/GDS PNR. */
export function ticketPrintReferences(
  booking: Pick<PublicBooking, 'airlinesPnr' | 'pnr'>
) {
  const airlinePnr = airlinePnrs(booking.airlinesPnr).join(', ') || 'Not available';
  return {
    airlinePnr,
    reservationPnr: booking.pnr?.trim() || airlinePnr,
  };
}
