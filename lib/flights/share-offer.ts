import { z } from 'zod';
import type { FlightFareOption } from '@/lib/flights/types';

const text = z.string().max(250);
export const itineraryOfferSchema = z.object({
  price: z.number().finite().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  refundable: z.boolean(),
  travellers: z.number().int().min(1).max(99),
  legs: z.array(z.object({
    from: text, to: text, fromCity: text.optional(), toCity: text.optional(), stops: z.number().int().nonnegative(),
    segments: z.array(z.object({
      from: text, to: text, fromAirport: text, toAirport: text,
      departure: text, arrival: text, airline: text, flightNumber: text,
      cabinClass: text, bookingClass: text,
      baggage: text.nullable(), handBaggage: text.nullable(),
      duration: text.nullable(),
    }).strict()).min(1).max(12),
  }).strict()).min(1).max(6),
}).strict();
export type ItineraryOffer = z.infer<typeof itineraryOfferSchema>;

export function itineraryShareOffer(option: FlightFareOption, currency: string, airportCities: Record<string, string> = {}): ItineraryOffer {
  return {
    price: option.totalPrice, currency, refundable: option.refundable,
    travellers: option.fares.reduce((total, fare) => total + fare.count, 0) || 1,
    legs: option.legs.map((leg) => ({
      from: leg.from, to: leg.to, fromCity: airportCities[leg.from] || leg.from, toCity: airportCities[leg.to] || leg.to, stops: leg.stops,
      segments: leg.segments.map(({ from, to, fromAirport, toAirport, departure, arrival, airline, flightNumber, cabinClass, bookingClass, baggage, handBaggage, duration }) => ({
        from, to, fromAirport, toAirport, departure, arrival, airline, flightNumber, cabinClass, bookingClass, baggage, handBaggage, duration,
      })),
    })),
  };
}
