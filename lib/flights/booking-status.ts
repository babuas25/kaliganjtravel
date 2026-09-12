/**
 * The seven booking statuses the business runs on.
 *
 * Every consumer — the application, reporting, filtering, analytics, exports
 * and admin tooling — resolves to exactly one of these. The operational states
 * (`draft`, `submitting`, `succeeded`, `failed`, `unknown`) belong to
 * `booking_attempts` and appear nowhere in this file, because they are not
 * things a customer holds.
 *
 * Five are decided and stored in `flight_bookings.status`. The authoritative
 * read projection is the database `booking_lifecycle_v`. This module mirrors
 * its seven-value contract for TypeScript and provides a fallback only for a
 * writer-returned row that has not yet been re-read through that view.
 *
 * See BOOKING_ARCHITECTURE.md §2.3.
 */

export const BOOKING_STATUSES = [
  'on-hold',
  'pending',
  'in-progress',
  'confirmed',
  'expired',
  'unconfirmed',
  'cancelled',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

const BOOKING_STATUS_SET = new Set<string>(BOOKING_STATUSES);

/** Runtime boundary for database, supplier, queue, and JSON values. */
export function isBookingStatus(value: unknown): value is BookingStatus {
  return typeof value === 'string' && BOOKING_STATUS_SET.has(value);
}

export const BOOKING_STATUS_LABELS: Record<BookingStatus, string> = {
  'on-hold': 'On Hold',
  pending: 'Pending',
  'in-progress': 'In Progress',
  confirmed: 'Confirmed',
  expired: 'Expired',
  unconfirmed: 'Unconfirmed',
  cancelled: 'Cancelled',
};

/** What `flight_bookings.status` may hold — the decided states only. */
export const STORED_BOOKING_STATUSES = [
  'on-hold',
  'pending',
  'in-progress',
  'confirmed',
  'cancelled',
] as const;

export type StoredBookingStatus = (typeof STORED_BOOKING_STATUSES)[number];

export type BookingStatusInput = {
  /** The decided state, straight from the column. */
  status: StoredBookingStatus;
  /** The airline's own PNR(s). Empty means the airline never confirmed. */
  airlinesPnr: string[];
  /**
   * The ticketing deadline as a real instant, parsed once when the booking was
   * written. Null when the supplier gave none, in which case the booking never
   * derives Expired — see BOOKING_ARCHITECTURE.md §11.1.
   */
  ticketingDeadlineAt: string | null;
  /** Injectable so the derivation stays testable. */
  now?: number;
};

/**
 * Fallback business-status derivation for writer-returned rows.
 *
 * Order matters. A decided state outranks anything computed — an admin who
 * cancelled a booking has said something supplier data cannot contradict — and
 * a missing airline PNR outranks a passed deadline, because a booking the
 * airline never confirmed is Un-Confirmed whether or not its deadline has
 * since gone by.
 */
export function deriveBookingStatus({
  status,
  airlinesPnr,
  ticketingDeadlineAt,
  now = Date.now(),
}: BookingStatusInput): BookingStatus {
  // Only a live hold is open to being re-read; the rest are already decided.
  if (status !== 'on-hold') return status;

  if (airlinesPnr.length === 0) return 'unconfirmed';

  const deadline = ticketingDeadlineAt
    ? Date.parse(ticketingDeadlineAt)
    : Number.NaN;
  if (Number.isFinite(deadline) && deadline <= now) return 'expired';

  return 'on-hold';
}

/**
 * Uses a trusted seven-value database projection when present, otherwise
 * derives from stored booking facts. Internal operation/attempt/case states
 * can never pass this customer-facing boundary.
 */
export function resolvePublicBookingStatus(
  input: BookingStatusInput & { lifecycleStatus?: unknown }
): BookingStatus {
  return isBookingStatus(input.lifecycleStatus)
    ? input.lifecycleStatus
    : deriveBookingStatus(input);
}
