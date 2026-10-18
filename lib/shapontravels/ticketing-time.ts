import type { ShapontravelsBookingRead } from './client';
import { evidenceTime, verifyShapontravelsBookingStatus, type ShapontravelsExpectedBooking } from './booking-status';

export type ShapontravelsTicketingTime = {
  rawLastTicketTime: string | null;
  ticketingDeadlineAt: string | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Identity-bound saved API deadline; never parse or guess supplier-local text. */
export function shapontravelsTicketingTime(
  read: ShapontravelsBookingRead, expected: ShapontravelsExpectedBooking,
): ShapontravelsTicketingTime | null {
  if (read.httpStatus !== 200 || !expected.bookingCodeRef || !expected.pnr || !expected.supplierPublicRef ||
      verifyShapontravelsBookingStatus(read, expected).result !== 'verified') return null;
  const body = object(read.body);
  const receipt = object(body?.publicReceipt);
  const deadline = object(receipt?.deadline);
  // Missing or malformed evidence is distinct from an explicitly unknown time.
  if (!deadline || !Object.hasOwn(deadline, 'iso')) return null;
  const iso = evidenceTime(deadline.iso);
  if (iso === undefined || (iso === null ? deadline.timeZone !== null : deadline.timeZone !== 'Asia/Dhaka')) return null;
  const item = object(body?.item1);
  for (const field of ['ticketingTimeLimit', 'lastTicketTime', 'lastTicketTimeIso']) {
    if (!item || !Object.hasOwn(item, field)) continue;
    const alias = evidenceTime(item[field]);
    if (alias === undefined || (iso === null ? alias !== null
      : alias === null || Date.parse(alias) !== Date.parse(iso))) return null;
  }
  // Use the canonical instant for both fields; raw display text has no authority.
  return { rawLastTicketTime: iso, ticketingDeadlineAt: iso };
}
