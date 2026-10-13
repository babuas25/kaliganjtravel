import type { TicketIssueInput } from '@/lib/triplover/ticket';

type Row = Record<string, unknown>;
type VerifiedIndigoTicket = {
  ticketNumbers: string[];
  airlinesPnr: string[];
  ticketCodeRef: string | null;
  passengerTickets: string[][];
};

const passengerTypes = ['ADT', 'CHD', 'CNN', 'INF', 'INS'] as const;
const locator = /^[A-Z0-9]{6}$/;
const numericTicket = /^\d{10,16}$/;

function record(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalized(value: unknown): string {
  return text(value).toUpperCase().replace(/\s+/g, ' ');
}

function validIssueDate(value: unknown): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(text(value));
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour && parsed.getUTCMinutes() === minute && parsed.getUTCSeconds() === second;
}

function money(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value))) return null;
  const amount = Number(value);
  const minor = Math.round(amount * 100);
  return Number.isFinite(amount) && amount >= 0 && Number.isSafeInteger(minor) &&
    Math.abs(amount * 100 - minor) < 0.0001 ? minor : null;
}

function identifiers(value: unknown): string[] | null {
  const values = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(values) || values.some(item => typeof item !== 'string' || !item.trim())) return null;
  const result = values.map(item => (item as string).trim());
  return result.length > 0 && new Set(result).size === result.length ? result : null;
}

function savedContext(input: TicketIssueInput) {
  const saved = input.savedBooking;
  const itinerary = saved?.itinerary;
  const rawPeople = saved?.passengers;
  const people = Array.isArray(rawPeople) ? rawPeople : record(rawPeople).travellers;
  if (!saved || itinerary?.carrierCode !== '6E' || !Array.isArray(itinerary.legs) || itinerary.legs.length === 0 ||
      !itinerary.legs.every(leg => leg && Array.isArray(leg.segments) && leg.segments.length > 0 &&
        leg.segments.every(segment => segment && segment.airlineCode === '6E' &&
          segment.codeshare !== true && (!segment.operatingCarrierCode || segment.operatingCarrierCode === '6E')))) return null;
  const pnrs = identifiers(saved.airlinePnrs);
  if (!pnrs || !pnrs.every(pnr => locator.test(pnr)) ||
      !Number.isInteger(input.expectedPassengerCount) || !input.expectedPassengerCount ||
      !Array.isArray(people) || people.length !== input.expectedPassengerCount ||
      !Array.isArray(saved.fares) || saved.fares.length === 0) return null;
  const fares = saved.fares.map(record);
  if (fares.some(fare => !passengerTypes.includes(fare.passengerType as typeof passengerTypes[number]) ||
      !Number.isInteger(fare.count) || Number(fare.count) <= 0 || money(fare.taxes) === null || money(fare.ait) === null) ||
      new Set(fares.map(fare => fare.passengerType)).size !== fares.length ||
      fares.reduce((count, fare) => count + Number(fare.count), 0) !== input.expectedPassengerCount ||
      money(saved.supplierTotalPrice) === null || money(saved.grossPrice) === null) return null;
  const passengers = people.map(record);
  const identityCounts = new Map<string, number>();
  for (const passenger of passengers) {
    if (!passengerIdentity(passenger)) return null;
    const type = normalized(passenger.passengerType);
    identityCounts.set(type, (identityCounts.get(type) ?? 0) + 1);
  }
  if (fares.some(fare => identityCounts.get(String(fare.passengerType)) !== fare.count)) return null;
  return { saved, itinerary, pnrs, fares, passengers };
}

function passengerIdentity(passenger: Row): string | null {
  const name = record(passenger.nameElement);
  const first = normalized(name.firstName ?? passenger.firstName ?? passenger.first);
  const last = normalized(name.lastName ?? passenger.lastName ?? passenger.last);
  const middle = normalized(name.middleName ?? passenger.middle);
  const type = normalized(passenger.passengerType);
  return last && passengerTypes.includes(type as typeof passengerTypes[number])
    ? JSON.stringify([first, last, middle, type]) : null;
}

