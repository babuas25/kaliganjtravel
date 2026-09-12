// Which country an airport sits in, read from the same airports.json dataset
// the search endpoint uses. Server-only for the same reason: the file is ~1.8 MB
// and must never reach the browser bundle.

import 'server-only';

import airportsRaw from '@/airports.json';
import type { BookedItinerary } from '@/lib/flights/booking';

type AirportCountryRecord = {
  iata?: unknown;
  /** ISO-3166 alpha-2, e.g. "BD". */
  iso?: unknown;
};

let countryByIata: Map<string, string> | null = null;

/** Built once, lazily — most requests never ask a country question. */
function index(): Map<string, string> {
  if (countryByIata) return countryByIata;

  const map = new Map<string, string>();
  (airportsRaw as AirportCountryRecord[]).forEach((airport) => {
    const iata = typeof airport.iata === 'string' ? airport.iata.trim() : '';
    const iso = typeof airport.iso === 'string' ? airport.iso.trim() : '';
    if (iata.length === 3 && iso.length === 2) {
      map.set(iata.toUpperCase(), iso.toUpperCase());
    }
  });
  countryByIata = map;
  return map;
}

/** ISO-2 country for an IATA code, or null when the code is unknown. */
export function countryOfAirport(iata: string): string | null {
  return index().get(iata.trim().toUpperCase()) ?? null;
}

/**
 * Does this itinerary need passport details?
 *
 * Only a trip that stays inside one country is exempt. Anything we cannot
 * resolve — an unknown airport code, an empty itinerary — asks for the
 * passport, because a missing document fails the booking outright while an
 * unnecessary one merely annoys.
 */
export function passportRequiredFor(codes: readonly string[]): boolean {
  if (codes.length === 0) return true;

  let country: string | null = null;
  for (const code of codes) {
    const resolved = countryOfAirport(code);
    if (!resolved) return true;
    if (country === null) {
      country = resolved;
    } else if (country !== resolved) {
      return true;
    }
  }
  return false;
}

/**
 * Apply the airport-country rule to every stop in a normalized itinerary.
 *
 * Segment airports are authoritative because a connection abroad makes the
 * whole trip international. Leg endpoints are retained as a safe fallback for
 * older snapshots that do not contain segment rows.
 */
export function passportRequiredForItinerary(
  itinerary: Pick<BookedItinerary, 'legs'>
): boolean {
  const segmentCodes = itinerary.legs.flatMap((leg) =>
    leg.segments.flatMap((segment) => [segment.from, segment.to])
  );
  const legCodes = itinerary.legs.flatMap((leg) => [leg.from, leg.to]);
  return passportRequiredFor(segmentCodes.length > 0 ? segmentCodes : legCodes);
}
