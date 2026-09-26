import { isTriploverSupplier, type TriploverSupplier } from '@/lib/triplover/config';

/** Flight suppliers. Shapontravels currently supports search and held bookings. */
export type FlightReadSupplier = TriploverSupplier | 'shapontravels';

export function isFlightReadSupplier(value: unknown): value is FlightReadSupplier {
  return value === 'shapontravels' || isTriploverSupplier(value);
}
