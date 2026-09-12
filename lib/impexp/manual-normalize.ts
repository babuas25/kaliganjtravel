import { passportRequiredForItinerary } from "@/lib/airports/country";
import type { BookedItinerary, BookingPassengerType } from "@/lib/flights/booking";
import type { FareBreakdown, ItineraryLeg, ItinerarySegment } from "@/lib/flights/types";
import type { ManualBookingImportInput } from "@/lib/impexp/manual-validation";

function localDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:00`;
}

function itineraryFrom(input: ManualBookingImportInput): BookedItinerary {
  const grouped = new Map<number, typeof input.segments>();
  for (const segment of input.segments) {
    const current = grouped.get(segment.leg) ?? [];
    current.push(segment);
    grouped.set(segment.leg, current);
  }
  const legs: ItineraryLeg[] = Array.from(grouped.entries())
    .sort(([a], [b]) => a - b)
    .map(([, legSegments]) => {
      const ordered = [...legSegments].sort((a, b) =>
        a.departureAt.localeCompare(b.departureAt),
      );
      const segments: ItinerarySegment[] = ordered.map((segment) => ({
        from: segment.from.code,
        fromAirport: segment.from.airport || segment.from.city,
        departureTerminal: segment.from.terminal || null,
        to: segment.to.code,
        toAirport: segment.to.airport || segment.to.city,
        arrivalTerminal: segment.to.terminal || null,
        departure: localDateTime(segment.departureAt),
        arrival: localDateTime(segment.arrivalAt),
        airline: segment.carrierName,
        airlineCode: segment.carrierCode,
        flightNumber: segment.flightNumber,
        cabinClass: segment.cabin,
        bookingClass: segment.bookingClass,
        duration: segment.duration,
        aircraft: segment.aircraft,
        baggage: segment.baggage,
        handBaggage: segment.handBaggage,
        seatsLeft: null,
      }));
      return {
        from: segments[0]!.from,
        to: segments[segments.length - 1]!.to,
        stops: Math.max(0, segments.length - 1),
        segments,
        duration: null,
        departure: segments[0]!.departure,
        arrival: segments[segments.length - 1]!.arrival,
      };
    });
  const lead = legs[0]!.segments[0]!;
  return {
    carrierCode: lead.airlineCode,
    carrierName: lead.airline,
    refundable: input.refundable,
    legs,
  };
}

function passengerCounts(input: ManualBookingImportInput) {
  return input.passengers.travellers.reduce<
    Partial<Record<BookingPassengerType, number>>
  >((counts, traveller) => {
    counts[traveller.passengerType] = (counts[traveller.passengerType] ?? 0) + 1;
    return counts;
  }, {});
}

function faresFrom(input: ManualBookingImportInput): FareBreakdown[] {
  return input.fares.map((fare) => ({
    passengerType: fare.passengerType,
    count: 1,
    basePrice: Number(fare.basePrice),
    taxes: Number(fare.taxes),
    ait: Number(fare.ait),
    serviceMargin: Number(fare.serviceMargin),
    totalPrice: Number(fare.totalPrice),
  }));
}

/** Produces the same normalized booking document used by existing pages. */
export function normalizeManualBooking(input: ManualBookingImportInput) {
  const confirmed = input.initialStatus === "confirmed";
  const itinerary = itineraryFrom(input);
  return {
    provider: "MANUAL",
    supplierReference: input.externalReference,
    originalReference: input.externalReference,
    orderStatus: confirmed ? "Manual Confirmed" : "Manual On Hold",
    lifecycleStatus: input.initialStatus,
    storedStatus: input.initialStatus,
    currency: input.currency.toUpperCase(),
    totalPrice: Number(input.supplierPayableAmount),
    supplierPayableAmount: Number(input.supplierPayableAmount),
    passengerCounts: passengerCounts(input),
    travelDate: input.travelDate,
    itinerary,
    fares: faresFrom(input),
    passengers: input.passengers,
    // The airport API data behind route entry is the source of truth. Passenger
    // documents and a stale/manual checkbox must not change a domestic route
    // into an international one.
    passportRequired: passportRequiredForItinerary(itinerary),
    pnr: input.pnr,
    airlinesPnr: [input.airlinePnr],
    ticketNumbers: confirmed ? input.ticketing!.ticketNumbers : [],
    ticketingTimeLimit: null,
    ticketingDeadlineAt: input.ticketingDeadlineAt ?? null,
    issuedAt: confirmed ? input.ticketing!.issuedAt : null,
    importedAt: new Date().toISOString(),
    supplierMessage: input.supplierMessage || null,
    initialStatus: input.initialStatus,
  };
}
