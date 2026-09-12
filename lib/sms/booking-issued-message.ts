import { airlineNameForCode } from '@/lib/airlines/catalog';

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function cleanText(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function itineraryLegs(value: unknown): UnknownRecord[] {
  const itinerary = record(value);
  const legs = itinerary?.legs;
  return Array.isArray(legs)
    ? legs.map(record).filter((leg): leg is UnknownRecord => Boolean(leg))
    : [];
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

function departureDateTime(
  value: unknown
): { date: string; time: string } | null {
  const text = cleanText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(text);
  if (!match) return null;
  const month = MONTHS[Number(match[2]) - 1];
  const year = match[1];
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = match[5];
  if (!month || !Number.isInteger(day) || day < 1 || day > 31 || hour > 23) {
    return null;
  }
  const displayHour = hour % 12 || 12;
  return {
    date: `${day} ${month} ${year}`,
    time: `${displayHour}:${minute} ${hour < 12 ? 'AM' : 'PM'}`,
  };
}

function fareLine(currencyValue: unknown, fareValue: unknown): string {
  const currency = cleanText(currencyValue).toUpperCase() || 'BDT';
  const rawFare = cleanText(fareValue);
  const fare = typeof fareValue === 'number'
    ? fareValue
    : rawFare
      ? Number(rawFare)
      : Number.NaN;
  if (!Number.isFinite(fare)) return `Fare: ${currency} --`;
  return `Fare: ${currency} ${fare.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

/** Builds the compact customer copy from the event-time immutable snapshot. */
export function bookingIssuedSmsMessage(value: unknown): string {
  const snapshot = record(value);
  if (!snapshot || snapshot.version !== 1) {
    throw new Error('Issued SMS snapshot is invalid.');
  }

  const passengerName = cleanText(snapshot.passengerName);
  const rawPnr = cleanText(snapshot.pnr);
  const pnr = rawPnr.length > 2 ? rawPnr : 'Not available';
  const airlineCode = cleanText(snapshot.airlineCode).toUpperCase();
  const airline = airlineNameForCode(airlineCode)
    || cleanText(snapshot.airlineName)
    || airlineCode
    || 'Airline';
  const lines = [
    'Dear Client,',
    'Your ticket has been successfully issued.',
    airline,
    `${snapshot.pnrType === 'airline' ? 'Airline PNR' : 'PNR'}: ${pnr}${passengerName ? ` | ${passengerName}` : ''}`,
  ];

  for (const leg of itineraryLegs(snapshot.itinerary)) {
    const from = cleanText(leg.from).toUpperCase();
    const to = cleanText(leg.to).toUpperCase();
    const dateTime = departureDateTime(leg.departure);
    if (from && to && dateTime) lines.push(`${dateTime.date} | ${from}-${to} | ${dateTime.time}`);
    else if (from && to) lines.push(`${from}-${to}`);
  }

  lines.push(fareLine(snapshot.currency, snapshot.grossAmount));
  return lines.join('\n');
}
