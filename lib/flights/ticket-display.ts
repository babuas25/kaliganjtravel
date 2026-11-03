import { airlinePnrs } from '@/lib/flights/airline-pnr';
import type { PublicBooking } from '@/lib/flights/booking';

type TicketDisplayLabel = 'Ticket number' | 'Airline PNR';
type TicketDisplayIdentifier = { label: TicketDisplayLabel; value: string; text: string };

export type BookingTicketDisplay = {
  columnLabel: TicketDisplayLabel | 'Ticket number / Airline PNR';
  passengers: Array<TicketDisplayIdentifier | null>;
  hasPassengerValues: boolean;
  showPassengerColumn: boolean;
  unavailableValue: 'Not available' | '--';
  unassignedTicketNumbers: string[];
  /** Booking-level locators have no passenger/segment assignment of their own. */
  sharedAirlinePnr: string | null;
};

/**
 * Presentation only. A known ticketless carrier's stored airline locator is
 * never promoted into a ticket number or supplier/payment verification proof.
 */
export function bookingTicketDisplay(
  booking: Pick<PublicBooking, 'status' | 'paymentState' | 'ticketNumbers' | 'airlinesPnr' | 'itinerary'>,
  passengerCount: number,
): BookingTicketDisplay {
  const count = Number.isSafeInteger(passengerCount) && passengerCount > 0 ? passengerCount : 0;
  const itinerary = booking.itinerary;
  const carrier = itinerary?.carrierCode;
  const legs = itinerary?.legs;
  const pnrCarrier = (carrier === '6E' || carrier === 'J9') &&
    Array.isArray(legs) && legs.length > 0 &&
    legs.every(leg => Array.isArray(leg?.segments) && leg.segments.length > 0 &&
      leg.segments.every(segment => segment?.airlineCode === carrier));
  const locators = airlinePnrs(booking.airlinesPnr)
    .filter(value => /^[A-Z0-9]{3,12}$/.test(value));
  const eligibleAirlinePnr = pnrCarrier && booking.status === 'confirmed' && booking.paymentState === 'captured';
  const fallback = eligibleAirlinePnr ? locators.join(', ') || null : null;
  const tickets = Array.isArray(booking.ticketNumbers)
    ? booking.ticketNumbers.map(value => typeof value === 'string' ? value.trim() : '') : [];
  const isPnr = (value: string) => pnrCarrier && !/^[0-9]{10,16}$/.test(value) && locators.includes(value);
  const aligns = count > 0 && tickets.length === count && tickets.every(value => value.length > 0);
  const unassignedTicketNumbers = aligns ? [] : tickets.filter(value => value && !isPnr(value));
  let usedSharedPnr = false;
  const passengers = Array.from({ length: count }, (_, index): TicketDisplayIdentifier | null => {
    const saved = aligns ? tickets[index] : '';
    if (saved) return { label: isPnr(saved) ? 'Airline PNR' : 'Ticket number', value: saved, text: saved };
    if (!fallback) return null;
    usedSharedPnr = true;
    return { label: 'Airline PNR', value: fallback, text: fallback };
  });
  const labels = new Set(passengers.flatMap(value => value ? [value.label] : []));
  const columnLabel = labels.size > 1 ? 'Ticket number / Airline PNR'
    : labels.has('Airline PNR') || (labels.size === 0 && eligibleAirlinePnr) ? 'Airline PNR' : 'Ticket number';
  if (labels.size > 1) {
    for (const identifier of passengers) {
      if (identifier?.label === 'Airline PNR') identifier.text = `Airline PNR: ${identifier.value}`;
    }
  }
  return {
    columnLabel, passengers, unassignedTicketNumbers,
    hasPassengerValues: passengers.some(value => value !== null),
    showPassengerColumn: passengers.some(value => value !== null) || Boolean(eligibleAirlinePnr),
    unavailableValue: eligibleAirlinePnr ? 'Not available' : '--',
    sharedAirlinePnr: usedSharedPnr && count > 1 ? fallback : null,
  };
}
