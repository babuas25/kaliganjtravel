import type {
  FlightFareOption,
  FlightItinerary,
  StandaloneFlightItinerary,
} from '@/lib/flights/types';

/**
 * Fare attributes such as RBD, baggage and refundability deliberately do not
 * belong in this key: differences in those fields are exactly what makes an
 * offer an upsell for the same physical flights.
 */
function scheduleKey(itinerary: StandaloneFlightItinerary): string {
  return JSON.stringify([
    itinerary.carrierCode,
    itinerary.legs.map((leg) =>
      leg.segments.map((segment) => [
        segment.airlineCode,
        segment.flightNumber,
        segment.from,
        segment.to,
        segment.departure,
        segment.arrival,
      ])
    ),
  ]);
}

function fareOption(
  itinerary: StandaloneFlightItinerary
): FlightFareOption {
  return {
    id: itinerary.id,
    auditPricing: itinerary.auditPricing,
    agencyPricing: itinerary.agencyPricing,
    totalPrice: itinerary.totalPrice,
    basePrice: itinerary.basePrice,
    taxes: itinerary.taxes,
    ait: itinerary.ait,
    serviceMargin: itinerary.serviceMargin,
    carrierCode: itinerary.carrierCode,
    carrierName: itinerary.carrierName,
    refundable: itinerary.refundable,
    bookable: itinerary.bookable,
    legs: itinerary.legs,
    fares: itinerary.fares,
    ambiguousSelection: itinerary.ambiguousSelection,
  };
}

/**
 * Collapses duplicate schedule cards into one lowest-fare card plus upsells.
 *
 * No supplier option is discarded: every nested option retains the itinerary
 * id that maps to its own opaque item/segment references in the server cache.
 */
export function groupUpsellOptions(
  itineraries: readonly StandaloneFlightItinerary[]
): FlightItinerary[] {
  const groups = new Map<string, StandaloneFlightItinerary[]>();

  itineraries.forEach((itinerary) => {
    const key = scheduleKey(itinerary);
    const group = groups.get(key);
    if (group) {
      group.push(itinerary);
    } else {
      groups.set(key, [itinerary]);
    }
  });

  const grouped: FlightItinerary[] = [];
  groups.forEach((options) => {
    const sorted = options
      .slice()
      .sort((a, b) => a.totalPrice - b.totalPrice);
    const primary = sorted[0];
    if (!primary) return;

    grouped.push({
      ...primary,
      upsellOptions: sorted.slice(1).map(fareOption),
    });
  });

  return grouped.sort((a, b) => a.totalPrice - b.totalPrice);
}
