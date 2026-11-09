import { BOOKING_STATUS_LABELS, type BookingStatus } from '../flights/booking-status';
import type { ShapontravelsBookingStatus } from './booking-status';

export type ShapontravelsStatusStorage = 'saved' | 'unavailable' | 'not_recorded';

export type ShapontravelsStatusCheck = Partial<ShapontravelsBookingStatus> & {
  currentStatusStorage?: ShapontravelsStatusStorage;
  projectionUpdated?: boolean;
  displayStatus?: BookingStatus;
  displayReviewRequired?: boolean;
};

export type ShapontravelsStatusMessage = {
  headline: string;
  details: string[];
};

/** The receipt identity result does not establish current supplier verification. */
export function formatShapontravelsBookingStatus(
  check: ShapontravelsStatusCheck | null | undefined,
  context: 'booking' | 'attempt' = 'booking',
): ShapontravelsStatusMessage {
  let headline = 'Shapon saved booking status unavailable.';
  const details: string[] = [];
  const trustedIdentity = check?.result === 'verified' || check?.result === 'pending';
  const current = trustedIdentity && check?.currentStatusState === 'available'
    ? check.currentStatus : null;

  if (trustedIdentity && check?.supplierPublicRef) {
    details.push(`Supplier reference: ${check.supplierPublicRef}.`);
  }

  if (current) {
    const label = BOOKING_STATUS_LABELS[check?.displayStatus ?? current.status];
    headline = `Shapon saved booking status: ${label}.`;
    if (current.reviewRequired === true || check?.displayReviewRequired === true) {
      details.push('This evidence needs staff review before further booking or financial action.');
    }
  } else if (check?.result === 'not_found') {
    details.push('No saved Shapon booking was found. This is inconclusive; staff must check the Shapon portal.');
  } else if (check?.result === 'mismatch') {
    details.push('The saved Shapon receipt identity did not match this booking. Staff must investigate before using this response.');
  } else if (!trustedIdentity) {
    details.push('The saved Shapon receipt could not be verified. Staff must investigate before using this response.');
  } else if (check?.currentStatusState === 'invalid') {
    details.push('Shapon returned invalid saved-status metadata. The original Book receipt does not establish the saved status.');
  } else {
    if (check?.result === 'pending') {
      details.push('The saved Shapon booking is still pending. No saved-status metadata was supplied.');
    } else {
      details.push('No saved-status metadata was supplied.');
    }
  }

  if (check?.currentStatusStorage === 'saved') {
    details.push(check.projectionUpdated === true
      ? 'Saved display evidence updated.' : 'Display evidence saved.');
  } else if (check?.currentStatusStorage === 'unavailable') {
    details.push('The saved Shapon booking was read, but its local display snapshot could not be updated. The list and receipt may still show earlier evidence.');
  }
  if (context === 'attempt') {
    details.push('Keep this case open until staff resolve it. Do not submit Book again.');
  }
  details.push('Wallet and payment are unchanged. This reads Shapon’s saved status only; no new supplier sync or ticket request was sent.');
  return { headline, details };
}