function matchesPassenger(expected: Row, actual: Row, supplier: string): boolean {
  // Triplover can label a saved CNN passenger CHD; verified fare counts remain CNN.
  const supplied = supplier === 'triplover' && expected.passengerType === 'CNN' && actual.passengerType === 'CHD'
    ? { ...actual, passengerType: 'CNN' } : actual;
  return passengerIdentity(expected) === passengerIdentity(supplied);
}

function compatibleReferences(raw: Row, input: TicketIssueInput): boolean {
  return [
    ['uniqueTransID', input.uniqueTransId], ['itemCodeRef', input.itemCodeRef],
    ['priceCodeRef', input.priceCodeRef], ['bookingCodeRef', input.bookingCodeRef],
  ].every(([key, expected]) => raw[key] == null || raw[key] === '' || raw[key] === expected);
}

/** A corroborating read must never conceal a response for a different booking. */
export function canVerifyIndigoIssueResponse(value: unknown, input: TicketIssueInput): boolean {
  const raw = record(value);
  return Boolean(savedContext(input) && raw.pnr === input.pnr && text(raw.ticketCodeRef) &&
    compatibleReferences(raw, input) && !['CANCELLED', 'CANCELED', 'REFUNDED'].includes(normalized(raw.status)));
}

function sameSegment(raw: Row, expected: Row, report: boolean): boolean {
  const carrier = raw.airlineCode ?? raw.operationCarrier;
  const departure = text(raw.departure).replace('T', ' ');
  const arrival = text(raw.arrival).replace('T', ' ');
  return raw.isCancelled !== true && raw.isRefunded !== true &&
    raw.isCodeShared !== true && raw.isCodeshare !== true &&
    (raw.operationCarrier == null || raw.operationCarrier === '6E') &&
    (raw.operatingCarrierCode == null || raw.operatingCarrierCode === '6E') &&
    normalized(raw.from ?? raw.origin) === normalized(expected.from) &&
    normalized(raw.to ?? raw.destination) === normalized(expected.to) && carrier === '6E' &&
    normalized(raw.flightNumber) === normalized(expected.flightNumber) &&
    departure === text(expected.departure).replace('T', ' ') &&
    arrival === text(expected.arrival).replace('T', ' ') &&
    normalized(raw.bookingClass ?? (report ? raw.bookingCode : undefined)) === normalized(expected.bookingClass) &&
    (!raw.cabinClass || !expected.cabinClass || normalized(raw.cabinClass) === normalized(expected.cabinClass));
}

function compatibleLocators(value: unknown, pnrs: string[]): boolean {
  if (value == null || value === '') return true;
  const values = identifiers(value);
  return Boolean(values && values.every(pnr => pnrs.includes(pnr)));
}

function sameFlights(raw: Row, context: NonNullable<ReturnType<typeof savedContext>>, report: boolean): boolean {
  if (report) {
    const expected = context.itinerary.legs.flatMap(leg => leg.segments);
    return Array.isArray(raw.segments) && raw.segments.length === expected.length &&
      raw.segments.every((segment, index) => sameSegment(record(segment), record(expected[index]), true) &&
        compatibleLocators(record(segment).airlinePNRs, context.pnrs));
  }
  return Array.isArray(raw.directions) && raw.directions.length === context.itinerary.legs.length &&
    raw.directions.every((group, legIndex) => {
      if (!Array.isArray(group) || group.length !== 1) return false;
      const segments = record(group[0]).segments;
      const expected = context.itinerary.legs[legIndex].segments;
      return Array.isArray(segments) && segments.length === expected.length &&
        segments.every((segment, index) => sameSegment(record(segment), record(expected[index]), false));
    });
}

function sameCounts(raw: unknown, context: NonNullable<ReturnType<typeof savedContext>>): boolean {
  const counts = record(raw);
  if (Object.entries(counts).some(([key, value]) => !passengerTypes.includes(key.toUpperCase() as typeof passengerTypes[number]) ||
      !Number.isInteger(value) || Number(value) < 0)) return false;
  return passengerTypes.every(type => {
    const expected = context.fares.find(fare => fare.passengerType === type)?.count ?? 0;
    return (counts[type.toLowerCase()] ?? counts[type] ?? 0) === expected;
  });
}

