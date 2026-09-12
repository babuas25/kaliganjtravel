/**
 * Shortlist shown before the visitor types anything. Lives on its own so both
 * the API route (which flags these as popular) and the client (which shows them
 * while the first request is still in flight) can read it.
 */
export const POPULAR_BANGLADESH_AIRPORTS = [
  {
    iata: 'DAC',
    name: 'Hazrat Shahjalal International Airport',
    city: 'Dhaka',
    country: 'Bangladesh',
  },
  {
    iata: 'CGP',
    name: 'Shah Amanat International Airport',
    city: 'Chittagong',
    country: 'Bangladesh',
  },
  { iata: 'ZYL', name: 'Osmany International Airport', city: 'Sylhet', country: 'Bangladesh' },
  { iata: 'CXB', name: "Cox's Bazar Airport", city: "Cox's Bazar", country: 'Bangladesh' },
  { iata: 'JSR', name: 'Jessore Airport', city: 'Jessore', country: 'Bangladesh' },
  { iata: 'SPD', name: 'Saidpur Airport', city: 'Saidpur', country: 'Bangladesh' },
  { iata: 'RJH', name: 'Rajshahi Airport', city: 'Rajshahi', country: 'Bangladesh' },
  { iata: 'BZL', name: 'Barisal Airport', city: 'Barisal', country: 'Bangladesh' },
];

/** Long-haul hubs used to pad the empty-query list out to a full dropdown. */
export const POPULAR_INTERNATIONAL_IATAS = [
  'LHR',
  'JFK',
  'DXB',
  'SIN',
  'BKK',
  'CDG',
  'NRT',
  'LAX',
];
