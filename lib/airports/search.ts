// Server-side airport search over the airports.json dataset in the project
// root. Kept off the client on purpose: the file is ~1.8 MB, so it is read here
// and exposed through /api/airports instead of being bundled into the page.

import airportsRaw from '@/airports.json';

import {
  getAirportsForCity,
  getCityCodesForQuery,
  getCityInfo,
  isMultiAirportCity,
} from './city-airport-mapping';
import { POPULAR_BANGLADESH_AIRPORTS, POPULAR_INTERNATIONAL_IATAS } from './popular';
import type { AirportOption } from './types';

type AirportRecord = {
  iata: string;
  name: string;
  city?: string;
  country?: string;
  iso: string;
  continent?: string;
  type?: string;
  status: number;
  lat?: number | string;
  lon?: number | string;
  size?: string | null;
};

/** Rows returned for an empty query, before the visitor types. */
const DEFAULT_RESULT_COUNT = 15;

function normalize(value: string) {
  return value.trim().toLowerCase();
}

function startsWithNormalized(haystack: string, needle: string) {
  const h = normalize(haystack);
  const n = normalize(needle);
  if (!n) return true;
  return h.startsWith(n);
}

function includesWordStart(haystack: string, needle: string) {
  const h = normalize(haystack);
  const n = normalize(needle);
  if (!n) return true;
  return h
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((w) => w.startsWith(n));
}

/** Fallback when a record has no city: the words before "… Airport". */
function extractCityFromName(name: string): string {
  const airportKeywords = [
    'International Airport',
    'Airport',
    'International',
    'Regional',
    'Municipal',
    'Airfield',
    'Heliport',
    'Station',
  ];

  for (const keyword of airportKeywords) {
    const idx = name.indexOf(keyword);
    if (idx !== -1) {
      const extracted = name.substring(0, idx).trim();
      const words = extracted.split(/\s+/);
      const firstWord = words[0];
      if (words.length > 0 && firstWord && firstWord.length > 2) {
        return firstWord;
      }
    }
  }

  const words = name.split(/\s+/);
  const firstWord = words[0];
  if (firstWord && firstWord.length > 2) {
    return firstWord;
  }

  return name;
}

/** Fallback when a record has no country name — covers the common markets. */
function getCountryName(iso: string): string {
  const countryMap: Record<string, string> = {
    US: 'United States',
    GB: 'United Kingdom',
    FR: 'France',
    DE: 'Germany',
    IT: 'Italy',
    ES: 'Spain',
    JP: 'Japan',
    CN: 'China',
    IN: 'India',
    BD: 'Bangladesh',
    NP: 'Nepal',
    LK: 'Sri Lanka',
    PK: 'Pakistan',
    AE: 'United Arab Emirates',
    TH: 'Thailand',
    SG: 'Singapore',
    HK: 'Hong Kong',
    TR: 'Turkey',
    RU: 'Russia',
  };

  return countryMap[iso] || iso;
}

const airportRecords: AirportRecord[] = Array.isArray(airportsRaw)
  ? (airportsRaw as AirportRecord[])
  : ((airportsRaw as { default?: AirportRecord[] }).default ?? []);

/**
 * The searchable table, built once per server process: only live records with a
 * three-letter IATA code, normalised into the shape the dropdown renders.
 */
const allAirports: AirportOption[] = airportRecords
  .filter(
    (a) => typeof a.iata === 'string' && a.iata.trim().length === 3 && a.status === 1 && a.name
  )
  .map((a, index) => {
    const cityInfo = getCityInfo(a.iata);
    const option: AirportOption = {
      id: `${a.iata}-${index}`,
      name: a.name || '',
      city: cityInfo?.city || a.city || extractCityFromName(a.name || ''),
      country: cityInfo?.country || a.country || getCountryName(a.iso),
      iata: a.iata.trim().toUpperCase(),
    };
    if (cityInfo?.cityCode) option.cityCode = cityInfo.cityCode;
    return option;
  });

const iataToAirport = new Map(allAirports.map((a) => [a.iata, a]));

/**
 * Cities with 2+ airports that city-airport-groups.json does not list get a
 * synthetic group, so "all airports in this city" works beyond the curated set.
 * Computed once — it depends only on the dataset, never on the query.
 */
const autoGroups = new Map<string, string[]>();
{
  const byCityCountry = new Map<string, AirportOption[]>();
  allAirports.forEach((a) => {
    const key = `${normalize(a.city)}|${normalize(a.country)}`;
    if (!byCityCountry.has(key)) byCityCountry.set(key, []);
    byCityCountry.get(key)!.push(a);
  });

  byCityCountry.forEach((list) => {
    if (list.length < 2) return;
    const first = list[0];
    if (!first) return;
    // A curated group already covers this city — leave it alone.
    if (list.some((a) => a.cityCode)) return;
    const syntheticCode = `AUTO_${first.city}_${first.country}`.replace(/\s+/g, '_');
    list.forEach((a) => {
      a.cityCode = syntheticCode;
    });
    autoGroups.set(
      syntheticCode,
      list.map((a) => a.iata)
    );
  });
}

