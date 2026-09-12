import type { BookedItinerary } from '@/lib/flights/booking';

/**
 * The terminal portion of a supplier ticket-detail segment. These are display
 * facts only: opaque supplier references and passenger data never enter this
 * shape.
 */
export type SupplierItineraryTerminalSegment = {
  origin: string | null;
  destination: string | null;
  flightNumber: string | null;
  originTerminal: string | null;
  destinationTerminal: string | null;
};

function identity(value: string | null | undefined): string {
  return value?.trim().toUpperCase() ?? '';
}

/** `BS307`, `BS 307`, and `307` all identify flight 307 for matching. */
function flightIdentity(value: string | null | undefined): string {
  const compact = identity(value).replace(/[^A-Z0-9]/g, '');
  return compact.replace(/^[A-Z]+/, '');
}

/**
 * Adds terminal facts from the ticket report to the immutable booked itinerary.
 * A route and (when supplied) flight number must agree, so a terminal from one
 * connection can never be attached to another flight on the same ticket.
 */
export function mergeSupplierTerminals(
  itinerary: BookedItinerary | null,
  supplierSegments: readonly SupplierItineraryTerminalSegment[]
): BookedItinerary | null {
  if (!itinerary || supplierSegments.length === 0) return itinerary;

  const consumed = new Set<number>();
  let changed = false;
  const legs = itinerary.legs.map((leg) => ({
    ...leg,
    segments: leg.segments.map((segment) => {
      const segmentFlight = flightIdentity(segment.flightNumber);
      const matchedIndex = supplierSegments.findIndex((candidate, index) => {
        if (consumed.has(index)) return false;
        if (
          identity(candidate.origin) !== identity(segment.from) ||
          identity(candidate.destination) !== identity(segment.to)
        ) {
          return false;
        }

        const supplierFlight = flightIdentity(candidate.flightNumber);
        return !supplierFlight || supplierFlight === segmentFlight;
      });
      if (matchedIndex < 0) return segment;

      consumed.add(matchedIndex);
      const supplier = supplierSegments[matchedIndex];
      const departureTerminal =
        supplier.originTerminal ?? segment.departureTerminal ?? null;
      const arrivalTerminal =
        supplier.destinationTerminal ?? segment.arrivalTerminal ?? null;
      if (
        departureTerminal === (segment.departureTerminal ?? null) &&
        arrivalTerminal === (segment.arrivalTerminal ?? null)
      ) {
        return segment;
      }

      changed = true;
      return { ...segment, departureTerminal, arrivalTerminal };
    }),
  }));

  return changed ? { ...itinerary, legs } : itinerary;
}
