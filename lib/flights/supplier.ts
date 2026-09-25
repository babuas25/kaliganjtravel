import { isTriploverSupplier, type TriploverSupplier } from '@/lib/triplover/config';

/** Search/read suppliers. Booking remains restricted to TriploverSupplier. */
export type FlightReadSupplier = TriploverSupplier | 'shapontravels';

export function isFlightReadSupplier(value: unknown): value is FlightReadSupplier {
  return value === 'shapontravels' || isTriploverSupplier(value);
}
