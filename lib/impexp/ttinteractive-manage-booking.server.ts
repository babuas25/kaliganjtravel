import "server-only";

import { resolveChromiumLaunchConfig } from "@/lib/impexp/chrome.server";
import type {
  OrderCreateApiResponse,
  OrderCreateResponse,
} from "@/lib/impexp/order-types";

import type { Browser } from "playwright-core";

const DEFAULT_US_BANGLA_FIND_BOOKING_URL =
  process.env.US_BANGLA_FIND_BOOKING_URL?.trim() ||
  "https://fo-usba.ttinteractive.com/Zenith/FrontOffice/usbangla/Home/FindBooking";
const DEFAULT_AIR_ASTRA_FIND_BOOKING_URL =
  process.env.AIR_ASTRA_FIND_BOOKING_URL?.trim() ||
  "https://fo-airastra.ttinteractive.com/Zenith/FrontOffice/airastra/Home/FindBooking";

type TtinteractiveSupplierProvider = "US_BANGLA" | "AIR_ASTRA";

interface TtinteractiveAirlineConfig {
  provider: TtinteractiveSupplierProvider;
  displayName: string;
  sourceName: string;
  defaultFindBookingUrl: string;
  defaultCarrierCode: string;
  carrierName: string;
  defaultFareType: string;
  defaultEquipment: string;
}

const US_BANGLA_CONFIG: TtinteractiveAirlineConfig = {
  provider: "US_BANGLA",
  displayName: "US-Bangla",
  sourceName: "US-Bangla Manage Booking",
  defaultFindBookingUrl: DEFAULT_US_BANGLA_FIND_BOOKING_URL,
  defaultCarrierCode: "BS",
  carrierName: "US-Bangla",
  defaultFareType: "US-Bangla Manage Booking",
  defaultEquipment: "ATR 72 - 600",
};

const AIR_ASTRA_CONFIG: TtinteractiveAirlineConfig = {
  provider: "AIR_ASTRA",
  displayName: "AirAstra",
  sourceName: "AirAstra Manage Booking",
  defaultFindBookingUrl: DEFAULT_AIR_ASTRA_FIND_BOOKING_URL,
  defaultCarrierCode: "2A",
  carrierName: "Air Astra",
  defaultFareType: "AirAstra Manage Booking",
  defaultEquipment: "",
};

const TTINTERACTIVE_BROWSER_ATTEMPTS = 2;
const TTINTERACTIVE_BROWSER_RETRY_DELAY_MS = 1500;
const CHROMIUM_STABILITY_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-blink-features=AutomationControlled",
  "--disable-infobars",
  "--lang=en-GB,en",
  "--window-size=1365,900",
];

const MONTHS: Record<string, string> = {
  jan: "01",
  january: "01",
  feb: "02",
  february: "02",
  mar: "03",
  march: "03",
  apr: "04",
  april: "04",
  may: "05",
  jun: "06",
  june: "06",
  jul: "07",
  july: "07",
  aug: "08",
  august: "08",
  sep: "09",
  sept: "09",
  september: "09",
  oct: "10",
  october: "10",
  nov: "11",
  november: "11",
  dec: "12",
  december: "12",
};

const CITY_AIRPORT_CODES: Record<string, string> = {
  barishal: "BZL",
  barisal: "BZL",
  chattogram: "CGP",
  chittagong: "CGP",
  "cox's bazar": "CXB",
  coxsbazar: "CXB",
  coxbazar: "CXB",
  bangkok: "BKK",
  chennai: "MAA",
  dhaka: "DAC",
  doha: "DOH",
  dubai: "DXB",
  guangzhou: "CAN",
  jashore: "JSR",
  jessore: "JSR",
  jeddah: "JED",
  kolkata: "CCU",
  "kuala lumpur": "KUL",
  kualalumpur: "KUL",
  male: "MLE",
  madinah: "MED",
  medina: "MED",
  muscat: "MCT",
  rajshahi: "RJH",
  riyadh: "RUH",
  saidpur: "SPD",
  sharjah: "SHJ",
  singapore: "SIN",
  sylhet: "ZYL",
};

