/** Sources that use the external-booking lifecycle without being Triplover writes. */
export const EXTERNAL_BOOKING_SOURCES = ["IMP_EXP", "MANUAL"] as const;

export type ExternalBookingSource = (typeof EXTERNAL_BOOKING_SOURCES)[number];

export function isExternalBookingSource(
  value: string | null | undefined,
): value is ExternalBookingSource {
  return value === "IMP_EXP" || value === "MANUAL";
}

/** A manually entered booking is never safe to send to a supplier API. */
export function isManualBookingSource(
  value: string | null | undefined,
): boolean {
  return value === "MANUAL";
}
