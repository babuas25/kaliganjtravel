/** Only automatic list refreshes share this short freshness window. */
export const BOOKING_LIST_FRESHNESS_MS = 30_000;

export function bookingListNeedsRefresh({
  serverLoadedAt,
  lastRefreshRequestedAt,
  now,
}: {
  serverLoadedAt: number;
  lastRefreshRequestedAt: number | null;
  now: number;
}): boolean {
  // A recent request or received snapshot suppresses paired browser events.
  // A backwards client-clock change must not extend this window indefinitely.
  const requestAge = lastRefreshRequestedAt === null ? Infinity : now - lastRefreshRequestedAt;
  if (requestAge >= 0 && requestAge < BOOKING_LIST_FRESHNESS_MS) return false;

  const dataAge = now - serverLoadedAt;
  // Material clock skew or an invalid timestamp cannot establish freshness.
  return !Number.isFinite(dataAge) ||
    dataAge < -BOOKING_LIST_FRESHNESS_MS ||
    dataAge >= BOOKING_LIST_FRESHNESS_MS;
}