function verifiedNumbers(value: unknown, pnrs: string[], numericSeen: Set<string>): string[] | null {
  const values = value == null || value === '' || (Array.isArray(value) && value.length === 0)
    ? pnrs : identifiers(value);
  if (!values) return null;
  for (const number of values) {
    if (numericTicket.test(number)) {
      if (numericSeen.has(number)) return null;
      numericSeen.add(number);
    } else if (!pnrs.includes(number)) return null;
  }
  return values;
}

function orderedTickets(rows: unknown, context: NonNullable<ReturnType<typeof savedContext>>, supplier: string, report: boolean) {
  if (!Array.isArray(rows) || rows.length !== context.passengers.length) return null;
  const ordered: string[][] = [];
  const numericSeen = new Set<string>();
  const suppliedRows: Row[] = [];
  for (const value of rows) {
    const row = record(value);
    const person = report ? row : record(row.passengerInfo);
    const matches = context.passengers.flatMap((passenger, index) => matchesPassenger(passenger, person, supplier) ? [index] : []);
    if (matches.length !== 1 || ordered[matches[0]] || row.isReissued === true) return null;
    // Live Triplover reports repeat the passenger-type party count on each
    // individually named row. Row identities, never that field, determine slots.
    const typeCount = context.fares.find(fare => fare.passengerType === context.passengers[matches[0]].passengerType)?.count;
    if (report && row.passengerCount != null && row.passengerCount !== 1 && row.passengerCount !== typeCount) return null;
    const numbers = verifiedNumbers(row.ticketNumbers, context.pnrs, numericSeen);
    if (!numbers) return null;
    ordered[matches[0]] = numbers;
    suppliedRows[matches[0]] = row;
  }
  return { numbers: ordered.flat(), slots: ordered, rows: suppliedRows };
}

/** Report recovery preserves every identifier already observed for its passenger. */
export function indigoIssueReportMatches(value: unknown, verified: VerifiedIndigoTicket, input: TicketIssueInput): boolean {
  const raw = record(value);
  const context = savedContext(input);
  if (!context || !compatibleLocators(raw.airlinesPNR, context.pnrs)) return false;
  if (raw.ticketInfoes == null) return true;
  const observed = orderedTickets(raw.ticketInfoes, context, input.supplier, false);
  if (!observed) return false;
  return observed.rows.every((row, index) => {
    if (row.ticketNumbers == null || row.ticketNumbers === '' ||
        (Array.isArray(row.ticketNumbers) && row.ticketNumbers.length === 0)) return true;
    const original = identifiers(row.ticketNumbers);
    const recovered = verified.passengerTickets[index];
    return Boolean(original && recovered && original.length === recovered.length && original.every(number => recovered.includes(number)));
  });
}

function moneyCoverage(rows: { type: string; count: number; base: unknown; taxes: unknown; ait: unknown; total: unknown }[],
  context: NonNullable<ReturnType<typeof savedContext>>): boolean {
  let base = 0, taxes = 0, ait = 0, total = 0;
  const coverage = new Map<string, { count: number; taxes: number; ait: number }>();
  for (const row of rows) {
    const amounts = [row.base, row.taxes, row.ait, row.total].map(money);
    if (amounts.some(value => value === null)) return false;
    const [rowBase, rowTaxes, rowAit, rowTotal] = amounts as number[];
    base += rowBase * row.count; taxes += rowTaxes * row.count;
    ait += rowAit * row.count; total += rowTotal * row.count;
    const prior = coverage.get(row.type) ?? { count: 0, taxes: 0, ait: 0 };
    coverage.set(row.type, { count: prior.count + row.count, taxes: prior.taxes + rowTaxes * row.count, ait: prior.ait + rowAit * row.count });
  }
  return [base, taxes, ait, total].every(Number.isSafeInteger) &&
    total === money(context.saved.supplierTotalPrice) && base + taxes + ait === money(context.saved.grossPrice) &&
    coverage.size === context.fares.length && context.fares.every(fare => {
      const actual = coverage.get(String(fare.passengerType));
      return Boolean(actual && actual.count === fare.count && actual.taxes === money(fare.taxes) && actual.ait === money(fare.ait));
    });
}

