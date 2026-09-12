import "server-only";

import { resolveChromiumLaunchConfig } from "@/lib/impexp/chrome.server";
import type {
  OrderCreateApiResponse,
  OrderCreateResponse,
} from "@/lib/impexp/order-types";

import type { Browser } from "playwright-core";

const DEFAULT_RETRIEVE_BOOKING_URL =
  process.env.NOVOAIR_RETRIEVE_BOOKING_URL?.trim() ||
  "https://secure.flynovoair.com/bookings/retrieve_reservation.aspx";

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

interface ScrapedTable {
  rows: string[][];
}

interface ScrapedPageData {
  finalUrl: string;
  pageText: string;
  hiddenInputs: Record<string, string>;
  tables: ScrapedTable[];
}

interface ScrapedNovoairPassenger {
  title: string;
  givenName: string;
  surname: string;
  gender: string;
  ticketNumber?: string;
  status?: string;
  price: number;
  fareFamily?: string;
  fareBasis?: string;
  baggageAllowance?: string;
}

interface ScrapedNovoairSegment {
  departureCity: string;
  arrivalCity: string;
  departureCode: string;
  arrivalCode: string;
  departureTime: string;
  arrivalTime: string;
  flightCarrier: string;
  flightNumber: string;
  cabin: string;
  equipment: string;
  fareFamily?: string;
  fareBasis?: string;
  baggageAllowance?: string;
  refundRules: string[];
  exchangeRules: string[];
}

interface ScrapedNovoairBooking {
  reference: string;
  supplierReference?: string;
  status: string;
  passengers: ScrapedNovoairPassenger[];
  segments: ScrapedNovoairSegment[];
  phoneNumber?: string;
  paymentDate?: string;
  totalAmount: number;
  baseFareTotal: number;
  taxTotal: number;
  otherFeeTotal: number;
  cabinBaggageAllowance?: string;
  finalUrl: string;
  pageText: string;
}

export interface NovoairImportResult {
  apiResponse: OrderCreateApiResponse;
  scraped: ScrapedNovoairBooking;
  missingFields: string[];
}

