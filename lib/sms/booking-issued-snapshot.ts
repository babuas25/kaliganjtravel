import 'server-only';

import { airlinePnrs as validAirlinePnrs } from '@/lib/flights/airline-pnr';

import type { BookingRow } from '@/lib/db/flight-bookings';

function leadPassengerName(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const travellers = (value as { travellers?: unknown }).travellers;
  if (!Array.isArray(travellers)) return '';
  const lead = travellers[0];
  if (!lead || typeof lead !== 'object' || Array.isArray(lead)) return '';
  const row = lead as { firstName?: unknown; lastName?: unknown };
  return [row.firstName, row.lastName]
    .filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
    .map((part) => part.trim())
    .join(' ');
}

/** Current confirmed-booking values used by the manual SMS preview and send. */
export function bookingIssuedSmsSnapshotFromBooking(
  booking: BookingRow
): Record<string, unknown> {
  const locators = validAirlinePnrs(booking.airlines_pnr);
  const unverified = booking.shapon_unverified_airline_pnr?.trim().toUpperCase();
  const pnr = locators.length === 1 && locators[0].toUpperCase() === unverified ? null : locators[0];
  return {
    version: 1,
    bookingReference: booking.public_ref,
    pnr: pnr || 'Not available',
    pnrType: 'airline',
    passengerName: leadPassengerName(booking.passengers),
    airlineCode: booking.itinerary?.carrierCode ?? '',
    airlineName: booking.itinerary?.carrierName ?? '',
    itinerary: booking.itinerary,
    currency: booking.currency,
    grossAmount: booking.pricing_snapshot.grossPrice,
  };
}
