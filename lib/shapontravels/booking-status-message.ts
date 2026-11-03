import { BOOKING_STATUS_LABELS, type BookingStatus } from '../flights/booking-status';
import type { ShapontravelsBookingStatus, ShapontravelsCurrentStatus } from './booking-status';

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

const SOURCE_LABELS: Record<ShapontravelsCurrentStatus['source'], string> = {
  supplier_pnr: 'Saved supplier PNR observation',
  supplier_sync: 'Saved supplier sync observation',
  ticket_operation: 'Ticket operation',
  cancellation_operation: 'Cancellation operation',
  admin_decision: 'Admin decision',
  staff_manual: 'Staff decision',
  saved_booking: 'Saved booking record',
  saved_import: 'Imported booking record',
  airline_refresh: 'Saved airline refresh',
  public_receipt: 'Public booking receipt',
};

const CHECK_FAILURE_LABELS: Record<string, string> = {
  SUPPLIER_TIMEOUT: 'the supplier timed out',
  SUPPLIER_READ_FAILED: 'the supplier could not be read',
  SUPPLIER_RECONCILIATION_FAILED: 'the supplier check could not be reconciled',
};

const timestamp = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  timeZone: 'Asia/Dhaka',
});

function stamp(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${timestamp.format(date)} (Bangladesh time)` : null;
}

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
    const label = BOOKING_STATUS_LABELS[current.status];
    headline = `Shapon saved booking status: ${label}.`;
    const recordedAt = stamp(current.checkedAt ?? current.supplierCheckedAt);
    details.push(`Source: ${SOURCE_LABELS[current.source]} (${current.verified ? 'verified when saved' : 'not machine-verified'}). ${recordedAt ? `Saved evidence time: ${recordedAt}.` : 'No source timestamp was supplied.'}`);
    if (current.supplierStatus && current.supplierCheckedAt && (
      current.supplierStatus.trim().toLowerCase() !== label.toLowerCase()
      || Date.parse(current.supplierCheckedAt) !== Date.parse(current.checkedAt ?? '')
      || current.source !== 'supplier_pnr'
    )) {
      details.push(`Saved supplier status: ${current.supplierStatus}. Recorded: ${stamp(current.supplierCheckedAt) ?? 'not recorded'}.`);
    }
    if (check?.displayStatus && check.displayStatus !== current.status) {
      details.push(`Saved local booking status: ${BOOKING_STATUS_LABELS[check.displayStatus]}.`);
    }
    if (current.reviewRequired === true || check?.displayReviewRequired === true) {
      details.push('This evidence needs staff review before further booking or financial action.');
    }
    if (current.lastCheck && !current.lastCheck.verified) {
      const reason = current.lastCheck.reasonCode
        ? CHECK_FAILURE_LABELS[current.lastCheck.reasonCode] : null;
      details.push(`Previously saved supplier check was not verified at ${stamp(current.lastCheck.checkedAt) ?? 'an unknown time'}${reason ? `: ${reason}` : ''}. The saved status and supplier evidence above are retained.`);
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
    if (check?.originalBookingStatus) {
      details.push(`Historical Book receipt status: ${check.originalBookingStatus}. This describes the original booking response, not the current status.`);
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