/** Port of the Rust ticketless policy: a known airline PNR alone never proves issuance. */
export function verifyIndigoIssueReceipt(value: unknown, input: TicketIssueInput): VerifiedIndigoTicket | null {
  const raw = record(value);
  const context = savedContext(input);
  if (!context || raw.pnr !== input.pnr || !text(raw.ticketCodeRef) || !compatibleReferences(raw, input) ||
      !compatibleLocators(raw.airlinesPNR, context.pnrs) ||
      !['ISSUED', 'TICKETED', 'CONFIRMED'].includes(normalized(raw.status)) || raw.isPaid === false) return null;
  const flight = record(raw.flightInfo);
  if (!sameFlights(flight, context, false) || !sameCounts(flight.passengerCounts, context) ||
      (flight.currency != null && flight.currency !== 'BDT') ||
      (flight.totalPrice != null && money(flight.totalPrice) !== money(context.saved.supplierTotalPrice))) return null;
  const fares = record(flight.passengerFares);
  const amounts = context.fares.map(fare => {
    const row = record(fares[String(fare.passengerType).toLowerCase()]);
    return { type: String(fare.passengerType), count: Number(fare.count), base: row.basePrice, taxes: row.taxes, ait: row.ait, total: row.totalPrice };
  });
  if (!moneyCoverage(amounts, context) || !Array.isArray(flight.bookingComponents) || flight.bookingComponents.length !== 1) return null;
  const component = record(flight.bookingComponents[0]);
  if (money(component.totalPrice) !== money(context.saved.supplierTotalPrice) ||
      money(component.taxes) !== context.fares.reduce((sum, fare) => sum + money(fare.taxes)!, 0) ||
      money(component.ait) !== context.fares.reduce((sum, fare) => sum + money(fare.ait)!, 0) ||
      money(component.basePrice) !== amounts.reduce((sum, row) => sum + money(row.base)! * row.count, 0)) return null;
  const tickets = orderedTickets(raw.ticketInfoes, context, input.supplier, false);
  return tickets ? { ticketNumbers: tickets.numbers, airlinesPnr: context.pnrs, ticketCodeRef: text(raw.ticketCodeRef), passengerTickets: tickets.slots } : null;
}

/** Read-only report corroboration; never treats an Active PNR as an issued ticket. */
export function verifyIndigoTicketReport(value: unknown, input: TicketIssueInput): VerifiedIndigoTicket | null {
  const raw = record(value);
  const ticket = record(raw.ticketInfo);
  const context = savedContext(input);
  if (!context || ticket.pnr !== input.pnr || ticket.uniqueTransID !== input.uniqueTransId ||
      !compatibleReferences(ticket, input) || !compatibleLocators(ticket.airlinePNRs, context.pnrs) ||
      ticket.status !== 'Issued' || ticket.statusFor !== 'Ticket' ||
      ticket.isPaid !== true || ticket.isCompleted !== true || ticket.isReissued === true ||
      !validIssueDate(ticket.issueDate) ||
      money(ticket.ticketingPrice) !== money(context.saved.supplierTotalPrice) || !sameFlights(raw, context, true)) return null;
  const tickets = orderedTickets(raw.passengerInfo, context, input.supplier, true);
  if (!tickets) return null;
  const amounts = tickets.rows.map((row, index) => ({
    type: normalized(context.passengers[index].passengerType), count: 1,
    base: row.basePrice, taxes: row.tax, ait: row.ait, total: row.totalPrice,
  }));
  if (tickets.rows.some(row => (row.pnr != null && row.pnr !== input.pnr) ||
      (row.uniqueTransID != null && row.uniqueTransID !== input.uniqueTransId) ||
      (row.currencyName != null && row.currencyName !== 'BDT')) || !moneyCoverage(amounts, context)) return null;
  return { ticketNumbers: tickets.numbers, airlinesPnr: context.pnrs, ticketCodeRef: text(ticket.ticketCodeRef) || null, passengerTickets: tickets.slots };
}
