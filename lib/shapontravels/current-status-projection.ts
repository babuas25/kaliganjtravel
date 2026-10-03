import { parseShapontravelsCurrentStatus, type ShapontravelsCurrentStatus } from './booking-status';
import { isBookingStatus, type BookingStatus } from '@/lib/flights/booking-status';

export type ShapontravelsCurrentStatusProjection = {
  currentStatus: ShapontravelsCurrentStatus;
  originalBookingStatus: string | null;
  fetchedAt: string;
  effectiveStatus: BookingStatus;
  reviewRequired: boolean;
};

/** Optional metadata during an application/database rollout. */
export function parseShapontravelsCurrentStatusProjection(
  value: unknown
): ShapontravelsCurrentStatusProjection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  const currentStatus = parseShapontravelsCurrentStatus(saved.currentStatus);
  if (!currentStatus || !isBookingStatus(saved.effectiveStatus) ||
      typeof saved.reviewRequired !== 'boolean' || typeof saved.fetchedAt !== 'string' ||
      !Number.isFinite(Date.parse(saved.fetchedAt)) ||
      !(saved.originalBookingStatus === null ||
        (typeof saved.originalBookingStatus === 'string' && saved.originalBookingStatus.length <= 100))) {
    return null;
  }
  return {
    currentStatus,
    originalBookingStatus: saved.originalBookingStatus as string | null,
    fetchedAt: saved.fetchedAt,
    effectiveStatus: saved.effectiveStatus,
    reviewRequired: saved.reviewRequired,
  };
}

/** Supplier confirmation is not proof of local ticket/payment completion. */
export function shapontravelsCurrentStatusBlocksIssue(booking: {
  supplier?: string;
  shapon_current_status?: unknown;
}): boolean {
  if (booking.supplier !== 'shapontravels' || booking.shapon_current_status == null) return false;
  const saved = parseShapontravelsCurrentStatusProjection(booking.shapon_current_status);
  return !saved || saved.currentStatus.status !== 'on-hold' || saved.reviewRequired ||
    saved.currentStatus.reviewRequired === true;
}
