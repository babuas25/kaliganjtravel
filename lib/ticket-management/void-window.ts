const DHAKA_UTC_OFFSET_MS = 6 * 60 * 60 * 1000;
const VOID_CUTOFF_HOUR = 23;
const VOID_CUTOFF_MINUTE = 30;

function validDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Returns the 23:30 Asia/Dhaka cutoff on the same local calendar day as issue.
 * Bangladesh is UTC+06:00 year-round and does not observe daylight saving time.
 */
export function ticketVoidRequestDeadline(
  issuedAt?: string | null
): Date | null {
  const issued = validDate(issuedAt);
  if (!issued) return null;

  const issuedInDhaka = new Date(issued.getTime() + DHAKA_UTC_OFFSET_MS);
  return new Date(
    Date.UTC(
      issuedInDhaka.getUTCFullYear(),
      issuedInDhaka.getUTCMonth(),
      issuedInDhaka.getUTCDate(),
      VOID_CUTOFF_HOUR,
      VOID_CUTOFF_MINUTE
    ) - DHAKA_UTC_OFFSET_MS
  );
}

export function isTicketVoidRequestOpen(
  issuedAt?: string | null,
  now = new Date()
): boolean {
  const issued = validDate(issuedAt);
  const deadline = ticketVoidRequestDeadline(issuedAt);
  if (!issued || !deadline || Number.isNaN(now.getTime())) return false;

  return now.getTime() >= issued.getTime() && now.getTime() < deadline.getTime();
}
