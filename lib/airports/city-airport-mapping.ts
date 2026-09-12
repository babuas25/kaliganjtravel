// City-to-airport grouping is data-driven from city-airport-groups.json.
// Add or edit entries there to support more cities (see
// https://en.wikipedia.org/wiki/List_of_cities_with_more_than_one_commercial_airport).
// cityCode (e.g. LON, NYC) is what a search would send when the visitor picks
// "All Airports" rather than a single airport.

import cityGroupsData from './city-airport-groups.json';

export interface CityInfo {
  city: string;
  country: string;
  countryCode: string;
  cityCode?: string;
}

export interface CityGroupRecord {
  city: string;
  country: string;
  countryCode: string;
  airports: string[];
}

const cityGroups = cityGroupsData as Record<string, CityGroupRecord>;

// Build IATA -> CityInfo from the groups, so getCityInfo(iata) works.
const cityAirportMapping: Record<string, CityInfo> = {};
Object.entries(cityGroups).forEach(([cityCode, record]) => {
  const info: CityInfo = {
    city: record.city,
    country: record.country,
    countryCode: record.countryCode,
    cityCode,
  };
  record.airports.forEach((iata) => {
    cityAirportMapping[iata.toUpperCase()] = info;
  });
});

export function getCityInfo(iata: string): CityInfo | null {
  return cityAirportMapping[iata.toUpperCase()] ?? null;
}

export function getAirportsForCity(cityCode: string): string[] {
  const group = cityGroups[cityCode];
  return group ? group.airports : [];
}

export function isMultiAirportCity(cityCode: string): boolean {
  return getAirportsForCity(cityCode).length > 1;
}

/** City codes whose name or code matches the query ("london" or "lon" -> ["LON"]). */
export function getCityCodesForQuery(normalizedQuery: string): string[] {
  const q = normalizedQuery.trim().toLowerCase();
  if (!q) return [];
  const codes = new Set<string>();
  Object.entries(cityGroups).forEach(([cityCode, record]) => {
    const cityNorm = record.city.toLowerCase();
    const codeNorm = cityCode.replace(/_CITY$/, '').toLowerCase();
    if (
      cityNorm === q ||
      cityNorm.startsWith(q) ||
      q.startsWith(cityNorm) ||
      codeNorm === q ||
      q.startsWith(codeNorm)
    ) {
      codes.add(cityCode);
    }
  });
  return Array.from(codes);
}