function cleanText(value: string | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseAmount(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(/(\d[\d,]*)/);
  if (!match?.[1]) return 0;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatAllowance(value: string | undefined): string | undefined {
  const cleaned = cleanText(value);
  const match = cleaned.match(/(\d+)\s*kgs?/i);
  if (match?.[1]) return `${match[1]} Kg`;
  return cleaned || undefined;
}

function parseDateParts(
  value: string,
): { day: string; month: string; year: string } | null {
  const match = cleanText(value).match(
    /(\d{1,2})[-\s]+([A-Za-z]+)[-\s]+(\d{4})/,
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (!month) return null;
  return {
    day: match[1].padStart(2, "0"),
    month,
    year: match[3],
  };
}

function parseTime(value: string): string | null {
  const match = cleanText(value).match(/^(\d{1,2}):(\d{2})\s*([AP]M)$/i);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  let hour = Number(match[1]);
  const minute = match[2];
  const meridiem = match[3].toUpperCase();
  if (meridiem === "PM" && hour < 12) hour += 12;
  if (meridiem === "AM" && hour === 12) hour = 0;
  return `${String(hour).padStart(2, "0")}:${minute}:00`;
}

function buildDateTime(dateValue: string, timeValue: string): string {
  const date = parseDateParts(dateValue);
  const time = parseTime(timeValue);
  if (!date || !time) return "";
  return `${date.year}-${date.month}-${date.day}T${time}+06:00`;
}

function addOneDay(dateTime: string): string {
  const parsed = new Date(dateTime);
  if (Number.isNaN(parsed.getTime())) return dateTime;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().replace(".000Z", "+06:00");
}

function parsePaymentDate(pageText: string): string | undefined {
  const match = pageText.match(
    /Date of Payment\s+(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}\s+[AP]M)/i,
  );
  if (!match?.[1]) return undefined;
  const date = parseDateParts(match[1]);
  const timeMatch = match[1].match(/(\d{1,2}:\d{2}\s+[AP]M)/i);
  const time = timeMatch?.[1] ? parseTime(timeMatch[1]) : null;
  if (!date || !time) return undefined;
  return `${date.year}-${date.month}-${date.day}T${time}+06:00`;
}

function findTableByHeader(
  tables: ScrapedTable[],
  headers: string[],
): ScrapedTable | undefined {
  return tables.find((table) => {
    const headerText = table.rows.slice(0, 3).flat().join(" ").toLowerCase();
    return headers.every((header) => headerText.includes(header.toLowerCase()));
  });
}

function parsePassengerName(
  value: string,
  requestedLastName: string,
): Omit<ScrapedNovoairPassenger, "price"> | null {
  const match = cleanText(value).match(/^(MR|MRS|MS|MISS|MSTR)\.?\s+(.+)$/i);
  if (!match?.[1] || !match[2]) return null;
  const title = match[1].toUpperCase();
  const name = match[2].trim().toUpperCase();
  const requestedSurname = requestedLastName.trim().toUpperCase();
  const nameParts = name.split(/\s+/).filter(Boolean);
  const surname =
    requestedSurname && name.endsWith(requestedSurname)
      ? requestedSurname
      : (nameParts[nameParts.length - 1] ?? "");
  const givenName =
    (surname ? name.slice(0, -surname.length) : name).trim() || name;

  return {
    title,
    givenName,
    surname,
    gender: title === "MR" || title === "MSTR" ? "Male" : "Female",
  };
}

function normalizeTicketNumber(value: string | undefined): string | undefined {
  const ticketPart = cleanText(value).split("/")[0]?.replace(/\D/g, "");
  return ticketPart && ticketPart.length >= 10 ? ticketPart : undefined;
}

function parsePassengers(
  ticketTable: ScrapedTable | undefined,
  requestedLastName: string,
): ScrapedNovoairPassenger[] {
  if (!ticketTable) return [];
  const passengers: ScrapedNovoairPassenger[] = [];

  for (let index = 1; index < ticketTable.rows.length; index += 1) {
    const row = ticketTable.rows[index] ?? [];
    if (row.length !== 1) continue;
    const parsedName = parsePassengerName(row[0] ?? "", requestedLastName);
    const detailRow = ticketTable.rows[index + 1] ?? [];
    if (!parsedName || detailRow.length < 8) continue;

    const passenger: ScrapedNovoairPassenger = {
      ...parsedName,
      price: parseAmount(detailRow[7]),
    };
    const ticketNumber = normalizeTicketNumber(detailRow[0]);
    const fareFamily = cleanText(detailRow[4]);
    const baggageAllowance = formatAllowance(detailRow[5]);
    const fareBasis = cleanText(detailRow[6]);
    const status = cleanText(detailRow[8]);
    if (ticketNumber) passenger.ticketNumber = ticketNumber;
    if (fareFamily) passenger.fareFamily = fareFamily;
    if (baggageAllowance) passenger.baggageAllowance = baggageAllowance;
    if (fareBasis) passenger.fareBasis = fareBasis;
    if (status) passenger.status = status;
    passengers.push(passenger);
  }

  return passengers;
}

function parseFeeRules(value: string | undefined): string[] {
  const text = cleanText(value);
  if (!text) return [];

  return Array.from(text.matchAll(/BDT\s*([\d,]+)\s*(.*?)(?=BDT\s*[\d,]+|$)/gi))
    .map((match) => {
      const amount = parseAmount(match[1]);
      const description = cleanText(match[2]);
      if (!amount || !description) return "";
      return `BDT ${amount} ${description}`;
    })
    .filter(Boolean);
}

function parseFlightInfo(value: string): {
  departureCity: string;
  arrivalCity: string;
  departureCode: string;
  arrivalCode: string;
  departureClock: string;
  arrivalClock: string;
} | null {
  const match = cleanText(value).match(
    /^(.+?)\s+to\s+(.+?)\s+([A-Z]{3})\s+(\d{1,2}:\d{2}\s*[AP]M)\s+([A-Z]{3})\s+(\d{1,2}:\d{2}\s*[AP]M)$/i,
  );
  if (match?.[1] && match[2] && match[3] && match[4] && match[5] && match[6]) {
    return {
      departureCity: cleanText(match[1]),
      arrivalCity: cleanText(match[2]),
      departureCode: match[3].toUpperCase(),
      departureClock: cleanText(match[4]).toUpperCase(),
      arrivalCode: match[5].toUpperCase(),
      arrivalClock: cleanText(match[6]).toUpperCase(),
    };
  }

  const compact = cleanText(value);
  const routePart = compact.split(/Departs/i)[0] ?? "";
  const routeMatch = routePart.match(/^(.+?)\s+to\s+(.+)$/i);
  const times = compact.match(/\d{1,2}:\d{2}\s*[AP]M/gi) ?? [];
  const codes = Array.from(
    compact.matchAll(/([A-Z]{3})(?=\d{1,2}:\d{2}\s*[AP]M)/g),
  ).map((item) => item[1]);
  if (
    !routeMatch?.[1] ||
    !routeMatch[2] ||
    !codes[0] ||
    !codes[1] ||
    !times[0] ||
    !times[1]
  ) {
    return null;
  }
  return {
    departureCity: cleanText(routeMatch[1]),
    arrivalCity: cleanText(routeMatch[2]),
    departureCode: codes[0].toUpperCase(),
    arrivalCode: codes[1].toUpperCase(),
    departureClock: cleanText(times[0]).toUpperCase(),
    arrivalClock: cleanText(times[1]).toUpperCase(),
  };
}

function parseFlightNumber(value: string): { carrier: string; number: string } {
  const match = cleanText(value).match(/^([A-Z0-9]{2})-?(\d{1,4})$/i);
  return {
    carrier: match?.[1]?.toUpperCase() ?? "VQ",
    number: match?.[2] ?? cleanText(value).replace(/^[A-Z0-9]{2}-?/i, ""),
  };
}

function parseSegments(
  itineraryTable: ScrapedTable | undefined,
  ticketTable: ScrapedTable | undefined,
  penaltyTable: ScrapedTable | undefined,
): ScrapedNovoairSegment[] {
  if (!itineraryTable) return [];
  const ticketDetailRows =
    ticketTable?.rows.filter(
      (row) => row.length >= 8 && /^[A-Z0-9]{2}-?\d{1,4}$/i.test(row[1] ?? ""),
    ) ?? [];
  const penaltyRows = penaltyTable?.rows.slice(1) ?? [];

  const segments: ScrapedNovoairSegment[] = [];

  itineraryTable.rows.slice(2).forEach((row, index) => {
    const flightInfo = parseFlightInfo(row[1] ?? "");
    if (!flightInfo) return;
    const ticketRow =
      ticketDetailRows.find(
        (item) => cleanText(item[1]) === cleanText(row[2]),
      ) ??
      ticketDetailRows[index] ??
      [];
    const dateValue = cleanText(ticketRow[3]) || cleanText(row[0]);
    const departureTime = buildDateTime(dateValue, flightInfo.departureClock);
    let arrivalTime = buildDateTime(dateValue, flightInfo.arrivalClock);
    if (
      arrivalTime &&
      departureTime &&
      new Date(arrivalTime).getTime() <= new Date(departureTime).getTime()
    ) {
      arrivalTime = addOneDay(arrivalTime);
    }
    const flight = parseFlightNumber(row[2] ?? "");
    const penaltyRow = penaltyRows[index] ?? penaltyRows[0] ?? [];
    const segment: ScrapedNovoairSegment = {
      departureCity: flightInfo.departureCity,
      arrivalCity: flightInfo.arrivalCity,
      departureCode: flightInfo.departureCode,
      arrivalCode: flightInfo.arrivalCode,
      departureTime,
      arrivalTime,
      flightCarrier: flight.carrier,
      flightNumber: flight.number,
      cabin: cleanText(row[3]) || "ECONOMY",
      equipment: cleanText(row[4]),
      exchangeRules: parseFeeRules(penaltyRow[1]),
      refundRules: parseFeeRules(penaltyRow[2]),
    };
    const fareFamily = cleanText(ticketRow[4]);
    const baggageAllowance = formatAllowance(ticketRow[5]);
    const fareBasis = cleanText(ticketRow[6]);
    if (fareFamily) segment.fareFamily = fareFamily;
    if (baggageAllowance) segment.baggageAllowance = baggageAllowance;
    if (fareBasis) segment.fareBasis = fareBasis;
    segments.push(segment);
  });

  return segments;
}

function parseFareTotals(
  fareTable: ScrapedTable | undefined,
  passengers: ScrapedNovoairPassenger[],
) {
  const row = fareTable?.rows.find(
    (item) => cleanText(item[0]).toLowerCase() === "ticket sale",
  );
  const baseFareTotal = parseAmount(row?.[1]);
  const surchargesTotal = parseAmount(row?.[2]);
  const taxesTotal = parseAmount(row?.[3]);
  const feesTotal = parseAmount(row?.[4]);
  const otherTotal = parseAmount(row?.[5]);
  const rowTotal = parseAmount(row?.[6]);
  const passengerTotal = passengers.reduce(
    (sum, passenger) => sum + passenger.price,
    0,
  );

  return {
    baseFareTotal:
      baseFareTotal ||
      Math.max(0, passengerTotal - taxesTotal - feesTotal - surchargesTotal),
    taxTotal: taxesTotal,
    otherFeeTotal: surchargesTotal + feesTotal + otherTotal,
    totalAmount: rowTotal || passengerTotal,
  };
}

function parseStatus(passengers: ScrapedNovoairPassenger[]): string {
  const statuses = passengers
    .map((passenger) => passenger.status?.toLowerCase() ?? "")
    .join(" ");
  if (/\b(cancel|void|refund)\b/.test(statuses)) return "Cancelled";
  if (/\b(used|ok|confirmed|issued)\b/.test(statuses)) return "Confirmed";
  return "Confirmed";
}

function parseCabinBaggage(pageText: string): string | undefined {
  const match = pageText.match(/CABIN BAGGAGE\s*-\s*([0-9]+\s*Kg)/i);
  return match?.[1] ? cleanText(match[1]) : undefined;
}

function parsePhoneNumber(pageText: string): string | undefined {
  const match = pageText.match(/\+?880[\d\s-]{8,}/);
  return match?.[0] ? cleanText(match[0]) : undefined;
}

function parseScrapedBooking(
  data: ScrapedPageData,
  requestedReference: string,
  requestedLastName: string,
): ScrapedNovoairBooking {
  const itineraryTable = findTableByHeader(data.tables, [
    "date",
    "flight info",
    "flight number",
  ]);
  const ticketTable = findTableByHeader(data.tables, [
    "ticket #",
    "fare basis",
    "status",
  ]);
  const penaltyTable = findTableByHeader(data.tables, [
    "trip segment",
    "change fees",
    "cancel fees",
  ]);
  const fareTable = findTableByHeader(data.tables, [
    "description",
    "base fare",
    "taxes",
    "total",
  ]);

  const reference =
    data.pageText.match(/BOOKING #\s+([A-Z0-9]{6})/i)?.[1]?.toUpperCase() ??
    requestedReference.trim().toUpperCase();
  const passengers = parsePassengers(ticketTable, requestedLastName);
  const segments = parseSegments(itineraryTable, ticketTable, penaltyTable);
  const fareTotals = parseFareTotals(fareTable, passengers);

  const booking: ScrapedNovoairBooking = {
    reference,
    status: parseStatus(passengers),
    passengers,
    segments,
    ...fareTotals,
    finalUrl: data.finalUrl,
    pageText: data.pageText,
  };
  const supplierReference = data.hiddenInputs.pnrRef;
  const phoneNumber = parsePhoneNumber(data.pageText);
  const paymentDate = parsePaymentDate(data.pageText);
  const cabinBaggageAllowance = parseCabinBaggage(data.pageText);
  if (supplierReference) booking.supplierReference = supplierReference;
  if (phoneNumber) booking.phoneNumber = phoneNumber;
  if (paymentDate) booking.paymentDate = paymentDate;
  if (cabinBaggageAllowance)
    booking.cabinBaggageAllowance = cabinBaggageAllowance;
  return booking;
}

function buildMissingFields(scraped: ScrapedNovoairBooking): string[] {
  const missing: string[] = [];
  if (scraped.segments.some((segment) => !segment.departureTime)) {
    missing.push("departure.aircraftScheduledDateTime");
  }
  if (scraped.segments.some((segment) => !segment.arrivalTime)) {
    missing.push("arrival.aircraftScheduledDateTime");
  }
  if (!scraped.passengers.length) missing.push("paxList");
  if (!scraped.phoneNumber) missing.push("contactDetail.phoneNumber");
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

function buildOrderResponse(
  scraped: ScrapedNovoairBooking,
  missingFields: string[],
): OrderCreateApiResponse {
  const paxCount = Math.max(1, scraped.passengers.length);
  const baseFarePerPax =
    Math.round((scraped.baseFareTotal / paxCount) * 100) / 100;
  const taxPerPax = Math.round((scraped.taxTotal / paxCount) * 100) / 100;
  const otherFeePerPax =
    Math.round((scraped.otherFeeTotal / paxCount) * 100) / 100;
  const totalAmount =
    scraped.totalAmount ||
    scraped.baseFareTotal + scraped.taxTotal + scraped.otherFeeTotal;
  const firstSegment = scraped.segments[0];
  const fallbackPassenger: ScrapedNovoairPassenger = {
    title: "",
    givenName: "",
    surname: "",
    gender: "",
    price: totalAmount,
  };
  const passengers = scraped.passengers.length
    ? scraped.passengers
    : [fallbackPassenger];

  const order: OrderCreateResponse = {
    orderReference: scraped.reference,
    orderItem: [
      {
        validatingCarrier: firstSegment?.flightCarrier || "VQ",
        refundable: scraped.segments.some(
          (segment) => segment.refundRules.length > 0,
        ),
        fareType: firstSegment?.fareFamily || "NOVOAIR Manage Booking",
        paxSegmentList: scraped.segments.map((segment, index) => ({
          paxSegment: {
            departure: {
              iatA_LocationCode: segment.departureCode,
              aircraftScheduledDateTime: segment.departureTime,
            },
            arrival: {
              iatA_LocationCode: segment.arrivalCode,
              aircraftScheduledDateTime: segment.arrivalTime,
            },
            marketingCarrierInfo: {
              carrierDesigCode: segment.flightCarrier || "VQ",
              marketingCarrierFlightNumber: segment.flightNumber,
              carrierName: "NOVOAIR",
            },
            operatingCarrierInfo: {
              carrierDesigCode: segment.flightCarrier || "VQ",
              carrierName: "NOVOAIR",
            },
            iatA_AircraftType: {
              iatA_AircraftTypeCode: segment.equipment,
            },
            rbd: segment.fareBasis || "",
            flightNumber: segment.flightNumber,
            segmentGroup: index,
            returnJourney: scraped.segments.length > 1,
            airlinePNR: scraped.reference,
            technicalStopOver: null,
            cabinType: segment.cabin.toLowerCase().includes("economy")
              ? "Economy"
              : segment.cabin,
          },
        })),
        fareDetailList: [
          {
            fareDetail: {
              baseFare: baseFarePerPax,
              tax: taxPerPax,
              otherFee: otherFeePerPax,
              discount: 0,
              vat: 0,
              currency: "BDT",
              paxType: "ADT",
              paxCount,
              subTotal: totalAmount,
            },
          },
        ],
        price: {
          totalPayable: money(totalAmount),
          gross: money(totalAmount),
          discount: money(0),
          totalVAT: money(0),
        },
        baggageAllowanceList: scraped.segments.map((segment) => ({
          baggageAllowance: {
            departure: segment.departureCode,
            arrival: segment.arrivalCode,
            checkIn: segment.baggageAllowance
              ? [{ paxType: "ADT", allowance: segment.baggageAllowance }]
              : [],
            cabin: scraped.cabinBaggageAllowance
              ? [{ paxType: "ADT", allowance: scraped.cabinBaggageAllowance }]
              : [],
          },
        })),
        penalty: {
          refundPenaltyList: scraped.segments.map((segment) => ({
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
          exchangePenaltyList: scraped.segments.map((segment) => ({
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
    paxList: passengers.map((passenger) => ({
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
      phoneNumber: scraped.phoneNumber ?? "",
      emailAddress: "",
    },
    orderStatus: scraped.status,
    supplier: "NOVOAIR",
    importSource: "IMP_EXP",
    supplierBookingUrl: scraped.finalUrl,
    ...(scraped.supplierReference
      ? { supplierOriginalReference: scraped.supplierReference }
      : {}),
    supplierMissingFields: missingFields,
  };

  const now = new Date().toISOString();
  return {
    message: null,
    requestedOn: now,
    respondedOn: scraped.paymentDate ?? now,
    response: order,
    statusCode: "Success",
    success: true,
    error: null,
    info: {
      supplier: "NOVOAIR",
      source: "NOVOAIR Manage Booking",
      missingFields,
    },
  };
}

async function readNovoairPage(
  reference: string,
  lastName: string,
  sourceUrl?: string,
): Promise<ScrapedNovoairBooking> {
  const launchConfig = await resolveChromiumLaunchConfig([
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ]);

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
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      viewport: { width: 1365, height: 900 },
    });
    const page = await context.newPage();
    await page.goto(sourceUrl?.trim() || DEFAULT_RETRIEVE_BOOKING_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => undefined);
    await page.fill('input[name="pnr"]', reference);
    await page.fill('input[name="passengerName"]', lastName);
    await Promise.all([
      page
        .waitForURL("**/view_reservation.aspx?PNR=*", { timeout: 30000 })
        .catch(() => undefined),
      page.click('input[type="submit"]'),
    ]);
    await page
      .waitForLoadState("networkidle", { timeout: 15000 })
      .catch(() => undefined);

    const data = await page.evaluate<ScrapedPageData>(`(() => {
      const clean = (value) => (value || '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      return {
        finalUrl: window.location.href,
        pageText: (document.body && document.body.innerText) || '',
        hiddenInputs: Object.fromEntries(
          Array.from(document.querySelectorAll('input[type="hidden"]')).map((input) => [
            input.name,
            input.value,
          ]),
        ),
        tables: Array.from(document.querySelectorAll('table')).map((table) => ({
          rows: Array.from(table.rows).map((row) =>
            Array.from(row.cells).map((cell) => clean(cell.textContent)),
          ),
        })),
      };
    })()`);

    await context.close();
    await browser.close();
    browser = null;

    if (
      !data.finalUrl.includes("/view_reservation.aspx") ||
      !/BOOKING #/i.test(data.pageText)
    ) {
      throw new Error(
        "NOVOAIR booking was not found or the website did not open booking details",
      );
    }

    return parseScrapedBooking(data, reference, lastName);
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

export async function importNovoairManageBooking(params: {
  reference: string;
  lastName: string;
  sourceUrl?: string;
}): Promise<NovoairImportResult> {
  const reference = params.reference.trim().toUpperCase();
  const lastName = params.lastName.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(reference)) {
    throw new Error("NOVOAIR reservation number must be 6 characters");
  }
  if (!lastName) {
    throw new Error("Last name is required for NOVOAIR import");
  }

  const scraped = await readNovoairPage(reference, lastName, params.sourceUrl);
  const missingFields = buildMissingFields(scraped);
  return {
    scraped,
    missingFields,
    apiResponse: buildOrderResponse(scraped, missingFields),
  };
}
