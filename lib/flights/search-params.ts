/**
 * The search as a URL, so a results page can be refreshed, shared or opened in
 * a new tab and still mean the same thing.
 *
 * Client-safe: pure string work. Everything here is *untrusted* on the way back
 * in — the URL is user-editable, so `decodeSearchParams` only shapes the input
 * and the real validation stays in the route handler's schema.
 */

import { isCabinClassValue, type CabinClassValue } from '@/lib/flights/cabin';
import type { FlightSearchInput, SearchRoute, TripType } from '@/lib/flights/types';

const LEG_SEPARATOR = ',';
const FIELD_SEPARATOR = ':';

function encodeLeg(route: SearchRoute): string {
  return [route.origin, route.destination, route.departureDate].join(FIELD_SEPARATOR);
}

export function encodeSearchParams(input: FlightSearchInput): string {
  const params = new URLSearchParams({
    trip: input.tripType,
    legs: input.routes.map(encodeLeg).join(LEG_SEPARATOR),
    adults: String(input.adults),
    children: String(input.children),
    infants: String(input.infants),
    cabin: String(input.cabinClass),
  });

  if (input.childrenAges.length > 0) {
    params.set('ages', input.childrenAges.join(LEG_SEPARATOR));
  }
  if (input.preferredCarriers.length > 0) {
    params.set('airlines', input.preferredCarriers.join(LEG_SEPARATOR));
  }

  return params.toString();
}

function readOne(params: Record<string, string | string[] | undefined>, key: string): string {
  const value = params[key];
  return (Array.isArray(value) ? value[0] : value) ?? '';
}

function readInt(
  params: Record<string, string | string[] | undefined>,
  key: string,
  fallback: number
): number {
  const parsed = Number.parseInt(readOne(params, key), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const TRIP_TYPES: TripType[] = ['oneway', 'round', 'multicity'];

/**
 * Reads a search back out of the URL. Returns null when there is nothing
 * usable — an empty results page is the right answer for a bare `/flights`.
 */
export function decodeSearchParams(
  params: Record<string, string | string[] | undefined>
): FlightSearchInput | null {
  const legs = readOne(params, 'legs');
  if (!legs) return null;
  const fareType = readOne(params, 'fareType');
  if (fareType && fareType !== 'regular') return null;

  const routes: SearchRoute[] = legs
    .split(LEG_SEPARATOR)
    .map((leg) => leg.split(FIELD_SEPARATOR))
    .flatMap(([origin, destination, departureDate]) =>
      origin && destination && departureDate
        ? [
            {
              origin: origin.toUpperCase(),
              destination: destination.toUpperCase(),
              departureDate,
            },
          ]
        : []
    );

  if (routes.length === 0) return null;

  const rawTrip = readOne(params, 'trip');
  const tripType = TRIP_TYPES.includes(rawTrip as TripType)
    ? (rawTrip as TripType)
    : routes.length > 1
      ? 'round'
      : 'oneway';

  const cabin = readInt(params, 'cabin', 1);
  const cabinClass: CabinClassValue = isCabinClassValue(cabin) ? cabin : 1;

  const ages = readOne(params, 'ages');
  const airlines = readOne(params, 'airlines');

  return {
    tripType,
    routes,
    adults: readInt(params, 'adults', 1),
    children: readInt(params, 'children', 0),
    infants: readInt(params, 'infants', 0),
    childrenAges: ages
      ? ages
          .split(LEG_SEPARATOR)
          .map((age) => Number.parseInt(age, 10))
          .filter((age) => Number.isFinite(age))
      : [],
    cabinClass,
    preferredCarriers: airlines
      ? airlines
          .split(LEG_SEPARATOR)
          .map((code) => code.trim().toUpperCase())
          .filter(Boolean)
      : [],
  };
}