/** How well one airport answers the query; 0 drops it from the results. */
function getRelevanceScore(airport: AirportOption, query: string): number {
  const q = normalize(query);
  let score = 0;

  // Ambiguous three-letter city codes: pin them to the city people mean.
  if (q === 'lon') {
    if (normalize(airport.city) === 'london' && normalize(airport.country) === 'united kingdom') {
      return normalize(airport.iata) === q ? 1000 : 800;
    }
    return 0;
  }

  if (q === 'new') {
    if (normalize(airport.city) === 'new york' && normalize(airport.country) === 'united states') {
      return 800;
    }
    return 0;
  }

  if (q === 'par') {
    if (normalize(airport.city) === 'paris' && normalize(airport.country) === 'france') {
      return 800;
    }
    return 0;
  }

  // Three letters typed: an exact IATA hit ("SIN", "CAN") must lead.
  if (q.length === 3) {
    if (normalize(airport.iata) === q) return 3000;
    if (startsWithNormalized(airport.city, q)) return 500;
    if (startsWithNormalized(airport.name, q)) return 300;
    return 0;
  }

  // One or two letters: an IATA prefix ("si" -> SIN) beats a city/name match.
  if (q.length <= 2) {
    if (startsWithNormalized(airport.iata, q)) return 2500;
  }

  if (normalize(airport.iata) === q) score += 2000;
  if (startsWithNormalized(airport.iata, q)) score += 1500;
  if (startsWithNormalized(airport.city, q)) score += 500;
  if (startsWithNormalized(airport.name, q)) score += 300;
  if (startsWithNormalized(airport.country, q)) score += 100;
  if (includesWordStart(airport.city, q)) score += 50;
  if (includesWordStart(airport.name, q)) score += 25;
  if (includesWordStart(airport.country, q)) score += 10;

  return score;
}

/** The pre-typing list: the Bangladesh shortlist, padded with long-haul hubs. */
function getDefaultOptions(limit: number): AirportOption[] {
  const results: AirportOption[] = POPULAR_BANGLADESH_AIRPORTS.map((airport, index) => ({
    id: `popular-${airport.iata}-${index}`,
    name: airport.name,
    city: airport.city,
    country: airport.country,
    iata: airport.iata,
    isPopular: true,
  }));

  const seen = new Set(results.map((a) => a.iata));
  for (const iata of POPULAR_INTERNATIONAL_IATAS) {
    if (results.length >= Math.min(limit, DEFAULT_RESULT_COUNT)) break;
    const airport = iataToAirport.get(iata);
    if (!airport || seen.has(iata)) continue;
    seen.add(iata);
    results.push(airport);
  }

  return results.slice(0, limit);
}

/**
 * Rank the dataset against `query` and lay the results out as city groups —
 * an "All Airports" row followed by the airports that belong to it — with
 * standalone airports after them.
 */
export function searchAirports(query: string, limit = 80): AirportOption[] {
  const q = normalize(query);
  if (!q) return getDefaultOptions(limit);

  const scoredAirports = allAirports
    .map((airport) => ({ airport, score: getRelevanceScore(airport, q) }))
    .filter(({ score }) => score > 0);

  // Short queries match far too much; keep only the confident hits.
  let filteredAirports = scoredAirports;
  if (q.length <= 3) {
    const minScore = q === 'lon' ? 500 : 100;
    filteredAirports = scoredAirports.filter(({ score }) => score >= minScore);
  }

  const sortedScored = filteredAirports.sort((a, b) => b.score - a.score);

  const cityGroups = new Map<string, { airport: AirportOption; score: number }[]>();
  const singles: { airport: AirportOption; score: number }[] = [];

  sortedScored.forEach(({ airport, score }) => {
    const code = airport.cityCode;
    const isGroup = code && (isMultiAirportCity(code) || autoGroups.has(code));
    if (isGroup) {
      if (!cityGroups.has(code)) cityGroups.set(code, []);
      cityGroups.get(code)!.push({ airport, score });
    } else {
      singles.push({ airport, score });
    }
  });

  // A query naming a city ("london", "lon") should open that city's group even
  // when no individual airport in it scored.
  getCityCodesForQuery(q).forEach((cityCode) => {
    if (isMultiAirportCity(cityCode) && !cityGroups.has(cityCode)) {
      cityGroups.set(cityCode, []);
    }
  });

  // Fill each group from the full city roster, so every airport of a matched
  // city is listed even if only one of them scored.
  const scoreByIata = new Map(sortedScored.map(({ airport, score }) => [airport.iata, score]));
  cityGroups.forEach((list, cityCode) => {
    const allIatasForCity = cityCode.startsWith('AUTO_')
      ? (autoGroups.get(cityCode) ?? [])
      : getAirportsForCity(cityCode);
    const fullList: { airport: AirportOption; score: number }[] = [];
    const seen = new Set<string>();
    allIatasForCity.forEach((iata) => {
      const airport = iataToAirport.get(iata);
      if (airport && !seen.has(iata)) {
        seen.add(iata);
        fullList.push({ airport, score: scoreByIata.get(iata) ?? 0 });
      }
    });
    list.length = 0;
    list.push(...fullList.sort((a, b) => b.score - a.score));
  });

  const results: AirportOption[] = [];
  const groupCodesByScore = Array.from(cityGroups.entries())
    .filter(([, list]) => list.length > 0)
    .map(([code, list]) => ({ code, maxScore: Math.max(...list.map((x) => x.score)) }))
    .sort((a, b) => b.maxScore - a.maxScore)
    .map((x) => x.code);

  groupCodesByScore.forEach((cityCode) => {
    const list = cityGroups.get(cityCode)!.sort((a, b) => b.score - a.score);
    const first = list[0]?.airport;
    if (!first) return;
    // Curated groups carry a real metro code (LON); synthetic ones borrow the
    // best-scoring airport's code, since no metro code exists.
    const displayCode = cityCode.startsWith('AUTO_') ? first.iata : cityCode.replace(/_CITY$/, '');
    results.push({
      id: `city-group-${cityCode}`,
      name: 'All Airports',
      city: first.city,
      country: first.country,
      iata: displayCode,
      isCity: true,
      cityCode,
    });
    list.forEach(({ airport }) => results.push(airport));
  });

  singles.sort((a, b) => b.score - a.score).forEach(({ airport }) => results.push(airport));
  return results.slice(0, limit);
}
