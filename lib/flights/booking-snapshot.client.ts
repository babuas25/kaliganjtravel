'use client';

import type { FlightBookingItinerarySnapshot } from '@/lib/flights/types';

const STORAGE_PREFIX = 'kaliganj-flight-booking-snapshot:';

function key(searchId: string, itineraryId: string): string {
  return `${STORAGE_PREFIX}${searchId}:${itineraryId}`;
}

/**
 * Carries the already-public selected itinerary across Clerk sign-in. It is
 * deliberately only a browser convenience: Prepare treats it as untrusted and
 * accepts it solely after the Redis-held digest matches exactly.
 */
export function saveBookingSnapshot(
  searchId: string,
  itineraryId: string,
  itinerary: FlightBookingItinerarySnapshot
): boolean {
  try {
    window.sessionStorage.setItem(key(searchId, itineraryId), JSON.stringify(itinerary));
    return true;
  } catch {
    return false;
  }
}

export function readBookingSnapshot(
  searchId: string,
  itineraryId: string
): unknown | null {
  try {
    const raw = window.sessionStorage.getItem(key(searchId, itineraryId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearBookingSnapshot(searchId: string, itineraryId: string): void {
  try {
    window.sessionStorage.removeItem(key(searchId, itineraryId));
  } catch {
    // The confirmed server-side attempt is still authoritative.
  }
}