function buildChromiumArgs(args: string[] = []): string[] {
  return Array.from(new Set([...args, ...CHROMIUM_STABILITY_ARGS]));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBrowserClosedNavigationError(error: unknown): boolean {
  return /Target page, context or browser has been closed|Browser has been closed|Target closed/i.test(
    getErrorMessage(error),
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface ScrapedPassenger {
  title: string;
  givenName: string;
  surname: string;
  gender: string;
  fare: number;
  tax: number;
  total: number;
  ticketNumber?: string;
}

interface ScrapedFlightSegment {
  direction: "outbound" | "inbound" | "unknown";
  departureCity: string;
  departureCode: string;
  arrivalCity: string;
  arrivalCode: string;
  departureTime: string;
  arrivalTime: string;
  departureTerminal?: string;
  flightCarrier: string;
  flightNumber: string;
  equipment: string;
  fareBrand: string;
  rbd: string;
  baggageAllowance?: string;
  fare: number;
  tax: number;
  total: number;
  refundRules: string[];
  exchangeRules: string[];
}

interface ScrapedFareRuleSection {
  departureCity: string;
  departureCode: string;
  arrivalCity: string;
  arrivalCode: string;
  flightCarrier: string;
  flightNumber: string;
  equipment: string;
  fareBrand: string;
  rbd: string;
  baggageAllowance?: string;
  total: number;
  refundRules: string[];
  exchangeRules: string[];
}

interface ScrapedUsBanglaBooking {
  reference: string;
  status: string;
  segments: ScrapedFlightSegment[];
  departureCity: string;
  departureCode: string;
  arrivalCity: string;
  arrivalCode: string;
  departureTime: string;
  arrivalTime: string;
  departureTerminal?: string;
  flightCarrier: string;
  flightNumber: string;
  equipment: string;
  tripType: string;
  passengerSummary: string;
  passengers: ScrapedPassenger[];
  totalAmount: number;
  fareTotal: number;
  taxTotal: number;
  fareBrand: string;
  rbd: string;
  baggageAllowance?: string;
  refundRules: string[];
  exchangeRules: string[];
  finalUrl: string;
  pageText: string;
  fareRulesText: string;
}

export interface TtinteractiveManageBookingImportResult {
  apiResponse: OrderCreateApiResponse;
  scraped: ScrapedUsBanglaBooking;
  missingFields: string[];
}

export type UsBanglaImportResult = TtinteractiveManageBookingImportResult;
export type AirAstraImportResult = TtinteractiveManageBookingImportResult;

function parseAmount(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(/(\d[\d,]*)/);
  if (!match?.[1]) return 0;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeLines(text: string): string[] {
  return text
    .replace(/\u00a0/g, " ")
    .split(/\n+/)
    .map((line) =>
      line
        .replace(/[\uE000-\uF8FF]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

function buildSearchUrl(
  reference: string,
  lastName: string,
  defaultFindBookingUrl: string,
  sourceUrl?: string,
): string {
  const url = new URL(sourceUrl?.trim() || defaultFindBookingUrl);
  const defaultUrl = new URL(defaultFindBookingUrl);
  if (url.hostname !== defaultUrl.hostname) {
    throw new Error(`Manage Booking URL must be from ${defaultUrl.hostname}`);
  }
  if (/\/PNR\/Details\//i.test(url.pathname)) {
    return url.toString();
  }
  url.searchParams.set("searchType", "PNR");
  url.searchParams.set("referenceNumber", reference.trim().toUpperCase());
  url.searchParams.set("travelerSurname", lastName.trim().toUpperCase());
  url.searchParams.set("findBookingMode", "PnrDetails");
  return url.toString();
}

function hasTtinteractiveSessionUrl(value: string): boolean {
  return /\/\(S\([a-f0-9]+\)\)\//i.test(value);
}

function buildDeviceCheckMessage(
  config: TtinteractiveAirlineConfig,
  attemptedUrl: string,
): string {
  if (hasTtinteractiveSessionUrl(attemptedUrl)) {
    return `${config.displayName} website returned a device check. Select the standard Manage Booking site option and try again, or retry after a few minutes.`;
  }

  return `${config.displayName} website returned a device check. Select the website session link option and try again, or retry after a few minutes.`;
}

function parseUsBanglaDateTime(value: string): string {
  const match = value.match(
    /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{2}):(\d{2})/,
  );
  if (!match?.[1] || !match[2] || !match[3] || !match[4] || !match[5])
    return "";
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return "";
  return `${match[3]}-${month}-${match[1].padStart(2, "0")}T${match[4]}:${match[5]}:00+06:00`;
}

function parsePassengerName(
  value: string,
): Omit<ScrapedPassenger, "fare" | "tax" | "total" | "ticketNumber"> | null {
  const match = value.match(/^(.+?)\s+(Mr|Mrs|Ms|Miss|Mstr)\.?\s+(.+)$/i);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const title = match[2].replace(/\.$/, "");
  const titleLower = title.toLowerCase();
  return {
    surname: match[1].trim().toUpperCase(),
    title,
    givenName: match[3].trim().toUpperCase(),
    gender: titleLower === "mr" || titleLower === "mstr" ? "Male" : "Female",
  };
}

function parsePassengers(lines: string[]): ScrapedPassenger[] {
  const passengers: ScrapedPassenger[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const parsedName = parsePassengerName(lines[index] ?? "");
    if (!parsedName) continue;

    const windowLines = lines.slice(index + 1, index + 14);
    const amounts = windowLines
      .filter((line) => /^\d[\d,]*$/.test(line))
      .map((line) => parseAmount(line))
      .filter((value) => value > 0);
    const ticketNumber = windowLines.find((line) => /^\d{10,16}$/.test(line));

    passengers.push({
      ...parsedName,
      fare: amounts[0] ?? 0,
      tax: amounts[1] ?? 0,
      total: amounts[2] ?? 0,
      ...(ticketNumber ? { ticketNumber } : {}),
    });
  }

  return passengers;
}

function getPassengerKey(passenger: ScrapedPassenger): string {
  const ticketKey = passenger.ticketNumber?.trim();
  if (ticketKey) return `ticket:${ticketKey}`;
  return [
    passenger.surname.trim().toUpperCase(),
    passenger.givenName.trim().toUpperCase(),
    passenger.title.trim().toUpperCase(),
  ].join("|");
}

function dedupePassengers(passengers: ScrapedPassenger[]): ScrapedPassenger[] {
  const passengersByKey = new Map<string, ScrapedPassenger>();

  for (const passenger of passengers) {
    const key = getPassengerKey(passenger);
    const existing = passengersByKey.get(key);
    if (!existing) {
      passengersByKey.set(key, { ...passenger });
      continue;
    }

    existing.fare += passenger.fare;
    existing.tax += passenger.tax;
    existing.total += passenger.total;
    if (!existing.ticketNumber && passenger.ticketNumber)
      existing.ticketNumber = passenger.ticketNumber;
    if (!existing.gender && passenger.gender)
      existing.gender = passenger.gender;
  }

  return Array.from(passengersByKey.values());
}

function findAmountByRegex(text: string, pattern: RegExp): number {
  const match = text.match(pattern);
  return parseAmount(match?.[1]);
}

function normalizeCityName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function airportCodeForCity(city: string): string {
  const normalized = normalizeCityName(city);
  return (
    CITY_AIRPORT_CODES[normalized] ??
    CITY_AIRPORT_CODES[normalized.replace(/\s+/g, "")] ??
    ""
  );
}

function parseRouteFromLines(lines: string[]): {
  departureCity: string;
  departureCode: string;
  arrivalCity: string;
  arrivalCode: string;
} {
  const compactText = lines.join("\n");
  const routeMatch = compactText.match(
    /([A-Za-z .'-]+)\s*\(([A-Z]{3})\)\s+flight\s+([A-Za-z .'-]+)\s*\(([A-Z]{3})\)/,
  );
  if (routeMatch) {
    return {
      departureCity: routeMatch[1]?.trim() ?? "",
      departureCode: routeMatch[2] ?? "",
      arrivalCity: routeMatch[3]?.trim() ?? "",
      arrivalCode: routeMatch[4] ?? "",
    };
  }

  const outboundIndex = lines.findIndex(
    (line) => line.toLowerCase() === "outbound",
  );
  if (outboundIndex >= 0) {
    const departureCity = lines[outboundIndex + 1] ?? "";
    const arrivalCity =
      lines[outboundIndex + 2]?.toLowerCase() === "flight"
        ? (lines[outboundIndex + 3] ?? "")
        : (lines[outboundIndex + 2] ?? "");
    return {
      departureCity,
      departureCode: airportCodeForCity(departureCity),
      arrivalCity,
      arrivalCode: airportCodeForCity(arrivalCity),
    };
  }

  const dateRouteLines = lines.filter((line) =>
    /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+\d{2}:\d{2}\s*-/i.test(
      line,
    ),
  );
  const departureCity =
    dateRouteLines[0]
      ?.split(/\s+-\s+/)[1]
      ?.replace(/\s+[A-Z]-[A-Z]$/, "")
      .trim() ?? "";
  const arrivalCity =
    dateRouteLines[1]
      ?.split(/\s+-\s+/)[1]
      ?.replace(/\s+[A-Z]-[A-Z]$/, "")
      .trim() ?? "";
  return {
    departureCity,
    departureCode: airportCodeForCity(departureCity),
    arrivalCity,
    arrivalCode: airportCodeForCity(arrivalCity),
  };
}

function parseDateRouteLine(line: string): {
  dateTime: string;
  city: string;
  code: string;
  terminal?: string;
} | null {
  const match = line.match(
    /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+\d{2}:\d{2})\s*-\s*([A-Za-z .'-]+?)(?:\s+([A-Z0-9]-[A-Z0-9]+))?$/i,
  );
  if (!match?.[1] || !match[2]) return null;

  const city = match[2].trim();
  const parsed = {
    dateTime: parseUsBanglaDateTime(match[1]),
    city,
    code: airportCodeForCity(city),
  };
  const terminal = match[3]?.trim();
  return terminal ? { ...parsed, terminal } : parsed;
}

function extractCurrencyAmounts(text: string): number[] {
  return Array.from(
    text.matchAll(
      /(?:\u09f3|Tk\.?|BDT)\s*(\d[\d,]*)|(\d[\d,]*)\s*(?:BDT|Tk\.?)/gi,
    ),
  )
    .map((match) => parseAmount(match[1] ?? match[2]))
    .filter((amount) => amount > 0);
}

function extractStandaloneAmounts(lines: string[]): number[] {
  return lines
    .map((line) => line.trim())
    .filter((line) =>
      /^(?:\u09f3\s*)?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s*BDT)?$/i.test(line),
    )
    .map(parseAmount)
    .filter((amount) => amount > 0);
}

function extractSegmentAmounts(lines: string[]): {
  fare: number;
  tax: number;
  total: number;
} {
  const currencyAmounts = extractCurrencyAmounts(lines.join("\n"));
  const amounts =
    currencyAmounts.length >= 3
      ? currencyAmounts
      : extractStandaloneAmounts(lines);
  if (amounts.length >= 3) {
    return amounts.reduce(
      (sum, amount, index) => {
        const column = index % 3;
        if (column === 0) sum.fare += amount;
        if (column === 1) sum.tax += amount;
        if (column === 2) sum.total += amount;
        return sum;
      },
      { fare: 0, tax: 0, total: 0 },
    );
  }

  return {
    fare: 0,
    tax: 0,
    total: 0,
  };
}

function getSegmentDirection(
  lines: string[],
  flightLineIndex: number,
): ScrapedFlightSegment["direction"] {
  const marker = lines
    .slice(Math.max(0, flightLineIndex - 12), flightLineIndex)
    .reverse()
    .find((line) => /^(outbound|inbound)$/i.test(line.trim()))
    ?.trim()
    .toLowerCase();

  if (marker === "outbound" || marker === "inbound") return marker;
  return "unknown";
}

function getSegmentDurationMinutes(
  departureTime: string,
  arrivalTime: string,
): string | undefined {
  const departureMs = Date.parse(departureTime);
  const arrivalMs = Date.parse(arrivalTime);
  if (!Number.isFinite(departureMs) || !Number.isFinite(arrivalMs))
    return undefined;

  const durationMinutes = Math.round((arrivalMs - departureMs) / 60000);
  return durationMinutes > 0 ? String(durationMinutes) : undefined;
}

function parseSegmentsFromPageLines(
  lines: string[],
  config: TtinteractiveAirlineConfig,
): ScrapedFlightSegment[] {
  const flightLineIndexes = lines
    .map((line, index) =>
      /^[A-Z0-9]{2}\s+\d{1,4}$/.test(line.trim()) ? index : -1,
    )
    .filter((index) => index >= 0);

  return flightLineIndexes.flatMap((flightLineIndex, index) => {
    const flightLine = lines[flightLineIndex]?.trim() ?? "";
    const flightMatch = flightLine.match(/^([A-Z0-9]{2})\s+(\d{1,4})$/);
    if (!flightMatch?.[1] || !flightMatch[2]) return [];

    const nextFlightLineIndex = flightLineIndexes[index + 1] ?? lines.length;
    const blockLines = lines.slice(flightLineIndex, nextFlightLineIndex);
    const dateRouteLines = blockLines
      .map(parseDateRouteLine)
      .filter(
        (line): line is NonNullable<ReturnType<typeof parseDateRouteLine>> =>
          line !== null,
      );
    const departure = dateRouteLines[0];
    const arrival = dateRouteLines[1];
    if (!departure || !arrival) return [];

    const amounts = extractSegmentAmounts(blockLines);
    const segment: ScrapedFlightSegment = {
      direction: getSegmentDirection(lines, flightLineIndex),
      departureCity: departure.city,
      departureCode: departure.code,
      arrivalCity: arrival.city,
      arrivalCode: arrival.code,
      departureTime: departure.dateTime,
      arrivalTime: arrival.dateTime,
      flightCarrier: flightMatch[1] || config.defaultCarrierCode,
      flightNumber: flightMatch[2],
      equipment: "",
      fareBrand: "",
      rbd: "",
      fare: amounts.fare,
      tax: amounts.tax,
      total: amounts.total,
      refundRules: [],
      exchangeRules: [],
    };
    if (departure.terminal) segment.departureTerminal = departure.terminal;
    return [segment];
  });
}

function extractPenaltyLines(sectionText: string): string[] {
  const lines = normalizeLines(sectionText);
  const rules: string[] = [];
  let parts: string[] = [];

  for (const line of lines) {
    if (
      /^(Up to|Between|Starting|After)\b/i.test(line) &&
      /\d[\d,]*\s*BDT\b/i.test(line)
    ) {
      rules.push(line.replace(/\s+/g, " ").trim());
      parts = [];
      continue;
    }
    if (/^\d[\d,]*\s*BDT$/i.test(line)) {
      rules.push([...parts, line].join(" ").replace(/\s+/g, " ").trim());
      parts = [];
      continue;
    }
    if (/^(Up to|Between|Starting|After)\b/i.test(line) || parts.length > 0) {
      parts.push(line);
    }
  }

  return rules;
}

function extractSection(
  text: string,
  startLabel: string,
  endLabels: string[],
): string {
  const start = text.toLowerCase().indexOf(startLabel.toLowerCase());
  if (start < 0) return "";
  const afterStart = text.slice(start + startLabel.length);
  const endIndexes = endLabels
    .map((label) => afterStart.toLowerCase().indexOf(label.toLowerCase()))
    .filter((index) => index >= 0);
  const end =
    endIndexes.length > 0 ? Math.min(...endIndexes) : afterStart.length;
  return afterStart.slice(0, end);
}

function isFareRuleRouteHeader(lines: string[], index: number): boolean {
  const line = lines[index] ?? "";
  if (!/^([A-Za-z .'-]+)\s+-\s+([A-Za-z .'-]+)$/.test(line)) return false;
  return lines
    .slice(index + 1, index + 6)
    .some((candidate) => /^Departure\s*:/i.test(candidate.trim()));
}

function parseFareRuleSections(
  fareRulesText: string,
): ScrapedFareRuleSection[] {
  const lines = normalizeLines(fareRulesText);
  const routeHeaderIndexes = lines
    .map((_, index) => (isFareRuleRouteHeader(lines, index) ? index : -1))
    .filter((index) => index >= 0);

  return routeHeaderIndexes.flatMap((startIndex, sectionIndex) => {
    const header = lines[startIndex] ?? "";
    const routeMatch = header.match(/^([A-Za-z .'-]+)\s+-\s+([A-Za-z .'-]+)$/);
    if (!routeMatch?.[1] || !routeMatch[2]) return [];

    const endIndex = routeHeaderIndexes[sectionIndex + 1] ?? lines.length;
    const sectionLines = lines.slice(startIndex, endIndex);
    const sectionText = sectionLines.join("\n");
    const flightLine =
      sectionLines.find((line) =>
        /^[A-Z0-9]{2}\s+\d{1,4}$/.test(line.trim()),
      ) ?? "";
    const flightMatch = flightLine.match(/^([A-Z0-9]{2})\s+(\d{1,4})$/);
    const fareBrand =
      sectionLines.find((line) => /^[A-Z]\s*-\s+.+\|.+$/.test(line)) ?? "";
    const rbd = fareBrand.match(/^([A-Z])\s*-/)?.[1] ?? "";
    const baggageAllowance =
      sectionText
        .match(/Adult\(s\)\s*:\s*([0-9]+\s*Kg)/i)?.[1]
        ?.replace(/\s+/g, " ") ?? undefined;
    const equipment =
      sectionText.match(/Equipment:\s*([^\n]+)/i)?.[1]?.trim() ?? "";
    const total = findAmountByRegex(
      sectionText,
      /Amount\s*:\s*(\d[\d,]*)\s+BDT/i,
    );
    const refundSection = extractSection(sectionText, "Refundable with fee", [
      "Exchange with fee",
      "Checked-in luggage",
    ]);
    const exchangeSection = extractSection(sectionText, "Exchange with fee", [
      "Checked-in luggage",
    ]);

    const section: ScrapedFareRuleSection = {
      departureCity: routeMatch[1].trim(),
      departureCode: airportCodeForCity(routeMatch[1]),
      arrivalCity: routeMatch[2].trim(),
      arrivalCode: airportCodeForCity(routeMatch[2]),
      flightCarrier: flightMatch?.[1] ?? "",
      flightNumber: flightMatch?.[2] ?? "",
      equipment,
      fareBrand,
      rbd,
      total,
      refundRules: extractPenaltyLines(refundSection),
      exchangeRules: extractPenaltyLines(exchangeSection),
    };
    if (baggageAllowance) section.baggageAllowance = baggageAllowance;
    return [section];
  });
}

function findMatchingFareRuleSection(
  segment: ScrapedFlightSegment,
  fareRuleSections: ScrapedFareRuleSection[],
  usedSectionIndexes: Set<number>,
): ScrapedFareRuleSection | undefined {
  const exactFlightIndex = fareRuleSections.findIndex((section, index) => {
    return (
      !usedSectionIndexes.has(index) &&
      section.flightCarrier === segment.flightCarrier &&
      section.flightNumber === segment.flightNumber
    );
  });
  if (exactFlightIndex >= 0) {
    usedSectionIndexes.add(exactFlightIndex);
    return fareRuleSections[exactFlightIndex];
  }

  const routeIndex = fareRuleSections.findIndex((section, index) => {
    return (
      !usedSectionIndexes.has(index) &&
      section.departureCode === segment.departureCode &&
      section.arrivalCode === segment.arrivalCode
    );
  });
  if (routeIndex >= 0) {
    usedSectionIndexes.add(routeIndex);
    return fareRuleSections[routeIndex];
  }

  return undefined;
}

function mergeFareRulesIntoSegments(
  pageSegments: ScrapedFlightSegment[],
  fareRuleSections: ScrapedFareRuleSection[],
): ScrapedFlightSegment[] {
  const usedSectionIndexes = new Set<number>();

  const mergedSegments = pageSegments.map((segment) => {
    const matchingSection = findMatchingFareRuleSection(
      segment,
      fareRuleSections,
      usedSectionIndexes,
    );
    if (!matchingSection) return segment;

    const merged: ScrapedFlightSegment = {
      ...segment,
      equipment: matchingSection.equipment || segment.equipment,
      fareBrand: matchingSection.fareBrand || segment.fareBrand,
      rbd: matchingSection.rbd || segment.rbd,
      total: segment.total || matchingSection.total,
      refundRules: matchingSection.refundRules.length
        ? matchingSection.refundRules
        : segment.refundRules,
      exchangeRules: matchingSection.exchangeRules.length
        ? matchingSection.exchangeRules
        : segment.exchangeRules,
    };
    if (matchingSection.baggageAllowance) {
      merged.baggageAllowance = matchingSection.baggageAllowance;
    }
    return merged;
  });

  if (mergedSegments.length > 0) return mergedSegments;

  return fareRuleSections.map((section, index): ScrapedFlightSegment => ({
    direction: index === 0 ? "outbound" : "inbound",
    departureCity: section.departureCity,
    departureCode: section.departureCode,
    arrivalCity: section.arrivalCity,
    arrivalCode: section.arrivalCode,
    departureTime: "",
    arrivalTime: "",
    flightCarrier: section.flightCarrier,
    flightNumber: section.flightNumber,
    equipment: section.equipment,
    fareBrand: section.fareBrand,
    rbd: section.rbd,
    ...(section.baggageAllowance
      ? { baggageAllowance: section.baggageAllowance }
      : {}),
    fare: 0,
    tax: 0,
    total: section.total,
    refundRules: section.refundRules,
    exchangeRules: section.exchangeRules,
  }));
}

function findBookingTotal(lines: string[], compactText: string): number {
  const bookingTotalIndex = lines.findIndex((line) =>
    /booking total amount/i.test(line),
  );
  if (bookingTotalIndex >= 0) {
    const followingText = lines
      .slice(bookingTotalIndex, bookingTotalIndex + 8)
      .join("\n");
    const followingAmounts = extractCurrencyAmounts(followingText);
    if (followingAmounts[0]) return followingAmounts[0];
  }

  return (
    findAmountByRegex(
      compactText,
      /booking total amount\s*(?:\u09f3|BDT)?\s*(\d[\d,]*)/i,
    ) || findAmountByRegex(compactText, /(\d[\d,]*)\s+BDT\s+Total/i)
  );
}

function parseScrapedBooking(
  pageText: string,
  fareRulesText: string,
  finalUrl: string,
  requestedReference: string,
  config: TtinteractiveAirlineConfig,
): ScrapedUsBanglaBooking {
  const lines = normalizeLines(pageText);
  const compactText = lines.join("\n");
  const compactFareRulesText = normalizeLines(fareRulesText).join("\n");

  const referenceIndex = lines.findIndex(
    (line) => line.toLowerCase() === "booking reference",
  );
  const status = referenceIndex >= 0 ? (lines[referenceIndex + 2] ?? "") : "";
  const reference = (
    referenceIndex >= 0
      ? (lines[referenceIndex + 1] ?? requestedReference)
      : requestedReference
  ).trim();

  const summaryLine =
    lines.find(
      (line) =>
        /\d{4}/.test(line) && /Adult\(s\)|Child\(s\)|Infant\(s\)/i.test(line),
    ) ?? "";
  const summaryParts = summaryLine.split("|").map((part) => part.trim());
  const passengerSummary =
    summaryParts.find((part) =>
      /Adult\(s\)|Child\(s\)|Infant\(s\)/i.test(part),
    ) ?? "";
  const hasOutbound = lines.some((line) => line.toLowerCase() === "outbound");
  const hasInbound = lines.some((line) => line.toLowerCase() === "inbound");
  const fareRuleSections = parseFareRuleSections(fareRulesText);
  let segments = mergeFareRulesIntoSegments(
    parseSegmentsFromPageLines(lines, config),
    fareRuleSections,
  );

  const dateTimeMatches = Array.from(
    compactText.matchAll(
      /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4}\s+\d{2}:\d{2})\s*-\s*([A-Za-z .'-]+?)(?:\s+([A-Z0-9]-[A-Z0-9]+))?(?=\n|$)/g,
    ),
  );
  const departureTime = parseUsBanglaDateTime(dateTimeMatches[0]?.[1] ?? "");
  const arrivalTime = parseUsBanglaDateTime(dateTimeMatches[1]?.[1] ?? "");
  const departureTerminal = dateTimeMatches[0]?.[3]?.trim();

  const flightLine =
    lines.find((line) => /^[A-Z0-9]{2}\s+\d{1,4}$/.test(line)) ?? "";
  const flightMatch = flightLine.match(/^([A-Z0-9]{2})\s+(\d{1,4})$/);
  const flightCarrier = flightMatch?.[1] ?? config.defaultCarrierCode;
  const flightNumber = flightMatch?.[2] ?? "";
  const equipment =
    compactFareRulesText.match(/Equipment:\s*([^\n]+)/i)?.[1]?.trim() ?? "";
  const fareBrand =
    normalizeLines(fareRulesText).find((line) =>
      /^[A-Z]\s*-\s+.+\|.+$/.test(line),
    ) ?? "";
  const rbd = fareBrand.match(/^([A-Z])\s*-/)?.[1] ?? "";
  const baggageAllowance =
    compactFareRulesText
      .match(/Adult\(s\)\s*:\s*([0-9]+\s*Kg)/i)?.[1]
      ?.replace(/\s+/g, " ") ?? undefined;
  if (segments.length === 0) {
    const fallbackRoute = parseRouteFromLines(lines);
    const fallbackSegment: ScrapedFlightSegment = {
      direction: hasInbound ? "outbound" : "unknown",
      departureCity: fallbackRoute.departureCity,
      departureCode: fallbackRoute.departureCode,
      arrivalCity: fallbackRoute.arrivalCity,
      arrivalCode: fallbackRoute.arrivalCode,
      departureTime,
      arrivalTime,
      flightCarrier,
      flightNumber,
      equipment,
      fareBrand,
      rbd,
      fare: 0,
      tax: 0,
      total: 0,
      refundRules: [],
      exchangeRules: [],
    };
    if (departureTerminal)
      fallbackSegment.departureTerminal = departureTerminal;
    if (baggageAllowance) fallbackSegment.baggageAllowance = baggageAllowance;
    segments = mergeFareRulesIntoSegments([fallbackSegment], fareRuleSections);
  }

  const firstSegment = segments[0];
  const routeFallback = parseRouteFromLines(lines);
  const summaryTripType =
    summaryParts.find((part) => /one\s*way|round|return/i.test(part)) ?? "";
  const tripType =
    summaryTripType ||
    (segments.length > 1 || hasInbound
      ? "Round Trip"
      : hasOutbound
        ? "One Way"
        : "");

  const passengers = dedupePassengers(parsePassengers(lines));
  const passengerCount =
    passengers.length ||
    parseAmount(passengerSummary.match(/(\d+)\s+Adult\(s\)/i)?.[1]) ||
    1;

  const segmentFareTotal = segments.reduce(
    (sum, segment) => sum + segment.fare,
    0,
  );
  const segmentTaxTotal = segments.reduce(
    (sum, segment) => sum + segment.tax,
    0,
  );
  const segmentGrandTotal = segments.reduce(
    (sum, segment) => sum + segment.total,
    0,
  );
  const fareRuleGrandTotal = fareRuleSections.reduce(
    (sum, section) => sum + section.total,
    0,
  );
  const passengerFareTotal = passengers.reduce(
    (sum, passenger) => sum + passenger.fare,
    0,
  );
  const passengerTaxTotal = passengers.reduce(
    (sum, passenger) => sum + passenger.tax,
    0,
  );
  const passengerGrandTotal = passengers.reduce(
    (sum, passenger) => sum + passenger.total,
    0,
  );
  const fareTotal =
    segmentFareTotal ||
    passengerFareTotal ||
    findAmountByRegex(compactText, /Fare\s+(\d[\d,]*)\s+BDT/i);
  const taxTotal =
    segmentTaxTotal ||
    passengerTaxTotal ||
    findAmountByRegex(compactText, /Taxes\s+(\d[\d,]*)\s+BDT/i);
  const totalAmount =
    findBookingTotal(lines, compactText) ||
    segmentGrandTotal ||
    passengerGrandTotal ||
    fareRuleGrandTotal ||
    findAmountByRegex(compactFareRulesText, /Amount\s*:\s*(\d[\d,]*)\s+BDT/i);
  const resolvedDepartureTerminal =
    firstSegment?.departureTerminal || departureTerminal || "";
  const resolvedBaggageAllowance =
    firstSegment?.baggageAllowance || baggageAllowance || "";

  return {
    reference: reference || requestedReference.trim().toUpperCase(),
    status,
    segments,
    departureCity: firstSegment?.departureCity ?? routeFallback.departureCity,
    departureCode: firstSegment?.departureCode ?? routeFallback.departureCode,
    arrivalCity: firstSegment?.arrivalCity ?? routeFallback.arrivalCity,
    arrivalCode: firstSegment?.arrivalCode ?? routeFallback.arrivalCode,
    departureTime: firstSegment?.departureTime ?? departureTime,
    arrivalTime: firstSegment?.arrivalTime ?? arrivalTime,
    ...(resolvedDepartureTerminal
      ? { departureTerminal: resolvedDepartureTerminal }
      : {}),
    flightCarrier: firstSegment?.flightCarrier ?? flightCarrier,
    flightNumber: firstSegment?.flightNumber ?? flightNumber,
    equipment: firstSegment?.equipment || equipment,
    tripType,
    passengerSummary: passengerSummary || `Adult ${passengerCount}`,
    passengers,
    totalAmount,
    fareTotal,
    taxTotal,
    fareBrand: firstSegment?.fareBrand || fareBrand,
    rbd: firstSegment?.rbd || rbd,
    ...(resolvedBaggageAllowance
      ? { baggageAllowance: resolvedBaggageAllowance }
      : {}),
    refundRules: firstSegment?.refundRules ?? [],
    exchangeRules: firstSegment?.exchangeRules ?? [],
    finalUrl,
    pageText,
    fareRulesText,
  };
}

function mapStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === "issued" || normalized === "confirmed") return "Confirmed";
  if (
    normalized.includes("cancel") ||
    normalized.includes("refund") ||
    normalized === "void" ||
    normalized === "voided"
  )
    return "Cancelled";
  if (normalized === "expired") return "Expired";
  if (
    normalized === "onhold" ||
    normalized === "on hold" ||
    normalized === "on-hold"
  )
    return "OnHold";
  return status.trim() || "Pending";
}

function buildMissingFields(scraped: ScrapedUsBanglaBooking): string[] {
  const missing: string[] = [];
  if (scraped.segments.length > 0) {
    if (scraped.segments.some((segment) => !segment.departureTime)) {
      missing.push("departure.aircraftScheduledDateTime");
    }
    if (scraped.segments.some((segment) => !segment.arrivalTime)) {
      missing.push("arrival.aircraftScheduledDateTime");
    }
  } else {
    if (!scraped.departureTime)
      missing.push("departure.aircraftScheduledDateTime");
    if (!scraped.arrivalTime) missing.push("arrival.aircraftScheduledDateTime");
  }
  if (!scraped.passengers.length) missing.push("paxList");
  if (
    !scraped.segments.some((segment) => segment.baggageAllowance) &&
    !scraped.baggageAllowance
  ) {
    missing.push("baggageAllowanceList.cabin/checkIn");
  }
  missing.push("contactDetail.phoneNumber");
  missing.push("contactDetail.emailAddress");
  missing.push("passenger.birthdate");
  missing.push("passenger.nationality");
  missing.push("passenger.identityDoc");
  missing.push("paymentTimeLimit");
  missing.push("partialPaymentInfo");
  return missing;
}

function money(total: number) {
  return {
    total,
    curreny: "BDT",
    currency: "BDT",
  };
}

function deriveCabinType(fareBrand: string): string {
  const brandedCabin = fareBrand
    .split("|")[0]
    ?.replace(/^[A-Z]\s*-\s*/, "")
    .trim();
  if (brandedCabin) return brandedCabin;
  return fareBrand.toLowerCase().includes("economy") ? "Economy" : "";
}

function isRoundTripType(tripType: string): boolean {
  return /round|return/i.test(tripType);
}

function isReturnSegment(
  segment: ScrapedFlightSegment,
  index: number,
  segments: ScrapedFlightSegment[],
  tripType: string,
): boolean {
  if (index === 0) return false;
  if (segment.direction === "inbound") return true;
  const firstSegment = segments[0];
  if (
    firstSegment &&
    firstSegment.departureCode === segment.arrivalCode &&
    firstSegment.arrivalCode === segment.departureCode
  ) {
    return true;
  }
  return isRoundTripType(tripType);
}

function getOrderSegments(
  scraped: ScrapedUsBanglaBooking,
  config: TtinteractiveAirlineConfig,
): ScrapedFlightSegment[] {
  if (scraped.segments.length > 0) return scraped.segments;

  const fallbackSegment: ScrapedFlightSegment = {
    direction: "unknown",
    departureCity: scraped.departureCity,
    departureCode: scraped.departureCode,
    arrivalCity: scraped.arrivalCity,
    arrivalCode: scraped.arrivalCode,
    departureTime: scraped.departureTime,
    arrivalTime: scraped.arrivalTime,
    flightCarrier: scraped.flightCarrier || config.defaultCarrierCode,
    flightNumber: scraped.flightNumber,
    equipment: scraped.equipment || config.defaultEquipment,
    fareBrand: scraped.fareBrand,
    rbd: scraped.rbd,
    fare: scraped.fareTotal,
    tax: scraped.taxTotal,
    total: scraped.totalAmount,
    refundRules: scraped.refundRules,
    exchangeRules: scraped.exchangeRules,
  };
  if (scraped.departureTerminal)
    fallbackSegment.departureTerminal = scraped.departureTerminal;
  if (scraped.baggageAllowance)
    fallbackSegment.baggageAllowance = scraped.baggageAllowance;
  return [fallbackSegment];
}

function buildOrderResponse(
  scraped: ScrapedUsBanglaBooking,
  missingFields: string[],
  config: TtinteractiveAirlineConfig,
): OrderCreateApiResponse {
  const segments = getOrderSegments(scraped, config);
  const passengerFareTotal = scraped.passengers.reduce(
    (sum, passenger) => sum + passenger.fare,
    0,
  );
  const passengerTaxTotal = scraped.passengers.reduce(
    (sum, passenger) => sum + passenger.tax,
    0,
  );
  const passengerGrandTotal = scraped.passengers.reduce(
    (sum, passenger) => sum + passenger.total,
    0,
  );
  const fareTotal = scraped.fareTotal || passengerFareTotal;
  const taxTotal = scraped.taxTotal || passengerTaxTotal;
  const totalAmount =
    scraped.totalAmount || passengerGrandTotal || fareTotal + taxTotal;
  const passengerList =
    scraped.passengers.length > 0
      ? scraped.passengers
      : [
          {
            title: "",
            givenName: "",
            surname: "",
            gender: "",
            fare: fareTotal,
            tax: taxTotal,
            total: totalAmount,
          },
        ];
  const paxCount = Math.max(1, passengerList.length);
  const baseFarePerPax = Math.round((fareTotal / paxCount) * 100) / 100;
  const taxPerPax = Math.round((taxTotal / paxCount) * 100) / 100;
  const subTotal = totalAmount || (baseFarePerPax + taxPerPax) * paxCount;
  const firstSegment = segments[0];
  const validatingCarrier =
    firstSegment?.flightCarrier ||
    scraped.flightCarrier ||
    config.defaultCarrierCode;
  const fareType =
    firstSegment?.fareBrand || scraped.fareBrand || config.defaultFareType;

  const order: OrderCreateResponse = {
    orderReference: scraped.reference,
    orderItem: [
      {
        validatingCarrier,
        refundable: segments.some((segment) => segment.refundRules.length > 0),
        fareType,
        paxSegmentList: segments.map((segment, index) => {
          const departure = {
            iatA_LocationCode: segment.departureCode,
            aircraftScheduledDateTime: segment.departureTime,
          };
          const duration = getSegmentDurationMinutes(
            segment.departureTime,
            segment.arrivalTime,
          );
          return {
            paxSegment: {
              departure: segment.departureTerminal
                ? { ...departure, terminalName: segment.departureTerminal }
                : departure,
              arrival: {
                iatA_LocationCode: segment.arrivalCode,
                aircraftScheduledDateTime: segment.arrivalTime,
              },
              marketingCarrierInfo: {
                carrierDesigCode:
                  segment.flightCarrier || config.defaultCarrierCode,
                marketingCarrierFlightNumber: segment.flightNumber,
                carrierName: config.carrierName,
              },
              operatingCarrierInfo: {
                carrierDesigCode:
                  segment.flightCarrier || config.defaultCarrierCode,
                carrierName: config.carrierName,
              },
              iatA_AircraftType: {
                iatA_AircraftTypeCode:
                  segment.equipment || config.defaultEquipment,
              },
              rbd: segment.rbd || "",
              flightNumber: segment.flightNumber,
              segmentGroup: index,
              returnJourney: isReturnSegment(
                segment,
                index,
                segments,
                scraped.tripType,
              ),
              airlinePNR: scraped.reference,
              technicalStopOver: null,
              ...(duration ? { duration } : {}),
              cabinType: deriveCabinType(segment.fareBrand || fareType),
            },
          };
        }),
        fareDetailList: [
          {
            fareDetail: {
              baseFare: baseFarePerPax,
              tax: taxPerPax,
              otherFee: 0,
              discount: 0,
              vat: 0,
              currency: "BDT",
              paxType: "ADT",
              paxCount,
              subTotal,
            },
          },
        ],
        price: {
          totalPayable: money(totalAmount || subTotal),
          gross: money(totalAmount || subTotal),
          discount: money(0),
          totalVAT: money(0),
        },
        baggageAllowanceList: segments.map((segment) => ({
          baggageAllowance: {
            departure: segment.departureCode,
            arrival: segment.arrivalCode,
            checkIn: segment.baggageAllowance
              ? [{ paxType: "ADT", allowance: segment.baggageAllowance }]
              : [],
            cabin: [],
          },
        })),
        penalty: {
          refundPenaltyList: segments.map((segment) => ({
            refundPenalty: {
              departure: segment.departureCode,
              arrival: segment.arrivalCode,
              penaltyInfoList: [
                {
                  penaltyInfo: {
                    type: "Refundable with fee",
                    textInfoList: [
                      {
                        textInfo: {
                          paxType: "ADT",
                          info: segment.refundRules,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          })),
          exchangePenaltyList: segments.map((segment) => ({
            exchangePenalty: {
              departure: segment.departureCode,
              arrival: segment.arrivalCode,
              penaltyInfoList: [
                {
                  penaltyInfo: {
                    type: "Exchange with fee",
                    textInfoList: [
                      {
                        textInfo: {
                          paxType: "ADT",
                          info: segment.exchangeRules,
                        },
                      },
                    ],
                  },
                },
              ],
            },
          })),
        },
      },
    ],
    paxList: passengerList.map((passenger) => ({
      ptc: "ADT",
      individual: {
        title: passenger.title,
        givenName: passenger.givenName,
        surname: passenger.surname,
        gender: passenger.gender,
        birthdate: "",
        nationality: "",
        ticketDocument: passenger.ticketNumber
          ? [{ ticketDocNbr: passenger.ticketNumber }]
          : null,
      },
    })),
    contactDetail: {
      phoneNumber: "",
      emailAddress: "",
    },
    orderStatus: mapStatus(scraped.status),
    supplier: config.provider,
    importSource: "IMP_EXP",
    supplierBookingUrl: scraped.finalUrl,
    supplierMissingFields: missingFields,
  };

  const now = new Date().toISOString();
  return {
    message: null,
    requestedOn: now,
    respondedOn: now,
    response: order,
    statusCode: "Success",
    success: true,
    error: null,
    info: {
      supplier: config.provider,
      source: config.sourceName,
      missingFields,
    },
  };
}

async function readTtinteractiveManageBookingPageOnce(
  reference: string,
  lastName: string,
  config: TtinteractiveAirlineConfig,
  sourceUrl?: string,
): Promise<ScrapedUsBanglaBooking> {
  const launchConfig = await resolveChromiumLaunchConfig(
    buildChromiumArgs(),
  );

  let browser: Browser | null = null;
  try {
    const { chromium } = await import("playwright-core");
    browser = await chromium.launch({
      headless: true,
      executablePath: launchConfig.executablePath,
      args: launchConfig.args,
    });
    const context = await browser.newContext({
      locale: "en-GB",
      timezoneId: "Asia/Dhaka",
      extraHTTPHeaders: {
        "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
      },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
      viewport: { width: 1365, height: 900 },
    });
    await context.route("**/*", (route) => {
      const resourceType = route.request().resourceType();
      if (
        resourceType === "image" ||
        resourceType === "media" ||
        resourceType === "font"
      ) {
        return route.abort().catch(() => undefined);
      }
      return route.continue().catch(() => undefined);
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", {
        get: () => ["en-GB", "en-US", "en"],
      });
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      const browserWindow = window as typeof window & {
        chrome?: { runtime?: object };
      };
      browserWindow.chrome = browserWindow.chrome || { runtime: {} };
    });
    const searchUrl = buildSearchUrl(
      reference,
      lastName,
      config.defaultFindBookingUrl,
      sourceUrl,
    );
    await page.goto(searchUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => undefined);
    await page
      .waitForFunction(
        () =>
          window.location.href.includes("/PNR/Details/") ||
          (document.body?.innerText || "").includes("Booking reference") ||
          (document.body?.innerText || "")
            .toLowerCase()
            .includes("booking not found"),
        { timeout: 20000 },
      )
      .catch(() => undefined);

    const blocked = await page.evaluate(() => {
      const iframeSources = Array.from(document.querySelectorAll("iframe")).map(
        (frame) => frame.getAttribute("src") ?? "",
      );
      const pageText = document.body?.innerText ?? "";
      return (
        iframeSources.some((src) => src.includes("captcha-delivery.com")) ||
        /device check|captcha|verify you are human|security check/i.test(
          pageText,
        )
      );
    });
    if (blocked) {
      throw new Error(buildDeviceCheckMessage(config, searchUrl));
    }

    const pageText = await page.locator("body").innerText({ timeout: 10000 });
    if (
      !page.url().includes("/PNR/Details/") &&
      !pageText.includes("Booking reference")
    ) {
      throw new Error(
        `${config.displayName} booking was not found or the website did not open booking details`,
      );
    }

    const fareButtons = [
      page
        .getByRole("button", {
          name: /Fare rules.*Baggage Allowance|Show fare conditions/i,
        })
        .first(),
      page
        .locator('button.btn-show-resume, [data-target="#ModalResume"]')
        .filter({ hasText: /Show fare conditions/i })
        .first(),
    ];
    let fareButtonClicked = false;
    for (const fareButton of fareButtons) {
      if (fareButtonClicked || (await fareButton.count()) === 0) continue;

      try {
        await fareButton.click({ timeout: 10000 });
        fareButtonClicked = true;
      } catch {
        try {
          await fareButton.evaluate((element) => {
            if (element instanceof HTMLElement) element.click();
          });
          fareButtonClicked = true;
        } catch {
          // keep trying the next selector
        }
      }
    }
    if (fareButtonClicked) {
      await page
        .waitForFunction(
          () =>
            /Fare details|Equipment:|Refundable with fee|Exchange with fee/i.test(
              document.body?.innerText ?? "",
            ),
          { timeout: 8000 },
        )
        .catch(() => page.waitForTimeout(800));
    }
    const fareRulesText = await page
      .locator("body")
      .innerText({ timeout: 10000 });

    await context.close();
    await browser.close();
    browser = null;

    const scraped = parseScrapedBooking(
      pageText,
      fareRulesText,
      page.url(),
      reference,
      config,
    );
    const requestedReference = reference.trim().toUpperCase();
    const scrapedReference = scraped.reference.trim().toUpperCase();
    if (scrapedReference && scrapedReference !== requestedReference) {
      throw new Error(
        `${config.displayName} returned booking ${scrapedReference}, but requested ${requestedReference}. Paste the current Manage Booking URL for the same booking and try again.`,
      );
    }

    return scraped;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

async function readTtinteractiveManageBookingPage(
  reference: string,
  lastName: string,
  config: TtinteractiveAirlineConfig,
  sourceUrl?: string,
): Promise<ScrapedUsBanglaBooking> {
  let lastBrowserClosedError: unknown = null;

  for (
    let attempt = 1;
    attempt <= TTINTERACTIVE_BROWSER_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await readTtinteractiveManageBookingPageOnce(
        reference,
        lastName,
        config,
        sourceUrl,
      );
    } catch (error) {
      if (!isBrowserClosedNavigationError(error)) throw error;
      lastBrowserClosedError = error;
      if (attempt >= TTINTERACTIVE_BROWSER_ATTEMPTS) break;
      await wait(TTINTERACTIVE_BROWSER_RETRY_DELAY_MS);
    }
  }

  if (lastBrowserClosedError) {
    throw new Error(
      `${config.displayName} website session closed during import. Please retry once, or paste the current website session link and try again.`,
    );
  }

  throw new Error(`${config.displayName} import failed`);
}

export async function importUsBanglaManageBooking(params: {
  reference: string;
  lastName: string;
  sourceUrl?: string;
}): Promise<UsBanglaImportResult> {
  const reference = params.reference.trim().toUpperCase();
  const lastName = params.lastName.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(reference)) {
    throw new Error("US-Bangla reservation number must be 6 characters");
  }
  if (!lastName) {
    throw new Error("Last name is required for US-Bangla import");
  }

  const scraped = await readTtinteractiveManageBookingPage(
    reference,
    lastName,
    US_BANGLA_CONFIG,
    params.sourceUrl,
  );
  const missingFields = buildMissingFields(scraped);
  return {
    scraped,
    missingFields,
    apiResponse: buildOrderResponse(scraped, missingFields, US_BANGLA_CONFIG),
  };
}

export async function importAirAstraManageBooking(params: {
  reference: string;
  lastName: string;
  sourceUrl?: string;
}): Promise<AirAstraImportResult> {
  const reference = params.reference.trim().toUpperCase();
  const lastName = params.lastName.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(reference)) {
    throw new Error("AirAstra reservation number must be 6 characters");
  }
  if (!lastName) {
    throw new Error("Last name is required for AirAstra import");
  }

  const scraped = await readTtinteractiveManageBookingPage(
    reference,
    lastName,
    AIR_ASTRA_CONFIG,
    params.sourceUrl,
  );
  const missingFields = buildMissingFields(scraped);
  return {
    scraped,
    missingFields,
    apiResponse: buildOrderResponse(scraped, missingFields, AIR_ASTRA_CONFIG),
  };
}
