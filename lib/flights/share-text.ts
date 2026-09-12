import { dateOf, timeOf, formatDuration, legDurationMinutes, type FlightFareOption } from './types';

const shareDate = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
});

export function itineraryShareText(option: FlightFareOption, currency: string, airportCities: Record<string, string> = {}): string {
  const journeys = option.legs.map((leg) => {
    const departureDate = dateOf(leg.departure);
    const arrivalDate = dateOf(leg.arrival);
    const parsedDate = new Date(`${departureDate}T00:00:00Z`);
    const date = Number.isNaN(parsedDate.getTime())
      ? departureDate
      : shareDate.format(parsedDate).replace('Sept', 'Sep');
    const duration = legDurationMinutes(leg);
    const stops = leg.stops === 0 ? 'Non stop' : `${leg.stops} stop${leg.stops === 1 ? '' : 's'}`;
    const arrival = `${timeOf(leg.arrival)}${arrivalDate !== departureDate ? ` (${arrivalDate})` : ''}`;
    return [
      `🛫 ${airportCities[leg.from] || leg.from} → ${airportCities[leg.to] || leg.to}`,
      `📅 ${date}`,
      `🕐 ${timeOf(leg.departure)} → ${arrival}  •  ${duration === null ? 'Duration unavailable' : formatDuration(duration)}  •  ${stops}`,
    ].join('\n');
  });
  const fare = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(option.totalPrice);
  return [
    `✈️ ${option.carrierName}`,
    journeys.join('\n\n'),
    '',
    `💰 ${fare} ${currency}`,
    option.refundable ? '✅ Refundable' : '❌ Non-refundable',
  ].join('\n');
}
